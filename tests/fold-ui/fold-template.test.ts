import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import type { ArtworkLayout } from '@/ui/artwork-layout';
import { deriveArtworkLayout } from '@/ui/artwork-layout';
import { panelSolidUvs } from '@/ui/fold-scene';
import { buildTemplateFilename, buildTemplateSvg } from '@/ui/fold-template';

function layoutFor(overrides: Record<string, number | string | boolean>): ArtworkLayout {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
  return deriveArtworkLayout(model);
}

function svgFor(overrides: Record<string, number | string | boolean>, lang: 'en' | 'zh' = 'en'): string {
  return buildTemplateSvg(layoutFor(overrides), { boxId: 'rte', label: 'RTE 55 × 55 × 117', lang });
}

function parseSvg(svg: string): Document {
  return new DOMParser().parseFromString(svg, 'image/svg+xml');
}

/** 只用 getElementsByTagName + 屬性過濾——不靠 querySelector/getElementById 對 XML doc 的
 *  隱含 CSS engine 支援（jsdom 對 SVG/XML document 的 querySelector 行為不如 HTML document
 *  穩定，getElementsByTagName 是所有 DOM 實作皆保證的 Level-1 API）。 */
function elementsByAttr(doc: Document, tag: string, attr: string, value?: string): Element[] {
  return Array.from(doc.getElementsByTagName(tag)).filter((el) =>
    (value === undefined ? el.hasAttribute(attr) : el.getAttribute(attr) === value));
}

function uvFromXY(point: { x: number; y: number }, frame: ArtworkLayout['frame']): { u: number; v: number } {
  return {
    u: (point.x - frame.minX + frame.offsetX) / frame.span,
    v: 1 - (point.y - frame.minY + frame.offsetY) / frame.span,
  };
}

function labelMapFrom(svg: string): Record<string, string> {
  const doc = parseSvg(svg);
  const labels = elementsByAttr(doc, 'text', 'data-label-panel-id');
  const map: Record<string, string> = {};
  for (const el of labels) {
    map[el.getAttribute('data-label-panel-id')!] = el.textContent ?? '';
  }
  return map;
}

describe('buildTemplateSvg — viewBox 與方形頁框（C2）', () => {
  it('viewBox = [minX-offsetX, minY-offsetY, span, span]，width/height 皆為 span 且相等', () => {
    const layout = layoutFor({});
    const svg = buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' });
    const doc = parseSvg(svg);
    const root = doc.documentElement;
    const [vx, vy, vw, vh] = root.getAttribute('viewBox')!.trim().split(/\s+/).map(Number);

    expect(vx).toBeCloseTo(layout.frame.minX - layout.frame.offsetX, 9);
    expect(vy).toBeCloseTo(layout.frame.minY - layout.frame.offsetY, 9);
    expect(vw).toBeCloseTo(layout.frame.span, 9);
    expect(vh).toBeCloseTo(layout.frame.span, 9);
    expect(vw).toBeCloseTo(vh!, 9);

    expect(root.getAttribute('width')).toMatch(/^[\d.eE+-]+mm$/);
    expect(root.getAttribute('height')).toMatch(/^[\d.eE+-]+mm$/);
    expect(parseFloat(root.getAttribute('width')!)).toBeCloseTo(layout.frame.span, 9);
    expect(parseFloat(root.getAttribute('height')!)).toBeCloseTo(layout.frame.span, 9);
  });
});

