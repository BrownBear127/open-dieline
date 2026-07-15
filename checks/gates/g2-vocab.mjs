// checks/gates/g2-vocab.mjs — G2：vocab 宣告在建置後 CSS 逐項存在且未被後置覆寫（Spec §8.1 C4）
// 分工註記：跨 selector 的 specificity/cascade 與 inline style 由 Playwright 層（§8.3）接手；
// 本 gate 抓「同 selector 同 property 的後置重宣告」與「宣告缺席/值漂移」兩族。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

/** 陽春 CSS 解析：頂層 rule 的 selector→[{prop,value}]。@media 等 at-rule 內層遞迴展開，
 *  selector 前綴 `@media …|`（G2 只要求「同 scope 同 selector」不重複宣告）。
 *  `seen`：同一 header 文字的出現次序計數器（見下方無巢狀 at-rule 分支的消歧說明），
 *  頂層呼叫端不用傳，遞迴自己接力共用同一個 Map。 */
export function parseDeclarations(cssText, scope = '', seen = new Map()) {
  const out = [];
  const css = stripComments(cssText);
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const header = css.slice(i, brace).trim();
    let depth = 1, j = brace + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; if (css[j] === '}') depth--; j++; }
    const body = css.slice(brace + 1, j - 1);
    if (header.startsWith('@') && body.includes('{')) {
      out.push(...parseDeclarations(body, `${scope}${header}|`, seen));
    } else if (!header.startsWith('@')) {
      for (const decl of body.split(';')) {
        const k = decl.indexOf(':');
        if (k === -1) continue;
        out.push({ selector: scope + header.replace(/\s+/g, ' '), prop: decl.slice(0, k).trim(), value: decl.slice(k + 1).trim() });
      }
    } else {
      // @font-face 等無巢狀 selector 的 at-rule：header 文字本身可合法重複出現多次（vocab.css
      // T9 起有六顆 @font-face）。若直接用 `scope + header` 當 selector，六個區塊的宣告會被
      // 塞進同一個 key，讓比對器把彼此當成「同 selector 重複宣告」互相誤判值漂移。用出現次序
      // 加尾碼消歧（`#0`/`#1`/…）——只在「build 不重排同 header 的相對順序」時安全：CSS 規則
      // 順序本身有 cascade 語意，bundler 不會重排（`--minify false` 下逐字驗證過六顆 @font-face
      // 在來源與建置產物裡的相對順序與內容一致，2026-07-16）。manifest（vocab.css 單獨呼叫）與
      // built（建置產物單獨呼叫）各自從自己的計數器從 0 開始數，只要兩邊同 header 的相對順序
      // 一致，序號就能正確配對。
      const key = scope + header;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const uniqueSelector = `${key}#${n}`;
      for (const decl of body.split(';')) {
        const k = decl.indexOf(':');
        if (k === -1) continue;
        out.push({ selector: uniqueSelector, prop: decl.slice(0, k).trim(), value: decl.slice(k + 1).trim() });
      }
    }
    i = j;
  }
  return out;
}

// --- norm() 擴充記錄（2026-07-16·Task 4 Step 4）--------------------------------------------
// Tailwind v4（`@import "tailwindcss"`）用 Lightning CSS 做 target-based 語法降級，即使關掉
// minify 仍會跑（見 checks/style-gate.mjs 的 --minify false 註記）。以下每條都驗證過是「同一
// CSS 語義的不同序列化」，不是放寬值語義：
//   1. 引號/逗號後空白/大小寫 — 既有 norm() 底子（quote 統一、trim、lowercase）
//   2. 前導零省略：`0.16em`→`.16em`（spec 原點名的例子）
//   3. font-family 引號可省略時剝除：`"Familjen Grotesk"`→`Familjen Grotesk`（合法 custom-ident）
//   4. 顏色正規化：`rgba(25,23,18,0.25)`→`#19171240`、`transparent`→`#0000`（數值換算逐位驗證
//      過：25→0x19、23→0x17、18→0x12、0.25×255=63.75→round 64→0x40；transparent=rgba(0,0,0,0)）
//      → colorToHex8() 把兩邊都換算成同一 canonical rgba tuple 再比較，token-level（保留
//      compound value 裡其他非顏色 token 原樣，如 `1px solid <color>` 只轉最後一節）
// --- selector 正規化（同一根因，但作用對象是 selector 不是 value，故獨立 normSelector()）----
//   5. pseudo-element 降級：`::before`→`:before`（唯一在 --minify false 下仍發生的 selector 級
//      轉寫；attribute selector 引號剝除／selector 內逗號-組合子空白剝除已靠關 minify 消除，
//      不需在此吸收——驗證見 report）
// --- 2 條屬性專屬別名表（非 tokenizer 能推導·各自逐一驗證是否放行前先讀註解）------------------
//   6. `background: transparent` shorthand ≡ `background: none`（transform-origin 同理，皆是
//      CSS 規格層級的「省略值→套用該子屬性 initial value」，不是 minifier 的自由發揮）
const normSelector = (s) => s.replace(/::/g, ':');

