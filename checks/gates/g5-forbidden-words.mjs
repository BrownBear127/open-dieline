// checks/gates/g5-forbidden-words.mjs — G5：D7 禁語（scope=src/＋checks/gates 的 inventory 檔·字面層）
// 拼接式繞路由 §8.3 Playwright 渲染文字掃描接手（分工見 Spec §8.2 G5）
// g5-allow 行內豁免（Task 6 Step 3 加）：LICENSE 引用類註解（如「PolyForm 非 MIT」說明）不必
// 改詞繞開字面，可標 `// g5-allow: 理由` 讓掃描器跳過該行——理由必填，缺理由仍算違規並提示。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// 中文等價詞（開源/开源/開放原始碼）＝裁決（2026-07-16）：D7 是既定裁決、涵蓋
// 等價詞——工具授權=PolyForm NC 非開源，任何語言的 open-source 宣稱皆違規。
const RE = /open[\s-]?source|\bMIT\b|開源|开源|開放原始碼/i;
const ALLOW_RE = /\/\/\s*g5-allow:\s*(.*)\s*$/;

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx?|css|json|md|html)$/.test(e)) yield p;
  }
}

export async function run({ root }) {
  const errs = [];
  for (const f of walk(path.join(root, 'src'))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!RE.test(line)) return;
      const allowMatch = line.match(ALLOW_RE);
      if (allowMatch) {
        const reason = allowMatch[1].trim();
        if (reason) return; // g5-allow 豁免·理由已填，跳過該行
        errs.push(`${path.relative(root, f)}:${i + 1}: g5-allow 缺理由（理由必填）— ${line.trim().slice(0, 80)}`);
        return;
      }
      errs.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  return errs;
}
