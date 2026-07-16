import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { manifest, tokenValues } from '../checks/e2e/derive-manifest.mjs';
import { parseDeclarations } from '../checks/gates/g2-vocab.mjs';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { resolveParams } from '../src/core/registry';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

interface Declaration {
  prop: string;
  value: string;
}

interface SourceDeclaration extends Declaration {
  selector: string;
}

const WARNBAR_STYLE_CHECKS = [
  { sourceSelector: '.warnbar', property: 'color' },
  { sourceSelector: '.mono', property: 'font-family' },
] as const;

const tokenDeclarations = parseDeclarations(
  readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
) as SourceDeclaration[];

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key]));
}

function sourceDeclaration(sourceSelector: string, property: string): Declaration {
  const declarations = sourceSelector === '.mono'
    ? (tokenDeclarations.filter(({ selector }) => selector === sourceSelector) as Declaration[])
    : (manifest.get(sourceSelector) as Declaration[] | undefined);
  const declaration = declarations?.find(({ prop }) => prop === property);
  if (!declaration) throw new Error(`Missing ${sourceSelector} ${property} in derived vocabulary manifest`);
  return declaration;
}

async function expectedComputedValue(page: Page, declaration: Declaration): Promise<string> {
  return page.evaluate(
    ({ prop, value, tokens }) => {
      const resolved = value.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => {
        const token = tokens[name];
        if (token === undefined) throw new Error(`Unknown token ${name}`);
        return token;
      });
      const probe = document.createElement('span');
      probe.style.setProperty(prop, resolved, 'important');
      document.body.append(probe);
      const normalized = getComputedStyle(probe).getPropertyValue(prop).trim();
      probe.remove();
      return normalized;
    },
    { ...declaration, tokens: tokenValues },
  );
}

test('real tuck-lock invariant failure shows the manifest-styled warnbar and clears after reset', async ({ page }) => {
  await gotoReady(page);

  const tuckLock = reverseTuckEnd.params.find((param) => param.key === 'tuckLock');
  expect(tuckLock).toBeDefined();
  const input = page.locator('#param-tuckLock');
  await expect(input).toHaveValue(String(tuckLock!.default));

  await input.fill('2');

  const warnbar = page.locator('.warnbar');
  await expect(warnbar).toHaveCount(1);
  await expect(warnbar).toBeVisible();

  for (const check of WARNBAR_STYLE_CHECKS) {
    const declaration = sourceDeclaration(check.sourceSelector, check.property);
    const expectedValue = await expectedComputedValue(page, declaration);
    const actualValue = await warnbar.evaluate(
      (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
      check.property,
    );
    expect(actualValue, `${check.sourceSelector} ${check.property} from derived manifest`).toBe(expectedValue);
  }

  const fixtureParams = resolveParams(reverseTuckEnd, { tuckLock: 2 });
  const fixtureResult = reverseTuckEnd.generate(fixtureParams);
  const fixtureWarnings = reverseTuckEnd.invariants.flatMap((invariant) => {
    const result = invariant.check(fixtureParams, fixtureResult);
    return result.ok ? [] : [{ id: invariant.id, message: result.message.en }];
  });
  const tuckLockWarning = fixtureWarnings.find(({ id }) => id === 'tuck-lock-fits');
  expect(tuckLockWarning, 'fixture must specifically fail tuck-lock-fits').toBeDefined();
  await expect(warnbar).toContainText(tuckLockWarning!.message);

  const failed = fixtureWarnings.length;
  const passed = reverseTuckEnd.invariants.length - failed;
  const checksText = format(dict['canvas.checks'].en, { p: passed, f: failed });
  await expect(warnbar.locator('.n')).toHaveText(checksText);

  await input.fill(String(tuckLock!.default));
  await expect(warnbar).toHaveCount(0);
  await expect(input).toHaveValue(String(tuckLock!.default));
});