describe('buildTemplateSvg — line style 白名單（模板只含 cut/crease）', () => {
  it('TEMPLATE_GUIDES 內所有 stroke 只能是 LINE_STYLES.cut/crease 兩色，且兩色都確實出現', () => {
    const doc = parseSvg(svgFor({}));
    const guidesGroups = elementsByAttr(doc, 'g', 'id', 'TEMPLATE_GUIDES');
    expect(guidesGroups).toHaveLength(1);

    const strokes = new Set<string>();
    for (const el of Array.from(guidesGroups[0]!.getElementsByTagName('*'))) {
      if (el.hasAttribute('stroke')) strokes.add(el.getAttribute('stroke')!);
    }

    expect(strokes.has(LINE_STYLES.cut.stroke)).toBe(true);
    expect(strokes.has(LINE_STYLES.crease.stroke)).toBe(true);
    for (const stroke of strokes) {
      expect([LINE_STYLES.cut.stroke, LINE_STYLES.crease.stroke]).toContain(stroke);
    }
    for (const forbidden of [
      LINE_STYLES.halfcut.stroke,
      LINE_STYLES.bleed.stroke,
      LINE_STYLES.annotation.stroke,
      LINE_STYLES.dimension.stroke,
    ]) {
      expect(strokes.has(forbidden)).toBe(false);
    }
  });

  it('panel 外緣 cut 邊 stroke/width 與 LINE_STYLES.cut 同源；hinge 摺線 stroke/width/dasharray 與 LINE_STYLES.crease 同源', () => {
    const doc = parseSvg(svgFor({}));
    // C9 修法 A 後 cut 以逐邊 <line data-panel-id> 輸出（共享邊 dedup），hinge 線用
    // data-hinge-panel-id——兩個屬性不相交，data-panel-id 命中的必為 cut 邊。
    const cutEdge = elementsByAttr(doc, 'line', 'data-panel-id', 'P1')[0]!;
    expect(cutEdge.getAttribute('stroke')).toBe(LINE_STYLES.cut.stroke);
    expect(Number(cutEdge.getAttribute('stroke-width'))).toBe(LINE_STYLES.cut.strokeWidth);

    const hingeLine = elementsByAttr(doc, 'line', 'data-hinge-panel-id', 'P2')[0]!;
    expect(hingeLine.getAttribute('stroke')).toBe(LINE_STYLES.crease.stroke);
    expect(Number(hingeLine.getAttribute('stroke-width'))).toBe(LINE_STYLES.crease.strokeWidth);
    expect(hingeLine.getAttribute('stroke-dasharray')).toBe(LINE_STYLES.crease.dasharray ?? null);
  });
});

describe('buildTemplateSvg — label map（default／zero-tuck／zero-lock 三 fixture，m13）', () => {
  it('default（tuckLock=20 分片）：分片 lid 只在 C 片標一次；L/R 無標示', () => {
    expect(labelMapFrom(svgFor({}))).toEqual({
      P1: 'P1',
      P2: 'P2',
      P3: 'P3',
      P4: 'P4',
      glue: 'glue',
      topLidC: 'top lid',
      bottomLidC: 'bottom lid',
      topTuck: 'tuck',
      bottomTuck: 'tuck',
      topDustP2: 'dust flap',
      topDustP4: 'dust flap',
      bottomDustP2: 'dust flap',
      bottomDustP4: 'dust flap',
    });
  });

  it('zero-tuck（tuckDepth=0）：無插舌面板、其餘標示不變', () => {
    expect(labelMapFrom(svgFor({ tuckDepth: 0 }))).toEqual({
      P1: 'P1',
      P2: 'P2',
      P3: 'P3',
      P4: 'P4',
      glue: 'glue',
      topLidC: 'top lid',
      bottomLidC: 'bottom lid',
      topDustP2: 'dust flap',
      topDustP4: 'dust flap',
      bottomDustP2: 'dust flap',
      bottomDustP4: 'dust flap',
    });
  });

  it('zero-lock（tuckLock=0）：單片 lid 直接標 top lid／bottom lid（非分片 id）', () => {
    expect(labelMapFrom(svgFor({ tuckLock: 0 }))).toEqual({
      P1: 'P1',
      P2: 'P2',
      P3: 'P3',
      P4: 'P4',
      glue: 'glue',
      topLid: 'top lid',
      bottomLid: 'bottom lid',
      topTuck: 'tuck',
      bottomTuck: 'tuck',
      topDustP2: 'dust flap',
      topDustP4: 'dust flap',
      bottomDustP2: 'dust flap',
      bottomDustP4: 'dust flap',
    });
  });

  it('內部分片 id（topLidL/topLidR 等）不出現在任何標示文字內容中', () => {
    const doc = parseSvg(svgFor({}));
    const labels = elementsByAttr(doc, 'text', 'data-label-panel-id').map((el) => el.textContent ?? '');
    for (const forbidden of ['topLidL', 'topLidR', 'bottomLidL', 'bottomLidR', 'topLidC', 'bottomLidC']) {
      expect(labels).not.toContain(forbidden);
    }
  });
});

