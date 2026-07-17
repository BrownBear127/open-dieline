import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { allManifest, excludedManifest, manifest, tokenValues } from '../checks/e2e/derive-manifest.mjs';
import { gotoReady } from './helpers';

interface Declaration {
  prop: string;
  value: string;
}

type BaselineContext = 'design' | 'fold' | 'imposition' | 'modal' | 'zhDesign' | 'zhImposition' | 'zhModal';

// M3 實測 2026-07-16；fold context 實測 2026-07-17。共享語彙保留原 context 基線，
// 並在 fold 穩態重測；0 是顯式基線，表示來源保留該語彙但該穩態 DOM 沒有對應元件。
const EXPECTED_COUNTS = {
  design: {
    'input[type="range"]': 0,
    html: 1,
    body: 1,
    '#root': 1,
    '.app': 1,
    '.masthead': 1,
    '.masthead .wordmark': 1,
    '.masthead .wordmark em': 1,
    '.masthead .meta': 1,
    '.masthead .meta .lang b': 1,
    '.masthead .meta .lang span': 0,
    '.masthead .meta .lang button': 2,
    '.moderow': 1,
    '.moderow .modes': 1,
    '.moderow .modes .k': 1,
    '.mode': 3,
    '.mode.on': 1,
    '.moderow .readout': 1,
    '.moderow .readout b': 1,
    '.moderow .acts': 1,
    '.main': 1,
    '.console': 1,
    '.sect': 7,
    '.sect-head': 7,
    '.sect-head .label': 7,
    '.sect-head .mono': 6,
    '.boxsel': 3,
    '.boxsel select': 3,
    '.param': 14,
    '.param + .param': 9,
    '.param label': 14,
    '.param-head': 13,
    '.param-head label': 13,
    '.param-reset': 0,
    '.param-control': 13,
    '.param-control.is-overridden': 0,
    '.param input[type="number"]': 12,
    '.param-select select': 2,
    '.param input.tick': 0,
    '.param output': 0,
    '.param output small': 0,
    '.group-collapsed': 0,
    '.group-collapsed .n': 0,
    '.layer': 4,
    '.layer .tick': 4,
    '.layer .key': 4,
    '.layer .key.crease': 1,
    '.layer .key.halfcut': 1,
    '.layer .key.dim': 1,
    '.layer .mono': 4,
    '.layer .mono s': 1,
    '.btn': 6,
    '.btn.quiet': 2,
    '.btn.tog.on': 0,
    '.bench': 1,
    '.warnbar': 0,
    '.warnbar .n': 0,
    '.calibrate-bar': 0,
    '.calibrate-bar form': 0,
    '.calibrate-bar input': 0,
    '.calibrate-bar .btn': 0,
    '.calibrate-bar .error': 0,
    '.drawing': 1,
    '.drawing svg': 1,
    '.plate-label': 1,
    '.legend': 1,
    '.zoom': 1,
    '.legend i': 2,
    '.legend .crease-key i': 1,
    '.zoom b': 1,
    '.zoom .zbtn': 2,
    '.zoom .fit': 1,
    '.platebar': 1,
    '.platebar .status': 1,
    '.platebar .status b': 2,
    '.platebar .acts': 1,
    '.platebar .compat': 1,
    '.platebar .compat .tick': 1,
  },
  fold: {
    'input[type="range"]': 1,
    '.mode': 8,
    '.mode.on': 3,
    '.btn': 3,
    '.btn.quiet': 0,
    '.btn.tog.on': 0,
    '.foldbar .compat': 3,
    '.foldbar .compat .tick': 1,
  },
  imposition: {
    '.imp-toolbar': 1,
    '.imp-group': 7,
    '.imp-group .k': 7,
    '.imp-group .row': 7,
    '.imp-group .mono.val': 0,
    '.imp-results': 1,
    '.imp-card': 2,
    '.imp-card .best': 1,
    '.imp-card h4': 2,
    '.imp-card h4 em': 0,
    '.imp-card .sub': 4,
    '.imp-card .sheet': 2,
    '.imp-card .sheet svg': 2,
    '.imp-stats': 2,
    '.imp-stats div': 4,
    '.imp-stats div + div': 2,
    '.imp-stats .k': 4,
    '.imp-stats .v': 4,
    '.imp-stats .v small': 2,
    '.imp-group input[type="number"]': 2,
    '.imp-toolbar .err': 0,
  },
  modal: {
    '.modal-mask': 1,
    '.modal-card': 1,
    '.modal-card h2': 1,
    '.modal-body': 1,
  },
  zhDesign: {
    '.zh .label': 17,
    '.zh .mono': 32,
    '.zh .boxsel select': 3,
    '.zh .param-select select': 2,
  },
  zhImposition: {
    '.zh .imp-card h4': 2,
  },
  zhModal: {
    '.zh .modal-card h2': 1,
    '.zh .modal-body': 1,
    '.zh-note p b': 0,
  },
} as const satisfies Record<BaselineContext, Record<string, number>>;

