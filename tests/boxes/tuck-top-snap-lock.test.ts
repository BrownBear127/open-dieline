import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { normalizeSegments, segmentsBounds } from '@/core/geometry';
import { resolveParams, getBox } from '@/core/registry';
import { tuckTopSnapLock, checkSnapLockClosure } from '@/boxes/tuck-top-snap-lock';
import type { DielinePath, GenerateResult } from '@/core/types';

// golden 一律以 thickness:0 建構（原刀模 刀模為名義幾何·無紙厚補償）；紙厚補償另有專測。
const gen = (overrides?: Partial<Record<string, number | boolean | string>>): GenerateResult =>
  tuckTopSnapLock.generate(resolveParams(tuckTopSnapLock, { thickness: 0, ...overrides }));

type Line = Extract<Segment, { kind: 'line' }>;
const isLine = (s: Segment): s is Line => s.kind === 'line';

/** 取指定 type+tag 的所有線段。 */
function segsOf(result: GenerateResult, type: DielinePath['type'], tag: string): Segment[] {
  return result.paths.filter((p) => p.type === type && p.tags?.includes(tag)).flatMap((p) => p.segments);
}

/** 近水平線段（|y1-y2|<eps）。 */
function horizontals(segs: Segment[], eps = 0.01): Line[] {
  return segs.filter(isLine).filter((s) => Math.abs(s.y1 - s.y2) < eps);
}

/** 由 'D' tag 的縱向 cut/crease 線反推 4 個面板寬（排序相鄰差）。 */
function panelWidths(result: GenerateResult): number[] {
  const xs = result.paths
    .filter((p) => (p.type === 'cut' || p.type === 'crease') && p.tags?.includes('D'))
    .flatMap((p) => p.segments)
    .filter(isLine)
    .filter((s) => Math.abs(s.x1 - s.x2) < 0.01)
    .map((s) => s.x1)
    .sort((a, b) => a - b);
  const widths: number[] = [];
  for (let i = 1; i < xs.length; i++) widths.push(xs[i]! - xs[i - 1]!);
  return widths;
}

