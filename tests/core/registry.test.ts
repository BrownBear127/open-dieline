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
    label: { zh: p.key, en: p.key },
    group: { id: 'test', zh: '測試群組', en: 'Test group' },
    description: {
      zh: '測試參數（fakeBox 佔位，內容與斷言無關）',
      en: 'Synthetic parameter for fakeBox tests.',
    },
    ...p,
  };
}

function fakeBox(paramDefs: PartialParamDef[], id?: string): BoxModule {
  return {
    meta: {
      id: id ?? `fake-box-${fakeBoxCounter++}`,
      name: { zh: '測試盒型', en: 'Test box' },
      intro: { zh: '測試用盒型（fakeBox 佔位）', en: 'Synthetic box for fakeBox tests.' },
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

  it('derivedDefault 內對 params 呼叫 JSON.stringify 不應誤判為前向引用', () => {
    // JSON.stringify 內部會探測 params 上是否有 toJSON；toJSON 從來不是宣告過的參數 key，
    // 不該被 guard 誤判成「宣告過但尚未解析」而擲錯。
    const mod = fakeBox([
      { key: 'D', unit: 'mm', default: 100 },
      {
        key: 'lid',
        unit: 'mm',
        default: 0,
        derivedDefault: (p) => {
          JSON.stringify(p);
          return (p.D as number) * 0.4;
        },
      },
    ]);
    expect(() => resolveParams(mod)).not.toThrow();
    expect(resolveParams(mod)).toMatchObject({ D: 100, lid: 40 });
  });

  it('override 上游 key 後，下游 derivedDefault 讀到覆寫值（cascade：T8 即時重算依賴此行為）', () => {
    const mod = fakeBox([
      { key: 'D', unit: 'mm', default: 100 },
      { key: 'lid', unit: 'mm', default: 0, derivedDefault: (p) => (p.D as number) * 0.4 },
    ]);
    expect(resolveParams(mod, { D: 200 })).toMatchObject({ D: 200, lid: 80 });
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

describe('registerBox：插件參數定義驗證（Slice 2 地基防撞）', () => {
  // BoxParamDef 型別（discriminated union 重構留給 Slice 2，這裡不動公開型別）允許
  // unit 與 default/options 的無效組合通過型別檢查（例如 unit:'enum' 沒宣告 options、
  // bool 配字串 default）——錯的插件過去要等 UI 消費時才會壞（ParamPanel 讀 undefined
  // 的 options、或畫面顯示格式錯亂），這裡在 registerBox 當下就擋下、擲錯訊息含
  // 盒型 id 與參數 key 方便定位。

  it('unit=enum 缺 options 時擲錯，訊息含盒型 id 與參數 key', () => {
    const mod = fakeBox([{ key: 'color', unit: 'enum', default: 'red' }], 'bad-enum-no-options');
    expect(() => registerBox(mod)).toThrow(/bad-enum-no-options/);
    expect(() => registerBox(mod)).toThrow(/color/);
  });

  it('unit=enum options 為空陣列時擲錯', () => {
    const mod = fakeBox([{ key: 'color', unit: 'enum', default: 'red', options: [] }], 'bad-enum-empty-options');
    expect(() => registerBox(mod)).toThrow(/bad-enum-empty-options/);
  });

  it('unit=enum default 不在 options 值域時擲錯', () => {
    const mod = fakeBox(
      [{ key: 'color', unit: 'enum', default: 'blue', options: [{ value: 'red', label: { zh: '紅', en: 'Red' } }] }],
      'bad-enum-default-mismatch',
    );
    expect(() => registerBox(mod)).toThrow(/blue/);
  });

  it('unit=bool default 非 boolean 時擲錯', () => {
    const mod = fakeBox([{ key: 'lock', unit: 'bool', default: 'yes' }], 'bad-bool-default');
    expect(() => registerBox(mod)).toThrow(/lock/);
  });

  it('unit=mm default 非 number 時擲錯', () => {
    const mod = fakeBox([{ key: 'W', unit: 'mm', default: '50' }], 'bad-mm-default-type');
    expect(() => registerBox(mod)).toThrow(/W/);
  });

  it('unit=mm default 小於 min 時擲錯', () => {
    const mod = fakeBox([{ key: 'W', unit: 'mm', default: 5, min: 10 }], 'bad-mm-below-min');
    expect(() => registerBox(mod)).toThrow(/W/);
  });

  it('unit=deg default 大於 max 時擲錯', () => {
    const mod = fakeBox([{ key: 'angle', unit: 'deg', default: 400, max: 360 }], 'bad-deg-above-max');
    expect(() => registerBox(mod)).toThrow(/angle/);
  });

  it('derivedDefault 出現在 bool 參數上時擲錯（只允許 mm/deg 這類 number 參數）', () => {
    const mod = fakeBox([{ key: 'lock', unit: 'bool', default: true, derivedDefault: () => 1 }], 'bad-derived-on-bool');
    expect(() => registerBox(mod)).toThrow(/lock/);
  });

  it('derivedDefault 出現在 enum 參數上時擲錯', () => {
    const mod = fakeBox(
      [
        {
          key: 'color',
          unit: 'enum',
          default: 'red',
          options: [{ value: 'red', label: { zh: '紅', en: 'Red' } }],
          derivedDefault: () => 1,
        },
      ],
      'bad-derived-on-enum',
    );
    expect(() => registerBox(mod)).toThrow(/color/);
  });

  it('合法組合（各 unit 搭配 min/max/options/derivedDefault）通過 validate，不擲錯', () => {
    const mod = fakeBox(
      [
        { key: 'W', unit: 'mm', default: 50, min: 0, max: 100 },
        { key: 'angle', unit: 'deg', default: 45, min: 0, max: 360 },
        { key: 'lock', unit: 'bool', default: true },
        {
          key: 'color',
          unit: 'enum',
          default: 'red',
          options: [
            { value: 'red', label: { zh: '紅', en: 'Red' } },
            { value: 'blue', label: { zh: '藍', en: 'Blue' } },
          ],
        },
        { key: 'derived', unit: 'mm', default: 0, derivedDefault: (p) => (p.W as number) * 2 },
      ],
      'good-box',
    );
    expect(() => registerBox(mod)).not.toThrow();
  });
});
