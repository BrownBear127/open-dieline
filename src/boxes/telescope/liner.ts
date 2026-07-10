/**
 * 天地盒內襯——平台式腳架墊片幾何（Slice 2 Task 4；2026-07-09 T7 樣張 gate 反饋重定義）。
 *
 * **重定義背景**：維護者實際操作樣張後裁決，原本的「L 形斷面落地圍框」（帶狀攤平＋翻邊＋
 * 黏合 tab，錨定上蓋內淨）是實際不會用的版本。正確形式（維護者定案）：
 * - 底面錨定＝**下盒內淨**（不是上蓋內淨）——內襯放進下盒貼底，物品放內襯上被墊高
 * - 四翼向下摺＝腳架（平台式）——翼深＝架高量，新參數 `linerFlapDepth`
 * - 四邊同深、單一參數（不分長短壁）
 * - 免膠、無 tab（四角天然讓位，翼互不重疊）
 *
 * 幾何＝「十字／加號攤平」：中央矩形底面（crease 周界）＋四邊各一個梯形翼（cut，45°
 * 內斜兩端），四角因兩相鄰翼的斜切共線而自然清出讓位缺口——不需要額外構造。
 *
 * 舊圍框版（帶狀攤平＋tab＋翻邊）已作廢，相關常數／函式全部移除，不做相容 shim
 * （spec §4.2 已同步改寫，見 docs/specs/2026-07-07-open-dieline-v1-design.md）。
 *
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import { dimensionLine } from '@/core/primitives';
import type { DielinePath, DielineText, LineType } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數
// ─────────────────────────────────────────────────────────────────────────

/** 標註線與量測點的安全外推距離（同 tray.ts/index.ts 同名常數的推導：offset 太小文字會
 *  跑到路徑包絡外，讓 pieces.ts 的 piece-bounds-mismatch 誤判）。 */
const DIM_OFFSET = 8;

// ─────────────────────────────────────────────────────────────────────────
// 導出鏈
// ─────────────────────────────────────────────────────────────────────────

export interface LinerFrameInputs {
  baseLength: number;
  baseWidth: number;
  thickness: number;
  fitGap: number;
}

export interface LinerFrame {
  /** 底面長邊（對應 baseLength 軸）。 */
  padL: number;
  /** 底面短邊（對應 baseWidth 軸）。 */
  padW: number;
}

/**
 * 內襯導出鏈（2026-07-09 T7 gate 重定義；spec 逐字公式）——底面錨定＝下盒內淨，
 * 無獨立尺寸參數：
 *   baseInnerL = baseLength − 4t（下盒內淨：雙壁，外壁 t＋內壁 t 每側）
 *   baseInnerW = baseWidth − 4t
 *   padL = baseInnerL − 2×fitGap（底面，四邊留一次套合間隙）
 *   padW = baseInnerW − 2×fitGap
 * 不再吃 lidMargin——舊版「翻邊寬＝lidMargin−4t−2×fitGap」的上蓋錨定已作廢。
 */
export function deriveLinerFrame(p: LinerFrameInputs): LinerFrame {
  const baseInnerL = p.baseLength - 4 * p.thickness;
  const baseInnerW = p.baseWidth - 4 * p.thickness;
  const padL = baseInnerL - 2 * p.fitGap;
  const padW = baseInnerW - 2 * p.fitGap;
  return { padL, padW };
}

// ─────────────────────────────────────────────────────────────────────────
// 幾何生成
// ─────────────────────────────────────────────────────────────────────────

export interface LinerOpts extends LinerFrameInputs {
  /** 腳架深度（架高量）——四邊共用同一值（維護者定案：單一參數，不分長短壁）。 */
  flapDepth: number;
  idPrefix: string;
  offsetX: number;
  offsetY: number;
}

interface PathDescriptor {
  type: LineType;
  tags: string[];
  segments: Segment[];
}

