import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { resolveParams } from '../src/core/registry';
import { buildRteFoldModel } from '../src/fold/models/reverse-tuck-end';
import { worldGeometry } from '../src/fold/pose3d';
import { foldPose } from '../src/fold/schedule';
import { dict } from '../src/i18n/dict';
import { deriveArtworkLayout } from '../src/ui/artwork-layout';
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
const PANEL_COLORS = {
  P2: { css: '#cc2244', rgba: [204, 34, 68, 255] as const, channel: 0 },
  P3: { css: '#22aa66', rgba: [34, 170, 102, 255] as const, channel: 1 },
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
  expect(sampled.P2).not.toEqual(sampled.P3);
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
