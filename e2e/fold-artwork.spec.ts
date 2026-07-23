import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { resolveParams } from '../src/core/registry';
import { buildRteFoldModel } from '../src/fold/models/reverse-tuck-end';
import { worldGeometry } from '../src/fold/pose3d';
import { foldPose } from '../src/fold/schedule';
import { dict } from '../src/i18n/dict';
import { artworkLayoutSignature, deriveArtworkLayout, hashArtworkLayoutSignature } from '../src/ui/artwork-layout';
import { gotoReady } from './helpers';

interface UploadFixture {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface ProjectedRegion {
  x: number;
  y: number;
  radius: number;
}

interface PixelDiffResult {
  diffPx: number;
  totalPx: number;
}

const CAMERA_AZIMUTH = 35;
const CAMERA_ELEVATION = 25;
const CUSTOM_DIFF_THRESHOLD = 0.0015;
const DEFAULT_VALUES = resolveParams(reverseTuckEnd, {});
const DEFAULT_MODEL = buildRteFoldModel(DEFAULT_VALUES);
const DEFAULT_LAYOUT = deriveArtworkLayout(DEFAULT_MODEL);
// The fixed +x/+z camera sees the front and right exterior panels after the outward fold.
const PANEL_COLORS = {
  P1: { css: '#cc2244', rgba: [204, 34, 68, 255] as const, channel: 0 },
  P2: { css: '#22aa66', rgba: [34, 170, 102, 255] as const, channel: 1 },
} as const;

function computeCameraFrame() {
  const boundsAt = (progress: number) => {
    const bounds = {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
      minZ: Infinity,
      maxZ: -Infinity,
    };
    for (const vertices of worldGeometry(DEFAULT_MODEL, foldPose(progress, DEFAULT_MODEL)).values()) {
      for (const vertex of vertices) {
        bounds.minX = Math.min(bounds.minX, vertex.x);
        bounds.maxX = Math.max(bounds.maxX, vertex.x);
        bounds.minY = Math.min(bounds.minY, -vertex.y);
        bounds.maxY = Math.max(bounds.maxY, -vertex.y);
        bounds.minZ = Math.min(bounds.minZ, vertex.z);
        bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
      }
    }
    return bounds;
  };
  const diagonal = (bounds: ReturnType<typeof boundsAt>) => Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
  const folded = boundsAt(1);
  const flat = boundsAt(0);
  return {
    target: {
      x: (folded.minX + folded.maxX) / 2,
      y: (folded.minY + folded.maxY) / 2,
      z: (folded.minZ + folded.maxZ) / 2,
    },
    fitDiagonal: Math.max(diagonal(flat), diagonal(folded)),
  };
}

function cameraOrbitPosition(
  target: { x: number; y: number; z: number },
  distance: number,
  azimuthDeg: number,
  elevationDeg: number,
) {
  const azimuth = azimuthDeg * Math.PI / 180;
  const elevation = elevationDeg * Math.PI / 180;
  const horizontalDistance = distance * Math.cos(elevation);
  return {
    x: target.x + horizontalDistance * Math.sin(azimuth),
    y: target.y + distance * Math.sin(elevation),
    z: target.z + horizontalDistance * Math.cos(azimuth),
  };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function pngFixture(): UploadFixture {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const left = x < width / 2;
      scanlines[offset] = left ? 204 : 34;
      scanlines[offset + 1] = left ? 34 : 102;
      scanlines[offset + 2] = left ? 68 : 204;
      scanlines[offset + 3] = 255;
    }
  }
  return {
    name: 'artwork.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(scanlines)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

function svgFixture(markup: string, name = 'artwork.svg'): UploadFixture {
  return { name, mimeType: 'image/svg+xml', buffer: Buffer.from(markup) };
}

function genericSvgFixture(): UploadFixture {
  return svgFixture([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '<rect width="100" height="100" fill="#2255cc"/>',
    '<circle cx="50" cy="50" r="28" fill="#ffcc22"/>',
    '</svg>',
  ].join(''));
}

function embeddedPngSvgFixture(): UploadFixture {
  const embeddedPng = pngFixture().buffer.toString('base64');
  return svgFixture([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    `<image href="data:image/png;base64,${embeddedPng}" width="100" height="100"/>`,
    '</svg>',
  ].join(''), 'embedded-png.svg');
}

function panelBounds(panelId: string): { minX: number; minY: number; width: number; height: number } {
  const panel = DEFAULT_LAYOUT.panels.find(({ id }) => id === panelId);
  if (panel === undefined) throw new Error(`Missing panel ${panelId}`);
  const xs = panel.polygon.map(({ x }) => x);
  const ys = panel.polygon.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function alignmentSvgFixture(): UploadFixture {
  const { frame } = DEFAULT_LAYOUT;
  const frameX = frame.minX - frame.offsetX;
  const frameY = frame.minY - frame.offsetY;
  const panels = Object.entries(PANEL_COLORS).map(([panelId, color]) => {
    const bounds = panelBounds(panelId);
    const width = bounds.width * 0.4;
    const height = bounds.height * 0.4;
    const x = bounds.minX + (bounds.width - width) / 2;
    const y = bounds.minY + (bounds.height - height) / 2;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color.css}"/>`;
  });
  return svgFixture([
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${frameX} ${frameY} ${frame.span} ${frame.span}">`,
    `<rect x="${frameX}" y="${frameY}" width="${frame.span}" height="${frame.span}" fill="#ffffff"/>`,
    ...panels,
    '</svg>',
  ].join(''), 'panel-alignment.svg');
}

const CURRENT_LAYOUT_HASH = hashArtworkLayoutSignature(artworkLayoutSignature(DEFAULT_MODEL));
const FRAME_X = DEFAULT_LAYOUT.frame.minX - DEFAULT_LAYOUT.frame.offsetX;
const FRAME_Y = DEFAULT_LAYOUT.frame.minY - DEFAULT_LAYOUT.frame.offsetY;
const FRAME_SPAN = DEFAULT_LAYOUT.frame.span;
const ALIGNMENT_ERROR_TOLERANCE_MM = 0.5;

// 40% 色塊中心取樣的容忍帶有數 mm 寬，只能證明
// 「有改寫」不能證明「< 0.5mm」。改用已知 mm 座標的窄定位記號＋二分搜尋量出記號邊緣
// 的實際 mm 位置，直接跟真值比對——這才是 sub-mm 對位誤差的像素級證據。
const MARK_SIZE_MM = 1;
const MARK_INSET_MM = 5;

interface CornerMark {
  cx: number;
  cy: number;
}

/** 頁框四角、各往內縮 MARK_INSET_MM 的記號中心點（真實 mm 座標，非 viewBox 座標）。 */
function cornerMarks(frameX: number, frameY: number, span: number): CornerMark[] {
  const near = frameX + MARK_INSET_MM;
  const far = frameX + span - MARK_INSET_MM;
  const nearY = frameY + MARK_INSET_MM;
  const farY = frameY + span - MARK_INSET_MM;
  return [
    { cx: near, cy: nearY },
    { cx: far, cy: nearY },
    { cx: near, cy: farY },
    { cx: far, cy: farY },
  ];
}

function cornerMarksSvg(marks: readonly CornerMark[]): string {
  const half = MARK_SIZE_MM / 2;
  return marks
    .map(({ cx, cy }) => `<rect x="${cx - half}" y="${cy - half}" width="${MARK_SIZE_MM}" `
      + `height="${MARK_SIZE_MM}" fill="#000000"/>`)
    .join('');
}

/**
 * 對每個定位記號的左邊／上邊做二分搜尋（在 source canvas 上找白底→黑記號的交界
 * 像素，換算回頁框 mm 座標），回傳每一次量測跟記號已知真實 mm 座標的絕對誤差。
 * 全部在單一 page.evaluate 內完成（迴圈呼叫既有 `__p3ReadArtworkPixel` hook，
 * 每次 hook 呼叫都是同一頁面內的同步呼叫，不是個別 round trip）。
 */
async function measureCornerMarkErrorsMm(
  page: Page,
  frameX: number,
  frameY: number,
  span: number,
  marks: readonly CornerMark[],
): Promise<number[]> {
  const half = MARK_SIZE_MM / 2;
  return page.evaluate(({ frameX, frameY, span, half, marks, searchMargin }) => {
    const hook = (window as unknown as Record<string, unknown>).__p3ReadArtworkPixel as
      ((u: number, v: number) => number[] | null) | undefined;
    if (typeof hook !== 'function') throw new Error('__p3ReadArtworkPixel unavailable');

    const isDark = (x: number, y: number): boolean => {
      const u = (x - frameX) / span;
      const v = 1 - (y - frameY) / span;
      const pixel = hook(u, v);
      return pixel !== null && pixel[0] < 128;
    };

    // 二分搜尋：low 恆落在白底背景（false），high 恆落在記號內部（true）——這是個
    // *假設*，過去從未驗證過。記號整個缺席／被搬走時兩端點都會讀白，二分搜尋仍會
    // 靜默收斂到一個貼著門檻下緣（≈0.49999mm）的假讀數，讓 <0.5mm 斷言假綠通過
    // （邊界案例）。進二分搜尋前先驗證端點色，
    // 不成立就 fail loud（丟錯），不進去悄悄搜出一個看似合格的數字。
    const findEdge = (axis: 'x' | 'y', fixed: number, lo: number, hi: number): number => {
      const sampleAt = (value: number): boolean => (axis === 'x' ? isDark(value, fixed) : isDark(fixed, value));
      const loIsBackground = !sampleAt(lo);
      const hiIsMark = sampleAt(hi);
      if (!loIsBackground || !hiIsMark) {
        throw new Error(
          `binary-search endpoint invariant violated (axis=${axis} fixed=${fixed} lo=${lo} hi=${hi} `
          + `loDark=${!loIsBackground} hiDark=${hiIsMark})——定位記號可能缺席或被搬移`,
        );
      }
      let low = lo;
      let high = hi;
      for (let i = 0; i < 24; i += 1) {
        const mid = (low + high) / 2;
        if (sampleAt(mid)) high = mid; else low = mid;
      }
      return (low + high) / 2;
    };

    const errors: number[] = [];
    for (const { cx, cy } of marks) {
      const expectedLeft = cx - half;
      const expectedTop = cy - half;
      const measuredLeft = findEdge('x', cy, expectedLeft - searchMargin, cx);
      const measuredTop = findEdge('y', cx, expectedTop - searchMargin, cy);
      errors.push(Math.abs(measuredLeft - expectedLeft));
      errors.push(Math.abs(measuredTop - expectedTop));
    }
    return errors;
  }, { frameX, frameY, span, half, marks: [...marks], searchMargin: 2 });
}

// 上傳對位 guard-rail 合成 Illustrator 風格 fixture——逐項復刻
// 實際 Illustrator 匯出檔（未勾 Use Artboards）觀測到的特徵：
//  ① viewBox 改寫為與真實內容座標系不同、四邊不對稱外擴的「pt 風格」數值（非真頁面）
//  ② 移除 root width/height（Illustrator 匯出未勾選 Use Artboards 的典型結果）
//  ③ 頁框 rect（data-role="page-frame"，帶真實 frame 座標）與 data-box-id／
//     data-layout-hash 存活在 <g style="display:none">（Illustrator 把 GUIDES 圖層關閉
//     顯示但不刪除）
// 內容座標（色塊 rect）沿用 alignmentSvgFixture 的真實 frame 座標系——Illustrator 只
// 重算外層 viewBox metadata，不會搬動使用者已畫物件的絕對座標。
function illustratorStyleFixture(options?: {
  boxId?: string;
  layoutHash?: string;
  extraRootAttrs?: string;
  name?: string;
}): UploadFixture {
  const { frame } = DEFAULT_LAYOUT;
  const frameX = frame.minX - frame.offsetX;
  const frameY = frame.minY - frame.offsetY;
  const panels = Object.entries(PANEL_COLORS).map(([panelId, color]) => {
    const bounds = panelBounds(panelId);
    const width = bounds.width * 0.4;
    const height = bounds.height * 0.4;
    const x = bounds.minX + (bounds.width - width) / 2;
    const y = bounds.minY + (bounds.height - height) / 2;
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color.css}"/>`;
  });
  // 四邊不對稱外擴（非「等比縮放」）＋pt 風格單位換算，數值刻意與真 frame 差一整個
  // 數量級，讓「改寫生效」與「改寫沒生效」在對位結果上有清楚可辨的差異。
  const mangledX = frameX * 2.8346 - 11.3;
  const mangledY = frameY * 2.8346 - 4.7;
  const mangledW = frame.span * 2.8346 + 22.9;
  const mangledH = frame.span * 2.8346 + 8.1;
  const attrs = [
    `data-box-id="${options?.boxId ?? 'rte'}"`,
    `data-layout-hash="${options?.layoutHash ?? CURRENT_LAYOUT_HASH}"`,
    options?.extraRootAttrs ?? '',
  ].filter((entry) => entry !== '').join(' ');
  const guides = `<g id="TEMPLATE_GUIDES" style="display:none">`
    + `<rect data-role="page-frame" x="${frameX}" y="${frameY}" width="${frame.span}" height="${frame.span}" fill="none"/>`
    + '</g>';
  const marks = cornerMarksSvg(cornerMarks(frameX, frameY, frame.span));
  return svgFixture([
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs} viewBox="${mangledX} ${mangledY} ${mangledW} ${mangledH}">`,
    guides,
    `<rect x="${frameX}" y="${frameY}" width="${frame.span}" height="${frame.span}" fill="#ffffff"/>`,
    ...panels,
    marks,
    '</svg>',
  ].join(''), options?.name ?? 'illustrator-mangled.svg');
}

// 頁框錨定專屬 fixture——跟上面 pt 風格／不對稱
// Illustrator fixture 分開，只測 viewBox 四邊皆外擴的案例：viewBox 四邊皆外擴
// 10mm（非不對稱、非 pt 單位換算），其餘 metadata（頁框 rect／data-box-id／
// data-layout-hash）與正常模板一致。
function fourEdgeExpandFixture(): UploadFixture {
  const { frame } = DEFAULT_LAYOUT;
  const frameX = frame.minX - frame.offsetX;
  const frameY = frame.minY - frame.offsetY;
  const expand = 10;
  const outerX = frameX - expand;
  const outerY = frameY - expand;
  const outerSpan = frame.span + expand * 2;
  const guides = `<g id="TEMPLATE_GUIDES">`
    + `<rect data-role="page-frame" x="${frameX}" y="${frameY}" width="${frame.span}" height="${frame.span}" fill="none"/>`
    + '</g>';
  const marks = cornerMarksSvg(cornerMarks(frameX, frameY, frame.span));
  return svgFixture([
    `<svg xmlns="http://www.w3.org/2000/svg" data-box-id="rte" data-layout-hash="${CURRENT_LAYOUT_HASH}" `
      + `viewBox="${outerX} ${outerY} ${outerSpan} ${outerSpan}" width="${outerSpan}" height="${outerSpan}">`,
    guides,
    `<rect x="${frameX}" y="${frameY}" width="${frame.span}" height="${frame.span}" fill="#ffffff"/>`,
    marks,
    '</svg>',
  ].join(''), 'four-edge-expand.svg');
}

/** 對已上傳的自訂圖稿逐 panel 讀 source-canvas 中心像素，斷言精確等於預期色——
 *  比對「頁框錨定」是否把上傳檔正確映射回 [0,1] source 座標（sub-mm 對位誤差的
 *  像素級證明：若 viewBox 改寫失敗，中心像素會落在背景白或錯誤色塊上，逐 bit
 *  比對必露餡；不像「投影畫面 dominant channel」容許數 px 的模糊帶）。 */
async function expectSourcePixelsAligned(page: Page): Promise<void> {
  for (const [panelId, expected] of Object.entries(PANEL_COLORS)) {
    const sourcePixel = await page.evaluate(({ u, v }) => {
      const hook = (window as unknown as Record<string, unknown>).__p3ReadArtworkPixel;
      if (typeof hook !== 'function') throw new Error('__p3ReadArtworkPixel unavailable');
      return hook(u, v) as number[] | null;
    }, panelCenterUv(panelId));
    expect(sourcePixel, `${panelId} source-canvas center pixel`).toEqual([...expected.rgba]);
  }
}

async function jpegFixture(page: Page): Promise<UploadFixture> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2D context unavailable');
    context.fillStyle = '#22aa66';
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = '#cc2244';
    context.fillRect(12, 12, 40, 40);
    return canvas.toDataURL('image/jpeg', 0.92);
  });
  return {
    name: 'artwork.jpeg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
  };
}

async function enterFold(page: Page): Promise<void> {
  await gotoReady(page);
  await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();
  await expect(page.locator('.fold-view')).toBeVisible();
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'none');
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await expect.poll(
    () => page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).__p3SetCameraOrbit,
    ),
    { message: '__p3SetCameraOrbit must be ready' },
  ).toBe('function');
}

async function freezeFrame(page: Page): Promise<void> {
  const cardGroup = page.getByRole('group', { name: dict['fold.card.label'].en, exact: true });
  const white = cardGroup.getByRole('button', { name: dict['fold.card.white'].en, exact: true });
  const autoRotate = page.getByRole('button', { name: dict['fold.autorotate'].en, exact: true });
  await white.click();
  await expect(white).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.foldbar input[type="range"]').fill('1');
  if (await autoRotate.getAttribute('aria-pressed') === 'true') await autoRotate.click();
  await expect(autoRotate).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(
    ({ azimuth, elevation }) => {
      const hook = (window as unknown as Record<string, unknown>).__p3SetCameraOrbit;
      if (typeof hook !== 'function') throw new Error('__p3SetCameraOrbit unavailable');
      hook(azimuth, elevation);
    },
    { azimuth: CAMERA_AZIMUTH, elevation: CAMERA_ELEVATION },
  );
}

async function stableShot(canvas: Locator): Promise<Buffer> {
  let previous: Buffer | null = null;
  let stable: Buffer | null = null;
  await expect.poll(async () => {
    const next = await canvas.screenshot({ style: '.fold-tools { visibility: hidden !important; }' });
    const matches = previous !== null && next.equals(previous);
    previous = next;
    if (matches) stable = next;
    return matches;
  }, { message: 'fold artwork frame must settle', timeout: 10_000 }).toBe(true);
  return stable!;
}

async function pixelDiff(page: Page, left: Buffer, right: Buffer): Promise<PixelDiffResult> {
  return page.evaluate(async ([leftBase64, rightBase64]) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((resolve) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image), { once: true });
      image.src = `data:image/png;base64,${base64}`;
    });
    const [leftImage, rightImage] = await Promise.all([load(leftBase64), load(rightBase64)]);
    const pixels = (image: HTMLImageElement): Uint8ClampedArray => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(image.width / 16);
      canvas.height = Math.ceil(image.height / 16);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2D context unavailable');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = pixels(leftImage);
    const b = pixels(rightImage);
    let diffPx = 0;
    for (let index = 0; index < a.length; index += 4) {
      const delta = Math.abs(a[index]! - b[index]!)
        + Math.abs(a[index + 1]! - b[index + 1]!)
        + Math.abs(a[index + 2]! - b[index + 2]!);
      if (delta > 3) diffPx += 1;
    }
    return { diffPx, totalPx: a.length / 4 };
  }, [left.toString('base64'), right.toString('base64')] as const);
}

function uploadInput(page: Page): Locator {
  return page.locator('.fold-tools input[type="file"]');
}

async function upload(page: Page, fixture: UploadFixture): Promise<void> {
  await uploadInput(page).setInputFiles(fixture);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
}

async function expectDistinctCustomFrame(page: Page, fixture: UploadFixture): Promise<void> {
  await freezeFrame(page);
  const canvas = page.locator('.fold-canvas');
  const artworkGroup = page.getByRole('group', { name: dict['fold.art.label'].en, exact: true });
  const sample = artworkGroup.getByRole('button', { name: dict['fold.art.sample'].en, exact: true });
  const uploadButton = artworkGroup.getByRole('button', { name: dict['fold.art.upload'].en, exact: true });
  const noneFrame = await stableShot(canvas);

  await sample.click();
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');
  const sampleFrame = await stableShot(canvas);

  await upload(page, fixture);
  await expect(sample).toHaveAttribute('aria-pressed', 'false');
  await expect(uploadButton).toHaveAttribute('aria-pressed', 'true');
  const customFrame = await stableShot(canvas);

  for (const [label, baseline] of [['NONE', noneFrame], ['SAMPLE', sampleFrame]] as const) {
    const diff = await pixelDiff(page, customFrame, baseline);
    expect(
      diff.diffPx / diff.totalPx,
      `custom frame must visibly differ from ${label}`,
    ).toBeGreaterThan(CUSTOM_DIFF_THRESHOLD);
  }
}

function panelCenterUv(panelId: string): { u: number; v: number } {
  const bounds = panelBounds(panelId);
  const x = bounds.minX + bounds.width / 2;
  const y = bounds.minY + bounds.height / 2;
  const { frame } = DEFAULT_LAYOUT;
  return {
    u: (x - frame.minX + frame.offsetX) / frame.span,
    v: 1 - (y - frame.minY + frame.offsetY) / frame.span,
  };
}

function projectPanelRegion(panelId: string, width: number, height: number): ProjectedRegion {
  const vertices = worldGeometry(DEFAULT_MODEL, foldPose(1, DEFAULT_MODEL)).get(panelId);
  const frame = computeCameraFrame();
  if (vertices === undefined) throw new Error(`Cannot project panel ${panelId}`);
  const camera = cameraOrbitPosition(
    frame.target,
    frame.fitDiagonal * 2,
    CAMERA_AZIMUTH,
    CAMERA_ELEVATION,
  );
  const normalize = (point: { x: number; y: number; z: number }) => {
    const length = Math.hypot(point.x, point.y, point.z);
    return { x: point.x / length, y: point.y / length, z: point.z / length };
  };
  const cross = (
    left: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number },
  ) => ({
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  });
  const dot = (
    left: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number },
  ) => left.x * right.x + left.y * right.y + left.z * right.z;
  const forward = normalize({
    x: frame.target.x - camera.x,
    y: frame.target.y - camera.y,
    z: frame.target.z - camera.z,
  });
  const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);
  const tangent = Math.tan(35 * Math.PI / 360);
  const projected = vertices.map((vertex) => {
    const point = { x: vertex.x, y: -vertex.y, z: vertex.z };
    const relative = { x: point.x - camera.x, y: point.y - camera.y, z: point.z - camera.z };
    const depth = dot(relative, forward);
    const ndcX = dot(relative, right) / (depth * tangent * (width / height));
    const ndcY = dot(relative, up) / (depth * tangent);
    return { x: (ndcX + 1) * width / 2, y: (1 - ndcY) * height / 2 };
  });
  const xs = projected.map(({ x }) => x);
  const ys = projected.map(({ y }) => y);
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
    radius: Math.max(2, Math.min(10, Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.08)),
  };
}

async function sampleScreenshotRegion(
  page: Page,
  screenshot: Buffer,
  region: ProjectedRegion,
): Promise<[number, number, number]> {
  return page.evaluate(async ({ base64, sample }) => {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Could not decode screenshot')), { once: true });
      image.src = `data:image/png;base64,${base64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2D context unavailable');
    context.drawImage(image, 0, 0);
    const minX = Math.max(0, Math.floor(sample.x - sample.radius));
    const minY = Math.max(0, Math.floor(sample.y - sample.radius));
    const maxX = Math.min(canvas.width, Math.ceil(sample.x + sample.radius));
    const maxY = Math.min(canvas.height, Math.ceil(sample.y + sample.radius));
    const pixels = context.getImageData(minX, minY, maxX - minX, maxY - minY).data;
    const totals = [0, 0, 0];
    for (let index = 0; index < pixels.length; index += 4) {
      totals[0] += pixels[index]!;
      totals[1] += pixels[index + 1]!;
      totals[2] += pixels[index + 2]!;
    }
    const count = pixels.length / 4;
    return totals.map((total) => Math.round(total / count)) as [number, number, number];
  }, { base64: screenshot.toString('base64'), sample: region });
}

test('upload png artwork renders a custom frame distinct from none and sample', async ({ page }) => {
  await enterFold(page);
  await expectDistinctCustomFrame(page, pngFixture());
});

test('upload jpeg artwork renders a custom frame distinct from none and sample', async ({ page }) => {
  await enterFold(page);
  await expectDistinctCustomFrame(page, await jpegFixture(page));
});

test('upload svg artwork renders a custom frame distinct from none and sample', async ({ page }) => {
  await enterFold(page);
  await expectDistinctCustomFrame(page, genericSvgFixture());
});

test('upload svg artwork with an embedded PNG renders successfully', async ({ page }) => {
  await enterFold(page);
  await expectDistinctCustomFrame(page, embeddedPngSvgFixture());
});

test('uploaded artwork lands on the correct panel after folding', async ({ page }) => {
  await enterFold(page);
  await freezeFrame(page);
  await upload(page, alignmentSvgFixture());

  for (const [panelId, expected] of Object.entries(PANEL_COLORS)) {
    const sourcePixel = await page.evaluate(({ u, v }) => {
      const hook = (window as unknown as Record<string, unknown>).__p3ReadArtworkPixel;
      if (typeof hook !== 'function') throw new Error('__p3ReadArtworkPixel unavailable');
      return hook(u, v) as number[] | null;
    }, panelCenterUv(panelId));
    expect(sourcePixel, `${panelId} source-canvas center pixel`).toEqual([...expected.rgba]);
  }

  const canvas = page.locator('.fold-canvas');
  const screenshot = await stableShot(canvas);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const sampled: Record<string, [number, number, number]> = {};
  for (const [panelId, expected] of Object.entries(PANEL_COLORS)) {
    const color = await sampleScreenshotRegion(
      page,
      screenshot,
      projectPanelRegion(panelId, box!.width, box!.height),
    );
    sampled[panelId] = color;
    const competitors = color.filter((_value, index) => index !== expected.channel);
    expect(
      color[expected.channel] - Math.max(...competitors),
      `${panelId} projected center must retain its expected dominant channel: ${color.join(',')}`,
    ).toBeGreaterThanOrEqual(40);
  }
  expect(sampled.P1).not.toEqual(sampled.P2);
});

test('upload rejects an invalid file and keeps the previous artwork', async ({ page }) => {
  await enterFold(page);
  await upload(page, genericSvgFixture());
  await uploadInput(page).setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not a png'),
  });

