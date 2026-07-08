/**
 * Overlay 狀態層（Slice 3 Task 4/5，spec §5）：管理使用者匯入的生產刀模 SVG 疊圖的顯示/校準
 * 狀態。純函式、UI 無關——OverlayPanel（匯入/控制項）與 Canvas（疊繪/校準 hit-test）負責把
 * 這裡的資料接到畫面，本檔不 import React 或任何 UI。
 *
 * OverlayState 是 session 級：不進 localStorage、不進匯出、不影響 GenerateResult（T3 的
 * `parseOverlaySvg` 輸出獨立疊在畫布最上層，是純顯示層，見 Canvas.tsx 疊繪處）。
 *
 * T5（點選校準，spec §5）在這裡加 `calibrateScale`（點選一段已知長度的線段定比例）與
 * `findNearestOverlaySegment`（校準模式 hit-test 純函式，供 Canvas.tsx 的點選事件呼叫）；
 * OverlayState 新增 `calibrating`／`calibrated` 兩個欄位（見下方型別定義）。
 */
import type { Bounds, Segment } from '@/core/geometry';
import { flattenBezier, segmentsBounds } from '@/core/geometry';
import type { OverlayParseResult } from './parse';

/**
 * overlay 疊繪固定描邊色。刻意不放進 `core/styles.ts` 的 `LINE_STYLES`——那份表是刀模線型
 * （cut/crease/halfcut/bleed/annotation/dimension）與其生成語意綁定的唯一樣式來源；overlay
 * 是「匯入對照用」的 UI 顯示層，跟盒型幾何生成完全無關，混進同一份表會誤導未來讀者以為它是
 * 一種刀模線型。（註：與 `LINE_STYLES.bleed` 剛好同色號是巧合，非本模組職責——bleed 目前沒有
 * 任何盒型生成過，不構成實際疊色衝突，見 task-4-report.md concerns。）
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
  /** overlay 座標 → mm 的比例。未校準過時＝ `initialScaleGuess` 的猜測值；點選校準完成後
   *  （T5，`calibrated` 為 true）＝ `calibrateScale` 算出的量測值。 */
  scale: number;
  /** mm，套在 scale 之後（見 `alignOffset` 與 Canvas 疊繪 transform 的套用順序：先 scale 再平移）。 */
  offsetX: number;
  offsetY: number;
  /** 0–1，預設 0.5。 */
  opacity: number;
  visible: boolean;
  /** `segmentsBounds(segments)`——未套 scale/offset 前的原始包絡，`alignOffset` 對齊計算用。 */
  rawBounds: Bounds;
  /** 是否處於「點選校準」互動模式（T5，spec §5）。校準模式的開關本身也存進這份共享狀態，
   *  因為 OverlayPanel（校準鈕）與 Canvas（hit-test／頂部提示條／游標）是平行兄弟元件，
   *  只有共同父層的 state 才能同步（跟 `scale`/`rawBounds` 等既有欄位同一個提升理由）。
   *  true 時 Canvas 對 overlay 線段開放點選 hit-test；false 時點選不做任何事。 */
  calibrating: boolean;
  /** 是否已完成過至少一次點選校準。影響單位下拉變更的優先順序（見 OverlayPanel.tsx
   *  `handleUnitChange`）：尚未校準時單位下拉直接重算 `scale`（T4 既有行為）；已校準後
   *  改為先提示使用者確認，避免無聲蓋掉量測得來的比例。 */
  calibrated: boolean;
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
 * - 'bbox'（brief 原文「raw×scale 的 bbox 對齊 target bbox 左上＋（若尺寸接近）中心微調」——
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
 * （見 task-4-report.md 的 rawBounds 決策記錄）。
 *
 * 不是 brief 字面列出的兩個函式之一，但屬於同一份「純函式、UI 無關」的 state 建構邏輯——
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
    calibrating: false,
    calibrated: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 Task 5：點選校準（spec §5「點選一段線、輸入實際 mm」）
// ─────────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/**
 * 線段自身「弦長」——使用者拿捲尺量的是實體兩點間的直線距離，不是曲線路徑長，因此 line／
 * bezier 取端點距，arc 也取起訖點的弦長（非弧長）。bezier 的控制點不影響這個值（brief 明文
 * 「都是弦、不是弧長」，只看兩端點）。
 *
 * 完整圓（arc 的 startAngle/endAngle 差恰為 2π 整數倍）弦長為 0，即使圓弧本身周長不為
 * 0——這是本模組刻意的設計選擇：`findNearestOverlaySegment` 用同一份定義判斷「零長段」
 * 並禁止選取（見下方），避免使用者選中一個弦長為 0 的完整圓後，`calibrateScale` 除以 0。
 */
function segmentChordLength(seg: Segment): number {
  if (seg.kind === 'arc') {
    const x1 = seg.cx + seg.r * Math.cos(seg.startAngle);
    const y1 = seg.cy + seg.r * Math.sin(seg.startAngle);
    const x2 = seg.cx + seg.r * Math.cos(seg.endAngle);
    const y2 = seg.cy + seg.r * Math.sin(seg.endAngle);
    return Math.hypot(x2 - x1, y2 - y1);
  }
  return Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
}

/**
 * 點選校準：線段自身弦長（見 `segmentChordLength`）對照使用者輸入的實際 mm，換算出
 * overlay 座標 → mm 的比例。呼叫端（Canvas.tsx 的校準確認流程）負責確保 `seg` 非零長
 * （`findNearestOverlaySegment` 的 hit-test 已排除零長段可選取）、`actualMm > 0`（UI 邊界
 * 檢查），這裡不重複驗證——校準流程的輸入合法性只在使用者互動的入口把關一次即可。
 */
