/**
 * SVG 匯出——把 `core/types` 的 `GenerateResult` 序列化成完整 SVG 文件字串（下載交付給
 * 使用者／刀模廠）。
 *
 * 樣式單一來源（spec §3.2 漂移防範）：所有線型的 stroke/strokeWidth/dasharray 一律從
 * `core/styles.ts` 的 `LINE_STYLES` 讀取，本檔內禁止散落字面色碼——與畫布（Canvas.tsx）
 * 共用同一份樣式表，刀模廠靠線色區分 cut/crease，色碼散落各處＝色偏風險。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 *
 * **製造模式（Slice 5 F7·`SvgExportOptions.manufacturing`）**：`toSvgDocument` 第二參數
 * 選填，省略或 `{ manufacturing: false }` 時走原本邏輯——同一份 `GenerateResult` 輸出
 * byte 級不變（見 `tests/export/svg.test.ts` 的迴歸快照，鎖 RTE／telescope 真實輸出）。
 * `{ manufacturing: true }` 時：線寬固定 `0.25`、無 dasharray（solid）、加 round
 * cap/join；排除 `dimension`/`annotation` 路徑與全部 `texts`；viewBox/width/height 改用
 * 排除後的製造幾何 bounds（`manufacturingBounds`，見 `core/bounds.ts`）重算，不沿用含
 * 標註的 `result.bounds`——否則刀模廠拿到的檔案會殘留標註外擴的空白邊。顏色不受影響
 * （仍讀 `LINE_STYLES`，cut/crease/halfcut＝black/lime/yellow）：製造模式只覆寫線寬／
 * dasharray／cap-join 三個視覺屬性，不覆寫色碼——與本檔「樣式單一來源」原則不衝突。
 * 這是 exporter 層獨有的輸出模式，畫布顯示（`Canvas.tsx`／`LINE_STYLES` 本身）不受影響
 * ——spec §F7 明文「畫布顯示不變」。全盒型功能：RTE／telescope 皆可用，不綁特定盒型。
 */

import type { DielinePath, DielineText, GenerateResult } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';
import { GENERATED_LAYER_LABEL, GENERATED_LAYER_ORDER, layerKeyForLineType } from '@/core/layers';
import type { GeneratedLayerKey } from '@/core/layers';
import { DIMENSION_LINE_TYPES, manufacturingBounds } from '@/core/bounds';

// re-export：既有外部契約不變（`export/svg.ts` 的消費者原本就從這裡 import 這兩個名字，
// 見 ExportBar.tsx／core/bounds.ts 檔頭「呼叫端」清單）；本檔內部（F7 製造模式）也需要
// 這兩個 binding 來過濾 paths／重算 bounds，改成「先 import 再 re-export」讓兩邊共用同一份
// import，不重複打一次 module specifier。
export { DIMENSION_LINE_TYPES, manufacturingBounds };

/**
 * `toSvgDocument` 第二參數（選填）。省略或 `manufacturing: false`＝既有全量路徑（byte 級
 * 不變，見檔頭「製造模式」說明）；`manufacturing: true`＝spec §F7 製造模式，細節見
 * `toSvgDocument` 與 `pathToSvg` 的文件。
 */
export interface SvgExportOptions {
  manufacturing?: boolean;
}

const DEFAULT_FONT_SIZE = 3;

const decimals = 2;

/** 製造模式（spec §F7）固定線寬——覆寫 LINE_STYLES 各線型原本的 strokeWidth（0.3/0.4）。 */
const MANUFACTURING_STROKE_WIDTH = 0.25;

/** toFixed(2) 對近零負值（如 -1e-9）會印出 "-0.00"；收斂為 "0.00"（與 core/path.ts 的 fmt 同一慣例）。 */
function fmt(v: number): string {
  const s = v.toFixed(decimals);
  return s === '-0.00' ? '0.00' : s;
}

