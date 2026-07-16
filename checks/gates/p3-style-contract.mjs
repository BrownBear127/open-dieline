import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
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

function readUsageSource(root, relativePath) {
  // 使用面掃描前先過 esbuild jsx transform（final review F4）：JSX/JS 註解裡的
  // className 誘餌會被剝除，真使用以 `className: "…"` 屬性形式保留。
  // 實測陷阱：jsx:'preserve' 不剝 JSX expression container 註解——必須完整 transform；
  // 因此 token regex 同時吃 `=`（原始 JSX）與 `:`（transform 後屬性）兩形。
  return transformSync(read(root, relativePath), { loader: 'tsx', jsx: 'automatic' }).code;
}

function extractClassTokens(source) {
  const tokens = new Set();
  for (const match of source.matchAll(/className\s*[:=]\s*\{?\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    for (const token of value.split(/\s+/)) {
      if (/^[a-z][a-z0-9-]*$/i.test(token)) tokens.add(token);
    }
  }
  return tokens;
}

function selectorClasses(selector) {
  return [...selector.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((match) => match[1]);
}

function selectorIsUsed(selector, usageSources) {
  if (selector === 'input[type="range"]') {
    return usageSources.some((source) => /type\s*[:=]\s*["']range["']/.test(source));
  }
  const classes = selectorClasses(selector);
  return classes.length > 0 && usageSources.some((source) => {
    const tokens = extractClassTokens(source);
    return classes.every((className) => tokens.has(className));
  });
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
  const usageSources = USAGE_FILES.map((file) => readUsageSource(root, file));
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

  const foldViewClasses = [...extractClassTokens(usageSources[0])].filter((className) => FOLD_CLASS_RE.test(className));
  for (const className of foldViewClasses) {
    if (!contract.some(({ selector }) => selectorClasses(selector).includes(className))) {
      errs.push(`FoldView 未登錄 derived selector：.${className}`);
    }
  }

  const foldOnlyClasses = new Set(derivedSelectors.flatMap(selectorClasses));
  for (const relativePath of DESIGN_CONTEXT_FILES) {
    const leaked = [...extractClassTokens(readUsageSource(root, relativePath))].filter((className) => foldOnlyClasses.has(className));
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
