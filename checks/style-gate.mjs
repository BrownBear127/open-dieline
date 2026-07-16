// checks/style-gate.mjs — G1-G6 runner；G2/G6 需 build 產物（跑一次 vite build）
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, '.gate-dist');
const needBuild = !process.env.GATE_SKIP_BUILD; // probe 針對純 source gate 時可跳過 build 提速

const GATES = ['g1-parity', 'g2-vocab', 'p3-style', 'g3-utility', 'g4-export-isolation', 'g5-forbidden-words', 'g6-external-urls', 'charset', 'a9-contrast', 'a15-copy', 'j1-bundle'];
const only = process.env.GATE_ONLY ? process.env.GATE_ONLY.split(',') : null;

if (needBuild) {
  rmSync(distDir, { recursive: true, force: true });
  // --minify false（G2 專用需求，Task 4）：CSS minifier（Lightning CSS）做的是結構性重寫
  // （shorthand/longhand 互換、attribute selector 引號剝除、函式名合併如 translateX→translate）
  // ——這些不是「等價值的不同寫法」而是「不同語法路徑達成同渲染」，G2 的 selector+prop+value
  // 三元組比對架構無法合理追蹤。關掉 minify 後仍會跑的是 Lightning CSS 的 target-based 語法
  // 降級（如 ::before→:before、色彩正規化、font-family 引號可省略時剝除）——這類才是 norm()
  // 該吸收的「等價變形」。僅影響本 gate 私有建置產物（.gate-dist），不影響 `npm run build` 的
  // 正式產物（不同的 vite build 呼叫，此 flag 不外溢）。
  execSync(`npx vite build --outDir ${distDir} --emptyOutDir --minify false`, { cwd: root, stdio: 'pipe' });
}

let failed = false;
for (const name of GATES) {
  if (only && !only.includes(name)) continue;
  const modPath = path.join(root, 'checks/gates', `${name}.mjs`);
  if (!existsSync(modPath)) { console.log(`[${name}] SKIP（尚未落地）`); continue; }
  const { run } = await import(modPath);
  const errs = await run({ root, distDir });
  if (errs.length) { failed = true; console.error(`[${name}] FAIL\n  - ${errs.join('\n  - ')}`); }
  else console.log(`[${name}] OK`);
}

// font-gate（py）＋A8 bytes 預算（值=T8 checkpoint 裁定 346,076B，Spec §6.3）
const BUDGET_BYTES = 346076;
execSync(`uvx --from "fonttools[woff]" python3 checks/font-gate.py`, { cwd: root, stdio: 'inherit' });
const totalBytes = readdirSync(path.join(root, 'public/fonts')).filter((f) => f.endsWith('.woff2'))
  .reduce((s, f) => s + statSync(path.join(root, 'public/fonts', f)).size, 0);
if (totalBytes > BUDGET_BYTES) { console.error(`[A8] FAIL fonts ${totalBytes}B > 預算 ${BUDGET_BYTES}B`); process.exit(1); }
console.log(`[A8] OK fonts ${totalBytes}B ≤ ${BUDGET_BYTES}B`);

process.exit(failed ? 1 : 0);
