// A15：i18n dict key 集與三份 vendored copy inventory 雙向一致；全 key EN/zh 逐字一致
//（2026-07-16 M2 T0：B5 家族逐字化——EN 讀 tierb 附錄 B 終稿表·zh 讀 expansion §B5·key-only 歸零）。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const VERIFIED_TIER_B_SECTIONS = ['B3', 'B4', 'B6'];

function cells(line) {
  const result = [];
  let cell = '';
  let inCode = false;

  for (let index = 1; index < line.length - 1; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '\\' && (next === '|' || next === '\\')) {
      cell += next;
      index += 1;
    } else if (char === '`') {
      inCode = !inCode;
      cell += char;
    } else if (char === '|' && !inCode) {
      result.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  result.push(cell.trim());
  return result;
}

function markdownRows(markdown) {
  const rows = [];
  let headers = null;

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('|') || !line.endsWith('|')) {
      headers = null;
      continue;
    }

    const values = cells(line);
    if (!headers) {
      headers = values;
      continue;
    }
    if (values.every((value) => /^:?-{3,}:?$/.test(value))) continue;
    if (values.length !== headers.length) {
      throw new Error(`markdown table column mismatch: ${line}`);
    }

    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  }

  return rows;
}

function headingSection(markdown, start, end) {
  const startMatch = new RegExp(`^#{2,4}\\s+${start}\\b.*$`, 'm').exec(markdown);
  if (!startMatch) throw new Error(`inventory section missing: ${start}`);
  const remainder = markdown.slice(startMatch.index + startMatch[0].length);
  const endMatch = new RegExp(`^#{2,4}\\s+${end}\\b.*$`, 'm').exec(remainder);
  if (!endMatch) throw new Error(`inventory section missing: ${start} … ${end}`);
  return remainder.slice(0, endMatch.index);
}

function between(markdown, start, end) {
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`inventory section missing: ${start} … ${end}`);
  return markdown.slice(from, to);
}