export function calibrateScale(seg: Segment, actualMm: number): number {
  return actualMm / segmentChordLength(seg);
}

// 零長判定容差：跟 `core/geometry.ts` 的 `CROSS_EPS`（同一模組內既有慣例）同量級、同理由——
// arc 端點由三角函數重算，理論上重合的兩點（如完整圓的起訖點）最多差在 1e-10~1e-12 級浮點
// 雜訊，1e-6 遠高於雜訊量級，又遠低於任何刀模量測有意義的最小長度（0.01mm 等級）。
const ZERO_CHORD_EPS = 1e-6;

// arc 折線近似的取樣間隔（度）——跟 `core/geometry.ts` 內部（未 export）的 `flattenArc` 用
// 同一個 5° 步進值。geometry.ts 不在本 task 可修改檔案清單內、該函式也未 export，這裡照抄
// 一份精簡版（只回傳點陣列，不像 geometry.ts 那份還要組成 LineSegment[]）。取捨：兩份程式碼
// 重複的維護成本，換取不擴大本 task 的檔案改動範圍；若未來 geometry.ts 的取樣邏輯調整，這裡
// 不會自動同步，需要人工對照更新。
const ARC_HITTEST_STEP_DEG = 5;
const HITTEST_TWO_PI = 2 * Math.PI;

function normalizeHitTestAngle(a: number): number {
  return ((a % HITTEST_TWO_PI) + HITTEST_TWO_PI) % HITTEST_TWO_PI;
}

/** 把單一 arc segment 依 startAngle→endAngle 掃過的弧，每 ARC_HITTEST_STEP_DEG° 取樣成點陣列。 */
function flattenArcToPoints(seg: Extract<Segment, { kind: 'arc' }>): Pt[] {
  const rawSweep = seg.ccw ? seg.startAngle - seg.endAngle : seg.endAngle - seg.startAngle;
  let sweep = normalizeHitTestAngle(rawSweep);
  if (sweep < 1e-9 && Math.abs(rawSweep) > 1e-9) sweep = HITTEST_TWO_PI; // 差為 2π 整數倍 → 完整圓
  const stepRad = (ARC_HITTEST_STEP_DEG * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil(sweep / stepRad));
  const dir = seg.ccw ? -1 : 1;

  const points: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = seg.startAngle + dir * sweep * (i / steps);
    points.push({ x: seg.cx + seg.r * Math.cos(theta), y: seg.cy + seg.r * Math.sin(theta) });
  }
  return points;
}

/** 折線點陣列 → 相鄰點對，供 `pointToSegmentDistance` 逐段量測用。 */
function pointsToPairs(points: Pt[]): Array<[Pt, Pt]> {
  const pairs: Array<[Pt, Pt]> = [];
  for (let i = 0; i < points.length - 1; i++) pairs.push([points[i]!, points[i + 1]!]);
  return pairs;
}

/** 單一 Segment 的折線近似（hit-test 用）：line 兩端點原樣；arc 5° 步進取樣；bezier 沿用
 *  既有 `flattenBezier`（`core/geometry.ts` 已 export，T5 brief 明文可直接用）。 */
function segmentToHitTestPairs(seg: Segment): Array<[Pt, Pt]> {
  if (seg.kind === 'line') {
    return [[{ x: seg.x1, y: seg.y1 }, { x: seg.x2, y: seg.y2 }]];
  }
  if (seg.kind === 'arc') {
    return pointsToPairs(flattenArcToPoints(seg));
  }
  return flattenBezier(seg).map((l): [Pt, Pt] => [
    { x: l.x1, y: l.y1 },
    { x: l.x2, y: l.y2 },
  ]);
}

/** 點 p 到線段 [a,b] 的最短距離；垂足落在線段範圍外時退回較近的端點距離。 */
function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y); // a===b（零長折線片段）：退化成點距
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface OverlayHitTestResult {
  /** 命中的線段在傳入 `segments` 陣列中的 index。 */
  index: number;
  /** 點到該線段的最短距離——與呼叫端傳入的 `point`／`thresholdRaw` 同一座標系（呼叫端決定）。 */
  distance: number;
}

/**
 * 校準模式 hit-test：在 `point` 所在座標系（呼叫端決定——Canvas.tsx 傳入 overlay **原始
 * 座標系**下的點，見該檔座標鏈註解）中，找離 `point` 最近、且距離在 `thresholdRaw` 以內的
 * 線段。line 直接算點到線段距離；arc/bezier 先折線近似（見 `segmentToHitTestPairs`）再取
 * 所有折線片段中的最小距離。
 *
 * 零長線段（弦長 < `ZERO_CHORD_EPS`，定義同 `calibrateScale` 的 `segmentChordLength`）直接
 * 跳過、永遠不會被判定為「最近」——呼應 brief「選中零長段→忽略點擊」：與其讓使用者先選中
 * 一個零長線段、下一步輸入 mm 時才發現 `calibrateScale` 除以 0，這裡在 hit-test 本身就排除，
 * 兩處共用同一份長度定義，語意一致。找不到落在閾值內的線段（或全部線段皆零長）回傳 null。
 */
export function findNearestOverlaySegment(segments: Segment[], point: Pt, thresholdRaw: number): OverlayHitTestResult | null {
  let best: OverlayHitTestResult | null = null;
  segments.forEach((seg, index) => {
    if (segmentChordLength(seg) < ZERO_CHORD_EPS) return;
    const pairs = segmentToHitTestPairs(seg);
    const distance = Math.min(...pairs.map(([a, b]) => pointToSegmentDistance(point, a, b)));
    if (distance <= thresholdRaw && (best === null || distance < best.distance)) {
      best = { index, distance };
    }
  });
  return best;
}