/** 平移一組 Segment（同 tray.ts 的 translateSegments 慣例；各檔各自持有，避免跨檔耦合）。 */
function translateSegments(segs: Segment[], dx: number, dy: number): Segment[] {
  return segs.map((s) => {
    if (s.kind === 'line') {
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    }
    if (s.kind === 'arc') {
      return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    }
    return {
      ...s,
      x1: s.x1 + dx,
      y1: s.y1 + dy,
      c1x: s.c1x + dx,
      c1y: s.c1y + dy,
      c2x: s.c2x + dx,
      c2y: s.c2y + dy,
      x2: s.x2 + dx,
      y2: s.y2 + dy,
    };
  });
}

type Axis = 'x' | 'y';
type Sign = 1 | -1;
type Point = { x: number; y: number };

/**
 * 局部座標映射（沿用 tray.ts 的 along/perp 慣例）：axis='x' 的邊垂直於 x 軸（左右邊，
 * 沿 y 方向延伸）——along→x（根／翼深方向）、perp→y（沿邊長度方向）。axis='y' 的邊
 * 垂直於 y 軸（上下邊，沿 x 方向延伸）——along→y、perp→x。底面以局部原點為中心。
 */
function toXY(axis: Axis, along: number, perp: number): Point {
  return axis === 'x' ? { x: along, y: perp } : { x: perp, y: along };
}

/**
 * 底面一邊＋其翼的 crease／cut 描述：
 * - crease（底面周界，根部＝該邊全長）：從 (rootAlong, −lenHalf) 到 (rootAlong, +lenHalf)。
 * - cut（翼片輪廓，斜切→外緣→斜切）：根部兩端點沿 45° 內斜 flapDepth，外緣＝該邊全長
 *   −2×flapDepth。四角因相鄰兩翼的斜切共線（同一條 45° 直線通過底面角點）而自然讓位，
 *   不需要另外的讓位構造——這是梯形公式本身的幾何推論，非額外設計。
 *
 * `flapDepth` 不鉗制（不同 tray.ts buildTongueFold 的 recess 防禦性 clamp）：翼深超過
 * 邊長一半時外緣會反轉（自撞），比照 gusset-b-fits／tongue-flap-fits 的既有慣例——
 * 用 `liner-flap-fits` 不變式警告＋範圍化豁免接住，不在幾何層silently 鉗制掉使用者設定值
 * （見 index.ts 的 liner-flap-fits 條件 3）。
 */
function buildPadEdgeAndFlap(axis: Axis, sign: Sign, side: string, rootHalf: number, lenHalf: number, flapDepth: number): PathDescriptor[] {
  const rootAlong = sign * rootHalf;
  const tipAlong = sign * (rootHalf + flapDepth);

  const p1 = toXY(axis, rootAlong, -lenHalf);
  const p2 = toXY(axis, rootAlong, lenHalf);
  const crease = new PathBuilder().moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).segments();

  const outerA = toXY(axis, tipAlong, -lenHalf + flapDepth);
  const outerB = toXY(axis, tipAlong, lenHalf - flapDepth);
  const cut = new PathBuilder().moveTo(p1.x, p1.y).lineTo(outerA.x, outerA.y).lineTo(outerB.x, outerB.y).lineTo(p2.x, p2.y).segments();

  return [
    { type: 'crease', tags: ['linerPad', side], segments: crease },
    { type: 'cut', tags: ['linerFlap', side], segments: cut },
  ];
}

