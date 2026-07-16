import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { manifest, tokenValues } from '../checks/e2e/derive-manifest.mjs';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

type Language = 'en' | 'zh';

interface Declaration {
  prop: string;
  value: string;
}

interface CanvasFrame {
  nonBackground: boolean;
  signature: number;
}

const DECLARATION_EXPANSIONS: Readonly<Record<string, readonly string[]>> = {
  border: [
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-right-width',
    'border-right-style',
    'border-right-color',
    'border-bottom-width',
    'border-bottom-style',
    'border-bottom-color',
    'border-left-width',
    'border-left-style',
    'border-left-color',
  ],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
};

async function enterFold(page: Page, lang: Language = 'en'): Promise<void> {
  await gotoReady(page, { lang });
  await page.getByRole('button', { name: dict['mode.fold'][lang], exact: true }).click();
  await expect(page.locator('.fold-view')).toBeVisible();
  await expect(page.locator('.fold-canvas')).toBeVisible();
  await expect(page.locator('.foldbar')).toBeVisible();
}

async function computedDeclarationMismatches(
  locator: Locator,
  sourceSelector: string,
  onlyProperties?: readonly string[],
): Promise<string[]> {
  const declarations = manifest.get(sourceSelector) as Declaration[] | undefined;
  expect(declarations, `Missing ${sourceSelector} in the vocabulary manifest`).toBeDefined();
  const selected = onlyProperties === undefined
    ? declarations!
    : declarations!.filter(({ prop }) => onlyProperties.includes(prop));
  expect(selected, `${sourceSelector} selected declarations`).not.toHaveLength(0);

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
        const actual = Object.fromEntries(
          properties.map((property) => [property, actualStyle.getPropertyValue(property).trim()]),
        );
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
    { declarations: selected, expansions: DECLARATION_EXPANSIONS, tokens: tokenValues },
  );
}

async function sampleCanvasFrame(canvas: Locator): Promise<CanvasFrame> {
  return canvas.evaluate(async (element) => {
    const source = element as HTMLCanvasElement;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const dataUrl = source.toDataURL('image/png');

    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => reject(new Error('Could not decode canvas data URL')), { once: true });
      image.src = dataUrl;
    });

    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const context = probe.getContext('2d');
    if (context === null) throw new Error('Canvas 2D context unavailable');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
    const background = [pixels[0], pixels[1], pixels[2], pixels[3]];
    let nonBackground = false;
    for (let index = 4; index < pixels.length; index += 4) {
      if (
        pixels[index] !== background[0] ||
        pixels[index + 1] !== background[1] ||
        pixels[index + 2] !== background[2] ||
        pixels[index + 3] !== background[3]
      ) {
        nonBackground = true;
        break;
      }
    }

    let signature = 2166136261;
    for (let index = 0; index < dataUrl.length; index += 1) {
      signature ^= dataUrl.charCodeAt(index);
      signature = Math.imul(signature, 16777619);
    }

    return { nonBackground, signature: signature >>> 0 };
  });
}

async function expectNonBackgroundFrame(canvas: Locator): Promise<void> {
  await expect.poll(
    async () => (await sampleCanvasFrame(canvas)).nonBackground,
    { message: 'fold canvas must contain rendered pixels beyond its background', timeout: 10_000 },
  ).toBe(true);
}

test('fold mode mounts its canvas and transfers the single pressed mode state', async ({ page }) => {
  await gotoReady(page);

  const modes = page.locator('.mode');
  await expect(modes).toHaveCount(3);
  await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();

  await expect(page.locator('.fold-canvas')).toBeVisible();
  const pressed = await modes.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-pressed') === 'true'),
  );
  expect(pressed.filter(Boolean)).toHaveLength(1);
  expect(pressed).toEqual([false, false, true]);
});

test('fold controls use the vocabulary declarations and render the real range thumb', async ({ page }) => {
  await enterFold(page);

  const button = page.locator('.foldbar .btn');
  const range = page.locator('.foldbar input[type="range"]');
  const compat = page.locator('.foldbar .compat');
  const tick = page.locator('.foldbar .compat .tick');
  await expect(button).toHaveCount(1);
  await expect(range).toHaveCount(1);
  await expect(compat).toHaveCount(1);
  await expect(tick).toHaveCount(1);

  expect(await computedDeclarationMismatches(button, '.btn', ['border', 'padding']), '.btn border/padding').toEqual([]);
  expect(await computedDeclarationMismatches(tick, '.foldbar .compat .tick'), '.foldbar .compat .tick').toEqual([]);
  await expect(tick).toBeChecked();

  await range.fill('0');
  const atMinimum = await range.screenshot();
  await range.fill('1');
  const atMaximum = await range.screenshot();
  expect(
    atMinimum.equals(atMaximum),
    'the production range must render a moving UA thumb; endpoint screenshots must differ',
  ).toBe(false);
});

