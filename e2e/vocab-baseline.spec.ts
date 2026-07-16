import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { allManifest, manifest, tokenValues } from '../checks/e2e/derive-manifest.mjs';
import { gotoReady } from './helpers';

interface Declaration {
  prop: string;
  value: string;
}

type BaselineContext = 'design' | 'imposition' | 'modal' | 'zhDesign' | 'zhImposition' | 'zhModal';

// M3 實測 2026-07-16。每個 selector 只在下方 contextFor() 指定的穩定畫面狀態量一次；
// 0 是顯式基線，表示來源保留該語彙但目前穩態 DOM 沒有對應元件。
const EXPECTED_COUNTS = {
  design: {
    'input[type="range"]': 0,
    html: 1,
    body: 1,
    '#root': 1,
    '.app': 1,
    '.masthead': 1,
    '.masthead .wordmark': 1,
    '.masthead .wordmark em': 1,
    '.masthead .meta': 1,
    '.masthead .meta .lang b': 1,
    '.masthead .meta .lang span': 0,
    '.masthead .meta .lang button': 2,
    '.moderow': 1,
    '.moderow .modes': 1,
    '.moderow .modes .k': 1,
    '.mode': 2,
    '.mode.on': 1,
    '.moderow .readout': 1,
    '.moderow .readout b': 1,
    '.moderow .acts': 1,
    '.main': 1,
    '.console': 1,
    '.sect': 7,
    '.sect-head': 7,
    '.sect-head .label': 7,
    '.sect-head .mono': 6,
    '.boxsel': 3,
    '.boxsel select': 3,
    '.param': 14,
    '.param + .param': 9,
    '.param label': 14,
    '.param-head': 13,
    '.param-head label': 13,
    '.param-reset': 0,
    '.param-control': 13,
    '.param-control.is-overridden': 0,
    '.param input[type="number"]': 12,
    '.param-select select': 2,
    '.param input.tick': 0,
    '.param output': 0,
    '.param output small': 0,
    '.group-collapsed': 0,
    '.group-collapsed .n': 0,
    '.layer': 4,
    '.layer .tick': 4,
    '.layer .key': 4,
    '.layer .key.crease': 1,
    '.layer .key.halfcut': 1,
    '.layer .key.dim': 1,
    '.layer .mono': 4,
    '.layer .mono s': 1,
    '.btn': 6,
    '.btn.quiet': 2,
    '.btn.tog.on': 0,
    '.bench': 1,
    '.warnbar': 0,
    '.warnbar .n': 0,
    '.calibrate-bar': 0,
    '.calibrate-bar form': 0,
    '.calibrate-bar input': 0,
    '.calibrate-bar .btn': 0,
    '.calibrate-bar .error': 0,
    '.drawing': 1,
    '.drawing svg': 1,
    '.plate-label': 1,
    '.legend': 1,
    '.zoom': 1,
    '.legend i': 2,
    '.legend .crease-key i': 1,
    '.zoom b': 1,
    '.zoom .zbtn': 2,
    '.zoom .fit': 1,
    '.platebar': 1,
    '.platebar .status': 1,
    '.platebar .status b': 2,
    '.platebar .acts': 1,
    '.platebar .compat': 1,
    '.platebar .compat .tick': 1,
  },
  imposition: {
    '.imp-toolbar': 1,
    '.imp-group': 7,
    '.imp-group .k': 7,
    '.imp-group .row': 7,
    '.imp-group .mono.val': 0,
    '.imp-results': 1,
    '.imp-card': 2,
    '.imp-card .best': 1,
    '.imp-card h4': 2,
    '.imp-card h4 em': 0,
    '.imp-card .sub': 4,
    '.imp-card .sheet': 2,
    '.imp-card .sheet svg': 2,
    '.imp-stats': 2,
    '.imp-stats div': 4,
    '.imp-stats div + div': 2,
    '.imp-stats .k': 4,
    '.imp-stats .v': 4,
    '.imp-stats .v small': 2,
    '.imp-group input[type="number"]': 2,
    '.imp-toolbar .err': 0,
  },
  modal: {
    '.modal-mask': 1,
    '.modal-card': 1,
    '.modal-card h2': 1,
    '.modal-body': 1,
  },
  zhDesign: {
    '.zh .label': 16,
    '.zh .mono': 32,
    '.zh .boxsel select': 3,
    '.zh .param-select select': 2,
  },
  zhImposition: {
    '.zh .imp-card h4': 2,
  },
  zhModal: {
    '.zh .modal-card h2': 1,
    '.zh .modal-body': 1,
    '.zh-note p b': 0,
  },
} as const satisfies Record<BaselineContext, Record<string, number>>;

// These properties cannot be normalized without masking an intentional browser
// behavior. Every other included declaration is compared; there is no implicit skip.
const SKIPPED = [
  {
    prop: 'transition',
    reason: 'A transition is time-dependent; transition is disabled while measuring final computed values.',
  },
  {
    prop: 'appearance',
    reason: 'The later @supports(base-select) rule intentionally overrides the fallback appearance in Chromium.',
  },
  {
    prop: '-webkit-appearance',
    reason: 'Chromium aliases this fallback to appearance, which the intentional @supports override replaces.',
  },
  {
    selector: '.param label',
    prop: 'margin-bottom',
    reason: 'Every current parameter label is inside .param-head, whose explicit margin-bottom: 0 override is tested separately.',
  },
] as const;

