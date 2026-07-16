import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady, settleFontsAndLayout } from './helpers';

const RECT_TOLERANCE_PX = 0.5;
// M3 實測 2026-07-16, 1440×900, Chromium. Signed direction is intentional: EN is
// 13.1875px taller than zh before the downstream flex filler absorbs the difference.
const DISCLAIMER_EN_MINUS_ZH_HEIGHT_PX = 13.1875;

// Modal copy may legitimately change intrinsic height, font fallback, letter spacing,
// weight, and text transform by language. These remaining computed properties define the
// layout box around each named text source and must not acquire a zh-only layout override.
const MODAL_SOURCE_LAYOUT_PROPERTIES = [
  'box-sizing',
  'display',
  'position',
  'width',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'row-gap',
  'column-gap',
  'font-size',
  'line-height',
  'text-indent',
  'white-space',
  'word-break',
  'overflow-wrap',
] as const;

const MODAL_TEXT_SOURCE_SELECTORS = ['.modal-card h2', '.modal-body'] as const;

const DESIGN_GEOMETRY_SAMPLES = [
  { name: '.masthead', selector: '.masthead', index: 0, exempt: [], attributable: {} },
  { name: '.moderow', selector: '.moderow', index: 0, exempt: [], attributable: {} },
  { name: '.sect-head[0]', selector: '.sect-head', index: 0, exempt: [], attributable: {} },
  { name: '.param[0]', selector: '.param', index: 0, exempt: [], attributable: {} },
] as const;

// F4（H4，裁決 A 的收斂實作，2026-07-16）: the imposition disclaimer line
// (`imp.disclaimer`, ImpositionResults.tsx:666) wraps to 2 lines in EN and 1 in zh — EN
// copy is simply longer, so EN is the taller one and "follow EN" has no meaning for
// text-length-driven heights. `.imp-results` is the flex:1 filler that absorbs the
// difference, cascading into card heights and the stats block's y.
//
// The previous version blanket-exempted those properties (skipped entirely). That is not
// what "exempt" was supposed to mean here — exempt means "attributable to the named text
// source," not "unconditionally allowed to drift." An `attributable` map replaces the skip:
// each entry maps a property to the multiplier of the frozen, signed disclaimer height
// difference that property's EN-minus-zh delta must equal within tolerance. The named source
// is asserted against that frozen value before the downstream relationships are checked.
// `x`/`width` and every property without an `attributable` entry stay strictly equal.
const IMPOSITION_GEOMETRY_SAMPLES = [
  { name: '.imp-toolbar', selector: '.imp-toolbar', index: 0, exempt: [], attributable: {} },
  { name: '.imp-results', selector: '.imp-results', index: 0, exempt: [], attributable: { height: -1 } },
  { name: '.imp-card[0]', selector: '.imp-card', index: 0, exempt: [], attributable: { height: -1 } },
  { name: '.imp-card[1]', selector: '.imp-card', index: 1, exempt: [], attributable: { height: -1 } },
  { name: '.imp-stats[0]', selector: '.imp-stats', index: 0, exempt: [], attributable: { y: -1 } },
  // The disclaimer line itself is the named text source that defines the base delta below —
  // it has nothing to be attributed *to*, so it stays a bare exempt (unconstrained), not an
  // attributable relationship.
  { name: 'imp disclaimer line', selector: 'p.mono.pb-4.opacity-60', index: 0, exempt: ['y', 'height'], attributable: {} },
] as const;

