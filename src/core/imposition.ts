/**
 * 拼版估算純計算核心：resolveWorkingSheet／fitCount／computeImposition。
 *
 * 純 TS 模組——不 import React、`export/*`、或 `boxes/*` 任何模組，只吃/吐數字。
 * 呼叫端（UI 或整合測試）自行準備 pieceW/pieceH（透過 `core/bounds.ts` 的
 * `manufacturingBounds` 取得製造 bounds 寬高，見該模組 docblock「不得直接使用
 * `GenerateResult.bounds`／`DielinePiece.bounds`」的理由——declared bounds 含畫布
 * 留白／標註外擴，會讓拼版模數算錯）與 paperW/paperH（preset 或自訂）後餵進來。
 * 座標單位一律 mm。
 *
 * 依據：docs/specs/2026-07-10-imposition-design.md §紙規與 working sheet 轉換鏈
 * （review F4）、§計算（review F5）、§輸入 domain（review F3）。gate round 1 T1（cutV/cutH
 * 可疊加＋L 形 90° 補排）取代原本的 `SheetMode` 三選一，詳見各介面/函式 docblock。
 */

export interface PaperPreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

/**
 * 常用紙規 preset（mm 標稱值沿用台灣紙業慣例，spec F4 維護者定案）：
 * 31"×43"／25"×35"／27"×39"。UI 選單的「自訂」輸入不在此常數內，由呼叫端另行處理。
 */
export const PAPER_PRESETS: readonly PaperPreset[] = [
  { id: '31x43', label: '31"×43"', w: 787, h: 1092 },
  { id: '25x35', label: '25"×35"', w: 635, h: 889 },
  { id: '27x39', label: '27"×39"', w: 686, h: 991 },
];

/**
 * fitCount footprint 判準的浮點容差——只吸收浮點噪音，不吸收實際公差（spec F5）。
 * 依據：件寬 30、gap 3.1、可用區 228.6 時 7 件的 footprint 理論上恰為 228.6，但
 * `7*30+6*3.1` 與可用區 228.6 兩邊在 IEEE754 double 各自帶浮點噪音、方向不保證一致，
 * 裸比較（`<=`, 無 epsilon）會誤判「超額」而少算一模。
 *
 * 已知語意界（gate round 1 SOL review·Record only）：絕對 epsilon 在 MIN_DIMENSION_MM
 * （0.01mm）尺度的件下不再是「噪音級」——如件寬 0.01、可用差額 0.0099995 時會多算一件。
 * 該尺度的刀模物理上不存在（安全界是防護欄不是使用範圍），且本工具是估算示範（免責
 * 聲明明示不可直接生產），故不為此改用 ULP 容差（會動 exact-fit 全部錨定）。
 */
export const FIT_EPSILON_MM = 1e-6;

/** 排列預覽的 instance 上限（review F10，T3 消費）；超過時預覽簡化，count 仍精確顯示。 */
export const MAX_PREVIEW_INSTANCES = 500;

/** 刀線間距硬下限（表廠規·spec 輸入 domain，F3）：低於此值視為 domain error，不予計算。 */
export const MIN_GAP_MM = 3;

/**
 * 尺寸安全界（T2 review F1）：「finite」不足以保證可安全計算——JS 的 finite 輸入仍可能
 * 上溢／下溢／超出整數精度。反例：`paperW=paperH=1e20`（gripper=0、piece=1、gap=3 皆合法）
 * 會讓 `fitCount` 的初值落在 IEEE-754 `n+1===n` 精度極限，上修迴圈永不終止；
 * `paperW=paperH=pieceW=pieceH=1e-200` 則讓兩方向 utilization 的分母（`sheet.w*sheet.h`）
 * 與分子都下溢為 0，變成 `0/0=NaN` 流出。`MAX_DIMENSION_MM=1e6`（1km）已遠超任何真實
 * 紙張／刀模；`MIN_DIMENSION_MM=0.01`（0.01mm）已遠小於任何真實可裁切尺寸，
 * 兩者都是安全餘裕很大的界，不影響任何實務輸入。
 */
export const MIN_DIMENSION_MM = 0.01;
export const MAX_DIMENSION_MM = 1e6;

export type SheetOrientation = 'portrait' | 'landscape';

