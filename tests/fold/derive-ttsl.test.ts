// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { GenerateResult, ResolvedParams } from '@/core/types';
import {
  panelizeFoldModel,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import {
  ARC_TOLERANCE_MM,
  type FoldModel,
  type Pt,
} from '@/fold/types';
import {
  ORACLE_FLATTEN_TOLERANCE_MM,
  oracleCutRegion,
  overlappingArea,
  symmetricDifferenceArea,
} from '../helpers/derive-oracle';

type Overrides = Partial<Record<string, number | string>>;

const AREA_EPSILON_MM2 = 0.05;
const MAX_THICKNESS_MM = 0.8;
const T1_MIRROR_AXIS_DOUBLED_MM = 280;

const TTSL_MATRIX: ReadonlyArray<{ label: string; overrides: Overrides }> = [
  { label: '預設', overrides: {} },
  {
    label: '左糊邊×最大紙厚',
    overrides: { glueSide: 'left', thickness: MAX_THICKNESS_MM },
  },
  {
    label: '右糊邊×最大紙厚',
    overrides: { glueSide: 'right', thickness: MAX_THICKNESS_MM },
  },
];

function foldGroups(result: GenerateResult): Map<string, { parentId: string; childId: string; pathIds: string[] }> {
  const groups = new Map<string, { parentId: string; childId: string; pathIds: string[] }>();
  for (const path of result.paths) {
    if (path.type !== 'crease') continue;
    const active = path.segments.some((_, index) => !(path.inactiveSegments ?? []).includes(index));
    if (!active) continue;
    for (const tag of path.tags ?? []) {
      const match = /^fold:([^>]+)>([^>]+)$/.exec(tag);
      if (!match) continue;
      const existing = groups.get(tag) ?? {
        parentId: match[1]!,
        childId: match[2]!,
        pathIds: [],
      };
      existing.pathIds.push(path.id);
      groups.set(tag, existing);
    }
  }
  return groups;
}

function expectedPanelIds(groups: ReturnType<typeof foldGroups>): string[] {
  const ids = new Set(['P1']);
  for (const group of groups.values()) {
    ids.add(group.parentId);
    ids.add(group.childId);
  }
  return [...ids].sort();
}

function angleSpecs(model: FoldModel): PanelAngleSpec[] {
  return model.panels.map(({ id, foldAngle, liftOffset }) => ({ id, foldAngle, liftOffset }));
}

function reorderedResult(result: GenerateResult): GenerateResult {
  const paths = [...result.paths];
  const evens = paths.filter((_, index) => index % 2 === 0).reverse();
  const odds = paths.filter((_, index) => index % 2 === 1).reverse();
  return { ...result, paths: [...odds, ...evens] };
}

function panelById(model: FoldModel, id: string) {
  const panel = model.panels.find((candidate) => candidate.id === id);
  expect(panel, `找不到 panel「${id}」`).toBeDefined();
  return panel!;
}

function expectTopologyComplete(model: FoldModel, result: GenerateResult): void {
  const groups = foldGroups(result);
  expect(model.panels.map(({ id }) => id).sort()).toEqual(expectedPanelIds(groups));
  expect(new Set(model.panels.map(({ id }) => id)).size).toBe(model.panels.length);
  expect(model.panels.filter(({ parent }) => parent !== null)).toHaveLength(groups.size);

  for (const group of groups.values()) {
    const child = panelById(model, group.childId);
    expect(child.parent).toBe(group.parentId);
    expect(child.hingeLine).toBeDefined();
    expect(child.hingeSourceCreaseIds).toEqual([...group.pathIds].sort());
  }

  const tracedIds = model.panels
    .flatMap(({ hingeSourceCreaseIds }) => hingeSourceCreaseIds ?? [])
    .sort();
  const activeCreaseIds = [...groups.values()].flatMap(({ pathIds }) => pathIds).sort();
  expect(tracedIds).toEqual(activeCreaseIds);
}

function expectPathOrderStable(result: GenerateResult, expected: FoldModel): void {
  const reordered = panelizeFoldModel(
    reorderedResult(result),
    'P1',
    angleSpecs(expected),
    expected.steps,
  );
  expect({ ...reordered, dieline: expected.dieline }).toEqual(expected);
}

describe('TTSL 2D 導出幾何全矩陣', () => {
  for (const testCase of TTSL_MATRIX) {
    it(`${testCase.label}: 全輪廓、曲線誤差預算、單次覆蓋、hinge 雙射與 path 重排穩定`, () => {
      const params = resolveParams(tuckTopSnapLock, testCase.overrides);
      const result = tuckTopSnapLock.generate(params);
      const model = buildTtslFoldModel(params);
      const oracle = oracleCutRegion(result);
      const polygons = model.panels.map(({ polygon }) => polygon);
      const curveFlattenBudgetMm = ARC_TOLERANCE_MM + ORACLE_FLATTEN_TOLERANCE_MM;
      const areaToleranceMm2 = oracle.perimeterMm * curveFlattenBudgetMm;
      const symmetricDifferenceMm2 = symmetricDifferenceArea(oracle.polygons, polygons);
      const overlapMm2 = overlappingArea(polygons);

      expect(
        symmetricDifferenceMm2,
        `${testCase.label}: symmetric difference 超過 perimeter×(${ARC_TOLERANCE_MM}+${ORACLE_FLATTEN_TOLERANCE_MM})`,
      ).toBeLessThanOrEqual(areaToleranceMm2);
      expect(overlapMm2, `${testCase.label}: panel 覆蓋超過一次`)
        .toBeLessThanOrEqual(AREA_EPSILON_MM2);
      expectTopologyComplete(model, result);
      expectPathOrderStable(result, model);
    });
  }
});

const LEFT_T1_REFERENCE_88C5A84: Record<string, Vec3[]> = {
  P1: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 125, z: 0 }],
  P2: [{ x: 85, y: 0, z: 0 }, { x: 85, y: 125, z: 0 }],
  P3: [{ x: 85, y: 0, z: -55 }, { x: 85, y: 125, z: -55 }],
  P4: [{ x: 0, y: 0, z: -55 }, { x: 0, y: 125, z: -55 }],
  glue: [{ x: 0, y: 62.5, z: -18 }],
  bottomLockP1: [{ x: 26.75, y: 125, z: -38.5 }],
  bottomWebP2: [{ x: 46.5, y: 125, z: 0 }],
  bottomWebP4: [{ x: 0, y: 125, z: 0 }],
  bottomReceiveP3: [
    { x: 62.25, y: 125, z: -27.5 },
    { x: 22.75, y: 125, z: -27.5 },
  ],
  topLid: [{ x: 85, y: 0, z: -55 }],
  topTuck: [{ x: 69.75, y: 18, z: -1 }, { x: 77.5, y: 0, z: -1 }],
  topDustP2: [{ x: 85, y: 0, z: 0 }],
  topDustP4: [{ x: 0, y: 0, z: 0 }],
};

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function distanceToSegment(point: Vec3, a: Vec3, b: Vec3): number {
  const direction = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const lengthSquared = direction.x ** 2 + direction.y ** 2 + direction.z ** 2;
  if (lengthSquared === 0) return distance(point, a);
  const offset = { x: point.x - a.x, y: point.y - a.y, z: point.z - a.z };
  const parameter = Math.max(0, Math.min(1,
    (offset.x * direction.x + offset.y * direction.y + offset.z * direction.z) / lengthSquared));
  return distance(point, {
    x: a.x + direction.x * parameter,
    y: a.y + direction.y * parameter,
    z: a.z + direction.z * parameter,
  });
}