/** 底面＋翼深兩條尺寸標註（spec：標「底面 padL×padW＋翼深」）；offset 皆外推，見 DIM_OFFSET 註解。 */
function buildDimensions(padL: number, padW: number, flapDepth: number): { descriptors: PathDescriptor[]; texts: Omit<DielineText, 'id'>[] } {
  const hl = padL / 2;
  const hw = padW / 2;
  const rightX = hw + flapDepth;
  const bottomY = -(hl + flapDepth);
  const descriptors: PathDescriptor[] = [];
  const texts: Omit<DielineText, 'id'>[] = [];

  const padWDim = dimensionLine(-hw, bottomY, hw, bottomY, `${padW.toFixed(1)}mm`, -DIM_OFFSET, 'h');
  descriptors.push({ type: 'dimension', tags: ['linerPad'], segments: padWDim.paths });
  texts.push({ x: padWDim.text.x, y: padWDim.text.y, text: padWDim.text.text, rotation: padWDim.text.rotation, fontSize: 3, anchor: 'middle' });

  const padLDim = dimensionLine(rightX, -hl, rightX, hl, `${padL.toFixed(1)}mm`, DIM_OFFSET, 'v');
  descriptors.push({ type: 'dimension', tags: ['linerPad'], segments: padLDim.paths });
  texts.push({ x: padLDim.text.x, y: padLDim.text.y, text: padLDim.text.text, rotation: padLDim.text.rotation, fontSize: 3, anchor: 'start' });

  const flapDim = dimensionLine(rightX, hl, rightX, hl + flapDepth, `${flapDepth.toFixed(1)}mm`, DIM_OFFSET * 2, 'v');
  descriptors.push({ type: 'dimension', tags: ['linerFlap'], segments: flapDim.paths });
  texts.push({ x: flapDim.text.x, y: flapDim.text.y, text: flapDim.text.text, rotation: flapDim.text.rotation, fontSize: 3, anchor: 'start' });

  return { descriptors, texts };
}

/** 四邊描述（各自的 axis/sign/side/rootHalf/lenHalf）：底面以局部原點為中心，四邊鏡射對稱。 */
function padEdges(padL: number, padW: number): Array<{ axis: Axis; sign: Sign; side: string; rootHalf: number; lenHalf: number }> {
  const hl = padL / 2;
  const hw = padW / 2;
  return [
    { axis: 'x', sign: -1, side: 'left', rootHalf: hw, lenHalf: hl },
    { axis: 'x', sign: 1, side: 'right', rootHalf: hw, lenHalf: hl },
    { axis: 'y', sign: -1, side: 'bottom', rootHalf: hl, lenHalf: hw },
    { axis: 'y', sign: 1, side: 'top', rootHalf: hl, lenHalf: hw },
  ];
}

/**
 * 內襯平台式腳架墊片生成——局部座標原點＝底面中心（四邊鏡射對稱，沿用 tray.ts 的
 * along/perp 慣例）。四片翼向外摺（架高 flapDepth），四角因相鄰翼斜切共線自然讓位。
 */
export function generateLiner(opts: LinerOpts): { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds } {
  const frame = deriveLinerFrame(opts);
  const { padL, padW } = frame;
  const flapDepth = opts.flapDepth;

  const descriptors: PathDescriptor[] = [];
  for (const edge of padEdges(padL, padW)) {
    descriptors.push(...buildPadEdgeAndFlap(edge.axis, edge.sign, edge.side, edge.rootHalf, edge.lenHalf, flapDepth));
  }

  const { descriptors: dimDescriptors, texts: dimTexts } = buildDimensions(padL, padW, flapDepth);
  descriptors.push(...dimDescriptors);

  const paths: DielinePath[] = descriptors
    .filter((d) => d.segments.length > 0)
    .map((d, i) => ({
      id: `${opts.idPrefix}-p-${i}`,
      type: d.type,
      segments: translateSegments(d.segments, opts.offsetX, opts.offsetY),
      tags: d.tags,
    }));

  const texts: DielineText[] = dimTexts.map((t, i) => ({
    ...t,
    id: `${opts.idPrefix}-t-${i}`,
    x: t.x + opts.offsetX,
    y: t.y + opts.offsetY,
  }));

  const bounds = segmentsBounds(paths.flatMap((p) => p.segments));
  return { paths, texts, bounds };
}
