/**
 * SVG 匯出——把 `core/types` 的 `GenerateResult` 序列化成完整 SVG 文件字串（下載交付給
 * 使用者／刀模廠）。
 *
 * 樣式單一來源（spec §3.2 漂移防範）：所有線型的 stroke/strokeWidth/dasharray 一律從
 * `core/styles.ts` 的 `LINE_STYLES` 讀取，本檔內禁止散落字面色碼——與畫布（Canvas.tsx）
 * 共用同一份樣式表，刀模廠靠線色區分 cut/crease，色碼散落各處＝色偏風險。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { DielinePath, DielineText, GenerateResult } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';
import { GENERATED_LAYER_LABEL, GENERATED_LAYER_ORDER, layerKeyForLineType } from '@/core/layers';
import type { GeneratedLayerKey } from '@/core/layers';

export { DIMENSION_LINE_TYPES, manufacturingBounds } from '@/core/bounds';

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
 * `GenerateResult` → 完整 SVG 文件字串。
 *
 * - `width`/`height` 以 mm 明示（取自 `bounds` 尺寸），`viewBox` 對應 `bounds`（皆 toFixed(2)，
 *   恆用全 bounds——見下方「恆全量」）。
 * - paths 依 `layerKeyForLineType` 分 4 桶（cut/crease/halfcut/dimensions，`GENERATED_LAYER_ORDER`
 *   順序輸出），每桶非空時包一層 `<g id="…" data-name="…">`（Illustrator 開啟得到 4 個命名
 *   圖層，可個別隱藏/鎖定/刪除）；空桶不輸出 `<g>`（AI 圖層面板不出現空群組）。g 內每個
 *   `DielinePath` 仍是一個 `<path>`、每個 `DielineText` 仍是一個 `<text>`，樣式/座標/排序與
 *   分組前完全一致——`pathToSvg`/`textToSvg` 本身不變，這裡只是多包一層容器。
 * - texts 全部歸 `dimensions` 桶（v1 texts 只來自標註，見 `core/bounds.ts` 的
 *   `DIMENSION_LINE_TYPES` 註解——該常數已於 2026-07-10 遷移，本檔僅 re-export）。
 * - **恆全量輸出**（Slice 3 gate round 1 T4 plan 裁決）：`includeDimensions` opts 參數已退役，
 *   不再有「剔除標註」這個匯出模式，viewBox/寬高也恆用含標註的全 bounds。畫布圖層可見性
 *   （`LayersState.generatedVisible`）只影響畫面顯示，不影響匯出檔內容；使用者若想要不含
 *   標註的檔案，改在 Illustrator 裡對匯出後的 `DIMENSIONS` 圖層自行隱藏/刪除——本函式做的
 *   g 分組正是為了讓這個操作可行。
 */
export function toSvgDocument(result: GenerateResult): string {
  const buckets: Record<GeneratedLayerKey, DielinePath[]> = { cut: [], crease: [], halfcut: [], dimensions: [] };
  for (const p of result.paths) {
    buckets[layerKeyForLineType(p.type)].push(p);
  }

  const { minX, minY, maxX, maxY } = result.bounds;
  const width = maxX - minX;
  const height = maxY - minY;

  const groups = GENERATED_LAYER_ORDER.flatMap((key) => {
    const texts = key === 'dimensions' ? result.texts : [];
    const children = [...buckets[key].map(pathToSvg), ...texts.map(textToSvg)];
    return children.length > 0 ? [groupToSvg(key, children)] : [];
  });
  const body = groups.length > 0 ? `\n  ${groups.join('\n  ')}\n` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}mm" height="${fmt(height)}mm" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(width)} ${fmt(height)}">` +
    `${body}</svg>`
  );
}
