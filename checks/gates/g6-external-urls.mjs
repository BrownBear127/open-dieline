// checks/gates/g6-external-urls.mjs — G6：建置產物零外部 URL 字面（Spec §8.1）
// runtime 組 URL／request 層由 §8.3 Playwright request 攔截接手
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

// Task 6 首跑逐條裁決（詳見 開發紀錄）：非 w3.org 五條皆非本輪 新增，
// 是既有內容——react.dev/tailwindcss.com 為 node_modules 依賴自嵌字串（React production
// 錯誤解碼器 URL／Tailwind build 自動注入授權橫幅），app 原始碼未撰寫、patch 需 fork 依賴；
// konvolut.art/github.com/BrownBear127/konvolut.substack.com 為 AnnouncementModal.tsx
// 既有功能（v0.2.0·commit a9ee9bc）品牌自我指涉／原始碼揭露連結，非追蹤或 CDN。
// 皆綁定精確網域，不影響 gate 對「新引入之任意外部網域」的偵測力（§8.2 mutation probe 精神）。
// 邊界錨定（batch review 2 Important·2026-07-16 修）：網域後必須緊跟 `/` 或字串結尾，
// 否則 `https://konvolut.art.evil-phish.example/steal` 這類網域混淆字串會被靜默放行
//（修前實測打穿）。w3.org／react.dev 以既有的必帶 `\/` 錨定；github 條目連 repo 路徑也
// 補 `(\/|$)`（防 `open-dieline-evil` 這類 repo 名前綴混淆）。
// P3 M1 T4 增列（裁決·2026-07-17 已追認）：three.js GLSL shader 模板字串內嵌
// 的學術參考連結（GGX VNDF importance sampling·Heitz 2018 論文）——字串內容 minify 剝不掉、
// 隨 fold chunk 真出貨（2026-07-17 真 dist 實測 17 筆中唯一出貨殘留·其餘 16 筆為 JS 註解
// 已由下方 minify 掃描消解）。與 react.dev 前例同類：依賴自嵌惰性字面、非追蹤非 CDN、
// 全路徑精準錨定（非網域級放行）。
// 頁尾新增 PolyForm 授權真連結；只放行官方 Noncommercial 1.0.0 精確路徑，
// 不擴成整個 host，維持 gate 對同網域其他未知 URL 的判別力。
const ALLOW = [
  /^https?:\/\/www\.w3\.org\//, // SVG/HTML xmlns 命名空間字串，非網路請求
  /^https?:\/\/react\.dev\//,
  /^https?:\/\/tailwindcss\.com(\/|$)/,
  /^https?:\/\/konvolut\.art(\/|$)/,
  /^https:\/\/polyformproject\.org\/licenses\/noncommercial\/1\.0\.0(\/|$)/,
  /^https?:\/\/github\.com\/BrownBear127\/open-dieline(\/|$)/,
  /^https?:\/\/konvolut\.substack\.com(\/|$)/,
  /^https:\/\/jcgt\.org\/published\/0007\/04\/01\/$/,
];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|css|html)$/.test(e)) yield p;
  }
}

export async function run({ distDir }) {
  const errs = [];
  for (const f of walk(distDir)) {
    let text = readFileSync(f, 'utf8');
    // .gate-dist 是 minify-false 建置（見 style-gate.mjs 檔頭）：依賴原始碼「註解」裡的
    // 文件參考 URL 會殘留（P3 T4 實測：three.js chunk 16 筆 JS 註解 URL·真 minified dist
    // 同點掃描 0 筆——不出貨也不構成請求面）。JS 先經 esbuild minify 再掃，讓掃描面等價於
    // 真出貨內容（2026-07-17 實測：minify 後留存集合 ≡ 真 dist 留存集合）。字串字面 minify
    // 逐字保留——shader 模板字串等「真出貨」的 URL 仍會被掃到（jcgt.org 一筆走 ALLOW 裁決）。
    // 注意 legalComments none 不 minify 時「不會」剝 class method 附掛 JSDoc（實測），
    // 必須 minify:true。HTML/CSS 照原文掃——index.html 註解注入 probe（g6-external-url）
    // 的紅方向路徑不受影響。
    if (f.endsWith('.js')) text = (await transform(text, { loader: 'js', legalComments: 'none', minify: true })).code;
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+|(?<=["'`])\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ) {
      if (!ALLOW.some((re) => re.test(m[0]))) errs.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
    }
  }
  return errs;
}
