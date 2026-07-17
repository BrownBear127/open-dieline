<!--
Vendored internal draft
Vendor date: 2026-07-17
-->

# Copy Inventory 擴充——Tier B 逐 key 明細 + mock 作廢清單

> 2026-07-16 M2 前置 B1：B5 佔位符正規化（dotted→平面名·巢狀註記抽 key）·句面文字不變·授權
> 2026-07-16 M2 T0：§B5 追加 2 個簽核新 key（`imp.cut.formula`／`imp.stats.footprint`·簽核
> 2026-07-16·EN 經產業術語對照）·B5=22·Tier B 合計 102
> 原料：`p2-m05-string-audit.md`（208 條編號＋16 條 S1-S5·2026-07-16 @ce72d7e）
> ＋現行 `copy-inventory.md`（§A 命名慣例）＋凍結 mock `tool-chrome-mock.html`
> 純機械整理：zh 逐字抄 audit，不創作不改寫。模板變數統一寫 `{expr}` 形（`{expr}` 內
> 直接保留原始 JS 表達式，含 `.toFixed()` 等呼叫，故不另立「原始表達式」備註欄）。

---

## 節 1：Tier B 逐 key 明細（取代現行 §B 的 B1-B7 摘要）

**節首計數**：B1=29（27 desc＋2 meta intro）／B2=24（audit 逐分支重數：RTE 6 own key＋
telescope 15 own key＋3 條 inv.common 合併 key；`pieces-valid` 為動態委派不佔號，另列說明）
／B3=8／B4=2／B5=20（含新補 `imp.footprint` 與 5 條欄位錯誤，較舊摘要「×12」多出，
因舊摘要漏了 `imp.footprint` 且未拆計 `imp.err.internal/.default` 與 `imp.sub.*`/`imp.per.*`
的雙詞獨立 key）／B6=8／B7=9。**Tier B 合計 100 key**（29+24+8+2+20+8+9）。
（2026-07-16 M2 T0 追加：B5=20＋2＝22（M2 簽核新 key·見 §B5 追加表）→ Tier B 合計 102。）

### B1 參數 description ×27 ＋ meta.intro ×2（audit §7a/§8a/§7c/§8d）

承載＝BoxModule LocalizedText 的 `description.zh`／`meta.intro.zh`。

#### RTE（`rte.param.{key}.desc` ×12）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| rte.param.L.desc | 成品的長邊內尺寸，決定前後兩片面板（P1、P3）的寬度，是整體外觀比例的主要來源。 | #39 | |
| rte.param.W.desc | 成品的短邊內尺寸，決定左右兩片側板（P2、P4）的寬度；同一個數字也決定上下蓋板要多高才能完全蓋住開口——蓋板高＝W。 | #40 | |
| rte.param.D.desc | 盒身的高度（開口到底部的距離），決定四片主面板與所有直向摺線的長度。 | #41 | |
| rte.param.thickness.desc | 紙張厚度（caliper）。盒身面板依摺次遞增補償、插舌與讓位間隙隨之調整；設 0 可還原無補償的幾何。 | #42 | |
| rte.param.tuckDepth.desc | 插舌伸進盒身的深度，決定上蓋抗拉開的力道。 | #43 | |
| rte.param.tuckRadius.desc | 插舌前緣兩個尖角的導圓半徑；設為 0 時插舌會變成直角矩形（前身在此有明確的兩分支：大於 0 走圓弧、等於 0 走直線）。 | #44 | |
| rte.param.tuckClearance.desc | 插舌左右兩側相對蓋板邊緣往內縮的量，讓插舌略窄於開口寬度，插入時才不會卡死。 | #45 | |
| rte.param.tuckLock.desc | 蓋板摺線中央摩擦扣凸起的寬度；設為 0 會停用摩擦扣，摺線退化回一條完整直線（無凸起卡榫）。 | #46 | |
| rte.param.dustFlapDepth.desc | 左右防塵翼向內摺入的深度，摺入後蓋住開口內側縫隙，阻擋灰塵與透光。 | #47 | |
| rte.param.flapNotch.desc | 防塵翼根部 J 型避讓槽的開口寬度，切開摺線交會處的應力集中點，避免摺紙時把紙纖維撕裂。 | #48 | |
| rte.param.creaseRelief.desc | 與避讓槽寬取兩者較大值，共同決定避讓槽的實際尺寸——這裡預留材料摺疊時需要的額外間隙（材質愈厚，摺線愈需要避讓空間）。 | #49 | |
| rte.param.glueSize.desc | 糊邊（耳仔）的寬度，是黏合面板首尾兩端、把展開圖捲成筒狀盒身所需的多餘寬度。 | #50 | |
| rte.param.glueSide.desc | 糊邊黏貼在整排面板的左側或右側（前身 glueOnRight 布林旗標在此改為 enum）；只影響版面鏡像方向，不影響盒子本身結構。 | #51 | |

