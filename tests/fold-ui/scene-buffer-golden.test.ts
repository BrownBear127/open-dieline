// AC-T6 buffer golden：只凍結 GPU 最終幾何資料，不把 scene graph 名稱或內部 map key
// 納入契約。浮點先固定到小數 6 位再做 SHA-256，避免不同 JS 引擎的尾數噪音。
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BufferGeometry, Mesh } from 'three';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import type { BoxModule, ResolvedParams } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import type { FoldModel } from '@/fold/types';
import goldenRaw from '../baselines/fold-scene/scene-buffer-golden.json';

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

import { createFoldScene, FOLD_DEFAULT_RECIPE } from '@/ui/fold-scene';

const FLOAT_PRECISION_DECIMALS = 6;
const SAMPLE_TIMES = [0, 0.5, 1] as const;

interface SceneHashes {
  meshCount: number;
  position: string;
  index: string;
  uv: string;
  materialGroups: string;
}

interface GoldenManifest {
  floatPrecisionDecimals: number;
  paperRecipe: string;
  scenarios: Record<string, SceneHashes>;
}

interface BoxCase {
  box: BoxModule;
  buildModel: (params: ResolvedParams) => FoldModel;
}

const BOX_CASES: Record<string, BoxCase> = {
  rte: { box: reverseTuckEnd, buildModel: buildRteFoldModel },
  ttsl: { box: tuckTopSnapLock, buildModel: buildTtslFoldModel },
  ttb: { box: triangularTube, buildModel: buildTtbFoldModel },
};

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
      putImageData: vi.fn(),
      createRadialGradient: () => ({ addColorStop: vi.fn() }),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  });
}

function roundFloat(value: number): number {
  const rounded = Number(value.toFixed(FLOAT_PRECISION_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function valuesOf(
  array: ArrayLike<number> | null,
  round: boolean,
): number[] | null {
  if (array === null) return null;
  return Array.from(array, (value) => (round ? roundFloat(value) : value));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function panelGeometryPayload(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  return {
    position: valuesOf(position?.array ?? null, true),
    index: valuesOf(index?.array ?? null, false),
    uv: valuesOf(uv?.array ?? null, true),
    materialGroups: geometry.groups.map(({ start, count, materialIndex }) => ({
      start,
      count,
      materialIndex,
    })),
  };
}

function hashActivePanelMeshes(meshes: Mesh[]): SceneHashes {
  // Panel mesh 唯一使用兩個材質的陣列；contact shadow 是單一材質。刻意不讀 mesh.name
  // 或 userData.panelId，確保 Spec 明列排除的 scene graph 名稱／map key 不會污染 golden。
  const payloads = meshes
    .filter((mesh) => Array.isArray(mesh.material))
    .map((mesh) => panelGeometryPayload(mesh.geometry))
    .sort((a, b) => sha256(a).localeCompare(sha256(b)));

  return {
    meshCount: payloads.length,
    position: sha256(payloads.map(({ position }) => position)),
    index: sha256(payloads.map(({ index }) => index)),
    uv: sha256(payloads.map(({ uv }) => uv)),
    materialGroups: sha256(payloads.map(({ materialGroups }) => materialGroups)),
  };
}

function defaultThickness(box: BoxModule): number {
  const declared = box.params.find(({ key }) => key === 'thickness');
  return typeof declared?.default === 'number' ? declared.default : 0;
}

function collectGolden(): GoldenManifest {
  const scenarios: Record<string, SceneHashes> = {};

  for (const [boxId, { box, buildModel }] of Object.entries(BOX_CASES)) {
    const params = resolveParams(box, {});
    const model = buildModel(params);
    const thicknesses = [...new Set([0, defaultThickness(box)])];

    for (const thickness of thicknesses) {
      capturedMeshes.length = 0;
      const scene = createFoldScene(document.createElement('canvas'));
      scene.replaceModel(model, { thickness });
      const activeMeshes = [...capturedMeshes];

      for (const time of SAMPLE_TIMES) {
        scene.updatePose(time);
        scenarios[`${boxId}|t=${time}|thickness=${thickness}`] =
          hashActivePanelMeshes(activeMeshes);
      }
      scene.dispose();
    }
  }

  return {
    floatPrecisionDecimals: FLOAT_PRECISION_DECIMALS,
    paperRecipe: FOLD_DEFAULT_RECIPE,
    scenarios,
  };
}

afterEach(() => {
  capturedMeshes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC-T6 既有盒型 mesh buffer golden', () => {
  it('rte／ttsl／ttb 在固定 t 與紙厚取樣下維持 position/index/uv/material groups', () => {
    mockCanvasContext();
    const actual = collectGolden();
    if (process.env.SCENE_BUFFER_GOLDEN_DUMP === '1') {
      console.info(JSON.stringify(actual, null, 2));
    }
    expect(actual).toEqual(goldenRaw as GoldenManifest);
  }, 30_000);
});
