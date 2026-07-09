# 拼版估算（Imposition Estimator）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 實作教育示範用拼版估算——單件刀模在目標紙張（含方向／對開／咬口）上 0°/90° 各能拼幾模，含真實輪廓預覽。

**Architecture:** 純計算核心（`core/imposition.ts`，零 React 零 export 依賴）＋純展示元件（`ImpositionView.tsx`，state 提升至 App）＋App 模式切換。`manufacturingBounds` 先遷移至 core 供拼版消費（export 側 re-export 保相容）。

**Tech Stack:** 既有 Vite+React+TS+vitest；無新依賴。

**Spec:** `docs/specs/2026-07-10-imposition-design.md`（v1.1——review 10 findings 全收版）。本 plan 的驗收錨值全部取自該 spec。

## Global Constraints

- `LINE_STYLES`（cut #000000／crease #00FF00／halfcut #FFFF00／dimension #3B82F6／bleed #FF00FF）不可改
- `tests/fixtures/rte-reference.json` 不可修改（t=0 錨定）
- 既有 549 tests 基線全綠；拼版為新增模組，不動既有幾何／匯出路徑的行為
- 拼版**不得使用** `result.bounds`／`piece.bounds`——一律製造 bounds（spec F1）
- `src/core/imposition.ts` 零 React 依賴、零 `src/export/*` 依賴
- 具名常數：`FIT_EPSILON_MM = 1e-6`、`MAX_PREVIEW_INSTANCES = 500`、`MIN_GAP_MM = 3`、`PAPER_PRESETS`（787×1092／635×889／686×991）
- gap 有效域 `finite 且 ≥ 3`；咬口 `finite 且 ≥ 0`；無效輸入回 typed invalid result，不讓 NaN/Infinity 流到 UI
- 註解繁體中文、匹配既有 docblock 風格；commit 訊息 `feat:`/`refactor:` 前綴＋既有尾綴慣例

---

### Task 1: manufacturingBounds 遷移至 core

**Files:**
- Create: `src/core/bounds.ts`
- Modify: `src/export/svg.ts`（改為 re-export）
- Test: 既有套件全綠即證相容（`manufacturingBounds` 已有測試覆蓋）；新增 `tests/core-bounds.test.ts` 直測 core 入口

**Interfaces:**
- Produces: `src/core/bounds.ts` export `DIMENSION_LINE_TYPES: ReadonlySet<LineType>`、`manufacturingBounds(result: GenerateResult, piece?: DielinePiece): Bounds`（簽名與現行 `src/export/svg.ts:31-57` 完全一致，含 docblock 搬遷）
- 消費端（`ui/App.tsx`、`ui/Canvas.tsx`、`ui/ExportBar.tsx`）import 路徑**不動**——`svg.ts` 用 `export { DIMENSION_LINE_TYPES, manufacturingBounds } from '@/core/bounds';` 保相容（同 gate round 1 遷移 `layerKeyForLineType` 手法）

- [ ] **Step 1:** 建 `src/core/bounds.ts`——把 `svg.ts` 的 `DIMENSION_LINE_TYPES`＋`manufacturingBounds` 連同 docblock 整段搬入（import 改 `@/core/geometry`、`@/core/types`）
- [ ] **Step 2:** `svg.ts` 刪除本體、改 re-export；確認 `svg.ts` 內部消費點（如有）改 import core
- [ ] **Step 3:** 新增 `tests/core-bounds.test.ts`：RTE 預設參數 `manufacturingBounds(result)` 寬高＝`233.2×251`（±0.01）；天地盒 `manufacturingBounds(result, pieces[0])` 嚴格小於 `pieces[0].bounds`（標註外擴證明）
- [ ] **Step 4:** `npx vitest run` 全綠；`npx madge --circular src/main.tsx` 無環
- [ ] **Step 5:** Commit `refactor: manufacturingBounds 遷移至 core/bounds（svg.ts re-export 保相容）`

### Task 2: core/imposition.ts 純計算核心

**Files:**
- Create: `src/core/imposition.ts`
- Test: `tests/imposition.test.ts`（純函式）＋`tests/imposition-anchor.test.ts`（整合數值錨）