#### Telescope（`tel.param.{key}.desc` ×15）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| tel.param.baseLength.desc | 下盒主面板長邊尺寸（製造尺寸，與生產刀模直接對帳）；同時決定上蓋面板長邊（＋2×上蓋放大量）與內襯墊片底面長邊的套合基準（內襯現在錨定下盒內淨，見 linerFitGap）。 | #65 | |
| tel.param.baseWidth.desc | 下盒主面板短邊尺寸；同時決定上蓋面板短邊（＋2×上蓋放大量）與內襯墊片底面短邊的套合基準。 | #66 | |
| tel.param.baseHeight.desc | 下盒後摺壁的名義全高；先摺壁（左右壁）另再減一個壁頂平齊補償量（wallTopCompensation）做「頂緣平齊」修正，讓四片牆摺起後頂緣切齊（Slice 5 F3 解耦：此修正原讀紙厚，現改讀獨立參數）。內襯墊片的腳架深度（linerFlapDepth）不得超過此值，否則內襯會頂出盒口（見 liner-flap-fits 警告）。 | #67 | |
| tel.param.lidMarginX.desc | 上蓋面板短向（對應 baseWidth／x 向先摺壁）相對下盒的等邊放大量——決定上蓋短向能套住下盒多深。Slice 5 F1：原單一 lidMargin 拆兩軸，取消 y 向測試豁免後兩軸皆為可獨立覆蓋的一般參數（無 derivedDefault）。（2026-07-09 T7 gate 重定義：內襯不再錨定上蓋，此參數與內襯幾何無關——見 linerFlapDepth。） | #68 | |
| tel.param.lidMarginY.desc | 上蓋面板長向（對應 baseLength／y 向後摺壁）相對下盒的等邊放大量。與 lidMarginX 各自獨立（Slice 5 F1：生產刀模長短向放大量本不相等 13.5≠18.5，拆分後才能逐線復刻；取消 y 向測試豁免）。 | #69 | |
| tel.param.lidHeight.desc | 上蓋後摺壁的名義全高；B-06（Slice 5 F3）：上蓋左右壁的頂緣平齊特例已移除，四面外壁恆等高（不吃 wallTopCompensation，不再有「−1 個紙厚」修正）。 | #70 | |
| tel.param.basePlatformWidth.desc | 下盒壁頂平台寬度；設 0＝薄壁單線反折（配弧形讓位角撐），大於 0＝厚壁平台（配 45° 斜角撐）。角撐款式跟隨這個值自動切換，不是獨立開關。 | #71 | |
| tel.param.lidPlatformWidth.desc | 上蓋壁頂平台寬度（生產品為薄壁單線反折，預設 0）。設 0 且壁高偏低時，薄壁角撐的讓位槽會擠壓變形，見 gusset-b-fits 警告。 | #72 | |
| tel.param.thickness.desc | 紙張厚度（caliper）。驅動內襯套合間隙（linerFitGap 換算）與角撐對角線位置（reach＝壁高－紙厚）。Slice 5 F3 解耦（audit A-01）：不再直接驅動壁根雙摺線間距與內外壁差，改由 rootJog／innerWallReduction／wallTopCompensation 三個獨立參數負責——設 0 不會讓這三處補償跟著歸零，見各自的參數說明。 | #73 | |
| tel.param.rootJog.desc | 後摺壁（y 向）壁根雙摺線之間的間距——與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。設 0 時雙摺線 collapse 為單一 crease（不論紙厚是否為 0）。Slice 5 T2 起這個位移量會進一步變成壁根階梯 stagger 的 jog 幅度，本階段（T1）幾何形狀仍是現行雙摺線，只有數值來源改讀這個參數。 | #74 | |
| tel.param.innerWallReduction.desc | 牆的內壁（面向盒內、舌摺線起點）相對外壁的縮減量——內壁＝外壁－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀 2×紙厚）。base／lid、x 向／y 向四面牆共用同一個值。 | #75 | |
| tel.param.wallTopCompensation.desc | 下盒左右外壁（先摺壁）的頂緣平齊修正量——外壁＝下盒壁高－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。只影響下盒：上蓋左右壁的平齊特例已移除（B-06），四面外壁恆＝壁高，不吃這個補償。 | #76 | |
| tel.param.linerEnabled.desc | 是否產生內襯墊片（2026-07-09 T7 gate 反饋重定義：平台式腳架墊片，放進下盒貼底、把物品墊高）。關閉時只輸出上蓋／下盒兩片，套合與定位需另外自理（如緊配或腰封）。 | #77 | |
| tel.param.linerFitGap.desc | 內襯底面對下盒內淨，四邊各留一次的套合間隙（2026-07-09 T7 gate 重定義：內襯改為平台式、底面錨定下盒內淨，此間隙只扣一次，不再是舊圍框版「上蓋一次＋下盒一次」的雙重扣）；愈大底面愈小、內襯愈鬆好放入。 | #78 | |
| tel.param.linerFlapDepth.desc | 內襯四翼向下摺的深度＝腳架高度，也就是物品被墊高的量（2026-07-09 T7 gate 反饋新增：平台式內襯重定義，維護者提供正確形式）。太深會頂出下盒盒口（見 liner-flap-fits 警告），太深也可能讓翼片外緣反轉（同一警告的另一條件）。 | #79 | |

#### meta.intro（B1 補·review 抓的漏項）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| rte.meta.intro | 前後左右四片面板一字排開展開的盒型；上下蓋板各以插舌卡入摩擦扣固定開口，兩側防塵翼摺入遮擋縫隙，免膠帶封口。 | #64 | 現行 §A6 只收 `rte.meta.name`，未收 intro |
| tel.meta.intro | 上蓋與下盒共用同一套免膠雙壁 tray 拓撲、上蓋依長短向分別放大套住下盒（Slice 5 F1：lidMarginX／lidMarginY 兩軸獨立，不再是單一等邊放大量）；內襯墊片放進下盒貼底，四翼向下摺成腳架把物品墊高（2026-07-09 T7 gate 反饋重定義：平台式，取代舊圍框版）。 | #103 | 同上 |

---

### B2 invariant message ×24（audit §7b/§8c；逐分支列）

命名：`inv.rte.{id}`（分支加 `.b1/.b2`）、`inv.tel.{id}`（分支加 `.b1/.b2/.b3`）、
`no-nan`／`no-bleed`／`bounds-cover` 兩盒型逐字相同→合併 `inv.common.{id}` ×3。

