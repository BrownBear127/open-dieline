import type { Segment } from '../../core/geometry';
import type { Pt } from '../types';

type ArcSegment = Extract<Segment, { kind: 'arc' }>;
type BezierSegment = Extract<Segment, { kind: 'bezier' }>;

const TWO_PI = 2 * Math.PI;
const MAX_BEZIER_DEPTH = 24;

export class FlattenError extends Error {
  override readonly name = 'FlattenError';
}

function assertFinite(values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new FlattenError('segment 的所有座標與數值都必須是有限數');
  }
}

function pointToSegmentDistance(point: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);

  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** 控制多邊形位於此距離的弦段鄰域內時，Bezier 凸包也位於同一鄰域內。 */
function bezierFlatness(curve: BezierSegment): number {
  const start = { x: curve.x1, y: curve.y1 };
  const end = { x: curve.x2, y: curve.y2 };
  return Math.max(
    pointToSegmentDistance({ x: curve.c1x, y: curve.c1y }, start, end),
    pointToSegmentDistance({ x: curve.c2x, y: curve.c2y }, start, end),
  );
}

function midpoint(a: Pt, b: Pt): Pt {
  return { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 };
}

function splitBezier(curve: BezierSegment): [BezierSegment, BezierSegment] {
  const p0 = { x: curve.x1, y: curve.y1 };
  const p1 = { x: curve.c1x, y: curve.c1y };
  const p2 = { x: curve.c2x, y: curve.c2y };
  const p3 = { x: curve.x2, y: curve.y2 };
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);

  return [
    {
      kind: 'bezier',
      x1: p0.x,
      y1: p0.y,
      c1x: p01.x,
      c1y: p01.y,
      c2x: p012.x,
      c2y: p012.y,
      x2: p0123.x,
      y2: p0123.y,
    },
    {
      kind: 'bezier',
      x1: p0123.x,
      y1: p0123.y,
      c1x: p123.x,
      c1y: p123.y,
      c2x: p23.x,
      c2y: p23.y,
      x2: p3.x,
      y2: p3.y,
    },
  ];
}

function appendBezier(curve: BezierSegment, tolerance: number, depth: number, points: Pt[]): void {
  const flatness = bezierFlatness(curve);
  if (!Number.isFinite(flatness)) {
    throw new FlattenError('bezier 計算產生非有限偏差，無法保證 tolMm');
  }
  if (flatness <= tolerance) {
    points.push({ x: curve.x2, y: curve.y2 });
    return;
  }
  if (depth >= MAX_BEZIER_DEPTH) {
    throw new FlattenError(`bezier 深度上限 ${MAX_BEZIER_DEPTH} 已耗盡，仍無法滿足 tolMm=${tolerance}`);
  }

  const [left, right] = splitBezier(curve);
  appendBezier(left, tolerance, depth + 1, points);
  appendBezier(right, tolerance, depth + 1, points);
}

function flattenBezier(curve: BezierSegment, tolerance: number): Pt[] {
  const points = [{ x: curve.x1, y: curve.y1 }];
  appendBezier(curve, tolerance, 0, points);
  return points;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function directedArcSweep(arc: ArcSegment): number {
  const rawMagnitude = arc.ccw ? arc.startAngle - arc.endAngle : arc.endAngle - arc.startAngle;
  let magnitude = positiveModulo(rawMagnitude, TWO_PI);
  if (magnitude < 1e-9 && Math.abs(rawMagnitude) > 1e-9) magnitude = TWO_PI;
  return arc.ccw ? -magnitude : magnitude;
}

function flattenArc(arc: ArcSegment, tolerance: number): Pt[] {
  if (arc.r <= 0) throw new FlattenError(`arc 半徑必須大於 0（收到 r=${arc.r}）`);
  if (tolerance >= 2 * arc.r) {
    throw new FlattenError(`arc tolMm 必須小於 2r（收到 tolMm=${tolerance}, r=${arc.r}）`);
  }

  const sweep = directedArcSweep(arc);
  const maximumStep = 2 * Math.acos(1 - tolerance / arc.r);
  const segmentCount = Math.ceil(Math.abs(sweep) / maximumStep);
  if (!Number.isSafeInteger(segmentCount)) {
    throw new FlattenError('arc 段數超出可安全表示範圍，無法保證 tolMm');
  }
  if (segmentCount === 0) {
    return [{ x: arc.cx + arc.r * Math.cos(arc.startAngle), y: arc.cy + arc.r * Math.sin(arc.startAngle) }];
  }

  const points: Pt[] = [];
  for (let index = 0; index <= segmentCount; index++) {
    const angle = arc.startAngle + (sweep * index) / segmentCount;
    points.push({ x: arc.cx + arc.r * Math.cos(angle), y: arc.cy + arc.r * Math.sin(angle) });
  }
  return points;
}

export function flattenSegment(segment: Segment, tolMm: number): Pt[] {
  if (!Number.isFinite(tolMm) || tolMm <= 0) {
    throw new FlattenError(`tolMm 必須是大於 0 的有限數（收到 ${tolMm}）`);
  }

  if (segment.kind === 'line') {
    assertFinite([segment.x1, segment.y1, segment.x2, segment.y2]);
    return [
      { x: segment.x1, y: segment.y1 },
      { x: segment.x2, y: segment.y2 },
    ];
  }

  if (segment.kind === 'arc') {
    assertFinite([segment.cx, segment.cy, segment.r, segment.startAngle, segment.endAngle]);
    return flattenArc(segment, tolMm);
  }

  assertFinite([
    segment.x1,
    segment.y1,
    segment.c1x,
    segment.c1y,
    segment.c2x,
    segment.c2y,
    segment.x2,
    segment.y2,
  ]);
  return flattenBezier(segment, tolMm);
}
