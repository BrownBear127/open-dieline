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

function bodyCreaseXs(result: GenerateResult, D: number): number[] {
  return lineSegments(result.paths.filter(({ type }) => type === 'crease'))
    .filter(({ x1, x2 }) => isClose(x1, x2))
    .filter(({ y1, y2 }) => isClose(Math.min(y1, y2), 0) && isClose(Math.max(y1, y2), D))
    .map(({ x1 }) => x1)
    .sort((left, right) => left - right);
}

function horizontalCreaseInterval(result: GenerateResult, y: number, tag: string): [number, number] {
  const candidates = lineSegments(taggedPaths(result, 'crease', tag))
    .filter(({ y1, y2 }) => isClose(y1, y) && isClose(y2, y));

  expect(candidates.length, `missing horizontal ${tag} crease at y=${y}`).toBeGreaterThan(0);
  const xs = candidates.flatMap(({ x1, x2 }) => [x1, x2]);
  return [Math.min(...xs), Math.max(...xs)];
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

function compensatedBoundaries(L: number, W: number, thickness: number, glueSide: 'left' | 'right'): number[] {
  const nominal = [0, L, L + W, 2 * L + W, 2 * L + 2 * W];
  const compensation = glueSide === 'right' ? [...GIRTH].reverse() : [...GIRTH];

  return nominal.map((x, index) => {
    const precedingCompensation = compensation
      .slice(0, index)
      .reduce<number>((sum, coefficient) => sum + coefficient, 0);
    return x + precedingCompensation * thickness;
  });
}

function expectCoordinatesClose(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(value).toBeCloseTo(expected[index]!, 9);
  }
}

function panel(model: FoldModel, id: string): FoldPanel {
  const target = model.panels.find((candidate) => candidate.id === id);
  expect(target, `missing fold panel ${id}`).toBeDefined();
  return target!;
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

    it(`${label}: body crease x coordinates equal nominal boundaries plus cumulative girth compensation`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const L = params.L as number;
      const W = params.W as number;
      const D = params.D as number;
      const boundaries = compensatedBoundaries(L, W, thickness, glueSide);
      const expected = [boundaries[1]!, boundaries[2]!, boundaries[3]!, boundaries[glueSide === 'left' ? 0 : 4]!]
        .sort((left, right) => left - right);

      expectCoordinatesClose(bodyCreaseXs(result, D), expected);
    });

    it(`${label}: top lid belongs to P3 and bottom lid belongs to P1`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const L = params.L as number;
      const W = params.W as number;
      const D = params.D as number;
      const [x0, x1, x2, x3] = compensatedBoundaries(L, W, thickness, glueSide);
      const topLid = panel(model, 'topLid');
      const bottomLid = panel(model, 'bottomLid');

      expect(topLid.parent).toBe('P3');
      expect(bottomLid.parent).toBe('P1');
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
      expect(Math.abs(topOuterHingeY)).toBeCloseTo(polygonHeight(panel(model, 'topLid')), 9);
      expect(bottomOuterHingeY - D).toBeCloseTo(polygonHeight(panel(model, 'bottomLid')), 9);

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

    it(`${label}: glue width equals glueSize in compensated 2D and nominal fold geometry`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const result = reverseTuckEnd.generate(params);
      const model = buildRteFoldModel(params);
      const L = params.L as number;
      const W = params.W as number;
      const glueSize = params.glueSize as number;
      const boundaries = compensatedBoundaries(L, W, thickness, glueSide);
      const glueCreaseX = glueSide === 'left' ? boundaries[0]! : boundaries[4]!;
      const [outerGlueEdge] = lineSegments(taggedPaths(result, 'cut', 'glueSize'))
        .filter(({ x1, x2 }) => isClose(x1, x2))
        .map(({ x1 }) => x1);

      expect(outerGlueEdge).toBeDefined();
      expect(Math.abs(outerGlueEdge! - glueCreaseX)).toBeCloseTo(glueSize, 9);
      expect(polygonWidth(panel(model, 'glue'))).toBeCloseTo(glueSize, 9);
    });
  }
});
