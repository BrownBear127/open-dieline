/**
 * AC-T9a：閉合俯視時下盒不得透出上蓋——**跨盒體尺寸**的像素閘門。
 *
 * 為什麼要有這一支：AC-T9a 在此之前只活在一次性探針裡，repo 內沒有任何像素斷言，
 * 於是「零透出」這個宣稱既無法回歸、也沒被任何 CI 守著。
 *
 * 為什麼判準不是「零像素」：殘餘的成因是上蓋底板與下盒壁頂之間 1.35mm 的高差在俯視下
 * 投影成**次像素**的螢幕視差。相機距離隨盒體尺寸線性放大，而那個高差由 thickness／
 * innerWallReduction 決定、**與盒體尺寸無關** ⇒ 視差 ∝ 1/尺寸，盒子越大殘餘越明顯。
 * 同理它也隨裝置像素比變化（實測預設列 dsf=2 得 0px、dsf=1 得 328px）。
 * 任何「零像素」的宣稱都只在某一組（尺寸, dsf, 視距）下成立，不是可回歸的契約。
 *
 * 判準改成**結構性**的：殘餘必須維持「貼著剪影邊緣的細線」形態，不得長成帶狀色塊。
 * 實測分離度（同一支探針·上蓋水平偏移 10mm 當 known-bad）：
 *
 *   列        健康(寬/佔比)    上蓋偏移 10mm(寬/佔比)
 *   M-01      1 / 0.30%       16 / 5.34%
 *   mid       2 / 1.29%        8 / 2.77%
 *   M-10      2 / 0.81%        1 / 0.28%
 *
 * ⚠ **本閘門的解析度（誠實記錄）**：它抓的是「螢幕上寬度超過 3px 的覆蓋失效」。
 * M-10 那列的 10mm 偏移只佔盒體 1.7%，落在解析度以下、本閘門抓不到——
 * 這不是設計缺陷而是量程，需要更細的覆蓋驗證時應該用幾何 oracle（AC-T4b ②）而不是像素。
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { dict } from '../src/i18n/dict';
import { gotoReady } from './helpers';

/** 殘餘允許的最大水平連續寬度（px）。健康值 1–2，known-bad 8–16。 */
const MAX_RUN_PX = 3;
/** 殘餘允許佔上蓋剪影的比例。健康值 ≤1.3%，known-bad 2.8–5.3%。 */
const MAX_AREA_RATIO = 0.02;
/** 正對照（改藏上蓋）的下限——低於此表示儀器沒在量東西。 */
const MIN_POSITIVE_CONTROL_PX = 20_000;

const BASE_PANEL_IDS = (() => {
  const ids = ['floor'];
  for (const axis of ['X', 'Y']) {
    for (const sign of ['Neg', 'Pos']) {
      for (const segment of ['outer', 'rim', 'inner', 'tongue']) {
        ids.push(`wall${axis}${sign}-${segment}`);
      }
    }
  }
  for (const corner of ['NegNeg', 'NegPos', 'PosNeg', 'PosPos']) {
    ids.push(`wingX${corner}`, `wingY${corner}`, `flap${corner}`, `gussetExt${corner}`);
  }
  return ids;
})();

const SHOT_STYLE = '.fold-tools { visibility: hidden !important; }';

interface DiffReport {
  count: number;
  maxRun: number;
  maxDelta: number;
  silhouette: number;
}

/**
 * 全解析度差集。**不得降採樣**——殘餘是 1px 細線，既有的 `pixelDiff` 走 1/16 縮圖，
 * 對這種訊號完全看不見（會把任何寬度的細線都算成 0）。
 */
async function diffFullRes(
  page: Page,
  left: Buffer,
  right: Buffer,
  silhouetteSource: Buffer,
): Promise<DiffReport> {
  return page.evaluate(async ([a, b, s]) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.addEventListener('load', () => resolve(image), { once: true });
      image.addEventListener('error', () => reject(new Error('PNG 解碼失敗')), { once: true });
      image.src = `data:image/png;base64,${base64}`;
    });
    const [imageA, imageB, imageS] = await Promise.all([load(a), load(b), load(s)]);
    const grab = (image: HTMLImageElement) => {
      const probe = document.createElement('canvas');
      probe.width = image.width;
      probe.height = image.height;
      const context = probe.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, probe.width, probe.height);
    };
    const dataA = grab(imageA);
    const dataB = grab(imageB);
    const dataS = grab(imageS);
    let count = 0;
    let maxRun = 0;
    let maxDelta = 0;
    let silhouette = 0;
    for (let y = 0; y < dataA.height; y += 1) {
      let run = 0;
      for (let x = 0; x < dataA.width; x += 1) {
        const index = (y * dataA.width + x) * 4;
        // 剪影＝隱藏下盒後仍非背景色的像素（--paper = 250,247,240）
        const isPaper = Math.abs(dataS.data[index]! - 250) < 6
          && Math.abs(dataS.data[index + 1]! - 247) < 6
          && Math.abs(dataS.data[index + 2]! - 240) < 6;
        if (!isPaper) silhouette += 1;
        const delta = Math.max(
          Math.abs(dataA.data[index]! - dataB.data[index]!),
          Math.abs(dataA.data[index + 1]! - dataB.data[index + 1]!),
          Math.abs(dataA.data[index + 2]! - dataB.data[index + 2]!),
        );
        if (delta > 2) {
          count += 1;
          maxDelta = Math.max(maxDelta, delta);
          run += 1;
          maxRun = Math.max(maxRun, run);
        } else {
          run = 0;
        }
      }
    }
    return { count, maxRun, maxDelta, silhouette };
  }, [
    left.toString('base64'),
    right.toString('base64'),
    silhouetteSource.toString('base64'),
  ] as const);
}

