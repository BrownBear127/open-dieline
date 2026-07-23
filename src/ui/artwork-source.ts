/** P3 M3 upload validation and raster transaction. Kept behind FoldView's lazy boundary. */
import { hashArtworkLayoutSignature } from './artwork-layout';
import type { ArtworkAlignmentMetadata, CustomArtworkSource } from './fold-scene';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RASTER_EDGE = 8192;
const MAX_RASTER_PIXELS = 33_554_432;
const MAX_EMBEDDED_RASTER_COUNT = 16;
const SOURCE_SIZE = 2048;
const SVG_SIDECAR_MAX_EDGE = 4096;

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/svg+xml': ['svg'],
};

export type ArtworkRejectionCode =
  | 'type'
  | 'mismatch'
  | 'bytes'
  | 'decode'
  | 'pixels'
  | 'parse'
  | 'viewbox'
  | 'size'
  | 'external';

export interface ArtworkRejection {
  code: ArtworkRejectionCode;
}

export type ArtworkValidationResult = ArtworkRejection | null;

/**
 * 上傳對位 guard-rail 警示碼。warn-and-apply：出現任一個都不阻擋 commit，
 * 只是提示使用者對位可能有問題。多個同時成立時顯示端取最高優先的一條
 * （見 `primaryArtworkWarning`）。
 */
export type ArtworkWarning = 'box-mismatch' | 'stale-template' | 'aspect';

export interface ArtworkCommitResult {
  status: 'committed';
  warnings: ArtworkWarning[];
}

export type ArtworkLoadResult =
  | ArtworkCommitResult
  | 'cancelled'
  | ArtworkRejection;

const WARNING_PRIORITY: readonly ArtworkWarning[] = ['box-mismatch', 'stale-template', 'aspect'];

/** box-mismatch > stale-template > aspect——同時成立時只顯示最高優先的一條。 */
export function primaryArtworkWarning(warnings: readonly ArtworkWarning[]): ArtworkWarning | null {
  return WARNING_PRIORITY.find((warning) => warnings.includes(warning)) ?? null;
}

export interface EditableArtworkAsset {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  revision: number;
}

export interface ArtworkLoadOptions {
  /** 目前作用中的盒型（用於 box-mismatch 警示——模板來自哪個盒型）。 */
  boxId: string;
  signature: string;
  signal?: AbortSignal;
  onCommit: (source: CustomArtworkSource, editableAsset?: EditableArtworkAsset) => void;
}

let latestRequestId = 0;

interface RasterSize {
  width: number;
  height: number;
}

function reject(code: ArtworkRejectionCode): ArtworkValidationResult {
  return { code };
}

const EMBEDDED_RASTER_DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

function hasExternalSvgResource(markup: string): boolean {
  return /<script(?:\s|>)|\b(?:xlink:)?href\s*=\s*(['"])(?!\s*#|data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+\1)|url\((?!\s*["']?\s*#)/i
    .test(markup);
}

const RESOURCE_ATTRIBUTE_NAMES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'poster',
  'src',
]);

