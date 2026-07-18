// checks/probes/run-probes.mjs — Spec §8.2 bypass-family probes。
// 共 36 probes：既有 33 項＋M4 compose 疊序／reducer 域值／session 轉換表——見各 probe 註解。
// 每 probe：套變異→跑對應驗證→預期非零 exit→原 byte 復原→驗證轉綠。
// 精準性：GATE_ONLY 限定目標 gate；probe 通過=「目標紅」且「復原全綠」。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNamedTests,
  REQUIRED_ARTWORK_E2E,
  REQUIRED_ARTWORK_UNIT,
} from './test-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sh = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: 'pipe', env: { ...process.env, ...env } }).toString();
const shFails = (cmd, env = {}) => { try { sh(cmd, env); return false; } catch { return true; } };
let originals = new Map();
const remember = (rel) => {
  const p = path.join(root, rel);
  if (!originals.has(p)) originals.set(p, readFileSync(p));
  return p;
};
const mutate = (rel, from, to) => {
  const p = remember(rel);
  const t = readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`probe 前置失敗：${rel} 找不到 "${from}"`);
  writeFileSync(p, t.replace(from, to));
};
const append = (rel, text) => {
  const p = remember(rel);
  writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from(text)]));
};
const revert = () => {
  for (const [p, contents] of originals) writeFileSync(p, contents);
  originals = new Map();
};

const EXPECTED_E2E_TOTAL = 60;
const REQUIRED_EDITOR_E2E = [
  'loads the editor chunk only after EDIT and keeps it cached after DONE',
  'EDIT adds an image and text, drags the text, then DONE updates the 3D preview',
  'C1 keeps fixed overlap colors aligned across editor, 2048 source, and 4096 download',
  'C2 square A-1 seed is pixel-identical and remains the non-undoable baseline',
  'C2 A-1 seed centers landscape 2:1 and portrait 1:2 without distortion',
  'C5 downloads a transparent 4096 PNG and disables download for whitespace-only text',
  'C7 keeps stale visible through two parameter changes, preserves coordinates, and clears on DONE',
  'uses a 2x backing store while CSS-center clicks still hit the rendered object',
  'keyboard chain handles duplicate, delete, undo, redo, and the two-stage Escape',
  'zh editor interface matches every visible F7 literal word-for-word',
];

const assertE2eManifest = () => {
  const listing = sh('npx playwright test --list');
  const total = Number(/Total: (\d+) tests? in/.exec(listing)?.[1]);
  if (total !== EXPECTED_E2E_TOTAL) {
    throw new Error(`e2e 總數漂移：expected ${EXPECTED_E2E_TOTAL}, got ${total}`);
  }
  assertNamedTests(listing, REQUIRED_ARTWORK_E2E, 'e2e');
  assertNamedTests(listing, REQUIRED_EDITOR_E2E, 'editor e2e');
};

