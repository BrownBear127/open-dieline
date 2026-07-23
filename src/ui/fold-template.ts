/**
 * 對位模板 builder。
 * 自 ArtworkLayout 補償後真刀模攤平幾何生成 square-frame
 * 模板 SVG（TEMPLATE_GUIDES ＋空 ARTWORK group）並觸發下載。lazy import 專用
 * ——本模組禁被 main 靜態 import（main bundle 只做接線的分包原則）。
 *
 * `buildTemplateSvg` 是純函式（layout+opts → SVG 字串）；`downloadTemplate` 是唯一
 * 有副作用的入口（deriveArtworkLayout → buildTemplateSvg → Blob 下載，慣例同
 * `src/ui/ExportBar.tsx` 的 downloadBlob，但那份是私有函式、`src/ui/` 未鎖故本檔
 * 局部複製一份精簡版，不動 ExportBar.tsx）。
 *
 * 座標系：SVG 直接畫 ArtworkLayout 的原始 mm 座標（不做 UV 正規化）——viewBox 用
 * `[minX-offsetX, minY-offsetY, span, span]` 承接 offset，面板點/hinge 端點原樣輸出。
 * 這與 3D UV 映射（`fold-scene.ts` 的 `flatUv`：u=(x-minX+offsetX)/span,
 * v=1-(y-minY+offsetY)/span）是同一個 frame 的兩種表現形式——
 * `tests/fold-ui/fold-template.test.ts` 逐點驗證兩者換算一致。
 */
import { dimensionKeys } from '@/core/registry';
import type { Segment } from '@/core/geometry';
import type { ResolvedParams } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import type { FoldModel } from '@/fold/types';
import type { Lang } from '@/i18n/lang';
import { getLang } from '@/i18n/lang';
import type { ArtworkLayout, ArtworkLayoutPanel } from './artwork-layout';
import {
  artworkLayoutSignatureFromLayout,
  deriveArtworkLayout,
  hashArtworkLayoutSignature,
} from './artwork-layout';

type LayoutPoint = ArtworkLayoutPanel['polygon'][number];

// 頁框細線比 panel 外緣細一半——視覺上跟「真正的刀線」區分，但色碼仍取自
// LINE_STYLES.cut（僅 cut/crease 兩色白名單，頁框不是獨立第三色，線寬取半）。
const PAGE_FRAME_STROKE_WIDTH = LINE_STYLES.cut.strokeWidth / 2;
// 面板標示／角落指示文字共用的淡灰色——規格要求「中心淡灰 mono 小字」，數值
// 本身無既有色票可同源（不是 LINE_STYLES 的四色之一，文字不算「線型」不受色碼
// 白名單限制），選定一個與 core/styles.ts LINE_STYLES.annotation 相近但更淺的
// 灰階，避免與畫布既有 annotation 語意混淆。
const GUIDE_TEXT_FILL = '#9a968f';

// Illustrator 開啟 SVG 時群組不可直接作畫（新繪物件落在作用中圖層頂端），且上傳
// 管線不解析群組結構——操作指示只講兩件硬需求（匯出前關閉 GUIDES 顯示＋保留整
// 頁），末尾附上模板出處。
// 上傳對位 guard-rail 操作指示包含「轉存時勾選使用工作區域」——Illustrator 匯出 SVG
// 若不勾選 Use Artboards，viewBox 會被改寫成可見物件邊界（而非整頁），是頁框錨定與 stale 偵測要防的根因
// 的源頭；guard-rail（頁框錨定＋警示）是事後補救，這句是事前預防，兩者互補。
const TEMPLATE_INSTRUCTIONS: Record<Lang, string> = {
  en: 'Paint anywhere on the page. Hide TEMPLATE_GUIDES before exporting, keep the full square page, and check “Use Artboards” on export. Made with open-dieline · dieline.konvolut.art',
  zh: '作畫位置不限，匯出前請關閉 TEMPLATE_GUIDES 顯示，保留完整正方形頁面，並在轉存時勾選『使用工作區域』。　以 open-dieline 製作 · dieline.konvolut.art',
};

