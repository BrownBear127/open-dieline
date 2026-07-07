/**
 * PathBuilder：手寫盒型生成代碼用的路徑建構器（SVG 手感 moveTo/lineTo/arcTo/bezierTo）。
 *
 * 內部把每個繪圖呼叫積累成結構化 `Segment`（Task 2），供 bounds/normalize/畫布渲染等後續消費。
 * `segmentsToSvgD` 是反向投影：Segment[] → SVG `d` 字串，畫布渲染與 SVG 匯出共用。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Segment } from '@/core/geometry';

type ArcSegment = Extract<Segment, { kind: 'arc' }>;
type Point = { x: number; y: number };

/**
 * SVG arc endpoint 語法（rx=ry=r，largeArc 固定 0）→ center 參數化 Arc。
 *
 * 依 W3C SVG 1.1 Implementation Notes（F.6.5）的 endpoint-to-center 公式，在 rx=ry、
 * phi=0、large-arc-flag=0 的簡化下推導：
 *   - 弦中點 M = (P0+P1)/2；h = sqrt(r² − (chord/2)²)（chord/2 > r 時無解，幾何不可能）。
 *   - sweep=1 時 center = M + h·(−uy, ux)；sweep=0 時 center = M + h·(uy, −ux)
 *     （u = 弦方向單位向量，兩側恰為關於弦鏡像的一對解）。
 * 角度＝`atan2(端點 − 圓心)`；ccw＝`sweep===0`（sweep=1＝SVG positive-angle direction＝
 * 角度遞增＝與 Task 2 的 `ccw=false` 語意一致，見 Segment 型別註解）。
 */
function arcFromEndpoints(from: Point, r: number, sweep: 0 | 1, to: Point): ArcSegment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  const half = chord / 2;
  const discriminant = r * r - half * half;

  if (chord === 0) {
    throw new Error('arcTo: 起訖點重合（弦長為 0），無法定義圓弧（圓心方向不確定）');
  }

  if (discriminant < 0) {
    throw new Error(
      `arcTo: 弦長 ${chord.toFixed(2)}mm 超過半徑 ${r}mm 的直徑 ${(2 * r).toFixed(2)}mm，無法求出圓弧圓心（幾何不可能）`,
    );
  }

  const h = Math.sqrt(discriminant);
  const ux = dx / chord;
  const uy = dy / chord;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const cx = sweep === 1 ? mx - h * uy : mx + h * uy;
  const cy = sweep === 1 ? my + h * ux : my - h * ux;

  return {
    kind: 'arc',
    cx,
    cy,
    r,
    startAngle: Math.atan2(from.y - cy, from.x - cx),
    endAngle: Math.atan2(to.y - cy, to.x - cx),
    ccw: sweep === 0,
  };
}

/** SVG 手感的路徑建構器：累積 moveTo/lineTo/arcTo/bezierTo 呼叫成 Segment[]。 */
export class PathBuilder {
  private readonly segs: Segment[] = [];
  private cursor: Point | null = null;

  /** 設定/搬移目前畫筆位置，不產生 Segment（對應 SVG 的 M，只在 segmentsToSvgD 反向投影時視不連續性重新發出）。 */
  moveTo(x: number, y: number): this {
    this.cursor = { x, y };
    return this;
  }

  /** 從目前位置畫直線到 (x,y)，產生一個 line segment。 */
  lineTo(x: number, y: number): this {
    const from = this.requireCursor();
    this.segs.push({ kind: 'line', x1: from.x, y1: from.y, x2: x, y2: y });
    this.cursor = { x, y };
    return this;
  }

  /** SVG endpoint 語法畫弧（rx=ry=r，largeArc=0）：內部轉為 center 參數化 arc segment。 */
  arcTo(r: number, sweep: 0 | 1, x: number, y: number): this {
    const from = this.requireCursor();
    this.segs.push(arcFromEndpoints(from, r, sweep, { x, y }));
    this.cursor = { x, y };
    return this;
  }