// These properties cannot be normalized without masking an intentional browser
// behavior. Every other included declaration is compared; there is no implicit skip.
const SKIPPED = [
  {
    prop: 'transition',
    reason: 'A transition is time-dependent; transition is disabled while measuring final computed values.',
  },
  {
    prop: 'appearance',
    reason: 'The later @supports(base-select) rule intentionally overrides the fallback appearance in Chromium.',
  },
  {
    prop: '-webkit-appearance',
    reason: 'Chromium aliases this fallback to appearance, which the intentional @supports override replaces.',
  },
  {
    selector: '.param label',
    prop: 'margin-bottom',
    reason: 'Every current parameter label is inside .param-head, whose explicit margin-bottom: 0 override is tested separately.',
  },
] as const;

// F1（H1）: derive-manifest.mjs's EXCLUSION_RULES drop a selector from `manifest` (and this
// spec's Playwright coverage) whenever it cannot be addressed as a plain DOM locator —
// @font-face, @media/@supports-scoped rules, vendor-prefixed pseudo-elements, pseudo-
// elements, and pseudo-classes. That is a legitimate architectural boundary (required
// representatives — hover states, the range thumb, base-select picker rules — are sampled
// explicitly elsewhere in this file), but the exclusion previously only accumulated a
// per-category *count*: any new rule that happened to match one of those regexes (a new
// `@supports` block, a new `:focus-visible`, a minifier quirk that reclassifies a selector)
// would silently disappear from coverage with no failing test to catch it.
//
// This is the frozen identity of every currently-excluded selector — machine-derived from
// src/styles/vocab.css on 2026-07-16 via `node checks/e2e/derive-manifest.mjs` (grouped by
// selector; `classify()` is a pure function of selector text, so every declaration sharing a
// selector always lands in the same category). Every current property occurs exactly once
// per selector, so the frozen per-selector declaration count is the frozen props length.
// `excludedManifest` also carries its independently counted raw declaration total; adding a
// second declaration of an existing property therefore changes the manifest and fails.
const FROZEN_EXCLUSION_SET = [
  { selector: '.boxsel select:focus-visible', category: 'pseudoClass', props: ['outline', 'outline-offset'] },
  { selector: '.boxsel::after', category: 'pseudoElement', props: ['color', 'content', 'font-size', 'pointer-events', 'position', 'right', 'top', 'transform'] },
  { selector: '.btn.quiet:hover', category: 'pseudoClass', props: ['background', 'border-color', 'color'] },
  { selector: '.btn:hover', category: 'pseudoClass', props: ['background', 'color'] },
  { selector: '.calibrate-bar input:focus', category: 'pseudoClass', props: ['outline', 'outline-offset'] },
  { selector: '.drawing .rb::after', category: 'pseudoElement', props: ['border-bottom-width', 'border-color', 'border-right-width', 'border-style', 'border-width', 'bottom', 'content', 'height', 'position', 'right', 'width'] },
  { selector: '.drawing .rb::before', category: 'pseudoElement', props: ['border-bottom-width', 'border-color', 'border-left-width', 'border-style', 'border-width', 'bottom', 'content', 'height', 'left', 'position', 'width'] },
  { selector: '.drawing::after', category: 'pseudoElement', props: ['border-color', 'border-right-width', 'border-style', 'border-top-width', 'border-width', 'content', 'height', 'position', 'right', 'top', 'width'] },
  { selector: '.drawing::before', category: 'pseudoElement', props: ['border-color', 'border-left-width', 'border-style', 'border-top-width', 'border-width', 'content', 'height', 'left', 'position', 'top', 'width'] },
  { selector: '.imp-card:last-child', category: 'pseudoClass', props: ['border-right'] },
  { selector: '.imp-group input[type="number"]:focus', category: 'pseudoClass', props: ['border-bottom-color', 'outline'] },
  { selector: '.imp-group:last-child', category: 'pseudoClass', props: ['border-right'] },
  { selector: '.layer .tick.on::after', category: 'pseudoElement', props: ['background', 'content', 'inset', 'position'] },
  { selector: '.param input.tick:checked', category: 'pseudoClass', props: ['background', 'box-shadow'] },
  { selector: '.param input.tick:focus-visible', category: 'pseudoClass', props: ['outline', 'outline-offset'] },
  { selector: '.param input[type="number"]:focus', category: 'pseudoClass', props: ['border-bottom-color', 'outline'] },
  { selector: '.param-reset:focus-visible', category: 'pseudoClass', props: ['color'] },
  { selector: '.param-reset:hover', category: 'pseudoClass', props: ['color'] },
  { selector: '.param-select::after', category: 'pseudoElement', props: ['right'] },
  { selector: '.zoom .zbtn:hover', category: 'pseudoClass', props: ['background', 'border-color', 'color'] },
  { selector: '@font-face#0', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@font-face#1', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@font-face#2', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@font-face#3', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@font-face#4', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@font-face#5', category: 'fontFace', props: ['font-display', 'font-family', 'font-style', 'font-weight', 'src'] },
  { selector: '@supports (appearance: base-select)|.boxsel select', category: 'scopedAtRule', props: ['appearance'] },
  { selector: '@supports (appearance: base-select)|.boxsel select option', category: 'scopedAtRule', props: ['color', 'font-family', 'font-size', 'font-variation-settings', 'font-weight', 'padding'] },
  { selector: '@supports (appearance: base-select)|.boxsel select option::checkmark', category: 'scopedAtRule', props: ['display'] },
  { selector: '@supports (appearance: base-select)|.boxsel select option:checked', category: 'scopedAtRule', props: ['box-shadow'] },
  { selector: '@supports (appearance: base-select)|.boxsel select option:focus', category: 'scopedAtRule', props: ['background', 'color'] },
  { selector: '@supports (appearance: base-select)|.boxsel select option:hover', category: 'scopedAtRule', props: ['background', 'color'] },
  { selector: '@supports (appearance: base-select)|.boxsel select::picker(select)', category: 'scopedAtRule', props: ['appearance', 'background', 'border', 'border-radius', 'box-shadow', 'margin', 'position-area'] },
  { selector: '@supports (appearance: base-select)|.boxsel select::picker-icon', category: 'scopedAtRule', props: ['display'] },
  { selector: '@supports (appearance: base-select)|.param-select select', category: 'scopedAtRule', props: ['appearance'] },
  { selector: '@supports (appearance: base-select)|.param-select select option', category: 'scopedAtRule', props: ['color', 'font-family', 'font-size', 'font-variation-settings', 'font-weight', 'padding'] },
  { selector: '@supports (appearance: base-select)|.param-select select option::checkmark', category: 'scopedAtRule', props: ['display'] },
  { selector: '@supports (appearance: base-select)|.param-select select option:checked', category: 'scopedAtRule', props: ['box-shadow'] },
  { selector: '@supports (appearance: base-select)|.param-select select option:focus', category: 'scopedAtRule', props: ['background', 'color'] },
  { selector: '@supports (appearance: base-select)|.param-select select option:hover', category: 'scopedAtRule', props: ['background', 'color'] },
  { selector: '@supports (appearance: base-select)|.param-select select::picker(select)', category: 'scopedAtRule', props: ['appearance', 'background', 'border', 'border-radius', 'box-shadow', 'margin', 'position-area'] },
  { selector: '@supports (appearance: base-select)|.param-select select::picker-icon', category: 'scopedAtRule', props: ['display'] },
  { selector: 'input[type="range"]::-moz-range-thumb', category: 'vendorPrefixedSelector', props: ['background', 'border', 'border-radius', 'height', 'width'] },
  { selector: 'input[type="range"]::-moz-range-track', category: 'vendorPrefixedSelector', props: ['background', 'height'] },
  { selector: 'input[type="range"]::-webkit-slider-runnable-track', category: 'vendorPrefixedSelector', props: ['background', 'height'] },
  { selector: 'input[type="range"]::-webkit-slider-thumb', category: 'vendorPrefixedSelector', props: ['-webkit-appearance', 'background', 'border', 'border-radius', 'height', 'margin-top', 'transition', 'width'] },
  { selector: 'input[type="range"]::-webkit-slider-thumb:hover', category: 'vendorPrefixedSelector', props: ['background', 'border-color', 'transform'] },
] as const;

const FROZEN_EXCLUSION_MANIFEST = FROZEN_EXCLUSION_SET.map((entry) => ({
  ...entry,
  declarationCount: entry.props.length,
}));

// Stretch goal considered and not pursued (2026-07-16, honest note per spec): the pinned
// Chromium (1.61.1's bundled build, verified via `CSS.supports('appearance', 'base-select')`
// === true) does satisfy the `@supports (appearance: base-select)` condition, so the block's
// plain-element declarations (`.boxsel select { appearance: base-select }` etc.) are in
// principle reachable. But most of the block's content targets `::picker(select)`,
// `::picker-icon`, and `option`/`option::checkmark` inside that native picker — a top-layer
// UA popover that only exists in the DOM while the picker is actually open, is not a normal
// document element, and is not something this file's computed-style techniques (inline-style
// force-set, or a detached probe span) can address without materially new test
// infrastructure. Promoting only the plain-element declarations while leaving their sibling
// picker rules excluded would split one `@supports` block across two coverage regimes for no
// real gain — the frozen exclusion set above already closes H1's actual complaint (silent,
// unbounded growth of the excluded set); it does not by itself require testing the picker's
// internals.

// Shorthands are checked through explicit representative longhands. Insets expand
// to all four sides; border shorthands expand to width/style/color for that side;
// font and flex expand to the minimum behavior-bearing set used by this vocabulary.
const SHORTHAND_EXPANSIONS: Record<string, readonly string[]> = {
  background: ['background-color'],
  border: ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  font: ['font-family', 'font-size', 'font-style', 'font-weight', 'line-height'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
};

// F2（H2）: every matched instance of a selector is checked, not just one representative.
// A handful of manifest selectors legitimately share elements with a higher-specificity
// manifest selector (a real cascade override, e.g. the first `.mode` is also `.mode.on`).
// For those specific pairs, the overridden instance still gets checked — only the exact
// longhand properties the more specific selector declares are excluded, because they are
// independently verified when that selector's own manifest entry runs through this same
// loop. This is a named, narrow exclusion (not a blanket skip of the instance or selector),
// matching every other property against the base rule as usual. Membership in each pair is
// resolved dynamically per instance via a real `Element.matches()` call — not a hardcoded
// index — so it stays correct if DOM order ever changes.
const NAMED_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  '.mode': ['.mode.on'],
  '.btn': ['.btn.quiet', '.btn.tog.on'],
  '.legend i': ['.legend .crease-key i'],
  '.param': ['.param + .param'],
  '.imp-stats div': ['.imp-stats div + div'],
  // `.boxsel` and `.param-select` co-occur on the same wrapper (e.g. LayersPanel's overlay
  // unit select), so one `.boxsel select` instance also matches `.param-select select`.
  '.boxsel select': ['.param-select select'],
  // `:last-child` is excluded from `manifest` (EXCLUSION_RULES pseudoClass) but the override
  // is real; look it up in `allManifest` (allInstanceMismatches always reads override
  // declarations from allManifest, independent of the base selector's own inclusion).
  '.imp-group': ['.imp-group:last-child'],
  '.imp-card': ['.imp-card:last-child'],
  // The enum-type param control (glueSide) is a `<select>` inside `.boxsel`, so it also
  // matches `.boxsel select` — a compound class+type selector that outranks `.param-control`
  // (a single class selector) in specificity regardless of source order. `.boxsel select`'s
  // `color` genuinely wins the real cascade there; it is independently verified by that
  // selector's own manifest entry.
  '.param-control': ['.boxsel select'],
  '.layer .key': ['.layer .key.crease', '.layer .key.halfcut', '.layer .key.dim'],
};

function expandedProperties(declarations: readonly Declaration[]): Set<string> {
  const props = new Set<string>();
  for (const { prop } of declarations) {
    for (const longhand of SHORTHAND_EXPANSIONS[prop] ?? [prop]) props.add(longhand);
  }
  return props;
}

// F6（I2）: each sample now checks every observable longhand its machine-derived
// declarations cover (via SHORTHAND_EXPANSIONS), not a hand-picked subset — the previous
// list checked as few as 3 of 8 declared properties for `.boxsel::after`.
const PSEUDO_SAMPLES = [
  { selector: '.drawing', pseudo: '::before' },
  { selector: '.drawing', pseudo: '::after' },
  { selector: '.drawing .rb', pseudo: '::before' },
  { selector: '.drawing .rb', pseudo: '::after' },
  { selector: '.boxsel', pseudo: '::after' },
] as const;

// Declared longhands that this probe-span technique cannot compare meaningfully. Every
// other declared longhand for every sample above is checked; nothing else is implicitly
// skipped. Each entry must carry a reason — see the loop below for how this is enforced.
const PSEUDO_SKIPPED: Readonly<Record<string, string>> = {
  // Empirically verified 2026-07-16: with every other declared longhand checked (content,
  // position, right, top, font-size, color, pointer-events), `.boxsel::after`'s `transform`
  // is the one property that cannot be compared this way. `translateY(-50%)` resolves
  // against the participating box's own line-box height, which the bare probe `<span>`
  // does not reproduce identically to the real pseudo-element (host: matrix(1,0,0,1,0,-6.6),
  // probe: matrix(1,0,0,1,0,0)) even though the declaration is unchanged — a probe-technique
  // limitation, not a missing/incorrect declaration. `right`/`top`/`font-size` already prove
  // the positioning and sizing declarations reached the real pseudo-element.
  transform: 'height-relative percentage transform does not resolve identically on a bare probe span; see comment above.',
};
for (const [prop, reason] of Object.entries(PSEUDO_SKIPPED)) {
  if (!reason || reason.trim().length < 10) throw new Error(`PSEUDO_SKIPPED.${prop} needs a real reason (reason required)`);
}

// F3（H3）: the slider thumb sample moved out of this array — see the dedicated pixel-fixture
// test below. Its previous entry here drove a synthetic `<span>` proxy built from the same
// machine-parsed base/hover rules used as the expected value, which only proved "the source
// text can be applied to a generic element." It never touched the real minified build's
// `input[type="range"]::-webkit-slider-thumb:hover` selector or the real UA thumb, so a
// removed/broken selector in production CSS would not have failed it.
const HOVER_SAMPLES = [
  {
    name: 'button reverse',
    elementSelector: '.moderow .acts .btn:first-child',
    sourceSelector: '.btn:hover',
    properties: ['background-color', 'color'],
  },
] as const;

// F3（H3）: `--cut` (tokens.css) is the hover color declared for the real
// `input[type="range"]::-webkit-slider-thumb:hover` rule.
const CUT_RGB = { r: 0xc9, g: 0x3a, b: 0x2b } as const;
// Anti-aliased edge pixels blend --cut with the --paper background; a generous per-channel
// tolerance still cannot match --paper (#FAF7F0 ≈ 250,247,240 — over 45 off on every channel
// from --cut), so this stays discriminating.
const PIXEL_COLOR_TOLERANCE = 24;
// More than a single stray anti-aliased pixel, comfortably less than the ~13×13px thumb.
const MIN_MATCHING_PIXELS = 4;

interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Minimal PNG decoder for exactly what Playwright's own screenshot() produces (8-bit,
// non-interlaced RGB/RGBA). No project or transitive dependency ships a PNG decoder, and
// this fix wave's whole point is judgment about test *discrimination* — writing ~50 lines
// against the small, stable PNG chunk/filter spec (using only node:zlib for the DEFLATE
// stream) is more auditable here than reaching for a new devDependency for one assertion.
function decodePng(buffer: Buffer): DecodedPng {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG buffer');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatChunks: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (expected 8)`);
      if (interlace !== 0) throw new Error('Unsupported interlaced PNG');
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + length + 4; // length(4) + type(4) + data(N) + crc(4)
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (channels === null) throw new Error(`Unsupported PNG color type ${colorType} (expected RGB=2 or RGBA=6)`);

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  let rawOffset = 0;
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset]!;
    rawOffset += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rawOffset + x]!;
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prevRow[x]!;
      const c = x >= channels ? prevRow[x - channels]! : 0;
      let predicted: number;
      switch (filterType) {
        case 0: predicted = 0; break;
        case 1: predicted = a; break;
        case 2: predicted = b; break;
        case 3: predicted = Math.floor((a + b) / 2); break;
        case 4: predicted = paeth(a, b, c); break;
        default: throw new Error(`Unsupported PNG filter type ${filterType}`);
      }
      row[x] = (rawByte + predicted) & 0xff;
    }
    data.set(row, y * stride);
    rawOffset += stride;
    prevRow = row;
  }

  return { width, height, channels, data };
}