/** XML content escape：至少涵蓋 & < >（text 內容是使用者可影響的字串，不跳脫會破壞 SVG 結構）。 */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 單一 DielinePath → 一個 `<path>` 元素；樣式一律查 LINE_STYLES（型別是 Record<LineType,…>，
 * 每個 LineType 保證有對應樣式）。
 *
 * `manufacturing`（F7）為 true 時三處覆寫：線寬固定 `MANUFACTURING_STROKE_WIDTH`（取代
 * `style.strokeWidth`）、恆不輸出 `stroke-dasharray`（solid，取代 `style.dasharray` 判斷）、
 * 加 `stroke-linecap="round" stroke-linejoin="round"`。`stroke` 顏色不受影響——三個覆寫都是
 * 純視覺線型屬性，色碼一律照舊查 `LINE_STYLES`（spec F7「顏色維持 black/lime/yellow」）。
 * false 時（預設）行為與 F7 之前逐字相同——`toSvgDocument` 在非製造模式下傳入 `false`，
 * 不影響既有輸出（迴歸見 `tests/export/svg.test.ts`）。
 */
function pathToSvg(p: DielinePath, manufacturing: boolean): string {
  const style = LINE_STYLES[p.type];
  const d = segmentsToSvgD(p.segments);
  const strokeWidth = manufacturing ? MANUFACTURING_STROKE_WIDTH : style.strokeWidth;
  const dasharrayAttr = !manufacturing && style.dasharray ? ` stroke-dasharray="${style.dasharray}"` : '';
  const capJoinAttr = manufacturing ? ' stroke-linecap="round" stroke-linejoin="round"' : '';
  // fill="none" 必加：SVG path 沒有明示 fill 時預設黑色填滿，會把刀模線稿的封閉輪廓塗死。
  return `<path d="${d}" stroke="${style.stroke}" stroke-width="${strokeWidth}"${dasharrayAttr}${capJoinAttr} fill="none" />`;
}

/**
 * 單一 DielineText → 一個 `<text>` 元素。
 *
 * `fill` 一律讀 `LINE_STYLES.dimension.stroke`（與 Canvas.tsx 的 `DIMENSION_TEXT_FILL`
 * 同一來源——v1 texts 全部來自標註線，見 `core/bounds.ts` 的 `DIMENSION_LINE_TYPES` 註解）：沒有明示
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
 * 4 個生成圖層桶的英文 id（`<g id="…">`，Illustrator 圖層面板顯示這個）。cut/crease/halfcut
 * 與 `export/dxf.ts` 的 `DXF_LAYER_BY_LINETYPE` 逐字相同（跨格式同名，同一份刀模的 SVG／DXF
 * 圖層名對得起來）——兩檔刻意不互相 import 這份對照（沿用 dxf.ts 檔頭「效果等價、少一個跨檔
 * import」的既有選擇，見該檔 `DXF_LAYER_BY_LINETYPE` 上方註解），一致性改由
 * `tests/export/svg.test.ts` 直接 import 兩邊常數交叉比對鎖住——源頭改一邊沒改另一邊會被
 * 測試抓到，不需要額外的跨檔 import。`dimensions` 是 SVG 專屬桶（DXF 恆排除標註，見 dxf.ts
 * 檔頭圖層排除規則），沒有 DXF 對應值可借，這裡另外定義。
 */
const GENERATED_LAYER_ID: Readonly<Record<GeneratedLayerKey, string>> = {
  cut: 'CUT',
  crease: 'CREASE',
  halfcut: 'HALFCUT',
  dimensions: 'DIMENSIONS',
};

/** 單一非空圖層桶 → 一個 `<g>` 元素；`id` 英文（跨格式同名）、`data-name` 中文（`GENERATED_LAYER_LABEL`）。 */
function groupToSvg(key: GeneratedLayerKey, children: string[]): string {
  return `<g id="${GENERATED_LAYER_ID[key]}" data-name="${GENERATED_LAYER_LABEL[key]}">\n    ${children.join('\n    ')}\n  </g>`;
}

