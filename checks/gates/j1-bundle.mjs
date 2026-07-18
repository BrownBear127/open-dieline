import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), '../..');

export function measureBundle(distDir = path.join(root, 'dist')) {
  const assetsDir = path.join(distDir, 'assets');
  const names = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .sort();

  if (names.length === 0) {
    throw new Error(`No JavaScript bundles found in ${assetsDir}; run npm run build first.`);
  }

  const files = names.map((name) => {
    const bytes = gzipSync(readFileSync(path.join(assetsDir, name)), { level: 9 }).length;
    return { file: `dist/assets/${name}`, bytes };
  });

  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function printMeasurement(measurement) {
  console.log('J1 bundle measurement (gzip level 9)');
  for (const file of measurement.files) {
    console.log(`${file.file}\t${file.bytes} bytes`);
  }
  console.log(`TOTAL\t${measurement.totalBytes} bytes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  printMeasurement(measureBundle());
}

// ── J1 gate：動態 import＋雙預算·shrink-only ──
// 主 bundle ≤118,000B（防 fold 代碼漏進主 bundle 的「動態假象」）；
// 全部 JS gzip 總和 ≤265,000B。
// M2 rebudget（一次調整到位）：117,000→118,000／
// 260,000→265,000——覆蓋 M2 production 新功能（卡色切換＋設計稿貼圖＋tuckLock
// ＋loadFailed）；shrink-only 精神不變，新預算仍為硬頂。
// M3 rebudget（一次調整到位）：total 265,000→270,000——
// T2 上傳管線落地後 headroom 僅 66B，覆蓋 T3 overlay＋T5 e2e hook/probes
// （全 lazy chunk·main 118,000 不動）。
// editor chunk 使 total bundle 預算調整為 315,000；main 預算維持 118,000 不變。
// 基準=正式 minified 產物：.gate-dist 是 --minify false 私有建置（G2 需求）、
// gzip 數字失真——本 gate 自跑一次正式 `vite build`（dist/）再量。
// GATE_SKIP_BUILD 時跳過（該 flag 僅配 GATE_ONLY 給純 source gate 的 probe 提速用）。
const MAIN_BUNDLE_BUDGET = 118_000;
const TOTAL_BUDGET = 315_000;

export async function run({ root: gateRoot }) {
  if (process.env.GATE_SKIP_BUILD) {
    console.log('  [j1] SKIP（GATE_SKIP_BUILD·J1 需正式 build 產物）');
    return [];
  }
  const { execSync } = await import('node:child_process');
  execSync('npx vite build', { cwd: gateRoot, stdio: 'pipe' });
  const { files, totalBytes } = measureBundle(path.join(gateRoot, 'dist'));

  const errors = [];
  const main = files.filter((f) => /\/index-[^/]+\.js$/.test(f.file));
  if (main.length !== 1) {
    errors.push(`主 bundle 識別異常：index-*.js 應恰一支，實得 ${main.length}（${main.map((f) => f.file).join(', ') || '無'}）`);
  } else if (main[0].bytes > MAIN_BUNDLE_BUDGET) {
    errors.push(`主 bundle 超標：${main[0].bytes}B > ${MAIN_BUNDLE_BUDGET}B（${main[0].file}）`);
  }
  if (totalBytes > TOTAL_BUDGET) {
    errors.push(`JS gzip 總量超標：${totalBytes}B > ${TOTAL_BUDGET}B`);
  }
  if (!errors.length) {
    const mainBytes = main[0]?.bytes ?? 0;
    console.log(`  [j1] main ${mainBytes}B ≤ ${MAIN_BUNDLE_BUDGET}B／total ${totalBytes}B ≤ ${TOTAL_BUDGET}B（${files.length} 支 JS）`);
  }
  return errors;
}
