import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { manifest, tokenValues } from '../checks/e2e/derive-manifest.mjs';
import { parseDeclarations } from '../checks/gates/g2-vocab.mjs';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { resolveParams } from '../src/core/registry';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

interface Declaration {
  prop: string;
  value: string;
}

interface SourceDeclaration extends Declaration {
  selector: string;
}

const tokenDeclarations = parseDeclarations(
  readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
) as SourceDeclaration[];

// F6（I2）: `.warnbar` and `.warnbar .n` are now compared on every declared longhand from
// every selector that actually matches the live element, in EN and zh, instead of the 2
// hand-picked properties this test previously checked. Canvas.tsx renders
// `<div className="warnbar mono">`, so the real `.warnbar` element's computed style is
// governed by BOTH `.warnbar` (vocab.css) AND `.mono` (tokens.css) — plus `.zh .mono` in the
// zh fixture, which has higher specificity and wins the font-family cascade there.
// `.warnbar .n` (the `<span className="n">`) only ever carries its own declared `color`.
const WARNBAR_SHORTHAND_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
};

const WARNBAR_TARGETS: readonly { name: string; selector: string; sourceSelectors: Record<Language, readonly string[]> }[] = [
  { name: '.warnbar', selector: '.warnbar', sourceSelectors: { en: ['.warnbar', '.mono'], zh: ['.warnbar', '.mono', '.zh .mono'] } },
  { name: '.warnbar .n', selector: '.warnbar .n', sourceSelectors: { en: ['.warnbar .n'], zh: ['.warnbar .n'] } },
];

function declarationsFor(selector: string): Declaration[] {
  if (selector === '.mono' || selector === '.label') {
    return tokenDeclarations.filter(({ selector: s }) => s === selector) as Declaration[];
  }
  const declarations = manifest.get(selector) as Declaration[] | undefined;
  if (!declarations) throw new Error(`Missing ${selector} in derived vocabulary manifest`);
  return declarations;
}

// `sourceSelectors` lists selectors in ascending cascade priority (base first, `.zh .mono`
// override last). Merging by property — keeping only the last declaration per prop — avoids
// checking a shadowed declaration (e.g. plain `.mono`'s font-family in the zh fixture, where
// `.zh .mono` actually wins) against the real element's actual computed value, which would
// always mismatch since that declaration never determines the final rendered style there.
function mergeDeclarations(selectors: readonly string[]): Declaration[] {
  const merged = new Map<string, Declaration>();
  for (const selector of selectors) {
    for (const declaration of declarationsFor(selector)) merged.set(declaration.prop, declaration);
  }
  return [...merged.values()];
}

// Sets each declaration directly on the real target element (temporarily, `!important`),
// reading back the expanded longhands the browser resolves it into — the same technique
// e2e/vocab-baseline.spec.ts uses for real (non-pseudo) elements. `.warnbar`/`.warnbar .n`
// are always-real DOM nodes here (the invariant fixture below renders them through the
// public UI), so setting inline style directly on them — rather than a detached probe span —
// is both simpler and immune to the layout-context divergence a probe span can have.
async function computedMismatches(locator: Locator, declarations: readonly Declaration[]): Promise<string[]> {
  return locator.evaluate(
    (element, args) => {
      const target = element as HTMLElement;
      const mismatches: string[] = [];

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

      for (const declaration of args.declarations) {
        const properties = args.expansions[declaration.prop] ?? [declaration.prop];
        const actualStyle = getComputedStyle(target);
        const actual = Object.fromEntries(properties.map((property) => [property, actualStyle.getPropertyValue(property).trim()]));
        const oldValue = target.style.getPropertyValue(declaration.prop);
        const oldPriority = target.style.getPropertyPriority(declaration.prop);
        target.style.setProperty(declaration.prop, resolveTokens(declaration.value), 'important');
        const expectedStyle = getComputedStyle(target);
        for (const property of properties) {
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
      return mismatches;
    },
    { declarations, expansions: WARNBAR_SHORTHAND_EXPANSIONS, tokens: tokenValues },
  );
}

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key]));
}

const LANGUAGES: readonly Language[] = ['en', 'zh'];

for (const lang of LANGUAGES) {
  test(`real tuck-lock invariant failure shows the manifest-styled warnbar (${lang} fixture) and clears after reset`, async ({ page }) => {
    await gotoReady(page, { lang });

    const tuckLock = reverseTuckEnd.params.find((param) => param.key === 'tuckLock');
    expect(tuckLock).toBeDefined();
    const input = page.locator('#param-tuckLock');
    await expect(input).toHaveValue(String(tuckLock!.default));

    await input.fill('2');

    const warnbar = page.locator('.warnbar');
    await expect(warnbar).toHaveCount(1);
    await expect(warnbar).toBeVisible();

    for (const target of WARNBAR_TARGETS) {
      const declarations = mergeDeclarations(target.sourceSelectors[lang]);
      const mismatches = await computedMismatches(page.locator(target.selector), declarations);
      expect(mismatches, `${target.name} (${lang}) full declared computed style`).toEqual([]);
    }

    const fixtureParams = resolveParams(reverseTuckEnd, { tuckLock: 2 });
    const fixtureResult = reverseTuckEnd.generate(fixtureParams);
    const fixtureWarnings = reverseTuckEnd.invariants.flatMap((invariant) => {
      const result = invariant.check(fixtureParams, fixtureResult);
      return result.ok ? [] : [{ id: invariant.id, message: result.message[lang] }];
    });
    const tuckLockWarning = fixtureWarnings.find(({ id }) => id === 'tuck-lock-fits');
    expect(tuckLockWarning, 'fixture must specifically fail tuck-lock-fits').toBeDefined();
    await expect(warnbar).toContainText(tuckLockWarning!.message);

    const failed = fixtureWarnings.length;
    const passed = reverseTuckEnd.invariants.length - failed;
    const checksText = format(dict['canvas.checks'][lang], { p: passed, f: failed });
    await expect(warnbar.locator('.n')).toHaveText(checksText);

    await input.fill(String(tuckLock!.default));
    await expect(warnbar).toHaveCount(0);
    await expect(input).toHaveValue(String(tuckLock!.default));
  });
}
