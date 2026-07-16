// A15：i18n dict key 集與 vendored copy inventory 雙向一致；structural-lock EN 逐字一致。
import { readFileSync } from 'node:fs';
import path from 'node:path';

function cells(line) {
  return line.slice(1, -1).split('|').map((cell) => cell.trim());
}

function markdownRows(markdown) {
  const rows = [];
  let headers = null;

  for (const line of markdown.split('\n')) {
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

    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
  }

  return rows;
}

function between(markdown, start, end) {
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`inventory section missing: ${start} … ${end}`);
  return markdown.slice(from, to);
}

function cleanMarkdown(value) {
  return value.replaceAll('`', '').trim();
}

function expandInventoryEntry(keyCell, valueCell) {
  const key = cleanMarkdown(keyCell);
  const values = cleanMarkdown(valueCell).split('／').map((value) => value.trim());

  if (key === 'imp.sheet.preset.{i}') {
    return values.map((value) => {
      const match = value.match(/^(\d+)"×(\d+)"$/);
      if (!match) throw new Error(`cannot expand inventory preset: ${value}`);
      return [`imp.sheet.preset.${match[1]}x${match[2]}`, value];
    });
  }
  if (key.endsWith('.*')) return [];

  const keyParts = key.split('/').map((part) => part.trim());
  if (keyParts.length === 1) return [[key, values[0]]];

  const first = keyParts[0];
  const prefix = first.slice(0, first.lastIndexOf('.') + 1);
  const expandedKeys = keyParts.map((part, index) => {
    if (index === 0) return part;
    return part.startsWith('.') ? `${prefix}${part.slice(1)}` : `${prefix}${part}`;
  });
  if (values.length !== expandedKeys.length) {
    throw new Error(`inventory key/value expansion mismatch: ${keyCell} ↔ ${valueCell}`);
  }
  return expandedKeys.map((expandedKey, index) => [expandedKey, values[index]]);
}

function addRows(target, rows, keyHeader, valueHeaders) {
  for (const row of rows) {
    const keyCell = row[keyHeader];
    if (!keyCell) continue;
    const value = valueHeaders.map((header) => row[header]).find((candidate) => candidate !== undefined) ?? '';
    for (const [key, en] of expandInventoryEntry(keyCell, value)) {
      const previous = target.get(key);
      if (previous && en && previous !== en && !previous.startsWith('— Tier B')) {
        throw new Error(`conflicting inventory values for ${key}: ${previous} ↔ ${en}`);
      }
      if (!previous || previous.startsWith('— Tier B')) target.set(key, en);
    }
  }
}

function inventoryEntries(copyInventory, expansion) {
  const entries = new Map();
  addRows(entries, markdownRows(copyInventory), 'key', ['EN（終稿）', 'EN']);

  const dictTierB = between(expansion, '### B3 ', '### B7 ');
  addRows(entries, markdownRows(dictTierB), 'key', ['EN', 'zh（逐字）', 'zh（逐字／模板）']);

  const gaps = between(expansion, '## 節 2：', '## 節 3：');
  const gapRows = markdownRows(gaps).filter((row) => row['類型']?.startsWith('缺 key'));
  addRows(entries, gapRows, 'key／項目', ['值']);
  return entries;
}

function dictEntries(source) {
  const entries = new Map();
  const entryPattern = /^\s*'([^']+)':\s*\{\s*en:\s*'((?:\\.|[^'\\])*)'/gm;
  for (const match of source.matchAll(entryPattern)) {
    const en = match[2].replace(/\\(['\\])/g, '$1').replace(/\\n/g, '\n');
    entries.set(match[1], en);
  }
  return entries;
}

function structuralLockKeys(source) {
  const match = source.match(/export const STRUCTURAL_LOCK_KEYS = \[([\s\S]*?)\] as const/);
  if (!match) throw new Error('STRUCTURAL_LOCK_KEYS declaration missing');
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

export async function run({ root }) {
  try {
    const dictSource = readFileSync(path.join(root, 'src/i18n/dict.ts'), 'utf8');
    const copyInventory = readFileSync(path.join(root, 'checks/canonical/copy-inventory.md'), 'utf8');
    const expansion = readFileSync(path.join(root, 'checks/canonical/inventory-expansion.md'), 'utf8');
    const actual = dictEntries(dictSource);
    const expected = inventoryEntries(copyInventory, expansion);
    const errs = [];

    const missingFromDict = difference(expected.keys(), actual);
    const missingFromInventory = difference(actual.keys(), expected);
    if (missingFromDict.length) errs.push(`inventory 有、dict 缺少：${missingFromDict.join(', ')}`);
    if (missingFromInventory.length) errs.push(`dict 有、inventory 缺少：${missingFromInventory.join(', ')}`);

    for (const key of structuralLockKeys(dictSource)) {
      if (!expected.has(key)) {
        errs.push(`STRUCTURAL_LOCK_KEYS 未見於 inventory：${key}`);
        continue;
      }
      if (actual.get(key) !== expected.get(key)) {
        errs.push(`structural-lock EN 漂移：${key}（dict=${JSON.stringify(actual.get(key))}，inventory=${JSON.stringify(expected.get(key))}）`);
      }
    }
    return errs;
  } catch (error) {
    return [`A15 parser failure: ${error instanceof Error ? error.message : String(error)}`];
  }
}
