<!--
Vendored internal draft
Vendor date: 2026-07-17
-->

# Copy Inventory（D10·M0.5 簽核 artifact）

> 2026-07-16 M2 視覺簽核輪修訂（裁決·原話「中文的盒型僅顯示中文名稱例如：反插式
> 尾封盒、天地盒」）：§A6 兩盒型 zh 名去英文附註——`rte.meta.name` zh＝`反插式尾封盒`、
> `telescope.meta.name` zh＝`天地盒`。EN 不動。inventory-expansion 節3 #24/#25 引述的
> 舊終稿值同步失效（該兩列為 audit 對帳紀錄·不回改·以本表為準）。
> 同輪追加：§A3 新 key `canvas.view.piece`＝`{label} view`／`{label}視圖`（plate label
> 單片視圖句殼·三案對照選 A·2026-07-16）——補 M1 佈線期 `${label.en} view` 硬編碼
> 的簽核殼；{content} 隨語言契約自此三處（盒名/片名/檢核訊息）全接。
> 狀態：**v1.1**——v1 簽核（2026-07-16·7 點全過）＋二輪 review 修訂（C1 逐
> key 化）。本表＋**規範性附件 `inventory-expansion.md`**（Tier B **99** key 逐 key 明細·
> §A 補漏·mock 作廢清單 28 條·audit 224 條對帳 100%）合為**文案唯一真相源**；
> A15 gate 對兩檔聯集驗。與 typography matrix 衝突時本表管文案、matrix 管字體。
> 原料：`p2-m05-string-audit.md`（audit @ce72d7e）
> EN 預設語言（D2）；zh＝現值逐字；**Tier B EN＝M0.6 review 起草→複核→回寫附件
> →抽查**（readiness：文案裁決不留實作 task）

## 規則（先簽這節）

1. **Tier A**＝chrome＋短 label：EN 終稿在本表（簽核即凍結）。
   **Tier B**＝長文（參數 description ×27、invariant message ×23、modal 段落、
   overlay/拼版句子）：本表收 key＋zh＋lock 裁決，EN 由 M1 起草後回寫。
2. **structural-lock 判準**：①D 核心隱喻詞（plate/instrument/folio 家族）②儀器讀數
   （No./FIT/百分比/規格型號）③品牌聲部（wordmark/by Konvolut）→ lock（無 zh 形態）。
   功能控制與說明→翻譯。
3. **⚠ 匯出凍結 4 key**：`GENERATED_LAYER_LABEL`（切割線/摺線/半刀/尺寸標註）被
   `export/svg.ts:120` 寫進 SVG `<g data-name>`＝**A2 基線 bytes 的一部分**。
   實作鐵則：原常數凍結不動（匯出續讀）；UI 顯示改讀 i18n 字典新 key（`layers.cut`
   等）。動原常數＝A2 破。
4. **排除 i18n**（§E）：16 條 throw Error（開發期斷言·無 Error Boundary·僅達 console）
   ＋純數值模板（`N%`、檔名模板——檔名用 ascii boxId/pieceId，**不隨語言變**）。
5. **版本字樣（已簽核·2026-07-16）**：版本號動態注入 `import pkg from
   '../../package.json'`（自 `src/ui/` 起算的正確相對路徑——I4 修正原稿 `../` 會
   解析到不存在的 src/package.json）＋測試斷言畫面版本===package version；
   「開發測試版」字樣刪 → EN=`v{version}`。
6. **error-code 前綴**（`duplicate-piece-id:` 等 9 條）：保留前綴（mono 聲部相容·
   debug 錨點），僅中文說明部分進翻譯。

## §A Tier A——chrome 與短 label（EN 終稿·簽核即凍結）

### A1 全域 chrome（新 D 語彙件·來源=凍結 mock；zh 為新增翻譯）