function distanceToBoundary(point: Vec3, vertices: Vec3[]): number {
  return Math.min(...vertices.map((vertex, index) =>
    distanceToSegment(point, vertex, vertices[(index + 1) % vertices.length]!)));
}

function referenceGaps(model: FoldModel, glueSide: 'left' | 'right'): Record<string, number> {
  const geometry = worldGeometry(model, foldPose(1, model));
  return Object.fromEntries(Object.entries(LEFT_T1_REFERENCE_88C5A84).map(([panelId, leftReferences]) => {
    const vertices = geometry.get(panelId);
    expect(vertices, `t=1 等價驗證缺少 panel「${panelId}」`).toBeDefined();
    const references = glueSide === 'left'
      ? leftReferences
      : leftReferences.map(({ x, y, z }) => ({ x: T1_MIRROR_AXIS_DOUBLED_MM - x, y, z }));
    const gap = Math.max(...references.map((reference) => distanceToBoundary(reference, vertices!)));
    return [panelId, gap];
  }));
}

describe('TTSL t=1 舊版等價', () => {
  for (const glueSide of ['left', 'right'] as const) {
    it(`${glueSide}: 代表頂點與 HEAD 88c5a84 摺合世界座標差不超過 girth 紙厚補償總量`, () => {
      const params = resolveParams(tuckTopSnapLock, { glueSide });
      const model = buildTtslFoldModel(params);
      const compensationBudgetMm = 4 * (params.thickness as number);
      const gaps = referenceGaps(model, glueSide);
      const maximumGapMm = Math.max(...Object.values(gaps));

      expect(maximumGapMm, JSON.stringify(gaps)).toBeLessThanOrEqual(compensationBudgetMm);
    });
  }
});

describe('TTSL 單一接收片契約', () => {
  it.each(TTSL_MATRIX)('$label 僅使用 bottomReceiveP3，摺序不含退役分片 id', ({ overrides }) => {
    const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, overrides));
    const panelIds = model.panels.map(({ id }) => id);
    const stepIds = model.steps.flatMap(({ panelIds: ids }) => ids);

    expect(panelIds).toContain('bottomReceiveP3');
    expect([...panelIds, ...stepIds].some((id) => /^bottomReceiveP3\.(?:L|center|R)$/.test(id))).toBe(false);
  });
});

function childSide(hinge: { a: Pt; b: Pt }, polygon: Pt[]): number {
  const centroid = polygon.reduce(
    (sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }),
    { x: 0, y: 0 },
  );
  return (hinge.b.x - hinge.a.x) * (centroid.y - hinge.a.y)
    - (hinge.b.y - hinge.a.y) * (centroid.x - hinge.a.x);
}

it('TTSL 所有正規化 hinge 的 child 在 a→b 左側，向外摺角為負四分之一圈', () => {
  const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, {}));
  for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
    expect(childSide(panel.hingeLine!, panel.polygon), panel.id).toBeGreaterThan(0);
    expect(panel.foldAngle, panel.id).toBe(-Math.PI / 2);
  }
});