/**
 * 拼版計算的純數字輸入——pieceW/pieceH 由呼叫端取得製造 bounds 後傳入（見檔頭說明）。
 * `cutV`/`cutH`（gate round 1 T1 取代舊 `SheetMode` 三選一，型別已刪除）：直切／橫切
 * 旗標，可獨立疊加——兩者皆真＝四開（子紙數 4），皆偽＝整紙。`allowRotate`：是否允許
 * L 形 90° 補排（見 `computeDirection`／`pickFillSplit` docblock）；`false` 時行為與加入
 * 補排前的舊版完全等價（回歸保證：見 `resolveWorkingSheet`／`computeDirection` docblock）。
 */
export interface ImpositionInput {
  pieceW: number;
  pieceH: number;
  paperW: number;
  paperH: number;
  orientation: SheetOrientation;
  cutV: boolean;
  cutH: boolean;
  allowRotate: boolean;
  gripper: number;
  gap: number;
}

/**
 * 依轉換鏈解析出的紙張：w/h 為（方向＋裁切處理後的）單一子紙尺寸，usableW/usableH 為扣
 * 咬口後的可用區；fullW/fullH 為方向處理後、裁切前的整張尺寸（T3 預覽 viewBox 消費，取代
 * 舊版呼叫端額外呼叫一次 `resolveWorkingSheet(...,'full',...)` 拿全紙的雙呼叫寫法）。
 * cutV/cutH 回帶呼叫時傳入的裁切旗標——T2 的 sectionOffsets 用這兩個布林決定子紙排列，
 * 不靠 w/h 與 fullW/fullH 的尺寸差反推切向（SOL review High 2：尺寸差在特定長寬比下會有
 * 歧義，直接回帶旗標沒有這個問題）。sections＝子紙數＝(cutV?2:1)×(cutH?2:1)。
 */
export interface WorkingSheet {
  w: number;
  h: number;
  usableW: number;
  usableH: number;
  fullW: number;
  fullH: number;
  cutV: boolean;
  cutH: boolean;
  sections: number;
}

/**
 * 單一條帶（L 形補排的底或右條帶之一）的 90° 補排結果。cols/rows 是條帶內的格數
 * （cols 沿條帶寬方向、rows 沿條帶高方向；件 footprint＝主格點方向旋轉 90° 後的寬高，
 * 見 `pickFillSplit` docblock）；count=cols×rows。
 */
export interface StripFill {
  cols: number;
  rows: number;
  count: number;
}

/**
 * 單一方向（0° 或 90°）的排列結果。cols/rows/gridCount 是主格點（同一件方向沿兩軸鋪滿，
 * 語意與補排功能加入前完全相同）；fillSplit/bottomFill/rightFill 是 L 形 90° 補排——主格點
 * 鋪滿可用區左上角後，右側／底部剩餘的 L 形空間可能還放得下幾件「轉 90° 後」的同一種件，
 * 窮舉兩種切法（bottom-full／right-full，見 `pickFillSplit`）取補排數較高者。`allowRotate=
 * false` 或主格點 `gridCount=0`（放不下）時 fillSplit/bottomFill/rightFill 全為 `null`，
 * `count`＝`gridCount`——與補排功能加入前的舊版數字逐字相同（回歸保證，見 spec 附錄）。
 */
export interface DirectionResult {
  cols: number;
  rows: number;
  gridCount: number;
  fillSplit: 'bottom-full' | 'right-full' | null;
  bottomFill: StripFill | null;
  rightFill: StripFill | null;
  count: number;
  totalCount: number;
  utilization: number;
}

export type ImpositionFieldError = {
  /** `'result'`＝內部錯誤的專屬歸因（不對應任何輸入欄位），只與 `reason:'internal'` 成對出現。 */
  field: 'paperW' | 'paperH' | 'pieceW' | 'pieceH' | 'gripper' | 'gap' | 'result';
  /** `'internal'`＝計算結果驗證失敗（非使用者輸入錯），UI 應走整體錯誤顯示、不標任何輸入框。 */
  reason: 'not-finite' | 'not-positive' | 'below-min' | 'out-of-range' | 'internal';
};

export type ImpositionResult =
  | { ok: true; sheet: WorkingSheet; deg0: DirectionResult; deg90: DirectionResult }
  | { ok: false; errors: ImpositionFieldError[] };

