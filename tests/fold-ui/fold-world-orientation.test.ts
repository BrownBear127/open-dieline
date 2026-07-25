import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mesh, PerspectiveCamera, Vector3 } from 'three';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import {
  buildTelescopeSceneSpec,
  TELESCOPE_ASSEMBLY_WINDOWS,
} from '@/fold/models/telescope';
import { SEAT_GAP_CONTRACT_MM, seatDropContract } from '../helpers/telescope-assembly-oracle';
import { FOLD_SCENE_REGISTRY } from '@/fold/registry';
import { resolveFoldSceneSpec, type ResolvedSceneSpec } from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';
import {
  modelVertexToWorld,
  type FoldWorldUp,
} from '@/fold/world-orientation';
import type { FoldSceneHandle } from '@/ui/fold-scene';

const capturedMeshes = vi.hoisted(() => [] as Mesh[]);
const capturedCameras = vi.hoisted(() => [] as PerspectiveCamera[]);
const controlListeners = vi.hoisted(
  () => new Map<string, (event?: unknown) => void>(),
);

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

  class CapturedPerspectiveCamera extends actual.PerspectiveCamera {
    constructor(...args: ConstructorParameters<typeof actual.PerspectiveCamera>) {
      super(...args);
      capturedCameras.push(this);
    }
  }

  return {
    ...actual,
    Mesh: CapturedMesh,
    PerspectiveCamera: CapturedPerspectiveCamera,
    WebGLRenderer: Renderer,
  };
});

vi.mock('three/addons/controls/OrbitControls.js', async () => {
  const { Vector3: ThreeVector3 } = await vi.importActual<typeof import('three')>('three');

  class OrbitControls {
    target = new ThreeVector3();
    enableDamping = false;
    autoRotate = false;
    minDistance = 0;
    maxDistance = 0;
    update = vi.fn(() => false);
    addEventListener = vi.fn((event: string, listener: (value?: unknown) => void) => {
      controlListeners.set(event, listener);
    });
    removeEventListener = vi.fn((event: string) => {
      controlListeners.delete(event);
    });
    dispose = vi.fn();
  }

  return { OrbitControls };
});

import { createFoldScene } from '@/ui/fold-scene';

interface Bounds3 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

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

function panelMeshes(): Mesh[] {
  return capturedMeshes.filter((mesh) => Array.isArray(mesh.material));
}

function panelMesh(pieceId: string, panelId: string): Mesh {
  const name = `fold-panel:${pieceId}:${panelId}`;
  const mesh = panelMeshes().find((candidate) => candidate.name === name);
  expect(mesh, `找不到 production mesh ${name}`).toBeDefined();
  return mesh!;
}

function worldPoints(mesh: Mesh): Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute('position');
  const points: Vector3[] = [];
  for (let index = 0; index < position.count; index += 1) {
    points.push(new Vector3(
      position.getX(index),
      position.getY(index),
      position.getZ(index),
    ).applyMatrix4(mesh.matrixWorld));
  }
  return points;
}

function bounds(points: readonly Vector3[]): Bounds3 {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    maxX: Math.max(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxY: Math.max(...points.map(({ y }) => y)),
    minZ: Math.min(...points.map(({ z }) => z)),
    maxZ: Math.max(...points.map(({ z }) => z)),
  };
}

function sceneBounds(): Bounds3 {
  return bounds(panelMeshes().flatMap(worldPoints));
}

function extents(box: Bounds3): { x: number; y: number; z: number } {
  return {
    x: box.maxX - box.minX,
    y: box.maxY - box.minY,
    z: box.maxZ - box.minZ,
  };
}

function meshCenter(mesh: Mesh): Vector3 {
  const box = bounds(worldPoints(mesh));
  return new Vector3(
    (box.minX + box.maxX) / 2,
    (box.minY + box.maxY) / 2,
    (box.minZ + box.maxZ) / 2,
  );
}

function cameraElevation(camera: PerspectiveCamera): number {
  return Math.atan2(
    camera.position.y,
    Math.hypot(camera.position.x, camera.position.z),
  ) * 180 / Math.PI;
}

function rootSemanticNormal(mesh: Mesh): Vector3 {
  mesh.updateWorldMatrix(true, false);
  return new Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
}

function expectWithin(
  actual: number,
  expected: number,
  tolerance: number,
): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function replaceAsProduction(
  handle: FoldSceneHandle,
  scene: ResolvedSceneSpec,
  worldUp: FoldWorldUp,
): void {
  handle.replaceScene(scene, { thickness: 0, worldUp });
}

function telescopeScene(delta: Record<string, boolean> = {}): {
  params: ReturnType<typeof resolveParams>;
  scene: ResolvedSceneSpec;
} {
  const params = resolveParams(telescope, delta);
  return {
    params,
    scene: resolveFoldSceneSpec(buildTelescopeSceneSpec(params), params),
  };
}

function rootPanelSpan(model: FoldModel): { x: number; y: number } {
  const root = model.panels.find(({ id }) => id === 'floor');
  if (!root) throw new Error('Telescope model 缺少 floor root');
  const xs = root.polygon.map(({ x }) => x);
  const ys = root.polygon.map(({ y }) => y);
  return {
    x: Math.max(...xs) - Math.min(...xs),
    y: Math.max(...ys) - Math.min(...ys),
  };
}