function countMatchingPixels(png: DecodedPng, target: { r: number; g: number; b: number }, tolerance: number): number {
  let count = 0;
  for (let i = 0; i < png.data.length; i += png.channels) {
    const r = png.data[i]!;
    const g = png.data[i + 1]!;
    const b = png.data[i + 2]!;
    if (Math.abs(r - target.r) <= tolerance && Math.abs(g - target.g) <= tolerance && Math.abs(b - target.b) <= tolerance) {
      count += 1;
    }
  }
  return count;
}

const FOLD_SHARED_SELECTORS = new Set([
  'input[type="range"]',
  '.mode',
  '.mode.on',
  '.btn',
  '.btn.quiet',
  '.btn.tog.on',
]);

function contextsFor(selector: string): readonly BaselineContext[] {
  if (selector.startsWith('.foldbar ')) return ['fold'];

  let primary: BaselineContext = 'design';
  if (selector.startsWith('.zh .imp-')) primary = 'zhImposition';
  else if (selector.startsWith('.zh .modal-') || selector.startsWith('.zh-note')) primary = 'zhModal';
  else if (selector.startsWith('.zh ')) primary = 'zhDesign';
  else if (selector.startsWith('.imp-')) primary = 'imposition';
  else if (selector.startsWith('.modal-')) primary = 'modal';

  return FOLD_SHARED_SELECTORS.has(selector) ? [primary, 'fold'] : [primary];
}

