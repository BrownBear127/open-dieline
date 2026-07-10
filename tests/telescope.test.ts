import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, hasSelfIntersection, normalizeSegments, segmentsBounds } from '@/core/geometry';
import type { DielinePath, GenerateResult, LineType } from '@/core/types';
import { generateTray, type TrayOpts } from '@/boxes/telescope/tray';
import { getBox, resolveParams } from '@/core/registry';
import { telescope, minStyleBHeight } from '@/boxes/telescope';
import { deriveLinerFrame, generateLiner } from '@/boxes/telescope/liner';
import { validatePieces } from '@/core/pieces';

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

// 生產下盒（base）：t=0.4、H=60、platform=5、panel 124(x)×179(y) —— spec Step 1 核心案例。
// rootJog/innerWallReduction/wallTopCompensation 取 spec F3 宣告預設（0.5/0.8/0.5）——
// 刻意與 thickness=0.4 不同值，讓下面各測試的數字能直接證明三補償與 t 已解耦（Slice 5 F3）。
const baseOpts: TrayOpts = {
  panelL: 124,
  panelW: 179,
  height: 60,
  platformWidth: 5,
  thickness: 0.4,
  rootJog: 0.5,
  innerWallReduction: 0.8,
  wallTopCompensation: 0.5,
  idPrefix: 'base',
  offsetX: 0,
  offsetY: 0,
};

// 生產上蓋（lid）：t=0.4、H=45、platform=0、panel 151(x)×206(y)。
// wallTopCompensation=0（B-06：上蓋左右壁的頂緣平齊特例移除，四面外壁恆＝壁高，模擬
// index.ts buildLidPiece 對 generateTray 的真實呼叫方式，見該函式）。
const lidOpts: TrayOpts = {
  panelL: 151,
  panelW: 206,
  height: 45,
  platformWidth: 0,
  thickness: 0.4,
  rootJog: 0.5,
  innerWallReduction: 0.8,
  wallTopCompensation: 0,
  idPrefix: 'lid',
  offsetX: 0,
  offsetY: 0,
};

