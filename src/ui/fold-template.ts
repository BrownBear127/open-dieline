/**
 * P3 M3 對位模板 builder（T0 skeleton——T1 落實作）。
 * 契約（Spec-M3 v2 F1/F1.0）：自 ArtworkLayout 名義攤平幾何生成 square-frame
 * 模板 SVG（TEMPLATE_GUIDES ＋空 ARTWORK group）並觸發下載。lazy import 專用
 * ——本模組禁被 main 靜態 import（J1 C7b）。
 *
 * `buildTemplateSvg` 是純函式（layout+opts → SVG 字串）；`downloadTemplate` 是唯一
 * 有副作用的入口（deriveArtworkLayout → buildTemplateSvg → Blob 下載，慣例同
 * `src/ui/ExportBar.tsx` 的 downloadBlob，但那份是私有函式、`src/ui/` 未鎖故本檔
 * 局部複製一份精簡版，不動 ExportBar.tsx）。
 *
 * 座標系：SVG 直接畫 ArtworkLayout 的原始 mm 座標（不做 UV 正規化）——viewBox 用
 * `[minX-offsetX, minY-offsetY, span, span]` 承接 offset，面板點/hinge 端點原樣輸出。
 * 這與 3D UV 映射（`fold-scene.ts` 的 `flatUv`：u=(x-minX+offsetX)/span,
 * v=1-(y-minY+offsetY)/span）是同一個 frame 的兩種表現形式——C1 測試
 * （`tests/fold-ui/fold-template.test.ts`）逐點驗證兩者換算一致。
 */
import type { ResolvedParams } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import type { FoldModel } from '@/fold/types';
import type { Lang } from '@/i18n/lang';
import { getLang } from '@/i18n/lang';
import type { ArtworkLayout, ArtworkLayoutPanel } from './artwork-layout';
import { deriveArtworkLayout } from './artwork-layout';

type LayoutPoint = ArtworkLayoutPanel['polygon'][number];

// 頁框細線比 panel 外緣細一半——視覺上跟「真正的刀線」區分，但色碼仍取自
// LINE_STYLES.cut（C1 白名單只准 cut/crease 兩色，頁框不是獨立第三色）。這是 spec
// 未定處的實作決定：spec F1 只寫「方形頁框細線」沒指定色碼／線寬，見 T1 紀錄。
const PAGE_FRAME_STROKE_WIDTH = LINE_STYLES.cut.strokeWidth / 2;
// 面板標示／角落指示文字共用的淡灰色——spec F1 m13「中心淡灰 mono 小字」，數值
// 本身無既有色票可同源（不是 LINE_STYLES 的四色之一，文字不算「線型」不受 C1
// 白名單限制），T1 選定一個與 core/styles.ts LINE_STYLES.annotation 相近但更淺的
// 灰階，避免與畫布既有 annotation 語意混淆。
const GUIDE_TEXT_FILL = '#9a968f';

// C9 修正版字面（2026-07-18 維護者裁「問題 2＝SVG＋.jsx 路線」）：實測證明 Illustrator
// 開 SVG 時群組不可直接作畫（新繪物件落作用中圖層頂端），且上傳管線不解析群組結構
// ——指示只講兩件硬需求（匯出前關閉 GUIDES 顯示＋保留整頁），並提示附帶腳本可轉真
// 圖層。zh 避字沿 charset.json 實驗（拘／群組／執／隱／眼／睛皆不在 cjk cmap，字面
// 已逐字驗過全覆蓋；同 invalidFile 避「符」前例，本段非 A15 dict 不需重生字型）。
const TEMPLATE_INSTRUCTIONS: Record<Lang, string> = {
  en: 'Paint anywhere on the page. Hide TEMPLATE_GUIDES before exporting and keep the full square page. Run the companion script for real layers.',
  zh: '作畫位置不限，匯出前請關閉 TEMPLATE_GUIDES 顯示，並保留完整正方形頁面。可使用附帶腳本建立真圖層結構。',
};

const DUST_FLAP_PANEL_IDS = new Set(['topDustP2', 'topDustP4', 'bottomDustP2', 'bottomDustP4']);
const TUCK_PANEL_IDS = new Set(['topTuck', 'bottomTuck']);
const MAIN_PANEL_ID_PATTERN = /^P[1-4]$/;

/**
 * 面板標示 label map（Spec F1 m13）：分片 lid（topLidL/C/R 等）只在 C 片標一次
 * `top lid`／`bottom lid`；tuckLock=0 時單片 `topLid`/`bottomLid` 直接標同樣文字。
 * 內部分片 id（topLidL/R 等）不出現在模板文字——回傳 undefined 代表該面板不標示。
 */
