/**
 * 拼版估算純計算核心：resolveWorkingSheet／fitCount／computeImposition。
 *
 * 純 TS 模組——不 import React、`export/*`、或 `boxes/*` 任何模組，只吃/吐數字（`core/profile.ts`
 * 是唯一例外，見下方 `shrunk?: ProfileStrides` 說明——那也是同層的純 core 模組，非 UI/boxes）。
 * 呼叫端（UI 或整合測試）自行準備 pieceW/pieceH（透過 `core/bounds.ts` 的
 * `manufacturingBounds` 取得製造 bounds 寬高，見該模組 docblock「不得直接使用
 * `GenerateResult.bounds`／`DielinePiece.bounds`」的理由——declared bounds 含畫布
 * 留白／標註外擴，會讓拼版模數算錯）與 paperW/paperH（preset 或自訂）後餵進來。
 * 座標單位一律 mm。
 *
 * 依據：docs/specs/2026-07-10-imposition-design.md §紙規與 working sheet 轉換鏈
 * （review F4）、§計算（review F5）、§輸入 domain（review F3）。gate round 1 T1（cutV/cutH
 * 可疊加＋L 形 90° 補排）取代原本的 `SheetMode` 三選一，詳見各介面/函式 docblock。
 *
 * profile-spacing slice（`docs/specs/2026-07-11-imposition-profile-spacing.md` §F2/F2b/F3/F4）
 * 疊加：可選的 `shrunk: ProfileStrides` 輸入讓 0°/90° 兩張方向卡各自在「行縮」與「列縮」間
 * 擇優（比較含 L 形補排的最終 count，不只 gridCount），單向收縮 stride 由 `fitCountStride`
 * 單一核心承載（`fitCount` 改為委託呼叫，見該函式 docblock）。
 */

import type { ProfileStrides } from '@/core/profile';

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
 * 已知語意界（gate round 1 review·Record only）：絕對 epsilon 在 MIN_DIMENSION_MM
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
 *
 * `shrunk?: ProfileStrides`（profile-spacing spec F2b）：件的輪廓投影 gap-aware stride
 * （`core/profile.ts` 的 `computeProfileStrides` 產出，opaque class——唯一合法產地）。
 * **`undefined`-only 缺省**：省略整個欄位、或其中 `strideX`/`strideY` 個別為
 * `undefined`＝該向使用矩形 stride（`pieceW+gap`／`pieceH+gap`，與加入本欄位前的
 * 行為逐字相同）——`null`／`NaN`／`Infinity` 皆非缺省語意，視為 domain error（見
 * `computeImposition` 的 `collectDomainErrors`／`checkShrunkAxis`）。`shrunk.gap` 必須與
 * `input.gap` 嚴格相等（機械驗證「這個 stride 真的是用這個 gap 算的」，見
 * `checkShrunkAxis` 呼叫處註解）——不相等即 domain error（field `gap`），不是靜默忽略。
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
  shrunk?: ProfileStrides;
}

