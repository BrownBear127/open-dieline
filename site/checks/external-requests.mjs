// Zero-external-requests acceptance check (Spec §7-1).
// Usage: node external-requests.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
const browser = await chromium.launch();
const page = await browser.newPage();
const offenders = [];
page.on('request', r => { if (!r.url().startsWith(ORIGIN)) offenders.push(r.url()); });
await page.goto(ORIGIN, { waitUntil: 'networkidle' });
await page.mouse.wheel(0, 20000); await page.waitForTimeout(2500);           // 觸發捲動載入
await page.locator('#w').first().evaluate(el => { el.value = 300; el.dispatchEvent(new Event('input')); });
await page.waitForTimeout(500);
await browser.close();
if (offenders.length) { console.error('EXTERNAL REQUESTS:', offenders); process.exit(1); }
console.log('ZERO-EXTERNAL OK');
