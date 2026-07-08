import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import type { DielinePath, DielineText, GenerateResult } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { toDxfDocument, DXF_LAYER_BY_LINETYPE } from '@/export/dxf';

// ─────────────────────────────────────────────────────────────────────────
// parseDxf：逐行讀 group code/value 配對、依 0 碼切「記錄」（SECTION/TABLE/LAYER/
// LINE/ARC/POLYLINE/VERTEX/SEQEND/…），依所在 SECTION 分類成 layers（TABLES 段的
// LAYER 名稱）與 entities（ENTITIES 段的每筆記錄）。結構性記錄（SECTION/ENDSEC/
// TABLE/ENDTAB/EOF）本身不算 layer 也不算 entity。之後 Task 2（下載 UI）沿用同一份
// helper 驗證匯出結果，故獨立於本檔任何單一測試案例、盡量通用。
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedDxfEntity {
  type: string;
  layer: string;
  codes: Record<number, string[]>;
}

export interface ParsedDxf {
  layers: string[];
  entities: ParsedDxfEntity[];
}

const STRUCTURAL_RECORD_TYPES = new Set(['SECTION', 'ENDSEC', 'TABLE', 'ENDTAB', 'EOF']);

export function parseDxf(text: string): ParsedDxf {
  const raw = text.split('\n');
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    pairs.push([Number(raw[i]!.trim()), raw[i + 1]!.trim()]);
  }

  const layers: string[] = [];
  const entities: ParsedDxfEntity[] = [];
  let section = '';
  let record: { type: string; codes: Record<number, string[]> } | null = null;

  const flush = () => {
    if (record && !STRUCTURAL_RECORD_TYPES.has(record.type)) {
      if (section === 'TABLES' && record.type === 'LAYER') {
        layers.push(record.codes[2]?.[0] ?? '');
      } else if (section === 'ENTITIES') {
        entities.push({ type: record.type, layer: record.codes[8]?.[0] ?? '', codes: record.codes });
      }
    }
    record = null;
  };

  for (const [code, value] of pairs) {
    if (code === 0) {
      flush();
      record = { type: value, codes: {} };
      continue;
    }
    if (!record) continue;
    (record.codes[code] ??= []).push(value);
    if (code === 2 && record.type === 'SECTION') section = value;
  }
  flush();

  return { layers, entities };
}

// ─────────────────────────────────────────────────────────────────────────
// 測試專用建構器與 bezier 數值 helper
// ─────────────────────────────────────────────────────────────────────────

function makeResult(paths: DielinePath[], texts: DielineText[] = []): GenerateResult {
  return { paths, texts, bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } };
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

type BezierSeg = Extract<Segment, { kind: 'bezier' }>;

/** 三次貝茲在參數 t 的座標（標準 De Casteljau 展開式）。 */
function bezierPointAt(b: BezierSeg, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const x = mt ** 3 * b.x1 + 3 * mt ** 2 * t * b.c1x + 3 * mt * t ** 2 * b.c2x + t ** 3 * b.x2;
  const y = mt ** 3 * b.y1 + 3 * mt ** 2 * t * b.c1y + 3 * mt * t ** 2 * b.c2y + t ** 3 * b.y2;
  return { x, y };
}