/**
 * 依轉換鏈解析出的紙張：w/h 為（方向＋裁切處理後的）單一子紙尺寸，usableW/usableH 為扣
 * 咬口後的可用區；fullW/fullH 為方向處理後、裁切前的整張尺寸（T3 預覽 viewBox 消費，取代
 * 舊版呼叫端額外呼叫一次 `resolveWorkingSheet(...,'full',...)` 拿全紙的雙呼叫寫法）。
 * cutV/cutH 回帶呼叫時傳入的裁切旗標——T2 的 sectionOffsets 用這兩個布林決定子紙排列，
 * 不靠 w/h 與 fullW/fullH 的尺寸差反推切向（review High 2：尺寸差在特定長寬比下會有
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
 *
 * profile-spacing spec F2b/F3 新增四欄（`computeDirection` 擇優輸出，預覽/UI 直接消費、
 * 不重算）：
 * - `spacingAxis`：本卡實際採用的收縮軸——`'rows'`＝行縮（cols 用矩形、rows 用收縮
 *   stride）、`'cols'`＝列縮（對稱）、`null`＝無 `shrunk` 輸入，或兩案收縮 stride 皆等於
 *   矩形（零收益，如 telescope 退化）——即使此時擇優仍需在兩個「數值相同」的候選間
 *   確定性挑一個（見 `computeDirection` 的 tie-break 註解），`spacingAxis` 仍如實回報
 *   「沒有真的收縮」，不因內部挑了行縮候選就誤標。
 * - `strideX`／`strideY`：本卡兩軸實際採用的 stride（sheet 座標系的 X/Y，即 cols/rows
 *   軸，非件的局部 W/H——90° 卡的 cols/rows 對調已經反映在呼叫 `computeDirection` 時
 *   傳入的 pieceForCols/pieceForRows／strideForCols/strideForRows，這兩欄只是如實回報
 *   「這卡的 cols 軸／rows 軸各用了什麼 stride」）。未收縮向＝矩形（`piece+gap`）。
 * - `usedW`／`usedH`：主格點 footprint（`n=0→0`；`n≥1→piece+(n−1)×stride`，spec F2b／
 *   F4）——補排條帶起點＝`used+gap`，欄位化讓預覽端直接消費、不用重算收縮/矩形兩套公式。
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
  /** 外接矩形利用率（`count×pieceForCols×pieceForRows / (sheet.w×sheet.h)`）。**UI 已不
   *  顯示此欄位**（spec F6 終裁 b，profile-spacing slice T4）：收縮排列下相鄰矩形本來就會
   *  互疊，數值可逾 1（如 RTE 90°＝103.3%），拿它當「利用率」指標會誤導，UI 改顯示主格點
   *  footprint（`usedW`/`usedH`）。欄位本身保留不動（計算照舊，供其他消費者／測試錨沿用，
   *  見 `tests/imposition.test.ts`），最小 churn。 */
  utilization: number;
  spacingAxis: 'rows' | 'cols' | null;
  strideX: number;
  strideY: number;
  usedW: number;
  usedH: number;
}

