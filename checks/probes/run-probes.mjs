// checks/probes/run-probes.mjs — Spec §8.2 bypass-family probes。
// 每 probe：套變異→跑對應驗證→預期非零 exit→git 復原→驗證轉綠。
// 精準性：GATE_ONLY 限定目標 gate；probe 通過=「目標紅」且「復原全綠」。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sh = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'pipe', env: { ...process.env, ...env } }).toString();
const shFails = (cmd, env = {}) => { try { sh(cmd, env); return false; } catch { return true; } };
const mutate = (rel, from, to) => {
  const p = path.join(root, rel);
  const t = readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`probe 前置失敗：${rel} 找不到 "${from}"`);
  writeFileSync(p, t.replace(from, to));
};
// index.html 進 revert 範圍——g6-external-url probe 改塞 index.html（見下方註記），
// 原「git checkout -- src tests checks/canonical」涵蓋不到 repo root 的 index.html。
const revert = () => sh('git checkout -- src tests checks/canonical index.html');

const PROBES = [
  // — G1 家族 —
  { id: 'g1-value-drift', gate: 'g1-parity', run: () => mutate('src/styles/tokens.css', '#C93A2B', '#C93A2C'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g1-parity', GATE_SKIP_BUILD: '1' }) },
  // 對齊修正：原稿 from/to 皆為 '--paper'（no-op replace，改不動任何 byte，probe 恆綠不起）。
  // 改動 vendored canonical 的實際值，模擬「vendored 副本本身被竄改」——G1 除比對
  // src↔canonical byte-identical，也比對 canonical↔manifest.json sha256，任何單 byte
  // 差異都會讓兩條檢查同時紅。
  { id: 'g1-vendored-tamper', gate: 'g1-parity',
    run: () => mutate('checks/canonical/tokens.css', '--paper: #FAF7F0;', '--paper: #FAF7F1;'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g1-parity', GATE_SKIP_BUILD: '1' }) },
  // — G2 家族（值漂移＋後置覆寫·C4）—
  // 對齊修正（雙重）：① 原稿目標字串 'letter-spacing: 0.16em' 在 vocab.css 現況找不到
  // （.label 規則已非該值）。② 更根本的問題——單純把某條宣告的值原地改掉（不管改哪條）
  // 對 G2 恆綠不起：G2 的 manifest 直接讀 src/styles/vocab.css 本檔（不像 G1 有獨立的
  // vendored canonical 可比對），改了源檔＝manifest 跟著變、build 也吃同一份源檔＝built
  // 跟著變，兩邊永遠自洽、沒有漂移可言（手測驗證過：改 letter-spacing 0.015em→0.02em，
  // G2 仍 OK；改成非法單位 0.015emx 讓 Lightning CSS 靜默丟棄的假設也測過，--minify false
  // 下無效地聲明照樣原樣序列化通過）。改用「同一 rule 內插入第二條同屬性異值宣告」——
  // 這會讓 manifest 端出現兩筆同 selector+prop 記錄（parseDeclarations 不去重複），built
  // 端 cascade 只留最後一筆，第一筆（凍結值）就跟 built 最終值對不上，同時觸發「值漂移」
  // 與「同 selector 重複宣告含異值」兩條錯誤——這是真實、與 g2-late-override 不同的注入
  // 管道（同一 rule 內部影子覆寫，非另一條規則後置覆寫），手測已確認能可靠翻紅。
  { id: 'g2-value-drift', gate: 'g2-vocab',
    run: () => mutate('src/styles/vocab.css', 'letter-spacing: 0.015em;', 'letter-spacing: 0.015em;\n    letter-spacing: 0.5em;'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }) },
  { id: 'g2-late-override', gate: 'g2-vocab',
    run: () => appendFileSync(path.join(root, 'src/index.css'), '\n.masthead .wordmark { font-weight: 900; }\n'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }) },
  // — G3 家族（新違規＋允許值移位·I3）—
  { id: 'g3-new-utility', gate: 'g3-utility', run: () => mutate('src/ui/App.tsx', 'className="', 'className="text-red-500 '),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g3-utility', GATE_SKIP_BUILD: '1' }) },
  // — G4 —
  { id: 'g4-display-import', gate: 'g4-export-isolation',
    run: () => mutate('src/export/svg.ts', "from '@/core/styles'", "from '@/core/styles';\nimport { DISPLAY_LINE_STYLES } from '@/core/displayStyles'"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  // — G5 —
  { id: 'g5-literal', gate: 'g5-forbidden-words', run: () => mutate('src/ui/App.tsx', 'export', "export const _x = 'open-source';\nexport"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g5-forbidden-words', GATE_SKIP_BUILD: '1' }) },
  // — G6 —
  // 對齊修正：原稿塞 App.tsx 頂層 export——該檔第一個 'export' 命中點其實落在檔頭
  // docblock「facade re-export」註解裡，就算命中真代碼行也可能被 Rollup 當未使用具名
  // 匯出搖掉，build 產物拿不到這條 URL、G6 紅不起來。改用 T6 已驗證過的可靠方法：
  // 塞進 index.html（Vite 原樣複製進 dist，不經 tree-shaking／comment-stripping）。
  { id: 'g6-external-url', gate: 'g6-external-urls',
    run: () => mutate('index.html', '</head>', '<!-- probe: https://example.invalid/tracker.js --></head>'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g6-external-urls' }) },
  // — A2 基線家族（拆層洩漏模擬：改匯出色必被基線抓）—
  { id: 'a2-export-color-leak', gate: 'baseline', run: () => mutate('src/core/styles.ts', "cut: { stroke: '#000000'", "cut: { stroke: '#C93A2B'"),
    check: () => shFails('npx vitest run tests/export/baseline.test.ts') },
];

let allOk = true;
const lines = ['## mutation probe 證據（Spec §8.2）', ''];
for (const p of PROBES) {
  let redOk = false, greenOk = false;
  try { p.run(); redOk = p.check(); } finally { revert(); }
  greenOk = !shFails('node checks/style-gate.mjs') && !shFails('npx vitest run tests/export/baseline.test.ts');
  const verdict = redOk && greenOk ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') allOk = false;
  lines.push(`- [${verdict}] ${p.id} → ${p.gate}：目標紅=${redOk}、復原全綠=${greenOk}`);
  console.log(lines[lines.length - 1]);
}
writeFileSync(path.join(root, 'checks/probes/last-run.md'), lines.join('\n') + '\n');
process.exit(allOk ? 0 : 1);