**Interfaces:**
- Consumes: `manufacturingBounds`（僅整合測試消費；純函式只吃數字）
- Produces:

```ts
export interface PaperPreset { id: string; label: string; w: number; h: number }
export const PAPER_PRESETS: readonly PaperPreset[] // 787×1092／635×889／686×991
export const FIT_EPSILON_MM = 1e-6;
export const MAX_PREVIEW_INSTANCES = 500;
export const MIN_GAP_MM = 3;

export type SheetOrientation = 'portrait' | 'landscape';
export type SheetMode = 'full' | 'halfV' | 'halfH';

export interface ImpositionInput {
  pieceW: number; pieceH: number;      // 製造 bounds 寬高（呼叫端負責取得）
  paperW: number; paperH: number;      // source 紙規（preset 或自訂）
  orientation: SheetOrientation;
  mode: SheetMode;
  gripper: number;                     // 四邊咬口 mm
  gap: number;                         // 刀線間距 mm
}
export interface WorkingSheet { w: number; h: number; usableW: number; usableH: number }
export interface DirectionResult { cols: number; rows: number; count: number; utilization: number }
export type ImpositionFieldError = { field: 'paperW'|'paperH'|'pieceW'|'pieceH'|'gripper'|'gap'; reason: 'not-finite'|'not-positive'|'below-min' };
export type ImpositionResult =
  | { ok: true; sheet: WorkingSheet; deg0: DirectionResult; deg90: DirectionResult }
  | { ok: false; errors: ImpositionFieldError[] };

export function resolveWorkingSheet(paperW: number, paperH: number, orientation: SheetOrientation, mode: SheetMode, gripper: number): WorkingSheet;
export function fitCount(available: number, piece: number, gap: number): number;
export function computeImposition(input: ImpositionInput): ImpositionResult;
```

**核心實作（fitCount——footprint 判準）：**

```ts
export function fitCount(available: number, piece: number, gap: number): number {
  if (!(available > 0) || !(piece > 0)) return 0;
  const fits = (k: number) => k >= 1 && k * piece + (k - 1) * gap <= available + FIT_EPSILON_MM;
  let n = Math.max(0, Math.floor((available + gap) / (piece + gap)));
  while (n > 0 && !fits(n)) n--;      // 防浮點高估
  while (fits(n + 1)) n++;            // 防浮點低估（30/3.1/228.6 案例）
  return n;
}
```

**resolveWorkingSheet 轉換鏈（spec F4 唯一順序）：** source → orientation 交換（landscape＝W>H 擺放：`w=max, h=min`；portrait 反之）→ mode（halfV：w/2；halfH：h/2）→ `usable = w−2×gripper, h−2×gripper`（clamp ≥0）。

**computeImposition：** 先 domain 驗證（逐欄收集 errors，`gap` 檢 `≥ MIN_GAP_MM`）→ resolveWorkingSheet → `deg0 = {cols: fitCount(usableW, pieceW, gap), rows: fitCount(usableH, pieceH, gap), ...}`、`deg90` 寬高互換 → `utilization = count×pieceW×pieceH/(sheet.w×sheet.h)`（0 模＝0）。

- [ ] **Step 1:** 寫失敗測試 `tests/imposition.test.ts`：
  - 數值錨（expected 硬編碼）：`computeImposition({pieceW:233.2, pieceH:251, paperW:787, paperH:1092, orientation:'portrait', mode:'full', gripper:20, gap:3})` → deg0 `{cols:3, rows:4, count:12}`、utilization≈`0.8173`（±0.0001）；deg90 `{cols:2, rows:4, count:8}`、≈`0.5449`
  - 浮點三案例：`fitCount(228.6, 30, 3.1)===7`（exact fit）；`fitCount(228.6-1e-3, 30, 3.1)===6`；`fitCount(228.6+1e-3, 30, 3.1)===7`
  - 對稱性質：deg90 ＝ pieceW/pieceH 互換後的 deg0（隨機十組）
  - 對開等式：`mode:'halfV'` 結果 ＝ 以 `paperW/2`（orientation 處理後）為整紙的計算
  - 計算矩陣：portrait/landscape × full/halfV/halfH 六組合各驗 `{cols,rows,count}`；三 preset 常數斷言（787×1092 等）
  - domain：`gap:2.9`→`{ok:false, errors:[{field:'gap', reason:'below-min'}]}`；NaN/Infinity/0/負各欄；`gripper:400`（過大）→ `ok:true` 且兩方向 count 0（合法非錯誤）