function expectVerticalBeat(
  scene: FoldSceneHandle,
  mesh: Mesh,
  start: number,
  end: number,
  expectedSign: 1 | -1,
): void {
  const samples = 8;
  const centers: Vector3[] = [];
  for (let index = 0; index <= samples; index += 1) {
    scene.updatePose(start + (end - start) * index / samples);
    centers.push(meshCenter(mesh));
  }
  for (let index = 1; index < centers.length; index += 1) {
    const direction = centers[index]!.clone().sub(centers[index - 1]!).normalize();
    const dot = direction.dot(new Vector3(0, 1, 0));
    if (expectedSign === 1) {
      expect(dot).toBeGreaterThanOrEqual(0.999);
    } else {
      expect(dot).toBeLessThanOrEqual(-0.999);
    }
  }
}

function expectLevelBeat(
  scene: FoldSceneHandle,
  mesh: Mesh,
  start: number,
  end: number,
): void {
  const samples = 8;
  const heights: number[] = [];
  for (let index = 0; index <= samples; index += 1) {
    scene.updatePose(start + (end - start) * index / samples);
    heights.push(meshCenter(mesh).y);
  }
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(0.1);
}

afterEach(() => {
  capturedMeshes.length = 0;
  capturedCameras.length = 0;
  controlListeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AC-T8 production 世界姿勢', () => {
  it.each([
    ['M-01 liner off', { linerEnabled: false }],
    ['M-02 liner on', { linerEnabled: true }],
  ])('AC-T8a：%s 終態高度與地面 footprint 來自 generator 尺寸', (
    _caseId,
    delta,
  ) => {
    mockCanvasContext();
    const { params, scene: resolved } = telescopeScene(delta);
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, 'tray');
    scene.updatePose(1);

    const actual = extents(sceneBounds());
    const lid = resolved.pieces.find(({ pieceId }) => pieceId === 'lid')!;
    const lidSpan = rootPanelSpan(lid.model);
    const thickness = params.thickness as number;
    const rootJog = params.rootJog as number;
    // 閉合盒外高量到的是 closedOuterTop（＝上蓋落座平面）。上蓋底板內面壓在
    // 下盒壁頂之上、材料向盒內佔一個紙厚，故外頂面較 baseRim 高一個 thickness
    // （Spec §4.7 三面基準）——此項是正確的物理結果，不得以放寬容差吸收。
    // ⚠ v15.4：原式含 `+ basePlatformWidth`＝遷就「長邊壁 rim 摺 0° 使壁凸出一個
    // platformWidth」的 bug（源頭已修·刀模四面皆有 rim crease）。改為逐項可指認：
    //   baseHeight            下盒壁頂＝baseRim
    //   + thickness           上蓋底板外表面（§4.7 三面基準·材料向盒內佔一個紙厚）
    //   + 2 × rootJog         兩片角撐根各低於自身盒底一個 rootJog（實測 base/lid 皆 z=−0.500），
    //                         上蓋翻面後該外突朝上，故計兩次。
    // 此三項皆為正確物理結果，不得以放寬容差吸收。
    //   + seatDrop               上蓋接觸面距其底板的深度（v15.7·取測試側 seatDropContract）
    //   + SEAT_GAP_CONTRACT_MM   上蓋落座間隙（v15.6·拉開精確共面）
    // ⚠ 落座間隙只有 0.05mm，落在本斷言 0.1mm 的容差內——**不補進公式的話，容差會
    //   默默吸收它**，等於閘門對「落座高度變了」失去知覺。期望值必須逐項可指認。
    // ⚠ seatDrop 取代原本的裸 `thickness` 項：接觸面是上蓋內壁的唇邊（比底板低一個
    //   innerWallReduction），不是底板內面；兩者在預設值下差 0.5mm。
    const expectedHeight = (params.baseHeight as number)
      + seatDropContract(thickness, params.innerWallReduction as number)
      + 2 * rootJog
      + SEAT_GAP_CONTRACT_MM;
    // ⚠ v15.5：原式為 `lidSpan + 3 × thickness`（無推導的 `foldedEdgeAllowance`）。
    // 那 0.9mm 是在遷就「層號當位移」時被推到盒外的面板——角翼／內壁／舌片當時
    // 各帶 +2.8~+3.5mm 的向外位移。位移改吃實體疊層索引後，最外層（外壁）位移為
    // 0，閉合盒的地面 footprint **恰等於**上蓋底板自身跨距，無需任何 allowance。
    const expectedWorldX = lidSpan.x;
    const expectedWorldZ = lidSpan.y;
    if (process.env.FOLD_WORLD_BOUNDS_DUMP === '1') {
      console.info(JSON.stringify({
        bounds: sceneBounds(),
        actual,
        expectedHeight,
        expectedWorldX,
        expectedWorldZ,
        lidSpan,
      }));
    }

    expectWithin(actual.y, expectedHeight, 0.1);
    expectWithin(actual.x, expectedWorldX, 0.1);
    expectWithin(actual.z, expectedWorldZ, 0.1);
    scene.dispose();
  });

  it.each([
    ['base', 'floor'],
    ['lid', 'floor'],
  ])('AC-T8b：t=0 %s root 正面朝世界上方', (pieceId, rootId) => {
    mockCanvasContext();
    const { scene: resolved } = telescopeScene({ linerEnabled: false });
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, 'tray');
    scene.updatePose(0);

    const normal = rootSemanticNormal(panelMesh(pieceId, rootId));
    expect(normal.dot(new Vector3(0, 1, 0))).toBeGreaterThanOrEqual(0.999);
    scene.dispose();
  });

  it('AC-T8c：liner 與 lid 的抬升、平移、下降拍保留帶符號 world-up 方向', () => {
    mockCanvasContext();
    const { scene: resolved } = telescopeScene({ linerEnabled: true });
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, 'tray');

    const liner = panelMesh('liner', 'linerPad');
    const lid = panelMesh('lid', 'floor');
    const linerTimes = TELESCOPE_ASSEMBLY_WINDOWS.liner;
    const lidTimes = TELESCOPE_ASSEMBLY_WINDOWS.lid;

    expectVerticalBeat(scene, liner, linerTimes[0], linerTimes[1], 1);
    expectLevelBeat(scene, liner, linerTimes[1], linerTimes[2]);
    expectVerticalBeat(scene, liner, linerTimes[2], linerTimes[3], -1);
    expectVerticalBeat(scene, lid, lidTimes[0], lidTimes[1], 1);
    expectLevelBeat(scene, lid, lidTimes[2], lidTimes[3]);
    expectVerticalBeat(scene, lid, lidTimes[3], lidTimes[4], -1);
    scene.dispose();
  });

  it('AC-T8d：RTE default 55×55×117 維持 tube world-up 站立', () => {
    mockCanvasContext();
    const entry = FOLD_SCENE_REGISTRY.rte as typeof FOLD_SCENE_REGISTRY.rte & {
      worldUp?: FoldWorldUp;
    };
    expect(entry.worldUp).toBe('tube');

    const params = resolveParams(reverseTuckEnd, {});
    const model = buildRteFoldModel(params);
    const resolved: ResolvedSceneSpec = {
      pieces: [{
        pieceId: 'rte',
        model,
        foldWindow: [0, 1],
        assemblyTrack: [],
      }],
    };
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, entry.worldUp!);
    scene.updatePose(1);

    const worldHeight = Number(extents(sceneBounds()).y.toFixed(3));
    expectWithin(worldHeight, params.D as number, 0.1);
    scene.dispose();
  });
});

