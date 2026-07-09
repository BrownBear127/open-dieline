/**
 * 拼版預覽的 UI 幾何純函式：instance 排列變換＋供預覽消費的製造 paths 子集。
 *
 * 拆成零 React 依賴的純函式（T3 spec 明文理由）：jsdom 不支援 `getBBox()`／實際 SVG
 * transform 矩陣運算，若把這段變換數學埋在 `ImpositionView.tsx` 元件內部，測試就只能驗
 * DOM 結構、驗不到「變換本身對不對」。抽出來後 `tests/imposition-preview.test.ts` 才能
 * 直接對 transform 字串與衍生的 cell 矩形數值做代數驗證。純 TS 模組，座標單位一律 mm。
 */

import type { Bounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult, LineType } from '@/core/types';
import { MAX_PREVIEW_INSTANCES } from '@/core/imposition';

/**
 * 單一排列 instance：`transform` 供 SVG `<g transform>` 直接消費；`cellX`/`cellY`/`cellW`/
 * `cellH` 是同一份變換「在紙張座標系裡實際佔據的矩形」（左上角＋寬高，旋轉後的佔位）——
 * 暴露這四個數字讓呼叫端（`ImpositionView.tsx` 畫咬口／可用區參考線、測試驗證變換正確性）
 * 不需要重新解析 `transform` 字串或模擬 SVG matrix 運算。
 */
export interface PreviewInstance {
  transform: string;
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
}

/**
 * 依方向（0°／90°）＋排列格數＋製造 bounds＋咬口／間距，算出每個 instance 的 SVG transform
 * （spec「排列預覽」，plan T3 已推導定死的變換鏈，這裡逐字落實）：
 *
 * - 兩個方向共通：先 `translate(-mb.minX, -mb.minY)` 把製造 bounds 局部化到 (0,0) 原點——
 *   bounds 的 min 角未必是 (0,0)（見下方測試用的非零 min fixture），局部化後幾何恆落在
 *   `[0,w]×[0,h]`（w/h＝mb 寬高）。
 * - 0°：局部化後的 `[0,w]×[0,h]` 直接套 cell 位移
 *   `translate(gripper + c*(w+gap), gripper + r*(h+gap))`，佔位＝w×h（cellW=w, cellH=h）。
 * - 90°：SVG `rotate(90)` 對「點」的效果是順時針 `(x,y)→(−y,x)`——`[0,w]×[0,h]` 旋轉後落在
 *   `[−h,0]×[0,w]`，需要 `translate(h,0)` 修回 `[0,h]×[0,w]`（旋轉後佔位＝h×w，即 cell
 *   step／cellW／cellH 都用「旋轉後」的寬高，不是原始 w/h）。旋轉＋修正必須在局部化「之後」、
 *   cell 位移「之前」——SVG transform-list 對點的套用順序是由右到左（字串裡最右邊的
 *   `translate(-mb.minX,-mb.minY)` 最先作用在原始幾何點上），故字串書寫順序是
 *   `translate(cell) translate(h,0) rotate(90) translate(-min)`。
 *
 * `cols×rows` 超過 `MAX_PREVIEW_INSTANCES`（review F10）時只回傳前 N 個（row-major：先列滿
 * 第 0 列再進第 1 列……）；`count`（cols×rows 精確值）由呼叫端另外顯示兩位小數的利用率與
 * 「N 模」文字，不受這裡截斷影響——這個函式只負責「畫多少個」，不負責「報告多少個」。
 */
export function instanceTransforms(
  dir: 0 | 90,
  cols: number,
  rows: number,
  mb: Bounds,
  gripper: number,
  gap: number,
): PreviewInstance[] {
  const w = mb.maxX - mb.minX;
  const h = mb.maxY - mb.minY;
  // 90° 旋轉後佔位＝h×w（見上方 docblock）；0° 佔位即原始 w×h。
  const cellW = dir === 0 ? w : h;
  const cellH = dir === 0 ? h : w;
  const localize = `translate(${-mb.minX} ${-mb.minY})`;

  const instances = Array.from({ length: Math.max(0, rows) }, (_, r) =>
    Array.from({ length: Math.max(0, cols) }, (_, c): PreviewInstance => {
      const cellX = gripper + c * (cellW + gap);
      const cellY = gripper + r * (cellH + gap);
      const transform =
        dir === 0
          ? `translate(${cellX} ${cellY}) ${localize}`
          : `translate(${cellX} ${cellY}) translate(${h} 0) rotate(90) ${localize}`;
      return { transform, cellX, cellY, cellW, cellH };
    }),
  ).flat();

  return instances.slice(0, MAX_PREVIEW_INSTANCES);
}

/** 預覽線段的線型集合——只取幾何結構線；UI 圖層可見性／標註／文字／overlay 一律不參與
 *  （spec「排列預覽」：忽略設計模式的圖層可見性，dimension/annotation/texts/overlays 不出現，
 *  這裡直接不讀取那三個來源，不是讀了再過濾掉）。 */
const PREVIEW_LINE_TYPES: ReadonlySet<LineType> = new Set(['cut', 'crease', 'halfcut']);

/**
 * 供預覽渲染的製造 paths 子集：只保留 `cut`／`crease`／`halfcut` 三線型；`piece` 有值時
 * 再依 `pathIds` 縮到該片（沿用 `core/bounds.ts` `manufacturingBounds` 同一套 pathIdSet
 * 過濾寫法），`piece` 為 `null` 時回全版（RTE／未選定片）。
 */
export function previewPaths(result: GenerateResult, piece: DielinePiece | null): DielinePath[] {
  const pathIdSet = piece ? new Set(piece.pathIds) : null;
  return result.paths.filter((p) => PREVIEW_LINE_TYPES.has(p.type) && (pathIdSet === null || pathIdSet.has(p.id)));
}