describe('generateTray', () => {
  it('x 向（先摺壁·左緣向外）駐留座標間距依序為 [59.5, 5, 58.7, 15]（H−wallTopCompensation 平齊修正，F3 解耦）', () => {
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
    expect(outerWall, 'outerWall = H − wallTopCompensation = 60 − 0.5（F3 解耦，不再讀 t）').toBeCloseTo(59.5, 6);
    expect(platformGap, 'platform = platformWidth').toBeCloseTo(5, 6);
    expect(innerWall, 'innerWall = outerWall − innerWallReduction = 59.5 − 0.8（F3 解耦，不再讀 2t）').toBeCloseTo(58.7, 6);

    const deepestAlong = -halfL - (59.5 + 5 + 58.7 + 15); // 全深 15 的最遠端點（局部座標，sign=-1）
    expect(flapAlongs.some((v) => Math.abs(v - deepestAlong) < 1e-6), 'tongueFlap 應有一點落在全深 15mm 處').toBe(true);
  });

  it('y 向（後摺壁）駐留間距：雙 crease gap=rootJog=0.5、外壁 60、平台 5、內壁 59.2、舌 15', () => {
    const result = generateTray(baseOpts);
    const halfW = baseOpts.panelW / 2;

    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    expect(root[0]!.segments, 'y 向 wallRoot 應有兩條 crease（雙 crease 根，rootJog>0）').toHaveLength(2);
    const rootAlongs = [...new Set(root[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
    expect(rootAlongs).toHaveLength(2);
    const doubleCreaseGap = rootAlongs[1]! - rootAlongs[0]!;
    expect(doubleCreaseGap, 'doubleCreaseGap = rootJog = 0.5（F3 解耦，不再讀 t=0.4）').toBeCloseTo(0.5, 6);
    expect(rootAlongs[0]).toBeCloseTo(halfW, 6);

    const top = findTagged(result.paths, 'wallTop', 'back', 'crease');
    const topAlongs = [...new Set(top[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
    expect(topAlongs).toHaveLength(2);
    const outerWall = topAlongs[0]! - rootAlongs[1]!; // 自雙 crease 外線起量
    const platformGap = topAlongs[1]! - topAlongs[0]!;
    expect(outerWall, 'y 向 outerWall = H（base／lid 皆不做平齊修正，F3 前後外壁一致）').toBeCloseTo(60, 6);
    expect(platformGap).toBeCloseTo(5, 6);

    const tongueFold = findTagged(result.paths, 'tongueFold', 'back');
    const tongueFoldAlong = alongOf(tongueFold[0]!.segments[0]!, 'y');
    const innerWall = tongueFoldAlong - topAlongs[1]!;
    // 59.2＝60−innerWallReduction(0.8)——F3 解耦後的公式。數值恰與舊公式 60−2t(0.4)=59.2
    // 巧合相同（baseOpts 選用 innerWallReduction=0.8=2×0.4），x 向 outerWall/innerWall
    // 測試（59.5/58.7 vs 舊 59.6/58.8）已用不同數值證明解耦，這裡數值巧合不影響結論。
    expect(innerWall, 'y 向 innerWall = outerWall − innerWallReduction = 60 − 0.8').toBeCloseTo(59.2, 6);

    const tongueFlap = findTagged(result.paths, 'tongueFlap', 'back', 'cut');
    const flapAlongs = allAlongValues(tongueFlap[0]!.segments, 'y');
    const deepestAlong = tongueFoldAlong + 15;
    expect(flapAlongs.some((v) => Math.abs(v - deepestAlong) < 1e-6), 'tongueFlap 應有一點落在全深 15mm 處').toBe(true);
  });

  it('線型斷言：舌摺線含 halfcut 段（中段）與 cut 段（兩端讓位角撐，維護者裁決需軋斷·2026-07-09 T7 gate）', () => {
    const result = generateTray(baseOpts);
    const halfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    const cut = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    expect(halfcut.length, '舌摺線應有 halfcut 型別的路徑（中段）').toBeGreaterThan(0);
    expect(cut.length, '舌摺線應有 cut 型別的路徑（兩端讓位角撐，自由邊必須軋斷）').toBeGreaterThan(0);
    expect(halfcut[0]!.segments).toHaveLength(1);
    expect(cut[0]!.segments, '兩端各一條 cut，合計 2 段').toHaveLength(2);
  });

  it('rootJog=0 時 y 向壁根 collapse 為單一 crease（與 t 解耦——F3：即使 thickness=0.4≠0 仍 collapse，不得輸出兩條重合線）', () => {
    const result = generateTray({ ...baseOpts, rootJog: 0 });
    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    expect(root[0]!.segments, 'rootJog=0 時雙 crease collapse，只剩一條線（thickness 仍是 0.4，證明 collapse 門檻已與 t 解耦）').toHaveLength(1);
  });

  it('t/rootJog/innerWallReduction/wallTopCompensation 全零（S5 等價形態）全圖掃描：四側壁根皆 collapse、無零長度線段、無同型重複線段（兩款各驗）', () => {
    for (const opts of [
      { ...baseOpts, thickness: 0, rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0 },
      { ...lidOpts, thickness: 0, rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0 },
    ]) {
      const result = generateTray(opts);
      for (const side of ['left', 'right', 'front', 'back']) {
        const root = findTagged(result.paths, 'wallRoot', side, 'crease');
        expect(root, `${opts.idPrefix}/${side} wallRoot`).toHaveLength(1);
        expect(root[0]!.segments, `rootJog=0 時 ${opts.idPrefix}/${side} 壁根應 collapse 成單線`).toHaveLength(1);
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

  it('platform=0（B 款薄壁，H=45）：壁頂單 crease；lid 分流（B-06）x 向外壁不吃補償＝H＝45', () => {
    const result = generateTray(lidOpts);

    const top = findTagged(result.paths, 'wallTop', 'left', 'crease');
    expect(top).toHaveLength(1);
    expect(top[0]!.segments, 'platform=0 時壁頂只有一條 crease（反折線）').toHaveLength(1);

    const root = findTagged(result.paths, 'wallRoot', 'left', 'crease');
    const rootAlong = alongOf(root[0]!.segments[0]!, 'x');
    const topAlong = alongOf(top[0]!.segments[0]!, 'x');
    const outerWall = Math.abs(topAlong - rootAlong);
    expect(outerWall, 'x 向外壁＝H＝45（B-06：上蓋左右壁特例移除，lidOpts.wallTopCompensation=0，即使 platform=0 也不再做平齊修正）').toBeCloseTo(45, 6);
  });

  it('hasNaN 全否、bounds＝牆鏈包絡的獨立公式值（base/lid/S5 全零等價形態 三組）', () => {
    // bounds 期望值用「面板半寬＋牆鏈總深」的獨立公式算出（不從 result 反推——
    // result.bounds 本來就是同一份 segments 算的，拿它自我比對是重言式）。
    // 牆鏈總深 = 外壁 + platform + 內壁 + 舌全深；x 向外壁 = H−wallTopCompensation（base）
    // 或 H（lid，B-06）、y 向自雙 crease 外線起量所以再加 rootJog（F3 解耦，不再讀 t）。
    // 角撐所有特徵都在牆鏈包絡之內（V3/V4/讓位槽 ≤ 牆鏈深，仍由 thickness 驅動，F6 範圍不動），不另擴。
    const cases: Array<{ opts: TrayOpts; xDepth: number; yDepth: number }> = [
      { opts: baseOpts, xDepth: 59.5 + 5 + 58.7 + 15, yDepth: 0.5 + 60 + 5 + 59.2 + 15 },
      {
        opts: { ...baseOpts, thickness: 0, rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0 },
        xDepth: 60 + 5 + 60 + 15,
        yDepth: 60 + 5 + 60 + 15,
      },
      { opts: lidOpts, xDepth: 45 + 0 + 44.2 + 15, yDepth: 0.5 + 45 + 44.2 + 15 },
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

  // spec §驗收 3（Slice 5 F3 解耦驗證）：thickness 改變不應讓 rootJog/innerWallReduction/
  // wallTopCompensation 驅動的輸出漂移——用 baseOpts 固定三補償（0.5/0.8/0.5），只變
  // thickness，量測 y 向 doubleCreaseGap／x 向 outerWall／x 向 innerWall 三個量應完全不變。
  it('F3 解耦驗證：thickness=0.4／0.5 時，doubleCreaseGap／x 向 outerWall／x 向 innerWall 三個量測值不變', () => {
    const extract = (thickness: number) => {
      const result = generateTray({ ...baseOpts, thickness });

      const rootBack = findTagged(result.paths, 'wallRoot', 'back', 'crease');
      const gapAlongs = [...new Set(rootBack[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
      const doubleCreaseGap = gapAlongs[1]! - gapAlongs[0]!;

      const rootLeft = findTagged(result.paths, 'wallRoot', 'left', 'crease');
      const topLeft = findTagged(result.paths, 'wallTop', 'left', 'crease');
      const rootAlong = alongOf(rootLeft[0]!.segments[0]!, 'x');
      const topAlongs = [...new Set(topLeft[0]!.segments.map((s) => alongOf(s, 'x')))].sort(
        (a, b) => Math.abs(a - rootAlong) - Math.abs(b - rootAlong),
      );
      const outerWall = Math.abs(topAlongs[0]! - rootAlong);

      const tongueFold = findTagged(result.paths, 'tongueFold', 'left');
      const tongueFoldAlong = alongOf(tongueFold[0]!.segments[0]!, 'x');
      const innerWall = Math.abs(tongueFoldAlong - topAlongs[topAlongs.length - 1]!);

      return { doubleCreaseGap, outerWall, innerWall };
    };

    const at04 = extract(0.4);
    const at05 = extract(0.5);
    expect(at05.doubleCreaseGap, 'doubleCreaseGap 不隨 thickness 漂移').toBeCloseTo(at04.doubleCreaseGap, 6);
    expect(at05.outerWall, 'outerWall(x) 不隨 thickness 漂移').toBeCloseTo(at04.outerWall, 6);
    expect(at05.innerWall, 'innerWall(x) 不隨 thickness 漂移').toBeCloseTo(at04.innerWall, 6);
    expect(at04.doubleCreaseGap, '= rootJog（baseOpts=0.5）').toBeCloseTo(0.5, 6);
    expect(at04.outerWall, '= H − wallTopCompensation = 60 − 0.5').toBeCloseTo(59.5, 6);
    expect(at04.innerWall, '= outerWall − innerWallReduction = 59.5 − 0.8').toBeCloseTo(58.7, 6);
  });
});

// ── 角撐座標級迴歸（Fix Round 1：F2）──
//
// 期望值全部是「獨立手算」的硬編碼（推導過程見 開發紀錄 Fix Round 1），
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
          const r = generateTray({
            panelL: 124,
            panelW: 179,
            height,
            platformWidth,
            thickness,
            rootJog: 0.5,
            innerWallReduction: 0.8,
            wallTopCompensation: 0.5,
            idPrefix: 't',
            offsetX: 0,
            offsetY: 0,
          });
          const cutSegs = r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
          if (hasNaN(r.paths.flatMap((p) => p.segments))) failures.push(`NaN@H=${height},p=${platformWidth},t=${thickness}`);
          if (hasSelfIntersection(cutSegs)) failures.push(`selfX@H=${height},p=${platformWidth},t=${thickness}`);
        }
      }
    }
    expect(failures, `異常組合：${failures.join('; ')}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T4：telescope BoxModule 組裝（liner 導出鏈／pieces／專屬不變式／假旋鈕／golden）
// ─────────────────────────────────────────────────────────────────────────

/** 預設參數上疊 overrides 後直接 generate 的捷徑（同 RTE 測試的 `gen` 慣例）。 */
const genTelescope = (overrides?: Partial<Record<string, number | boolean | string>>) =>
  telescope.generate(resolveParams(telescope, overrides));

describe('telescope', () => {
  it('模組載入時已透過 registerBox 自行註冊（id=telescope）', () => {
    expect(getBox('telescope')).toBe(telescope);
  });
});

describe('telescope: liner 導出鏈（deriveLinerFrame／generateLiner，2026-07-09 T7 gate 反饋重定義：平台式）', () => {
  // 平台式重定義（維護者裁決，取代圍框版）：底面錨定＝下盒內淨（不再是上蓋內淨），
  // 四翼向下摺＝腳架、翼深＝linerFlapDepth（架高量）、四邊同深單一參數、免膠無 tab。
  // 驗算錨（spec 自檢，controller 手算）：t=0.4/fitGap=0.5/base 179×124/flapDepth=15
  // → 底面 176.4×121.4、攤平 206.4×151.4；t=0.3 預設 → 底面 176.8×121.8。

  it('t=0.4/fitGap=0.5/base 179×124 → 底面 176.4×121.4（spec 驗算錨）', () => {
    const frame = deriveLinerFrame({ baseLength: 179, baseWidth: 124, thickness: 0.4, fitGap: 0.5 });
    expect(frame.padL, '底面長邊＝(baseLength−4t)−2×fitGap，對應 baseLength 軸').toBeCloseTo(176.4, 6);
    expect(frame.padW, '底面短邊＝(baseWidth−4t)−2×fitGap，對應 baseWidth 軸').toBeCloseTo(121.4, 6);
  });

  it('thickness=0.3（宣告預設）/fitGap=0.5/base 179×124 → 底面 176.8×121.8（spec 第二驗算錨）', () => {
    const frame = deriveLinerFrame({ baseLength: 179, baseWidth: 124, thickness: 0.3, fitGap: 0.5 });
    expect(frame.padL).toBeCloseTo(176.8, 6);
    expect(frame.padW).toBeCloseTo(121.8, 6);
  });

  it('同組參數＋flapDepth=15 → 攤平外圍 206.4×151.4（bounds 驗；spec 驗算錨）', () => {
    const liner = generateLiner({
      baseLength: 179,
      baseWidth: 124,
      thickness: 0.4,
      fitGap: 0.5,
      flapDepth: 15,
      idPrefix: 'liner',
      offsetX: 0,
      offsetY: 0,
    });
    // 攤平寬（X 向，對應 padW 軸）＝padW+2×flapDepth＝121.4+30＝151.4；
    // 攤平高（Y 向，對應 padL 軸）＝padL+2×flapDepth＝176.4+30＝206.4。
    // 只量 crease/cut（實際製造幾何），排除 dimension 標註線——同 ExportBar.tsx FX3 教訓：
    // 標註線因 DIM_OFFSET 外推會把 liner.bounds 撐大，直接拿整個 bounds 驗會跟這組自檢錨對不上。
    const geomOnly = segmentsBounds(liner.paths.filter((p) => p.type !== 'dimension').flatMap((p) => p.segments));
    expect(geomOnly.maxX - geomOnly.minX, '攤平外圍寬＝padW+2×flapDepth').toBeCloseTo(151.4, 6);
    expect(geomOnly.maxY - geomOnly.minY, '攤平外圍高＝padL+2×flapDepth').toBeCloseTo(206.4, 6);
  });

  it('底面 crease 周界四條（top/bottom/left/right），根部＝該邊全長（無翻邊/tab，免膠）', () => {
    const liner = generateLiner({ baseLength: 179, baseWidth: 124, thickness: 0.4, fitGap: 0.5, flapDepth: 15, idPrefix: 'liner', offsetX: 0, offsetY: 0 });
    const padCreases = liner.paths.filter((p) => p.type === 'crease' && p.tags?.includes('linerPad'));
    expect(padCreases, '底面周界四條 crease').toHaveLength(4);
    for (const side of ['top', 'bottom']) {
      const seg = padCreases.find((c) => c.tags?.includes(side))!.segments[0] as Extract<Segment, { kind: 'line' }>;
      expect(Math.abs(seg.x2 - seg.x1), `${side} 邊全長＝padW`).toBeCloseTo(121.4, 6);
    }
    for (const side of ['left', 'right']) {
      const seg = padCreases.find((c) => c.tags?.includes(side))!.segments[0] as Extract<Segment, { kind: 'line' }>;
      expect(Math.abs(seg.y2 - seg.y1), `${side} 邊全長＝padL`).toBeCloseTo(176.4, 6);
    }
  });

  it('翼片外緣（cut）較根部縮 2×flapDepth、兩端 45° 內斜（dx=dy=flapDepth）、四角空出讓位（免膠無 tab）', () => {
    const liner = generateLiner({ baseLength: 179, baseWidth: 124, thickness: 0.4, fitGap: 0.5, flapDepth: 15, idPrefix: 'liner', offsetX: 0, offsetY: 0 });
    const topFlap = liner.paths.find((p) => p.type === 'cut' && p.tags?.includes('linerFlap') && p.tags?.includes('top'))!;
    const lines = topFlap.segments as Extract<Segment, { kind: 'line' }>[];
    expect(lines, '翼片 cut＝斜切→外緣→斜切，共 3 段').toHaveLength(3);

    const [slantA, outerEdge, slantB] = lines;
    expect(Math.abs(outerEdge!.x2 - outerEdge!.x1), '外緣＝padW−2×flapDepth＝121.4−30').toBeCloseTo(91.4, 6);
    expect(Math.abs(outerEdge!.y2 - outerEdge!.y1), '外緣與根部平行（同一 y）').toBeCloseTo(0, 6);
    for (const slant of [slantA!, slantB!]) {
      expect(Math.abs(slant.x2 - slant.x1), '斜切 |dx|＝flapDepth').toBeCloseTo(15, 6);
      expect(Math.abs(slant.y2 - slant.y1), '斜切 |dy|＝flapDepth（45°：|dx|=|dy|）').toBeCloseTo(15, 6);
    }

    // 沒有任何 linerTab/linerWall 這類舊圍框版的 tag 殘留（免膠無 tab，構造徹底重定義）。
    const staleTags = liner.paths.flatMap((p) => p.tags ?? []).filter((t) => t === 'linerTab' || t === 'linerWall');
    expect(staleTags, '不應殘留圍框版的 linerTab/linerWall tag').toEqual([]);
  });

  it('t=0：底面公式仍是 fitGap 的一次函數（歸零項只剩 −2×fitGap），無 NaN', () => {
    const frame = deriveLinerFrame({ baseLength: 179, baseWidth: 124, thickness: 0, fitGap: 0.5 });
    expect(frame.padL).toBeCloseTo(179 - 1, 6);
    expect(frame.padW).toBeCloseTo(124 - 1, 6);
    const liner = generateLiner({ baseLength: 179, baseWidth: 124, thickness: 0, fitGap: 0.5, flapDepth: 15, idPrefix: 'liner', offsetX: 0, offsetY: 0 });
    expect(hasNaN(liner.paths.flatMap((p) => p.segments))).toBe(false);
  });

  it('offsetX/offsetY 對整體幾何做剛體平移（bounds 跟著平移相同量，同 tray 的版面位移慣例）', () => {
    const plain = generateLiner({ baseLength: 179, baseWidth: 124, thickness: 0.4, fitGap: 0.5, flapDepth: 15, idPrefix: 'liner', offsetX: 0, offsetY: 0 });
    const shifted = generateLiner({ baseLength: 179, baseWidth: 124, thickness: 0.4, fitGap: 0.5, flapDepth: 15, idPrefix: 'liner', offsetX: 50, offsetY: -30 });
    expect(shifted.bounds.minX - plain.bounds.minX).toBeCloseTo(50, 6);
    expect(shifted.bounds.minY - plain.bounds.minY).toBeCloseTo(-30, 6);
  });

  it('lidMarginX／lidMarginY 改變不影響 liner 片幾何尺寸（重定義核心語意：底面錨定＝下盒內淨，不再是上蓋內淨；F1 拆兩軸後兩軸都要驗）', () => {
    const a = genTelescope({ lidMarginX: 13.5, lidMarginY: 18.5 });
    const b = genTelescope({ lidMarginX: 20, lidMarginY: 40 });
    const dimsOf = (bd: { minX: number; maxX: number; minY: number; maxY: number }) => ({ w: bd.maxX - bd.minX, h: bd.maxY - bd.minY });
    const linerA = a.pieces!.find((p) => p.id === 'liner')!;
    const linerB = b.pieces!.find((p) => p.id === 'liner')!;
    expect(dimsOf(linerB.bounds), 'liner 片尺寸不隨 lidMarginX/lidMarginY 改變').toEqual(dimsOf(linerA.bounds));
  });
});

describe('telescope: pieces 分組（linerEnabled 開關／pieces-identity 防對調）', () => {
  it('linerEnabled=true（預設）→ pieces=[base,lid,liner]，各片 pathIds/textIds 非空，validatePieces 通過', () => {
    const result = genTelescope();
    expect(result.pieces?.map((p) => p.id)).toEqual(['base', 'lid', 'liner']);
    for (const piece of result.pieces!) {
      expect(piece.pathIds.length, `${piece.id} pathIds 應非空`).toBeGreaterThan(0);
      expect(piece.textIds.length, `${piece.id} textIds 應非空（3 條標註/2 條標註至少各有 text）`).toBeGreaterThan(0);
    }
    expect(validatePieces(result)).toEqual({ ok: true });
  });

  it('linerEnabled=false → pieces=[base,lid] 兩片，不產生任何 liner- 開頭的 path，validatePieces 通過', () => {
    const result = genTelescope({ linerEnabled: false });
    expect(result.pieces?.map((p) => p.id)).toEqual(['base', 'lid']);
    expect(result.paths.some((p) => p.id.startsWith('liner-')), '不應殘留任何 liner path').toBe(false);
    expect(validatePieces(result)).toEqual({ ok: true });
  });

  it('pieces-identity 不變式：預設參數下 base/lid 主面板實測與 baseLength/baseWidth/lidMarginX/lidMarginY 吻合', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'pieces-identity')!;
    expect(inv.check(params, result)).toMatchObject({ ok: true });
  });

  it('人為互換 base/lid 的 pathIds/textIds（模擬「pieces 整包對調」的迴歸）→ pieces-identity 應偵測不通過', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    const basePiece = result.pieces!.find((p) => p.id === 'base')!;
    const lidPiece = result.pieces!.find((p) => p.id === 'lid')!;
    const swapped: GenerateResult = {
      ...result,
      pieces: result.pieces!.map((p) => {
        if (p.id === 'base') return { ...p, pathIds: lidPiece.pathIds, textIds: lidPiece.textIds };
        if (p.id === 'lid') return { ...p, pathIds: basePiece.pathIds, textIds: basePiece.textIds };
        return p;
      }),
    };
    const inv = telescope.invariants.find((i) => i.id === 'pieces-identity')!;
    expect(inv.check(params, swapped)).toMatchObject({ ok: false });
  });
});

describe('telescope: rim-flush（base 先摺壁外壁高＝後摺壁外壁高−wallTopCompensation；lid 四面等高，B-06；F3 分流）', () => {
  it('預設參數下 rim-flush 通過', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'rim-flush')!;
    expect(inv.check(params, result)).toMatchObject({ ok: true });
  });

  it('thickness 假旋鈕（0／0.3／0.8）下 rim-flush 皆自洽通過（F3 解耦驗證：rim-flush 已不讀 thickness，只讀 wallTopCompensation，thickness 漂移不應影響結果）', () => {
    for (const thickness of [0, 0.3, 0.8]) {
      const params = resolveParams(telescope, { thickness });
      const result = telescope.generate(params);
      const inv = telescope.invariants.find((i) => i.id === 'rim-flush')!;
      expect(inv.check(params, result), `thickness=${thickness}`).toMatchObject({ ok: true });
    }
  });
});

describe('telescope: 標註起點對齊後摺壁外線（Fix1 review：yEdge 改讀 rootJog，不再讀 thickness）', () => {
  it('base/lid 壁高標註（type=dimension、tag=baseHeight/lidHeight）起點 y 座標，精確等於該片後摺壁（wallRoot back）雙 crease 外線的 y 座標', () => {
    // 預設參數 thickness=0.3 ≠ rootJog=0.5——足以區分「yEdge 讀 thickness（舊公式，偏差
    // 0.2mm）」與「yEdge 讀 rootJog（修正後，精確對齊）」，不需要額外覆寫參數。
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    const cases: Array<[string, string]> = [
      ['base', 'baseHeight'],
      ['lid', 'lidHeight'],
    ];
    for (const [pieceId, heightTag] of cases) {
      const piece = result.pieces!.find((p) => p.id === pieceId)!;
      const piecePaths = result.paths.filter((p) => piece.pathIds.includes(p.id));

      const rootBack = findTagged(piecePaths, 'wallRoot', 'back', 'crease');
      expect(rootBack, `${pieceId} wallRoot(back) 應恰有 1 條 path`).toHaveLength(1);
      const rootYs = allAlongValues(rootBack[0]!.segments, 'y');
      // back 側 sign=+1，離面板中心較遠（外線）的駐留值較大——見 tray.ts computeWallGeom
      // 的 outerStartAlong = rootAlong + sign×doubleGap 推導。
      const outerLineY = Math.max(...rootYs);

      const dim = piecePaths.filter((p) => p.type === 'dimension' && p.tags?.includes(heightTag));
      expect(dim, `${pieceId} 應恰有 1 條 tag=${heightTag} 的 dimension path`).toHaveLength(1);
      const dimYs = allAlongValues(dim[0]!.segments, 'y');
      const dimStartY = Math.min(...dimYs); // dimensionLine 兩端點 y＝{yEdge, yEdge+height}，較小者＝起點

      expect(
        dimStartY,
        `${pieceId} 壁高標註起點應精確對齊後摺壁外線（yEdge=panelW/2+rootJog；修正前讀 thickness 在預設參數下會偏 0.2mm）`,
      ).toBeCloseTo(outerLineY, 6);
    }
  });
});

describe('telescope: liner-flap-fits（2026-07-09 T7 gate 重定義——取代 liner-flange-fits，3 條參數域邊界）', () => {
  it('預設參數（flapDepth=15 < baseHeight=60，底面 176.8×121.8>0，flapDepth<底面邊長一半）通過', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    expect(inv.check(params, result)).toMatchObject({ ok: true });
  });

  it('條件 1——腳架深度超過下盒壁高（linerFlapDepth > baseHeight）→ 警告', () => {
    const params = resolveParams(telescope, { baseHeight: 10 }); // flapDepth 預設 15 > 10
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message.zh).toContain('頂出');
  });

  it('條件 1 邊界（非嚴格大於）：flapDepth 恰等於 baseHeight 時通過', () => {
    const params = resolveParams(telescope, { baseHeight: 15 }); // = 預設 linerFlapDepth
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    expect(inv.check(params, result)).toMatchObject({ ok: true });
  });

  it('條件 2——極端參數使底面非正值（padL/padW ≤ 0）→ 警告「底面不存在」（超出宣告 UI 範圍的防禦檢查）', () => {
    // resolveParams 不驗證 override 值域（只驗 key 存在），可用來直接構造超出宣告 min 的案例：
    // baseLength=1、linerFitGap=2 → baseInnerL=1−1.2=−0.2、padL=−0.2−4=−4.2<0。
    const params = resolveParams(telescope, { baseLength: 1, linerFitGap: 2 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message.zh).toContain('不存在');
  });

  it('條件 3——腳架深度超過底面邊長一半（翼片外緣反轉）→ 警告（單一 mm 參數 min/max 掃描會踩到的真實案例：baseWidth=30）', () => {
    // baseWidth=30（宣告 min）、其餘預設：padW=30−4×0.3−2×0.5=27.8，
    // flapDepth=15 > 27.8/2=13.9 → 翼片外緣＝27.8−30=−2.2<0，反轉。
    const params = resolveParams(telescope, { baseWidth: 30 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok, 'baseWidth=30 應觸發條件 3').toBe(false);
  });

  it('linerEnabled=false 時不適用（同 liner-flange-fits 舊慣例）：極端參數也不得假警告；同參數開內襯必警告', () => {
    const paramsOff = resolveParams(telescope, { linerEnabled: false, baseHeight: 10 });
    const resultOff = telescope.generate(paramsOff);
    for (const inv of telescope.invariants) {
      expect(inv.check(paramsOff, resultOff), `linerEnabled=false 時 ${inv.id} 不得警告`).toMatchObject({ ok: true });
    }
    const paramsOn = resolveParams(telescope, { linerEnabled: true, baseHeight: 10 });
    const flapInv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    expect(flapInv.check(paramsOn, telescope.generate(paramsOn)), '開內襯時同參數必警告').toMatchObject({ ok: false });
  });
});

describe('telescope: gusset-b-fits（薄壁角撐讓位槽最小壁高，minStyleBHeight 解析推導）', () => {
  it('minStyleBHeight 在 thickness=0/0.3/0.4/0.8 的值——獨立二分搜尋驗證過的錨（見 開發紀錄），非由公式自證', () => {
    // 這幾個數字是另外寫腳本、用 generateTray+hasSelfIntersection 對 height 做二分搜尋
    // 獨立算出來的（非從 minStyleBHeight 的公式反推），閉式解與搜尋結果殘差 <1e-5mm。
    expect(minStyleBHeight(0)).toBeCloseTo(16.1124, 3);
    expect(minStyleBHeight(0.3)).toBeCloseTo(16.6351, 3);
    expect(minStyleBHeight(0.4)).toBeCloseTo(16.8093, 3);
    expect(minStyleBHeight(0.8)).toBeCloseTo(17.5063, 3);
  });

  it('lidHeight 剛好低於門檻（platform=0）→ 警告；剛好高於→ 通過', () => {
    const threshold = minStyleBHeight(0.3); // 預設 thickness
    const below = resolveParams(telescope, { lidHeight: threshold - 0.5 });
    const above = resolveParams(telescope, { lidHeight: threshold + 0.5 });
    const inv = telescope.invariants.find((i) => i.id === 'gusset-b-fits')!;
    expect(inv.check(below, telescope.generate(below)), '低於門檻應警告').toMatchObject({ ok: false });
    expect(inv.check(above, telescope.generate(above)), '高於門檻應通過').toMatchObject({ ok: true });
  });

  it('basePlatformWidth=0 時（下盒改用薄壁）同樣受此門檻約束，不是只查 lid', () => {
    const threshold = minStyleBHeight(0.3);
    const params = resolveParams(telescope, { basePlatformWidth: 0, baseHeight: threshold - 0.5 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'gusset-b-fits')!;
    expect(inv.check(params, result)).toMatchObject({ ok: false });
  });

  it('門檻之上 0.5mm：與 hasSelfIntersection 交叉驗證，確認真的沒有自撞（不只是不變式沒報而已）', () => {
    const threshold = minStyleBHeight(0.3);
    const params = resolveParams(telescope, { lidHeight: threshold + 0.5 });
    const result = telescope.generate(params);
    const cutSegs = result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
    expect(hasSelfIntersection(cutSegs)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FX4（whole-branch review 查證）：telescope 不變式 tags 是否對應真實幾何
//
// 查證結論＝是 bug（見 src/boxes/telescope/index.ts 不變式區塊前的長註解）：Canvas.tsx
// 的 highlightTags 機制只認 `DielinePath.tags`（tray.ts/liner.ts 蓋的幾何 tag），不變式
// 回傳的 tags 若不是這個 vocabulary 裡的字串，高亮就是無聲的 no-op。下面針對修過的四條
// （liner-flange-fits／rim-flush／gusset-b-fits／tongue-flap-fits）逐一驗證：警告觸發時
// 回傳的 tags 必須至少有一個命中「真實 path 會用到的 tag 字典」。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: 不變式 tags 對應真實幾何（FX4——Canvas highlightTags 消費 path.tags，不是參數 key）', () => {
  /** 兩種常見組態（含/不含 liner、厚壁/薄壁角撐）的 path tags 聯集——當「真實 tag 字典」，
   *  用來驗證不變式回傳的 tags 不是憑空字串（未命中任何 path 等於 canvas 高亮 no-op）。 */
  function realPathTagVocabulary(): Set<string> {
    const withLiner = genTelescope();
    const withoutLinerThinWalls = genTelescope({ linerEnabled: false, basePlatformWidth: 0, lidPlatformWidth: 0 });
    const all = [...withLiner.paths, ...withoutLinerThinWalls.paths];
    return new Set(all.flatMap((p) => p.tags ?? []));
  }

  it('sanity：真實幾何存在 wallRoot/wallTop/gusset/tongueFlap/linerFlap，不存在 thickness/linerFitGap/basePlatformWidth/lidPlatformWidth/rootJog/innerWallReduction/wallTopCompensation 這些參數名字面', () => {
    const vocab = realPathTagVocabulary();
    for (const geometric of ['wallRoot', 'wallTop', 'gusset', 'tongueFlap', 'linerFlap']) {
      expect(vocab.has(geometric), `真實幾何應存在 tag「${geometric}」`).toBe(true);
    }
    // rootJog/innerWallReduction/wallTopCompensation（Slice 5 F3 新增）比照舊有四個參數，
    // highlightTags 一律用幾何 tag（'wallRoot'/'tongueFold'/'wallTop'）而非參數自己的 key，
    // 這裡延伸驗證新參數同樣沒有把 key 字面洩漏成 path tag。
    for (const paramKey of ['thickness', 'linerFitGap', 'basePlatformWidth', 'lidPlatformWidth', 'rootJog', 'innerWallReduction', 'wallTopCompensation']) {
      expect(vocab.has(paramKey), `真實幾何不應存在字面參數名 tag「${paramKey}」（否則本組測試沒有意義）`).toBe(false);
    }
  });

  it('liner-flap-fits：警告 tags 全部命中真實 path tag（2026-07-09 T7 gate 重定義，取代 liner-flange-fits）', () => {
    const vocab = realPathTagVocabulary();
    const params = resolveParams(telescope, { baseHeight: 10 }); // flapDepth 預設 15 > baseHeight 10
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'liner-flap-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok, 'baseHeight=10 應觸發警告').toBe(false);
    if (!outcome.ok) {
      expect(outcome.tags?.length ?? 0, '應至少有一個 tag').toBeGreaterThan(0);
      for (const tag of outcome.tags!) {
        expect(vocab.has(tag), `tag「${tag}」應命中至少一條真實 path（否則高亮 no-op）`).toBe(true);
      }
    }
  });

  it('rim-flush：警告 tags 命中真實 path tag（修前 thickness 不命中；合法參數域下 rim-flush 恆真，用構造的 fake result 直接觸發 check()；F3 解耦後改讀 wallTopCompensation）', () => {
    const vocab = realPathTagVocabulary();
    const fakeResult: GenerateResult = {
      paths: [
        { id: 'b-root-l', type: 'crease', tags: ['wallRoot', 'left'], segments: [{ kind: 'line', x1: -10, y1: -5, x2: -10, y2: 5 }] },
        { id: 'b-top-l', type: 'crease', tags: ['wallTop', 'left'], segments: [{ kind: 'line', x1: -20, y1: -5, x2: -20, y2: 5 }] },
        { id: 'b-root-back', type: 'crease', tags: ['wallRoot', 'back'], segments: [{ kind: 'line', x1: -5, y1: 8, x2: 5, y2: 8 }] },
        { id: 'b-top-back', type: 'crease', tags: ['wallTop', 'back'], segments: [{ kind: 'line', x1: -5, y1: 8.3, x2: 5, y2: 8.3 }] },
      ],
      texts: [],
      bounds: { minX: -20, maxX: 5, minY: -8, maxY: 8.3 },
      pieces: [
        {
          id: 'base',
          label: { zh: '下盒' },
          pathIds: ['b-root-l', 'b-top-l', 'b-root-back', 'b-top-back'],
          textIds: [],
          bounds: { minX: -20, maxX: 5, minY: -8, maxY: 8.3 },
        },
        {
          id: 'lid',
          label: { zh: '上蓋' },
          pathIds: ['b-root-l', 'b-top-l', 'b-root-back', 'b-top-back'],
          textIds: [],
          bounds: { minX: -20, maxX: 5, minY: -8, maxY: 8.3 },
        },
      ],
    };
    const inv = telescope.invariants.find((i) => i.id === 'rim-flush')!;
    // x 向外壁高（wallRoot~wallTop, left）=10、y 向外壁高（wallRoot~wallTop, back）=0.3，
    // 10 ≠ 0.3-0.3=0，構造的 fake result 讓 base 片這條關係不成立，直接觸發 not-ok。
    // F3 解耦：base 分支改讀 wallTopCompensation（不再是 thickness）——必須顯式提供這個 key，
    // 否則 undefined 會讓 base 分支的比較變成 NaN（恆 false，靜默跳過），退化成巧合命中
    // lid 分支（lid 分支不讀補償參數，10≠0.3 一樣會觸發）——那樣「會綠」的原因就錯了，
    // 不是這條測試原本要驗的 base 分支。
    const outcome = inv.check({ wallTopCompensation: 0.3 }, fakeResult);
    expect(outcome.ok, '構造的 x/y 外壁高差不等於 wallTopCompensation，應觸發警告').toBe(false);
    if (!outcome.ok) {
      expect(outcome.tags).toEqual(['wallRoot']);
      for (const tag of outcome.tags!) {
        expect(vocab.has(tag), `tag「${tag}」應命中至少一條真實 path（否則高亮 no-op）`).toBe(true);
      }
    }
  });

  it('gusset-b-fits：警告 tags 全部命中真實 path tag（修前 platformKey 不命中）', () => {
    const vocab = realPathTagVocabulary();
    const threshold = minStyleBHeight(0.3);
    const params = resolveParams(telescope, { lidHeight: threshold - 0.5 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'gusset-b-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok, 'lidHeight 低於門檻應警告').toBe(false);
    if (!outcome.ok) {
      expect(outcome.tags).toEqual(['gusset']);
      for (const tag of outcome.tags!) {
        expect(vocab.has(tag), `tag「${tag}」應命中至少一條真實 path（否則高亮 no-op）`).toBe(true);
      }
    }
  });

  it('tongue-flap-fits：警告 tags 含 tongueFlap 且全部命中真實 path tag（修前缺 tongueFlap）', () => {
    const vocab = realPathTagVocabulary();
    const params = resolveParams(telescope, { baseLength: 30 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'tongue-flap-fits')!;
    const outcome = inv.check(params, result);
    expect(outcome.ok, 'baseLength=30 應警告').toBe(false);
    if (!outcome.ok) {
      expect(outcome.tags).toContain('tongueFlap');
      for (const tag of outcome.tags!) {
        expect(vocab.has(tag), `tag「${tag}」應命中至少一條真實 path（否則高亮 no-op）`).toBe(true);
      }
    }
  });
});

describe('telescope: 全部不變式在預設參數下通過（linerEnabled 開關兩態都驗）', () => {
  it('linerEnabled=true（預設）', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    for (const inv of telescope.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
  });

  it('linerEnabled=false', () => {
    const params = resolveParams(telescope, { linerEnabled: false });
    const result = telescope.generate(params);
    for (const inv of telescope.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
  });

  it('t=0＋三補償（rootJog/innerWallReduction/wallTopCompensation）皆 0 時全部不變式仍通過（S5 等價形態；Slice 5 F3：三補償與 t 解耦後單獨 t=0 不再等價於全零 collapse，見 thickness 參數說明；兩態，原 review Minor 4 覆蓋範圍升級）', () => {
    // 原本只有 rim-flush 與 liner 導出鏈各自測過 t=0；補一個對全部不變式的迴圈，
    // 讓「collapse／歸零後幾何仍自洽」在不變式層有整體覆蓋（含 pieces-valid 的
    // 三向 bounds 等式——collapse 少一條線後 hull 仍須閉合）。F3 解耦後，thickness=0
    // 單獨不再讓 wallRoot/innerWall/outerWall 的補償歸零（那三處已改讀 rootJog／
    // innerWallReduction／wallTopCompensation），S5 等價形態要求四個都設 0。
    for (const linerEnabled of [true, false]) {
      const params = resolveParams(telescope, { thickness: 0, rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0, linerEnabled });
      const result = telescope.generate(params);
      for (const inv of telescope.invariants) {
        expect(inv.check(params, result), `${inv.id}（S5 全零, linerEnabled=${linerEnabled}）`).toMatchObject({ ok: true });
      }
    }
  });
});

describe('telescope: 假旋鈕（每個宣告參數都接線，spec §8；15 參數自動迴圈）', () => {
  // 通用 alt 規則（default+max(step,1)）對 basePlatformWidth 給 5→6，仍停在厚壁款內、
  // 跨不到 platform=0 的薄壁分支；顯式改用 0，讓這個旋鈕真的測到 A/B 角撐款式切換
  // （review Minor 3）。其餘參數維持通用規則（Slice 5 新增的 lidMarginX/lidMarginY/
  // rootJog/innerWallReduction/wallTopCompensation 五個都直接吃通用規則，皆有可偵測的
  // 幾何效果，見各自 highlightTags 對應的真實 path——不需要特例覆寫）。
  const ALT_OVERRIDES: Record<string, number> = { basePlatformWidth: 0 };

  it('每個參數取第二有效值都改變輸出', () => {
    // 原 10 個原參數 + linerFlapDepth ＝11（見 2026-07-09 T7 gate）。Slice 5 T1：
    // lidMargin 拆 lidMarginX/lidMarginY（+1）、F3 新增 rootJog/innerWallReduction/
    // wallTopCompensation（+3）——11+1+3＝15。
    expect(telescope.params, '11（舊）+1（lidMargin 拆兩軸）+3（F3 新增三補償）＝15').toHaveLength(15);
    const base = normalizeSegments(genTelescope().paths.flatMap((p) => p.segments));
    for (const param of telescope.params) {
      const alt =
        ALT_OVERRIDES[param.key] ??
        (param.unit === 'bool'
          ? !(param.default as boolean)
          : param.unit === 'enum'
            ? param.options!.find((o) => o.value !== param.default)!.value
            : Math.min(param.max ?? 999, (param.default as number) + Math.max(param.step ?? 1, 1)));
      const out = normalizeSegments(genTelescope({ [param.key]: alt }).paths.flatMap((s) => s.segments));
      expect(out, `參數 ${param.key} 未接線`).not.toEqual(base);
    }
  });
});

describe('telescope: golden 快照（預設參數，t=0.3）', () => {
  it('golden 快照', () => {
    const result = genTelescope();
    expect(normalizeSegments(result.paths.flatMap((p) => p.segments))).toMatchSnapshot();
  });
});