**特殊委派**：`inv.tel.pieces-valid`（audit #83，Canvas.tsx 消費點）內容＝`{v.message}`
動態插入，字面值 100% 來自 B7（`core/pieces.ts` 9 條 check message）——**不獨立佔一個
Tier B key**，此處僅列記錄供對帳，實際文字見 B7。

#### RTE（`inv.rte.{id}`，6 key／9 audit 列，其中 3 列併入 common）

| key | zh（逐字／模板） | audit # |
|---|---|---|
| inv.rte.unfold-width | 展開總寬應為 {expected}mm（含邊距），實際為 {actual}mm | #54 |
| inv.rte.lid-equals-w | 蓋板側邊鉛直 cut 線應有 4 條（上蓋 2＋下蓋 2，長度皆＝W={w}mm），實際只找到 {lidSideCuts.length} 條 | #55 |
| inv.rte.tuck-lock-fits.b1 | 摩擦扣寬 {tuckLock}mm 超過蓋板可容納寬度 {lidWidth.toFixed(2)}mm（已計入 girth 補償），會切出面板外 | #56 |
| inv.rte.tuck-lock-fits.b2 | 摩擦扣寬 {tuckLock}mm 小於兩側導角總和 {2 * LOCK_CHAMFER}mm，卡榫梯形會反折自撞 | #57 |
| inv.rte.tuck-radius-clamped | 插舌圓角 {tuckRadius}mm 超過幾何上限 {limit.toFixed(2)}mm（受插舌深度/寬度限制，已計入 girth 補償），已鉗制繪製 | #61 |
| inv.rte.no-cut-self-intersection | cut 路徑偵測到自撞（線段真交叉），幾何已退化成無法裁切的翻折形狀 | #62 |

（#58/#59/#60 → 併入下方 `inv.common.*`）

#### Telescope（`inv.tel.{id}`，15 key／19 audit 列，其中 1 列委派 B7、3 列併入 common）

| key | zh（逐字／模板） | audit # |
|---|---|---|
| inv.tel.liner-flap-fits.b1 | 內襯底面尺寸（{frame.padL.toFixed(2)}×{frame.padW.toFixed(2)}mm）非正值，參數組合下底面幾何不存在 | #84 |
| inv.tel.liner-flap-fits.b2 | 內襯腳架深度 {linerFlapDepth}mm 超過下盒壁高 {baseHeight}mm，內襯會頂出盒口 | #85 |
| inv.tel.liner-flap-fits.b3 | 內襯腳架深度 {linerFlapDepth}mm 超過底面較短邊長 {minPadEdge.toFixed(2)}mm 的一半，翼片外緣已反轉自撞 | #86 |
| inv.tel.pieces-identity | {label} 主面板實測 {actual.toFixed(2)}mm 應為 {expected.toFixed(2)}mm（pieces 身分可能對調或算錯） | #87 |
| inv.tel.rim-flush.base | base 片先摺壁外壁高 {baseWalls.x.toFixed(3)}mm 應等於後摺壁 {baseWalls.y.toFixed(3)}mm − 壁頂平齊補償 {wallTopCompensation}mm | #88 |
| inv.tel.rim-flush.lid | lid 片先摺壁外壁高 {lidWalls.x.toFixed(3)}mm 應等於後摺壁 {lidWalls.y.toFixed(3)}mm（B-06：左右壁特例移除，四面外壁應等高） | #89 |
| inv.tel.gusset-b-fits | {platformKey}=0（薄壁角撐）時壁高 {height}mm 低於 {minH.toFixed(1)}mm，讓位槽幾何已擠壓變形 | #90 |
| inv.tel.tongue-flap-fits | {label}＝{edge}mm 低於插底舌讓位所需的最小邊長 {minEdge}mm，該側插底舌梯形已反轉自撞 | #91 |
| inv.tel.notch-reduced | 側壁雙 U-notch 放不下兩個，已退化為單一置中 notch（notch-reduced） | #92 |
| inv.tel.notch-omitted | U-notch 壁長不足 40mm，已全部省略（notch-omitted） | #93 |
| inv.tel.platform-corner-omitted | 平台端寬度低於 {PLATFORM_CORNER_MIN_WIDTH_MM}mm，角落圓角降級為直角（platform-corner-omitted） | #94 |
| inv.tel.gusset-relief-omitted | A 款角撐周邊複合 relief 鏈與 U-notch／壁界衝突，或壁高偏離校準值致鏈自身扭曲自撞，已整鏈省略（gusset-relief-omitted） | #95 |
| inv.tel.tongue-crease-shrunk | B 款舌根端段可用長度不足 nominal，已縮減（tongue-crease-shrunk） | #96 |
| inv.tel.tongue-crease-omitted | B 款舌根端段可用長度過短，已全省改 halfcut（tongue-crease-omitted） | #97 |
| inv.tel.relief-omitted | V relief 依附端段過短，已省略（relief-omitted） | #98 |

（#83 → 委派 B7；#99/#100/#101 → 併入下方 `inv.common.*`）

#### 共用（`inv.common.{id}` ×3·兩盒型逐字相同）

| key | zh（逐字） | audit # |
|---|---|---|
| inv.common.no-nan | 偵測到 NaN 座標 | #58／#99 |
| inv.common.no-bleed | 不應出現 bleed 線型路徑（v1 尚未支援） | #59／#100 |
| inv.common.bounds-cover | bounds 未完整涵蓋所有路徑的實際範圍 | #60／#101 |

---

