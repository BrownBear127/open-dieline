# A8 字體可行性實測報告（Task 8·2026-07-16）

給法蘭的裁決文件：本 task 只做量測與聯集收集，**不 vendor 到 `public/fonts`、不動 `vocab.css`**（Task 9 的事）。所有數字皆來自實跑輸出（`checks/fonts/measure-subsets.sh`），無估算值。

## 1. Charset 聯集統計

`checks/gates/charset.mjs`（掛進 `style-gate.mjs` GATES 尾端，`npm test` 971/971 + G1-G6+charset 全 OK）對三源聯集後的實測結果（`checks/fonts/charset.json`）：

| | 字元數 | 來源 |
|---|---|---|
| latin | **88** | BoxModule LocalizedText 的 `zh:`/`en:` 字面中非 CJK 部分 ＋ `RUNTIME_CHARSET`（`0-9 . , % × − ＋ ° : /` 與空格）＋ `vocab.css` 的 `content:` 字串 |
| cjk | **532** | 全部已註冊 BoxModule 的 `zh:`（reverse-tuck-end.ts／telescope/{index,liner,tray}.ts 的 label／group／description／invariant 訊息）——`en:` 目前無值（app 只讀 `.zh`，`en` 為型別上選填、尚未落地） |

抽查確認（self-review 判準）：`cjk` 集合含「插」「舌」「內」「襯」四字（`reverse-tuck-end.ts` 插舌參數＋telescope 內襯片名），確認聯集真的吃到 BoxModule 字面，不是只有 runtime charset。

**與站群現況的字元集差異（這是本次工具跟站群不同的地方）**：站群 `subset.sh` 的 Latin 用固定 unicode range（`U+0020-007E,U+00A0-00FF` 等，約 200 個潛在碼位）、CJK 用「站群 `/zh/` 頁面渲染文字」（248 字）。本次工具的字元集改用「**BoxModule 字面實際掃描**」——latin 因為工具目前用字窄（88＜約 200）反而更小；cjk 因為盒型參數說明文字比行銷頁豐富，反而更大（532＞248，約 2.1 倍）。**字典（`src/i18n/` chrome 文案字典，Spec §7 D2）目前還沒建**，屆時字典字面會再疊加進這個聯集，latin/cjk 數字預期會再漲。

## 2. per-face bytes 實測

方法：`checks/fonts/measure-subsets.sh` 對 `/tmp/fonts-src/` 上游 ttf（與 `site/fonts/subset.sh` 同一批來源）跑 `pyftsubset`，Latin 五顆逐字沿用 `subset.sh` 的 `--flavor=woff2 --layout-features='*'`（僅把 `--unicodes=<固定範圍>` 換成本次聯集的 `--text-file=`）；Noto 沿用 `subset.sh` T5 起的正式兩步流程（`varLib.instancer --static wght=400` → `pyftsubset --text-file`）。

**Shell escaping 對策**：latin 字元集含 `<>[]()` 等 shell 特殊字元，直接塞 `--text="$LATIN"` 有炸殼風險；cjk 集合 532 字太長也不適合單一參數。兩者皆改寫暫存檔（`/tmp/p2-font-measure/{latin,cjk}-chars.txt`，Python `json.load` 讀 `charset.json` 後原樣寫出、不加換行）用 `--text-file=` 餵給 `pyftsubset`。

| face | bytes | 對照站群同 face |
|---|---:|---:|
| familjen.woff2 | 10,784 | 17,068 |
| fraunces-var.woff2 | 66,068 | 113,792 |
| fraunces-italic-var.woff2 | 88,132 | 140,632 |
| plex-mono.woff2 | 9,104 | 13,932 |
| plex-mono-500.woff2 | 9,264 | 14,252 |
| noto-serif-tc-subset.woff2 | 108,320 | 46,400 |
| **TOTAL** | **291,672** | **346,076** |

五顆 latin face 都比站群小（本工具目前用字窄於站群固定 range）；Noto 比站群大 2.3×（cjk 字元數多 2.1×，方向一致、量級合理）。**TOTAL 291,672B < 站群 346,076B**，儘管 CJK 面更重，Latin 面省下的量還是抵過。

