// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type {
  BoxModule,
  GenerateResult,
  ResolvedParams,
} from '@/core/types';
import { flattenSegment } from '@/fold/derive/flatten';
import {
  clampFoldPanelsToBodyHull,
  completeUncutCreaseGaps,
  InvalidBoxParamsError,
  panelizeFoldModel,
  splitFoldPanelHorizontally,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import {
  extractFaces,
  type FaceGraph,
  type PlanarSegmentInput,
} from '@/fold/derive/planar-faces';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel, TTB_BODY_HULL_CLAMP_SPEC } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import { applyTransform, panelWorldTransform } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import {
  ARC_TOLERANCE_MM,
  type FoldModel,
  type Pt,
  type SeamSegment,
} from '@/fold/types';
import {
  ORACLE_FLATTEN_TOLERANCE_MM,
  oracleCutRegion,
  overlappingArea,
  symmetricDifferenceArea,
} from '../helpers/derive-oracle';
import { sharedEdgeGapsAt, type SharedEdgeSample } from '../helpers/trajectory';

type Overrides = Partial<Record<string, number | string>>;

interface MatrixCase {
  boxId: 'rte' | 'ttsl' | 'ttb';
  label: string;
  box: BoxModule;
  rootId: string;
  overrides: Overrides;
  empiricalAreaCapMm2: number;
  build: (params: ResolvedParams) => FoldModel;
}

const MAX_THICKNESS_MM = 0.8;
const AREA_OVERLAP_TOLERANCE_MM2 = 0.05;
const TRAJECTORY_TOLERANCE_MM = 1e-8;
const SNAP_TOLERANCE_MM = 1e-6;

