import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export type ReadyLanguage = 'en' | 'zh';

interface GotoReadyOptions {
  lang?: ReadyLanguage;
}

// F10（M1）: font readiness must be re-checked after any language switch, not just
// before it. A cold run can have the EN first-paint's document.fonts.ready already
// resolved while the zh-only Noto face is still loading; measuring immediately after
// the click risks reading fallback-font geometry. Shared by gotoReady's zh path and
// zh-geometry.spec.ts's own switchLanguage so every spec's readiness definition agrees.
export async function settleFontsAndLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

/** Load the production preview and wait for the geometry-affecting prerequisites. */
export async function gotoReady(page: Page, { lang = 'en' }: GotoReadyOptions = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);

  // A first visit opens the announcement modal above the language control. Close
  // it through the public UI so the requested language switch remains a real click.
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close' }).click();
  }

  if (lang === 'zh') {
    await page.locator('.lang button').filter({ hasText: '中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
    expect(await page.evaluate(() => localStorage.getItem('od.lang'))).toBe('zh');
    await settleFontsAndLayout(page);
  } else {
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  }
}
