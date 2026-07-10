# open-dieline Slice 4 gate round 1 — 拼版精修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** T5 樣張 gate 反饋四項（法蘭 2026-07-10）：①拼版設定移到預覽區上方、按鈕化（SVG 圖示）②混排補排——主格點排完後剩餘 L 形條帶放 90° 旋轉件（法蘭實證案例：31×43 橫放 RTE 下方空白可再放 4 模），加「可轉 90°」選項 ③預覽一律顯示全紙、裁切方式（對開/四開）用線條疊加示意、只有可落版區域變動（參考 trouver.crm-rebuild `FloatingTools.tsx` ImpositionTool 的顯示語意）④排列預覽線寬與設計模式 Canvas 統一（non-scaling-stroke）。

**Architecture:** 計算核心保持「單一子紙 working sheet」——`SheetMode` 三選一退役，改 `cutV`/`cutH` 兩個可疊加布林（全紙／對開 V／對開 H／四開＝V+H，裁切恆在中線，參考物語意），總模數＝每子紙 × `sections`（2^裁切數）。混排＝主格點 → L 形剩餘**雙分割取大**（SOL review Medium 4：固定單一分割會漏算合法補排——plan 自身錨的直放 90° 主即反例，right-full 分割 4 模 vs bottom-full 3 模）：分割 A「bottom-full」＝底部條帶全寬＋右側條帶高只到 usedH；分割 B「right-full」＝右側條帶全高＋底部條帶寬只到 usedW；兩分割各自跑 90° 旋轉件格點，取補排總數較高者，**平手 tie-break 固定取 bottom-full**。每種分割內兩條帶不重疊。預覽＝全紙 viewBox 恆定、裁切線疊加、**每個子紙都畫實排**（超越參考物「只畫一個代表象限」的簡化）。

**Tech Stack:** 同 Slice 1–4（Vite 6 / React 19 / TS 6 / vitest）。除本 plan 明列外不引入任何依賴。

**Review 歷程**：SOL plan review（gpt-5.6-sol@xhigh·2026-07-10）6 findings（3H/2M/1L）全收——H1 T1 編譯保全（消費端最小遷移入 T1＋測試檔真實路徑勘誤）／H2 budget 語意矛盾＋截斷漏報（remainingBudget 鏈＋renderedCount 驗收＋budget 硬限）／H3 spec delta 擴列（免責文案/總數顯示/矩陣八組/基線）／M4 L 形雙分割取大（SOL 以 plan 自身錨構造反例：直放 90° 主 right-full 4>bottom-full 3，錨 11→12）／M5 混排極端分支驗收保護八項／L6 錨表結構化（fill cols×rows＋utilization 補全）。

## 法蘭四點反饋 → controller 定案（2026-07-10）

1. **toolbar 化**：`ImpositionControls` 從左側欄（w-64 直排）改為主區頂部橫排 toolbar（掛在 `ImpositionResults` 上方）；紙規／方向／裁切／可轉 90° 全部按鈕化（inline SVG 圖示＋文字標籤）；咬口、刀線間距保留數字輸入（toolbar 尾端小輸入框）；件選擇（多片盒型）保留下拉。
2. **混排補排**：L 形一層補排（不遞迴、不做異形咬合）——維持「單件外接矩形估算」定位。`allowRotate` 預設 **true**（法蘭：「大多數情況刀模可轉」）。0°/90° 兩卡語意升級為「0° 為主＋90° 補」vs「90° 為主＋0° 補」對照，兩卡同等權重不變（spec F9 沿用）。180° 混拼（頭尾對插）不需獨立處理：外接矩形下 0°/180° footprint 相同，計算等價——docblock 記明此語意，UI 不出現 180° 選項。
3. **cutV/cutH 可疊加**：法蘭原話「對開、四開等」＋指名參考 trouver ImpositionTool（該實作正是 cutV/cutH 兩布林可疊加、都開＝四開）。`SheetMode('full'|'halfV'|'halfH')` 型別退役。裁切後每子紙視獨立紙張進機、四邊（含新切邊）各留咬口——spec 對開語義沿用、推廣到四開。
4. **線寬統一**：排列預覽的刀模 paths 改 `vectorEffect="non-scaling-stroke"`＋原始 `style.strokeWidth`（與 `Canvas.tsx` 逐字同構）；`PREVIEW_STROKE_SCALE` 常數刪除。紙張外框／裁切線／可用區框同步改 non-scaling（整張預覽的線都是 screen-space 細線，縮放層級變動不再影響視覺粗細）。

