# open-dieline v1 — Design Spec

> 印刷刀模產生器，原始碼公開的教育專案（source-available）。參數化生成盒型刀模（dieline），同時是一份「讓人看得懂盒型結構」的教材。
> 掛 trouver.art。License：PolyForm Noncommercial 1.0.0（歡迎學習改作，商業使用請洽 trouver.art 談授權）。

- **版本**：v1.1（2026-07-07 Codex spec review 19 findings 全數修入；v1.0 同日初稿）
- **作者**：法蘭（product owner）＋ 小稜（architect）
- **前身**：`trouver.crm-rebuild/components/Tools/Packaging/`（2025 年底 Gemini 3.5 Pro 產物）——本 spec 是它的剝離重構。前身深度分析：coding-workspace `Coding Projets/research/2026/07/07-trouver-workshop-os-重新審視/`（摘要見附錄 A）。

---

## 1. Vision 與定位

**一句話**：打開網頁 → 選盒型 → 調參數 → 即時看刀模 → 匯出 SVG/DXF 給刀模廠。每個參數附「它在盒型結構上的意義」，工具本身就是印刷刀模的公開教材。

**三個受眾**：
1. 法蘭自己（印刷業務的日常刀模與拼版工具）
2. 想了解刀模知識的設計師／印刷同好（公開學習）
3. 未來的貢獻者（照「新增盒型」教學加自己的盒型）

**不是**：DAM、估價系統、通用向量編輯器。

**措辭規範**：本專案自稱「原始碼公開的教育專案／source-available」，不自稱 OSI 定義的 open source（License 為非商業條款）。`open-dieline` 之 open 指開放知識。README 需有一段白話說明此區別。

## 2. 已定決策

| # | 決策 | 定案 |
|---|---|---|
| D1 | 形態 | 純前端靜態站（Vite + React + TypeScript，零後端），GitHub Pages 部署 |
| D2 | v1 盒型 | RTE（反插盒）移植 ＋ 天地盒（Telescope）參數化重寫 |
| D3 | 架構 | Schema-driven 插件：每盒型自帶 meta + paramSchema + generate + invariants |
| D4 | 專案名 | `open-dieline`，掛 trouver.art |
| D5 | License | PolyForm Noncommercial 1.0.0 全包；README 註明商用洽談；措辭見 §1 |
| D6 | SVG 匯入語意 | 生產刀模 1:1 overlay 對照（人眼比對調參），**不做** AI/自動逆向 |
| D7 | 匯出 | SVG ＋ DXF（R12），刀模廠兩者皆收 |
| D8 | UI | 沿用前身的流程與外觀（深色工程風、左參數欄＋右畫布），元件化重寫 |
| D9 | 範例資產 | 一律用本工具生成的刀模；法蘭的生產檔**不進 repo**（防呆見 §9.3） |
| D10 | 語言 | v1 繁中先行；文字欄位一律 `LocalizedText`（v1 只填 zh）；README 繁中為主＋英文摘要 |

## 3. 架構

### 3.1 目錄結構

```
open-dieline/
├── src/
│   ├── core/                  # 幾何核心：純 TS、零 React 依賴、可獨立測試
│   │   ├── geometry.ts        # Segment 型別（Line/Arc/Bezier）與運算（bounds、離散、正規化）
│   │   ├── path.ts            # PathBuilder：累積 Segment，投影出 SVG path 字串
│   │   ├── styles.ts          # 線型樣式表（顏色/線寬/虛線）——畫布與匯出唯一共享來源
│   │   ├── primitives.ts      # 可複用構件：摩擦扣、J-Hook 避讓槽、防塵翼倒角、尺寸標註線
│   │   ├── types.ts           # DielinePath / GenerateResult / BoxModule / BoxParamDef / BoxInvariant
│   │   └── registry.ts        # 盒型註冊表
│   ├── boxes/                 # 盒型插件——一盒型一檔
│   │   ├── reverse-tuck-end.ts
│   │   └── telescope.ts
│   ├── export/
│   │   ├── svg.ts             # SVG 序列化（吃 Segment + styles.ts）
│   │   └── dxf.ts             # DXF R12 writer（直接吃 Segment，不解析字串）
│   ├── overlay/
│   │   ├── import.ts          # SVG 檔解析（支援子集見 §5）
│   │   └── calibrate.ts       # 已知長度校準（主）＋單位猜測（輔）
│   ├── imposition/
│   │   └── layout.ts          # 拼版計算
│   ├── ui/
│   │   ├── App.tsx
│   │   ├── ParamPanel.tsx     # 從 paramSchema 自動生成（含 hover 高亮聯動）
│   │   ├── Canvas.tsx         # pan/zoom＋SVG 渲染（樣式取自 styles.ts）
│   │   ├── OverlayControls.tsx
│   │   ├── PaperPanel.tsx
│   │   └── ExportBar.tsx
│   └── content/               # 教育內容：每盒型結構介紹
├── tests/                     # vitest：不變式＋golden＋fixture＋假旋鈕＋DXF
├── public/examples/           # 生成的範例刀模
├── docs/specs/
├── LICENSE                    # PolyForm NC 1.0.0
├── README.md
└── .github/workflows/ci.yml  # test + build + Pages 部署 + 私有資產防呆檢查
```