// Shorthands are checked through explicit representative longhands. Insets expand
// to all four sides; border shorthands expand to width/style/color for that side;
// font and flex expand to the minimum behavior-bearing set used by this vocabulary.
const SHORTHAND_EXPANSIONS: Record<string, readonly string[]> = {
  background: ['background-color'],
  border: ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  font: ['font-family', 'font-size', 'font-style', 'font-weight', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
};

// The first .mode is intentionally also .mode.on. Use the inactive peer when
// validating the base rule so the state-specific override is not mistaken for drift.
const REPRESENTATIVE_INDEX: Readonly<Record<string, number>> = {
  '.mode': 1,
};

const PSEUDO_SAMPLES = [
  { selector: '.drawing', pseudo: '::before', properties: ['content', 'color', 'width', 'height', 'border-top-color'] },
  { selector: '.drawing', pseudo: '::after', properties: ['content', 'color', 'width', 'height', 'border-top-color'] },
  { selector: '.drawing .rb', pseudo: '::before', properties: ['content', 'color', 'width', 'height', 'border-bottom-color'] },
  { selector: '.drawing .rb', pseudo: '::after', properties: ['content', 'color', 'width', 'height', 'border-bottom-color'] },
  { selector: '.boxsel', pseudo: '::after', properties: ['content', 'color', 'font-size'] },
] as const;

const HOVER_SAMPLES = [
  {
    name: 'slider thumb',
    elementSelector: '[data-testid="slider-thumb-probe"]',
    sourceSelector: 'input[type="range"]::-webkit-slider-thumb:hover',
    properties: ['background-color', 'border-top-color', 'transform'],
  },
  {
    name: 'button reverse',
    elementSelector: '.moderow .acts .btn:first-child',
    sourceSelector: '.btn:hover',
    properties: ['background-color', 'color'],
  },
] as const;

function contextFor(selector: string): BaselineContext {
  if (selector.startsWith('.zh .imp-')) return 'zhImposition';
  if (selector.startsWith('.zh .modal-') || selector.startsWith('.zh-note')) return 'zhModal';
  if (selector.startsWith('.zh ')) return 'zhDesign';
  if (selector.startsWith('.imp-')) return 'imposition';
  if (selector.startsWith('.modal-')) return 'modal';
  return 'design';
}

async function prepareContext(page: Page, context: BaselineContext): Promise<void> {
  const zh = context.startsWith('zh');
  await gotoReady(page, { lang: zh ? 'zh' : 'en' });

  if (context === 'imposition' || context === 'zhImposition') {
    await page.locator('.mode').filter({ hasText: zh ? '拼版估算' : 'Imposition' }).click();
  }
  if (context === 'modal' || context === 'zhModal') {
    await page.locator('.moderow .acts .btn').first().click();
  }
}

async function computedMismatches(
  page: Page,
  selector: string,
  declarations: readonly Declaration[],
  onlyProperties?: readonly string[],
): Promise<string[]> {
  return page.locator(selector).nth(REPRESENTATIVE_INDEX[selector] ?? 0).evaluate(
    (element, args) => {
      const target = element as HTMLElement | SVGElement;
      const skipped = new Set<string>(args.skippedProperties);
      const requested = args.onlyProperties ? new Set(args.onlyProperties) : null;

      function resolveTokens(raw: string): string {
        let value = raw;
        for (let pass = 0; pass < 10 && value.includes('var('); pass += 1) {
          value = value.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => {
            const token = args.tokens[name];
            if (token === undefined) throw new Error(`Unknown token ${name}`);
            return token;
          });
        }
        if (value.includes('var(')) throw new Error(`Unresolved token in ${raw}`);
        return value;
      }

      const mismatches: string[] = [];
      const oldTransition = target.style.getPropertyValue('transition');
      const oldTransitionPriority = target.style.getPropertyPriority('transition');
      target.style.setProperty('transition', 'none', 'important');

      for (const declaration of args.declarations) {
        if (skipped.has(declaration.prop)) continue;
        const properties = args.expansions[declaration.prop] ?? [declaration.prop];
        const checkedProperties = requested ? properties.filter((property) => requested.has(property)) : properties;
        if (checkedProperties.length === 0) continue;

        const actualStyle = getComputedStyle(target);
        const actual = Object.fromEntries(
          checkedProperties.map((property) => [property, actualStyle.getPropertyValue(property).trim()]),
        );
        const oldValue = target.style.getPropertyValue(declaration.prop);
        const oldPriority = target.style.getPropertyPriority(declaration.prop);
        target.style.setProperty(declaration.prop, resolveTokens(declaration.value), 'important');
        const expectedStyle = getComputedStyle(target);

        for (const property of checkedProperties) {
          const expected = expectedStyle.getPropertyValue(property).trim();
          if (actual[property] !== expected) {
            mismatches.push(
              `${declaration.prop} (${property}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual[property])}`,
            );
          }
        }

        if (oldValue) target.style.setProperty(declaration.prop, oldValue, oldPriority);
        else target.style.removeProperty(declaration.prop);
      }

      if (oldTransition) target.style.setProperty('transition', oldTransition, oldTransitionPriority);
      else target.style.removeProperty('transition');
      return mismatches;
    },
    {
      declarations,
      expansions: SHORTHAND_EXPANSIONS,
      skippedProperties: SKIPPED.filter((entry) => !('selector' in entry) || entry.selector === selector).map(({ prop }) => prop),
      tokens: tokenValues,
      onlyProperties,
    },
  );
}

