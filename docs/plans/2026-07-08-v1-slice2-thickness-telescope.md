# open-dieline v1 Slice 2 — thickness 接線＋天地盒三件套 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `thickness` 接成真實幾何參數（RTE 標準補償集、t=0 錨定等價），並以生產刀模量測 ground truth 重寫天地盒為三件套（上蓋／下盒／內襯，pieces 分組）。

**Architecture:** 沿用 Slice 1 的 schema-driven 插件架構。新增 `DielinePiece` 型別與 pieces 驗證 helper；天地盒以「雙壁 tray 幾何 helper」×2 片＋「內襯帶狀 generator」組裝。所有補償量＝t 的一次函數、t=0 歸零。

**Tech Stack:** 同 Slice 1（Vite 6 / React 19 / TS 6 / vitest / tailwind 4）。

**Spec:** `docs/specs/2026-07-07-open-dieline-v1-design.md` **v1.2**（§3.3 pieces、§4.1 RTE 補償集、§4.2 天地盒三件套）。量測 ground truth：coding-workspace `Coding Projets/feature/2026/07/07-open-dieline/天地盒量測表.md`。

## Global Constraints

- **t=0 錨定**：RTE `thickness=0`＋其餘前身預設 → 與既有 fixture（`tests/fixtures/rte-reference.json`）normalized Segment 等價（容差 0.01mm）。**既有 fixture 檔不得修改。**
- 所有補償量必為 `thickness` 的一次函數，t=0 時全部歸零；係數用具名常數。
- `LINE_STYLES`（cut #000000／crease #00FF00／halfcut #FFFF00／dimension #3B82F6）不可改。
- pieces 規則（spec §3.3）：id 唯一、每片非空、path/text 歸屬聯集＝全集且兩兩不交、id 引用存在、各片 bounds 兩兩不重疊、`GenerateResult.bounds`＝全片 hull＝全幾何 hull。
- 天地盒 `t=0` 時雙 crease collapse 為單 crease（不輸出重合線）。
- 參數 `description` 一律繁中教育說明；`derivedDefault` 只可引用先前宣告的參數。
- 程式風格同 Slice 1：immutability、函式 <50 行、檔 <800 行、繁中註解僅記「代碼看不出的約束」。
- commit 尾綴：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` ＋ `Claude-Session: https://claude.ai/code/session_01SF3TGPV8efTNMXh6Jhwz3K`

## File Structure

```
src/core/types.ts          # 修改：+DielinePiece、GenerateResult.pieces?
src/core/pieces.ts         # 新增：validatePieces()（完整性規則）
src/boxes/reverse-tuck-end.ts  # 修改：thickness 接線（girth/tuckClearance/防塵翼）
src/boxes/telescope/tray.ts    # 新增：雙壁 tray 單片幾何（兩款壁頂、兩款角撐）
src/boxes/telescope/liner.ts   # 新增：內襯帶狀幾何
src/boxes/telescope/index.ts   # 新增：BoxModule 組裝（params/invariants/generate/pieces）
src/ui/Canvas.tsx / ExportBar.tsx / App.tsx  # 修改：單片視圖切換＋單片匯出
tests/pieces.test.ts       # 新增
tests/reverse-tuck-end.test.ts  # 修改：等價 t=0、golden 重錨、補償測試
tests/telescope.test.ts    # 新增：不變式＋golden＋假旋鈕
tests/telescope-fixture.test.ts # 新增：具名槽位分層對帳＋liner golden
tests/fixtures/telescope-reference.json  # 新增：量測結構分解 fixture
tests/app.test.tsx         # 修改：pieces UI 冒煙
```

---

