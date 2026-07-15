import { describe, it, expect } from 'vitest';
import { LINE_STYLES } from '@/core/styles';
import { DISPLAY_LINE_STYLES } from '@/core/displayStyles';
import type { LineType } from '@/core/types';

// Spec §5 維度凍結表（來源：Spec.md §5·2026-07-15 裁定 Q3+D8）
const EXPECTED_STROKE: Record<LineType, string> = {
  cut: 'var(--cut)',
  crease: 'var(--crease)',
  halfcut: 'var(--brass)',
  bleed: '#FF00FF',
  annotation: 'var(--ink-soft)',
  dimension: 'var(--ink-soft)',
};

describe('DISPLAY_LINE_STYLES（Spec §5 拆層契約）', () => {
  const types = Object.keys(LINE_STYLES) as LineType[];
  it('覆蓋全部 LineType', () => {
    expect(Object.keys(DISPLAY_LINE_STYLES).sort()).toEqual(types.sort());
  });
  for (const t of Object.keys(EXPECTED_STROKE) as LineType[]) {
    it(`${t}：stroke=${EXPECTED_STROKE[t]}，寬度/dash 逐欄位===匯出層（繼承非重宣告）`, () => {
      expect(DISPLAY_LINE_STYLES[t].stroke).toBe(EXPECTED_STROKE[t]);
      expect(DISPLAY_LINE_STYLES[t].strokeWidth).toBe(LINE_STYLES[t].strokeWidth);
      expect(DISPLAY_LINE_STYLES[t].dasharray).toBe(LINE_STYLES[t].dasharray);
    });
  }
  it('匯出層未被污染（LINE_STYLES 原值）', () => {
    expect(LINE_STYLES.cut.stroke).toBe('#000000');
    expect(LINE_STYLES.crease.stroke).toBe('#00FF00');
  });
});
