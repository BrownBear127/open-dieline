# open-dieline v1 Slice 3 — DXF 匯出＋Overlay 對照 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DXF R12 匯出（刀模廠交付格式）＋生產刀模 SVG 的 1:1 overlay 對照層（匯入→校準→疊圖調參）。

**Architecture:** DXF writer 為純 TS 零依賴模組，直接消費 `core/geometry` 的 Segment（bezier 離散復用既有 `flattenBezier`——spec §6.2 的弦高 0.1／單段 5mm 就是它的預設值）。Overlay 為獨立顯示層：SVG 子集 parser → `Segment[]`＋校準變換（scale/offset），只進 Canvas 疊繪、**不進 `GenerateResult`**、不參與不變式/golden/匯出。

**Tech Stack:** 同 Slice 1/2（Vite 6 / React 19 / TS 6 / vitest / tailwind 4）。SVG 解析用瀏覽器內建 `DOMParser`（測試環境 jsdom 已有）。

**Spec:** `docs/specs/2026-07-07-open-dieline-v1-design.md` v1.2 §5（Overlay）、§6.2（DXF）、§8（測試策略 DXF 行）、§12（風險：R12 相容性由法蘭真實廠商流程驗）。

## Global Constraints

- `LINE_STYLES`（cut #000000／crease #00FF00／halfcut #FFFF00／dimension #3B82F6）不可改。overlay 洋紅是新常數 `OVERLAY_STROKE = '#FF00FF'`，宣告在 overlay 模組內、**不進 LINE_STYLES**（它不是刀模線型）。
- **既有幾何零改動**：本 slice 純新增功能——RTE/telescope 的 golden、等價測試、`tests/fixtures/*.json` 全部不得變。
- DXF 座標單位＝mm（與 Segment 同）、角度單位＝**度**（DXF 慣例；Segment 用弧度，writer 內轉換）。
- DXF **恆排除** `dimension`/`annotation` 線型與全部 texts——DXF 是給刀模廠的生產檔，標註是給人看的（與 SVG 的 `includeDimensions` 可選不同；UI 上 DXF 下載不受該 checkbox 影響，按鈕旁不需說明、程式註解記理由即可）。
- Overlay 是 session 級狀態（不 localStorage、不進匯出）；`GenerateResult` 型別不動。
- 程式風格同前：immutability、函式 <50 行、檔 <800 行、繁中註解僅記「代碼看不出的約束」。
- Commit 尾綴：
```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SF3TGPV8efTNMXh6Jhwz3K
```

## File Structure

```
src/export/dxf.ts            # 新增：DXF R12 writer（吃 GenerateResult）
src/overlay/parse.ts         # 新增：SVG 子集 → Segment[]（含 transform 展平、警告清單）
src/overlay/state.ts         # 新增：OverlayState 型別＋校準/對齊純函式
src/ui/OverlayPanel.tsx      # 新增：匯入/透明度/開關/對齊/校準 UI（側欄區塊）
src/ui/ExportBar.tsx         # 修改：＋「下載 DXF」（全版/單片同 SVG 模式）
src/ui/Canvas.tsx            # 修改：overlay 疊繪層＋點選校準 hit-test
src/ui/App.tsx               # 修改：overlay state 提升＋OverlayPanel 掛載
tests/export/dxf.test.ts     # 新增：writer 單元＋round-trip 解析
tests/overlay/parse.test.ts  # 新增：parser 全元素/transform/警告
tests/overlay/state.test.ts  # 新增：校準/對齊純函式
tests/ui/app.test.tsx        # 修改：DXF 下載＋overlay UI 冒煙
```

**依賴序**：T1（dxf.ts 純函式）→ T2（ExportBar 接線）；T3（parse.ts 純函式）→ T4（state＋Panel＋Canvas 疊繪）→ T5（點選校準）。T1/T2 與 T3/T4/T5 兩條線互相獨立，但**依序執行**（SDD 不並行 implementer）。

---

### Task 1: DXF R12 writer

**Files:**
- Create: `src/export/dxf.ts`
- Test: `tests/export/dxf.test.ts`

