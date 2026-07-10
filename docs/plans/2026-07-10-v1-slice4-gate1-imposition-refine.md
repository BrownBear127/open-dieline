# open-dieline Slice 4 gate round 1 — 拼版精修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** T5 樣張 gate 反饋四項（法蘭 2026-07-10）：①拼版設定移到預覽區上方、按鈕化（SVG 圖示）②混排補排——主格點排完後剩餘 L 形條帶放 90° 旋轉件（法蘭實證案例：31×43 橫放 RTE 下方空白可再放 4 模），加「可轉 90°」選項 ③預覽一律顯示全紙、裁切方式（對開/四開）用線條疊加示意、只有可落版區域變動（參考 trouver.crm-rebuild `FloatingTools.tsx` ImpositionTool 的顯示語意）④排列預覽線寬與設計模式 Canvas 統一（non-scaling-stroke）。

**Architecture:** 計算核心保持「單一子紙 working sheet」——`SheetMode` 三選一退役，改 `cutV`/`cutH` 兩個可疊加布林（全紙／對開 V／對開 H／四開＝V+H，裁切恆在中線，參考物語意），總模數＝每子紙 × `sections`（2^裁切數）。混排＝主格點 → L 形剩餘分割（底部條帶取全寬、右側條帶高=主排佔用高，兩塊不重疊）→ 各條帶內 90° 旋轉件格點。預覽＝全紙 viewBox 恆定、裁切線疊加、**每個子紙都畫實排**（超越參考物「只畫一個代表象限」的簡化）。

**Tech Stack:** 同 Slice 1–4（Vite 6 / React 19 / TS 6 / vitest）。除本 plan 明列外不引入任何依賴。

## 法蘭四點反饋 → controller 定案（2026-07-10）

1. **toolbar 化**：`ImpositionControls` 從左側欄（w-64 直排）改為主區頂部橫排 toolbar（掛在 `ImpositionResults` 上方）；紙規／方向／裁切／可轉 90° 全部按鈕化（inline SVG 圖示＋文字標籤）；咬口、刀線間距保留數字輸入（toolbar 尾端小輸入框）；件選擇（多片盒型）保留下拉。
2. **混排補排**：L 形一層補排（不遞迴、不做異形咬合）——維持「單件外接矩形估算」定位。`allowRotate` 預設 **true**（法蘭：「大多數情況刀模可轉」）。0°/90° 兩卡語意升級為「0° 為主＋90° 補」vs「90° 為主＋0° 補」對照，兩卡同等權重不變（spec F9 沿用）。180° 混拼（頭尾對插）不需獨立處理：外接矩形下 0°/180° footprint 相同，計算等價——docblock 記明此語意，UI 不出現 180° 選項。
3. **cutV/cutH 可疊加**：法蘭原話「對開、四開等」＋指名參考 trouver ImpositionTool（該實作正是 cutV/cutH 兩布林可疊加、都開＝四開）。`SheetMode('full'|'halfV'|'halfH')` 型別退役。裁切後每子紙視獨立紙張進機、四邊（含新切邊）各留咬口——spec 對開語義沿用、推廣到四開。
4. **線寬統一**：排列預覽的刀模 paths 改 `vectorEffect="non-scaling-stroke"`＋原始 `style.strokeWidth`（與 `Canvas.tsx` 逐字同構）；`PREVIEW_STROKE_SCALE` 常數刪除。紙張外框／裁切線／可用區框同步改 non-scaling（整張預覽的線都是 screen-space 細線，縮放層級變動不再影響視覺粗細）。

## 數值錨（RTE 預設參數·製造 bounds 233.2×251·gripper 20·gap 3·31"×43"＝787×1092）

已用獨立 Python 腳本驗算（2026-07-10 controller，與 fitCount 同一 footprint 判準）。expected 硬編碼於測試、不得由被測函式導出（沿用 spec F8 鐵則）：

| 情境 | 主格點 | 補排 | count/子紙 | totalCount |
|---|---|---|---|---|
| 直放·整紙·0° 主·關轉 | 3×4=12 | — | 12（81.73%） | 12 |
| 直放·整紙·90° 主·關轉 | 2×4=8 | — | 8（54.49%） | 8 |
| 直放·整紙·0° 主·開轉 | 3×4=12 | 底 0＋右 0 | 12 | 12 |
| 直放·整紙·90° 主·開轉 | 2×4=8 | 底 0＋右 3（1×3） | 11 | 11 |
| **橫放·整紙·0° 主·開轉** | **4×2=8** | **底 4（4×1）＋右 0** | **12** | **12** |
| 橫放·整紙·90° 主·開轉 | 4×3=12 | 底 0＋右 0 | 12 | 12 |
| 直放·四開（cutV+cutH·子紙 393.5×546）·0° 主·開轉 | 1×2=2 | 底 0＋右 0 | 2 | 8 |