/**
 * 紙規／方向／裁切 → working sheet 的唯一轉換鏈（spec F4——計算卡、尺寸文字、
 * 對開切線示意全部消費同一個 resolved result，避免各自重算漂移）：
 *   1. source W/H（preset 或自訂，呼叫端負責取得）
 *   2. 直放／橫放交換：landscape＝較大邊當 w、較小邊當 h；portrait 反之——結果即
 *      fullW/fullH（裁切前，T3 預覽 viewBox 消費）
 *   3. cutV／cutH 可疊加各自取半（gate round 1 T1 取代舊 `SheetMode` 三選一單選——
 *      四開＝兩者皆真；子紙視為獨立紙張進機，四邊含新切邊都留咬口）
 *   4. 四邊各扣一次咬口 → 可用區（clamp ≥ 0：咬口過大是合法輸入，見 spec 輸入 domain）
 */
export function resolveWorkingSheet(
  paperW: number,
  paperH: number,
  orientation: SheetOrientation,
  cutV: boolean,
  cutH: boolean,
  gripper: number,
): WorkingSheet {
  const longSide = Math.max(paperW, paperH);
  const shortSide = Math.min(paperW, paperH);
  const fullW = orientation === 'landscape' ? longSide : shortSide;
  const fullH = orientation === 'landscape' ? shortSide : longSide;

  const w = cutV ? fullW / 2 : fullW;
  const h = cutH ? fullH / 2 : fullH;

  return {
    w,
    h,
    usableW: Math.max(0, w - 2 * gripper),
    usableH: Math.max(0, h - 2 * gripper),
    fullW,
    fullH,
    cutV,
    cutH,
    sections: (cutV ? 2 : 1) * (cutH ? 2 : 1),
  };
}

/**
 * footprint 判準（spec F5）：n 件放得下 ⟺ n×piece + (n−1)×gap ≤ available + FIT_EPSILON_MM。
 * 先用除法估算初值，再雙向修正——防浮點誤差讓 exact-fit 案例被高估或低估一模
 * （見 FIT_EPSILON_MM 依據的 30/3.1/228.6 案例）。
 */
export function fitCount(available: number, piece: number, gap: number): number {
  if (!(available > 0) || !(piece > 0)) return 0;

  const fits = (k: number) => k >= 1 && k * piece + (k - 1) * gap <= available + FIT_EPSILON_MM;

  let n = Math.max(0, Math.floor((available + gap) / (piece + gap)));
  while (n > 0 && !fits(n)) n--; // 防浮點高估
  // 防浮點低估（30/3.1/228.6 案例）＋無進展防護（T2 review F1 深度防禦）：
  // domain 已將呼叫端的 available/piece/gap 限制在 [MIN_DIMENSION_MM, MAX_DIMENSION_MM]
  // 內，正常情況下 n 不會大到觸及 IEEE-754 精度極限；但 fitCount 是 export 的公開函式，
  // 呼叫端可能繞過 computeImposition 的 domain 驗證直接餵極端值（如 Infinity 或 1e20），
  // 此時 n 逼近 2^53 附近會出現 `n+1===n`（浮點無法表示下一個整數），若不防護會永久迴圈。
  while (fits(n + 1)) {
    const next = n + 1;
    if (next === n) break;
    n = next;
  }
  return n;
}

/**
 * paper*／piece* 欄位：finite、> 0、且落在 `[MIN_DIMENSION_MM, MAX_DIMENSION_MM]`
 * 尺寸安全界內（domain 表：兩者皆由生成器/使用者輸入，同一套規則；T2 review F1）。
 * 三層檢查刻意分開、不合併：`not-finite`／`not-positive` 是既有分類（0、負值、
 * NaN、Infinity 沿用既有 reason，不因新增尺寸界而改變既有行為／既有測試斷言）；
 * `out-of-range` 只抓「finite 且 > 0，但太小或太大」這個新增的中間地帶
 * （如 `1e-200`：> 0 為真，但遠小於 MIN_DIMENSION_MM；`1e20`：> 0 為真，但遠大於
 * MAX_DIMENSION_MM）。
 */
function checkDimension(value: number): ImpositionFieldError['reason'] | null {
  if (!Number.isFinite(value)) return 'not-finite';
  if (!(value > 0)) return 'not-positive';
  if (value < MIN_DIMENSION_MM || value > MAX_DIMENSION_MM) return 'out-of-range';
  return null;
}

/**
 * 咬口：finite 且 `0 ≤ x ≤ MAX_DIMENSION_MM`——0 合法（四邊不咬口），跟 paper*／piece*
 * 的「必須 > 0」不同，故無 MIN_DIMENSION_MM 下限；上限沿用尺寸安全界（T2 review F1）。
 */
