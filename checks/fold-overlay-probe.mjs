import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const RASTER_WIDTH_PX = 1600;
const VIEWBOX_PADDING_MM = 5;
const DILATION_RADIUS_PX = 1;
const MAX_NON_OVERLAP_RATIO = 0.005;
const SABOTAGE_TRANSLATION_PX = 2;

function percent(ratio) {
  return `${(ratio * 100).toFixed(4)}%`;
}

const server = await createServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1', port: 0 },
});

let browser;
let failed = false;

try {
  await server.listen();
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('無法取得 probe server port');
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });

  console.log('fold overlay probe');
  console.log(`規格: width=${RASTER_WIDTH_PX}px padding=${VIEWBOX_PADDING_MM}mm dilate=${DILATION_RADIUS_PX}px threshold=${percent(MAX_NON_OVERLAP_RATIO)}`);

  for (const boxId of ['rte', 'ttsl', 'ttb']) {
    const measurement = await page.evaluate(async ({
      boxId: targetBoxId,
      dilationRadiusPx,
      paddingMm,
      rasterWidthPx,
      sabotageTranslationPx,
    }) => {
      const [
        { reverseTuckEnd },
        { triangularTube },
        { tuckTopSnapLock },
        { resolveParams },
        { buildRteFoldModel },
        { buildTtbFoldModel },
        { buildTtslFoldModel },
        { oracleCutRegion },
      ] = await Promise.all([
        import('/src/boxes/reverse-tuck-end.ts'),
        import('/src/boxes/triangular-tube.ts'),
        import('/src/boxes/tuck-top-snap-lock.ts'),
        import('/src/core/registry.ts'),
        import('/src/fold/models/reverse-tuck-end.ts'),
        import('/src/fold/models/triangular-tube.ts'),
        import('/src/fold/models/tuck-top-snap-lock.ts'),
        import('/tests/helpers/derive-oracle.ts'),
      ]);

      const catalog = {
        rte: { box: reverseTuckEnd, build: buildRteFoldModel },
        ttsl: { box: tuckTopSnapLock, build: buildTtslFoldModel },
        ttb: { box: triangularTube, build: buildTtbFoldModel },
      };
      const entry = catalog[targetBoxId];
      const params = resolveParams(entry.box);
      const generated = entry.box.generate(params);
      const model = entry.build(params);
      const dielinePolygons = oracleCutRegion(generated).polygons;
      const flatPolygons = model.panels.map(({ polygon }) => polygon);
      const minX = generated.bounds.minX - paddingMm;
      const minY = generated.bounds.minY - paddingMm;
      const widthMm = generated.bounds.maxX - generated.bounds.minX + 2 * paddingMm;
      const heightMm = generated.bounds.maxY - generated.bounds.minY + 2 * paddingMm;
      const rasterHeightPx = Math.max(1, Math.round(rasterWidthPx * heightMm / widthMm));

      function svgFor(polygons) {
        const shapes = polygons.map((polygon) =>
          `<polygon points="${polygon.map(({ x, y }) => `${x},${y}`).join(' ')}"/>`).join('');
        return [
          '<svg xmlns="http://www.w3.org/2000/svg"',
          ` viewBox="${minX} ${minY} ${widthMm} ${heightMm}"`,
          ` width="${rasterWidthPx}" height="${rasterHeightPx}">`,
          '<g fill="#000" stroke="none">',
          shapes,
          '</g></svg>',
        ].join('');
      }

      async function rasterize(polygons, translatePx = 0) {
        const svg = svgFor(polygons);
        const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('SVG mask 解碼失敗'));
        });
        image.src = source;
        await loaded;
        const canvas = document.createElement('canvas');
        canvas.width = rasterWidthPx;
        canvas.height = rasterHeightPx;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.clearRect(0, 0, canvas.width, canvas.height);
        const diagonalComponentPx = translatePx / Math.sqrt(2);
        context.drawImage(image, diagonalComponentPx, diagonalComponentPx);
        URL.revokeObjectURL(source);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const mask = new Uint8Array(canvas.width * canvas.height);
        for (let pixel = 0; pixel < mask.length; pixel += 1) {
          mask[pixel] = rgba[pixel * 4 + 3] >= 128 ? 1 : 0;
        }
        return mask;
      }

      function dilate(mask) {
        const result = new Uint8Array(mask.length);
        for (let y = 0; y < rasterHeightPx; y += 1) {
          for (let x = 0; x < rasterWidthPx; x += 1) {
            const index = y * rasterWidthPx + x;
            if (mask[index] === 0) continue;
            for (let offsetY = -dilationRadiusPx; offsetY <= dilationRadiusPx; offsetY += 1) {
              const targetY = y + offsetY;
              if (targetY < 0 || targetY >= rasterHeightPx) continue;
              for (let offsetX = -dilationRadiusPx; offsetX <= dilationRadiusPx; offsetX += 1) {
                const targetX = x + offsetX;
                if (targetX >= 0 && targetX < rasterWidthPx) {
                  result[targetY * rasterWidthPx + targetX] = 1;
                }
              }
            }
          }
        }
        return result;
      }

      function compare(dielineMask, flatMask) {
        const dilatedDieline = dilate(dielineMask);
        const dilatedFlat = dilate(flatMask);
        let dielineFillPixels = 0;
        let nonOverlapPixels = 0;
        for (let pixel = 0; pixel < dielineMask.length; pixel += 1) {
          if (dielineMask[pixel] !== 0) dielineFillPixels += 1;
          const dielineOnly = dilatedDieline[pixel] !== 0 && dilatedFlat[pixel] === 0;
          const flatOnly = dilatedFlat[pixel] !== 0 && dilatedDieline[pixel] === 0;
          if (dielineOnly || flatOnly) nonOverlapPixels += 1;
        }
        return {
          dielineFillPixels,
          nonOverlapPixels,
          ratio: nonOverlapPixels / dielineFillPixels,
        };
      }

      const dielineMask = await rasterize(dielinePolygons);
      const flatMask = await rasterize(flatPolygons);
      const sabotagedFlatMask = await rasterize(flatPolygons, sabotageTranslationPx);
      return {
        heightPx: rasterHeightPx,
        normal: compare(dielineMask, flatMask),
        sabotage: compare(dielineMask, sabotagedFlatMask),
      };
    }, {
      boxId,
      dilationRadiusPx: DILATION_RADIUS_PX,
      paddingMm: VIEWBOX_PADDING_MM,
      rasterWidthPx: RASTER_WIDTH_PX,
      sabotageTranslationPx: SABOTAGE_TRANSLATION_PX,
    });

    const normalPass = measurement.normal.dielineFillPixels > 0
      && measurement.normal.ratio <= MAX_NON_OVERLAP_RATIO;
    const sabotageFails = measurement.sabotage.ratio > MAX_NON_OVERLAP_RATIO;
    console.log(`${boxId} normal: ${normalPass ? 'PASS' : 'FAIL'} ratio=${percent(measurement.normal.ratio)} mismatch=${measurement.normal.nonOverlapPixels} denominator=${measurement.normal.dielineFillPixels} raster=${RASTER_WIDTH_PX}x${measurement.heightPx}`);
    console.log(`${boxId} sabotage(${SABOTAGE_TRANSLATION_PX}px diagonal): ${sabotageFails ? 'FAIL（預期）' : 'PASS（錯誤）'} ratio=${percent(measurement.sabotage.ratio)} mismatch=${measurement.sabotage.nonOverlapPixels} denominator=${measurement.sabotage.dielineFillPixels}`);
    failed ||= !normalPass || !sabotageFails;
  }

  console.log(`fold overlay self-test: ${failed ? 'FAIL' : 'PASS'}`);
} finally {
  await browser?.close();
  await server.close();
}

if (failed) process.exitCode = 1;