| key | EN（終稿） | zh | lock | 聲部 | 承載 |
|-----|-----------|-----|------|------|------|
| chrome.wordmark | Open *Dieline* | — | ✅ | display | dict |
| chrome.folio | The instrument — by Konvolut | — | ✅ | mono | dict |
| chrome.lang | EN · 中文 | —（自身即雙語） | ✅ | mono | dict |
| chrome.mode | Mode | — | ✅ | label | dict |
| mode.design | Design | 刀模設計 | | label | dict |
| mode.imposition | Imposition | 拼版估算 | | label | dict |
| chrome.about | About | 關於 | | label | dict |
| chrome.about.title | Reopen the project introduction | 重新開啟專案介紹 | | — | dict |
| chrome.resetAll | Reset all | 重設全部 | | label | dict |
| chrome.resetAll.title | Clear all overrides, back to defaults | 清除全部參數覆寫，回到預設值 | | — | dict |
| chrome.modeSwitch.aria | Mode switch | 模式切換 | | — | dict |

（mode.design/imposition 的 EN 顯示形＝label 聲部 uppercase 由 CSS 管，字典存 Title case。）

### A2 console 側欄

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| console.boxStyle | Box style | 盒型 | | label |
| console.styles.count | {n} styles | — | ✅（讀數） | mono |
| console.group.no | No. {nn} | — | ✅ | mono |
| console.params.count | {n} params ＋ | — | ✅ | mono |
| param.reset.title | Reset to default | 重設為預設值 | | — |
| param.reset.aria | Reset “{label}” to default | 重設「{label}」為預設值 | | — |
| layers.title | Layers | 圖層 | | label |
| layers.generated | Generated | 生成圖層 | ⚠ 半lock：EN 沿 mock「Generated」·zh 翻 | mono |
| layers.cut | Cut | 切割線 | | mono |
| layers.crease | Crease | 摺線 | | mono |
| layers.halfcut | Half-cut | 半刀 | | mono |
| layers.dimensions | Dimensions | 尺寸標註 | | mono |
| layers.halfcut.full | half-cut lines | 半刀線 | | —（disabled title 用） |
| layers.disabled.title | This box style has no {layer} | 此盒型無{layer} | | — |
| layers.overlays | Overlays | 對照圖層 | | label |
| layers.overlays.desc | — Tier B（§B4） | 對照調參用——匯入生產刀模…（audit #134） | | body |
| overlay.import | Import production SVG | 匯入生產 SVG | | label |
| overlay.unit | Unit | 單位 | | mono |
| overlay.show | Show overlay | 顯示疊圖 | | mono |
| overlay.opacity | Opacity | 透明度 | | mono |
| overlay.remove | Remove | 刪除 | | label |
| overlay.select.title | Select / deselect this layer (target for calibrate & recenter) | 點選選中／取消選中此圖層（校準與重新置中的對象） | | — |
| overlay.calibrate | Calibrate | 校準 | | label |
| overlay.calibrate.exit | Exit calibration | 取消校準 | | label |
| overlay.calibrate.needSelect | Select a layer first | 先選取此圖層 | | — |
| overlay.calibrate.needVisible | Turn on “Show overlay” first | 先開啟顯示疊圖 | | — |
| overlay.recenter | Recenter | 重新置中 | | label |
| overlay.recenter.needSelect | Select a layer first | 先選取一個圖層 | | — |

