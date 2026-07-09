# 拼版估算（Imposition Estimator）設計 Spec

> 狀態：v1.1——spec review 10 findings（1 Critical／7 Important／2 Minor）全收修訂（2026-07-10）
> 需求來源：2026-07-10 法蘭口述定案
> **本文完整取代總體 spec（`2026-07-07-open-dieline-v1-design.md`）§7；兩文衝突時以本文為準。**
> 總體 spec §3.1 目錄、§7、§8 拼版測試列、§10#6 已同步改為本文摘要與指向。

## 目標與定位

教育示範用的快速估算器：回答「這個盒型的某一件，在目標紙張上能拼幾模」。

**明確非目標**：這不是正式拼版工具。真實生產的拼版（混向塞角、多件合拼、共刀、
印刷加工限制）複雜度高且案件差異大，仍由人工處理。本功能示範拼版的基本幾何
邏輯與紙張利用概念。

## 需求（法蘭定案）

| 項目 | 定案 |
|------|------|
| 拼版單位 | 單件（多片盒型逐件選、各自估算） |
| 常用紙規 | 31"×43"、25"×35"、27"×39" 三種＋自訂 |
| 作業模式 | 整紙或對開（切半），可選 |
| 咬口 | 四邊各留 2cm（天地咬口為主；借邊的極端排法不在 scope） |
| 刀線間距 | 最少 3mm（不共刀）——**硬下限**（見輸入 domain） |
| 方向 | 0° 與 90° 兩個結果都顯示，絲向由人工判斷 |

## 功能規格

### 模尺寸的定義（review F1·Critical）

拼版的模尺寸一律使用「**製造 bounds**」，**不得直接使用 `GenerateResult.bounds`
或 `DielinePiece.bounds`**：

- 多片盒型：依所選 piece 的 `pathIds` 取 paths；單片盒型（RTE）：取全部 paths
- 兩者都排除 `DIMENSION_LINE_TYPES`（dimension／annotation）與 texts，
  以剩餘 segments 取 tight bounds
- **依據（2026-07-10 實證）**：RTE 的 `result.bounds` 含四邊各 20mm 畫布留白
  （declared 273.2×291 vs 製造 233.2×251）；天地盒 piece bounds 含尺寸標註線外擴。
  用 declared bounds 在 31"×43" 下算出 6 模，正確為 12 模——主要輸出差一倍
- 實作：把 `src/export/svg.ts` 的 `manufacturingBounds(result, piece?)` 與
  `DIMENSION_LINE_TYPES` 遷移至 core（`src/export/svg.ts` re-export 保持既有
  消費端相容——同 gate round 1 遷移 `layerKeyForLineType` 的手法）；
  `src/core/imposition.ts` 不得依賴 export 模組
- 計算與預覽共用同一份製造 paths／bounds（防卡片與畫面漂移）

### 件選擇與狀態生命週期（review F6）

| 規則 | 定案 |
|---|---|
| state 分離 | `impositionPieceId` 獨立於設計模式的 `selectedPieceId`；拼版**沒有** `null＝全版` 語意 |
| 預設值 | 多片盒型預設第一個有效 piece |
| 失效 fallback | 選中件消失（如 `linerEnabled=false`）或切換盒型 → 立即改選第一個有效 piece |
| RTE | 顯示固定「整件」，不建立可失效的 piece id |
| 模式往返 | 盒型、盒參數、紙規、方向、作業模式、咬口、gap、拼版件選擇**全部保留**（逐欄列舉，不用「任何參數」概括） |
| 校準互斥 | 進入拼版模式即退出 `calibrating`；overlay 資料保留但不顯示 |
| 組裝 | `App` 只生成一次 `result`；側欄保留盒型選擇與 ParamPanel，依 mode 切換 LayersPanel／ExportBar ↔ 拼版控制；主區切換 Canvas ↔ 拼版預覽 |

