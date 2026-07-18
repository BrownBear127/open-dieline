import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, hasSelfIntersection, normalizeSegments, segmentsBounds } from '@/core/geometry';
import { segmentsToSvgD } from '@/core/path';
import type { DielinePath, GenerateResult, LineType } from '@/core/types';
import { generateTray, type TrayOpts } from '@/boxes/telescope/tray';
import { getBox, resolveParams } from '@/core/registry';
import { telescope, minStyleBHeight } from '@/boxes/telescope';
import { deriveLinerFrame, generateLiner } from '@/boxes/telescope/liner';
import { validatePieces } from '@/core/pieces';
import fixtureRaw from './fixtures/telescope-production-details.json';

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

/**
 * Fix 1（Medium，2026-07-11 re-review）四角逐段固定迴歸專用：把 T0 fixture 的原始 P-mm
 * 座標（`telescope-production-details.json` 的 `aGussetPeriphery_reliefChain`／
 * `aGussetPeriphery_tenDegCuts` 系列欄位）平移到 generateTray() 的面板中心局部座標系。
 * 純平移（無旋轉/縮放）——由 abToXY(corner,sx,sy,{a,b})=corner+sx·a+sy·b 與 fixture 端
 * 反推出的 (a,b)=sx·(P−fixtureCorner) 代數消去 sx/sy（sx²=sy²=1 恆成立）後可得
 * world=fixtureP+(codeCorner−fixtureCorner)——與 tray.ts 的 A_GUSSET_* 常數表無關
 * （直接讀 fixture 原始座標，不透過程式的常數表，避免「測試抄實作常數」的重言式）。
 */
function fixtureChainToWorld(
  entries: Array<{ p1_mm: number[]; p2_mm: number[]; gid?: string }>,
  translate: { x: number; y: number },
): Array<{ x1: number; y1: number; x2: number; y2: number; gid: string }> {
  return entries.map((e) => ({
    x1: e.p1_mm[0]! + translate.x,
    y1: e.p1_mm[1]! + translate.y,
    x2: e.p2_mm[0]! + translate.x,
    y2: e.p2_mm[1]! + translate.y,
    gid: e.gid ?? '?',
  }));
}

const EPS = 1e-6;

/**
 * 「同線型（LineType）共線區間重疊」偵測（Slice 5 Fix2·review Finding 1 新增，通用
 * helper 供之後 task 沿用）——補既有兩種檢查之間的缺口：
 * - `hasSelfIntersection`（core/geometry.ts）刻意排除共線重疊（刀模轉角正常銜接，不是
 *   幾何錯誤），抓不到這裡要抓的東西；
 * - 本檔「無同型重複線段」測試（見 't/rootJog/.../全零' 案例）用 normalizeSegments 端點
 *   正規化比對，只抓「兩條線段端點集合完全相同」，抓不到「短線完整落在長線內」這種
 *   部分重複（Finding 1 原始 bug：jog 短段與角撐 y 軸摺線 0.5mm 共線重疊，兩者端點都
 *   不同，不是同一組端點）。
 * 回傳重疊描述陣列（空＝無重疊）。ANGLE_TOL 判平行（正規化方向向量的叉積，無量綱）、
 * DIST_TOL 判同線＋量重疊長度（mm，遠低於刀模物理精度）。
 */
function findCollinearOverlaps(paths: DielinePath[]): string[] {
  const ANGLE_TOL = 1e-6;
  const DIST_TOL = 1e-4;
  type Entry = { pathId: string; seg: LineSeg };
  const byType = new Map<LineType, Entry[]>();
  for (const p of paths) {
    for (const s of p.segments) {
      if (s.kind !== 'line') continue;
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 1e-9) continue; // 零長度另有專門檢查
      const list = byType.get(p.type) ?? [];
      list.push({ pathId: p.id, seg: s });
      byType.set(p.type, list);
    }
  }
  const overlaps: string[] = [];
  for (const [type, entries] of byType) {
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]!.seg;
      const lenA = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      const ux = (a.x2 - a.x1) / lenA;
      const uy = (a.y2 - a.y1) / lenA;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j]!.seg;
        const lenB = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
        const vx = (b.x2 - b.x1) / lenB;
        const vy = (b.y2 - b.y1) / lenB;
        if (Math.abs(ux * vy - uy * vx) > ANGLE_TOL) continue; // 不平行
        const perpDist = Math.abs((b.x1 - a.x1) * uy - (b.y1 - a.y1) * ux);
        if (perpDist > DIST_TOL) continue; // 平行但不共線
        const proj = (x: number, y: number) => (x - a.x1) * ux + (y - a.y1) * uy;
        const bMin = Math.min(proj(b.x1, b.y1), proj(b.x2, b.y2));
        const bMax = Math.max(proj(b.x1, b.y1), proj(b.x2, b.y2));
        const overlapLen = Math.min(lenA, bMax) - Math.max(0, bMin);
        if (overlapLen > DIST_TOL) {
          overlaps.push(`${type}: ${entries[i]!.pathId} 與 ${entries[j]!.pathId} 共線重疊 ${overlapLen.toFixed(4)}mm`);
        }
      }
    }
  }
  return overlaps;
}

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

