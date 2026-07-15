// Screenshot matrix acceptance check (Spec §7-3): full-page captures across
// {375,768,1440} viewport widths × {default, reduced-motion}, for Task 9's visual
// review loop and manual sign-off.
//
// Usage: node screenshots.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
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

const browser = await chromium.launch();
const shots = [];

for (const vp of VIEWPORTS) {
  for (const motion of MOTIONS) {
    const page = await browser.newPage({ viewport: vp });
    await page.emulateMedia({ reducedMotion: motion.reducedMotion });
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    // Force every scroll-triggered `.reveal` element straight to its settled state instead of
    // relying on IntersectionObserver firing during a scripted scroll: a single huge
    // page.mouse.wheel(0, 20000) jump (as used in external-requests.mjs, where it's fine —
    // that check only cares about request URLs) can skip past a mid-page section's viewport
    // intersection entirely, leaving it permanently stuck at opacity:0 in the capture. Confirmed
    // while validating this script: the `default`-motion #instrument section came back blank
    // under that approach (copyHasIn:false, opacity:'0') even after a 1.5s wait post-scroll.
    await page.evaluate(() => document.querySelectorAll('.reveal').forEach(el => el.classList.add('in')));
    await page.waitForTimeout(1500); // let the opacity/transform transition (max ~0.4s delay + 0.85s duration) settle
    const filename = `${vp.width}-${motion.label}.png`;
    await page.screenshot({ path: join(OUT_DIR, filename), fullPage: true });
    shots.push(filename);
    await page.close();
  }
}

await browser.close();
console.log(`SCREENSHOTS OK — ${shots.length} files written to site/checks/shots/: ${shots.join(', ')}`);
