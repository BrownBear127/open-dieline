import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadArtworkFile,
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
      { signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    await expect(promise).resolves.toBe('committed');

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
      { signature: 'layout-a', onCommit: commits },
    );
    await waitForImages(1);

    DeferredImage.instances[0]!.resolve();
    await waitForImages(2);
    DeferredImage.instances[1]!.resolve();
    await expect(promise).resolves.toBe('committed');

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
      { signature: 'layout-a', onCommit: commits },
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
      { signature: 'A', onCommit: commits },
    );
    await waitForImages(1);
    const second = loadArtworkFile(
      new File(['b'], 'b.png', { type: 'image/png' }),
      { signature: 'B', onCommit: commits },
    );
    await waitForImages(2);

    DeferredImage.instances[1]!.resolve();
    await expect(second).resolves.toBe('committed');
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
      { signature: 'A', signal: controller.signal, onCommit: commits },
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
      { signature: 'A', signal: owner.signal, onCommit: commits },
    );
    await waitForImages(1);

    owner.abort();

    await expect(promise).resolves.toBe('cancelled');
    expect(commits).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:a.png');
  });
});
