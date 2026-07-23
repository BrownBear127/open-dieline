// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { afterEach, expect, it, vi } from 'vitest';
import type { FoldModel } from '@/fold/types';

vi.mock('@/ui/triangulate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/triangulate')>();
  return { ...actual, earClipIndices: vi.fn(actual.earClipIndices) };
});

import { createFoldScene } from '@/ui/fold-scene';
import { earClipIndices } from '@/ui/triangulate';

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

it('caches panel triangulation when the animation advances to t=0.5', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(
    this: HTMLCanvasElement,
  ) {
    return {
      canvas: this,
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });
  const model: FoldModel = {
    panels: [{
      id: 'root',
      polygon: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      parent: null,
      foldAngle: 0,
    }],
    steps: [],
    dieline: [],
  };
  const scene = createFoldScene(document.createElement('canvas'));
  vi.mocked(earClipIndices).mockClear();

  scene.replaceModel(model, { thickness: 0.5 });
  const cachedIndices = vi.mocked(earClipIndices).mock.results[0]!.value;
  const indexSnapshot = [...cachedIndices];
  scene.updatePose(0.5);

  expect(earClipIndices).toHaveBeenCalledOnce();
  expect(cachedIndices).toEqual(indexSnapshot);
  scene.dispose();
});
