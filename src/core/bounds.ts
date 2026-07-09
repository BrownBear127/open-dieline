/**
 * 製造 bounds：排除尺寸標註後，計算全版或單片的實際製造幾何包絡。
 * 純 TS 模組，不 import export、React 或任何 UI。座標單位一律 mm。
 */

import type { Bounds } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, LineType } from '@/core/types';

// v1 的 texts 只有一個來源：boxes/*.ts 呼叫 core/primitives.ts 的 dimensionLine() 產生的
// 尺寸標註數字（見 reverse-tuck-end.ts 的 addDim）。DielineText 型別本身沒有 type/LineType
// 欄位可供逐條分類「這是不是標註文字」——這與「v1 texts 全部來自標註」的事實剛好一致，不是
// 缺陷。若未來出現非標註文字（例如面板名稱標籤），需要先幫 DielineText 加分類欄位才談得上
// 細分，現在加是沒有消費者的臆測性欄位（YAGNI）。
//
// export（供 ui/Canvas.tsx 共用，T9 Fix Round 2 修復 3）：畫布顯示與下載內容必須用同一份
// 「哪些線型算尺寸標註」定義，避免兩處各自維護一份字面量集合而在未來悄悄漂移（spec §3.2
// 樣式單一來源的同一種精神，此處套用在「過濾規則」而非「樣式數值」）。這份定義現在的唯一
// 消費者是 `manufacturingBounds`（排除標註後取幾何包絡，供疊圖對齊／檔名尺寸使用，見該函式
// 文件）——`toSvgDocument` 的 `includeDimensions` opts 已於 Slice 3 gate round 1 T4 退役，
// SVG 匯出恆全量，不再有「保留或剔除文字」這個分支可言。
//
// 搬遷紀錄：2026-07-10 拼版 Slice 4 從 `export/svg.ts` 遷入 core；原檔 re-export 保持相容。
export const DIMENSION_LINE_TYPES: ReadonlySet<LineType> = new Set(['dimension', 'annotation']);

/**
 * 「製造 bounds」——排除 `DIMENSION_LINE_TYPES`（dimension/annotation）路徑後，對剩餘幾何
 * 取 `segmentsBounds`（FX3/FX5，Slice 3 final review）。可選傳入 `piece`：有值時只算該片的
 * 成員（`pathIds` 過濾），省略時算全版（`result.paths` 全集）——同一份「排除標註」定義供
 * 兩種呼叫情境共用，避免各自維護一份字面量集合而漂移（沿用 `DIMENSION_LINE_TYPES` 本身
 * 「過濾規則單一來源」的精神，見上方該常數 docblock）。
 *
 * 呼叫端：`ui/App.tsx` 的疊圖快速對齊目標（FX3——修前 `activePiece?.bounds ?? result.bounds`
 * 依 spec §3.3 三向等式必含尺寸標註線外擴，對齊會對到標註框而非製造幾何）、
 * `ui/ExportBar.tsx` 的全版檔名 fallback（FX5——無 L/W/D 宣告 key 的盒型，全版匯出檔名
 * 修前直接用 `result.bounds`，同一種「標註外擴污染尺寸判斷」問題）。
 *
 * 跟 `ui/ExportBar.tsx` 的 `pieceManufacturingBounds`（Slice 2 FX3 引入，單片匯出檔名專用）
 * 是兩個獨立函式，刻意不合併：那個只排除 `type==='dimension'`（不含 `'annotation'`），是
 * 單片匯出檔名這個窄範圍場景下的既有定案行為，且已有測試鎖住那個精確數值，改動它會超出
 * 本輪修復範圍（FX3/FX5 只涵蓋疊圖對齊與全版檔名 fallback 兩個新呼叫情境，不動既有單片
 * 匯出邏輯）。這裡兩個新呼叫端都是本輪新增，用更完整的 `DIMENSION_LINE_TYPES`（含
 * annotation）定義才對，沒有「相容既有行為」的包袱。
 */
export function manufacturingBounds(result: GenerateResult, piece?: DielinePiece): Bounds {
  const pathIdSet = piece ? new Set(piece.pathIds) : null;
  const segments = result.paths
    .filter((p) => (pathIdSet === null || pathIdSet.has(p.id)) && !DIMENSION_LINE_TYPES.has(p.type))
    .flatMap((p) => p.segments);
  return segmentsBounds(segments);
}