  await expect(page.getByRole('alert')).toHaveText(dict['fold.art.invalidFile'].en);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
  await expect(page.getByRole('button', { name: dict['fold.art.upload'].en, exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});

test('upload cancel via file chooser keeps state unchanged', async ({ page }) => {
  await enterFold(page);
  const sample = page.getByRole('button', { name: dict['fold.art.sample'].en, exact: true });
  await sample.click();
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: dict['fold.art.upload'].en, exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([]);

  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');
  await expect(sample).toHaveAttribute('aria-pressed', 'true');
});

test('re-selecting the same file re-triggers upload', async ({ page }) => {
  await enterFold(page);
  const fixture = genericSvgFixture();
  const input = uploadInput(page);
  const uploadButton = page.getByRole('button', { name: dict['fold.art.upload'].en, exact: true });

  await upload(page, fixture);
  await expect(input).toHaveValue('');
  await uploadButton.click();
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'none');
  await input.setInputFiles(fixture);

  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
  await expect(input).toHaveValue('');
  await expect(uploadButton).toHaveAttribute('aria-pressed', 'true');
});

test('retained custom artwork reports none before custom while returning from DESIGN to FOLD', async ({ page }) => {
  await enterFold(page);
  await upload(page, genericSvgFixture());

  await page.getByRole('button', { name: dict['mode.design'].en, exact: true }).click();
  await expect(page.locator('.fold-view')).toHaveCount(0);
  await page.evaluate(() => {
    const observations: string[] = [];
    const record = (element: Element): void => {
      if (element.matches('.fold-view')) {
        observations.push(element.getAttribute('data-artwork-ready') ?? 'missing');
      }
      for (const foldView of element.querySelectorAll('.fold-view')) {
        observations.push(foldView.getAttribute('data-artwork-ready') ?? 'missing');
      }
    };
    const observer = new MutationObserver((records) => {
      for (const mutation of records) {
        if (mutation.type === 'attributes') {
          record(mutation.target as Element);
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) record(node);
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-artwork-ready'],
      childList: true,
      subtree: true,
    });
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__p3ArtworkReadySequence = observations;
    hooks.__p3ArtworkReadyObserver = observer;
  });

  await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');

  const sequence = await page.evaluate(() => {
    const hooks = window as unknown as Record<string, unknown>;
    (hooks.__p3ArtworkReadyObserver as MutationObserver).disconnect();
    return hooks.__p3ArtworkReadySequence as string[];
  });
  expect(sequence[0]).toBe('none');
  expect(sequence).toContain('custom');
  expect(sequence.indexOf('none')).toBeLessThan(sequence.indexOf('custom'));
});

test('switching artwork mode during decode discards the stale request', async ({ page }) => {
  await page.addInitScript(() => {
    const originalDecode = HTMLImageElement.prototype.decode;
    const releases: Array<() => void> = [];
    Object.defineProperty(window, '__p3PendingArtworkDecodes', {
      configurable: true,
      get: () => releases.length,
    });
    (window as unknown as Record<string, unknown>).__p3ReleaseArtworkDecodes = () => {
      for (const release of releases.splice(0)) release();
    };
    HTMLImageElement.prototype.decode = function decodeWithArtworkBarrier(): Promise<void> {
      if (!this.src.startsWith('blob:')) return originalDecode.call(this);
      return new Promise<void>((resolve, reject) => {
        releases.push(() => originalDecode.call(this).then(resolve, reject));
      });
    };
  });
  await enterFold(page);
  await uploadInput(page).setInputFiles(pngFixture());
  await expect.poll(
    () => page.evaluate(
      () => (window as unknown as Record<string, unknown>).__p3PendingArtworkDecodes,
    ),
  ).toBe(1);

  const sample = page.getByRole('button', { name: dict['fold.art.sample'].en, exact: true });
  await sample.click();
  await page.evaluate(() => {
    const release = (window as unknown as Record<string, unknown>).__p3ReleaseArtworkDecodes;
    if (typeof release === 'function') release();
  });

  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'sample');
  await expect(sample).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: dict['fold.art.upload'].en, exact: true }))
    .toHaveAttribute('aria-pressed', 'false');
});