describe('buildTemplateSvg — <g id="ARTWORK"> 空殼＋角落指示文字', () => {
  it('<g id="ARTWORK"> 為空（供使用者作畫，模板本身不預填內容）', () => {
    const doc = parseSvg(svgFor({}));
    const artworkGroups = elementsByAttr(doc, 'g', 'id', 'ARTWORK');
    expect(artworkGroups).toHaveLength(1);
    expect(artworkGroups[0]!.childNodes.length).toBe(0);
  });

  it('角落指示文字依 opts.lang 切換 EN/zh 字面（Spec F1.2 逐字）', () => {
    const textOf = (svg: string): string | null =>
      elementsByAttr(parseSvg(svg), 'text', 'data-role', 'instructions')[0]?.textContent ?? null;

    // C9 修正版字面（2026-07-18）：不再教「畫進 ARTWORK」（Illustrator 群組不可直接
    // 作畫·實測），只講兩件硬需求。腳本提示句已隨 Q2 拆鈕裁決移除。
    // zh 避字見 fold-template.ts 註解。
    expect(textOf(svgFor({}, 'en'))).toBe(
      'Paint anywhere on the page. Hide TEMPLATE_GUIDES before exporting and keep the full square page.',
    );
    expect(textOf(svgFor({}, 'zh'))).toBe(
      '作畫位置不限，匯出前請關閉 TEMPLATE_GUIDES 顯示，並保留完整正方形頁面。',
    );
  });
});

describe('buildTemplateFilename', () => {
  it('open-dieline-template-{boxId}-{L}x{W}x{D}.svg（L/W/D 取 resolved params 數值）', () => {
    const values = resolveParams(reverseTuckEnd, {});
    expect(buildTemplateFilename('rte', values)).toBe(
      `open-dieline-template-rte-${values.L}x${values.W}x${values.D}.svg`,
    );
  });
});