### 3.2 資料流與「單一來源」的精確定義

```
ParamPanel（由 paramSchema 生成）
   → params state
   → registry.get(boxId).generate(params)
   → GenerateResult { paths: DielinePath[]（結構化 Segment）, texts, bounds }
   → Canvas 渲染（React 將 Segment 投影為 <path d>，樣式取 styles.ts）
   → 匯出（svg.ts / dxf.ts 各自吃同一份 Segment；SVG 樣式取 styles.ts）
```

**漂移防範的落地方式**（修正前身「畫布與下載兩份手刻模板」問題）：
1. **幾何單一來源**：畫布與兩種匯出讀的都是同一份 `GenerateResult.paths`（結構化 Segment）
2. **樣式單一來源**：線型→顏色/線寬/虛線的映射只存在 `core/styles.ts`，Canvas JSX 與 svg.ts 皆 import 它；新增線型只改此一處
3. **測試強制**：mutation 測試——改 styles.ts 任一線型顏色，畫布 snapshot 與匯出 SVG 內容必須同步改變

Overlay 層與拼版預覽為畫布上的獨立顯示層，不進 GenerateResult、不進匯出。

### 3.3 核心型別契約

```ts
type LocalizedText = { zh: string; en?: string };   // v1 只填 zh

// ── 幾何：結構化 Segment 為核心資料，SVG 字串只是投影 ──
type Segment =
  | { kind: 'line';   x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arc';    cx: number; cy: number; r: number;
      startAngle: number; endAngle: number; ccw: boolean }
  | { kind: 'bezier'; x1: number; y1: number; c1x: number; c1y: number;
      c2x: number; c2y: number; x2: number; y2: number };

type LineType = 'cut' | 'crease' | 'halfcut' | 'bleed' | 'annotation' | 'dimension';

interface DielinePath {
  id: string;
  type: LineType;
  segments: Segment[];
  tags?: string[];          // 參數高亮對應（一段幾何可對應多個參數）
}

interface GenerateResult {
  paths: DielinePath[];
  texts: DielineText[];     // { id, x, y, text, rotation?, fontSize?, anchor? }
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

// ── 參數 ──
interface BoxParamDef {
  key: string;
  label: LocalizedText;
  unit: 'mm' | 'deg' | 'bool' | 'enum';
  default: number | boolean | string;
  options?: { value: string; label: LocalizedText }[];   // unit='enum' 必填
  min?: number; max?: number; step?: number;
  group: LocalizedText;
  description: LocalizedText;          // 教育說明：此參數在盒型結構上的意義（一級公民）
  highlightTags?: string[];            // hover 時高亮之幾何 tag
  derivedDefault?: (params: Readonly<Record<string, number | boolean | string>>) => number;
}
// derivedDefault 解析規則：按 params 宣告順序解析、只可引用先前參數（禁止前向引用，
// 測試強制）；UI 在使用者未手動覆寫該欄位時即時重算——顯示值與生成值恆同源。

// ── 不變式：測試與 runtime 警告共用 ──
interface BoxInvariant {
  id: string;
  description: LocalizedText;          // 也是教材：這條幾何規則為什麼存在
  check: (params: ResolvedParams, result: GenerateResult) =>
    { ok: true } | { ok: false; message: LocalizedText; tags?: string[] };
}
// 測試：全部不變式在預設參數與邊界參數組合下必須 ok。
// UI：任一不變式 not-ok 時畫布顯示警告條（含 message），並高亮 tags——
// 使用者調出「做不出來的刀模」時當場知道，而不是送廠才發現。

interface BoxModule {
  meta: { id: string; name: LocalizedText; intro: LocalizedText;
          topology: 'linear' | 'cross' | string };
  params: BoxParamDef[];               // 每盒型只宣告自己的參數（無共用大袋子）
  invariants: BoxInvariant[];
  generate: (params: ResolvedParams) => GenerateResult;
}
```

