import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { segmentsBounds, type Segment } from '@/core/geometry';
import { resolveParams } from '@/core/registry';
import type { DielinePath, GenerateResult } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import type { FoldModel, FoldPanel } from '@/fold/types';

type LineSegment = Extract<Segment, { kind: 'line' }>;

const EPSILON = 1e-9;

// 對帳基準：GIRTH_COMP_FROM_GLUE（src/boxes/reverse-tuck-end.ts:255·未 export·B1 禁改 export 面）
const GIRTH = [0, 1, 1, 2] as const;

const RECONCILIATION_MATRIX = [
  { thickness: 0, glueSide: 'left' },
  { thickness: 0, glueSide: 'right' },
  { thickness: 0.3, glueSide: 'left' },
  { thickness: 0.3, glueSide: 'right' },
  { thickness: 0.8, glueSide: 'left' },
  { thickness: 0.8, glueSide: 'right' },
] as const;

function isClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function lineSegments(paths: DielinePath[]): LineSegment[] {
  return paths
    .flatMap(({ segments }) => segments)
    .filter((segment): segment is LineSegment => segment.kind === 'line');
}

function taggedPaths(result: GenerateResult, type: DielinePath['type'], tag: string): DielinePath[] {
  return result.paths.filter((path) => path.type === type && path.tags?.includes(tag));
}

function uniqueSorted(values: number[]): number[] {
  return values
    .sort((left, right) => left - right)
    .filter((value, index, sorted) => index === 0 || !isClose(value, sorted[index - 1]!));
}

function bodyBoundaryXs(result: GenerateResult, D: number): number[] {
  const bodySegments = lineSegments(
    result.paths.filter(({ type }) => type === 'crease' || type === 'cut'),
  );
  return uniqueSorted(bodySegments
    .filter(({ x1, x2 }) => isClose(x1, x2))
    .filter(({ y1, y2 }) => isClose(Math.min(y1, y2), 0) && isClose(Math.max(y1, y2), D))
    .map(({ x1 }) => x1));
}

function horizontalCreaseInterval(result: GenerateResult, y: number, tag: string): [number, number] {
  const candidates = lineSegments(taggedPaths(result, 'crease', tag))
    .filter(({ y1, y2 }) => isClose(y1, y) && isClose(y2, y));

  expect(candidates.length, `missing horizontal ${tag} crease at y=${y}`).toBeGreaterThan(0);
  const xs = candidates.flatMap(({ x1, x2 }) => [x1, x2]);
  return [Math.min(...xs), Math.max(...xs)];
}

function tongueCutInterval(result: GenerateResult, yFold: number): [number, number] {
  // 插舌 cut path 在 yFold 上恰有兩段肩線（lid.start→xt1／xt2→lid.end·generate() :439/:450）
  // ——四個端點排序後的內側對＝真 xt1/xt2。從 2D cut 幾何直接抽取，與 builder 的
  // 「crease ∓ tuckClearance」公式互相獨立（final review F7：期望值不得與 builder 同式自我印證）。
  const xs = uniqueSorted(lineSegments(taggedPaths(result, 'cut', 'tuckDepth'))
    .filter(({ y1, y2 }) => isClose(y1, yFold) && isClose(y2, yFold))
    .flatMap(({ x1, x2 }) => [x1, x2]));
  expect(xs.length, `tongue shoulder cut endpoints at y=${yFold}`).toBe(4);
  return [xs[1]!, xs[2]!];
}

function horizontalCreaseIntervals(result: GenerateResult, y: number, tag: string): [number, number][] {
  return lineSegments(taggedPaths(result, 'crease', tag))
    .filter(({ y1, y2 }) => isClose(y1, y) && isClose(y2, y))
    .map(({ x1, x2 }): [number, number] => [Math.min(x1, x2), Math.max(x1, x2)])
    .sort(([left], [right]) => left - right);
}

function outerLidHingeY(result: GenerateResult, side: 'top' | 'bottom', D: number): number {
  const candidates = lineSegments(taggedPaths(result, 'crease', 'W'))
    .filter(({ y1, y2 }) => isClose(y1, y2))
    .filter(({ y1 }) => side === 'top' ? y1 < 0 : y1 > D);

  expect(candidates.length, `missing ${side} lid outer hinge`).toBeGreaterThan(0);
  const [first, ...rest] = candidates.map(({ y1 }) => y1);
  for (const y of rest) expect(y).toBeCloseTo(first!, 9);
  return first!;
}

