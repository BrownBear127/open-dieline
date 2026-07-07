# open-dieline v1 — Design Spec

> 開源印刷刀模產生器。參數化生成盒型刀模（dieline），同時是一份「讓人看得懂盒型結構」的教材。
> 掛 trouver.art。License：PolyForm Noncommercial 1.0.0（歡迎學習改作，商業使用請洽談授權）。

- **日期**：2026-07-07
- **作者**：法蘭（product owner）＋ 小稜（architect）
- **前身**：`trouver.crm-rebuild/components/Tools/Packaging/`（2025 年底 Gemini 3.5 Pro 產物）——本 spec 是它的剝離重構。前身深度分析：coding-workspace `Coding Projets/research/2026/07/07-trouver-workshop-os-重新審視/`（agent 掃描報告節錄於附錄 A）。

---

## 1. Vision 與定位

**一句話**：打開網頁 → 選盒型 → 調參數 → 即時看刀模 → 匯出 SVG/DXF 給刀模廠。每個參數附「它在盒型結構上的意義」，工具本身就是印刷刀模的公開教材。

**三個受眾**：
1. 法蘭自己（印刷業務的日常刀模與拼版工具）
2. 想了解刀模知識的設計師／印刷同好（開源教育）
3. 未來的貢獻者（照「新增盒型」教學加自己的盒型）

**不是**：DAM、估價系統、通用向量編輯器。

## 2. 已定決策

| # | 決策 | 定案 |
|---|---|---|
| D1 | 形態 | 純前端靜態站（Vite + React + TypeScript，零後端），GitHub Pages 部署 |
| D2 | v1 盒型 | RTE（反插盒）移植 ＋ 天地盒（Telescope）參數化重寫 |
| D3 | 架構 | Schema-driven 插件：每盒型自帶 meta + paramSchema + generate |
| D4 | 專案名 | `open-dieline`，掛 trouver.art |
| D5 | License | PolyForm Noncommercial 1.0.0 全包；README 註明商用洽談 |
| D6 | SVG 匯入語意 | 生產刀模 1:1 overlay 對照（人眼比對調參），**不做** AI/自動逆向 |
| D7 | 匯出 | SVG ＋ DXF（R12），刀模廠兩者皆收 |
| D8 | UI | 沿用前身的流程與外觀（深色工程風、左參數欄＋右畫布），元件化重寫 |
| D9 | 範例資產 | 一律用本工具生成的刀模；法蘭的生產檔**不進 repo** |
| D10 | 語言 | v1 繁中先行；型別預留 `{ zh, en }`；README 繁中為主＋英文摘要 |

## 3. 架構

### 3.1 目錄結構

```
open-dieline/
├── src/
│   ├── core/                  # 幾何核心：純 TS、零 React 依賴、可獨立測試
│   │   ├── path.ts            # PathBuilder：M/L/A/C 輔助、座標精度統一（toFixed(2)）
│   │   ├── primitives.ts      # 可複用構件：摩擦扣、J-Hook 避讓槽、防塵翼倒角、尺寸標註線
│   │   ├── types.ts           # DielinePath / DielineText / GenerateResult / BoxModule / BoxParamDef
│   │   └── registry.ts        # 盒型註冊表（boxes/ 的模組在此註冊）
│   ├── boxes/                 # 盒型插件——一盒型一檔
│   │   ├── reverse-tuck-end.ts
│   │   └── telescope.ts
│   ├── export/
│   │   ├── svg.ts             # SVG 序列化——畫布渲染與下載共用此一來源
│   │   └── dxf.ts             # DXF R12 ASCII writer（LINE/ARC/POLYLINE，圖層分線型）
│   ├── overlay/
│   │   ├── import.ts          # SVG 檔解析（DOMParser）→ 線段集
│   │   └── calibrate.ts       # 單位換算（pt/mm/px）＋已知長度校準
│   ├── imposition/
│   │   └── layout.ts          # 拼版計算：紙張＋咬口＋間距 → 模數與排列
│   ├── ui/                    # React 層
│   │   ├── App.tsx
│   │   ├── ParamPanel.tsx     # 從 paramSchema 自動生成（含 hover 高亮聯動）
│   │   ├── Canvas.tsx         # pan/zoom（沿用前身手刻邏輯）＋ SVG 渲染
│   │   ├── OverlayControls.tsx
│   │   ├── PaperPanel.tsx     # 紙張預設＋拼版
│   │   └── ExportBar.tsx
│   └── content/               # 教育內容：每盒型的結構介紹（v1 為側欄短文）
├── tests/                     # vitest：幾何不變式＋golden 快照＋fixture 對照
├── public/examples/           # 生成的範例刀模
├── docs/specs/                # 本文件
├── LICENSE                    # PolyForm NC 1.0.0
├── README.md
└── .github/workflows/ci.yml  # test + build + Pages 部署
```