test('fold artwork upload makes no request outside the localhost origin', async ({ page }) => {
  const requestUrls: string[] = [];
  await page.route('**/*', async (route) => {
    requestUrls.push(route.request().url());
    await route.continue();
  });

  await enterFold(page);
  await upload(page, genericSvgFixture());

  const localhostOrigin = new URL(page.url()).origin;
  const externalUrls = requestUrls.filter((url) => new URL(url).origin !== localhostOrigin);
  expect(externalUrls, `non-localhost requests:\n${externalUrls.join('\n')}`).toEqual([]);
});

// 上傳對位 guard-rail：頁框錨定＋警示。

test('Illustrator 風格改寫的模板上傳後仍精確對位，誤差 < 0.5mm（頁框錨定修復 viewBox 改寫）', async ({ page }) => {
  await enterFold(page);
  await freezeFrame(page);
  const marks = cornerMarks(FRAME_X, FRAME_Y, FRAME_SPAN);
  await upload(page, illustratorStyleFixture());

  // 主證據：四角定位記號的量測 mm 誤差，直接斷言 < 0.5mm——不是「40% 色塊
  // 中心落在容忍帶內」這種只能證明「有改寫」的弱判別力檢查。
  const errorsMm = await measureCornerMarkErrorsMm(page, FRAME_X, FRAME_Y, FRAME_SPAN, marks);
  for (const errorMm of errorsMm) expect(errorMm).toBeLessThan(ALIGNMENT_ERROR_TOLERANCE_MM);

  // 輔助證據（既有）：色塊仍落在正確的 3D 面板上，證明改寫沒有把內容錯位到別的面。
  await expectSourcePixelsAligned(page);
});

