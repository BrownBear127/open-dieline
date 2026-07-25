// AC-T6 材質色 golden：三個既有盒型逐一切換三種紙色，直接讀 panel material
// 的 color 與 map.image 像素。此測試覆蓋 mesh buffer golden 不涵蓋的 recipe 色彩路徑。
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { BoxModule, ResolvedParams } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import type { FoldModel } from '@/fold/types';

const capturedMeshes = vi.hoisted(() => [] as Mesh[]);

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

  class CapturedMesh extends actual.Mesh {
    constructor(...args: ConstructorParameters<typeof actual.Mesh>) {
      super(...args);
      capturedMeshes.push(this);
    }
  }

  return {
    ...actual,
    Mesh: CapturedMesh,
    WebGLRenderer: Renderer,
  };
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

import {
  createFoldScene,
  type FoldRecipeName,
} from '@/ui/fold-scene';

interface BoxCase {
  box: BoxModule;
  buildModel: (params: ResolvedParams) => FoldModel;
}

interface MaterialColorGolden {
  materialColor: number;
  albedoSha256: string;
}

const BOX_CASES: Record<string, BoxCase> = {
  rte: { box: reverseTuckEnd, buildModel: buildRteFoldModel },
  ttsl: { box: tuckTopSnapLock, buildModel: buildTtslFoldModel },
  ttb: { box: triangularTube, buildModel: buildTtbFoldModel },
};
const RECIPES: FoldRecipeName[] = ['white', 'kraft', 'black'];
const WHITE_MATERIAL = {
  materialColor: 0xffffff,
  albedoSha256: 'a67877cc487d4d06cea6d2e8aa59bb0abd3de90e624ed066e9f8fbfb3e98112c',
};
const KRAFT_MATERIAL = {
  materialColor: 0xffffff,
  albedoSha256: 'd37de7209b69701f6e35271c81b072b3bfbcc4e6fb17df02b9ec136b6a43941b',
};
const BLACK_MATERIAL = {
  materialColor: 0xffffff,
  albedoSha256: '5359765561b940e261ca94d7d41921ae79ceb39509099e4fe243b1360a0da5c4',
};
const MATERIAL_COLOR_GOLDEN: Record<string, MaterialColorGolden> = {
  'rte|white': WHITE_MATERIAL,
  'rte|kraft': KRAFT_MATERIAL,
  'rte|black': BLACK_MATERIAL,
  'ttsl|white': WHITE_MATERIAL,
  'ttsl|kraft': KRAFT_MATERIAL,
  'ttsl|black': BLACK_MATERIAL,
  'ttb|white': WHITE_MATERIAL,
  'ttb|kraft': KRAFT_MATERIAL,
  'ttb|black': BLACK_MATERIAL,
};

const canvasPixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();

function mockCanvasContext(): void {
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
      putImageData: (image: ImageData) => {
        canvasPixels.set(this, image.data);
      },
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });
}

function sha256(bytes: Uint8ClampedArray): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readMaterialGolden(
  material: MeshStandardMaterial,
): MaterialColorGolden {
  const image = material.map?.image;
  if (!(image instanceof HTMLCanvasElement)) {
    throw new Error('Panel material albedo map 必須來自 canvas');
  }
  const pixels = canvasPixels.get(image);
  if (!pixels) throw new Error('Panel material albedo canvas 缺少像素資料');
  return {
    materialColor: material.color.getHex(),
    albedoSha256: sha256(pixels),
  };
}

function firstPanelPaperMaterial(): MeshStandardMaterial {
  const panel = capturedMeshes.find((mesh) => Array.isArray(mesh.material));
  if (!panel || !Array.isArray(panel.material)) {
    throw new Error('Scene 必須建立至少一片 panel mesh');
  }
  return panel.material[1] as MeshStandardMaterial;
}

afterEach(() => {
  capturedMeshes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC-T6 既有盒型 material-color golden', () => {
  it('rte／ttsl／ttb 的 white／kraft／black recipe 直達 panel material', () => {
    mockCanvasContext();
    const actual: Record<string, MaterialColorGolden> = {};

    for (const [boxId, { box, buildModel }] of Object.entries(BOX_CASES)) {
      const params = resolveParams(box, {});
      capturedMeshes.length = 0;
      const scene = createFoldScene(document.createElement('canvas'));
      scene.replaceModel(buildModel(params));

      for (const recipe of RECIPES) {
        scene.applyRecipe(recipe);
        actual[`${boxId}|${recipe}`] =
          readMaterialGolden(firstPanelPaperMaterial());
      }
      scene.dispose();
    }

    expect(actual).toEqual(MATERIAL_COLOR_GOLDEN);
  }, 30_000);
});