**Interfaces:**
- Consumes: `GenerateResult`（core/types）、`Segment`／`flattenBezier`（core/geometry——**復用，不重寫離散**）
- Produces: `toDxfDocument(result: GenerateResult): string`（R12 ASCII 全文）；`DXF_LAYER_BY_LINETYPE`（LineType→圖層名映射，T2 測試引用）

**規格（spec §6.2＋本 plan 裁決）：**

```ts
// LineType → DXF 圖層與 AutoCAD color index（ACI）
// cut→CUT(7 黑/白)、crease→CREASE(3 綠)、halfcut→HALFCUT(2 黃)
// dimension/annotation → 不輸出（生產檔；理由見 Global Constraints）
export const DXF_LAYER_BY_LINETYPE: Readonly<Partial<Record<LineType, string>>> = {
  cut: 'CUT',
  crease: 'CREASE',
  halfcut: 'HALFCUT',
};

// R12 ASCII 骨架（group code 與值逐行、\r\n 或 \n 擇一全檔一致——用 \n）：
// 0/SECTION 2/HEADER 9/$ACADVER 1/AC1009 0/ENDSEC
// 0/SECTION 2/TABLES 0/TABLE 2/LAYER 70/3
//   ×3: 0/LAYER 2/<name> 70/0 62/<aci> 6/CONTINUOUS
// 0/ENDTAB 0/ENDSEC
// 0/SECTION 2/ENTITIES … 0/ENDSEC 0/EOF
```

- **line → LINE**：`0/LINE 8/<layer> 10/x1 20/y1 11/x2 21/y2`
- **arc → ARC**：`0/ARC 8/<layer> 10/cx 20/cy 40/r 50/<startDeg> 51/<endDeg>`。**DXF ARC 語意恆為逆時針**（自 start 角掃到 end 角）；Segment 的 `ccw` 旗標語意見 geometry.ts `angleInArc` 註解——**`ccw: true` 時 writer 必須交換 start/end 再輸出**，兩種方向都要測試釘住（畫弧方向錯＝刀模弧翻面，人眼難察覺、廠商軋出來才發現）。弧度→度：`(rad × 180 / Math.PI)`，輸出前 normalize 到 [0,360)。
- **bezier → POLYLINE**：`flattenBezier(seg)`（預設參數即 spec 值：chordTol 0.1、maxSegLen 5）→ `0/POLYLINE 8/<layer> 66/1 70/0`＋每個頂點 `0/VERTEX 8/<layer> 10/x 20/y`（首段起點＋各段終點）＋`0/SEQEND`。
- 數值格式：`toFixed(4)` 後去尾零（DXF 慣例可接受定點；4 位小數在 mm 下＝0.1µm 級，遠超製造精度）；`-0` 收斂為 `0`（沿用 svg.ts fmt 慣例）。
- 座標系：Segment 的 y 向下（SVG 慣例）vs DXF y 向上——**v1 不翻轉**（整版輸出鏡像一致、刀模廠對單面刀模鏡像不敏感且常自行翻面）；在 `toDxfDocument` docblock 記這個決策與理由，gate（T6）由法蘭真實流程判是否要加翻轉。
- ⚠️ implementer 注意：R12 group code 結構屬穩定格式知識，但**動手前先 WebSearch 對照一份權威參照**（AutoCAD DXF R12 參考或 ezdxf 文件）確認 LAYER table 的 70 flags 與 POLYLINE 66/70 的必要性——訓練資料當 hypothesis。

