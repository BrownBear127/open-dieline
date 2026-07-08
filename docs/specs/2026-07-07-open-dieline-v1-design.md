# open-dieline v1 — Design Spec

> 印刷刀模產生器，原始碼公開的教育專案（source-available）。參數化生成盒型刀模（dieline），同時是一份「讓人看得懂盒型結構」的教材。
> 掛 trouver.art。License：PolyForm Noncommercial 1.0.0（歡迎學習改作，商業使用請洽 trouver.art 談授權）。

- **版本**：v1.2（2026-07-08 Slice 2 修訂：紙厚接線＋天地盒三件套，據生產刀模量測 ground truth；修訂記錄見附錄 C。v1.1＝2026-07-07 Codex spec review 19 findings 全數修入；v1.0 同日初稿）
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
| D11 | 紙厚接線（2026-07-08） | `thickness` 為真實幾何參數（step 0.1mm、default 0.3mm），所有補償量為 t 的函數、**t=0 時全部歸零**（RTE 等價測試以 t=0 錨定）。補償依據：天地盒生產刀模量測 ground truth（量測表見 coding-workspace 任務夾）＋ RTE 行業標準補償集 |
| D12 | 天地盒三件套（2026-07-08） | 天地盒＝上蓋＋下盒＋內襯圍框三片（`pieces` 分組）；參數語意＝**主面板**（製造尺寸，與 RTE 一致、與生產刀模直接對帳）；上蓋放大量＝單一等邊 `lidMargin`（生產品 y 向多 5mm 為手調遺留，不重現）；壁款＝每片一個 `platformWidth`（0＝薄壁單線反折、>0＝厚壁平台） |
| D13 | Slice 切分（2026-07-08） | Slice 2＝幾何完整化（D11＋D12＋樣張 gate）；Slice 3＝overlay＋DXF；Slice 4＝拼版＋公開發布配套 |

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

interface DielinePiece {          // v1.2：多片盒型（天地盒三件套）的「片」
  id: string;                     // 盒型自定（如 'lid' | 'base' | 'liner'）
  label: LocalizedText;
  pathIds: string[];              // 屬於此片的 path id（不動 DielinePath 介面）
  textIds: string[];              // 屬於此片的 text id
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface GenerateResult {
  paths: DielinePath[];
  texts: DielineText[];     // { id, x, y, text, rotation?, fontSize?, anchor? }
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  pieces?: DielinePiece[];  // 省略＝單片盒型（RTE 不變、向後相容）
}
// pieces 規則（測試強制）：generate 自行決定片的絕對座標排版（片間距用具名常數）；
// piece.id 唯一且每片非空；每個 path/text 必屬於恰好一片（pathIds/textIds 聯集＝全集、
// 兩兩不交、引用的 id 必須存在）；各片 bounds 涵蓋其成員且兩兩不重疊；
// GenerateResult.bounds ＝ 全片 bounds 之聯集包絡 ＝ 全幾何包絡。
// 片的「語意身分」（哪片是 lid）型別層不管——由各盒型的不變式綁定（見 §4.2）。
// UI：畫布提供「全版／單片」切換；SVG 匯出可選整版或單片（樣張列印必需——內襯攤平逾 700mm）。

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

### 4.1 RTE 反插盒（移植＋v1.2 紙厚接線）

- 幾何邏輯自前身 `ReverseTuckEnd.ts` 移植（該檔為健康的參數化實作，見附錄 A）。**Slice 1 已完成移植**（12 參數、thickness 因前身未接線而排除）；v1.2 把 thickness 正式接回。
- 移植改造：具名化 3 個容差常數（糊邊導角 5mm、摩擦扣凸高 1.5mm、扣具導角 2mm）；上下週界鏡像重複抽成共用函式；輸出改為結構化 Segment（經 `core/path.ts`）
- 參數集：L / W / D / **紙厚 thickness（default 0.3、step 0.1、min 0、max 0.8）** / 插舌深度 / 插舌圓角 / 插舌內縮 / 摩擦扣寬 / 防塵翼深 / 避讓槽寬 / 折線避讓 / 糊邊寬 / **糊邊位置（enum：左｜右）**
- 每參數補 `description`（教育說明）
- **thickness 標準補償集**（全部為 t 的一次函數、t=0 歸零）：

