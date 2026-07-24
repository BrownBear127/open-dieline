// AC-T3：直接讀實際 mesh buffer，與數值層 G5 分開驗終幀剪影與組裝層序。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mesh } from 'three';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';
import { resolveFoldSceneSpec } from '@/fold/scene-spec';

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
  panelOverlapPlan,
  type PanelOverlapPlan,
} from '@/ui/fold-scene';

interface Point3 {
  x: number;
  y: number;
  z: number;
}

type Point2 = [number, number];
type PositionReader = (pieceId: string, panelId: string) => Point3[];

const SILHOUETTE_CAP_MM = 0.05;

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

function activePanelMeshes(): Mesh[] {
  return capturedMeshes.filter((mesh) => {
    if (!Array.isArray(mesh.material)) return false;
    let ancestor = mesh.parent;
    while (ancestor !== null) {
      if (ancestor.name === 'fold-panel-root') return true;
      ancestor = ancestor.parent;
    }
    return false;
  });
}

function meshPositions(pieceId: string, panelId: string): Point3[] {
  const name = `fold-panel:${pieceId}:${panelId}`;
  const mesh = activePanelMeshes().find((candidate) => candidate.name === name);
  if (!mesh) throw new Error(`找不到 ${name}`);
  const attribute = mesh.geometry.getAttribute('position');
  return Array.from({ length: attribute.count }, (_, index) => ({
    x: attribute.getX(index),
    y: attribute.getY(index),
    z: attribute.getZ(index),
  }));
}

function convexHull(points: Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (input: Point2[]): Point2[] => {
    const output: Point2[] = [];
    for (const point of input) {
      while (output.length >= 2) {
        const origin = output[output.length - 2]!;
        const previous = output[output.length - 1]!;
        const turn = (previous[0] - origin[0]) * (point[1] - origin[1])
          - (previous[1] - origin[1]) * (point[0] - origin[0]);
        if (turn > 0) break;
        output.pop();
      }
      output.push(point);
    }
    return output;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function outsideDistance(point: Point2, hull: Point2[]): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < hull.length; index += 1) {
    const start = hull[index]!;
    const end = hull[(index + 1) % hull.length]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const cross = (end[0] - start[0]) * (point[1] - start[1])
      - (end[1] - start[1]) * (point[0] - start[0]);
    maximum = Math.max(maximum, -cross / length);
  }
  return maximum;
}

function outsideWitness(
  point: Point2,
  hull: Point2[],
): { distance: number; outward: Point2 } {
  let witness = {
    distance: Number.NEGATIVE_INFINITY,
    outward: [0, 0] as Point2,
  };
  for (let index = 0; index < hull.length; index += 1) {
    const start = hull[index]!;
    const end = hull[(index + 1) % hull.length]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const outward: Point2 = [
      (end[1] - start[1]) / length,
      -(end[0] - start[0]) / length,
    ];
    const distance = (point[0] - start[0]) * outward[0]
      + (point[1] - start[1]) * outward[1];
    if (distance > witness.distance) witness = { distance, outward };
  }
  return witness;
}

function silhouetteViolations(
  pieceId: string,
  panelIds: string[],
  readPositions: PositionReader,
  rootJogMm: number,
  pieceHeightMm: number,
): string[] {
  const bodyPanelIds = panelIds.filter((panelId) =>
    panelId === 'floor' || panelId.startsWith('wall'));
  const bodyPoints = bodyPanelIds.flatMap((panelId) =>
    readPositions(pieceId, panelId));
  const projections = [
    (point: Point3): Point2 => [point.x, point.y],
    (point: Point3): Point2 => [point.x, point.z],
    (point: Point3): Point2 => [point.y, point.z],
  ];
  const hulls = projections.map((project) =>
    convexHull(bodyPoints.map(project)));
  const reinforcedPoints = [
    ...bodyPoints,
    ...panelIds
      .filter((panelId) => panelId.startsWith('wing'))
      .flatMap((panelId) => readPositions(pieceId, panelId)),
  ];
  const reinforcedHulls = projections.map((project) =>
    convexHull(reinforcedPoints.map(project)));
  const violations: string[] = [];

  for (const panelId of panelIds) {
    if (bodyPanelIds.includes(panelId)) {
      continue;
    }
    let maximum = Number.NEGATIVE_INFINITY;
    const targetHulls = panelId.startsWith('gussetExt')
      ? reinforcedHulls
      : hulls;
    for (const point of readPositions(pieceId, panelId)) {
      for (const [index, project] of projections.entries()) {
        maximum = Math.max(
          maximum,
          outsideDistance(project(point), targetHulls[index]!),
        );
      }
    }
    let cap = SILHOUETTE_CAP_MM;
    if (panelId.startsWith('wing')) {
      cap = rootJogMm + SILHOUETTE_CAP_MM;
    } else if (panelId.startsWith('flap')) {
      cap = rootJogMm + 2 * SILHOUETTE_CAP_MM;
    } else if (panelId.startsWith('gussetExt')) {
      cap = pieceHeightMm + SILHOUETTE_CAP_MM;
    }
    if (maximum > cap) {
      violations.push(`${pieceId}:${panelId} outside=${maximum.toFixed(6)}mm`);
    }
  }
  return violations;
}