- [ ] **Step 2:** 跑測試確認 FAIL（module 不存在）
- [ ] **Step 3:** 實作 `src/core/imposition.ts`（上述介面與演算法；docblock 記 spec 依據與 F5 浮點案例）
- [ ] **Step 4:** 寫 `tests/imposition-anchor.test.ts`（整合錨——驗收 1/2 全鏈）：RTE 預設 `generate` → `manufacturingBounds` → `computeImposition` → 12/8 模；同輸入改用 `result.bounds`（273.2×291）→ 6 模——斷言兩者不同、正確路徑為 12（防回退 declared bounds）
- [ ] **Step 5:** 全綠＋madge 無環＋commit `feat: 拼版純計算核心（resolveWorkingSheet/fitCount/computeImposition）`

### Task 3: ImpositionView 元件（含預覽變換純函式）

**Files:**
- Create: `src/ui/ImpositionView.tsx`、`src/ui/impositionPreview.ts`（變換純函式，供測試直測）
- Test: `tests/imposition-view.test.tsx`、`tests/imposition-preview.test.ts`

**Interfaces:**
- Consumes: `computeImposition`／常數（T2）、`manufacturingBounds`（T1）、`GenerateResult`／`DielinePiece`
- Produces:

```ts
// impositionPreview.ts —— UI 幾何純函式（jsdom 不做 getBBox，故變換數學抽純函式直測）
export interface PreviewInstance { transform: string; cellX: number; cellY: number; cellW: number; cellH: number }
export function instanceTransforms(dir: 0 | 90, cols: number, rows: number,
  mb: Bounds, gripper: number, gap: number): PreviewInstance[];
// 0°:  translate(gripper + c*(w+gap), gripper + r*(h+gap)) translate(-mb.minX, -mb.minY)
// 90°: translate(gripper + c*(h+gap), gripper + r*(w+gap)) translate(h, 0) rotate(90) translate(-mb.minX, -mb.minY)
//   （SVG rotate(90) 順時針 (x,y)→(−y,x)：局部化後幾何 [0,w]×[0,h] 旋轉落 [−h,0]×[0,w]，
//    前置 translate(h,0) 修回 [0,h]×[0,w]——旋轉後佔位＝h×w，cell step 用旋轉後寬高）
export function previewPaths(result: GenerateResult, piece: DielinePiece | null): DielinePath[];
// 製造 paths 中 type ∈ {cut, crease, halfcut}——忽略設計圖層可見性/dimension/annotation/texts/overlays

// ImpositionView.tsx —— 受控元件，state 全部提升（F6 模式往返保留）
export interface ImpositionState {
  pieceId: string | null;              // RTE（無 pieces）恆 null＝整件
  paperPresetId: string;               // 'custom' 或 preset id
  customW: number; customH: number;
  orientation: SheetOrientation; mode: SheetMode;
  gripper: number; gap: number;
}
export function ImpositionView(props: { result: GenerateResult; state: ImpositionState;
  onChange: (next: ImpositionState) => void }): JSX.Element;
```

- [ ] **Step 1:** 失敗測試 `tests/imposition-preview.test.ts`：
  - `instanceTransforms` 數量＝cols×rows（cap 內）；超 `MAX_PREVIEW_INSTANCES` 截斷至上限
  - 90° 佔位驗證：用非零 min 的 `mb={minX:5, minY:-7, maxX:35, maxY:13}`（20 高 30 寬）驗全部 instance 的 cell 矩形落在可用區內、cell step＝旋轉後寬高＋gap
  - `previewPaths`：混合六線型的 mock result → 只回 cut/crease/halfcut；piece 過濾走 `pathIds`
