// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import type { GenerateResult, ResolvedParams } from '@/core/types';
import {
  panelizeFoldModel,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
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

const RTE_MATRIX: ReadonlyArray<{ label: string; overrides: Overrides }> = [
  { label: '預設', overrides: {} },
  { label: 'tuckDepth=0', overrides: { tuckDepth: 0 } },
  { label: 'tuckLock=0', overrides: { tuckLock: 0 } },
  { label: 'dustFlapDepth=0', overrides: { dustFlapDepth: 0 } },
  {
    label: '雙側零寬插舌',
    overrides: { L: 20, tuckClearance: 10, thickness: 0 },
  },
  {
    label: '補償後單側零寬插舌',
    overrides: { L: 20, tuckClearance: 10 },
  },
  {
    label: 'tuckRadius 鉗制邊界',
    overrides: { tuckRadius: 14, tuckDepth: 10 },
  },
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

function expectPathOrderStable(params: ResolvedParams, result: GenerateResult, expected: FoldModel): void {
  const reordered = panelizeFoldModel(
    reorderedResult(result),
    'P1',
    angleSpecs(expected),
    expected.steps,
  );
  expect({ ...reordered, dieline: expected.dieline }).toEqual(expected);
}

describe('RTE 2D 導出幾何全矩陣', () => {
  for (const testCase of RTE_MATRIX) {
    it(`${testCase.label}: 全輪廓、單次覆蓋、hinge 雙射與 path 重排穩定`, () => {
      const params = resolveParams(reverseTuckEnd, testCase.overrides);
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const oracle = oracleCutRegion(result);
      const polygons = model.panels.map(({ polygon }) => polygon);
      const linearErrorBudgetMm = ARC_TOLERANCE_MM + ORACLE_FLATTEN_TOLERANCE_MM;
      const areaToleranceMm2 = oracle.perimeterMm * linearErrorBudgetMm;

      expect(
        symmetricDifferenceArea(oracle.polygons, polygons),
        `${testCase.label}: symmetric difference 超過 perimeter×(${ARC_TOLERANCE_MM}+${ORACLE_FLATTEN_TOLERANCE_MM})`,
      ).toBeLessThanOrEqual(areaToleranceMm2);
      expect(overlappingArea(polygons), `${testCase.label}: panel 覆蓋超過一次`)
        .toBeLessThanOrEqual(AREA_EPSILON_MM2);
      expectTopologyComplete(model, result);
      expectPathOrderStable(params, result, model);
    });
  }
});

const RTE_T1_REFERENCE_FROZEN: Record<string, Vec3[]> = {
  P1: [{ x: 0, y: 0, z: 0 }, { x: 55, y: 117, z: 0 }],
  P2: [{ x: 55, y: 0, z: -55 }, { x: 55, y: 117, z: -55 }],
  P3: [{ x: 0, y: 0, z: -55 }, { x: 0, y: 117, z: -55 }],
  P4: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 117, z: 0 }],
  glue: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 117, z: 0 }],
  topLid: [{ x: 55, y: 0, z: -55 }, { x: 0, y: 0, z: -55 }],
  bottomLid: [{ x: 0, y: 117, z: -55 }, { x: 55, y: 117, z: -55 }],
  topTuck: [{ x: 51.2, y: 12, z: 0 }, { x: 3.8, y: 12, z: 0 }],
  bottomTuck: [{ x: 51.2, y: 105, z: -55 }, { x: 3.8, y: 105, z: -55 }],
  topDustP2: [{ x: 55, y: 0, z: 0 }, { x: 55, y: 0, z: -55 }],
  topDustP4: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -55 }],
  bottomDustP2: [{ x: 55, y: 117, z: 0 }, { x: 55, y: 117, z: -55 }],
  bottomDustP4: [{ x: 0, y: 117, z: 0 }, { x: 0, y: 117, z: -55 }],
};

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function referenceGaps(model: FoldModel): Record<string, number> {
  const geometry = worldGeometry(model, foldPose(1, model));
  return Object.fromEntries(Object.entries(RTE_T1_REFERENCE_FROZEN).map(([panelId, references]) => {
    const vertices = geometry.get(panelId);
    expect(vertices, `t=1 等價驗證缺少 panel「${panelId}」`).toBeDefined();
    const gap = Math.max(...references.map(
      (reference) => Math.min(...vertices!.map((vertex) => distance(reference, vertex))),
    ));
    return [panelId, gap];
  }));
}

describe('RTE t=1 舊版等價', () => {
  it('代表頂點與 HEAD 85ac411 摺合世界座標差不超過 girth 紙厚補償總量', () => {
    const params = resolveParams(reverseTuckEnd, {});
    const model = buildRteFoldModel(params);
    const compensationBudgetMm = 4 * (params.thickness as number);
    const gaps = referenceGaps(model);
    const maximumGapMm = Math.max(...Object.values(gaps));

    expect(maximumGapMm, JSON.stringify(gaps)).toBeLessThanOrEqual(compensationBudgetMm);
  });
});

describe('RTE 單一蓋板契約', () => {
  it.each(RTE_MATRIX)('$label 僅使用 topLid/bottomLid，摺序不含退役分片 id', ({ overrides }) => {
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
    const panelIds = model.panels.map(({ id }) => id);
    const stepIds = model.steps.flatMap(({ panelIds: ids }) => ids);

    expect(panelIds).toContain('topLid');
    expect(panelIds).toContain('bottomLid');
    expect([...panelIds, ...stepIds].some((id) => /^(top|bottom)Lid[CLR]$/.test(id))).toBe(false);
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

it('RTE 所有正規化 hinge 的 child 在 a→b 左側，向外摺角為負四分之一圈', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
  for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
    expect(childSide(panel.hingeLine!, panel.polygon), panel.id).toBeGreaterThan(0);
    expect(panel.foldAngle, panel.id).toBe(-Math.PI / 2);
  }
});