  /** 三次貝茲曲線到 (x,y)，控制點 (c1x,c1y)/(c2x,c2y)。 */
  bezierTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    const from = this.requireCursor();
    this.segs.push({ kind: 'bezier', x1: from.x, y1: from.y, c1x, c1y, c2x, c2y, x2: x, y2: y });
    this.cursor = { x, y };
    return this;
  }

  /** 累積的 Segment 清單（回傳副本，避免外部改動內部狀態）。 */
  segments(): Segment[] {
    return [...this.segs];
  }

  private requireCursor(): Point {
    if (this.cursor === null) {
      throw new Error('PathBuilder: 尚未呼叫 moveTo() 設定路徑起點，無法呼叫 lineTo/arcTo/bezierTo');
    }
    return this.cursor;
  }
}

const decimals = 2;

/** toFixed(2) 對近零負值（如 -1e-9）會印出 "-0.00"；收斂為 "0.00" 避免這個跟正確性無關的雜訊符號外露。 */
const fmt = (v: number): string => {
  const s = v.toFixed(decimals);
  return s === '-0.00' ? '0.00' : s;
};

// 連續性判定容差：遠低於輸出解析度（toFixed(2) → 0.01mm）與刀模物理精度，
// 只用來吸收「arc 端點座標由 cx + r·cos(angle) 三角函數重算」帶來的浮點捨入雜訊
// （重算值與原始輸入位元級相等只是巧合，不能保證，見 segmentStart/segmentEnd）。
const CONTINUITY_EPS = 1e-6;

function segmentStart(s: Segment): Point {
  if (s.kind === 'arc') {
    return { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) };
  }
  return { x: s.x1, y: s.y1 };
}

function segmentEnd(s: Segment): Point {
  if (s.kind === 'arc') {
    return { x: s.cx + s.r * Math.cos(s.endAngle), y: s.cy + s.r * Math.sin(s.endAngle) };
  }
  return { x: s.x2, y: s.y2 };
}

/** 單一 Segment 投影為（不含 M 的）SVG 繪圖指令：line→L、arc→A、bezier→C。 */
function segmentToCommand(s: Segment): string {
  if (s.kind === 'line') {
    return `L${fmt(s.x2)},${fmt(s.y2)}`;
  }

  if (s.kind === 'bezier') {
    return `C${fmt(s.c1x)},${fmt(s.c1y)} ${fmt(s.c2x)},${fmt(s.c2y)} ${fmt(s.x2)},${fmt(s.y2)}`;
  }

  // arc：ccw=sweep===0 的逆映射 → sweep = ccw ? 0 : 1（與 arcFromEndpoints 同一映射的逆向）
  const end = segmentEnd(s);
  const sweep = s.ccw ? 0 : 1;
  return `A${fmt(s.r)},${fmt(s.r)} 0 0,${sweep} ${fmt(end.x)},${fmt(end.y)}`;
}

/**
 * 把 Segment[] 投影成單一 SVG `d` 字串：連續段（前段終點與後段起點在 CONTINUITY_EPS 容差內相等）
 * 合併，不連續處重新發出 `M`。精度固定 toFixed(2)。
 *
 * 用容差而非 `===` 比對：line/bezier 的起訖點是使用者輸入的原始數值，但 arc 的起訖點
 * 是由 cx + r·cos(angle) 三角函數反算回來的，與原始輸入位元級相等只是偶然（實測機率
 * 僅約 36-58%）。嚴格 `===` 會把幾乎所有涉及 arc 的相鄰段誤判為不連續，多發 `M`（下游
 * 切割機會誤以為要抬筆），是正確性問題不是風格問題。
 */
export function segmentsToSvgD(segs: Segment[]): string {
  const parts: string[] = [];
  let prevEnd: Point | null = null;

  for (const s of segs) {
    const start = segmentStart(s);
    const isContinuous =
      prevEnd !== null &&
      Math.abs(start.x - prevEnd.x) < CONTINUITY_EPS &&
      Math.abs(start.y - prevEnd.y) < CONTINUITY_EPS;
    if (!isContinuous) {
      parts.push(`M${fmt(start.x)},${fmt(start.y)}`);
    }
    parts.push(segmentToCommand(s));
    prevEnd = segmentEnd(s);
  }

  return parts.join(' ');
}
