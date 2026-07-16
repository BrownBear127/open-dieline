import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

// 逐字同源 g5-forbidden-words.mjs:10；雙處同步義務。
const FORBIDDEN_WORDS = /open[\s-]?source|\bMIT\b|開源|开源|開放原始碼/i;
const LANGUAGES: readonly Language[] = ['en', 'zh'];

async function renderedText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
}

async function expectNoForbiddenRenderedWords(page: Page, lang: Language, state: string): Promise<void> {
  const text = await renderedText(page);
  const match = text.match(FORBIDDEN_WORDS);
  expect(match, `${lang} ${state}: rendered forbidden text in ${JSON.stringify(text)}`).toBeNull();
  console.log(`G5-RENDER lang=${lang} state=${state} characters=${text.length}`);
}

for (const lang of LANGUAGES) {
  test(`G5 rendered text excludes forbidden claims in ${lang} default and modal states`, async ({ page }) => {
    await gotoReady(page, { lang });
    await expectNoForbiddenRenderedWords(page, lang, 'default');

    await page.getByRole('button', { name: dict['chrome.about'][lang], exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoForbiddenRenderedWords(page, lang, 'modal');
  });
}

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
