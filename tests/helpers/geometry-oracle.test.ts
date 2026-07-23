import { describe, expect, it } from 'vitest';
import type { Segment } from '@/core/geometry';
import { flattenBezier } from '@/core/geometry';
import type { Pt } from '@/fold/types';
import { flattenBezierAdaptive, sampleBezierArcLength } from './geometry-oracle';

type BezierSegment = Extract<Segment, { kind: 'bezier' }>;

/** 三次貝茲 Bernstein 公式直接求值——獨立於本檔任何實作，當密集抽樣的真值來源。 */
function evalBezier(b: BezierSegment, t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: mt ** 3 * b.x1 + 3 * mt ** 2 * t * b.c1x + 3 * mt * t ** 2 * b.c2x + t ** 3 * b.x2,
    y: mt ** 3 * b.y1 + 3 * mt ** 2 * t * b.c1y + 3 * mt * t ** 2 * b.c2y + t ** 3 * b.y2,
  };
}

/** 密集抽樣真實曲線（uniform-t，樣本數夠多時累積弦長可當弧長真值近似）。 */
function denseSample(b: BezierSegment, samples: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) points.push(evalBezier(b, i / samples));
  return points;
}

function cumulativeLengths(points: { x: number; y: number }[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(cur.x - prev.x, cur.y - prev.y));
  }
  return cum;
}

/** 點到有限線段的最短距離（獨立小函式，只給測試驗證用，不呼叫被測模組任何東西）。 */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (len * len)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