/** (px,py) 到 bezier 曲線的最近距離——密集取樣近似（500 段遠細於 0.1mm 弦高容差，不會誤判邊界）。 */
function nearestDistanceToBezier(b: BezierSeg, px: number, py: number): number {
  const samples = 500;
  let min = Infinity;
  for (let i = 0; i <= samples; i++) {
    const p = bezierPointAt(b, i / samples);
    min = Math.min(min, Math.hypot(p.x - px, p.y - py));
  }
  return min;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1 測試案例（spec 逐項）
// ─────────────────────────────────────────────────────────────────────────

describe('toDxfDocument', () => {
  it('1. line×1（cut）→ ENTITIES 恰 1 個 LINE、layer=CUT、10/20/30/11/21/31 值正確（含 Z，F1）', () => {
    const result = makeResult([{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 1, y1: 2, x2: 3, y2: 4 }] }]);
    const dxf = toDxfDocument(result);
    const parsed = parseDxf(dxf);
    const lines = parsed.entities.filter((e) => e.type === 'LINE');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.layer).toBe('CUT');
    expect(Number(lines[0]!.codes[10]![0])).toBeCloseTo(1, 3);
    expect(Number(lines[0]!.codes[20]![0])).toBeCloseTo(2, 3);
    expect(Number(lines[0]!.codes[30]![0])).toBeCloseTo(0, 3);
    expect(Number(lines[0]!.codes[11]![0])).toBeCloseTo(3, 3);
    expect(Number(lines[0]!.codes[21]![0])).toBeCloseTo(4, 3);
    expect(Number(lines[0]!.codes[31]![0])).toBeCloseTo(0, 3);
    // 直接斷言原始文字（不經 parseDxf helper）：鎖住 30/31 的實際 group code 序與值，
    // 防止「解析器容忍缺欄位」把漏寫 Z 的迴歸悄悄放過（F1）。
    expect(dxf).toContain('0\nLINE\n8\nCUT\n10\n1\n20\n2\n30\n0\n11\n3\n21\n4\n31\n0');
  });

  it('2. arc ccw=false（0°→90°）→ ARC 50=0、51=90，圓心含 Z=0（30，F1）', () => {
    const result = makeResult([
      { id: 'p-0', type: 'cut', segments: [{ kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: degToRad(0), endAngle: degToRad(90), ccw: false }] },
    ]);
    const parsed = parseDxf(toDxfDocument(result));
    const arcs = parsed.entities.filter((e) => e.type === 'ARC');
    expect(arcs).toHaveLength(1);
    expect(Number(arcs[0]!.codes[30]![0])).toBeCloseTo(0, 3);
    expect(Number(arcs[0]!.codes[50]![0])).toBeCloseTo(0, 3);
    expect(Number(arcs[0]!.codes[51]![0])).toBeCloseTo(90, 3);
  });

  it('3. arc ccw=true（90°→0°，即順時針掃）→ 輸出 50=0、51=90（swap 後，方向語意測試）', () => {
    const result = makeResult([
      { id: 'p-0', type: 'cut', segments: [{ kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: degToRad(90), endAngle: degToRad(0), ccw: true }] },
    ]);
    const parsed = parseDxf(toDxfDocument(result));
    const arcs = parsed.entities.filter((e) => e.type === 'ARC');
    expect(arcs).toHaveLength(1);
    expect(Number(arcs[0]!.codes[50]![0])).toBeCloseTo(0, 3);
    expect(Number(arcs[0]!.codes[51]![0])).toBeCloseTo(90, 3);
  });

  it('arc ccw=false 跨 0° 環繞（350°→10°）→ ARC 50=350、51=10（防「排序後輸出」誤實作：min/max 排序在跨圈時會判反方向，F2）', () => {
    const result = makeResult([
      { id: 'p-0', type: 'cut', segments: [{ kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: degToRad(350), endAngle: degToRad(10), ccw: false }] },
    ]);
    const parsed = parseDxf(toDxfDocument(result));
    const arcs = parsed.entities.filter((e) => e.type === 'ARC');
    expect(arcs).toHaveLength(1);
    expect(Number(arcs[0]!.codes[50]![0])).toBeCloseTo(350, 3);
    expect(Number(arcs[0]!.codes[51]![0])).toBeCloseTo(10, 3);
  });

  it('arc ccw=true 跨 0° 環繞（10°→350°，順時針掃過 0°）→ swap 後 50=350、51=10（與上一條互為同一物理弧段，F2）', () => {
    const result = makeResult([
      { id: 'p-0', type: 'cut', segments: [{ kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: degToRad(10), endAngle: degToRad(350), ccw: true }] },
    ]);
    const parsed = parseDxf(toDxfDocument(result));
    const arcs = parsed.entities.filter((e) => e.type === 'ARC');
    expect(arcs).toHaveLength(1);
    expect(Number(arcs[0]!.codes[50]![0])).toBeCloseTo(350, 3);
    expect(Number(arcs[0]!.codes[51]![0])).toBeCloseTo(10, 3);
  });

  it('4. bezier（r=1mm 圓角級曲率）→ POLYLINE＋VERTEX≥3＋SEQEND；頂點皆在原曲線 0.1mm 內、首尾＝端點、x 嚴格遞增、含 Z（F1/F3）', () => {
    const bezier: BezierSeg = { kind: 'bezier', x1: 0, y1: 0, c1x: 0, c1y: 0.55, c2x: 0.45, c2y: 1, x2: 1, y2: 1 };
    const result = makeResult([{ id: 'p-0', type: 'crease', segments: [bezier] }]);
    const dxf = toDxfDocument(result);
    const parsed = parseDxf(dxf);

    const polylines = parsed.entities.filter((e) => e.type === 'POLYLINE');
    const vertices = parsed.entities.filter((e) => e.type === 'VERTEX');
    const seqends = parsed.entities.filter((e) => e.type === 'SEQEND');

    expect(polylines).toHaveLength(1);
    expect(polylines[0]!.layer).toBe('CREASE');
    expect(vertices.length).toBeGreaterThanOrEqual(3);
    expect(seqends).toHaveLength(1);

    const first = vertices[0]!;
    const last = vertices[vertices.length - 1]!;
    expect(Number(first.codes[10]![0])).toBeCloseTo(bezier.x1, 3);
    expect(Number(first.codes[20]![0])).toBeCloseTo(bezier.y1, 3);
    expect(Number(last.codes[10]![0])).toBeCloseTo(bezier.x2, 3);
    expect(Number(last.codes[20]![0])).toBeCloseTo(bezier.y2, 3);

    // POLYLINE header 直接斷言原始文字（不經 parseDxf helper）：鎖住 66 之後、70 之前的
    // dummy elevation point 10/0 20/0 30/0 群組碼序（F1；parseDxf 的 codes map 不驗順序，
    // 只有原始字串比對能抓到「值對但位置插錯」這類迴歸）。
    expect(dxf).toContain('0\nPOLYLINE\n8\nCREASE\n66\n1\n10\n0\n20\n0\n30\n0\n70\n0');

    let prevX = -Infinity;
    for (const v of vertices) {
      const px = Number(v.codes[10]![0]);
      const py = Number(v.codes[20]![0]);
      expect(nearestDistanceToBezier(bezier, px, py)).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(Number(v.codes[30]![0])).toBeCloseTo(0, 3); // F1：VERTEX 含 Z
      expect(px).toBeGreaterThan(prevX); // F3：此 bezier 單調遞增，中間頂點不應重排/漏點
      prevX = px;
    }
  });

  it('5. dimension/annotation 線型＋texts → 完全不出現在 ENTITIES', () => {
    const result = makeResult(
      [
        { id: 'p-0', type: 'dimension', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-1', type: 'annotation', segments: [{ kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5 }] },
      ],
      [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    );
    const dxf = toDxfDocument(result);
    expect(parseDxf(dxf).entities).toHaveLength(0);
    expect(dxf).not.toContain('10mm');
  });

  it('6. LAYER table 恰 3 條（CUT/CREASE/HALFCUT，宣告序），62 色碼分別 7/3/2', () => {
    const dxf = toDxfDocument(makeResult([]));
    const parsed = parseDxf(dxf);
    expect(parsed.layers).toEqual(['CUT', 'CREASE', 'HALFCUT']);
    // parseDxf 回傳型別（供 T2 共用）只收 layer 名稱；62 色碼在此直接鎖原始文字的逐行結構，
    // 同時驗到 spec 骨架規定的 group code 順序（2/70/62/6）。
    expect(dxf).toContain('0\nLAYER\n2\nCUT\n70\n0\n62\n7\n6\nCONTINUOUS');
    expect(dxf).toContain('0\nLAYER\n2\nCREASE\n70\n0\n62\n3\n6\nCONTINUOUS');
    expect(dxf).toContain('0\nLAYER\n2\nHALFCUT\n70\n0\n62\n2\n6\nCONTINUOUS');
  });

  it('7. 檔案以 0/EOF 結尾、HEADER 有 $ACADVER=AC1009', () => {
    const dxf = toDxfDocument(makeResult([]));
    expect(dxf.endsWith('0\nEOF')).toBe(true);
    expect(dxf).toContain('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC');
  });

  it('DXF_LAYER_BY_LINETYPE 映射三層、不含 dimension/annotation/bleed', () => {
    expect(DXF_LAYER_BY_LINETYPE.cut).toBe('CUT');
    expect(DXF_LAYER_BY_LINETYPE.crease).toBe('CREASE');
    expect(DXF_LAYER_BY_LINETYPE.halfcut).toBe('HALFCUT');
    expect(DXF_LAYER_BY_LINETYPE.dimension).toBeUndefined();
    expect(DXF_LAYER_BY_LINETYPE.annotation).toBeUndefined();
    expect(DXF_LAYER_BY_LINETYPE.bleed).toBeUndefined();
  });

  // ── Step 5：盒型整合案例（RTE／telescope 互補覆蓋三圖層） ──

  it('RTE 預設參數：可解析、實體數 >0、無 NaN、cut/crease 出現、無 halfcut（RTE 不產生此線型）', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const dxf = toDxfDocument(result);
    expect(dxf).not.toContain('NaN');
    const parsed = parseDxf(dxf);
    expect(parsed.entities.length).toBeGreaterThan(0);
    const layersUsed = new Set(parsed.entities.map((e) => e.layer));
    expect(layersUsed.has('CUT')).toBe(true);
    expect(layersUsed.has('CREASE')).toBe(true);
    expect(layersUsed.has('HALFCUT')).toBe(false);
  });

  it('telescope 預設參數：可解析、實體數 >0、無 NaN、halfcut 進 HALFCUT 層', () => {
    const result = telescope.generate(resolveParams(telescope));
    const dxf = toDxfDocument(result);
    expect(dxf).not.toContain('NaN');
    const parsed = parseDxf(dxf);
    expect(parsed.entities.length).toBeGreaterThan(0);
    const layersUsed = new Set(parsed.entities.map((e) => e.layer));
    expect(layersUsed.has('HALFCUT')).toBe(true);
  });
});
