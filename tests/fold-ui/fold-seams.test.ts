// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineBasicMaterial, type LineSegments } from 'three';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { applyTransform, panelWorldTransform } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, Pt, SeamSegment } from '@/fold/types';

const capturedLines = vi.hoisted(() => [] as LineSegments[]);

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

  class CapturedLineSegments extends actual.LineSegments {
    constructor(...args: ConstructorParameters<typeof actual.LineSegments>) {
      super(...args);
      capturedLines.push(this);
    }
  }

  return {
    ...actual,
    LineSegments: CapturedLineSegments,
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
  createPanelRenderPoseContext,
  expandPolylineSegments,
  panelOverlapPlan,
  panelRenderPoint,
} from '@/ui/fold-scene';

const THICKNESS_MM = 0.5;
const POINT_TOLERANCE_MM = 1e-7;

function distance(first: { x: number; y: number; z: number }, second: {
  x: number;
  y: number;
  z: number;
}): number {
  return Math.hypot(
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  );
}

function pointKey(point: Pt): string {
  return `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
}

function segmentKey({ points }: SeamSegment): string {
  return points.map(pointKey).sort().join('|');
}

function seamGroups(model: FoldModel): SeamSegment[][] {
  const groups = new Map<string, SeamSegment[]>();
  for (const seam of model.seams ?? []) {
    const key = segmentKey(seam);
    const group = groups.get(key) ?? [];
    group.push(seam);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function ownerHinge(model: FoldModel, owners: string[]) {
  return model.panels.find((panel) =>
    panel.parent !== null
    && owners.includes(panel.id)
    && owners.includes(panel.parent))?.hingeLine;
}

function distanceToLine(point: Pt, line: { a: Pt; b: Pt }): number {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  return Math.abs(dx * (line.a.y - point.y) - (line.a.x - point.x) * dy)
    / Math.hypot(dx, dy);
}

function isAxisGroup(model: FoldModel, group: SeamSegment[]): boolean {
  if (group.length !== 2) return false;
  const hinge = ownerHinge(model, group.map(({ ownerPanelId }) => ownerPanelId));
  return hinge !== undefined
    && group[0]!.points.every((point) => distanceToLine(point, hinge) < POINT_TOLERANCE_MM);
}

function taggedPathId(tag: string): string {
  const generated = triangularTube.generate(resolveParams(triangularTube, {}));
  const path = generated.paths.find((candidate) => candidate.tags?.includes(tag));
  expect(path, `找不到 ${tag} path`).toBeDefined();
  return path!.id;
}

function sampledTimes(model: FoldModel): number[] {
  return [
    0,
    ...model.steps.map(({ t0, t1 }) => (t0 + t1) / 2),
    1,
  ];
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

afterEach(() => {
  capturedLines.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('panelRenderPoint seam 共動', () => {
  it('在全部 step 中點讓 zoneDTab 縫線與同面頂點維持固定相對距離，並套用堆疊位移', () => {
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const panel = model.panels.find(({ id }) => id === 'zoneDTab')!;
    const seam = model.seams!.find(({ ownerPanelId }) => ownerPanelId === panel.id);
    const overlapPlan = panelOverlapPlan(panel.id, THICKNESS_MM);
    expect(seam).toBeDefined();
    const distances = sampledTimes(model).map((t) => {
      const context = createPanelRenderPoseContext(
        model,
        foldPose(t, model),
        THICKNESS_MM,
      );
      return distance(
        panelRenderPoint(panel.id, seam!.points[0]!, context),
        panelRenderPoint(panel.id, panel.polygon[0]!, context),
      );
    });

    const foldedPose = foldPose(1, model);
    const foldedContext = createPanelRenderPoseContext(model, foldedPose, THICKNESS_MM);
    const nominalPoint = applyTransform(
      panelWorldTransform(model, foldedPose, panel.id),
      { ...seam!.points[0]!, z: 0 },
    );
    const renderedPoint = panelRenderPoint(panel.id, seam!.points[0]!, foldedContext);

    expect(overlapPlan.normalOffset).not.toBe(0);
    expect(distance(renderedPoint, nominalPoint)).toBeCloseTo(
      Math.abs(overlapPlan.normalOffset),
      7,
    );
    for (const measured of distances) {
      expect(measured).toBeCloseTo(distances[0]!, 7);
    }
  });

  it('讓 abSlot 軸段兩份在攤平、各 step 中點與摺合態恆重合', () => {
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const abSlotId = taggedPathId('abSlot');
    const pair = seamGroups(model).find((group) =>
      group[0]!.sourcePathId === abSlotId && isAxisGroup(model, group))!;

    expect(pair).toHaveLength(2);
    for (const t of sampledTimes(model)) {
      const context = createPanelRenderPoseContext(model, foldPose(t, model), THICKNESS_MM);
      for (let pointIndex = 0; pointIndex < pair[0]!.points.length; pointIndex += 1) {
        const first = panelRenderPoint(
          pair[0]!.ownerPanelId,
          pair[0]!.points[pointIndex]!,
          context,
        );
        const second = panelRenderPoint(
          pair[1]!.ownerPanelId,
          pair[1]!.points[pointIndex]!,
          context,
        );
        expect(distance(first, second)).toBeLessThan(POINT_TOLERANCE_MM);
      }
    }
  });

  it('讓 abSlot 非軸 2-owner 斜坡在摺開態分離，且兩份各自與 owner 面共動', () => {
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const abSlotId = taggedPathId('abSlot');
    const pair = seamGroups(model).find((group) =>
      group[0]!.sourcePathId === abSlotId
      && group.length === 2
      && !isAxisGroup(model, group))!;
    const flatContext = createPanelRenderPoseContext(model, foldPose(0, model), THICKNESS_MM);
    const foldedContext = createPanelRenderPoseContext(model, foldPose(1, model), THICKNESS_MM);

    expect(pair).toHaveLength(2);
    const foldedGaps = pair[0]!.points.map((_, pointIndex) => distance(
      panelRenderPoint(
        pair[0]!.ownerPanelId,
        pair[0]!.points[pointIndex]!,
        foldedContext,
      ),
      panelRenderPoint(
        pair[1]!.ownerPanelId,
        pair[1]!.points[pointIndex]!,
        foldedContext,
      ),
    ));
    expect(Math.max(...foldedGaps)).toBeGreaterThan(0);

    for (const seam of pair) {
      const panel = model.panels.find(({ id }) => id === seam.ownerPanelId)!;
      const flatDistance = distance(
        panelRenderPoint(panel.id, seam.points[0]!, flatContext),
        panelRenderPoint(panel.id, panel.polygon[0]!, flatContext),
      );
      const foldedDistance = distance(
        panelRenderPoint(panel.id, seam.points[0]!, foldedContext),
        panelRenderPoint(panel.id, panel.polygon[0]!, foldedContext),
      );
      expect(foldedDistance).toBeCloseTo(flatDistance, 7);
    }
  });
});

describe('seam LineSegments 顯示層', () => {
  it('把 n 點 polyline 展開為 2(n - 1) 個相鄰點對頂點', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 1, z: 0 },
      { x: 4, y: 1, z: 0 },
      { x: 6, y: 3, z: 0 },
    ];

    expect(expandPolylineSegments(points)).toEqual([
      points[0], points[1],
      points[1], points[2],
      points[2], points[3],
    ]);
  });

  it('為 ttb 每份 seam 建立正反兩條深灰不透明線，並在 updatePose 同步頂點', () => {
    mockCanvasContext();
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const scene = createFoldScene(document.createElement('canvas'));

    scene.replaceModel(model, { thickness: THICKNESS_MM });

    expect(model.seams!.length).toBeGreaterThan(0);
    expect(capturedLines).toHaveLength(model.seams!.length * 2);
    for (const [seamIndex, seam] of model.seams!.entries()) {
      const lines = capturedLines.slice(seamIndex * 2, seamIndex * 2 + 2);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const material = line.material as LineBasicMaterial;
        expect(line.geometry.getAttribute('position').count).toBe(2 * (seam.points.length - 1));
        expect(material.color.getHexString()).toBe('3a3a3a');
        expect(material.opacity).toBe(1);
        expect(material.transparent).toBe(false);
      }
      const firstNegative = lines[0]!.geometry.getAttribute('position').array;
      const firstPositive = lines[1]!.geometry.getAttribute('position').array;
      expect(distance(
        { x: firstNegative[0]!, y: firstNegative[1]!, z: firstNegative[2]! },
        { x: firstPositive[0]!, y: firstPositive[1]!, z: firstPositive[2]! },
      )).toBeCloseTo(0.1, 5);
    }

    const before = capturedLines.map((line) =>
      [...line.geometry.getAttribute('position').array]);
    scene.updatePose(1);
    const after = capturedLines.map((line) =>
      [...line.geometry.getAttribute('position').array]);
    expect(after.some((positions, index) =>
      positions.some((value, offset) => value !== before[index]![offset]))).toBe(true);

    scene.dispose();
  });

  it('ttb 同時保留 abSlot 與 zoneDNotch，且軸、非軸與死端分類總數閉合', () => {
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const groups = seamGroups(model);
    const abSlotId = taggedPathId('abSlot');
    const zoneDNotchId = taggedPathId('zoneDNotch');
    const axis = groups.filter((group) => isAxisGroup(model, group));
    const nonAxis = groups.filter((group) => group.length === 2 && !isAxisGroup(model, group));
    const deadEnds = groups.filter((group) => group.length === 1);
    const classifiedSeams = [...axis, ...nonAxis, ...deadEnds].reduce(
      (total, group) => total + group.length,
      0,
    );

    expect(model.seams!.filter(({ sourcePathId }) => sourcePathId === abSlotId).length)
      .toBe(12);
    expect(model.seams!.filter(({ sourcePathId }) => sourcePathId === zoneDNotchId).length)
      .toBe(8);
    expect(axis).toHaveLength(2);
    expect(nonAxis).toHaveLength(6);
    expect(deadEnds).toHaveLength(4);
    expect(model.seams).toHaveLength(20);
    expect(classifiedSeams).toBe(model.seams!.length);
  });
});