const MATRIX: readonly MatrixCase[] = [
  {
    boxId: 'rte', label: '預設', box: reverseTuckEnd, rootId: 'P1', overrides: {},
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: 'tuckDepth=0', box: reverseTuckEnd, rootId: 'P1', overrides: { tuckDepth: 0 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: 'tuckLock=0', box: reverseTuckEnd, rootId: 'P1', overrides: { tuckLock: 0 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: 'dustFlapDepth=0', box: reverseTuckEnd, rootId: 'P1', overrides: { dustFlapDepth: 0 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: '雙側零寬插舌', box: reverseTuckEnd, rootId: 'P1',
    overrides: { L: 20, tuckClearance: 10, thickness: 0 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: '補償後單側零寬插舌', box: reverseTuckEnd, rootId: 'P1',
    overrides: { L: 20, tuckClearance: 10 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: 'tuckRadius 鉗制邊界', box: reverseTuckEnd, rootId: 'P1',
    overrides: { tuckRadius: 14, tuckDepth: 10 },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: '左糊邊×最大紙厚', box: reverseTuckEnd, rootId: 'P1',
    overrides: { glueSide: 'left', thickness: MAX_THICKNESS_MM },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'rte', label: '右糊邊×最大紙厚', box: reverseTuckEnd, rootId: 'P1',
    overrides: { glueSide: 'right', thickness: MAX_THICKNESS_MM },
    empiricalAreaCapMm2: 20, build: buildRteFoldModel,
  },
  {
    boxId: 'ttsl', label: '預設', box: tuckTopSnapLock, rootId: 'P1', overrides: {},
    empiricalAreaCapMm2: 20, build: buildTtslFoldModel,
  },
  {
    boxId: 'ttsl', label: '左糊邊×最大紙厚', box: tuckTopSnapLock, rootId: 'P1',
    overrides: { glueSide: 'left', thickness: MAX_THICKNESS_MM },
    empiricalAreaCapMm2: 20, build: buildTtslFoldModel,
  },
  {
    boxId: 'ttsl', label: '右糊邊×最大紙厚', box: tuckTopSnapLock, rootId: 'P1',
    overrides: { glueSide: 'right', thickness: MAX_THICKNESS_MM },
    empiricalAreaCapMm2: 20, build: buildTtslFoldModel,
  },
  {
    boxId: 'ttb', label: '預設', box: triangularTube, rootId: 'faceA', overrides: {},
    empiricalAreaCapMm2: 1, build: buildTtbFoldModel,
  },
  {
    boxId: 'ttb', label: '最短合法 tubeLength', box: triangularTube, rootId: 'faceA',
    overrides: { tubeLength: 82.998 }, empiricalAreaCapMm2: 1, build: buildTtbFoldModel,
  },
  {
    boxId: 'ttb', label: '最窄 tabWidth=30', box: triangularTube, rootId: 'faceA',
    overrides: { tabWidth: 30 }, empiricalAreaCapMm2: 1, build: buildTtbFoldModel,
  },
];

function activePlanarInputs(result: GenerateResult): PlanarSegmentInput[] {
  const inputs = result.paths.flatMap((path) => {
    if (path.type !== 'cut' && path.type !== 'crease') return [];
    const kind: PlanarSegmentInput['kind'] = path.type;
    const inactive = new Set(path.inactiveSegments ?? []);
    return path.segments.flatMap((segment, index) => inactive.has(index)
      ? []
      : [{
          polyline: flattenSegment(segment, ARC_TOLERANCE_MM),
          pathId: path.id,
          kind,
        } satisfies PlanarSegmentInput]);
  });
  return completeUncutCreaseGaps(inputs);
}

function snappedPointKey(point: Pt): string {
  return `${Math.round(point.x / SNAP_TOLERANCE_MM)}:${Math.round(point.y / SNAP_TOLERANCE_MM)}`;
}

function canonicalCycle(keys: string[]): string {
  const variants: string[] = [];
  for (const ordered of [keys, [...keys].reverse()]) {
    for (let start = 0; start < ordered.length; start += 1) {
      variants.push([...ordered.slice(start), ...ordered.slice(0, start)].join('|'));
    }
  }
  return variants.sort()[0]!;
}

function polygonKey(polygon: Pt[]): string {
  return canonicalCycle(polygon.map(snappedPointKey));
}

function orderedSegmentKey(a: Pt, b: Pt): string {
  return [snappedPointKey(a), snappedPointKey(b)].sort().join('|');
}

function faceOwners(graph: FaceGraph, model: FoldModel): Map<number, string> {
  const ownerByPolygon = new Map(model.panels.map((panel) => [polygonKey(panel.polygon), panel.id]));
  return new Map(graph.faces.flatMap((face, index) => {
    const owner = ownerByPolygon.get(polygonKey(face.outline));
    return owner === undefined ? [] : [[index, owner] as const];
  }));
}

function foldGroups(result: GenerateResult): Map<string, { parentId: string; childId: string; pathIds: string[] }> {
  const groups = new Map<string, { parentId: string; childId: string; pathIds: string[] }>();
  for (const path of result.paths) {
    if (path.type !== 'crease') continue;
    const inactive = new Set(path.inactiveSegments ?? []);
    if (!path.segments.some((_, index) => !inactive.has(index))) continue;
    for (const tag of path.tags ?? []) {
      const match = /^fold:([^>]+)>([^>]+)$/.exec(tag);
      if (!match) continue;
      const group = groups.get(tag) ?? {
        parentId: match[1]!,
        childId: match[2]!,
        pathIds: [],
      };
      group.pathIds.push(path.id);
      groups.set(tag, group);
    }
  }
  return groups;
}

function angleSpecs(model: FoldModel): PanelAngleSpec[] {
  return model.panels.map(({ id, foldAngle, liftOffset }) => ({ id, foldAngle, liftOffset }));
}

function reproducePostProcessedModel(
  result: GenerateResult,
  rootId: string,
  expected: FoldModel,
): FoldModel {
  const virtualPanels = expected.panels.filter(({ hingeLine }) => hingeLine?.virtual === true);
  const virtualIds = new Set(virtualPanels.map(({ id }) => id));
  let reproduced = panelizeFoldModel(
    result,
    rootId,
    angleSpecs(expected).filter(({ id }) => !virtualIds.has(id)),
    expected.steps.filter(({ panelIds }) => panelIds.every((id) => !virtualIds.has(id))),
  );

  for (const virtualPanel of virtualPanels) {
    const child = expected.panels.find(({ parent }) => parent === virtualPanel.id);
    expect(child, `${virtualPanel.id} 應有後處理 child`).toBeDefined();
    reproduced = splitFoldPanelHorizontally(reproduced, {
      panelId: virtualPanel.parent!,
      newPanelId: virtualPanel.id,
      reparentChildId: child!.id,
      splitY: virtualPanel.hingeLine!.a.y,
      foldAngle: virtualPanel.foldAngle,
    });
  }

  // 端封件視覺 allowance（vertexClamp）也屬後處理——expected 含收束頂點時重放。
  if (expected.panels.some(({ vertexClamp }) => vertexClamp !== undefined)) {
    reproduced = clampFoldPanelsToBodyHull(reproduced, TTB_BODY_HULL_CLAMP_SPEC);
  }
  return { ...reproduced, steps: expected.steps };
}

function reorderedResult(result: GenerateResult): GenerateResult {
  const evens = result.paths.filter((_, index) => index % 2 === 0).reverse();
  const odds = result.paths.filter((_, index) => index % 2 === 1).reverse();
  return { ...result, paths: [...odds, ...evens] };
}

function expectTopologyComplete(testCase: MatrixCase, result: GenerateResult, model: FoldModel): void {
  const groups = foldGroups(result);
  const expectedIds = new Set([testCase.rootId]);
  const virtualPanels = model.panels.filter(({ hingeLine }) => hingeLine?.virtual === true);
  for (const group of groups.values()) {
    expectedIds.add(group.parentId);
    expectedIds.add(group.childId);
  }
  for (const panel of virtualPanels) expectedIds.add(panel.id);

  expect(model.panels.map(({ id }) => id).sort()).toEqual([...expectedIds].sort());
  expect(new Set(model.panels.map(({ id }) => id)).size).toBe(model.panels.length);
  expect(model.panels.filter(({ parent }) => parent !== null)).toHaveLength(groups.size + virtualPanels.length);

  for (const group of groups.values()) {
    const child = model.panels.find(({ id }) => id === group.childId);
    expect(child, group.childId).toBeDefined();
    const actualParent = model.panels.find(({ id }) => id === child!.parent);
    if (child!.parent === group.parentId) {
      expect(child!.parent).toBe(group.parentId);
    } else {
      expect(actualParent).toEqual(expect.objectContaining({
        parent: group.parentId,
        hingeLine: expect.objectContaining({ virtual: true }),
      }));
    }
    expect(child!.hingeSourceCreaseIds).toEqual([...group.pathIds].sort());
  }

  const reordered = reproducePostProcessedModel(
    reorderedResult(result),
    testCase.rootId,
    model,
  );
  expect({ ...reordered, dieline: model.dieline }).toEqual(model);
}

function expectedSeams(graph: FaceGraph, owners: Map<number, string>): SeamSegment[] {
  const expected: SeamSegment[] = [];
  for (const adjacency of graph.adjacency) {
    const adjacentOwners = [owners.get(adjacency.faceA), owners.get(adjacency.faceB)]
      .filter((owner): owner is string => owner !== undefined);
    if (adjacentOwners.length !== 2) continue;
    for (const edge of adjacency.sharedEdges.filter(({ kind }) => kind === 'cut')) {
      for (const ownerPanelId of adjacentOwners) {
        expected.push({
          points: [edge.a, edge.b],
          ownerPanelId,
          sourcePathId: edge.pathId,
        });
      }
    }
  }
  for (const cut of graph.danglingCuts) {
    const ownerPanelId = owners.get(cut.containingFace);
    if (ownerPanelId !== undefined) {
      expected.push({
        points: [cut.a, cut.b],
        ownerPanelId,
        sourcePathId: cut.pathId,
      });
    }
  }
  return expected;
}

function seamMultiset(seams: readonly SeamSegment[]): Record<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const seam of seams) {
    expect(seam.points).toHaveLength(2);
    const key = orderedSegmentKey(seam.points[0]!, seam.points[1]!);
    const owners = entries.get(key) ?? [];
    owners.push(`${seam.ownerPanelId}\u0000${seam.sourcePathId}`);
    entries.set(key, owners);
  }
  return Object.fromEntries([...entries]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, owners]) => [key, owners.sort()]));
}