### Task 1: DielinePiece 型別＋pieces 驗證 helper

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/pieces.ts`
- Test: `tests/pieces.test.ts`

**Interfaces:**
- Produces: `DielinePiece { id: string; label: LocalizedText; pathIds: string[]; textIds: string[]; bounds: Bounds }`；`GenerateResult.pieces?: DielinePiece[]`
- Produces: `validatePieces(result: GenerateResult): { ok: true } | { ok: false; message: string }` — T4 的不變式與 T5 測試共用

- [ ] **Step 1: 失敗測試**——`tests/pieces.test.ts`，用手工組的最小 GenerateResult 覆蓋violations：
  ```ts
  // 各案例斷言 validatePieces(result).ok === false 且 message 含關鍵詞：
  // 'duplicate-piece-id'｜'empty-piece'｜'unassigned-path'｜'double-assigned-path'
  // ｜'unknown-path-id'｜'piece-bounds-mismatch'（片 bounds 未涵蓋成員）
  // ｜'overlapping-pieces'｜'result-bounds-mismatch'（總 bounds ≠ 全片 hull）
  // 合法三片案例斷言 ok === true；pieces === undefined 時直接 ok（單片盒型）
  ```
- [ ] **Step 2: 跑測試確認失敗**（`npx vitest run tests/pieces.test.ts`，模組不存在）
- [ ] **Step 3: 實作**——types.ts 加型別（照 spec §3.3 逐字）；pieces.ts 實作 validatePieces，浮點比較容差 1e-6
- [ ] **Step 4: 測試綠＋typecheck**（`npm run typecheck && npx vitest run`）
- [ ] **Step 5: Commit** `feat: DielinePiece 型別與 pieces 完整性驗證`

---

### Task 2: RTE thickness 接線

**Files:**
- Modify: `src/boxes/reverse-tuck-end.ts`
- Modify: `tests/reverse-tuck-end.test.ts`（等價參數組＋golden＋補償測試）

**Interfaces:**
- Consumes: 既有 RTE 實作（面板序 `wP1=L, wP2=W, wP3=L, wP4=W`、`tuckClearance` default 0.5、`reliefGap` 邏輯、unfold-width 不變式 `L+W+L+W+glueSize+40`）
- Produces: RTE 參數表新增 `thickness`（宣告位置：`D` 之後、`tuckDepth` 之前——`tuckClearance.derivedDefault` 引用它，需先宣告）

**規格（spec §4.1）：**

```ts
// 補償係數具名常數（審核條款：改動只碰此表）
const GIRTH_COMP_FROM_GLUE = [0, 1, 1, 2] as const; // 離糊邊近→遠，×t

// thickness 參數
{ key: 'thickness', unit: 'mm', default: 0.3, min: 0, max: 0.8, step: 0.1,
  label: { zh: '紙厚' }, group: …, description: { zh: '紙張厚度（caliper）。盒身面板依摺次遞增補償、插舌與讓位間隙隨之調整；設 0 可還原無補償的幾何。' } }

// girth 補償：糊邊貼的面板 +0、依序 +t、+t、+2t
// glueSide==='left'（糊邊貼 P1 左）：comp = [0,1,1,2]
// glueSide==='right'（糊邊貼 P4 右）：comp = [2,1,1,0]
const comp = glueOnRight ? [...GIRTH_COMP_FROM_GLUE].reverse() : GIRTH_COMP_FROM_GLUE;
const wP1 = L + comp[0] * t;
const wP2 = W + comp[1] * t;
const wP3 = L + comp[2] * t;
const wP4 = W + comp[3] * t;
// hLid（蓋板高）維持 = W 名義，不吃 girth（開口配合由 tuckClearance 吃 t）

// tuckClearance 改 derivedDefault（auto/manual 機制既有，useParams 已支援）
{ key: 'tuckClearance', …, default: 0.5,
  derivedDefault: (p) => 0.5 + (p.thickness as number) }