describe('tuckTopSnapLock（插底盒）', () => {
  it('模組載入時已透過 registerBox 自行註冊（id=ttsl）', () => {
    expect(getBox('ttsl')).toBe(tuckTopSnapLock);
  });

  it('假旋鈕：每個參數取第二有效值都改變輸出', () => {
    const base = normalizeSegments(gen({}).paths.flatMap((p) => p.segments));
    for (const p of tuckTopSnapLock.params) {
      const alt =
        p.unit === 'enum'
          ? p.options!.find((o) => o.value !== p.default)!.value
          : Math.min(p.max ?? 999, (p.default as number) + Math.max(p.step ?? 1, 1));
      const out = normalizeSegments(gen({ [p.key]: alt }).paths.flatMap((s) => s.segments));
      expect(out, `參數 ${p.key} 未接線`).not.toEqual(base);
    }
  });

  it('全部不變式在預設參數下通過', () => {
    const params = resolveParams(tuckTopSnapLock);
    const result = tuckTopSnapLock.generate(params);
    for (const inv of tuckTopSnapLock.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
  });

  // ── 裁切外框連續性檢查（可偵測翼片交界缺段/紙橋）───────────────────
  // 純 cut-cut degree 檢查：cut 段須構成閉合輪廓，degree≠2 的端點只允許「已知避讓切口末端」。
  // 本盒唯二合法 degree-1＝P3 插舌兩側 straddle 避讓槽末端（止於插舌摺線 y≈yFF·內部相性）。
  // 移除任一連接段（頂 boundaryBump／底 ARC10-12）→ 該交界兩翼片角變 degree-1 → 數量>2 → 紅。
  // 若移除任一連接段·此檢查即會轉為不通過（可作為連續性回歸的防線）。
  it('裁切外框連續：cut 端點 degree=2，唯二 degree-1 為 straddle 避讓槽末端', () => {
    const W = 55;
    const yFF = -(W - 1); // 插舌摺線 y（straddle 避讓槽末端所在）
    for (const glueSide of ['left', 'right'] as const) {
      const r = gen({ glueSide });
      type Pt = { x: number; y: number };
      const ends: Pt[] = [];
      for (const path of r.paths) {
        if (path.type !== 'cut') continue;
        for (const s of path.segments) {
          if (s.kind === 'line' || s.kind === 'bezier') ends.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
        }
      }
      const eps = 0.02;
      const deg1 = ends.filter((p) => ends.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < eps).length < 2);
      const uniq = deg1.filter((p, i) => deg1.findIndex((q) => Math.hypot(p.x - q.x, p.y - q.y) < eps) === i);
      // 恰 2 個 degree-1（連接段被移除會新增翼片角 degree-1·使數量>2）
      expect(uniq, `glueSide=${glueSide} degree-1 cut 端點：${JSON.stringify(uniq)}`).toHaveLength(2);
      // 且兩者皆為 straddle 避讓槽末端（y≈yFF·內部·非落在 y=0/y=D 摺線上的翼片角）
      for (const p of uniq) {
        expect(Math.abs(p.y - yFF), `degree-1 端點 ${JSON.stringify(p)} 應在插舌摺線 y=${yFF}`).toBeLessThan(0.1);
      }
    }
  });

  // ── Number.isFinite 防線（±Infinity 不只 NaN）─────────────────────────
  it('all-finite：dustFlapDepth=Infinity / glueSize=Infinity 皆判定不通過', () => {
    const inv = tuckTopSnapLock.invariants.find((i) => i.id === 'all-finite')!;
    for (const bad of [{ dustFlapDepth: Infinity }, { glueSize: Infinity }]) {
      const params = resolveParams(tuckTopSnapLock, { thickness: 0, ...bad });
      const result = tuckTopSnapLock.generate(params);
      expect(inv.check(params, result), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  // ── 合法 schema 內的退化輸入被相依 invariant 擋下（兩個邊界反例）──────
  it('邊界反例：lockReceiveDepth=1（< 3.5 圓角）觸發 receive-depth-vs-corner，且缺口不倒折（已鉗制）', () => {
    const inv = tuckTopSnapLock.invariants.find((i) => i.id === 'receive-depth-vs-corner')!;
    const params = resolveParams(tuckTopSnapLock, { thickness: 0, lockReceiveDepth: 1 });
    const result = tuckTopSnapLock.generate(params);
    expect(inv.check(params, result)).toMatchObject({ ok: false });
    // 鉗制後幾何不自撞（no-cut-self-intersection 仍通過）
    const si = tuckTopSnapLock.invariants.find((i) => i.id === 'no-cut-self-intersection')!;
    expect(si.check(params, result)).toMatchObject({ ok: true });
  });

  it('邊界反例：L=55（固定 70mm 插舌超出 P3）觸發 top-tuck-fits-panel', () => {
    const inv = tuckTopSnapLock.invariants.find((i) => i.id === 'top-tuck-fits-panel')!;
    const params = resolveParams(tuckTopSnapLock, { thickness: 0, L: 55, W: 40, D: 20, tuckDepth: 4, dustFlapDepth: 5, lockFlapDepth: 25, lockReceiveWidth: 10, lockReceiveDepth: 5, lockTabWidth: 5, glueSize: 5 });
    const result = tuckTopSnapLock.generate(params);
    expect(inv.check(params, result)).toMatchObject({ ok: false });
  });

  // ── thickness 驅動盒身繼承 RTE girth 補償（真旋鈕·非假旋鈕）──────────
  it('thickness=0 等價錨 + t>0 盒身面板寬符合 RTE 補償表 [0,1,1,2]', () => {
    const t0 = normalizeSegments(gen({ thickness: 0 }).paths.flatMap((p) => p.segments));
    const t0Again = normalizeSegments(gen({ thickness: 0 }).paths.flatMap((p) => p.segments));
    expect(t0Again).toEqual(t0); // 決定性
    // t=0.4：面板寬 [L, W+t, L+t, W+2t]（糊邊側 P1 不補償）
    const t = 0.4;
    const widths = panelWidths(gen({ thickness: t }));
    expect(widths[0]).toBeCloseTo(85, 2); // P1 +0t
    expect(widths[1]).toBeCloseTo(55 + t, 2); // P2 +1t
    expect(widths[2]).toBeCloseTo(85 + t, 2); // P3 +1t
    expect(widths[3]).toBeCloseTo(55 + 2 * t, 2); // P4 +2t
    // t>0 輸出與 t=0 不同（真旋鈕）
    const tSegs = normalizeSegments(gen({ thickness: t }).paths.flatMap((p) => p.segments));
    expect(tSegs).not.toEqual(t0);
  });

  // ── golden：盒身 ────────────────────────────────────────────────────
  it('golden 盒身：面板序 L85-W55-L85-W55、盒身高 D125、糊邊 18', () => {
    const r = gen();
    const widths = panelWidths(r);
    expect(widths[0]).toBeCloseTo(85, 2);
    expect(widths[1]).toBeCloseTo(55, 2);
    expect(widths[2]).toBeCloseTo(85, 2);
    expect(widths[3]).toBeCloseTo(55, 2);
    // 盒身高：D tag 縱向線長度
    const dVert = segsOf(r, 'crease', 'D').filter(isLine).find((s) => Math.abs(s.x1 - s.x2) < 0.01)!;
    expect(Math.abs(dVert.y2 - dVert.y1)).toBeCloseTo(125, 2);
    // 糊邊：cut glueSize 最左 x = -18
    const glueXs = segsOf(r, 'cut', 'glueSize').filter(isLine).flatMap((s) => [s.x1, s.x2]);
    expect(Math.min(...glueXs)).toBeCloseTo(-18, 2);
  });

  // ── golden：頂部反插插舌 ──────────────────────────────────────────────
  it('golden 頂部插舌：fold 寬 70、尖端平邊 54.5、插舌深 18、肩弧取樣', () => {
    const r = gen();
    // 插舌摺線（crease W 水平·y≈-54）寬 70
    const foldCrease = horizontals(segsOf(r, 'crease', 'W'))
      .filter((s) => s.y1 < -40) // 排除底摺線等
      .sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1))[0]!;
    expect(Math.abs(foldCrease.x2 - foldCrease.x1)).toBeCloseTo(70, 2);
    expect(foldCrease.y1).toBeCloseTo(-54, 2);
    // 尖端平邊（cut tuckDepth 最上方水平線）
    const tuckH = horizontals(segsOf(r, 'cut', 'tuckDepth'));
    const tip = tuckH.reduce((a, b) => (b.y1 < a.y1 ? b : a));
    expect(Math.abs(tip.x2 - tip.x1)).toBeCloseTo(54.5, 2);
    expect(tip.y1).toBeCloseTo(-72, 2); // -(W-1+tuckDepth)=-(55-1+18)
    // 插舌深 = 尖端 y − flap 摺線 y
    expect(foldCrease.y1 - tip.y1).toBeCloseTo(18, 2);
    // 肩弧 bezier 取樣（起點 / 真實中點 t=0.5 / 終點·±0.1·原刀模 逐字複製值）
    const bez = segsOf(r, 'cut', 'tuckDepth').find((s): s is Extract<Segment, { kind: 'bezier' }> => s.kind === 'bezier')!;
    // 左肩：SBL(140.31,-58.31)→TL(155.25,-72)
    expect(bez.x1).toBeCloseTo(140.31, 1); // 起點
    expect(bez.y1).toBeCloseTo(-58.31, 1);
    expect(bez.x2).toBeCloseTo(155.25, 1); // 終點
    expect(bez.y2).toBeCloseTo(-72, 1);
    // 真實中點：cubic B(0.5)=0.125P0+0.375C1+0.375C2+0.125P3（原刀模對照 (145.115,-68.06)）
    const mid = (a: number, c1: number, c2: number, b: number): number => 0.125 * a + 0.375 * c1 + 0.375 * c2 + 0.125 * b;
    expect(mid(bez.x1, bez.c1x, bez.c2x, bez.x2)).toBeCloseTo(145.12, 1);
    expect(mid(bez.y1, bez.c1y, bez.c2y, bez.y2)).toBeCloseTo(-68.06, 1);
  });

  it('golden 防塵翼：P2 輪廓折點與斜邊終點座標逐字（依原刀模·非只量深度）', () => {
    const r = gen();
    // P2 防塵翼 cut 段（第一條 dustFlapDepth cut path·斜切側在左）
    const p2 = r.paths.find((p) => p.type === 'cut' && p.tags?.includes('dustFlapDepth'))!;
    const lines = p2.segments.filter(isLine);
    // 逐段驗座標：直上 → 2mm 折點 → 長斜邊終點（尖端）→ 尖端平邊 → 直邊
    // 原刀模：(85.602,0)→(85.602,-5.997)→(87.602,-7.997)→(91.761,-31.598)→(137.001,-31.598)
    const near = (v: number, t: number) => Math.abs(v - t) < 0.05;
    // 折點 (87.602,-7.997)
    expect(lines.some((s) => near(s.x2, 87.602) && near(s.y2, -7.997)), '折點 (87.602,-7.997) 缺失').toBe(true);
    // 斜邊終點/尖端角 (91.761,-31.6)——鎖住座標避免退回錯誤的 93.759
    expect(lines.some((s) => near(s.x2, 91.761) && near(s.y2, -31.6)), '斜邊終點應為 91.761 非 93.759').toBe(true);
    expect(lines.some((s) => near(s.x1, 93.759)), '不應出現錯誤的 93.759 x 座標').toBe(false);
    // 深度仍為 31.6
    const tipY = Math.min(...horizontals(segsOf(r, 'cut', 'dustFlapDepth')).map((s) => s.y1));
    expect(tipY).toBeCloseTo(-31.6, 1);
  });

  // ── 相依 invariant 用補償後 P3 寬（不誤擋合法紙厚輸入）───────────────
  it('補償後合法：L=84,t=0.4（P3 實 84.4 容得下插舌）＋ L=85,t=0.8,Rw=76 皆通過全 invariants', () => {
    for (const ov of [
      { L: 84, thickness: 0.4 },
      { L: 85, thickness: 0.8, lockReceiveWidth: 76 },
    ]) {
      const params = resolveParams(tuckTopSnapLock, ov);
      const result = tuckTopSnapLock.generate(params);
      for (const inv of tuckTopSnapLock.invariants) {
        expect(inv.check(params, result), `${JSON.stringify(ov)} / ${inv.id}`).toMatchObject({ ok: true });
      }
    }
  });

  // ── golden：snap-lock 底 ─────────────────────────────────────────────
  it('golden snap-lock：底片深 38.5、P1 尖端寬 31.5、P3 缺口寬 39.5、缺口內縮 11.0', () => {
    const r = gen();
    const yBot = 125;
    // 底片深：所有 cut 最深 y
    const allCut = r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments).filter(isLine);
    const deepest = Math.max(...allCut.flatMap((s) => [s.y1, s.y2]));
    expect(deepest - yBot).toBeCloseTo(38.5, 1);
    // P1 尖端平邊（cut lockTabWidth 最深水平線）寬 31.5
    const tabH = horizontals(segsOf(r, 'cut', 'lockTabWidth'));
    const tabTip = tabH.reduce((a, b) => (b.y1 > a.y1 ? b : a));
    expect(Math.abs(tabTip.x2 - tabTip.x1)).toBeCloseTo(31.5, 2);
    expect(tabTip.y1 - yBot).toBeCloseTo(38.5, 1);
    // P3 缺口內緣（cut lockReceiveWidth 水平線·非最深的那條·y≈152.5）寬 39.5
    const recvH = horizontals(segsOf(r, 'cut', 'lockReceiveWidth'));
    const notch = recvH.find((s) => Math.abs(s.y1 - (yBot + 27.5)) < 1)!;
    expect(Math.abs(notch.x2 - notch.x1)).toBeCloseTo(39.5, 2);
    expect(notch.y1 - yBot).toBeCloseTo(27.5, 1); // 38.5 − 11.0
  });

  it('checkSnapLockClosure：原刀模 實測值與 normalized 預設皆 PASS', () => {
    // normalized 預設
    const norm = checkSnapLockClosure({ L: 85, W: 55, lockFlapDepth: 38.5, lockReceiveWidth: 39.5, lockReceiveDepth: 11.0, lockTabWidth: 31.5 });
    expect(norm.pass, `normalized: ${JSON.stringify(norm.results)}`).toBe(true);
    expect(norm.overlapDepth).toBeCloseTo(11.0, 2);
    expect(norm.warnings).toHaveLength(0);
    // 原刀模 實測值
    const src = checkSnapLockClosure({ L: 85.002, W: 54.998, lockFlapDepth: 38.548, lockReceiveWidth: 39.5006, lockReceiveDepth: 11.049, lockTabWidth: 31.4995 });
    expect(src.pass).toBe(true);
    expect(src.overlapDepth).toBeCloseTo(11.049, 2);
  });

  it('checkSnapLockClosure：三級契約（≤0 hard FAIL、0<x<4 warning 不擋 pass、≥4 乾淨過）', () => {
    // overlapDepth ≤ 0 → hard FAIL：2F−Rd−W ≤0，取 F 小
    const hardFail = checkSnapLockClosure({ L: 85, W: 55, lockFlapDepth: 30, lockReceiveWidth: 39.5, lockReceiveDepth: 11, lockTabWidth: 31.5 });
    expect(hardFail.overlapDepth).toBeLessThanOrEqual(0);
    expect(hardFail.pass).toBe(false);
    // 0 < overlapDepth < 4 → warning 但 pass=true（其餘條件都成立）
    const shallow = checkSnapLockClosure({ L: 85, W: 55, lockFlapDepth: 34, lockReceiveWidth: 39.5, lockReceiveDepth: 11, lockTabWidth: 31.5 });
    expect(shallow.overlapDepth).toBeGreaterThan(0);
    expect(shallow.overlapDepth).toBeLessThan(4);
    expect(shallow.pass).toBe(true);
    expect(shallow.warnings.length).toBeGreaterThan(0);
  });

  it('glueSide=right：整體水平鏡射，仍通過全部不變式且輸出與 left 不同', () => {
    const left = normalizeSegments(gen({ glueSide: 'left' }).paths.flatMap((p) => p.segments));
    const rightParams = resolveParams(tuckTopSnapLock, { glueSide: 'right' });
    const rightResult = tuckTopSnapLock.generate(rightParams);
    const right = normalizeSegments(rightResult.paths.flatMap((p) => p.segments));
    expect(right).not.toEqual(left);
    for (const inv of tuckTopSnapLock.invariants) {
      expect(inv.check(rightParams, rightResult), inv.id).toMatchObject({ ok: true });
    }
  });

  it('golden 快照', () => {
    const result = gen();
    expect(normalizeSegments(result.paths.flatMap((p) => p.segments))).toMatchSnapshot();
  });

  it('bounds 完整涵蓋且有限', () => {
    const r = gen();
    const actual = segmentsBounds(r.paths.flatMap((p) => p.segments));
    expect(actual.minX).toBeGreaterThanOrEqual(r.bounds.minX - 0.01);
    expect(actual.maxX).toBeLessThanOrEqual(r.bounds.maxX + 0.01);
    for (const v of Object.values(r.bounds)) expect(Number.isFinite(v)).toBe(true);
  });
});
