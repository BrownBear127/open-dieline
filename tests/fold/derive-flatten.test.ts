// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import type { Segment } from '@/core/geometry';
import { FlattenError, flattenSegment } from '@/fold/derive/flatten';
import type { Pt } from '@/fold/types';
import { sampleBezierArcLength } from '../helpers/geometry-oracle';

type BezierSegment = Extract<Segment, { kind: 'bezier' }>;

const TWO_PI = 2 * Math.PI;
const INTERIOR_SAMPLE_PARAMETERS = [0.25, 0.5, 0.75] as const;

function distanceToSegment(point: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distanceToPolyline(point: Pt, polyline: Pt[]): number {
  let nearest = Infinity;
  for (let index = 1; index < polyline.length; index++) {
    nearest = Math.min(nearest, distanceToSegment(point, polyline[index - 1]!, polyline[index]!));
  }
  return nearest;
}

function maxCurveToPolylineDistance(curve: BezierSegment, polyline: Pt[]): number {
  return Math.max(...sampleBezierArcLength(curve, 512).map((point) => distanceToPolyline(point, polyline)));
}

function maxPolylineToCurveDistance(polyline: Pt[], curve: BezierSegment): number {
  const curveOracle = sampleBezierArcLength(curve, 8192);
  let maximum = 0;

  for (let index = 1; index < polyline.length; index++) {
    const a = polyline[index - 1]!;
    const b = polyline[index]!;
    for (const t of INTERIOR_SAMPLE_PARAMETERS) {
      const interior = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      let nearest = Infinity;
      for (const point of curveOracle) nearest = Math.min(nearest, Math.hypot(interior.x - point.x, interior.y - point.y));
      maximum = Math.max(maximum, nearest);
    }
  }

  return maximum;
}

function expectFlattenError(run: () => unknown, message?: RegExp): void {
  try {
    run();
    throw new Error('預期 flattenSegment 拋出 FlattenError');
  } catch (error) {
    expect(error).toBeInstanceOf(FlattenError);
    expect((error as Error).name).toBe('FlattenError');
    if (message) expect((error as Error).message).toMatch(message);
  }
}

describe('flattenSegment', () => {
  it('line：原樣回傳首尾點', () => {
    expect(flattenSegment({ kind: 'line', x1: -2, y1: 3, x2: 8, y2: -5 }, 0.1)).toEqual([
      { x: -2, y: 3 },
      { x: 8, y: -5 },
    ]);
  });

  it.each([
    {
      label: '遞增方向跨過 0°',
      arc: { kind: 'arc', cx: 2, cy: -3, r: 10, startAngle: (7 * Math.PI) / 4, endAngle: Math.PI / 4, ccw: false } as const,
      sweep: Math.PI / 2,
    },
    {
      label: '遞減方向跨過 0°',
      arc: { kind: 'arc', cx: 2, cy: -3, r: 10, startAngle: Math.PI / 4, endAngle: (7 * Math.PI) / 4, ccw: true } as const,
      sweep: -Math.PI / 2,
    },
    {
      label: '完整圓',
      arc: { kind: 'arc', cx: 2, cy: -3, r: 10, startAngle: 0, endAngle: TWO_PI, ccw: false } as const,
      sweep: TWO_PI,
    },
  ])('arc：$label 的段數符合閉式公式，且首尾與行進方向正確', ({ arc, sweep }) => {
    const tolerance = 0.1;
    const expectedSegments = Math.ceil(Math.abs(sweep) / (2 * Math.acos(1 - tolerance / arc.r)));
    const points = flattenSegment(arc, tolerance);

    expect(points).toHaveLength(expectedSegments + 1);
    expect(points[0]!.x).toBeCloseTo(arc.cx + arc.r * Math.cos(arc.startAngle), 12);
    expect(points[0]!.y).toBeCloseTo(arc.cy + arc.r * Math.sin(arc.startAngle), 12);
    expect(points.at(-1)!.x).toBeCloseTo(arc.cx + arc.r * Math.cos(arc.endAngle), 12);
    expect(points.at(-1)!.y).toBeCloseTo(arc.cy + arc.r * Math.sin(arc.endAngle), 12);

    const firstStepAngle = Math.atan2(points[1]!.y - arc.cy, points[1]!.x - arc.cx);
    const expectedFirstStep = arc.startAngle + sweep / expectedSegments;
    expect(Math.atan2(Math.sin(firstStepAngle - expectedFirstStep), Math.cos(firstStepAngle - expectedFirstStep))).toBeCloseTo(0, 12);
  });

  it('bezier：一般曲線的雙向 Hausdorff 樣本距離都不超過 tolMm', () => {
    const curve: BezierSegment = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 12,
      c1y: 28,
      c2x: 34,
      c2y: -16,
      x2: 50,
      y2: 4,
    };
    const tolerance = 0.05;
    const polyline = flattenSegment(curve, tolerance);

    expect(maxCurveToPolylineDistance(curve, polyline)).toBeLessThanOrEqual(tolerance);
    expect(maxPolylineToCurveDistance(polyline, curve)).toBeLessThanOrEqual(tolerance);
  });

  it('bezier：tol=0.1mm 時 S 曲線的單弦最大偏差 >1mm，而新折線通過雙向距離界', () => {
    const curve: BezierSegment = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 0,
      c1y: 100,
      c2x: 0.05,
      c2y: -100,
      x2: 0.05,
      y2: 0,
    };
    const tolerance = 0.1;
    const chord = [
      { x: curve.x1, y: curve.y1 },
      { x: curve.x2, y: curve.y2 },
    ];
    const chordDeviation = maxCurveToPolylineDistance(curve, chord);
    expect(chordDeviation).toBeGreaterThan(tolerance);

    const polyline = flattenSegment(curve, tolerance);
    const curveToPolyline = maxCurveToPolylineDistance(curve, polyline);
    const polylineToCurve = maxPolylineToCurveDistance(polyline, curve);
    console.info(
      `[derive-flatten] S 曲線：單弦最大偏差=${chordDeviation.toFixed(3)}mm > tol=${tolerance}mm；` +
        `新折線雙向最大偏差=${Math.max(curveToPolyline, polylineToCurve).toFixed(3)}mm`,
    );

    expect(polyline.length).toBeGreaterThan(2);
    expect(curveToPolyline).toBeLessThanOrEqual(tolerance);
    expect(polylineToCurve).toBeLessThanOrEqual(tolerance);
  });

  it.each([0, -0.1, NaN, Infinity])('tolMm=%s：明確拋出具名 FlattenError', (tolerance) => {
    expectFlattenError(() => flattenSegment({ kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }, tolerance), /tolMm/);
  });

  it.each([
    ['line', { kind: 'line', x1: NaN, y1: 0, x2: 1, y2: 1 }],
    ['arc', { kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: Infinity, ccw: false }],
    ['bezier', { kind: 'bezier', x1: 0, y1: 0, c1x: 1, c1y: NaN, c2x: 2, c2y: 2, x2: 3, y2: 0 }],
  ] satisfies Array<[string, Segment]>)('%s 含非有限座標：明確拋出具名 FlattenError', (_label, segment) => {
    expectFlattenError(() => flattenSegment(segment, 0.1), /有限/);
  });

  it.each([0, -1])('arc r=%s：明確拋出具名 FlattenError', (radius) => {
    expectFlattenError(
      () => flattenSegment({ kind: 'arc', cx: 0, cy: 0, r: radius, startAngle: 0, endAngle: Math.PI, ccw: false }, 0.1),
      /半徑/,
    );
  });

  it('arc tolMm >= 2r：明確拋出具名 FlattenError', () => {
    expectFlattenError(
      () => flattenSegment({ kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: Math.PI, ccw: false }, 10),
      /2r/,
    );
  });

  it('bezier 深度耗盡：明確拋出具名 FlattenError，不靜默接受粗折線', () => {
    const curve: BezierSegment = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 0,
      c1y: 1,
      c2x: 1,
      c2y: -1,
      x2: 1,
      y2: 0,
    };
    expectFlattenError(() => flattenSegment(curve, Number.MIN_VALUE), /深度上限/);
  });
});