// 非 strict 位置（url-token 資源分支的 presentation attributes）的 CSS value
// 掃描。完備性論證（V5 五/六審 70/70 逐項核）：這些屬性（fill/stroke/filter/
// clip-path/marker-*）的資源分支僅 <url>，而 CSS Values 4 §4.5 的 <url> 恰兩
// 形態=url() 與 src()（六審 successor 口徑修正·Chromium 149 尚未實作 src()
// 但 F2 合約=含 reference 即拒）——兩形態 literal 掃描＋反斜線拒（封 CSS
// escape 改寫）即完備；image-set() 等 <image> 語法屬 strict 集合屬性的文法。
function hasExternalCssResource(css: string): boolean {
  if (css.includes('\\')) return true;
  if (/@import\b/i.test(css)) return true;

  // 右括號不是辨識條件：CSS Syntax 3 §2.2 的 EOF 自動閉合會把未閉合的
  // url('http://… 補完並照常取資源（七審實證 Chromium 對未閉合 url( 發請求）。
  // 判準=開括號後（跳引號/空白）非 # fragment 即拒。negative lookahead 整組
  // 不消耗字元——`["']?` 若在主 pattern 內會回溯到引號位使 url('#g') 假陽性
  //（八審抓的 fail-closed 誤拒回歸）；此形態同 raw-scan href/url 判準。
  return /\b(?:url|src)\((?!\s*["']?\s*#)/i.test(css);
}

// style 位置（<style> 元素內容＋style attribute）的嚴格掃描。這裡能用完整 CSS
// property 文法（image-set(<string>) 等不經 url( 的資源引用·V5 三審反例實證
// Chromium 對 style attr 形態真發請求），denylist 追語法是打地鼠——改可證明
// 邊界：CSS 的外部資源引用必經 function notation 或 at-rule，故 `\`（escape）
// 與 `@`（at-rule 全族）與白名單 url(#fragment) 之外的任何 `(`（function 全族）
// 一律拒。合法引用僅剩 fragment url——fail-closed，var()/transform() 等進 style
// 會被誤拒（設計稿典型 style 是 fill/stroke 純值·殘餘相容性代價記 backlog）。
function hasExternalStyleContent(css: string): boolean {
  if (css.includes('\\') || css.includes('@')) return true;
  const withoutFragmentUrls = css.replace(/url\(\s*(["']?)#[^)"']*\1\s*\)/gi, '');
  return withoutFragmentUrls.includes('(');
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100_0000
    + bytes[offset + 1]! * 0x1_0000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function readPngSize(bytes: Uint8Array): RasterSize | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((byte, index) => bytes[index] === byte)) {
    return null;
  }
  if (
    readUint32(bytes, 8) !== 13
    || bytes[12] !== 73
    || bytes[13] !== 72
    || bytes[14] !== 68
    || bytes[15] !== 82
    || crc32(bytes.subarray(12, 29)) !== readUint32(bytes, 29)
  ) {
    return null;
  }
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

function isJpegStartOfFrameMarker(marker: number): boolean {
  return marker >= 0xc0
    && marker <= 0xcf
    && marker !== 0xc4
    && marker !== 0xc8
    && marker !== 0xcc;
}

function readJpegSize(bytes: Uint8Array): RasterSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  let frameSize: RasterSize | null = null;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return frameSize;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (isJpegStartOfFrameMarker(marker)) {
      if (segmentLength < 8 || frameSize !== null) return null;
      frameSize = {
        width: bytes[offset + 5]! * 0x100 + bytes[offset + 6]!,
        height: bytes[offset + 3]! * 0x100 + bytes[offset + 4]!,
      };
    }
    offset += segmentLength;
  }
  return frameSize;
}

function readEmbeddedRasterSize(value: string): RasterSize | null {
  const match = EMBEDDED_RASTER_DATA_URI.exec(value);
  if (match === null) return null;

  let bytes: Uint8Array;
  try {
    const decoded = atob(match[2]!);
    bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  return match[1] === 'png' ? readPngSize(bytes) : readJpegSize(bytes);
}

function hasInvalidRasterDimensions({ width, height }: RasterSize): boolean {
  return (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || Math.min(width, height) <= 0
    || Math.max(width, height) > MAX_RASTER_EDGE
    || !Number.isSafeInteger(width * height)
    || width * height > MAX_RASTER_PIXELS
  );
}

function readAllowedEmbeddedRasterSize(element: Element, attribute: Attr): RasterSize | null {
  if (
    element.localName !== 'image'
    || (attribute.name !== 'href' && attribute.name !== 'xlink:href')
  ) {
    return null;
  }
  const size = readEmbeddedRasterSize(attribute.value);
  return size !== null && !hasInvalidRasterDimensions(size) ? size : null;
}

function hasExternalDomResource(documentNode: Document): boolean {
  const elements = [documentNode.documentElement, ...documentNode.querySelectorAll('*')];
  let embeddedRasterCount = 0;
  let embeddedRasterPixels = 0;
  for (const element of elements) {
    const elementName = element.localName.toLowerCase();
    if (elementName === 'foreignobject' || elementName === 'script') return true;
    if (elementName === 'style' && hasExternalStyleContent(element.textContent ?? '')) return true;

    let embeddedRasterSize: RasterSize | null = null;
    for (const attribute of element.attributes) {
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (attributeName.startsWith('on')) return true;
      if (RESOURCE_ATTRIBUTE_NAMES.has(attributeName) && !value.startsWith('#')) {
        const allowedSize = readAllowedEmbeddedRasterSize(element, attribute);
        if (allowedSize === null) return true;
        if (embeddedRasterSize === null || attribute.name === 'href') {
          embeddedRasterSize = allowedSize;
        }
      }
      // 嚴格掃描位置=style＋mask＋cursor。V5 五審按 SVG2 §6.6 主表 70/70 逐項
      // 核值文法（開發紀錄 §②）：非 url-token 資源語法的 property
      // 僅 mask（<mask-reference>→<image>）與 cursor（CSS UI 3 明許 <image>
      // superset·UI 4 <url-set>）——兩者的 image-set(<string>) 可不經 url( 引
      // 外部資源（四/五審各實證 Chromium 發請求）。其餘 61 項無資源分支、7 項
      //（fill/stroke/filter/clip-path/marker-*）資源分支僅 <url>——url( 掃描＋
      // \ 拒即完備，transform 族 function notation 不誤拒。
      const strict = attributeName === 'style' || attributeName === 'mask' || attributeName === 'cursor';
      if (strict ? hasExternalStyleContent(value) : hasExternalCssResource(value)) {
        return true;
      }
    }
    if (embeddedRasterSize !== null) {
      embeddedRasterCount += 1;
      embeddedRasterPixels += embeddedRasterSize.width * embeddedRasterSize.height;
      if (
        embeddedRasterCount > MAX_EMBEDDED_RASTER_COUNT
        || embeddedRasterPixels > MAX_RASTER_PIXELS
      ) {
        return true;
      }
    }
  }
  return false;
}

function parseSvgViewBox(root: Element): RasterSize | null {
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (
    viewBox.length !== 4
    || !viewBox.every(Number.isFinite)
    || Math.min(viewBox[2]!, viewBox[3]!) <= 0
  ) {
    return null;
  }
  return { width: viewBox[2]!, height: viewBox[3]! };
}

// 上傳對位 guard-rail：頁框錨定＋警示。改寫只在 validateArtworkFile 通過
// 之後才發生（見 loadArtworkFile），不影響、不繞過上方既有的安全掃描。

/** viewBox 長寬比偏離正方形的相對容差——我們自己產生的模板 frame 恆為 span×span
 *  （逐位元方形）；一般繪圖軟體匯出的方形 canvas 通常準到浮點誤差內。2% 足夠吸收
 *  正常捨入雜訊，同時能抓到「明顯不是方形頁面」的案例（如 Letter ~0.77、A4 ~0.71）。 */
const ASPECT_TOLERANCE = 0.02;

interface PageFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// 嚴格純數字：不接受單位字尾（mm/px/%等）、指數記法以外的任何非數字字元、純空白。
// 根因＝`Number.parseFloat('3mm')` 會靜默吃掉字尾
// 回傳 3——第三方編輯器重新匯出的座標系不一定跟我們的 mm 假設一致，錨錯比不錨更糟。
const STRICT_NUMBER_PATTERN = /^-?(?:\d+\.?\d*|\.\d+)$/;

/** width/height：屬性必須存在且嚴格純數字，否則視為異常（sentinel null）。 */
function requiredStrictNumberAttr(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return STRICT_NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

/** x/y：SVG 規格允許缺席時預設為 0（缺席≠異常）；若屬性*存在*但非嚴格純數字
 *  （單位字尾／百分比／空字串／非數字文字）才視為異常。 */
function optionalStrictNumberAttr(element: Element, name: string, fallback: number): number | null {
  const raw = element.getAttribute(name);
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  return STRICT_NUMBER_PATTERN.test(trimmed) ? Number(trimmed) : null;
}

/** rect 自身或任一祖先（含 root）帶 transform 屬性──Illustrator 常在群組包
 *  transform matrix，這裡刻意不做座標變換數學，沿用 rect 的原始
 *  屬性值當作對位基準就會錨錯；錨錯比不錨更糟，故一律放棄。 */
function hasTransformInAncestry(element: Element): boolean {
  let node: Element | null = element;
  while (node !== null) {
    if (node.hasAttribute('transform')) return true;
    node = node.parentElement;
  }
  return false;
}

function isInsideDefs(element: Element): boolean {
  let node: Element | null = element.parentElement;
  while (node !== null) {
    if (node.localName.toLowerCase() === 'defs') return true;
    node = node.parentElement;
  }
  return false;
}

/** 用 querySelectorAll('*')（非屬性選擇器）掃全樹、逐一過濾 data-role 屬性——同
 *  `hasExternalDomResource` 既有慣例，避免依賴 jsdom 對 SVG/XML document 的屬性
 *  CSS 選擇器支援。全樹掃描不管祖先的 `display:none` style（那是 layout/render
 *  階段的事，不是 DOM tree walk 的事），天然滿足「含 display:none 群組內」的要求。
 *
 *  Fail-safe：只接受「恰好一個」候選、且該候選必須是 SVG 命名空間下的
 *  `<rect>`、不在 `<defs>` 內、自身與祖先鏈都沒有 transform、x/y/width/height
 *  皆嚴格純數字（x/y 缺席視為 0）。任一條件不成立就整體放棄錨定（frame=null），
 *  不做座標變換數學——回退原檔行為，交由 aspect 警示規則接手（inspectSvgMetadata
 *  只在 frame===null 時才檢查 aspect，兩者天然銜接，不需要額外分支）。 */
function findPageFrameRect(documentNode: Document): PageFrameRect | null {
  const candidates = Array.from(documentNode.querySelectorAll('*')).filter(
    (element) => element.getAttribute('data-role') === 'page-frame',
  );
  if (candidates.length !== 1) return null;

  const rect = candidates[0]!;
  if (
    rect.localName !== 'rect'
    || rect.namespaceURI !== SVG_NAMESPACE
    || isInsideDefs(rect)
    || hasTransformInAncestry(rect)
  ) {
    return null;
  }

  const x = optionalStrictNumberAttr(rect, 'x', 0);
  const y = optionalStrictNumberAttr(rect, 'y', 0);
  const width = requiredStrictNumberAttr(rect, 'width');
  const height = requiredStrictNumberAttr(rect, 'height');
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function isNonSquareAspect({ width, height }: RasterSize): boolean {
  return Math.abs(width / height - 1) > ASPECT_TOLERANCE;
}

interface SvgMetadataInspection {
  metadata: ArtworkAlignmentMetadata;
  frame: PageFrameRect | null;
}

/**
 * 純粹的「讀取事實」——不跟任何「當下」狀態比較（box-mismatch／
 * stale-template 的判斷改移到 `evaluateArtworkWarnings`，這裡只負責把上傳檔本身
 * 宣告的原始字面值(data-box-id／data-layout-hash)與 aspect 這個固定事實抽出來）。
 * aspect 只在找不到頁框時才檢查（頁框本身就是對位基準，長寬比是否偏離無關）；
 * data-box-id／data-layout-hash 的抽取與頁框是否存在無關——即使頁框對位正確，
 * 模板仍可能屬於錯的盒型或帶著舊參數的 hash。
 */
function inspectSvgMetadata(documentNode: Document): SvgMetadataInspection {
  const root = documentNode.documentElement;
  const frame = findPageFrameRect(documentNode);
  let aspectMismatch = false;
  if (frame === null) {
    const size = parseSvgViewBox(root);
    aspectMismatch = size !== null && isNonSquareAspect(size);
  }

  return {
    frame,
    metadata: {
      boxId: root.getAttribute('data-box-id'),
      layoutHash: root.getAttribute('data-layout-hash'),
      aspectMismatch,
    },
  };
}

/**
 * 警示不再於上傳當下「凍結」。這是唯一負責
 * 「拿 metadata 事實跟當下狀態比對」的純函式——上傳時（loadArtworkFile）與之後
 * 任何時間點（FoldView 顯示層，boxId／參數改變後重新 render）都呼叫同一顆函式，
 * 保證兩處算法逐字一致，不會各自維護一份比對邏輯而漂移。
 */
export function evaluateArtworkWarnings(
  metadata: ArtworkAlignmentMetadata,
  currentBoxId: string,
  currentLayoutHash: string | null,
): ArtworkWarning[] {
  const warnings: ArtworkWarning[] = [];
  if (metadata.boxId !== null && metadata.boxId !== currentBoxId) warnings.push('box-mismatch');
  if (
    metadata.layoutHash !== null
    && currentLayoutHash !== null
    && metadata.layoutHash !== currentLayoutHash
  ) {
    warnings.push('stale-template');
  }
  if (metadata.aspectMismatch) warnings.push('aspect');
  return warnings;
}

/** viewBox 改寫為頁框矩形，width/height 同步覆寫為頁框數值（無單位字尾，與新
 *  viewBox 的四個數字同座標系）——確保 intrinsic aspect ratio 與新 viewBox 逐位元
 *  一致，杜絕 preserveAspectRatio 在瀏覽器預設 sizing 演算法下可能產生的 letterbox
 *  （letterbox 偏移的根因）。 */
function rewriteSvgViewBoxToFrame(markup: string, frame: PageFrameRect): string {
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = documentNode.documentElement;
  root.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.width} ${frame.height}`);
  root.setAttribute('width', String(frame.width));
  root.setAttribute('height', String(frame.height));
  return new XMLSerializer().serializeToString(documentNode);
}

/** 單一攔截點：偵測到頁框就改寫 viewBox，sidecar／source 兩條
 *  rasterize 路徑吃同一份改寫後的檔案、下游零改動。找不到頁框時原樣回傳 `file`
 *  （不做「恆改寫」，只在必要時動手）。只抽取原始 metadata，不跟任何「當下」比較
 *  （比較的職責移到 `evaluateArtworkWarnings`，由呼叫端在需要的時間點求值）。 */
async function anchorSvgToPageFrame(
  file: File,
): Promise<{ file: File; metadata: ArtworkAlignmentMetadata }> {
  const markup = await file.text();
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const { metadata, frame } = inspectSvgMetadata(documentNode);
  if (frame === null) return { file, metadata };

  const rewritten = rewriteSvgViewBoxToFrame(markup, frame);
  return { file: new File([rewritten], file.name, { type: file.type }), metadata };
}

async function validateSvg(file: File): Promise<ArtworkValidationResult> {
  const markup = await file.text();
  if (hasExternalSvgResource(markup)) return reject('external');
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = documentNode.documentElement;
  if (documentNode.querySelector('parsererror') !== null || root.localName !== 'svg') {
    return reject('parse');
  }
  if (hasExternalDomResource(documentNode)) return reject('external');

  if (parseSvgViewBox(root) === null) return reject('viewbox');

  for (const name of ['width', 'height']) {
    const dimension = Number.parseFloat(root.getAttribute(name) ?? '1');
    if (!Number.isFinite(dimension) || dimension <= 0) return reject('size');
  }
  return null;
}

async function validateRaster(file: File): Promise<ArtworkValidationResult> {
  let decoded: ImageBitmap;
  try {
    decoded = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return reject('decode');
  }

  const invalidDimensions = hasInvalidRasterDimensions(decoded);
  decoded.close();
  return invalidDimensions ? reject('pixels') : null;
}

function svgSidecarSize({ width, height }: RasterSize): RasterSize {
  const scale = SVG_SIDECAR_MAX_EDGE / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function readSvgSidecarSize(file: File): Promise<RasterSize> {
  const markup = await file.text();
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const size = parseSvgViewBox(documentNode.documentElement);
  if (size === null) throw new Error();
  return svgSidecarSize(size);
}

async function rasterizeFile(
  file: File,
  size: RasterSize,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  const cancel = (): void => {
    image.src = '';
  };
  try {
    if (signal?.aborted) throw new Error();
    signal?.addEventListener('abort', cancel);
    image.src = url;
    await image.decode();
    if (signal?.aborted) throw new Error();

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error();
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas;
  } finally {
    signal?.removeEventListener('abort', cancel);
    URL.revokeObjectURL(url);
  }
}

async function createSvgSidecarBitmap(file: File, signal?: AbortSignal): Promise<ImageBitmap> {
  const canvas = await rasterizeFile(file, await readSvgSidecarSize(file), signal);
  try {
    return await createImageBitmap(canvas);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function createEditableArtworkAsset(
  file: File,
  revision: number,
  signal?: AbortSignal,
): Promise<EditableArtworkAsset | ArtworkRejection> {
  let bitmap: ImageBitmap;
  try {
    bitmap = file.type === 'image/svg+xml'
      ? await createSvgSidecarBitmap(file, signal)
      : await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { code: 'decode' };
  }

  if (hasInvalidRasterDimensions(bitmap)) {
    bitmap.close();
    return { code: 'pixels' };
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, revision };
}

export async function validateArtworkFile(file: File): Promise<ArtworkValidationResult> {
  const extensions = MIME_EXTENSIONS[file.type];
  if (extensions === undefined) return reject('type');
  const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  if (!extensions.includes(extension)) return reject('mismatch');
  if (file.size > MAX_FILE_BYTES) return reject('bytes');
  return file.type === 'image/svg+xml' ? validateSvg(file) : validateRaster(file);
}

export async function rasterizeToSource(
  file: File,
  signature = '',
  signal?: AbortSignal,
): Promise<CustomArtworkSource> {
  const canvas = await rasterizeFile(
    file,
    { width: SOURCE_SIZE, height: SOURCE_SIZE },
    signal,
  );
  return { canvas, signature };
}

export async function loadArtworkFile(
  file: File,
  options: ArtworkLoadOptions,
): Promise<ArtworkLoadResult> {
  const requestId = ++latestRequestId;
  const isCurrent = (): boolean => requestId === latestRequestId && !options.signal?.aborted;
  const validation = await validateArtworkFile(file);

  if (!isCurrent()) return 'cancelled';
  if (validation !== null) return validation;

  // 頁框錨定＋metadata 抽取只對 SVG 生效（PNG/JPEG 沒有 viewBox／data-* metadata
  // 可讀；非 SVG 路徑完全不變）。改寫在 validateArtworkFile 通過之後才
  // 進行，不影響、不繞過上方的安全掃描。
  let effectiveFile = file;
  let alignmentMetadata: ArtworkAlignmentMetadata | undefined;
  if (file.type === 'image/svg+xml') {
    const anchored = await anchorSvgToPageFrame(file);
    effectiveFile = anchored.file;
    alignmentMetadata = anchored.metadata;
  }
  if (!isCurrent()) return 'cancelled';

  const editableAsset = await createEditableArtworkAsset(effectiveFile, requestId, options.signal);
  if ('code' in editableAsset) return isCurrent() ? editableAsset : 'cancelled';
  if (!isCurrent()) {
    editableAsset.bitmap.close();
    return 'cancelled';
  }

  let source: CustomArtworkSource;
  try {
    source = await rasterizeToSource(effectiveFile, options.signature, options.signal);
  } catch {
    editableAsset.bitmap.close();
    return isCurrent() ? { code: 'decode' } : 'cancelled';
  }

  if (!isCurrent()) {
    source.canvas.width = source.canvas.height = 0;
    editableAsset.bitmap.close();
    return 'cancelled';
  }

  // metadata 原樣掛在 source 上交給呼叫端（隨 CustomArtworkSource 一起被
  // FoldView 的 controlled-prop 提升機制持久化，顯示層可在任何之後的時間點重新
  // 求值）。回傳值的 `warnings` 用同一顆 evaluateArtworkWarnings 算「上傳當下」
  // 的結果，供不需要反應性的呼叫端／既有測試直接使用，兩處算法保證一致。
  if (alignmentMetadata !== undefined) source.alignmentMetadata = alignmentMetadata;
  options.onCommit(source, editableAsset);
  const warnings = alignmentMetadata === undefined
    ? []
    : evaluateArtworkWarnings(alignmentMetadata, options.boxId, hashArtworkLayoutSignature(options.signature));
  return { status: 'committed', warnings };
}
