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

function parsePoints(pointsAttr: string): { x: number; y: number }[] {
  return pointsAttr
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x: x!, y: y! };
    });
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

  it('panel 外緣 stroke/width 與 LINE_STYLES.cut 同源；hinge 摺線 stroke/width/dasharray 與 LINE_STYLES.crease 同源', () => {
    const doc = parseSvg(svgFor({}));
    const panelOutline = elementsByAttr(doc, 'polygon', 'data-panel-id', 'P1')[0]!;
    expect(panelOutline.getAttribute('stroke')).toBe(LINE_STYLES.cut.stroke);
    expect(Number(panelOutline.getAttribute('stroke-width'))).toBe(LINE_STYLES.cut.strokeWidth);

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

    expect(textOf(svgFor({}, 'en'))).toBe(
      'Paint in the ARTWORK layer. Hide TEMPLATE_GUIDES before exporting and keep the full square page.',
    );
    // zh 避字「隱」（U+96B1，不在 noto-serif-tc-subset.woff2 cmap 內·font-gate 實抓）：
    // 見 fold-template.ts TEMPLATE_INSTRUCTIONS 註解，改用「關閉…顯示」保留原意。
    expect(textOf(svgFor({}, 'zh'))).toBe(
      '請在 ARTWORK 圖層作畫，匯出前請關閉 TEMPLATE_GUIDES 顯示，並保留完整正方形頁面。',
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
  it('SVG 面板外緣的每個角點與 ArtworkLayout 原始座標逐點相同（同一份幾何、無獨立複製一份）', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));

    for (const panel of layout.panels) {
      const el = elementsByAttr(doc, 'polygon', 'data-panel-id', panel.id)[0]!;
      const parsed = parsePoints(el.getAttribute('points')!);
      expect(parsed).toEqual(panel.polygon);
    }
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
