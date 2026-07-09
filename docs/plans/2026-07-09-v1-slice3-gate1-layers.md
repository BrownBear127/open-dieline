# open-dieline Slice 3 gate round 1 — 圖層系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** T6 gate 反饋——把 overlay 對照升級為圖層系統：生成刀模按線型分 4 層（可獨立顯示）、匯入 SVG 每份一個 overlay 圖層（置中預設＋選中拖曳＋校準/透明度/刪除）、SVG 匯出帶 `<g>` 圖層分組讓 Illustrator 開啟可分層操作。

**Architecture:** 「圖層」是一份資料模型的兩面：畫布的圖層面板（顯示過濾）與 SVG 匯出的 g 分組（同一個線型分桶函式）。生成側 4 個固定桶（cut/crease/halfcut/dimensions——由 `layerKeyForLineType` 從 `LineType` 導出）；匯入側 `OverlayLayer[]` 動態陣列（取代單體 OverlayState）。生成層位置由幾何參數定義不可拖；overlay 層選中後畫布拖曳＝改 offset。

**Tech Stack:** 同 Slice 1–3（Vite 6 / React 19 / TS 6 / vitest）。

**法蘭三定案（2026-07-09 gate 反饋收斂）**：①線型 3 層＋標註第 4 層（`includeDimensions` checkbox 退役、由圖層可見性取代）②匯入支援多個 overlay 圖層 ③匯出 g 命名＝英文 id＋中文 data-name。

## Global Constraints

