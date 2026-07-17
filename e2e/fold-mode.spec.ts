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

// 穩態截圖：連續兩次 locator.screenshot() byte 相等才回傳（自轉關、damping 靜止後成立）。
// 走 compositor 而非 toDataURL——three 預設 preserveDrawingBuffer:false，渲染停止後
// toDataURL 回空白（實測：靜止 canvas 的 signature 取樣永不收斂），compositor 截圖
// 不受 drawing buffer 生命週期影響。供 F6 的 t 態對比使用（final review F6）。
//
// t 態對比先縮至 1/16 尺寸，排除高頻 albedo 在同一幾何重渲染時的 mip/AA 相位差；
// 再用像素容差而非 byte 等式，仍能以 >1% 的輪廓差異抓出任何真幾何回歸。
async function pixelDiff(page: Page, left: Buffer, right: Buffer): Promise<{ diffPx: number; totalPx: number; maxDelta: number }> {
  return page.evaluate(async ([a, b]) => {
    const load = (b64: string) => new Promise<HTMLImageElement>((resolve) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image), { once: true });
      image.src = `data:image/png;base64,${b64}`;
    });
    const [imageA, imageB] = await Promise.all([load(a), load(b)]);
    const pixels = (image: HTMLImageElement) => {
      const probe = document.createElement('canvas');
      probe.width = Math.ceil(image.width / 16);
      probe.height = Math.ceil(image.height / 16);
      const context = probe.getContext('2d')!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, probe.width, probe.height);
      return context.getImageData(0, 0, probe.width, probe.height).data;
    };
    const dataA = pixels(imageA);
    const dataB = pixels(imageB);
    let diffPx = 0;
    let maxDelta = 0;
    for (let index = 0; index < dataA.length; index += 4) {
      const delta = Math.abs(dataA[index] - dataB[index])
        + Math.abs(dataA[index + 1] - dataB[index + 1])
        + Math.abs(dataA[index + 2] - dataB[index + 2]);
      if (delta > 3) {
        diffPx += 1;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    return { diffPx, totalPx: dataA.length / 4, maxDelta };
  }, [left.toString('base64'), right.toString('base64')] as const);
}
async function stableShot(canvas: Locator): Promise<Buffer> {
  let previous: Buffer | null = null;
  let stable: Buffer | null = null;
  await expect.poll(
    async () => {
      const next = await canvas.screenshot();
      const isStable = previous !== null && next.equals(previous);
      previous = next;
      if (isStable) stable = next;
      return isStable;
    },
    { message: 'fold canvas screenshot must settle', timeout: 10_000 },
  ).toBe(true);
  return stable!;
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
  // 自轉預設關閉（2026-07-17 法蘭 E2E 裁決）：進場靜止、由使用者主動開啟。
  await expect(tick).not.toBeChecked();

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

  // final review F6：t=0 與 t=1 的穩態畫面必須互異（雙背景空白 ⇒ 相等 ⇒ 紅），
  // 否則 updatePose no-op 也能靠「初始任意一張非空白幀」假綠；補 t=1→t=0 反向驗可逆。
  // 先開自轉（持續渲染·預設已關）驗有真內容，再關回自轉取穩態對比——
  // toDataURL 取樣依賴持續渲染（preserveDrawingBuffer:false）。
  const canvas = page.locator('.fold-canvas');
  await page.locator('.foldbar .compat .tick').check();
  await expectNonBackgroundFrame(canvas);
  await page.locator('.foldbar .compat .tick').uncheck();

  const range = page.locator('.foldbar input[type="range"]');

  await range.fill('0');
  const flat = await stableShot(canvas);

  const box = await range.boundingBox();
  expect(box, 'fold progress range needs a real layout box').not.toBeNull();
  const y = box!.y + box!.height / 2;
  await page.mouse.move(box!.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 1, y, { steps: 12 });
  await page.mouse.up();

  await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThanOrEqual(0.999);
  const folded = await stableShot(canvas);
  // 「不同」升級為可見差異量級（byte not-equal 連 1 個 AA 抖動像素都算過——太弱）
  const foldedDiff = await pixelDiff(page, folded, flat);
  expect(
    foldedDiff.diffPx / foldedDiff.totalPx,
    'folded (t=1) frame must visibly differ from the flat (t=0) frame',
  ).toBeGreaterThan(0.01);

  await range.fill('0');
  const reflattened = await stableShot(canvas);
  // re-review N4：只斷言「離開 folded」可被『第二次歸零偷換 0.5』假綠——回到 t=0 必須
  // 回到 flat 幀（像素容差版：AA 抖動實測 8px/Δ1·閾值 0.05%＋Δ≤8 給 30× 餘裕，
  // 半摺畫面的差異量級〔>1%〕遠超此閾值必紅）。
  const reflatDiff = await pixelDiff(page, reflattened, flat);
  expect(reflatDiff.maxDelta, 'reflattened frame may differ from flat only by AA jitter').toBeLessThanOrEqual(8);
  expect(
    reflatDiff.diffPx / reflatDiff.totalPx,
    'returning to t=0 must reproduce the flat frame within AA tolerance',
  ).toBeLessThan(0.0005);
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
  // 開自轉讓 toDataURL 取樣有持續渲染可取——勾 checkbox 不產生網路請求，斷言面不變。
  await page.locator('.foldbar .compat .tick').check();
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
  // 預設關——使用者主動開啟後，自轉狀態必須跨 context loss/restore 存活（原測試意圖）。
  await autoRotate.check();
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