const DUST_FLAP_PANEL_IDS = new Set(['topDustP2', 'topDustP4', 'bottomDustP2', 'bottomDustP4']);
const TUCK_PANEL_IDS = new Set(['topTuck', 'bottomTuck']);
const MAIN_PANEL_ID_PATTERN = /^P[1-4]$/;

/** 面板標示 label map；回傳 undefined 代表該面板不標示。 */
function labelFor(panelId: string): string | undefined {
  if (MAIN_PANEL_ID_PATTERN.test(panelId)) return panelId;
  if (panelId === 'glue') return 'glue';
  if (TUCK_PANEL_IDS.has(panelId)) return 'tuck';
  if (DUST_FLAP_PANEL_IDS.has(panelId)) return 'dust flap';
  if (panelId === 'topLid') return 'top lid';
  if (panelId === 'bottomLid') return 'bottom lid';
  return undefined;
}

function fmt(value: number): string {
  // 不做小數捨入：String(value) 是 JS number→string 的最短可逆表示法
  // （Number(String(x)) === x 恆成立），SVG 字串經 DOMParser 解析回來的座標與
  // ArtworkLayout 原始浮點值逐 bit 相同——含插舌圓角弧點（Math.cos/sin 產生的長
  // 小數）也不失真，測試才能用嚴格 toEqual 比對而非容差比對。
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

function segmentStart(segment: Segment): LayoutPoint {
  if (segment.kind === 'arc') {
    return {
      x: segment.cx + segment.r * Math.cos(segment.startAngle),
      y: segment.cy + segment.r * Math.sin(segment.startAngle),
    };
  }
  return { x: segment.x1, y: segment.y1 };
}

function segmentEnd(segment: Segment): LayoutPoint {
  if (segment.kind === 'arc') {
    return {
      x: segment.cx + segment.r * Math.cos(segment.endAngle),
      y: segment.cy + segment.r * Math.sin(segment.endAngle),
    };
  }
  return { x: segment.x2, y: segment.y2 };
}

function dielineSegmentSvg(
  pathId: string,
  type: 'cut' | 'crease',
  segment: Segment,
  segmentIndex: number,
): string {
  const style = LINE_STYLES[type];
  const data = `data-dieline-path-id="${escapeXml(pathId)}" data-dieline-segment-index="${segmentIndex}" `
    + `data-dieline-kind="${segment.kind}" data-dieline-type="${type}"`;
  const dash = style.dasharray === undefined ? '' : ` stroke-dasharray="${style.dasharray}"`;
  const paint = `fill="none" stroke="${style.stroke}" stroke-width="${fmt(style.strokeWidth)}"${dash}`;

  if (segment.kind === 'line') {
    return `<line ${data} x1="${fmt(segment.x1)}" y1="${fmt(segment.y1)}" `
      + `x2="${fmt(segment.x2)}" y2="${fmt(segment.y2)}" ${paint} />`;
  }
  if (segment.kind === 'bezier') {
    const d = `M${fmt(segment.x1)},${fmt(segment.y1)} C${fmt(segment.c1x)},${fmt(segment.c1y)} `
      + `${fmt(segment.c2x)},${fmt(segment.c2y)} ${fmt(segment.x2)},${fmt(segment.y2)}`;
    return `<path ${data} data-x1="${fmt(segment.x1)}" data-y1="${fmt(segment.y1)}" `
      + `data-c1x="${fmt(segment.c1x)}" data-c1y="${fmt(segment.c1y)}" `
      + `data-c2x="${fmt(segment.c2x)}" data-c2y="${fmt(segment.c2y)}" `
      + `data-x2="${fmt(segment.x2)}" data-y2="${fmt(segment.y2)}" d="${d}" ${paint} />`;
  }
  const start = segmentStart(segment);
  const end = segmentEnd(segment);
  const sweep = segment.ccw ? 0 : 1;
  const d = `M${fmt(start.x)},${fmt(start.y)} A${fmt(segment.r)},${fmt(segment.r)} 0 0,${sweep} `
    + `${fmt(end.x)},${fmt(end.y)}`;
  return `<path ${data} data-cx="${fmt(segment.cx)}" data-cy="${fmt(segment.cy)}" `
    + `data-r="${fmt(segment.r)}" data-start-angle="${fmt(segment.startAngle)}" `
    + `data-end-angle="${fmt(segment.endAngle)}" data-ccw="${segment.ccw}" `
    + `d="${d}" ${paint} />`;
}

export interface BuildTemplateSvgOptions {
  boxId: string;
  label: string;
  lang: Lang;
}

/**
 * 純函式：ArtworkLayout → 對位模板 SVG 字串。TEMPLATE_GUIDES 內含頁框、完整 2D dieline、
 * panel 標示及角落指示文字；空 ARTWORK group
 * 供使用者作畫。
 */
export function buildTemplateSvg(layout: ArtworkLayout, opts: BuildTemplateSvgOptions): string {
  const { frame, panels, dieline } = layout;
  const viewMinX = frame.minX - frame.offsetX;
  const viewMinY = frame.minY - frame.offsetY;
  const span = frame.span;
  const labelFontSize = span * 0.012;
  const instructionFontSize = span * 0.01;
  const inset = span * 0.015;

  const pageFrame = `<rect data-role="page-frame" x="${fmt(viewMinX)}" y="${fmt(viewMinY)}" `
    + `width="${fmt(span)}" height="${fmt(span)}" fill="none" `
    + `stroke="${LINE_STYLES.cut.stroke}" stroke-width="${fmt(PAGE_FRAME_STROKE_WIDTH)}" />`;

  const dielineGuides = dieline.flatMap((path) => path.segments.map((segment, segmentIndex) =>
    dielineSegmentSvg(path.id, path.type, segment, segmentIndex))).join('\n    ');

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

  // data-layout-hash＝本 layout 簽章的 hash（與 artwork-source.ts 上傳路徑
  // 共用同一顆 artworkLayoutSignatureFromLayout／hashArtworkLayoutSignature），供上傳時
  // 偵測「模板下載後參數又變了」的 stale case（不必等使用者上傳後再對比目前 model）。
  const layoutHash = hashArtworkLayoutSignature(artworkLayoutSignatureFromLayout(layout));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // 根 id 會成為 Illustrator 開檔時唯一圖層的名稱（否則預設顯示「圖層 1」）
    `<svg id="TEMPLATE" xmlns="http://www.w3.org/2000/svg" data-box-id="${escapeXml(opts.boxId)}" `
      + `data-layout-hash="${layoutHash}" `
      + `viewBox="${fmt(viewMinX)} ${fmt(viewMinY)} ${fmt(span)} ${fmt(span)}" `
      + `width="${fmt(span)}mm" height="${fmt(span)}mm">`,
    `  <title>${escapeXml(opts.label)}</title>`,
    '  <g id="TEMPLATE_GUIDES">',
    `    ${pageFrame}`,
    `    ${dielineGuides}`,
    `    ${labels}`,
    `    ${instructionText}`,
    '  </g>',
    '  <g id="ARTWORK"></g>',
    '</svg>',
  ].join('\n');
}

/** 檔名：`open-dieline-template-{boxId}-{dims}.svg`（依盒型通用化，非硬編 L/W/D）。
 *  `dims` 由 `dimensionKeys()` 決定的欄位序列組成（rte／ttsl 為 `{L}x{W}x{D}`、ttb 為
 *  `{edgeA}x{tubeLength}`），數值取 resolved params 原樣、不做小數格式化。序列為空
 *  （目前三個已註冊 fold 盒型皆不會發生）時退化為 '?x?x?'——同 telescope 等未來盒型未必
 *  宣告尺寸欄位的防禦性 fallback 精神（同 ExportBar.tsx buildFilename 的 hasDeclaredLWD
 *  判斷精神，但本檔不 import ExportBar 私有函式，局部複製精簡版）。 */
export function buildTemplateFilename(boxId: string, values: ResolvedParams): string {
  const dim = (key: string): string => {
    const value = values[key];
    return value === undefined ? '?' : String(value);
  };
  const keys = dimensionKeys(boxId);
  const dims = keys.length > 0 ? keys.map(dim).join('x') : '?x?x?';
  return `open-dieline-template-${boxId}-${dims}.svg`;
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
 * 自 ArtworkLayout 補償後真刀模攤平幾何生成 square-frame 模板
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
