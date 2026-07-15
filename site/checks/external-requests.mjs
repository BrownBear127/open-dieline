// Zero-external-requests acceptance check (Spec §7-1).
// Usage: node external-requests.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
//
// Two-page matrix (extended M3 Task 5 for the /zh/ page): '/' and the /zh/ homepage. Local
// `python3 -m http.server` has no cleanUrls rewrite, so locally the zh page is requested as
// `/zh/index.html`; in production (Vercel cleanUrls) it's `/zh/`. Set ZH_PATH to override for
// a production run, e.g. `ZH_PATH=/zh/ node external-requests.mjs https://dieline.konvolut.art`.
// Both pages carry the same #w instrument slider — drive it on each.
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
const PAGES = ['/', process.env.ZH_PATH ?? '/zh/index.html'];
const browser = await chromium.launch();
const offenders = [];

for (const path of PAGES) {
  const page = await browser.newPage();
  page.on('request', r => { if (!r.url().startsWith(ORIGIN)) offenders.push(`${path} → ${r.url()}`); });
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  await page.mouse.wheel(0, 20000); await page.waitForTimeout(2500);           // 觸發捲動載入
  await page.locator('#w').first().evaluate(el => { el.value = 300; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(500);
  await page.close();
}

await browser.close();
if (offenders.length) { console.error('EXTERNAL REQUESTS:', offenders); process.exit(1); }
console.log(`ZERO-EXTERNAL OK — ${PAGES.length} pages checked (${PAGES.join(', ')})`);