設計重點：
- **Segment 為核心**——DXF 直接消費（LINE/ARC/POLYLINE），SVG `d` 字串由 `path.ts` 投影；golden 比對與等價驗證都在 normalized Segment 層做，不比字串
- **參數宣告即接線**——盒型不得宣告 generate 未使用的參數（假旋鈕測試見 §8）
- **`bleed` 線型 v1 禁產**——型別保留供 v2，任何盒型 generate 產出 bleed 即測試失敗（見 §11）

## 4. v1 盒型規格

### 4.1 RTE 反插盒（移植）

- 幾何邏輯自前身 `ReverseTuckEnd.ts` 移植（該檔為健康的參數化實作，見附錄 A）
- 移植改造：具名化 3 個容差常數（糊邊導角 5mm、摩擦扣凸高 1.5mm、扣具導角 2mm）；上下週界鏡像重複抽成共用函式；輸出改為結構化 Segment（經 `core/path.ts`）
- 參數集（照前身平移）：L / W / D / 紙厚 / 插舌深度 / 插舌圓角 / 插舌內縮 / 摩擦扣寬 / 防塵翼深 / 避讓槽寬 / 折線避讓 / 糊邊寬 / **糊邊位置（enum：左｜右）**
- 每參數補 `description`（教育說明）
- **等價驗收定義**：與前身輸出在 normalized Segment 層等價——線段化（曲線離散 0.05mm）後端點集合排序比對，容差 0.01mm，忽略 path 順序、id、tag；比對腳本進 tests/

### 4.2 天地盒（參數化重寫）

- **前身實作作廢**（bug 清單見附錄 A），僅「上蓋＋底座十字展開」拓撲概念保留
- 重寫流程（三步、每步有產物）：
  1. **量測表**：從法蘭生產 SVG 人工量測關鍵尺寸 → 成表（欄位：蓋/底展開寬高、側板高、Hook Tab 寬/深/間距、捲邊深、蓋身間隙、角切偏移與角度）→ **法蘭確認比例關係**後才進下一步
  2. **fixture 化**：量測表數值寫成公開 fixture（量測數值＝盒型比例知識，進 repo；生產 SVG 檔案本身不進，見 §9.3）
  3. **generate 實作**：參數全部真接線；Hook Tab 尺寸與間距由參數推導並附「相鄰構件不重疊」不變式
- **驗收（兩層）**：
  - CI 層（客觀、可重現）：以量測 fixture 參數生成 → 關鍵尺寸與 fixture 數值對照，**容差 ±0.2mm**（人工量測精度）；全部不變式通過
  - 法蘭手動 gate（主觀輔助）：本地 overlay 疊生產 SVG 目測 R 角與細部——release checklist 項，不進 CI

## 5. Overlay 對照層

- **支援的 SVG 子集**（明定，超出者列警告不擋匯入）：`path`（M/L/H/V/C/S/Q/A/Z，絕對與相對指令）、`line`、`polyline`、`polygon`、`rect`、`circle`、`ellipse`；`<g>` 之 `transform`（translate/scale/rotate/matrix）展平套用。**不支援**：`text`、`image`、`use`、嵌套 `<svg>`、CSS class 以外的樣式繼承——遇到時列入「未匯入元素」警告清單
- **校準（已知長度為主）**：匯入後使用者點選一段線、輸入實際 mm → 換算係數自動套用；單位下拉（pt ×0.3528／mm／px）僅作初始猜測
- 對齊：拖曳平移＋快速對齊（左上角／中心／邊界框）；縮放與生成層鎖同比例（1:1）
- 顯示：overlay 全線段染洋紅、透明度滑桿（預設 50%）、可開關；生成層維持線型原色
- 用途定位（寫進 UI 說明）：對照調參用，特別是 R 角與細部結構

## 6. 匯出

### 6.1 SVG
- `export/svg.ts` 吃 `GenerateResult.paths`（Segment 投影為 `d`）＋ `styles.ts` 樣式——與畫布同源（見 §3.2 漂移防範）
- 線色慣例：黑＝cut、綠（#00FF00）＝crease、黃（#FFFF00）＝halfcut（與業界及法蘭生產檔一致）
- `width/height` 以 mm 明示＋viewBox；尺寸標註線可選含／不含

