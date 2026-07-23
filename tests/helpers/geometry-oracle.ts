/**
 * geometry-oracle.ts — 幾何測試 oracle（3D fold 預覽測試共用基座）。
 *
 * 核心動機：production `flattenBezier`（`src/core/geometry.ts`）只採樣曲線中點 `B(0.5)`
 * 判斷是否夠平——對「控制點關於弦中點反對稱」的對稱 S 形曲線有盲區（中點恰好落回弦上，
 * 見下方 `controlPolygonHeight` docblock）。本檔採用「控制多邊形到有限弦段的距離」判準
 * （凸集合論證，同一 docblock），不受這個盲區影響；而且深度上限命中時**明確拋錯**，
 * 不像 production 私有的深度上限讓超界的葉節點被靜默接受。
 */

import type { Segment } from '@/core/geometry';
import type { Pt } from '@/fold/types';

export type BezierCurve = Extract<Segment, { kind: 'bezier' }>;

interface FlatLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 控制點到「有限弦段」（不是無限延伸直線）的距離。 */
function distToChordSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (len * len)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 「控制多邊形到有限弦段」高度判準：曲線上任一點是 P0..P3 的 Bernstein 凸組合，P0/P3 本身
 * 在弦段上（到弦段距離＝0），到凸集合的距離本身是凸函式，故曲線上任一點到弦段的距離
 * ≤ max(d(P1),d(P2))——直接檢查兩個控制點本身到有限弦段的真實偏離，不會被「曲線中點恰好
 * 歸零」的對稱反例騙過（見 `tests/imposition-anchor.test.ts` 該反例的完整推導）。
 */
function controlPolygonHeight(b: BezierCurve): number {
  const d1 = distToChordSegment(b.c1x, b.c1y, b.x1, b.y1, b.x2, b.y2);
  const d2 = distToChordSegment(b.c2x, b.c2y, b.x1, b.y1, b.x2, b.y2);
  return Math.max(d1, d2);
}

/** de Casteljau 對半分割（純代數，標準教科書算法）。 */
function splitCubicAtMid(b: BezierCurve): { left: BezierCurve; right: BezierCurve } {
  const p0: Pt = { x: b.x1, y: b.y1 };
  const p1: Pt = { x: b.c1x, y: b.c1y };
  const p2: Pt = { x: b.c2x, y: b.c2y };
  const p3: Pt = { x: b.x2, y: b.y2 };
  const mid = (a: Pt, c: Pt): Pt => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123); // = 曲線在 t=0.5 的點
  return {
    left: { kind: 'bezier', x1: p0.x, y1: p0.y, c1x: p01.x, c1y: p01.y, c2x: p012.x, c2y: p012.y, x2: p0123.x, y2: p0123.y },
    right: { kind: 'bezier', x1: p0123.x, y1: p0123.y, c1x: p123.x, c1y: p123.y, c2x: p23.x, c2y: p23.y, x2: p3.x, y2: p3.y },
  };
}

/** 純防護值——正常曲線與 `sampleBezierArcLength` 用到的容差遠低於此深度就會終止。 */
const MAX_ADAPTIVE_FLATTEN_DEPTH = 24;

/**
 * 獨立自適應細分（供 `sampleBezierArcLength` 內部使用，亦單獨匯出方便直接測試深度上限
 * 行為）。深度上限命中時**直接拋錯**，拒絕靜默接受一個可能違反誤差界的葉節點——這裡在意
 * 的是「宣稱的誤差界是否真的成立」，跟 production `flattenBezier` 讓超界葉節點被靜默接受
 * 的取捨不同（那邊優先求不崩潰，這裡優先求不騙人）。
 */