describe('buildTemplateSvg — C1 對位同源（TEMPLATE 與 3D UV 消費同一 ArtworkLayout，非只斷言共用 frame 函式）', () => {
  it('SVG cut 邊端點與 ArtworkLayout 原始座標逐 bit 相同，且恰為「全 panel 邊集中恰出現一次」的邊（測試端獨立重算 oracle）', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));

    // 獨立 oracle：測試端自行重算 canonical 邊次數，不呼叫實作的 dedup。fmt 的最短
    // 可逆表示保證 Number↔String 逐 bit 可逆，key 用原始 number 字串化即可對上。
    const canonical = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
      const ka = `${a.x},${a.y}`;
      const kb = `${b.x},${b.y}`;
      return ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    };
    const counts = new Map<string, number>();
    const owner = new Map<string, string>();
    for (const panel of layout.panels) {
      const polygon = panel.polygon;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i]!;
        const b = polygon[(i + 1) % polygon.length]!;
        if (a.x === b.x && a.y === b.y) continue;
        const key = canonical(a, b);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        owner.set(key, panel.id);
      }
    }
    const expectedUnique = new Set(
      Array.from(counts.entries()).filter(([, count]) => count === 1).map(([key]) => key),
    );

    const emitted = new Set<string>();
    for (const el of elementsByAttr(doc, 'line', 'data-panel-id')) {
      const a = { x: Number(el.getAttribute('x1')), y: Number(el.getAttribute('y1')) };
      const b = { x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')) };
      const key = canonical(a, b);
      expect(emitted.has(key)).toBe(false); // 每邊至多輸出一次
      emitted.add(key);
      expect(expectedUnique.has(key)).toBe(true); // 只輸出唯一邊（共享邊不畫）
      expect(el.getAttribute('data-panel-id')).toBe(owner.get(key)); // 歸屬＝唯一所屬 panel
    }
    expect(emitted.size).toBe(expectedUnique.size); // 唯一邊全數輸出、無漏
  });

  it('SVG hinge 端點與 ArtworkLayout hinge 逐值相同；中點換算 UV 落在 [0,1] 且與獨立第二條路徑（panelSolidUvs 對同一頂點算出的 UV）一致', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));

    for (const panel of layout.panels) {
      if (panel.hinge === undefined) continue;
      const el = elementsByAttr(doc, 'line', 'data-hinge-panel-id', panel.id)[0]!;
      const a = { x: Number(el.getAttribute('x1')), y: Number(el.getAttribute('y1')) };
      const b = { x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')) };
      expect(a).toEqual(panel.hinge.a);
      expect(b).toEqual(panel.hinge.b);

      const svgMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const templateUv = uvFromXY(svgMidpoint, layout.frame);
      expect(templateUv.u).toBeGreaterThanOrEqual(0);
      expect(templateUv.u).toBeLessThanOrEqual(1);
      expect(templateUv.v).toBeGreaterThanOrEqual(0);
      expect(templateUv.v).toBeLessThanOrEqual(1);

      // 獨立第二條路徑：3D 貼圖實際消費的 panelSolidUvs，對同一 panel 第一個頂點算出的
      // UV，須與 uvFromXY 對同一頂點算出的值一致——證明模板換算與 3D UV 映射是同一份
      // 公式作用在同一份資料，不是各自複製一份、恰好碰巧同值。
      const panelUvs = panelSolidUvs(
        panel.polygon.map((point) => ({ ...point, z: 0 })),
        layout.frame,
        0,
      );
      // panelSolidUvs 回傳 Float32Array（3D 貼圖管線的真實精度，~7 位有效數字）——
      // 容差對齊 float32 精度上限，不是放寬到失去交叉驗證意義。
      const firstVertexUv = { u: panelUvs[0]!, v: panelUvs[1]! };
      const expectedFirstVertexUv = uvFromXY(panel.polygon[0]!, layout.frame);
      expect(firstVertexUv.u).toBeCloseTo(expectedFirstVertexUv.u, 5);
      expect(firstVertexUv.v).toBeCloseTo(expectedFirstVertexUv.v, 5);
    }
  });

  it('panel 標示位置＝polygon bounds center，換算 UV 落在該 panel 角點 UV 的 min/max 範圍內', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));

    for (const panel of layout.panels) {
      const labelEl = elementsByAttr(doc, 'text', 'data-label-panel-id', panel.id)[0];
      if (labelEl === undefined) continue; // 無標示的分片（L/R）略過

      const svgLabelPos = { x: Number(labelEl.getAttribute('x')), y: Number(labelEl.getAttribute('y')) };
      const xs = panel.polygon.map((p) => p.x);
      const ys = panel.polygon.map((p) => p.y);
      const expectedCenter = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
      expect(svgLabelPos).toEqual(expectedCenter);

      const cornerUvs = panel.polygon.map((point) => uvFromXY(point, layout.frame));
      const centerUv = uvFromXY(expectedCenter, layout.frame);
      const uMin = Math.min(...cornerUvs.map((uv) => uv.u));
      const uMax = Math.max(...cornerUvs.map((uv) => uv.u));
      const vMin = Math.min(...cornerUvs.map((uv) => uv.v));
      const vMax = Math.max(...cornerUvs.map((uv) => uv.v));
      expect(centerUv.u).toBeGreaterThanOrEqual(uMin - 1e-9);
      expect(centerUv.u).toBeLessThanOrEqual(uMax + 1e-9);
      expect(centerUv.v).toBeGreaterThanOrEqual(vMin - 1e-9);
      expect(centerUv.v).toBeLessThanOrEqual(vMax + 1e-9);
    }
  });
});