function stripCodeFormatting(value) {
  return value.replace(/`([^`]*)`/g, '$1').trim();
}

function expandKeys(keyCell, enCell = '') {
  const key = stripCodeFormatting(keyCell);
  if (!key || key.endsWith('.*')) return [];

  if (key === 'imp.sheet.preset.{i}') {
    return enCell.split('／').map((value) => {
      const match = value.trim().match(/^(\d+)"×(\d+)"$/);
      if (!match) throw new Error(`cannot expand inventory preset: ${value}`);
      return `imp.sheet.preset.${match[1]}x${match[2]}`;
    });
  }

  const parts = key.split('/').map((part) => stripCodeFormatting(part));
  if (parts.length === 1) return parts;

  const prefix = parts[0].slice(0, parts[0].lastIndexOf('.') + 1);
  return parts.map((part, index) => {
    if (index === 0) return part;
    return `${prefix}${part.startsWith('.') ? part.slice(1) : part}`;
  });
}

function expandValues(valueCell, count) {
  if (count === 1) return [valueCell.trim()];
  const values = valueCell.split('／').map((value) => value.trim());
  if (values.length !== count) {
    throw new Error(`inventory grouped value count mismatch: ${valueCell} (${values.length} values for ${count} keys)`);
  }
  return values;
}

function sameAsEnglish(value) {
  return value === '—' || value.startsWith('—（') || value.startsWith('骨架 lock');
}

function dictEntries(source) {
  const entries = new Map();
  const entryPattern = /^\s*'([^']+)':\s*\{\s*en:\s*'((?:\\.|[^'\\])*)',\s*zh:\s*'((?:\\.|[^'\\])*)',?\s*\}/gm;
  for (const match of source.matchAll(entryPattern)) {
    if (entries.has(match[1])) throw new Error(`duplicate dict key: ${match[1]}`);
    entries.set(match[1], {
      en: decodeSingleQuoted(match[2]),
      zh: decodeSingleQuoted(match[3]),
    });
  }

  const declaredKeys = [...source.matchAll(/^\s*'([^']+)':\s*\{/gm)].map((match) => match[1]);
  const unparsed = declaredKeys.filter((key) => !entries.has(key));
  if (unparsed.length) throw new Error(`cannot parse dict values: ${unparsed.join(', ')}`);
  return entries;
}

function decodeSingleQuoted(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      decoded += value[index];
      continue;
    }

    const escaped = value[index + 1];
    const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
    if (escaped in simpleEscapes) decoded += simpleEscapes[escaped];
    else if (escaped === "'" || escaped === '"' || escaped === '\\') decoded += escaped;
    else throw new Error(`unsupported dict string escape: \\${escaped}`);
    index += 1;
  }
  return decoded;
}

function addKey(target, key) {
  if (key) target.add(key);
}

function addValue(target, key, locale, value) {
  const locales = target.get(key) ?? {};
  const previous = locales[locale];
  if (previous !== undefined && previous !== value) {
    throw new Error(`conflicting ${locale} inventory values for ${key}: ${JSON.stringify(previous)} ↔ ${JSON.stringify(value)}`);
  }
  locales[locale] = value;
  target.set(key, locales);
}

function addCopyInventory(keys, values, copyInventory) {
  for (const row of markdownRows(copyInventory)) {
    const keyCell = row.key;
    const enCell = row['EN（終稿）'] ?? row.EN;
    if (!keyCell || enCell === undefined) continue;

    const expandedKeys = expandKeys(keyCell, enCell);
    for (const key of expandedKeys) addKey(keys, key);
    if (!expandedKeys.length || enCell.startsWith('— Tier B')) continue;

    const enValues = expandValues(enCell, expandedKeys.length);
    let zhValues = sameAsEnglish(row.zh) ? enValues : expandValues(row.zh, expandedKeys.length);

    if (expandedKeys.length === 1 && expandedKeys[0] === 'canvas.legend.crease') {
      const decision = row.lock?.match(/裁決=統一用「([^」]+)」/);
      if (!decision) throw new Error('canvas.legend.crease final zh decision missing');
      zhValues = [decision[1]];
    }

    expandedKeys.forEach((key, index) => {
      addValue(values, key, 'en', enValues[index]);
      if (key !== 'overlay.select.title') addValue(values, key, 'zh', zhValues[index]);
    });
  }
}

function addExpansionGaps(keys, values, expansion) {
  const gaps = between(expansion, '## 節 2：', '## 節 3：');
  for (const row of markdownRows(gaps)) {
    const type = row['類型'];
    const keyCell = row['key／項目'];
    const valueCell = row['值'];
    if (!type || !keyCell || valueCell === undefined) continue;

    if (type.startsWith('缺 key')) {
      const expandedKeys = expandKeys(keyCell, valueCell);
      const expandedValues = expandValues(valueCell, expandedKeys.length);
      expandedKeys.forEach((key, index) => {
        addKey(keys, key);
        addValue(values, key, 'en', expandedValues[index]);
        addValue(values, key, 'zh', expandedValues[index]);
      });
    } else if (type === 'zh 逐字訂正') {
      const correctedKey = keyCell.match(/`([^`]+)`/)?.[1] ?? keyCell;
      const expandedKeys = expandKeys(correctedKey);
      const corrected = valueCell.match(/<br>應為（[^）]+）：(.+)$/);
      if (expandedKeys.length !== 1 || !corrected) {
        throw new Error(`cannot parse zh correction: ${keyCell} ↔ ${valueCell}`);
      }
      addValue(values, expandedKeys[0], 'zh', corrected[1].replaceAll('**', ''));
    }
  }
}

function rowsForSection(markdown, section) {
  const next = `B${Number(section.slice(1)) + 1}`;
  return markdownRows(headingSection(markdown, section, next)).filter((row) => row.key);
}

function addTierB(keys, values, expansion, tierBEnglish) {
  for (const section of VERIFIED_TIER_B_SECTIONS) {
    const expansionRows = rowsForSection(expansion, section);
    const englishRows = rowsForSection(tierBEnglish, section);

    for (const row of [...expansionRows, ...englishRows]) {
      for (const key of expandKeys(row.key)) addKey(keys, key);
    }

    for (const row of expansionRows) {
      const key = expandKeys(row.key)[0];
      const zh = row['zh（逐字）'] ?? row['zh（逐字／模板）'];
      if (!key || zh === undefined) throw new Error(`${section} expansion value missing: ${row.key}`);
      addValue(values, key, 'zh', zh);
    }
    for (const row of englishRows) {
      const key = expandKeys(row.key)[0];
      const en = row['EN（你的稿）'];
      const zh = row['zh（照抄·對照用）'];
      if (!key || en === undefined || zh === undefined) throw new Error(`${section} Tier B value missing: ${row.key}`);
      addValue(values, key, 'en', en);
      addValue(values, key, 'zh', zh);
    }
  }
}

