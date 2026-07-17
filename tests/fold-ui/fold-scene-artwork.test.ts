import { afterEach, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { deriveArtworkLayout, type FlatDielineUvFrame } from '@/ui/artwork-layout';
import {
  artworkPointUv,
  buildPanelArtworkUvs,
  createCustomArtworkTexture,
  createFoldScene,
  type CustomArtworkSource,
} from '@/ui/fold-scene';

function expectedPanelUvs(
  polygon: ReadonlyArray<{ x: number; y: number }>,
  frame: FlatDielineUvFrame,
  thickness: number,
): number[] {
  const points = polygon.map((point) => artworkPointUv(point, frame));
  const values: number[] = [];
  const write = (index: number): void => {
    values.push(points[index]!.u, points[index]!.v);
  };

  for (let index = 1; index < points.length - 1; index += 1) {
    write(0);
    write(index);
    write(index + 1);
  }
  if (!(thickness > 0)) return values;

  for (let index = 1; index < points.length - 1; index += 1) {
    write(0);
    write(index + 1);
    write(index);
  }
  for (let index = 0; index < points.length; index += 1) {
    const nextIndex = (index + 1) % points.length;
    write(index);
    write(index);
    write(nextIndex);
    write(index);
    write(nextIndex);
    write(nextIndex);
  }
  return values;
}

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

describe('production panel UV wiring consumes ArtworkLayout (F1)', () => {
  it.each([
    ['sliced lid', {}],
    ['zero thickness', { thickness: 0 }],
    ['extreme L and clearance', { L: 65, tuckClearance: 3 }],
  ] as const)('%s fixture maps every panel corner, hinge midpoint, and center through the shared layout', (_label, overrides) => {
    const values = resolveParams(reverseTuckEnd, overrides);
    const model = buildRteFoldModel(values);
    const expectedLayout = deriveArtworkLayout(model);
    const production = buildPanelArtworkUvs(model, values.thickness as number);

    expect(production.layout).toEqual(expectedLayout);
    expect([...production.uvs.keys()]).toEqual(expectedLayout.panels.map(({ id }) => id));

    for (const panel of expectedLayout.panels) {
      expect(production.uvs.get(panel.id)).toEqual(new Float32Array(
        expectedPanelUvs(panel.polygon, expectedLayout.frame, values.thickness as number),
      ));

      const xs = panel.polygon.map(({ x }) => x);
      const ys = panel.polygon.map(({ y }) => y);
      const points = [
        ...panel.polygon,
        ...(panel.hinge === undefined ? [] : [{
          x: (panel.hinge.a.x + panel.hinge.b.x) / 2,
          y: (panel.hinge.a.y + panel.hinge.b.y) / 2,
        }]),
        {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        },
      ];

      for (const point of points) {
        const uv = artworkPointUv(point, production.layout.frame);
        expect(uv.u).toBe((point.x - expectedLayout.frame.minX + expectedLayout.frame.offsetX) / expectedLayout.frame.span);
        expect(uv.v).toBe(1 - (point.y - expectedLayout.frame.minY + expectedLayout.frame.offsetY) / expectedLayout.frame.span);
      }
    }
  });
});