// 防塵翼讓位：reliefGap 尾端 +t
const reliefGap = (xGapVal > 0 ? xGapVal : 3) + t;
```

- [ ] **Step 1: 等價測試改造（先行）**——既有等價測試的參數組顯式加 `thickness: 0`，並加參數宣告＋`const t = p.thickness`（幾何暫未接線）。**只跑等價測試**確認綠（`npx vitest run -t 等價`；此中間態假旋鈕測試對 t 必紅——屬預期，Step 3 接線後轉綠）
- [ ] **Step 2: 失敗測試**——新增補償測試：
  ```ts
  // girth：t=0.4、glueSide='left' → 面板寬 [L, W+0.4, L+0.4, W+0.8]（由 crease x 座標驗）
  // girth 鏡像：glueSide='right' → [L+0.8, W+0.4, L+0.4, W]
  // tuckClearance derived：t=0.4 未覆寫 → 生效值 0.9；覆寫 2 → 維持 2
  // unfold-width：expected = L+W+L+W + 4*t + glueSize + 40
  // t 假旋鈕：t=0 vs t=0.4 輸出必異（自動迴圈已涵蓋，確認不需特例）
  ```
- [ ] **Step 3: 實作接線**（girth／derivedDefault／reliefGap；unfold-width 不變式改 `+ 4 * t`）
- [ ] **Step 4: golden 重錨**——刪除既有 RTE golden snapshot、以新預設（t=0.3）重錄；快照 diff 人工過目：僅面板 x 座標／插舌間隙／讓位間隙變化
- [ ] **Step 5: 全綠＋typecheck**；等價測試（t=0）確認未動 fixture 而過
- [ ] **Step 6: Commit** `feat: RTE thickness 標準補償集（girth+插舌+讓位，t=0 錨定等價）`

---

### Task 3: 天地盒 tray 幾何 helper

**Files:**
- Create: `src/boxes/telescope/tray.ts`
- Test: `tests/telescope.test.ts`（本 task 先放 tray 單元測試）

**Interfaces:**
- Consumes: `PathBuilder`、`LINE_STYLES` 線型、`Segment`
- Produces:
  ```ts
  interface TrayOpts {
    panelL: number; panelW: number;   // 主面板（製造尺寸）
    height: number;                    // 名義壁高（後摺壁全高）
    platformWidth: number;             // 0＝薄壁單線反折；>0＝厚壁平台
    thickness: number;
    idPrefix: string;                  // path id 前綴（'base'|'lid'）
    offsetX: number; offsetY: number;  // 版面排版位移
  }
  function generateTray(opts: TrayOpts): { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds }
  ```
  面板中心為局部原點、x 向＝panelL 方向（先摺壁＝左右）、y 向＝panelW 方向（後摺壁＝前後）。

**剖面規格（單側，自面板邊向外；全部尺寸具名常數／參數推導）：**

| 段 | x 向（先摺壁·左右） | y 向（後摺壁·前後） |
|---|---|---|
| 壁根摺線 | 單 crease @ 面板邊 | **雙 crease** @ 面板邊與 +t（t=0 collapse 單線） |
| 外壁 | `height − t`（頂緣平齊） | `height`（自雙 crease 外線起量） |
| 壁頂 | platform>0：兩條 crease 相距 `platformWidth`；platform=0：單 crease 反折 | 同左 |
| 內壁 | `外壁 − 2t` | `外壁 − 2t` |
| 舌摺線 | **halfcut**（中段）＋ crease（兩端各留 ~9mm，照量測讓位角撐） | 同左 |
| 插底舌 | `TUCK_FLAP_DEPTH = 15`，梯形：兩端深 7.5、中段全深 15、45° 過渡 | 同左 |

**角撐（跟隨壁款）：**
- 厚壁（platform>0）＝ 45° 斜角撐：面板角沿 45° 斜 crease（cut 段＋crease 段連續，各長 ≈25.3mm 級、由壁高推導）＋外緣斜切；參照 A 片座標（附錄槽位表＋量測表原檔）
- 薄壁（platform=0）＝ 弧形讓位角撐：45° 斜 crease（長 26.3mm 級）＋斜 cut（100°）＋**讓位弧 R=5.0**＋**角撐頂小弧 R=1.5**（bezier 反解值）；參照 B 片座標
- 兩款的角撐尺寸與壁高聯動（照量測比例參數化）；**實作以附錄參照座標復刻後參數化**，slot 對帳（T5）驗最終正確性

- [ ] **Step 1: 失敗測試**——tray 結構測試（以 t=0.4、H=60、platform=5、panel 124×179——即生產下盒）：
  ```ts
  // x 向駐留座標（自面板左緣向外）依序間距：[59.6, 5, 58.8, 15]（先摺鏈 −t）
  // y 向：雙 crease gap 0.4、外壁 60、平台 5、內壁 59.2、舌 15
  // 線型斷言：壁根 y 向兩條 crease；舌摺線含 halfcut 段；t=0 時 y 向壁根只有一條 crease
  // platform=0（B 款參數 45 高）：壁頂單 crease；x 向外壁 44.6（做平齊修正——spec 例外槽）
  // hasNaN 全否、bounds 涵蓋
  ```
- [ ] **Step 2: 確認失敗** → **Step 3: 實作**（先剖面骨架後角撐；角撐照附錄座標復刻再參數化）
- [ ] **Step 4: 綠＋typecheck** → **Step 5: Commit** `feat: 天地盒雙壁 tray 幾何（兩款壁頂/角撐、平齊補償、halfcut 舌線）`

---

### Task 4: 內襯 generator＋telescope BoxModule 組裝

**Files:**
- Create: `src/boxes/telescope/liner.ts`、`src/boxes/telescope/index.ts`
- Modify: `src/ui/App.tsx`（registerBox telescope）
- Test: `tests/telescope.test.ts`（module 級：參數表／不變式／golden／假旋鈕）

**Interfaces:**
- Consumes: `generateTray`（T3）、`validatePieces`（T1）、registry
- Produces: `telescope: BoxModule`（id `telescope`）；pieces `[base, lid]` 或 `[base, lid, liner]`

**參數表（spec §4.2 逐字，宣告序）：** `baseLength 179 (30–600, 0.5)`、`baseWidth 124 (30–600, 0.5)`、`baseHeight 60 (10–200, 0.5)`、`lidMargin 13.5 (1–40, 0.1)`、`lidHeight 45 (10–200, 0.5)`、`basePlatformWidth 5 (0–15, 0.5)`、`lidPlatformWidth 0 (0–15, 0.5)`、`thickness 0.3 (0–0.8, 0.1)`、`linerEnabled true`、`linerFitGap 0.5 (0.2–2, 0.1)`。每參數繁中 `description`（結構意義）。

**liner 幾何（spec §4.2 導出鏈；參照 coding-workspace 任務夾 `gen_liner.py`——構造參照、數值不抄）：**
```ts
// 導出（等邊 margin 下兩向翻邊相同 = lidMargin − 4t − 2×fitGap）
const lidPanelL = baseLength + 2 * lidMargin, lidPanelW = baseWidth + 2 * lidMargin;
const lidInnerL = lidPanelL - 4 * t, lidInnerW = lidPanelW - 4 * t;
const frameL = lidInnerL - 2 * fitGap, frameW = lidInnerW - 2 * fitGap; // 圍框外圍
const flange = lidMargin - 4 * t - 2 * fitGap;                           // 翻邊寬
const wallH = baseHeight;
// 帶狀攤平：LINER_TAB(15, 上下 45° 斜切 5=GLUE_CHAMFER) + 長壁(frameL) + 短壁(frameW) ×2 交替
// 每段壁頂向上翻邊 flange，梯形 45° 讓位；壁-壁/壁-翻邊/tab 根＝crease
```

**不變式（spec §4.2）：** `liner-flange-fits`（flange ≥ MIN_FLANGE=5，else 警告）、`pieces-identity`（片 id 集合正確；base 片主面板實測=baseLength×baseWidth、lid 片=＋2×lidMargin）、`rim-flush`（每片先摺壁=後摺−t）、pieces 完整性（呼叫 `validatePieces`）、no-nan、bounds。

**版面排列：** lid 左、base 右（照生產版）、liner 橫放下方；`PIECE_GAP = 20`。

**尺寸標註：** 重用 `primitives.dimensionLine`——每片標主要尺寸（base/lid：面板 L×W＋壁高；liner：帶長＋壁高），歸屬各片 textIds/pathIds；`includeDimensions` 過濾機制沿用 Slice 1（畫布與匯出同 predicate）。

- [ ] **Step 1: 失敗測試**——liner 導出值（t=0.4/margin 13.5/fitGap 0.5/base 179×124×60：圍框 203.4×148.4、翻邊 10.9、攤平 718.6×70.9）；pieces identity；linerEnabled=false → 2 片；假旋鈕（10 參數自動迴圈）；golden（預設參數 t=0.3）
- [ ] **Step 2: 確認失敗** → **Step 3: 實作**（liner.ts → index.ts 組裝 → App 註冊）
- [ ] **Step 4: 綠＋typecheck＋`npm run build`** → **Step 5: Commit** `feat: 天地盒三件套 BoxModule（pieces 分組＋內襯導出鏈＋專屬不變式）`

---

### Task 5: 具名槽位對帳 fixture＋分層對帳測試

**Files:**
- Create: `tests/fixtures/telescope-reference.json`、`tests/telescope-fixture.test.ts`

**Fixture 建構（數值全在附錄槽位表；來源欄 `measured`｜`corrected`）：** params＝`{baseLength:179, baseWidth:124, baseHeight:60, lidMargin:13.5, lidHeight:45, basePlatformWidth:5, lidPlatformWidth:0, thickness:0.4, linerEnabled:true, linerFitGap:0.5}`

**比對規則（spec §4.2，三層）：**
1. t 無關槽位（source=measured、tIndependent=true）：x 向逐項 `|生成−預期| ≤ 0.05`
2. t 相關槽位：公式自洽（生成值代公式驗）＋ x 向 `|生成−量測| ≤ 0.15`；**corrected 槽**（lid.x.outerWall/innerWall）對公式修正值 ≤0.05、不對量測
3. y 向：**序列完整性**（槽位依序存在、線型正確）＋公式關係（雙 crease=t 等），不驗與生產品的絕對差
4. liner golden：圍框 203.4×148.4、翻邊 10.9、段序 tab|203.4|148.4|203.4|148.4、壁高 60（公式自產，見 T4 Step 1 值）

- [ ] **Step 1: 建 fixture JSON**（照附錄槽位表逐槽：name/expected/lineType/source/tIndependent）
- [ ] **Step 2: 失敗測試**（比對器未實作）→ **Step 3: 實作比對器**（生成→抽駐留座標→槽位匹配；重用 Slice 1 的 normalize 工具）
- [ ] **Step 4: 綠** → **Step 5: Commit** `test: 天地盒生產刀模具名槽位分層對帳＋內襯 golden`
- [ ] **Step 6: param-sweep**——天地盒版掃描（三值×關鍵參數組合，斷言：不變式全過或正確警告、無 NaN、無 cut 自撞——重用 Slice 1 掃描骨架）＋commit

---

### Task 6: UI pieces 支援（全版／單片視圖＋單片匯出）

**Files:**
- Modify: `src/ui/Canvas.tsx`、`src/ui/ExportBar.tsx`、`src/ui/App.tsx`
- Test: `tests/app.test.tsx`

**規格：**
- `result.pieces` 存在時 Canvas 上方顯示視圖切換（`全版｜上蓋｜下盒｜內襯`——label 取 piece.label.zh）；單片視圖只渲染該片 paths/texts、viewBox 用該片 bounds（含 padding）
- ExportBar：pieces 存在時多一個「匯出目前視圖」——全版視圖＝整版 SVG（既有行為）、單片視圖＝該片獨立 SVG（`toSvgDocument` 吃過濾後的 paths/texts＋片 bounds；檔名 `{boxId}-{pieceId}-{L}x{W}.svg`）
- 單片盒型（RTE）：UI 完全不變（pieces undefined → 不顯示切換）
- derivedDefault auto/manual 回歸：調 thickness → tuckClearance 顯示值跟動；手動覆寫後調 t 不被洗掉（Slice 1 useParams 機制既有——補斷言即可）

- [ ] **Step 1: 失敗測試**（視圖切換渲染、單片匯出 SVG 內容只含該片、RTE 不顯示切換、derived 回歸、**RTE↔telescope 雙向切盒不 crash 且參數面板正確重置**——Slice 1 切盒 guard 的首次雙盒實戰）
- [ ] **Step 2: 確認失敗** → **Step 3: 實作** → **Step 4: 綠＋typecheck＋build**
- [ ] **Step 5: Commit** `feat: pieces 全版/單片視圖與單片 SVG 匯出`

---

### Task 7: 樣張 gate（法蘭人工驗收·release checklist）

- [ ] dev server 起站，法蘭操作：天地盒調參、切視圖、單片匯出
- [ ] 列印試摺：上蓋／下盒／內襯（縮放或分頁列印）、三件互套、腰封位確認
- [ ] RTE 回歸：t=0.4 樣張目測（girth 補償後盒身可摺合）
- [ ] gate 反饋迭代（如有）→ 全過後 Slice 2 完結

---

## 附錄：天地盒量測槽位表（fixture 數值源；量測=生產刀模 pt→mm，公式值以 t=0.4 計）

### base（下盒；A 片。panel 124(x)×179(y)、H=60、platform=5）

| 槽位 | 預期值 | 量測值 | 線型 | source | t 無關 |
|---|---|---|---|---|---|
| base.x.panel | 124.0 | 124.0 | crease（單） | measured | ✓ |
| base.x.outerWall | 59.6（H−t） | 59.5 | — | measured（≤0.15） | |
| base.x.platform | 5.0 | 5.0 | crease×2 | measured | ✓ |
| base.x.innerWall | 58.8（H−3t） | 58.7 | — | measured（≤0.15） | |
| base.x.tuckFoldLine | — | — | halfcut 中段＋crease 兩端 | measured | ✓（線型） |
| base.x.tuckFlap | 15.0 | 15.0 | cut | measured | ✓ |
| base.y.doubleCreaseGap | 0.4（t） | 0.5 | crease×2 | measured（≤0.15） | |
| base.y.outerWall | 60.0（H，自外線） | 60.0 | — | measured | |
| base.y.platform | 5.0 | 5.0 | crease×2 | measured | ✓ |
| base.y.innerWall | 59.2（H−2t） | 59.2 | — | measured | |
| base.y.tuckFlap | 15.0（7.5+7.5 梯形） | 15.0 | cut | measured | ✓ |

### lid（上蓋；B 片。panel 151(x)×206(y·生產品 216——y 絕對值不對帳)、H=45、platform=0）

| 槽位 | 預期值 | 量測值 | 線型 | source | t 無關 |
|---|---|---|---|---|---|
| lid.x.panel | 151.0（124+2×13.5） | 151.0 | crease（單） | measured | ✓ |
| lid.x.outerWall | **44.6（H−t）** | 45.0 | — | **corrected**（平齊修正，生產品漏做） | |
| lid.x.innerWall | **43.8（H−3t）** | 44.2 | — | **corrected** | |
| lid.x.tuckFlap | 15.0 | 15.0 | cut | measured | ✓ |
| lid.y.doubleCreaseGap | 0.4（t） | 0.5 | crease×2 | measured（≤0.15） | |
| lid.y.outerWall | 45.0（H） | 45.0 | — | measured | |
| lid.y.innerWall | 44.2（H−2t） | 44.2 | — | measured | |
| lid.y.tuckFlap | 15.0（7.5+7.5） | 15.0 | cut | measured | ✓ |
| lid.y.panel | 206.0 | 216.0 | — | **y 絕對不對帳（D12）**——僅驗序列與公式 | |

### 角撐參照（生產刀模絕對座標 pt；復刻→參數化用）

- **A 款（45° 斜角撐·厚壁）**，右下角一組：斜 cut `(2085.97,1071.89)→(2157.66,1143.58)`＋斜 crease 續段 `→(2229.35,1215.27)`（各 25.3mm、45°）；外緣斜切 `(2085.97,1240.55)→(2229.35,1215.27)→(2254.63,1071.89)`
- **B 款（弧形讓位·薄壁）**，左下角一組：45° 斜 crease `(494.28,1171.1)→(441.58,1223.8)`（26.3mm）；斜 cut `(362.54,1174.61)→(349.3,1249.69)`（26.9mm、100°）；**讓位弧 R=5.0mm**（`(349.3,1249.69)→(325.32,1257.25)` 跨度 8.87mm）；45° 斜 cut `(325.32,1257.25)→(285.37,1217.3)`；**角撐頂小弧 R=1.5mm**（`(370.91,1174.61)→(362.54,1174.61)`）
- 舌片兩端讓位：內壁末端舌摺線兩端各留 ~9mm crease（halfcut 只在中段）；舌片全長比面板內圍短（B 片：197.2 vs 216——每端縮 9.4）

（完整逐線座標見量測腳本輸出與 `天地盒刀模.svg` 原檔——repo 外唯讀參照，勿複製進 repo。）
