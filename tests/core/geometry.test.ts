import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { segmentBounds, segmentsBounds, flattenBezier, normalizeSegments, hasNaN } from '@/core/geometry';

// ── 測試專用工具：獨立於被測模組的 de Casteljau 求值與點-折線距離 ──
// （brief 要求弦高誤差驗證要「真的對曲線取樣」，不可依賴被測模組的內部實作）
type BezierLike = { x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number };
type LineLike = { x1: number; y1: number; x2: number; y2: number };

function deCasteljauPoint(b: BezierLike, t: number): { x: number; y: number } {
  const mt = 1 - t;
  const x = mt ** 3 * b.x1 + 3 * mt ** 2 * t * b.c1x + 3 * mt * t ** 2 * b.c2x + t ** 3 * b.x2;
  const y = mt ** 3 * b.y1 + 3 * mt ** 2 * t * b.c1y + 3 * mt * t ** 2 * b.c2y + t ** 3 * b.y2;
  return { x, y };
}

function pointToSegmentDistance(px: number, py: number, seg: LineLike): number {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - seg.x1, py - seg.y1);
  let t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = seg.x1 + t * dx;
  const cy = seg.y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function pointToPolylineDistance(px: number, py: number, lines: LineLike[]): number {
  return Math.min(...lines.map((l) => pointToSegmentDistance(px, py, l)));
}

describe('segmentBounds', () => {
  it('line 的 bounds 是端點包絡', () => {
    expect(segmentBounds({ kind: 'line', x1: 10, y1: -5, x2: 3, y2: 8 })).toEqual({
      minX: 3,
      maxX: 10,
      minY: -5,
      maxY: 8,
    });
  });

  it('跨 0° 的 arc 要含最右極值點 (cx+r)', () => {
    // 從 -45° 到 45°、半徑 10、圓心 (0,0)：maxX 必須是 10（0° 極值），不是端點的 7.07
    const b = segmentBounds({
      kind: 'arc',
      cx: 0,
      cy: 0,
      r: 10,
      startAngle: -Math.PI / 4,
      endAngle: Math.PI / 4,
      ccw: false,
    });
    expect(b.maxX).toBeCloseTo(10, 5);
  });

  it('arc 完整圓（start/end 差 2π）四個極值點都含', () => {
    const b = segmentBounds({ kind: 'arc', cx: 5, cy: -3, r: 4, startAngle: 0, endAngle: 2 * Math.PI, ccw: false });
    expect(b.minX).toBeCloseTo(1, 5); // cx - r
    expect(b.maxX).toBeCloseTo(9, 5); // cx + r
    expect(b.minY).toBeCloseTo(-7, 5); // cy - r
    expect(b.maxY).toBeCloseTo(1, 5); // cy + r
  });

  it('ccw 方向不同，同一組 start/end 角度涵蓋的極值不同', () => {
    // 45°→135°：ccw=false 走短弧（經 90°），ccw=true 走長弧（經 0°/270°/180°）
    const base = { cx: 0, cy: 0, r: 10, startAngle: Math.PI / 4, endAngle: (3 * Math.PI) / 4 } as const;
    const minorArc = segmentBounds({ kind: 'arc', ...base, ccw: false });
    const majorArc = segmentBounds({ kind: 'arc', ...base, ccw: true });

    // 短弧：含 90° 極值 → maxY = r；不含 180° → minX 只到端點 135° 的 -7.07
    expect(minorArc.maxY).toBeCloseTo(10, 5);
    expect(minorArc.minX).toBeCloseTo(Math.cos((3 * Math.PI) / 4) * 10, 5);

    // 長弧：含 0°/180°/270° 極值 → maxX=10, minX=-10, minY=-10
    expect(majorArc.maxX).toBeCloseTo(10, 5);
    expect(majorArc.minX).toBeCloseTo(-10, 5);
    expect(majorArc.minY).toBeCloseTo(-10, 5);
  });

  it('bezier 的 bounds 用控制多邊形包絡（凸包性質，保證涵蓋真實曲線）', () => {
    const b = segmentBounds({ kind: 'bezier', x1: 0, y1: 0, c1x: -2, c1y: 5, c2x: 12, c2y: 5, x2: 10, y2: 0 });
    expect(b).toEqual({ minX: -2, maxX: 12, minY: 0, maxY: 5 });
  });
});