function labelFor(panelId: string): string | undefined {
  if (MAIN_PANEL_ID_PATTERN.test(panelId)) return panelId;
  if (panelId === 'glue') return 'glue';
  if (TUCK_PANEL_IDS.has(panelId)) return 'tuck';
  if (DUST_FLAP_PANEL_IDS.has(panelId)) return 'dust flap';
  if (panelId === 'topLid' || panelId === 'topLidC') return 'top lid';
  if (panelId === 'bottomLid' || panelId === 'bottomLidC') return 'bottom lid';
  return undefined;
}

function fmt(value: number): string {
  // 不做小數捨入：String(value) 是 JS number→string 的最短可逆表示法
  // （Number(String(x)) === x 恆成立），SVG 字串經 DOMParser 解析回來的座標與
  // ArtworkLayout 原始浮點值逐 bit 相同——含插舌圓角弧點（Math.cos/sin 產生的長
  // 小數）也不失真，C1 測試才能用嚴格 toEqual 比對而非容差比對。
  return String(value);
}

function boundsCenter(polygon: LayoutPoint[]): LayoutPoint {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type HingedPanel = ArtworkLayoutPanel & { hinge: NonNullable<ArtworkLayoutPanel['hinge']> };

function hasHinge(panel: ArtworkLayoutPanel): panel is HingedPanel {
  return panel.hinge !== undefined;
}

interface CutEdge {
  panelId: string;
  a: LayoutPoint;
  b: LayoutPoint;
}

// 端點無序 canonical key：fmt 是最短可逆表示（同檔 fmt 註解），座標逐 bit 相同的
// 邊必得同 key——分片共享邊來自同一份 ArtworkLayout 浮點值，不需容差比對。
function edgeKey(a: LayoutPoint, b: LayoutPoint): string {
  const ka = `${fmt(a.x)},${fmt(a.y)}`;
  const kb = `${fmt(b.x)},${fmt(b.y)}`;
  return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/**
 * C9 問題 1 修法 A（edge dedup）：cut 只畫「所有 panel 中恰出現一次」的邊。
 * tuckLock 分片（topLidL/C/R 等）的內部邊界被相鄰分片各畫一次（出現 2 次）→
 * 不輸出，2D dieline 沒有的線不再滲進模板；body P1-P4／glue／dust flap 間的
 * 真摺邊同樣成對出現 → cut 不畫、僅剩 hinge crease（與 2D dieline 摺線語義一致）。
 * 已知殘留（非本輪回歸）：lid↔P3 等「單條長邊 vs 對側多段子邊」的邊界因分段
 * 不一致無法成對，仍以 cut 疊在 crease 下——與修法 A 裁定範圍一致，不擴大處理。
 */
function dedupCutEdges(panels: ArtworkLayoutPanel[]): CutEdge[] {
  const counts = new Map<string, number>();
  const edges: CutEdge[] = [];
  for (const panel of panels) {
    const polygon = panel.polygon;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      if (a.x === b.x && a.y === b.y) continue;
      const key = edgeKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      edges.push({ panelId: panel.id, a, b });
    }
  }
  return edges.filter((edge) => counts.get(edgeKey(edge.a, edge.b)) === 1);
}

export interface BuildTemplateSvgOptions {
  boxId: string;
  label: string;
  lang: Lang;
}

/**
 * 純函式：ArtworkLayout → 對位模板 SVG 字串。TEMPLATE_GUIDES 內含頁框／panel 外緣
 * cut 邊（edge dedup 後·共享邊不畫，見 dedupCutEdges）／hinge 摺線（crease）／
 * panel 標示／角落指示文字；空 ARTWORK group 殿後供使用者作畫（Spec F1.2＋C9 修正）。
 */
export function buildTemplateSvg(layout: ArtworkLayout, opts: BuildTemplateSvgOptions): string {
  const { frame, panels } = layout;
  const viewMinX = frame.minX - frame.offsetX;
  const viewMinY = frame.minY - frame.offsetY;
  const span = frame.span;
  const labelFontSize = span * 0.012;
  const instructionFontSize = span * 0.01;
  const inset = span * 0.015;

  const pageFrame = `<rect data-role="page-frame" x="${fmt(viewMinX)}" y="${fmt(viewMinY)}" `
    + `width="${fmt(span)}" height="${fmt(span)}" fill="none" `
    + `stroke="${LINE_STYLES.cut.stroke}" stroke-width="${fmt(PAGE_FRAME_STROKE_WIDTH)}" />`;

  const panelOutlines = dedupCutEdges(panels)
    .map((edge) => `<line data-panel-id="${escapeXml(edge.panelId)}" `
      + `x1="${fmt(edge.a.x)}" y1="${fmt(edge.a.y)}" x2="${fmt(edge.b.x)}" y2="${fmt(edge.b.y)}" `
      + `stroke="${LINE_STYLES.cut.stroke}" stroke-width="${fmt(LINE_STYLES.cut.strokeWidth)}" />`)
    .join('\n    ');

  const hingeLines = panels
    .filter(hasHinge)
    .map((panel) => {
      const dash = LINE_STYLES.crease.dasharray !== undefined
        ? ` stroke-dasharray="${LINE_STYLES.crease.dasharray}"`
        : '';
      return `<line data-hinge-panel-id="${escapeXml(panel.id)}" `
        + `x1="${fmt(panel.hinge.a.x)}" y1="${fmt(panel.hinge.a.y)}" `
        + `x2="${fmt(panel.hinge.b.x)}" y2="${fmt(panel.hinge.b.y)}" `
        + `stroke="${LINE_STYLES.crease.stroke}" stroke-width="${fmt(LINE_STYLES.crease.strokeWidth)}"${dash} />`;
    })
    .join('\n    ');

  const labels = panels
    .map((panel) => {
      const label = labelFor(panel.id);
      if (label === undefined) return '';
      const center = boundsCenter(panel.polygon);
      return `<text data-label-panel-id="${escapeXml(panel.id)}" x="${fmt(center.x)}" y="${fmt(center.y)}" `
        + `text-anchor="middle" dominant-baseline="middle" font-family="monospace" `
        + `font-size="${fmt(labelFontSize)}" fill="${GUIDE_TEXT_FILL}">${escapeXml(label)}</text>`;
    })
    .filter((entry) => entry !== '')
    .join('\n    ');

  const instructionText = `<text data-role="instructions" x="${fmt(viewMinX + inset)}" y="${fmt(viewMinY + inset)}" `
    + `font-family="monospace" font-size="${fmt(instructionFontSize)}" fill="${GUIDE_TEXT_FILL}">`
    + `${escapeXml(TEMPLATE_INSTRUCTIONS[opts.lang])}</text>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // 根 id 會成為 Illustrator 開檔時唯一圖層的名稱（C9 實測證實·原顯示「圖層 1」）
    `<svg id="TEMPLATE" xmlns="http://www.w3.org/2000/svg" data-box-id="${escapeXml(opts.boxId)}" `
      + `viewBox="${fmt(viewMinX)} ${fmt(viewMinY)} ${fmt(span)} ${fmt(span)}" `
      + `width="${fmt(span)}mm" height="${fmt(span)}mm">`,
    `  <title>${escapeXml(opts.label)}</title>`,
    '  <g id="TEMPLATE_GUIDES">',
    `    ${pageFrame}`,
    `    ${panelOutlines}`,
    `    ${hingeLines}`,
    `    ${labels}`,
    `    ${instructionText}`,
    '  </g>',
    '  <g id="ARTWORK"></g>',
    '</svg>',
  ].join('\n');
}

/** 檔名：`open-dieline-template-{boxId}-{L}x{W}x{D}.svg`（Spec F1 §3；L/W/D 取
 *  resolved params 數值原樣，不做小數格式化——v1 唯一盒型 rte 的預設值恆為整數）。
 *  L/W/D 缺一即以 '?' 佔位而非拋錯：telescope 等未來盒型未必宣告這三個 key（Non-goal
 *  範圍外先留防禦性 fallback，同 ExportBar.tsx buildFilename 的 hasDeclaredLWD 判斷
 *  精神，但本檔不 import ExportBar 私有函式，局部複製精簡版）。 */
export function buildTemplateFilename(boxId: string, values: ResolvedParams): string {
  const dim = (key: string): string => {
    const value = values[key];
    return value === undefined ? '?' : String(value);
  };
  return `open-dieline-template-${boxId}-${dim('L')}x${dim('W')}x${dim('D')}.svg`;
}

/** 角落 `<title>`／裝置無關的人類可讀盤標——同 ExportBar.tsx `plateReadout` 精神
 *  的局部複製版（該函式未匯出，本檔不動 ExportBar.tsx）。 */
function buildTemplateLabel(boxId: string, values: ResolvedParams): string {
  const dims = ['L', 'W', 'D'].map((key) => values[key]).filter((value) => value !== undefined);
  return dims.length === 3 ? `${boxId.toUpperCase()} ${dims.join(' × ')}` : boxId.toUpperCase();
}

/** Blob → object URL → 隱藏 `<a download>` → click → revoke，同 ExportBar.tsx
 *  `downloadBlob` 慣例（該函式未匯出，本檔局部複製一份，不動 ExportBar.tsx）。 */
function downloadBlob(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(link);
}

export interface DownloadTemplateOptions {
  model: FoldModel;
  boxId: string;
  values: ResolvedParams;
}

/**
 * 契約（Spec-M3 v2 F1/F1.0）：自 ArtworkLayout 名義攤平幾何生成 square-frame 模板
 * SVG（TEMPLATE_GUIDES ＋空 ARTWORK group）並觸發下載。lang 取當下 UI 語言
 * （`@/i18n/lang` `getLang()`）——呼叫端（FoldView）不需額外傳遞，同 ExportBar.tsx
 * 內部直接 `import { t }` 的既有慣例。
 */
export async function downloadTemplate(opts: DownloadTemplateOptions): Promise<void> {
  const layout = deriveArtworkLayout(opts.model);
  const svg = buildTemplateSvg(layout, {
    boxId: opts.boxId,
    label: buildTemplateLabel(opts.boxId, opts.values),
    lang: getLang(),
  });
  downloadBlob(svg, 'image/svg+xml;charset=utf-8', buildTemplateFilename(opts.boxId, opts.values));
}

/**
 * C9 問題 2（維護者裁 2026-07-18）：Illustrator 圖層腳本。SVG 格式先天無圖層元素，
 * Illustrator 開模板必得單一圖層＋群組（Adobe 私有編輯資料無法由網頁端生成）；
 * 本腳本在使用者端跑一次，把兩個頂層群組就地轉成真正的頂層圖層（ARTWORK 設為
 * 作用中——之後直接作畫即落入其中）。已於 Illustrator 2026 實測（c9-模板問題調查.md）。
 * 內嵌字串而非 public/ 靜態檔：同模組 lazy chunk、零額外資產管線、vitest 可直測內容。
 */
export const LAYER_SCRIPT_FILENAME = 'open-dieline-illustrator-layers.jsx';

export const LAYER_SCRIPT_JSX = `// open-dieline template helper: convert the template's top-level groups
// (ARTWORK / TEMPLATE_GUIDES) into real Illustrator layers.
// Usage: open the template SVG in Illustrator, then run this file via
// File > Scripts > Other Script... (Fn+F12). ARTWORK becomes the active layer.
(function () {
  if (app.documents.length === 0) {
    alert('Open the open-dieline template SVG first.');
    return;
  }
  var doc = app.activeDocument;
  var src = doc.layers[0];
  function norm(name) {
    return String(name || '').replace(/[_ ]/g, '').toUpperCase();
  }
  function findGroup(name) {
    for (var i = 0; i < src.groupItems.length; i++) {
      if (norm(src.groupItems[i].name) === norm(name)) return src.groupItems[i];
    }
    return null;
  }
  var guides = findGroup('TEMPLATE_GUIDES');
  if (guides === null) {
    alert('TEMPLATE_GUIDES group not found - is this an open-dieline template?');
    return;
  }
  var artwork = findGroup('ARTWORK');
  var guidesLayer = doc.layers.add();
  guidesLayer.name = 'TEMPLATE_GUIDES';
  for (var g = guides.pageItems.length - 1; g >= 0; g--) {
    guides.pageItems[g].move(guidesLayer, ElementPlacement.PLACEATBEGINNING);
  }
  guides.remove();
  var artworkLayer = doc.layers.add();
  artworkLayer.name = 'ARTWORK';
  if (artwork !== null) {
    for (var a = artwork.pageItems.length - 1; a >= 0; a--) {
      artwork.pageItems[a].move(artworkLayer, ElementPlacement.PLACEATBEGINNING);
    }
    artwork.remove();
  }
  if (src.pageItems.length === 0 && src.layers.length === 0) src.remove();
  doc.activeLayer = artworkLayer;
})();
`;

/** 觸發圖層腳本下載（.jsx 純文字·瀏覽器不解譯）。 */
export function downloadLayerScript(): void {
  downloadBlob(LAYER_SCRIPT_JSX, 'text/plain;charset=utf-8', LAYER_SCRIPT_FILENAME);
}