## 數值錨（RTE 預設參數·製造 bounds 233.2×251·gripper 20·gap 3·31"×43"＝787×1092）

已用獨立 Python 腳本驗算（2026-07-10 controller）＋SOL plan review 逐列獨立重算交叉（第 4 列由 SOL 的雙分割反例修正 11→12；fill 結構化欄位由 SOL Low 6 補全）。expected 硬編碼於測試、不得由被測函式導出（沿用 spec F8 鐵則）；`bottomFill`/`rightFill` 斷言到 `cols×rows` 結構、不只 count：

| 情境 | 主格點 | fillSplit | bottomFill | rightFill | count/子紙 | totalCount | util |
|---|---|---|---|---|---|---|---|
| 直放·整紙·0° 主·關轉 | 3×4=12 | null | null | null | 12 | 12 | 81.73% |
| 直放·整紙·90° 主·關轉 | 2×4=8 | null | null | null | 8 | 8 | 54.49% |
| 直放·整紙·0° 主·開轉 | 3×4=12 | bottom-full（tie 0=0） | 2×0=0 | 0×4=0 | 12 | 12 | 81.73% |
| 直放·整紙·90° 主·開轉 | 2×4=8 | **right-full**（4>3） | 2×0=0 | 1×4=4 | 12 | 12 | 81.73% |
| **橫放·整紙·0° 主·開轉** | **4×2=8** | bottom-full（4>3） | **4×1=4** | 0×2=0 | **12** | **12** | 81.73% |
| 橫放·整紙·90° 主·開轉 | 4×3=12 | bottom-full（tie 0=0） | 4×0=0 | 0×2=0 | 12 | 12 | 81.73% |
| 直放·四開（cutV+cutH·子紙 393.5×546）·0° 主·開轉 | 1×2=2 | bottom-full（tie 0=0） | 0×0=0 | 0×2=0 | 2 | 8 | 54.49% |

粗體列＝法蘭 gate 反饋的實證案例（截圖：下方空白可放 4 模卻沒算進去）。第 4 列＝SOL 雙分割反例（right-full 的右側全高條帶 239×1052 放 1×4；固定 bottom-full 只有 1×3）——採雙分割後 0°/90° 兩卡在此組輸入下對稱收斂到 12。utilization 分子＝count×pieceW×pieceH（旋轉不改面積），分母＝子紙 w×h（扣咬口前）——公式不變，count 含補排。fill 條帶內 cols/rows 的語意：cols 沿條帶寬方向、rows 沿條帶高方向，件 footprint＝主方向旋轉 90° 後的寬高。

**回歸保證**：`allowRotate=false` 且單一裁切語意等價時（`full`→`cutV:false,cutH:false`、`halfV`→`cutV:true`、`halfH`→`cutH:true`），既有全部錨值（cols/rows/count/utilization）逐字不變——既有測試改參數形狀、不改 expected 數字。

## Global Constraints

