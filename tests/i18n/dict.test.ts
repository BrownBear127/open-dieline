import { describe, expect, it } from 'vitest';
import { dict, STRUCTURAL_LOCK_KEYS } from '@/i18n/dict';
import { t } from '@/i18n/t';

const EXPECTED_STRUCTURAL_LOCK_EN = {
  'chrome.wordmark': 'Open *Dieline*',
  'chrome.folio': 'The instrument — by Konvolut',
  'chrome.lang': 'EN · 中文',
  'chrome.mode': 'Mode',
  'console.styles.count': '{n} styles',
  'console.group.no': 'No. {nn}',
  'console.params.count': '{n} params ＋',
  'canvas.plateLabel': 'Plate Nº {nn} — {content}',
  'canvas.zoom.fit': 'Fit',
  'canvas.zoom.in': '＋',
  'canvas.zoom.out': '−',
  'canvas.checks': 'Checks · {p} pass · {f} fail',
  'canvas.calibrate.unit': 'mm',
  'plate.status.plate': 'Plate',
  'plate.status.blank': 'Blank',
  'plate.status.scale': 'Scale · 1 : 1 mm',
  'imp.sheet.preset.31x43': '31"×43"',
  'imp.sheet.preset.25x35': '25"×35"',
  'imp.sheet.preset.27x39': '27"×39"',
  'imp.sheet.w': 'W (mm)',
  'imp.sheet.h': 'H (mm)',
  'param.reset.glyph': '↺',
  'overlay.unit.pt': 'pt',
  'overlay.unit.mm': 'mm',
  'overlay.unit.px': 'px',
  'imp.placeholder.dash': '—',
} as const;

describe('i18n dictionary', () => {
  it('returns the default English copy', () => {
    expect(t('mode.design')).toBe('Design');
  });

  it('interpolates named parameters', () => {
    expect(t('imp.err.field.belowMin', { MIN_GAP_MM: 2 })).toContain('2mm');
  });

  it('fails loudly when a named parameter is missing', () => {
    expect(() => t('imp.err.field.belowMin')).toThrow(/MIN_GAP_MM/);
  });

  it('has non-empty English and Chinese copy for every key', () => {
    for (const [key, text] of Object.entries(dict)) {
      expect(text.en, `${key}.en`).not.toBe('');
      expect(text.zh, `${key}.zh`).not.toBe('');
    }
  });

  it('uses only flat named placeholders without nested-note remnants', () => {
    for (const [key, text] of Object.entries(dict)) {
      for (const [lang, template] of Object.entries(text)) {
        const withoutNamedPlaceholders = template.replace(/\{\w+\}/g, '');
        expect(withoutNamedPlaceholders, `${key}.${lang} has an invalid placeholder`).not.toMatch(/[{}]/);
        expect(template, `${key}.${lang} has a backtick remnant`).not.toContain('`');
      }
    }
  });

  it('interpolates the normalized imposition sub-size template', () => {
    expect(t('imp.sheet.subSize', {
      sheetW: '310.0',
      sheetH: '430.0',
      sheetUsableW: '300.0',
      sheetUsableH: '415.0',
    })).toBe('310.0 × 430.0 mm (usable 300.0 × 415.0 mm)');
  });

  it('keeps every structural-lock English value byte-for-byte', () => {
    expect(STRUCTURAL_LOCK_KEYS).toEqual(Object.keys(EXPECTED_STRUCTURAL_LOCK_EN));
    for (const key of STRUCTURAL_LOCK_KEYS) {
      expect(dict[key].en).toBe(EXPECTED_STRUCTURAL_LOCK_EN[key]);
    }
  });

  it('keeps the approved artwork switch copy byte-for-byte in both languages', () => {
    expect(dict['fold.art.label']).toEqual({ en: 'ART', zh: '圖稿' });
    expect(dict['fold.art.none']).toEqual({ en: 'NONE', zh: '無' });
    expect(dict['fold.art.sample']).toEqual({ en: 'SAMPLE', zh: '範例' });
  });
});
