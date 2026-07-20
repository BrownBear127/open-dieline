import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FORBIDDEN_RE } from '../checks/gates/g5-forbidden-words.mjs';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

const LANGUAGES: readonly Language[] = ['en', 'zh'];

async function renderedText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
}

async function expectNoForbiddenRenderedWords(page: Page, lang: Language, state: string): Promise<void> {
  // F9（OD_G5_MUTATION）: standing negative control — runtime string concatenation is
  // exactly the bypass class this Playwright scan exists to catch (G5's static regex never
  // sees text assembled at runtime from separate literals; static G5 stays green under this
  // mutation, proving the division of labor). Injected *before* the real assertion below, so
  // the same check this function always runs is what goes red — not a separate, trivially
  // circular self-check. Off by default.
  if (process.env.OD_G5_MUTATION === '1') {
    await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.dataset.testid = 'g5-mutation-probe';
      probe.textContent = 'open-' + 'source';
      document.body.append(probe);
    });
  }

  const text = await renderedText(page);
  const match = text.match(FORBIDDEN_RE);
  console.log(`G5-RENDER lang=${lang} state=${state} characters=${text.length}`);
  expect(match, `${lang} ${state}: rendered forbidden text in ${JSON.stringify(text)}`).toBeNull();
}

for (const lang of LANGUAGES) {
  // F7（I3）: three visible states — design, imposition, modal — so the runtime scan
  // actually reaches the imposition UI, not just the two states G5 previously covered.
  test(`G5 rendered text excludes forbidden claims in ${lang} design, imposition, and modal states`, async ({ page }) => {
    await gotoReady(page, { lang });
    await expectNoForbiddenRenderedWords(page, lang, 'design');

    await page.getByRole('button', { name: dict['mode.imposition'][lang], exact: true }).click();
    await expectNoForbiddenRenderedWords(page, lang, 'imposition');

    await page.getByRole('button', { name: dict['chrome.about'][lang], exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoForbiddenRenderedWords(page, lang, 'modal');
  });
}

// Containment is asserted at the default desktop viewport only: .app is a desktop-only
// single-column grid, so at phone widths every row (masthead, moderow, main, platebar,
// footer) stretches to the same track forced by the toolbars' min-content — the footer
// cannot fit the viewport there without whole-app responsive work.
test('footer and modal expose the exact safe external links inside the app frame', async ({ page }) => {
  await gotoReady(page);

  const app = page.locator('.app');
  const footer = page.locator('.app-footer');
  await expect(footer).toHaveText('source-available · PolyForm Noncommercial · GitHub · Substack · Konvolut');
  await expect(footer.getByRole('link')).toHaveCount(4);
  await expect(footer.getByRole('link', { name: 'PolyForm Noncommercial' })).toHaveAttribute(
    'href',
    'https://polyformproject.org/licenses/noncommercial/1.0.0',
  );
  await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/BrownBear127/open-dieline',
  );
  await expect(footer.getByRole('link', { name: 'Substack' })).toHaveAttribute(
    'href',
    'https://konvolut.substack.com',
  );
  await expect(footer.getByRole('link', { name: 'Konvolut' })).toHaveAttribute(
    'href',
    'https://konvolut.art',
  );
  for (const link of await footer.getByRole('link').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  const [appBox, footerBox] = await Promise.all([app.boundingBox(), footer.boundingBox()]);
  expect(appBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(footerBox!.x).toBeGreaterThanOrEqual(appBox!.x);
  expect(footerBox!.x + footerBox!.width).toBeLessThanOrEqual(appBox!.x + appBox!.width);

  await page.getByRole('button', { name: dict['chrome.about'].en, exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const name of ['GitHub', 'Substack'] as const) {
    await expect(dialog.getByRole('link', { name })).toHaveAttribute('target', '_blank');
    await expect(dialog.getByRole('link', { name })).toHaveAttribute('rel', 'noopener noreferrer');
  }
});

test('G6 complete interaction flow makes no request outside the localhost origin', async ({ page }) => {
  const requestUrls: string[] = [];
  await page.route('**/*', async (route) => {
    requestUrls.push(route.request().url());
    await route.continue();
  });

  await gotoReady(page);
  await page.getByRole('button', { name: '中文', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');

  await page.getByRole('button', { name: dict['mode.imposition'].zh, exact: true }).click();
  await page.getByRole('button', { name: dict['mode.design'].zh, exact: true }).click();

  await page.getByRole('button', { name: dict['chrome.about'].zh, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: dict['modal.close'].zh }).click();

  // F9（OD_G6_MUTATION）: standing negative control — a runtime fetch to a host that is
  // guaranteed never to be legitimate traffic (`.invalid` is reserved by RFC 2606 for
  // exactly this) must show up in `requestUrls` and fail the "no external requests"
  // assertion below. `.catch()` swallows the network-level rejection (the domain will never
  // resolve); the interception in `page.route()` fires at request-initiation, before that
  // failure, so it is captured regardless. Off by default.
  if (process.env.OD_G6_MUTATION === '1') {
    await page.evaluate(() => {
      fetch('https://example.invalid/probe').catch(() => {});
    });
    await page.waitForTimeout(200);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: dict['export.svg'].zh, exact: true }).click();
  const download = await downloadPromise;
  await download.delete();

  const localhostOrigin = new URL(page.url()).origin;
  const externalUrls = requestUrls.filter((url) => new URL(url).origin !== localhostOrigin);
  console.log(
    `G6-REQUESTS total=${requestUrls.length} localhost=${requestUrls.length - externalUrls.length} external=${externalUrls.length}`,
  );
  if (externalUrls.length) console.error(`G6-EXTERNAL-URLS ${JSON.stringify(externalUrls, null, 2)}`);
  expect(externalUrls, `non-localhost requests:\n${externalUrls.join('\n')}`).toEqual([]);
});
