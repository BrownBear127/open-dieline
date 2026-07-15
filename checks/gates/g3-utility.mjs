// checks/gates/g3-utility.mjs — G3：TSX/CSS/SVG 色彩與字體入口禁令（Spec §6.2 I3 掃描面）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PATTERNS = [
  // Tailwind 帶色 utility（含任意值 [#hex]）
  /\b(?:text|bg|border|accent|fill|stroke|ring|outline|shadow|decoration|caret|divide)-(?:\[#|(?:inherit|current|transparent|black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b)/g,
  // Tailwind 字體/字距/字級/行高
  /\b(?:font-(?:sans|serif|mono|thin|light|normal|medium|semibold|bold|black)|text-(?:xs|sm|base|lg|xl|\dxl|\[)|tracking-|leading-)/g,
  // TSX 內 SVG 色 attribute 字面量（放行 none/currentColor/inherit/var()）
  /\b(?:fill|stroke)=\{?["'](?!none|currentColor|inherit|var\()[#a-zA-Z0-9]/g,
  // style object 色值
  /\b(?:color|background|backgroundColor|borderColor|fill|stroke)\s*:\s*["']#?[0-9a-fA-F]{3,8}["']/g,
];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(tsx|ts|css|svg)$/.test(e)) yield p;
  }
}

// 誤報收窄（2026-07-16·實跑 279 命中人工核對後加）：JSDoc/區塊註解常引用 Tailwind class 名當
// 文件散文（如 impositionIcons.tsx 檔頭「統一走 `stroke="currentColor"`...選中態 `text-white`／
// 未選 `text-zinc-600`」——純散文說明選中態視覺，該檔實際零 Tailwind className），逐字比對規則
// 4 條 PATTERNS 對這類散文一樣會命中，但那不是真正的 utility-class 使用點。修法收窄在「不掃描
// `/* ... */` 區塊註解內文」（與 g2-vocab.mjs 的 stripComments() 同一手法），而非為個別命中加
// allowlist 條目——這樣涵蓋所有現在與未來同類散文，不是頭痛醫頭。只用區塊註解（`/* */`）而非
// `//` 行註解：這個 codebase 全部用 JSDoc `/** */` 風格、且原始碼字面內有 `https://` 等含 `//`
// 的字串字面量（AnnouncementModal.tsx 的 href、svg.ts 的 xmlns），naive 行註解剝除會誤傷這些
// 字串字面量；已核實此 repo 目前沒有任何 `//` 行註解含 pattern 會命中的 token，故不需處理該類。
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

export async function run({ root }) {
  const allow = JSON.parse(readFileSync(path.join(root, 'checks/gates/g3-allowlist.json'), 'utf8'));
  const ratchet = JSON.parse(readFileSync(path.join(root, 'checks/gates/g3-ratchet.json'), 'utf8'));
  const hits = [];
  for (const file of walk(path.join(root, 'src'))) {
    if (file.includes(`${path.sep}styles${path.sep}`)) continue; // tokens/vocab 本身是語彙真相源
    const rel = path.relative(root, file);
    const text = stripBlockComments(readFileSync(file, 'utf8'));
    for (const re of PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
        const allowed = allow.some((a) => a.file === rel && m[0].includes(a.pattern));
        if (!allowed) hits.push(`${rel}: ${m[0]}`);
      }
    }
  }
  const errs = [];
  if (hits.length > ratchet.maxViolations) {
    errs.push(`違規 ${hits.length} > ratchet ${ratchet.maxViolations}：`, ...hits.slice(0, 30));
  }
  console.log(`  [g3] 現況違規 ${hits.length}／ratchet ${ratchet.maxViolations}`);
  return errs;
}