function checkGripper(value: number): ImpositionFieldError['reason'] | null {
  if (!Number.isFinite(value)) return 'not-finite';
  if (value < 0) return 'not-positive';
  if (value > MAX_DIMENSION_MM) return 'out-of-range';
  return null;
}

/**
 * gap：finite 且 `MIN_GAP_MM ≤ x ≤ MAX_DIMENSION_MM`——硬下限本身已涵蓋「非正」情況，
 * 統一歸類 below-min；上限沿用尺寸安全界（T2 review F1）。
 */
function checkGap(value: number): ImpositionFieldError['reason'] | null {
  if (!Number.isFinite(value)) return 'not-finite';
  if (value < MIN_GAP_MM) return 'below-min';
  if (value > MAX_DIMENSION_MM) return 'out-of-range';
  return null;
}

/** 逐欄收集 domain errors（不是找到第一個就短路），順序依 `ImpositionInput` 宣告順序。 */
function collectDomainErrors(input: ImpositionInput): ImpositionFieldError[] {
  const errors: ImpositionFieldError[] = [];
  const record = (field: ImpositionFieldError['field'], reason: ImpositionFieldError['reason'] | null) => {
    if (reason) errors.push({ field, reason });
  };

  record('pieceW', checkDimension(input.pieceW));
  record('pieceH', checkDimension(input.pieceH));
  record('paperW', checkDimension(input.paperW));
  record('paperH', checkDimension(input.paperH));
  record('gripper', checkGripper(input.gripper));
  record('gap', checkGap(input.gap));

  return errors;
}

/**
 * 單一條帶（L 形補排的底或右）的 90° 補排 fitCount。條帶任一邊 `≤0`（如主格點已頂滿
 * 可用區、或扣一個 gap 後轉負）時整個結構強制回傳 `{cols:0,rows:0,count:0}`——不是任一維
 * 各自跑 `fitCount` 後可能出現「寬 0 但高算出非零列」這種結構上沒有意義的中間態（`fitCount`
 * 本身對非正 available 已回 0，但另一維若仍 >0 會各自算出獨立於「條帶不存在」這件事的
 * cols/rows，混淆讀者）。`fillPieceForCols`/`fillPieceForRows` 是「補排件」的 footprint，
 * 恆與呼叫端主格點的 pieceForCols/pieceForRows 對調（見 `pickFillSplit` docblock）。
 */
function computeStripFill(
  stripW: number,
  stripH: number,
  fillPieceForCols: number,
  fillPieceForRows: number,
  gap: number,
): StripFill {
  if (!(stripW > 0) || !(stripH > 0)) return { cols: 0, rows: 0, count: 0 };
  const cols = fitCount(stripW, fillPieceForCols, gap);
  const rows = fitCount(stripH, fillPieceForRows, gap);
  return { cols, rows, count: cols * rows };
}

/**
 * L 形雙分割補排（gate 驗收反饋的實證案例：主格點鋪滿可用區左上角後，右側／底部的 L 形
 * 剩餘空間常常還放得下幾件「轉 90°」的同一種件，加入補排前完全沒算進去）。
 *
 * 剩餘空間是一個 L 形（右側一條＋底部一條，重疊角落只能歸其中一條），窮舉兩種切法瓜分：
 *   - 「bottom-full」：底條帶拿全寬（`usableW×剩餘高`），右條帶只到主格點的高度
 *     （`剩餘寬×usedH`）——右下角歸底條帶。
 *   - 「right-full」：右條帶拿全高（`剩餘寬×usableH`），底條帶只到主格點的寬度
 *     （`usedW×剩餘高`）——右下角歸右條帶。
 * 兩者右下角歸屬不同、放得下的補排件數可能不同（SOL review 的雙分割反例：右側全高的窄長條
 * 能多塞一整排，固定只取 bottom-full 會少算），分別跑 `computeStripFill` 後取補排總數
 * 較高者；平手取 bottom-full（無業務含義，純粹需要一個確定性選擇，spec 附錄明定）。
 *
 * 條帶內補排件永遠是主格點方向「旋轉 90°」後的 footprint——`fillPieceForCols=
 * pieceForRows`、`fillPieceForRows=pieceForCols`，對調不是巧合：deg0 卡主格點是 0°，
 * 補排轉 90°；deg90 卡呼叫時 pieceForCols/pieceForRows 本身已對調（見 `computeImposition`
 * 呼叫處），補排再對調一次即轉回 0°——兩卡在同一組輸入下用的補排 footprint 恰好互補
 * （T1 report ambiguity 解析），不是各自獨立的規則。
 */