### 6.2 DXF
- R12 ASCII、純 TS 手寫 writer、零依賴；**直接消費 Segment**（不解析 SVG 字串）
- 圖層：`CUT` / `CREASE` / `HALFCUT`
- line→LINE；arc→ARC（圓心/半徑/起訖角直接來自 Segment 欄位）；bezier→POLYLINE，**離散演算法＝de Casteljau 遞迴細分、弦高判準 ≤0.1mm、單段最長 5mm**
- 測試：輸出可被解析（實體計數、圖層歸屬）；離散誤差測試涵蓋最小圓角（r=1mm）與最大曲率案例
- 檔名自動：`{盒型id}-{L}x{W}x{D}.dxf`

## 7. 拼版（imposition）

- 紙張預設：31"×43"（787×1092）、25"×35"（635×889）、70×100cm＋自訂
- 輸入：紙張尺寸、咬口（gripper，印刷機夾紙側單邊預留，預設 10mm）、四周邊距、模間距
- 計算：正放與旋轉 90° 兩種方向的 N×M 組合 → 回報最優模數與方向
- 預覽：畫布上以淡色陣列顯示排列
- v1 為矩形邊界框拼版（以刀模 bounds 計）；異形交錯拼版（nesting）為 Non-goal
- **歷史案例 fixture**：至少 2 個法蘭真實案例，每案記完整輸入（紙張、咬口、邊距、間距、方向限制）＋當年實際模數＋差異可接受原因（若演算法更優）——實作期向法蘭取得

## 8. 測試策略

| 層 | 工具 | 內容 |
|---|---|---|
| 幾何不變式 | vitest | 每盒型的 `invariants` 在預設參數＋邊界參數組合下全過（含：展開總寬＝Σ面板＋糊邊、蓋板高＝W〔RTE〕、Hook Tab 相鄰不重疊〔天地盒〕、全 Segment 無 NaN、bounds 涵蓋所有 Segment、**不產出 bleed 線型**） |
| 假旋鈕防範 | vitest | 每個 param key 取兩個有效值（數值＝[min,max] 內兩點；bool＝反轉；enum＝另一選項），生成輸出的 normalized Segment 必須有差異。**定位**：只防「宣告未接線」，語意正確性由不變式＋golden＋fixture 保證 |
| derivedDefault 秩序 | vitest | 宣告順序解析、無前向引用、無循環 |
| Golden 快照 | vitest | 每盒型固定參數組 → **normalized geometry snapshot**（Segment 固定精度 0.01、端點排序穩定、剔除 id 等非幾何欄位）——重構不產生無意義 diff |
| RTE 等價 | vitest | 對前身輸出之 normalized Segment 比對（§4.1 定義） |
| 天地盒 fixture | vitest | §4.2 量測 fixture 對照，容差 ±0.2mm |
| 樣式同源 | vitest | styles.ts mutation → 畫布與匯出 SVG 同步改變 |
| DXF | vitest | 可解析、圖層歸屬、離散誤差（§6.2 案例） |
| 拼版 | vitest | §7 歷史案例 fixture |
| UI | vitest + testing-library | 冒煙：選盒型→調參→畫布更新→不變式警告顯示→匯出觸發 |

## 9. 公開發布配套

### 9.1 README
定位與 source-available 說明（§1 措辭）、線上 demo（Pages 連結）、盒型知識索引、快速開始、**「如何新增一個盒型」教學**（貢獻指南＝教材）、License＋「商業使用請聯繫 trouver.art 洽談授權」。

### 9.2 CI（GitHub Actions）
PR：test＋build＋私有資產檢查；main：加 Pages 部署。

### 9.3 私有資產防呆（法蘭生產檔不進 repo）
- 慣例：生產參照檔一律放 repo 外 `~/dieline-refs/`；repo 內另設 `refs/` 於 `.gitignore`
- `.gitignore`：`refs/`、`*.ai`、`*.eps`
- CI 檢查：拒絕 >1MB 的 SVG 與任何 `*.ai/*.eps` 進版（生成的範例刀模遠小於此）

### 9.4 位置
本地 `~/projects/open-dieline`；remote 由法蘭提供 trouver.art 帳號後掛。教育內容 v1 形式：`meta.intro`（側欄）＋參數 `description`（hover）；獨立知識頁為 v1.1+。

## 10. 驗收條件（可驗證）