### 紙規與 working sheet 轉換鏈（review F4）

紙規 preset（mm 標稱值沿用台灣紙業慣例）：
- 31"×43" ＝ 787×1092
- 25"×35" ＝ 635×889
- 27"×39" ＝ 686×991（2026-07-10 法蘭確認）
- 自訂：W×H 數字輸入

**唯一轉換順序**（`resolveWorkingSheet` 純函式，計算卡、尺寸文字、切線示意
全部消費同一個 resolved result）：

1. preset／自訂 → source W/H
2. 直放／橫放 → 交換 W/H
3. 整紙／對開 V（W/2）／對開 H（H/2）→ working W/H
4. working sheet 四邊各扣一次咬口 → 可用區

- 對開語義：切開後的半張視為獨立紙張進機，四邊（含新切邊）都留咬口
- **N 與利用率都以 working sheet 計算**；對開時 UI 明標「每半張 N 模」。
  原紙總模數（2N）不顯示——若需要屬新需求，不得暗中替換 N
- UI 顯示 working sheet 尺寸文字；對開切線示意畫在「原紙來源」位置，
  與 working half 的可用區分開，避免誤讀為半張還要再切

### 輸入 domain（review F3）

咬口：預設 20mm，可調，四邊等距。gap：預設 3mm，可調。

| 輸入 | 有效域 | 無效時的行為 |
|---|---|---|
| 紙 W/H（自訂） | finite 且 > 0 | 欄位錯誤標示＋兩卡結果顯示「—」＋不渲染排列 |
| 件 W/H | finite 且 > 0（由製造 bounds 導出，生成器保證） | 同上（防禦性） |
| 咬口 | finite 且 ≥ 0 | 同上 |
| gap | **finite 且 ≥ 3**（定案表廠規為硬下限；0–2.9mm 的非標準情況不示範） | 同上 |
| 咬口過大（可用區 ≤ 0） | 屬**合法輸入** | 0 模＋「放不下」狀態（不是錯誤） |

純函式契約：無效輸入回傳 typed invalid result（discriminated union），
不讓 NaN／Infinity 流到 UI。

### 計算（純函式·review F5）

```
可用區 W' = workingW − 2×咬口
可用區 H' = workingH − 2×咬口
n 件放得下 ⟺ n×件寬 + (n−1)×gap ≤ W' + FIT_EPSILON_MM   （footprint 判準）
cols = 滿足上式的最大 n（0°：件寬對 W'；rows 同理件高對 H'）
90°：件寬／件高互換，同式
N = cols × rows
利用率 = N × 件寬 × 件高 ÷ (workingW × workingH)，顯示固定兩位小數
```

- `FIT_EPSILON_MM = 1e-6`（具名常數；吸收浮點噪音，不吸收實際公差）。
  依據：件寬 30、gap 3.1、W'=228.6 時 7 件 footprint 恰為 228.6，
  但 JS 除法得 6.999…，裸 `floor` 會少算一模
- 實作可先 `floor((W'+gap)/(件寬+gap))` 取初值，再以 footprint 判準修正 ±1
- 邊界：任一向 0 → 該方向 N=0＋UI「放不下」；不報錯

### 輸出（UI）

- 兩方向卡片並列，**同等權重、無「最佳／推薦」標記**（review F9）：
  各顯示 `列 × 行 ＝ N 模`、**外接矩形利用率** %（兩位小數）
- 結果區固定顯示界線聲明（review F9）：
  「以單件外接矩形估算；未計混向、塞角、共刀、絲向及加工限制，不可直接作生產拼版。」
