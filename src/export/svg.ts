/**
 * SVG 匯出——把 `core/types` 的 `GenerateResult` 序列化成完整 SVG 文件字串（下載交付給
 * 使用者／刀模廠）。
 *
 * 樣式單一來源（spec §3.2 漂移防範）：所有線型的 stroke/strokeWidth/dasharray 一律從
 * `core/styles.ts` 的 `LINE_STYLES` 讀取，本檔內禁止散落字面色碼——與畫布（Canvas.tsx）
 * 共用同一份樣式表，刀模廠靠線色區分 cut/crease，色碼散落各處＝色偏風險。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Bounds } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePiece, DielinePath, DielineText, GenerateResult, LineType } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';

// v1 的 texts 只有一個來源：boxes/*.ts 呼叫 core/primitives.ts 的 dimensionLine() 產生的
// 尺寸標註數字（見 reverse-tuck-end.ts 的 addDim）。DielineText 型別本身沒有 type/LineType
// 欄位可供逐條分類「這是不是標註文字」，所以 includeDimensions 只能整批保留或整批剔除文字，
// 沒有中間地帶——這與「v1 texts 全部來自標註」的事實剛好一致，不是缺陷。若未來出現非標註
// 文字（例如面板名稱標籤），需要先幫 DielineText 加分類欄位才談得上細分，現在加是沒有消費者
// 的臆測性欄位（YAGNI）。
//
// export（供 ui/Canvas.tsx 共用，T9 Fix Round 2 修復 3）：畫布顯示與下載內容必須用同一份
// 「哪些線型算尺寸標註」定義，避免兩處各自維護一份字面量集合而在未來悄悄漂移（spec §3.2
// 樣式單一來源的同一種精神，此處套用在「過濾規則」而非「樣式數值」）。
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

const DEFAULT_FONT_SIZE = 3;

const decimals = 2;

/** toFixed(2) 對近零負值（如 -1e-9）會印出 "-0.00"；收斂為 "0.00"（與 core/path.ts 的 fmt 同一慣例）。 */
function fmt(v: number): string {
  const s = v.toFixed(decimals);
  return s === '-0.00' ? '0.00' : s;
}

/** XML content escape：至少涵蓋 & < >（text 內容是使用者可影響的字串，不跳脫會破壞 SVG 結構）。 */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 單一 DielinePath → 一個 `<path>` 元素；樣式一律查 LINE_STYLES（型別是 Record<LineType,…>，每個 LineType 保證有對應樣式）。 */
function pathToSvg(p: DielinePath): string {
  const style = LINE_STYLES[p.type];
  const d = segmentsToSvgD(p.segments);
  const dasharrayAttr = style.dasharray ? ` stroke-dasharray="${style.dasharray}"` : '';
  // fill="none" 必加：SVG path 沒有明示 fill 時預設黑色填滿，會把刀模線稿的封閉輪廓塗死。
  return `<path d="${d}" stroke="${style.stroke}" stroke-width="${style.strokeWidth}"${dasharrayAttr} fill="none" />`;
}

/**
 * 單一 DielineText → 一個 `<text>` 元素。
 *
 * `fill` 一律讀 `LINE_STYLES.dimension.stroke`（與 Canvas.tsx 的 `DIMENSION_TEXT_FILL`
 * 同一來源——v1 texts 全部來自標註線，見上方 `DIMENSION_LINE_TYPES` 註解）：沒有明示
 * `fill` 時瀏覽器預設黑，會跟畫布顯示的藍色不一致（漂移，spec §3.2 要修正的問題）。
 */
function textToSvg(t: DielineText): string {
  const x = fmt(t.x);
  const y = fmt(t.y);
  const fontSize = t.fontSize ?? DEFAULT_FONT_SIZE;
  const anchorAttr = t.anchor ? ` text-anchor="${t.anchor}"` : '';
  // rotation 用 truthy 檢查：0 與 undefined 都是 falsy，剛好等價於「有值且非 0 才輸出」，
  // 不需要另外寫 `!== undefined && !== 0`。旋轉中心固定為文字自身的錨點座標 (x,y)。
  const transformAttr = t.rotation ? ` transform="rotate(${fmt(t.rotation)} ${x} ${y})"` : '';
  return `<text x="${x}" y="${y}" font-size="${fontSize}" font-family="sans-serif" fill="${LINE_STYLES.dimension.stroke}"${anchorAttr}${transformAttr}>${escapeXmlText(t.text)}</text>`;
}

/**
 * `GenerateResult` → 完整 SVG 文件字串。
 *
 * - `width`/`height` 以 mm 明示（取自 `bounds` 尺寸），`viewBox` 對應 `bounds`（皆 toFixed(2)）。
 * - 每個 `DielinePath` 產生一個 `<path>`，樣式值來自 `LINE_STYLES`（禁止字面色碼）。
 * - 每個 `DielineText` 產生一個 `<text>`。
 * - `includeDimensions`（預設 `true`）為 `false` 時，剔除 `dimension`/`annotation` 線型的路徑，
 *   以及全部 texts（v1 texts 只來自標註，見上方 `DIMENSION_LINE_TYPES` 註解）。
 */
export function toSvgDocument(result: GenerateResult, opts?: { includeDimensions?: boolean }): string {
  const includeDimensions = opts?.includeDimensions ?? true;

  const paths = includeDimensions ? result.paths : result.paths.filter((p) => !DIMENSION_LINE_TYPES.has(p.type));
  const texts = includeDimensions ? result.texts : [];

  const { minX, minY, maxX, maxY } = result.bounds;
  const width = maxX - minX;
  const height = maxY - minY;

  const children = [...paths.map(pathToSvg), ...texts.map(textToSvg)];
  const body = children.length > 0 ? `\n  ${children.join('\n  ')}\n` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}">` +
    `${body}</svg>`
  );
}