async function settledShot(canvas: Locator): Promise<Buffer> {
  let previous: Buffer | null = null;
  let settled: Buffer | null = null;
  await expect.poll(
    async () => {
      const next = await canvas.screenshot({ style: SHOT_STYLE });
      const same = previous !== null && next.equals(previous);
      previous = next;
      if (same) settled = next;
      return same;
    },
    { message: '俯視畫面必須先靜定（相機阻尼未收斂會造成全畫布假訊號）', timeout: 15_000 },
  ).toBe(true);
  return settled!;
}

async function setPieceVisible(
  page: Page,
  pieceId: string,
  visible: boolean,
): Promise<number> {
  return page.evaluate(([ids, piece, show]) => {
    const hook = (window as unknown as Record<string, unknown>).__p3SetPanelVisible;
    if (typeof hook !== 'function') throw new Error('__p3SetPanelVisible unavailable');
    let applied = 0;
    for (const id of ids as string[]) {
      if ((hook as (a: string, b: boolean) => boolean)(`${piece as string}:${id}`, show as boolean)) {
        applied += 1;
      }
    }
    return applied;
  }, [BASE_PANEL_IDS, pieceId, visible] as const);
}

const ROWS = [
  { caseId: 'M-01', params: {} as Record<string, number> },
  {
    caseId: '中尺寸',
    params: { baseLength: 358, baseWidth: 248, baseHeight: 120, lidHeight: 90 },
  },
  {
    caseId: 'M-10',
    params: {
      baseLength: 600,
      baseWidth: 600,
      baseHeight: 200,
      lidMarginX: 10,
      lidMarginY: 10,
      lidHeight: 200,
    },
  },
];

for (const row of ROWS) {
  test(`AC-T9a ${row.caseId}：閉合俯視下盒不透出上蓋（殘餘須維持細線形態）`, async ({ page }) => {
    await gotoReady(page);
    await page.locator('#box-select').selectOption('telescope');
    for (const [key, value] of Object.entries(row.params)) {
      const input = page.locator(`#param-${key}`);
      await expect(input, `缺少參數輸入 #param-${key}`).toBeVisible();
      await input.fill(String(value));
      await input.dispatchEvent('change');
    }
    await page.getByRole('button', { name: dict['mode.fold'].en, exact: true }).click();
    const canvas = page.locator('.fold-canvas');
    await expect(canvas).toBeVisible();
    await expect.poll(
      () => page.evaluate(
        () => typeof (window as unknown as Record<string, unknown>).__p3SetCameraOrbit,
      ),
      { message: '相機 hook 必須就緒' },
    ).toBe('function');

    await page.locator('.foldbar input[type="range"]').fill('1');
    // production 預設視距（fitCamera 落定的那一個），只改仰角不改距離。
    // 判準與視距強相關——使用者自行縮遠時殘餘會回來，那是合法操作、不在本閘門範圍。
    await page.evaluate(() => {
      const hook = (window as unknown as Record<string, unknown>).__p3SetCameraOrbit;
      if (typeof hook !== 'function') throw new Error('__p3SetCameraOrbit unavailable');
      (hook as (a: number, b: number) => void)(0, 90);
    });

    const withBase = await settledShot(canvas);
    const stillness = await settledShot(canvas);

    const hiddenBase = await setPieceVisible(page, 'base', false);
    expect(hiddenBase, '下盒 panel 一片都沒藏到＝儀器空轉，此時「零透出」與「沒量到」同值')
      .toBeGreaterThan(0);
    const withoutBase = await settledShot(canvas);

    const nullControl = await diffFullRes(page, withBase, stillness, withoutBase);
    expect(nullControl.count, 'null-control：同一場景連拍兩張必須完全相同').toBe(0);

    await setPieceVisible(page, 'base', true);
    const hiddenLid = await setPieceVisible(page, 'lid', false);
    expect(hiddenLid, '正對照：上蓋 panel 一片都沒藏到').toBeGreaterThan(0);
    const withoutLid = await settledShot(canvas);
    const positive = await diffFullRes(page, withBase, withoutLid, withoutBase);
    expect(
      positive.count,
      `正對照只有 ${positive.count}px——儀器沒有牙齒，主判準的通過不具意義`,
    ).toBeGreaterThan(MIN_POSITIVE_CONTROL_PX);

    await setPieceVisible(page, 'lid', true);
    const report = await diffFullRes(page, withBase, withoutBase, withoutBase);
    const areaRatio = report.count / report.silhouette;
    const detail = `count=${report.count} maxRun=${report.maxRun} maxDelta=${report.maxDelta}`
      + ` silhouette=${report.silhouette} area=${(areaRatio * 100).toFixed(3)}%`;

    expect(report.silhouette, `上蓋剪影過小，量測無意義（${detail}）`).toBeGreaterThan(5_000);
    expect(
      report.maxRun,
      `殘餘長成帶狀而非細線——上蓋很可能沒蓋住下盒（${detail}）`,
    ).toBeLessThanOrEqual(MAX_RUN_PX);
    expect(
      areaRatio,
      `殘餘佔上蓋剪影過大（${detail}）`,
    ).toBeLessThanOrEqual(MAX_AREA_RATIO);
  });
}
