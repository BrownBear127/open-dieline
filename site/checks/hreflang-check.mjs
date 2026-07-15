// hreflang acceptance check (M3 Task 5 · Spec §3/§7-4). Verifies the EN ('/') and /zh/ pages
// each carry exactly three `<link rel="alternate" hreflang>` entries — en / zh-Hant /
// x-default — with absolute-URL hrefs, that x-default matches the en href, that canonical is
// self-referencing on each page (EN canonical == its own en href; zh canonical == its own
// zh-Hant href), and that the two pages are reciprocal (declare the identical {lang: href}
// set). It does not hardcode the production domain — everything is cross-checked structurally
// against what the pages themselves declare, so the check travels with a domain rename for
// free. (This repo has no policies-equivalent page, unlike konvolut-site's copy of this
// script, which additionally asserts zero hreflang on /policies.html.)
//
// Usage: node hreflang-check.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
//
// Local `python3 -m http.server` has no cleanUrls rewrite, so locally the zh page is requested
// as `/zh/index.html`; in production (Vercel cleanUrls) it's `/zh/`. Set ZH_PATH to override
// for a production run, e.g. `ZH_PATH=/zh/ node hreflang-check.mjs https://dieline.konvolut.art`.
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
const ZH_PATH = process.env.ZH_PATH ?? '/zh/index.html';
const REQUIRED_LANGS = ['en', 'zh-Hant', 'x-default'];

const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];

async function readHead(path) {
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  return page.evaluate(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    alternates: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map(el => ({
      hreflang: el.getAttribute('hreflang'),
      href: el.getAttribute('href'),
    })),
  }));
}

function toMap(alternates) {
  const map = {};
  for (const { hreflang, href } of alternates) map[hreflang] = href;
  return map;
}

// Validates one page's alternates (count, no dupes, absolute URLs, all three langs present,
// x-default == en) and returns the {lang: href} map for cross-page reciprocal comparison.
function validateAlternates(label, alternates) {
  if (alternates.length !== 3) {
    failures.push(`${label}: hreflang 列數應為 3，實 ${alternates.length}`);
  }
  const seen = new Set();
  for (const { hreflang, href } of alternates) {
    if (seen.has(hreflang)) failures.push(`${label}: hreflang="${hreflang}" 重複`);
    seen.add(hreflang);
    if (!href || !/^https:\/\//.test(href)) {
      failures.push(`${label}: hreflang="${hreflang}" href 非絕對 URL: ${href}`);
    }
  }
  for (const lang of REQUIRED_LANGS) {
    if (!seen.has(lang)) failures.push(`${label}: 缺 hreflang="${lang}"`);
  }
  const map = toMap(alternates);
  if (map.en && map['x-default'] && map.en !== map['x-default']) {
    failures.push(`${label}: x-default href (${map['x-default']}) != en href (${map.en})`);
  }
  return map;
}

const enHead = await readHead('/');
const enMap = validateAlternates('EN /', enHead.alternates);
if (!enHead.canonical) failures.push('EN /: 缺 canonical');
else if (enMap.en && enHead.canonical !== enMap.en) {
  failures.push(`EN /: canonical (${enHead.canonical}) != 自身 hreflang="en" href (${enMap.en})`);
}

const zhHead = await readHead(ZH_PATH);
const zhMap = validateAlternates(`ZH ${ZH_PATH}`, zhHead.alternates);
if (!zhHead.canonical) failures.push(`ZH ${ZH_PATH}: 缺 canonical`);
else if (zhMap['zh-Hant'] && zhHead.canonical !== zhMap['zh-Hant']) {
  failures.push(`ZH ${ZH_PATH}: canonical (${zhHead.canonical}) != 自身 hreflang="zh-Hant" href (${zhMap['zh-Hant']})`);
}

// Reciprocal: both pages must declare the exact same {lang: href} set.
const enKeys = Object.keys(enMap).sort();
const zhKeys = Object.keys(zhMap).sort();
const reciprocalOk = JSON.stringify(enKeys) === JSON.stringify(zhKeys)
  && enKeys.every(k => enMap[k] === zhMap[k]);
if (!reciprocalOk) {
  failures.push(`reciprocal 違反: EN 頁 ${JSON.stringify(enMap)} != ZH 頁 ${JSON.stringify(zhMap)}`);
}

await browser.close();

if (failures.length) { console.error('HREFLANG-CHECK FAIL:', failures); process.exit(1); }
console.log('HREFLANG-CHECK OK — EN/zh 各 3 列（絕對 URL＋reciprocal＋canonical 自指）');