1. `npm run dev` 起站：選 RTE／天地盒，調任一參數畫布即時更新；hover 參數高亮 `highlightTags` 對應幾何；不變式 not-ok 時警告條顯示
2. RTE 等價：§4.1 定義的 normalized Segment 比對通過（容差 0.01mm）
3. 天地盒：§4.2 CI 層驗收全過（fixture ±0.2mm＋全不變式）；法蘭本地 overlay 目測 gate 過（release checklist）
4. 匯出同源：樣式 mutation 測試過；SVG 含三線型且與畫布一致；DXF 經 LibreCAD 或等效 viewer 開啟可見三圖層
5. Overlay：匯入 §5 子集內的 AI 匯出 SVG → 已知長度校準 → 與生成層 1:1 疊圖、透明度可調；含未支援元素的檔案顯示警告清單且不崩潰
6. 拼版：§7 兩個歷史案例 fixture 通過（相同模數，或更優且原因成立）
7. 全部測試綠、CI 過、Pages 部署可公開訪問
8. 假旋鈕測試全過（每宣告參數都影響輸出）
9. README 完整（§9.1 清單）

## 11. Non-goals（v1 明確不做）

- ❌ AI／自動逆向 SVG 成參數化盒型（人眼 overlay 對照即可，前身實證 AI 讀刀模不可靠）
- ❌ 異形交錯拼版（nesting）——v1 僅矩形邊界框
- ❌ 3D 摺疊預覽（v2 候選）
- ❌ 出血生成——`bleed` 線型保留於型別，v1 任何盒型產出 bleed 即測試失敗
- ❌ 專案存檔／分享連結（URL 參數序列化列 v1.1 候選）
- ❌ 多語 UI 內容（`LocalizedText` 結構已就位，v1 只填 zh）
- ❌ PWA／離線
- ❌ 前身 crm-rebuild 的任何其他模組遷移

## 12. 風險

| 風險 | 對策 |
|---|---|
| 天地盒生產 SVG 量測比例理解錯誤 | §4.2 三步流程：量測表先給法蘭確認再寫 generate；overlay 目測為 release gate |
| DXF 在刀模廠 CAD 的相容性 | R12 最保守通用；交付前法蘭拿真實廠商流程驗一次 |
| 生產檔誤入 repo | §9.3 三層防呆（目錄慣例＋gitignore＋CI 檢查） |
| 前身 UI 手刻 pan/zoom 移植後手感差異 | 樣張 gate：UI 先出可互動版本給法蘭實際操作核可 |
| Segment 抽象讓 RTE 移植量放大 | RTE 移植即第一個消費者，PathBuilder 提供與前身相同手感的 M/L/A 介面、內部積累 Segment |

---

## 附錄 A：前身分析摘要（2026-07-07 agent 深掃）

- **RTE（357 行）**：健康——座標全參數推導、helper 抽象正確、僅 3 個合理容差常數。移植對象。
- **天地盒（505 行）**：作廢——Hook Tab 高度寫死 30mm 而間距 W/4（預設即重疊 54%）；宣告 7 參數僅讀 2 個，餘被 `hookW=50` 等硬編碼取代；`glueSize`/`thickness` 收了沒用；UI 顯示預設（D×0.4）與生成預設（D×0.75）兩套；generateLid/generateBase 重複 helper、手動鏡像複製。
- **UI（691 行單檔）**：pan/zoom 手刻可用、耦合極輕（僅 4 個純展示元件）、11 個死 import；下載 SVG 與畫布為兩條平行手刻序列化（已漂移：漏 halfcut 樣式）。
- **types**：`DielinePath`/`BoxModel` 契約健康；`BoxDimensions` 為跨盒型參數聯集大袋子。
- **參考 SVG**（天地盒＋雙蓋盒）：AI 30.1 匯出、流水號線段無語意分組、無文字標註、無單位標示；色碼黑/綠/黃與本 spec 慣例一致。雙蓋盒為未動工原料（v1.1 候選盒型）。

## 附錄 B：v1.0 → v1.1 修訂記錄（Codex spec review，19 findings 全收）

- 幾何核心改**結構化 Segment**、SVG 字串降為投影（原 BLOCKING/SERIOUS：DXF 不解析字串、等價與 golden 比對可正規化）
- 樣式表 `styles.ts` 為畫布/匯出唯一共享來源＋mutation 測試（原 BLOCKING：兩條渲染路徑漂移）
- 天地盒驗收拆 CI 客觀層（fixture ±0.2mm）與法蘭手動 overlay gate（原 BLOCKING：目測不可驗收）
- `BoxInvariant` 型別與 UI 警告行為定義（原 BLOCKING：型別缺漏）
- Overlay 支援子集明定＋未支援警告清單（原 BLOCKING：「任一 SVG」不可保證）
- 假旋鈕測試向量規則與定位釐清；`derivedDefault` 改 resolver＋秩序測試；`unit` 補 enum；`LocalizedText` 即刻定型；DXF 離散演算法明定；拼版 fixture 完整輸入；bleed v1 禁產；RTE 等價定義；gitignore/CI 防呆具體化；source-available 措辭規範