function pickFillSplit(
  sheet: WorkingSheet,
  cols: number,
  rows: number,
  pieceForCols: number,
  pieceForRows: number,
  gap: number,
): { fillSplit: 'bottom-full' | 'right-full'; bottomFill: StripFill; rightFill: StripFill } {
  // n=1 時 (n-1)*gap=0，不多扣一個 gap（單列/單欄主排的正確 footprint）。
  const usedW = cols * pieceForCols + (cols - 1) * gap;
  const usedH = rows * pieceForRows + (rows - 1) * gap;
  const fillPieceForCols = pieceForRows;
  const fillPieceForRows = pieceForCols;

  // 分割 A「bottom-full」。
  const bottomFillA = computeStripFill(sheet.usableW, sheet.usableH - usedH - gap, fillPieceForCols, fillPieceForRows, gap);
  const rightFillA = computeStripFill(sheet.usableW - usedW - gap, usedH, fillPieceForCols, fillPieceForRows, gap);
  const totalA = bottomFillA.count + rightFillA.count;

  // 分割 B「right-full」。
  const rightFillB = computeStripFill(sheet.usableW - usedW - gap, sheet.usableH, fillPieceForCols, fillPieceForRows, gap);
  const bottomFillB = computeStripFill(usedW, sheet.usableH - usedH - gap, fillPieceForCols, fillPieceForRows, gap);
  const totalB = bottomFillB.count + rightFillB.count;

  return totalB > totalA
    ? { fillSplit: 'right-full', bottomFill: bottomFillB, rightFill: rightFillB }
    : { fillSplit: 'bottom-full', bottomFill: bottomFillA, rightFill: rightFillA };
}

/**
 * 單一方向（0° 或 90°）的排列結果——呼叫端傳入 `pieceForCols`/`pieceForRows` 決定方向
 * （90° 時兩者對調，同一份計算式，spec F5）。主格點鋪滿後，若 `allowRotate` 且鋪出非零
 * 格點，再跑 `pickFillSplit` 補排 L 形剩餘空間；**`gridCount=0` 先短路**（Global
 * Constraints「主格點為 0 時不補排」：「0° 放不下但 90° 放得下」的情境由 90° 卡涵蓋，
 * 避免兩卡數字重複語意混淆）——不算 usedW/usedH，避免 `(cols−1)×gap` 在 cols=0 時出負值
 * 污染下游。`count`＝gridCount＋兩條帶補排數（無補排時兩者為 0，回歸舊版數字，見 spec
 * 附錄回歸保證）；`totalCount`＝count×sections（子紙數，四開＝4）。utilization 分子含
 * 補排件（旋轉不改面積，故 pieceForCols×pieceForRows 對兩個方向皆可直接用），分母固定用
 * working sheet 單一子紙全尺寸（`sheet.w×sheet.h`，扣咬口前，公式不變）；0 模時
 * utilization＝0，不是 NaN。
 */
function computeDirection(
  sheet: WorkingSheet,
  pieceForCols: number,
  pieceForRows: number,
  gap: number,
  allowRotate: boolean,
): DirectionResult {
  const cols = fitCount(sheet.usableW, pieceForCols, gap);
  const rows = fitCount(sheet.usableH, pieceForRows, gap);
  const gridCount = cols * rows;

  const fill = allowRotate && gridCount > 0 ? pickFillSplit(sheet, cols, rows, pieceForCols, pieceForRows, gap) : null;
  const fillSplit = fill?.fillSplit ?? null;
  const bottomFill = fill?.bottomFill ?? null;
  const rightFill = fill?.rightFill ?? null;

  const count = gridCount + (bottomFill?.count ?? 0) + (rightFill?.count ?? 0);
  const totalCount = count * sheet.sections;
  const utilization = count === 0 ? 0 : (count * pieceForCols * pieceForRows) / (sheet.w * sheet.h);

  return { cols, rows, gridCount, fillSplit, bottomFill, rightFill, count, totalCount, utilization };
}

