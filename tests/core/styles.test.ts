import { describe, it, expect } from 'vitest';
import type { LineType } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';

describe('LINE_STYLES', () => {
  it('六種線型都有樣式定義（stroke 為合法 hex 色碼）', () => {
    const types: LineType[] = ['cut', 'crease', 'halfcut', 'bleed', 'annotation', 'dimension'];
    for (const t of types) {
      expect(LINE_STYLES[t].stroke).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  // 精確值逐一釘死——樣式表是刀模行業慣例的載體（黑=cut、綠=crease、黃=halfcut 對齊維護者生產檔），
  // 值錯了會直接害到廠商收檔，不能只驗證格式對就算過。

  it('cut：黑色實線、線寬 0.4（無 dasharray）', () => {
    expect(LINE_STYLES.cut).toEqual({ stroke: '#000000', strokeWidth: 0.4 });
  });

  it('crease：綠色、線寬 0.4、虛線 "4 2"', () => {
    expect(LINE_STYLES.crease).toEqual({ stroke: '#00FF00', strokeWidth: 0.4, dasharray: '4 2' });
  });

  it('halfcut：黃色、線寬 0.4、虛線 "1 1"', () => {
    expect(LINE_STYLES.halfcut).toEqual({ stroke: '#FFFF00', strokeWidth: 0.4, dasharray: '1 1' });
  });

  it('bleed：洋紅色、線寬 0.3（無 dasharray；v1 型別保留但禁產，見 spec §3.3）', () => {
    expect(LINE_STYLES.bleed).toEqual({ stroke: '#FF00FF', strokeWidth: 0.3 });
  });

  it('annotation：灰色、線寬 0.25（無 dasharray）', () => {
    expect(LINE_STYLES.annotation).toEqual({ stroke: '#888888', strokeWidth: 0.25 });
  });

  it('dimension：藍色、線寬 0.25（無 dasharray）', () => {
    expect(LINE_STYLES.dimension).toEqual({ stroke: '#3B82F6', strokeWidth: 0.25 });
  });
});