### A3 畫布 chrome

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| canvas.plateLabel | Plate Nº {nn} — {content} | 骨架 lock·{content}=盒型/視圖名隨語言 | ✅骨架 | mono |
| canvas.view.piece | {label} view | {label}視圖 | | mono |
| canvas.view.fullSet | Full set | 全版 | | label |
| canvas.legend.cut | Cut | 切割 | | mono |
| canvas.legend.crease | Crease | 壓痕 | ⚠ 與 layers.crease「摺線」異詞：**裁決=統一用「摺線」**（沿現行 app·mock zh plate 的「壓痕線」作廢） | mono |
| canvas.zoom.fit | Fit | — | ✅ | mono |
| canvas.zoom.in/out | ＋／− | — | ✅ | mono |
| canvas.checks | Checks · {p} pass · {f} fail | — | ✅（讀數） | mono |
| canvas.calibrate.hint | Click a segment of known length on the overlay (Esc to cancel) | 點選 overlay 上一段已知長度的線（Esc 取消校準） | | mono |
| canvas.calibrate.lengthLabel | Actual length of this segment: | 該線段實際長度： | | mono |
| canvas.calibrate.unit | mm | mm | ✅ | mono |
| canvas.calibrate.confirm | Confirm | 確認 | | label |
| canvas.calibrate.invalid | Enter a number greater than 0 | 請輸入大於 0 的數字 | | mono |

### A4 plate 匯出列

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| plate.status.plate | Plate | — | ✅ | mono |
| plate.status.blank | Blank | — | ✅ | mono |
| plate.status.scale | Scale · 1 : 1 mm | — | ✅ | mono |
| export.manufacturing | Manufacturing stroke | 製造模式 | ⚠ mock「AI-compat stroke」作廢（本表終裁·與 API `manufacturing` 語義對齊） | mono |
| export.manufacturing.title | — Tier B（§B4·現行 title 長句） | 僅影響 SVG 匯出：…（audit #25） | | — |
| export.svg | Download SVG | 下載 SVG | | label |
| export.svg.scoped | Export current view | 匯出目前視圖 | | label |
| export.dxf | Download DXF | 下載 DXF | | label |
| export.dxf.scoped | Export current view (DXF) | 匯出目前視圖（DXF） | | label |

### A5 拼版模式

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| imp.title | Imposition | 拼版設定 | | label |
| imp.piece | Piece | 件 | | mono |
| imp.piece.whole | Whole piece | 整件 | | label |
| imp.sheet | Sheet | 紙規 | | mono |
| imp.sheet.preset.{i} | 31"×43"／25"×35"／27"×39" | — | ✅（規格） | label |
| imp.sheet.custom | Custom | 自訂 | | label |
| imp.sheet.w / .h | W (mm)／H (mm) | W (mm)／H (mm) | ✅ | mono |
| imp.orient | Orientation | 方向 | | mono |
| imp.orient.portrait | Portrait | 直放 | | label |
| imp.orient.landscape | Landscape | 橫放 | | label |
| imp.halving | Halving | 裁切 | | mono |
| imp.halving.v / .h | Halve V／Halve H | 對開 V／對開 H | | label |
| imp.rotate | Rotation | 旋轉 | | mono |
| imp.rotate.allow | Allow 90° | 可轉 90° | | label |
| imp.gripper | Gripper (mm) | 咬口 (mm) | | mono |
| imp.gutter | Gutter (mm) | 刀線間距 (mm) | | mono |
| imp.card.0 | 0° run | 0° | ⚠ mock「Portrait run」作廢——現行卡=0°/90°（旋轉語義非紙向），EN 取「0° run／90° run」 | display |
| imp.card.90 | 90° run | 90° | 同上 | display |
| imp.best | ◆ Best yield | ◆ 最佳排法 | | mono |
| imp.stats.up | Up | 模數 | | mono |
| imp.stats.yield | Yield | 得料率 | | mono |
| imp.stats.waste | Waste | 損耗 | | mono |
| imp.noFit | Doesn’t fit | 放不下 | | mono |
| imp.previewSimplified | Preview simplified for large counts | 數量過大，預覽已簡化 | | mono |
| imp.preview.aria | {label} layout preview | {label} 排列預覽 | | — |
| imp.err.selectPiece | Choose a piece to impose | 請選擇拼版的件 | | mono |
| imp.err.field.* | — Tier B（§B5·5 條欄位錯誤） | 請輸入有效數字…等 | | mono |

（imp.stats 三詞、Best yield、0°/90° run＝matrix #22-24 留待本表的終裁，此處即終裁。）