- [ ] **Step 1: 失敗測試**——`tests/export/dxf.test.ts`。先寫一個 ~30 行的測試用 parser helper `parseDxf(text): { layers: string[]; entities: Array<{ type: string; layer: string; codes: Record<number, string[]> }> }`（逐行讀 group code/value 配對、依 0 碼切實體——這個 helper 之後 T2 也用）：
  ```ts
  // 案例（手工組 GenerateResult，不跑盒型）：
  // 1. line×1（cut）→ ENTITIES 恰 1 個 LINE、layer=CUT、10/20/11/21 值正確
  // 2. arc ccw=false（0°→90°）→ ARC 50=0、51=90
  // 3. arc ccw=true（90°→0°，即順時針掃）→ 輸出 50=0、51=90（swap 後）——方向語意測試
  // 4. bezier（r=1mm 圓角級曲率：如 (0,0)C(0,0.55)(0.45,1)(1,1)）→ POLYLINE＋VERTEX 數 ≥3＋SEQEND；
  //    每個 VERTEX 到原 bezier 的最近距離 ≤0.1（弦高保證的離散誤差驗證——用 flattenBezier 已測過的
  //    數學，此處驗 writer 沒有丟點/錯序：VERTEX 序列首尾＝bezier 端點）
  // 5. dimension/annotation 線型＋texts → 完全不出現在 ENTITIES
  // 6. LAYER table 恰 3 條（CUT/CREASE/HALFCUT）、62 色碼 7/3/2
  // 7. 檔案以 0/EOF 結尾、HEADER 有 $ACADVER=AC1009
  ```
- [ ] **Step 2: 跑測試確認失敗**（`npx vitest run tests/export/dxf.test.ts`，模組不存在）
- [ ] **Step 3: 實作 `toDxfDocument`**（骨架如上；先查權威參照再定 group code 細節）
- [ ] **Step 4: 綠＋typecheck**（`npm run typecheck && npx vitest run`）
- [ ] **Step 5: 盒型整合案例**——RTE 預設參數＋telescope 預設參數各跑一次 `toDxfDocument`：可解析、實體數 >0、無 NaN 字串、telescope 的 halfcut 進 HALFCUT 層（RTE 無 halfcut——兩盒型互補覆蓋三圖層）＋commit `feat: DXF R12 writer（三圖層、直接消費 Segment、bezier 離散復用 flattenBezier）`

---

### Task 2: ExportBar 接 DXF 下載

**Files:**
- Modify: `src/ui/ExportBar.tsx`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: `toDxfDocument`（T1）、既有 `buildFilename`/`buildPieceFilename`/`pieceManufacturingBounds`/下載 Blob 機制（ExportBar 內都有——先讀再改）
- Produces: UI「下載 DXF」按鈕（全版＋單片視圖，與 SVG 按鈕並列）

**規格：**
- 檔名沿用既有兩個 builder 的邏輯、副檔名換 `.dxf`（重構共用：把副檔名抽成參數，**不**複製貼上兩份檔名邏輯）。
- 單片視圖：過濾該片 paths 後組臨時 `GenerateResult`（沿用 SVG 單片匯出的既有過濾——同一份過濾代碼，不重寫）→ `toDxfDocument`。
- `includeDimensions` checkbox 對 DXF 無效（writer 恆排除）——不需 UI 提示，程式註解記。
- MIME：`application/dxf`（或 `text/plain`——擇一並註明）。

- [ ] **Step 1: 失敗測試**——全版 DXF 下載觸發（jsdom 攔 Blob/anchor 同既有 SVG 下載測試模式）：內容含 `AC1009` 與 `CUT` 層、檔名 `.dxf` 結尾；單片視圖下載內容只含該片（用 T1 的 parseDxf helper 驗實體數）；RTE 檔名 `rte-55x55x117.dxf` 級、telescope 走 bounds 檔名（FX1 模式）
- [ ] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 綠＋typecheck＋build**
- [ ] **Step 5: Commit** `feat: DXF 下載（全版/單片、檔名與 SVG 同邏輯）`

---

### Task 3: Overlay SVG 子集 parser

**Files:**
- Create: `src/overlay/parse.ts`
- Test: `tests/overlay/parse.test.ts`

**Interfaces:**
- Consumes: `Segment`（core/geometry 型別；純資料、不 import UI）
- Produces:
  ```ts
  interface OverlayParseResult {
    segments: Segment[];
    warnings: string[];          // 未支援元素/屬性：「<text> ×3 未匯入」式人話（繁中）
    sourceInfo: { widthAttr: string | null; viewBox: string | null }; // 校準初始猜測用（T4）
  }
  function parseOverlaySvg(svgText: string): OverlayParseResult
  ```

**規格（spec §5 子集）：**