// B5 家族（2026-07-16 T0 逐字化）：zh＝expansion §B5（原表「zh（逐字／模板）」欄＋
// M2 追加表 zh/en 欄）；EN＝tierb 附錄 B 終稿表（20 key·值以反引號包殼·殼內逐字，
// 保前導空白如 imp.grid.fillSuffix）。tierb §B5 原表為 B1 正規化前底稿——僅貢獻 key 集，
// 值不消費（表面形式非逐字；消費會與附錄 B 衝突直接紅）。
function appendixBSection(tierBEnglish) {
  const heading = /^##\s+附錄 B——.*$/m.exec(tierBEnglish);
  if (!heading) throw new Error('tierb appendix B missing');
  return tierBEnglish.slice(heading.index + heading[0].length);
}

function unshell(value, context) {
  const match = /^`([\s\S]*)`$/.exec(value);
  if (!match) throw new Error(`appendix B value not backtick-shelled: ${context}`);
  return match[1];
}

function addTierB5(keys, values, expansion, tierBEnglish) {
  const expansionRows = rowsForSection(expansion, 'B5');
  const englishRows = rowsForSection(tierBEnglish, 'B5');
  for (const row of [...expansionRows, ...englishRows]) {
    for (const key of expandKeys(row.key)) addKey(keys, key);
  }

  for (const row of expansionRows) {
    const key = expandKeys(row.key)[0];
    const zh = row['zh（逐字／模板）'] ?? row.zh;
    if (!key || zh === undefined) throw new Error(`B5 expansion zh missing: ${row.key}`);
    addValue(values, key, 'zh', zh);
    if (row.en !== undefined) addValue(values, key, 'en', row.en);
  }

  for (const row of markdownRows(appendixBSection(tierBEnglish))) {
    const enCell = row['EN（終稿·dict 逐字）'];
    if (!row.key || enCell === undefined) continue;
    const key = expandKeys(row.key)[0];
    if (!key) throw new Error(`B5 appendix key unparsable: ${row.key}`);
    addKey(keys, key);
    addValue(values, key, 'en', unshell(enCell, row.key));
  }
}

function inventoryContract(copyInventory, expansion, tierBEnglish) {
  const keys = new Set();
  const values = new Map();

  addCopyInventory(keys, values, copyInventory);
  addExpansionGaps(keys, values, expansion);
  addTierB(keys, values, expansion, tierBEnglish);
  addTierB5(keys, values, expansion, tierBEnglish);

  const incomplete = [...keys].filter((key) => values.get(key)?.en === undefined || values.get(key)?.zh === undefined);
  if (incomplete.length) throw new Error(`value-verified key missing EN/zh source: ${incomplete.sort().join(', ')}`);

  return { keys, values };
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

export async function run({ root }) {
  try {
    const dictSource = readFileSync(path.join(root, 'src/i18n/dict.ts'), 'utf8');
    const copyInventory = readFileSync(path.join(root, 'checks/canonical/copy-inventory.md'), 'utf8');
    const expansion = readFileSync(path.join(root, 'checks/canonical/inventory-expansion.md'), 'utf8');
    const tierBEnglish = readFileSync(path.join(root, 'checks/canonical/tierb-en-draft.md'), 'utf8');
    const actual = dictEntries(dictSource);
    const expected = inventoryContract(copyInventory, expansion, tierBEnglish);
    const errs = [];

    const missingFromDict = difference(expected.keys, actual);
    const missingFromInventory = difference(actual.keys(), expected.keys);
    if (missingFromDict.length) errs.push(`inventory 有、dict 缺少：${missingFromDict.join(', ')}`);
    if (missingFromInventory.length) errs.push(`dict 有、inventory 缺少：${missingFromInventory.join(', ')}`);

    for (const key of expected.keys) {
      if (!actual.has(key)) continue;
      for (const locale of ['en', 'zh']) {
        const expectedValue = expected.values.get(key)[locale];
        const actualValue = actual.get(key)[locale];
        if (actualValue !== expectedValue) {
          errs.push(`${locale} value 漂移：${key}（dict=${JSON.stringify(actualValue)}，inventory=${JSON.stringify(expectedValue)}）`);
        }
      }
    }

    console.log(`  [a15] value-verified ${expected.keys.size} keys／key-only 0 keys（B5 逐字化 2026-07-16 T0）`);
    return errs;
  } catch (error) {
    return [`A15 parser failure: ${error instanceof Error ? error.message : String(error)}`];
  }
}