export type ImpositionFieldError = {
  /**
   * `'result'`＝內部錯誤的專屬歸因（不對應任何輸入欄位），只與 `reason:'internal'` 成對出現。
   * `'shrunk'`＝`shrunk` 欄位本身形狀不合法（`null`／非物件——只有型別繞過才可能發生，見
   * `snapshotShrunk`）；`'shrunkStrideX'`／`'shrunkStrideY'`＝個別軸的 stride 數值違反
   * domain（非 finite，或超出 `[gap, 對應矩形邊+gap+FIT_EPSILON_MM]`，見 `checkShrunkAxis`）。
   * `shrunk.gap !== input.gap` 的不一致沿用既有 `'gap'` 欄位（spec F2b「gap 一致性」機械
   * 驗證——這件事本質上仍是「gap 這個概念錯了」，不是獨立的 shrunk 子欄位問題）。
   */
  field: 'paperW' | 'paperH' | 'pieceW' | 'pieceH' | 'gripper' | 'gap' | 'shrunk' | 'shrunkStrideX' | 'shrunkStrideY' | 'result';
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
 * footprint 判準的單一 stride 核心（profile-spacing spec F2，v1.1 修訂）：n 件放得下 ⟺
 * `piece + (n−1)×stride ≤ available + FIT_EPSILON_MM`——`fitCount(available,piece,gap)`
 * 是 `stride=piece+gap` 的特例（見下方委託），矩形排列與收縮排列（`stride` 來自
 * `ProfileStrides`）共用同一份浮點防護邏輯，不是兩份代數上「應該等價」但實際各自維護的
 * 平行實作（spec F2「單一核心、兩份浮點邏輯零漂移」）。
 *
 * 首件邊界刻意與 `piece+gap` 特例逐字對齊（`available+FIT_EPSILON_MM<piece → 0`）：
 * `available=piece−0.5ε` 時仍接受 1 件（`available+eps=piece+0.5eps`，未觸發早退），與既有
 * `fitCount` 的 epsilon 語意一致（spec F2 註記——新式不得比舊式更嚴格）。
 *
 * `stride` 防禦（spec「stride 非正/非 finite 直呼防禦測試」）：`stride≤0` 時
 * `piece+(k−1)×stride` 不隨 k 遞增（甚至遞減），會讓下方「雙向修正」迴圈永遠找不到
 * 「多一件就超額」的終止點——`fitCount` 的委託恆保證 `stride=piece+gap>0`（因為呼叫端已
 * 經檢查 `piece>0`），但 `fitCountStride` 本身是 export 的公開函式，呼叫端可能直接餵入
 * `shrunk.strideY` 這類未經 domain 驗證的數字（`computeImposition` 的 domain 驗證是
 * *呼叫* `fitCountStride` 之前的另一道防線，不是這個函式能倚賴的前提）；`stride=Infinity`
 * 還會讓 `(k−1)×stride` 在 `k=1` 時算出 `0×Infinity=NaN`，故非 finite 也一併提早拒絕。
 */
export function fitCountStride(available: number, piece: number, stride: number): number {
  if (!(available > 0) || !(piece > 0) || !(stride > 0) || !Number.isFinite(stride)) return 0;
  if (available + FIT_EPSILON_MM < piece) return 0; // 首件邊界（spec F2，與委託後的 fitCount 逐字等價）

  const fits = (k: number) => k >= 1 && piece + (k - 1) * stride <= available + FIT_EPSILON_MM;

  let n = Math.max(1, Math.floor((available - piece) / stride) + 1);
  while (n > 1 && !fits(n)) n--; // 防浮點高估
  // 防浮點低估＋無進展防護（移植自既有 fitCount 的 T2 review F1 深度防禦，見該處歷史
  // 註解）：`stride` 已在函式頂端保證 finite 且 >0，`n` 仍可能在極端 available（如
  // `Infinity`／`1e20`）下逼近 IEEE-754 精度極限出現 `n+1===n`，若不防護會永久迴圈。
  while (fits(n + 1)) {
    const next = n + 1;
    if (next === n) break;
    n = next;
  }
  return n;
}

/**
 * footprint 判準（spec F5）：n 件放得下 ⟺ n×piece + (n−1)×gap ≤ available + FIT_EPSILON_MM。
 * **委託 `fitCountStride(available, piece, piece+gap)`**（profile-spacing spec F2，v1.1
 * 修訂）——矩形排列是「stride=piece+gap」的特例，不再是獨立維護的第二份浮點公式。委託
 * 前後對既有全部呼叫端（含 `Infinity`/`1e20`/`MAX_SAFE_INTEGER` 等極端直呼測試）逐字
 * 等價，已用 60 萬組隨機＋邊界導向 fuzz case 交叉驗證兩份實作（含完整
 * `computeDirection` 管線，非只獨立比對 `fitCount` 的回傳值本身）零漂移——見
 * `tests/imposition.test.ts` 的委託等價 describe block。
 */
export function fitCount(available: number, piece: number, gap: number): number {
  return fitCountStride(available, piece, piece + gap);
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

/**
 * `input.shrunk` 恰讀一次進快照（profile-spacing spec F2b「snapshot 同步」，與既有
 * `gap`/`cutV` 等欄位的 getter 防禦同一紀律，見 `computeImposition` docblock）——`gap`／
 * `strideX`／`strideY` 三個 getter 各自只呼叫一次，之後 domain 驗證與計算一律讀這份快照，
 * 不再碰 `input.shrunk` 本身（防 hostile getter 在兩次讀值之間變值，見
 * `tests/imposition.test.ts` 的 snapshot 測試）。
 *
 * `'invalid'`＝`shrunk` 既非 `undefined`（缺省，合法）也不是物件（如型別繞過餵入
 * `null`／基本型別）——`ProfileStrides` 是 opaque class，本模組不驗證「是不是真的
 * `ProfileStrides` instance」（那超出 domain 驗證範圍，spec F2b 明文的威脅模型邊界：
 * JS/`as any` 蓄意偽造與既有 API「pieceW 無從驗證來源」同級），只防禦會讓後續
 * `.gap`/`.strideX`/`.strideY` 存取直接拋 TypeError 的 `null`/非物件輸入。
 */
type ShrunkSnapshot = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'present'; gap: number; strideX: number | undefined; strideY: number | undefined };

function snapshotShrunk(shrunk: ProfileStrides | undefined): ShrunkSnapshot {
  if (shrunk === undefined) return { kind: 'absent' };
  if (shrunk === null || typeof shrunk !== 'object') return { kind: 'invalid' };
  return { kind: 'present', gap: shrunk.gap, strideX: shrunk.strideX, strideY: shrunk.strideY };
}

/**
 * `shrunk` 單軸 stride 的 domain 驗證（profile-spacing spec F2b「其餘 domain 驗證」）——
 * `undefined`＝該向缺省用矩形 stride，合法，不是錯誤（`ImpositionInput.shrunk` docblock
 * 的「兩 stride 欄可各自獨立缺省」）。非 `undefined` 時：先驗 finite（擋 `NaN`/`Infinity`，
 * 必須先於下面的範圍比較——`NaN` 參與 `<`/`>` 恆為 false，範圍檢查會誤判為「通過」）；再驗
 * `gap ≤ stride ≤ pieceEdge+gap+FIT_EPSILON_MM`（spec 名詞段「恆有 gap≤strideY≤H+gap」
 * 的矩形上界不變式，`+FIT_EPSILON_MM` 吸收「stride 剛好算成矩形值」時的浮點噪音——
 * `computeProfileStrides` 對退化幾何算出的矩形值本身就帶浮點噪音，見 `core/profile.ts`
 * telescope 錨測試用 `toBeCloseTo` 而非 `toBe` 的理由）。`pieceEdge` 是**呼叫端傳入的
 * `input.pieceW`/`pieceH`**（不是算 `shrunk` 時用的幾何尺寸）——驗證的是「這個 stride
 * 數字對『這次呼叫聲明的件尺寸』而言合不合理」，不是重新反推 `shrunk` 的來源幾何。
 */
function checkShrunkAxis(strideValue: number | undefined, pieceEdge: number, gap: number): ImpositionFieldError['reason'] | null {
  if (strideValue === undefined) return null;
  if (!Number.isFinite(strideValue)) return 'not-finite';
  if (strideValue < gap || strideValue > pieceEdge + gap + FIT_EPSILON_MM) return 'out-of-range';
  return null;
}

/** 逐欄收集 domain errors（不是找到第一個就短路），順序依 `ImpositionInput` 宣告順序。 */
function collectDomainErrors(input: ImpositionInput, shrunkSnap: ShrunkSnapshot): ImpositionFieldError[] {
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

  if (shrunkSnap.kind === 'invalid') {
    record('shrunk', 'not-finite');
  } else if (shrunkSnap.kind === 'present') {
    // gap 一致性＝機械驗證（spec F2b v1.2·M2）：裸 `stride≥gap` 下界擋不住「gap 改大後
    // 沿用舊 stride」（gap=3 算出的值在 gap=4 下仍可能通過下界，但實際間距不足）。沿用
    // 既有 'gap' 欄位名——本質仍是「gap 這個概念不一致」，不是獨立的 shrunk 子問題。
    if (shrunkSnap.gap !== input.gap) {
      record('gap', 'out-of-range');
    }
    record('shrunkStrideX', checkShrunkAxis(shrunkSnap.strideX, input.pieceW, input.gap));
    record('shrunkStrideY', checkShrunkAxis(shrunkSnap.strideY, input.pieceH, input.gap));
  }

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
 * 兩者右下角歸屬不同、放得下的補排件數可能不同（review 的雙分割反例：右側全高的窄長條
 * 能多塞一整排，固定只取 bottom-full 會少算），分別跑 `computeStripFill` 後取補排總數
 * 較高者；平手取 bottom-full（無業務含義，純粹需要一個確定性選擇，spec 附錄明定）。
 *
 * 條帶內補排件永遠是主格點方向「旋轉 90°」後的 footprint——`fillPieceForCols=
 * pieceForRows`、`fillPieceForRows=pieceForCols`，對調不是巧合：deg0 卡主格點是 0°，
 * 補排轉 90°；deg90 卡呼叫時 pieceForCols/pieceForRows 本身已對調（見 `computeImposition`
 * 呼叫處），補排再對調一次即轉回 0°——兩卡在同一組輸入下用的補排 footprint 恰好互補
 * （T1 紀錄 ambiguity 解析），不是各自獨立的規則。
 *
 * `usedW`/`usedH` 由呼叫端傳入（profile-spacing spec F4，不再由本函式從 `cols`/`rows`×
 * `gap` 內部反推）——收縮排列下主格點的 footprint 由**主格點實際採用的 stride**決定
 * （`piece+(n−1)×stride`，`n=0→0`），不是恆等於矩形公式 `n×piece+(n−1)×gap`；兩者只在
 * `stride=piece+gap`（矩形／未收縮向）時代數相等，此時也逐字等價於舊版內部反推的值（見
 * `computeGridAndFill` 的 `usedW`/`usedH` 推導，已用 fuzz case 交叉驗證退化路徑零漂移）。
 * **條帶內補排件本身仍固定用矩形 stride**（`computeStripFill`→`fitCount`，spec F4「維持
 * 矩形」不變）——只有「條帶從哪裡起算」（`usedW`/`usedH`）隨主格點收縮而變小，條帶內部
 * 排列邏輯本身不變。
 */
function pickFillSplit(
  sheet: WorkingSheet,
  usedW: number,
  usedH: number,
  pieceForCols: number,
  pieceForRows: number,
  gap: number,
): { fillSplit: 'bottom-full' | 'right-full'; bottomFill: StripFill; rightFill: StripFill } {
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

/** 單一收縮候選（行縮或列縮其中之一）的主格點＋L 形補排完整結果——`computeDirection`
 *  擇優比較的兩個候選皆用這個 helper 算，兩者唯一差異是 `strideForCols`/`strideForRows`
 *  傳入哪一組（見 `computeDirection` 的呼叫處）。 */
interface GridAndFill {
  cols: number;
  rows: number;
  gridCount: number;
  fillSplit: 'bottom-full' | 'right-full' | null;
  bottomFill: StripFill | null;
  rightFill: StripFill | null;
  count: number;
  usedW: number;
  usedH: number;
  strideForCols: number;
  strideForRows: number;
}

/**
 * 主格點（`fitCountStride` 兩軸）＋條帶補排（若 `allowRotate` 且鋪出非零格點）。
 * **`gridCount=0` 先短路**（Global Constraints「主格點為 0 時不補排」：「0° 放不下但 90°
 * 放得下」的情境由 90° 卡涵蓋，避免兩卡數字重複語意混淆）——不算補排，但 `usedW`/`usedH`
 * 仍照 `n=0→0` 規則算（profile-spacing spec F2b／F4），不是略過。
 */
function computeGridAndFill(
  sheet: WorkingSheet,
  pieceForCols: number,
  pieceForRows: number,
  strideForCols: number,
  strideForRows: number,
  gap: number,
  allowRotate: boolean,
): GridAndFill {
  const cols = fitCountStride(sheet.usableW, pieceForCols, strideForCols);
  const rows = fitCountStride(sheet.usableH, pieceForRows, strideForRows);
  const gridCount = cols * rows;
  // n=0→0（spec F2b 明定，防 n=1 時的 (n-1)*stride 公式在 n=0 出負值污染 usedW/usedH）；
  // n≥1→piece+(n-1)*stride——stride=矩形（piece+gap）時與舊版 n*piece+(n-1)*gap 代數相等，
  // 且已用 fuzz case 交叉驗證退化路徑浮點結果零漂移（見 fitCountStride docblock）。
  const usedW = cols === 0 ? 0 : pieceForCols + (cols - 1) * strideForCols;
  const usedH = rows === 0 ? 0 : pieceForRows + (rows - 1) * strideForRows;

  const fill = allowRotate && gridCount > 0 ? pickFillSplit(sheet, usedW, usedH, pieceForCols, pieceForRows, gap) : null;
  const fillSplit = fill?.fillSplit ?? null;
  const bottomFill = fill?.bottomFill ?? null;
  const rightFill = fill?.rightFill ?? null;

  const count = gridCount + (bottomFill?.count ?? 0) + (rightFill?.count ?? 0);

  return { cols, rows, gridCount, fillSplit, bottomFill, rightFill, count, usedW, usedH, strideForCols, strideForRows };
}

/**
 * 行縮 vs 列縮擇優（profile-spacing spec F3）：比**最終 `count`**（主格點＋補排），不是只比
 * `gridCount`——只比 gridCount 會漏掉「主格點少一件但條帶補更多」的反超（spec F3·v1.1·M，
 * 正數補排案例即為此反超的具體例證，見 `tests/imposition.test.ts`）。`count` 平手比
 * `gridCount`；再平手取行縮（`true`）——確定性選擇，無業務含義，比照 `pickFillSplit`
 * 平手條款先例（同一份 tie-break 精神：需要一個確定的答案時，固定選其中一邊）。
 */
function pickRowShrink(rowShrink: GridAndFill, colShrink: GridAndFill): boolean {
  if (rowShrink.count !== colShrink.count) return rowShrink.count > colShrink.count;
  if (rowShrink.gridCount !== colShrink.gridCount) return rowShrink.gridCount > colShrink.gridCount;
  return true;
}

/**
 * 單一方向（0° 或 90°）的排列結果——呼叫端傳入 `pieceForCols`/`pieceForRows` 決定方向
 * （90° 時兩者對調，同一份計算式，spec F5）；`strideForCols`/`strideForRows` 是
 * `shrunk.strideX`/`strideY`（`undefined`＝該向缺省，見下方矩形回退），**90° 卡呼叫時這兩者
 * 也跟著對調**（profile-spacing spec F3「stride 兩軸對調，與 pieceForCols/pieceForRows
 * 對調同構」——見 `computeImposition` 呼叫處：`strideX` 恆與 `pieceW` 同進退、`strideY`
 * 恆與 `pieceH` 同進退，90° 呼叫把兩組 pair 一起交換，不是分別交換）。
 *
 * **F3 單向擇優**：算兩個完整候選（各自含 L 形補排）——「行縮」（cols 用矩形 stride、rows
 * 用 `strideForRows` 或矩形回退）與「列縮」（對稱，cols 用 `strideForCols`、rows 用矩形）
 * ——`pickRowShrink` 依最終 `count` 擇優（見該函式 docblock）。**禁止雙向同時收縮**
 * （spec F3 對角安全論證）由建構本身保證：兩個候選各自最多只有一軸用收縮 stride，從未
 * 存在「兩軸同時收縮」的第三個候選。
 *
 * `spacingAxis`：只有在擇優挑中的那一軸的 stride**真的**小於矩形（`< 矩形−FIT_EPSILON_MM`，
 * 留一點餘裕防浮點噪音把「剛好等於矩形」誤判成「有收縮」）才標 `'rows'`/`'cols'`——`shrunk`
 * 缺省或兩軸皆零收益（如 telescope 退化）時，即使 tie-break 仍確定性選了「行縮」候選，
 * 這兩個候選的數字其實逐字相同（矩形 vs 矩形），如實回報 `null`（spec F2b「null＝無收縮或
 * 零收益」），不因內部挑了哪個候選就誤標成看起來有收縮。
 */
function computeDirection(
  sheet: WorkingSheet,
  pieceForCols: number,
  pieceForRows: number,
  gap: number,
  allowRotate: boolean,
  strideForCols: number | undefined,
  strideForRows: number | undefined,
): DirectionResult {
  const rectStrideForCols = pieceForCols + gap;
  const rectStrideForRows = pieceForRows + gap;
  const effStrideForCols = strideForCols ?? rectStrideForCols;
  const effStrideForRows = strideForRows ?? rectStrideForRows;

  const rowShrink = computeGridAndFill(sheet, pieceForCols, pieceForRows, rectStrideForCols, effStrideForRows, gap, allowRotate);
  const colShrink = computeGridAndFill(sheet, pieceForCols, pieceForRows, effStrideForCols, rectStrideForRows, gap, allowRotate);

  const rowWins = pickRowShrink(rowShrink, colShrink);
  const picked = rowWins ? rowShrink : colShrink;

  const rowsGenuinelyShrunk = effStrideForRows < rectStrideForRows - FIT_EPSILON_MM;
  const colsGenuinelyShrunk = effStrideForCols < rectStrideForCols - FIT_EPSILON_MM;
  const spacingAxis: DirectionResult['spacingAxis'] = rowWins ? (rowsGenuinelyShrunk ? 'rows' : null) : colsGenuinelyShrunk ? 'cols' : null;

  const totalCount = picked.count * sheet.sections;
  const utilization = picked.count === 0 ? 0 : (picked.count * pieceForCols * pieceForRows) / (sheet.w * sheet.h);

  return {
    cols: picked.cols,
    rows: picked.rows,
    gridCount: picked.gridCount,
    fillSplit: picked.fillSplit,
    bottomFill: picked.bottomFill,
    rightFill: picked.rightFill,
    count: picked.count,
    totalCount,
    utilization,
    spacingAxis,
    strideX: picked.strideForCols,
    strideY: picked.strideForRows,
    usedW: picked.usedW,
    usedH: picked.usedH,
  };
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
 *  避免條帶內部算出的 NaN／Infinity 剛好與外層聚合值的檢查路徑錯開而漏檢。**profile-spacing
 *  新增四個數值欄位（`strideX`/`strideY`/`usedW`/`usedH`）同樣納入**——`shrunk` 的 domain
 *  驗證（`checkShrunkAxis`）已擋掉輸入層的 NaN/Infinity，但這裡是「domain 已擋、仍須有」
 *  的第二道防線（同一份 T2 review F1 深度防禦精神，不因新欄位是本 slice 加的就例外）。
 *  `spacingAxis` 是 `'rows'|'cols'|null` 字串聯集，非數值欄位，不適用 `Number.isFinite`。 */
function isFiniteDirectionResult(direction: DirectionResult): boolean {
  return (
    Number.isFinite(direction.cols) &&
    Number.isFinite(direction.rows) &&
    Number.isFinite(direction.gridCount) &&
    Number.isFinite(direction.count) &&
    Number.isFinite(direction.totalCount) &&
    Number.isFinite(direction.utilization) &&
    Number.isFinite(direction.strideX) &&
    Number.isFinite(direction.strideY) &&
    Number.isFinite(direction.usedW) &&
    Number.isFinite(direction.usedH) &&
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
 * 又被計算鏈重複讀取而拿到不同值。`shrunk` 走獨立的 `snapshotShrunk`（見該函式
 * docblock）——`gap`/`strideX`/`strideY` 三個 getter 同樣各自恰讀一次，不併入這裡的
 * `ImpositionInput` 形狀快照（`shrunk` 本身仍是 opaque class instance，不適合被拆進純
 * plain-object 快照又要保留型別）。
 *
 * **stride 兩軸對調（profile-spacing spec F3）**：deg0 呼叫傳 `(shrunkStrideX,
 * shrunkStrideY)`，deg90 呼叫傳 `(shrunkStrideY, shrunkStrideX)`——與 `pieceW`/`pieceH`
 * 的對調同構（`strideX` 恆與 `pieceW` same-call 同進退：0° 時兩者都在「cols」位置、90°
 * 時兩者都在「cols」位置但值換成 H/strideY 那組——不是「strideX↔strideY 互換」而是「(W,
 * strideX) pair 與 (H, strideY) pair 各自固定跟著自己的欄位走，只有『這個 pair 現在對應
 * cols 還是 rows』隨 90° 旋轉」，見 `computeDirection` 呼叫處與
 * `docs/specs/2026-07-11-imposition-profile-spacing.md` §F3）。`shrunk` 缺省或未定義
 * 兩軸時，`shrunkStrideX`/`shrunkStrideY` 皆為 `undefined`，`computeDirection` 內部即
 * 回退矩形——與加入本欄位前的呼叫序完全等價。
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
  const shrunkSnap = snapshotShrunk(input.shrunk);

  const errors = collectDomainErrors(snapshot, shrunkSnap);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const sheet = resolveWorkingSheet(snapshot.paperW, snapshot.paperH, snapshot.orientation, snapshot.cutV, snapshot.cutH, snapshot.gripper);

  const shrunkStrideX = shrunkSnap.kind === 'present' ? shrunkSnap.strideX : undefined;
  const shrunkStrideY = shrunkSnap.kind === 'present' ? shrunkSnap.strideY : undefined;

  const deg0 = computeDirection(sheet, snapshot.pieceW, snapshot.pieceH, snapshot.gap, snapshot.allowRotate, shrunkStrideX, shrunkStrideY);
  const deg90 = computeDirection(sheet, snapshot.pieceH, snapshot.pieceW, snapshot.gap, snapshot.allowRotate, shrunkStrideY, shrunkStrideX);

  if (!isFiniteDirectionResult(deg0) || !isFiniteDirectionResult(deg90)) {
    return { ok: false, errors: [{ field: 'result', reason: 'internal' }] };
  }

  return { ok: true, sheet, deg0, deg90 };
}
