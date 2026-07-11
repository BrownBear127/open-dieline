# Contributing to open-dieline

Thanks for your interest! This document explains what kinds of contributions are most valuable and the conventions this project follows.

感謝你想為這個專案出力。這份文件說明哪些貢獻最有價值，以及這個專案的工程慣例。

## 最有價值的貢獻：真實刀模與量測數據

這個專案的核心價值是「幾何規則以真實生產刀模逆向量測校準」——**實際生產過的刀模樣本、量測數據、印刷廠實務知識，比程式碼更珍貴**。如果你有：

- 實際打樣或量產過的刀模檔（SVG／DXF／AI），且確認可以分享
- 特定盒型的業界參數慣例（插舌內縮量、紙厚補償係數、咬口尺寸等）與其出處
- 用本工具產出的刀模在實際打樣時發現的誤差

歡迎開 issue 分享，這是新盒型與幾何修正的直接依據。

## 回報問題（Bug Report）

開 issue 時請附上：

- 盒型與完整參數組合（長寬深、紙厚、以及你調過的所有參數）
- 預期行為與實際行為（截圖或匯出的 SVG 更好）
- 如果是拼版問題：紙規、方向、裁切、咬口、刀線間距的設定值

## 程式碼貢獻

### 開發環境

依 README 的「本地執行」段落安裝（Node.js 20+），開發時常用指令：

```bash
npm run dev          # 開發伺服器
npm test             # 跑測試（vitest）
npm run typecheck    # TypeScript 型別檢查（含測試檔）
npm run check:cycles # 循環依賴檢查（madge）
npm run build        # production 打包
```

**送 PR 前四道閘門必須全綠**：`npm test`、`npm run typecheck`、`npm run check:cycles`、`npm run build`。CI 會跑同一套。

### 工程慣例

- **幾何規則必須有依據**。新盒型或參數調整要能回答「這個數字從哪裡來」——真實刀模量測、業界文獻、或印刷廠實務確認。「看起來對」的 magic number 不收。
- **錨值測試（anchor tests）**：幾何輸出以具體數值鎖住（來自真實量測或手算），改動幾何邏輯時錨值變化必須能解釋。
- **Fail loud**：物理上做不出來的參數組合要產生明確 warning 或錯誤，不能靜默產出不可製造的刀模。
- **線型樣式單一來源**：畫布與匯出共用 `src/core/styles.ts` 的 `LINE_STYLES`（黑=切割、綠=摺線、黃=半刀，對齊印刷業慣例），不要散落字面量色碼。
- **Commit 格式**：`<type>: <description>`（feat／fix／refactor／docs／test／chore）。
- Issue 與 PR 中英文皆可。

## 授權條款（License Terms for Contributions）

本專案採 [PolyForm Noncommercial License 1.0.0](LICENSE)，並由維護者保留商業授權（詳見 README）。為了讓這個模式可行：

**提交貢獻（PR、patch、或以其他形式提供的程式碼與內容）即表示你同意**：

1. 你的貢獻以 PolyForm Noncommercial License 1.0.0 隨專案釋出；
2. 你授予專案維護者一項非專屬、永久、不可撤銷、全球性的權利，得以其他授權條款（包括商業授權）使用、修改、散布及再授權你的貢獻；
3. 你確認你有權做出以上授權（貢獻是你的原創作品，或你已取得必要的權利）。

如果你無法同意以上條款，仍然非常歡迎以 issue 形式分享知識與回報問題。

有任何疑問：hello@konvolut.art
