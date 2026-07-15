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
  const entryDir = path.join(root, 'src/export');
  const queue = readdirSync(entryDir).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(entryDir, f));
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const next = resolveImport(file, m[1], root);
      if (next) queue.push(next);
    }
  }
  const errs = [];
  const names = [...visited].map((f) => path.relative(root, f));
  if (names.length < 3) errs.push(`BFS 僅走訪 ${names.length} 檔——gate 疑似空心（sanity）`);
  if (!names.some((n) => n.includes(path.join('core', 'styles')))) errs.push('BFS 未達 core/styles.ts——解析器壞了（sanity）');
  const bad = names.filter((n) => n.includes('displayStyles'));
  if (bad.length) errs.push(`匯出路徑引入顯示層：${bad.join(', ')}`);
  return errs;
}
