/**
 * 三角盒 fixture 驗證：對三個參考尺寸的原刀模量測值（committed reference JSON）逐樣本、逐特徵
 * 交叉比對——① reference 自洽（observed↔normalized 在容差內）② generate(sample.params) 的
 * 幾何逐樣本鎖定外翼四遠端頂點 P3/P4/Q1/Q2 與端封/插槽/剖面尺寸到 normalized（防非預設尺寸
 * 的外翼縮放公式回歸靜默漂移）③ SVG/DXF 匯出決定性（以生成決定性驗證匯出穩定·不落 byte 基線檔）。
 */
import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { resolveParams } from '@/core/registry';
import { triangularTube } from '@/boxes/triangular-tube';
import type { GenerateResult } from '@/core/types';
import { toSvgDocument } from '@/export/svg';
import { toDxfDocument } from '@/export/dxf';
import reference from '../fixtures/triangular-tube-reference.json';

type Line = Extract<Segment, { kind: 'line' }>;
const isLine = (s: Segment): s is Line => s.kind === 'line';
const len = (s: Line): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

const r = (o?: Record<string, number>): GenerateResult => triangularTube.generate(resolveParams(triangularTube, o));
function segsTag(result: GenerateResult, type: string, tag: string): Segment[] {
  return result.paths.filter((p) => p.type === type && p.tags?.includes(tag)).flatMap((p) => p.segments);
}
function horizontals(segs: Segment[], eps = 0.01): Line[] {
  return segs.filter(isLine).filter((s) => Math.abs(s.y1 - s.y2) < eps);
}
function endpointsOf(segs: Segment[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const s of segs) if (s.kind === 'line' || s.kind === 'bezier') out.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  return out;
}
function hasPoint(pts: { x: number; y: number }[], x: number, y: number, tol: number): boolean {
  return pts.some((p) => Math.hypot(p.x - x, p.y - y) < tol);
}

interface Sample {
  params: { edgeA: number; tubeLength: number };
  observed: Record<string, number | number[]>;
  normalized: Record<string, number | number[]>;
  wing: Record<'P3' | 'P4' | 'Q1' | 'Q2', { observed: [number, number]; normalized: [number, number] }>;
}
const SAMPLES = reference.samples as unknown as Record<'S1' | 'S2' | 'S3', Sample>;
const SCALAR_TOL = reference.scalarTol as number;
const WING_TOL = reference.wingTol as number;
const GEN_TOL = 0.05; // generate() 對 normalized 錨（公式殘差 ~0·防漂移硬鎖）

describe('triangularTube fixture（三個參考尺寸的幾何比對）', () => {
  // ① reference 自洽：|observed − normalized| ≤ 容差（scalar/wing 各自）
  for (const [name, s] of Object.entries(SAMPLES)) {
    it(`${name} reference 自洽：observed↔normalized 在容差內`, () => {
      for (const key of Object.keys(s.normalized)) {
        const o = s.observed[key];
        const n = s.normalized[key];
        if (Array.isArray(o) && Array.isArray(n)) {
          o.forEach((v, i) => expect(Math.abs(v - n[i]!), `${name}.${key}[${i}]`).toBeLessThanOrEqual(SCALAR_TOL));
        } else if (typeof o === 'number' && typeof n === 'number') {
          expect(Math.abs(o - n), `${name}.${key}`).toBeLessThanOrEqual(SCALAR_TOL);
        }
      }
      for (const k of ['P3', 'P4', 'Q1', 'Q2'] as const) {
        const w = s.wing[k];
        expect(Math.hypot(w.observed[0] - w.normalized[0], w.observed[1] - w.normalized[1]), `${name}.wing.${k}`).toBeLessThanOrEqual(WING_TOL);
      }
    });
  }

  // ② generate(sample.params) 逐樣本鎖定 normalized（剖面/插槽/端封 + 外翼四點）
  for (const [name, s] of Object.entries(SAMPLES)) {
    it(`${name} generate 命中 normalized：剖面/端摺線/插槽/端封三角 + 外翼 P3/P4/Q1/Q2`, () => {
      const result = r(s.params);
      const nrm = s.normalized as Record<string, number | number[]>;
      const fw = nrm.faceWidths as number[];
      // 剖面
      const abY = horizontals(segsTag(result, 'crease', 'abCrease'))[0]!.y1;
      const bcY = horizontals(segsTag(result, 'crease', 'bcCrease'))[0]!.y1;
      const cdY = horizontals(segsTag(result, 'crease', 'cdCrease'))[0]!.y1;
      expect(abY).toBeCloseTo(fw[0]!, 1);
      expect(bcY - abY).toBeCloseTo(fw[1]!, 1);
      expect(cdY - bcY).toBeCloseTo(fw[2]!, 1);
      // 管長
      expect(len(horizontals(segsTag(result, 'cut', 'faceFree'))[0]!)).toBeCloseTo(nrm.tubeLength as number, 1);
      // 端摺線 abEndCrease（兩端）
      for (const seg of horizontals(segsTag(result, 'crease', 'abCrease'))) expect(len(seg)).toBeCloseTo(nrm.abEndCrease as number, 1);
      // 插槽 slotWidth
      const slot = horizontals(segsTag(result, 'cut', 'abSlot')).reduce((a, b) => (len(b) > len(a) ? b : a));
      expect(len(slot)).toBeCloseTo(nrm.slotWidth as number, 1);
      // 端封等邊 triangleSide
      for (const seg of segsTag(result, 'crease', 'endTriangle').filter(isLine)) expect(len(seg)).toBeCloseTo(nrm.triangleSide as number, 1);
      // centralZoneWidth（兩肩 x 距）
      const rootXs = horizontals(segsTag(result, 'crease', 'tabRootCrease')).filter(isLine).flatMap((seg) => [seg.x1, seg.x2]);
      expect(Math.max(...rootXs) - Math.min(...rootXs)).toBeCloseTo(nrm.centralZoneWidth as number, 1);
      // 穿入比例
      expect(len(slot) / (nrm.centralZoneWidth as number)).toBeCloseTo(nrm.insertionRatio as number, 2);
      // 外翼四遠端頂點（右端封閉式·對 normalized 錨 ±GEN_TOL·左端由鏡射另驗於單元測試）
      const wingPts = endpointsOf(segsTag(result, 'cut', 'endWing'));
      for (const k of ['P3', 'P4', 'Q1', 'Q2'] as const) {
        const [x, y] = s.wing[k].normalized;
        expect(hasPoint(wingPts, x, y, GEN_TOL), `${name} 外翼 ${k}=(${x},${y}) 未命中`).toBe(true);
      }
    });
  }

  it('匯出 SVG/DXF 決定性穩定（兩次 generate 逐字元相同）且結構有效', () => {
    const a = r();
    const b = r();
    expect(toSvgDocument(a)).toBe(toSvgDocument(b));
    expect(toDxfDocument(a)).toBe(toDxfDocument(b));
    expect(toSvgDocument(a)).toContain('<svg');
    expect(toSvgDocument(a)).not.toContain('NaN');
    expect(toDxfDocument(a)).not.toContain('NaN');
    expect(a.paths.some((p) => p.type === 'cut')).toBe(true);
    expect(a.paths.some((p) => p.type === 'crease')).toBe(true);
  });
});