describe('sampleBezierArcLength — 對稱 S 曲線（中點弦高判準的盲區反例，比照 imposition-anchor.test.ts）', () => {
  // P0/P3 定弦（弦長僅 0.05mm）；P1/P2 關於弦中點反對稱（y 分量正負相反、x 分量對稱）——
  // de Casteljau 中點 B(0.5)=(P0+3P1+3P2+P3)/8 恰好落回弦上，任何只採樣曲線中點的判準都會
  // 被騙過，誤判「整條曲線＝1 條直線」，見 imposition-anchor.test.ts 該反例的完整推導。
  const chordLen = 0.05;
  const bulge = 100;
  const sCurve: BezierSegment = {
    kind: 'bezier',
    x1: 0,
    y1: 0,
    c1x: 0,
    c1y: bulge,
    c2x: chordLen,
    c2y: -bulge,
    x2: chordLen,
    y2: 0,
  };

  it('production flattenBezier（中點弦高判準）對這條 S 型曲線即使給緊容差仍回傳單一線段，密集抽樣垂距顯示實際偏離遠超合理容差', () => {
    const productionLines = flattenBezier(sCurve, 1e-4, 0.1);
    expect(productionLines).toHaveLength(1);

    const dense = denseSample(sCurve, 5000);
    let maxDeviation = 0;
    for (const p of dense) {
      const d = distToSegment(p.x, p.y, productionLines[0]!.x1, productionLines[0]!.y1, productionLines[0]!.x2, productionLines[0]!.y2);
      if (d > maxDeviation) maxDeviation = d;
    }
    // 真實偏離量級達數十 mm（實際 ~28.87mm），遠超任何合理的 mm 級容差——
    // 不試圖觀察 production 私有的 MAX_FLATTEN_DEPTH，改用行為
    // （對真實曲線的垂距）驗證它的折線失真。
    expect(maxDeviation).toBeGreaterThan(1);
  });

  it('sampleBezierArcLength 用獨立判準（控制多邊形到有限弦段距離）不受這個盲區影響，回傳的 32 點確實落在真實曲線上、且弧長間距均勻', () => {
    const points = sampleBezierArcLength(sCurve, 32);
    expect(points).toHaveLength(32);
    expect(points[0]).toMatchObject({ x: 0, y: 0 });
    expect(points[31]).toMatchObject({ x: chordLen, y: 0 });

    const dense = denseSample(sCurve, 20000);
    const cum = cumulativeLengths(dense);
    const totalLen = cum[cum.length - 1]!;

    // 對每個輸出點找密集抽樣中最近的參考點，記錄其（真值）累積弧長位置。
    let maxOnCurveDeviation = 0;
    const impliedArcLen: number[] = [];
    for (const p of points) {
      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < dense.length; i++) {
        const ref = dense[i]!;
        const d = Math.hypot(p.x - ref.x, p.y - ref.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      if (nearestDist > maxOnCurveDeviation) maxOnCurveDeviation = nearestDist;
      impliedArcLen.push(cum[nearestIdx]!);
    }

    // 斷言 1：每個輸出點都真的在曲線上（不是憑空生成的座標）——即使曲線本身把 0.05mm 的
    // 弦壓縮成上百 mm 的真實弧長，這裡驗的是「點是否落在曲線上」，不是「32 點是否稠密覆蓋
    // 曲線」（後者對這條病態曲線本來就不該用歐氏最近點密度去驗）。
    expect(maxOnCurveDeviation).toBeLessThan(0.05);

    // 斷言 2：弧長位置均勻分布（等弧長取樣的核心承諾）——用真值累積弧長反查出的位置序列，
    // 相鄰間距應接近 totalLen/31，容許取樣噪音（dense=20000 本身也有離散化誤差）給 10% 寬容。
    const expectedGap = totalLen / 31;
    for (let i = 1; i < impliedArcLen.length; i++) {
      const gap = impliedArcLen[i]! - impliedArcLen[i - 1]!;
      expect(gap).toBeGreaterThan(expectedGap * 0.9);
      expect(gap).toBeLessThan(expectedGap * 1.1);
    }
  });
});

describe('sampleBezierArcLength — 一般平滑曲線（正例：象限弧近似）', () => {
  it('回傳 32 點、首尾對齊曲線端點、弧長間距均勻、點落在真實曲線上', () => {
    const R = 20;
    const K = 0.5522847498 * R; // 三次貝茲近似 90° 圓弧的標準 kappa 常數
    const quarterArc: BezierSegment = { kind: 'bezier', x1: R, y1: 0, c1x: R, c1y: K, c2x: K, c2y: R, x2: 0, y2: R };

    const points = sampleBezierArcLength(quarterArc, 32);
    expect(points).toHaveLength(32);
    expect(points[0]).toMatchObject({ x: R, y: 0 });
    expect(points[31]).toMatchObject({ x: 0, y: R });

    const dense = denseSample(quarterArc, 20000);
    const cum = cumulativeLengths(dense);
    const totalLen = cum[cum.length - 1]!;
    // 整體幾何量級檢查：近似 1/4 圓弧長理論值 R*π/2。
    expect(totalLen).toBeCloseTo((R * Math.PI) / 2, 1);

    let maxOnCurveDeviation = 0;
    const impliedArcLen: number[] = [];
    for (const p of points) {
      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < dense.length; i++) {
        const ref = dense[i]!;
        const d = Math.hypot(p.x - ref.x, p.y - ref.y);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      if (nearestDist > maxOnCurveDeviation) maxOnCurveDeviation = nearestDist;
      impliedArcLen.push(cum[nearestIdx]!);
    }
    expect(maxOnCurveDeviation).toBeLessThan(0.01);

    const expectedGap = totalLen / 31;
    for (let i = 1; i < impliedArcLen.length; i++) {
      const gap = impliedArcLen[i]! - impliedArcLen[i - 1]!;
      expect(gap).toBeGreaterThan(expectedGap * 0.9);
      expect(gap).toBeLessThan(expectedGap * 1.1);
    }
  });
});

describe('sampleBezierArcLength — 大尺度平滑曲線需要遠超 256 段自適應細分時，最終取樣不得經過獨立粗 LUT 損失局部曲率', () => {
  /** 對照組實作（僅供這個測試比對用，不是被測模組的一部分）：先把精確折線壓縮成固定
   * 257 點 LUT，再從 LUT 展開出 n 個等弧長點——這是一個會損失局部曲率的作法；
   * `sampleBezierArcLength` 不經過這個中介 LUT，直接從精確折線本身取樣。 */
  function cumulativeLengthsOf(points: Pt[]): number[] {
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const cur = points[i]!;
      cum.push(cum[i - 1]! + Math.hypot(cur.x - prev.x, cur.y - prev.y));
    }
    return cum;
  }
  function resampleViaFixedLut(points: Pt[], count: number): Pt[] {
    const cum = cumulativeLengthsOf(points);
    const total = cum[cum.length - 1]!;
    const result: Pt[] = [];
    for (let i = 0; i < count; i++) {
      const target = total <= 0 ? 0 : (i / (count - 1)) * total;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cum[mid]! < target) lo = mid + 1;
        else hi = mid;
      }
      const j = Math.max(1, lo);
      const segStart = cum[j - 1]!;
      const segEnd = cum[j]!;
      const segFrac = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
      const p0 = points[j - 1]!;
      const p1 = points[j]!;
      result.push({ x: p0.x + segFrac * (p1.x - p0.x), y: p0.y + segFrac * (p1.y - p0.y) });
    }
    return result;
  }
  function sampleViaFixed257Lut(curve: BezierSegment, n: number): Pt[] {
    const lines = flattenBezierAdaptive(curve);
    const accuratePolyline: Pt[] = [{ x: lines[0]!.x1, y: lines[0]!.y1 }];
    for (const line of lines) accuratePolyline.push({ x: line.x2, y: line.y2 });
    const lut = resampleViaFixedLut(accuratePolyline, 257);
    return resampleViaFixedLut(lut, n);
  }
  function maxDeviationFromDense(points: Pt[], dense: { x: number; y: number }[]): number {
    let maxDev = 0;
    for (const p of points) {
      let nearest = Infinity;
      for (const ref of dense) {
        const d = Math.hypot(p.x - ref.x, p.y - ref.y);
        if (d < nearest) nearest = d;
      }
      if (nearest > maxDev) maxDev = nearest;
    }
    return maxDev;
  }

  it('R=20000 的九十度圓弧近似（跟下方正例同一形狀家族，純粹放大尺度）：自適應細分需要遠超 256 段才能滿足 chordTol=1e-4，直接取樣維持在合理容差內；若改用固定 257 點 LUT 中介，偏離會明顯更大', () => {
    const R = 20000;
    const K = 0.5522847498 * R;
    const curve: BezierSegment = { kind: 'bezier', x1: R, y1: 0, c1x: R, c1y: K, c2x: K, c2y: R, x2: 0, y2: R };

    const dense = denseSample(curve, 500000);

    const fixedPoints = sampleBezierArcLength(curve, 32);
    expect(fixedPoints).toHaveLength(32);
    const fixedDeviation = maxDeviationFromDense(fixedPoints, dense);

    const fixedLutPoints = sampleViaFixed257Lut(curve, 32);
    const fixedLutDeviation = maxDeviationFromDense(fixedLutPoints, dense);

    // 直接從精確折線取樣，32 點對真實曲線的偏離在合理容差內。
    expect(fixedDeviation).toBeLessThan(0.05);
    // 對比：「先壓縮成 257 點 LUT 再展開」的做法，在同一條曲線上偏離明顯更大、
    // 超出同一容差——證明直接取樣捕捉局部曲率的能力確實較佳。
    expect(fixedLutDeviation).toBeGreaterThan(0.05);
    expect(fixedLutDeviation).toBeGreaterThan(fixedDeviation * 2);
  });
});

describe('flattenBezierAdaptive — 深度上限命中時直接拋錯，不靜默接受可能違反誤差界的葉節點', () => {
  const curve: Extract<Segment, { kind: 'bezier' }> = {
    kind: 'bezier',
    x1: 0,
    y1: 0,
    c1x: 1,
    c1y: 1,
    c2x: 2,
    c2y: -1,
    x2: 3,
    y2: 0,
  };

  it('不可能滿足的容差（chordTol=0）＋極小深度上限（maxDepth=2）→ 明確拋錯（訊息含「深度上限」）', () => {
    expect(() => flattenBezierAdaptive(curve, 0, 100, 0, 2)).toThrow(/深度上限/);
  });

  it('同一條曲線用 sampleBezierArcLength 實際使用的預設容差／深度上限→不拋錯，正常路徑不受這條防線影響', () => {
    expect(() => flattenBezierAdaptive(curve)).not.toThrow();
  });
});