/** `StripFill` 三欄是否全為 finite；`null` 本身是合法值（`fillSplit=null` 時的兩 fill），
 *  視為「通過」不是異常。（gate round 1 T1 review Fix 3：export 供獨立測試——原本是私有
 *  helper，只能透過 `isFiniteDirectionResult`／`computeImposition` 間接測，正常輸入路徑
 *  必然餵 finite 值，刪掉這個呼叫測試也照樣綠、沒有鑑別力；export 後可直接餵 NaN/Infinity
 *  斷言拒絕，見 tests/imposition.test.ts。純 export，行為逐字不變。） */
export function isFiniteStripFill(fill: StripFill | null): boolean {
  if (fill === null) return true;
  return Number.isFinite(fill.cols) && Number.isFinite(fill.rows) && Number.isFinite(fill.count);
}

/** `DirectionResult` 是否全為 finite（T2 review F1 深度防禦，見 `computeImposition`）——
 *  深入兩條帶（`bottomFill`/`rightFill`）各自的 cols/rows/count，不只外層 count/totalCount，
 *  避免條帶內部算出的 NaN／Infinity 剛好與外層聚合值的檢查路徑錯開而漏檢。 */
function isFiniteDirectionResult(direction: DirectionResult): boolean {
  return (
    Number.isFinite(direction.cols) &&
    Number.isFinite(direction.rows) &&
    Number.isFinite(direction.gridCount) &&
    Number.isFinite(direction.count) &&
    Number.isFinite(direction.totalCount) &&
    Number.isFinite(direction.utilization) &&
    isFiniteStripFill(direction.bottomFill) &&
    isFiniteStripFill(direction.rightFill)
  );
}

/**
 * 拼版主計算：先 domain 驗證（逐欄收集所有欄位的錯誤，不是找到第一個就短路）——
 * 有任何錯誤就直接回傳 `{ok:false, errors}`，不繼續算 sheet/deg0/deg90；全部合法
 * 才進 `resolveWorkingSheet` → 0°/90° 兩方向 `computeDirection`（90° 為 pieceW/pieceH
 * 互換——這個互換同時決定了 90° 卡的補排 footprint 會轉回 0°，見 `pickFillSplit`
 * docblock）。
 *
 * 進場先建立 input snapshot（每個屬性恰讀一次的 plain object）：JS 物件屬性可以是
 * getter、每次讀值可以不同（T2 re-review 的反例——`gap` getter 第一次回 3 通過 domain
 * 驗證、之後回 Infinity 進計算），snapshot 讓 domain 驗證與計算保證看到同一組值，
 * 「防禦分支不可達」的數值上界證明（單軸 count < 6.65e5、總 count < 4.42e11 < 2^53）
 * 才真正成立。`cutV`/`cutH`/`allowRotate` 三個布林欄位不受 domain 驗證管轄（不是尺寸
 * 欄位），但同樣納入 snapshot 恰讀一次——理由相同：避免 hostile getter 在 snapshot 之後
 * 又被計算鏈重複讀取而拿到不同值。
 *
 * 回傳前再驗證 deg0/deg90 全為 finite（T2 review F1 深度防禦）：snapshot＋domain 上下界
 * 後理論上不可達，但這是「domain 已擋、仍須有」的第二道防線，不讓 NaN/Infinity 有任何
 * 路徑流到 UI。命中時回 `{field:'result', reason:'internal'}`——內部錯誤專屬歸因，
 * 不把沒有超界的輸入欄位標成肇因（T2 re-review 裁決）。
 */
export function computeImposition(input: ImpositionInput): ImpositionResult {
  const snapshot: ImpositionInput = {
    pieceW: input.pieceW,
    pieceH: input.pieceH,
    paperW: input.paperW,
    paperH: input.paperH,
    orientation: input.orientation,
    cutV: input.cutV,
    cutH: input.cutH,
    allowRotate: input.allowRotate,
    gripper: input.gripper,
    gap: input.gap,
  };

  const errors = collectDomainErrors(snapshot);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sheet = resolveWorkingSheet(snapshot.paperW, snapshot.paperH, snapshot.orientation, snapshot.cutV, snapshot.cutH, snapshot.gripper);
  const deg0 = computeDirection(sheet, snapshot.pieceW, snapshot.pieceH, snapshot.gap, snapshot.allowRotate);
  const deg90 = computeDirection(sheet, snapshot.pieceH, snapshot.pieceW, snapshot.gap, snapshot.allowRotate);

  if (!isFiniteDirectionResult(deg0) || !isFiniteDirectionResult(deg90)) {
    return { ok: false, errors: [{ field: 'result', reason: 'internal' }] };
  }

  return { ok: true, sheet, deg0, deg90 };
}
