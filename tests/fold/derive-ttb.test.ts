// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import type { GenerateResult } from '@/core/types';
import {
  panelizeFoldModel,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
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

type Overrides = Partial<Record<string, number>>;

const AREA_EPSILON_MM2 = 0.05;
const SHORTEST_TUBE_LENGTH_MM = 82.998;

const TTB_MATRIX: ReadonlyArray<{ label: string; overrides: Overrides }> = [
  { label: '預設', overrides: {} },
  {
    label: '最短合法 tubeLength（abEndCrease=1.5mm）',
    overrides: { tubeLength: SHORTEST_TUBE_LENGTH_MM },
  },
  { label: '最窄 tabWidth=30mm', overrides: { tabWidth: 30 } },
];

interface FoldGroup {
  parentId: string;
  childId: string;
  pathIds: string[];
}

function foldGroups(result: GenerateResult): Map<string, FoldGroup> {
  const groups = new Map<string, FoldGroup>();
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

function expectedPanelIds(groups: Map<string, FoldGroup>): string[] {
  const ids = new Set(['faceA', 'zoneDLip']);
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
  expect(model.panels.filter(({ parent }) => parent !== null)).toHaveLength(groups.size + 1);
  expect(model.panels.filter(({ hingeLine }) => hingeLine?.virtual === true)).toEqual([
    expect.objectContaining({ id: 'zoneDLip', parent: 'zoneDBase' }),
  ]);

  for (const group of groups.values()) {
    const child = panelById(model, group.childId);
    expect(child.parent).toBe(group.childId === 'zoneDTab' ? 'zoneDLip' : group.parentId);
    expect(child.hingeLine).toBeDefined();
    expect(child.hingeSourceCreaseIds).toEqual([...group.pathIds].sort());
  }

  const tracedIds = model.panels
    .filter(({ hingeLine }) => hingeLine?.virtual !== true)
    .flatMap(({ hingeSourceCreaseIds }) => hingeSourceCreaseIds ?? [])
    .sort();
  const activeCreaseIds = [...groups.values()].flatMap(({ pathIds }) => pathIds).sort();
  expect(tracedIds).toEqual(activeCreaseIds);
}

function expectPathOrderStable(result: GenerateResult, expected: FoldModel): void {
  const angles = angleSpecs(expected).filter(({ id }) => id !== 'zoneDLip');
  const steps = expected.steps.filter(({ panelIds }) => !panelIds.includes('zoneDLip'));
  const original = panelizeFoldModel(result, 'faceA', angles, steps);
  const reordered = panelizeFoldModel(
    reorderedResult(result),
    'faceA',
    angles,
    steps,
  );
  expect({ ...reordered, dieline: original.dieline }).toEqual(original);
}

function comparePoints(a: Pt, b: Pt): number {
  return a.x - b.x || a.y - b.y;
}

function expectCanonicalTabHinge(model: FoldModel, result: GenerateResult): void {
  const segments = result.paths
    .filter((path) => path.type === 'crease' && path.tags?.includes('fold:zoneDBase>zoneDTab'))
    .flatMap((path) => path.segments)
    .filter((segment) => segment.kind === 'line')
    .map((segment) => {
      const endpoints: [Pt, Pt] = [
        { x: segment.x1, y: segment.y1 },
        { x: segment.x2, y: segment.y2 },
      ];
      endpoints.sort(comparePoints);
      return endpoints;
    })
    .sort((first, second) => comparePoints(first[0], second[0]));

  expect(segments).toHaveLength(2);
  const hinge = panelById(model, 'zoneDTab').hingeLine!;
  expect(hinge.a.x).toBeCloseTo(segments[0]![0].x, 9);
  expect(hinge.a.y).toBeCloseTo(segments[0]![0].y, 9);
  expect(hinge.b.x).toBeCloseTo(segments[0]![1].x, 9);
  expect(hinge.b.y).toBeCloseTo(segments[0]![1].y, 9);
}

describe('TTB 2D 導出幾何全矩陣', () => {
  for (const testCase of TTB_MATRIX) {
    it(`${testCase.label}: 全輪廓、單次覆蓋、hinge 雙射與 path 重排穩定`, () => {
      const params = resolveParams(triangularTube, testCase.overrides);
      const result = triangularTube.generate(params);
      const model = buildTtbFoldModel(params);
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
      expectPathOrderStable(result, model);
    });
  }
});

describe('TTB logical crease group 與單一插舌', () => {
  for (const testCase of TTB_MATRIX) {
    it(`${testCase.label}: A/B 與 tab root 分段 crease 各自合成單一 logical hinge`, () => {
      const params = resolveParams(triangularTube, testCase.overrides);
      const result = triangularTube.generate(params);
      const model = buildTtbFoldModel(params);

      expect(panelById(model, 'faceB').hingeSourceCreaseIds).toHaveLength(2);
      expect(panelById(model, 'zoneDTab').hingeSourceCreaseIds).toHaveLength(2);
      expect(panelById(model, 'zoneDTab').polygon).toHaveLength(9);
      expect(model.panels.some(({ id }) => id.startsWith('zoneDTab.'))).toBe(false);
      expectCanonicalTabHinge(model, result);
    });
  }
});

describe('TTB t=0 split 幾何恆等', () => {
  for (const testCase of TTB_MATRIX) {
    it(`${testCase.label}: 既有 panel 逐位元不變，zoneDBase split 邊界與外框逐位元守恆`, () => {
      const params = resolveParams(triangularTube, testCase.overrides);
      const result = triangularTube.generate(params);
      const splitModel = buildTtbFoldModel(params);
      const sourceModel = panelizeFoldModel(
        result,
        'faceA',
        angleSpecs(splitModel).filter(({ id }) => id !== 'zoneDLip'),
        splitModel.steps.filter(({ panelIds }) => !panelIds.includes('zoneDLip')),
      );
      const sourceBase = panelById(sourceModel, 'zoneDBase');
      const splitBase = panelById(splitModel, 'zoneDBase');
      const lip = panelById(splitModel, 'zoneDLip');

      for (const sourcePanel of sourceModel.panels.filter(({ id }) => id !== 'zoneDBase')) {
        expect(panelById(splitModel, sourcePanel.id).polygon).toEqual(sourcePanel.polygon);
      }
      for (const sourceVertex of sourceBase.polygon) {
        expect([...splitBase.polygon, ...lip.polygon]).toContainEqual(sourceVertex);
      }
      const splitY = lip.hingeLine!.a.y;
      const compare = (first: Pt, second: Pt): number => first.x - second.x || first.y - second.y;
      expect([...splitBase.polygon, ...lip.polygon]
        .filter(({ y }) => y !== splitY)
        .sort(compare))
        .toEqual([...sourceBase.polygon].sort(compare));
      expect({
        minX: Math.min(...splitBase.polygon.map(({ x }) => x), ...lip.polygon.map(({ x }) => x)),
        maxX: Math.max(...splitBase.polygon.map(({ x }) => x), ...lip.polygon.map(({ x }) => x)),
        minY: Math.min(...splitBase.polygon.map(({ y }) => y), ...lip.polygon.map(({ y }) => y)),
        maxY: Math.max(...splitBase.polygon.map(({ y }) => y), ...lip.polygon.map(({ y }) => y)),
      }).toEqual({
        minX: Math.min(...sourceBase.polygon.map(({ x }) => x)),
        maxX: Math.max(...sourceBase.polygon.map(({ x }) => x)),
        minY: Math.min(...sourceBase.polygon.map(({ y }) => y)),
        maxY: Math.max(...sourceBase.polygon.map(({ y }) => y)),
      });
    });
  }
});
