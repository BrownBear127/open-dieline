import { describe, it, expect } from 'vitest';
import { PathBuilder, segmentsToSvgD } from '@/core/path';

describe('PathBuilder', () => {
  it('lineTo 產生 line segment', () => {
    const segs = new PathBuilder().moveTo(0, 0).lineTo(10, 0).segments();
    expect(segs).toEqual([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }]);
  });

  it('arcTo 端點語法轉 center 參數化：90° 圓角', () => {
    // 從 (0,-5) 以 r=5、sweep=1 到 (5,0)：圓心應為 (0+5? → 依幾何 (5,-5)…) 驗證圓心到兩端點距離皆 r 且掃過 90°
    const segs = new PathBuilder().moveTo(0, -5).arcTo(5, 1, 5, 0).segments();
    const a = segs[0]!;
    expect(a.kind).toBe('arc');
    if (a.kind === 'arc') {
      expect(Math.hypot(a.cx - 0, a.cy - -5)).toBeCloseTo(5, 6);
      expect(Math.hypot(a.cx - 5, a.cy - 0)).toBeCloseTo(5, 6);
    }
  });

  // 手算錨定（非只驗距離）：依 W3C SVG arc endpoint→center 公式（rx=ry=r, largeArc=0）逐步推導，
  // 並用「(W-r,0)→(W,r) 圓角＝標準 rounded-rect 角公式 center=(W-r,r)」獨立驗證公式無誤——
  // 這組案例算出圓心精確為 (0,0)（spec 註解猜的 (5,-5) 其實是 sweep=0 那一側，見下一測試）。
  it('arcTo 數值錨定：已知案例的圓心精確值與掃角 90°', () => {
    const segs = new PathBuilder().moveTo(0, -5).arcTo(5, 1, 5, 0).segments();
    const a = segs[0]!;
    if (a.kind !== 'arc') throw new Error('expected arc segment');
    expect(a.cx).toBeCloseTo(0, 6);
    expect(a.cy).toBeCloseTo(0, 6);
    expect(a.ccw).toBe(false); // sweep=1 → ccw===false
    expect(a.startAngle).toBeCloseTo(-Math.PI / 2, 6);
    expect(a.endAngle).toBeCloseTo(0, 6);
    // ccw=false：角度從 startAngle 遞增到 endAngle，掃過量 = endAngle - startAngle
    expect(a.endAngle - a.startAngle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('arcTo sweep=0 與 sweep=1 圓心落在弦兩側（鏡像）', () => {
    const p0 = { x: 0, y: -5 };
    const p1 = { x: 5, y: 0 };
    const segSweep1 = new PathBuilder().moveTo(p0.x, p0.y).arcTo(5, 1, p1.x, p1.y).segments()[0]!;
    const segSweep0 = new PathBuilder().moveTo(p0.x, p0.y).arcTo(5, 0, p1.x, p1.y).segments()[0]!;
    if (segSweep1.kind !== 'arc' || segSweep0.kind !== 'arc') throw new Error('expected arc segments');

    // 兩側圓心都合法：到兩端點距離皆為 r
    for (const a of [segSweep1, segSweep0]) {
      expect(Math.hypot(a.cx - p0.x, a.cy - p0.y)).toBeCloseTo(5, 6);
      expect(Math.hypot(a.cx - p1.x, a.cy - p1.y)).toBeCloseTo(5, 6);
    }

    // 數值錨定：sweep=1→(0,0)、sweep=0→(5,-5)（spec 註解猜的側）
    expect(segSweep1.cx).toBeCloseTo(0, 6);
    expect(segSweep1.cy).toBeCloseTo(0, 6);
    expect(segSweep0.cx).toBeCloseTo(5, 6);
    expect(segSweep0.cy).toBeCloseTo(-5, 6);

    // 鏡像不變量（不依賴實作巧合的通用幾何驗證）：
    // 1. 兩圓心中點＝弦中點（兩圓心關於弦的中垂線對稱）
    const chordMid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    expect((segSweep1.cx + segSweep0.cx) / 2).toBeCloseTo(chordMid.x, 6);
    expect((segSweep1.cy + segSweep0.cy) / 2).toBeCloseTo(chordMid.y, 6);
    // 2. 兩圓心連線垂直於弦（點積為 0）
    const centerDiff = { x: segSweep1.cx - segSweep0.cx, y: segSweep1.cy - segSweep0.cy };
    const chordVec = { x: p1.x - p0.x, y: p1.y - p0.y };
    expect(centerDiff.x * chordVec.x + centerDiff.y * chordVec.y).toBeCloseTo(0, 6);

    // sweep 相反 → ccw 相反
    expect(segSweep1.ccw).toBe(false);
    expect(segSweep0.ccw).toBe(true);
  });

  it('arcTo 遇 chord 大於直徑（幾何不可能）時拋出錯誤', () => {
    // r=1，兩端點距離 hypot(10,10)=14.14 遠大於直徑 2
    expect(() => new PathBuilder().moveTo(0, 0).arcTo(1, 1, 10, 10)).toThrow(/弦長|直徑/);
  });

  it('arcTo 遇 chord===0（起訖點重合）時拋出錯誤', () => {
    // 起訖點重合：dx=dy=0 → chord=0 → ux=dx/chord=NaN，若不特判會靜默產生 NaN 圓心
    expect(() => new PathBuilder().moveTo(5, 5).arcTo(3, 1, 5, 5)).toThrow(/起訖點|重合/);
  });

  it('未呼叫 moveTo 就呼叫 lineTo/arcTo/bezierTo 皆拋出錯誤', () => {
    expect(() => new PathBuilder().lineTo(1, 1)).toThrow(/moveTo/);
    expect(() => new PathBuilder().arcTo(1, 1, 1, 1)).toThrow(/moveTo/);
    expect(() => new PathBuilder().bezierTo(1, 1, 2, 2, 3, 3)).toThrow(/moveTo/);
  });
});

describe('segmentsToSvgD', () => {
  it('連續段共用起點只發一次 M', () => {
    const d = segmentsToSvgD(new PathBuilder().moveTo(0, 0).lineTo(10, 0).lineTo(10, 5).segments());
    expect(d).toBe('M0.00,0.00 L10.00,0.00 L10.00,5.00');
  });

  it('不連續段（第二個 moveTo）在 d 內產生第二個 M', () => {
    const segs = new PathBuilder()
      .moveTo(0, 0)
      .lineTo(10, 0)
      .moveTo(20, 20) // 中斷：不與前段終點相接
      .lineTo(30, 20)
      .segments();
    const d = segmentsToSvgD(segs);
    expect(d).toBe('M0.00,0.00 L10.00,0.00 M20.00,20.00 L30.00,20.00');
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('arc 投影回 SVG「A r r 0 0 sweep x y」格式正確', () => {
    // 乾淨案例（避開弦跨 0° 造成的浮點 -0 雜訊）：(10,0)→(20,10)，r=10，sweep=1
    // 對照 rounded-rect 角公式 center=(W-r,r)=(10,10) 獨立驗證：起點在圓心正上方(-90°)，終點在正右方(0°)
    const segs = new PathBuilder().moveTo(10, 0).arcTo(10, 1, 20, 10).segments();
    const d = segmentsToSvgD(segs);
    expect(d).toBe('M10.00,0.00 A10.00,10.00 0 0,1 20.00,10.00');
  });

  it('bezier 投影為「C c1x,c1y c2x,c2y x,y」格式', () => {
    const segs = new PathBuilder().moveTo(0, 0).bezierTo(1, 2, 3, 4, 5, 6).segments();
    const d = segmentsToSvgD(segs);
    expect(d).toBe('M0.00,0.00 C1.00,2.00 3.00,4.00 5.00,6.00');
  });

  it('連續段判定用容差比對：line→arc→line 鏈不因 arc 端點重算的浮點誤差多發 M', () => {
    // 非 90° 對稱的非巧合數值：arc 端點用 cx+r*cos(angle) 重算，與原始輸入不會位元級相等
    // （已用 Node 腳本驗證 chord=6.505 < 2r=9.2 合法、且 line1.end 與 arc.start 之間確實有
    // ~2.2e-16 的浮點誤差，嚴格 === 判定下會誤發第二個 M）。
    const segs = new PathBuilder()
      .moveTo(3.7, 1.3)
      .lineTo(12.9, 1.3)
      .arcTo(4.6, 1, 17.5, 5.9)
      .lineTo(17.5, 14.2)
      .segments();
    const d = segmentsToSvgD(segs);
    expect(d.match(/M/g)!.length).toBe(1);
  });

  it('fmt 對近零負值不輸出 -0.00', () => {
    // -1e-9.toFixed(2) === "-0.00"（JS 原生行為）；segment 座標含此類近零負值時不應外露這個雜訊符號
    const segs = new PathBuilder().moveTo(0, 0).lineTo(-1e-9, -1e-9).segments();
    const d = segmentsToSvgD(segs);
    expect(d).not.toContain('-0.00');
  });
});
