import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { reverseTuckEnd } from '../src/boxes/reverse-tuck-end';
import { dict } from '../src/i18n/dict';
import { LANG_STORAGE_KEY } from '../src/i18n/lang';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

const LANGUAGE_BUTTON = { en: 'EN', zh: '中文' } as const;

async function waitUntilReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) await dialog.locator('button').first().click();
}

async function clearStorageAndReload(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitUntilReady(page);
}

async function expectLanguage(page: Page, lang: Language): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await expect(page.locator('.app')).toHaveClass(lang === 'zh' ? /(^|\s)zh(\s|$)/ : /^app$/);
  await expect(page.getByRole('button', { name: LANGUAGE_BUTTON[lang], exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Three independent chrome locations: mode control, console group heading,
  // and moderow action button.
  await expect(page.getByRole('button', { name: dict['mode.design'][lang], exact: true })).toBeVisible();
  await expect(page.locator('.sect-head .label').first()).toHaveText(dict['console.boxStyle'][lang]);
  await expect(page.getByRole('button', { name: dict['chrome.about'][lang], exact: true })).toBeVisible();

  // Schema-owned copy: the box option comes from BoxModule metadata, not dict chrome.
  await expect(page.locator('#box-select option').first()).toHaveText(reverseTuckEnd.meta.name[lang]);
}

test.beforeEach(async ({ page }) => {
  await gotoReady(page);
});

test('A14.1 empty storage defaults to English', async ({ page }) => {
  await clearStorageAndReload(page);

  await expectLanguage(page, 'en');
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBeNull();
});

test('A14.2 Chinese switch updates all copy, document state, root class, and storage', async ({ page }) => {
  await clearStorageAndReload(page);
  await page.getByRole('button', { name: LANGUAGE_BUTTON.zh, exact: true }).click();

  await expectLanguage(page, 'zh');
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBe('zh');
});

test('A14.3 switching back to English restores every language surface', async ({ page }) => {
  await clearStorageAndReload(page);
  await page.getByRole('button', { name: LANGUAGE_BUTTON.zh, exact: true }).click();
  await page.getByRole('button', { name: LANGUAGE_BUTTON.en, exact: true }).click();

  await expectLanguage(page, 'en');
  await expect(page.getByRole('button', { name: dict['mode.design'].zh, exact: true })).toHaveCount(0);
  await expect(page.locator('#box-select option').filter({ hasText: reverseTuckEnd.meta.name.zh })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBe('en');
});

test('A14.4 a stored Chinese selection survives reload', async ({ page }) => {
  await clearStorageAndReload(page);
  await page.getByRole('button', { name: LANGUAGE_BUTTON.zh, exact: true }).click();
  await page.reload();
  await waitUntilReady(page);

  await expectLanguage(page, 'zh');
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBe('zh');
});

test('A14.5 an invalid stored language falls back to English', async ({ page }) => {
  await page.evaluate((key) => localStorage.setItem(key, 'xx'), LANG_STORAGE_KEY);
  await page.reload();
  await waitUntilReady(page);

  await expectLanguage(page, 'en');
  // readStoredLang guards the runtime state; it deliberately does not rewrite storage.
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBe('xx');
});

// F8（I4·裁決版）: a JSON-shaped value simulates a plausible future storage schema (e.g. a
// versioned payload from a later build) leaking into today's build — a rollback, a shared
// localStorage origin across app versions, or a stale tab from a not-yet-released format.
// `isLang()` (src/i18n/lang.ts) only accepts the exact literal strings 'en'/'zh', so any
// structured/object-shaped value is already rejected and falls back safely; this locks that
// behavior in as an explicit Playwright case instead of leaving it as an untested
// implication of A14.5's plain-invalid-string case. 裁決（2026-07-16，M3 fix
// wave）：不修改 `src/i18n/` 加版本欄位——`isLang` 型別守衛已滿足「未知格式安全回退 EN」的
// 契約，版本化 payload 是 YAGNI（目前只有一種格式，沒有第二種格式需要相互區分/遷移）。
test('A14.6 a JSON-shaped (future-format) stored value falls back to English', async ({ page }) => {
  const jsonShapedValue = '{"v":1,"lang":"zh"}';
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: LANG_STORAGE_KEY, value: jsonShapedValue },
  );
  await page.reload();
  await waitUntilReady(page);

  await expectLanguage(page, 'en');
  // Same guard behavior as A14.5: readStoredLang does not rewrite storage on rejection.
  expect(await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY)).toBe(jsonShapedValue);
});