- 排列預覽（review F7）：
  - 線段來源＝製造 paths 中 `cut`／`crease`／`halfcut` 三線型；
    **忽略設計模式的圖層可見性**、dimension／annotation／texts／overlays
  - 輪廓先正規化到局部 (0,0)（平移 −製造 bounds 的 min）；
    0° 套 gripper＋cell offset；90° 先旋轉、補回旋轉後的軸向位移、再套 cell offset
  - cell step ＝ 旋轉後寬／高 ＋ gap；cols 沿紙張 X、rows 沿紙張 Y
  - 畫面：紙張外框＋咬口區淡色標示＋排列 instances＋（對開時）切線示意
  - `MAX_PREVIEW_INSTANCES = 500`（具名常數·review F10）：count 永遠精確顯示；
    超過上限時預覽只畫前 N 模或簡化格線＋「數量過大，預覽已簡化」提示

## 驗收條件（review F8 全面重寫）

1. **數值錨**（expected 硬編碼於測試、不得由被測函式導出）：RTE 預設參數
   製造 bounds＝233.2×251；31"×43" 整紙直放、咬口 20、gap 3 →
   working 787×1092、可用區 747×1052、0°＝3×4＝12 模（81.73%）、
   90°＝2×4＝8 模（54.49%）
2. **bounds 硬規則**：測試斷言拼版不使用 `result.bounds`／`piece.bounds`
   （declared 與製造 bounds 不同時，拼數以製造 bounds 為準）
3. **計算矩陣**：直／橫 × 整紙／V／H 六組合；三個 preset 各驗常數＋自訂一例；
   兩方向都驗 `{cols, rows, count, utilization}`
4. **浮點邊界**：exact fit（30／3.1／228.6 案例）、fit−ε、fit＋ε 三測試；
   兩軸與 90° 共用同一 helper
5. **輸入 domain**：0／負／NaN／Infinity → typed invalid＋UI「—」不渲染；
   咬口過大 → 0 模非錯誤；單一方向放不下、另一方向正常計算
6. **state 生命週期**：模式往返後列舉欄位全保留；換片／`linerEnabled=false`／
   換盒型 → fallback 第一個有效 piece；進拼版模式退出 `calibrating`
7. **預覽**：instance 數＝count（cap 內）；線型集合固定三線型；
   設計模式圖層全隱藏時拼版輪廓仍完整；以非零 minX／minY 的 fixture 驗證
   90° 變換後全部 instance bounds 落在可用區內；超 cap 顯示簡化提示
8. **對開語義**：對開 V 結果＝以（方向處理後 W/2）×H 為 working sheet 的
   整紙計算；UI 顯示「每半張」單位與切線示意
9. **即時性**：紙規／方向／作業模式／咬口／gap／盒參數／件選擇任一改值 →
   兩卡與預覽同步重算
10. 既有測試基線（549，以當前 main 為準）全綠——拼版為新增模組，
    不動既有幾何／匯出路徑

## Non-goals（明確不做）

- 混向拼（部分件轉 90° 塞邊角）
- 多件合拼同一張版
- 共刀（相鄰模共用刀線）
- 印刷加工限制建模（軋型、燙金、裱糊等生產約束）
- 拼版結果匯出 SVG/DXF（給廠的正式拼版檔仍由人工製作；匯出列在拼版模式下隱藏）
- 絲向自動判斷／方向推薦
- 借用咬口空間的極端排法
- 對開時顯示原紙總模數（2N）——若需要屬新需求

## 技術要點

- `src/core/imposition.ts`：`resolveWorkingSheet`＋排列計算純函式；
  `FIT_EPSILON_MM`／`MAX_PREVIEW_INSTANCES`／`PAPER_PRESETS` 具名常數；
  typed invalid result；**零 React 依賴、零 export 模組依賴**
- `manufacturingBounds`＋`DIMENSION_LINE_TYPES` 遷移至 core
  （如 `src/core/bounds.ts`），`src/export/svg.ts` re-export 保相容
- `src/ui/ImpositionView.tsx`：預覽＋輸入面板＋兩方向卡片＋界線聲明
- `App.tsx`：mode state（`'design' | 'imposition'`）＋`impositionPieceId`＋
  進拼版退 calibrating