### B3 modal 段落 ×8（audit #4-#12）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| modal.body.p1 | 一個印刷刀模（dieline）產生器——把包裝盒的結構知識做成可以調參數、可以列印試摺的工具。<br>幾何規則以真實生產刀模逆向量測校準。 | #4 | 原文含換行＋全形破折號，逐字抄 |
| modal.body.p2 | 目前為開發測試版，僅提供兩種盒型——反向插舌盒（RTE）與天地盒三件套（上蓋／下盒／平台式內襯），更多盒型陸續開發中。 | #5 | 「開發測試版」字樣隨規則 5 版本裁決連動修改（簽核點） |
| modal.body.p3 | 本專案是 Konvolut 的一部分——關於書、紙、印刷與收藏的實踐。原始碼在 GitHub，文字刊於 Substack。 | #6 | 含連結：`Konvolut`／`GitHub`／`Substack` 為連結文字，周邊中文＝「本專案是」「的一部分——關於書、紙、印刷與收藏的實踐。原始碼在」「，文字刊於」「。」；M1 起草需保留連結錨點結構 |
| modal.note.1 | ・產出的刀模僅供打樣與學習參考；量產前請務必實際打樣驗證（紙材、絲向、機台都會影響成品） | #8 | 項目符號「・」屬字面值一部分 |
| modal.note.2 | ・紙厚補償係數以特定紙材（黑卡 0.4mm 級）的生產經驗校準，其他紙材請自行試摺調整 | #9 | |
| modal.note.3 | ・所有計算與檔案處理皆在瀏覽器本地完成，匯入的刀模檔不會上傳到任何伺服器 | #10 | |
| modal.note.4 | ・畫布拖曳與校準以滑鼠操作設計，建議使用桌面瀏覽器 | #11 | |
| modal.note.5 | ・非商業使用授權（PolyForm Noncommercial 1.0.0）；商業使用及問題回報請聯繫：hello@konvolut.art | #12 | 含 email，不翻譯 |

---

### B4 說明長句 ×2

| key | zh（逐字） | audit # |
|---|---|---|
| layers.overlays.desc | 對照調參用——匯入生產刀模、校準比例後與生成層疊圖比對（特別是 R 角與細部結構）。 | #134 |
| export.manufacturing.title | 僅影響 SVG 匯出：solid／0.25 線寬／round cap-join，排除尺寸標註與文字（DXF 恆排除標註，不受此開關影響） | #25 |

---

### B5 拼版句子 ×20（audit §14/§15）

| key | zh（逐字／模板） | audit # | 備註 |
|---|---|---|---|
| imp.disclaimer | 以單件輪廓間距估算（單向收縮）；未計交錯、塞角、共刀、絲向及加工限制，不可直接作生產拼版。 | #161 | `DISCLAIMER_TEXT` 常量 |
| imp.sheet.working | 工作尺寸：{sheetW} × {sheetH} mm（可用區 {sheetUsableW} × {sheetUsableH} mm） | #162 | `workingSheetText()` 無裁切分支 |
| imp.sub.quarter | 四開子紙 | #163 | `subLabel` 三元之一（`cutV&&cutH`） |
| imp.sub.half | 半張子紙 | #163 | `subLabel` 三元之二 |
| imp.sheet.workingCut | 全紙 {sheetFullW} × {sheetFullH} mm，{subLabel} {sub} | #164 | `workingSheetText()` 有裁切分支，內嵌 `imp.sub.*` |
| imp.sheet.subSize | {sheetW} × {sheetH} mm（可用 {sheetUsableW} × {sheetUsableH} mm） | #164 | |
| imp.per.quarter | 每四開 | #165 | `directionCardText()` 有裁切分支之三元詞 1；完整句＝`{per} {count} 模 × {sectionsCount} ＝ {totalCount} 模` |
| imp.per.half | 每半張 | #165 | 三元詞 2 |
| imp.grid.formula | {cols} 列 × {rows} 行{fillSuffix} ＝ {count} 模 | #166 | `directionCardText()` 無裁切分支 |
| imp.grid.fillSuffix | ＋ 補 {fillCount} | #166 | |
| imp.spacing.rows | 行距輪廓收縮 | #167 | `spacingAxisLabel()` 三元之一（`axis==='rows'`） |
| imp.spacing.cols | 列距輪廓收縮 | #167 | 三元之二 |
| imp.footprint | 主格點 footprint {usedW} × {usedH} mm | #170 | **review 抓的漏項**，現行 §A5 未列 |
| imp.err.internal | 系統內部計算錯誤，請重新整理頁面；若持續發生請回報。 | #174 | `generalErrorMessage` internal 分支（與 `imp.err.field.internal` #183 不同語境不同 key） |
| imp.err.default | 計算發生錯誤，請確認輸入數值。 | #175 | `generalErrorMessage` 預設分支 |
| imp.err.field.notFinite | 請輸入有效數字 | #179 | `fieldErrorMessage('not-finite')` |
| imp.err.field.notPositive | 必須大於 0 | #180 | `fieldErrorMessage('not-positive')` |
| imp.err.field.belowMin | 不得小於 {MIN_GAP_MM}mm | #181 | `fieldErrorMessage('below-min')` |
| imp.err.field.outOfRange | 數值超出安全範圍 | #182 | `fieldErrorMessage('out-of-range')` |
| imp.err.field.internal | 內部計算錯誤 | #183 | `fieldErrorMessage('internal')` |

#### B5 追加——M2 簽核新 key ×2（2026-07-16·簽核·EN 經產業術語對照）

接線 blocker 補殼＋統計列標籤：`imp.cut.formula`＝裁切分支卡片句殼（zh 原硬編碼於
ImpositionResults.tsx `directionCardText()` 裁切分支、EN 無殼；「N-up」＝印刷業標準
計數詞·{per} 修飾語前掛＝裁決）；`imp.stats.footprint`＝統計列第二格標籤（維護者
裁決①·沿用已簽 `imp.footprint` 產品語彙「主格點／Footprint」·「image area」語義過寬棄用）。

