import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

const RECT_TOLERANCE_PX = 0.5;

const DESIGN_GEOMETRY_SAMPLES = [
  { name: '.masthead', selector: '.masthead', index: 0, exempt: [] },
  { name: '.moderow', selector: '.moderow', index: 0, exempt: [] },
  { name: '.sect-head[0]', selector: '.sect-head', index: 0, exempt: [] },
  { name: '.param[0]', selector: '.param', index: 0, exempt: [] },
] as const;

// Rule 6 height extension (法蘭裁決 A, 2026-07-16): the imposition disclaimer line
// (`imp.disclaimer`, ImpositionResults.tsx:666) wraps to 2 lines in EN and 1 in zh —
// EN copy is simply longer, so EN is the taller one and "follow EN" has no meaning
// for text-length-driven heights. `.imp-results` is the flex:1 filler that absorbs
// the difference, cascading into card heights and the stats block's y. Those
// properties are exempt as text-intrinsic; every other property stays strict.
const IMPOSITION_GEOMETRY_SAMPLES = [
  { name: '.imp-toolbar', selector: '.imp-toolbar', index: 0, exempt: [] },
  { name: '.imp-results', selector: '.imp-results', index: 0, exempt: ['height'] },
  { name: '.imp-card[0]', selector: '.imp-card', index: 0, exempt: ['height'] },
  { name: '.imp-card[1]', selector: '.imp-card', index: 1, exempt: ['height'] },
  { name: '.imp-stats[0]', selector: '.imp-stats', index: 0, exempt: ['y'] },
  { name: 'imp disclaimer line', selector: 'p.mono.pb-4.opacity-60', index: 0, exempt: ['y', 'height'] },
] as const;

// Rule 6 height extension (same adjudication): modal body copy lengths differ per
// language, so card height and the flex-centered y follow content. x/width stay
// strict — horizontal centering must not drift.
const MODAL_GEOMETRY_SAMPLES = [
  { name: '.modal-card', selector: '.modal-card', index: 0, exempt: ['y', 'height'] },
] as const;

// Rule 6 exemption: translated intrinsic widths make .imp-group width intentionally
// language-dependent. Width parity is not asserted; groups that occupy one visual
// toolbar row must still share the same top edge.
const GEOMETRY_EXEMPTIONS = [
  {
    selector: '.imp-group',
    exemptProperty: 'width',
    reason: 'flex intrinsic width follows translated label length; same-row y alignment remains required',
  },
] as const;

type GeometrySample = (typeof DESIGN_GEOMETRY_SAMPLES)[number] | (typeof IMPOSITION_GEOMETRY_SAMPLES)[number] | (typeof MODAL_GEOMETRY_SAMPLES)[number];
type Rect = { x: number; y: number; width: number; height: number };
type RectTable = Record<string, Rect>;

async function settleFontsAndLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function switchLanguage(page: Page, lang: 'en' | 'zh'): Promise<void> {
  const label = lang === 'zh' ? '中文' : 'EN';
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  await settleFontsAndLayout(page);
}

async function measureRects(page: Page, samples: readonly GeometrySample[]): Promise<RectTable> {
  const table: RectTable = {};
  for (const sample of samples) {
    const locator = page.locator(sample.selector).nth(sample.index);
    await expect(locator, `${sample.name} must be visible before measurement`).toBeVisible();
    table[sample.name] = await locator.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
  }
  return table;
}

function rectParityFailures(en: RectTable, zh: RectTable, samples: readonly GeometrySample[]): string[] {
  const failures: string[] = [];
  if (JSON.stringify(Object.keys(zh)) !== JSON.stringify(Object.keys(en))) {
    failures.push(`sample keys: EN=${JSON.stringify(Object.keys(en))}, zh=${JSON.stringify(Object.keys(zh))}`);
  }
  for (const sample of samples) {
    const enRect = en[sample.name]!;
    const zhRect = zh[sample.name]!;
    const exempt = new Set<string>(sample.exempt ?? []);
    for (const property of ['x', 'y', 'width', 'height'] as const) {
      if (exempt.has(property)) continue;
      const delta = Math.abs(enRect[property] - zhRect[property]);
      if (delta >= RECT_TOLERANCE_PX) {
        failures.push(`${sample.name}.${property}: EN=${enRect[property]}, zh=${zhRect[property]}, |delta|=${delta}`);
      }
    }
  }
  return failures;
}

async function measureImpositionGroupRows(page: Page): Promise<Rect[]> {
  return page.locator(GEOMETRY_EXEMPTIONS[0].selector).evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}