- `LINE_STYLES` 不可改；`tests/fixtures/*.json` 不可改；`src/boxes/*`／`src/core/bounds.ts`／設計模式 `Canvas.tsx` 一律不動。golden／等價測試零影響。
- spec delta（SOL review High 3 擴列——原「僅取代兩條款」聲明不完整，以下條款全部以本 plan 為準）：本 plan **取代** `docs/specs/2026-07-10-imposition-design.md` 的 §作業模式（SheetMode 三選一→cutV/cutH 可疊加）、§排列預覽（PREVIEW_STROKE_SCALE→non-scaling-stroke）、**§免責聲明文案**（原「未計混向」與 90° 混排功能矛盾，新文案見下）、**§「不顯示原紙總模數」條款**（廢止——裁切時顯示「每子紙 × sections ＝ totalCount」正是本輪需求）、**§驗收計算矩陣**（直／橫 × 整紙／V／H 六組 → 直／橫 × 整紙／V／H／V+H 八組）、**§測試基線數字**（549→681）。其餘 spec 條款（F1 製造 bounds 硬規則、F3 輸入 domain、F5 footprint 判準、F6 state 生命週期、F9 兩卡同權、F10 cap 在建立前生效）沿用。驗收 expected 以本 plan 數值錨表為準。
- **免責聲明新文案**（取代 `DISCLAIMER_TEXT`）：「以單件外接矩形估算，僅計單層 L 形 90° 補排；未計遞迴塞角、異形咬合、共刀、絲向及加工限制，不可直接作生產拼版。」
- **主格點為 0 時不補排**：`gridCount=0` → `fillSplit=null`、兩條帶不計算（count=0＝「放不下」）——「0° 放不下但 90° 放得下」的情境由 90° 卡涵蓋，避免兩卡數字重複語意混淆。docblock 記明。實作注意：`gridCount=0` 時**先短路**再算 `usedW/usedH`（`(cols−1)×gap` 在 cols=0 時會出負值）。
- **preview cap 語意（SOL review High 2 定案）**：cap＝「每張方向卡各自最多 `MAX_PREVIEW_INSTANCES`（500）個 instance」（全紙合計、含所有子紙與補排件）。子紙順序固定**左上→右上→左下→右下**；逐子紙傳 `remainingBudget`、扣除實際回傳數量——**不做均分**。渲染驗收：`renderedCount = min(totalCount, MAX_PREVIEW_INSTANCES)`；截斷提示條件＝`totalCount > renderedCount`（原 per-子紙 `count > instances.length` 在四開情境會漏報——每子紙 150、全紙 600、實畫 500 時 150>500 恆 false）。`directionInstances` 對傳入 budget 正規化並硬限在 `0…MAX_PREVIEW_INSTANCES`（`NaN`/負值→0、`Infinity`/超大→500——公開函式不信任呼叫端）。cap 在建立物件前生效（O(limit) 不是 O(total)——Slice 4 High finding 的教訓不回退）。
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
src/core/imposition.ts        # T1：cutV/cutH/allowRotate 介面＋L 形雙分割補排＋sections 乘數
src/ui/ImpositionView.tsx     # T1：最小遷移（欄位改名＋雙呼叫退役）；T3：結果區全紙預覽重寫；T4：Controls toolbar 化
src/ui/App.tsx                # T1：ImpositionState 欄位遷移＋初始值；T4：拼版模式佈局改「toolbar＋results」直排
src/ui/impositionPreview.ts   # T2：instance 幾何擴充（補排件＋子紙偏移＋budget cap）
src/ui/impositionIcons.tsx    # T4 新增：inline SVG 圖示（紙規／直橫／cutV/cutH／旋轉）
tests/imposition-anchor.test.ts    # T1 修改：錨表更新（新增混排／四開錨）
tests/imposition.test.ts           # T1 修改：欄位形狀跟進＋新增混排極端/退化分支
tests/imposition-view.test.tsx     # T1 最小跟進；T3/T4 主要修改（root-level，無 tests/ui/ 目錄——SOL High 1 勘誤）
tests/imposition-app.test.tsx      # T1 最小跟進（allowRotate 預設 true 改變預設顯示 expected）；T4 修改（F6 往返欄位更新）
tests/imposition-preview.test.ts   # T2 修改＋新增
```

**依賴序**：T1（純計算＋**全 repo 編譯保全的最小遷移**）→ T2（預覽幾何純函式）→ T3（結果區渲染）→ T4（toolbar＋App 佈局）→ T5 樣張 gate（法蘭）。嚴格直線——T3/T4 都動 `ImpositionView.tsx`，不並行。

**T1 範圍聲明（SOL review High 1）**：T1 刪 `SheetMode`、改 `ImpositionInput`／`resolveWorkingSheet` 簽名——若只動 core，`ImpositionView.tsx`（`state.mode` 消費＋`resolveWorkingSheet(…,'full',…)` 雙呼叫）與 `App.tsx`（初始值）立即編譯失敗，違反「每 task 四 gate 全綠」。故 T1 **納入消費端最小遷移**：`ImpositionState.mode` → `cutV/cutH/allowRotate` 三欄、App 初始值 `{cutV:false, cutH:false, allowRotate:true}`、`computeImpositionView` 跟進新欄位與新 `WorkingSheet`（fullW/fullH 取代雙呼叫）、**作業模式下拉暫時保留原外觀**（options 改為 整紙/對開V/對開H/四開 四項、onChange 內部映射到 cutV/cutH——UI 形態不變、語意先到位），「可轉 90°」T1 先以 checkbox 掛在下拉旁（樣式從簡）。T4 才把這些改成 toolbar 按鈕。受影響測試（`tests/imposition-view.test.tsx`、`tests/imposition-app.test.tsx`）T1 做最小更新：欄位形狀＋**allowRotate 預設 true 使預設直放 90° 卡 expected 8→12**（雙分割）＋原「作業模式」下拉互動測試改走四項 options。

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
  cutV: boolean; cutH: boolean;   // 回帶裁切旗標——T2 sectionOffsets 不靠尺寸差猜切向（SOL High 2）
  sections: number;               // 子紙數＝(cutV?2:1)×(cutH?2:1)
}

/** 單一條帶的 90° 補排結果。cols/rows 是條帶內的格數（cols 沿條帶寬、rows 沿條帶高）；count=cols×rows。 */
export interface StripFill { cols: number; rows: number; count: number; }

export interface DirectionResult {
  cols: number; rows: number;      // 主格點（語意不變）
  gridCount: number;               // cols×rows（原 count 的舊語意）
  /** 勝出的 L 形分割（雙分割取大·tie 取 bottom-full）；null＝allowRotate=false 或 gridCount=0。
   *  T2 據此決定兩條帶的原點與尺寸（bottom-full：底條帶全寬＋右條帶高到 usedH；
   *  right-full：右條帶全高＋底條帶寬到 usedW）。 */
  fillSplit: 'bottom-full' | 'right-full' | null;
  bottomFill: StripFill | null;    // fillSplit=null → null；否則勝出分割下的底部條帶結果（可為 count 0）
  rightFill: StripFill | null;
  count: number;                   // gridCount＋兩 fill count（每子紙）
  totalCount: number;              // count × sections
  utilization: number;             // count×pieceW×pieceH／(w×h)——分母子紙全尺寸
}
```

