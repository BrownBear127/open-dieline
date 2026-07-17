import { describe, expect, it } from 'vitest';
import {
  assertNamedTests,
  REQUIRED_ARTWORK_E2E,
  REQUIRED_ARTWORK_UNIT,
} from '../../checks/probes/test-manifest.mjs';

describe('probe test manifest fail-loud contract (F4)', () => {
  it('requires C6 SVG default and manufacturing download parity cases', () => {
    expect(REQUIRED_ARTWORK_E2E).toContain(
      'A2 en svg-default download is byte-identical to the RTE baseline',
    );
    expect(REQUIRED_ARTWORK_E2E).toContain(
      'A2 en svg-manufacturing download is byte-identical to the RTE baseline',
    );
  });

  it('requires every named C5 DOM resource rejection case', () => {
    expect(REQUIRED_ARTWORK_UNIT).toEqual([
      'rejects external CSS @import during the mandatory DOM resource scan',
      'rejects foreignObject with a nested image src during the mandatory DOM resource scan',
      'rejects style attribute with an external url during the mandatory DOM resource scan',
      'rejects mixed-case xlink namespace href during the mandatory DOM resource scan',
      'rejects data URI href during the mandatory DOM resource scan',
      // V5 re-review：CSS 十六進位轉義漏網修正的兩案（escape 拒收策略）。
      'rejects CSS-escaped url in a style attribute during the mandatory DOM resource scan',
      'rejects CSS-escaped @import in a style element during the mandatory DOM resource scan',
      // V5 三審：image-set(<string>) 不經 url( 的資源引用（function-notation 全擋策略）。
      'rejects image-set string reference in a style element during the mandatory DOM resource scan',
      'rejects image-set string reference in a style attribute during the mandatory DOM resource scan',
      // V5 四審：mask presentation attribute 的 <image> 文法縫（嚴格掃描擴 mask）。
      'rejects image-set string reference in a mask presentation attribute during the mandatory DOM resource scan',
    ]);
  });

  it('throws with every missing case name instead of silently passing', () => {
    expect(() => assertNamedTests(
      'suite > present case',
      ['present case', 'missing A', 'missing B'],
      'unit',
    )).toThrow('unit manifest 缺案：missing A, missing B');
  });
});