### 3.2 資料流（單向一條線）

```
ParamPanel（由 paramSchema 生成）
   → params state
   → registry.get(boxId).generate(params)
   → GenerateResult { paths, texts, bounds }
   → Canvas 渲染（SVG JSX）
   → ExportBar 匯出（svg.ts / dxf.ts 序列化同一份 GenerateResult）
```

Overlay 層與拼版預覽是畫布上的獨立顯示層，不進 GenerateResult、不進匯出。

### 3.3 核心型別契約

```ts
interface BoxParamDef {
  key: string;
  label: string;                     // v1 繁中；未來 { zh, en }
  unit: 'mm' | 'deg' | 'bool';
  default: number | boolean;
  min?: number; max?: number; step?: number;
  group: string;                     // 面板分組：尺寸／插舌／防塵翼／糊邊…
  description: string;               // 教育說明：此參數在盒型結構上的意義（一級公民）
  highlightTag?: string;             // hover 時高亮的幾何 tag
  derivedDefault?: (base: BaseDims) => number;  // 衍生預設，顯示與生成同源
}

interface GenerateResult {
  paths: DielinePath[];              // type: cut | crease | halfcut | bleed | annotation | dimension
  texts: DielineText[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

interface BoxModule {
  meta: { id: string; name: string; nameEn: string;
          intro: string;             // 盒型結構介紹（側欄教育內容）
          topology: 'linear' | 'cross' | string };
  params: BoxParamDef[];             // 每盒型只宣告自己的參數（無共用大袋子）
  invariants: BoxInvariant[];        // 幾何不變式（測試與 runtime 檢查共用）
  generate: (params: Record<string, number | boolean>) => GenerateResult;
}
```

設計重點：
- **`derivedDefault` 單一來源**——杜絕前身「UI 顯示 D×0.4、生成用 D×0.75」的雙套預設 bug 類型
- **參數宣告即接線**——盒型不得宣告 generate 未使用的參數（測試強制：每個 param key 必須影響輸出）；杜絕前身天地盒 7 個假旋鈕
- **`invariants` 一級公民**——盒型自帶幾何不變式（見 §8），測試跑、UI 也可即時警告（參數組合導致自相交時提示）

## 4. v1 盒型規格

### 4.1 RTE 反插盒（移植）

- 幾何邏輯自前身 `ReverseTuckEnd.ts` 移植（該檔為健康的參數化實作，見附錄 A）
- 移植時改造：具名化 3 個容差常數（糊邊導角 5mm、摩擦扣凸高 1.5mm、扣具導角 2mm）；上下週界的鏡像重複抽成共用函式；path helper 改用 `core/path.ts`
- 參數集（照前身平移）：L / W / D / 紙厚 / 插舌深度 / 插舌圓角 / 插舌內縮 / 摩擦扣寬 / 防塵翼深 / 避讓槽寬 / 折線避讓 / 糊邊寬 / 糊邊位置
- 每個參數補 `description`（教育說明）

### 4.2 天地盒（參數化重寫）