// F4（H4，裁決 A 的收斂實作）: modal body copy length differs per language (title `h2`
// and `.modal-body`), so the card's height and its flex-centered y follow that content. Both
// are checked with bespoke attribution assertions in the modal test below rather than
// through this table's generic `attributable` mechanism — `.modal-card` is
// `max-h-[85vh] overflow-y-auto`, so the rendered height is viewport-clamped for the (longer)
// EN copy but not for zh, breaking a simple external-baseDelta multiplier (see
// measureModalCardNaturalHeight's comment). x/width stay strict here — horizontal centering
// must not drift.
const MODAL_GEOMETRY_SAMPLES = [
  { name: '.modal-card', selector: '.modal-card', index: 0, exempt: ['y', 'height'], attributable: {} },
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

// N1（H4）: `signedBaseDelta` is a frozen EN-minus-zh text-source difference. A property
// listed in `attributable` must preserve both magnitude and direction; Math.abs is used only
// for the final error magnitude. A direction flip can therefore no longer self-normalize.
function rectParityFailures(
  en: RectTable,
  zh: RectTable,
  samples: readonly GeometrySample[],
  signedBaseDelta = 0,
  tolerance = RECT_TOLERANCE_PX,
): string[] {
  const failures: string[] = [];
  if (JSON.stringify(Object.keys(zh)) !== JSON.stringify(Object.keys(en))) {
    failures.push(`sample keys: EN=${JSON.stringify(Object.keys(en))}, zh=${JSON.stringify(Object.keys(zh))}`);
  }
  for (const sample of samples) {
    const enRect = en[sample.name]!;
    const zhRect = zh[sample.name]!;
    const exempt = new Set<string>(sample.exempt ?? []);
    const attributable: Readonly<Partial<Record<'x' | 'y' | 'width' | 'height', number>>> = sample.attributable ?? {};
    for (const property of ['x', 'y', 'width', 'height'] as const) {
      const signedDelta = enRect[property] - zhRect[property];
      const absoluteDelta = Math.abs(signedDelta);
      const multiplier = attributable[property];
      if (multiplier !== undefined) {
        const expectedDelta = signedBaseDelta * multiplier;
        const attributionError = Math.abs(signedDelta - expectedDelta);
        if (attributionError >= tolerance) {
          failures.push(
            `${sample.name}.${property}: EN=${enRect[property]}, zh=${zhRect[property]}, signed delta=${signedDelta}, ` +
              `attributable expected=${expectedDelta} (baseDelta=${signedBaseDelta}×${multiplier}), |diff|=${attributionError}`,
          );
        }
        continue;
      }
      if (exempt.has(property)) continue;
      if (absoluteDelta >= tolerance) {
        failures.push(`${sample.name}.${property}: EN=${enRect[property]}, zh=${zhRect[property]}, |delta|=${absoluteDelta}`);
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

// F5（I1）: row count and row membership are frozen constants, not derived from the same
// y-proximity tolerance the alignment check re-verifies. The previous version partitioned
// rects into rows using RECT_TOLERANCE_PX, then asserted every row's members were within
// RECT_TOLERANCE_PX of each other — tautological: a group that drifted 30px down just formed
// its own new single-member "row," and "some row has length > 1" still held as long as any
// other row kept two members. Freezing the row count AND the exact DOM-index membership per
// row means a drifted group is caught either by row count changing (7 groups no longer fold
// into 2 rows) or by membership changing (the group leaves its frozen row).
const IMP_GROUP_ROW_COUNT = 2;
// M3 實測 2026-07-16, 1440×900, Chromium: `.imp-group` DOM-order indices per visual toolbar
// row (flex-wrap wraps in source order, so this is exhaustive — see the continuity check
// below for the property that makes that assumption load-bearing rather than assumed).
const IMP_GROUP_ROW_MEMBERSHIP: Readonly<Record<'en' | 'zh', readonly (readonly number[])[]>> = {
  en: [[0, 1, 2], [3, 4, 5, 6]],
  zh: [[0, 1, 2, 3, 4], [5, 6]],
};

function expectFrozenRowMembership(rects: Rect[], language: 'en' | 'zh'): void {
  expect(rects.length, `${language}: expected 7 .imp-group elements`).toBe(7);

  // Partition purely to locate row boundaries (flex-wrap groups sharing a top edge) — this
  // partition is not itself the source of truth; every group's assignment is checked against
  // the frozen membership table below, which does not depend on this tolerance.
  const rowTops: number[] = [];
  const rowIndexByGroup = rects.map((rect) => {
    const existingRow = rowTops.findIndex((top) => Math.abs(top - rect.y) < RECT_TOLERANCE_PX);
    if (existingRow !== -1) return existingRow;
    rowTops.push(rect.y);
    return rowTops.length - 1;
  });

  expect(rowTops.length, `${language}: .imp-group row count`).toBe(IMP_GROUP_ROW_COUNT);

  // DOM order continuity: flex-wrap lays groups out left-to-right, top-to-bottom in source
  // order, so a group's row index must never be lower than the row index of any group before
  // it in the DOM. A violation means the layout is no longer a simple wrap (or a group has
  // been displaced out of sequence) — the frozen membership table below would not even be a
  // meaningful comparison target if this did not hold.
  for (let i = 1; i < rowIndexByGroup.length; i += 1) {
    expect(
      rowIndexByGroup[i]!,
      `${language}: .imp-group row index must be non-decreasing in DOM order at group ${i}`,
    ).toBeGreaterThanOrEqual(rowIndexByGroup[i - 1]!);
  }

  const expectedMembership = IMP_GROUP_ROW_MEMBERSHIP[language];
  const actualMembership = expectedMembership.map(() => [] as number[]);
  rowIndexByGroup.forEach((rowIndex, groupIndex) => actualMembership[rowIndex]?.push(groupIndex));
  expect(actualMembership, `${language}: .imp-group row membership (frozen, M3 實測 2026-07-16)`).toEqual(expectedMembership);

  for (const [rowIndex, memberIndices] of expectedMembership.entries()) {
    const expectedY = rects[memberIndices[0]!]!.y;
    for (const groupIndex of memberIndices) {
      expect(
        Math.abs(rects[groupIndex]!.y - expectedY),
        `${language}: .imp-group row ${rowIndex} top alignment (group ${groupIndex})`,
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
    // Discriminating RED probe requested by the spec. It exists only in page
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
  expectFrozenRowMembership(enGroupRects, 'en');

  if (process.env.OD_N1_DISCLAIMER_MUTATION === '1') {
    await page.addStyleTag({
      content: '.zh p.mono.pb-4.opacity-60 { padding-block: 24px !important; }',
    });
  }
  await switchLanguage(page, 'zh');
  const zh = await measureRects(page, IMPOSITION_GEOMETRY_SAMPLES);
  const zhGroupRects = await measureImpositionGroupRows(page);
  expectFrozenRowMembership(zhGroupRects, 'zh');

  // N1（H4）: freeze the named source itself before using its legal signed difference in
  // downstream relationships. A zh-only padding can no longer rewrite its own baseline.
  const disclaimerSignedDelta = en['imp disclaimer line']!.height - zh['imp disclaimer line']!.height;

  console.log(
    `GEOMETRY-MEASUREMENTS imposition ${JSON.stringify({
      en,
      zh,
      delta: rectDeltas(en, zh),
      disclaimerSignedDelta,
      frozenDisclaimerSignedDelta: DISCLAIMER_EN_MINUS_ZH_HEIGHT_PX,
      impGroupRows: { en: enGroupRects, zh: zhGroupRects },
      exemptions: GEOMETRY_EXEMPTIONS,
    })}`,
  );
  expect(
    disclaimerSignedDelta,
    'imp disclaimer EN−zh height delta must equal the frozen M3 Chromium measurement',
  ).toBe(DISCLAIMER_EN_MINUS_ZH_HEIGHT_PX);
  expect(
    rectParityFailures(en, zh, IMPOSITION_GEOMETRY_SAMPLES, DISCLAIMER_EN_MINUS_ZH_HEIGHT_PX),
    'all imposition deltas must be strictly equal, or preserve the frozen signed disclaimer relationship',
  ).toEqual([]);
});

// F4（H4）: the named text source the modal card's height/y exemption is attributed to —
// the title row (`.modal-card h2`) plus the body copy (`.modal-body`), summed. Both contain
// translated text that can wrap differently per language; the card's padding and the
// "begin" button below the content are language-invariant and intentionally excluded.
async function measureModalContentHeight(page: Page): Promise<number> {
  const titleHeight = await page.locator('.modal-card h2').first().evaluate((element) => element.getBoundingClientRect().height);
  const bodyHeight = await page.locator('.modal-body').first().evaluate((element) => element.getBoundingClientRect().height);
  return titleHeight + bodyHeight;
}

// `.modal-card` is `max-h-[85vh] overflow-y-auto` (AnnouncementModal.tsx:131). At 1440×900
// the EN announcement text is long enough to hit that cap — its rendered
// getBoundingClientRect().height is 765px, exactly 85% of 900, and does not vary with
// content beyond that point. zh's shorter text fits under the cap, so its rendered height
// *does* track content directly. A single "rendered height delta == content delta"
// assertion is therefore not honest for the current copy: one side of the comparison is
// viewport-clamped, not content-driven. `scrollHeight` reports the card's natural,
// pre-clamp height regardless of whether the visual box is currently clipped, so it is the
// quantity that actually tracks content 1:1 on both sides.
async function measureModalCardNaturalHeight(page: Page): Promise<number> {
  return page.locator('.modal-card').first().evaluate((element) => element.scrollHeight);
}

type ModalSourceLayout = Record<string, Record<string, string>>;

async function measureModalSourceLayout(page: Page): Promise<ModalSourceLayout> {
  const result: ModalSourceLayout = {};
  for (const selector of MODAL_TEXT_SOURCE_SELECTORS) {
    result[selector] = await page.locator(selector).first().evaluate(
      (element, properties) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
      },
      MODAL_SOURCE_LAYOUT_PROPERTIES,
    );
  }
  return result;
}

test('zh strict geometry parity: modal container', async ({ page }) => {
  await gotoReady(page);

  // Modal is opened through the public About control; no storage shortcut is used.
  await page.getByRole('button', { name: dict['chrome.about'].en, exact: true }).click();
  const en = await measureRects(page, MODAL_GEOMETRY_SAMPLES);
  const enContentHeight = await measureModalContentHeight(page);
  const enNaturalHeight = await measureModalCardNaturalHeight(page);
  const enSourceLayout = await measureModalSourceLayout(page);
  // The modal intentionally covers the language control. Close it through its
  // public button, switch language on the same page, then reopen through About.
  await page.getByRole('dialog').getByRole('button', { name: dict['modal.close'].en }).click();
  if (process.env.OD_N1_MODAL_MUTATION === '1') {
    await page.addStyleTag({ content: '.zh .modal-body { padding-block: 24px !important; }' });
  }
  await switchLanguage(page, 'zh');
  await page.getByRole('button', { name: dict['chrome.about'].zh, exact: true }).click();
  const zh = await measureRects(page, MODAL_GEOMETRY_SAMPLES);
  const zhContentHeight = await measureModalContentHeight(page);
  const zhNaturalHeight = await measureModalCardNaturalHeight(page);
  const zhSourceLayout = await measureModalSourceLayout(page);

  const modalContentDelta = Math.abs(enContentHeight - zhContentHeight);
  const naturalHeightDelta = Math.abs(enNaturalHeight - zhNaturalHeight);
  const realHeightDelta = Math.abs(en['.modal-card']!.height - zh['.modal-card']!.height);
  const realYDelta = Math.abs(en['.modal-card']!.y - zh['.modal-card']!.y);

  console.log(
    `GEOMETRY-MEASUREMENTS modal ${JSON.stringify({
      en,
      zh,
      delta: rectDeltas(en, zh),
      modalContentDelta,
      enContentHeight,
      zhContentHeight,
      enNaturalHeight,
      zhNaturalHeight,
      sourceLayout: { en: enSourceLayout, zh: zhSourceLayout },
    })}`,
  );

  // x/width (horizontal centering) stay strict; height/y are handled by the two
  // attribution checks below instead of rectParityFailures's baseDelta mechanism — see the
  // measureModalCardNaturalHeight comment for why a single external baseDelta multiplier
  // (as used for the imposition samples above) is not honest here.
  expect(
    rectParityFailures(en, zh, MODAL_GEOMETRY_SAMPLES),
    'x/width (horizontal centering) must remain strictly equal',
  ).toEqual([]);

  expect(
    zhSourceLayout,
    'modal named text sources must preserve language-invariant layout-affecting computed properties',
  ).toEqual(enSourceLayout);

  // The card's *natural* (pre-clamp) height delta — unaffected by the 85vh visual clamp
  // either language happens to hit — must equal the title+body box delta. Source-box drift
  // is guarded separately by the computed-property equality above; this relationship only
  // verifies that the card continues to follow those source boxes 1:1.
  expect(
    Math.abs(naturalHeightDelta - modalContentDelta),
    `modal-card natural (scrollHeight) height delta (${naturalHeightDelta}) must be attributable to the title+body content delta (${modalContentDelta})`,
  ).toBeLessThan(1);

  // The rendered (possibly clamped) y offset is flex-centered on the rendered (possibly
  // clamped) height — this holds regardless of *why* the rendered height differs, so it is
  // checked as a self-consistency invariant on the real rect rather than against
  // modalContentDelta directly.
  expect(
    Math.abs(realYDelta - realHeightDelta / 2),
    `modal-card rendered y delta (${realYDelta}) must equal half its own rendered height delta (${realHeightDelta})`,
  ).toBeLessThan(0.5);
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
