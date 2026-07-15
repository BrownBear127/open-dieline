// checks/gates/g6-external-urls.mjs — G6：建置產物零外部 URL 字面（Spec §8.1）
// runtime 組 URL／request 層由 §8.3 Playwright request 攔截接手
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Task 6 首跑逐條裁決（詳見 p2-task-6-report.md）：非 w3.org 五條皆非本 task 新增，
// 是既有內容——react.dev/tailwindcss.com 為 node_modules 依賴自嵌字串（React production
// 錯誤解碼器 URL／Tailwind build 自動注入授權橫幅），app 原始碼未撰寫、patch 需 fork 依賴；
// konvolut.art/github.com/BrownBear127/konvolut.substack.com 為 AnnouncementModal.tsx
// 既有功能（v0.2.0·commit a9ee9bc）品牌自我指涉／原始碼揭露連結，非追蹤或 CDN。
// 皆綁定精確網域，不影響 gate 對「新引入之任意外部網域」的偵測力（§8.2 mutation probe 精神）。
// 邊界錨定（batch review 2 Important·2026-07-16 修）：網域後必須緊跟 `/` 或字串結尾，
// 否則 `https://konvolut.art.evil-phish.example/steal` 這類網域混淆字串會被靜默放行
//（修前實測打穿）。w3.org／react.dev 以既有的必帶 `\/` 錨定；github 條目連 repo 路徑也
// 補 `(\/|$)`（防 `open-dieline-evil` 這類 repo 名前綴混淆）。
const ALLOW = [
  /^https?:\/\/www\.w3\.org\//, // SVG/HTML xmlns 命名空間字串，非網路請求
  /^https?:\/\/react\.dev\//,
  /^https?:\/\/tailwindcss\.com(\/|$)/,
  /^https?:\/\/konvolut\.art(\/|$)/,
  /^https?:\/\/github\.com\/BrownBear127\/open-dieline(\/|$)/,
  /^https?:\/\/konvolut\.substack\.com(\/|$)/,
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
    for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/[^\s"'`)]+|(?<=["'`])\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ) {
      if (!ALLOW.some((re) => re.test(m[0]))) errs.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
    }
  }
  return errs;
}