**Steps:**
- [ ] RED：錨表測試更新——上方數值錨表 7 列逐列 hardcode expected（fillSplit＋bottomFill/rightFill 斷到 cols×rows 結構＋utilization）；`halfV`/`halfH` 舊語意等價錨（`cutV:true,cutH:false` 對舊 halfV 錨值不變）；四開 totalCount=count×4；`allowRotate=false` 全部既有錨逐字回歸。
- [ ] RED：混排極端/退化分支（SOL review Medium 5——既有極端測試全走 `allowRotate=false`，新分支需自己的驗收保護）：①`piece=800×50`＋開轉：0° `gridCount=0`→`fillSplit/兩fill=null`、count=0 ②一軸/兩軸 usable=0 ③`usedH+gap>usableH`（條帶高負值→`{0,0,0}`）④單列（rows=1）/單欄（cols=1）主排的 usedW/usedH（n=1 不多扣 gap）⑤`paper=MAX_DIMENSION_MM`＋`piece=MIN_DIMENSION_MM`＋四開＋開轉：新欄位全 finite、totalCount 為安全整數 ⑥殘餘條帶 exact-fit／差 `FIT_EPSILON_MM` 邊界 ⑦`cutV`/`cutH`/`allowRotate` hostile getter 各恰讀一次（snapshot 擴欄驗證）⑧`isFiniteDirectionResult` 深查兩 fill 的 cols/rows/count（不只外層 total）。
- [ ] `resolveWorkingSheet(paperW, paperH, orientation, cutV, cutH, gripper)`：方向交換（沿用）→ `cutV` 時 `w/=2`、`cutH` 時 `h/=2`（可疊加）→ 四邊扣咬口；回傳補 `fullW/fullH`（裁切前）＋`cutV/cutH` 回帶＋`sections`。呼叫端（ImpositionView）原本額外呼叫一次 `resolveWorkingSheet(…,'full',…)` 拿全紙的雙呼叫寫法退役——一次回傳給齊。
- [ ] L 形雙分割補排：主格點 `usedW=cols×pieceW+(cols−1)×gap`、`usedH` 同理（**gridCount=0 先短路**，不算 usedW/usedH）；分割 A「bottom-full」＝底條帶 `usableW×(usableH−usedH−gap)` 全寬＋右條帶 `(usableW−usedW−gap)×usedH`；分割 B「right-full」＝右條帶 `(usableW−usedW−gap)×usableH` 全高＋底條帶 `usedW×(usableH−usedH−gap)`；條帶內 90° 件（footprint 對調 pieceH×pieceW）跑同一 `fitCount`，條帶任一邊 ≤0 → `{cols:0,rows:0,count:0}`；**取補排總數較高的分割**，平手取 bottom-full。
- [ ] `computeDirection` 簽名擴充（傳入 allowRotate＋主/補 footprint）；`computeImposition` 組裝 deg0（0° 主＋90° 補）/deg90（90° 主＋0° 補）；input snapshot 加三個新欄位；`isFiniteDirectionResult` 涵蓋新欄位（深入 fill 內欄位）。
- [ ] 消費端最小遷移（見上方「T1 範圍聲明」）：`ImpositionState` 欄位、App 初始值、`computeImpositionView` 跟進、作業模式下拉四項化（內部映射）、可轉 90° checkbox（暫）、兩個 root-level UI 測試最小更新（90° 卡 8→12 等）。
- [ ] GREEN＋gate 四綠＋commit。