粗體列＝法蘭 gate 反饋的實證案例（截圖：下方空白可放 4 模卻沒算進去）。utilization 分子＝count×pieceW×pieceH（旋轉不改面積），分母＝子紙 w×h（扣咬口前）——公式不變，count 含補排。

**回歸保證**：`allowRotate=false` 且單一裁切語意等價時（`full`→`cutV:false,cutH:false`、`halfV`→`cutV:true`、`halfH`→`cutH:true`），既有全部錨值（cols/rows/count/utilization）逐字不變——既有測試改參數形狀、不改 expected 數字。

## Global Constraints

- `LINE_STYLES` 不可改；`tests/fixtures/*.json` 不可改；`src/boxes/*`／`src/core/bounds.ts`／設計模式 `Canvas.tsx` 一律不動。golden／等價測試零影響。
- spec delta：本 plan 的「法蘭四點反饋 → controller 定案」段**取代** `docs/specs/2026-07-10-imposition-design.md` 的 §作業模式（SheetMode 三選一）與 §排列預覽（PREVIEW_STROKE_SCALE）條款；其餘 spec 條款（F1 製造 bounds 硬規則、F3 輸入 domain、F5 footprint 判準、F6 state 生命週期、F9 兩卡同權、F10 preview cap、免責聲明文案）全部沿用。驗收條件表的 expected 以本 plan 數值錨表為準。
- **主格點為 0 時不補排**：`gridCount=0` → 兩條帶不計算（count=0＝「放不下」）——「0° 放不下但 90° 放得下」的情境由 90° 卡涵蓋，避免兩卡數字重複語意混淆。docblock 記明。
- `MAX_PREVIEW_INSTANCES=500` cap 語意升級為「全紙合計」（含所有子紙、含補排件）；cap 在建立物件前生效（O(limit) 不是 O(total)——Slice 4 High finding 的教訓不回退）。
- 錯誤處理／domain 驗證鏈（collectDomainErrors／input snapshot／isFiniteDirectionResult 深度防禦）結構不動，僅隨欄位改名跟進。
- 程式風格：immutability、函式 <50 行、檔 <800 行、繁中註解僅記代碼看不出的約束。
- 每 task 完成即 commit（feat/fix 前綴），gate：`npm test`＋`npm run typecheck`＋`npm run build`＋`npm run check:cycles` 全綠才進下一 task。
- Commit 尾綴：
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GVdsPjgciU3GezKTm1hMDh
```

## File Structure

```
src/core/imposition.ts        # T1：cutV/cutH/allowRotate 介面＋L 形補排＋sections 乘數
src/ui/impositionPreview.ts   # T2：instance 幾何擴充（補排件＋子紙偏移＋全紙 cap）
src/ui/ImpositionView.tsx     # T3：結果區全紙預覽重寫＋non-scaling stroke；T4：Controls toolbar 化
src/ui/impositionIcons.tsx    # T4 新增：inline SVG 圖示（紙規／直橫／cutV/cutH／旋轉）
src/ui/App.tsx                # T4：拼版模式佈局改「toolbar＋results」直排＋ImpositionState 欄位遷移
tests/imposition-anchor.test.ts    # T1 修改：錨表更新（新增混排／四開錨）
tests/imposition.test.ts           # T1 修改：cutV/cutH 參數形狀跟進
tests/imposition-preview.test.ts   # T2 修改＋新增
tests/ui/imposition-view.test.tsx  # T3/T4 修改
tests/ui/app.test.tsx              # T4 修改（F6 往返欄位更新）
```

**依賴序**：T1（純計算）→ T2（預覽幾何純函式）→ T3（結果區渲染）→ T4（toolbar＋App 佈局）→ T5 樣張 gate（法蘭）。嚴格直線——T3/T4 都動 `ImpositionView.tsx`，不並行。

---

### Task 1: 計算核心——cutV/cutH＋L 形補排＋sections

**Files:**
- Modify: `src/core/imposition.ts`
- Test: `tests/imposition-anchor.test.ts`、`tests/imposition.test.ts`

**Interfaces（T2/T3 逐字消費）:**
```ts
export interface ImpositionInput {
  pieceW: number; pieceH: number;
  paperW: number; paperH: number;
  orientation: SheetOrientation;
  cutV: boolean;        // 取代 mode（SheetMode 型別刪除）
  cutH: boolean;
  allowRotate: boolean; // 新增：L 形 90° 補排開關
  gripper: number; gap: number;
}

export interface WorkingSheet {
  w: number; h: number;           // 單一子紙尺寸（方向＋裁切處理後）
  usableW: number; usableH: number;
  fullW: number; fullH: number;   // 全紙尺寸（方向處理後、裁切前）——T3 預覽 viewBox 消費
  sections: number;               // 子紙數＝(cutV?2:1)×(cutH?2:1)
}