| key | en | zh | 聲部 | 用途 |
|---|---|---|---|---|
| imp.cut.formula | {count} up {per} × {sections} = {totalCount} up | {per} {count} 模 × {sections} ＝ {totalCount} 模 | mono | 裁切分支卡片句殼（{per}＝`imp.per.quarter`／`imp.per.half` 之值） |
| imp.stats.footprint | Footprint | 主格點 | mono | 統計列第二格標籤（主格點佔用尺寸） |

---

### B6 overlay 解析警告 ×8（audit §13）

| key | zh（逐字／模板） | audit # | 備註 |
|---|---|---|---|
| ovl.warn.notImported | {key} ×{n} 未匯入 | #153 | `makeWarningCollector()` 預設格式；`{key}` 可能為 `<text>`/`<image>`/`<use>`/`<svg>`（未支援 tag）、或下兩條的 key 字串本身 |
| ovl.warn.pathIncomplete | path 資料不完整，部分內容 | #154 | 作為上一項 `{key}` 值使用的字串常量 |
| ovl.warn.rectRadius | rect 圓角（rx/ry） | #155 | 同上，`{key}` 值 |
| ovl.warn.transform | transform {name} 不支援，已忽略 ×{n} | #156 | `{name}` 為不支援的 transform 函式名（如 `skewX`），不翻 |
| ovl.warn.droppedSegments | {dropped} 個線段座標無法解析，已略過 | #157 | |
| ovl.warn.classStyle | {classStyleCount} 個元素帶 class/style 樣式，樣式不套用（全部視為刀線匯入） | #158 | |
| ovl.warn.parseFail | SVG 解析失敗：不是合法的 SVG 文件 | #159 | root 非 `<svg>` 或 parsererror |
| ovl.warn.parseFailMsg | SVG 解析失敗：{msg} | #160 | `{msg}` 為瀏覽器原生例外訊息（英文），**透傳不翻** |

---

### B7 pieces 檢核 ×9（audit §10）

規則 6：error-code 前綴保留（mono 聲部相容·debug 錨點），只翻中文說明部分。

| key | zh（逐字／模板，含 error-code 前綴） | audit # | 對應 check 函式 |
|---|---|---|---|
| inv.pieces.duplicate-piece-id | duplicate-piece-id: 片 id「{piece.id}」重複出現 | #116 | `checkUniqueIds` |
| inv.pieces.empty-piece | empty-piece: 片「{piece.id}」沒有任何 path/text 成員 | #117 | `checkNonEmpty` |
| inv.pieces.unknown-id | unknown-{kind}-id: 片「{piece.id}」引用了不存在的 {kind} id「{id}」 | #118 | `checkAssignment`（`kind`＝`path`／`text`） |
| inv.pieces.double-assigned | double-assigned-{kind}: {kind} id「{id}」同時被「{owner}」與「{piece.id}」兩片認領 | #119 | `checkAssignment` |
| inv.pieces.unassigned | unassigned-{kind}: {kind} id「{id}」未被任何片認領 | #120 | `checkAssignment` |
| inv.pieces.piece-bounds-mismatch | piece-bounds-mismatch: 片「{piece.id}」的 bounds 未涵蓋其成員的實際範圍 | #121 | `checkPieceBoundsCoverMembers` |
| inv.pieces.overlapping-pieces | overlapping-pieces: 片「{a.id}」與「{b.id}」的 bounds 重疊 | #122 | `checkNoOverlap` |
| inv.pieces.result-bounds-mismatch | result-bounds-mismatch: GenerateResult.bounds 與全片 bounds 聯集包絡不一致 | #123 | `checkResultBoundsMatchesHull` |
| inv.pieces.geometry-hull-mismatch | geometry-hull-mismatch: GenerateResult.bounds 與全幾何包絡不一致（宣告的 bounds 跟實際幾何脫節） | #124 | `checkResultBoundsMatchesGeometry` |

### B8 摺盒模式狀態文案 ×3（P3 M1 新增·2026-07-17 簽核）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| fold.unsupported | 此盒型尚未支援 3D 摺盒預覽。 | — | P3 M1 新增·無 audit 前身 |
| fold.webglUnavailable | 瀏覽器不支援 WebGL，無法顯示 3D 摺盒預覽。 | — | P3 M1 新增·無 audit 前身 |
| fold.loadFailed | 3D 摺盒預覽載入失敗，切換模式可重試。 | — | P3 M2 新增·2026-07-17 簽核 |

### B9 摺盒卡色短件 ×4（P3 M2 新增·2026-07-17 controller 提案·待 B5-final 追認）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| fold.card.label | 卡色 | — | production 三態切換標籤 |
| fold.card.white | 白 | — | production 配方名 |
| fold.card.kraft | 牛皮 | — | production 配方名 |
| fold.card.black | 黑 | — | production 配方名 |

### B10 摺盒圖稿短件 ×3（P3 M2 T2.6 新增·2026-07-17 controller 提案·待 B5-final 追認）

| key | zh（逐字） | audit # | 備註 |
|---|---|---|---|
| fold.art.label | 圖稿 | — | production 二態切換標籤 |
| fold.art.none | 無 | — | 素面紙張 |
| fold.art.sample | 範例 | — | 內建程序化範例稿 |

---

## 節 2：§A 補漏 key（review 抓的·併入 §A 用）

**節首計數**：4 條新 key 缺口＋1 條 zh 值訂正＋1 條 review-confirm（無需新 key）＝6 項。