- [ ] **Step 2:** 失敗測試 `tests/imposition-view.test.tsx`：
  - 兩卡並列、各含 `列×行＝N 模` 與利用率兩位小數；0 模方向顯示「放不下」且無排列
  - 界線聲明逐字：「以單件外接矩形估算；未計混向、塞角、共刀、絲向及加工限制，不可直接作生產拼版。」
  - 無「最佳／推薦」字樣（F9）；對開模式顯示「每半張」與 working 尺寸文字
  - invalid 輸入（gap 2.9）→ 欄位錯誤標示＋結果「—」＋不渲染排列
  - 多片盒型件下拉逐件；RTE 顯示「整件」無下拉失效項
- [ ] **Step 3:** 實作 `impositionPreview.ts`＋`ImpositionView.tsx`（Tailwind 樣式沿用既有面板慣例；預覽 SVG：紙張外框＋咬口淡色區＋instances＋halfV/halfH 切線虛線示意於原紙位置）
- [ ] **Step 4:** 全綠＋commit `feat: 拼版預覽元件（兩方向卡片+真實輪廓排列+界線聲明）`

### Task 4: App 模式切換與 state 生命週期

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `tests/imposition-app.test.tsx`

**Interfaces:**
- Consumes: `ImpositionView`／`ImpositionState`（T3）
- Produces: App state `appMode: 'design' | 'imposition'`＋`impositionState: ImpositionState`（含 `pieceId` fallback 邏輯）；頂部模式切換鈕「刀模設計｜拼版估算」

**State 規則（spec F6 表逐條落實）：**
- `impositionState.pieceId` 與設計模式 `selectedPieceId` 分離
- 多片盒型初值＝`pieces[0].id`；`result.pieces` 變動後選中件消失 → effect 改選第一個有效 piece；RTE → `null`（整件）
- 進入 imposition 模式：`setCalibrating(false)`（沿用 gate round 1 校準殭屍狀態的清理慣例）；overlay 保留不顯示
- 模式往返：`impositionState` 與盒型／參數 state 全保留（不 reset）
- imposition 模式：隱藏 LayersPanel／ExportBar／overlay 控制；主區渲染 `ImpositionView`；ParamPanel 與盒型選擇保留可調

- [ ] **Step 1:** 失敗測試：模式切換顯隱（LayersPanel/ExportBar 消失、ImpositionView 出現、ParamPanel 保留）；往返保留（改 gripper→切設計→切回→值仍在）；天地盒選 liner→`linerEnabled=false`→fallback 第一有效 piece；換盒型 fallback；calibrating=true 進拼版→退出且返回設計模式不復活；盒參數改值→拼版結果同步（驗收 9 抽驗一組）
- [ ] **Step 2:** 實作 App 整合
- [ ] **Step 3:** 全綠（含既有 549 全套迴歸）＋typecheck＋build＋commit `feat: 拼版模式切換與 state 生命週期`

### Task 5: 樣張 gate（法蘭 e2e）

- [ ] 法蘭以真實案件條件試算：三 preset＋自訂、對開 V/H、直橫、90° 對照、天地盒逐件、RTE 整件、邊界（超大咬口／過大件）
- [ ] 檢查點：數字與手感一致、預覽輪廓正確、對開「每半張」語義清楚、界線聲明是否干擾
- [ ] gate 過 → 併開源配套（README 教育段更新）評估 v1.0.0（D13 順序）

## Self-review 記錄

- 型別一致性：`ImpositionState.pieceId: string | null` 與 F6「RTE 恆 null＝整件」對齊；`DirectionResult` 無 `fits` 欄（0 模即「放不下」，UI 以 `count===0` 判斷——少一個冗餘欄位）
- spec 覆蓋：驗收 1↔T2 Step1/Step4、2↔T2 Step4、3↔T2 矩陣、4↔T2 浮點、5↔T2 domain＋T3 invalid UI、6↔T4、7↔T3、8↔T2 對開＋T3 UI、9↔T4 Step1、10↔各 task 全套迴歸
- 無 placeholder；所有常數具名；90° 變換數學已在 plan 內推導定死
