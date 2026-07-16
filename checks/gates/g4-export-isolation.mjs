// checks/gates/g4-export-isolation.mjs — G4：export/ 依賴圖禁入顯示層（Spec §5/§8.1）
// 自寫 BFS 不用 madge（madge 空心 gate 前科——見 memory）；sanity：走訪數>0 且含 core/styles
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

function resolveImport(from, spec, root) {
  let base = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2))
    : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null; // 外部套件
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(cand) && !cand.endsWith(path.sep)) try { if (readFileSync(cand)) return cand; } catch { /* dir */ }
  }
  return null;
}

export async function run({ root }) {
  const configPath = path.join(root, 'checks/gates/g4-forbidden.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const forbidden = Array.isArray(config.forbidden)
    ? config.forbidden.filter((fragment) => typeof fragment === 'string' && fragment.length > 0)
    : [];
  const entryDir = path.join(root, 'src/export');
  const queue = readdirSync(entryDir).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(entryDir, f));
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, m[1], root);
      if (next) queue.push(next);
    }
  }
  const errs = [];
  if (forbidden.length === 0) errs.push('g4-forbidden.json forbidden 清單不可為空（sanity）');
  const names = [...visited].map((f) => path.relative(root, f).split(path.sep).join('/'));
  if (names.length < 3) errs.push(`BFS 僅走訪 ${names.length} 檔——gate 疑似空心（sanity）`);
  if (!names.some((n) => n.includes('core/styles'))) errs.push('BFS 未達 core/styles.ts——解析器壞了（sanity）');
  const bad = names.filter((name) => forbidden.some((fragment) => name.includes(fragment)));
  if (bad.length) errs.push(`匯出路徑引入顯示層：${bad.join(', ')}`);
  return errs;
}