function expectSameRowTopAlignment(rects: Rect[], language: 'en' | 'zh'): void {
  expect(rects.length, `${language}: expected multiple imposition groups`).toBeGreaterThan(1);

  const rows: Rect[][] = [];
  for (const rect of rects) {
    const row = rows.find((candidate) => Math.abs(candidate[0]!.y - rect.y) < RECT_TOLERANCE_PX);
    if (row) row.push(rect);
    else rows.push([rect]);
  }

  expect(
    rows.some((row) => row.length > 1),
    `${language}: the fixed viewport must contain at least one multi-group toolbar row`,
  ).toBe(true);
  for (const [rowIndex, row] of rows.entries()) {
    const expectedY = row[0]!.y;
    for (const rect of row) {
      expect(
        Math.abs(rect.y - expectedY),
        `${language}: .imp-group row ${rowIndex} top alignment`,
      ).toBeLessThan(RECT_TOLERANCE_PX);
    }
  }
}

function rectDeltas(en: RectTable, zh: RectTable): RectTable {
  return Object.fromEntries(
    Object.keys(en).map((name) => [
      name,
      {
        x: Math.abs(en[name]!.x - zh[name]!.x),
        y: Math.abs(en[name]!.y - zh[name]!.y),
        width: Math.abs(en[name]!.width - zh[name]!.width),
        height: Math.abs(en[name]!.height - zh[name]!.height),
      },
    ]),
  );
}

interface CjkFontProbe {
  character: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  notoAvailable: boolean;
  stackWidth: number;
  notoWidth: number;
}

async function probeCjkFallback(locator: Locator): Promise<CjkFontProbe> {
  return locator.evaluate((element) => {
    const text = element.textContent ?? '';
    const character = text.match(/[\u3400-\u9fff]/u)?.[0];
    if (!character) throw new Error(`No CJK character found in ${JSON.stringify(text)}`);

    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');

    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const stackWidth = context.measureText(character).width;
    context.font = `400 ${style.fontSize} "Noto Serif TC"`;
    const notoWidth = context.measureText(character).width;

    return {
      character,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      notoAvailable: document.fonts.check(`400 ${style.fontSize} "Noto Serif TC"`, character),
      stackWidth,
      notoWidth,
    };
  });
}

interface LatinFontProbe {
  fontFamily: string;
  text: string;
  renderedWidth: number;
}

async function probeLatinVoice(locator: Locator): Promise<LatinFontProbe> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const text = element.textContent?.trim() ?? '';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context unavailable');
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return { fontFamily: style.fontFamily, text, renderedWidth: context.measureText(text).width };
  });
}

test('zh strict geometry parity: design containers', async ({ page }) => {
  await gotoReady(page);

  const en = await measureRects(page, DESIGN_GEOMETRY_SAMPLES);
  if (process.env.OD_GEOMETRY_MUTATION === '1') {
    // Discriminating RED probe requested by the brief. It exists only in page
    // memory and is activated solely for the explicit negative-control run.
    await page.addStyleTag({ content: '.zh { line-height: normal !important; }' });
  }
  await switchLanguage(page, 'zh');
  const zh = await measureRects(page, DESIGN_GEOMETRY_SAMPLES);

  console.log(`GEOMETRY-MEASUREMENTS design ${JSON.stringify({ en, zh, delta: rectDeltas(en, zh) })}`);
  expect(rectParityFailures(en, zh, DESIGN_GEOMETRY_SAMPLES), 'all design x/y/width/height deltas must remain below 0.5px').toEqual([]);
});

test('zh strict geometry parity: imposition containers and exempt group alignment', async ({ page }) => {
  await gotoReady(page);

  await page.getByRole('button', { name: dict['mode.imposition'].en, exact: true }).click();
  await settleFontsAndLayout(page);
  const en = await measureRects(page, IMPOSITION_GEOMETRY_SAMPLES);
  const enGroupRects = await measureImpositionGroupRows(page);
  expectSameRowTopAlignment(enGroupRects, 'en');

  await switchLanguage(page, 'zh');
  const zh = await measureRects(page, IMPOSITION_GEOMETRY_SAMPLES);
  const zhGroupRects = await measureImpositionGroupRows(page);
  expectSameRowTopAlignment(zhGroupRects, 'zh');

  console.log(
    `GEOMETRY-MEASUREMENTS imposition ${JSON.stringify({
      en,
      zh,
      delta: rectDeltas(en, zh),
      impGroupRows: { en: enGroupRects, zh: zhGroupRects },
      exemptions: GEOMETRY_EXEMPTIONS,
    })}`,
  );
  expect(rectParityFailures(en, zh, IMPOSITION_GEOMETRY_SAMPLES), 'all non-exempt imposition deltas must remain below 0.5px').toEqual([]);
});