- **前身實作作廢**（硬編碼常數取代參數、Hook Tab 內建預設即自我重疊、雙套預設值——bug 清單見附錄 A），僅其「上蓋＋底座十字展開」的拓撲概念保留
- 重寫依據：法蘭的生產刀模 SVG（本地對照用，不進 repo）——先人工量測關鍵比例（蓋高、蓋身間隙、Hook Tab 尺寸與間距、捲邊深度、角部斜切）建立參數關係，再寫參數化 generate
- 參數全部真接線；Hook Tab 尺寸與間距均由參數推導並附不重疊不變式
- **驗收＝重現生產檔**：以生產 SVG 的量測尺寸為 fixture 數值對照 ＋ overlay 目測重合

## 5. Overlay 對照層

- 匯入：`<input type=file>` → DOMParser → 抽取 path/line/polyline/circle 線段集
- 單位校準：單位下拉（pt→mm ×0.3528／mm／px）＋「已知長度校準」（點選一段、輸入實際 mm、換算係數自動套用）
- 對齊：拖曳平移＋快速對齊（左上角／中心／邊界框）；縮放鎖定與生成層同比例（1:1）
- 顯示：overlay 全線段染洋紅、50% 透明度（可調滑桿）、可開關；生成層維持線型原色
- 用途定位（寫進 UI 說明）：對照調參用，特別是 R 角與細部結構

## 6. 匯出

### 6.1 SVG
- 與畫布共用 `export/svg.ts` 序列化（消滅前身「下載另一份手刻模板漏 halfcut 樣式」的漂移類 bug）
- 線色慣例：黑＝cut、綠（#00FF00）＝crease、黃（#FFFF00）＝halfcut（與業界及法蘭生產檔一致）
- `width/height` 以 mm 明示＋viewBox；尺寸標註線可選含／不含

### 6.2 DXF
- R12 ASCII、純 TS 手寫 writer、零依賴
- 圖層：`CUT` / `CREASE` / `HALFCUT`（刀模廠 CAD 慣例）
- 直線→LINE；圓弧→ARC；貝茲曲線（J-Hook 避讓槽）離散為 POLYLINE，弦高誤差 ≤0.1mm
- 檔名自動：`{盒型id}-{L}x{W}x{D}.dxf`

## 7. 拼版（imposition）

- 紙張預設：31"×43"（787×1092）、25"×35"（635×889）、70×100cm＋自訂
- 輸入：紙張尺寸、咬口（gripper，印刷機夾紙側單邊預留，預設 10mm）、四周邊距、模間距
- 計算：正放與旋轉 90° 兩種方向的 N×M 組合 → 回報最優模數與方向
- 預覽：畫布上以淡色陣列顯示排列
- v1 為矩形邊界框拼版（以刀模 bounds 計）；異形交錯拼版（nesting）為 Non-goal

## 8. 測試策略

| 層 | 工具 | 內容 |
|---|---|---|
| 幾何不變式 | vitest | 每盒型宣告：展開總寬＝Σ面板＋糊邊、蓋板高＝W（RTE）、Hook Tab 相鄰不重疊（天地盒）、全 path 無 NaN、bounds 涵蓋所有 path |
| 假旋鈕防範 | vitest | 對每個 param key：改變值必須改變 generate 輸出（宣告即接線） |
| Golden 快照 | vitest | 每盒型固定參數組 → paths 資料快照（非 SVG 字串，避免序列化噪音） |
| 天地盒 fixture | vitest | 生產 SVG 人工量測的關鍵尺寸值對照生成輸出（量測數值＝盒型比例知識，可進 repo；生產 SVG 檔案本身不進） |
| DXF | vitest | 產出可解析（實體計數、圖層歸屬）、弦高誤差抽驗 |
| 拼版 | vitest | 已知案例對照（含法蘭歷史估價中的實際拼版數） |
| UI | vitest + testing-library | 冒煙：選盒型→調參→畫布更新→匯出觸發 |

## 9. 開源配套

- **README**：定位、線上 demo（Pages 連結）、盒型知識索引、快速開始、**「如何新增一個盒型」教學**（貢獻指南＝教材）、License 說明＋「商業使用請聯繫 trouver.art 洽談授權」
- **CI**（GitHub Actions）：PR 跑 test＋build；main 推送自動部署 GitHub Pages
- **repo 位置**：本地 `~/projects/open-dieline`；remote 由法蘭提供 trouver.art 帳號後掛
- 教育內容 v1 形式：每盒型 `meta.intro`（側欄）＋參數 `description`（hover）；獨立知識頁為 v1.1+

