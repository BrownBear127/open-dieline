import { describe, it, expect } from 'vitest';
import type { DielinePath, DielineText, GenerateResult } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { toSvgDocument } from '@/export/svg';
import { DXF_LAYER_BY_LINETYPE } from '@/export/dxf';

// ── 測試專用建構器：只覆寫關心的欄位，其餘用最小合法預設值 ──
function makeResult(overrides?: { paths?: DielinePath[]; texts?: DielineText[]; bounds?: GenerateResult['bounds'] }): GenerateResult {
  return {
    paths: overrides?.paths ?? [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    texts: overrides?.texts ?? [],
    bounds: overrides?.bounds ?? { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  };
}

describe('toSvgDocument', () => {
  it('輸出含 width/height（mm 明示，取自 bounds 尺寸）與 viewBox（從 0 起算的簡單案例）', () => {
    const result = makeResult({ bounds: { minX: 0, maxX: 100, minY: 0, maxY: 50 } });
    const svg = toSvgDocument(result);
    expect(svg).toContain('width="100.00mm"');
    expect(svg).toContain('height="50.00mm"');
    expect(svg).toContain('viewBox="0.00 0.00 100.00 50.00"');
  });

  it('bounds 非零起點時 viewBox 正確反映 minX/minY（不可假設一律從 0 開始）', () => {
    const result = makeResult({ bounds: { minX: -20, maxX: 80, minY: -10, maxY: 40 } });
    const svg = toSvgDocument(result);
    expect(svg).toContain('width="100.00mm"');
    expect(svg).toContain('height="50.00mm"');
    expect(svg).toContain('viewBox="-20.00 -10.00 100.00 50.00"');
  });

  it('SVG 文件頭：xml 宣告與 xmlns（合法可獨立開啟的完整文件）', () => {
    const svg = toSvgDocument(makeResult());
    expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('cut path 的 stroke 值等於 LINE_STYLES.cut.stroke（從模組讀，不寫死字面色碼）', () => {
    const result = makeResult({
      paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain(`stroke="${LINE_STYLES.cut.stroke}"`);
    expect(svg).toContain(`stroke-width="${LINE_STYLES.cut.strokeWidth}"`);
  });

  it('每個 path 都有 fill="none"（沒有會被 SVG 預設黑填色毀掉刀模線稿）', () => {
    const svg = toSvgDocument(makeResult());
    expect(svg).toContain('fill="none"');
  });

  it('無 dasharray 的線型（cut）輸出完全不含 stroke-dasharray 屬性', () => {
    const result = makeResult({
      paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    });
    const svg = toSvgDocument(result);
    expect(svg).not.toContain('stroke-dasharray');
  });

  it('有 dasharray 的線型（crease）輸出 stroke-dasharray 屬性值等於 LINE_STYLES.crease.dasharray', () => {
    const result = makeResult({
      paths: [{ id: 'p-0', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain(`stroke-dasharray="${LINE_STYLES.crease.dasharray}"`);
  });

  it('每個 DielinePath 產生一個 <path d=…>，segments 經 segmentsToSvgD 投影（與畫布同一份投影邏輯）', () => {
    const result = makeResult({
      paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 5 }] }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain('d="M0.00,0.00 L10.00,5.00"');
  });

  it('texts 轉 <text>：x/y toFixed(2)、fontSize 未給時預設 3、anchor 對應 text-anchor、內容原樣輸出', () => {
    const result = makeResult({
      texts: [{ id: 't-0', x: 12.345, y: 6.789, text: '55mm', anchor: 'middle' }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain('<text');
    expect(svg).toContain('x="12.35"');
    expect(svg).toContain('y="6.79"');
    expect(svg).toContain('font-size="3"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('>55mm</text>');
  });

  it('text 輸出含 fill，值從 LINE_STYLES.dimension.stroke 讀（與畫布 Canvas.tsx 的 DIMENSION_TEXT_FILL 同源，不寫死色碼；沒有 fill 時瀏覽器預設黑，跟畫布藍不一致）', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 0, y: 0, text: 'D' }] });
    const svg = toSvgDocument(result);
    expect(svg).toContain(`fill="${LINE_STYLES.dimension.stroke}"`);
  });

  it('text 有 fontSize 時使用該值，不套用預設值 3', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 0, y: 0, text: 'D', fontSize: 3.5 }] });
    const svg = toSvgDocument(result);
    expect(svg).toContain('font-size="3.5"');
  });

  it('text 的 rotation 非 0 時輸出 transform="rotate(角度 x y)"', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 10, y: 20, text: 'D', rotation: -90 }] });
    const svg = toSvgDocument(result);
    expect(svg).toContain('transform="rotate(-90.00 10.00 20.00)"');
  });

  it('text 的 rotation 為 0 時不輸出 transform 屬性', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 10, y: 20, text: 'D', rotation: 0 }] });
    const svg = toSvgDocument(result);
    expect(svg).not.toContain('transform=');
  });

  it('text 未給 rotation 時不輸出 transform 屬性', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 10, y: 20, text: 'D' }] });
    const svg = toSvgDocument(result);
    expect(svg).not.toContain('transform=');
  });

  it('文字內容做 XML escape（& < > 至少）——label 是使用者可影響的字串', () => {
    const result = makeResult({ texts: [{ id: 't-0', x: 0, y: 0, text: 'A & B <tag>' }] });
    const svg = toSvgDocument(result);
    expect(svg).not.toContain('A & B <tag>'); // 原始未跳脫字串不該原樣出現
    expect(svg).toContain('A &amp; B &lt;tag&gt;');
  });

  it('恆全量輸出（includeDimensions 已於本輪退役）：dimension/annotation 線與 texts 全部保留', () => {
    const result = makeResult({
      paths: [
        { id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-1', type: 'dimension', segments: [{ kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5 }] },
        { id: 'p-2', type: 'annotation', segments: [{ kind: 'line', x1: 0, y1: 8, x2: 10, y2: 8 }] },
      ],
      texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(svg).toContain(`stroke="${LINE_STYLES.annotation.stroke}"`);
    expect(svg).toContain('>10mm</text>');
  });

  it('樣式同源 mutation 測試：改 LINE_STYLES.cut.stroke 後輸出的 stroke 值跟著變', () => {
    // LINE_STYLES.cut.stroke 是純資料屬性（非函式/非 accessor），vi.spyOn 的攔截機制設計給
    // 函式呼叫或 getter/setter 用，對純資料屬性不適用。改用直接 mutate 模組匯出物件的屬性＋
    // try/finally 復原：這正是要鎖的行為本身——匯出讀的是「LINE_STYLES 這個模組物件的當下值」
    // 而不是在別處複製了一份色碼常數；直接改這個物件、看輸出是否跟著變，就是最直接的證據。
    const original = LINE_STYLES.cut.stroke;
    try {
      LINE_STYLES.cut.stroke = '#123456';
      const svg = toSvgDocument(makeResult());
      expect(svg).toContain('stroke="#123456"');
    } finally {
      LINE_STYLES.cut.stroke = original;
    }
  });

  it('空 GenerateResult（零 paths、零 texts）不拋錯，輸出合法 SVG 骨架', () => {
    const result = makeResult({ paths: [], texts: [], bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 } });
    const svg = toSvgDocument(result);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('<path');
    expect(svg).not.toContain('<text');
  });

  it('冒煙：真實 RTE 輸出（42 條路徑）餵入不拋錯，<path> 數量與 paths.length 一致', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const svg = toSvgDocument(result);
    const pathCount = (svg.match(/<path /g) ?? []).length;
    expect(pathCount).toBe(result.paths.length);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  // ── g 圖層分組（Slice 3 gate round 1 T4）──
  // paths 依 layerKeyForLineType 分 4 桶，每桶非空時包一層 <g id=英文 data-name=中文>；
  // 空桶不輸出 g（AI 圖層面板不出現空群組）；texts 全部歸 DIMENSIONS 桶（v1 texts 全來自標註）。

  it('paths 依線型分 4 桶，各自包一層 <g id="…" data-name="…">（Illustrator 圖層分組）', () => {
    const result = makeResult({
      paths: [
        { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-crease', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 1, x2: 10, y2: 1 }] },
        { id: 'p-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 2, x2: 10, y2: 2 }] },
      ],
      texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain('<g id="CUT" data-name="切割線">');
    expect(svg).toContain('<g id="CREASE" data-name="摺線">');
    expect(svg).toContain('<g id="HALFCUT" data-name="半刀">');
    expect(svg).toContain('<g id="DIMENSIONS" data-name="尺寸標註">');
  });

  it('g id（cut/crease/halfcut）與 DXF_LAYER_BY_LINETYPE 的圖層名逐字一致（跨格式同名，Illustrator/CAD 圖層對得上）', () => {
    const result = makeResult({
      paths: [
        { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-crease', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 1, x2: 10, y2: 1 }] },
        { id: 'p-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 2, x2: 10, y2: 2 }] },
      ],
    });
    const svg = toSvgDocument(result);
    expect(svg).toContain(`<g id="${DXF_LAYER_BY_LINETYPE.cut}"`);
    expect(svg).toContain(`<g id="${DXF_LAYER_BY_LINETYPE.crease}"`);
    expect(svg).toContain(`<g id="${DXF_LAYER_BY_LINETYPE.halfcut}"`);
  });

  it('texts 全部在 DIMENSIONS 這個 g 內，不出現在 cut 的 g 裡（v1 texts 全來自標註）', () => {
    const result = makeResult({
      paths: [{ id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    });
    const svg = toSvgDocument(result);
    const dimensionsGroupStart = svg.indexOf('<g id="DIMENSIONS"');
    const dimensionsGroupEnd = svg.indexOf('</g>', dimensionsGroupStart);
    const textIndex = svg.indexOf('<text');
    expect(dimensionsGroupStart).toBeGreaterThan(-1);
    expect(textIndex).toBeGreaterThan(dimensionsGroupStart);
    expect(textIndex).toBeLessThan(dimensionsGroupEnd);

    const cutGroupStart = svg.indexOf('<g id="CUT"');
    const cutGroupEnd = svg.indexOf('</g>', cutGroupStart);
    expect(svg.slice(cutGroupStart, cutGroupEnd)).not.toContain('<text');
  });

  it('空桶不輸出 g：RTE 真實輸出沒有 halfcut 線型，不含 <g id="HALFCUT">（AI 圖層面板不出現空群組）', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const svg = toSvgDocument(result);
    expect(svg).not.toContain('id="HALFCUT"');
  });

  it('telescope 真實輸出含 halfcut 線型（舌摺線中段軋半斷），輸出 <g id="HALFCUT" data-name="半刀">', () => {
    const result = telescope.generate(resolveParams(telescope));
    const svg = toSvgDocument(result);
    expect(svg).toContain('<g id="HALFCUT" data-name="半刀">');
  });

  it('g id 恰不重複', () => {
    const result = telescope.generate(resolveParams(telescope));
    const svg = toSvgDocument(result);
    const ids = [...svg.matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