- 支援元素：`path`（M/L/H/V/C/S/Q/A/Z 絕對＋相對）、`line`、`polyline`、`polygon`、`rect`（無圓角）、`circle`、`ellipse`；`<g>` 與元素自身的 `transform`（translate/scale/rotate/matrix，嵌套累乘展平）。
- 不支援（列警告不擋）：`text`、`image`、`use`、嵌套 `<svg>`、`rect` 的 rx/ry 圓角、CSS class 樣式繼承（樣式本來就不讀——overlay 全染洋紅）。警告去重計數（同類元素合併一條）。
- **path 指令 → Segment 映射**：
  - M/L/H/V（含相對）→ line（M 只移動游標；隱式 lineto：M 後續座標對＝L）
  - C/S → bezier（S 反射前控制點；前一指令非 C/S 時反射點＝當前點）
  - Q/T → 升階 cubic：`c1 = p0 + 2/3×(q − p0)`、`c2 = p3 + 2/3×(q − p3)`（T 反射同 S 規則）
  - **A（橢圓弧）**：先照 SVG 規範 F.6.5 endpoint→center 參數化；`|rx−ry| ≤ 1e-6×max(rx,ry)` 視為圓 → `arc` Segment（**sweep flag → ccw 映射要對照 geometry.ts 的 ccw 語意寫測試釘住**，SVG y 向下座標系的「sweep=1 順時針視覺」陷阱）；rx≠ry（真橢圓）→ 每 ≤90° 切一段、標準 a2c 演算法轉 cubic bezier（刀模實務幾乎全是圓弧，橢圓走近似路徑即可）
  - Z → 回起點 line（若當前點≠子路徑起點）
- `rect` → 4 line；`polyline`/`polygon` → line 序列（polygon 補閉合線）；`circle` → 完整圓 arc（startAngle=0、endAngle=2π、ccw=false——geometry.ts 對「差 2π」有完整圓語意）；`ellipse` → 4 段 a2c bezier
- **transform 展平**：3×3 仿射矩陣累乘。套用到 Segment：line/bezier 直接變換端點與控制點；**arc 在非等比 scale 或 skew 下不再是圓**——變換矩陣非「等比縮放＋旋轉＋平移」（判準：`|a²+b² − (c²+d²)| > EPS` 或 `|a·c + b·d| > EPS`）時，arc 先轉 4 段 bezier 再變換；等比時直接變換圓心/半徑/角度（半徑 ×scale、角度加旋轉、**負 determinant（鏡射）翻轉 ccw**）。
- 錯誤處理：整體 try/catch，壞檔回 `{ segments: [], warnings: ['SVG 解析失敗：…'] }` 不 throw（UI 直接顯示警告）。

- [ ] **Step 1: 失敗測試**——合成 SVG 字串逐案例：
  ```ts
  // 每種元素×1；path 相對指令（m l c 小寫）；H/V；S 反射；Q 升階（對照手算控制點）；
  // A 圓弧（sweep 0/1 各一——ccw 映射釘住：畫 90° 弧、斷言 Segment 起訖角與 ccw）；
  // A 橢圓（rx=2ry）→ bezier 段、無 arc；Z 閉合補線；
  // 嵌套 g transform（translate+scale 累乘）→ 端點座標手算比對；
  // rotate(45) 下的 arc → 角度偏移 45°；scale(1,2)（非等比）下的 arc → 全 bezier；
  // scale(-1,1)（鏡射）下的 arc → ccw 翻轉；
  // text/use/嵌套 svg → 警告清單含計數、segments 不含其內容；
  // 壞檔（非 XML）→ 空 segments＋警告；
  // 「一線一 <g id="LINE##">」生產檔式樣（合成 6 條線帶 g 包裹）→ 6 line
  ```
- [ ] **Step 2: 確認失敗** → **Step 3: 實作**（矩陣工具→元素遍歷→path tokenizer→指令狀態機→a2c；函式各 <50 行、tokenizer/狀態機/a2c 拆私有函式）
- [ ] **Step 4: 綠＋typecheck** → **Step 5: Commit** `feat: overlay SVG 子集 parser（path 全指令、transform 展平、警告清單）`

---