// 二分搜尋原本假設「lo 端點必為背景、hi 端點
// 必為記號」的不變量成立，從未驗證過——記號整個缺席／被搬走時，兩端點皆讀白，
// 搜尋仍會靜默收斂到一個貼著門檻下緣（≈0.49999mm）的假讀數，讓斷言假綠通過。
// 這裡直接證明「記號缺席」時 measureCornerMarkErrorsMm 會 fail loud（丟錯），
// 不是悄悄回傳一個看似合格的數字。
test('二分搜尋端點檢查：定位記號缺席時 fail loud（非靜默收斂出貼近門檻的假讀數）', async ({ page }) => {
  await enterFold(page);
  await freezeFrame(page);
  const blankMarkup = `<svg xmlns="http://www.w3.org/2000/svg" `
    + `viewBox="${FRAME_X} ${FRAME_Y} ${FRAME_SPAN} ${FRAME_SPAN}">`
    + `<rect x="${FRAME_X}" y="${FRAME_Y}" width="${FRAME_SPAN}" height="${FRAME_SPAN}" fill="#ffffff"/></svg>`;
  await upload(page, svgFixture(blankMarkup, 'blank-no-marks.svg'));

  const marks = cornerMarks(FRAME_X, FRAME_Y, FRAME_SPAN);
  await expect(measureCornerMarkErrorsMm(page, FRAME_X, FRAME_Y, FRAME_SPAN, marks)).rejects.toThrow();
});