/**
 * `GenerateResult` → 完整 SVG 文件字串。`opts.manufacturing`（F7，選填，預設 `false`）＝
 * 製造模式；省略／`false` 時下面每一條都跟 F7 之前逐字相同（byte 級迴歸見
 * `tests/export/svg.test.ts`）。
 *
 * - `width`/`height` 以 mm 明示、`viewBox` 對應同一份 bounds（皆 toFixed(2)）。非製造模式
 *   恆用全 `result.bounds`（見下方「恆全量」）；製造模式改用 `manufacturingBounds(result)`
 *   （排除 dimension/annotation 後的幾何包絡，見 `core/bounds.ts`）——不沿用含標註的
 *   `result.bounds`，否則 viewBox 會比實際製造幾何大一圈，刀模廠拿到的檔案殘留標註外擴的
 *   空白邊（spec F7 明文）。
 * - paths 依 `layerKeyForLineType` 分 4 桶（cut/crease/halfcut/dimensions，`GENERATED_LAYER_ORDER`
 *   順序輸出），每桶非空時包一層 `<g id="…" data-name="…">`（Illustrator 開啟得到 4 個命名
 *   圖層，可個別隱藏/鎖定/刪除）；空桶不輸出 `<g>`（AI 圖層面板不出現空群組）。g 內每個
 *   `DielinePath` 仍是一個 `<path>`、每個 `DielineText` 仍是一個 `<text>`，樣式/座標/排序與
 *   分組前完全一致（除了 `pathToSvg` 的 `manufacturing` 覆寫，見該函式文件）——這裡只是多
 *   包一層容器。
 * - texts 全部歸 `dimensions` 桶（v1 texts 只來自標註，見 `core/bounds.ts` 的
 *   `DIMENSION_LINE_TYPES` 註解——該常數已於 2026-07-10 遷移，本檔僅 re-export）。
 * - **恆全量輸出**（Slice 3 gate round 1 T4 plan 裁決，F7 之前的既有行為）：`includeDimensions`
 *   opts 參數已退役，不再有「剔除標註」這個匯出模式，viewBox/寬高也恆用含標註的全 bounds。
 *   畫布圖層可見性（`LayersState.generatedVisible`）只影響畫面顯示，不影響匯出檔內容；
 *   使用者若想要不含標註的檔案，改在 Illustrator 裡對匯出後的 `DIMENSIONS` 圖層自行隱藏/
 *   刪除，或直接用 F7 製造模式（見檔頭）。
 * - **製造模式**（F7，`opts.manufacturing === true`）：`result.paths` 先過濾掉
 *   `DIMENSION_LINE_TYPES`（dimension／annotation）成員、`texts` 整組清空，才進上面的分桶
 *   邏輯——`dimensions` 桶因此恆空，對應的 `<g id="DIMENSIONS">` 不會輸出（沿用既有「空桶
 *   不輸出」規則，不需要另外特判）。留下的 cut/crease/halfcut 路徑經 `pathToSvg` 的
 *   `manufacturing` 分支覆寫線寬/dasharray/cap-join（見該函式文件），色碼不變。
 */
export function toSvgDocument(result: GenerateResult, opts?: SvgExportOptions): string {
  const manufacturing = opts?.manufacturing ?? false;
  const paths = manufacturing ? result.paths.filter((p) => !DIMENSION_LINE_TYPES.has(p.type)) : result.paths;
  const texts = manufacturing ? [] : result.texts;

  const buckets: Record<GeneratedLayerKey, DielinePath[]> = { cut: [], crease: [], halfcut: [], dimensions: [] };
  for (const p of paths) {
    buckets[layerKeyForLineType(p.type)].push(p);
  }

  const bounds = manufacturing ? manufacturingBounds(result) : result.bounds;
  const { minX, minY, maxX, maxY } = bounds;
  const width = maxX - minX;
  const height = maxY - minY;

  const groups = GENERATED_LAYER_ORDER.flatMap((key) => {
    const keyTexts = key === 'dimensions' ? texts : [];
    const children = [...buckets[key].map((p) => pathToSvg(p, manufacturing)), ...keyTexts.map(textToSvg)];
    return children.length > 0 ? [groupToSvg(key, children)] : [];
  });
  const body = groups.length > 0 ? `\n  ${groups.join('\n  ')}\n` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}">` +
    `${body}</svg>`
  );
}