**急凍區**：`fitCount` 本體、`FIT_EPSILON_MM`、`MIN_GAP_MM`、domain 驗證三函式（checkDimension/checkGripper/checkGap）不動。

---

### Task 2: 預覽幾何——補排 instance＋子紙偏移＋全紙 cap

**Files:**
- Modify: `src/ui/impositionPreview.ts`
- Test: `tests/imposition-preview.test.ts`

**Interfaces（T3 逐字消費）:**
```ts
/** 單一子紙內的完整排列（主格點＋勝出分割的兩條帶補排件；補排件 dir 與主方向相反）。
 *  budget 正規化並硬限 0…MAX_PREVIEW_INSTANCES（NaN/負→0、Infinity/超大→上限）——
 *  公開函式不信任呼叫端（SOL review High 2）。 */
export function directionInstances(
  dir: 0 | 90,
  direction: DirectionResult,
  mb: Bounds,
  gripper: number,
  gap: number,
  budget: number,
): PreviewInstance[];

/** 子紙左上角偏移（全紙座標系）：讀 sheet.cutV/cutH 旗標（不靠尺寸差猜切向），
 *  順序固定左上→右上→左下→右下：整紙→[{0,0}]；cutV→左、右；cutH→上、下；四開→4 張。 */
export function sectionOffsets(sheet: WorkingSheet): { dx: number; dy: number }[];
```

**Steps:**
- [ ] RED：補排件 transform 代數驗證——bottom-full 與 right-full 兩種分割的條帶原點（bottom-full：底 `(gripper, gripper+usedH+gap)` 寬 usableW、右 `(gripper+usedW+gap, gripper)` 高 usedH；right-full：右同原點高 usableH、底同原點寬 usedW）；90° 補件旋轉修正沿用既有 `translate(h,0) rotate(90)` 鏈；sectionOffsets 四情境＋順序（左上→右上→左下→右下）＋讀旗標不猜尺寸；截斷順序（主格點 row-major → 底條帶 → 右條帶）；budget 邊界（`NaN`/負值→0、`Infinity`/`1e9`→硬限 500、恰為 0、恰截在主排/補排交界）。
- [ ] `instanceTransforms` 改名/擴充為 `directionInstances`：主格點沿用既有 row-major 反推；補排件的 cell 原點依 `direction.fillSplit` 決定條帶幾何，件 footprint 用旋轉後寬高。
- [ ] budget 語意：本模組只吃 budget 參數（正規化+硬限），不讀全域常數的分配邏輯；跨子紙的 remainingBudget 鏈由 T3 呼叫端負責（本模組單子紙）。
- [ ] GREEN＋gate 四綠＋commit。

---

### Task 3: 結果區——全紙預覽＋non-scaling stroke＋數字呈現

**Files:**
- Modify: `src/ui/ImpositionView.tsx`（`ImpositionResults`／`DirectionCard`／`computeImpositionView`）
- Test: `tests/imposition-view.test.tsx`