woff2 已是最終壓縮格式（內部走 Brotli），上述 bytes 就是瀏覽器實際下載量；再套一層 gzip 對已壓縮的 woff2 幾乎無效益（站群 `subset.sh` 現行部署也未對 woff2 二次壓縮），本表不另列壓縮前後兩欄。

## 3. 必備 face manifest 草案（六 face）

`fontTools` 實測驗證 fvar 軸（`uv run --with "fonttools[woff]"`，非估算）：

| face | 型態 | fvar 軸（實測） |
|---|---|---|
| Fraunces（roman） | variable | opsz 9–144／wght 100–900／SOFT 0–100／WONK 0–1（四軸，同站群凍結基線） |
| Fraunces（italic） | variable | 同上四軸 |
| Familjen Grotesk | variable | wght 400–700 |
| IBM Plex Mono Regular | static | 無 fvar（原生靜態檔） |
| IBM Plex Mono Medium | static | 無 fvar（原生靜態檔） |
| Noto Serif TC | static 400 | 無 fvar（`varLib.instancer --static` 主動 drop，同站群 T5 決策——省 79,780B 換 LCP，見 `subset.sh` 註解） |

Fraunces 兩檔四軸完整保留（沒用任何 `--instantiate`，pyftsubset 對 variable font 預設不做軸限縮）——A7（「Fraunces fvar 四軸=站群凍結基線」）在本次量測路徑下可過。

## 4. 重要發現：4 個字元落在「六 face 皆無 glyph」的縫（需法蘭裁決，非 A8 預算問題）

比照站群 `subset.sh` 對 ✕(U+2715) 的既有教訓（「三套上游字體皆無此 glyph，pyftsubset 靜默跳過缺碼位」），本次對聯集 88+532 字逐字元跑 `fontTools.getBestCmap()` 覆蓋率檢查（`uv run --with "fonttools[woff]"`，非樣本抽查、全量掃過），發現：

| 字元 | 碼位 | 來源 | 現況 |
|---|---|---|---|
| ①②③ | U+2460-2462 | `telescope/index.ts:820` 的 `zh:` invariant 訊息字面（Canvas.tsx:480 `{w.message.zh}` 會渲染警告文字） | `charset.mjs` 的 cjk 判別 regex `[　-鿿豈-﫿＀-￯「」（）]` 覆蓋不到「Enclosed Alphanumerics」區塊（U+2460-24FF），被歸進 latin 桶。但 **Fraunces／Familjen／Plex 五顆上游 ttf 全部沒有這三個字**（實測，非分類疏漏造成的假警報）——Noto Serif TC **有**這三個字。若照現行分類跑 T9 vendor，這三字會落在 latin 桶又沒有任何 latin face 承接，靜默消失（pyftsubset 對缺碼位不報錯，同 ✕ 教訓） |
| ▾ | U+25BE | `vocab.css:96` `.boxsel::after { content: "▾"; }`（下拉選單箭頭裝飾） | 正確歸類 latin（CSS content 來源本就該歸類無誤），但**六顆 face 全部沒有這個字**（含 Noto）。目前 `.boxsel` class 尚未接進真實 JSX（vocab.css 是凍結尚未接線的語彙表，`grep` 確認 `App.tsx` 等檔案沒有任何元素用 `className="boxsel"`），不是本次量測範圍的立即風險，但接線那天會踩 |

**建議處置（留法蘭裁決，不擅自改）**：
1. ①②③：`charset.mjs` 的 cjk regex 補一段 `①-⓿`（Enclosed Alphanumerics），讓這三字連同其餘 cjk 一起走 Noto 桶——bytes 影響可忽略（Noto 面已含大量常用字，多 3 個碼位量級是幾十 bytes）。
2. ▾：同 ✕ 的既有先例（`subset.sh` 註解：「✕ 已自清單移除…改用 U+00D7(×)」），若最終要接線 `.boxsel`，需要換一個六 face 裡有的替代碼位（例如檢查 Fraunces/Familjen 是否有 U+25BC▼／U+2193↓ 這類可用符號），或接受瀏覽器 fallback（該字純裝飾用途、非文字內容，fallback 風險低於文字缺字，但仍是視覺不一致）。**本 task 不擅自做這個替換**（Files 範圍不含 vocab.css）。

