import { describe, it, expect } from 'vitest';
import type { DielinePath, DielineText, GenerateResult } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { DIMENSION_LINE_TYPES, manufacturingBounds, toSvgDocument } from '@/export/svg';
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

  // ── 製造模式匯出（F7·Slice 5 Task 6）──
  // 預設關＝既有全量路徑，byte 級一致（迴歸保證，spec §F7／驗收 5）；製造模式開＝solid＋
  // 0.25 線寬＋round cap/join＋排除 dimensions/annotation paths 與全部 texts＋viewBox/width/
  // height 用過濾後的製造幾何 bounds 重算（不沿用含標註的 result.bounds）。

  describe('預設關＝既有全量路徑（byte 級迴歸——防選項管線重構夾帶變動）', () => {
    // 這兩個快照是本次改動前既有的真實輸出（generate() 走既有邏輯，toSvgDocument 省略第二
    // 參數）——F7 上線後若任何一版重構動到了「manufacturing=false」這條路徑的輸出（哪怕只是
    // 屬性順序、空白、或某個 opts 分支意外滲入預設路徑），這裡會逐 byte 炸開，不只是「有無
    // dasharray」這種抽樣斷言可以掩蓋過去的變動。
    it('RTE 真實輸出：省略第二參數，輸出逐 byte 鎖定（golden 快照）', () => {
      const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
      expect(toSvgDocument(result)).toMatchSnapshot();
    });

    it('telescope 真實輸出：省略第二參數，輸出逐 byte 鎖定（golden 快照）', () => {
      const result = telescope.generate(resolveParams(telescope));
      expect(toSvgDocument(result)).toMatchSnapshot();
    });

    it('明確傳 { manufacturing: false } 與省略第二參數完全等價（驗證 opts?.manufacturing ?? false 的預設語意，不是巧合地兩條路徑剛好同輸出）', () => {
      const result = telescope.generate(resolveParams(telescope));
      expect(toSvgDocument(result, { manufacturing: false })).toBe(toSvgDocument(result));
    });
  });

  describe('製造模式開（{ manufacturing: true }）', () => {
    it('solid：crease（原本有 dasharray）在製造模式下輸出不含 stroke-dasharray（mutation 檢查：若漏做 solid 覆寫，這裡會抓到殘留 dasharray）', () => {
      const result = makeResult({
        paths: [{ id: 'p-0', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).not.toContain('stroke-dasharray');
    });

    it('halfcut（原本也有 dasharray）同樣不含 stroke-dasharray', () => {
      const result = makeResult({
        paths: [{ id: 'p-0', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).not.toContain('stroke-dasharray');
    });

    it('stroke-width 固定 0.25：覆寫 cut/crease/halfcut 各自的 LINE_STYLES.strokeWidth（三者原值皆 0.4，見 core/styles.ts）', () => {
      const result = makeResult({
        paths: [
          { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
          { id: 'p-crease', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 1, x2: 10, y2: 1 }] },
          { id: 'p-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 2, x2: 10, y2: 2 }] },
        ],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      const widths = [...svg.matchAll(/stroke-width="([^"]+)"/g)].map((m) => m[1]);
      expect(widths).toEqual(['0.25', '0.25', '0.25']);
      expect(svg).not.toContain('stroke-width="0.4"');
    });

    it('round cap/join：每個 path 都輸出 stroke-linecap="round" stroke-linejoin="round"', () => {
      const result = makeResult({
        paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('stroke-linejoin="round"');
    });

    it('非製造模式（預設）不輸出 stroke-linecap/stroke-linejoin（確認這兩個屬性是製造模式獨有，不會滲進既有路徑——與上方 byte 級迴歸快照互證）', () => {
      const result = makeResult({
        paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      });
      const svg = toSvgDocument(result);
      expect(svg).not.toContain('stroke-linecap');
      expect(svg).not.toContain('stroke-linejoin');
    });

    it('顏色維持 black/lime/yellow：cut/crease/halfcut 的 stroke 仍讀 LINE_STYLES，不被製造模式覆寫（製造模式只覆寫線寬/dasharray/cap-join 三個視覺屬性）', () => {
      const result = makeResult({
        paths: [
          { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
          { id: 'p-crease', type: 'crease', segments: [{ kind: 'line', x1: 0, y1: 1, x2: 10, y2: 1 }] },
          { id: 'p-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 0, y1: 2, x2: 10, y2: 2 }] },
        ],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).toContain(`stroke="${LINE_STYLES.cut.stroke}"`);
      expect(svg).toContain(`stroke="${LINE_STYLES.crease.stroke}"`);
      expect(svg).toContain(`stroke="${LINE_STYLES.halfcut.stroke}"`);
      // 三個色碼本身就是 spec F7「black/lime/yellow」——鎖字面值，避免 LINE_STYLES 改了
      // 這三個值時，上面三個 toContain 因為「兩邊都變了」而繼續巧合通過。
      expect(LINE_STYLES.cut.stroke).toBe('#000000');
      expect(LINE_STYLES.crease.stroke).toBe('#00FF00');
      expect(LINE_STYLES.halfcut.stroke).toBe('#FFFF00');
    });

    it('排除 dimension／annotation paths 與全部 texts：輸出不含這兩種線型的 stroke、不含 <text>、不含空的 DIMENSIONS 群組', () => {
      const result = makeResult({
        paths: [
          { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
          { id: 'p-dim', type: 'dimension', segments: [{ kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5 }] },
          { id: 'p-ann', type: 'annotation', segments: [{ kind: 'line', x1: 0, y1: 8, x2: 10, y2: 8 }] },
        ],
        texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).not.toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
      expect(svg).not.toContain(`stroke="${LINE_STYLES.annotation.stroke}"`);
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('10mm');
      expect(svg).not.toContain('id="DIMENSIONS"');
      expect(svg).toContain(`stroke="${LINE_STYLES.cut.stroke}"`); // cut 本身仍保留，證明過濾有選擇性、不是整包清空
    });

    it('viewBox/width/height 以過濾後的製造幾何 bounds 重算，不沿用含標註的 result.bounds（mutation 檢查：若沿用 result.bounds，viewBox 會殘留標註外擴的空白邊）', () => {
      // cut 幾何本身 bounds 只到 x∈[0,10]/y∈[0,10]；result.bounds 因為含 dimension 標註被
      // 撐大到 x∈[-20,50]/y∈[-20,40]——製造模式必須用前者（10×10）算 viewBox，不能用後者。
      const result = makeResult({
        paths: [
          { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }] },
          { id: 'p-dim', type: 'dimension', segments: [{ kind: 'line', x1: -20, y1: -20, x2: 50, y2: 40 }] },
        ],
        bounds: { minX: -20, maxX: 50, minY: -20, maxY: 40 },
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).toContain('width="10.00mm"');
      expect(svg).toContain('height="10.00mm"');
      expect(svg).toContain('viewBox="0.00 0.00 10.00 10.00"');
      expect(svg).not.toContain('width="70.00mm"');
      expect(svg).not.toContain('viewBox="-20.00 -20.00 70.00 60.00"');
    });

    it('viewBox 重算與獨立呼叫 manufacturingBounds() 的結果一致（不是測試巧合湊出的固定值，是真的用同一份 bounds 計算）', () => {
      const result = makeResult({
        paths: [
          { id: 'p-cut', type: 'cut', segments: [{ kind: 'line', x1: 3, y1: 4, x2: 13, y2: 24 }] },
          { id: 'p-dim', type: 'dimension', segments: [{ kind: 'line', x1: -50, y1: -50, x2: 90, y2: 90 }] },
        ],
        bounds: { minX: -50, maxX: 90, minY: -50, maxY: 90 },
      });
      const expected = manufacturingBounds(result);
      const svg = toSvgDocument(result, { manufacturing: true });
      const width = expected.maxX - expected.minX;
      const height = expected.maxY - expected.minY;
      expect(svg).toContain(
        `viewBox="${expected.minX.toFixed(2)} ${expected.minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}"`,
      );
    });

    it('全部是 dimension/annotation（無 cut/crease/halfcut）：製造模式輸出合法但無圖形內容的 SVG 骨架，不拋錯、不出現 NaN', () => {
      const result = makeResult({
        paths: [{ id: 'p-dim', type: 'dimension', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
        texts: [{ id: 't-0', x: 5, y: 0, text: '10mm' }],
      });
      const svg = toSvgDocument(result, { manufacturing: true });
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).not.toContain('<path');
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('NaN');
    });
  });

  describe('RTE 驗一組（全盒型證明——F7 是 exporter 層功能，不綁 telescope，見 spec §F7「全盒型功能」）', () => {
    it('RTE 真實輸出套用製造模式：solid／0.25／round cap-join／排除標註＋文字／viewBox＝製造幾何 bounds', () => {
      const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
      const svg = toSvgDocument(result, { manufacturing: true });

      expect(svg).not.toContain('stroke-dasharray');
      expect(svg).not.toContain('stroke-width="0.4"');
      expect(svg).toContain('stroke-linecap="round"');
      expect(svg).toContain('stroke-linejoin="round"');
      expect(svg).not.toContain('<text');
      expect(svg).not.toContain('id="DIMENSIONS"');

      const expectedBounds = manufacturingBounds(result);
      const width = expectedBounds.maxX - expectedBounds.minX;
      const height = expectedBounds.maxY - expectedBounds.minY;
      expect(svg).toContain(
        `viewBox="${expectedBounds.minX.toFixed(2)} ${expectedBounds.minY.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}"`,
      );
      // RTE 的 result.bounds 含尺寸標註外擴，理應比製造幾何 bounds 寬鬆——先確認兩者真的
      // 不同，這條測試才有能力區分「用對 bounds」與「沿用 result.bounds 但巧合沒差」。
      expect(result.bounds).not.toEqual(expectedBounds);

      // 輸出的 <path> 數＝非 dimension/annotation 的 paths 數（RTE 沒有 halfcut，見既有
      // 「空桶不輸出 g：RTE...不含 <g id="HALFCUT">」測試；這裡不重複假設 cut/crease 是
      // 唯二型別，直接用 F7 的過濾定義 DIMENSION_LINE_TYPES 算期望值）。
      const pathCount = (svg.match(/<path /g) ?? []).length;
      const manufacturingPathCount = result.paths.filter((p) => !DIMENSION_LINE_TYPES.has(p.type)).length;
      expect(pathCount).toBe(manufacturingPathCount);
      expect(manufacturingPathCount).toBeGreaterThan(0);
    });
  });
});
