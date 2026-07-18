/** P3 M3 upload validation and raster transaction. Kept behind FoldView's lazy boundary. */
import type { CustomArtworkSource } from './fold-scene';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RASTER_EDGE = 8192;
const MAX_RASTER_PIXELS = 33_554_432;
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

export type ArtworkLoadResult =
  | 'committed'
  | 'cancelled'
  | ArtworkRejection;

export interface EditableArtworkAsset {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  revision: number;
}

export interface ArtworkLoadOptions {
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

function readJpegSize(bytes: Uint8Array): RasterSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = bytes[offset]! * 0x100 + bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (segmentLength < 8) return null;
      return {
        width: bytes[offset + 5]! * 0x100 + bytes[offset + 6]!,
        height: bytes[offset + 3]! * 0x100 + bytes[offset + 4]!,
      };
    }
    offset += segmentLength;
  }
  return null;
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

function isAllowedEmbeddedRaster(element: Element, attribute: Attr): boolean {
  if (
    element.localName !== 'image'
    || (attribute.name !== 'href' && attribute.name !== 'xlink:href')
  ) {
    return false;
  }
  const size = readEmbeddedRasterSize(attribute.value);
  return size !== null && !hasInvalidRasterDimensions(size);
}

function hasExternalDomResource(documentNode: Document): boolean {
  const elements = [documentNode.documentElement, ...documentNode.querySelectorAll('*')];
  for (const element of elements) {
    const elementName = element.localName.toLowerCase();
    if (elementName === 'foreignobject' || elementName === 'script') return true;
    if (elementName === 'style' && hasExternalStyleContent(element.textContent ?? '')) return true;

    for (const attribute of element.attributes) {
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value.trim();
      if (
        RESOURCE_ATTRIBUTE_NAMES.has(attributeName)
        && !value.startsWith('#')
        && !isAllowedEmbeddedRaster(element, attribute)
      ) {
        return true;
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

  const editableAsset = await createEditableArtworkAsset(file, requestId, options.signal);
  if ('code' in editableAsset) return isCurrent() ? editableAsset : 'cancelled';
  if (!isCurrent()) {
    editableAsset.bitmap.close();
    return 'cancelled';
  }

  let source: CustomArtworkSource;
  try {
    source = await rasterizeToSource(file, options.signature, options.signal);
  } catch {
    editableAsset.bitmap.close();
    return isCurrent() ? { code: 'decode' } : 'cancelled';
  }

  if (!isCurrent()) {
    source.canvas.width = source.canvas.height = 0;
    editableAsset.bitmap.close();
    return 'cancelled';
  }

  options.onCommit(source, editableAsset);
  return 'committed';
}