test.describe('machine-derived vocabulary baseline', () => {
  for (const context of Object.keys(EXPECTED_COUNTS) as BaselineContext[]) {
    test(`${context}: exact counts and computed declarations`, async ({ page }) => {
      await prepareContext(page, context);

      const expectedCounts: Record<string, number> = EXPECTED_COUNTS[context];
      for (const [selector, declarations] of manifest as Map<string, Declaration[]>) {
        if (contextFor(selector) !== context) continue;
        const expectedCount = expectedCounts[selector];
        expect(expectedCount, `Missing frozen count for ${selector}`).not.toBeUndefined();
        await expect(page.locator(selector), `${selector} count`).toHaveCount(expectedCount!);

        if (expectedCount! > 0) {
          const mismatches = await computedMismatches(page, selector, declarations);
          expect(mismatches, `${selector} computed declarations`).toEqual([]);
        }
      }

      const assignedSelectors = [...manifest.keys()].filter((selector) => contextFor(selector) === context);
      expect(Object.keys(expectedCounts).sort(), `${context} count table coverage`).toEqual(assignedSelectors.sort());
    });
  }
});

test('explicit pseudo-element samples', async ({ page }) => {
  await gotoReady(page);

  for (const sample of PSEUDO_SAMPLES) {
    const declarations = allManifest.get(`${sample.selector}${sample.pseudo}`) as Declaration[] | undefined;
    expect(declarations, `Missing source declarations for ${sample.selector}${sample.pseudo}`).toBeDefined();

    const mismatches = await page.locator(sample.selector).first().evaluate(
      (element, args) => {
        const host = element as HTMLElement;
        const actual = getComputedStyle(host, args.pseudo);
        const probe = document.createElement('span');
        probe.style.setProperty('transition', 'none', 'important');
        for (const { prop, value } of args.declarations) {
          const resolved = value.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => args.tokens[name]!);
          probe.style.setProperty(prop, resolved, 'important');
        }
        host.append(probe);
        const expected = getComputedStyle(probe);
        const failures = args.properties.flatMap((property) => {
          const actualValue = actual.getPropertyValue(property).trim();
          const expectedValue = expected.getPropertyValue(property).trim();
          return actualValue === expectedValue ? [] : [`${property}: expected ${expectedValue}, got ${actualValue}`];
        });
        probe.remove();
        return failures;
      },
      { pseudo: sample.pseudo, properties: sample.properties, declarations: declarations!, tokens: tokenValues },
    );

    expect(mismatches, `${sample.selector}${sample.pseudo}`).toEqual([]);
  }
});

test('explicit hover samples', async ({ page }) => {
  await gotoReady(page);

  // Chromium exposes no computed-style handle for its user-agent range thumb.
  // Build a measurable surrogate from the machine-parsed base and hover rules;
  // this keeps the selector/value source authoritative and exercises a real hover.
  const sliderBase = allManifest.get('input[type="range"]::-webkit-slider-thumb') as Declaration[];
  const sliderHover = allManifest.get(HOVER_SAMPLES[0].sourceSelector) as Declaration[];
  await page.evaluate(
    ({ base, hover }) => {
      const resolve = (value: string) => value.replace(/var\((--[\w-]+)\)/g, (_match, name: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      );
      const probe = document.createElement('span');
      probe.dataset.testid = 'slider-thumb-probe';
      for (const { prop, value } of base) probe.style.setProperty(prop, resolve(value));
      Object.assign(probe.style, { position: 'fixed', left: '100px', top: '100px', display: 'block' });
      const style = document.createElement('style');
      style.textContent = `[data-testid="slider-thumb-probe"]:hover { ${hover
        .map(({ prop, value }) => `${prop}: ${resolve(value)} !important;`)
        .join(' ')} }`;
      document.head.append(style);
      document.body.append(probe);
    },
    { base: sliderBase, hover: sliderHover },
  );

  for (const sample of HOVER_SAMPLES) {
    const declarations = allManifest.get(sample.sourceSelector) as Declaration[] | undefined;
    expect(declarations, `Missing hover source ${sample.sourceSelector}`).toBeDefined();
    await page.hover(sample.elementSelector);
    await page.waitForTimeout(200);
    const mismatches = await computedMismatches(page, sample.elementSelector, declarations!, sample.properties);
    expect(mismatches, sample.name).toEqual([]);
  }
});