test('dragging fold progress to one renders a non-background canvas frame', async ({ page }) => {
  await enterFold(page);

  const range = page.locator('.foldbar input[type="range"]');
  await range.fill('0');
  const box = await range.boundingBox();
  expect(box, 'fold progress range needs a real layout box').not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 1, y, { steps: 12 });
  await page.mouse.up();

  await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThanOrEqual(0.999);
  await expectNonBackgroundFrame(page.locator('.fold-canvas'));
});

test('zh fold controls use exact dictionary copy and the zh voice classes', async ({ page }) => {
  await enterFold(page, 'zh');

  await expect(page.locator('.app')).toHaveClass(/(^|\s)zh(\s|$)/);
  const controls = page.getByRole('group', { name: dict['fold.controls.aria'].zh, exact: true });
  await expect(controls).toBeVisible();
  await expect(controls.getByRole('button', { name: dict['fold.play'].zh, exact: true })).toHaveClass(/(^|\s)label(\s|$)/);
  await expect(controls.getByRole('slider', { name: dict['fold.progress.aria'].zh, exact: true })).toBeVisible();
  const autoRotate = controls.locator('.compat');
  await expect(autoRotate).toHaveClass(/(^|\s)mono(\s|$)/);
  await expect(autoRotate).toHaveText(dict['fold.autorotate'].zh);
});

test('fold mode makes no request outside the localhost origin', async ({ page }) => {
  const requestUrls: string[] = [];
  await page.route('**/*', async (route) => {
    requestUrls.push(route.request().url());
    await route.continue();
  });

  await enterFold(page);
  await expectNonBackgroundFrame(page.locator('.fold-canvas'));

  const localhostOrigin = new URL(page.url()).origin;
  const externalUrls = requestUrls.filter((url) => new URL(url).origin !== localhostOrigin);
  console.log(
    `FOLD-REQUESTS total=${requestUrls.length} localhost=${requestUrls.length - externalUrls.length} external=${externalUrls.length}`,
  );
  expect(externalUrls, `non-localhost requests:\n${externalUrls.join('\n')}`).toEqual([]);
});

test('fold mode survives synthetic WebGL context loss and resumes auto-rotation after restore', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await enterFold(page);
  const foldView = page.locator('.fold-view');
  const canvas = page.locator('.fold-canvas');
  const autoRotate = page.locator('.foldbar .compat .tick');
  await expect(autoRotate).toBeChecked();
  await expectNonBackgroundFrame(canvas);

  const lossResult = await canvas.evaluate((element) => {
    const event = new Event('webglcontextlost', { cancelable: true });
    const dispatched = element.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched };
  });
  expect(lossResult).toEqual({ defaultPrevented: true, dispatched: false });
  await expect(foldView).toHaveAttribute('data-context-lost', 'true');
  await expect(canvas).toBeVisible();
  expect(consoleErrors, 'console errors after context loss').toEqual([]);
  expect(pageErrors, 'page errors after context loss').toEqual([]);

  await canvas.evaluate((element) => {
    element.dispatchEvent(new Event('webglcontextrestored'));
  });
  await expect(foldView).toHaveAttribute('data-context-lost', 'false');
  await expect(canvas).toBeVisible();
  await expect(autoRotate).toBeChecked();
  await expectNonBackgroundFrame(canvas);

  const restoredFrame = await sampleCanvasFrame(canvas);
  expect(restoredFrame.nonBackground).toBe(true);
  await expect.poll(
    async () => {
      const nextFrame = await sampleCanvasFrame(canvas);
      return nextFrame.nonBackground && nextFrame.signature !== restoredFrame.signature;
    },
    { message: 'rendered canvas frames must keep changing after restore while auto-rotate is checked', timeout: 10_000 },
  ).toBe(true);

  expect(consoleErrors, 'console errors after context restore').toEqual([]);
  expect(pageErrors, 'page errors after context restore').toEqual([]);
});
