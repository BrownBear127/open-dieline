/**
 * 幾何核心：結構化 Segment 型別與運算。
 *
 * 這是後續盒型生成、SVG/DXF 匯出、golden 測試比對共同的資料基石——
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

export type Segment =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; startAngle: number; endAngle: number; ccw: boolean }
  | {
      kind: 'bezier';
      x1: number;
      y1: number;
      c1x: number;
      c1y: number;
      c2x: number;
      c2y: number;
      x2: number;
      y2: number;
    };

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type LineSegment = Extract<Segment, { kind: 'line' }>;
type ArcSegment = Extract<Segment, { kind: 'arc' }>;
type BezierSegment = Extract<Segment, { kind: 'bezier' }>;

const TWO_PI = 2 * Math.PI;

/** 角度正規化到 [0, 2π) */
function normalizeAngle(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * 判斷角度 theta 是否落在 arc 的 [start, end] 弧範圍內（內部函式）。
 *
 * ccw=false：角度沿「遞增」方向從 start 掃到 end（不足則跨圈補 2π）。
 * ccw=true：角度沿「遞減」方向從 start 掃到 end（不足則跨圈減 2π）。
 * start/end 差恰為 2π 的整數倍（且非 0）視為完整圓，任何角度都算在弧範圍內。
 */
function angleInArc(theta: number, start: number, end: number, ccw: boolean): boolean {
  const EPS = 1e-9;

  const rawSweep = ccw ? start - end : end - start;
  let sweep = normalizeAngle(rawSweep);
  if (sweep < EPS && Math.abs(rawSweep) > EPS) {
    sweep = TWO_PI; // start/end 差為 2π 整數倍 → 完整圓
  }

  const rawOffset = ccw ? start - theta : theta - start;
  const offset = normalizeAngle(rawOffset);

  return offset <= sweep + EPS;
}

/** 單一 Segment 的 bounds；arc 需考慮跨象限的 0/90/180/270° 極值點 */
export function segmentBounds(s: Segment): Bounds {
  if (s.kind === 'line') {
    return {
      minX: Math.min(s.x1, s.x2),
      maxX: Math.max(s.x1, s.x2),
      minY: Math.min(s.y1, s.y2),
      maxY: Math.max(s.y1, s.y2),
    };
  }

  if (s.kind === 'arc') {
    return arcBounds(s);
  }

  // bezier：用控制多邊形（含端點與控制點）的包絡——凸包性質保證涵蓋真實曲線
  return {
    minX: Math.min(s.x1, s.c1x, s.c2x, s.x2),
    maxX: Math.max(s.x1, s.c1x, s.c2x, s.x2),
    minY: Math.min(s.y1, s.c1y, s.c2y, s.y2),
    maxY: Math.max(s.y1, s.c1y, s.c2y, s.y2),
  };
}

function arcBounds(s: ArcSegment): Bounds {
  const points: Array<{ x: number; y: number }> = [
    { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) },
    { x: s.cx + s.r * Math.cos(s.endAngle), y: s.cy + s.r * Math.sin(s.endAngle) },
  ];

  const extremaAngles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  for (const theta of extremaAngles) {
    if (angleInArc(theta, s.startAngle, s.endAngle, s.ccw)) {
      points.push({ x: s.cx + s.r * Math.cos(theta), y: s.cy + s.r * Math.sin(theta) });
    }
  }

  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/** 多個 Segment 的聯集 bounds；空陣列回傳 {0,0,0,0} */
export function segmentsBounds(list: Segment[]): Bounds {
  if (list.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  const boundsList = list.map(segmentBounds);
  return {
    minX: Math.min(...boundsList.map((b) => b.minX)),
    maxX: Math.max(...boundsList.map((b) => b.maxX)),
    minY: Math.min(...boundsList.map((b) => b.minY)),
    maxY: Math.max(...boundsList.map((b) => b.maxY)),
  };
}

/** de Casteljau 對半分割：回傳左右兩段子 bezier，以及中點（t=0.5 之曲線點） */
function splitBezierAtMid(b: BezierSegment): { left: BezierSegment; right: BezierSegment; mid: { x: number; y: number } } {
  const p0 = { x: b.x1, y: b.y1 };
  const p1 = { x: b.c1x, y: b.c1y };
  const p2 = { x: b.c2x, y: b.c2y };
  const p3 = { x: b.x2, y: b.y2 };
  const midOf = (a: { x: number; y: number }, c: { x: number; y: number }) => ({
    x: (a.x + c.x) / 2,
    y: (a.y + c.y) / 2,
  });

  const p01 = midOf(p0, p1);
  const p12 = midOf(p1, p2);
  const p23 = midOf(p2, p3);
  const p012 = midOf(p01, p12);
  const p123 = midOf(p12, p23);
  const p0123 = midOf(p012, p123); // = 曲線在 t=0.5 的點

  return {
    left: { kind: 'bezier', x1: p0.x, y1: p0.y, c1x: p01.x, c1y: p01.y, c2x: p012.x, c2y: p012.y, x2: p0123.x, y2: p0123.y },
    right: { kind: 'bezier', x1: p0123.x, y1: p0123.y, c1x: p123.x, c1y: p123.y, c2x: p23.x, c2y: p23.y, x2: p3.x, y2: p3.y },
    mid: p0123,
  };
}

/** 中點到「起訖點連線」的垂直距離（弦高） */
function chordHeight(b: BezierSegment, mid: { x: number; y: number }): number {
  const dx = b.x2 - b.x1;
  const dy = b.y2 - b.y1;
  const chordLen = Math.hypot(dx, dy);
  if (chordLen < 1e-9) {
    return Math.hypot(mid.x - b.x1, mid.y - b.y1);
  }
  const cross = dx * (mid.y - b.y1) - dy * (mid.x - b.x1);
  return Math.abs(cross) / chordLen;
}

// 遞迴深度上限：純防護性設計，避免病態參數（如 chordTol=0）導致失控遞迴；
// 正常曲線與預設容差在遠低於此深度就會終止，不影響任何合理輸入的行為。
const MAX_FLATTEN_DEPTH = 24;

function flattenRecursive(b: BezierSegment, chordTol: number, maxSegLen: number, depth: number): LineSegment[] {
  const segLen = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  const { left, right, mid } = splitBezierAtMid(b);
  const height = chordHeight(b, mid);

  if ((height > chordTol || segLen > maxSegLen) && depth < MAX_FLATTEN_DEPTH) {
    return [...flattenRecursive(left, chordTol, maxSegLen, depth + 1), ...flattenRecursive(right, chordTol, maxSegLen, depth + 1)];
  }

  return [{ kind: 'line', x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }];
}

/** de Casteljau 遞迴細分：中點弦高 > chordTol 或段長 > maxSegLen 就對半分（spec §6.2） */
export function flattenBezier(b: BezierSegment, chordTol = 0.1, maxSegLen = 5): LineSegment[] {
  return flattenRecursive(b, chordTol, maxSegLen, 0);
}

/** precision（預設 0.01）轉換為小數位數，例如 0.01 → 2 位（toFixed(2) 語意） */
function decimalsFromPrecision(precision: number): number {
  return Math.max(0, Math.round(-Math.log10(precision)));
}

function quantize(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function normalizeOneSegment(s: Segment, decimals: number): string {
  const q = (v: number) => quantize(v, decimals);

  if (s.kind === 'line') {
    // 端點按 (x,y) 字典序排序成 canonical 方向，讓正反方向的同一條線段化為相同字串
    const firstIsA = s.x1 < s.x2 || (s.x1 === s.x2 && s.y1 <= s.y2);
    const ax = firstIsA ? s.x1 : s.x2;
    const ay = firstIsA ? s.y1 : s.y2;
    const bx = firstIsA ? s.x2 : s.x1;
    const by = firstIsA ? s.y2 : s.y1;
    return `line|${q(ax)}|${q(ay)}|${q(bx)}|${q(by)}`;
  }

  if (s.kind === 'arc') {
    return `arc|${q(s.cx)}|${q(s.cy)}|${q(s.r)}|${q(normalizeAngle(s.startAngle))}|${q(normalizeAngle(s.endAngle))}|${s.ccw}`;
  }

  return `bezier|${q(s.x1)}|${q(s.y1)}|${q(s.c1x)}|${q(s.c1y)}|${q(s.c2x)}|${q(s.c2y)}|${q(s.x2)}|${q(s.y2)}`;
}

/**
 * 每段量化到指定精度＋端點/角度正規排序，序列化成字串後整體 sort。
 * 用於 golden 快照與等價比對——同幾何不同順序/方向會產生相同輸出（spec §8）。
 */
export function normalizeSegments(list: Segment[], precision = 0.01): string[] {
  const decimals = decimalsFromPrecision(precision);
  return list.map((s) => normalizeOneSegment(s, decimals)).sort();
}

/** 偵測列表中任一 Segment 的任一數值欄位是否為 NaN */
export function hasNaN(list: Segment[]): boolean {
  for (const s of list) {
    const values =
      s.kind === 'line'
        ? [s.x1, s.y1, s.x2, s.y2]
        : s.kind === 'arc'
          ? [s.cx, s.cy, s.r, s.startAngle, s.endAngle]
          : [s.x1, s.y1, s.c1x, s.c1y, s.c2x, s.c2y, s.x2, s.y2];
    if (values.some((v) => Number.isNaN(v))) {
      return true;
    }
  }
  return false;
}