// C9 問題 1 迴歸鎖（2026-07-18 裁定修法 A）：C9 真實流程在 Illustrator 發現
// 上下蓋各多兩條縱向刀線——tuckLock 分片（L/C/R）的內部邊界被相鄰分片各畫一次、
// 裸露成 cut，2D 正式 dieline 沒有這些線。鎖住「分片共享邊不出現在模板 cut 中」。
describe('buildTemplateSvg — C9 分片內部邊不輸出（edge dedup 迴歸鎖）', () => {
  function cutEdgeKeys(doc: Document): Set<string> {
    const keys = new Set<string>();
    for (const el of elementsByAttr(doc, 'line', 'data-panel-id')) {
      const ka = `${el.getAttribute('x1')},${el.getAttribute('y1')}`;
      const kb = `${el.getAttribute('x2')},${el.getAttribute('y2')}`;
      keys.add(ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    }
    return keys;
  }

  function polygonEdgeKeys(layout: ArtworkLayout, panelId: string): Set<string> {
    const panel = layout.panels.find((entry) => entry.id === panelId)!;
    const keys = new Set<string>();
    const polygon = panel.polygon;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      if (a.x === b.x && a.y === b.y) continue;
      const ka = `${a.x},${a.y}`;
      const kb = `${b.x},${b.y}`;
      keys.add(ka <= kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    }
    return keys;
  }

  function sharedKeys(layout: ArtworkLayout, idA: string, idB: string): Set<string> {
    const keysA = polygonEdgeKeys(layout, idA);
    return new Set(Array.from(polygonEdgeKeys(layout, idB)).filter((key) => keysA.has(key)));
  }

  it('default（tuckLock=20 分片）：lid 分片間共享邊存在於幾何、但不出現在模板 cut（使用者看到的多餘刀線）', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    const emitted = cutEdgeKeys(doc);

    for (const [idA, idB] of [
      ['topLidL', 'topLidC'],
      ['topLidC', 'topLidR'],
      ['bottomLidL', 'bottomLidC'],
      ['bottomLidC', 'bottomLidR'],
    ] as const) {
      const shared = sharedKeys(layout, idA, idB);
      expect(shared.size).toBeGreaterThan(0); // fixture 有效性：分片邊界確實成對存在
      for (const key of shared) {
        expect(emitted.has(key)).toBe(false); // 共享邊不畫＝多餘刀線消失
      }
    }
  });

  it('body 真摺邊（P1/P2 共享邊）cut 不畫、hinge crease 仍畫（摺線語義歸 crease·與 2D dieline 一致）', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    const emitted = cutEdgeKeys(doc);

    const shared = sharedKeys(layout, 'P1', 'P2');
    expect(shared.size).toBeGreaterThan(0);
    for (const key of shared) {
      expect(emitted.has(key)).toBe(false);
    }
    expect(elementsByAttr(doc, 'line', 'data-hinge-panel-id', 'P2')).toHaveLength(1);
  });

  it('zero-lock（tuckLock=0）：單片 lid 無分片、其唯一邊照常輸出（dedup 不誤刪）', () => {
    const layout = layoutFor({ tuckLock: 0 });
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    expect(elementsByAttr(doc, 'line', 'data-panel-id', 'topLid').length).toBeGreaterThan(0);
    expect(elementsByAttr(doc, 'line', 'data-panel-id', 'bottomLid').length).toBeGreaterThan(0);
  });
});

// C9 問題 2（2026-07-18）：根 id 命名圖層（.jsx 腳本已隨 Q2 拆鈕裁決移除）。
describe('buildTemplateSvg — 根 id（C9 問題 2）', () => {
  it('根 <svg id="TEMPLATE">——Illustrator 開檔時唯一圖層以此命名（實測 Illustrator 2026 證實）', () => {
    const doc = parseSvg(svgFor({}));
    expect(doc.documentElement.getAttribute('id')).toBe('TEMPLATE');
  });
});
