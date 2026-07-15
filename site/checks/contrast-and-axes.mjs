// Contrast acceptance check (Spec §7-2): every visible text node on the page must clear
// WCAG-style contrast against its effective background — 4.5:1 for small text, 3:1 for large text.
//
// Usage: node contrast-and-axes.mjs [baseURL]
// Requires a local server first, e.g. from repo root: `python3 -m http.server 8788 -d site`
//
// Two-page matrix (extended M3 Task 5 for the /zh/ page): '/' and the /zh/ homepage. Local
// `python3 -m http.server` has no cleanUrls rewrite, so locally the zh page is requested as
// `/zh/index.html`; in production (Vercel cleanUrls) it's `/zh/`. Set ZH_PATH to override for
// a production run.
//
// "axes" in the filename = the two WCAG contrast thresholds (small-text axis / large-text axis)
// being validated per node, not a font-variation-axes check.
//
// Large-text threshold (project decision, wider than strict WCAG 18.66px/700):
//   fontSize >= 24px, OR (fontSize >= 18.66px AND fontWeight >= 700)  [strict WCAG, aligned with Lighthouse/axe]
// This only widens the floor for `.tagline .big b` (brass on paper, ~4.06:1) which already
// clears the stricter WCAG large-text 3:1 minimum, so the wider floor is safe here.
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] ?? 'http://localhost:8788';
const PAGES = ['/', process.env.ZH_PATH ?? '/zh/index.html'];

const LARGE_MIN_PX = 24;
const LARGE_BOLD_MIN_PX = 18.66;
const LARGE_BOLD_MIN_WEIGHT = 700;
const SMALL_TEXT_MIN_RATIO = 4.5;
const LARGE_TEXT_MIN_RATIO = 3.0;

const browser = await chromium.launch();
const allViolations = [];
let totalChecked = 0;

for (const path of PAGES) {
const page = await browser.newPage();
// Forces every `.reveal` element straight to its final visible state (opacity:1, no transform/transition)
// per site/css/tokens.css's `@media (prefers-reduced-motion: reduce)` override — this sidesteps needing to
// scroll + wait for the IntersectionObserver-driven reveal animation before scanning computed styles.
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });

const result = await page.evaluate((cfg) => {
  const { LARGE_MIN_PX, LARGE_BOLD_MIN_PX, LARGE_BOLD_MIN_WEIGHT, SMALL_TEXT_MIN_RATIO, LARGE_TEXT_MIN_RATIO } = cfg;

  function parseColor(str) {
    if (!str || str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function relLuminance({ r, g, b }) {
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrastRatio(c1, c2) {
    const L1 = relLuminance(c1), L2 = relLuminance(c2);
    const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
    return (hi + 0.05) / (lo + 0.05);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      node = node.parentElement;
    }
    return true;
  }

  // Walk from <html> down to el, alpha-compositing each ancestor's background-color over a
  // white canvas default, so translucent backgrounds resolve to the correct effective color.
  function effectiveBackground(el) {
    const stack = [];
    let node = el;
    while (node) {
      stack.push(parseColor(getComputedStyle(node).backgroundColor));
      node = node.parentElement;
    }
    let bg = { r: 255, g: 255, b: 255 };
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i];
      if (!c || c.a === 0) continue;
      bg = {
        r: c.r * c.a + bg.r * (1 - c.a),
        g: c.g * c.a + bg.g * (1 - c.a),
        b: c.b * c.a + bg.b * (1 - c.a),
      };
    }
    return bg;
  }

  function describe(el) {
    const cls = el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.')
      : '';
    const id = el.id ? '#' + el.id : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  const violations = [];
  let checked = 0;
  const els = document.querySelectorAll('body *');
  for (const el of els) {
    // Scope: HTML text only. The single dynamic SVG <text> node (die dimensions label) uses
    // fill="var(--ink-soft)" on --paper, a pairing already >4.5:1 elsewhere on this page — not scanned here.
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const hasDirectText = Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasDirectText) continue;
    if (!isVisible(el)) continue;

    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize);
    let weight = parseFloat(cs.fontWeight);
    if (Number.isNaN(weight)) weight = cs.fontWeight === 'bold' ? 700 : 400;

    const isLarge = fontSize >= LARGE_MIN_PX || (fontSize >= LARGE_BOLD_MIN_PX && weight >= LARGE_BOLD_MIN_WEIGHT);
    const threshold = isLarge ? LARGE_TEXT_MIN_RATIO : SMALL_TEXT_MIN_RATIO;

    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const ratio = contrastRatio(fg, bg);
    checked++;

    if (ratio < threshold) {
      const text = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 60);
      violations.push({
        selector: describe(el),
        text,
        fontSizePx: fontSize,
        fontWeight: weight,
        isLarge,
        color: cs.color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: Math.round(ratio * 100) / 100,
        requiredRatio: threshold,
      });
    }
  }
  return { checked, violations };
}, { LARGE_MIN_PX, LARGE_BOLD_MIN_PX, LARGE_BOLD_MIN_WEIGHT, SMALL_TEXT_MIN_RATIO, LARGE_TEXT_MIN_RATIO });

await page.close();

// Scan-floor guard: a broken selector or a page that failed to load can silently produce
// zero (or near-zero) checked nodes, which would make this gate report "0 violations" and
// pass green while checking nothing. This site's healthy scan is ~98 text nodes on '/'; the
// zh page runs somewhat higher (bilingual layout keeps English-layer sentences alongside most
// zh copy — see M3 Task 5). Floors set generously under each page's healthy scan count.
const SCAN_FLOORS = { '/': 50, '/zh/index.html': 50, '/zh/': 50 };
const floor = SCAN_FLOORS[path] ?? 50;
if (result.checked < floor) {
  console.error(`SCAN TOO THIN on ${path}: only ${result.checked} text nodes (floor ${floor}) — selector or page likely broken`);
  await browser.close();
  process.exit(1);
}

totalChecked += result.checked;
for (const v of result.violations) allViolations.push({ page: path, ...v });
}

await browser.close();

if (allViolations.length) {
  console.error(`CONTRAST VIOLATIONS (${allViolations.length}/${totalChecked} text nodes checked across ${PAGES.length} pages):`);
  console.error(JSON.stringify(allViolations, null, 2));
  process.exit(1);
}
console.log(`CONTRAST OK — 0 violations across ${totalChecked} text nodes on ${PAGES.length} pages (large-text floor: >=${LARGE_MIN_PX}px or >=${LARGE_BOLD_MIN_PX}px+weight>=${LARGE_BOLD_MIN_WEIGHT})`);