| # | key／項目 | 值 | audit # | 類型 | 說明 |
|---|---|---|---|---|---|
| 1 | `param.reset.glyph` | ↺ | #33 | 缺 key（lock） | 現行 §A2 只收 `param.reset.title`（#31）＋`param.reset.aria`（#32），符號本身「↺」（jsx-text，非裝飾）未建 key |
| 2 | `overlay.unit.pt` / `.mm` / `.px` | pt／mm／px | #141 | 缺 key（lock·規格值） | 現行 `overlay.unit` 只收下拉的 label「Unit／單位」，選項本身（`{u}` 動態值）未建 key；三值皆為度量單位縮寫，非中文，lock 不翻 |
| 3 | `imp.placeholder.dash` | — | #168 | 缺 key（lock） | `direction===null` 時的佔位符，現行 §A5 未收錄 |
| 4 | `modal.title` | open-dieline | #3（部分） | 缺 key（待裁決） | Modal 標題行含兩段：version（已有 `modal.version` key）＋純文字「open-dieline」（無 em 斜體、非 wordmark 元件樣式）——現行 §A7 無對應 key。待裁決：新建獨立 key，或重用 `chrome.wordmark`（需確認樣式是否相容） |
| 5 | `overlay.select.title` zh 值訂正 | 現行：點選選中／取消選中此圖層（校準與重新置中的對象）<br>應為（audit 逐字）：**點擊**選中／取消選中此圖層（校準與重新置中的對象） | #142 | zh 逐字訂正 | 現行 inventory 誤植「點選」，來源碼原文為「點擊」（LayersPanel.tsx:281）；App.tsx 另一處校準提示（#105，Canvas.tsx）用的才是「點選」，兩處各自獨立、非同一 key，不應互相污染 |
| 6 | impositionIcons.tsx 內嵌數字「31」「25」「27」 | — | #36-38 | review-confirm（無需新 key） | 紙規圖示 SVG 內嵌的裝飾性簡碼數字，屬純數值（比照 §E「純數值模板不進字典」邏輯），與 `imp.sheet.preset.{i}` 的完整規格文字（`31"×43"` 等，#125-127）是不同的兩組字串；判定不需獨立字典 key，僅供 controller 確認此判斷 |

---

## 節 3：mock 作廢/差異字串完整清單

**節首計數**：全面掃描 mock 3 個 plate＋footer 後，共列出 **27 條**不一致（含 3 條已知＋
24 條新增，含 review 點名的 6 條全數涵蓋）。