function planeNormal(points: Point3[]): Point3 {
  const [a, b, c] = points;
  if (!a || !b || !c) throw new Error('mesh 缺少三角形');
  const first = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const second = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const normal = {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z);
  return {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };
}

function layerCoordinate(
  pieceId: string,
  panelId: string,
  normal: Point3,
): number {
  const points = meshPositions(pieceId, panelId);
  return points.reduce(
    (sum, point) =>
      sum + point.x * normal.x + point.y * normal.y + point.z * normal.z,
    0,
  ) / points.length;
}

function normalizedLayerPositions(
  pieceId: string,
  wallId: string,
  panelIds: string[],
): number[] {
  const normal = planeNormal(meshPositions(pieceId, wallId));
  const outer = layerCoordinate(pieceId, wallId, normal);
  const innerId = wallId.replace('-outer', '-inner');
  const inner = layerCoordinate(pieceId, innerId, normal);
  return panelIds.map((panelId) =>
    (layerCoordinate(pieceId, panelId, normal) - outer) / (inner - outer));
}

function interlockPlanViolations(
  pieceId: string,
  planFor: (panelId: string) => PanelOverlapPlan,
): string[] {
  const violations: string[] = [];
  for (const ySign of ['Neg', 'Pos']) {
    const outer = planFor(`${pieceId}:wallY${ySign}-outer`);
    const xNeg = planFor(`${pieceId}:flapNeg${ySign}`);
    const xPos = planFor(`${pieceId}:flapPos${ySign}`);
    const inner = planFor(`${pieceId}:wallY${ySign}-inner`);
    const plans = [outer, xNeg, xPos, inner];
    const distinct = new Set(plans.map((plan) =>
      `${plan.normalOffset}/${plan.polygonOffsetUnits}/${plan.renderOrder}`));
    if (distinct.size !== plans.length || xNeg.normalOffset >= xPos.normalOffset) {
      violations.push(`${pieceId}:Y${ySign} interlock layer order`);
    }
  }
  return violations;
}

function installScene(delta: Record<string, number | boolean> = {}) {
  const params = resolveParams(telescope, delta);
  const resolved = resolveFoldSceneSpec(buildTelescopeSceneSpec(params), params);
  const scene = createFoldScene(document.createElement('canvas'));
  scene.replaceScene(resolved, { thickness: 0 });
  scene.updatePose(1);
  return { scene, resolved, params };
}

