/**
 * Overlay 純函式層（Slice 3 Task 4/5，spec §5；Slice 3 gate round 1 T2 起單一疊圖模型退役）：
 * 比例猜測／對齊／點選校準的純函式，供 `overlay/layers.ts` 的 `OverlayLayer`（多層資料模型，
 * 取代本檔曾有的單一 `OverlayState`/`createOverlayState`）與 UI（LayersPanel 控制項、Canvas
 * 疊繪/校準 hit-test）共同消費。純函式、UI 無關，本檔不 import React 或任何 UI。
 *
 * 這些函式描述的資料是 session 級：不進 localStorage、不進匯出、不影響 GenerateResult
 * （`parseOverlaySvg` 輸出獨立疊在畫布最上層，是純顯示層，見 Canvas.tsx 疊繪處）。
 *
 * `calibrateScale`（點選一段已知長度的線段定比例）與 `findNearestOverlaySegment`（校準模式
 * hit-test 純函式，供 Canvas.tsx 的點選事件呼叫）為 T5 加入；「calibrating」（是否處於校準
 * 互動模式）與「calibrated」（是否已完成過校準）這兩個狀態欄位，在多層模型下分別搬到
 * App.tsx 的獨立 `calibrating` state（跨層共用同一個開關，T1 的 `LayersState` 未收錄這個
 * 欄位）與 `OverlayLayer.calibrated`（逐層各自紀錄，見 `overlay/layers.ts`）。
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

const UNIT_TO_MM: Record<'pt' | 'mm' | 'px', number> = {
  pt: 0.352778,
  mm: 1,
  px: 25.4 / 96,
};

/** width 屬性帶 mm/pt 單位字尾（如 "200mm"）時的偵測 pattern；只認這兩種——px 與純數字（SVG
 *  慣例常省略單位）一律回退用 unit 下拉值，那是使用者當下唯一的判斷依據。 */
const WIDTH_UNIT_SUFFIX_RE = /(mm|pt)$/i;

/** viewBox="minX minY width height" 字串 → width 分量（FX6 用：width 帶單位字尾且有 viewBox
 *  時，scale 要拿 viewBox 的寬度做分母，見 `initialScaleGuess` 下方分支）。分隔符可能是空白
 *  或逗號（SVG spec 皆合法），不假設固定用哪一種；格式不是合法的 4 個數字時回傳 null，讓
 *  呼叫端安全退回舊行為，不 throw、不產生 NaN。 */
function parseViewBoxWidth(viewBox: string): number | null {
  const nums = viewBox.trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => Number.isNaN(n))) return null;
  return nums[2]!;
}

/**
 * overlay 座標 → mm 的初始比例猜測。`sourceInfo.widthAttr` 帶 mm/pt 單位字尾時優先自動判定
 * （覆蓋 `unit` 參數，這是生產 SVG 少數自帶單位資訊的欄位，比使用者手動選的下拉更可信）；
 * 否則採用 `unit` 下拉選的比例（pt→×0.352778、mm→×1、px→×(25.4/96)）。
 *
 * FX6（Slice 3 final review，規格修正）：width 帶單位字尾時，若同時有 `viewBox`，scale 不能
 * 只看字尾本身——那等於假設「1 個 SVG 使用者單位＝1 個字尾單位」，只在「沒有 viewBox（或
 * viewBox 尺寸恰好等於 width 數值）」時成立。Illustrator 標準匯出常見
 * `width="210mm" viewBox="0 0 595.28 841.89"`：width 的 210mm 是紙張實體尺寸，viewBox 座標
 * 其實是 72dpi 的 pt 使用者單位（595.28pt×0.352778≈210mm 才對得上）——字尾「mm」描述的是
 * *實體尺寸*的單位，不是*座標系*的單位，這是修前 brief 規格本身的漏洞（誤把「width 字尾優先」
 * 讀成「字尾＝座標系比例」）。正確語意：`scale＝(width 數值換算成 mm) ÷ viewBox 寬度`
 * （此例 210÷595.28≈0.352775，非任意巧合——viewBox 寬度就是拿 210mm 除以「Illustrator 認定
 * 的 1pt=0.3528mm」反推出來的 72dpi 座標值）。
 *
 * 沒有 viewBox、或 viewBox 格式無法解析（`parseViewBoxWidth` 回傳 null）、或解析出的寬度
 * ≤0 時，沒有座標系寬度可除，安全退回修前的字尾判定（`UNIT_TO_MM[detected]`，假設使用者
 * 單位＝字尾單位）——不 throw、不產生 NaN／Infinity。width 無單位字尾時無論有無 viewBox
 * 都維持現行下拉單位：沒有字尾就沒有「實體尺寸」的可信來源，只能信使用者手動選的下拉，
 * 這不是本次規格修正的範圍。
 */
export function initialScaleGuess(sourceInfo: OverlayParseResult['sourceInfo'], unit: 'pt' | 'mm' | 'px'): number {
  const widthAttr = sourceInfo.widthAttr?.trim() ?? '';
  const suffixMatch = WIDTH_UNIT_SUFFIX_RE.exec(widthAttr);
  if (suffixMatch) {
    const detected = suffixMatch[1]!.toLowerCase() as 'mm' | 'pt';
    const numericWidth = Number(widthAttr.slice(0, suffixMatch.index));
    const viewBoxWidth = sourceInfo.viewBox ? parseViewBoxWidth(sourceInfo.viewBox) : null;
    if (viewBoxWidth !== null && viewBoxWidth > 0 && !Number.isNaN(numericWidth)) {
      return (numericWidth * UNIT_TO_MM[detected]) / viewBoxWidth;
    }
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

// createOverlayState（單一 OverlayState 建構函式）已於 Slice 3 gate round 1 T2 隨 OverlayPanel
// →LayersPanel 遷移退役——等價邏輯（scale/rawBounds/opacity/visible/calibrated 預設值＋
// segments 不預變換）由 `overlay/layers.ts` 的 `createOverlayLayer` 取代（多一個置中 offset
// 與 id 參數，見該檔文件）。`initialScaleGuess`／`segmentsBounds` 兩個純函式本身不受影響，
// 繼續被 `createOverlayLayer` 消費。

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
 *
 * 補述（FX1，Slice 3 final review）：`overlay/parse.ts` 的 `circleToSegments` 把匯入的
 * `<circle>` 拆成兩個半圓 arc（0→π、π→2π；不再用單一 startAngle=0/endAngle=2π 的完整圓，
 * 那種表示法餵給 Canvas 的 SVG `A` 指令渲染是零渲染，見 parse.ts 該函式文件的完整推導）。
 * 這個拆法的副作用：每個半圓的起訖點是圓上正對的兩點，`segmentChordLength` 算出來的弦長
 * 恰為該圓的直徑——使用者校準生產圖裡的圓孔時，可以直接點選其中一段半圓弧、輸入實測的
 * 孔徑（直徑）當作 `actualMm`，不需要額外的「圓專屬」校準路徑。
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
