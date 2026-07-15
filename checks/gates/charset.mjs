// checks/gates/charset.mjs — Spec §6.3 字元聯集：zh/en 字面（含 BoxModule LocalizedText·C6）
// ∪ runtime-charset ∪ CSS content。regex 掃字面=聯集的超集，對 subset 安全（多包不缺字）。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function* walk(dir, exts) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p, exts);
    else if (exts.test(e)) yield p;
  }
}

export function collectCharset(root) {
  const chars = new Set();
  const add = (s) => { for (const ch of s) chars.add(ch); };
  // ① zh:/en: 字串字面（i18n 字典＋BoxModule LocalizedText 同時被此 regex 覆蓋）
  for (const f of walk(path.join(root, 'src'), /\.(tsx?|json)$/)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b(?:zh|en)\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g)) add(m[2]);
  }
  // ② runtime charset（直接讀原始檔字面，不執行 TS）
  const rt = readFileSync(path.join(root, 'src/i18n/runtime-charset.ts'), 'utf8');
  add(/RUNTIME_CHARSET\s*=\s*'([^']*)'/.exec(rt)[1]);
  // ③ CSS content 字串
  for (const f of walk(path.join(root, 'src/styles'), /\.css$/)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/content:\s*(['"])((?:(?!\1).)*)\1/g)) add(m[2]);
  }
  const all = [...chars].filter((c) => c !== '\n' && c !== '\\');
  const cjk = all.filter((c) => /[　-鿿豈-﫿＀-￯「」（）]/.test(c)).sort().join('');
  const latin = all.filter((c) => !cjk.includes(c)).sort().join('');
  return { latin, cjk };
}

export async function run({ root }) {
  const cs = collectCharset(root);
  writeFileSync(path.join(root, 'checks/fonts/charset.json'), JSON.stringify({ ...cs, latinCount: cs.latin.length, cjkCount: cs.cjk.length }, null, 2));
  return []; // 產物型 gate：font-gate.py（T9）消費 charset.json 才做斷言
}
