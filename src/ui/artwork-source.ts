/** P3 M3 upload validation and raster transaction. Kept behind FoldView's lazy boundary. */
import type { CustomArtworkSource } from './fold-scene';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RASTER_EDGE = 8192;
const MAX_RASTER_PIXELS = 33_554_432;
const SOURCE_SIZE = 2048;

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

export interface ArtworkLoadOptions {
  signature: string;
  signal?: AbortSignal;
  onCommit: (source: CustomArtworkSource) => void;
}

let latestRequestId = 0;

function reject(code: ArtworkRejectionCode): ArtworkValidationResult {
  return { code };
}

function hasExternalSvgResource(markup: string): boolean {
  return /<script(?:\s|>)|\b(?:xlink:)?href\s*=\s*(['"])(?!\s*#)|url\((?!\s*["']?\s*#)/i
    .test(markup);
}

async function validateSvg(file: File): Promise<ArtworkValidationResult> {
  const markup = await file.text();
  if (hasExternalSvgResource(markup)) return reject('external');
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = documentNode.documentElement;
  if (documentNode.querySelector('parsererror') !== null || root.localName !== 'svg') {
    return reject('parse');
  }

  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (
    viewBox.length !== 4
    || !viewBox.every(Number.isFinite)
    || Math.min(viewBox[2]!, viewBox[3]!) <= 0
  ) {
    return reject('viewbox');
  }

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

  const { width, height } = decoded;
  decoded.close();
  if (
    Math.min(width, height) <= 0
    || Math.max(width, height) > MAX_RASTER_EDGE
    || width * height > MAX_RASTER_PIXELS
  ) {
    return reject('pixels');
  }
  return null;
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
    canvas.width = canvas.height = SOURCE_SIZE;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error();
    context.drawImage(image, 0, 0, SOURCE_SIZE, SOURCE_SIZE);
    return { canvas, signature };
  } finally {
    signal?.removeEventListener('abort', cancel);
    URL.revokeObjectURL(url);
  }
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

  let source: CustomArtworkSource;
  try {
    source = await rasterizeToSource(file, options.signature, options.signal);
  } catch {
    return isCurrent() ? { code: 'decode' } : 'cancelled';
  }

  if (!isCurrent()) {
    source.canvas.width = source.canvas.height = 0;
    return 'cancelled';
  }

  options.onCommit(source);
  return 'committed';
}