| # | mock 字串（位置） | inventory 終稿（或「無對應=mock 示意」） | 處置 |
|---|---|---|---|
| 1 | `AI-compat stroke`（platebar .compat，Plate I） | `export.manufacturing` EN 終稿＝`Manufacturing stroke` | 作廢不回改（簽核裁決，見規則 3） |
| 2 | `Portrait <em>run</em>`（imp-card h4，Plate II） | `imp.card.0` 終稿＝`0° run` | 作廢不回改（旋轉語義非紙向，簽核裁決） |
| 3 | `Landscape <em>run</em>`（imp-card h4，Plate II） | `imp.card.90` 終稿＝`90° run` | 作廢不回改（同上） |
| 4 | `壓痕線`（.layer .label，Plate III zh，crease 圖層） | `layers.crease` zh 終稿＝`摺線` | 作廢不回改（簽核裁決，統一用「摺線」） |
| 5 | `Telescope — lid & base`（`<option>`，Plate I select，line 308） | `telescope.meta.name` EN 終稿＝`Telescope Box` | 作廢不回改 |
| 6 | `Telescope · lid & base`（readout，Plate II，line 415） | 同上＝`Telescope Box` | 作廢不回改；註：mock 自身此處與 #5 用不同標點（em-dash vs middot），兩處皆作廢 |
| 7 | `Dust flaps & slots`（group-collapsed label，Plate I，line 338） | `group.dustGlue` EN 終稿＝`Dust flaps & glue` | 作廢不回改 |
| 8 | `Glue flap`（group-collapsed label，Plate I，line 339） | 無對應=mock 示意 | RTE 實際只有 4 組（尺寸與材質／插舌與鎖扣／防塵翼與糊邊／折線避讓公差），糊邊已併入 `group.dustGlue`（防塵翼與糊邊）為同一組，非獨立第 5 組；mock 把「防塵翼」與「糊邊」拆成兩顆摺疊卡片是簡化示意，且遺漏「折線避讓公差」整組未顯示 |
| 9 | `0 imported`（sect-head mono，Overlays 小節，line 350） | 無對應=mock 示意 | 現行 §A2 無「已匯入疊圖張數」計數 key（有 `console.styles.count`／`console.params.count` 但無 overlay 版本）；是否比照補一個新 lock key 待 裁決 |
| 10 | `Import SVG`（btn，line 352） | `overlay.import` EN 終稿＝`Import production SVG` | 作廢不回改 |
| 11 | `Base tray`（sect-head label，Plate II 側欄，line 431） | 無對應=mock 示意 | `baseLength`/`baseWidth`/`baseHeight` 實際仍屬 `group.dimensions`（Dimensions & board／尺寸與材質），非獨立「Base tray」組；mock 為拼版模式側欄自創了不存在的分組名 |
| 12 | `Lid oversize`（group-collapsed label，line 448） | 無對應=mock 示意 | `lidMarginX`/`lidMarginY` 實際屬 `group.fit`（Fit／套合，2 參數）；mock 標「3 params ＋」對不上實際 2 個參數的分組 |
| 13 | `Platforms`（group-collapsed label，line 449） | 無對應=mock 示意 | `basePlatformWidth`/`lidPlatformWidth` 實際屬 `group.wallStyle`（Wall style／壁款） |
| 14 | `Full set`（imposition piece 選鈕，line 456） | 無對應=mock 示意 | audit 未見拼版模式「件」欄有合併「Full set」選項；telescope 多片盒型的「件」欄應為 base/lid/liner 逐片下拉（audit #187 動態），`imp.piece.whole`（整件）僅用於單片盒型（audit #186，pieces===undefined 時） |
| 15 | `B1 · 1092 × 787`（紙規按鈕，line 464） | 無對應=mock 示意 | 真實紙規值為 `imp.sheet.preset.{i}`＝`31"×43"`／`25"×35"`／`27"×39"`（`imposition.ts` `PAPER_PRESETS`），非 ISO B1 公制規格；mock 用了完全不存在於程式碼的紙規示例 |
| 16 | `V ½`（裁切按鈕，line 471） | `imp.halving.v` EN 終稿＝`Halve V` | 作廢不回改 |
| 17 | `H ½`（裁切按鈕，line 472） | `imp.halving.h` EN 終稿＝`Halve H` | 作廢不回改 |
| 18 | `Gripper`（imp-group k label，缺 `(mm)`，line 476） | `imp.gripper` EN 終稿＝`Gripper (mm)` | 作廢不回改（mock 把單位挪到旁邊獨立顯示的數值裡，非 label 本身的一部分） |
| 19 | `Gutter`（imp-group k label，缺 `(mm)`，line 480） | `imp.gutter` EN 終稿＝`Gutter (mm)` | 作廢不回改（同上） |
| 20 | `546 × 787 half sheet · grain long` / `787 × 546 half sheet · grain short`（imp-card .sub，lines 489/499） | 無對應=mock 示意 | 真實 `workingSheetText()`／`subLabel` 格式（B5 `imp.sheet.working`／`imp.sheet.workingCut`／`imp.sub.quarter`／`imp.sub.half`）完全不是這個句型；此為 mock 自創的簡化摘要行 |
| 21 | `Imposition · B1 half · V`（footer platebar status，line 513） | 無對應=mock 示意 | 沿用已作廢的「B1」紙規示例＋mock 自創格式，audit 無對應句型 |
| 22 | `Best · Portrait 8-up`（footer platebar status，line 514） | 無對應=mock 示意 | `Portrait` 已隨 #2 作廢；「8-up」格式亦不對應任何 B5 key |
| 23 | `Download report`（footer btn，line 517） | 無對應=mock 示意 | audit 全文未見任何「下載報告」功能或按鈕文字（ImpositionResults.tsx 只有拼版卡片＋SVG/DXF 匯出），疑似 mock 超前示意的未實作功能，需確認是否為真實需求或純示意 |
| 24 | `反插式尾封盒（RTE）`（`<option>`，Plate III zh，line 534） | `rte.meta.name` zh 終稿＝`反插式尾封盒 (Reverse Tuck End, RTE)` | 作廢不回改（mock 簡化省略英文全名，且用全形括號） |
| 25 | `天地盒（上蓋＋下盒）`（`<option>`，Plate III zh，line 535） | `telescope.meta.name` zh 終稿＝`天地盒 (Telescope Box)` | 作廢不回改（mock 內容完全不同，描述片名而非英文名） |
| 26 | `長度（L）`（param label，Plate III zh，全形括號，line 542） | `rte.param.L` zh 終稿＝`長度 (L)`（半形括號，逐字抄自原始碼） | 作廢不回改（全形／半形括號不一致） |
| 27 | `Generated`（sect-head mono，圖層小節，Plate III zh，line 554，維持英文未翻） | `layers.generated` zh 終稿＝`生成圖層`（inventory 裁決：EN 沿 mock「Generated」·zh 翻譯） | 作廢不回改（zh 對照頁尚未套用這條裁決，仍顯示英文原文） |
| 28 | `匯入 SVG`（btn，Plate III zh，line 560） | `overlay.import` zh 終稿＝`匯入生產 SVG` | 作廢不回改（mock 少了「生產」二字） |

**次要/待確認項（非文字內容錯誤，供 controller 參考，不列入上表 27 條主計數）：**

- `full set`（plate-label 內嵌小寫，line 365）vs `canvas.view.fullSet` 終稿 Title Case `Full set`——大小寫風格差異，可能是模板拼接時的刻意小寫（label 聲部語境），建議確認是否需統一。
- `aria-label="Zoom out"` / `"Zoom in"`（zoom 按鈕，lines 372-373）——audit 未記錄畫布縮放鈕的 aria-label，現行 inventory 也未建對應 key；可能是 mock 新增的 a11y 屬性，需確認是否要補 key，或維持沿用視覺字元本身（`canvas.zoom.in/out`）作為 aria 內容。
- SVG 內部裝飾文字（`Parametric RTE dieline` aria-label、`GRIPPER 12` SVG `<text>`）——純 mock 示意用假幾何的裝飾標籤，非真實工具會渲染的內容（真實工具畫真幾何，非示意矩形），不需字典 key。
- `plate-note`／`colophon` 章節的英文說明文字（"Plate I — Design mode · EN" 等）——文件自身的排版註記，非產品 UI 字串，不列入比對。

---

## 與 audit 逐條對帳（audit 1-208 ＋ S1-S5，共 224 條的去向）

