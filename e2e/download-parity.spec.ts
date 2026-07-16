import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = path.join(ROOT, 'tests/baselines/export');
const LANGUAGES: readonly Language[] = ['en', 'zh'];
const VARIANTS = [
  {
    name: 'svg-default',
    buttonKey: 'export.svg',
    baseline: 'rte-default.svg',
    manufacturing: false,
  },
  {
    name: 'svg-manufacturing',
    buttonKey: 'export.svg',
    baseline: 'rte-default.manufacturing.svg',
    manufacturing: true,
  },
  {
    name: 'dxf-default',
    buttonKey: 'export.dxf',
    baseline: 'rte-default.dxf',
    manufacturing: false,
  },
] as const;

for (const lang of LANGUAGES) {
  for (const variant of VARIANTS) {
    test(`A2 ${lang} ${variant.name} download is byte-identical to the RTE baseline`, async ({ page }) => {
      await gotoReady(page, { lang });
      await expect(page.locator('#box-select')).toHaveValue('rte');

      const manufacturingMode = page.locator('#manufacturing-mode');
      await expect(manufacturingMode).not.toBeChecked();
      if (variant.manufacturing) {
        await manufacturingMode.check();
        await expect(manufacturingMode).toBeChecked();
      }

      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: dict[variant.buttonKey][lang], exact: true }).click();
      const download = await downloadPromise;
      const downloadPath = await download.path();
      if (!downloadPath) throw new Error(`${lang} ${variant.name}: Playwright did not provide a download path`);

      const actual = readFileSync(downloadPath);
      const baseline = readFileSync(path.join(BASELINE_DIR, variant.baseline));
      console.log(
        `DOWNLOAD-PARITY lang=${lang} variant=${variant.name} actualBytes=${actual.byteLength} baselineBytes=${baseline.byteLength}`,
      );
      expect(
        actual.equals(baseline),
        `${lang} ${variant.name}: actualBytes=${actual.byteLength}, baselineBytes=${baseline.byteLength}`,
      ).toBe(true);
      await download.delete();
    });
  }
}