function trajectoryTimes(model: FoldModel): number[] {
  const times = new Set([0, 1]);
  for (const step of model.steps) {
    for (const localProgress of [0.25, 0.5, 0.75]) {
      times.add(step.t0 + (step.t1 - step.t0) * localProgress);
    }
  }
  return [...times].sort((first, second) => first - second);
}

function sampleSegment(a: Pt, b: Pt): Pt[] {
  return [0, 0.25, 0.5, 0.75, 1].map((amount) => ({
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  }));
}

function creaseSamples(graph: FaceGraph, owners: Map<number, string>, model: FoldModel): SharedEdgeSample[] {
  return graph.adjacency.flatMap((adjacency) => {
    const aPanelId = owners.get(adjacency.faceA);
    const bPanelId = owners.get(adjacency.faceB);
    if (aPanelId === undefined || bPanelId === undefined) return [];
    const child = model.panels.find((panel) =>
      (panel.id === aPanelId && panel.parent === bPanelId)
      || (panel.id === bPanelId && panel.parent === aPanelId));
    if (child === undefined) return [];
    return adjacency.sharedEdges
      .filter(({ kind }) => kind === 'crease')
      .map(({ a, b }) => ({ aPanelId, bPanelId, points: sampleSegment(a, b) }));
  });
}