// lid 測試固定參數：t=0.4、H=45、platform=0、panel 151(x)×206(y)。
// wallTopCompensation=0（B-06：上蓋左右壁的頂緣平齊特例移除，四面外壁恆＝壁高，模擬
// index.ts buildLidPiece 對 generateTray 的真實呼叫方式，見該函式）。
// ⚠ F3 review Fix（2026-07-11）：panelW=206 不是 P 實測值——P 實測 panelW=216
// （fixtureRaw.lid.panel.corners_mm 四角互證：bottomLeft.y−topLeft.y=215.9988，見 F1/F2
// review Fix report）。本檔 F1/F5/F6-B 絕大多數測試（含 S1 param-sweep「reservedSpan=
// 187.204」一類註解）長期沿用這個 206 做結構/公式自洽驗證，非逐項對 P；改動會牽動數十處
// 既有斷言（超出本 Low finding 範圍，未動）。需要驗證真正 production-P 尺寸時，用局部
// override `{ ...lidOpts, panelW: 216 }`（見「production-P 版本」系列測試），不要改這個
// 共用常數本身。
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

    // Slice 5 F4：A 款舌摺線含 U-notch（cut，開口/底/圓角座標各異，非單純 along 定值線）
    // ＋halfcut 分段（各段仍在同一 along=tongueFoldAlong）——取 along 值改查 halfcut
    // （對 A/B 兩款都是「沿線各段 along 皆定值」的可靠來源，notch 的 cut 不是）。
    const tongueFoldHalfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    expect(tongueFoldHalfcut.length).toBeGreaterThan(0);
    const tongueFoldAlong = alongOf(tongueFoldHalfcut[0]!.segments[0]!, 'x');

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

  it('y 向（後摺壁）駐留間距：階梯 jog gap=rootJog=0.5、外壁 60、平台 5、內壁 59.2、舌 15', () => {
    const result = generateTray(baseOpts);
    const halfW = baseOpts.panelW / 2;

    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    // Slice 5 F2：階梯 jog 取代舊「雙 crease 根」——中央 offset crease（跨整個 perp 範圍）＋
    // 兩端各一段 jog 短接段，共 3 段；但仍只有 2 個相異駐留座標（nominal/offset），
    // doubleCreaseGap 的抽取語意不變（用 allAlongValues 寬鬆抽取，不假設每段都是定值線）。
    expect(root[0]!.segments, 'y 向 wallRoot 應有 3 段（中央 offset crease＋兩端 jog 短段，baseOpts=A 款獨立短線）').toHaveLength(3);
    const rootAlongs = [...new Set(allAlongValues(root[0]!.segments, 'y'))].sort((a, b) => a - b);
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

    // Slice 5 F4：改查 halfcut（沿線各段 along 皆定值＝tongueFoldAlong，notch 的 cut 不是，見上方 x 向測試同款修正）。
    const tongueFoldHalfcut = findTagged(result.paths, 'tongueFold', 'back', 'halfcut');
    const tongueFoldAlong = alongOf(tongueFoldHalfcut[0]!.segments[0]!, 'y');
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

  it('線型斷言（Slice 5 F4 retire：A 款舊「兩端 9mm cut 讓位」語意退役，改 U-notch 切段拓撲）：左右壁（長壁，2 notch）halfcut 3 段＋notch cut 10 段（2×5）', () => {
    const result = generateTray(baseOpts);
    const halfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    const notchCut = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    expect(halfcut.length, '舌摺線應有 halfcut 型別的路徑（notch 之間與角落 reach 之間的段）').toBe(1);
    expect(notchCut.length, '舌摺線應有 cut 型別的路徑（U-notch 本身，full-cut）').toBe(1);
    expect(halfcut[0]!.segments, '長壁（左右）2 notch → 3 段 halfcut（reach↔notch1／notch1↔notch2／notch2↔reach）').toHaveLength(3);
    expect(notchCut[0]!.segments, '2 個 U-notch，每個 5 段（2 line＋2 arc＋1 底線）＝10 段').toHaveLength(10);
    expect(notchCut[0]!.tags).toContain('uNotch');
  });

  it('線型斷言（同上，短壁）：前後壁（短壁，1 notch 置中）halfcut 2 段＋notch cut 5 段', () => {
    const result = generateTray(baseOpts);
    const halfcut = findTagged(result.paths, 'tongueFold', 'back', 'halfcut');
    const notchCut = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(halfcut[0]!.segments, '短壁（前後）1 notch 置中 → 2 段 halfcut（reach↔notch 兩側各一）').toHaveLength(2);
    expect(notchCut[0]!.segments, '1 個 U-notch＝5 段').toHaveLength(5);
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
      // F2 階梯 jog 後 wallRoot(back) 可能有 3 段（中央+兩端短段），連 jog 短段一起用寬鬆
      // 的 allAlongValues 抽取（不能用 alongOf——它假設每段在該軸上是定值，jog 短段本身
      // 就是「該軸不是定值」的線，直接呼叫會擲錯）。
      const gapAlongs = [...new Set(allAlongValues(rootBack[0]!.segments, 'y'))].sort((a, b) => a - b);
      const doubleCreaseGap = gapAlongs[1]! - gapAlongs[0]!;

      const rootLeft = findTagged(result.paths, 'wallRoot', 'left', 'crease');
      const topLeft = findTagged(result.paths, 'wallTop', 'left', 'crease');
      const rootAlong = alongOf(rootLeft[0]!.segments[0]!, 'x');
      const topAlongs = [...new Set(topLeft[0]!.segments.map((s) => alongOf(s, 'x')))].sort(
        (a, b) => Math.abs(a - rootAlong) - Math.abs(b - rootAlong),
      );
      const outerWall = Math.abs(topAlongs[0]! - rootAlong);

      // Slice 5 F4：改查 halfcut（見前面兩則 x/y 向間距測試同款修正）。
      const tongueFoldHalfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
      const tongueFoldAlong = alongOf(tongueFoldHalfcut[0]!.segments[0]!, 'x');
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

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 F2：wallRoot 階梯 jog——退役「中央面板兩條 full-length 平行 crease」，改為
// 分段 stagger（中央留外移後那一條、兩端是否補 jog 短段依 A／B 款而異）。生產依據：P
// （天地盒刀模.svg）逐 entity 反推，下盒（A 款）LINE204/206/207＝中央 crease＋兩端各自
// 獨立的短 jog 段（P:734-756）；上蓋（B 款）LINE242＝只有中央線，沒有獨立短線 entity，
// nominal↔offset 區間落在既有角撐 y 軸 web 摺線（LINE240/245）路徑內（P:797-861）——本檔
// baseOpts(platformWidth=5)＝A 款、lidOpts(platformWidth=0)＝B 款，與 generateTray 內部
// useThickStyle 判準一致。
//
// Slice 5 Fix2（review Finding 1）：本區塊原本誤判 B 款「nominal→offset→offset→
// nominal 併成一筆連續 lineTo 鏈」——逐 entity 對照 P 原始 SVG 後證實這是錯的，B 根本不
// 該有 nomNeg/nomPos 這兩個端點；正確形態＝wallRoot 只留中央 offset crease，nominal 端
// 由角撐（gussetFold）既有的 y 軸摺線涵蓋，不重畫。舊實作因此在 A/B 兩款都與 gussetFold
// 的 y 軸摺線同線型共線重疊 rootJog（A 端點對齊 nominal 角落、B 多畫了兩段）；修法：A 款
// 把 gussetFold y 軸摺線起點移到 offset（見 tray.ts buildGussetA），B 款 wallRoot 直接
// 不畫 jog 短段。下面測試改為逐 entity 座標驗證＋共線重疊掃描，不再只看 segmentsToSvgD
// 的 M 指令數（B 款退化成單段後，M 數本身已不再能反映「有沒有多畫 jog」）。
// ─────────────────────────────────────────────────────────────────────────

describe('generateTray: F2 階梯 jog（wallRoot 分段 stagger 取代 full-length 雙 crease）', () => {
  it('結構斷言：中央無 full-length 平行雙 crease——wallRoot(back) 只有 1 段有 perp 方向延伸（舊結構是 2 段）', () => {
    const result = generateTray(baseOpts);
    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    expect(root).toHaveLength(1);
    // perp 方向（y 向牆＝x 軸）有延伸的線段＝候選「跨全 perp 範圍」的 crease；退役前的舊
    // 結構會有 2 段（nominal 一條、offset 一條，皆全長平行）。中央只留外移後那一條，
    // 兩端 jog 短段本身是零 perp 位移（純 along 方向），不會被這個篩選誤算進來。
    const perpExtentSegs = root[0]!.segments.filter((s) => s.kind === 'line' && Math.abs(s.x2 - s.x1) > 1e-6);
    expect(perpExtentSegs, '應恰有 1 段有 perp 延伸（中央 offset crease），不是 2 段 full-length 平行線').toHaveLength(1);
    expect(Math.abs((perpExtentSegs[0] as Extract<Segment, { kind: 'line' }>).x2 - (perpExtentSegs[0] as Extract<Segment, { kind: 'line' }>).x1), '該段應跨整個 perp 全長（panelL）').toBeCloseTo(baseOpts.panelL, 6);
  });

  it('jog 短段存在性（A 款）：兩端各一段，零 perp 位移、長度=rootJog', () => {
    const result = generateTray(baseOpts);
    const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
    const jogSegs = root[0]!.segments.filter((s) => {
      if (s.kind !== 'line') return false;
      const perpDelta = Math.abs(s.x2 - s.x1);
      const alongDelta = Math.abs(s.y2 - s.y1);
      return perpDelta < 1e-9 && Math.abs(alongDelta - baseOpts.rootJog) < 1e-6;
    });
    expect(jogSegs, '應有 2 段零 perp 位移、長度=rootJog 的短接段（兩端各一，接回 nominal 角落）').toHaveLength(2);
  });

  it('A／B entity 形態差異：base（A 款）中央＋兩端 jog 三段互不相連，逐 entity 座標對照；lid（B 款）僅中央 offset 一段、不新增 jog（Slice 5 Fix2·Finding 1 校正，P:LINE204/206/207 vs P:LINE242）', () => {
    const baseRootPaths = findTagged(generateTray(baseOpts).paths, 'wallRoot', 'back', 'crease');
    const lidRootPaths = findTagged(generateTray(lidOpts).paths, 'wallRoot', 'back', 'crease');
    const baseRoot = baseRootPaths[0]!;
    const lidRoot = lidRootPaths[0]!;

    const baseHalfL = baseOpts.panelL / 2;
    const baseNominal = baseOpts.panelW / 2;
    const baseOffset = baseNominal + baseOpts.rootJog;
    expect(baseRoot.segments, 'A 款仍是 3 段（中央 offset crease＋兩端 jog）').toHaveLength(3);
    expectLine(baseRootPaths, -baseHalfL, baseOffset, baseHalfL, baseOffset, EPS, 'A 中央 offset crease（跨整個 perp 全長）');
    expectLine(baseRootPaths, -baseHalfL, baseNominal, -baseHalfL, baseOffset, EPS, 'A 負端 jog 短段（nominal→offset）');
    expectLine(baseRootPaths, baseHalfL, baseOffset, baseHalfL, baseNominal, EPS, 'A 正端 jog 短段（offset→nominal）');

    const lidHalfL = lidOpts.panelL / 2;
    const lidOffset = lidOpts.panelW / 2 + lidOpts.rootJog;
    expect(lidRoot.segments, 'B 款只有 1 段（中央 offset crease），不新增獨立 jog 短段（Finding 1 修正：舊版誤多畫了 nomNeg→offNeg／offPos→nomPos 兩段）').toHaveLength(1);
    expectLine(lidRootPaths, -lidHalfL, lidOffset, lidHalfL, lidOffset, EPS, 'B 中央 offset crease（跨整個 perp 全長）');

    // segmentsToSvgD 的 M 指令數是這個結構差異的匯出投影，仍可作輔助交叉驗證（A 三段
    // 互不相連＝3 個 M；B 現在退化成單段＝1 個 M——這裡數字巧合跟舊版一樣，但語意完全
    // 不同：舊版的 1 是「4 端點一筆連續」、新版的 1 是「根本只有 1 段」，上面座標級
    // 斷言才是真正驗到差異的地方，M 數只是順帶驗證匯出投影沒有跟著壞掉）。
    expect((segmentsToSvgD(baseRoot.segments).match(/M/g) ?? []).length).toBe(3);
    expect((segmentsToSvgD(lidRoot.segments).match(/M/g) ?? []).length).toBe(1);
  });

  it('B 款（lid）entity 結構驗證：wallRoot(back) 中央 offset crease 兩端由相鄰角落 gussetFold 的 y 軸摺線涵蓋 nominal→offset（Finding 1：不得留缺口，也不得共線重疊）', () => {
    const result = generateTray(lidOpts);
    const halfW = lidOpts.panelW / 2;
    const nominal = halfW;
    const offset = halfW + lidOpts.rootJog;

    for (const { label, cornerX } of [
      { label: 'left-back', cornerX: -lidOpts.panelL / 2 },
      { label: 'right-back', cornerX: lidOpts.panelL / 2 },
    ]) {
      const folds = findTagged(result.paths, 'gussetFold', label, 'crease')[0]!;
      const yFold = (folds.segments as LineSeg[]).find((s) => Math.abs(s.x1 - cornerX) < EPS && Math.abs(s.x2 - cornerX) < EPS);
      expect(yFold, `${label}: 應有 x=${cornerX} 的 y 向 web 摺線`).toBeDefined();
      const yMin = Math.min(yFold!.y1, yFold!.y2);
      const yMax = Math.max(yFold!.y1, yFold!.y2);
      expect(Math.min(Math.abs(yMin - nominal), Math.abs(yMax - nominal)), `${label}: 摺線應有一端精確在 nominal=${nominal}（B 款不變的既有行為）`).toBeLessThan(EPS);
      expect(offset, `${label}: 摺線範圍 [${yMin},${yMax}] 應涵蓋 offset=${offset}（否則 wallRoot 中央段與摺線之間會留缺口）`).toBeGreaterThanOrEqual(yMin - EPS);
      expect(offset).toBeLessThanOrEqual(yMax + EPS);
    }
  });

  it('無同線型共線區間重疊（baseOpts/lidOpts 預設 rootJog=0.5，非 collapse 案例）：Finding 1 原始 bug——jog 短段與角撐 y 軸摺線重疊 0.5mm——不得再現', () => {
    for (const opts of [baseOpts, lidOpts]) {
      const overlaps = findCollinearOverlaps(generateTray(opts).paths);
      expect(overlaps, `${opts.idPrefix}: ${overlaps.join('; ')}`).toEqual([]);
    }
  });

  it('rootJog=0 時（S5 等價形態）A／B 兩款皆收斂為單一共線 crease，無重複線', () => {
    for (const opts of [baseOpts, lidOpts]) {
      const result = generateTray({ ...opts, rootJog: 0 });
      const root = findTagged(result.paths, 'wallRoot', 'back', 'crease');
      expect(root, `${opts.idPrefix}`).toHaveLength(1);
      expect(root[0]!.segments, `${opts.idPrefix}: rootJog=0 應 collapse 為單一共線 crease（A/B 款差異在此退化，不適用）`).toHaveLength(1);
    }
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

    // web 摺線：角落沿兩軸到 V3/V4（reach = H−wallTopCompensation = 59.5——Fix 4·2026-07-11
    // review M4：先前殘留 height−thickness 舊公式＝59.6，T1 參數遷移漏網已修正，
    // P 實測長壁 outerWall=59.4995 對 59.5 差 0.0005mm ✓，對舊公式 59.6 差 0.1005mm）。
    // y 軸摺線起點在 offset（cornerY+rootJog=89.5+0.5=90.0，Slice 5 Fix2·review
    // Finding 1：避免與相鄰 wallRoot jog 短段共線重疊，見 buildGussetA）；x 軸摺線起點
    // 仍在角落——x 向牆無 jog。
    expectLine(folds, 62, 89.5, 121.5, 89.5, T, 'A web 摺線（x 軸）');
    expectLine(folds, 62, 90.0, 62, 149.0, T, 'A web 摺線（y 軸，起點在 offset）');

    // 對角線：角落半段 cut、外半段 crease（單軸位移 25.2906 級——diagHalf 只吃 height，
    // 不吃 reach，Fix 4 不影響這兩條）
    const diagCut = g.filter((p) => p.type === 'cut');
    const diagCrease = g.filter((p) => p.type === 'crease');
    expectLine(diagCut, 62, 89.5, 87.2906, 114.7906, 1e-4, 'A 對角 cut 半段');
    expectLine(diagCrease, 87.2906, 114.7906, 112.5812, 140.0812, 1e-4, 'A 對角 crease 半段');

    // 外緣斜切：V4→tip→V3
    expectLine(diagCut, 62, 149.0, 112.5812, 140.0812, 1e-4, 'A 外緣 V4→tip');
    expectLine(diagCut, 112.5812, 140.0812, 121.5, 89.5, 1e-4, 'A 外緣 tip→V3');

    // 牆側邊 cut 從錨點（V3/V4）起，不得在角落到錨點之間有 cut（web 與牆相連）
    const rightWallSide = findTagged(result.paths, 'wallSide', 'right', 'cut');
    const sideXs = allAlongValues(rightWallSide[0]!.segments, 'x');
    expect(Math.min(...sideXs), 'x 向牆側邊 cut 應從 V3（62+59.5）起').toBeCloseTo(121.5, 6);
    const backWallSide = findTagged(result.paths, 'wallSide', 'back', 'cut');
    const sideYs = allAlongValues(backWallSide[0]!.segments, 'y');
    expect(Math.min(...sideYs), 'y 向牆側邊 cut 應從 V4（89.5+59.5）起').toBeCloseTo(149.0, 6);
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
// Slice 5 F4／F6-A（Task 3）：U-notch＋halfcut 分段＋平台角撐周邊複合 relief 鏈。
// baseOpts 的 panelL=124/panelW=179 與 production-P 完全相同（僅 thickness=0.4≠0.44，
// 但本節測項全不依賴 thickness——notch/halfcut/角撐周邊鏈皆與 t 無關），故座標／長度
// 錨可直接對 T0 座標表（tests/fixtures/telescope-production-details.json）±0.05 對算。
// ─────────────────────────────────────────────────────────────────────────

describe('generateTray: F4 U-notch＋halfcut 分段（A 款專屬，T0 座標表對算）', () => {
  const T = 0.05; // T0 對算容差

  it('側壁（左右壁，長壁）雙 notch 中心比例＝±(29.3385/179)×sideRootSpan（panelW=179 時精確為 ±29.3385）', () => {
    const result = generateTray(baseOpts);
    const notch = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    expect(notch, '左壁應恰有 1 條 notch cut path').toHaveLength(1);
    // 底線（26mm 直線，非圓角）的中點＝notch 中心；兩個 notch 各一條，用長度=26 篩出。
    const baseLines = (notch[0]!.segments as LineSeg[]).filter((s) => Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - 26) < 1e-6);
    expect(baseLines, '2 個 notch，各 1 條 26mm 底線').toHaveLength(2);
    const centers = baseLines.map((s) => (s.y1 + s.y2) / 2).sort((a, b) => a - b);
    expect(centers[0]).toBeCloseTo(-29.3385, 2);
    expect(centers[1]).toBeCloseTo(29.3385, 2);
  });

  it('上下壁（前後壁，短壁）單 notch 置中：底線中點＝0', () => {
    const result = generateTray(baseOpts);
    const notch = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(notch).toHaveLength(1);
    const baseLine = (notch[0]!.segments as LineSeg[]).find((s) => Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - 26) < 1e-6)!;
    expect(baseLine, '應找到 1 條 26mm 底線').toBeDefined();
    expect((baseLine.x1 + baseLine.x2) / 2, '短壁 notch 置中，底線中點＝0').toBeCloseTo(0, 6);
  });

  it('U-notch nominal 尺寸：開口 30／底 26／深 4.2／R2×12（左壁校準點，T0 對算 ±0.05）', () => {
    const result = generateTray(baseOpts);
    const notch = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    const tongueFoldHalfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    const alongOpening = alongOf(tongueFoldHalfcut[0]!.segments[0]!, 'x');
    const segs = notch[0]!.segments as LineSeg[];

    // 左壁單壁 2 個 notch×2 弧＝4；6 notch×2＝12 的全域計數見 telescope-fixture.test.ts
    // 的「F4／F6-A production-P 錨」（跨全部 4 面壁彙總）。
    const arcs = notch[0]!.segments.filter((s): s is ArcSeg => s.kind === 'arc');
    expect(arcs, '左壁 2 個 notch×2 弧＝4 個 R2 弧').toHaveLength(4);
    for (const a of arcs) expect(a.r, 'notch 圓角半徑 R2').toBeCloseTo(2, 6);

    // 「開口端」短直線：恰有一端落在 along=alongOpening（notch 開口與 tongueFold 邊緣重合，
    // 見 tray.ts uNotchSegments 註解）；兩條的 perp 值相減＝開口寬 30。
    const openingTouching = segs.filter((s) => Math.abs(s.x1 - alongOpening) < 1e-6 || Math.abs(s.x2 - alongOpening) < 1e-6);
    const leftWallOpeningTouching = openingTouching.filter((s) => Math.abs(s.y1 - -29.3385) < 20 || Math.abs(s.y2 - -29.3385) < 20);
    expect(leftWallOpeningTouching, '負側 notch（s_center=-29.3385）應有 2 條開口端短直線').toHaveLength(2);
    const openingYs = leftWallOpeningTouching.map((s) => (Math.abs(s.x1 - alongOpening) < 1e-6 ? s.y1 : s.y2));
    expect(Math.abs(openingYs[1]! - openingYs[0]!), '開口寬＝30').toBeCloseTo(30, 1);

    // 底線（26mm 直線）與開口（alongOpening）的 along 差＝深度 4.2。
    const baseLine = segs.find((s) => Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - 26) < 1e-3 && Math.abs(s.y1 - -29.3385) < 20)!;
    expect(baseLine, '應找到 26mm 底線').toBeDefined();
    expect(Math.abs(baseLine.x1 - alongOpening), 'notch 深度＝4.2').toBeCloseTo(4.2, 2);
  });

  it('halfcut 分段長度：左壁 3 段 23.661/28.677/23.661、前壁 2 段 45.000×2（T0 對算 ±0.05，與 thickness 無關）', () => {
    const result = generateTray(baseOpts);
    const leftHalfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    const leftLens = (leftHalfcut[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1)).sort((a, b) => a - b);
    expect(leftLens, '左壁 3 段（T0：23.6608/28.6773/23.6608）').toHaveLength(3);
    expect(leftLens[0]).toBeCloseTo(23.6608, 1);
    expect(leftLens[1]).toBeCloseTo(23.6608, 1);
    expect(leftLens[2]).toBeCloseTo(28.6773, 1);

    const frontHalfcut = findTagged(result.paths, 'tongueFold', 'front', 'halfcut');
    const frontLens = (frontHalfcut[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(frontLens, '前壁 2 段（T0：45.0003×2）').toHaveLength(2);
    for (const l of frontLens) expect(l).toBeCloseTo(45.0003, 1);

    const totalAllWalls =
      leftLens.reduce((a, b) => a + b, 0) * 2 + // 左右壁對稱
      frontLens.reduce((a, b) => a + b, 0) * 2; // 前後壁對稱
    expect(Math.abs(totalAllWalls - 332.0), `halfcut 總長 ${totalAllWalls.toFixed(4)}`).toBeLessThanOrEqual(0.5);
  });

  it('降級：notch-omitted（壁長<40）與 notch-reduced（壁長不足容納兩個但仍≥40）改變 notch/halfcut 結構', () => {
    // panelW=35（短壁 span<40）→ 全省，halfcut 應收斂為單一整段
    const omitted = generateTray({ ...baseOpts, panelL: 35 });
    const frontNotchOmitted = findTagged(omitted.paths, 'tongueFold', 'front', 'cut');
    expect(frontNotchOmitted, 'panelL=35＜40，前壁 notch 應全省').toHaveLength(0);
    const frontHalfcutOmitted = findTagged(omitted.paths, 'tongueFold', 'front', 'halfcut');
    expect(frontHalfcutOmitted[0]!.segments, '全省後 halfcut 收斂為單一整段').toHaveLength(1);

    // panelW=90（長壁 span<比例雙 notch 門檻(~106.87)但≥40，且留給角落 reach(21.5018×2)
    // 與 notch 半寬(15) 的空間仍為正——見 A_CHAIN_REACH_LONGWALL 常數；panelW 太小會讓
    // halfcut 邊界公式退化出負長度段，那是另一個獨立的參數域邊界，不是本測項要驗的東西）
    // → 退化為單一置中 notch。
    const reduced = generateTray({ ...baseOpts, panelW: 90 });
    const leftNotchReduced = findTagged(reduced.paths, 'tongueFold', 'left', 'cut');
    expect(leftNotchReduced[0]!.segments, 'panelW=90 退化為單一 notch＝5 段').toHaveLength(5);
    const leftHalfcutReduced = findTagged(reduced.paths, 'tongueFold', 'left', 'halfcut');
    expect(leftHalfcutReduced[0]!.segments, '單一置中 notch → 2 段 halfcut').toHaveLength(2);
  });
});

describe('generateTray: F6-A 平台端內縮＋角撐周邊複合 relief 鏈（A 款專屬，T0 座標表對算）', () => {
  it('平台端第二條 crease 兩端內縮：長壁(左右) 4.5mm／短壁(前後) 5.0mm（spec nominal）', () => {
    const result = generateTray(baseOpts);
    const halfW = baseOpts.panelW / 2;
    const halfL = baseOpts.panelL / 2;
    // 左壁（x 向牆）：crease 沿 toXY('x',along,perp)={x:along,y:perp}——同一 along 的 crease
    // 兩端點 x 相同（定值）、y（perp，即壁長方向）才是要驗內縮的軸。
    const leftTop = findTagged(result.paths, 'wallTop', 'left', 'crease');
    const insetSeg = (leftTop[0]!.segments as LineSeg[]).find((s) => Math.abs(s.x1 - s.x2) < 1e-6 && Math.abs(s.y1) < halfW)!;
    expect(insetSeg, '應找到內縮的第二條 crease（perp 跨距 < 壁全寬）').toBeDefined();
    expect(halfW - Math.abs(insetSeg.y1), '長壁內縮量＝4.5').toBeCloseTo(4.5, 6);

    // 後壁（y 向牆）：crease 沿 toXY('y',along,perp)={x:perp,y:along}——y 定值、x（壁長方向）內縮。
    const backTop = findTagged(result.paths, 'wallTop', 'back', 'crease');
    const insetSegY = (backTop[0]!.segments as LineSeg[]).find((s) => Math.abs(s.y1 - s.y2) < 1e-6 && Math.abs(s.x1) < halfL)!;
    expect(insetSegY, '短壁應同樣找到內縮的第二條 crease').toBeDefined();
    expect(halfL - Math.abs(insetSegY.x1), '短壁內縮量＝5.0').toBeCloseTo(5.0, 6);
  });

  it('4 個角落皆有平台角圓角（platformCorner，R2.5）＋角撐周邊複合鏈（aGussetPeriphery，13 段，僅 cut 無 crease）', () => {
    const result = generateTray(baseOpts);
    for (const label of ['right-back', 'right-front', 'left-back', 'left-front']) {
      const corner = findTagged(result.paths, 'platformCorner', label, 'cut');
      expect(corner, `${label} 應有 1 條 platformCorner cut path`).toHaveLength(1);
      const arc = corner[0]!.segments.find((s): s is ArcSeg => s.kind === 'arc');
      expect(arc, `${label} 應含 1 個 R2.5 圓角`).toBeDefined();
      expect(arc!.r).toBeCloseTo(2.5, 6);

      const chain = findTagged(result.paths, 'aGussetPeriphery', label, 'cut');
      expect(chain, `${label} 應有 1 條 aGussetPeriphery cut path`).toHaveLength(1);
      expect(chain[0]!.segments, `${label}：13 段（Fix 5·2026-07-11 口徑更正——新 relief chain 13 段＋既有 gusset 對應 2 cut+1 crease＝合計覆蓋 P 的 16 primitive，見 tray.ts A_GUSSET_OUTER_TL 註解）`).toHaveLength(13);
    }
  });

  it('180° 旋轉實例化：兩組對角配對（left-front↔right-back、right-front↔left-back）座標精確互為負值（角落為旋轉中心，見 buildAGussetChain；Fix 1·2026-07-11 擴充覆蓋第二組對角——先前只驗第一組，相鄰角落誤鏡射的 bug 不會被這條測試單獨抓到）', () => {
    const result = generateTray(baseOpts);
    const diagonalPairs: Array<[string, string]> = [
      ['left-front', 'right-back'],
      ['right-front', 'left-back'],
    ];
    for (const [cornerA, cornerB] of diagonalPairs) {
      const a = findTagged(result.paths, 'aGussetPeriphery', cornerA, 'cut')[0]!.segments as LineSeg[];
      const b = findTagged(result.paths, 'aGussetPeriphery', cornerB, 'cut')[0]!.segments as LineSeg[];
      expect(a, `${cornerA}/${cornerB} 段數應相等`).toHaveLength(b.length);
      // 逐點反向比對：a 第 i 段的兩端點，180° 旋轉（negate x,y）後應精確等於 b 第 i 段
      // 對應端點（corner+sx*a+sy*b 這個實例化公式，對角角落數學上恆等於 180° 旋轉，見
      // 開發紀錄 對算過程——本測試釘住這個關係不被意外破壞）。
      for (let i = 0; i < a.length; i++) {
        const segA = a[i]!;
        const segB = b[i]!;
        expect(-segA.x1, `${cornerA}/${cornerB} 段 ${i} x1`).toBeCloseTo(segB.x1, 6);
        expect(-segA.y1, `${cornerA}/${cornerB} 段 ${i} y1`).toBeCloseTo(segB.y1, 6);
        expect(-segA.x2, `${cornerA}/${cornerB} 段 ${i} x2`).toBeCloseTo(segB.x2, 6);
        expect(-segA.y2, `${cornerA}/${cornerB} 段 ${i} y2`).toBeCloseTo(segB.y2, 6);
      }
    }
  });

  it('相鄰角落非鏡射（Fix 1·2026-07-11 review H1 迴歸釘樁）：right-front 的平台端 zigzag 深度與 left-front 不同——若誤用 topLeft 模板鏡射四角，這裡會抓到約 20mm 偏差', () => {
    // 相鄰角落（topLeft/topRight）在 T0 原始量測裡走線不同，不是同一模板的鏡射或旋轉
    // （見 tray.ts A_GUSSET_PLATFORM_RELIEF_TR 註解：topLeft 對應段 b 範圍到 52.9978，
    // topRight 對應段 b 範圍到 72.9968，相差 20mm）。用「若誤鏡射會產生的座標」與
    // 「正確 topRight 模板應產生的座標」兩者中只有一個該存在來鎖住這個修正。
    const result = generateTray(baseOpts);
    const rf = findTagged(result.paths, 'aGussetPeriphery', 'right-front', 'cut');
    const cornerX = 62;
    const cornerY = -89.5;
    const T = 0.05;
    // 正確（topRight 模板）：a≈64.4984（snap 到 distPlatformEnd≈64.5）沿線一路到 b=72.9968。
    expectLine(rf, cornerX + 64.4984, cornerY + 4.5014, cornerX + 64.4984, cornerY - 72.9968, T, 'right-front 正確 topRight 深度（b=72.9968）');
    // 錯誤（若誤把 topLeft 模板鏡射到此角）：同一 a，但只到 b=52.9978——不應存在。
    const lines = rf.flatMap((p) => p.segments).filter((s): s is LineSeg => s.kind === 'line');
    const wrongMirrorHit = lines.some(
      (s) => Math.abs(s.x1 - (cornerX + 64.4984)) <= T && Math.abs(s.y1 - (cornerY - 52.9978)) <= T && Math.abs(s.x2 - (cornerX + 64.4984)) <= T,
    );
    expect(wrongMirrorHit, 'right-front 不應出現 topLeft 鏡射深度（b=52.9978）—— 若出現代表退回誤鏡射的舊 bug').toBe(false);
  });

  it('T0 座標表逐項對（left-front／right-front 兩角，±0.05mm）：10° cut、角撐周邊鏈終點（halfcut 邊界）——Fix 1·2026-07-11 擴充覆蓋 right-front（先前只驗 left-front）', () => {
    // baseOpts 角落 left-front = (-62, -89.5)、right-front = (62, -89.5)；T0 topLeft／
    // topRight 分別對應同一角。座標换算：本函式用的 (a,b) 與 T0 fixture 的 P 絕對座標差
    // 一個仿射變換，這裡改用「相對角落的位移」直接比對（T0 座標見 aGussetPeriphery_reliefChain
    // 的 topLeftCorner_*／topRightCorner_* 系列欄位，開發紀錄／Fix 1 補量記錄）。
    const result = generateTray(baseOpts);
    const T = 0.05;

    const lfChain = findTagged(result.paths, 'aGussetPeriphery', 'left-front', 'cut');
    const lfX = -62;
    const lfY = -89.5;
    // LINE27（10° cut，topLeft）：corner+(59.4995,0) → corner+(64.4984,-0.8819)
    expectLine(lfChain, lfX - 59.4995, lfY, lfX - 64.4984, lfY + 0.8819, T, 'left-front 10° cut（LINE27）');
    // LINE92 終點＝角撐周邊鏈與 halfcut 邊界的交會點：corner+(123.2006,-21.5018)
    expectLine(lfChain, lfX - 121.2003, lfY + 21.5018, lfX - 123.2006, lfY + 21.5018, T, 'left-front LINE92（notch 逼近終點→halfcut 邊界）');

    const rfChain = findTagged(result.paths, 'aGussetPeriphery', 'right-front', 'cut');
    const rfX = 62;
    const rfY = -89.5;
    // LINE12（10° cut，topRight，獨立補量——非 LINE27 鏡射，但這兩點恰好數值相符，
    // 見 tray.ts A_GUSSET_OUTER_TR 註解）：corner+(59.4995,0) → corner+(64.4984,-0.8819)，
    // sx=+1 時符號與 left-front 相反（outward 是 +x 而非 -x）。
    expectLine(rfChain, rfX + 59.4995, rfY, rfX + 64.4984, rfY + 0.8819, T, 'right-front 10° cut（LINE12）');
    // LINE22 終點＝topRight 角撐周邊鏈與 halfcut 邊界的交會點：corner+(123.2006,-21.5018)
    // （與 left-front 的 LINE92 同一 tongueFold/reach 幾何——這段兩模板數值相同，見
    // A_GUSSET_INNER_WALL_APPROACH_TR 最後一段）。
    expectLine(rfChain, rfX + 121.2003, rfY + 21.5018, rfX + 123.2006, rfY + 21.5018, T, 'right-front LINE22（notch 逼近終點→halfcut 邊界）');
  });

  it('四角逐段固定迴歸（Fix 1 re-review·2026-07-11）：topLeft/topRight 各 13 段直接對 T0 fixture 原始座標（不透過 tray.ts 常數表），bottomRight/bottomLeft 用各自對角模板的 180° 旋轉推導（無獨立量測——fixture _meta.verification.mirrorGidsCaveat 明記「bottomLeft/bottomRight 清單碎片化」）', () => {
    // 動機：上一條「T0 座標表逐項對」只驗 2 個點（10° cut outer＋innerWallApproach
    // 終點），re-review 用 mutation 證實不夠——把 topRight fixture 的 LINE60
    // （platformRelief 子鏈內部折點）端點暫改 1mm，既有四角相關的五項測試（180° 旋轉
    // 實例化／相鄰角落非鏡射／T0 逐項對／複合鏈段數／全部不變式）全部維持綠燈：程式本身
    // 沒錯，但迴歸網沒有任何一條斷言碰到那個座標，改錯了也測不出來。
    //
    // 本測試逐段覆蓋兩模板各自的 13 段（outer 1＋platformRelief 5＋innerWallApproach 7），
    // 直接讀 fixture 原始 P-mm 座標換算（見 fixtureChainToWorld 推導），不經過 tray.ts 的
    // A_GUSSET_* 常數表——避免「測試抄實作常數」的重言式（那樣常數表本身改錯也測不出來）。
    const result = generateTray(baseOpts);
    const halfL = baseOpts.panelL / 2;
    const halfW = baseOpts.panelW / 2;
    const T = 0.05; // T0 對算容差

    const cornersMm = fixtureRaw.base.panel.corners_mm;
    const chains = fixtureRaw.base.aGussetPeriphery_reliefChain;
    const tenDegCuts = fixtureRaw.base.aGussetPeriphery_tenDegCuts;

    // topLeft(fixture) → left-front(code, TL 模板)：translate = codeCorner − fixtureCorner。
    const translateTL = { x: -halfL - cornersMm.topLeft[0]!, y: -halfW - cornersMm.topLeft[1]! };
    const tlEntries = [tenDegCuts.topLeft, ...chains.topLeftCorner_platformRelief_chain, ...chains.topLeftCorner_innerWallApproach_chain];
    expect(tlEntries, 'topLeft 模板應恰有 13 段 fixture 原始資料（1 outer＋5 platformRelief＋7 innerWallApproach）').toHaveLength(13);
    const lfChain = findTagged(result.paths, 'aGussetPeriphery', 'left-front', 'cut');
    const tlWorld = fixtureChainToWorld(tlEntries, translateTL);
    for (const seg of tlWorld) {
      expectLine(lfChain, seg.x1, seg.y1, seg.x2, seg.y2, T, `left-front（topLeft fixture ${seg.gid}）`);
    }

    // topRight(fixture) → right-front(code, TR 模板)。
    const translateTR = { x: halfL - cornersMm.topRight[0]!, y: -halfW - cornersMm.topRight[1]! };
    const trEntries = [...chains.topRightCorner_outer_cut, ...chains.topRightCorner_platformRelief_chain, ...chains.topRightCorner_innerWallApproach_chain];
    expect(trEntries, 'topRight 模板應恰有 13 段 fixture 原始資料（1 outer＋5 platformRelief＋7 innerWallApproach）').toHaveLength(13);
    const rfChain = findTagged(result.paths, 'aGussetPeriphery', 'right-front', 'cut');
    const trWorld = fixtureChainToWorld(trEntries, translateTR);
    for (const seg of trWorld) {
      expectLine(rfChain, seg.x1, seg.y1, seg.x2, seg.y2, T, `right-front（topRight fixture ${seg.gid}）`);
    }

    // bottomRight(=right-back，TL 對角)／bottomLeft(=left-back，TR 對角)：無獨立量測，
    // 改用「180° 旋轉＝負值」（與 tray.ts A_GUSSET_CHAIN_TL/TR 註解「對角角落才是數學
    // 精確的 180° 旋轉」、本檔前段「180° 旋轉實例化」測試一致的關係）逐段對照。
    const rbChain = findTagged(result.paths, 'aGussetPeriphery', 'right-back', 'cut');
    for (const seg of tlWorld) {
      expectLine(rbChain, -seg.x1, -seg.y1, -seg.x2, -seg.y2, T, `right-back（topLeft fixture ${seg.gid} 180° 旋轉）`);
    }
    const lbChain = findTagged(result.paths, 'aGussetPeriphery', 'left-back', 'cut');
    for (const seg of trWorld) {
      expectLine(lbChain, -seg.x1, -seg.y1, -seg.x2, -seg.y2, T, `left-back（topRight fixture ${seg.gid} 180° 旋轉）`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 Task 4：F5 B 款舌根拓撲＋V relief（T0 座標表對算）
//
// lidOpts（既有 fixture，platformWidth=0）在此三分支驗算下座落分支 1（不縮不警告）：
// - 左右壁（longWall，x 向牆，hasDoubleRoot=false）：reserved=B_TONGUE_RESERVED_LONGWALL
//   (9.398)，perpHalf=panelW/2=103，reservedSpan=2×(103−9.398)=187.204；threshold=
//   2×45+10=100；187.204≥100→分支 1，endLen=45。
// - 前後壁（shortWall，y 向牆，hasDoubleRoot=true）：reserved=V_RELIEF_INSET(2.5)，
//   perpHalf=panelL/2=75.5，reservedSpan=2×(75.5−2.5)=146；threshold=2×35+10=80；
//   146≥80→分支 1，endLen=35。V relief 依附端段 E′=35≥7.5→生成。
// ─────────────────────────────────────────────────────────────────────────

describe('generateTray: F5 B 款舌根拓撲＋V relief（T0 座標表對算）', () => {
  it('左右壁（longWall）分支 1（一般參數化案例，非 P 實測 panelW——見下一條 production-P 版本）：端段 crease 2 段各 45mm、halfcut 1 段 97.204mm（187.204−2×45）、無 V relief', () => {
    // F3 review Fix（2026-07-11）：本檔 lidOpts.panelW=206（見該常數定義處註解），但 P
    // 實測 panelW=216（fixtureRaw.lid.panel.corners_mm：bottomLeft.y−topLeft.y=
    // 413.1381−197.1393=215.9988，四角互證，見 F1/F2 review Fix report）——標題原稱
    // 「T0 座標表對算」誤導成此為 production-P golden 值。本測試改標為一般參數化結構
    // 驗證（驗證 bTongueBranch 分支 1 公式在 panelW=206 這組具體數字下的自洽性，不代表
    // P 逐項對算）；真正 production-P（panelW=216）驗算見下一條。lidOpts 本身維持不變
    // （206 被 F1/F6-B/F5 其餘測試全面沿用——若改動需重新推導數十處斷言，超出本 Low
    // finding 範圍，見 lidOpts 定義處註解）。
    const result = generateTray(lidOpts);
    const crease = findTagged(result.paths, 'tongueFold', 'left', 'crease');
    expect(crease, '左壁應恰有 1 條端段 crease path').toHaveLength(1);
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, '分支 1：兩端各 45mm（nominal，不縮）').toEqual([45, 45]);

    const halfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    expect(halfcut, '左壁應恰有 1 條 halfcut path').toHaveLength(1);
    const halfcutLen = (halfcut[0]!.segments as LineSeg[]).reduce((s, seg) => s + Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 0);
    expect(halfcutLen, 'halfcut＝reservedSpan−2×endLen＝187.204−90（panelW=206 這組參數自身的公式自洽，非 P 對算）').toBeCloseTo(97.204, 6);

    const vRelief = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    expect(vRelief, 'longWall 沒有 V relief 機制（讓位改由 F6-B 角撐周邊負責）').toHaveLength(0);
  });

  it('左右壁（longWall）分支 1，production-P 版本（F3 review Fix，2026-07-11）：panelW 改用 P 實測 216（非 lidOpts 的 206），期望值獨立重導（不抄 review 數字）——halfcut 1 段 107.204mm（197.204−2×45）', () => {
    // 獨立重導（不透過 tray.ts 常數表或 review 給的數字，純手算 spec 公式）：
    //   perpHalf(longWall) = panelW/2 = 216/2 = 108
    //   reservedSpan = 2×(perpHalf − B_TONGUE_RESERVED_LONGWALL) = 2×(108−9.398) = 197.204
    //   threshold(分支 1) = 2×eNominal+10 = 2×45+10 = 100；197.204 ≥ 100 → 分支 1，端段不縮
    //   halfcut = reservedSpan − 2×45 = 197.204 − 90 = 107.204
    const result = generateTray({ ...lidOpts, panelW: 216 });
    const crease = findTagged(result.paths, 'tongueFold', 'left', 'crease');
    expect(crease, '左壁應恰有 1 條端段 crease path').toHaveLength(1);
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, '分支 1：兩端各 45mm（nominal，不縮）').toEqual([45, 45]);

    const halfcut = findTagged(result.paths, 'tongueFold', 'left', 'halfcut');
    expect(halfcut, '左壁應恰有 1 條 halfcut path').toHaveLength(1);
    const halfcutLen = (halfcut[0]!.segments as LineSeg[]).reduce((s, seg) => s + Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 0);
    expect(halfcutLen, 'halfcut＝reservedSpan−2×endLen＝197.204−90（獨立重導，panelW=216=P 實測）').toBeCloseTo(107.204, 6);

    const vRelief = findTagged(result.paths, 'tongueFold', 'left', 'cut');
    expect(vRelief, 'longWall 沒有 V relief 機制（讓位改由 F6-B 角撐周邊負責）').toHaveLength(0);
  });

  it('前後壁（shortWall）分支 1：端段 crease 2 段各 35mm、halfcut 76mm（146−2×35）、V relief 4 段（2 個×2 線）', () => {
    const result = generateTray(lidOpts);
    const crease = findTagged(result.paths, 'tongueFold', 'back', 'crease');
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, '分支 1：兩端各 35mm').toEqual([35, 35]);

    const halfcut = findTagged(result.paths, 'tongueFold', 'back', 'halfcut');
    const halfcutLen = (halfcut[0]!.segments as LineSeg[]).reduce((s, seg) => s + Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 0);
    expect(halfcutLen, 'halfcut＝146−70').toBeCloseTo(76, 6);

    const vRelief = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(vRelief, 'shortWall E′=35≥7.5，V relief 應生成').toHaveLength(1);
    expect(vRelief[0]!.tags, 'V relief 應帶 vRelief tag').toContain('vRelief');
    const vSegs = vRelief[0]!.segments as LineSeg[];
    expect(vSegs, '4 段（2 個 V 形×2 條直線）').toHaveLength(4);
    for (const s of vSegs) {
      // 每條線是 V 的一臂：apex↔arm，長度＝√(inset²+(height/2)²)＝√(2.5²+2.5²)。
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      expect(len, 'V 臂長＝√(2.5²+2.5²)（inset 2.5、半高 2.5，nominal 5×2.5）').toBeCloseTo(Math.hypot(2.5, 2.5), 6);
    }
    expect(result.paths.some((p) => p.tags?.includes('vRelief') && p.segments.some((s) => s.kind === 'arc')), 'V relief 兩條直線，無圓角').toBe(false);

    // Slice 5 Task 7 review fix（review Medium）：上面的斜邊長檢查對 (height,inset) 是等價類
    // 不敏感——height=4/inset=2.915475947 仍給出同一斜邊長 √(2.915475947²+2²)≈3.5355，會
    // 矇混過關（review mutation 實證，同縫修法見 telescope-fixture.test.ts 兩個 V relief
    // block）。segs[0,1] 是第一個 V（apex↔arm）、segs[2,3] 是第二個 V（tray.ts
    // buildVReliefPair 逐 endSign 產出的建構順序）：分組後①確認兩線共用 1 個頂點
    // （也覆核分組沒配錯）②bbox 兩軸獨立鎖 height（兩臂端點間距）與 inset（頂點距壁緣）。
    for (let i = 0; i < vSegs.length; i += 2) {
      const g = vSegs.slice(i, i + 2);
      const l1 = g[0]!;
      const l2 = g[1]!;
      const pts = [
        { x: l1.x1, y: l1.y1 },
        { x: l1.x2, y: l1.y2 },
        { x: l2.x1, y: l2.y1 },
        { x: l2.x2, y: l2.y2 },
      ];
      const distinctPts = pts.filter((p, idx) => pts.findIndex((q) => Math.abs(q.x - p.x) <= 1e-6 && Math.abs(q.y - p.y) <= 1e-6) === idx);
      expect(distinctPts, `V#${i / 2} 兩線應共用 1 個頂點（apex）——4 端點只有 3 個相異點`).toHaveLength(3);

      const b = segmentsBounds(g);
      const dims = [b.maxX - b.minX, b.maxY - b.minY].sort((a, c) => a - c);
      expect(dims[0], `V#${i / 2} 頂點距壁緣＝內縮量（bbox 較短軸，獨立於 height）`).toBeCloseTo(2.5, 6);
      expect(dims[1], `V#${i / 2} 兩臂端點間距＝V 開口高（bbox 較長軸，獨立於 inset）`).toBeCloseTo(5, 6);
    }
  });

  it('分支 2（縮減）：構造 reservedSpan 落在 [10,2E+10) 區間，端段縮至 (reservedSpan−10)/2、halfcut 保底吃剩餘', () => {
    // 短壁 E=35，選 panelL 讓 reservedSpan=2×(panelL/2−2.5) 落在 [10,80)——取 panelL=44：
    // reservedSpan=2×(22−2.5)=39，E′=(39−10)/2=14.5（≥7.5，V relief 仍生成，驗證兩者獨立）。
    const result = generateTray({ ...lidOpts, panelL: 44 });
    const crease = findTagged(result.paths, 'tongueFold', 'back', 'crease');
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, '分支 2：端段縮至 E′=(39−10)/2=14.5').toEqual([14.5, 14.5]);

    const halfcut = findTagged(result.paths, 'tongueFold', 'back', 'halfcut');
    const halfcutLen = (halfcut[0]!.segments as LineSeg[]).reduce((s, seg) => s + Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 0);
    expect(halfcutLen, 'halfcut＝39−2×14.5=10（保底）').toBeCloseTo(10, 6);

    const vRelief = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(vRelief, 'E′=14.5≥7.5，V relief 仍生成（分支縮減與 V relief 省略各自獨立判定）').toHaveLength(1);
  });

  it('分支 3（全省）：構造 reservedSpan<10，端段全省（0 段 crease）、halfcut 覆蓋整段、V relief 恆省略', () => {
    // 短壁：panelL=14 → reservedSpan=2×(7−2.5)=9<10 → 分支 3。
    const result = generateTray({ ...lidOpts, panelL: 14 });
    const crease = findTagged(result.paths, 'tongueFold', 'back', 'crease');
    expect(crease, '分支 3：端段全省，不應有 crease path').toHaveLength(0);

    const halfcut = findTagged(result.paths, 'tongueFold', 'back', 'halfcut');
    expect(halfcut, '仍應有 1 條 halfcut path（覆蓋整段）').toHaveLength(1);
    const halfcutLen = (halfcut[0]!.segments as LineSeg[]).reduce((s, seg) => s + Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1), 0);
    expect(halfcutLen, 'halfcut＝reservedSpan（9，端段=0 全吃）').toBeCloseTo(9, 6);

    const vRelief = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(vRelief, '分支 3（無端段）恆省略 V relief').toHaveLength(0);
  });

  it('F4 review Fix（2026-07-11）：V relief 可容納邊界 E′=7.5（真行為測試，直接斷言幾何是否生成）——E′ 恰為門檻時仍生成', () => {
    // 舊「mutation 自證」測試只重算常數（eNominal=35≥7.5 恆真，不碰生成器），無法證明
    // E′<7.5 真的會被攔下。這裡改構造 panelL 讓 shortWall 的 E′ 恰好落在門檻上，直接讀
    // generateTray 輸出斷言 V relief 是否存在（真行為，非算式重言）。
    // panelL=30 → perpHalf=15 → reservedSpan=2×(15−2.5)=25（<2×35+10=100，落分支 2，
    // 不是分支 1，隔離「純測 V_RELIEF_MIN_END 門檻」不與分支 1/2 邊界混淆）→
    // E′=(25−10)/2=7.5，條件 endLen>=V_RELIEF_MIN_END(7.5) 為真 → 應生成。
    const result = generateTray({ ...lidOpts, panelL: 30 });
    const crease = findTagged(result.paths, 'tongueFold', 'back', 'crease');
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, 'E′=(25−10)/2=7.5（分支 2）').toEqual([7.5, 7.5]);

    const vRelief = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(vRelief, 'E′=7.5 恰為門檻（>=7.5 為真）→ V relief 應生成（真行為斷言，非算式重言）').toHaveLength(1);
    expect((vRelief[0]!.segments as LineSeg[]).length, '4 段（2 個 V 形×2 條直線）').toBe(4);
  });

  it('F4 review Fix（2026-07-11）：V relief 可容納邊界 E′=7.4（略低於門檻，真行為測試）——E′<7.5 應省略', () => {
    // panelL=29.8 → perpHalf=14.9 → reservedSpan=2×(14.9−2.5)=24.8（仍屬分支 2）→
    // E′=(24.8−10)/2=7.4<7.5 → 應省略（真行為斷言：直接讀 generateTray 輸出，不重算常數）。
    const result = generateTray({ ...lidOpts, panelL: 29.8 });
    const crease = findTagged(result.paths, 'tongueFold', 'back', 'crease');
    const creaseLens = (crease[0]!.segments as LineSeg[]).map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
    expect(creaseLens, 'E′=(24.8−10)/2=7.4（分支 2，端段仍存在，只是 V relief 依附的門檻沒過）').toEqual([7.4, 7.4]);

    const vRelief = findTagged(result.paths, 'tongueFold', 'back', 'cut');
    expect(vRelief, 'E′=7.4<7.5 → V relief 應省略（真行為斷言；門檻若誤放行本測試會抓到 4 段 vRelief cut）').toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 Task 4：F6-B B 款角撐周邊（4 個 R2 quarter turn＋2mm 側邊內縮，R1.5/R5 核心不動）
// ─────────────────────────────────────────────────────────────────────────

describe('generateTray: F6-B B 款角撐周邊（T0 座標表對算）', () => {
  it('4 個角落皆有 bGussetPeriphery cut path：6 段（5 line＋1 R2 圓角），核心 gusset（R1.5/R5）不受影響', () => {
    const result = generateTray(lidOpts);
    for (const label of ['right-back', 'right-front', 'left-back', 'left-front']) {
      const peri = findTagged(result.paths, 'bGussetPeriphery', label, 'cut');
      expect(peri, `${label} 應有 1 條 bGussetPeriphery cut path`).toHaveLength(1);
      expect(peri[0]!.segments, `${label}：6 段（P0→P1→P2→(R2)→P3→P4→P5→P6）`).toHaveLength(6);
      const arcs = peri[0]!.segments.filter((s): s is ArcSeg => s.kind === 'arc');
      expect(arcs, `${label} 應恰有 1 個 R2 圓角`).toHaveLength(1);
      expect(arcs[0]!.r, 'B 款角撐周邊圓角半徑＝R2（spec nominal）').toBeCloseTo(2, 6);

      // R1.5/R5 核心（buildGussetB 既有幾何）不動：gusset tag 底下仍應找到這兩個半徑。
      const gusset = findTagged(result.paths, 'gusset', label, 'cut');
      const gussetArcs = gusset.flatMap((p) => p.segments).filter((s): s is ArcSeg => s.kind === 'arc');
      const radii = gussetArcs.map((a) => Math.round(a.r * 10) / 10).sort();
      expect(radii, `${label} 核心角撐仍含 R1.5＋R5`).toEqual([1.5, 5]);
    }
  });

  it('全域計數：4 個角落＝4 個 R2 圓角（feature-normalized，跨全部角落彙總）', () => {
    const result = generateTray(lidOpts);
    const periPaths = result.paths.filter((p) => p.tags?.includes('bGussetPeriphery'));
    const r2Arcs = periPaths.flatMap((p) => p.segments).filter((s): s is ArcSeg => s.kind === 'arc');
    expect(r2Arcs, '4 個角落各 1 個 R2 圓角').toHaveLength(4);
    for (const a of r2Arcs) expect(a.r).toBeCloseTo(2, 6);
  });

  it('單一模板四角鏡射對稱（非 A 款的 180° 旋轉／兩手性模板）：四角在各自 (a,b) 局部座標下數值一致', () => {
    // B 款周邊固定 nominal 模板套 sx/sy 標準鏡射（abToXY: corner+sx·a+sy·b）即可涵蓋四角——
    // 與 A 款「兩組手性模板＋180° 旋轉」不同（任務報告驗證腳本：四角 (a,b) 數值一致
    // <0.005mm）。這裡反向驗證：把每個角落的路徑用該角自己的 sx/sy 轉回 (a,b)，四角應相等。
    const result = generateTray(lidOpts);
    const halfL = lidOpts.panelL / 2;
    const halfW = lidOpts.panelW / 2;
    const corners: Array<{ sx: 1 | -1; sy: 1 | -1; label: string }> = [
      { sx: 1, sy: 1, label: 'right-back' },
      { sx: 1, sy: -1, label: 'right-front' },
      { sx: -1, sy: 1, label: 'left-back' },
      { sx: -1, sy: -1, label: 'left-front' },
    ];
    const toAB = (sx: number, sy: number, cornerX: number, cornerY: number, x: number, y: number) => ({ a: (x - cornerX) / sx, b: (y - cornerY) / sy });

    const abSets = corners.map(({ sx, sy, label }) => {
      const cornerX = sx * halfL;
      const cornerY = sy * halfW;
      const peri = findTagged(result.paths, 'bGussetPeriphery', label, 'cut')[0]!;
      return (peri.segments as LineSeg[])
        .filter((s) => s.kind === 'line')
        .map((s) => {
          const p1 = toAB(sx, sy, cornerX, cornerY, s.x1, s.y1);
          const p2 = toAB(sx, sy, cornerX, cornerY, s.x2, s.y2);
          return { p1, p2 };
        });
    });

    const T = 0.01;
    for (let i = 1; i < abSets.length; i++) {
      expect(abSets[i]!, `${corners[i]!.label} 的 (a,b) 段數應與 ${corners[0]!.label} 相同`).toHaveLength(abSets[0]!.length);
      for (let j = 0; j < abSets[0]!.length; j++) {
        expect(abSets[i]![j]!.p1.a, `${corners[i]!.label} 段 ${j} p1.a`).toBeCloseTo(abSets[0]![j]!.p1.a, 1);
        expect(abSets[i]![j]!.p1.b, `${corners[i]!.label} 段 ${j} p1.b`).toBeCloseTo(abSets[0]![j]!.p1.b, 1);
        expect(abSets[i]![j]!.p2.a, `${corners[i]!.label} 段 ${j} p2.a`).toBeCloseTo(abSets[0]![j]!.p2.a, 1);
        expect(abSets[i]![j]!.p2.b, `${corners[i]!.label} 段 ${j} p2.b`).toBeCloseTo(abSets[0]![j]!.p2.b, 1);
      }
    }
  });

  it('P6（鏈終點）與相鄰 longWall 的 buildTongueFlap 全深角點精確重合（觸而不穿，見 bPeripheryTailB）', () => {
    const result = generateTray(lidOpts);
    const peri = findTagged(result.paths, 'bGussetPeriphery', 'left-front', 'cut')[0]!;
    const periLines = peri.segments as LineSeg[];
    const p6 = periLines[periLines.length - 1]!;
    const periEnd = { x: p6.x2, y: p6.y2 };

    const flap = findTagged(result.paths, 'tongueFlap', 'left', 'cut')[0]!;
    const flapPts = (flap.segments as LineSeg[]).flatMap((s) => [
      { x: s.x1, y: s.y1 },
      { x: s.x2, y: s.y2 },
    ]);
    const hit = flapPts.some((p) => Math.abs(p.x - periEnd.x) < 1e-6 && Math.abs(p.y - periEnd.y) < 1e-6);
    expect(hit, 'P6 應精確重合 tongueFlap 梯形的一個端點（觸而不穿，非假交叉）').toBe(true);
  });

  it('F2 review Fix（2026-07-11）：四角完整鏈鎖 P（±0.05mm，不透過 tray.ts 常數表）——上一條「P6 觸碰 tongueFlap」只驗兩者互相重合，兩者可一起偏離 P 仍全綠；本測試改直接比對 T0 fixture 原始 P-mm 座標（LINE161-165／180-184／121-125／141-145）', () => {
    // fixtureRaw.lid.panel.corners_mm 為獨立 T0 量測（非本次補量），與本檔案透過
    // bLongWallFlapRecess 反推的角落座標一致（topLeft=(174.371,197.1393)，見 F1 review
    // Fix report 獨立重新量測過程）——用它算 translate，不依賴 tray.ts 的 halfL/halfW 以外
    // 任何常數表。四個 chain 的第 6 段（P5→P6）即 F1 review 的爭議點，本測試逐段（含
    // P6）鎖死，之後任何人再把 bPeripheryTailB 改回舊公式都會在此變紅。
    const result = generateTray(lidOpts);
    const halfL = lidOpts.panelL / 2;
    const halfW = lidOpts.panelW / 2;
    const T = 0.05; // spec §驗收條件容差分層：detour 尺寸 ±0.05

    const cornersMm = fixtureRaw.lid.panel.corners_mm;
    const periphery = fixtureRaw.lid.bGussetPeriphery;
    type ChainEntry = (typeof periphery.topLeft_chain)[number];

    const cases: Array<{ label: string; sx: 1 | -1; sy: 1 | -1; fixtureCorner: readonly [number, number]; chain: readonly ChainEntry[] }> = [
      { label: 'left-front', sx: -1, sy: -1, fixtureCorner: cornersMm.topLeft as [number, number], chain: periphery.topLeft_chain },
      { label: 'right-front', sx: 1, sy: -1, fixtureCorner: cornersMm.topRight as [number, number], chain: periphery.topRight_chain },
      { label: 'left-back', sx: -1, sy: 1, fixtureCorner: cornersMm.bottomLeft as [number, number], chain: periphery.bottomLeft_chain },
      { label: 'right-back', sx: 1, sy: 1, fixtureCorner: cornersMm.bottomRight as [number, number], chain: periphery.bottomRight_chain },
    ];

    for (const { label, sx, sy, fixtureCorner, chain } of cases) {
      expect(chain, `${label} fixture 鏈應恰有 6 段（P0→P1→P2→(R2)→P3→P4→P5→P6）`).toHaveLength(6);
      const translate = { x: sx * halfL - fixtureCorner[0], y: sy * halfW - fixtureCorner[1] };
      const peri = findTagged(result.paths, 'bGussetPeriphery', label, 'cut');
      expect(peri, `${label} 應恰有 1 條 bGussetPeriphery cut path`).toHaveLength(1);

      for (const entry of chain) {
        if (entry.kind === 'line') {
          const p1 = entry.p1_mm!;
          const p2 = entry.p2_mm!;
          const x1 = p1[0]! + translate.x;
          const y1 = p1[1]! + translate.y;
          const x2 = p2[0]! + translate.x;
          const y2 = p2[1]! + translate.y;
          expectLine(peri, x1, y1, x2, y2, T, `${label}（fixture ${entry.gid}）`);
        } else {
          const p0 = entry.p0_mm!;
          const p3 = entry.p3_mm!;
          const e1 = { x: p0[0]! + translate.x, y: p0[1]! + translate.y };
          const e2 = { x: p3[0]! + translate.x, y: p3[1]! + translate.y };
          const arc = findArc(peri, entry.radius_mm!, e1, e2, T);
          expect(arc, `${label}（fixture ${entry.gid} R${entry.radius_mm} 圓角）應存在對應 arc`).toBeDefined();
        }
      }

      // 額外聚焦鏈"終點" P6：上面逐段迴圈已含此段，這裡再用獨立路徑（直接讀 generateTray
      // 輸出的最後一個 segment，不透過 findTagged 的 tag 篩選以外任何邏輯）明確鎖 P6 座標，
      // 避免「逐段比對剛好都能配對到某條線」的巧合掩蓋 P6 本身。
      const p6Entry = chain[chain.length - 1]!;
      if (p6Entry.kind !== 'line') throw new Error('P6 段（鏈終點）預期為 line');
      const p6End = p6Entry.p2_mm!;
      const p6World = { x: p6End[0]! + translate.x, y: p6End[1]! + translate.y };
      const periLines = peri[0]!.segments as LineSeg[];
      const lastSeg = periLines[periLines.length - 1]!;
      expect(lastSeg.x2, `${label} P6.x（鏈終點，鎖 T0 fixture ${p6Entry.gid}）`).toBeCloseTo(p6World.x, 1);
      expect(lastSeg.y2, `${label} P6.y（鏈終點，鎖 T0 fixture ${p6Entry.gid}）`).toBeCloseTo(p6World.y, 1);
    }
  });

  it('無 NaN、bGussetPeriphery 與其餘 cut 幾何無自撞（lidOpts 及極端 innerWallReduction/height 皆驗）', () => {
    for (const opts of [lidOpts, { ...lidOpts, innerWallReduction: 5 }, { ...lidOpts, height: 15 }]) {
      const result = generateTray(opts);
      expect(hasNaN(result.paths.flatMap((p) => p.segments)), `hasNaN（height=${opts.height},iwr=${opts.innerWallReduction}）`).toBe(false);
      const cutSegs = result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
      // gusset／tongueFlap 兩個既有 tag 的已知邊界退化（gusset-b-fits／tongue-flap-fits）
      // 在 height=15 這組會被觸發——bGussetPeriphery 隨這兩條門檻共同退化，同 telescope-
      // fixture.test.ts 的 BOUNDARY_EXEMPT_TAGS 豁免範圍，這裡只驗「非豁免範圍」乾淨。
      const nonExempt = result.paths.filter((p) => p.type === 'cut' && !p.tags?.includes('gusset') && !p.tags?.includes('tongueFlap')).flatMap((p) => p.segments);
      expect(hasSelfIntersection(nonExempt), `cut 不應自撞（height=${opts.height},iwr=${opts.innerWallReduction}，已排除 gusset/tongueFlap 已知邊界）`).toBe(false);
      void cutSegs;
    }
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
  // 驗算錨（spec 自檢，實作輪 手算）：t=0.4/fitGap=0.5/base 179×124/flapDepth=15
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
    const outcome = inv.check(params, swapped);
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) {
      expect(outcome.message.en).not.toMatch(/[一-鿿]/u);
      expect(outcome.message.en).toMatch(/^baseWidth main panel measures /);
    }
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
      // Fix 2·2026-07-11：baseHeight=10（本測試借來觸發 liner-flap-fits 條件 1 的極端值）
      // 搭配預設 basePlatformWidth=5 恰好也讓 A 款角撐周邊複合 relief 鏈放不下（壁高過矮，
      // 鏈自身因錨點校正扭曲自撞，見 tray.ts aGussetChainFits）——這是與本測試意圖（驗證
      // linerEnabled 閘門）無關但正確的獨立警告，不是假警告，排除在這條泛用斷言之外。
      if (inv.id === 'gusset-relief-omitted') continue;
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
// Slice 5 F4／F6-A 可容納降級 warning（notch-reduced／notch-omitted／platform-corner-
// omitted，spec §縮放與降級表）——三組參數組合逐一推導，推導過程見各 it() 註解
// （不從公式反推期望值，是先手算、再用測試釘住）。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: notch-reduced／notch-omitted／platform-corner-omitted（U-notch／平台角可容納降級）', () => {
  it('production-P 預設參數：全部可容納，三條新 invariant 皆通過（∅ 警告，spec S1）', () => {
    const params = resolveParams(telescope, { baseLength: 179, baseWidth: 124, basePlatformWidth: 5, lidPlatformWidth: 0 });
    const result = telescope.generate(params);
    for (const id of ['notch-reduced', 'notch-omitted', 'platform-corner-omitted']) {
      const inv = telescope.invariants.find((i) => i.id === id)!;
      expect(inv.check(params, result), id).toMatchObject({ ok: true });
    }
  });

  it('baseLength=60（側壁長壁 span=60）：2×(29.3385/179)×60−30=−10.3<5 → 兩 notch 放不下但 60≥40 → notch-reduced', () => {
    const params = resolveParams(telescope, { baseLength: 60, baseWidth: 40 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'notch-reduced')!;
    expect(inv.check(params, result)).toMatchObject({ ok: false });
    const omitted = telescope.invariants.find((i) => i.id === 'notch-omitted')!;
    expect(omitted.check(params, result), '短壁 baseWidth=40 恰為門檻，仍可容納單一 notch').toMatchObject({ ok: true });
  });

  it('baseLength=40, baseWidth=30：長壁 40（僅剛好夠單一置中,notch-reduced）＋短壁 30<40（notch-omitted）同時成立', () => {
    const params = resolveParams(telescope, { baseLength: 40, baseWidth: 30 });
    const result = telescope.generate(params);
    const reduced = telescope.invariants.find((i) => i.id === 'notch-reduced')!;
    const omitted = telescope.invariants.find((i) => i.id === 'notch-omitted')!;
    expect(reduced.check(params, result), '長壁 40：雙 notch 放不下但單一 40≥40 可容納').toMatchObject({ ok: false });
    expect(omitted.check(params, result), '短壁 30<40：單一 notch 也放不下，全省').toMatchObject({ ok: false });
  });

  it('basePlatformWidth=2（<2.5）：平台角圓角降級為直角（platform-corner-omitted），2.5 剛好不觸發', () => {
    const below = resolveParams(telescope, { basePlatformWidth: 2 });
    const belowResult = telescope.generate(below);
    const inv = telescope.invariants.find((i) => i.id === 'platform-corner-omitted')!;
    expect(inv.check(below, belowResult)).toMatchObject({ ok: false });

    const atThreshold = resolveParams(telescope, { basePlatformWidth: 2.5 });
    expect(inv.check(atThreshold, telescope.generate(atThreshold)), '恰等於門檻（非嚴格小於）應通過').toMatchObject({ ok: true });
  });

  it('lidPlatformWidth>0（款式互換情境）時同樣受兩組門檻約束，不是只查 base', () => {
    const params = resolveParams(telescope, { basePlatformWidth: 0, lidPlatformWidth: 2, lidMarginX: 5, lidMarginY: 5 });
    const result = telescope.generate(params);
    const cornerInv = telescope.invariants.find((i) => i.id === 'platform-corner-omitted')!;
    expect(cornerInv.check(params, result), 'lidPlatformWidth=2<2.5 應觸發').toMatchObject({ ok: false });
  });

  it('S1-S4：未過濾 uNotch／aGussetPeriphery／platformCorner 的 cut 自交零斷言（Fix 2·2026-07-11 review H2——warning 是合法降級聲明，不是自交豁免；S2/S3 降級後 uNotch×aGussetPeriphery 曾在此真自交，被舊版「降級時排除 uNotch」豁免隱藏，這裡刻意不對這三個 tag 套用任何豁免，直接驗證）', () => {
    // 只排除 tongueFlap／linerFlap 兩個 tag——這兩者是 tongue-flap-fits／liner-flap-fits
    // 既有、已記錄在案、與本輪 Fix 2（uNotch/aGussetPeriphery）無關的獨立已知降級（見
    // BOUNDARY_EXEMPT_TAGS 對這兩條 invariant 的豁免仍保留，以及「豁免案例現狀記錄」
    // 系列測試）；S3（baseWidth=30<33）會觸發 tongue-flap-fits，預設 linerEnabled=true
    // 下 baseWidth=30 也會觸發 liner-flap-fits 條件 3（翼片外緣反轉）——兩者都是已知、
    // 已測試涵蓋的獨立退化，混進本測試的斷言範圍只會製造假失敗，不代表 Fix 2 沒修好。
    const cases: Array<[string, Record<string, number>]> = [
      ['S1（production-P 對應等效組）', { baseLength: 179, baseWidth: 124, basePlatformWidth: 5 }],
      ['S2（baseLength=60,baseWidth=40，notch-reduced）', { baseLength: 60, baseWidth: 40 }],
      ['S3（baseLength=40,baseWidth=30，notch-reduced+notch-omitted）', { baseLength: 40, baseWidth: 30 }],
      ['S4（basePlatformWidth=2，platform-corner-omitted）', { basePlatformWidth: 2 }],
    ];
    for (const [label, overrides] of cases) {
      const params = resolveParams(telescope, overrides);
      const result = telescope.generate(params);
      const scopedCutSegs = result.paths
        .filter((p) => p.type === 'cut' && !p.tags?.includes('tongueFlap') && !p.tags?.includes('linerFlap'))
        .flatMap((p) => p.segments);
      expect(hasSelfIntersection(scopedCutSegs), `${label}：cut（排除已知獨立降級 tongueFlap／linerFlap）不應自交`).toBe(false);
      expect(hasNaN(result.paths.flatMap((p) => p.segments)), `${label}：不應有 NaN`).toBe(false);
    }
  });
});

describe('telescope: tongue-crease-shrunk／tongue-crease-omitted／relief-omitted（B 款舌根端段/V relief 可容納降級）', () => {
  it('production-P 預設參數：全部可容納，三條新 invariant 皆通過（∅ 警告，spec S1）', () => {
    const params = resolveParams(telescope, { baseLength: 179, baseWidth: 124, basePlatformWidth: 5 });
    const result = telescope.generate(params);
    for (const id of ['tongue-crease-shrunk', 'tongue-crease-omitted', 'relief-omitted']) {
      const inv = telescope.invariants.find((i) => i.id === id)!;
      expect(inv.check(params, result), id).toMatchObject({ ok: true });
    }
  });

  it('baseLength=60, baseWidth=40（S2）：lid 短向/長向舌摺線可用長度皆落分支 2 → tongue-crease-shrunk；relief-omitted 不觸發（E′=26≥7.5）', () => {
    const params = resolveParams(telescope, { baseLength: 60, baseWidth: 40 });
    const result = telescope.generate(params);
    expect(telescope.invariants.find((i) => i.id === 'tongue-crease-shrunk')!.check(params, result), '短壁 reservedSpan=62<80、長壁 78.204<100，兩者皆分支 2').toMatchObject({ ok: false });
    expect(telescope.invariants.find((i) => i.id === 'relief-omitted')!.check(params, result), '短壁 E′=(62−10)/2=26≥7.5，V relief 仍生成').toMatchObject({ ok: true });
    expect(telescope.invariants.find((i) => i.id === 'tongue-crease-omitted')!.check(params, result), '尚未縮到 reservedSpan<10').toMatchObject({ ok: true });
  });

  it('baseLength=40, baseWidth=30（S3）：同樣分支 2，relief-omitted 仍不觸發（E′=21≥7.5）', () => {
    const params = resolveParams(telescope, { baseLength: 40, baseWidth: 30 });
    const result = telescope.generate(params);
    expect(telescope.invariants.find((i) => i.id === 'tongue-crease-shrunk')!.check(params, result), '短壁 reservedSpan=52<80').toMatchObject({ ok: false });
    expect(telescope.invariants.find((i) => i.id === 'relief-omitted')!.check(params, result), '短壁 E′=(52−10)/2=21≥7.5').toMatchObject({ ok: true });
  });

  it('lidPlatformWidth>0（款式互換情境）時同樣受 B 款端段門檻約束，不是只查 lid', () => {
    // 互換後 base 變 B 款（basePlatformWidth=0），baseWidth 縮到觸發分支 2。
    const params = resolveParams(telescope, { basePlatformWidth: 0, lidPlatformWidth: 5, baseLength: 60, baseWidth: 40 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'tongue-crease-shrunk')!;
    expect(inv.check(params, result), 'base 變 B 款後，baseLength=60/baseWidth=40 應觸發（同 S2 的公式，換到 base 身上）').toMatchObject({ ok: false });
  });

  it('relief-omitted：baseWidth 低於 schema min（直接構造 out-of-range 值，schema min=30 恰為 E′=7.5 邊界、無法用合法值觸發<7.5，同 tongue-flap-fits 系列既有測試手法用 resolveParams 直接餵界外值）', () => {
    // baseWidth=20（basePlatformWidth=0，B 款）：reservedSpan=2×(10−2.5)=15，E′=(15−10)/2=2.5<7.5。
    const params = resolveParams(telescope, { basePlatformWidth: 0, baseWidth: 20 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'relief-omitted')!;
    expect(inv.check(params, result), 'baseWidth=20 → shortWall E′=2.5<7.5，V relief 應省略').toMatchObject({ ok: false });
  });

  it('F4 review Fix（2026-07-11）：relief-omitted warning 在 E′=7.5／7.45 兩個真邊界皆真行為驗證（不只 E′=2.5 這種遠低於門檻的案例）', () => {
    // baseWidth=30＝schema 合法 min（不必構造界外值）：shortSpan=30，reservedSpan=
    // 2×(15−2.5)=25，E′=(25−10)/2=7.5，恰為門檻——條件 endLen>=7.5 為真 → 不觸發警告。
    const paramsAt = resolveParams(telescope, { basePlatformWidth: 0, baseWidth: 30 });
    const resultAt = telescope.generate(paramsAt);
    const invAt = telescope.invariants.find((i) => i.id === 'relief-omitted')!;
    expect(invAt.check(paramsAt, resultAt), 'baseWidth=30（schema 合法 min）→ E′=7.5 恰為門檻，>=7.5 為真 → 不觸發').toMatchObject({ ok: true });

    // baseWidth=29.9（略低於 schema min，界外值，同既有手法）：shortSpan=29.9，
    // reservedSpan=2×(14.95−2.5)=24.9，E′=(24.9−10)/2=7.45<7.5 → 應觸發。
    const paramsBelow = resolveParams(telescope, { basePlatformWidth: 0, baseWidth: 29.9 });
    const resultBelow = telescope.generate(paramsBelow);
    const invBelow = telescope.invariants.find((i) => i.id === 'relief-omitted')!;
    expect(invBelow.check(paramsBelow, resultBelow), 'baseWidth=29.9 → E′=7.45<7.5 → 應觸發（與上面 7.5 案例僅差 0.1mm baseWidth，證明門檻本身有牙齒，非遠低於門檻才測得出來）').toMatchObject({ ok: false });
  });

  it('tongue-crease-omitted：構造 reservedSpan<10（界外值，同上手法）', () => {
    // baseWidth=8：reservedSpan=2×(4−2.5)=3<10 → 分支 3。
    const params = resolveParams(telescope, { basePlatformWidth: 0, baseWidth: 8 });
    const result = telescope.generate(params);
    const inv = telescope.invariants.find((i) => i.id === 'tongue-crease-omitted')!;
    expect(inv.check(params, result), 'baseWidth=8 → reservedSpan=3<10，端段全省').toMatchObject({ ok: false });
    // 分支 3 恆省略 V relief，relief-omitted 也應同時觸發（兩條各自獨立判定但同一參數組雙中）。
    const reliefInv = telescope.invariants.find((i) => i.id === 'relief-omitted')!;
    expect(reliefInv.check(params, result), '分支 3（無端段）恆省略 V relief').toMatchObject({ ok: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 Task 4：spec §驗收 4 的 S1-S7 warning 矩陣（B 款相關組·A 款部分已由 T3 的
// notch-reduced/notch-omitted/platform-corner-omitted/gusset-relief-omitted 描述涵蓋，
// 這裡把 B 款三條新 warning 併入同一矩陣，逐組驗「unique warning id 集合精確匹配」——
// 比較對象＝telescope.invariants 全部（16 條，含 pieces-valid／liner-flap-fits／
// pieces-identity／rim-flush／gusset-b-fits／tongue-flap-fits／no-nan／no-bleed／
// bounds-cover 等既有 module invariant＋spec §縮放與降級規律表列出的 7 個「細節降級」
// id：notch-reduced／notch-omitted／platform-corner-omitted／gusset-relief-omitted／
// tongue-crease-shrunk／tongue-crease-omitted／relief-omitted）中實際觸發
// （check().ok===false）的完整集合，不篩子集（2026-07-11 review T5-M1 同型縫修正—
// 舊版只收集上述 7 個新降級 id、把既有 module invariant 排除在集合外，見下方
// warningSet() 檔頭註解）。
//
// 與 tests/boxes/param-sweep.test.ts「S1-S7 矩陣」（Task 5，spec 原文明點的正式落地
// 位置）的差異：本檔 warningSet() 用 resolveParams(telescope, overrides) 直接疊 schema
// 預設，不像 param-sweep 版疊 PRODUCTION_P fixture（PRODUCTION_P.linerEnabled=false，
// 本檔 schema 預設 linerEnabled=true）——這個差異只在 S3（baseWidth=30<33）顯現：
// linerEnabled=true 下 baseWidth=30 額外頂到內襯翼片外緣反轉門檻，多觸發一個
// liner-flap-fits（與上方「S1-S4：cut 自交零斷言」測試開頭註解「S3 會觸發
// tongue-flap-fits，預設 linerEnabled=true 下 baseWidth=30 也會觸發 liner-flap-fits」
// 逐字一致），S3 因此比 param-sweep 版多一項（六項，見下方）。其餘六組
// （S1/S2/S4/S5/S6/S7）與 param-sweep 版逐組交叉核對完全一致。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: S1-S7 warning 矩陣（spec §驗收 4，B 款新增三條併入）', () => {
  /**
   * 跑 telescope.generate()，回傳 telescope.invariants 全部（16 條）中實際觸發
   * （check().ok===false）的 id 完整集合——不篩子集（2026-07-11 review T5-M1 同型縫
   * 修正：舊版用一個寫死的 7-id DEGRADATION_IDS 白名單篩選，把既有 module invariant
   * （tongue-flap-fits／gusset-b-fits／liner-flap-fits／rim-flush／pieces-identity 等）
   * 排除在集合外——但 spec §驗收 4 表 S3 明列「＋既有 tongue-flap-fits（如觸發）」，可見
   * 既有 invariant 觸發與否本就是預期集合的一部分，舊篩選下這條既有 warning 意外出現或
   * 消失，矩陣仍全綠、測試偵測不到。見上方檔頭註解——本檔 overrides 疊在 schema 預設
   * （linerEnabled=true）上，S3 因此比 param-sweep.test.ts 的 PRODUCTION_P 版
   * （linerEnabled=false）多觸發一項 liner-flap-fits，見下方 S3 區塊）。
   */
  function warningSet(overrides: Record<string, number>): Set<string> {
    const params = resolveParams(telescope, overrides);
    const result = telescope.generate(params);
    const fired = new Set<string>();
    for (const inv of telescope.invariants) {
      if (!inv.check(params, result).ok) fired.add(inv.id);
    }
    return fired;
  }

  it('S1（production-P 原組）：∅', () => {
    expect(warningSet({ baseLength: 179, baseWidth: 124, basePlatformWidth: 5 })).toEqual(new Set());
  });

  it('S2（baseLength=60,baseWidth=40）：{notch-reduced, tongue-crease-shrunk, gusset-relief-omitted}', () => {
    expect(warningSet({ baseLength: 60, baseWidth: 40 })).toEqual(new Set(['notch-reduced', 'tongue-crease-shrunk', 'gusset-relief-omitted']));
  });

  it('S3（baseLength=40,baseWidth=30）：{notch-reduced, notch-omitted, tongue-crease-shrunk, gusset-relief-omitted, tongue-flap-fits, liner-flap-fits}（無 relief-omitted；後兩項為既有 module invariant，本檔 schema 預設 linerEnabled=true 下皆觸發——見上方檔頭與 warningSet() 註解，比 param-sweep.test.ts 版多一項 liner-flap-fits）', () => {
    expect(warningSet({ baseLength: 40, baseWidth: 30 })).toEqual(new Set(['notch-reduced', 'notch-omitted', 'tongue-crease-shrunk', 'gusset-relief-omitted', 'tongue-flap-fits', 'liner-flap-fits']));
  });

  it('S4（basePlatformWidth=2）：{platform-corner-omitted}', () => {
    expect(warningSet({ basePlatformWidth: 2 })).toEqual(new Set(['platform-corner-omitted']));
  });

  it('S5（rootJog=innerWallReduction=wallTopCompensation=thickness=0，t=0 等價形態）：∅', () => {
    expect(warningSet({ rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0, thickness: 0 })).toEqual(new Set());
  });

  it('S6（lidMarginX=5, lidMarginY=60，極端不對稱）：∅', () => {
    expect(warningSet({ lidMarginX: 5, lidMarginY: 60 })).toEqual(new Set());
  });

  it('S7（basePlatformWidth=0, lidPlatformWidth=5，款式互換）：{gusset-relief-omitted}（見下方實測更正說明）＋結構斷言（下盒得 B 款舌根拓撲、上蓋得 A 款）', () => {
    // 實測更正（Task 4 逐組重推驗證，非憑空修改）：spec v1.4 原預期 S7＝∅，但這裡直接跑
    // telescope.generate() 驗證後發現上蓋（A 款，height=45）的 aGussetPeriphery 複合鏈
    // 四角全數省略（aGussetChainFits 判不可容納，見 tray.ts aGussetChainSelfIntersects）。
    // 根因非本輪 引入的新 bug——A 鏈模板（A_GUSSET_CHAIN_TL/_TR 的固定 T0 內部頂點）
    // 校準點是 base 的典型高度（~59.5-60，height−wallTopCompensation），S7 之前 lid 恆為
    // B 款、從未在 height=45（且 lid 的 wallTopCompensation 恆寫死 0，見 buildLidPiece）
    // 這組現場值下測過 A 鏈——snapALongAnchor 現場值與模板固定內部頂點的相對關係在
    // height=45 偏離校準點過遠，觸發 Fix 2 既有的「a 軸自撞」判定，整鏈省略＋warning
    // （系統設計上的正確行為：優雅降級，非崩潰或壞幾何）。已回報實作輪：spec v1.4
    // S7 列的 ∅ 需要更正為 {gusset-relief-omitted}（A 鏈本身不在本輪 修改範圍，凍結區）。
    const overrides = { basePlatformWidth: 0, lidPlatformWidth: 5 };
    expect(warningSet(overrides)).toEqual(new Set(['gusset-relief-omitted']));

    const params = resolveParams(telescope, overrides);
    const result = telescope.generate(params);
    const basePiece = result.pieces!.find((p) => p.id === 'base')!;
    const lidPiece = result.pieces!.find((p) => p.id === 'lid')!;
    const basePaths = result.paths.filter((p) => basePiece.pathIds.includes(p.id));
    const lidPaths = result.paths.filter((p) => lidPiece.pathIds.includes(p.id));

    // 下盒（B 款）：舌根應有 crease 端段＋V relief（前後壁），不應有 U-notch（uNotch tag）。
    const baseCrease = findTagged(basePaths, 'tongueFold', 'left', 'crease');
    expect(baseCrease.length, 'S7 下盒（B 款）左壁應有端段 crease（U-notch 拓撲換成了 crease 拓撲）').toBeGreaterThan(0);
    const baseVRelief = findTagged(basePaths, 'tongueFold', 'back', 'cut');
    expect(baseVRelief.length, 'S7 下盒（B 款）前後壁應有 V relief').toBeGreaterThan(0);
    const baseNotch = basePaths.filter((p) => p.tags?.includes('uNotch'));
    expect(baseNotch, 'S7 下盒不應再有 U-notch（款式已互換為 B 款）').toHaveLength(0);
    const baseBPeriphery = basePaths.filter((p) => p.tags?.includes('bGussetPeriphery'));
    expect(baseBPeriphery.length, 'S7 下盒應有 B 款角撐周邊（4 角）').toBe(4);

    // 上蓋（A 款）：舌根應有 U-notch，不應有端段 crease／V relief。
    const lidNotch = lidPaths.filter((p) => p.tags?.includes('uNotch'));
    expect(lidNotch.length, 'S7 上蓋（A 款）應有 U-notch 切段拓撲').toBeGreaterThan(0);
    const lidVRelief = lidPaths.filter((p) => p.tags?.includes('vRelief'));
    expect(lidVRelief, 'S7 上蓋不應再有 V relief（款式已互換為 A 款）').toHaveLength(0);
    // A 款角撐周邊複合鏈本身在 height=45 因 gusset-relief-omitted 整鏈省略（見上方測試
    // 開頭的實測更正說明）——這裡驗證的是「省略後仍是 0 或 4 角一致」（不留半成品），
    // 不強求鏈一定生成；鏈是否生成屬 A 鏈自身可容納性判定，非 F5 整組綁款式要驗的範圍。
    const lidAPeriphery = lidPaths.filter((p) => p.tags?.includes('aGussetPeriphery'));
    expect(lidAPeriphery.length % 4, 'A 款角撐周邊鏈若生成必四角一致；此組因 gusset-relief-omitted 整鏈省略＝0').toBe(0);
    // gusset 核心款式判定：B 款（buildGussetB）的讓位槽固定含 R1.5＋R5 圓角，A 款
    // （buildGussetA）核心全是直線（45° 對角＋web 摺線＋外緣斜切，無 arcTo）——用「gusset
    // tag 底下有無圓角」判斷用的是哪個 build 函式，不受角撐周邊鏈是否生成影響。
    const lidGussetArcs = lidPaths.filter((p) => p.tags?.includes('gusset')).flatMap((p) => p.segments).filter((s) => s.kind === 'arc');
    expect(lidGussetArcs, 'S7 上蓋 gusset 核心應無圓角（buildGussetA 全直線，非 buildGussetB 的 R1.5/R5 讓位槽）').toHaveLength(0);
  });

  it('全組：無 crash／無 NaN（含既有 module invariant tongue-flap-fits／gusset-b-fits／liner-flap-fits 皆不 throw）', () => {
    const cases: Record<string, number>[] = [
      { baseLength: 179, baseWidth: 124, basePlatformWidth: 5 },
      { baseLength: 60, baseWidth: 40 },
      { baseLength: 40, baseWidth: 30 },
      { basePlatformWidth: 2 },
      { rootJog: 0, innerWallReduction: 0, wallTopCompensation: 0, thickness: 0 },
      { lidMarginX: 5, lidMarginY: 60 },
      { basePlatformWidth: 0, lidPlatformWidth: 5 },
    ];
    for (const overrides of cases) {
      const params = resolveParams(telescope, overrides);
      let result: GenerateResult | undefined;
      expect(() => {
        result = telescope.generate(params);
      }, JSON.stringify(overrides)).not.toThrow();
      expect(hasNaN(result!.paths.flatMap((p) => p.segments)), JSON.stringify(overrides)).toBe(false);
      for (const inv of telescope.invariants) {
        expect(() => inv.check(params, result!), `${JSON.stringify(overrides)} / ${inv.id}`).not.toThrow();
      }
    }
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
          label: { zh: '下盒', en: 'Base' },
          pathIds: ['b-root-l', 'b-top-l', 'b-root-back', 'b-top-back'],
          textIds: [],
          bounds: { minX: -20, maxX: 5, minY: -8, maxY: 8.3 },
        },
        {
          id: 'lid',
          label: { zh: '上蓋', en: 'Lid' },
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

  it('notch-reduced／notch-omitted／platform-corner-omitted（Slice 5 F4/F6-A 新增）：警告 tags 全部命中真實 path tag（uNotch／platformCorner，見 realPathTagVocabulary 的 withLiner 變體，basePlatformWidth=5 預設值）', () => {
    const vocab = realPathTagVocabulary();
    expect(vocab.has('uNotch'), 'sanity：A 款預設參數應存在 uNotch tag').toBe(true);
    expect(vocab.has('platformCorner'), 'sanity：A 款預設參數應存在 platformCorner tag').toBe(true);

    const reducedParams = resolveParams(telescope, { baseLength: 60, baseWidth: 40 });
    const reducedOutcome = telescope.invariants.find((i) => i.id === 'notch-reduced')!.check(reducedParams, telescope.generate(reducedParams));
    expect(reducedOutcome.ok).toBe(false);
    if (!reducedOutcome.ok) for (const tag of reducedOutcome.tags!) expect(vocab.has(tag), tag).toBe(true);

    const omittedParams = resolveParams(telescope, { baseLength: 40, baseWidth: 30 });
    const omittedOutcome = telescope.invariants.find((i) => i.id === 'notch-omitted')!.check(omittedParams, telescope.generate(omittedParams));
    expect(omittedOutcome.ok).toBe(false);
    if (!omittedOutcome.ok) for (const tag of omittedOutcome.tags!) expect(vocab.has(tag), tag).toBe(true);

    const cornerParams = resolveParams(telescope, { basePlatformWidth: 2 });
    const cornerOutcome = telescope.invariants.find((i) => i.id === 'platform-corner-omitted')!.check(cornerParams, telescope.generate(cornerParams));
    expect(cornerOutcome.ok).toBe(false);
    if (!cornerOutcome.ok) for (const tag of cornerOutcome.tags!) expect(vocab.has(tag), tag).toBe(true);
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