function cumulativeCompensationOffsets(thickness: number, glueSide: 'left' | 'right'): number[] {
  const compensation = glueSide === 'right' ? [...GIRTH].reverse() : [...GIRTH];
  const offsets = [0];

  for (const coefficient of compensation) {
    offsets.push(offsets[offsets.length - 1]! + coefficient * thickness);
  }

  return offsets;
}

function expectCoordinatesClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(value).toBeCloseTo(expected[index]!, 9);
  }
}

function panel(model: FoldModel, id: string): FoldPanel {
  const target = model.panels.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`missing fold panel ${id}`);
  return target;
}

function foldBodyBoundaryXs(model: FoldModel): number[] {
  return uniqueSorted(['P1', 'P2', 'P3', 'P4'].flatMap((id) => {
    const xs = panel(model, id).polygon.map(({ x }) => x);
    return [Math.min(...xs), Math.max(...xs)];
  }));
}

function hingeXInterval(target: FoldPanel): [number, number] {
  if (target.hingeLine === undefined) throw new Error(`${target.id} must have a hingeLine`);
  const { a, b } = target.hingeLine;
  return [Math.min(a.x, b.x), Math.max(a.x, b.x)];
}

function lidHingeIntervals(model: FoldModel, side: 'top' | 'bottom'): [number, number][] {
  return ['L', 'C', 'R']
    .map((suffix) => hingeXInterval(panel(model, `${side}Lid${suffix}`)))
    .sort(([left], [right]) => left - right);
}

function frictionLockCutVertices(
  result: GenerateResult,
  side: 'top' | 'bottom',
  D: number,
): { x: number; y: number }[] {
  const candidates = taggedPaths(result, 'cut', 'tuckLock').filter(({ segments }) => {
    const bounds = segmentsBounds(segments);
    return side === 'top' ? bounds.maxY < 0 : bounds.minY > D;
  });
  expect(candidates, `missing ${side} friction-lock cut`).toHaveLength(1);
  const segments = lineSegments(candidates);
  expect(segments, `${side} friction-lock trapezoid segment count`).toHaveLength(3);
  return [
    { x: segments[0]!.x1, y: segments[0]!.y1 },
    ...segments.map(({ x2, y2 }) => ({ x: x2, y: y2 })),
  ];
}

function nominalizeLockVertices(
  vertices: { x: number; y: number }[],
  offsets: number[],
  boundaryIndices: [number, number],
): { x: number; y: number }[] {
  const centerOffset = (offsets[boundaryIndices[0]]! + offsets[boundaryIndices[1]]!) / 2;
  return vertices.map(({ x, y }) => ({ x: x - centerOffset, y }));
}

function expectPanelContainsPoints(target: FoldPanel, points: { x: number; y: number }[]): void {
  for (const point of points) {
    expect(
      target.polygon.some(({ x, y }) => isClose(x, point.x) && isClose(y, point.y)),
      `${target.id} must contain (${point.x}, ${point.y})`,
    ).toBe(true);
  }
}

function nominalizeInterval(
  interval: [number, number],
  offsets: number[],
  boundaryIndices: [number, number],
): [number, number] {
  return [
    interval[0] - offsets[boundaryIndices[0]]!,
    interval[1] - offsets[boundaryIndices[1]]!,
  ];
}

function polygonHeight(target: FoldPanel): number {
  const ys = target.polygon.map(({ y }) => y);
  return Math.max(...ys) - Math.min(...ys);
}

function polygonWidth(target: FoldPanel): number {
  const xs = target.polygon.map(({ x }) => x);
  return Math.max(...xs) - Math.min(...xs);
}

function taggedPathHeights(result: GenerateResult, tag: string, side: 'top' | 'bottom', D: number): number[] {
  return taggedPaths(result, 'cut', tag)
    .map(({ segments }) => segmentsBounds(segments))
    .filter((bounds) => side === 'top' ? bounds.minY < 0 : bounds.maxY > D)
    .map(({ minY, maxY }) => maxY - minY);
}

