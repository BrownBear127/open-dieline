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
    // 嚴格 (-掃描只限 style 位置——presentation/transform attr 走 url( 掃描，
    // Illustrator 匯出稿的 transform="translate(...)" 不得誤拒。
    const file = new File([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g transform="translate(3,4) rotate(15)"><rect fill="url(#g)" style="fill-opacity:0.5"/></g></svg>',
    ], 'art.svg', { type: 'image/svg+xml' });

    await expect(validateArtworkFile(file)).resolves.toBeNull();
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
