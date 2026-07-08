import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, hasSelfIntersection, normalizeSegments, segmentsBounds } from '@/core/geometry';
import type { DielinePath, LineType } from '@/core/types';
import { generateTray, type TrayOpts } from '@/boxes/telescope/tray';

// ── 測試專用查詢 helper（依 tray.ts 的 tags 慣例：['<landmark>', '<side>']）──

/** 找出同時帶有 landmark 與 side 兩個 tag 的路徑（可選再篩線型）。 */
function findTagged(paths: DielinePath[], landmark: string, side: string, type?: LineType): DielinePath[] {
  return paths.filter((p) => p.tags?.includes(landmark) && p.tags?.includes(side) && (type === undefined || p.type === type));
}

/** 單一 line segment 在指定 axis 上的「駐留座標」（x-axis 牆量 x、y-axis 牆量 y），非 line 或非該軸定值時擲錯。 */
function alongOf(seg: Segment, axis: 'x' | 'y'): number {
  if (seg.kind !== 'line') throw new Error('alongOf: 預期 line segment');
  const [a1, a2] = axis === 'x' ? [seg.x1, seg.x2] : [seg.y1, seg.y2];
  if (Math.abs(a1 - a2) > 1e-9) throw new Error(`alongOf: 線段在 ${axis} 軸上不是定值（非該方向的駐留線）`);
  return a1;
}

/** 一組 segments 裡所有 line 端點在指定 axis 上的座標值（含重複，供「是否出現過某值」的寬鬆檢查用）。 */
function allAlongValues(segs: Segment[], axis: 'x' | 'y'): number[] {
  const vals: number[] = [];
  for (const s of segs) {
    if (s.kind === 'line') {
      vals.push(axis === 'x' ? s.x1 : s.y1, axis === 'x' ? s.x2 : s.y2);
    }
  }
  return vals;
}

type LineSeg = Extract<Segment, { kind: 'line' }>;
type ArcSeg = Extract<Segment, { kind: 'arc' }>;

/** 斷言一組路徑中存在指定端點的 line segment（端點順序不拘，容差 tol）。 */
function expectLine(paths: DielinePath[], x1: number, y1: number, x2: number, y2: number, tol: number, label: string): void {
  const lines = paths.flatMap((p) => p.segments).filter((s): s is LineSeg => s.kind === 'line');
  const hit = lines.some(
    (s) =>
      (Math.abs(s.x1 - x1) <= tol && Math.abs(s.y1 - y1) <= tol && Math.abs(s.x2 - x2) <= tol && Math.abs(s.y2 - y2) <= tol) ||
      (Math.abs(s.x1 - x2) <= tol && Math.abs(s.y1 - y2) <= tol && Math.abs(s.x2 - x1) <= tol && Math.abs(s.y2 - y1) <= tol),
  );
  expect(hit, `${label}: 應存在 line (${x1},${y1})→(${x2},${y2})（tol=${tol}）`).toBe(true);
}

/** arc segment 的起訖端點（由圓心＋半徑＋角度重建）。 */
function arcEndpoints(s: ArcSeg): { start: { x: number; y: number }; end: { x: number; y: number } } {
  return {
    start: { x: s.cx + s.r * Math.cos(s.startAngle), y: s.cy + s.r * Math.sin(s.startAngle) },
    end: { x: s.cx + s.r * Math.cos(s.endAngle), y: s.cy + s.r * Math.sin(s.endAngle) },
  };
}

/** 找出半徑≈r 且端點（無序）與 (e1,e2) 在 tol 內吻合的 arc。 */
function findArc(paths: DielinePath[], r: number, e1: { x: number; y: number }, e2: { x: number; y: number }, tol: number): ArcSeg | undefined {
  const arcs = paths.flatMap((p) => p.segments).filter((s): s is ArcSeg => s.kind === 'arc' && Math.abs(s.r - r) <= tol);
  return arcs.find((s) => {
    const { start, end } = arcEndpoints(s);
    const match = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
    return (match(start, e1) && match(end, e2)) || (match(start, e2) && match(end, e1));
  });
}