describe('segmentsBounds', () => {
  it('多個 segment 的 bounds 是各自 bounds 的聯集包絡', () => {
    const list: Segment[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 2, y2: 2 },
      { kind: 'line', x1: -3, y1: 1, x2: 1, y2: 5 },
    ];
    expect(segmentsBounds(list)).toEqual({ minX: -3, maxX: 2, minY: 0, maxY: 5 });
  });

  it('空陣列 bounds 回 {0,0,0,0}', () => {
    expect(segmentsBounds([])).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });
});

describe('flattenBezier', () => {
  it('離散結果對曲線的弦高誤差 ≤0.1mm', () => {
    const bez = { kind: 'bezier' as const, x1: 0, y1: 0, c1x: 0, c1y: 10, c2x: 10, c2y: 10, x2: 10, y2: 0 };
    const lines = flattenBezier(bez);
    // 抽樣曲線上 100 點，每點到折線的最短距離 ≤ 0.1
    // （測試內用 de Casteljau 求值函式取樣——實作於測試檔內，不依賴被測模組的內部）
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.x1).toBe(0);
    expect(lines[lines.length - 1]!.x2).toBe(10);

    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      const p = deCasteljauPoint(bez, t);
      const dist = pointToPolylineDistance(p.x, p.y, lines);
      expect(dist).toBeLessThanOrEqual(0.1 + 1e-6);
    }
  });

  it('近乎直線的短曲線只產生 1-2 段', () => {
    // 控制點與端點皆在同一水平線上（y 全 0）→ 弦高恆為 0，長度 4mm < maxSegLen(5)
    const straight = { kind: 'bezier' as const, x1: 0, y1: 0, c1x: 4 / 3, c1y: 0, c2x: 8 / 3, c2y: 0, x2: 4, y2: 0 };
    const lines = flattenBezier(straight);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('maxSegLen=5 上限生效：長且平緩的曲線仍被切成多段', () => {
    // 控制點只有 0.05mm 的微小凸起（弦高遠低於 0.1 容差），但總長 20mm > maxSegLen(5)
    const gentle = {
      kind: 'bezier' as const,
      x1: 0,
      y1: 0,
      c1x: 20 / 3,
      c1y: 0.05,
      c2x: 40 / 3,
      c2y: 0.05,
      x2: 20,
      y2: 0,
    };
    const lines = flattenBezier(gentle);
    expect(lines.length).toBeGreaterThanOrEqual(4); // 20mm / maxSegLen(5) 至少切 4 段
    for (const seg of lines) {
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
      expect(len).toBeLessThanOrEqual(5 + 1e-6);
    }
  });
});

describe('normalizeSegments', () => {
  it('同幾何不同順序/方向 → 相同 normalized 輸出', () => {
    const a = [{ kind: 'line' as const, x1: 0, y1: 0, x2: 5, y2: 5 }];
    const b = [{ kind: 'line' as const, x1: 5, y1: 5, x2: 0, y2: 0 }]; // 反向
    expect(normalizeSegments(a)).toEqual(normalizeSegments(b));
  });

  it('精度化：0.014 與 0.006 都量化為 0.01', () => {
    const a = [{ kind: 'line' as const, x1: 0.014, y1: 0, x2: 5, y2: 5 }];
    const b = [{ kind: 'line' as const, x1: 0.006, y1: 0, x2: 5, y2: 5 }];
    expect(normalizeSegments(a)).toEqual(normalizeSegments(b));
    expect(normalizeSegments(a)[0]).toContain('0.01');
  });
});

describe('hasNaN', () => {
  it('偵測任一欄位 NaN', () => {
    expect(hasNaN([{ kind: 'line', x1: NaN, y1: 0, x2: 1, y2: 1 }])).toBe(true);
  });

  it('無 NaN 時回傳 false（涵蓋 line/arc/bezier 三種 kind）', () => {
    const list: Segment[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 },
      { kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: 1, ccw: false },
      { kind: 'bezier', x1: 0, y1: 0, c1x: 1, c1y: 1, c2x: 2, c2y: 2, x2: 3, y2: 3 },
    ];
    expect(hasNaN(list)).toBe(false);
  });

  it('偵測 arc 或 bezier 欄位中的 NaN', () => {
    expect(hasNaN([{ kind: 'arc', cx: 0, cy: NaN, r: 5, startAngle: 0, endAngle: 1, ccw: false }])).toBe(true);
    expect(
      hasNaN([{ kind: 'bezier', x1: 0, y1: 0, c1x: NaN, c1y: 0, c2x: 0, c2y: 0, x2: 0, y2: 0 }]),
    ).toBe(true);
  });
});
