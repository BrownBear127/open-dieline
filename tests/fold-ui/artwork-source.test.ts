import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashArtworkLayoutSignature } from '@/ui/artwork-layout';
import {
  evaluateArtworkWarnings,
  loadArtworkFile,
  primaryArtworkWarning,
  rasterizeToSource,
  validateArtworkFile,
} from '@/ui/artwork-source';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
let drawImage: ReturnType<typeof vi.fn>;

function fileWithSize(name: string, type: string, size: number): File {
  const file = new File(['fixture'], name, { type });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

function bitmap(width = 100, height = 100): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
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

function pngDataUri(width = 1, height = 1): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanline = Buffer.from([0, 34, 85, 204, 255]);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function svgWithEmbeddedRasters(dataUris: readonly string[]): string {
  const images = dataUris.map((dataUri) => `<image href="${dataUri}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${images}</svg>`;
}

function jpegDataUriWithFrames(
  frames: readonly (readonly [marker: number, width: number, height: number])[],
): string {
  const frameBytes = frames.flatMap(([marker, width, height]) => [
    0xff, marker, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]);
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x12, 0x34,
    ...frameBytes,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function jpegDataUri(marker: number, width = 1, height = 1): string {
  return jpegDataUriWithFrames([[marker, width, height]]);
}

class DeferredImage {
  static instances: DeferredImage[] = [];

  decoding = 'async';
  private currentSrc = '';
  private resolveDecode!: () => void;
  private rejectDecode!: (error: Error) => void;
  private readonly decoded = new Promise<void>((resolve, reject) => {
    this.resolveDecode = resolve;
    this.rejectDecode = reject;
  });

  constructor() {
    DeferredImage.instances.push(this);
  }

  get src(): string {
    return this.currentSrc;
  }

  set src(value: string) {
    const wasLoading = this.currentSrc !== '';
    this.currentSrc = value;
    if (wasLoading && value === '') this.rejectDecode(new Error('cancelled'));
  }

  decode(): Promise<void> {
    return this.decoded;
  }

  resolve(): void {
    this.resolveDecode();
  }

  reject(): void {
    this.rejectDecode(new Error('decode'));
  }
}

async function waitForImages(count: number): Promise<void> {
  await vi.waitFor(() => expect(DeferredImage.instances).toHaveLength(count));
}

beforeEach(() => {
  DeferredImage.instances = [];
  vi.stubGlobal('Image', DeferredImage);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => `blob:${(blob as File).name}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage,
  }) as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validateArtworkFile', () => {
  it('rejects an empty MIME before inspecting bytes or decoding', async () => {
    const result = await validateArtworkFile(new File(['png'], 'art.png'));

    expect(result).toEqual({ code: 'type' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('rejects a MIME and filename-extension mismatch', async () => {
    const file = new File(['jpeg'], 'art.png', { type: 'image/jpeg' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'mismatch' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('rejects files larger than 25 MiB before decoding', async () => {
    const file = fileWithSize('art.png', 'image/png', MAX_FILE_BYTES + 1);

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'bytes' });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('uses oriented bitmap dimensions and rejects an oversized raster', async () => {
    const decoded = bitmap(8193, 100);
    vi.mocked(createImageBitmap).mockResolvedValueOnce(decoded);

    await expect(validateArtworkFile(
      new File(['png'], 'art.png', { type: 'image/png' }),
    )).resolves.toEqual({ code: 'pixels' });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(File), {
      imageOrientation: 'from-image',
    });
    expect(decoded.close).toHaveBeenCalledOnce();
  });

  it('rejects a raster whose pixel area exceeds the limit even when both edges fit', async () => {
    vi.mocked(createImageBitmap).mockResolvedValueOnce(bitmap(6000, 6000));

    await expect(validateArtworkFile(
      new File(['png'], 'art.png', { type: 'image/png' }),
    )).resolves.toEqual({ code: 'pixels' });
  });

  it('accepts a viewBox-only SVG and derives finite dimensions from it', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200"/></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts a clean SVG without inline event handler attributes', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><rect width="10" height="10"/></g></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it.each([
    [
      'root',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><rect width="10" height="10"/></svg>',
    ],
    [
      'child',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" onclick="alert(1)"/></svg>',
    ],
  ])('rejects an inline event handler attribute on the %s element', async (_label, markup) => {
    const file = new File([markup], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects an SVG without a valid positive viewBox', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'viewbox' });
  });

  it('rejects a non-finite explicit SVG dimension', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="Infinity"></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'size' });
  });

  it('accepts fragment-only href and url references', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect id="r" fill="url(#g)"/><use href="#r"/></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts transform function notation outside style positions', async () => {
    // 嚴格 (-掃描只限 style＋mask 位置——presentation/transform attr 走 url( 掃描，
    // Illustrator 匯出稿的 transform="translate(...)"／filter="blur(2px)" 不得誤拒。
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g transform="translate(3,4) rotate(15)"><rect fill="url(#g)" filter="blur(2px)" cursor="pointer" style="fill-opacity:0.5"/></g></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts fragment-only src() references in url-token positions', async () => {
    // CSS Values 4 <url> = url() | src()——fragment 形態與 url(#...) 同白名單。
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="src(#g)"/></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it.each([
    ['single-quoted url fragment', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(\'#g\')"/></svg>'],
    ['double-quoted url fragment', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill=\'url("#g")\'/></svg>'],
    ['single-quoted src fragment', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="src(\'#g\')"/></svg>'],
    ['whitespace-padded url fragment', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url( #g )"/></svg>'],
  ])('accepts a quoted or padded fragment reference (%s) without false rejection', async (_label, markup) => {
    // 八審回歸：negative lookahead 消耗引號後回溯使帶引號 fragment 假陽性。
    const file = new File([markup], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts fragment-only mask references under the strict mask scan', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><mask id="m"/></defs><rect width="10" height="10" mask="url(#m)"/></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts a 1x1 PNG data URI on an image href', async () => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="${pngDataUri()}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('accepts an SVG containing 15 embedded rasters', async () => {
    const file = new File([
      svgWithEmbeddedRasters(Array.from({ length: 15 }, () => pngDataUri())),
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('rejects an SVG containing 17 embedded rasters', async () => {
    const file = new File([
      svgWithEmbeddedRasters(Array.from({ length: 17 }, () => pngDataUri())),
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
  });

  it('accepts embedded rasters whose combined area equals the raster pixel limit', async () => {
    const file = new File([
      svgWithEmbeddedRasters([pngDataUri(4096, 4096), pngDataUri(4096, 4096)]),
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it('rejects embedded rasters whose combined area exceeds the raster pixel limit by one', async () => {
    const file = new File([
      svgWithEmbeddedRasters([
        pngDataUri(4096, 4096),
        pngDataUri(4096, 4096),
        pngDataUri(),
      ]),
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
  });

  it.each([
    ['SOF0', jpegDataUri(0xc0)],
    ['SOF2', jpegDataUri(0xc2)],
  ])('accepts a JPEG data URI whose dimensions come from %s', async (_label, dataUri) => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image xlink:href="${dataUri}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it.each([
    ['SOF1', jpegDataUri(0xc1, 8000, 4000)],
    ['SOF5', jpegDataUri(0xc5, 4096, 4096)],
  ])('accepts a JPEG data URI whose dimensions come from the %s variant', async (_label, dataUri) => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="${dataUri}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
  });

  it.each([
    [
      'SOF0 followed by SOF2',
      jpegDataUriWithFrames([[0xc0, 1, 1], [0xc2, 8000, 8000]]),
    ],
    [
      'SOF1 followed by SOF0',
      jpegDataUriWithFrames([[0xc1, 8000, 4000], [0xc0, 1, 1]]),
    ],
  ])('rejects a JPEG data URI containing multiple frame headers (%s)', async (_label, dataUri) => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="${dataUri}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
  });

  it.each([
    ['SVG image data URI', 'image', 'href', 'data:image/svg+xml;base64,PHN2Zy8+'],
    ['URL-encoded PNG data URI', 'image', 'href', 'data:image/png,%89PNG'],
    ['PNG data URI with a media parameter', 'image', 'href', pngDataUri().replace(';base64', ';charset=utf-8;base64')],
    ['PNG data URI on a use element', 'use', 'href', pngDataUri()],
    ['PNG data URI on an image src attribute', 'image', 'src', pngDataUri()],
    ['PNG data URI on an uppercase IMAGE element', 'IMAGE', 'href', pngDataUri()],
    ['PNG data URI in a style url', 'rect', 'style', `fill:url(${pngDataUri()})`],
    ['PNG data URI with an oversized IHDR', 'image', 'href', pngDataUri(8193, 1)],
    ['PNG data URI whose IHDR area is oversized', 'image', 'href', pngDataUri(6000, 6000)],
    ['truncated PNG base64', 'image', 'href', 'data:image/png;base64,iVBORw0KGgoAAAAA'],
  ])('rejects %s', async (_label, element, attribute, value) => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><${element} ${attribute}="${value}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
  });

  it('rejects a data URI on a mixed-case XLink:href attribute', async () => {
    const file = new File([
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:XLink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><image XLink:href="${pngDataUri()}"/></svg>`,
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use xlink:href="data:image/png;base64,AA=="/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>rect{fill:url(https://example.com/a.svg)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>',
  ])('rejects SVG external or executable resources without creating a URL', async (markup) => {
    const file = new File([markup], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    [
      'external CSS @import',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import "https://example.com/a.css";</style></svg>',
    ],
    [
      'foreignObject with a nested image src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://example.com/a.png"/></div></foreignObject></svg>',
    ],
    [
      'style attribute with an external url',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:url(https://example.com/a.svg)"/></svg>',
    ],
    [
      'mixed-case xlink namespace href',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:XLink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use XLink:href="https://example.com/a.svg#shape"/></svg>',
    ],
    [
      'data URI href',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,AA=="/></svg>',
    ],
    [
      'CSS-escaped url in a style attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect style="fill:u\\72l(https://example.com/a.svg)"/></svg>',
    ],
    [
      'CSS-escaped @import in a style element',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@\\69mport "https://example.com/a.css";</style></svg>',
    ],
    [
      'image-set string reference in a style element',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>svg { background-image: image-set("https://example.com/a.png" 1x) }</style></svg>',
    ],
    [
      'image-set string reference in a style attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" style="background-image:image-set(\'https://example.com/a.png\' 1x)"></svg>',
    ],
    [
      'image-set string reference in a mask presentation attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" mask="image-set(\'http://probe.invalid/a.png\' 1x)"/></svg>',
    ],
    [
      'image-set string reference in a cursor presentation attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" cursor="image-set(\'http://probe.invalid/cursor.png\' 1x), auto"/></svg>',
    ],
    [
      'src() url reference in a fill presentation attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="src(\'http://probe.invalid/fill.svg\')"/></svg>',
    ],
    [
      'src() url reference in a marker-start presentation attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L5 5" marker-start="src(\'http://probe.invalid/m.svg\')"/></svg>',
    ],
    [
      'src() url reference in a clip-path presentation attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect clip-path="src(\'http://probe.invalid/c.svg\')"/></svg>',
    ],
    [
      'unclosed url() reference recovered by CSS EOF auto-close',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="url(\'http://probe.invalid/unclosed.svg\'"/></svg>',
    ],
    [
      'unclosed src() reference recovered by CSS EOF auto-close',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="src(\'http://probe.invalid/unclosed.svg\'"/></svg>',
    ],
  ])('rejects %s during the mandatory DOM resource scan', async (_label, markup) => {
    const file = new File([markup], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'external' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('rejects SVG parser errors', async () => {
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toEqual({ code: 'parse' });
  });
});

describe('rasterizeToSource', () => {
  it('draws the whole square frame into 2048px and revokes its blob URL once', async () => {
    const file = new File(['png'], 'art.png', { type: 'image/png' });
    const promise = rasterizeToSource(file, 'rte:{L:120}');
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    const source = await promise;
    expect(source).toMatchObject({ signature: 'rte:{L:120}' });
    expect(source.canvas.width).toBe(2048);
    expect(source.canvas.height).toBe(2048);
    expect(drawImage).toHaveBeenCalledExactlyOnceWith(
      DeferredImage.instances[0], 0, 0, 2048, 2048,
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:art.png');
  });

  it('revokes its blob URL once when decode fails', async () => {
    const file = new File(['png'], 'broken.png', { type: 'image/png' });
    const promise = rasterizeToSource(file, 'signature');
    await waitForImages(1);

    DeferredImage.instances[0]!.reject();

    await expect(promise).rejects.toBeInstanceOf(Error);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:broken.png');
  });
});

describe('loadArtworkFile transaction', () => {
  it('commits the unchanged 2048 source with a retained original-size editable sidecar', async () => {
    const validationBitmap = bitmap(640, 320);
    const editableBitmap = bitmap(640, 320);
    vi.mocked(createImageBitmap)
      .mockResolvedValueOnce(validationBitmap)
      .mockResolvedValueOnce(editableBitmap);
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File(['art'], 'art.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    await expect(promise).resolves.toEqual({ status: 'committed', warnings: [] });

    expect(commits).toHaveBeenCalledOnce();
    expect(commits.mock.calls[0]![0]).toMatchObject({ signature: 'layout-a' });
    expect(commits.mock.calls[0]![0].canvas).toMatchObject({ width: 2048, height: 2048 });
    expect(commits.mock.calls[0]![1]).toEqual({
      bitmap: editableBitmap,
      width: 640,
      height: 320,
      revision: expect.any(Number),
    });
    expect(validationBitmap.close).toHaveBeenCalledOnce();
    expect(editableBitmap.close).not.toHaveBeenCalled();
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, expect.any(File), {
      imageOrientation: 'from-image',
    });
    expect(createImageBitmap).toHaveBeenNthCalledWith(2, expect.any(File), {
      imageOrientation: 'from-image',
    });
    expect(vi.mocked(createImageBitmap).mock.calls.every(([source]) => source instanceof File))
      .toBe(true);
  });

  it('rasterizes an SVG sidecar at its viewBox ratio without decoding the File as a bitmap', async () => {
    const editableBitmap = bitmap(4096, 2048);
    vi.mocked(createImageBitmap).mockResolvedValueOnce(editableBitmap);
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"></svg>',
      ], 'art.svg', { type: 'image/svg+xml' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    await waitForImages(2);
    DeferredImage.instances[1]!.resolve();
    // 400×200＝2:1，無 page-frame——aspect 警示如實觸發（本測試焦點是
    // sidecar 依非方形 viewBox 比例縮放，不是「必為方形」；警示與縮放正確性正交）。
    await expect(promise).resolves.toEqual({ status: 'committed', warnings: ['aspect'] });

    expect(drawImage).toHaveBeenNthCalledWith(
      1, DeferredImage.instances[0], 0, 0, 4096, 2048,
    );
    expect(createImageBitmap).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLCanvasElement));
    expect(createImageBitmap).not.toHaveBeenCalledWith(expect.any(File), expect.anything());
    expect(commits.mock.calls[0]![1]).toEqual({
      bitmap: editableBitmap,
      width: 4096,
      height: 2048,
      revision: expect.any(Number),
    });
  });

  it('rejects and closes an oversized decoded SVG sidecar before creating the preview', async () => {
    const oversized = bitmap(8193, 100);
    vi.mocked(createImageBitmap).mockResolvedValueOnce(oversized);
    const commits = vi.fn();

    const promise = loadArtworkFile(
      new File([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8193 100"></svg>',
      ], 'oversized.svg', { type: 'image/svg+xml' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    await expect(promise).resolves.toEqual({ code: 'pixels' });

    expect(oversized.close).toHaveBeenCalledOnce();
    expect(DeferredImage.instances).toHaveLength(1);
    expect(commits).not.toHaveBeenCalled();
  });

  it('commits only B when A and B finish in reverse order', async () => {
    const commits = vi.fn();
    const first = loadArtworkFile(
      new File(['a'], 'a.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'A', onCommit: commits },
    );
    await waitForImages(1);
    const second = loadArtworkFile(
      new File(['b'], 'b.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'B', onCommit: commits },
    );
    await waitForImages(2);

    DeferredImage.instances[1]!.resolve();
    await expect(second).resolves.toEqual({ status: 'committed', warnings: [] });
    DeferredImage.instances[0]!.resolve();
    await expect(first).resolves.toBe('cancelled');

    expect(commits).toHaveBeenCalledOnce();
    expect(commits.mock.calls[0]![0]).toMatchObject({ signature: 'B' });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('does not commit a decode cancelled by switching to NONE', async () => {
    const controller = new AbortController();
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File(['a'], 'a.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'A', signal: controller.signal, onCommit: commits },
    );
    await waitForImages(1);

    controller.abort();
    DeferredImage.instances[0]!.reject();

    await expect(promise).resolves.toBe('cancelled');
    expect(commits).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:a.png');
  });

  it('does not commit after its owner is disposed', async () => {
    const owner = new AbortController();
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File(['a'], 'a.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'A', signal: owner.signal, onCommit: commits },
    );
    await waitForImages(1);

    owner.abort();

    await expect(promise).resolves.toBe('cancelled');
    expect(commits).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:a.png');
  });
});

// 上傳對位 guard-rail：頁框錨定＋警示。frame 座標刻意跟 mangled 外層 viewBox
// 差很多（不對稱、不同數量級），這樣「改寫生效」與「改寫沒生效（假綠）」在斷言上
// 會有清楚可辨的差異，不是容差邊緣的巧合通過。
const TRUE_FRAME = { x: 3, y: 5, width: 120, height: 120 } as const;

function mangledSvgWithPageFrame(options?: {
  wrapGuidesInDisplayNone?: boolean;
  boxId?: string;
  layoutHash?: string;
  includeWidthHeight?: boolean;
}): string {
  const attrs = [
    options?.boxId !== undefined ? `data-box-id="${options.boxId}"` : '',
    options?.layoutHash !== undefined ? `data-layout-hash="${options.layoutHash}"` : '',
  ].filter((entry) => entry !== '').join(' ');
  const pageFrameRect = `<rect data-role="page-frame" x="${TRUE_FRAME.x}" y="${TRUE_FRAME.y}" `
    + `width="${TRUE_FRAME.width}" height="${TRUE_FRAME.height}" fill="none"/>`;
  const guides = options?.wrapGuidesInDisplayNone === true
    ? `<g id="TEMPLATE_GUIDES" style="display:none">${pageFrameRect}</g>`
    : `<g id="TEMPLATE_GUIDES">${pageFrameRect}</g>`;
  const widthHeight = options?.includeWidthHeight === false ? '' : ' width="850.39pt" height="611.02pt"';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs} viewBox="0 0 850.39 611.02"${widthHeight}>`
    + `${guides}<g id="ARTWORK"><rect x="10" y="10" width="5" height="5" fill="#ff0000"/></g></svg>`;
}

function nonSquareSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#2255cc"/></svg>`;
}

async function objectUrlBlobText(index: number): Promise<string> {
  const [blob] = vi.mocked(URL.createObjectURL).mock.calls[index]!;
  return (blob as File).text();
}

/** 送出一份 SVG 上傳並把兩個 rasterize 路徑（sidecar／source）的 DeferredImage 都 resolve 完。 */
async function uploadSvg(
  markup: string,
  options: { boxId: string; signature: string; onCommit?: (...args: unknown[]) => void },
): ReturnType<typeof loadArtworkFile> {
  const promise = loadArtworkFile(
    new File([markup], 'artwork.svg', { type: 'image/svg+xml' }),
    { boxId: options.boxId, signature: options.signature, onCommit: options.onCommit ?? vi.fn() },
  );
  await waitForImages(1);
  DeferredImage.instances[0]!.resolve();
  await waitForImages(2);
  DeferredImage.instances[1]!.resolve();
  return promise;
}

describe('loadArtworkFile — 頁框錨定（改寫 viewBox 為頁框矩形＋覆寫 width/height）', () => {
  it('偵測到 [data-role="page-frame"]（含 display:none 群組內）時，改寫 viewBox／width／height 為頁框矩形，兩條 rasterize 路徑都吃到改寫後的檔案', async () => {
    const commits = vi.fn();
    const markup = mangledSvgWithPageFrame({ wrapGuidesInDisplayNone: true });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a', onCommit: commits });

    expect(result).toEqual({ status: 'committed', warnings: [] });
    expect(commits).toHaveBeenCalledOnce();
    // metadata 隨 CustomArtworkSource 一起交出
    // （原樣存放，不是預先烤好的 warnings 陣列）——顯示層才能拿「當下」boxId/hash 重算。
    expect(commits.mock.calls[0]![0].alignmentMetadata).toEqual({
      boxId: null,
      layoutHash: null,
      aspectMismatch: false,
    });

    const expectedViewBox = `viewBox="${TRUE_FRAME.x} ${TRUE_FRAME.y} ${TRUE_FRAME.width} ${TRUE_FRAME.height}"`;
    for (const index of [0, 1]) {
      const markupText = await objectUrlBlobText(index);
      expect(markupText, `rasterize path #${index}`).toContain(expectedViewBox);
      expect(markupText, `rasterize path #${index}`).toContain(`width="${TRUE_FRAME.width}"`);
      expect(markupText, `rasterize path #${index}`).toContain(`height="${TRUE_FRAME.height}"`);
      expect(markupText, `rasterize path #${index}`).not.toContain('850.39');
      expect(markupText, `rasterize path #${index}`).not.toContain('611.02');
    }
  });

  it('root 原有 width/height 與 viewBox 比例嚴重不一致（letterbox 成因）→ 改寫後 width/height 精確等於頁框尺寸，不殘留原數值', async () => {
    const frame = { x: 0, y: 0, width: 130, height: 130 };
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300" width="5000" height="10">`
      + `<rect data-role="page-frame" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/>`
      + `<g id="ARTWORK"/></svg>`;
    await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    const sourceMarkup = await objectUrlBlobText(1);
    expect(sourceMarkup).toContain(`width="${frame.width}"`);
    expect(sourceMarkup).toContain(`height="${frame.height}"`);
    expect(sourceMarkup).not.toContain('width="5000"');
    expect(sourceMarkup).not.toContain('height="10"');
  });

  it('無頁框時完全不改寫檔案內容（原樣傳遞進兩條 rasterize 路徑，非「恆改寫」）', async () => {
    const markup = nonSquareSvg(100, 100);
    await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(await objectUrlBlobText(0)).toBe(markup);
    expect(await objectUrlBlobText(1)).toBe(markup);
  });

  it('含 page-frame 但也含外部資源引用的 SVG 仍在既有驗證階段被拒絕——改寫不會繞過任何既有安全掃描', async () => {
    const malicious = mangledSvgWithPageFrame().replace('<g id="ARTWORK">', '<script>alert(1)</script><g id="ARTWORK">');
    const commits = vi.fn();

    const result = await loadArtworkFile(
      new File([malicious], 'evil.svg', { type: 'image/svg+xml' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );

    expect(result).toEqual({ code: 'external' });
    expect(commits).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

// findPageFrameRect 對「合法極端輸入」必須嚴格
// （單位字尾／transform／多候選／defs／非 SVG namespace）——這些情況下錨錯比不錨更
// 糟（Illustrator 常在群組包 transform matrix）。不做座標變換數學，做 fail-safe：
// 偵測到任一異常就放棄錨定（frame=null，回退原檔行為＋併入 aspect 警示規則）。
// 每支 fixture 的外層 viewBox 刻意非正方形（850.39×611.02）——放棄錨定後應觸發
// aspect 警示，直接驗證「併入 aspect 規則」的行為，而不只是「沒被改寫」。
describe('loadArtworkFile — findPageFrameRect fail-safe（異常輸入放棄錨定）', () => {
  async function expectBailOut(markup: string): Promise<void> {
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });
    expect(result).toEqual({ status: 'committed', warnings: ['aspect'] });
    expect(await objectUrlBlobText(0)).toBe(markup);
    expect(await objectUrlBlobText(1)).toBe(markup);
  }

  it.each([
    ['x 帶 mm 單位字尾', 'x="3mm" y="5" width="120" height="120"'],
    ['width 帶 px 單位字尾', 'x="3" y="5" width="120px" height="120"'],
    ['height 帶百分比', 'x="3" y="5" width="120" height="100%"'],
    ['y 為空字串', 'x="3" y="" width="120" height="120"'],
    ['width 為非數字字串', 'x="3" y="5" width="wide" height="120"'],
  ])('頁框 rect 屬性非嚴格純數字（%s）→ 視為異常，放棄錨定（不做單位換算）', async (_label, attrs) => {
    await expectBailOut(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">`
      + `<rect data-role="page-frame" ${attrs}/>`
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('頁框 rect 自身帶 transform → 視為異常，放棄錨定', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<rect data-role="page-frame" x="3" y="5" width="120" height="120" transform="translate(1,1)"/>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('頁框 rect 的祖先群組帶 transform → 視為異常，放棄錨定（Illustrator 常見群組 matrix）', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<g transform="matrix(1,0,0,1,2,3)"><rect data-role="page-frame" x="3" y="5" width="120" height="120"/></g>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('祖先鏈更深層（曾孫層級）帶 transform 也視為異常（非只查直接父層）', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<g transform="scale(1.01)"><g><g><rect data-role="page-frame" x="3" y="5" width="120" height="120"/></g></g></g>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('多個 data-role="page-frame" 候選 → 視為異常，放棄錨定（無法判斷哪個才是真頁框）', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<rect data-role="page-frame" x="3" y="5" width="120" height="120"/>'
      + '<rect data-role="page-frame" x="0" y="0" width="100" height="100"/>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('頁框 rect 位於 <defs> 內 → 視為異常，放棄錨定（defs 內容不直接渲染）', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<defs><rect data-role="page-frame" x="3" y="5" width="120" height="120"/></defs>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('data-role="page-frame" 落在非 SVG namespace 的元素上 → 視為異常，放棄錨定', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<rect xmlns="urn:example:not-svg" data-role="page-frame" x="3" y="5" width="120" height="120"/>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('data-role="page-frame" 落在非 rect 元素上（如 circle）→ 視為異常，放棄錨定', async () => {
    await expectBailOut(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<circle data-role="page-frame" cx="60" cy="60" r="60"/>'
      + '<g id="ARTWORK"/></svg>',
    );
  });

  it('頁框 rect 缺省 x/y（依 SVG 規格預設為 0）仍視為合法頁框，非異常（不要求座標必須顯式寫出）', async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850.39 611.02">'
      + '<rect data-role="page-frame" width="120" height="120"/>'
      + '<g id="ARTWORK"/></svg>';
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
    expect(await objectUrlBlobText(1)).toContain('viewBox="0 0 120 120"');
  });
});

describe('loadArtworkFile — PNG／JPEG 不受影響（non-goal：不做頁框錨定）', () => {
  it('PNG 上傳完全不做頁框掃描或警示計算，commit 結果 warnings 恆為空陣列', async () => {
    vi.mocked(createImageBitmap).mockResolvedValue(bitmap(640, 320));
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File(['art'], 'art.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);
    DeferredImage.instances[0]!.resolve();

    await expect(promise).resolves.toEqual({ status: 'committed', warnings: [] });
    expect(commits).toHaveBeenCalledOnce();
  });
});

describe('loadArtworkFile — 警示契約（box-mismatch / stale-template / aspect）', () => {
  it('data-box-id 存在且與目前 boxId 不同 → box-mismatch 警示，仍照常 commit（warn-and-apply）', async () => {
    const commits = vi.fn();
    const markup = mangledSvgWithPageFrame({ boxId: 'ttb' });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a', onCommit: commits });

    expect(result).toEqual({ status: 'committed', warnings: ['box-mismatch'] });
    expect(commits).toHaveBeenCalledOnce();
  });

  it('data-box-id 與目前 boxId 相同 → 不警示', async () => {
    const markup = mangledSvgWithPageFrame({ boxId: 'rte' });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
  });

  it('data-layout-hash 存在且與目前 signature 的 hash 不同 → stale-template 警示', async () => {
    const markup = mangledSvgWithPageFrame({ layoutHash: 'deadbeef' });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: ['stale-template'] });
  });

  it('data-layout-hash 與目前 signature 的 hash 相同 → 不警示 stale', async () => {
    const matchingHash = hashArtworkLayoutSignature('layout-a');
    const markup = mangledSvgWithPageFrame({ layoutHash: matchingHash });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
  });

  it('metadata 缺失（無 data-box-id、無 data-layout-hash）→ 不警示 box-mismatch／stale-template', async () => {
    const markup = mangledSvgWithPageFrame();
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
  });

  it('box-mismatch 與 stale-template 同時成立時，warnings 陣列同時帶出兩者', async () => {
    const markup = mangledSvgWithPageFrame({ boxId: 'ttb', layoutHash: 'deadbeef' });
    const result = await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a' });

    expect(result).toMatchObject({
      status: 'committed',
      warnings: expect.arrayContaining(['box-mismatch', 'stale-template']),
    });
  });

  it('無頁框且 viewBox 長寬比偏離正方形超過容差 → aspect 警示（仍照常 commit）', async () => {
    const result = await uploadSvg(nonSquareSvg(800, 400), { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: ['aspect'] });
  });

  it('無頁框但 viewBox 為正方形（容差內）→ 不警示、行為不變（正常檔案分支）', async () => {
    const result = await uploadSvg(nonSquareSvg(100, 100), { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
  });

  it('找到頁框時不做 aspect 檢查，即使外層 viewBox 非方形（頁框本身已是對位基準）', async () => {
    const result = await uploadSvg(mangledSvgWithPageFrame(), { boxId: 'rte', signature: 'layout-a' });

    expect(result).toEqual({ status: 'committed', warnings: [] });
  });
});

describe('primaryArtworkWarning（box-mismatch > stale-template > aspect）', () => {
  it('空陣列 → null', () => {
    expect(primaryArtworkWarning([])).toBeNull();
  });

  it.each([
    [['aspect'], 'aspect'],
    [['stale-template'], 'stale-template'],
    [['stale-template', 'aspect'], 'stale-template'],
    [['box-mismatch', 'stale-template', 'aspect'], 'box-mismatch'],
    [['aspect', 'box-mismatch'], 'box-mismatch'],
    [['box-mismatch'], 'box-mismatch'],
  ] as const)('%s → %s', (warnings, expected) => {
    expect(primaryArtworkWarning(warnings)).toBe(expected);
  });
});

// 警示不再於上傳當下「凍結」——loadArtworkFile
// 只負責把上傳檔的原始 metadata（data-box-id／data-layout-hash／aspectMismatch）交出，
// 「跟目前 boxId／目前 layout signature 比對」這件事抽成純函式 evaluateArtworkWarnings，
// 顯示層（FoldView）每次 render 都能拿「當下」的值重新求值——盒型或參數之後再變，
// 警示會跟著動態重算，不會卡在上傳那一刻的舊答案。
describe('evaluateArtworkWarnings（純函式：metadata × 當下 boxId／當下 hash → warnings[]）', () => {
  const HASH_A = hashArtworkLayoutSignature('layout-a');
  const HASH_B = hashArtworkLayoutSignature('layout-b');

  it('metadata.boxId 與當下 boxId 不同 → box-mismatch', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: 'ttb', layoutHash: null, aspectMismatch: false },
      'rte',
      null,
    );
    expect(warnings).toEqual(['box-mismatch']);
  });

  it('metadata.boxId 與當下 boxId 相同 → 不警示（同一份 metadata，只是當下 boxId 換了才會變）', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: 'rte', layoutHash: null, aspectMismatch: false },
      'rte',
      null,
    );
    expect(warnings).toEqual([]);
  });

  it('metadata.layoutHash 與當下 hash 不同 → stale-template', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: null, layoutHash: HASH_A, aspectMismatch: false },
      'rte',
      HASH_B,
    );
    expect(warnings).toEqual(['stale-template']);
  });

  it('metadata.layoutHash 與當下 hash 相同 → 不警示（同一份 metadata，換一個「當下 hash」結果就不同）', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: null, layoutHash: HASH_A, aspectMismatch: false },
      'rte',
      HASH_A,
    );
    expect(warnings).toEqual([]);
  });

  it('metadata.layoutHash 存在但當下 hash 為 null（尚無可用 model）→ 不警示 stale（無從比較）', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: null, layoutHash: HASH_A, aspectMismatch: false },
      'rte',
      null,
    );
    expect(warnings).toEqual([]);
  });

  it('aspectMismatch=true → aspect（與當下 boxId／hash 無關，恆定事實）', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: null, layoutHash: null, aspectMismatch: true },
      'rte',
      HASH_A,
    );
    expect(warnings).toEqual(['aspect']);
  });

  it('三者同時成立時，回傳全部（優先序由 primaryArtworkWarning 另外處理，非本函式職責）', () => {
    const warnings = evaluateArtworkWarnings(
      { boxId: 'ttb', layoutHash: HASH_A, aspectMismatch: true },
      'rte',
      HASH_B,
    );
    expect(warnings).toEqual(expect.arrayContaining(['box-mismatch', 'stale-template', 'aspect']));
    expect(warnings).toHaveLength(3);
  });

  it('同一份 metadata 對「不同的當下 boxId」重新求值會得到不同結果（動態重算的核心證明）', () => {
    const metadata = { boxId: 'rte', layoutHash: null, aspectMismatch: false };
    expect(evaluateArtworkWarnings(metadata, 'rte', null)).toEqual([]);
    expect(evaluateArtworkWarnings(metadata, 'ttb', null)).toEqual(['box-mismatch']);
    expect(evaluateArtworkWarnings(metadata, 'rte', null)).toEqual([]);
  });
});

describe('loadArtworkFile — alignmentMetadata 傳遞（原始事實，非預烤警示）', () => {
  it('box-mismatch/stale-template 案例：alignmentMetadata 帶出原始 data-box-id／data-layout-hash 字面值', async () => {
    const commits = vi.fn();
    const markup = mangledSvgWithPageFrame({ boxId: 'ttb', layoutHash: 'deadbeef' });
    await uploadSvg(markup, { boxId: 'rte', signature: 'layout-a', onCommit: commits });

    expect(commits.mock.calls[0]![0].alignmentMetadata).toEqual({
      boxId: 'ttb',
      layoutHash: 'deadbeef',
      aspectMismatch: false,
    });
  });

  it('aspect 案例（無頁框、非正方形）：alignmentMetadata.aspectMismatch=true，boxId/layoutHash 皆 null', async () => {
    const commits = vi.fn();
    await uploadSvg(nonSquareSvg(800, 400), { boxId: 'rte', signature: 'layout-a', onCommit: commits });

    expect(commits.mock.calls[0]![0].alignmentMetadata).toEqual({
      boxId: null,
      layoutHash: null,
      aspectMismatch: true,
    });
  });

  it('PNG 上傳：alignmentMetadata 為 undefined（非 SVG，無從判斷）', async () => {
    vi.mocked(createImageBitmap).mockResolvedValue(bitmap(640, 320));
    const commits = vi.fn();
    const promise = loadArtworkFile(
      new File(['art'], 'art.png', { type: 'image/png' }),
      { boxId: 'rte', signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);
    DeferredImage.instances[0]!.resolve();
    await promise;

    expect(commits.mock.calls[0]![0].alignmentMetadata).toBeUndefined();
  });
});