這兩個縫都不是「量測方法錯」（已用全量掃描而非抽樣驗證），而是「charset.mjs 分類 regex 邊界」與「上游字體選字」兩個真實限制，跟 A8 的「總 bytes 預算」是兩個獨立問題——即使 A8 訂多寬，這兩個字元缺口都不會自動解決，需要另外處理（建議在 T9 動 charset.mjs 前一併修，或至少讓 font-gate.py（T9）的 glyph coverage 檢查對這 4 個字元顯性報告，不要靜默漏過）。

## 5. AnnouncementModal.tsx 範圍界定（已核實非缺口，非開放問題）

`AnnouncementModal.tsx` 有大量純 JSX 段落文字（「一個印刷刀模…」等），不經 `zh:`/`en:` LocalizedText 欄位，`charset.mjs` 的規則①（zh/en 字面）掃不到。核對 Spec §6.3 明文的四個來源（chrome i18n 字典＋BoxModule LocalizedText＋runtime charset＋CSS content），AnnouncementModal 屬於「維護者定稿文案」（該檔自身 docblock 用語），既不是字典（`src/i18n/` 字典本身還沒建，屬 §7 D2 未來工作）也不是 BoxModule——**Spec 範圍本就不含它**。另外核實：`vocab.css` 的 `.zh .label`/`.mono-cjk`（唯一會切到 Noto Serif TC 自架字型的 CSS 規則）目前沒有任何真實 JSX 用到（`grep` 全 repo `className` 只見 Tailwind 內建 `font-mono`，vocab.css 的語彙 class 尚未接線），AnnouncementModal 現在渲染時走瀏覽器預設字體堆疊，不吃自架 subset，沒有缺字風險。**這不是本次量測的缺口，是設計上的範圍邊界**——留意：等 D-vocab CSS 真的接線那天，若 AnnouncementModal 之類的自由文案也要套自架字型，`charset.mjs` 需要加第五個來源。

## 6. A8 預算裁決（需法蘭定案）

**建議值：340,000 bytes（≈332KB）**

理由：
- 實測 TOTAL＝291,672B 是「目前兩個盒型（RTE＋telescope）、字典尚未落地」的地板值，不是穩定上限——`src/i18n/` chrome 字典（§7）與下一個盒型（雙蓋盒，任務夾已有骨架）都會再加 latin/cjk 字面，聯集只會漲不會跌。340,000B 留了 48,328B（≈17%）餘裕吸收這些已知在製品的成長，不是憑空拍數字。
- 340,000B 仍低於站群現有六檔 346,076B 的既有先例——工具跟站群維持同一量級，不會出現「工具比整個行銷站還重」的觀感落差。
- 若之後真的逼近或超過 340,000B，那是自然的重新盤點訊號（該回頭看是不是聯集裡混進不必要的字，或該重新裁決），比放一個過鬆的數字（例如直接抄 700KB 的 zh 頁面總資源預算）更有把關意義——那個 700KB 是 `subset.sh` 註解裡整頁資源預算（含非字體資源），不是字體專用預算，不適合直接套用。

若法蘭想要更保守（禁止任何成長空間，逼字典設計時精簡字面），可訂在測得地板值附近（比如 300,000B）；若想給更寬裕的餘裕（例如預期字典會顯著擴充 UI 文案量），可直接比照站群既有先例 346,076B 整數採用。三個選項的地板/依據都已在上表列清楚，供法蘭選。

## 附錄：驗證方法記錄

- glyph coverage 驗證：`uv run --with "fonttools[woff]" python3` 對 `checks/fonts/charset.json` 的 latin/cjk 全量字元、逐字用 `TTFont(...).getBestCmap()` 查碼位是否存在，五顆 latin 檔＋Noto 各自驗一次（非抽樣）。
- fvar 軸驗證：同一 Python 環境對 `fraunces-var.woff2`／`fraunces-italic-var.woff2`／`familjen.woff2`／`plex-mono*.woff2`／`noto-serif-tc-subset.woff2` 讀 `TTFont.fvar.axes`，六檔皆驗（Plex/Noto 確認為靜態無 fvar，符合預期）。
- 量測全程用 `/tmp/p2-font-measure/` 工作目錄，未寫入 repo 任何 vendor 產物（`public/fonts` 未動）；`checks/fonts/charset.json` 是本 task 的合法產出物（`checks/gates/charset.mjs` 的 interface 輸出，Task 9 消費）。
