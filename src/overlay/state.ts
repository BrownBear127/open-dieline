/**
 * Overlay 狀態層（Slice 3 Task 4，spec §5）：管理使用者匯入的生產刀模 SVG 疊圖的顯示/校準
 * 狀態。純函式、UI 無關——OverlayPanel（匯入/控制項）與 Canvas（疊繪）負責把這裡的資料接到
 * 畫面，本檔不 import React 或任何 UI。
 *
 * OverlayState 是 session 級：不進 localStorage、不進匯出、不影響 GenerateResult（T3 的
 * `parseOverlaySvg` 輸出獨立疊在畫布最上層，是純顯示層，見 Canvas.tsx 疊繪處）。
 *
 * T5（下一個 task）會在這裡加 `calibrateScale`（點選兩點定比例）並在 Canvas 加校準
 * hit-test；本檔目前刻意不做任何校準相關邏輯（YAGNI），介面維持精簡以利該擴充——見
 * `initialScaleGuess`／單位下拉 recompute 邏輯的「尚無校準」註記。
 */
import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { OverlayParseResult } from './parse';

/**
 * overlay 疊繪固定描邊色。刻意不放進 `core/styles.ts` 的 `LINE_STYLES`——那份表是刀模線型
 * （cut/crease/halfcut/bleed/annotation/dimension）與其生成語意綁定的唯一樣式來源；overlay
 * 是「匯入對照用」的 UI 顯示層，跟盒型幾何生成完全無關，混進同一份表會誤導未來讀者以為它是
 * 一種刀模線型。（註：與 `LINE_STYLES.bleed` 剛好同色號是巧合，非本模組職責——bleed 目前沒有
 * 任何盒型生成過，不構成實際疊色衝突，見 開發紀錄 concerns。）
 */
export const OVERLAY_STROKE = '#FF00FF';

/** 透明度滑桿的預設值（0–1 比例，UI 顯示為 50%）。 */
const DEFAULT_OVERLAY_OPACITY = 0.5;

export interface OverlayState {
  /** parse 原始輸出，不預先套用 scale/offset——渲染時（Canvas 的 `<g transform>`）才套用，
   *  維持「segments 是使用者匯入檔案的忠實記錄」不變式，方便切換單位或（T5）重新校準時
   *  重算顯示位置，不需要重新解析 SVG 檔案。 */
  segments: Segment[];
  warnings: string[];
  /** overlay 座標 → mm 的比例（校準結果；T4 尚無校準機制時＝ `initialScaleGuess` 的猜測值）。 */
  scale: number;
  /** mm，套在 scale 之後（見 `alignOffset` 與 Canvas 疊繪 transform 的套用順序：先 scale 再平移）。 */
  offsetX: number;
  offsetY: number;
  /** 0–1，預設 0.5。 */
  opacity: number;
  visible: boolean;
  /** `segmentsBounds(segments)`——未套 scale/offset 前的原始包絡，`alignOffset` 對齊計算用。 */
  rawBounds: Bounds;
}

const UNIT_TO_MM: Record<'pt' | 'mm' | 'px', number> = {
  pt: 0.352778,
  mm: 1,
  px: 25.4 / 96,
};

/** width 屬性帶 mm/pt 單位字尾（如 "200mm"）時的偵測 pattern；只認這兩種——px 與純數字（SVG
 *  慣例常省略單位）一律回退用 unit 下拉值，那是使用者當下唯一的判斷依據。 */
const WIDTH_UNIT_SUFFIX_RE = /(mm|pt)$/i;

/**
 * overlay 座標 → mm 的初始比例猜測。`sourceInfo.widthAttr` 帶 mm/pt 單位字尾時優先自動判定
 * （覆蓋 `unit` 參數，這是生產 SVG 少數自帶單位資訊的欄位，比使用者手動選的下拉更可信）；
 * 否則採用 `unit` 下拉選的比例（pt→×0.352778、mm→×1、px→×(25.4/96)）。
 */
export function initialScaleGuess(sourceInfo: OverlayParseResult['sourceInfo'], unit: 'pt' | 'mm' | 'px'): number {
  const widthAttr = sourceInfo.widthAttr?.trim() ?? '';
  const suffixMatch = WIDTH_UNIT_SUFFIX_RE.exec(widthAttr);
  if (suffixMatch) {
    const detected = suffixMatch[1]!.toLowerCase() as 'mm' | 'pt';
    return UNIT_TO_MM[detected];
  }
  return UNIT_TO_MM[unit];
}

// 'bbox' 快速對齊模式的「尺寸接近」判準：scaled raw 尺寸與 target 尺寸差距在 target 尺寸的
// 5% 以內視為接近（每軸獨立判斷，不是整體面積）。見 alignOffset 的 'bbox' 分支 docblock。
const BBOX_SIZE_CLOSE_TOLERANCE = 0.05;

