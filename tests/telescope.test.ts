import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, segmentsBounds } from '@/core/geometry';
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

const EPS = 1e-6;

// 生產下盒（base）：t=0.4、H=60、platform=5、panel 124(x)×179(y) —— spec Step 1 核心案例。
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

  it('platform=0（B 款薄壁，H=45）：壁頂單 crease；x 向外壁做平齊修正＝44.6', () => {
    const lidLikeOpts: TrayOpts = {
      panelL: 151,
      panelW: 206,
      height: 45,
      platformWidth: 0,
      thickness: 0.4,
      idPrefix: 'lid',
      offsetX: 0,
      offsetY: 0,
    };
    const result = generateTray(lidLikeOpts);
    const halfL = lidLikeOpts.panelL / 2;

    const top = findTagged(result.paths, 'wallTop', 'left', 'crease');
    expect(top).toHaveLength(1);
    expect(top[0]!.segments, 'platform=0 時壁頂只有一條 crease（反折線）').toHaveLength(1);

    const root = findTagged(result.paths, 'wallRoot', 'left', 'crease');
    const rootAlong = alongOf(root[0]!.segments[0]!, 'x');
    const topAlong = alongOf(top[0]!.segments[0]!, 'x');
    const outerWall = Math.abs(topAlong - rootAlong);
    expect(outerWall, 'x 向外壁＝H−t＝45−0.4（spec 例外槽：即使 platform=0 也做平齊修正）').toBeCloseTo(44.6, 6);
  });

  it('hasNaN 全否、bounds 完整涵蓋所有幾何（base 與 lid-like 兩組參數）', () => {
    for (const opts of [
      baseOpts,
      { ...baseOpts, thickness: 0 },
      { panelL: 151, panelW: 206, height: 45, platformWidth: 0, thickness: 0.4, idPrefix: 'lid', offsetX: 0, offsetY: 0 },
    ]) {
      const result = generateTray(opts);
      const allSegs = result.paths.flatMap((p) => p.segments);
      expect(hasNaN(allSegs), `hasNaN 不應為 true（opts=${JSON.stringify(opts)}）`).toBe(false);

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

  it('四個角落都有角撐（style A：cut+crease 皆有；style B：crease+cut 皆有）', () => {
    const thick = generateTray(baseOpts);
    const cornerLabels = ['right-back', 'right-front', 'left-back', 'left-front'];
    for (const label of cornerLabels) {
      const gusset = findTagged(thick.paths, 'gusset', label);
      const types = new Set(gusset.map((p) => p.type));
      expect(types.has('cut'), `厚壁角撐 ${label} 應有 cut`).toBe(true);
      expect(types.has('crease'), `厚壁角撐 ${label} 應有 crease`).toBe(true);
    }

    const thin = generateTray({ panelL: 151, panelW: 206, height: 45, platformWidth: 0, thickness: 0.4, idPrefix: 'lid', offsetX: 0, offsetY: 0 });
    for (const label of cornerLabels) {
      const gusset = findTagged(thin.paths, 'gusset', label);
      const types = new Set(gusset.map((p) => p.type));
      expect(types.has('cut'), `薄壁角撐 ${label} 應有 cut`).toBe(true);
      expect(types.has('crease'), `薄壁角撐 ${label} 應有 crease`).toBe(true);
    }
  });
});