const EPS = 1e-6;

// 生產下盒（base）：t=0.4、H=60、platform=5、panel 124(x)×179(y) —— brief Step 1 核心案例。
const baseOpts: TrayOpts = {
  panelL: 124,
  panelW: 179,
  height: 60,
  platformWidth: 5,
  thickness: 0.4,
  idPrefix: 'base',
  offsetX: 0,
  offsetY: 0,
};

// 生產上蓋（lid）：t=0.4、H=45、platform=0、panel 151(x)×206(y)。
const lidOpts: TrayOpts = {
  panelL: 151,
  panelW: 206,
  height: 45,
  platformWidth: 0,
  thickness: 0.4,
  idPrefix: 'lid',
  offsetX: 0,
  offsetY: 0,
};

describe('generateTray', () => {
  it('x 向（先摺壁·左緣向外）駐留座標間距依序為 [59.6, 5, 58.8, 15]（H−t 平齊修正）', () => {
    const result = generateTray(baseOpts);
    const halfL = baseOpts.panelL / 2;

    const root = findTagged(result.paths, 'wallRoot', 'left', 'crease');
    expect(root, 'left wallRoot 應恰有 1 條 path（x 向單 crease）').toHaveLength(1);
    const rootAlongs = root[0]!.segments.map((s) => alongOf(s, 'x'));
    expect(new Set(rootAlongs).size, 'x 向 wallRoot 只有一個駐留座標（單 crease，非雙線）').toBe(1);
    expect(rootAlongs[0]).toBeCloseTo(-halfL, 6);

    const top = findTagged(result.paths, 'wallTop', 'left', 'crease');
    expect(top).toHaveLength(1);
    // 左壁 sign=−1，往外走座標遞減，故按「離 root 的距離」升冪排序（而非數值升冪）
    // 才能正確得到 [nearer, farther] 順序——數值升冪對 sign=−1 的牆會把兩者順序弄反。
    const topAlongs = [...new Set(top[0]!.segments.map((s) => alongOf(s, 'x')))].sort(
      (a, b) => Math.abs(a - rootAlongs[0]!) - Math.abs(b - rootAlongs[0]!),
    );
    expect(topAlongs, 'platform>0 時壁頂應有兩個相異駐留座標（兩條 crease）').toHaveLength(2);

    const tongueFold = findTagged(result.paths, 'tongueFold', 'left');
    expect(tongueFold.length).toBeGreaterThan(0);
    const tongueFoldAlong = alongOf(tongueFold[0]!.segments[0]!, 'x');

    const tongueFlap = findTagged(result.paths, 'tongueFlap', 'left', 'cut');
    expect(tongueFlap).toHaveLength(1);
    const flapAlongs = allAlongValues(tongueFlap[0]!.segments, 'x');

    // 依序間距：root→top(outerWall)→top兩線間(platform)→tongueFold(innerWall)→tongueFlap全深(tuckFlap)
    const outerWall = Math.abs(topAlongs[0]! - rootAlongs[0]!);
    const platformGap = Math.abs(topAlongs[1]! - topAlongs[0]!);
    const innerWall = Math.abs(tongueFoldAlong - topAlongs[1]!);
    expect(outerWall, 'outerWall = H − t = 60 − 0.4').toBeCloseTo(59.6, 6);
    expect(platformGap, 'platform = platformWidth').toBeCloseTo(5, 6);
    expect(innerWall, 'innerWall = outerWall − 2t = 59.6 − 0.8').toBeCloseTo(58.8, 6);

    const deepestAlong = -halfL - (59.6 + 5 + 58.8 + 15); // 全深 15 的最遠端點（局部座標，sign=-1）
    expect(flapAlongs.some((v) => Math.abs(v - deepestAlong) < 1e-6), 'tongueFlap 應有一點落在全深 15mm 處').toBe(true);
  });

  it('y 向（後摺壁）駐留間距：雙 crease gap=t=0.4、外壁 60、平台 5、內壁 59.2、舌 15', () => {
    const result = generateTray(baseOpts);
    const halfW = baseOpts.panelW / 2;

    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    expect(root[0]!.segments, 'y 向 wallRoot 應有兩條 crease（雙 crease 根，t>0）').toHaveLength(2);
    const rootAlongs = [...new Set(root[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
    expect(rootAlongs).toHaveLength(2);
    const doubleCreaseGap = rootAlongs[1]! - rootAlongs[0]!;
    expect(doubleCreaseGap, 'doubleCreaseGap = t = 0.4').toBeCloseTo(0.4, 6);
    expect(rootAlongs[0]).toBeCloseTo(halfW, 6);

    const top = findTagged(result.paths, 'wallTop', 'back', 'crease');
    const topAlongs = [...new Set(top[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
    expect(topAlongs).toHaveLength(2);
    const outerWall = topAlongs[0]! - rootAlongs[1]!; // 自雙 crease 外線起量
    const platformGap = topAlongs[1]! - topAlongs[0]!;
    expect(outerWall, 'y 向 outerWall = H（不做平齊修正）').toBeCloseTo(60, 6);
    expect(platformGap).toBeCloseTo(5, 6);

    const tongueFold = findTagged(result.paths, 'tongueFold', 'back');
    const tongueFoldAlong = alongOf(tongueFold[0]!.segments[0]!, 'y');
    const innerWall = tongueFoldAlong - topAlongs[1]!;
    expect(innerWall, 'y 向 innerWall = outerWall − 2t = 60 − 0.8').toBeCloseTo(59.2, 6);

    const tongueFlap = findTagged(result.paths, 'tongueFlap', 'back', 'cut');
    const flapAlongs = allAlongValues(tongueFlap[0]!.segments, 'y');
    const deepestAlong = tongueFoldAlong + 15;
    expect(flapAlongs.some((v) => Math.abs(v - deepestAlong) < 1e-6), 'tongueFlap 應有一點落在全深 15mm 處').toBe(true);
  });

  it('線型斷言：舌摺線含 halfcut 段（中段）與 crease 段（兩端讓位角撐）', () => {
    const result = generateTray(baseOpts);
    const halfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    const crease = findTagged(result.paths, 'tongueFold', 'left', 'crease');
    expect(halfcut.length, '舌摺線應有 halfcut 型別的路徑（中段）').toBeGreaterThan(0);
    expect(crease.length, '舌摺線應有 crease 型別的路徑（兩端讓位角撐）').toBeGreaterThan(0);
    expect(halfcut[0]!.segments).toHaveLength(1);
    expect(crease[0]!.segments, '兩端各一條 crease，合計 2 段').toHaveLength(2);
  });

  it('t=0 時 y 向壁根 collapse 為單一 crease（不得輸出兩條重合線）', () => {
    const result = generateTray({ ...baseOpts, thickness: 0 });
    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    expect(root[0]!.segments, 't=0 時雙 crease collapse，只剩一條線').toHaveLength(1);
  });

  it('t=0 全圖掃描：四側壁根皆 collapse、無零長度線段、無同型重複線段（兩款各驗）', () => {
    for (const opts of [
      { ...baseOpts, thickness: 0 },
      { ...lidOpts, thickness: 0 },
    ]) {
      const result = generateTray(opts);
      for (const side of ['left', 'right', 'front', 'back']) {
        const root = findTagged(result.paths, 'wallRoot', side, 'crease');
        expect(root, `${opts.idPrefix}/${side} wallRoot`).toHaveLength(1);
        expect(root[0]!.segments, `t=0 時 ${opts.idPrefix}/${side} 壁根應 collapse 成單線`).toHaveLength(1);
      }
      const seen = new Set<string>();
      for (const p of result.paths) {
        for (const s of p.segments) {
          if (s.kind === 'line') {
            const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
            expect(len, `${opts.idPrefix}: 不得有零長度線段（path ${p.id}）`).toBeGreaterThan(1e-9);
          }
          // 同型（同 LineType）重複線段偵測：normalizeSegments 已做端點正規排序＋量化，
          // 兩條幾何相同的線段（含方向相反）會化為同一字串。
          const key = `${p.type}|${normalizeSegments([s])[0]!}`;
          expect(seen.has(key), `${opts.idPrefix}: 偵測到同型重複線段（${key}，path ${p.id}）`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it('platform=0（B 款薄壁，H=45）：壁頂單 crease；x 向外壁做平齊修正＝44.6', () => {
    const result = generateTray(lidOpts);

    const top = findTagged(result.paths, 'wallTop', 'left', 'crease');
    expect(top).toHaveLength(1);
    expect(top[0]!.segments, 'platform=0 時壁頂只有一條 crease（反折線）').toHaveLength(1);

    const root = findTagged(result.paths, 'wallRoot', 'left', 'crease');
    const rootAlong = alongOf(root[0]!.segments[0]!, 'x');
    const topAlong = alongOf(top[0]!.segments[0]!, 'x');
    const outerWall = Math.abs(topAlong - rootAlong);
    expect(outerWall, 'x 向外壁＝H−t＝45−0.4（spec 例外槽：即使 platform=0 也做平齊修正）').toBeCloseTo(44.6, 6);
  });

  it('hasNaN 全否、bounds＝牆鏈包絡的獨立公式值（base/lid/t=0 三組）', () => {
    // bounds 期望值用「面板半寬＋牆鏈總深」的獨立公式算出（不從 result 反推——
    // result.bounds 本來就是同一份 segments 算的，拿它自我比對是重言式）。
    // 牆鏈總深 = 外壁 + platform + 內壁 + 舌全深；x 向外壁 = H−t、y 向自雙 crease 外線
    // 起量所以再加 t。角撐所有特徵都在牆鏈包絡之內（V3/V4/讓位槽 ≤ 牆鏈深），不另擴。
    const cases: Array<{ opts: TrayOpts; xDepth: number; yDepth: number }> = [
      { opts: baseOpts, xDepth: 59.6 + 5 + 58.8 + 15, yDepth: 0.4 + 60 + 5 + 59.2 + 15 },
      { opts: { ...baseOpts, thickness: 0 }, xDepth: 60 + 5 + 60 + 15, yDepth: 60 + 5 + 60 + 15 },
      { opts: lidOpts, xDepth: 44.6 + 0 + 43.8 + 15, yDepth: 0.4 + 45 + 44.2 + 15 },
    ];
    for (const { opts, xDepth, yDepth } of cases) {
      const result = generateTray(opts);
      const allSegs = result.paths.flatMap((p) => p.segments);
      expect(hasNaN(allSegs), `hasNaN 不應為 true（${opts.idPrefix} t=${opts.thickness}）`).toBe(false);

      const ex = opts.panelL / 2 + xDepth;
      const ey = opts.panelW / 2 + yDepth;
      expect(result.bounds.minX, `${opts.idPrefix} minX`).toBeCloseTo(-ex, 6);
      expect(result.bounds.maxX, `${opts.idPrefix} maxX`).toBeCloseTo(ex, 6);
      expect(result.bounds.minY, `${opts.idPrefix} minY`).toBeCloseTo(-ey, 6);
      expect(result.bounds.maxY, `${opts.idPrefix} maxY`).toBeCloseTo(ey, 6);

      // bounds 涵蓋實際幾何（用 segmentsBounds 交叉驗，涵蓋角撐不越界的斷言）
      const actual = segmentsBounds(allSegs);
      expect(actual.minX).toBeGreaterThanOrEqual(result.bounds.minX - EPS);
      expect(actual.maxX).toBeLessThanOrEqual(result.bounds.maxX + EPS);
      expect(actual.minY).toBeGreaterThanOrEqual(result.bounds.minY - EPS);
      expect(actual.maxY).toBeLessThanOrEqual(result.bounds.maxY + EPS);
    }
  });

  it('offsetX/offsetY 對整體幾何做剛體平移（bounds 跟著平移相同量）', () => {
    const plain = generateTray(baseOpts);
    const shifted = generateTray({ ...baseOpts, offsetX: 100, offsetY: -50 });
    expect(shifted.bounds.minX - plain.bounds.minX).toBeCloseTo(100, 6);
    expect(shifted.bounds.maxX - plain.bounds.maxX).toBeCloseTo(100, 6);
    expect(shifted.bounds.minY - plain.bounds.minY).toBeCloseTo(-50, 6);
    expect(shifted.bounds.maxY - plain.bounds.maxY).toBeCloseTo(-50, 6);
  });

  it('四個角落都有角撐（含 web 摺線；兩款 cut+crease 皆有）', () => {
    const cornerLabels = ['right-back', 'right-front', 'left-back', 'left-front'];
    for (const opts of [baseOpts, lidOpts]) {
      const result = generateTray(opts);
      for (const label of cornerLabels) {
        const gusset = findTagged(result.paths, 'gusset', label);
        const types = new Set(gusset.map((p) => p.type));
        expect(types.has('cut'), `${opts.idPrefix} 角撐 ${label} 應有 cut`).toBe(true);
        expect(types.has('crease'), `${opts.idPrefix} 角撐 ${label} 應有 crease`).toBe(true);
        const folds = findTagged(result.paths, 'gussetFold', label, 'crease');
        expect(folds, `${opts.idPrefix} 角撐 ${label} 應有 web 摺線`).toHaveLength(1);
        expect(folds[0]!.segments, 'web 摺線兩條（沿兩軸）').toHaveLength(2);
      }
    }
  });
});

// ── 角撐座標級迴歸（Fix Round 1：F2）──
//
// 期望值全部是「獨立手算」的硬編碼（推導過程見 task-3-report.md Fix Round 1），
// 不從 tray.ts 的公式重算——否則公式改錯測試也跟著錯（重言式）。

describe('gusset 幾何（座標級迴歸）', () => {
  it('style A 校準點（t=0.4/H=60/platform=5）：web 摺線＋對角 cut/crease＋外緣斜切座標', () => {
    const result = generateTray(baseOpts); // 角落 right-back = (62, 89.5)
    const g = findTagged(result.paths, 'gusset', 'right-back');
    const folds = findTagged(result.paths, 'gussetFold', 'right-back', 'crease');
    const T = 1e-6;

    // web 摺線：角落沿兩軸到 V3/V4（reach = H−t = 59.6）
    expectLine(folds, 62, 89.5, 121.6, 89.5, T, 'A web 摺線（x 軸）');
    expectLine(folds, 62, 89.5, 62, 149.1, T, 'A web 摺線（y 軸）');

    // 對角線：角落半段 cut、外半段 crease（單軸位移 25.2906 級）
    const diagCut = g.filter((p) => p.type === 'cut');
    const diagCrease = g.filter((p) => p.type === 'crease');
    expectLine(diagCut, 62, 89.5, 87.2906, 114.7906, 1e-4, 'A 對角 cut 半段');
    expectLine(diagCrease, 87.2906, 114.7906, 112.5812, 140.0812, 1e-4, 'A 對角 crease 半段');

    // 外緣斜切：V4→tip→V3
    expectLine(diagCut, 62, 149.1, 112.5812, 140.0812, 1e-4, 'A 外緣 V4→tip');
    expectLine(diagCut, 112.5812, 140.0812, 121.6, 89.5, 1e-4, 'A 外緣 tip→V3');

    // 牆側邊 cut 從錨點（V3/V4）起，不得在角落到錨點之間有 cut（web 與牆相連）
    const rightWallSide = findTagged(result.paths, 'wallSide', 'right', 'cut');
    const sideXs = allAlongValues(rightWallSide[0]!.segments, 'x');
    expect(Math.min(...sideXs), 'x 向牆側邊 cut 應從 V3（62+59.6）起').toBeCloseTo(121.6, 6);
    const backWallSide = findTagged(result.paths, 'wallSide', 'back', 'cut');
    const sideYs = allAlongValues(backWallSide[0]!.segments, 'y');
    expect(Math.min(...sideYs), 'y 向牆側邊 cut 應從 V4（89.5+59.6）起').toBeCloseTo(149.1, 6);
  });

  it('style B 校準點（t=0.4/H=45/platform=0）：讓位槽鏈全點位＋弧半徑＋apex 相切', () => {
    const result = generateTray(lidOpts); // 角落 right-back = (75.5, 103)
    const g = findTagged(result.paths, 'gusset', 'right-back');
    const folds = findTagged(result.paths, 'gussetFold', 'right-back', 'crease');
    const cuts = g.filter((p) => p.type === 'cut');
    const creases = g.filter((p) => p.type === 'crease');
    // 期望值：reach=44.6；hairpin 軸 a=reach、apex 切 b=0、腿傾角 10°、R1.5/R5、
    // 出口線 a+b=2reach、出口轉角 b=16.298/45×45（獨立手算，離角座標＋角落 (75.5,103)）
    const T = 1e-4;

    expectLine(folds, 75.5, 103, 148.402, 103, T, 'B web 摺線（x 軸→p6）');
    expectLine(folds, 75.5, 103, 75.5, 148, T, 'B web 摺線（y 軸→H）');

    expectLine(cuts, 75.5, 103, 93.92232, 121.42232, T, 'B 對角 cut 半段');
    expectLine(creases, 93.92232, 121.42232, 112.34465, 139.84465, T, 'B 對角 crease 半段');
    expectLine(cuts, 112.34465, 139.84465, 75.5, 148, T, 'B terminal cut（tip→y 軸錨點）');

    // 讓位槽鏈：tip→p1、[R1.5]、p2→p3、[R5]、p4→p5、p5→p6
    expectLine(cuts, 112.34465, 139.84465, 118.62279, 104.23953, T, 'B 槽內腿（tip→p1）');
    expectLine(cuts, 121.57721, 104.23953, 126.18748, 130.38566, T, 'B 槽外腿（p2→p3）');
    expectLine(cuts, 134.64705, 133.05295, 148.402, 119.298, T, 'B 45° 出口（p4→p5）');
    expectLine(cuts, 148.402, 119.298, 148.402, 103, T, 'B 垂直出口（p5→p6）');

    const arc15 = findArc(cuts, 1.5, { x: 118.62279, y: 104.23953 }, { x: 121.57721, y: 104.23953 }, T);
    expect(arc15, 'R1.5 迴轉小弧（p1→p2）').toBeDefined();
    const arc5 = findArc(cuts, 5.0, { x: 126.18748, y: 130.38566 }, { x: 134.64705, y: 133.05295 }, T);
    expect(arc5, 'R5 讓位弧（p3→p4）').toBeDefined();

    // apex 相切：R1.5 弧頂應恰好觸及牆根線 y=103（凹凸向錯誤時會鼓向反側、遠離根線）
    const b15 = segmentsBounds([arc15!]);
    expect(b15.minY, 'R1.5 弧 apex 觸及 y=103 根線').toBeCloseTo(103, 6);
    // R5 讓位弧鼓向外（遠離面板），不得越過出口線側往面板方向鼓
    const b5 = segmentsBounds([arc5!]);
    expect(b5.maxY, 'R5 弧向外鼓（apex y > 兩切點 y）').toBeGreaterThan(133.05295 + 0.5);

    // 牆側邊 cut 錨點：x 向從 p6、y 向從 H
    const rightWallSide = findTagged(result.paths, 'wallSide', 'right', 'cut');
    expect(Math.min(...allAlongValues(rightWallSide[0]!.segments, 'x')), 'x 側邊 cut 自 p6 起').toBeCloseTo(148.402, 4);
    const backWallSide = findTagged(result.paths, 'wallSide', 'back', 'cut');
    expect(Math.min(...allAlongValues(backWallSide[0]!.segments, 'y')), 'y 側邊 cut 自 H 起').toBeCloseTo(148, 4);
  });

  it('style B 復刻殘差：t=0/H=45 對生產參照 ≤0.08mm；弦長錨（R5≈8.87、R1.5≈2.95）', () => {
    // 生產參照值（角落相對 mm，自生產 SVG pt 座標換算；t=0 時 reach=H 與生產一致）。
    // 只錨鏈條特徵點與兩弧弦長；yEnd 生產值 45.074（我們取整 H=45，殘差 0.074 已知）。
    const result = generateTray({ ...lidOpts, thickness: 0 }); // 角落 right-back = (75.5, 103)
    const g = findTagged(result.paths, 'gusset', 'right-back');
    const cuts = g.filter((p) => p.type === 'cut');
    const creases = g.filter((p) => p.type === 'crease');
    const T = 0.08;

    // 對角 crease：mid(18.591,18.591)→tip(37.183,37.183)（相對角落）
    expectLine(creases, 75.5 + 18.5914, 103 + 18.5914, 75.5 + 37.1832, 103 + 37.1832, T, 'B 對角 crease vs 生產');
    // 垂直出口：p5(73.699,16.298)→p6(73.699,0)
    expectLine(cuts, 75.5 + 73.699, 103 + 16.2981, 75.5 + 73.699, 103, T, 'B 垂直出口 vs 生產');
    // terminal：tip→(0,45.074)（我們畫到 (0,45)，殘差 0.074 ≤ 0.08）
    expectLine(cuts, 75.5 + 37.1832, 103 + 37.1832, 75.5, 103 + 45.0743, T, 'B terminal vs 生產');

    // 兩弧弦長錨（coordinator 量化錨：R5 弦 8.87 級、R1.5 弦 2.95 級）
    const arcs = cuts.flatMap((p) => p.segments).filter((s): s is ArcSeg => s.kind === 'arc');
    const chords = arcs.map((s) => {
      const { start, end } = arcEndpoints(s);
      return { r: s.r, chord: Math.hypot(end.x - start.x, end.y - start.y) };
    });
    const c5 = chords.find((c) => Math.abs(c.r - 5) < 0.01);
    const c15 = chords.find((c) => Math.abs(c.r - 1.5) < 0.01);
    expect(c5, 'R5 弧存在').toBeDefined();
    expect(c15, 'R1.5 弧存在').toBeDefined();
    expect(c5!.chord, 'R5 弦長 ≈ 8.87（生產 8.870）').toBeCloseTo(8.87, 1);
    expect(c15!.chord, 'R1.5 弦跨 ≈ 2.95（生產 2.953）').toBeCloseTo(2.95, 1);
  });

  it('cut 自撞掃描（persisted）：H×platform×t 24 組合 cut 幾何無真交叉、無 NaN', () => {
    // H 下限取 30：style B 讓位槽用固定半徑 R5/R1.5，H ≲ 17 時 R5 圓角在幾何上放不下
    // （出口轉角高超過槽底），是參數域邊界而非本掃描要抓的退化——T4 應以不變式擋下。
    const failures: string[] = [];
    for (const height of [30, 45, 60, 90]) {
      for (const platformWidth of [0, 5]) {
        for (const thickness of [0, 0.4, 0.8]) {
          const r = generateTray({ panelL: 124, panelW: 179, height, platformWidth, thickness, idPrefix: 't', offsetX: 0, offsetY: 0 });
          const cutSegs = r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
          if (hasNaN(r.paths.flatMap((p) => p.segments))) failures.push(`NaN@H=${height},p=${platformWidth},t=${thickness}`);
          if (hasSelfIntersection(cutSegs)) failures.push(`selfX@H=${height},p=${platformWidth},t=${thickness}`);
        }
      }
    }
    expect(failures, `異常組合：${failures.join('; ')}`).toEqual([]);
  });
});
