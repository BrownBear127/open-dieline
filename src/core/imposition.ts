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
 * （review F4）、§計算（review F5）、§輸入 domain（review F3）。
 */

export interface PaperPreset {
  id: string;
  label: string;
  w: number;
  h: number;
}

/**
 * 常用紙規 preset（mm 標稱值沿用台灣紙業慣例，spec F4 法蘭定案）：
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
export type SheetMode = 'full' | 'halfV' | 'halfH';

/** 拼版計算的純數字輸入——pieceW/pieceH 由呼叫端取得製造 bounds 後傳入（見檔頭說明）。 */
export interface ImpositionInput {
  pieceW: number;
  pieceH: number;
  paperW: number;
  paperH: number;
  orientation: SheetOrientation;
  mode: SheetMode;
  gripper: number;
  gap: number;
}

/** 依轉換鏈解析出的紙張：w/h 為（方向＋作業模式處理後的）整張尺寸，usableW/usableH 為扣咬口後的可用區。 */
export interface WorkingSheet {
  w: number;
  h: number;
  usableW: number;
  usableH: number;
}

/** 單一方向（0° 或 90°）的排列結果。 */
export interface DirectionResult {
  cols: number;
  rows: number;
  count: number;
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
 * 紙規／方向／作業模式 → working sheet 的唯一轉換鏈（spec F4——計算卡、尺寸文字、
 * 對開切線示意全部消費同一個 resolved result，避免各自重算漂移）：
 *   1. source W/H（preset 或自訂，呼叫端負責取得）
 *   2. 直放／橫放交換：landscape＝較大邊當 w、較小邊當 h；portrait 反之
 *   3. 整紙／對開 V（w 取半）／對開 H（h 取半）——對開後的半張視為獨立紙張進機，
 *      四邊（含新切邊）都留咬口
 *   4. 四邊各扣一次咬口 → 可用區（clamp ≥ 0：咬口過大是合法輸入，見 spec 輸入 domain）
 */
export function resolveWorkingSheet(
  paperW: number,
  paperH: number,
  orientation: SheetOrientation,
  mode: SheetMode,
  gripper: number,
): WorkingSheet {
  const longSide = Math.max(paperW, paperH);
  const shortSide = Math.min(paperW, paperH);
  let w = orientation === 'landscape' ? longSide : shortSide;
  let h = orientation === 'landscape' ? shortSide : longSide;

  if (mode === 'halfV') {
    w = w / 2;
  } else if (mode === 'halfH') {
    h = h / 2;
  }

  return {
    w,
    h,
    usableW: Math.max(0, w - 2 * gripper),
    usableH: Math.max(0, h - 2 * gripper),
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
 * 單一方向（0° 或 90°）的排列結果——呼叫端傳入 `pieceForCols`/`pieceForRows` 決定方向
 * （90° 時兩者對調，同一份計算式，spec F5）。utilization 分母固定用 working sheet
 * 全尺寸（`sheet.w×sheet.h`，扣咬口前）；0 模時 utilization＝0，不是 NaN。
 */
function computeDirection(sheet: WorkingSheet, pieceForCols: number, pieceForRows: number, gap: number): DirectionResult {
  const cols = fitCount(sheet.usableW, pieceForCols, gap);
  const rows = fitCount(sheet.usableH, pieceForRows, gap);
  const count = cols * rows;
  const utilization = count === 0 ? 0 : (count * pieceForCols * pieceForRows) / (sheet.w * sheet.h);
  return { cols, rows, count, utilization };
}

/** `DirectionResult` 四欄是否全為 finite（T2 review F1 深度防禦，見 `computeImposition`）。 */
function isFiniteDirectionResult(direction: DirectionResult): boolean {
  return (
    Number.isFinite(direction.cols) &&
    Number.isFinite(direction.rows) &&
    Number.isFinite(direction.count) &&
    Number.isFinite(direction.utilization)
  );
}

/**
 * 拼版主計算：先 domain 驗證（逐欄收集所有欄位的錯誤，不是找到第一個就短路）——
 * 有任何錯誤就直接回傳 `{ok:false, errors}`，不繼續算 sheet/deg0/deg90；全部合法
 * 才進 `resolveWorkingSheet` → 0°/90° 兩方向 `fitCount`（90° 為 pieceW/pieceH 互換）。
 *
 * 進場先建立 input snapshot（每個屬性恰讀一次的 plain object）：JS 物件屬性可以是
 * getter、每次讀值可以不同（T2 re-review 的反例——`gap` getter 第一次回 3 通過 domain
 * 驗證、之後回 Infinity 進計算），snapshot 讓 domain 驗證與計算保證看到同一組值，
 * 「防禦分支不可達」的數值上界證明（單軸 count < 6.65e5、總 count < 4.42e11 < 2^53）
 * 才真正成立。
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
    mode: input.mode,
    gripper: input.gripper,
    gap: input.gap,
  };

  const errors = collectDomainErrors(snapshot);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sheet = resolveWorkingSheet(snapshot.paperW, snapshot.paperH, snapshot.orientation, snapshot.mode, snapshot.gripper);
  const deg0 = computeDirection(sheet, snapshot.pieceW, snapshot.pieceH, snapshot.gap);
  const deg90 = computeDirection(sheet, snapshot.pieceH, snapshot.pieceW, snapshot.gap);

  if (!isFiniteDirectionResult(deg0) || !isFiniteDirectionResult(deg90)) {
    return { ok: false, errors: [{ field: 'result', reason: 'internal' }] };
  }

  return { ok: true, sheet, deg0, deg90 };
}
