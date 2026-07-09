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
- SVG 匯出：按線型分 `<g>` 命名群組，Adobe Illustrator 開啟即可分層操作
- DXF 匯出：R12 相容、CUT／CREASE／HALFCUT 三圖層，供刀模廠直接使用
- 單片視圖：多片盒型可切換全版／單片顯示與匯出

## Dev

```bash
npm install       # 安裝依賴
npm run dev       # 啟動開發伺服器
npx vitest run    # 跑測試
npm run build     # production build
```

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)——僅限非商業使用；商業使用請來信洽談：hello@konvolut.art

## Links

- [Live demo](https://open-dieline.vercel.app)
- [Konvolut](https://konvolut.art)
- [Substack](https://konvolut.substack.com)