function distance(first: { x: number; y: number; z: number }, second: {
  x: number; y: number; z: number;
}): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function expectSeamsMoveRigidly(model: FoldModel, times: number[]): void {
  const panels = new Map(model.panels.map((panel) => [panel.id, panel]));
  for (const t of times) {
    const pose = foldPose(t, model);
    for (const seam of model.seams ?? []) {
      const panel = panels.get(seam.ownerPanelId)!;
      const transform = panelWorldTransform(model, pose, panel.id);
      const worldPoints = seam.points.map((point) => applyTransform(transform, { ...point, z: 0 }));
      const flatLength = Math.hypot(
        seam.points[1]!.x - seam.points[0]!.x,
        seam.points[1]!.y - seam.points[0]!.y,
      );
      expect(distance(worldPoints[0]!, worldPoints[1]!), `${panel.id} seam at t=${t}`)
        .toBeCloseTo(flatLength, 8);
    }
  }
}

describe('2D／3D 導出幾何共用全矩陣', () => {
  for (const testCase of MATRIX) {
    it(`${testCase.boxId}/${testCase.label}`, () => {
      const params = resolveParams(testCase.box, testCase.overrides);
      const result = testCase.box.generate(params);
      const model = testCase.build(params);
      const oracle = oracleCutRegion(result);
      const polygons = model.panels.map(({ polygon }) => polygon);
      const linearBudgetMm = ARC_TOLERANCE_MM + ORACLE_FLATTEN_TOLERANCE_MM;
      const theoreticalAreaToleranceMm2 = oracle.perimeterMm * linearBudgetMm;
      const differenceMm2 = symmetricDifferenceArea(oracle.polygons, polygons);

      expect(differenceMm2).toBeLessThanOrEqual(theoreticalAreaToleranceMm2);
      expect(differenceMm2, `${testCase.boxId}/${testCase.label} 經驗上限`)
        .toBeLessThanOrEqual(testCase.empiricalAreaCapMm2);
      expect(overlappingArea(polygons)).toBeLessThanOrEqual(AREA_OVERLAP_TOLERANCE_MM2);
      expectTopologyComplete(testCase, result, model);

      const graph = extractFaces(activePlanarInputs(result));
      const owners = faceOwners(graph, model);
      const expected = model.panels.some(({ hingeLine }) => hingeLine?.virtual === true)
        ? reproducePostProcessedModel(result, testCase.rootId, model).seams ?? []
        : expectedSeams(graph, owners);
      expect(seamMultiset(model.seams ?? [])).toEqual(seamMultiset(expected));

      const times = trajectoryTimes(model);
      expect(times).toHaveLength(2 + model.steps.length * 3);
      expectSeamsMoveRigidly(model, times);

      const samples = creaseSamples(graph, owners, model);
      expect(samples.length).toBeGreaterThan(0);
      for (const t of times) {
        const gaps = sharedEdgeGapsAt(model, samples, t);
        const maximumGapMm = Math.max(...gaps.map(({ maxGapMm }) => maxGapMm));
        expect(maximumGapMm, `${testCase.boxId}/${testCase.label} at t=${t}`)
          .toBeLessThan(TRAJECTORY_TOLERANCE_MM);
      }
    });
  }
});

describe('非法輸入具名失敗', () => {
  it.each([
    ['rte', reverseTuckEnd, buildRteFoldModel, { tuckLock: 2 }, 'tuck-lock-fits'],
    ['ttsl', tuckTopSnapLock, buildTtslFoldModel, { tuckDepth: 0 }, 'tuck-depth-within-body'],
    ['ttb', triangularTube, buildTtbFoldModel, { tubeLength: 80, tabWidth: 100 }, 'tab-base-geometry'],
  ] as const)('%s 真 error invariant', (_boxId, box, build, overrides, invariantId) => {
    try {
      build(resolveParams(box, overrides));
      throw new Error('預期 builder 拋出 InvalidBoxParamsError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBoxParamsError);
      expect((error as InvalidBoxParamsError).invariantId).toBe(invariantId);
    }
  });
});
