// checks/gates/g4-export-isolation.mjs — G4：export/ 依賴圖禁入顯示層（Spec §5/§8.1）
// 自寫 BFS 不用 madge（madge 空心 gate 前科——見 memory）；sanity：走訪數>0 且含 core/styles
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const INTERNAL_SPEC_RE = /^(?:@\/|\.)/;

function resolveImport(from, spec, root) {
  let base = spec.startsWith('@/') ? path.join(root, 'src', spec.slice(2))
    : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null; // 外部套件
  // .js/.jsx specifier 對齊 TypeScript/Vite 解析（round 3 R1-B：import('./x.js') 會被
  // build 解析到 x.ts·gate 不能靜默當無法解析）
  const jsStripped = /\.(js|jsx)$/.test(base) ? base.replace(/\.(js|jsx)$/, '') : null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  if (jsStripped !== null) candidates.push(`${jsStripped}.ts`, `${jsStripped}.tsx`);
  for (const cand of candidates) {
    if (existsSync(cand) && !cand.endsWith(path.sep)) try { if (readFileSync(cand)) return cand; } catch { /* dir */ }
  }
  return null;
}


// TS AST 取真 import 面（re-review N3·取代 regex）：static import／re-export／dynamic
// import()，specifier 接受 string literal 與「無替換 template literal」；註解與一般字串
// 天然不算——regex 版兩反例（import(`…`) 假綠、// import('…') 假紅）同時根治。
function importSpecifiers(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs = [];
  const specText = (node) => (
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text : null
  );
  const nonLiteralDynamicImports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = specText(node.moduleSpecifier);
      if (spec !== null) specs.push(spec);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = specText(node.arguments[0]);
      if (spec !== null) specs.push(spec);
      // round 3 R1-A：非字面參數的 import() 無法靜態驗證——fail-loud 不得靜默略過
      //（import('../fold/' + 'registry') 在正式 build 真的會把 fold chunk 接進來）
      else nonLiteralDynamicImports.push(node.getText(sourceFile).slice(0, 60));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specs, nonLiteralDynamicImports };
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
  const loudErrs = [];
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    const { specs, nonLiteralDynamicImports } = importSpecifiers(text, file);
    for (const snippet of nonLiteralDynamicImports) {
      loudErrs.push(`非字面 dynamic import（G4 無法靜態驗證·fail-loud）：${path.relative(root, file)} → ${snippet}`);
    }
    for (const spec of specs) {
      const next = resolveImport(file, spec, root);
      if (next) queue.push(next);
      // round 3 R1：internal specifier（./ 或 @/）解析失敗＝gate 解析器與 build 不對齊，
      // 必須報錯不得靜默當外部套件跳過（.css 等真實存在的資產檔會被上面解析吸收）
      else if (INTERNAL_SPEC_RE.test(spec)) {
        loudErrs.push(`無法解析的 internal specifier（fail-loud）：${path.relative(root, file)} → ${spec}`);
      }
    }
  }
  const errs = [...loudErrs];
  if (forbidden.length === 0) errs.push('g4-forbidden.json forbidden 清單不可為空（sanity）');
  const names = [...visited].map((f) => path.relative(root, f).split(path.sep).join('/'));
  if (names.length < 3) errs.push(`BFS 僅走訪 ${names.length} 檔——gate 疑似空心（sanity）`);
  if (!names.some((n) => n.includes('core/styles'))) errs.push('BFS 未達 core/styles.ts——解析器壞了（sanity）');
  const bad = names.filter((name) => forbidden.some((fragment) => name.includes(fragment)));
  if (bad.length) errs.push(`匯出路徑引入顯示層：${bad.join(', ')}`);
  return errs;
}
