// Screenshot matrix acceptance check (Spec §7-3): full-page captures across
// {2 pages} × {375,768,1440} viewport widths × {default, reduced-motion} = 12, for Task 9's
// visual review loop and manual sign-off.
//
// Usage: node screenshots.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
//
// Two-page matrix (extended M3 Task 5 for the /zh/ page): '/' and the /zh/ homepage. Local
// `python3 -m http.server` has no cleanUrls rewrite, so locally the zh page is requested as
// `/zh/index.html`; in production (Vercel cleanUrls) it's `/zh/`. Set ZH_PATH to override for
// a production run.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
const PAGES = ['/', process.env.ZH_PATH ?? '/zh/index.html'];
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'shots');
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const MOTIONS = [
  { label: 'default', reducedMotion: 'no-preference' },
  { label: 'reduced', reducedMotion: 'reduce' },
];

// Strips a trailing slash (production ZH_PATH=/zh/) and an /index.html suffix (local
// ZH_PATH=/zh/index.html) down to the same 'zh' slug, so screenshot filenames stay stable
// across local vs. production runs instead of diverging into 'zh' vs 'zh-index'.
function pageSlug(path) {
  if (path === '/') return 'index';
  let p = path.replace(/^\//, '').replace(/\/$/, '');
  p = p.replace(/\/index\.html$/, '').replace(/\.html$/, '');
  return p.replace(/\//g, '-') || 'index';
}

const browser = await chromium.launch();
const shots = [];

let exitCode = 0;

for (const path of PAGES) {
  const slug = pageSlug(path);
  for (const vp of VIEWPORTS) {
    for (const motion of MOTIONS) {
      const page = await browser.newPage({ viewport: vp });
      await page.emulateMedia({ reducedMotion: motion.reducedMotion });
      await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
      // Let the real IntersectionObserver drive `.reveal` → `.reveal.in` instead of forcing the
      // class: scroll from the top in small 600px steps (with a short pause each step) so every
      // section actually crosses the observer's 0.15 threshold on the way down, matching how a
      // real visitor scrolling the page would trigger it. A single huge jump can skip a section's
      // viewport intersection entirely, leaving it stuck at opacity:0 (this is why the earlier,
      // now-removed classList.add('in') hack existed — it papered over that risk instead of
      // exercising the real reveal path).
      let pos = 0;
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
      while (pos < scrollHeight) {
        await page.mouse.wheel(0, 600);
        pos += 600;
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(900); // let the last section's opacity/transform transition settle
      await page.mouse.wheel(0, -scrollHeight); // scroll back to top for the full-page capture
      await page.waitForTimeout(400);

      // Signal check: for the default-motion runs, every `.reveal` element must actually have
      // received `.in` from the IntersectionObserver by now. If the reveal loop is dead (selector
      // drift, observer never firing, JS error), we want this to fail loudly rather than silently
      // capture a page full of invisible content. Reduced-motion is exempt: tokens.css's
      // `@media (prefers-reduced-motion: reduce)` override shows `.reveal` content directly via
      // CSS and never adds the `.in` class at all.
      const revealCounts = await page.evaluate(() => ({
        total: document.querySelectorAll('.reveal').length,
        in: document.querySelectorAll('.reveal.in').length,
      }));
      if (motion.label === 'default' && revealCounts.in < revealCounts.total) {
        console.error(`REVEAL SIGNAL BROKEN on ${path} at ${vp.width}-${motion.label}: only ${revealCounts.in}/${revealCounts.total} .reveal elements got .in — observer loop likely dead`);
        exitCode = 1;
      }

      const filename = `${slug}-${vp.width}-${motion.label}.png`;
      await page.screenshot({ path: join(OUT_DIR, filename), fullPage: true });
      shots.push(filename);
      await page.close();
    }
  }
}

await browser.close();

if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log(`SCREENSHOTS OK — ${shots.length} files written to site/checks/shots/: ${shots.join(', ')}`);
