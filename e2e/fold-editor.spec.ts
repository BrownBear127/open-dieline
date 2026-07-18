import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { resolveParams } from '../src/core/registry';
import { buildRteFoldModel } from '../src/fold/models/reverse-tuck-end';
import { dict } from '../src/i18n/dict';
import { deriveArtworkLayout, type ArtworkLayout } from '../src/ui/artwork-layout';
import { dedupCutEdges } from '../src/ui/fold-template';
import { gotoReady, settleFontsAndLayout } from './helpers';

interface UploadFixture {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface NormalizedSample {
  x: number;
  y: number;
  expected: readonly [number, number, number, number];
}

interface CanvasTranslation {
  width: number;
  height: number;
  x: number;
  y: number;
}

const RED = [214, 48, 72, 255] as const;
const BLUE = [35, 92, 214, 255] as const;
const PAPER = [255, 255, 255, 255] as const;
const CUT = [201, 58, 43, 255] as const;
const DEFAULT_VALUES = resolveParams(reverseTuckEnd, {});
const DEFAULT_LAYOUT = deriveArtworkLayout(buildRteFoldModel(DEFAULT_VALUES));

test.setTimeout(60_000);

function isEditorChunk(url: string): boolean {
  return /\/assets\/EditorView-[^/]+\.js$/.test(new URL(url).pathname);
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

function solidPng(
  name: string,
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): UploadFixture {
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
      scanlines[offset] = rgba[0];
      scanlines[offset + 1] = rgba[1];
      scanlines[offset + 2] = rgba[2];
      scanlines[offset + 3] = rgba[3];
    }
  }
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(scanlines)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

async function installCanvasInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canvases: HTMLCanvasElement[] = [];
    const translations: Array<{ width: number; height: number; x: number; y: number }> = [];
    const seen = new Set<HTMLCanvasElement>();
    const canvasPrototype = HTMLCanvasElement.prototype;
    const originalGetContext = canvasPrototype.getContext;
    Object.defineProperty(canvasPrototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, ...args: unknown[]) {
        if (!seen.has(this)) {
          seen.add(this);
          canvases.push(this);
        }
        return Reflect.apply(originalGetContext, this, args);
      },
    });

    const contextPrototype = CanvasRenderingContext2D.prototype;
    const originalTranslate = contextPrototype.translate;
    Object.defineProperty(contextPrototype, 'translate', {
      configurable: true,
      value(this: CanvasRenderingContext2D, x: number, y: number) {
        translations.push({ width: this.canvas.width, height: this.canvas.height, x, y });
        return originalTranslate.call(this, x, y);
      },
    });

    const hooks = window as unknown as Record<string, unknown>;
    hooks.__m4TrackedCanvases = canvases;
    hooks.__m4CanvasTranslations = translations;
  });
}

async function gotoReadyAtDpr(page: Page, dpr: number): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(dpr);

  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: dict['modal.close'].en, exact: true }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await settleFontsAndLayout(page);
}

async function enterFold(
  page: Page,
  options: { dpr?: number; lang?: 'en' | 'zh' } = {},
): Promise<void> {
  const dpr = options.dpr ?? 1;
  const lang = options.lang ?? 'en';
  if (dpr === 1) await gotoReady(page, { lang });
  else await gotoReadyAtDpr(page, dpr);

  await page.getByRole('button', { name: dict['mode.fold'][lang], exact: true }).click();
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: dict['fold.art.edit'][lang], exact: true })).toBeVisible();
}

