// checks/style-gate.mjs — G1-G6 runner；G2/G6 需 build 產物（跑一次 vite build）
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, '.gate-dist');
const needBuild = !process.env.GATE_SKIP_BUILD; // probe 針對純 source gate 時可跳過 build 提速

const GATES = ['g1-parity', 'g2-vocab', 'g3-utility', 'g4-export-isolation', 'g5-forbidden-words', 'g6-external-urls'];
const only = process.env.GATE_ONLY ? process.env.GATE_ONLY.split(',') : null;

if (needBuild) {
  rmSync(distDir, { recursive: true, force: true });
  execSync(`npx vite build --outDir ${distDir} --emptyOutDir`, { cwd: root, stdio: 'pipe' });
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
process.exit(failed ? 1 : 0);