function colorToHex8(tok) {
  const t = tok.trim().toLowerCase();
  if (t === 'transparent') return '#00000000';
  let m = t.match(/^#([0-9a-f]{3})$/);
  if (m) { const [r, g, b] = m[1].split(''); return `#${r}${r}${g}${g}${b}${b}ff`; }
  m = t.match(/^#([0-9a-f]{4})$/);
  if (m) { const [r, g, b, a] = m[1].split(''); return `#${r}${r}${g}${g}${b}${b}${a}${a}`; }
  m = t.match(/^#([0-9a-f]{6})$/);
  if (m) return `#${m[1]}ff`;
  if (/^#([0-9a-f]{8})$/.test(t)) return t;
  m = t.match(/^rgba?\(([\d.]+),([\d.]+),([\d.]+)(?:,([\d.]+))?\)$/);
  if (m) {
    const [, r, g, b, a] = m;
    const hex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
    const alpha = a === undefined ? 255 : Math.round(Number(a) * 255);
    return `#${hex(r)}${hex(g)}${hex(b)}${hex(alpha)}`;
  }
  return null; // 非顏色 token（如 `1px`、`solid`、`var(--x)`）——原樣放行給呼叫端比對
}

// background shorthand：單一 token 且該 token 等價「僅設色、其餘子屬性維持 initial」時，
// `transparent`／`none`／`0 0`／`0% 0%` 四種序列化渲染結果相同（transparent=color 的 initial
// 值、0 0≈0% 0%=position 的 initial 值、none=image 的 initial 值——三者殊途同歸皆是「no-op」）。
// 比對點在 colorToHex8() 之後，故 'transparent' 在此已恆等於 '#00000000'（colorToHex8 保證）。
const BACKGROUND_TRANSPARENT_ALIASES = new Set(['#00000000', 'none', '0 0', '0% 0%']);

function normValue(raw) {
  let v = raw.replace(/\s+/g, ' ').replace(/"/g, "'").replace(/'/g, '').trim().toLowerCase();
  v = v.replace(/\s*,\s*/g, ',');                    // 逗號後空白（Lightning CSS 降級效應）
  v = v.replace(/(?<![0-9])0(\.\d)/g, '$1');         // 前導零：0.16em → .16em
  const tokens = v.split(' ').map((tok) => colorToHex8(tok) ?? tok);
  return tokens.join(' ');
}

function valuesEqual(manifestValue, builtValue, prop) {
  const a = normValue(manifestValue);
  const b = normValue(builtValue);
  if (a === b) return true;
  if (prop === 'background' && BACKGROUND_TRANSPARENT_ALIASES.has(a) && BACKGROUND_TRANSPARENT_ALIASES.has(b)) return true;
  if (prop === 'transform-origin') {
    const strip50 = (s) => s.replace(/^(\S+) (50%|center)$/, '$1');
    if (strip50(a) === strip50(b)) return true;
  }
  return false;
}

export async function run({ root, distDir }) {
  const errs = [];
  const vocab = parseDeclarations(readFileSync(path.join(root, 'src/styles/vocab.css'), 'utf8'));
  const tokens = parseDeclarations(readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8'));
  const manifest = [...tokens, ...vocab].map((d) => ({ ...d, selector: normSelector(d.selector) }));

  const assetsDir = path.join(distDir, 'assets');
  const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'));
  if (cssFiles.length === 0) return ['建置產物無 CSS——gate 自身失效（sanity check）'];
  const built = cssFiles.map((f) => readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
  const builtDecls = parseDeclarations(built).map((d) => ({ ...d, selector: normSelector(d.selector) }));

  // vendor-prefix 豁免（第 6 條擴充，2026-07-16）：Lightning CSS 的 target-based autoprefixer
  // 會在「同 rule 內前綴/無前綴宣告並存」時砍掉前綴版（如 `-webkit-appearance` 旁邊已有
  // `appearance` 時整個前綴宣告消失）——這是編譯器判定「當前 targets 下前綴多餘」，不是宣告被
  // 覆寫/遺失。豁免條件很窄：僅當同 selector 內有同值的無前綴版本、且該無前綴版本在建置產物裡
  // 本身健在（存在＋值不漂移）才放行，否則仍照常報「缺席」。
  const VENDOR_PREFIX_RE = /^-(webkit|moz|ms|o)-(.+)$/;
  const isPrefixElisionSafe = (d) => {
    const m = d.prop.match(VENDOR_PREFIX_RE);
    if (!m) return false;
    const baseProp = m[2];
    const sibling = manifest.find((x) => x.selector === d.selector && x.prop === baseProp);
    if (!sibling) return false;
    const siblingHits = builtDecls.filter((b) => b.selector === d.selector && b.prop === baseProp);
    if (siblingHits.length === 0) return false;
    return valuesEqual(sibling.value, siblingHits[siblingHits.length - 1].value, baseProp);
  };

  for (const d of manifest) {
    const hits = builtDecls.filter((b) => b.selector === d.selector && b.prop === d.prop);
    if (hits.length === 0) {
      if (isPrefixElisionSafe(d)) continue;
      errs.push(`缺席：${d.selector} { ${d.prop} }`);
      continue;
    }
    const last = hits[hits.length - 1];               // cascade 生效的是最後一筆
    if (!valuesEqual(d.value, last.value, d.prop)) errs.push(`值漂移/後置覆寫：${d.selector} { ${d.prop}: ${last.value} }（凍結=${d.value}）`);
    if (hits.length > 1 && hits.some((h) => !valuesEqual(d.value, h.value, d.prop))) errs.push(`同 selector 重複宣告含異值：${d.selector} { ${d.prop} } ×${hits.length}`);
  }
  if (manifest.length < 50) errs.push(`manifest 僅 ${manifest.length} 條——疑似 vocab.css 空心（sanity check）`);
  return errs;
}
