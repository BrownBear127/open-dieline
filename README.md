# open-dieline

> A [Konvolut](https://konvolut.art) project · **Live: [open-dieline.vercel.app](https://open-dieline.vercel.app)**

An open-source dieline generator for print & packaging — parametric, printable, calibrated against real production dielines.

一個開源的印刷刀模（dieline）產生器——把包裝盒的結構知識做成可以調參數、可以列印試摺的工具。目前支援反向插舌盒（RTE）與天地盒三件套，幾何規則以真實生產刀模逆向量測校準。

## 目前盒型與特點

**盒型**
- 反向插舌盒（RTE, Reverse Tuck End）
- 天地盒三件套（Telescope Box）：上蓋／下盒／平台式內襯

**特點**
- 紙厚補償：參數隨紙厚即時重算（如插舌內縮量）
- 生產刀模對帳：幾何規則以真實生產刀模逆向量測校準
- 圖層系統：切割線／摺線／半刀／尺寸標註四層獨立顯示
- 疊圖對照：匯入生產 SVG 作多圖層 1:1 比對（置中、拖曳、點選線段校準比例）
- 拼版試算：選件後在常用紙規（31"×43"／25"×35"／27"×39"／自訂）上試排，支援直放橫放、對切、咬口與刀線間距設定，0° 與 90° 兩方向並列比較模數
- 輪廓收縮排列：非矩形件依實際刀線輪廓（含斜線與圓弧）收縮行距或列距，在維持刀線最小間距的前提下多排一行——RTE 於 31"×43" 直放實測 12 模 → 15 模（+25%）。拼版結果為單向收縮估算，未計交錯、共刀、絲向及加工限制，不可直接作生產拼版
- SVG 匯出：按線型分 `<g>` 命名群組，Adobe Illustrator 開啟即可分層操作；可選「製造模式」僅輸出切割／摺線／半刀三層
- DXF 匯出：R12 相容、CUT／CREASE／HALFCUT 三圖層，供刀模廠直接使用
- 單片視圖：多片盒型可切換全版／單片顯示與匯出

## 使用

**直接使用（免安裝）**：開啟 **[open-dieline.vercel.app](https://open-dieline.vercel.app)** 即可。所有計算都在瀏覽器內完成，不需要安裝任何東西，匯入的刀模檔也不會上傳到任何伺服器。

**本地執行（想改程式碼的人）**：需要先安裝 [Node.js](https://nodejs.org/)（20 以上，選 LTS 版即可），然後在終端機依序執行：

```bash
# 1. 把原始碼下載到電腦（也可以在 GitHub 頁面點 Code → Download ZIP 後解壓縮）
git clone https://github.com/BrownBear127/open-dieline.git

# 2. 進入專案資料夾
cd open-dieline

# 3. 安裝依賴（第一次執行需要，之後不用）
npm install

# 4. 啟動開發伺服器，然後用瀏覽器開啟畫面上顯示的網址（通常是 http://localhost:5173）
npm run dev
```

開發用指令：`npx vitest run` 跑測試、`npm run build` 打包 production 版到 `dist/`。

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)——僅限非商業使用；商業使用請來信洽談：hello@konvolut.art

## Links

- [Live demo](https://open-dieline.vercel.app)
- [Konvolut](https://konvolut.art)
- [Substack](https://konvolut.substack.com)