/** 單一軸（X 或 Y）的對齊位移：尺寸接近時用中心對齊、否則退回左上（該軸 raw min 對齊 target min）。 */
function axisAlignOffset(rawMin: number, rawMax: number, scale: number, targetMin: number, targetMax: number): number {
  const scaledRawSize = (rawMax - rawMin) * scale;
  const targetSize = targetMax - targetMin;
  const isClose = targetSize > 0 && Math.abs(scaledRawSize - targetSize) <= targetSize * BBOX_SIZE_CLOSE_TOLERANCE;
  if (isClose) {
    const rawCenter = ((rawMin + rawMax) / 2) * scale;
    const targetCenter = (targetMin + targetMax) / 2;
    return targetCenter - rawCenter;
  }
  return targetMin - rawMin * scale;
}

/**
 * 疊圖對齊位移計算：`raw`（overlay 原始 bounds，未套 scale/offset）套用 `scale` 後，
 * 對齊 `target`（目前畫布顯示的刀模 bounds）。
 *
 * - 'top-left'：raw×scale 的左上角（minX,minY）對齊 target 左上角。
 * - 'center'：raw×scale 的幾何中心對齊 target 中心。
 * - 'bbox'（spec 原文「raw×scale 的 bbox 對齊 target bbox 左上＋（若尺寸接近）中心微調」——
 *   實作定義如下，寫入本 docblock 供後續維護者對照）：X/Y 兩軸**各自獨立**判斷，scaled raw
 *   尺寸與 target 尺寸差距在 target 尺寸 5% 以內時，該軸改用中心對齊；否則該軸維持左上對齊
 *   （見 `axisAlignOffset`）。per-axis 判斷比「整體尺寸是否接近」更貼合實際使用情境——生產
 *   檔案常常只有一個維度（如寬度）跟目前參數精確吻合、另一個維度因為出血/量測誤差略有落差，
 *   per-axis 讓吻合的那一軸享受置中的視覺效果，不吻合的那一軸退回左上對齊，比「整體強制同一種
 *   模式」更少意外位移。兩軸都接近時效果等同 'center'；兩軸都不接近時效果等同 'top-left'。
 */
export function alignOffset(
  raw: Bounds,
  scale: number,
  target: Bounds,
  mode: 'top-left' | 'center' | 'bbox',
): { offsetX: number; offsetY: number } {
  if (mode === 'center') {
    const rawCenterX = ((raw.minX + raw.maxX) / 2) * scale;
    const rawCenterY = ((raw.minY + raw.maxY) / 2) * scale;
    return {
      offsetX: (target.minX + target.maxX) / 2 - rawCenterX,
      offsetY: (target.minY + target.maxY) / 2 - rawCenterY,
    };
  }
  if (mode === 'bbox') {
    return {
      offsetX: axisAlignOffset(raw.minX, raw.maxX, scale, target.minX, target.maxX),
      offsetY: axisAlignOffset(raw.minY, raw.maxY, scale, target.minY, target.maxY),
    };
  }
  // 'top-left'
  return { offsetX: target.minX - raw.minX * scale, offsetY: target.minY - raw.minY * scale };
}

/**
 * 從 `parseOverlaySvg` 的輸出建構初始 `OverlayState`：scale 用 `initialScaleGuess`（呼叫當下
 * unit 下拉的選擇）、offset 歸零（尚未對齊）、opacity 用預設 0.5、visible 預設開、rawBounds
 * 用 `core/geometry.ts` 既有的 `segmentsBounds`——RTE 的 bounds 計算與 ExportBar 的單片製造
 * 尺寸（`pieceManufacturingBounds`）都已經在用同一函式，不另外自寫一份：它對 line/arc 給出
 * 精確包絡、對 bezier 給出控制多邊形包絡，精度已優於「對齊用途不需 tight bounds」的最低要求
 * （見 開發紀錄 的 rawBounds 決策記錄）。
 *
 * 不是 spec 字面列出的兩個函式之一，但屬於同一份「純函式、UI 無關」的 state 建構邏輯——
 * 抽出來讓 OverlayPanel.tsx 的檔案匯入 handler 保持薄，且這段邏輯本身可獨立單元測試。
 */
export function createOverlayState(parseResult: OverlayParseResult, unit: 'pt' | 'mm' | 'px'): OverlayState {
  return {
    segments: parseResult.segments,
    warnings: parseResult.warnings,
    scale: initialScaleGuess(parseResult.sourceInfo, unit),
    offsetX: 0,
    offsetY: 0,
    opacity: DEFAULT_OVERLAY_OPACITY,
    visible: true,
    rawBounds: segmentsBounds(parseResult.segments),
  };
}