### A6 盒型與片名（承載=BoxModule LocalizedText 的 `en` 欄位·C6 必填）

| 位置 | EN | zh（現值） |
|------|-----|-----------|
| rte.meta.name | Reverse Tuck End (RTE) | 反插式尾封盒 |
| telescope.meta.name | Telescope Box | 天地盒 |
| piece.base | Base | 下盒 |
| piece.lid | Lid | 上蓋 |
| piece.liner | Liner | 內襯 |
| rte.param.L | Length (L) | 長度 (L) |
| rte.param.W | Width (W) | 寬度 (W) |
| rte.param.D | Depth (D) | 深度 (D) |
| rte.param.thickness | Board caliper | 紙厚 |
| rte.param.tuckDepth | Tuck depth | 插舌深度 |
| rte.param.tuckRadius | Tuck radius | 插舌圓角 |
| rte.param.tuckClearance | Tuck clearance | 插舌內縮 |
| rte.param.tuckLock | Friction-lock width | 摩擦扣寬度 |
| rte.param.dustFlapDepth | Dust-flap depth | 防塵翼深度 |
| rte.param.flapNotch | Relief-notch width | 避讓槽寬 |
| rte.param.creaseRelief | Crease relief gap | 折線避讓間隙 |
| rte.param.glueSize | Glue-flap width | 糊邊寬度 |
| rte.param.glueSide | Glue-flap side | 糊邊位置 |
| rte.option.left / .right | Left／Right | 左／右 |
| tel.param.baseLength | Base length | 下盒長度 |
| tel.param.baseWidth | Base width | 下盒寬度 |
| tel.param.baseHeight | Base wall height | 下盒壁高 |
| tel.param.lidMarginX | Lid oversize (short axis) | 上蓋放大量（短向） |
| tel.param.lidMarginY | Lid oversize (long axis) | 上蓋放大量（長向） |
| tel.param.lidHeight | Lid wall height | 上蓋壁高 |
| tel.param.basePlatformWidth | Base platform width | 下盒壁頂平台寬 |
| tel.param.lidPlatformWidth | Lid platform width | 上蓋壁頂平台寬 |
| tel.param.thickness | Board caliper | 紙厚 |
| tel.param.rootJog | Root jog | 壁根位移量 |
| tel.param.innerWallReduction | Inner-wall reduction | 內壁縮減量 |
| tel.param.wallTopCompensation | Wall-top compensation | 壁頂平齊補償 |
| tel.param.linerEnabled | Liner pad | 內襯墊片 |
| tel.param.linerFitGap | Liner fit gap | 內襯套合間隙 |
| tel.param.linerFlapDepth | Liner leg depth | 內襯腳架深度 |
| group.dimensions | Dimensions & board | 尺寸與材質 |
| group.tuckLock | Tuck & lock | 插舌與鎖扣 |
| group.dustGlue | Dust flaps & glue | 防塵翼與糊邊 |
| group.creaseRelief | Crease relief | 折線避讓公差 |
| group.fit | Fit | 套合 |
| group.wallStyle | Wall style | 壁款 |
| group.compensation | Compensation | 補償 |
| group.liner | Liner | 內襯 |

### A7 AnnouncementModal 短件

| key | EN | zh | 備註 |
|-----|-----|-----|------|
| modal.aria | About open-dieline | 關於 open-dieline | |
| modal.close | Close | 關閉 | |
| modal.version | v{version} | v{version} | 規則 5：動態注入·「開發測試版」刪（⚠ 維護者簽） |
| modal.notes.title | Usage notes | 使用注意 | |
| modal.begin | Begin | 開始使用 | |
| modal.body.* | — Tier B（§B3·3 段＋5 注意事項） | audit #4-#12 | body 聲部 |