afterEach(() => {
  capturedMeshes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Telescope AC-T3 render-layer gates', () => {
  it.each([
    ['liner-on', {}],
    ['liner-off', { linerEnabled: false }],
  ])('%s：base/lid 的 mesh buffer 剪影留在結構外殼凸包上界內', (
    _caseId,
    delta,
  ) => {
    mockCanvasContext();
    const { scene, resolved, params } = installScene(delta);
    for (const piece of resolved.pieces.filter(
      ({ pieceId }) => pieceId === 'base' || pieceId === 'lid',
    )) {
      expect(silhouetteViolations(
        piece.pieceId,
        piece.model.panels.map(({ id }) => id),
        meshPositions,
        params.rootJog as number,
        params[piece.pieceId === 'base' ? 'baseHeight' : 'lidHeight'] as number,
      )).toEqual([]);
    }
    scene.dispose();
  }, 30_000);

  it('組裝終態 mesh 直讀：互卡 pair 嚴格異層且 extension 夾在外壁與內壁間', () => {
    mockCanvasContext();
    const { scene } = installScene();

    for (const ySign of ['Neg', 'Pos']) {
      const [xNeg, xPos] = normalizedLayerPositions(
        'base',
        `wallY${ySign}-outer`,
        [`flapNeg${ySign}`, `flapPos${ySign}`],
      );
      expect(xPos).toBeGreaterThan(0);
      expect(xPos).toBeLessThan(xNeg!);
      expect(xNeg).toBeLessThan(1);
    }
    for (const corner of ['NegNeg', 'NegPos', 'PosNeg', 'PosPos']) {
      const xSign = corner.startsWith('Neg') ? 'Neg' : 'Pos';
      const [extension] = normalizedLayerPositions(
        'lid',
        `wallX${xSign}-outer`,
        [`gussetExt${corner}`],
      );
      expect(extension).toBeGreaterThan(0);
      expect(extension).toBeLessThan(1);
    }
    scene.dispose();
  }, 30_000);

  it('M-16 組裝終態 mesh 直讀：lid 的互卡 pair 仍維持 xNeg 在 xPos 之下', () => {
    mockCanvasContext();
    const { scene } = installScene({
      basePlatformWidth: 0,
      lidPlatformWidth: 5,
      lidHeight: 60,
    });

    for (const ySign of ['Neg', 'Pos']) {
      const [xNeg, xPos] = normalizedLayerPositions(
        'lid',
        `wallY${ySign}-outer`,
        [`flapNeg${ySign}`, `flapPos${ySign}`],
      );
      expect(xPos).toBeGreaterThan(0);
      expect(xPos).toBeLessThan(xNeg!);
      expect(xNeg).toBeLessThan(1);
    }
    scene.dispose();
  }, 30_000);

  it('互卡 pair 若被 sabotage 成 same plan，AC-T3 必須 RED', () => {
    const actualPlan = (panelId: string) => panelOverlapPlan(panelId, 0);
    expect(interlockPlanViolations('base', actualPlan)).toEqual([]);

    const samePlan = (panelId: string) => {
      if (panelId.includes(':flapPos')) {
        return panelOverlapPlan(panelId.replace(':flapPos', ':flapNeg'), 0);
      }
      return panelOverlapPlan(panelId, 0);
    };
    expect(interlockPlanViolations('base', samePlan)).not.toEqual([]);
  });

  it('任一 mesh 頂點向凸包外偏移 0.2mm，獨立 L3 上界必須 RED', () => {
    mockCanvasContext();
    const { scene, resolved } = installScene();
    const base = resolved.pieces.find(({ pieceId }) => pieceId === 'base')!;
    const targetPanelId = 'flapPosPos';
    const original = meshPositions('base', targetPanelId);
    const bodyPanelIds = base.model.panels
      .map(({ id }) => id)
      .filter((panelId) => panelId === 'floor' || panelId.startsWith('wall'));
    const bodyPoints = bodyPanelIds.flatMap((panelId) =>
      meshPositions('base', panelId));
    const projections = [
      (point: Point3): Point2 => [point.x, point.y],
      (point: Point3): Point2 => [point.x, point.z],
      (point: Point3): Point2 => [point.y, point.z],
    ];
    const hulls = projections.map((project) =>
      convexHull(bodyPoints.map(project)));
    let worst = {
      distance: Number.NEGATIVE_INFINITY,
      pointIndex: 0,
      projectionIndex: 0,
      outward: [0, 0] as Point2,
    };
    for (const [pointIndex, point] of original.entries()) {
      for (const [projectionIndex, project] of projections.entries()) {
        const witness = outsideWitness(
          project(point),
          hulls[projectionIndex]!,
        );
        if (witness.distance > worst.distance) {
          worst = {
            ...witness,
            pointIndex,
            projectionIndex,
          };
        }
      }
    }
    const offset = { x: 0, y: 0, z: 0 };
    const [first, second] = worst.outward;
    if (worst.projectionIndex === 0) {
      offset.x = first * 0.2;
      offset.y = second * 0.2;
    } else if (worst.projectionIndex === 1) {
      offset.x = first * 0.2;
      offset.z = second * 0.2;
    } else {
      offset.y = first * 0.2;
      offset.z = second * 0.2;
    }
    const sabotagedReader: PositionReader = (pieceId, panelId) => {
      if (pieceId !== 'base' || panelId !== targetPanelId) {
        return meshPositions(pieceId, panelId);
      }
      return original.map((point, index) =>
        index === worst.pointIndex
          ? {
              x: point.x + offset.x,
              y: point.y + offset.y,
              z: point.z + offset.z,
            }
          : point);
    };

    expect(silhouetteViolations(
      'base',
      base.model.panels.map(({ id }) => id),
      sabotagedReader,
      0.5,
      60,
    )).not.toEqual([]);
    scene.dispose();
  }, 30_000);
});