test('zh strict geometry parity: modal container', async ({ page }) => {
  await gotoReady(page);

  // Modal is opened through the public About control; no storage shortcut is used.
  await page.getByRole('button', { name: dict['chrome.about'].en, exact: true }).click();
  const en = await measureRects(page, MODAL_GEOMETRY_SAMPLES);
  // The modal intentionally covers the language control. Close it through its
  // public button, switch language on the same page, then reopen through About.
  await page.getByRole('dialog').getByRole('button', { name: dict['modal.close'].en }).click();
  await switchLanguage(page, 'zh');
  await page.getByRole('button', { name: dict['chrome.about'].zh, exact: true }).click();
  const zh = await measureRects(page, MODAL_GEOMETRY_SAMPLES);

  console.log(`GEOMETRY-MEASUREMENTS modal ${JSON.stringify({ en, zh, delta: rectDeltas(en, zh) })}`);
  expect(rectParityFailures(en, zh, MODAL_GEOMETRY_SAMPLES), 'all non-exempt modal deltas (x/width — horizontal centering) must remain below 0.5px').toEqual([]);
});

test('zh CJK uses Noto fallback while Latin and digits retain their source voices', async ({ page }) => {
  await gotoReady(page);

  const readout = page.locator('.readout b');
  const enReadout = await probeLatinVoice(readout);
  expect(enReadout.fontFamily).toContain('IBM Plex Mono');

  // Current production markup has no output node (the T2 manifest freezes its
  // count at zero). This disposable probe exercises the frozen .param output
  // vocabulary without changing application code or claiming that it is live UI.
  await page.locator('.param').first().evaluate((param) => {
    const output = document.createElement('output');
    output.dataset.testid = 'param-output-font-probe';
    output.textContent = '55.5 mm';
    param.append(output);
  });
  const paramOutput = page.getByTestId('param-output-font-probe');
  const enParamOutput = await probeLatinVoice(paramOutput);
  expect(enParamOutput.fontFamily).toContain('Fraunces');

  await switchLanguage(page, 'zh');
  const zhReadout = await probeLatinVoice(readout);
  const zhParamOutput = await probeLatinVoice(paramOutput);
  expect(zhReadout.fontFamily.split(',')[0]).toBe(enReadout.fontFamily.split(',')[0]);
  expect(zhReadout.text).toBe(enReadout.text);
  expect(Math.abs(zhReadout.renderedWidth - enReadout.renderedWidth)).toBeLessThan(0.01);
  expect(zhParamOutput.fontFamily.split(',')[0]).toBe(enParamOutput.fontFamily.split(',')[0]);
  expect(zhParamOutput.text).toBe(enParamOutput.text);
  expect(Math.abs(zhParamOutput.renderedWidth - enParamOutput.renderedWidth)).toBeLessThan(0.01);

  const samples: Array<{ name: string; probe: CjkFontProbe }> = [];
  samples.push({ name: 'sect-head label', probe: await probeCjkFallback(page.locator('.sect-head .label').first()) });

  await page.getByRole('button', { name: dict['mode.imposition'].zh, exact: true }).click();
  samples.push({ name: 'imposition group label', probe: await probeCjkFallback(page.locator('.imp-group .k').first()) });

  await page.getByRole('button', { name: dict['chrome.about'].zh, exact: true }).click();
  samples.push({ name: 'modal body', probe: await probeCjkFallback(page.locator('.modal-body')) });

  for (const { name, probe } of samples) {
    expect(probe.notoAvailable, `${name}: Noto face must contain ${probe.character}`).toBe(true);
    expect(probe.fontFamily, `${name}: declared fallback stack`).toContain('Noto Serif TC');
    expect(
      Math.abs(probe.stackWidth - probe.notoWidth),
      `${name}: stack-rendered ${probe.character} must match Noto width`,
    ).toBeLessThan(0.01);
  }

  await paramOutput.evaluate((element) => element.remove());
  console.log(`FONT-MEASUREMENTS ${JSON.stringify({ cjk: samples, latin: { enReadout, zhReadout, enParamOutput, zhParamOutput } })}`);
});