### Task 4: Overlay 狀態層＋匯入/顯示/對齊 UI

**Files:**
- Create: `src/overlay/state.ts`、`src/ui/OverlayPanel.tsx`
- Modify: `src/ui/App.tsx`（state 提升＋掛載）、`src/ui/Canvas.tsx`（疊繪層）
- Test: `tests/overlay/state.test.ts`、`tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: `parseOverlaySvg`（T3）、Canvas 既有 viewBox/縮放機制（**先讀 Canvas.tsx 再動**——pan/zoom 與 activePiece viewBox 已有成熟結構）
- Produces:
  ```ts
  // overlay/state.ts（純函式，UI 無關）
  interface OverlayState {
    segments: Segment[];       // parse 原始輸出（不預變換——scale/offset 渲染時套）
    warnings: string[];
    scale: number;             // overlay 座標 → mm 的比例（校準結果）
    offsetX: number; offsetY: number;  // mm，套在 scale 之後
    opacity: number;           // 0–1，預設 0.5
    visible: boolean;
    rawBounds: Bounds;         // segmentsBounds(segments)，對齊計算用
  }
  function initialScaleGuess(sourceInfo: OverlayParseResult['sourceInfo'], unit: 'pt' | 'mm' | 'px'): number
  // pt→×0.352778、mm→×1、px→×(25.4/96)；width 屬性帶 mm/pt 單位字尾時優先自動判定
  function alignOffset(raw: Bounds, scale: number, target: Bounds, mode: 'top-left' | 'center' | 'bbox'): { offsetX: number; offsetY: number }
  // 'bbox'＝raw×scale 的 bbox 對齊 target bbox 左上＋（若尺寸接近）中心微調——實作定義寫進 docblock；'top-left'/'center' 依字面
  ```
- **UI 規格**：
  - OverlayPanel（側欄新區塊，位於 ParamPanel 之後）：「匯入生產 SVG」file input（accept=.svg）→ FileReader→parse；warnings 顯示（黃底小字清單）；顯示開關 checkbox；透明度 slider（0–100%、預設 50）；單位下拉（pt／mm／px，預設 pt——法蘭生產檔慣例）改變時重算 scale（**僅在未做過點選校準時**——校準結果優先，下拉變更提示會覆蓋）；快速對齊三鈕（左上／中心／邊界框）；「清除」鈕。
  - Canvas 疊繪：`visible && segments.length > 0` 時，在生成層之後（上層）畫 overlay ——全段 `OVERLAY_STROKE = '#FF00FF'`、`strokeOpacity={opacity}`、`fill="none"`、線寬同生成層；座標套 `scale`＋`offset`（一個 `<g transform>` 即可，不逐段換算）；**不參與** hover 高亮／hit-test（T5 校準模式除外）／bounds／fit 計算。
  - 用途定位一句話（spec §5）放 OverlayPanel 頂部說明文字：「對照調參用——匯入生產刀模、校準比例後與生成層疊圖比對（特別是 R 角與細部結構）。」
- 拖曳平移 overlay：**本 task 不做自由拖曳**（快速對齊＋校準已覆蓋主用途；自由拖曳與畫布 pan 的模式切換複雜度高）——offsetX/offsetY 提供數字輸入框微調（step 0.5mm）。若 gate 時法蘭要真拖曳再加（記入 T6 檢查點）。此為對 spec §5「拖曳平移」的**降級實作，plan 裁決、gate 驗收**。

- [ ] **Step 1: 失敗測試**——state.test.ts：`initialScaleGuess`（pt/mm/px 三值＋width="200mm" 自動判定）、`alignOffset` 三模式手算案例；app.test.tsx：匯入（File mock）→ 畫布出現洋紅 g、slider 改 opacity、開關隱藏、警告顯示、快速對齊後 offset 生效、清除後消失、**RTE/telescope 既有測試零影響**
- [ ] **Step 2: 確認失敗** → **Step 3: 實作**（state.ts → OverlayPanel → App 提升 → Canvas 疊繪）
- [ ] **Step 4: 綠＋typecheck＋build** → **Step 5: Commit** `feat: overlay 匯入/顯示/透明度/快速對齊（獨立疊層、不進 GenerateResult）`

---

### Task 5: 點選校準（已知長度）

**Files:**
- Modify: `src/ui/Canvas.tsx`（校準模式 hit-test）、`src/ui/OverlayPanel.tsx`（校準鈕＋輸入流程）、`src/overlay/state.ts`（`calibrateScale` 純函式）
- Test: `tests/overlay/state.test.ts`（校準數學）、`tests/ui/app.test.tsx`（流程冒煙）

**Interfaces:**
- Produces: `calibrateScale(seg: Segment, actualMm: number): number`——線段自身長度（line 端點距；arc 弦長；bezier 端點弦長）→ `actualMm / rawLength`。校準後 scale 直接替換 OverlayState.scale（offset 不動——校準前建議先不對齊，流程說明文字提醒「先校準再對齊」）。

**規格（spec §5：「點選一段線、輸入實際 mm」）：**
- OverlayPanel「校準」鈕 → 進校準模式（Canvas 游標 crosshair、頂部提示條「點選 overlay 上一段已知長度的線」）
- 校準模式中 Canvas 對 **overlay 線段**做 hit-test：滑鼠點 → 找最近 overlay 線段（點到線段距離、閾值 ~3mm/當前 zoom 換算；line 直接算、arc/bezier 用 `flattenToLines` 級的折線近似——geometry.ts 的 `flattenBezier` 可用、arc 取樣私有邏輯照抄 5° 步進或抽 export）→ 選中段高亮（加粗）＋彈出行內輸入（數字 mm）→ 確認 → `calibrateScale` → 退出校準模式
- Esc 退出校準模式不改 scale
- 邊界：選中零長段 → 忽略點擊；輸入 ≤0 → 不套用＋提示

- [ ] **Step 1: 失敗測試**——calibrateScale 三種 Segment 手算；hit-test 純函式（若抽出）最近段判定；UI 流程（進模式→模擬 click→輸入 100→scale 更新→模式退出）
- [ ] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 綠＋typecheck＋build**
- [ ] **Step 5: Commit** `feat: overlay 點選校準（已知長度→比例換算）`

---

### Task 6: Slice 3 gate（法蘭人工驗收）＋v0.3.0

- [ ] final 雙軌 review（照慣例：Opus whole-branch＋Codex 迴歸 pass→fix wave→驗收）
- [ ] 法蘭操作驗收：
  - 匯入真實生產 SVG（天地盒刀模.svg 級）→ 校準（已知 124mm 面板邊）→ 對齊 → 與生成層疊圖比對手感
  - 匯出 DXF 走真實廠商流程開啟（spec §12 風險驗證：R12 相容性、y 鏡像方向、三圖層可見）
  - overlay 降級項確認：offset 數字微調夠用嗎（vs 自由拖曳）
- [ ] gate 反饋迭代 → 全過後 tag `v0.3.0`＋push

---

## Self-review 記錄（writing-plans checklist）

1. **Spec coverage**：§5 全項對 T3/T4/T5（拖曳平移降級為數字微調——標注為 plan 裁決、gate 驗收項）；§6.2 全項對 T1/T2（離散演算法復用既有 flattenBezier、參數吻合）；§8 DXF 測試行對 T1 Step 1；§12 風險對 T6。
2. **Placeholder 掃描**：無 TBD；T3 的 a2c 與 F.6.5 為具名標準演算法（implementer 對照 SVG 規範實作，屬「查權威參照」非 placeholder）；T4 alignOffset 'bbox' 模式語意留 docblock 定義——已在接口註明。
3. **型別一致性**：`toDxfDocument(result)` T1 定義 T2 消費；`parseOverlaySvg` T3 定義 T4 消費；`OverlayState`/`calibrateScale` T4 定義 T5 擴充——名稱逐字一致。
4. **已知風險前置**：DXF ARC 恆逆時針 vs Segment ccw 旗標（T1 專門測試）；SVG A 指令 sweep→ccw 映射（T3 專門測試）；非等比 transform 下 arc 圓性破壞（T3 專門測試）；y 軸方向 v1 不翻轉（T1 docblock＋T6 gate 驗證）。
