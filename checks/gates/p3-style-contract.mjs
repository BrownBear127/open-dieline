import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parseDeclarations } from './g2-vocab.mjs';

const CONTRACT_PATH = 'checks/canonical/p3-style-contract.json';
const USAGE_FILES = ['src/ui/FoldView.tsx', 'src/ui/App.tsx'];
const DESIGN_CONTEXT_FILES = ['src/ui/Canvas.tsx'];
const VERBATIM_SOURCE_RE = /^(vocab|tokens)\.css:(\d+) verbatim$/;
const DERIVED_SOURCE_RE = /^derived — .+·簽核=M2 視覺輪$/;
const FOLD_CLASS_RE = /^fold(?:bar|-[a-z0-9-]+)$/;

function read(root, relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

// TS AST 只收「JSX attribute」的 className/type 字面（re-review N2·取代文字掃描）：
// JS/JSX 註解、普通 object property（{ className: '…' }）、無關字串天然不算——
// decoy 族根治。值位收集走白名單節點（string/template/三元/串接），template span 與
// 三元的「條件」表達式不走訪（避免 appMode === 'fold' 的比較值被誤收為 token）。
function collectValueStrings(node, sink) {
  if (node === undefined) return;
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) {
    collectValueStrings(node.expression, sink);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    sink(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    sink(node.head.text);
    for (const span of node.templateSpans) {
      collectValueStrings(span.expression, sink);
      sink(span.literal.text);
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectValueStrings(node.whenTrue, sink);
    collectValueStrings(node.whenFalse, sink);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    collectValueStrings(node.left, sink);
    collectValueStrings(node.right, sink);
  }
}

function extractJsxUsage(root, relativePath) {
  const sourceFile = ts.createSourceFile(
    relativePath, read(root, relativePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const tokens = new Set();
  let rangeInput = false;
  const visit = (node) => {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === 'className') {
        collectValueStrings(node.initializer, (value) => {
          for (const token of value.split(/\s+/)) {
            if (/^[a-z][a-z0-9-]*$/i.test(token)) tokens.add(token);
          }
        });
      } else if (name === 'type') {
        collectValueStrings(node.initializer, (value) => {
          if (value === 'range') rangeInput = true;
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { tokens, rangeInput };
}

function selectorClasses(selector) {
  return [...selector.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((match) => match[1]);
}

function selectorIsUsed(selector, usages) {
  if (selector === 'input[type="range"]') {
    return usages.some(({ rangeInput }) => rangeInput);
  }
  const classes = selectorClasses(selector);
  return classes.length > 0 && usages.some(({ tokens }) => classes.every((className) => tokens.has(className)));
}

function ruleStartingAtLine(css, lineNumber) {
  const lines = css.split('\n');
  if (lineNumber < 1 || lineNumber > lines.length) return null;
  const start = lines.slice(0, lineNumber - 1).reduce((size, line) => size + line.length + 1, 0);
  const open = css.indexOf('{', start);
  if (open === -1) return null;
  const header = css.slice(start, open).trim();
  if (header.length === 0 || header.startsWith('/*') || header.startsWith('@')) return null;
  let depth = 1;
  let end = open + 1;
  while (end < css.length && depth > 0) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
    end++;
  }
  return depth === 0 ? css.slice(start, end) : null;
}

function declarationMap(declarations, selector) {
  const entries = declarations.filter((declaration) => declaration.selector === selector);
  return new Map(entries.map(({ prop, value }) => [prop, value]));
}

function compareExactProps(selector, expected, actual, label, errs) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...actual.keys()];
  for (const prop of expectedKeys) {
    if (!actual.has(prop)) errs.push(`${label}：${selector} 缺少 ${prop}`);
    else if (actual.get(prop) !== expected[prop]) {
      errs.push(`${label}：${selector} { ${prop}: ${actual.get(prop)} }（contract=${expected[prop]}）`);
    }
  }
  for (const prop of actualKeys) {
    if (!Object.hasOwn(expected, prop)) errs.push(`${label}：${selector} 未登錄 ${prop}`);
  }
}

function normalizeBuiltValue(value) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/["']/g, '')
    .trim()
    .toLowerCase();
}

function compareBuiltProps(selector, expected, actual, errs) {
  const expectedKeys = Object.keys(expected);
  const actualKeys = [...actual.keys()];
  for (const prop of expectedKeys) {
    if (!actual.has(prop)) {
      errs.push(`build 缺席：${selector} { ${prop} }`);
      continue;
    }
    if (normalizeBuiltValue(actual.get(prop)) !== normalizeBuiltValue(expected[prop])) {
      errs.push(`build 值漂移：${selector} { ${prop}: ${actual.get(prop)} }（contract=${expected[prop]}）`);
    }
  }
  for (const prop of actualKeys) {
    if (!Object.hasOwn(expected, prop)) errs.push(`build 未登錄宣告：${selector} { ${prop} }`);
  }
}

function loadContract(root, errs) {
  let contract;
  try {
    contract = JSON.parse(read(root, CONTRACT_PATH));
  } catch (error) {
    errs.push(`contract 無法解析：${error.message}`);
    return [];
  }
  if (!Array.isArray(contract)) {
    errs.push('contract 頂層必須是陣列');
    return [];
  }
  return contract;
}

export async function run({ root, distDir }) {
  const errs = [];
  const contract = loadContract(root, errs);
  if (contract.length === 0) errs.push('contract 不可為空（sanity check）');

  const seenSelectors = new Set();
  const usageSources = USAGE_FILES.map((file) => extractJsxUsage(root, file));
  const derivedSelectors = [];

  for (const entry of contract) {
    const { selector, props, source } = entry ?? {};
    if (typeof selector !== 'string' || selector.length === 0) {
      errs.push('contract 條目缺少 selector');
      continue;
    }
    if (seenSelectors.has(selector)) errs.push(`contract selector 重複：${selector}`);
    seenSelectors.add(selector);
    if (props === null || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length === 0) {
      errs.push(`contract props 無效：${selector}`);
      continue;
    }
    if (!selectorIsUsed(selector, usageSources)) errs.push(`src 未使用 selector：${selector}`);

    const verbatim = typeof source === 'string' ? source.match(VERBATIM_SOURCE_RE) : null;
    if (verbatim !== null) {
      const [, fileStem, lineText] = verbatim;
      const sourcePath = `src/styles/${fileStem}.css`;
      const rule = ruleStartingAtLine(read(root, sourcePath), Number(lineText));
      if (rule === null) {
        errs.push(`verbatim 來源行無對應 rule：${selector} → ${source}`);
        continue;
      }
      const declarations = parseDeclarations(rule);
      compareExactProps(selector, props, declarationMap(declarations, selector), 'verbatim 值漂移', errs);
      continue;
    }

    if (typeof source !== 'string' || !DERIVED_SOURCE_RE.test(source)) {
      errs.push(`derived 來源格式無效：${selector}`);
      continue;
    }
    derivedSelectors.push(selector);
  }

  const foldViewClasses = [...usageSources[0].tokens].filter((className) => FOLD_CLASS_RE.test(className));
  for (const className of foldViewClasses) {
    if (!contract.some(({ selector }) => selectorClasses(selector).includes(className))) {
      errs.push(`FoldView 未登錄 derived selector：.${className}`);
    }
  }

  const foldOnlyClasses = new Set(derivedSelectors.flatMap(selectorClasses));
  for (const relativePath of DESIGN_CONTEXT_FILES) {
    const leaked = [...extractJsxUsage(root, relativePath).tokens].filter((className) => foldOnlyClasses.has(className));
    if (leaked.length > 0) errs.push(`design context 洩漏：${relativePath} 使用 ${leaked.map((name) => `.${name}`).join(', ')}`);
  }

  const assetsDir = path.join(distDir, 'assets');
  if (!existsSync(assetsDir)) {
    errs.push('build CSS 目錄不存在（.gate-dist/assets）');
    return errs;
  }
  const cssFiles = readdirSync(assetsDir).filter((file) => file.endsWith('.css'));
  if (cssFiles.length === 0) {
    errs.push('build CSS 不存在（sanity check）');
    return errs;
  }
  const builtDeclarations = parseDeclarations(cssFiles.map((file) => read(root, path.join('.gate-dist/assets', file))).join('\n'));
  for (const selector of derivedSelectors) {
    const entry = contract.find((candidate) => candidate.selector === selector);
    compareBuiltProps(selector, entry.props, declarationMap(builtDeclarations, selector), errs);
  }

  return errs;
}
