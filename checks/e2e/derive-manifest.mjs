import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeclarations } from '../gates/g2-vocab.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vocabPath = path.join(root, 'src/styles/vocab.css');
const tokensPath = path.join(root, 'src/styles/tokens.css');

/**
 * The Playwright baseline only passes selectors that document.querySelectorAll can
 * address in a stable DOM state. Every excluded class is named here and counted;
 * nothing is silently discarded.
 *
 * Classification order matters: scoped rules are reported as scoped even when
 * their inner selector also contains a pseudo-class, and vendor pseudo-elements
 * get their own bucket instead of the generic pseudo-element bucket.
 */
export const EXCLUSION_RULES = [
  {
    category: 'fontFace',
    reason: '@font-face has declarations but no DOM selector; font readiness is asserted separately.',
    matches: (selector) => selector.startsWith('@font-face'),
  },
  {
    category: 'scopedAtRule',
    reason: '@media/@supports and other parseDeclarations scope prefixes are not valid locator selectors.',
    matches: (selector) => selector.includes('|'),
  },
  {
    category: 'vendorPrefixedSelector',
    reason: '::-webkit-*/::-moz-* controls are browser internals; the Chromium thumb is sampled explicitly.',
    matches: (selector) => /::-(?:webkit|moz|ms|o)-/i.test(selector),
  },
  {
    category: 'pseudoElement',
    reason: 'Pseudo-elements cannot be counted as DOM locators; required representatives are sampled explicitly.',
    matches: (selector) => /::[a-z-]+/i.test(selector),
  },
  {
    category: 'pseudoClass',
    reason: ':hover/:focus/:checked and structural states are transient; required hover states are sampled explicitly.',
    matches: (selector) => /:(?!:)[a-z-]+(?:\([^)]*\))?/i.test(selector),
  },
];

function classify(selector) {
  return EXCLUSION_RULES.find((rule) => rule.matches(selector))?.category ?? null;
}

function groupDeclarations(declarations) {
  const grouped = new Map();
  for (const { selector, prop, value } of declarations) {
    const entries = grouped.get(selector) ?? [];
    entries.push({ prop, value });
    grouped.set(selector, entries);
  }
  return grouped;
}

const declarations = parseDeclarations(readFileSync(vocabPath, 'utf8'));
// N3 negative control: model a second same-property declaration on an already-excluded
// selector without touching production CSS. The in-memory duplicate must change the frozen
// per-selector declaration count even though its selector/property identity is unchanged.
if (process.env.OD_N3_MUTATION === '1') {
  const duplicate = declarations.find(
    ({ selector, prop }) => selector === '.btn:hover' && prop === 'background',
  );
  if (!duplicate) throw new Error('OD_N3_MUTATION source declaration not found');
  declarations.push({ ...duplicate });
}
export const allManifest = groupDeclarations(declarations);
const included = [];
const excluded = Object.fromEntries(EXCLUSION_RULES.map(({ category }) => [category, 0]));
// F1（H1）: `classify(selector)` is a pure function of the selector text, so every
// declaration sharing a selector always lands in the same category — grouping by selector
// loses no identity information versus a flat per-declaration list, and is far more
// reviewable. Each entry freezes the selector, category, unique properties, and raw
// declaration count. The count keeps repeated same-property declarations observable.
const excludedSelectors = new Map();

for (const declaration of declarations) {
  const category = classify(declaration.selector);
  if (category === null) {
    included.push(declaration);
    continue;
  }
  excluded[category] += 1;
  let entry = excludedSelectors.get(declaration.selector);
  if (!entry) {
    entry = { selector: declaration.selector, category, props: new Set(), declarationCount: 0 };
    excludedSelectors.set(declaration.selector, entry);
  }
  entry.props.add(declaration.prop);
  entry.declarationCount += 1;
}

export const manifest = groupDeclarations(included);
export const manifestJson = Object.fromEntries(manifest);

// F1（H1）: the frozen-identity counterpart of `manifest` — consumed by
// e2e/vocab-baseline.spec.ts's frozen-exclusion-set test. Any new selector that falls into
// an exclusion bucket (a new @supports rule, a new pseudo-class override, a minifier
// regression that reclassifies a selector) changes this export and must fail that test until
// a human reviews and extends the frozen constant.
export const excludedManifest = [...excludedSelectors.values()]
  .map(({ selector, category, props, declarationCount }) => ({
    selector,
    category,
    props: [...props].sort(),
    declarationCount,
  }))
  .sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));

const tokenDeclarations = parseDeclarations(readFileSync(tokensPath, 'utf8'));
export const tokenValues = Object.fromEntries(
  tokenDeclarations
    .filter(({ selector, prop }) => selector === ':root' && prop.startsWith('--'))
    .map(({ prop, value }) => [prop, value]),
);

export const stats = {
  totalDeclarations: declarations.length,
  includedDeclarations: included.length,
  includedSelectors: manifest.size,
  excludedDeclarations: excluded,
};

function printStats() {
  console.log(`total declarations: ${stats.totalDeclarations}`);
  console.log(`included declarations: ${stats.includedDeclarations}`);
  console.log(`included selectors: ${stats.includedSelectors}`);
  for (const { category, reason } of EXCLUSION_RULES) {
    console.log(`excluded ${category}: ${stats.excludedDeclarations[category]} — ${reason}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printStats();
}