describe('RTE fold nominal geometry reconciles with compensated 2D output', () => {
  for (const { thickness, glueSide } of RECONCILIATION_MATRIX) {
    const label = `thickness=${thickness}, glueSide=${glueSide}`;

    it(`${label}: fold body boundaries equal compensated 2D boundaries minus cumulative girth compensation`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const D = params.D as number;
      const offsets = cumulativeCompensationOffsets(thickness, glueSide);
      const nominalized2dBoundaries = bodyBoundaryXs(result, D)
        .map((x, index) => x - offsets[index]!);

      expectCoordinatesClose(nominalized2dBoundaries, foldBodyBoundaryXs(model));
    });

    it(`${label}: three top lid slices belong to P3 and three bottom slices belong to P1`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const D = params.D as number;
      const [x0, x1, x2, x3] = bodyBoundaryXs(result, D);
      for (const suffix of ['L', 'C', 'R']) {
        expect(panel(model, `topLid${suffix}`).parent).toBe('P3');
        expect(panel(model, `bottomLid${suffix}`).parent).toBe('P1');
      }
      expect(panel(model, 'topTuck').parent).toBe('topLidC');
      expect(panel(model, 'bottomTuck').parent).toBe('bottomLidC');
      expectCoordinatesClose(horizontalCreaseInterval(result, 0, 'L'), [x2!, x3!]);
      expectCoordinatesClose(horizontalCreaseInterval(result, D, 'L'), [x0!, x1!]);
    });

    it(`${label}: lid, tuck, and dust heights stay nominal in both spaces`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const W = params.W as number;
      const D = params.D as number;
      const tuckDepth = params.tuckDepth as number;
      const dustFlapDepth = params.dustFlapDepth as number;
      const topOuterHingeY = outerLidHingeY(result, 'top', D);
      const bottomOuterHingeY = outerLidHingeY(result, 'bottom', D);
      const topTuckHeights = taggedPathHeights(result, 'tuckDepth', 'top', D);
      const bottomTuckHeights = taggedPathHeights(result, 'tuckDepth', 'bottom', D);
      const topDustHeights = taggedPathHeights(result, 'dustFlapDepth', 'top', D);
      const bottomDustHeights = taggedPathHeights(result, 'dustFlapDepth', 'bottom', D);

      expect(topOuterHingeY).toBeCloseTo(-W, 9);
      expect(bottomOuterHingeY).toBeCloseTo(D + W, 9);
      expect(Math.abs(topOuterHingeY)).toBeCloseTo(polygonHeight(panel(model, 'topLidC')), 9);
      expect(bottomOuterHingeY - D).toBeCloseTo(polygonHeight(panel(model, 'bottomLidC')), 9);

      expectCoordinatesClose(topTuckHeights, [tuckDepth]);
      expectCoordinatesClose(bottomTuckHeights, [tuckDepth]);
      expect(topTuckHeights[0]!).toBeCloseTo(polygonHeight(panel(model, 'topTuck')), 9);
      expect(bottomTuckHeights[0]!).toBeCloseTo(polygonHeight(panel(model, 'bottomTuck')), 9);

      expectCoordinatesClose(topDustHeights, [dustFlapDepth, dustFlapDepth]);
      expectCoordinatesClose(bottomDustHeights, [dustFlapDepth, dustFlapDepth]);
      expect(topDustHeights[0]!).toBeCloseTo(polygonHeight(panel(model, 'topDustP2')), 9);
      expect(topDustHeights[1]!).toBeCloseTo(polygonHeight(panel(model, 'topDustP4')), 9);
      expect(bottomDustHeights[0]!).toBeCloseTo(polygonHeight(panel(model, 'bottomDustP2')), 9);
      expect(bottomDustHeights[1]!).toBeCloseTo(polygonHeight(panel(model, 'bottomDustP4')), 9);
    });

    it(`${label}: lid, tuck, and dust hinge x spans match compensated 2D creases`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const D = params.D as number;
      const W = params.W as number;
      const offsets = cumulativeCompensationOffsets(thickness, glueSide);

      const topLidIntervals = lidHingeIntervals(model, 'top');
      const bottomLidIntervals = lidHingeIntervals(model, 'bottom');
      expectCoordinatesClose(
        [topLidIntervals[0]![0], topLidIntervals[2]![1]],
        nominalizeInterval(horizontalCreaseInterval(result, 0, 'L'), offsets, [2, 3]),
      );
      expectCoordinatesClose(
        [bottomLidIntervals[0]![0], bottomLidIntervals[2]![1]],
        nominalizeInterval(horizontalCreaseInterval(result, D, 'L'), offsets, [0, 1]),
      );
      expect(topLidIntervals[0]![1]).toBeCloseTo(topLidIntervals[1]![0], 9);
      expect(topLidIntervals[1]![1]).toBeCloseTo(topLidIntervals[2]![0], 9);
      expect(bottomLidIntervals[0]![1]).toBeCloseTo(bottomLidIntervals[1]![0], 9);
      expect(bottomLidIntervals[1]![1]).toBeCloseTo(bottomLidIntervals[2]![0], 9);
      // 插舌 hinge＝2D tongue 真實區間（M1 B4 接線 2026-07-17）：2D 在 yFold 畫全跨 crease，
      // 但肩部（lid.start..xt1／xt2..lid.end）同座標被插舌 cut 路徑分離，實體摺合連接只有
      // tongue 區間 [xt1, xt2]——直接從 cut path 抽取（不用 builder 同式推導·F7）。
      const nominalTopTongue = nominalizeInterval(tongueCutInterval(result, -W), offsets, [2, 3]);
      const nominalBottomTongue = nominalizeInterval(tongueCutInterval(result, D + W), offsets, [0, 1]);
      const topCenter = hingeXInterval(panel(model, 'topLidC'));
      const bottomCenter = hingeXInterval(panel(model, 'bottomLidC'));
      expectCoordinatesClose(hingeXInterval(panel(model, 'topTuck')), [
        Math.max(nominalTopTongue[0], topCenter[0]),
        Math.min(nominalTopTongue[1], topCenter[1]),
      ]);
      expectCoordinatesClose(hingeXInterval(panel(model, 'bottomTuck')), [
        Math.max(nominalBottomTongue[0], bottomCenter[0]),
        Math.min(nominalBottomTongue[1], bottomCenter[1]),
      ]);

      const dustPanelIds = ['topDustP2', 'topDustP4', 'bottomDustP2', 'bottomDustP4'];
      const foldDustIntervals = dustPanelIds.map((id) => hingeXInterval(panel(model, id)));
      const topDustIntervals = horizontalCreaseIntervals(result, 0, 'dustFlapDepth');
      const bottomDustIntervals = horizontalCreaseIntervals(result, D, 'dustFlapDepth');
      expect(topDustIntervals).toHaveLength(2);
      expect(bottomDustIntervals).toHaveLength(2);

      const nominalDustIntervals = [...topDustIntervals, ...bottomDustIntervals]
        .map((interval, index) => nominalizeInterval(
          interval,
          offsets,
          index % 2 === 0 ? [1, 2] : [3, 4],
        ));
      for (const [index, interval] of foldDustIntervals.entries()) {
        expectCoordinatesClose(interval, nominalDustIntervals[index]!);
      }
    });

    it(`${label}: lid wing vertices equal the compensated 2D frictionLock trapezoids in nominal space`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const D = params.D as number;
      const offsets = cumulativeCompensationOffsets(thickness, glueSide);
      const topLock = nominalizeLockVertices(
        frictionLockCutVertices(result, 'top', D),
        offsets,
        [2, 3],
      );
      const bottomLock = nominalizeLockVertices(
        frictionLockCutVertices(result, 'bottom', D),
        offsets,
        [0, 1],
      );

      expectPanelContainsPoints(panel(model, 'topLidL'), topLock.slice(0, 2));
      expectPanelContainsPoints(panel(model, 'topLidR'), topLock.slice(2));
      expectPanelContainsPoints(panel(model, 'bottomLidL'), bottomLock.slice(0, 2));
      expectPanelContainsPoints(panel(model, 'bottomLidR'), bottomLock.slice(2));
    });

    it(`${label}: glue width, height, and hinge span match compensated 2D and nominal fold geometry`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const D = params.D as number;
      const glueSize = params.glueSize as number;
      const boundaries = bodyBoundaryXs(result, D);
      const glueCreaseX = glueSide === 'left' ? boundaries[0]! : boundaries[4]!;
      const gluePaths = taggedPaths(result, 'cut', 'glueSize');
      const [outerGlueEdge] = lineSegments(gluePaths)
        .filter(({ x1, x2 }) => isClose(x1, x2))
        .map(({ x1 }) => x1);
      const [glueBounds] = gluePaths.map(({ segments }) => segmentsBounds(segments));
      const foldGlue = panel(model, 'glue');

      expect(outerGlueEdge).toBeDefined();
      expect(glueBounds).toBeDefined();
      expect(Math.abs(outerGlueEdge! - glueCreaseX)).toBeCloseTo(glueSize, 9);
      expect(polygonWidth(foldGlue)).toBeCloseTo(glueSize, 9);
      expect(glueBounds!.maxY - glueBounds!.minY).toBeCloseTo(D, 9);
      expect(polygonHeight(foldGlue)).toBeCloseTo(D, 9);
      expectCoordinatesClose(
        [Math.min(foldGlue.hingeLine!.a.y, foldGlue.hingeLine!.b.y), Math.max(foldGlue.hingeLine!.a.y, foldGlue.hingeLine!.b.y)],
        [0, D],
      );
    });
  }
});