describe('model → Three → production world 三軸管線', () => {
  it.each([
    [
      'tube',
      [
        [{ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }],
        [{ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }],
      ],
    ],
    [
      'tray',
      [
        [{ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
        [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
        [{ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }],
      ],
    ],
  ] as const)('%s 對同一張表逐軸映射', (worldUp, rows) => {
    for (const [model, expected] of rows) {
      const actual = modelVertexToWorld(model, worldUp);
      expect(actual.x).toBeCloseTo(expected.x, 12);
      expect(actual.y).toBeCloseTo(expected.y, 12);
      expect(actual.z).toBeCloseTo(expected.z, 12);
    }
  });
});

describe('world-up camera behavior', () => {
  it('tray elevation eases from overhead to 3/4 and yields after user orbit', () => {
    mockCanvasContext();
    const { scene: resolved } = telescopeScene({ linerEnabled: true });
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, 'tray');
    const camera = capturedCameras.at(-1)!;

    scene.updatePose(0);
    expect(cameraElevation(camera)).toBeCloseTo(75, 6);
    scene.updatePose(TELESCOPE_ASSEMBLY_WINDOWS.liner[0] / 2);
    expect(cameraElevation(camera)).toBeGreaterThan(30);
    expect(cameraElevation(camera)).toBeLessThan(75);
    scene.updatePose(TELESCOPE_ASSEMBLY_WINDOWS.liner[0]);
    expect(cameraElevation(camera)).toBeCloseTo(30, 6);

    camera.position.set(12, 34, 56);
    controlListeners.get('start')?.();
    scene.updatePose(0);
    expect(camera.position.toArray()).toEqual([12, 34, 56]);
    scene.dispose();
  });

  it('tube camera path is unchanged across pose updates', () => {
    mockCanvasContext();
    const params = resolveParams(reverseTuckEnd, {});
    const resolved: ResolvedSceneSpec = {
      pieces: [{
        pieceId: 'rte',
        model: buildRteFoldModel(params),
        foldWindow: [0, 1],
        assemblyTrack: [],
      }],
    };
    const scene = createFoldScene(document.createElement('canvas'));
    replaceAsProduction(scene, resolved, 'tube');
    const camera = capturedCameras.at(-1)!;
    const initial = camera.position.toArray();

    scene.updatePose(0);
    scene.updatePose(0.5);
    scene.updatePose(1);
    expect(camera.position.toArray()).toEqual(initial);
    scene.dispose();
  });
});
