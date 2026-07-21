/**
 * 插底盒 fixture 驗證：對原刀模參考量測（committed reference JSON）逐特徵交叉比對，
 * 並驗證 SVG/DXF 匯出的決定性與結構有效性（兩次生成逐字元相同＋含 cut/crease 幾何）。
 */
import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { resolveParams } from '@/core/registry';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import type { GenerateResult } from '@/core/types';
import { toSvgDocument } from '@/export/svg';
import { toDxfDocument } from '@/export/dxf';
import reference from '../fixtures/tuck-top-snap-lock-reference.json';

type Line = Extract<Segment, { kind: 'line' }>;
const isLine = (s: Segment): s is Line => s.kind === 'line';

// 原刀模為名義幾何（無紙厚補償）→ fixture 一律 thickness:0 建構。
const r = (): GenerateResult => tuckTopSnapLock.generate(resolveParams(tuckTopSnapLock, { thickness: 0 }));

function horizontals(segs: Segment[], eps = 0.01): Line[] {
  return segs.filter(isLine).filter((s) => Math.abs(s.y1 - s.y2) < eps);
}
function segsTag(result: GenerateResult, type: string, tag: string): Segment[] {
  return result.paths.filter((p) => p.type === type && p.tags?.includes(tag)).flatMap((p) => p.segments);
}

type Feat = { observed: number; normalized: number; tol: number };
interface RefFeatures {
  panelWidths: { observed: number[]; normalized: number[]; tol: number };
  bodyDepth: Feat;
  glueWidth: Feat;
  tuckFoldWidth: Feat;
  tuckTipWidth: Feat;
  tuckDepth: Feat;
  dustFlapDepth: Feat;
  lockFlapDepth: Feat;
  lockTabWidth: Feat;
  lockReceiveWidth: Feat;
  lockReceiveDepth: Feat;
}
const F = reference.features as unknown as RefFeatures;

describe('tuckTopSnapLock fixture（對原刀模參考量測交叉比對）', () => {
  const result = r();

  it('reference JSON 自洽：|observed − normalized| ≤ tol（P4 對稱正規化除外）', () => {
    const skip = new Set(['panelWidths', 'dustFlapDepth']); // P4 正規化、dustFlap 採原刀模實測值
    type AnyFeat = { observed: number | number[]; normalized: number | number[]; tol: number };
    for (const [k, f] of Object.entries(reference.features as Record<string, AnyFeat>)) {
      if (skip.has(k) || typeof f.observed !== 'number' || typeof f.normalized !== 'number') continue;
      expect(Math.abs(f.observed - f.normalized), `${k}`).toBeLessThanOrEqual(f.tol);
    }
  });

  it('盒身：面板寬 / 盒身高 / 糊邊 命中 normalized', () => {
    const xs = result.paths
      .filter((p) => (p.type === 'cut' || p.type === 'crease') && p.tags?.includes('D'))
      .flatMap((p) => p.segments)
      .filter(isLine)
      .filter((s) => Math.abs(s.x1 - s.x2) < 0.01)
      .map((s) => s.x1)
      .sort((a, b) => a - b);
    const widths: number[] = [];
    for (let i = 1; i < xs.length; i++) widths.push(xs[i]! - xs[i - 1]!);
    F.panelWidths.normalized.forEach((w, i) => expect(widths[i]).toBeCloseTo(w, 1));

    const dVert = segsTag(result, 'crease', 'D').filter(isLine).find((s) => Math.abs(s.x1 - s.x2) < 0.01)!;
    expect(Math.abs(dVert.y2 - dVert.y1)).toBeCloseTo(F.bodyDepth.normalized, 1);

    const glueXs = segsTag(result, 'cut', 'glueSize').filter(isLine).flatMap((s) => [s.x1, s.x2]);
    expect(-Math.min(...glueXs)).toBeCloseTo(F.glueWidth.normalized, 1);
  });

  it('頂部插舌 + 防塵翼：fold 寬 / 尖端 / 深度 / 防塵翼深命中 normalized', () => {
    const foldCrease = horizontals(segsTag(result, 'crease', 'W'))
      .filter((s) => s.y1 < -40)
      .sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1))[0]!;
    expect(Math.abs(foldCrease.x2 - foldCrease.x1)).toBeCloseTo(F.tuckFoldWidth.normalized, 1);
    const tuckH = horizontals(segsTag(result, 'cut', 'tuckDepth'));
    const tip = tuckH.reduce((a, b) => (b.y1 < a.y1 ? b : a));
    expect(Math.abs(tip.x2 - tip.x1)).toBeCloseTo(F.tuckTipWidth.normalized, 1);
    expect(foldCrease.y1 - tip.y1).toBeCloseTo(F.tuckDepth.normalized, 1);
    const dfTip = Math.min(...horizontals(segsTag(result, 'cut', 'dustFlapDepth')).map((s) => s.y1));
    expect(-dfTip).toBeCloseTo(F.dustFlapDepth.normalized, 1);
  });

  it('snap-lock 底：底片深 / 尖端寬 / 缺口寬 / 缺口內縮命中 normalized', () => {
    const yBot = F.bodyDepth.normalized;
    const allCut = result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments).filter(isLine);
    const deepest = Math.max(...allCut.flatMap((s) => [s.y1, s.y2]));
    expect(deepest - yBot).toBeCloseTo(F.lockFlapDepth.normalized, 1);
    const tabTip = horizontals(segsTag(result, 'cut', 'lockTabWidth')).reduce((a, b) => (b.y1 > a.y1 ? b : a));
    expect(Math.abs(tabTip.x2 - tabTip.x1)).toBeCloseTo(F.lockTabWidth.normalized, 1);
    const notch = horizontals(segsTag(result, 'cut', 'lockReceiveWidth')).find(
      (s) => Math.abs(s.y1 - (yBot + F.lockFlapDepth.normalized - F.lockReceiveDepth.normalized)) < 1,
    )!;
    expect(Math.abs(notch.x2 - notch.x1)).toBeCloseTo(F.lockReceiveWidth.normalized, 1);
    expect(deepest - notch.y1).toBeCloseTo(F.lockReceiveDepth.normalized, 1);
  });

  it('匯出 SVG/DXF 決定性穩定（兩次 generate 逐字元相同）且結構有效', () => {
    const a = r();
    const b = r();
    const svgA = toSvgDocument(a);
    const svgB = toSvgDocument(b);
    const dxfA = toDxfDocument(a);
    const dxfB = toDxfDocument(b);
    expect(svgA).toBe(svgB);
    expect(dxfA).toBe(dxfB);
    expect(svgA).toContain('<svg');
    expect(svgA).not.toContain('NaN');
    expect(dxfA).not.toContain('NaN');
    // 至少含 cut 與 crease 幾何
    expect(a.paths.some((p) => p.type === 'cut')).toBe(true);
    expect(a.paths.some((p) => p.type === 'crease')).toBe(true);
  });
});
