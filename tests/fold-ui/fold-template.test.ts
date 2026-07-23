// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import type { ArtworkLayout } from '@/ui/artwork-layout';
import {
  artworkLayoutSignatureFromLayout,
  deriveArtworkLayout,
  hashArtworkLayoutSignature,
} from '@/ui/artwork-layout';
import { panelSolidUvs } from '@/ui/fold-scene';
import { buildTemplateFilename, buildTemplateSvg } from '@/ui/fold-template';
import { earClipIndices } from '@/ui/triangulate';

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

function expectEmittedDieline(doc: Document, layout: ArtworkLayout): void {
  const expected = layout.dieline.flatMap((path) => path.segments.map((segment, segmentIndex) => ({
    pathId: path.id,
    type: path.type,
    segment,
    segmentIndex,
  })));
  const emitted = elementsByAttr(doc, '*', 'data-dieline-path-id');
  expect(emitted).toHaveLength(expected.length);

  expected.forEach(({ pathId, type, segment, segmentIndex }, index) => {
    const element = emitted[index]!;
    expect(element.getAttribute('data-dieline-path-id')).toBe(pathId);
    expect(Number(element.getAttribute('data-dieline-segment-index'))).toBe(segmentIndex);
    expect(element.getAttribute('data-dieline-type')).toBe(type);
    expect(element.getAttribute('data-dieline-kind')).toBe(segment.kind);

    if (segment.kind === 'line') {
      expect(element.tagName).toBe('line');
      expect([
        Number(element.getAttribute('x1')),
        Number(element.getAttribute('y1')),
        Number(element.getAttribute('x2')),
        Number(element.getAttribute('y2')),
      ]).toEqual([segment.x1, segment.y1, segment.x2, segment.y2]);
      return;
    }
    expect(element.tagName).toBe('path');
    if (segment.kind === 'bezier') {
      expect(element.getAttribute('d')).toBe(
        `M${segment.x1},${segment.y1} C${segment.c1x},${segment.c1y} `
        + `${segment.c2x},${segment.c2y} ${segment.x2},${segment.y2}`,
      );
      return;
    }
    const start = {
      x: segment.cx + segment.r * Math.cos(segment.startAngle),
      y: segment.cy + segment.r * Math.sin(segment.startAngle),
    };
    const end = {
      x: segment.cx + segment.r * Math.cos(segment.endAngle),
      y: segment.cy + segment.r * Math.sin(segment.endAngle),
    };
    expect(element.getAttribute('d')).toBe(
      `M${start.x},${start.y} A${segment.r},${segment.r} 0 0,${segment.ccw ? 0 : 1} ${end.x},${end.y}`,
    );
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

function pairedGroupRange(svg: string, id: string): { start: number; end: number } {
  const openingTag = `<g id="${id}">`;
  const start = svg.indexOf(openingTag);
  if (start === -1) throw new Error(`Missing SVG group: ${id}`);

  const groupTag = /<\/?g(?:\s[^>]*)?>/g;
  groupTag.lastIndex = start;
  let depth = 0;
  for (let match = groupTag.exec(svg); match !== null; match = groupTag.exec(svg)) {
    depth += match[0].startsWith('</g') ? -1 : 1;
    if (depth === 0) return { start, end: match.index + match[0].length };
  }
  throw new Error(`Unclosed SVG group: ${id}`);
}

describe('buildTemplateSvg — viewBox 與方形頁框', () => {
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
  it('zoneDLip virtual hinge 不會合成 guide，輸出數量只由真實 dieline 決定', () => {
    const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
    const layout = deriveArtworkLayout(model);
    const lip = layout.panels.find(({ id }) => id === 'zoneDLip');
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'ttb', label: 'TTB', lang: 'en' }));

    expect(lip).toBeDefined();
    expect(lip!.hinge?.virtual).toBe(true);
    expectEmittedDieline(doc, layout);
    expect(elementsByAttr(doc, '*', 'data-hinge-panel-id')).toHaveLength(0);
  });

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

  it('dieline cut/crease 的 stroke、width、dasharray 與 LINE_STYLES 同源', () => {
    const doc = parseSvg(svgFor({}));
    const cutEdge = elementsByAttr(doc, '*', 'data-dieline-type', 'cut')[0]!;
    expect(cutEdge.getAttribute('stroke')).toBe(LINE_STYLES.cut.stroke);
    expect(Number(cutEdge.getAttribute('stroke-width'))).toBe(LINE_STYLES.cut.strokeWidth);
    expect(cutEdge.getAttribute('fill')).toBe('none');

    const hingeLine = elementsByAttr(doc, '*', 'data-dieline-type', 'crease')[0]!;
    expect(hingeLine.getAttribute('stroke')).toBe(LINE_STYLES.crease.stroke);
    expect(Number(hingeLine.getAttribute('stroke-width'))).toBe(LINE_STYLES.crease.strokeWidth);
    expect(hingeLine.getAttribute('stroke-dasharray')).toBe(LINE_STYLES.crease.dasharray ?? null);
  });
});