async function prepareContext(page: Page, context: BaselineContext): Promise<void> {
  const zh = context.startsWith('zh');
  await gotoReady(page, { lang: zh ? 'zh' : 'en' });

  if (context === 'fold') {
    await page.locator('.mode').filter({ hasText: 'Fold' }).click();
    await expect(page.locator('.foldbar')).toBeVisible();
  }
  if (context === 'imposition' || context === 'zhImposition') {
    await page.locator('.mode').filter({ hasText: zh ? '拼版估算' : 'Imposition' }).click();
  }
  if (context === 'modal' || context === 'zhModal') {
    await page.locator('.moderow .acts .btn').first().click();
  }
}

async function computedMismatches(
  page: Page,
  selector: string,
  declarations: readonly Declaration[],
  index: number,
  onlyProperties?: readonly string[],
  excludeProperties?: ReadonlySet<string>,
): Promise<string[]> {
  return page.locator(selector).nth(index).evaluate(
    (element, args) => {
      const target = element as HTMLElement | SVGElement;
      const skipped = new Set<string>(args.skippedProperties);
      const requested = args.onlyProperties ? new Set(args.onlyProperties) : null;
      const excluded = new Set<string>(args.excludeProperties ?? []);

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

      const mismatches: string[] = [];
      const oldTransition = target.style.getPropertyValue('transition');
      const oldTransitionPriority = target.style.getPropertyPriority('transition');
      target.style.setProperty('transition', 'none', 'important');

      for (const declaration of args.declarations) {
        if (skipped.has(declaration.prop)) continue;
        const properties = args.expansions[declaration.prop] ?? [declaration.prop];
        const requestedProperties = requested ? properties.filter((property) => requested.has(property)) : properties;
        const checkedProperties = requestedProperties.filter((property) => !excluded.has(property));
        if (checkedProperties.length === 0) continue;

        const actualStyle = getComputedStyle(target);
        const actual = Object.fromEntries(
          checkedProperties.map((property) => [property, actualStyle.getPropertyValue(property).trim()]),
        );
        const oldValue = target.style.getPropertyValue(declaration.prop);
        const oldPriority = target.style.getPropertyPriority(declaration.prop);
        target.style.setProperty(declaration.prop, resolveTokens(declaration.value), 'important');
        const expectedStyle = getComputedStyle(target);

        for (const property of checkedProperties) {
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

      if (oldTransition) target.style.setProperty('transition', oldTransition, oldTransitionPriority);
      else target.style.removeProperty('transition');
      return mismatches;
    },
    {
      declarations,
      expansions: SHORTHAND_EXPANSIONS,
      skippedProperties: SKIPPED.filter((entry) => !('selector' in entry) || entry.selector === selector).map(({ prop }) => prop),
      tokens: tokenValues,
      onlyProperties,
      excludeProperties: excludeProperties ? [...excludeProperties] : undefined,
    },
  );
}

// N2（H2）: iterate every matched instance and expand declarations only from override
// selectors that the current element actually matches. Different overrides of the same base
// selector must never donate each other's properties to a shared exclusion union.
async function allInstanceMismatches(
  page: Page,
  selector: string,
  declarations: readonly Declaration[],
  count: number,
): Promise<string[]> {
  const overrideSelectors = NAMED_OVERRIDES[selector] ?? [];

  const mismatches: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const matchedOverrideSelectors = overrideSelectors.length
      ? await page
          .locator(selector)
          .nth(index)
          .evaluate((element, selectors) => selectors.filter((s) => (element as Element).matches(s)), overrideSelectors)
      : [];
    const excludeProperties = matchedOverrideSelectors.length
      ? expandedProperties(
          matchedOverrideSelectors.flatMap((overrideSelector) =>
            (allManifest.get(overrideSelector) as Declaration[] | undefined) ?? [],
          ),
        )
      : undefined;
    const instanceMismatches = await computedMismatches(page, selector, declarations, index, undefined, excludeProperties);
    mismatches.push(...instanceMismatches.map((mismatch) => `instance[${index}]: ${mismatch}`));
  }
  return mismatches;
}

test.describe('machine-derived vocabulary baseline', () => {
  for (const context of Object.keys(EXPECTED_COUNTS) as BaselineContext[]) {
    test(`${context}: exact counts and computed declarations`, async ({ page }) => {
      await prepareContext(page, context);

      // F9（OD_INLINE_MUTATION）: standing negative control for F2 (H2) — an inline
      // override on the second (non-first) `.btn` instance must fail only the `.btn`
      // check, proving every matched instance is compared, not just index 0. Off by
      // default; exists only in page memory when the env var is set for this run.
      if (process.env.OD_INLINE_MUTATION === '1' && context === 'design') {
        await page.locator('.btn').nth(1).evaluate((element) => {
          (element as HTMLElement).style.setProperty('background', 'red', 'important');
        });
      }

      // N2 negative control: `.btn.quiet` does not match `.btn.tog.on`, so the latter's
      // background declaration must not hide this base `.btn` mismatch.
      if (process.env.OD_N2_MUTATION === '1' && context === 'design') {
        await page.locator('.btn.quiet').first().evaluate((element) => {
          (element as HTMLElement).style.setProperty('background', 'red', 'important');
        });
      }

      const expectedCounts: Record<string, number> = EXPECTED_COUNTS[context];
      for (const [selector, declarations] of manifest as Map<string, Declaration[]>) {
        if (!contextsFor(selector).includes(context)) continue;
        const expectedCount = expectedCounts[selector];
        expect(expectedCount, `Missing frozen count for ${selector}`).not.toBeUndefined();
        await expect(page.locator(selector), `${selector} count`).toHaveCount(expectedCount!);

        if (expectedCount! > 0) {
          const mismatches = await allInstanceMismatches(page, selector, declarations, expectedCount!);
          expect(mismatches, `${selector} computed declarations (all ${expectedCount} instances)`).toEqual([]);
        }
      }

      const assignedSelectors = [...manifest.keys()].filter((selector) => contextsFor(selector).includes(context));
      expect(Object.keys(expectedCounts).sort(), `${context} count table coverage`).toEqual(assignedSelectors.sort());
    });
  }
});

// F1（H1）: the manifest's exclusion set is frozen, not just counted. This is a pure
// data-derivation check — no browser needed — but lives in this file (per the spec) beside
// the manifest it guards. A new selector/property or a repeated declaration on an existing
// selector changes `excludedManifest` and must be reviewed before updating the frozen data.
test('manifest exclusion identity and declaration multiplicity are frozen', () => {
  expect(excludedManifest, 'excludedManifest identity or per-selector multiplicity drifted').toEqual(
    FROZEN_EXCLUSION_MANIFEST,
  );
});

test('explicit pseudo-element samples', async ({ page }) => {
  await gotoReady(page);

  for (const sample of PSEUDO_SAMPLES) {
    const declarations = allManifest.get(`${sample.selector}${sample.pseudo}`) as Declaration[] | undefined;
    expect(declarations, `Missing source declarations for ${sample.selector}${sample.pseudo}`).toBeDefined();
    const properties = [...expandedProperties(declarations!)].filter((property) => !(property in PSEUDO_SKIPPED));

    const mismatches = await page.locator(sample.selector).first().evaluate(
      (element, args) => {
        const host = element as HTMLElement;
        const actual = getComputedStyle(host, args.pseudo);
        const probe = document.createElement('span');
        probe.style.setProperty('transition', 'none', 'important');
        for (const { prop, value } of args.declarations) {
          const resolved = value.replace(/var\((--[\w-]+)\)/g, (_match, name: string) => args.tokens[name]!);
          probe.style.setProperty(prop, resolved, 'important');
        }
        host.append(probe);
        const expected = getComputedStyle(probe);
        const failures = args.properties.flatMap((property) => {
          const actualValue = actual.getPropertyValue(property).trim();
          const expectedValue = expected.getPropertyValue(property).trim();
          return actualValue === expectedValue ? [] : [`${property}: expected ${expectedValue}, got ${actualValue}`];
        });
        probe.remove();
        return failures;
      },
      { pseudo: sample.pseudo, properties, declarations: declarations!, tokens: tokenValues },
    );

    expect(mismatches, `${sample.selector}${sample.pseudo}`).toEqual([]);
  }
});

test('explicit hover samples', async ({ page }) => {
  await gotoReady(page);

  for (const sample of HOVER_SAMPLES) {
    const declarations = allManifest.get(sample.sourceSelector) as Declaration[] | undefined;
    expect(declarations, `Missing hover source ${sample.sourceSelector}`).toBeDefined();
    await page.hover(sample.elementSelector);
    await page.waitForTimeout(200);
    const mismatches = await computedMismatches(page, sample.elementSelector, declarations!, 0, sample.properties);
    expect(mismatches, sample.name).toEqual([]);
  }
});

// F3（H3）: real `<input type="range">` fixture, verified with a pixel diff instead of a
// computed-style comparison — Chromium exposes no computed-style handle for the UA slider
// thumb pseudo-element at all, but it does render real, screenshottable pixels for it. A
// one-time disposable fixture, appended into a real `.param` container and removed after the
// assertion (same convention as the `.param output` font probe in zh-geometry.spec.ts), lets
// the actual production stylesheet — not a hand-rebuilt proxy — style a genuine native thumb.
// This is the only technique in this file that can catch: (1) the compiled selector being
// dropped/mismangled by minification, (2) the selector failing to match the real element
// (wrong specificity, wrong pseudo-element name for the shipped browser target), and (3) the
// hover style not being visually applied at all — none of which the previous synthetic-span
// proxy could detect, since it built both "expected" and "actual" from the same source text.
test('slider thumb hover changes the real UA thumb color (pixel fixture)', async ({ page }) => {
  await gotoReady(page);

  const testId = 'slider-thumb-fixture';
  await page.locator('.param').first().evaluate((param, id) => {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.value = '50'; // midpoint: the WebKit thumb travel formula centers the thumb
    // horizontally in the track at the midpoint value regardless of thumb width, so a plain
    // hover() (which targets the element's bounding-box center) lands on the real thumb.
    input.dataset.testid = id;
    param.append(input);
  }, testId);

  const input = page.getByTestId(testId);
  await expect(input).toBeVisible();

  const beforeScreenshot = await input.screenshot();
  await input.hover();
  await page.waitForTimeout(200);
  const afterScreenshot = await input.screenshot();

  const beforeMatches = countMatchingPixels(decodePng(beforeScreenshot), CUT_RGB, PIXEL_COLOR_TOLERANCE);
  const afterMatches = countMatchingPixels(decodePng(afterScreenshot), CUT_RGB, PIXEL_COLOR_TOLERANCE);
  console.log(`SLIDER-THUMB-PIXELS before=${beforeMatches} after=${afterMatches}`);

  await input.evaluate((element) => element.remove());

  expect(beforeMatches, 'no --cut-colored pixels before hover (default thumb is --paper)').toBe(0);
  expect(afterMatches, 'hovering the real range input must paint --cut-colored pixels on the real UA thumb').toBeGreaterThanOrEqual(
    MIN_MATCHING_PIXELS,
  );
});
