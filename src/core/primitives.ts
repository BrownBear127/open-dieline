/**
 * 可複用刀模構件庫：摩擦扣（friction lock）、J-Hook 避讓槽（relief slot）、標註線（dimension line）。
 *
 * 這是「移植保真」模組——幾何行為完全對齊前身 ReverseTuckEnd.ts（唯讀參照，
 * /Users/fran/Desktop/trouver.crm-rebuild/components/Tools/Packaging/models/ReverseTuckEnd.ts）
 * 的 drawLock/drawRelief/drawDim/drawDimV，只是把字串拼接的 SVG `d` 改產結構化 Segment、
 * 把行內 helper 抽成獨立可測試函式，供後續盒型（Task 6 RTE 及未來盒型）共用。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Segment } from '@/core/geometry';
import { PathBuilder } from '@/core/path';

/** 糊邊導角 mm（前身 Glue Flap 區塊 `const chamfer = 5`，見 ReverseTuckEnd.ts:106，具名化）。 */
export const GLUE_CHAMFER = 5;

/** 摩擦扣凸起高 mm（前身 drawLock `const h_lock = 1.5`，見 ReverseTuckEnd.ts:132）。 */
export const LOCK_HEIGHT = 1.5;

/** 摩擦扣導角 mm（前身 drawLock `const chamfer = 2`，見 ReverseTuckEnd.ts:138）。 */
export const LOCK_CHAMFER = 2;

/**
 * 摩擦扣（friction lock）：盒蓋插入時卡住的凸起卡榫。
 *
 * 對齊前身 `drawLock`（ReverseTuckEnd.ts:124-149）：
 * - `lockWidth` 不是正數時（含前身 `!w_lock || w_lock <= 0` 隱性涵蓋的 0／負值／NaN 三種
 *   退化輸入，等價於 `!(lockWidth > 0)`）不產生卡榫，只回傳 `xStart→xEnd` 整段直線
 *   crease，`cut` 為空陣列。
 * - 否則從中心點 `(xStart+xEnd)/2` 左右各展開 `lockWidth/2`，中段兩側 crease 各自斷在
 *   卡榫邊緣；卡榫本體是一個梯形 cut（兩側各內縮 `LOCK_CHAMFER` 導角，凸起高度
 *   `LOCK_HEIGHT`，方向由 `dir` 決定符號：'up' 對應前身 `sign=-1`、'down' 對應 `sign=+1`）。
 */
export function frictionLock(
  xStart: number,
  xEnd: number,
  y: number,
  dir: 'up' | 'down',
  lockWidth: number,
): { creases: Segment[]; cut: Segment[] } {
  if (!(lockWidth > 0)) {
    const creases = new PathBuilder().moveTo(xStart, y).lineTo(xEnd, y).segments();
    return { creases, cut: [] };
  }

  const sign = dir === 'up' ? -1 : 1;
  const cx = (xStart + xEnd) / 2;
  const xLeft = cx - lockWidth / 2;
  const xRight = cx + lockWidth / 2;
  const bumpY = y + LOCK_HEIGHT * sign;

  const creases = new PathBuilder()
    .moveTo(xStart, y)
    .lineTo(xLeft, y)
    .moveTo(xRight, y)
    .lineTo(xEnd, y)
    .segments();

  const cut = new PathBuilder()
    .moveTo(xLeft, y)
    .lineTo(xLeft + LOCK_CHAMFER, bumpY)
    .lineTo(xRight - LOCK_CHAMFER, bumpY)
    .lineTo(xRight, y)
    .segments();

  return { creases, cut };
}