test('頁框錨定專屬 fixture：viewBox 四邊皆外擴 10mm，上傳後對位誤差 < 0.5mm', async ({ page }) => {
  await enterFold(page);
  await freezeFrame(page);
  const marks = cornerMarks(FRAME_X, FRAME_Y, FRAME_SPAN);
  await upload(page, fourEdgeExpandFixture());

  const errorsMm = await measureCornerMarkErrorsMm(page, FRAME_X, FRAME_Y, FRAME_SPAN, marks);
  for (const errorMm of errorsMm) expect(errorMm).toBeLessThan(ALIGNMENT_ERROR_TOLERANCE_MM);
});

test('root 原有 width/height 與 viewBox 比例嚴重不一致時，改寫後仍精確對位，誤差 < 0.5mm', async ({ page }) => {
  await enterFold(page);
  await freezeFrame(page);
  const marks = cornerMarks(FRAME_X, FRAME_Y, FRAME_SPAN);
  await upload(page, illustratorStyleFixture({ extraRootAttrs: 'width="5000" height="10"' }));

  const errorsMm = await measureCornerMarkErrorsMm(page, FRAME_X, FRAME_Y, FRAME_SPAN, marks);
  for (const errorMm of errorsMm) expect(errorMm).toBeLessThan(ALIGNMENT_ERROR_TOLERANCE_MM);
  await expectSourcePixelsAligned(page);
});