describe('buildTemplateSvg — label map（default／zero-tuck／zero-lock 三 fixture）', () => {
  it('default：single lid 各標示一次', () => {
    expect(labelMapFrom(svgFor({}))).toEqual({
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

  it('zero-tuck（tuckDepth=0）：無插舌面板、其餘標示不變', () => {
    expect(labelMapFrom(svgFor({ tuckDepth: 0 }))).toEqual({
      P1: 'P1',
      P2: 'P2',
      P3: 'P3',
      P4: 'P4',
      glue: 'glue',
      topLid: 'top lid',
      bottomLid: 'bottom lid',
      topDustP2: 'dust flap',
      topDustP4: 'dust flap',
      bottomDustP2: 'dust flap',
      bottomDustP4: 'dust flap',
    });
  });

  it('zero-lock：single lid 仍標 top lid／bottom lid', () => {
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

  it('已退役的 lid fragment id 不出現在任何標示文字內容中', () => {
    const doc = parseSvg(svgFor({}));
    const labels = elementsByAttr(doc, 'text', 'data-label-panel-id').map((el) => el.textContent ?? '');
    for (const forbidden of ['top', 'bottom'].flatMap((side) =>
      ['L', 'C', 'R'].map((suffix) => `${side}Lid${suffix}`))) {
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

  it('角落指示文字依 opts.lang 切換 EN/zh 字面（逐字比對）', () => {
    const textOf = (svg: string): string | null =>
      elementsByAttr(parseSvg(svg), 'text', 'data-role', 'instructions')[0]?.textContent ?? null;

    // 指示文字講三件硬需求（不提「畫進 ARTWORK」——Illustrator 群組不可直接作畫），
    // 指示文字包含「轉存時勾選使用工作區域」——預防 Illustrator 匯出改寫 viewBox。
    expect(textOf(svgFor({}, 'en'))).toBe(
      'Paint anywhere on the page. Hide TEMPLATE_GUIDES before exporting, keep the full square page, and check “Use Artboards” on export. Made with open-dieline · dieline.konvolut.art',
    );
    expect(textOf(svgFor({}, 'zh'))).toBe(
      '作畫位置不限，匯出前請關閉 TEMPLATE_GUIDES 顯示，保留完整正方形頁面，並在轉存時勾選『使用工作區域』。　以 open-dieline 製作 · dieline.konvolut.art',
    );
  });
});

describe('buildTemplateSvg — TEMPLATE 圖層歸屬', () => {
  it.each([
    ['en', 'Made with open-dieline · dieline.konvolut.art'],
    ['zh', '以 open-dieline 製作 · dieline.konvolut.art'],
  ] as const)('%s source line 位於 TEMPLATE_GUIDES 配對範圍，ARTWORK 空層在其後', (lang, sourceLine) => {
    const svg = svgFor({}, lang);
    const guides = pairedGroupRange(svg, 'TEMPLATE_GUIDES');
    const artwork = pairedGroupRange(svg, 'ARTWORK');
    const sourceLineIndex = svg.indexOf(sourceLine);

    expect(sourceLineIndex).toBeGreaterThan(guides.start);
    expect(sourceLineIndex).toBeLessThan(guides.end);
    expect(artwork.start).toBeGreaterThan(guides.end);
  });
});

describe('buildTemplateFilename', () => {
  it('open-dieline-template-{boxId}-{L}x{W}x{D}.svg（L/W/D 取 resolved params 數值）', () => {
    const values = resolveParams(reverseTuckEnd, {});
    expect(buildTemplateFilename('rte', values)).toBe(
      `open-dieline-template-rte-${values.L}x${values.W}x${values.D}.svg`,
    );
  });

  // ttsl 跟 rte 一樣宣告 L/W/D，檔名字面維持 {L}x{W}x{D} 樣式。
  it('ttsl（同樣宣告 L/W/D）維持 {L}x{W}x{D} 樣式', () => {
    const values = resolveParams(tuckTopSnapLock, {});
    expect(buildTemplateFilename('ttsl', values)).toBe(
      `open-dieline-template-ttsl-${values.L}x${values.W}x${values.D}.svg`,
    );
  });

  // ttb 沒有 L/W/D、只宣告 edgeA/tubeLength——檔名讀盒型 params 宣告的 dimensions
  // 群組欄位，得到 edgeA×tubeLength 樣式（若照抓 L/W/D 會全數落空、退化成
  // `open-dieline-template-ttb-?x?x?.svg`，見下方反向斷言）。
  it('ttb（無 L/W/D，宣告 edgeA/tubeLength）讀盒型實際尺寸欄位，不退化成 ?x?x?', () => {
    const values = resolveParams(triangularTube, {});
    expect(buildTemplateFilename('ttb', values)).toBe(
      `open-dieline-template-ttb-${values.edgeA}x${values.tubeLength}.svg`,
    );
    expect(buildTemplateFilename('ttb', values)).not.toBe('open-dieline-template-ttb-?x?x?.svg');
  });
});

describe('buildTemplateSvg — 對位同源（TEMPLATE 與 3D UV 消費同一補償後真刀模版面）', () => {
  it('SVG guide 與 ArtworkLayout 完整 dieline 逐 path、segment、座標相同', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    expectEmittedDieline(doc, layout);
  });

  it('模板共用 frame 與 panelSolidUvs 對同一 panel 頂點的 UV 換算一致', () => {
    const layout = layoutFor({});

    for (const panel of layout.panels) {
      // 獨立第二條路徑：3D 貼圖實際消費的 panelSolidUvs，對同一 panel 第一個頂點算出的
      // UV，須與 uvFromXY 對同一頂點算出的值一致——證明模板換算與 3D UV 映射是同一份
      // 公式作用在同一份資料，不是各自複製一份、恰好碰巧同值。
      const panelUvs = panelSolidUvs(
        panel.polygon.map((point) => ({ ...point, z: 0 })),
        earClipIndices(panel.polygon),
        layout.frame,
        0,
      );
      // panelSolidUvs 回傳 Float32Array（3D 貼圖管線的真實精度，~7 位有效數字）——
      // 容差對齊 float32 精度上限，不是放寬到失去交叉驗證意義。
      const firstVertexUv = { u: panelUvs[0]!, v: panelUvs[1]! };
      const expectedFirstVertexUv = uvFromXY(panel.polygon[earClipIndices(panel.polygon)[0]!]!, layout.frame);
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

describe('buildTemplateSvg — inactive/退化變體仍遵循 2D 全量繪製集', () => {
  it.each([
    ['default', {}],
    ['zero lock', { tuckLock: 0 }],
    ['zero tuck', { tuckDepth: 0 }],
    ['zero dust', { dustFlapDepth: 0 }],
    ['single zero width', { L: 20, tuckClearance: 10 }],
    ['double zero', { L: 20, tuckClearance: 10, thickness: 0 }],
  ] as const)('%s：模板逐 segment 等於 layout.dieline', (_label, overrides) => {
    const layout = layoutFor(overrides);
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    expectEmittedDieline(doc, layout);
  });
});

describe('buildTemplateSvg — 根 id 命名圖層', () => {
  it('根 <svg id="TEMPLATE">——Illustrator 開檔時唯一圖層以此命名', () => {
    const doc = parseSvg(svgFor({}));
    expect(doc.documentElement.getAttribute('id')).toBe('TEMPLATE');
  });
});

describe('buildTemplateSvg — data-layout-hash（上傳時偵測 stale 模板）', () => {
  it('根元素 data-layout-hash＝該 layout 簽章的 hash（與 artwork-layout 共用同一顆 hash 函式，非各自算一套）', () => {
    const layout = layoutFor({});
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }));
    const expectedHash = hashArtworkLayoutSignature(artworkLayoutSignatureFromLayout(layout));

    expect(doc.documentElement.getAttribute('data-layout-hash')).toBe(expectedHash);
  });

  it('參數改變（L 改變）時 hash 隨之改變（否則上傳時偵測不到 stale 模板）', () => {
    const baseline = layoutFor({});
    const changed = layoutFor({ L: (baseline.frame.span) + 10 });
    const hashOf = (layout: ArtworkLayout): string =>
      parseSvg(buildTemplateSvg(layout, { boxId: 'rte', label: 'RTE', lang: 'en' }))
        .documentElement.getAttribute('data-layout-hash')!;

    expect(hashOf(changed)).not.toBe(hashOf(baseline));
  });
});

describe('buildTemplateSvg — 完整 dieline guide', () => {
  it('TTB 每個原始 segment 都有對應 guide，包含完整 A/B crease 與 slot cut', () => {
    const params = resolveParams(triangularTube, {});
    const generated = triangularTube.generate(params);
    const layout = deriveArtworkLayout(buildTtbFoldModel(params));
    const doc = parseSvg(buildTemplateSvg(layout, { boxId: 'ttb', label: 'TTB', lang: 'en' }));
    const guideElements = elementsByAttr(doc, '*', 'data-dieline-path-id');
    const expectedSegmentCount = generated.paths
      .filter(({ type }) => type === 'cut' || type === 'crease')
      .reduce((sum, path) => sum + path.segments.length, 0);
    const abCreaseIds = generated.paths
      .filter((path) => path.tags?.includes('abCrease'))
      .map(({ id }) => id);
    const slotId = generated.paths.find((path) => path.tags?.includes('abSlot'))!.id;

    expect(guideElements).toHaveLength(expectedSegmentCount);
    expect(guideElements.filter((element) =>
      abCreaseIds.includes(element.getAttribute('data-dieline-path-id')!))).toHaveLength(2);
    expect(guideElements.some((element) =>
      element.getAttribute('data-dieline-path-id') === slotId)).toBe(true);
  });

  it('TEMPLATE_SEAMS 退役，頁框、標示、指示與 ARTWORK 結構維持', () => {
    const doc = parseSvg(svgFor({}));

    expect(elementsByAttr(doc, 'g', 'id', 'TEMPLATE_SEAMS')).toHaveLength(0);
    expect(elementsByAttr(doc, 'g', 'id', 'TEMPLATE_GUIDES')).toHaveLength(1);
    expect(elementsByAttr(doc, 'rect', 'data-role', 'page-frame')).toHaveLength(1);
    expect(elementsByAttr(doc, 'text', 'data-role', 'instructions')).toHaveLength(1);
    expect(elementsByAttr(doc, 'g', 'id', 'ARTWORK')).toHaveLength(1);
  });
});