  | 補償點 | 公式（預設係數） | 結構理由 |
  |---|---|---|
  | 面板圍圈（girth） | 面板寬依摺次遞增 `[+0, +t, +t, +2t]`——面板編號 P1..P4 依**攤平圖從糊邊側起算**（與前身攤平序一致），補償依序套用。t=0.4 校驗值：四面寬＝名義＋[0, 0.4, 0.4, 0.8] | 紙繞盒身一圈，外層每過一摺要多走約一個紙厚 |
  | 插舌內縮 | `derivedDefault = 前身預設 + t`（§3.3 auto/manual 機制：未覆寫隨 t 重算、已覆寫不被洗掉） | 插舌插入處內空因紙厚縮小 |
  | 防塵翼讓位 | 讓位間隙 `+t` | 翼片摺入時與相鄰面板的紙厚干涉 |
  | 摩擦扣／糊邊 | 不補 | 黏合面與扣位由手動參數控制，不疊自動項 |

  **係數審核條款**：girth 係數 `[0,1,1,2]` 為行業常規（無前身 ground truth），定稿依據＝Codex review 驗證＋法蘭生產經驗審核＋樣張 gate 實摺；係數以具名常數表集中一處，審核改動不觸幾何代碼。
- **等價驗收定義（v1.2 改為 t=0 錨定）**：`thickness=0`、其餘參數同前身預設時，與前身輸出在 normalized Segment 層等價——線段化（曲線離散 0.05mm）後端點集合排序比對，容差 0.01mm，忽略 path 順序、id、tag；既有 fixture 不變。t>0 的新行為由 golden（t=0.3）與不變式防守。

### 4.2 天地盒三件套（參數化重寫，v1.2 定稿）

- **前身實作作廢**（bug 清單見附錄 A；前身為膠黏式構造，與生產品的免膠折疊式根本不同）
- **量測 ground truth 已完成（2026-07-08）**：生產刀模逐線量測＋法蘭確認，量測表在 coding-workspace 任務夾 `feature/2026/07/07-open-dieline/天地盒量測表.md`。量測數值 fixture 化進 repo（比例知識公開；生產 SVG 檔案本身不進，見 §9.3）
- **構造（量測定案）**：上蓋、下盒同一「免膠雙壁 tray」拓撲——中央面板＋四壁（外壁 →〔壁頂平台〕→ 內壁 → 插底舌 15mm）＋四角撐；左右壁先立（單 crease 根）、前後壁後摺（雙 crease 根、間距 t）；內壁→舌摺線為 halfcut（中段 halfcut、兩端留 **cut**——2026-07-09 T7 樣張 gate 法蘭裁決：兩端讓位段是自由邊，刀模須軋斷，量測表原判讀為 crease 係 SVG 顏色分類誤差）。**內襯＝平台式腳架墊片**（2026-07-09 T7 gate 反饋重定義，取代原「L 形斷面落地圍框」版——法蘭實測後裁決該版是實際不會用的形式）：中央矩形底面錨定**下盒內淨**、四邊各一片翼向下摺成腳架（翼深＝架高量，單一參數 `linerFlapDepth`），功能＝放進下盒貼底把物品墊高、免膠無 tab（四角天然讓位）

**參數表**（宣告順序；生產品重現值＝括號內）：

| key | default | min–max（step） | 說明 |
|---|---|---|---|
| `baseLength` / `baseWidth` | 179 / 124 | 30–600（0.5） | 下盒**主面板**尺寸（製造尺寸；D12） |
| `baseHeight` | 60 | 10–200（0.5） | 下盒壁高（＝後摺壁全高；先摺壁自動 −t 頂緣平齊） |
| `lidMargin` | 13.5 | 1–40（0.1） | 上蓋等邊放大：上蓋面板＝下盒面板＋2×margin；有內襯時下界受不變式約束（見下） |
| `lidHeight` | 45 | 10–200（0.5） | 上蓋壁高 |
| `basePlatformWidth` | 5 | 0–15（0.5） | 下盒壁頂平台寬；0＝薄壁單線反折 |
| `lidPlatformWidth` | 0 | 0–15（0.5） | 上蓋壁頂平台寬（生產品＝薄壁） |
| `thickness` | 0.3 | 0–0.8（0.1） | 紙厚（生產品黑卡 0.44→輸 0.4） |
| `linerEnabled` | true | bool | 內襯墊片開關（false＝pieces 只有 lid＋base 兩片，緊配或腰封自理） |
| `linerFitGap` | 0.5 | 0.2–2（0.1） | 內襯底面對下盒內淨的套合間隙（2026-07-09 T7 gate 重定義：只扣一次，不再是舊圍框版「上蓋一次＋下盒一次」的雙重扣） |
| `linerFlapDepth` | 15 | 5–60（0.5） | 內襯腳架深度＝物品架高量（2026-07-09 T7 gate 反饋新增，平台式重定義；四邊同深、單一參數） |

固定具名常數（照量測）：插底舌深 15、角撐斜切 5、片間距（版面排列用）。角撐款式跟隨壁款：厚壁（platform>0）配 45° 斜角撐、薄壁配弧形讓位角撐（照生產品兩款各自的畫法）。（內襯黏合 tab／翻邊最小寬 `MIN_FLANGE` 隨圍框版作廢移除，2026-07-09 T7 gate。）

**天地盒專屬不變式**（除通用不變式外）：
- `liner-flap-fits`（2026-07-09 T7 gate 反饋重定義，取代 `liner-flange-fits`）：`linerEnabled` 時 3 條件依序檢查——① 底面尺寸（`padL`/`padW`，見內襯導出鏈）必須為正值，否則警告「底面不存在」；② `linerFlapDepth` 不得超過 `baseHeight`，否則警告「內襯會頂出盒口」；③ `linerFlapDepth` 不得超過底面較短邊長的一半，否則警告「翼片外緣反轉自撞」
- `pieces-identity`：pieces 依 `linerEnabled` 為 `[base, lid, liner]` 或 `[base, lid]`；`base` 片主面板實測＝`baseLength×baseWidth`、`lid` 片主面板實測＝`＋2×lidMargin`（從生成幾何驗證，防 lid/base 整包對調）
- `rim-flush`：每片先摺壁外壁高＝後摺壁外壁高 − t（頂緣平齊）
- `t=0` 時後摺壁根部雙 crease **collapse 為單 crease**（不輸出兩條重合摺線；DXF/SVG 不出重線）

**補償公式**（全部為 t 的函數、t=0 歸零；ground truth＝量測表，當年設計以 0.4/0.5 圓整值驗證吻合）：

| 補償點 | 公式 | 量測佐證（t≈0.4） |
|---|---|---|
| 內壁高 | 外壁高 − 2t | 60→59.2、45→44.2（8 壁全中） |
| 後摺壁根部雙 crease | 間距 t | 0.5（4 處全中） |
| 先摺壁外壁高 | 名義壁高 − t（**頂緣平齊**） | 下盒 59.5 vs 60（上蓋當年漏做，新模組兩款都做） |
| 上蓋內淨 | 上蓋面板 − 4t | （設計定義式，非直接量測——內淨是折疊後空間值；t=0.44 推算 149.2，與內襯間隙帶反推吻合） |
| 下盒外圍 | 下盒面板 ＋ 2t | （同上，設計定義式；124→124.9） |

**內襯導出鏈**（2026-07-09 T7 gate 反饋重定義：平台式，取代原「L 形斷面落地圍框」版；法蘭提供正確形式、三題定案——底面錨定＝下盒內淨、四翼向下摺＝腳架、四邊同深單一參數；圍框版全部作廢，無獨立尺寸參數，全部由套合幾何導出）：
- `baseInnerL = baseLength − 4t`、`baseInnerW = baseWidth − 4t`（下盒內淨：雙壁，外壁 t＋內壁 t 每側）
- `padL = baseInnerL − 2×linerFitGap`、`padW = baseInnerW − 2×linerFitGap`（底面，四邊留一次套合間隙；t=0.4/fitGap=0.5/base 179×124 → 底面 176.4×121.4，t=0.3 預設 → 176.8×121.8）
- 攤平＝底面＋四邊各一個翼（深 `linerFlapDepth`）；翼＝梯形，根部（crease）＝該邊全長、外緣（cut）＝該邊長 − 2×`linerFlapDepth`（兩端 45° 內斜）；四角因相鄰兩翼的 45° 斜切共線而自然讓位，免膠無 tab
- 攤平外圍 ＝ `(padL + 2×linerFlapDepth) × (padW + 2×linerFlapDepth)`（同組參數＋`linerFlapDepth`=15 → 206.4×151.4）
- 線型：crease＝底面周界 4 條；cut＝四翼外輪廓（各翼斜切→外緣→斜切，共 3 段）
- 構造參照：舊圍框版任務夾 `gen_liner.py`＋`內襯圍框-重建.svg`**已作廢**——平台式重定義不承接其構造，golden 由本導出鏈全新自產

**驗收（v1.2 修訂）**：
- CI 層：
  1. 全部不變式通過（含 pieces 完整性：path/text 歸屬聯集＝全集且兩兩不交、各片 bounds 不重疊）
  2. **生產刀模部分對帳（具名槽位 fixture）**：params＝(179/124/60、margin 13.5、lidHeight 45、platform 5/0、t=0.4、fitGap 0.5) 生成 → 對照 fixture。fixture 為**具名結構分解表**而非裸座標序列——每片（base/lid）×每方向（x/y）的剖面槽位依序具名（如 `base.x.outerWall`、`base.x.platform`、`lid.y.doubleCreaseGap`、`base.x.tuckFlap`），每槽記〔預期值、線型、序位〕，**防「差值湊成 t 但槽位錯置」**。比對規則分兩層：
     - **t 無關槽位**（面板 124、平台 5、插底舌 15 等）：x 方向逐項 ±0.05mm（量測為腳本聚類非人工）
     - **t 相關槽位**（壁高、內壁差、雙 crease）：驗**公式關係**（內壁＝外壁−2t、先摺壁＝名義−t、雙 crease＝t，對生成值自洽）＋ x 方向與量測絕對差 ≤0.15mm——當年設計對不同補償點用了不一致的圓整（內壁差 0.8＝2×0.4、先摺壁差 0.5＝0.44 進位），對帳驗的是規則、不複製圓整噪音。**例外槽位**：上蓋先摺壁鏈（`lid.x.outerWall`／`lid.x.innerWall`）——生產品當年漏做平齊補償（量測 45.0/44.2），新模組刻意修正為 −t（44.6/43.8），此二槽對帳目標＝公式修正值、fixture 中標注來源為 `corrected` 並記偏離原因
     - **y 方向**：不對帳生產刀模的**絕對尺寸**（單一等邊 margin 定案 D12 使 y 向整體差 10mm，屬已知非目標）；但 y 向**剖面槽位序列的完整性與公式關係照驗**（外壁→〔平台〕→內壁→halfcut→舌片的序位、線型、雙 crease 間距＝t）——y 向的結構錯畫不因此放行
  3. 內襯公式對帳（2026-07-09 T7 gate 重定義：平台式）：golden 由 §4.2 導出鏈在 t=0.4/fitGap=0.5/flapDepth=15 下自產（底面 176.4×121.4、攤平 206.4×151.4、翼片 45° 斜切）；不引用舊圍框版重建 SVG 數值
- 樣張 gate（release checklist、不進 CI）：法蘭以單片 SVG 匯出列印（縮放或分頁）、試摺三件、互套＋腰封位確認

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
| 幾何不變式 | vitest | 每盒型的 `invariants` 在預設參數＋邊界參數組合下全過（含：展開總寬＝Σ面板＋糊邊、蓋板高＝W〔RTE〕、**頂緣平齊與內外壁對帳〔天地盒〕**、全 Segment 無 NaN、bounds 涵蓋所有 Segment、**pieces 完整性（§3.3 規則）**、**不產出 bleed 線型**） |
| 假旋鈕防範 | vitest | 每個 param key 取兩個有效值（數值＝[min,max] 內兩點；bool＝反轉；enum＝另一選項），生成輸出的 normalized Segment 必須有差異（**thickness 亦然——宣告即接線**）。**定位**：只防「宣告未接線」，語意正確性由不變式＋golden＋fixture 保證 |
| derivedDefault 秩序 | vitest | 宣告順序解析、無前向引用、無循環 |
| Golden 快照 | vitest | 每盒型固定參數組（**含 t=0.3 預設——錨定補償後的新行為**）→ **normalized geometry snapshot**（Segment 固定精度 0.01、端點排序穩定、剔除 id 等非幾何欄位）——重構不產生無意義 diff |
| RTE 等價 | vitest | **t=0**、餘參數同前身預設，對前身輸出之 normalized Segment 比對（§4.1 定義；既有 fixture 不變） |
| 天地盒對帳 | vitest | §4.2 具名槽位 fixture 分層對帳（t 無關 ±0.05／t 相關驗公式＋≤0.15／y 向驗序列與公式不驗絕對值——完整規則以 §4.2 為準）＋內襯 golden（§4.2 導出鏈自產） |
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

1. `npm run dev` 起站：選 RTE／天地盒，調任一參數畫布即時更新；hover 參數高亮 `highlightTags` 對應幾何；不變式 not-ok 時警告條顯示；**天地盒可切「全版／單片」視圖、單片可獨立匯出 SVG**；derivedDefault 欄位（如插舌內縮）未覆寫時隨 thickness 即時重算、已手動覆寫後調 t 不被洗掉
2. RTE 等價：§4.1 定義的 t=0 錨定比對通過（容差 0.01mm）；**t>0 時 girth／插舌／防塵翼補償生效且 t 假旋鈕測試過**
3. 天地盒：§4.2 CI 層驗收全過（具名槽位分層對帳＋內襯 golden＋全不變式，規則以 §4.2 為準）；`linerEnabled=false` 時 pieces＝〔base, lid〕兩片且匯出／視圖行為一致；**樣張 gate 過（法蘭列印試摺三件互套）**
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
- ❌ 瓦楞／厚板（t>0.8mm）補償——本 spec 補償公式為薄卡域，厚板的摺線損耗非線性、另議
- ❌ 天地盒 y 方向的生產刀模 1:1 重現（D12 單一等邊 margin 定案的已知後果，x 向對帳已足以驗證幾何引擎）
- ❌ 非矩形／分隔式內襯（v1 內襯＝矩形對中腳架墊片一種，2026-07-09 T7 gate 重定義為平台式）

## 12. 風險

| 風險 | 對策 |
|---|---|
| ~~天地盒量測比例理解錯誤~~（已解） | 量測表已完成＋法蘭確認（2026-07-08：一對天地、t=0.44 黑卡、內襯＋腰封構造）；殘餘細節由 x 向對帳＋樣張 gate 收口 |
| RTE girth 補償係數無前身 ground truth | 係數具名常數集中一處＋審核條款（§4.1）；t=0 錨定保證不破壞既有等價；樣張 gate 實摺驗證 |
| 內襯腳架深度是否墊高適中、四角讓位是否夠穩（2026-07-09 T7 gate 平台式重定義後的風險，取代舊翻邊咬合力疑慮） | 樣張 gate 實摺驗證；linerFlapDepth／linerFitGap 可調，底面與腳架深度隨之自動變 |
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

## 附錄 C：v1.1 → v1.2 修訂記錄（2026-07-08 Slice 2 brainstorming，法蘭六題定案）

**觸發**：Slice 1 完結（T9 gate 過）後法蘭兩個新需求——紙厚接線計算（step 0.1／default 0.3）、天地盒內襯參數化（重建內襯時發現的第三件）。

**Ground truth**：天地盒生產刀模逐線量測（`天地盒量測表.md`，coding-workspace 任務夾）＋法蘭確認：一對天地（下盒 124×179×60 厚壁平台款＋上蓋 151×216×45 薄壁款）、黑卡 t=0.44、內襯圍框填隙＋腰封固定。內襯原檔遺失已重建（`gen_liner.py`）。

**六題定案**（D11–D13）：①Slice 2 範圍＝幾何完整化 ②天地盒參數語意＝主面板 ③三件套＝pieces 分組 ④RTE＝標準補償集（t=0 錨定）⑤壁款＝每片 platformWidth ⑥上蓋放大＝單一等邊 lidMargin。

**修訂章節**：§2（D11–D13）、§3.3（DielinePiece／pieces 規則）、§4.1（thickness 補償集＋t=0 等價錨定）、§4.2（全重寫：構造定案／參數表／補償公式／內襯導出鏈／對帳驗收）、§8（等價 t=0、golden t=0.3、pieces 完整性、天地盒對帳）、§10（驗收 1–3 修訂）、§11（＋瓦楞域／y 向 1:1／非矩形內襯三條 non-goal）、§12（風險表更新）。

**Codex spec review（v1.2 輪，12 findings 全收）**：1 BLOCKING＝§8/§10 殘留舊對帳表述與 §4.2 分層條款衝突→改引用；7 SERIOUS＝y 向「不對帳」措辭過寬（改為只放絕對值、序列與公式照驗）、內襯 golden 混用生產 y 向（改導出鏈自產）、對帳槽位可被湊值（改具名槽位 fixture）、天地盒參數缺範圍（補 min/max/step＋`liner-flange-fits` 不變式，翻邊解析式＝margin−4t−2×fitGap）、pieces 完整性補強（id 唯一/非空/bounds hull）、pieces 語意歸屬（`pieces-identity` 不變式防 lid/base 對調）、derivedDefault auto/manual 狀態（引 §3.3 機制＋UI 驗收）；4 MINOR＝girth 四面起算序＋校驗值、fitGap 扣兩次語意註明、linerEnabled=false 預期補進 §10、t=0 雙 crease collapse 單線。