async function enterEditor(page: Page, lang: 'en' | 'zh' = 'en'): Promise<void> {
  await page.getByRole('button', { name: dict['fold.art.edit'][lang], exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toBeVisible();
}

function uploadInput(page: Page): Locator {
  return page.locator('.fold-tools input[type="file"]');
}

async function uploadArtwork(page: Page, fixture: UploadFixture): Promise<void> {
  await uploadInput(page).setInputFiles(fixture);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
}

async function sampleCanvasMedian(
  canvas: Locator,
  point: Pick<NormalizedSample, 'x' | 'y'>,
  radius = 3,
): Promise<[number, number, number, number]> {
  return canvas.evaluate((node, { sample, sampleRadius }) => {
    const target = node as HTMLCanvasElement;
    const context = target.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('2D context unavailable');
    const centerX = Math.min(target.width - 1, Math.max(0, Math.floor(sample.x * target.width)));
    const centerY = Math.min(target.height - 1, Math.max(0, Math.floor(sample.y * target.height)));
    const minX = Math.max(0, centerX - sampleRadius);
    const minY = Math.max(0, centerY - sampleRadius);
    const width = Math.min(target.width - minX, sampleRadius * 2 + 1);
    const height = Math.min(target.height - minY, sampleRadius * 2 + 1);
    const pixels = context.getImageData(minX, minY, width, height).data;
    const channels = [[], [], [], []] as number[][];
    for (let index = 0; index < pixels.length; index += 4) {
      for (let channel = 0; channel < 4; channel += 1) {
        channels[channel]!.push(pixels[index + channel]!);
      }
    }
    return channels.map((values) => {
      values.sort((left, right) => left - right);
      return values[Math.floor(values.length / 2)]!;
    }) as [number, number, number, number];
  }, { sample: point, sampleRadius: radius });
}

function expectColor(
  actual: readonly number[],
  expected: readonly number[],
  label: string,
  tolerance = 12,
): void {
  expect(actual).toHaveLength(4);
  for (let channel = 0; channel < 4; channel += 1) {
    expect(
      Math.abs(actual[channel]! - expected[channel]!),
      `${label} channel ${channel}: ${actual.join(',')} vs ${expected.join(',')}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

function normalizedLayoutPoint(
  layout: ArtworkLayout,
  point: { x: number; y: number },
): Pick<NormalizedSample, 'x' | 'y'> {
  return {
    x: (point.x - layout.frame.minX + layout.frame.offsetX) / layout.frame.span,
    y: (point.y - layout.frame.minY + layout.frame.offsetY) / layout.frame.span,
  };
}

function panelCenterSample(
  layout: ArtworkLayout,
  panelId: string,
): Pick<NormalizedSample, 'x' | 'y'> {
  const panel = layout.panels.find(({ id }) => id === panelId);
  if (panel === undefined) throw new Error(`Missing panel ${panelId}`);
  const center = {
    x: panel.polygon.reduce((sum, point) => sum + point.x, 0) / panel.polygon.length,
    y: panel.polygon.reduce((sum, point) => sum + point.y, 0) / panel.polygon.length,
  };
  return normalizedLayoutPoint(layout, center);
}

// 取最長的 cut 邊：長直邊中點的 stroke 中心是實色，短邊/斜邊中點會吃到抗鋸齒混色。
function longestCutMidpointSample(layout: ArtworkLayout): Pick<NormalizedSample, 'x' | 'y'> {
  const edges = dedupCutEdges(layout.panels);
  if (edges.length === 0) throw new Error('Missing cut edge');
  const longest = edges.reduce((best, edge) => {
    const len = (e: typeof edge) => Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    return len(edge) > len(best) ? edge : best;
  });
  return normalizedLayoutPoint(layout, {
    x: (longest.a.x + longest.b.x) / 2,
    y: (longest.a.y + longest.b.y) / 2,
  });
}

async function readArtworkPixel(
  page: Page,
  point: Pick<NormalizedSample, 'x' | 'y'>,
): Promise<number[]> {
  const pixel = await page.evaluate(({ x, y }) => {
    const hook = (window as unknown as Record<string, unknown>).__p3ReadArtworkPixel;
    if (typeof hook !== 'function') throw new Error('__p3ReadArtworkPixel unavailable');
    return hook(x, 1 - y) as number[] | null;
  }, point);
  if (pixel === null) throw new Error('Artwork source pixel unavailable');
  return pixel;
}

async function stableCanvasShot(canvas: Locator): Promise<Buffer> {
  let previous: Buffer | null = null;
  let stable: Buffer | null = null;
  await expect.poll(async () => {
    const next = await canvas.screenshot({
      style: '.fold-tools, .foldbar { visibility: hidden !important; }',
    });
    const matches = previous !== null && next.equals(previous);
    previous = next;
    if (matches) stable = next;
    return matches;
  }, { message: 'fold canvas must settle', timeout: 10_000 }).toBe(true);
  return stable!;
}

async function screenshotDiffRatio(page: Page, left: Buffer, right: Buffer): Promise<number> {
  return page.evaluate(async ([leftBase64, rightBase64]) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((resolve) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image), { once: true });
      image.src = `data:image/png;base64,${base64}`;
    });
    const [a, b] = await Promise.all([load(leftBase64), load(rightBase64)]);
    const pixels = (image: HTMLImageElement): Uint8ClampedArray => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(image.width / 16);
      canvas.height = Math.ceil(image.height / 16);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2D context unavailable');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const leftPixels = pixels(a);
    const rightPixels = pixels(b);
    let changed = 0;
    for (let index = 0; index < leftPixels.length; index += 4) {
      const delta = Math.abs(leftPixels[index]! - rightPixels[index]!)
        + Math.abs(leftPixels[index + 1]! - rightPixels[index + 1]!)
        + Math.abs(leftPixels[index + 2]! - rightPixels[index + 2]!);
      if (delta > 3) changed += 1;
    }
    return changed / (leftPixels.length / 4);
  }, [left.toString('base64'), right.toString('base64')] as const);
}

async function inspectDownload(
  page: Page,
  downloadPath: string,
  samples: readonly Pick<NormalizedSample, 'x' | 'y'>[] = [],
): Promise<{
  width: number;
  height: number;
  corners: number[];
  samples: Array<[number, number, number, number]>;
}> {
  const base64 = readFileSync(downloadPath).toString('base64');
  return page.evaluate(async ({ pngBase64, normalizedSamples }) => {
    const bytes = Uint8Array.from(atob(pngBase64), (value) => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('2D context unavailable');
    context.drawImage(bitmap, 0, 0);
    const cornerPoints = [
      [0, 0],
      [canvas.width - 1, 0],
      [0, canvas.height - 1],
      [canvas.width - 1, canvas.height - 1],
    ] as const;
    const corners = cornerPoints.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]!);
    const sampled = normalizedSamples.map(({ x, y }) => {
      const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(x * canvas.width)));
      const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(y * canvas.height)));
      return [...context.getImageData(px, py, 1, 1).data] as [number, number, number, number];
    });
    const result = { width: canvas.width, height: canvas.height, corners, samples: sampled };
    bitmap.close();
    canvas.width = canvas.height = 0;
    return result;
  }, { pngBase64: base64, normalizedSamples: samples });
}

async function latestCanvasDigest(page: Page, size: number): Promise<string> {
  return page.evaluate(async (targetSize) => {
    const canvases = (window as unknown as Record<string, unknown>).__m4TrackedCanvases as HTMLCanvasElement[];
    const canvas = canvases.filter(({ width, height }) => width === targetSize && height === targetSize).at(-1);
    if (canvas === undefined) throw new Error(`No tracked ${targetSize}px canvas`);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('2D context unavailable');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = await crypto.subtle.digest('SHA-256', pixels);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }, size);
}

async function latestAlphaBounds(page: Page, size: number): Promise<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}> {
  // 只認「帶透明背景」的合成輸出：3D 管線在合成之後還會產同尺寸的不透明材質
  // canvas（畫紙紋理），單純取最後一張會讀到材質而非合成結果。
  return page.evaluate((targetSize) => {
    const canvases = (window as unknown as Record<string, unknown>).__m4TrackedCanvases as HTMLCanvasElement[];
    const candidates = canvases.filter(({ width, height }) => width === targetSize && height === targetSize);
    if (candidates.length === 0) throw new Error(`No tracked ${targetSize}px canvas`);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const canvas = candidates[index]!;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) continue;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      let transparent = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (pixels[(y * canvas.width + x) * 4 + 3] === 0) {
            transparent += 1;
            continue;
          }
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (transparent > 0) return { minX, minY, maxX, maxY };
    }
    throw new Error(`No tracked ${targetSize}px composition canvas with a transparent background`);
  }, size);
}

async function latestTranslation(page: Page, width: number): Promise<CanvasTranslation> {
  return page.evaluate((targetWidth) => {
    const translations = (window as unknown as Record<string, unknown>).__m4CanvasTranslations as CanvasTranslation[];
    const translation = translations.filter((entry) => entry.width === targetWidth).at(-1);
    if (translation === undefined) throw new Error(`No ${targetWidth}px canvas translation`);
    return translation;
  }, width);
}

function translationToMm(translation: CanvasTranslation, layout: ArtworkLayout): { x: number; y: number } {
  const scale = translation.width / layout.frame.span;
  return {
    x: translation.x / scale + layout.frame.minX - layout.frame.offsetX,
    y: translation.y / scale + layout.frame.minY - layout.frame.offsetY,
  };
}

function rteLayout(overrides: Record<string, number>): ArtworkLayout {
  return deriveArtworkLayout(buildRteFoldModel(resolveParams(reverseTuckEnd, overrides)));
}

test('loads the editor chunk only after EDIT and keeps it cached after DONE', async ({ page }) => {
  const editorChunkRequests: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'script' && isEditorChunk(request.url())) {
      editorChunkRequests.push(request.url());
    }
    await route.continue();
  });

  await gotoReady(page);
  await page.waitForLoadState('networkidle');
  expect(editorChunkRequests, 'DESIGN first paint must not request the editor chunk').toEqual([]);

  await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: dict['fold.art.edit'].en, exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(editorChunkRequests, 'FOLD preview before EDIT must not request the editor chunk').toEqual([]);

  await enterEditor(page);
  await expect.poll(() => editorChunkRequests.length).toBe(1);

  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toHaveCount(0);
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await enterEditor(page);
  expect(editorChunkRequests, 'DONE then EDIT must reuse the loaded chunk').toHaveLength(1);
});

test('EDIT adds an image and text, drags the text, then DONE updates the 3D preview', async ({ page }) => {
  await enterFold(page);
  const foldCanvas = page.locator('.fold-canvas');
  const before = await stableCanvasShot(foldCanvas);
  await enterEditor(page);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: dict['editor.addImage'].en, exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(solidPng('flow-red.png', 64, 128, RED));
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');

  await page.getByRole('button', { name: dict['editor.addText'].en, exact: true }).click();
  const interaction = page.getByTestId('editor-interaction-canvas');
  const box = await interaction.boundingBox();
  expect(box).not.toBeNull();
  await page.keyboard.down('Alt');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 72, box!.y + box!.height / 2 - 48);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toHaveCount(0);
  await expect(page.locator('.fold-view')).toHaveAttribute('data-artwork-ready', 'custom');
  await expect.poll(async () => {
    const pixel = await readArtworkPixel(page, { x: 0.5, y: 0.82 });
    return Math.max(...pixel.map((channel, index) => Math.abs(channel - RED[index]!)));
  }).toBeLessThanOrEqual(4);

  const after = await stableCanvasShot(foldCanvas);
  expect(await screenshotDiffRatio(page, before, after)).toBeGreaterThan(0.0015);
});

test('C1 keeps fixed overlap colors aligned across editor, 2048 source, and 4096 download', async ({ page }) => {
  await installCanvasInstrumentation(page);
  await enterFold(page);
  await enterEditor(page);
  await uploadArtwork(page, solidPng('base-red.png', 96, 96, RED));
  await uploadArtwork(page, solidPng('top-blue.png', 48, 96, BLUE));

  const samples: NormalizedSample[] = [
    { ...panelCenterSample(DEFAULT_LAYOUT, 'P1'), expected: RED },
    { ...panelCenterSample(DEFAULT_LAYOUT, 'P2'), expected: BLUE },
    { ...panelCenterSample(DEFAULT_LAYOUT, 'P3'), expected: BLUE },
  ];
  const displayCanvas = page.getByTestId('editor-canvas-container').locator('canvas').first();
  await expect.poll(async () => {
    const pixel = await sampleCanvasMedian(displayCanvas, samples[1]!);
    return Math.max(...pixel.map((channel, index) => Math.abs(channel - BLUE[index]!)));
  }, { message: 'the second upload must become the blue top layer' }).toBeLessThanOrEqual(18);
  for (const [index, sample] of samples.entries()) {
    expectColor(await sampleCanvasMedian(displayCanvas, sample), sample.expected, `editor sample ${index}`, 18);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: dict['editor.download'].en, exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('Playwright did not provide a download path');
  const inspected = await inspectDownload(page, path, samples);
  expect({ width: inspected.width, height: inspected.height }).toEqual({ width: 4096, height: 4096 });
  inspected.samples.forEach((pixel, index) => {
    expectColor(pixel, samples[index]!.expected, `4096 download sample ${index}`, 4);
  });
  await download.delete();

  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
  await expect(page.getByTestId('editor-canvas-container')).toHaveCount(0);
  const sourceSamples: number[][] = [];
  for (const [index, sample] of samples.entries()) {
    const pixel = await readArtworkPixel(page, sample);
    sourceSamples.push(pixel);
    expectColor(pixel, sample.expected, `2048 source sample ${index}`, 4);
    expectColor(pixel, inspected.samples[index]!, `2048/4096 proportional sample ${index}`, 4);
  }
  expect(sourceSamples[0], 'underlying red must remain outside the blue overlap').not.toEqual(sourceSamples[1]);
});

test('C2 square A-1 seed is pixel-identical and remains the non-undoable baseline', async ({ page }) => {
  await installCanvasInstrumentation(page);
  await enterFold(page);
  await uploadArtwork(page, solidPng('square-seed.png', 64, 64, RED));
  const before = await latestCanvasDigest(page, 2048);

  await enterEditor(page);
  const interaction = page.getByTestId('editor-interaction-canvas');
  await interaction.click({ position: { x: 256, y: 256 } });
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: dict['editor.download'].en, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();

  await expect.poll(() => latestCanvasDigest(page, 2048), {
    message: 'the seeded 2048 composition must match the original M3 source byte-for-byte',
    timeout: 15_000,
  }).toBe(before);
});

test('C2 A-1 seed centers landscape 2:1 and portrait 1:2 without distortion', async ({ page }) => {
  await installCanvasInstrumentation(page);
  const cases = [
    {
      fixture: solidPng('landscape-2x1.png', 128, 64, RED),
      expected: { minX: 0, minY: 512, maxX: 2047, maxY: 1535 },
    },
    {
      fixture: solidPng('portrait-1x2.png', 64, 128, BLUE),
      expected: { minX: 512, minY: 0, maxX: 1535, maxY: 2047 },
    },
  ];

  for (const { fixture, expected } of cases) {
    await enterFold(page);
    await uploadArtwork(page, fixture);
    await enterEditor(page);
    await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
    await expect.poll(async () => {
      const bounds = await latestAlphaBounds(page, 2048);
      return (['minX', 'minY', 'maxX', 'maxY'] as const).every(
        (key) => Math.abs(bounds[key] - expected[key]) <= 1,
      );
    }, { message: `${fixture.name} seeded bounds must converge`, timeout: 15_000 }).toBe(true);
  }
});

test('C5 downloads a paper-backed, clipped, guided 4096 PNG and disables download for whitespace-only text', async ({ page }) => {
  await enterFold(page);
  await enterEditor(page);
  await expect(page.getByRole('button', { name: dict['editor.done'].en, exact: true })).toHaveCSS(
    'border-right-width',
    '0px',
  );
  await page.getByRole('button', { name: dict['editor.addText'].en, exact: true }).click();
  const interaction = page.getByTestId('editor-interaction-canvas');
  await interaction.dblclick({ position: { x: 256, y: 256 } });
  const textarea = page.getByRole('textbox', { name: dict['editor.addText'].en, exact: true });
  const downloadButton = page.getByRole('button', { name: dict['editor.download'].en, exact: true });

  await textarea.fill('   \n  ');
  await expect(downloadButton).toBeDisabled();
  await textarea.fill('CENTER');
  await expect(downloadButton).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('Playwright did not provide a download path');
  const outputSamples: NormalizedSample[] = [
    { ...panelCenterSample(DEFAULT_LAYOUT, 'P4'), expected: PAPER },
    { ...longestCutMidpointSample(DEFAULT_LAYOUT), expected: CUT },
  ];
  const inspected = await inspectDownload(page, path, outputSamples);
  expect({ width: inspected.width, height: inspected.height }).toEqual({ width: 4096, height: 4096 });
  expect(inspected.corners).toEqual([0, 0, 0, 0]);
  inspected.samples.forEach((pixel, index) => {
    expectColor(pixel, outputSamples[index]!.expected, `C5 download sample ${index}`, 12);
  });
  await download.delete();
});

test('C7 keeps stale visible through two parameter changes, preserves coordinates, and clears on DONE', async ({ page }) => {
  await installCanvasInstrumentation(page);
  await enterFold(page);
  await enterEditor(page);
  await page.getByRole('button', { name: dict['editor.addText'].en, exact: true }).click();
  const interaction = page.getByTestId('editor-interaction-canvas');
  const box = await interaction.boundingBox();
  expect(box).not.toBeNull();
  await page.keyboard.down('Alt');
  await page.mouse.move(box!.x + 256, box!.y + 256);
  await page.mouse.down();
  await page.mouse.move(box!.x + 327, box!.y + 211);
  await page.mouse.up();
  await page.keyboard.up('Alt');

  const initialLayout = rteLayout({});
  const before = translationToMm(await latestTranslation(page, 512), initialLayout);
  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();

  const nextL = Number(DEFAULT_VALUES.L) + 10;
  const nextW = Number(DEFAULT_VALUES.W) + 7;
  await page.locator('#param-L').fill(String(nextL));
  await expect(page.getByRole('status')).toHaveText(dict['editor.stale'].en);
  await page.locator('#param-W').fill(String(nextW));
  await expect(page.getByRole('status')).toHaveText(dict['editor.stale'].en);

  await enterEditor(page);
  await expect(page.getByRole('status')).toHaveText(dict['editor.stale'].en);
  const changedLayout = rteLayout({ L: nextL, W: nextW });
  const after = translationToMm(await latestTranslation(page, 512), changedLayout);
  expect(after.x).toBeCloseTo(before.x, 9);
  expect(after.y).toBeCloseTo(before.y, 9);

  await page.getByRole('button', { name: dict['editor.done'].en, exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test.describe('C11 DPR 2', () => {
  test.use({ deviceScaleFactor: 2 });

  test('uses a 2x backing store while CSS-center clicks still hit the rendered object', async ({ page }) => {
    await enterFold(page, { dpr: 2 });
    await enterEditor(page);
    await page.getByRole('button', { name: dict['editor.addText'].en, exact: true }).click();

    const container = page.getByTestId('editor-canvas-container');
    const canvases = container.locator('canvas');
    await expect(canvases).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      const geometry = await canvases.nth(index).evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        return {
          width: canvas.width,
          height: canvas.height,
          cssWidth: canvas.getBoundingClientRect().width,
          cssHeight: canvas.getBoundingClientRect().height,
        };
      });
      expect(geometry.width).toBe(Math.round(geometry.cssWidth * 2));
      expect(geometry.height).toBe(Math.round(geometry.cssHeight * 2));
    }

    const interaction = page.getByTestId('editor-interaction-canvas');
    await interaction.click({ position: { x: 256, y: 256 } });
    await page.keyboard.press('Escape');
    const deleteButton = page.getByRole('button', { name: dict['editor.delete'].en, exact: true });
    await expect(deleteButton).toBeDisabled();
    await interaction.click({ position: { x: 256, y: 256 } });
    await expect(deleteButton).toBeEnabled();
  });
});

test('keyboard chain handles duplicate, delete, undo, redo, and the two-stage Escape', async ({ page }) => {
  await enterFold(page);
  await enterEditor(page);
  await page.getByRole('button', { name: dict['editor.addText'].en, exact: true }).click();
  const interaction = page.getByTestId('editor-interaction-canvas');
  const lower = page.getByRole('button', { name: dict['editor.layerDown'].en, exact: true });
  const deleteButton = page.getByRole('button', { name: dict['editor.delete'].en, exact: true });

  await interaction.click({ position: { x: 256, y: 256 } });
  await page.keyboard.press('Control+d');
  await expect(lower).toBeEnabled();
  await page.keyboard.press('Delete');
  await expect(deleteButton).toBeDisabled();
  await expect(lower).toBeDisabled();

  await page.keyboard.press('Control+z');
  await interaction.click({ position: { x: 256, y: 256 } });
  await expect(lower).toBeEnabled();
  await page.keyboard.press('Control+Shift+z');
  await expect(lower).toBeDisabled();

  await page.keyboard.press('Control+z');
  await interaction.click({ position: { x: 256, y: 256 } });
  await expect(lower).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(lower).toBeDisabled();
  await expect(page.getByTestId('editor-canvas-container')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('editor-canvas-container')).toHaveCount(0);
  await expect(page.locator('.fold-canvas')).toBeVisible();
});

test('zh editor interface matches every visible F7 literal word-for-word', async ({ page }) => {
  await enterFold(page, { lang: 'zh' });
  await expect(page.getByRole('button', { name: '編輯', exact: true })).toBeVisible();
  await enterEditor(page, 'zh');

  const toolbar = page.getByRole('toolbar', { name: '編輯', exact: true });
  for (const copy of ['加圖', '加字', '上移', '下移', '複製', '刪除', '下載成品', '完成']) {
    await expect(toolbar.getByRole('button', { name: copy, exact: true })).toHaveCount(1);
  }
  await expect(toolbar.getByRole('button', { name: '完成', exact: true })).toHaveCSS(
    'border-right-width',
    '0px',
  );
  await expect(page.getByRole('status')).toHaveText('加入圖片或文字開始編輯。');

  await toolbar.getByRole('button', { name: '加字', exact: true }).click();
  const interaction = page.getByTestId('editor-interaction-canvas');
  await interaction.dblclick({ position: { x: 256, y: 256 } });
  const panel = page.getByTestId('editor-text-panel');
  await expect(panel.getByRole('textbox', { name: '加字', exact: true })).toHaveValue('加字');
  for (const copy of ['無襯線', '襯線', '等寬', '左', '中', '右', '墨', '淡墨', '刀紅', '摺藍', '黃銅']) {
    await expect(panel.getByRole('button', { name: copy, exact: true })).toHaveCount(1);
  }

  await page.locator('#param-L').fill(String(Number(DEFAULT_VALUES.L) + 5));
  await expect(page.getByRole('status')).toHaveText('參數已變更，請重新對位物件。');
});