/** 單一條帶的 90° 補排結果。cols/rows 是條帶內的格數；count=cols×rows。 */
export interface StripFill { cols: number; rows: number; count: number; }

export interface DirectionResult {
  cols: number; rows: number;      // 主格點（語意不變）
  gridCount: number;               // cols×rows（原 count 的舊語意）
  bottomFill: StripFill | null;    // allowRotate=false 或 gridCount=0 → null
  rightFill: StripFill | null;
  count: number;                   // gridCount＋兩 fill count（每子紙）
  totalCount: number;              // count × sections
  utilization: number;             // count×pieceW×pieceH／(w×h)——分母子紙全尺寸
}
```

**Steps:**
- [ ] RED：錨表測試更新——上方數值錨表 7 列逐列 hardcode expected（含 bottomFill/rightFill 的 cols×rows 結構）；`halfV`/`halfH` 舊語意等價錨（`cutV:true,cutH:false` 對舊 halfV 錨值不變）；四開 totalCount=count×4；`allowRotate=false` 全部既有錨逐字回歸。
- [ ] `resolveWorkingSheet(paperW, paperH, orientation, cutV, cutH, gripper)`：方向交換（沿用）→ `cutV` 時 `w/=2`、`cutH` 時 `h/=2`（可疊加）→ 四邊扣咬口；回傳補 `fullW/fullH`（裁切前）＋`sections`。呼叫端（ImpositionView）原本額外呼叫一次 `resolveWorkingSheet(…,'full',…)` 拿全紙的雙呼叫寫法退役——一次回傳給齊。
- [ ] L 形補排：主格點 `usedW=cols×pieceW+(cols−1)×gap`、`usedH` 同理；底部條帶＝`usableW × (usableH−usedH−gap)`（全寬）、右側條帶＝`(usableW−usedW−gap) × usedH`（高只到主排佔用高——兩塊不重疊、合併覆蓋全部剩餘）；條帶內 90° 件（footprint 對調 pieceH×pieceW）跑同一 `fitCount`。條帶尺寸 ≤0 → `{cols:0,rows:0,count:0}`。
- [ ] `computeDirection` 簽名擴充（傳入 allowRotate＋主/補 footprint）；`computeImposition` 組裝 deg0（0° 主＋90° 補）/deg90（90° 主＋0° 補）；input snapshot 加三個新欄位；`isFiniteDirectionResult` 涵蓋新欄位。
- [ ] GREEN＋gate 四綠＋commit。

**急凍區**：`fitCount` 本體、`FIT_EPSILON_MM`、`MIN_GAP_MM`、domain 驗證三函式（checkDimension/checkGripper/checkGap）不動。

---

### Task 2: 預覽幾何——補排 instance＋子紙偏移＋全紙 cap

**Files:**
- Modify: `src/ui/impositionPreview.ts`
- Test: `tests/imposition-preview.test.ts`

**Interfaces（T3 逐字消費）:**
```ts
/** 單一子紙內的完整排列（主格點＋兩條帶補排件；補排件 dir 與主方向相反）。 */
export function directionInstances(
  dir: 0 | 90,
  direction: DirectionResult,
  mb: Bounds,
  gripper: number,
  gap: number,
  budget: number,               // 呼叫端分配的 instance 上限（cap 在建立前生效）
): PreviewInstance[];