### A8 摺盒模式（P3 M1 新增·2026-07-17 簽核）

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| mode.fold | Fold | 摺盒預覽 | | label |
| fold.play | Play | 播放 | | label |
| fold.pause | Pause | 暫停 | | label |
| fold.autorotate | Auto-rotate | 自動旋轉 | | label |
| fold.progress.aria | Fold progress | 摺合進度 | | — |
| fold.controls.aria | Fold controls | 摺盒控制 | | — |

（mode.fold 的 EN 顯示形＝label 聲部 uppercase 由 CSS 管，字典存 Title case——同 mode.design 慣例；
兩條 aria 不渲染。）

### A9 摺盒卡色（P3 M2 新增·2026-07-17 實作輪 提案·待 B5-final 追認）

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| fold.card.label | CARD | 卡色 | | label |
| fold.card.white | WHITE | 白 | | label |
| fold.card.kraft | KRAFT | 牛皮 | | label |
| fold.card.black | BLACK | 黑 | | label |

### A10 摺盒圖稿（P3 M2 T2.6 新增·2026-07-17 實作輪 提案·待 B5-final 追認）

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| fold.art.label | ART | 圖稿 | | label |
| fold.art.none | NONE | 無 | | label |
| fold.art.sample | SAMPLE | 範例 | | label |

### A11 設計稿上傳（P3 M3 T0 新增·2026-07-17 review 草案＋採納·待 C9 簽核輪終裁）

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| fold.art.template | TEMPLATE | 模板 | | label |
| fold.art.upload | UPLOAD | 上傳 | | label |
| fold.art.staleTemplate | Parameters changed. Download a new template to realign your artwork. | 參數已變更，建議重新下載模板對位。 | | status |
| fold.art.invalidFile | This file can’t be used. Upload a PNG, JPEG, or SVG within the size limit. | 無法使用此檔案。請上傳大小限制內的 PNG、JPEG 或 SVG。 | | alert |

### A12 套圖編輯器（P3 M4 T4 新增·2026-07-18 簽核終稿）

| key | EN | zh | lock | 聲部 |
|-----|-----|-----|------|------|
| fold.art.edit | EDIT | 編輯 | | label |
| editor.done | DONE | 完成 | | label |
| editor.addImage | IMAGE | 加圖 | | label |
| editor.addText | TEXT | 加字 | | label |
| editor.duplicate | COPY | 複製 | | label |
| editor.delete | DELETE | 刪除 | | label |
| editor.layerUp | RAISE | 上移 | | label |
| editor.layerDown | LOWER | 下移 | | label |
| editor.download | ARTWORK PNG | 下載成品 | | label |
| editor.empty | Add an image or text to begin. | 加入圖片或文字開始編輯。 | | status |
| editor.stale | Parameters changed. Reposition your artwork to realign. | 參數已變更，請重新對位物件。 | | status |
| editor.limit.objects | Object limit reached (32). | 已達物件上限（32）。 | | status |
| editor.error.compose | Rendering failed. Try again or remove the last object. | 合成失敗，請重試或移除最後加入的物件。 | | status |
| editor.font.sans | SANS | 無襯線 | | label |
| editor.font.serif | SERIF | 襯線 | | label |
| editor.font.mono | MONO | 等寬 | | label |
| editor.align.left | LEFT | 左 | | label |
| editor.align.center | CENTER | 中 | | label |
| editor.align.right | RIGHT | 右 | | label |
| editor.color.ink | INK | 墨 | | label |
| editor.color.inkSoft | SOFT | 淡墨 | | label |
| editor.color.cut | CUT | 刀紅 | | label |
| editor.color.crease | CREASE | 摺藍 | | label |
| editor.color.brass | BRASS | 黃銅 | | label |

## §B Tier B——長文（**逐 key 明細=`inventory-expansion.md` 節 1·規範性**；下為家族總覽）