## 10. 驗收條件（可驗證）

1. `npm run dev` 起站：選 RTE／天地盒，調任一參數畫布即時更新，hover 參數高亮對應幾何
2. RTE 以預設參數生成的刀模與前身輸出幾何等價（golden 對照，容差 0.01mm）
3. 天地盒以生產檔量測參數生成 → overlay 疊生產 SVG 目測重合，fixture 數值對照全過；**預設參數下所有不變式通過（無自我重疊）**
4. SVG 匯出：檔案內含 cut/crease/halfcut 三線型樣式且與畫布一致；DXF 匯出：LibreCAD 或線上 viewer 開啟可見三圖層
5. Overlay：匯入任一 AI 匯出 SVG（pt 單位）→ 校準後與生成層 1:1 疊圖，透明度可調
6. 拼版：對至少 2 個歷史真實案例（如 31"×43" 拼 27）算出相同或更優模數
7. 全部測試綠、CI 通過、Pages 部署可公開訪問
8. 假旋鈕測試：每個宣告參數都影響輸出
9. README 完整（含新增盒型教學與商用條款說明）

## 11. Non-goals（v1 明確不做）

- ❌ AI／自動逆向 SVG 成參數化盒型（人眼 overlay 對照即可，前身實證 AI 讀刀模不可靠）
- ❌ 異形交錯拼版（nesting）——v1 僅矩形邊界框
- ❌ 3D 摺疊預覽（列 v2 候選）
- ❌ 出血自動生成（`bleed` 線型保留於型別，實作延後）
- ❌ 專案存檔／分享連結（URL 參數序列化列 v1.1 候選）
- ❌ 多語 UI（型別預留，v1 繁中）
- ❌ PWA／離線（靜態站已可 file:// 級使用）
- ❌ 前身 crm-rebuild 的任何其他模組遷移

## 12. 風險

| 風險 | 對策 |
|---|---|
| 天地盒生產 SVG 量測比例理解錯誤 | 量測結果先做成對照表給法蘭確認再寫 generate；overlay 目測為最終閘 |
| DXF 在刀模廠 CAD 的相容性 | R12 是最保守通用格式；交付前法蘭拿真實廠商流程驗一次 |
| 開源後生產檔誤入 repo | 生產 SVG 一律放 repo 外的本地 `~/dieline-refs/`；`.gitignore` 防呆＋review 檢查 |
| 前身 UI 手刻 pan/zoom 移植後手感差異 | 樣張 gate：UI 先出可互動版本給法蘭實際操作核可 |

---

## 附錄 A：前身分析摘要（2026-07-07 agent 深掃）

- **RTE（357 行）**：健康——座標全參數推導、helper 抽象正確、僅 3 個合理容差常數。移植對象。
- **天地盒（505 行）**：作廢——Hook Tab 高度寫死 30mm 而間距 W/4（預設即重疊 54%）；宣告 7 參數僅讀 2 個，餘被 `hookW=50` 等硬編碼取代；`glueSize`/`thickness` 收了沒用；UI 顯示預設（D×0.4）與生成預設（D×0.75）兩套；generateLid/generateBase 重複 helper、手動鏡像複製。
- **UI（691 行單檔）**：pan/zoom 手刻可用、耦合極輕（僅 4 個純展示元件）、11 個死 import；下載 SVG 與畫布為兩條平行手刻序列化（已漂移：漏 halfcut 樣式）。
- **types**：`DielinePath`/`BoxModel` 契約健康；`BoxDimensions` 為跨盒型參數聯集大袋子。
- **參考 SVG**（天地盒＋雙蓋盒）：AI 30.1 匯出、流水號線段無語意分組、無文字標註、無單位標示；色碼黑/綠/黃與本 spec 慣例一致。雙蓋盒為未動工原料（v1.1 候選盒型）。