- `LINE_STYLES` 不可改；`tests/fixtures/*.json` 不可改；RTE/telescope golden 與等價測試零影響（golden 斷幾何層、本輪只動渲染/匯出/UI——任何 `src/core/` 或 `src/boxes/` 改動都是越界）。
- **匯出恆全量**（plan 裁決、gate 驗收）：畫布圖層可見性純顯示，SVG 匯出恆含全部線型內容（AI 裡自行隱藏/刪除）、DXF 恆排除標註（既有裁決不變）。理由：匯出檔要完整，「忘了開層就匯出殘缺刀模」是生產事故。（勘誤 2026-07-09 final review：原文「恆含全部 4 層 g」與 T4「空桶不輸出 g」矛盾——語意以「內容恆全量、空桶不輸出空 g」為準，Codex final pass 抓到、controller 裁決。）
- `OVERLAY_STROKE` 常數與洋紅色值不變（gate 另案）；overlay 不進 `GenerateResult`、不進匯出、不 localStorage。
- 校準（T5 既有）語意不變：作用於**選中的** overlay 層；4px drag guard、Esc、visible gate 全保留。
- 程式風格：immutability、函式 <50 行、檔 <800 行、繁中註解僅記代碼看不出的約束。
- Commit 尾綴：
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SF3TGPV8efTNMXh6Jhwz3K
```

## File Structure

```
src/overlay/layers.ts        # 新增：OverlayLayer/LayersState 型別＋layerKeyForLineType＋純函式（create/update/remove）
src/overlay/state.ts         # 修改：舊 OverlayState 單體退役（保留 initialScaleGuess/alignOffset/calibrateScale/segmentsBounds 純函式，OverlayLayer 消費）
src/ui/LayersPanel.tsx       # 新增：圖層面板（生成 4 層 toggle＋overlay 層清單）——取代 OverlayPanel
src/ui/OverlayPanel.tsx      # 刪除（功能併入 LayersPanel）
src/ui/App.tsx               # 修改：LayersState 提升（includeDimensions 退役）
src/ui/Canvas.tsx            # 修改：4 桶過濾渲染＋多 overlay 疊繪＋選中層拖曳＋校準對象=選中層
src/ui/ExportBar.tsx         # 修改：includeDimensions props/checkbox 移除
src/export/svg.ts            # 修改：toSvgDocument 恆全量＋g 分組（id+data-name）
tests/overlay/layers.test.ts # 新增
tests/overlay/state.test.ts  # 修改：跟上型別遷移（純函式斷言不變）
tests/export/svg.test.ts     # 修改：g 分組結構斷言（幾何值斷言不變）
tests/ui/app.test.tsx        # 修改：圖層 UI 測試＋includeDimensions 測試改寫
```

**依賴序**：T1（純函式層，與 UI 共存編譯）→ T2（UI 原子遷移）→ T3（拖曳）→ T4（匯出 g 分組，與 T2/T3 無耦合但依序執行）→ T5 gate。

---

### Task 1: 圖層資料模型與純函式層

**Files:**
- Create: `src/overlay/layers.ts`
- Modify: `src/overlay/state.ts`（只加 export 不刪——UI 遷移在 T2）
- Test: `tests/overlay/layers.test.ts`

**Interfaces:**
- Consumes: `Segment`/`Bounds`/`segmentsBounds`（既有）、`OverlayParseResult`（parse.ts）、`initialScaleGuess`/`alignOffset`（state.ts 既有純函式）
- Produces（T2/T3/T4 逐字消費）:
  ```ts
  export type GeneratedLayerKey = 'cut' | 'crease' | 'halfcut' | 'dimensions';
  export const GENERATED_LAYER_ORDER: readonly GeneratedLayerKey[] = ['cut', 'crease', 'halfcut', 'dimensions'];
  export const GENERATED_LAYER_LABEL: Readonly<Record<GeneratedLayerKey, string>> = {
    cut: '切割線', crease: '摺線', halfcut: '半刀', dimensions: '尺寸標註',
  };
  // LineType → 圖層桶。cut/crease/halfcut 對號；DIMENSION_LINE_TYPES（dimension/annotation）→
  // 'dimensions'；bleed → 'dimensions'（輔助線類；v1 無任何盒型產 bleed paths，此分支
  // 不可達，僅為 exhaustive mapping——docblock 記明）。texts 恆屬 'dimensions'（v1 texts
  // 全部來自 dimensionLine 標註，見 svg.ts 檔頭 docblock）。
  export function layerKeyForLineType(t: LineType): GeneratedLayerKey;

  export interface OverlayLayer {
    id: string;            // `overlay-${n}`，n 由 App 遞增計數（不用 Date.now——確定性）
    name: string;          // 來源檔名去 .svg 副檔名
    segments: Segment[];   // parse 原始輸出（不預變換）
    warnings: string[];
    scale: number;
    offsetX: number; offsetY: number;   // mm
    opacity: number;       // 預設 0.5
    visible: boolean;      // 預設 true
    calibrated: boolean;   // T5 單位下拉 precedence 沿用（校準過→單位變更提示覆蓋）
    rawBounds: Bounds;
  }
  export interface LayersState {
    generatedVisible: Record<GeneratedLayerKey, boolean>;  // 預設全 true
    overlays: OverlayLayer[];
    selectedOverlayId: string | null;   // 選中→可拖曳/校準對象
  }
  export function initialLayersState(): LayersState;
  // 置中預設（gate 反饋①）：offset = alignOffset(rawBounds, scale, targetBounds, 'center')
  export function createOverlayLayer(
    parsed: OverlayParseResult, name: string, unit: 'pt' | 'mm' | 'px',
    targetBounds: Bounds, id: string,
  ): OverlayLayer;
  // 不可變更新：回新陣列/新物件
  export function updateOverlayLayer(layers: OverlayLayer[], id: string, patch: Partial<OverlayLayer>): OverlayLayer[];
  export function removeOverlayLayer(layers: OverlayLayer[], id: string): OverlayLayer[];
  ```
- `state.ts` 的 `OverlayState`/`createOverlayState` 本 task 不動（T2 遷移後刪）；`initialScaleGuess`/`alignOffset`/`calibrateScale`/`findNearestOverlaySegment`/`OVERLAY_STROKE` 全保留原樣供新層消費。

- [ ] **Step 1: 失敗測試** `tests/overlay/layers.test.ts`：
  ```ts
  // layerKeyForLineType：cut/crease/halfcut 對號；dimension→dimensions；annotation→dimensions；
  //   bleed→dimensions（exhaustive、含 docblock 理由斷言不了——測行為即可）
  // initialLayersState：generatedVisible 四鍵全 true、overlays 空、selectedOverlayId null
  // createOverlayLayer：手組 parsed（兩條 line、rawBounds 已知）＋targetBounds→
  //   斷言 scale=initialScaleGuess 結果、offset=alignOffset center 手算值、opacity 0.5、
  //   visible true、calibrated false、segments 引用相等（toBe——不預變換）
  // updateOverlayLayer：patch offsetX→新陣列（不 mutate 原陣列 toBe 檢查）、其他層原引用
  // removeOverlayLayer：移除後長度-1、原陣列不 mutate
  ```
- [ ] **Step 2: 確認失敗**（`npx vitest run tests/overlay/layers.test.ts`——模組不存在）
- [ ] **Step 3: 實作 `layers.ts`**（layerKeyForLineType 消費 svg.ts 的 `DIMENSION_LINE_TYPES`——同一份過濾定義，防漂移）
- [ ] **Step 4: 綠＋typecheck**（`npm run typecheck && npx vitest run`）
- [ ] **Step 5: Commit** `feat: 圖層資料模型（生成 4 桶＋OverlayLayer 多層、置中預設）`

---

### Task 2: UI 原子遷移——LayersPanel＋Canvas 分桶渲染＋includeDimensions 退役

**Files:**
- Create: `src/ui/LayersPanel.tsx`
- Delete: `src/ui/OverlayPanel.tsx`
- Modify: `src/ui/App.tsx`、`src/ui/Canvas.tsx`、`src/ui/ExportBar.tsx`
- Test: `tests/ui/app.test.tsx`、`tests/overlay/state.test.ts`（OverlayState 退役連動）

**Interfaces:**
- Consumes: T1 全部＋既有 `parseOverlaySvg`/`manufacturingBounds`/校準機制
- Produces: App 持有 `layersState: LayersState`（單一 useState）＋`setLayersState`；Canvas props 改 `layers: LayersState`＋`onLayersChange`（校準寫回）；LayersPanel props＝`layers`/`onLayersChange`/`targetBounds`/校準模式 props（沿用 OverlayPanel 既有）

**規格：**
- **LayersPanel**（側欄、ParamPanel 之後，容器視覺沿用 zinc 淺色工程風）：
  - 上段「生成圖層」：GENERATED_LAYER_ORDER 四列，每列＝可見 checkbox＋GENERATED_LAYER_LABEL 中文名。RTE 無 halfcut paths 時 halfcut 列仍顯示（disabled 樣式、title「此盒型無半刀線」）——列表恆定四列比動態增減穩定。
  - 下段「對照圖層」：「匯入生產 SVG」file input（既有 accept/.svg/FileReader/重掛載 key 機制照搬）＋單位下拉（既有）；匯入→`createOverlayLayer`（置中預設）append＋自動選中新層。每層一列：層名（檔名）＋可見眼睛 toggle＋透明度 slider（0–100）＋校準鈕（進校準模式、對象=該層；沿用既有 visible gate + disabled 邏輯）＋刪除鈕。點列名＝選中/取消選中（選中列高亮邊框）；warnings 顯示在對應層列下（黃底小字、既有樣式）。
  - 「重新置中」鈕（選中層可用）：offset 重算 `alignOffset(..., 'center')`。快速對齊三鈕（左上/中心/bbox）退役。
  - 頂部用途說明文字沿用（spec §5 文案）。
- **Canvas**：
  - 生成側：per path 渲染前過 `generatedVisible[layerKeyForLineType(path.type)]`；texts 過 `generatedVisible.dimensions`。原 `includeDimensions` prop 刪除。invariant 警告高亮、hover、fit/bounds 邏輯**不受圖層可見性影響**（高亮的目標線被隱藏時就是看不到——可接受、docblock 記）。
  - overlay 側：`layers.overlays.filter(o => o.visible && o.segments.length > 0)` 逐層 `<g transform>` 疊繪（既有單層渲染邏輯 map 化；每層各自 opacity）。選中層 stroke 加粗（既有校準高亮的加粗樣式沿用為「選中」視覺）。
  - 校準模式：hit-test 對象＝**選中層**的 segments（原單體 overlay 改選中層；未選中時校準鈕已 disabled 故不可達，防禦 early return 照舊）。
- **App**：`overlayState`/`setOverlayState`/`includeDimensions` 三個 state 退役→`layersState` 單一 state＋`overlayIdCounter`（useRef 遞增）。`targetBounds` 計算保留（FX3 的 manufacturingBounds）。切盒型（boxId change）時 overlays 保留（對照檔跨盒型仍有意義——docblock 記裁決）、selectedOverlayId 保留。
- **ExportBar**：`includeDimensions`/`onIncludeDimensionsChange` props＋checkbox 移除（匯出語意 T4 收斂——本 task 先讓 SVG 匯出暫時恆含標註、T4 接手 g 分組）。
- **測試改寫**：app.test.tsx 的 includeDimensions 同步測試（Slice 2 T9 修復 3 回歸測試）改寫為「dimensions 圖層 toggle 影響畫布 texts/dimension paths 顯示」；overlay 匯入/透明度/清除/校準流程測試改多層語意（匯入兩份→兩層各自 toggle）；`tests/overlay/state.test.ts` 移除 createOverlayState 相關（T1 的 layers.test.ts 已覆蓋等價功能）。

- [ ] **Step 1: 失敗測試**（先寫 app.test.tsx 新語意：匯入→自動置中＋選中；兩層獨立 opacity/visible；dimensions toggle 畫布同步；halfcut disabled 列；重新置中）
- [ ] **Step 2: 確認失敗** → **Step 3: 實作**（layers state→LayersPanel→App→Canvas→ExportBar→刪 OverlayPanel）
- [ ] **Step 4: 綠＋typecheck＋build**（RTE/telescope/parse/dxf/svg 既有測試零影響）
- [ ] **Step 5: Commit** `feat: 圖層面板（生成 4 層＋多 overlay 層、置中預設、includeDimensions 退役）`

---

### Task 3: 選中 overlay 層的畫布拖曳

**Files:**
- Modify: `src/ui/Canvas.tsx`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: T2 的 `layers.selectedOverlayId`＋`onLayersChange`；Canvas 既有 pan（`handleMouseDown/Move/Up`＋`isDragging`）與 `dragStartPosRef`（T5 gate fix）
- Produces: 拖曳交互——**校準模式 > 選中 overlay 拖曳 > pan** 的 mousedown 分流

**規格：**
- 選中 overlay 層（selectedOverlayId 非 null 且該層 visible）時：mousedown→拖曳＝即時更新該層 offsetX/offsetY（螢幕 delta ÷ canvas zoom＝mm delta；offset 在渲染變換 `translate(offset) scale(overlayScale)` 的外側＝mm 域，**不除 overlay.scale**——docblock 記這個易錯點）。游標 `move`。
- 未選中＝pan 照舊；校準模式中＝既有行為（pan 可用、click 走 hit-test＋4px guard）——校準模式優先於拖曳分流（校準中不拖 overlay）。
- 拖曳結束（mouseup）才算一次操作；拖曳過程 offset 即時反映（受控更新、React state 每 mousemove——v1 接受、量級小）。
- Esc（非校準模式）＝取消選中（LayersPanel 高亮同步消失）。

- [ ] **Step 1: 失敗測試**：選中層＋mousedown(100,100)→mousemove(150,130)→斷言該層 offset 增量=(50/zoom, 30/zoom) 手算值、其他層 offset 不變；未選中同序列→offset 全不變（pan 路徑）；校準模式中同序列→offset 不變；Esc 取消選中
- [ ] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 綠＋typecheck＋build**
- [ ] **Step 5: Commit** `feat: 選中 overlay 圖層畫布拖曳（校準>拖曳>pan 分流）`

---

### Task 4: SVG 匯出 g 圖層分組（Illustrator 工作流）

**Files:**
- Modify: `src/export/svg.ts`、`src/ui/ExportBar.tsx`（呼叫端簽名跟上）
- Test: `tests/export/svg.test.ts`

**Interfaces:**
- Consumes: T1 `layerKeyForLineType`/`GENERATED_LAYER_ORDER`/`GENERATED_LAYER_LABEL`（**跨模組 import 方向注意**：svg.ts 是 export 層、layers.ts 在 overlay/——若 import 方向彆扭（export 依賴 overlay），把 `layerKeyForLineType`＋相關常數搬到 `src/core/layers.ts`（純型別/映射、無 UI 依賴），overlay/layers.ts re-export——implementer 依實際耦合判斷並在 report 記，兩案皆可）
- Produces: `toSvgDocument(result: GenerateResult): string`——`includeDimensions` opts 參數退役、恆全量輸出

**規格：**
- ENTITIES 結構：paths 按 `layerKeyForLineType` 分 4 桶，每桶非空時輸出 `<g id="CUT" data-name="切割線">…</g>`（id 對照表：cut→CUT、crease→CREASE、halfcut→HALFCUT、dimensions→DIMENSIONS——**與 DXF_LAYER_BY_LINETYPE 的圖層名一致**，跨格式同名；data-name＝GENERATED_LAYER_LABEL）。texts 全部進 DIMENSIONS g（v1 texts 全來自標註）。空桶不輸出 g（RTE 無 halfcut→無 HALFCUT g——AI 圖層面板不出現空群組）。
- g 內 path 的樣式/座標/排序與現行完全一致（幾何零變——只是包了一層 g）。
- `includeDimensions` 匯出語意退役（plan 裁決：匯出恆全量、AI 裡自行操作；gate 驗收）。ExportBar 呼叫端簽名跟上（T2 已移除 UI checkbox）。
- viewBox/寬高計算不變（含標註的整體 bounds——匯出恆全量所以恆用全 bounds，原 includeDimensions=false 時的窄 viewBox 分支一併退役）。
- svg.test.ts：既有幾何/樣式斷言保留（更新 DOM 路徑深一層）；新增 g 結構斷言（4 桶 id/data-name、RTE 無 HALFCUT g、telescope 有 HALFCUT g、texts 在 DIMENSIONS 內、id 恰不重複）。

- [ ] **Step 1: 失敗測試** → **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 綠＋typecheck＋build**（golden/等價/fixture 零影響——它們斷幾何層）
- [ ] **Step 5: Commit** `feat: SVG 匯出按線型分 g 圖層（id 英文+data-name 中文、恆全量、AI 可分層操作）`

---

### Task 5: gate round 2（法蘭驗收）

- [ ] final review（單軌 Sonnet whole-round 即可——本輪無新深水區演算法；Codex 可選加跑迴歸 pass）
- [ ] 法蘭操作驗收：
  - 匯入 2 份生產 SVG→各自置中/校準/透明度/拖曳對照
  - 生成 4 層開關（只看摺線、只看切割線的對照手感）
  - 匯出 SVG 開進 Illustrator：確認 4 個命名群組（中文 data-name 顯示）、可獨立隱藏/鎖定、Release to Layers 可轉真圖層
  - 拖曳手感 vs 前版數字微調
- [ ] gate 反饋迭代 → 全過後 tag `v0.3.0`＋push（原 T6 的 DXF 廠商流程驗證合併在此輪 gate）

---

## Self-review 記錄（writing-plans checklist）

1. **需求覆蓋**：gate 反饋①置中預設（T1 createOverlayLayer）＋手動拖曳（T3）；②圖層顯示/隱藏/刪除（T2）＋線型分層（T1 桶+T2 渲染）＋匯入獨立層（T2 多層）；③AI 開啟分層（T4 g 分組——已 WebSearch 驗證：頂層 g→AI 命名群組、可獨立操作、Release to Layers 轉真圖層）。三定案（4 層/多 overlay/id+data-name）全落 task。
2. **Placeholder 掃描**：無 TBD；T4 的 import 方向留兩案是明確的裁量點（附判準與退路），非 placeholder。
3. **型別一致性**：`LayersState`/`OverlayLayer`/`layerKeyForLineType`/`GENERATED_LAYER_LABEL` T1 定義、T2/T3/T4 逐字消費；`createOverlayLayer` 簽名 T1↔T2 一致。
4. **已知風險前置**：includeDimensions 退役的測試改寫範圍點名（Slice 2 T9 回歸測試）；匯出恆全量是行為變更（plan 裁決標記 gate 驗收）；拖曳 mm 換算不除 overlay.scale 的易錯點寫進 T3 規格；T4 import 方向的架構彆扭預先給退路。
5. **Slice 3 記帳項連動**：本輪不動 pieceManufacturingBounds 口徑（照 final review ③行動點條件——沒動 ExportBar 檔名邏輯）；ensureRegistered infra debt 若 T2 大改 app.test.tsx 順手根治（afterEach 回復全部 fake boxes、4 行）——T2 implementer 裁量、report 記。