**Steps:**
- [ ] RED：卡片文字格式（整紙有補排：`{cols} 列 × {rows} 行 ＋ 補 {fillCount} ＝ {count} 模`，如橫放 0° 錨＝`4 列 × 2 行 ＋ 補 4 ＝ 12 模`；補 0 時不顯示「＋ 補 0」沿用舊格式；裁切時 `每半張 {count} 模 × 2 ＝ {totalCount} 模`／四開 `每四開 {count} 模 × 4 ＝ {totalCount} 模`——數字一律取錨表真值，不自創）；SVG 結構（全紙外框恆在＋cutV/cutH 中線 data-testid＋每子紙一個 `<g data-testid="section">`＋`renderedCount = min(totalCount, MAX_PREVIEW_INSTANCES)`）；**截斷提示＝`totalCount > renderedCount`**（含四開漏報回歸：每子紙 150、全紙 600、實畫 500 → 提示必須出現）；paths `vector-effect: non-scaling-stroke` 屬性斷言；`PREVIEW_STROKE_SCALE` 引用歸零。
- [ ] DirectionCard 預覽重寫：viewBox=`0 0 fullW fullH` 恆定（「要動的只有可落版區域」——切換裁切時紙不動）；裁切線畫全紙中線（cutV 豎／cutH 橫，可同時）；每子紙 `<g transform=translate(sectionOffset)>` 內畫咬口淡色區＋可用區＋`directionInstances`（補排件在同一份 instances 裡，旋轉已含在 transform）；**跨子紙 remainingBudget 鏈**（初始 `MAX_PREVIEW_INSTANCES`，逐子紙扣實際回傳數——不均分，子紙順序左上→右上→左下→右下）。
- [ ] 線寬統一：刀模 paths＝`strokeWidth={style.strokeWidth}`＋`vectorEffect="non-scaling-stroke"`（與 Canvas.tsx 同構）；外框／切線／可用區框同步 non-scaling（新常數組，px 語意，docblock 記明）。
- [ ] 數字行：`workingSheet` 文字行補全紙／子紙資訊（`全紙 787×1092，四開子紙 393.5×546（可用 353.5×506）`措辭 T3 現場定，測試斷數字存在不斷全文）。
- [ ] GREEN＋gate 四綠＋commit。

**測試現實**：jsdom 不做 SVG 佈局——斷 attribute（vector-effect／transform 字串／viewBox）不斷視覺；視覺可辨度是 T5 gate 的人眼職責。

---

### Task 4: toolbar 化＋SVG 圖示＋App 佈局

**Files:**
- Create: `src/ui/impositionIcons.tsx`
- Modify: `src/ui/ImpositionView.tsx`（`ImpositionControls`）、`src/ui/App.tsx`
- Test: `tests/imposition-view.test.tsx`、`tests/imposition-app.test.tsx`

**Steps:**
- [ ] RED：toolbar 按鈕組（紙規 3 preset＋自訂＝4 顆、直/橫 2 顆、cutV/cutH 2 顆 toggle、可轉 90° 1 顆 toggle）aria-pressed 狀態；自訂紙規點選展開 W/H 輸入；咬口/gap 輸入仍在（含既有欄位錯誤紅字）；F6 往返逐欄保留測試跟進 toolbar 形態（欄位遷移本身 T1 已完成——T4 把 T1 的暫時下拉/checkbox 換成按鈕）。
- [ ] `impositionIcons.tsx`：inline SVG（20×20、`stroke="currentColor"`、`fill="none"`、strokeWidth 1.5）——紙張直放（瘦高矩形）／橫放（寬扁矩形）／cutV（矩形＋豎虛線）／cutH（矩形＋橫虛線）／可轉 90°（矩形＋弧形旋轉箭頭）／三紙規＋自訂（矩形內小字或比例示意，T4 現場定）。純展示元件、零 props 邏輯。
- [ ] `ImpositionControls` 重寫為橫排 toolbar：分組（紙規｜方向｜裁切｜旋轉｜咬口/gap｜件）＋`flex flex-wrap gap-x-4 gap-y-2`；按鈕樣式沿用 App.tsx 模式切換鈕的 zinc 選中/未選慣例（`aria-pressed`＋`bg-zinc-900 text-white` 選中態）；數字輸入縮窄（w-20）。左側欄的拼版分支移除。
- [ ] `App.tsx`：拼版模式主區改 `<div className="flex flex-col">` toolbar＋results（初始值遷移 T1 已完成）；lazy initializer／fallback effect 不動。
- [ ] GREEN＋gate 四綠＋commit。

---

### Task 5: 樣張 gate（法蘭 E2E·本 plan 之外）

檢查點（原 T5 checklist 沿用＋本輪新增）：三 preset＋自訂／cutV/cutH 單開＋疊加（四開）／直橫／0°+90° 對照（**橫放 0° 主開轉＝8+4=12 模**——法蘭反饋案例回歸）／可轉 90° 開關對照／天地盒逐件／RTE 整件／邊界（超大咬口→放不下）／**線寬與設計模式目測一致**／全紙顯示切換裁切時紙不跳動。gate 過 → push＋tag v0.4.0。