/** 子紙左上角偏移（全紙座標系）：整紙→[{0,0}]；cutV→左右兩張；cutH→上下；四開→4 張。 */
export function sectionOffsets(sheet: WorkingSheet): { dx: number; dy: number }[];
```

**Steps:**
- [ ] RED：補排件 transform 代數驗證（底部條帶第一件的 cellX/cellY＝gripper＋條帶起點；90° 補件旋轉修正沿用既有 `translate(h,0) rotate(90)` 鏈）；sectionOffsets 四情境；cap 預算跨主排/補排/子紙的截斷順序（主格點 row-major → 底部條帶 → 右側條帶，子紙 0 排完才進子紙 1）。
- [ ] `instanceTransforms` 改名/擴充為 `directionInstances`：主格點沿用既有 row-major 反推；補排件的 cell 原點＝條帶起點（底部：`x=gripper, y=gripper+usedH+gap`；右側：`x=gripper+usedW+gap, y=gripper`），件 footprint 用旋轉後寬高。
- [ ] cap 語意：T3 呼叫端把 `MAX_PREVIEW_INSTANCES` 均分／順序分配給各子紙（`budget` 參數）——本模組只吃 budget 不讀全域常數（可測性）。
- [ ] GREEN＋gate 四綠＋commit。

---

### Task 3: 結果區——全紙預覽＋non-scaling stroke＋數字呈現

**Files:**
- Modify: `src/ui/ImpositionView.tsx`（`ImpositionResults`／`DirectionCard`／`computeImpositionView`）
- Test: `tests/ui/imposition-view.test.tsx`

**Steps:**
- [ ] RED：卡片文字（`4 列 × 2 行 ＋ 補 4 ＝ 12 模`；裁切時 `每半張 12 模 × 2 ＝ 24 模`／四開 `每四開 2 模 × 4 ＝ 8 模`）；SVG 結構（全紙外框恆在＋cutV/cutH 中線 data-testid＋每子紙一個 `<g data-testid="section">`＋instance 數=各子紙 budget 合計）；paths `vector-effect: non-scaling-stroke` 屬性斷言；`PREVIEW_STROKE_SCALE` 引用歸零。
- [ ] DirectionCard 預覽重寫：viewBox=`0 0 fullW fullH` 恆定（「要動的只有可落版區域」——切換裁切時紙不動）；裁切線畫全紙中線（cutV 豎／cutH 橫，可同時）；每子紙 `<g transform=translate(sectionOffset)>` 內畫咬口淡色區＋可用區＋`directionInstances`（補排件在同一份 instances 裡，旋轉已含在 transform）。
- [ ] 線寬統一：刀模 paths＝`strokeWidth={style.strokeWidth}`＋`vectorEffect="non-scaling-stroke"`（與 Canvas.tsx 同構）；外框／切線／可用區框同步 non-scaling（新常數組，px 語意，docblock 記明）。
- [ ] 數字行：`workingSheet` 文字行補全紙／子紙資訊（`全紙 787×1092，四開子紙 393.5×546（可用 353.5×506）`措辭 T3 現場定，測試斷數字存在不斷全文）。
- [ ] GREEN＋gate 四綠＋commit。

**測試現實**：jsdom 不做 SVG 佈局——斷 attribute（vector-effect／transform 字串／viewBox）不斷視覺；視覺可辨度是 T5 gate 的人眼職責。

---

### Task 4: toolbar 化＋SVG 圖示＋App 佈局

**Files:**
- Create: `src/ui/impositionIcons.tsx`
- Modify: `src/ui/ImpositionView.tsx`（`ImpositionControls`）、`src/ui/App.tsx`
- Test: `tests/ui/imposition-view.test.tsx`、`tests/ui/app.test.tsx`

**Steps:**
- [ ] RED：toolbar 按鈕組（紙規 3 preset＋自訂＝4 顆、直/橫 2 顆、cutV/cutH 2 顆 toggle、可轉 90° 1 顆 toggle）aria-pressed 狀態；自訂紙規點選展開 W/H 輸入；咬口/gap 輸入仍在（含既有欄位錯誤紅字）；`ImpositionState` 欄位遷移（`mode` 刪除、`cutV`/`cutH`/`allowRotate` 新增）後 F6 往返逐欄保留測試更新。
- [ ] `impositionIcons.tsx`：inline SVG（20×20、`stroke="currentColor"`、`fill="none"`、strokeWidth 1.5）——紙張直放（瘦高矩形）／橫放（寬扁矩形）／cutV（矩形＋豎虛線）／cutH（矩形＋橫虛線）／可轉 90°（矩形＋弧形旋轉箭頭）／三紙規＋自訂（矩形內小字或比例示意，T4 現場定）。純展示元件、零 props 邏輯。
- [ ] `ImpositionControls` 重寫為橫排 toolbar：分組（紙規｜方向｜裁切｜旋轉｜咬口/gap｜件）＋`flex flex-wrap gap-x-4 gap-y-2`；按鈕樣式沿用 App.tsx 模式切換鈕的 zinc 選中/未選慣例（`aria-pressed`＋`bg-zinc-900 text-white` 選中態）；數字輸入縮窄（w-20）。左側欄的拼版分支移除。
- [ ] `App.tsx`：拼版模式主區改 `<div className="flex flex-col">` toolbar＋results；`ImpositionState` 初始值遷移（`cutV:false, cutH:false, allowRotate:true`）；lazy initializer／fallback effect 不動。
- [ ] GREEN＋gate 四綠＋commit。

---

### Task 5: 樣張 gate（法蘭 E2E·本 plan 之外）

檢查點（原 T5 checklist 沿用＋本輪新增）：三 preset＋自訂／cutV/cutH 單開＋疊加（四開）／直橫／0°+90° 對照（**橫放 0° 主開轉＝8+4=12 模**——法蘭反饋案例回歸）／可轉 90° 開關對照／天地盒逐件／RTE 整件／邊界（超大咬口→放不下）／**線寬與設計模式目測一致**／全紙顯示切換裁切時紙不跳動。gate 過 → push＋tag v0.4.0。