§A 補漏 4 key（`param.reset.glyph` ↺·lock／`overlay.unit.pt/mm/px` lock 規格值／
`imp.placeholder.dash` — lock／`modal.title`）＋zh 訂正（`overlay.select.title`
「點選」→「點擊」·audit 逐字）＝expansion 節 2·已採納併入本表效力。

- **B1 參數 description ×27**（rte 12＋tel 15·audit §7a/§8a）——承載=LocalizedText `en`；
  技術詞彙錨：caliper／girth compensation／dust flap／friction lock／gusset／relief
- **B2 invariant message ×23**（rte 9＋tel 14·audit §7b/§8c；no-nan/no-bleed/bounds-cover
  兩盒型重複→合併單 key ×3）——模板變數逐字保留；語調=儀器警示（簡潔·陳述式）
- **B3 modal 段落 ×8**（3 段＋5 注意事項·audit #4-#12）——D7 掃描過（零禁語）；
  段 2 的「開發測試版」字樣隨規則 5 裁決同步修
- **B4 說明長句 ×2**：layers.overlays.desc（#134）＋export.manufacturing.title（#25）
- **B5 拼版句子 ×12**（audit §14/§15：DISCLAIMER、workingSheetText 模板、每四開/每半張、
  行距/列距輪廓收縮、5 條欄位錯誤、2 條 generalError）
- **B6 overlay 解析警告 ×8**（audit §13——`${key} ×N 未匯入` 模板家族；`err.message`
  透傳條保持原樣不翻）
- **B7 pieces.ts 檢核 ×9**（audit §10）——規則 6：error-code 前綴保留
- **B8 摺盒模式狀態文案 ×3**（P3 M1 新增·2026-07-17 簽核·無 audit 前身）——
  telescope 空狀態＋WebGL fallback＋dynamic chunk 載入失敗；聲部=mono 置中（P3 Spec §7）

## §C 匯出凍結（規則 3 執行細目）

| 常數 | 值 | 消費者 | 處置 |
|------|-----|--------|------|
| GENERATED_LAYER_LABEL.cut/crease/halfcut/dimensions | 切割線/摺線/半刀/尺寸標註 | export/svg.ts:120 `<g data-name>`＋（現）LayersPanel | 常數凍結；LayersPanel 改讀 layers.* 字典 key；匯出續讀常數（A2 不動） |
| 檔名模板 boxId/pieceId | ascii id（rte/telescope/base/lid/liner） | ExportBar 檔名 | 不隨語言變（lock） |

## §D 承載架構（M1 實作契約）

- chrome/UI key → `src/i18n/` 字典（`{ en, zh }`·單一檔）；**組合句用 message-template**（整句 key＋具名參數·每語言自持模板——EN 語序重排需要·M0.6 實證·禁字串拼接）
- 盒型 schema 字串 → 原地補 LocalizedText `en` 欄（C6·型別收緊必填）
- 存量常數（§C）→ 不動
- A15 gate：渲染 key 全集 ≡ 本表 key 全集；structural-lock 字串逐字相等

## §E 排除清單（不進字典·理由=開發期斷言僅達 console）

audit S1-S5 全 16 條（main.tsx mount 錯誤、registry.ts 註冊斷言 ×12、path.ts 幾何
斷言 ×3）——保持中文原樣（維護者語言），不進 i18n、不進 zh subset charset（throw
字串非 `zh:` key 形式·charset 掃描本就不收）。

## 簽核點總覽（待裁項總覽）

1. 規則 5：版本字樣（動態注入＋刪「開發測試版」）
2. A3：legend zh「壓痕」→統一「摺線」（mock zh plate 作廢一詞）
3. A4：mock「AI-compat stroke」→「Manufacturing stroke」
4. A5：mock「Portrait run／Landscape run」→「0° run／90° run」（旋轉語義非紙向）
5. Tier A 全部 EN 文案＋structural-lock 標記
6. Tier B 的分層辦法（EN 由 M1 review 起草·複核·回寫）
7. （typography matrix 側）zh 恆 400＋`font-synthesis: none`