| audit 範圍 | 去向 |
|---|---|
| #1-2 | §A（`modal.aria`／`modal.close`） |
| #3 | §A7（`modal.version`，version 部分）＋節2 gap #4（`modal.title`，純文字標題部分缺 key） |
| #4-6 | 節1 B3（`modal.body.p1-p3`） |
| #7 | §A（`modal.notes.title`） |
| #8-12 | 節1 B3（`modal.note.1-5`） |
| #13 | §A（`modal.begin`） |
| #14 | §E（S1，main.tsx，排除） |
| #15-23 | §A（`chrome.wordmark`／`chrome.about.title`／`chrome.about`／`chrome.resetAll.title`／`chrome.resetAll`／`chrome.modeSwitch.aria`／`mode.design`／`mode.imposition`／`console.boxStyle`） |
| #24 | §A6（動態，指向盒型 meta.name） |
| #25 | 節1 B4（`export.manufacturing.title`） |
| #26-28 | §A（`export.manufacturing`／`export.svg.scoped`／`export.svg`／`export.dxf.scoped`／`export.dxf`） |
| （檔名模板列，ExportBar） | §C（匯出凍結，boxId/pieceId lock 不翻） |
| #29 | 節1 B1（動態，指向 param description keys） |
| #30 | §A6（動態，指向 param label keys） |
| #31-32 | §A（`param.reset.title`／`param.reset.aria`） |
| #33 | 節2 gap #1（`param.reset.glyph`，缺 key） |
| #34 | §A6（`rte.option.left`／`.right`） |
| #35 | §A6（動態，指向 group.* keys） |
| #36-38 | 節2 gap #6（review-confirm，判定不需新 key） |
| #39-51 | §A6（label ×12＋group ×12 共用）＋節1 B1（desc ×12） |
| #52-53 | §A6（`rte.option.left`／`.right`，同 #34） |
| #54-62 | 節1 B2（RTE invariants：6 own key＋3 併入 `inv.common`） |
| #63 | §A6（`rte.meta.name`） |
| #64 | 節1 B1（`rte.meta.intro`，B1 補） |
| #65-79 | §A6（label ×15＋group ×15 共用）＋節1 B1（desc ×15） |
| #80-82 | §A6（`piece.base`／`.lid`／`.liner`） |
| #83 | 節1 B2 附註（`inv.tel.pieces-valid` 委派 B7，非獨立 key） |
| #84-98 | 節1 B2（telescope invariants ×15 own key） |
| #99-101 | 節1 B2（併入 `inv.common`，與 #58-60 同 3 key） |
| #102 | §A6（`telescope.meta.name`） |
| #103 | 節1 B1（`tel.meta.intro`，B1 補） |
| #104 | 動態（指向 B2 invariant messages，非獨立 key） |
| #105-109 | §A（`canvas.calibrate.hint`／`.lengthLabel`／`.unit`／`.confirm`／`.invalid`） |
| #110 | §A（`canvas.view.fullSet`） |
| #111 | §A6（動態，指向 piece.* labels） |
| #112,114 | §A（`canvas.zoom.in/out`，合併 lock key） |
| #113 | 純模板（`%` 數字，排除） |
| #115 | §A（`canvas.zoom.fit`） |
| #116-124 | 節1 B7（`inv.pieces.*` ×9） |
| #125-127 | §A（`imp.sheet.preset.{i}`） |
| #128-131 | §A（`layers.cut/crease/halfcut/dimensions`）＋§C（匯出凍結） |
| #132-140 | §A（`layers.halfcut.full`／`.title`／`.overlays.desc`〔實為節1 B4〕／`.generated`／`.disabled.title`／動態／`.overlays`／`overlay.import`／`overlay.unit`） |
| #134 | 節1 B4（`layers.overlays.desc`，長句） |
| #141 | 節2 gap #2（`overlay.unit.pt/mm/px`，缺 key） |
| #142 | §A（`overlay.select.title`）＋節2 gap #5（zh 值訂正：點擊→現行誤植點選） |
| #143 | 動態（`layer.name`＝使用者檔名，非字典字串，不需 key） |
| #144-146 | §A（`overlay.remove`／`.show`／`.opacity`） |
| #147 | 純模板（`%` 數字，排除） |
| #148-149 | §A（`overlay.calibrate.needSelect`／`.needVisible`／`overlay.calibrate`／`.calibrate.exit`） |
| #150 | 動態（指向 B6 overlay 警告 keys） |
| #151-152 | §A（`overlay.recenter.needSelect`／`overlay.recenter`） |
| #153-160 | 節1 B6（`ovl.warn.*` ×8） |
| #161-167 | 節1 B5（`imp.disclaimer`／`.sheet.working`／`.sub.quarter`／`.half`／`.sheet.workingCut`／`.per.quarter`／`.half`／`.grid.formula`／`.spacing.rows`／`.cols`） |
| #168 | 節2 gap #3（`imp.placeholder.dash`，缺 key） |
| #169 | §A（`imp.noFit`） |
| #170 | 節1 B5（`imp.footprint`，新增） |
| #171-173 | §A（`imp.preview.aria`／`.previewSimplified`／`err.selectPiece`） |
| #174-175 | 節1 B5（`imp.err.internal`／`.default`） |
| #176 | §A（`imp.card.0`／`imp.card.90`） |
| #177-178 | §A（`imp.orient.portrait`／`.landscape`） |
| #179-183 | 節1 B5（`imp.err.field.*` ×5） |
| #184-204 | §A（`imp.title` … `imp.gutter`，全數已存在，逐一核對通過） |
| #205-208 | §C／§E（動態模板殼／geometry-derived，非字典 key） |
| S1-S5（含子項，16 條） | §E（排除清單，開發期斷言，已在現行 §E 標註） |

**對帳結論：audit 208 條編號 ＋ 16 條 S1-S5 ＝ 224 條，100% 有明確去向**（§A 既有 key／
節1 Tier B key／節2 新補 key／§C 匯出凍結／§E 排除／純模板無需 key／動態委派其他 key），
無遺漏、無雙重計數衝突。唯一需要維護者/裁決的懸而未決項＝節2 的 6 條補漏＋節3
「無對應=mock 示意」類的數項（是否要新增 key 或維持純示意），其餘皆為機械歸類。