/**
 * J-Hook 避讓槽（relief slot）：貝茲曲線構成的避讓切口，防止摺痕撕裂。
 *
 * 對齊前身 `drawRelief`（ReverseTuckEnd.ts:151-165）。前身的 `relief_gap`/`notch_height`
 * 是盒型層級算好、多處共用的值（見前身 39-41 行）；這裡改由呼叫端以 `gap`/`notchHeight`
 * 參數直接傳入（契約簡化，幾何行為不變）。
 *
 * `side` 決定 x 方向位移正負（'left'→負、'right'→正），`dir` 決定 y 方向位移正負
 * （'top'→負、'bottom'→正），與前身 `x_gap`/`y_sign` 一致。回傳 `end` 供呼叫端接續
 * 下一段路徑（前身 `drawRelief` 回傳值原樣搬過來）。
 */
export function reliefSlot(
  cornerX: number,
  cornerY: number,
  side: 'left' | 'right',
  dir: 'top' | 'bottom',
  gap: number,
  notchHeight: number,
): { cut: Segment[]; end: { x: number; y: number } } {
  const ySign = dir === 'top' ? -1 : 1;
  const xGap = side === 'left' ? -gap : gap;
  const xTarget = cornerX + xGap;
  const yCurveEnd = cornerY + notchHeight * ySign;

  const cut = new PathBuilder()
    .moveTo(cornerX, cornerY)
    .bezierTo(
      cornerX,
      cornerY + notchHeight * 0.5 * ySign,
      xTarget,
      cornerY + notchHeight * 0.3 * ySign,
      xTarget,
      yCurveEnd,
    )
    .segments();

  return { cut, end: { x: xTarget, y: yCurveEnd } };
}

/**
 * 標註線（dimension line）：工程圖尺寸標註，含兩條端點引出線（末端外伸 2mm 刻線）與
 * 一條主標註線，附文字標籤。
 *
 * 對齊前身 `drawDim`（水平，ReverseTuckEnd.ts:312-319）與 `drawDimV`（垂直，321-327）。
 * 前身用 `labelVal.toFixed(0)+'mm'` 在函式內格式化文字；新契約改由呼叫端直接傳入格式化好
 * 的 `label` 字串（契約簡化，見 brief 簽章），幾何行為不變。
 *
 * - 'h'：標註線與引出線沿 y 方向偏移 `offset`（`ly = y1+offset`），文字置中於
 *   `((x1+x2)/2, ly-2)`，`rotation=0`。
 * - 'v'：標註線與引出線沿 x 方向偏移 `offset`（`lx = x1+offset`），文字置於
 *   `(lx-4, (y1+y2)/2)`，`rotation=-90`（前身 `addText(...,-90)`，非 90）。
 * - 引出線外伸刻線方向：`offset>0` 時朝正向多伸 2mm，否則（含 `offset===0`）朝負向多伸
 *   2mm（前身 `offset > 0 ? 2 : -2`，逐字保留這個含 0 的分支——即使測量點與標註線重合，
 *   前身仍照樣外伸，不特判 0）。
 */
export function dimensionLine(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string,
  offset: number,
  orientation: 'h' | 'v',
): { paths: Segment[]; text: { x: number; y: number; text: string; rotation: number } } {
  const tick = offset > 0 ? 2 : -2;

  if (orientation === 'h') {
    const ly = y1 + offset;
    const paths = new PathBuilder()
      .moveTo(x1, y1)
      .lineTo(x1, ly + tick)
      .moveTo(x2, y2)
      .lineTo(x2, ly + tick)
      .moveTo(x1, ly)
      .lineTo(x2, ly)
      .segments();
    return { paths, text: { x: (x1 + x2) / 2, y: ly - 2, text: label, rotation: 0 } };
  }

  const lx = x1 + offset;
  const paths = new PathBuilder()
    .moveTo(x1, y1)
    .lineTo(lx + tick, y1)
    .moveTo(x2, y2)
    .lineTo(lx + tick, y2)
    .moveTo(lx, y1)
    .lineTo(lx, y2)
    .segments();
  return { paths, text: { x: lx - 4, y: (y1 + y2) / 2, text: label, rotation: -90 } };
}