test('無頁框且非正方形的 SVG 上傳後顯示 aspect 警示，圖稿仍照常套用（warn-and-apply）', async ({ page }) => {
  await enterFold(page);
  await upload(page, svgFixture(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="#2255cc"/></svg>',
    'wide.svg',
  ));

  await expect(page.getByRole('status')).toHaveText(dict['fold.art.warning.aspect'].en);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
});

test('無頁框但正方形的 SVG 上傳後不顯示對位警示（正常檔案分支，行為不變）', async ({ page }) => {
  await enterFold(page);
  await upload(page, genericSvgFixture());

  await expect(page.getByRole('status')).toHaveCount(0);
});

test('data-box-id 與目前盒型不同時顯示 box-mismatch 警示，圖稿仍照常套用', async ({ page }) => {
  await enterFold(page);
  await upload(page, illustratorStyleFixture({ boxId: 'ttb' }));

  await expect(page.getByRole('status')).toHaveText(dict['fold.art.warning.boxMismatch'].en);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
});

test('data-layout-hash 與目前參數不符時顯示 stale-template 警示，圖稿仍照常套用', async ({ page }) => {
  await enterFold(page);
  await upload(page, illustratorStyleFixture({ layoutHash: 'deadbeef' }));

  await expect(page.getByRole('status')).toHaveText(dict['fold.art.staleTemplate'].en);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
});

test('PNG／JPEG 上傳不受頁框錨定或警示邏輯影響（行為不變）', async ({ page }) => {
  await enterFold(page);
  await upload(page, pngFixture());

  await expect(page.getByRole('status')).toHaveCount(0);
});
