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

const EXPECTED_EDITOR_COPY = {
  'fold.art.edit': { en: 'EDIT', zh: '編輯' },
  'editor.done': { en: 'DONE', zh: '完成' },
  'editor.addImage': { en: 'IMAGE', zh: '加圖' },
  'editor.addText': { en: 'TEXT', zh: '加字' },
  'editor.duplicate': { en: 'COPY', zh: '複製' },
  'editor.delete': { en: 'DELETE', zh: '刪除' },
  'editor.layerUp': { en: 'RAISE', zh: '上移' },
  'editor.layerDown': { en: 'LOWER', zh: '下移' },
  'editor.download': { en: 'ARTWORK PNG', zh: '下載成品' },
  'editor.empty': { en: 'Add an image or text to begin.', zh: '加入圖片或文字開始編輯。' },
  'editor.stale': {
    en: 'Parameters changed. Reposition your artwork to realign.',
    zh: '參數已變更，請重新對位物件。',
  },
  'editor.limit.objects': { en: 'Object limit reached (32).', zh: '已達物件上限（32）。' },
  'editor.error.compose': {
    en: 'Rendering failed. Try again or remove the last object.',
    zh: '合成失敗，請重試或移除最後加入的物件。',
  },
  'editor.font.sans': { en: 'SANS', zh: '無襯線' },
  'editor.font.serif': { en: 'SERIF', zh: '襯線' },
  'editor.font.mono': { en: 'MONO', zh: '等寬' },
  'editor.align.left': { en: 'LEFT', zh: '左' },
  'editor.align.center': { en: 'CENTER', zh: '中' },
  'editor.align.right': { en: 'RIGHT', zh: '右' },
  'editor.color.ink': { en: 'INK', zh: '墨' },
  'editor.color.inkSoft': { en: 'SOFT', zh: '淡墨' },
  'editor.color.cut': { en: 'CUT', zh: '刀紅' },
  'editor.color.crease': { en: 'CREASE', zh: '摺藍' },
  'editor.color.brass': { en: 'BRASS', zh: '黃銅' },
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

  it('keeps the SVG safety rejection copy byte-for-byte in both languages', () => {
    expect((dict as Record<string, { en: string; zh: string }>)['fold.art.invalidSvg']).toEqual({
      en: 'This SVG contains an unsupported external reference or script.',
      zh: '此 SVG 含不支援的外部引用或指令碼。',
    });
  });

  it.each(['en', 'zh'] as const)('keeps every approved M4 F7 %s value byte-for-byte', (lang) => {
    for (const [key, copy] of Object.entries(EXPECTED_EDITOR_COPY)) {
      const actual = dict[key as keyof typeof dict] as { en: string; zh: string } | undefined;
      expect(actual?.[lang], `${key}.${lang}`).toBe(copy[lang]);
    }
  });
});