export function flattenBezierAdaptive(
  b: BezierCurve,
  chordTol = 1e-4,
  maxSegLen = 0.1,
  depth = 0,
  maxDepth = MAX_ADAPTIVE_FLATTEN_DEPTH,
): FlatLine[] {
  const segLen = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  const height = controlPolygonHeight(b);
  if (height > chordTol || segLen > maxSegLen) {
    if (depth >= maxDepth) {
      throw new Error(
        `flattenBezierAdaptive：深度上限（${maxDepth}）命中但容差未滿足（controlPolygonHeight=${height}, segLen=${segLen}, chordTol=${chordTol}, maxSegLen=${maxSegLen}）——拒絕靜默接受一個可能違反誤差界的葉節點`,
      );
    }
    const { left, right } = splitCubicAtMid(b);
    return [
      ...flattenBezierAdaptive(left, chordTol, maxSegLen, depth + 1, maxDepth),
      ...flattenBezierAdaptive(right, chordTol, maxSegLen, depth + 1, maxDepth),
    ];
  }
  return [{ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }];
}

function polylineFromLines(lines: FlatLine[]): Pt[] {
  const first = lines[0]!;
  const points: Pt[] = [{ x: first.x1, y: first.y1 }];
  for (const line of lines) points.push({ x: line.x2, y: line.y2 });
  return points;
}

function cumulativeLengths(points: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(cur.x - prev.x, cur.y - prev.y));
  }
  return cum;
}

/** 沿累積弦長參數化，把 polyline 均勻重取樣成 `count` 個等弧長點（含頭尾）。 */
function resampleEqualArcLength(points: Pt[], count: number): Pt[] {
  if (count < 2) throw new Error(`resampleEqualArcLength：count 必須 ≥2（收到 ${count}）`);
  const cum = cumulativeLengths(points);
  const total = cum[cum.length - 1]!;
  const result: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const target = total <= 0 ? 0 : (i / (count - 1)) * total;
    // 下界二分：找第一個 cum[idx] >= target 的 idx。
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const j = Math.max(1, lo);
    const segStart = cum[j - 1]!;
    const segEnd = cum[j]!;
    const segFrac = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const p0 = points[j - 1]!;
    const p1 = points[j]!;
    result.push({ x: p0.x + segFrac * (p1.x - p0.x), y: p0.y + segFrac * (p1.y - p0.y) });
  }
  return result;
}

/** 累積弦長表的最低段數（曲線 oracle 容差定案值）。 */
const MIN_ARC_LENGTH_SEGMENTS = 256;

/**
 * 把折線補點到至少 `minSegments` 段——若折線本身已經 ≥ `minSegments` 段，原樣返回，不丟棄
 * `accuratePolyline` 已經捕捉到的任何局部細節；只有段數不足時才補點（沿現有累積弧長等分插值）。
 * 這裡刻意不做「先降到固定解析度再升回來」這種事：一旦降到某個固定解析度，中間被跳過的頂點
 * 所代表的局部曲率就回不來了。
 */
function densifyToMinSegments(points: Pt[], minSegments: number): Pt[] {
  if (points.length - 1 >= minSegments) return points;
  return resampleEqualArcLength(points, minSegments + 1);
}

/**
 * 等弧長取樣：用獨立自適應細分（`flattenBezierAdaptive`，深度上限命中拋錯）取得精確折線，
 * 只在折線段數不足 256 時才補點到 256 段（曲線 oracle 容差定案值），再直接從這條
 * （補點後的）精確折線本身的累積弦長反算出 `n` 個等弧長點，不經過一個「先固定壓縮成
 * 257 點再展開」的獨立粗 LUT：若折線遠比 256 段密（例如深度自適應細分因局部尖銳曲率而
 * 產生遠超 256 個頂點），先壓縮到 257 點會把兩個相鄰 LUT 節點之間的真實曲率丟掉，之後
 * 展開的最終取樣點會落在一條掩蓋了局部特徵的直線上，而不是真實曲線上
 * （`tests/helpers/geometry-oracle.test.ts` 有相應測試涵蓋這個情況）。
 */
export function sampleBezierArcLength(curve: BezierCurve, n = 32): Pt[] {
  const lines = flattenBezierAdaptive(curve);
  const accuratePolyline = polylineFromLines(lines);
  const densified = densifyToMinSegments(accuratePolyline, MIN_ARC_LENGTH_SEGMENTS);
  return resampleEqualArcLength(densified, n);
}
