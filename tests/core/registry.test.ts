import { describe, it, expect, afterEach } from 'vitest';
import type { BoxModule, BoxParamDef } from '@/core/types';
import { registerBox, getBox, listBoxes, resolveParams, _clearRegistry } from '@/core/registry';

// ── 測試專用工具：組出最小可用的 BoxModule/BoxParamDef ──
// fakeParam 補齊 BoxParamDef 必填但本檔測試不關心的欄位（label/group/description），
// 讓每個測試案例只需指定 key/unit/default（與可選的 derivedDefault）。
let fakeBoxCounter = 0;

type PartialParamDef = Partial<BoxParamDef> & Pick<BoxParamDef, 'key' | 'unit' | 'default'>;

function fakeParam(p: PartialParamDef): BoxParamDef {
  return {
    label: { zh: p.key },
    group: { zh: '測試群組' },
    description: { zh: '測試參數（fakeBox 佔位，內容與斷言無關）' },
    ...p,
  };
}

function fakeBox(paramDefs: PartialParamDef[], id?: string): BoxModule {
  return {
    meta: {
      id: id ?? `fake-box-${fakeBoxCounter++}`,
      name: { zh: '測試盒型' },
      intro: { zh: '測試用盒型（fakeBox 佔位）' },
      topology: 'linear',
    },
    params: paramDefs.map(fakeParam),
    invariants: [],
    generate: () => ({ paths: [], texts: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } }),
  };
}

afterEach(() => {
  // registry 是模組層級全域 Map，測試間必須隔離，否則後面測試的 registerBox 會誤判「重複」。
  _clearRegistry();
});

describe('resolveParams', () => {
  it('按宣告順序解析 derivedDefault', () => {
    const mod = fakeBox([
      { key: 'D', unit: 'mm', default: 100 },
      { key: 'lid', unit: 'mm', default: 0, derivedDefault: (p) => (p.D as number) * 0.4 },
    ]);
    expect(resolveParams(mod)).toMatchObject({ D: 100, lid: 40 });
  });

  it('derivedDefault 讀到尚未解析（後宣告）的 key 時擲錯，訊息含當事雙方 key（前向引用防範）', () => {
    // lid 在 D 之前宣告，但其 derivedDefault 卻讀取 D（此時 D 尚未被解析）→ 必須擲錯，
    // 而不是讀到 undefined 靜默算出 NaN。
    const mod = fakeBox([
      { key: 'lid', unit: 'mm', default: 0, derivedDefault: (p) => (p.D as number) * 0.4 },
      { key: 'D', unit: 'mm', default: 100 },
    ]);
    // lookahead：確保訊息同時指名「lid」（誰在讀）與「D」（讀了什麼未解析的 key），
    // 而非隨便一條含糊訊息就能通過。
    expect(() => resolveParams(mod)).toThrow(/(?=.*lid)(?=.*D)/s);
  });

  it('overrides 覆蓋 derived 值', () => {
    const mod = fakeBox([
      { key: 'D', unit: 'mm', default: 100 },
      { key: 'lid', unit: 'mm', default: 0, derivedDefault: (p) => (p.D as number) * 0.4 },
    ]);
    expect(resolveParams(mod, { lid: 55 })).toMatchObject({ D: 100, lid: 55 });
  });

  it('overrides 含未宣告的 key 時擲錯，訊息含該 key 名稱', () => {
    const mod = fakeBox([{ key: 'D', unit: 'mm', default: 100 }]);
    expect(() =>
      resolveParams(mod, { notDeclared: 999 } as Partial<Record<string, number | boolean | string>>),
    ).toThrow(/notDeclared/);
  });

  it('沒有 overrides、沒有 derivedDefault 時直接使用宣告的 default（涵蓋 number/bool/enum 三態）', () => {
    const mod = fakeBox([
      { key: 'W', unit: 'mm', default: 50 },
      { key: 'lock', unit: 'bool', default: true },
      { key: 'color', unit: 'enum', default: 'red' },
    ]);
    expect(resolveParams(mod)).toEqual({ W: 50, lock: true, color: 'red' });
  });
});

describe('registerBox / getBox / listBoxes', () => {
  it('registerBox 重複 id 擲錯，訊息含該 id', () => {
    const mod = fakeBox([], 'dup-box');
    registerBox(mod);
    expect(() => registerBox(mod)).toThrow(/dup-box/);
  });

  it('getBox 回傳先前註冊的盒型', () => {
    const mod = fakeBox([], 'gettable-box');
    registerBox(mod);
    expect(getBox('gettable-box')).toBe(mod);
  });

  it('getBox 找不到不存在的 id 時擲錯，訊息含該 id', () => {
    expect(() => getBox('no-such-box')).toThrow(/no-such-box/);
  });

  it('listBoxes 回傳所有已註冊的盒型', () => {
    registerBox(fakeBox([], 'box-a'));
    registerBox(fakeBox([], 'box-b'));
    const ids = listBoxes()
      .map((m) => m.meta.id)
      .sort();
    expect(ids).toEqual(['box-a', 'box-b']);
  });
});