const assertUnitManifest = () => {
  const listing = sh('npx vitest list tests/fold-ui/artwork-source.test.ts');
  assertNamedTests(listing, REQUIRED_ARTWORK_UNIT, 'unit');
};

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
  { id: 'g2-inheritance-base-drift', gate: 'g2-vocab',
    run: () => mutate('src/styles/vocab.css', 'font-family: "Fraunces", Georgia, serif;', 'font-family: Arial, sans-serif;'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }) },
  { id: 'g2-zh-weight', gate: 'g2-vocab',
    run: () => mutate('src/styles/vocab.css', '.zh .label { font-family: "Familjen Grotesk", "Noto Serif TC", sans-serif; letter-spacing: 0.12em; font-weight: 400; text-transform: none; }', '.zh .label { font-family: "Familjen Grotesk", "Noto Serif TC", sans-serif; letter-spacing: 0.12em; font-weight: 600; text-transform: none; }'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }) },
  { id: 'g2-late-override', gate: 'g2-vocab',
    run: () => append('src/index.css', '\n.masthead .wordmark { font-weight: 900; }\n'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }) },
  // 2026-07-16 M3 T5 常駐化（M2 T4 否證探針的教訓固定下來）：FROZEN_
  // DECLARATION_MANIFEST 的三條 zh weight 凍結項（.zh .boxsel select／.zh .param-select
  // select／.zh .imp-card h4·皆 400）漂移必翻紅。前兩者共用同一條 comma-list 規則——
  // 一次 mutate 同時覆蓋兩個 manifest 項（parseDeclarations 拆解後兩項同時漂移），故兩
  // 循環蓋三項。單 probe 內部逐循環 mutate→紅→復原，全部紅才算目標紅。
  { id: 'g2-frozen-zh-weights', gate: 'g2-vocab',
    run: () => {},
    check: () => {
      const cycles = [
        ['.zh .boxsel select, .zh .param-select select { font-family: "Fraunces", "Noto Serif TC", serif; font-weight: 400; }',
         '.zh .boxsel select, .zh .param-select select { font-family: "Fraunces", "Noto Serif TC", serif; font-weight: 600; }'],
        ['.zh .imp-card h4 { font-family: "Fraunces", "Noto Serif TC", serif; font-weight: 400; }',
         '.zh .imp-card h4 { font-family: "Fraunces", "Noto Serif TC", serif; font-weight: 600; }'],
      ];
      return cycles.every(([from, to]) => {
        try { mutate('src/styles/vocab.css', from, to); return shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g2-vocab' }); }
        finally { revert(); }
      });
    } },
  // — Phase 3 style contract —
  { id: 'p3c-unregistered', gate: 'p3-style',
    run: () => mutate('src/ui/FoldView.tsx', 'className="fold-empty"', 'className="fold-empty fold-rogue"'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style', GATE_SKIP_BUILD: '1' }) },
  { id: 'p3c-value-drift', gate: 'p3-style',
    // 錨字串跟 contract 的 .foldbar 條目走（T10-fix 浮動工具組：五欄→二欄·2026-07-17）
    run: () => mutate('checks/canonical/p3-style-contract.json',
      '"grid-template-columns": "auto minmax(120px, 1fr)"',
      '"grid-template-columns": "auto minmax(121px, 1fr)"'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style', GATE_SKIP_BUILD: '1' }) },
  // re-review N2：object property 誘餌（{ className: '…' }）曾可騙過 transform 後文字掃描
  // ——JSX attribute AST 修後常駐
  { id: 'p3c-object-decoy', gate: 'p3-style',
    run: () => {
      mutate('src/ui/FoldView.tsx', '<canvas className="fold-canvas" ref={canvasRef} hidden={viewMode === \'editor\'} />', '<canvas className="canvas" ref={canvasRef} hidden={viewMode === \'editor\'} />');
      mutate('src/ui/FoldView.tsx', 'export function FoldView(', "const probeDecoy = { className: 'fold-canvas' };\nvoid probeDecoy;\nexport function FoldView(");
    },
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style', GATE_SKIP_BUILD: '1' }) },
  // final review F4：JSX 註解 className 誘餌曾可騙過使用面掃描——AST 只收 JsxAttribute 修後常駐
  { id: 'p3c-comment-decoy', gate: 'p3-style',
    run: () => mutate('src/ui/FoldView.tsx',
      '<canvas className="fold-canvas" ref={canvasRef} hidden={viewMode === \'editor\'} />',
      '<canvas className="canvas" ref={canvasRef} hidden={viewMode === \'editor\'} />{/* className="fold-canvas" */}'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style', GATE_SKIP_BUILD: '1' }) },
  { id: 'p3c-context-leak', gate: 'p3-style',
    run: () => mutate('src/ui/Canvas.tsx', 'className="bench flex-1 h-full"', 'className="bench foldbar flex-1 h-full"'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'p3-style', GATE_SKIP_BUILD: '1' }) },
  // — G3 家族（新違規＋允許值移位·I3）—
  { id: 'g3-new-utility', gate: 'g3-utility', run: () => mutate('src/ui/App.tsx', 'className="', 'className="text-red-500 '),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g3-utility', GATE_SKIP_BUILD: '1' }) },
  // — G4 —
  { id: 'g4-display-import', gate: 'g4-export-isolation',
    run: () => mutate('src/export/svg.ts', "from '@/core/styles'", "from '@/core/styles';\nimport { DISPLAY_LINE_STYLES } from '@/core/displayStyles'"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  { id: 'g4-rename', gate: 'g4-export-isolation',
    run: () => mutate('checks/gates/g4-forbidden.json',
      '"forbidden": ["core/displayStyles", "i18n/", "ui/", "fold/"]', '"forbidden": []'),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  { id: 'g4-fold-import', gate: 'g4-export-isolation',
    run: () => append('src/export/svg.ts', "\nimport '../fold/registry';\n"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  // round 3 R1-A：計算型 dynamic import 曾被靜默略過——fail-loud 修後常駐紅方向
  { id: 'g4-fold-computed', gate: 'g4-export-isolation',
    run: () => append('src/export/svg.ts', "\nvoid import('../fold/' + 'registry');\n"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  // round 3 R1-B：.js specifier（build 解析到 .ts）曾被靜默判綠——解析映射修後常駐紅方向
  { id: 'g4-fold-jsspec', gate: 'g4-export-isolation',
    run: () => append('src/export/svg.ts', "\nvoid import('../fold/registry.js');\n"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  // re-review N3：無替換 template literal specifier 曾可穿越 G4——TS AST 修後常駐紅方向
  { id: 'g4-fold-template', gate: 'g4-export-isolation',
    run: () => append('src/export/svg.ts', "\nvoid import(`../fold/registry`);\n"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
  // final review F5：dynamic import() 曾可靜默穿越 G4——TS AST（前身三分支 regex）修後常駐紅方向
  { id: 'g4-fold-dynamic', gate: 'g4-export-isolation',
    run: () => append('src/export/svg.ts', "\nvoid import('../fold/registry');\n"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }),
    greenCheck: () => !shFails('node checks/style-gate.mjs', { GATE_ONLY: 'g4-export-isolation', GATE_SKIP_BUILD: '1' }) },
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
  { id: 'a2-ci-guard', gate: 'baseline', run: () => {},
    check: () => shFails('npx vitest run tests/export/baseline.test.ts', { CI: '1', BASELINE_WRITE: '1' }) },
  // — A15 copy inventory —
  { id: 'a15-drift', gate: 'a15-copy',
    run: () => mutate('src/i18n/dict.ts', "'chrome.wordmark': { en: 'Open *Dieline*'", "'chrome.wordmark': { en: 'Open *Dielines*'"),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'a15-copy', GATE_SKIP_BUILD: '1' }) },
  // 2026-07-16 T0 retarget：mode.design（Tier A 非 lock·B3 期實證用）→ imp.err.default
  // （B5 家族·本輪逐字化的新覆蓋面）——非 lock 值漂移類覆蓋不變，且常駐驗證附錄 B 消費路徑。
  { id: 'a15-value-drift', gate: 'a15-copy',
    run: () => mutate('src/i18n/dict.ts', "'imp.err.default': { en: 'Calculation error.", "'imp.err.default': { en: 'Calculation drift."),
    check: () => shFails('node checks/style-gate.mjs', { GATE_ONLY: 'a15-copy', GATE_SKIP_BUILD: '1' }) },
  // — Fold look frozen family：任一 FOLD_RECIPES 宣告值漂移都必須被逐欄凍結測試抓到 —
  { id: 'look-frozen-drift', gate: 'fold-look-frozen',
    run: () => mutate('src/ui/fold-scene.ts', 'cardColor: 0x332615', 'cardColor: 0x332616'),
    check: () => shFails('npx vitest run tests/fold-ui/fold-look-frozen.test.ts'),
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/fold-look-frozen.test.ts') },
  // — Fold model / 2D reconciliation —
  { id: 'fold-hinge-break', gate: 'fold-model',
    run: () => mutate('src/fold/models/reverse-tuck-end.ts', 'hingeLine: { a: { x: x1, y: 0 }, b: { x: x1, y: D } }', 'hingeLine: { a: { x: x1 + 1, y: 0 }, b: { x: x1 + 1, y: D } }'),
    check: () => shFails('npx vitest run tests/fold/'),
    greenCheck: () => !shFails('npx vitest run tests/fold/') },
  { id: 'fold-comp-drift', gate: 'fold-reconcile',
    run: () => mutate('tests/fold/rte-reconcile.test.ts', '[0, 1, 1, 2]', '[0, 1, 1, 1]'),
    check: () => shFails('npx vitest run tests/fold/rte-reconcile.test.ts'),
    greenCheck: () => !shFails('npx vitest run tests/fold/') },
  // tuckLock sliced-lid family：分片 hinge 兩端必須留在同一條 parent/child 共邊上。
  { id: 'tucklock-degenerate', gate: 'fold-model-validate',
    run: () => mutate('src/fold/models/reverse-tuck-end.ts',
      'b: { x: hingeSegments[index]![1]!, y: hingeY },',
      'b: { x: hingeSegments[index]![1]!, y: hingeY + 0.5 },'),
    check: () => shFails('npx vitest run tests/fold/rte-model.test.ts -t "預設模型通過 validateFoldModel"'),
    greenCheck: () => !shFails('npx vitest run tests/fold/') },
  // final fix F1：updatePose 從非零回到 0 時若卡在 0.5，獨立 flat oracle 必須翻紅。
  { id: 'fold-reset-stuck', gate: 'fold-reset-reversibility',
    run: () => mutate('src/ui/fold-scene.ts',
      'currentT = Number.isFinite(t) ? t : 0;',
      'currentT = t === 0 && currentT !== 0 ? 0.5 : (Number.isFinite(t) ? t : 0);'),
    check: () => shFails('npm run build:e2e && npx playwright test e2e/fold-mode.spec.ts -g "dragging fold progress to one"'),
    greenCheck: () => !shFails('npm run build:e2e && npx playwright test e2e/fold-mode.spec.ts -g "dragging fold progress to one"') },
  // M3 C1：square frame 的 span 若從長軸 max 漂成短軸 min，C1 同源 fixture 必須翻紅。
  { id: 'c1-alignment-drift', gate: 'c1-artwork-alignment',
    run: () => mutate('src/ui/artwork-layout.ts',
      'const span = Math.max(width, height, Number.EPSILON);',
      'const span = Math.min(width, height);'),
    check: () => shFails('npx vitest run tests/fold-ui/artwork-layout.test.ts'),
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/artwork-layout.test.ts') },
  // M3 F2.1：latest-request-wins 若失效，A/B 反序完成測試必須抓到舊 request commit。
  { id: 'artwork-upload-mutation', gate: 'artwork-upload-transaction',
    run: () => mutate('src/ui/artwork-source.ts',
      'const isCurrent = (): boolean => requestId === latestRequestId && !options.signal?.aborted;',
      'const isCurrent = (): boolean => true;'),
    check: () => shFails('npx vitest run tests/fold-ui/artwork-source.test.ts -t "commits only B when A and B finish in reverse order"'),
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/artwork-source.test.ts') },
  // M4 C1：兩張完全重疊的實色 bitmap 以 array 尾端藍色為固定 oracle；反轉疊序必須翻紅。
  { id: 'm4-compose-layer-order', gate: 'editor-compose-layer-order',
    run: () => append('tests/fold-ui/editor-compose.test.ts', `

it('keeps blue at a fully overlapping fixed-color point', () => {
  type ProbeBitmap = ImageBitmap & { probeColor: 'red' | 'blue' };
  const red = { width: 64, height: 64, probeColor: 'red' } as ProbeBitmap;
  const blue = { width: 64, height: 64, probeColor: 'blue' } as ProbeBitmap;
  let overlapColor = 'transparent';
  const context = {
    save() {},
    translate() {},
    rotate() {},
    drawImage(bitmap: ProbeBitmap) { overlapColor = bitmap.probeColor; },
    restore() {},
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const overlapRegistry = {
    get: (id: string) => ({ bitmap: id === 'red' ? red : blue, width: 64, height: 64 }),
  } as unknown as AssetRegistry;
  composeArtwork({
    selectedId: null,
    objects: [
      { id: 'red', kind: 'image', assetId: 'red', x: 60, y: 45, rotation: 0, widthMm: 40 },
      { id: 'blue', kind: 'image', assetId: 'blue', x: 60, y: 45, rotation: 0, widthMm: 40 },
    ],
  }, layout, 64, { guides: false }, overlapRegistry);
  expect(overlapColor).toBe('blue');
});
`),
    check: () => {
      const command = 'npx vitest run tests/fold-ui/editor-compose.test.ts -t "keeps blue at a fully overlapping fixed-color point"';
      if (shFails(command)) return false;
      mutate('src/ui/editor/editor-compose.ts',
        'for (const object of effectiveObjects(state)) {',
        'for (const object of effectiveObjects(state).reverse()) {');
      return shFails(command);
    },
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/editor-compose.test.ts') },
  // M4 F2：最小尺寸域值由 2mm 漂移至 0 時，既有 reducer 邊界矩陣必須翻紅。
  { id: 'm4-reducer-domain', gate: 'editor-reducer-domain',
    run: () => mutate('src/ui/editor/editor-state.ts',
      'const MIN_SIZE_MM = 2;',
      'const MIN_SIZE_MM = 0;'),
    check: () => shFails('npx vitest run tests/fold-ui/editor-state.test.ts -t "rejects out-of-domain image width"'),
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/editor-state.test.ts') },
  // M4 F1.2：既有 session 的 UPLOAD 分支若改走無 session 條件，轉換表指定案例必須翻紅。
  { id: 'm4-session-upload-transition', gate: 'editor-session-transition',
    run: () => mutate('src/ui/FoldView.tsx',
      'if (session !== null && layout !== null && nextEditableArtwork !== undefined) {',
      'if (session === null && layout !== null && nextEditableArtwork !== undefined) {'),
    check: () => shFails('npx vitest run tests/fold-ui/fold-editor-wiring.test.tsx -t "adds UPLOAD to the top of an existing session"'),
    greenCheck: () => !shFails('npx vitest run tests/fold-ui/fold-editor-wiring.test.tsx') },
];

assertE2eManifest();
assertUnitManifest();
const probeOnly = process.env.PROBE_ONLY;
const selectedProbes = probeOnly === undefined
  ? PROBES
  : PROBES.filter(({ id }) => id === probeOnly);
if (selectedProbes.length === 0) {
  throw new Error(`未知 PROBE_ONLY=${probeOnly}；可用 id：${PROBES.map(({ id }) => id).join(', ')}`);
}

let allOk = true;
const lines = ['## mutation probe 證據（Spec §8.2）', ''];
for (const p of selectedProbes) {
  let redOk = false, greenOk = false;
  try { p.run(); redOk = p.check(); } finally { revert(); }
  greenOk = !shFails('node checks/style-gate.mjs')
    && !shFails('npx vitest run tests/export/baseline.test.ts')
    && (p.greenCheck?.() ?? true);
  const verdict = redOk && greenOk ? 'PASS' : 'FAIL';
  if (verdict === 'FAIL') allOk = false;
  lines.push(`- [${verdict}] ${p.id} → ${p.gate}：目標紅=${redOk}、復原全綠=${greenOk}`);
  console.log(lines[lines.length - 1]);
}
if (probeOnly === undefined) {
  writeFileSync(path.join(root, 'checks/probes/last-run.md'), lines.join('\n') + '\n');
}
process.exit(allOk ? 0 : 1);
