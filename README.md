# open-dieline

An open-source dieline generator for print & packaging — parametric, printable, calibrated against real production dielines.

一個開源的印刷刀模（dieline）產生器——把包裝盒的結構知識做成可以調參數、可以列印試摺的工具。目前支援反向插舌盒（RTE）與天地盒三件套，幾何規則以真實生產刀模逆向量測校準。

## 目前盒型與特點

**盒型**
- 反向插舌盒（RTE, Reverse Tuck End）
- 天地盒三件套（Telescope Box）：上蓋／下盒／平台式內襯

**特點**
- 紙厚補償：參數隨紙厚即時重算（如插舌內縮量）
- 生產刀模對帳：幾何規則以真實生產刀模逆向量測校準
- SVG 匯出：可選是否含尺寸標註
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

- [Konvolut](https://konvolut.art)
- [Substack](https://konvolut.substack.com)
