import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomArtworkTexture,
  createFoldScene,
  type CustomArtworkSource,
} from '@/ui/fold-scene';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class Renderer {
    toneMapping = 0;
    toneMappingExposure = 1;
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    dispose = vi.fn();
  }
  return { ...actual, WebGLRenderer: Renderer };
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3 } = await vi.importActual<typeof import('three')>('three');
  class OrbitControls {
    target = new Vector3();
    enableDamping = false;
    autoRotate = false;
    minDistance = 0;
    maxDistance = 0;
    update = vi.fn(() => false);
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    dispose = vi.fn();
  }
  return { OrbitControls };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('custom artwork albedo composition', () => {
  it('creates a 2048 target, upscales paper first, then overlays the full source at alpha 0.88', () => {
    const paper = document.createElement('canvas');
    paper.width = 512;
    paper.height = 512;
    const artwork = document.createElement('canvas');
    artwork.width = 2048;
    artwork.height = 2048;
    const operations: unknown[][] = [];
    const context = {
      canvas: document.createElement('canvas'),
      drawImage: vi.fn((...args: unknown[]) => operations.push(['drawImage', ...args])),
      set globalCompositeOperation(value: string) {
        operations.push(['globalCompositeOperation', value]);
      },
      set globalAlpha(value: number) {
        operations.push(['globalAlpha', value]);
      },
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const source: CustomArtworkSource = { canvas: artwork, signature: 'rte:fixture' };

    const texture = createCustomArtworkTexture(paper, source);

    expect(texture.image).toMatchObject({ width: 2048, height: 2048 });
    expect(operations).toEqual([
      ['drawImage', paper, 0, 0, 2048, 2048],
      ['globalCompositeOperation', 'source-over'],
      ['globalAlpha', 0.88],
      ['drawImage', artwork, 0, 0, 2048, 2048],
    ]);
  });

  it('fails loudly instead of reusing an old texture when custom has no installed source', () => {
    const paper = document.createElement('canvas');

    expect(() => createCustomArtworkTexture(paper, null)).toThrow(
      'Custom artwork source is not installed',
    );
  });

  it("makes applyArtwork('custom') fail loudly when no source is installed", () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      canvas: document.createElement('canvas'),
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
    const scene = createFoldScene(document.createElement('canvas'));

    expect(() => scene.applyArtwork('custom')).toThrow(
      'Custom artwork source is not installed',
    );

    scene.dispose();
  });
});
