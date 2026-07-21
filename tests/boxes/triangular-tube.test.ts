import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { normalizeSegments, segmentsBounds } from '@/core/geometry';
import { resolveParams, getBox } from '@/core/registry';
import { triangularTube } from '@/boxes/triangular-tube';
import type { DielinePath, GenerateResult } from '@/core/types';

// 三角盒依原刀模量測值建構名義幾何（thickness 鎖 0 不暴露）；預設 edgeA=58.5/tubeLength=135＝主參考尺寸。
const gen = (overrides?: Partial<Record<string, number | boolean | string>>): GenerateResult =>
  triangularTube.generate(resolveParams(triangularTube, overrides));

type Line = Extract<Segment, { kind: 'line' }>;
const isLine = (s: Segment): s is Line => s.kind === 'line';
const len = (s: Line): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

function segsOf(r: GenerateResult, type: DielinePath['type'], tag: string): Segment[] {
  return r.paths.filter((p) => p.type === type && p.tags?.includes(tag)).flatMap((p) => p.segments);
}
function horizontals(segs: Segment[], eps = 0.01): Line[] {
  return segs.filter(isLine).filter((s) => Math.abs(s.y1 - s.y2) < eps);
}
/** 全 cut 線段端點集合中，是否有點落在 (x,y) 的 tol 內。 */
function hasPoint(pts: { x: number; y: number }[], x: number, y: number, tol = 0.05): boolean {
  return pts.some((p) => Math.hypot(p.x - x, p.y - y) < tol);
}
function endpointsOf(segs: Segment[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const s of segs) {
    if (s.kind === 'line' || s.kind === 'bezier') out.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  }
  return out;
}

describe('triangularTube（三角盒）', () => {
  it('模組載入時已透過 registerBox 自行註冊（id=ttb）', () => {
    expect(getBox('ttb')).toBe(triangularTube);
  });

  it('假旋鈕：每個參數取第二有效值都改變輸出', () => {
    const base = normalizeSegments(gen({}).paths.flatMap((p) => p.segments));
    for (const p of triangularTube.params) {
      const alt = Math.min(p.max ?? 999, (p.default as number) + Math.max(p.step ?? 1, 1));
      const out = normalizeSegments(gen({ [p.key]: alt }).paths.flatMap((s) => s.segments));
      expect(out, `參數 ${p.key} 未接線`).not.toEqual(base);
    }
  });

  it('全部不變式在預設參數下通過', () => {
    const params = resolveParams(triangularTube);
    const result = triangularTube.generate(params);
    for (const inv of triangularTube.invariants) {
      expect(inv.check(params, result), inv.id).toMatchObject({ ok: true });
    }
  });

  // ── golden：三側面剖面 + 管長 ─────────────────────────────────────────
  it('golden 剖面：Face A 58.5 / B 60 / C 61、管長 135（normalized）', () => {
    const r = gen();
    // Face A 自由邊 y=0·長度=tubeLength
    const faceFree = horizontals(segsOf(r, 'cut', 'faceFree'))[0]!;
    expect(faceFree.y1).toBeCloseTo(0, 2);
    expect(len(faceFree)).toBeCloseTo(135, 1);
    // 邊界 y：A/B(58.5)、B/C(118.5)、C/D(179.5)
    const abY = horizontals(segsOf(r, 'crease', 'abCrease'))[0]!.y1;
    const bcY = horizontals(segsOf(r, 'crease', 'bcCrease'))[0]!.y1;
    const cdY = horizontals(segsOf(r, 'crease', 'cdCrease'))[0]!.y1;
    expect(abY - 0).toBeCloseTo(58.5, 2); // edgeA
    expect(bcY - abY).toBeCloseTo(60.0, 2); // edgeB
    expect(cdY - bcY).toBeCloseTo(61.0, 2); // edgeC
  });

  it('golden A/B 複合：中央插槽 cut 寬 64.0、端摺線 abEndCrease 27.501（normalized）', () => {
    const r = gen();
    // 插槽＝abSlot 的水平段（y=57.7·slotOffset 0.799 above A/B）·寬 slotWidth
    const slot = horizontals(segsOf(r, 'cut', 'abSlot')).reduce((a, b) => (len(b) > len(a) ? b : a));
    expect(len(slot)).toBeCloseTo(64.0, 1);
    expect(slot.y1).toBeCloseTo(58.5 - 0.799, 1);
    // 插槽為真穿孔 cut（不是 crease）
    expect(r.paths.some((p) => p.type === 'cut' && p.tags?.includes('abSlot'))).toBe(true);
    // abEndCrease：abCrease 兩端各 27.501
    for (const s of horizontals(segsOf(r, 'crease', 'abCrease'))) {
      expect(len(s)).toBeCloseTo(27.501, 1);
    }
  });

  it('golden 端封等邊三角：triangleSide 59.75、apexHeight 51.745（normalized）', () => {
    const r = gen();
    const triCreases = segsOf(r, 'crease', 'endTriangle').filter(isLine);
    // 8 條（左右各 2 邊·×2 端 → 4 條/端 → 實際每端 2 條 crease·共 4 條）
    expect(triCreases.length).toBe(4);
    // 每條 = triangleSide 59.75
    for (const s of triCreases) expect(len(s)).toBeCloseTo(59.75, 1);
    // 右端 apex（x 最大的端點）與 corner（另一端點·x=corner1_x）算 apexHeight
    const rightTri = triCreases.filter((s) => s.x1 > 100 || s.x2 > 100);
    const apexX = Math.max(...rightTri.flatMap((s) => [s.x1, s.x2]));
    const cornerX = Math.min(...rightTri.flatMap((s) => [s.x1, s.x2]));
    expect(apexX - cornerX).toBeCloseTo(51.745, 1); // flapApexHeight
    // apex 置中於 Face B（y=edgeA+edgeB/2=88.5）
    const apexPt = endpointsOf(rightTri).reduce((a, b) => (b.x > a.x ? b : a));
    expect(apexPt.y).toBeCloseTo(88.5, 1);
  });

  it('golden 外翼封閉式：topLongEdge 57.74 / botLongEdge 59.75、P3/P4/Q1/Q2 錨定 S1 值', () => {
    const r = gen();
    const wing = segsOf(r, 'cut', 'endWing').filter(isLine);
    // 上翼最長段＝topLongEdge(P3→P4)=57.74·下翼最長段＝botLongEdge(Q1→Q2)=59.75
    const lens = wing.map(len).sort((a, b) => a - b);
    // 兩個 ~39.7（apex 回邊·上下各一）、topLongEdge 57.74、botLongEdge 59.75 應各出現於左右端（×2）
    expect(lens.some((l) => Math.abs(l - 57.74) < 0.05)).toBe(true); // topLongEdge
    expect(lens.some((l) => Math.abs(l - 59.75) < 0.05)).toBe(true); // botLongEdge
    // 四遠端頂點封閉式錨值（右端·主參考尺寸）·±0.05
    const pts = endpointsOf(wing);
    expect(hasPoint(pts, 156.8013, 25.2412), 'P3_right').toBe(true);
    expect(hasPoint(pts, 206.8056, 54.1112), 'P4_right').toBe(true);
    expect(hasPoint(pts, 155.0683, 152.7593), 'Q1_right').toBe(true);
    expect(hasPoint(pts, 206.8133, 122.8843), 'Q2_right').toBe(true);
    // 左端鏡射（X 對 tubeCenter=67.5）
    expect(hasPoint(pts, -21.8013, 25.2412), 'P3_left').toBe(true);
    expect(hasPoint(pts, -71.8056, 54.1112), 'P4_left').toBe(true);
  });

  it('golden Zone D：tabBaseDepth 61.5、centralZoneWidth 80.0、穿入比例 0.800±0.005', () => {
    const r = gen();
    const cdY = horizontals(segsOf(r, 'crease', 'cdCrease'))[0]!.y1; // 179.5
    // tabBaseDepth：Zone D base 側邊縱向 cut 長度（zoneD tag·從 C/D 到 base 底）
    const zoneVert = segsOf(r, 'cut', 'zoneD')
      .filter(isLine)
      .filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && Math.min(s.y1, s.y2) >= cdY - 0.5)
      .filter((s) => Math.abs(len(s) - 61.5) < 2);
    expect(zoneVert.length).toBeGreaterThanOrEqual(2);
    expect(len(zoneVert[0]!)).toBeCloseTo(61.5, 1);
    // centralZoneWidth：兩肩邊 x 距（tab root crease 兩段外端）
    const tabRootCreases = horizontals(segsOf(r, 'crease', 'tabRootCrease')).filter(isLine);
    const xs = tabRootCreases.flatMap((s) => [s.x1, s.x2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80.0, 1); // centralZoneWidth
    // 穿入比例＝slotWidth/centralZoneWidth=64/80
    const slot = horizontals(segsOf(r, 'cut', 'abSlot')).reduce((a, b) => (len(b) > len(a) ? b : a));
    expect(len(slot) / 80.0).toBeCloseTo(0.8, 3);
  });

  it('golden Zone D 錐尖：apex 置中（tubeCenter）·深 15.5（=edgeC+15.5 自 C/D）', () => {
    const r = gen();
    const cdY = horizontals(segsOf(r, 'crease', 'cdCrease'))[0]!.y1;
    // 錐尖 apex＝所有 cut 最深 y 的點·x=tubeCenter=67.5
    const allCut = r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments).filter(isLine);
    const deepest = Math.max(...allCut.flatMap((s) => [s.y1, s.y2]));
    expect(deepest - cdY).toBeCloseTo(76.5, 1); // edgeC(61)+15.5
    const apexPt = endpointsOf(allCut).reduce((a, b) => (b.y > a.y ? b : a));
    expect(apexPt.x).toBeCloseTo(67.5, 1); // tubeCenter
  });

  // ── golden：tubeLength 變體（S2 tubeLength=115 → abEndCrease 17.501）──────
  it('golden S2 變體：tubeLength=115 → abEndCrease 17.501（剖面不變）', () => {
    const r = gen({ tubeLength: 115 });
    for (const s of horizontals(segsOf(r, 'crease', 'abCrease'))) {
      expect(len(s)).toBeCloseTo(17.501, 1);
    }
    // 剖面尺寸不隨 tubeLength 變（triangleSide 仍 59.75）
    for (const s of segsOf(r, 'crease', 'endTriangle').filter(isLine)) expect(len(s)).toBeCloseTo(59.75, 1);
  });

  // ── golden：剖面變體（S3 edgeA=78.5·三邊 +20）───────────────────────────
  it('golden S3 變體：edgeA=78.5 → triangleSide 79.75 / slotWidth 84 / centralZoneWidth 100', () => {
    const r = gen({ edgeA: 78.5 });
    for (const s of segsOf(r, 'crease', 'endTriangle').filter(isLine)) expect(len(s)).toBeCloseTo(79.75, 1); // edgeB(80)−0.25
    const slot = horizontals(segsOf(r, 'cut', 'abSlot')).reduce((a, b) => (len(b) > len(a) ? b : a));
    expect(len(slot)).toBeCloseTo(84.0, 1); // edgeC(81)+3
    const tabRootCreases = horizontals(segsOf(r, 'crease', 'tabRootCrease')).filter(isLine);
    const xs = tabRootCreases.flatMap((s) => [s.x1, s.x2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100.0, 1); // edgeC(81)+19
  });

  // ── 裁切外框連續性檢查（可偵測翼片交界缺段/紙橋）───────────────────
  // 純 cut-cut degree 檢查：主外框全閉合（degree-2）·唯四合法 degree-1＝A/B 兩 bridge relief 末端
  // （y≈edgeA+0.7·懸於 A/B 線下）＋ Zone D notch 兩 jog 頂（y≈zoneBaseBot−0.699）。
  // 若移除任一外框連接段（外翼/relief/tube 邊）·該交界端點變 degree-1·數量≠4·此檢查即轉為不通過
  //（可作為連續性回歸的防線）。
  it('裁切外框連續：cut 端點恰 4 個 degree-1（A/B bridge relief ×2 + notch jog ×2）', () => {
    const r = gen();
    const edgeA = 58.5;
    const zoneBaseBot = 58.5 + 60 + 61 + 61.5; // 241
    const ends = endpointsOf(r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments));
    const eps = 0.02;
    const deg1 = ends.filter((p) => ends.filter((q) => Math.hypot(p.x - q.x, p.y - q.y) < eps).length < 2);
    const uniq = deg1.filter((p, i) => deg1.findIndex((q) => Math.hypot(p.x - q.x, p.y - q.y) < eps) === i);
    expect(uniq, `degree-1 cut 端點：${JSON.stringify(uniq)}`).toHaveLength(4);
    // 兩個為 bridge relief 末端（y≈edgeA+0.7）·兩個為 notch jog 頂（y≈zoneBaseBot−0.699）
    const bridgeRel = uniq.filter((p) => Math.abs(p.y - (edgeA + 0.7)) < 0.1);
    const notchJog = uniq.filter((p) => Math.abs(p.y - (zoneBaseBot - 0.699)) < 0.1);
    expect(bridgeRel, 'bridge relief 末端 ×2').toHaveLength(2);
    expect(notchJog, 'notch jog 頂 ×2').toHaveLength(2);
  });

  // ── friction / 合法域 invariant（反例擋下）────────────────────────────
  it('friction-lock-insertion：edgeA 極端使穿入比例出界時判定不通過', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'friction-lock-insertion')!;
    // edgeA=250(max)：ratio=0.941 通過；設超界不可能在合法 UI 域內·用直接算式反例（edgeC 巨大→ratio→1）
    // 這裡用 override 到極大 edgeA（>UI max·仍是合法數）驗上界防呆
    const paramsHi = resolveParams(triangularTube, { edgeA: 400 });
    expect(inv.check(paramsHi, triangularTube.generate(paramsHi))).toMatchObject({ ok: false });
    // 預設通過
    const p0 = resolveParams(triangularTube);
    expect(inv.check(p0, triangularTube.generate(p0))).toMatchObject({ ok: true });
  });

  it('tube-length-valid：tubeLength 過小（< edgeC+21.998）判定不通過', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'tube-length-valid')!;
    const params = resolveParams(triangularTube, { tubeLength: 30 }); // edgeC=61 → floor≈82.998
    expect(inv.check(params, triangularTube.generate(params))).toMatchObject({ ok: false });
  });

  it('cross-section-non-degenerate：edgeA≤1.5 判定不通過（UI min 20 涵蓋·防呆）', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'cross-section-non-degenerate')!;
    const params = resolveParams(triangularTube, { edgeA: 1 });
    expect(inv.check(params, triangularTube.generate(params))).toMatchObject({ ok: false });
  });

  it('all-finite：edgeA=Infinity / tubeLength=Infinity 皆判定不通過', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'all-finite')!;
    for (const bad of [{ edgeA: Infinity }, { tubeLength: Infinity }]) {
      const params = resolveParams(triangularTube, bad);
      expect(inv.check(params, triangularTube.generate(params)), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  // ── schema 契約（字面斷言·非讀 schema·抓 schema 漂移）+ 貼下限邊界 ────────
  it('schema 契約字面：edgeA/tubeLength/tabWidth/tabDepth 四欄，thickness/edgeB/edgeC 不暴露', () => {
    const p = (key: string) => triangularTube.params.find((x) => x.key === key)!;
    const edgeA = p('edgeA');
    expect([edgeA.default, edgeA.min, edgeA.max, edgeA.step], 'edgeA schema').toEqual([58.5, 20, 250, 1]);
    const tubeLength = p('tubeLength');
    expect([tubeLength.default, tubeLength.min, tubeLength.max, tubeLength.step], 'tubeLength schema').toEqual([135, 30, 500, 1]);
    const tabWidth = p('tabWidth');
    expect([tabWidth.default, tabWidth.min, tabWidth.max, tabWidth.step], 'tabWidth schema').toEqual([80, 30, 300, 0.5]);
    const tabDepth = p('tabDepth');
    expect([tabDepth.default, tabDepth.min, tabDepth.max, tabDepth.step], 'tabDepth schema').toEqual([15, 6, 60, 0.5]);
    // thickness/edgeB/edgeC 不暴露（鎖 0 / derived）
    expect(triangularTube.params.map((x) => x.key)).toEqual(['edgeA', 'tubeLength', 'tabWidth', 'tabDepth']);
  });

  // ── 插舌寬/深 derived-default 可 override（舌為主·孔跟隨）─────────
  it('derived-default：tabWidth 隨 edgeA 重算（孔跟隨）·tabDepth 固定 15（插入段·不隨 edgeA）', () => {
    // 預設 edgeA=58.5：tabWidth 派生 80（=edgeC+19）；tabDepth 固定 15（肩 7+錐尖 8）
    const def = resolveParams(triangularTube);
    expect(def.tabWidth).toBeCloseTo(80, 6);
    expect(def.tabDepth).toBe(15);
    // edgeA=78.5：tabWidth 隨剖面重算 100；tabDepth 仍 15（插入段不隨剖面）
    const s3 = resolveParams(triangularTube, { edgeA: 78.5 });
    expect(s3.tabWidth).toBeCloseTo(100, 6);
    expect(s3.tabDepth).toBe(15);
    // override 生效
    const ov = resolveParams(triangularTube, { tabWidth: 90, tabDepth: 20 });
    expect(ov.tabWidth).toBe(90);
    expect(ov.tabDepth).toBe(20);
  });

  // 修正 1：插舌孔隨舌寬連動（slotWidth = tabWidth − 16·abEndCrease/穿入比例全鏈隨動）
  it('tabWidth override→孔+管身佈局連動：tabWidth=100 時 slotWidth=84、abEndCrease 隨動、穿入比例 0.84', () => {
    const r = gen({ tabWidth: 100 });
    // 插槽（插舌孔）寬＝tabWidth−16=84
    const slot = horizontals(segsOf(r, 'cut', 'abSlot')).reduce((a, b) => (len(b) > len(a) ? b : a));
    expect(len(slot)).toBeCloseTo(84, 1);
    // 插舌基座寬（tab 根摺線兩端 x 距）＝100
    const tabRootXs = segsOf(r, 'crease', 'tabRootCrease').filter(isLine).flatMap((s) => [s.x1, s.x2]);
    expect(Math.max(...tabRootXs) - Math.min(...tabRootXs)).toBeCloseTo(100, 1);
    // 每側 tab 根摺線＝(100−25)/2=37.5
    for (const s of horizontals(segsOf(r, 'crease', 'tabRootCrease')).filter(isLine)) expect(len(s)).toBeCloseTo(37.5, 1);
    // abEndCrease 隨 slotWidth 變：(135−84−15.998)/2=17.501（管身 A/B 佈局隨動）
    for (const s of horizontals(segsOf(r, 'crease', 'abCrease'))) expect(len(s)).toBeCloseTo(17.501, 1);
    // 穿入比例＝slot/tab=84/100=0.84·friction invariant 通過
    const params = resolveParams(triangularTube, { tabWidth: 100 });
    expect(triangularTube.invariants.find((i) => i.id === 'friction-lock-insertion')!.check(params, r)).toMatchObject({ ok: true });
  });

  // 修正 2：tabDepth 只動肩+錐尖插入段（基座/盒身不動）·按 7:8 分配
  it('tabDepth override→只動肩錐段：tabDepth=20 時肩 9.33、錐尖 10.67、基座深不變(61.5)', () => {
    const cdY = 58.5 + 60 + 61; // 179.5·C/D 邊界
    const baseBotDefault = cdY + 61.5; // 基座深＝edgeC+0.5=61.5（不受 tabDepth 影響）
    const r = gen({ tabDepth: 20 });
    // 基座深不變：Zone D base 側邊縱向 cut 仍深 61.5（自 C/D）
    const baseVert = segsOf(r, 'cut', 'zoneD').filter(isLine)
      .filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && Math.abs(Math.min(s.y1, s.y2) - cdY) < 0.5 && Math.abs(len(s) - 61.5) < 1);
    expect(baseVert.length, '基座側邊 cut 仍深 61.5').toBeGreaterThanOrEqual(2);
    // 肩段＝20×7/15=9.333：肩邊縱向 cut 自 base 底起深 9.333
    const shoulderVert = segsOf(r, 'cut', 'zoneD').filter(isLine)
      .filter((s) => Math.abs(s.x1 - s.x2) < 0.01 && Math.abs(Math.min(s.y1, s.y2) - baseBotDefault) < 0.5)
      .filter((s) => Math.abs(len(s) - 20 * 7 / 15) < 0.1);
    expect(shoulderVert.length, '肩段深 9.333').toBeGreaterThanOrEqual(2);
    // 錐尖 apex：base 底 + 肩 9.333 + 錐尖 10.667 = tabDepth 20 自 base 底
    const allCut = r.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments).filter(isLine);
    const deepest = Math.max(...allCut.flatMap((s) => [s.y1, s.y2]));
    expect(deepest - baseBotDefault).toBeCloseTo(20, 1); // 肩+錐尖=tabDepth
    expect(deepest - cdY).toBeCloseTo(61.5 + 20, 1); // 基座 61.5 + 插入段 20
  });

  it('tab-base-geometry invariant：寬<27 / 寬>盒身寬 / 插入段深<6 皆擋下·合法 override 全 invariants 通過', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'tab-base-geometry')!;
    for (const ov of [{ tabWidth: 26 }, { tabWidth: 200 /* > tubeLength 135 */ }, { tabDepth: 5 }]) {
      const params = resolveParams(triangularTube, ov);
      expect(inv.check(params, triangularTube.generate(params)), JSON.stringify(ov)).toMatchObject({ ok: false });
    }
    // 合法 override（寬 100 深 20·tube 200）全 invariants 通過
    const ok = resolveParams(triangularTube, { tubeLength: 200, tabWidth: 100, tabDepth: 20 });
    const res = triangularTube.generate(ok);
    for (const i of triangularTube.invariants) expect(i.check(ok, res), i.id).toMatchObject({ ok: true });
  });

  it('tube-length-valid 隨 slotWidth 動態升：tabWidth 大→孔大→下限升（寫死值失效）', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'tube-length-valid')!;
    // tabWidth=120→slotWidth=104→下限=104+18.998=122.998；tubeLength=120 過小→擋下
    const tooShort = resolveParams(triangularTube, { tabWidth: 120, tubeLength: 120 });
    expect(inv.check(tooShort, triangularTube.generate(tooShort))).toMatchObject({ ok: false });
    // 同 tabWidth 但 tubeLength=130 ≥ 122.998→通過
    const okLen = resolveParams(triangularTube, { tabWidth: 120, tubeLength: 130 });
    expect(inv.check(okLen, triangularTube.generate(okLen))).toMatchObject({ ok: true });
  });

  it('合法貼下限邊界 (20,44.498) 與 (250,274.498)：全 invariants 通過', () => {
    for (const ov of [{ edgeA: 20, tubeLength: 44.498 }, { edgeA: 250, tubeLength: 274.498 }]) {
      const params = resolveParams(triangularTube, ov);
      const result = triangularTube.generate(params);
      for (const inv of triangularTube.invariants) {
        expect(inv.check(params, result), `${JSON.stringify(ov)} / ${inv.id}`).toMatchObject({ ok: true });
      }
    }
  });

  it('下限反例：tubeLength 各減小量（跌破 edgeC+21.998）後只由 tube-length-valid 擋下', () => {
    for (const ov of [{ edgeA: 20, tubeLength: 44.0 }, { edgeA: 250, tubeLength: 274.0 }]) {
      const params = resolveParams(triangularTube, ov);
      const result = triangularTube.generate(params);
      const failed = triangularTube.invariants.filter((inv) => !inv.check(params, result).ok).map((inv) => inv.id);
      expect(failed, JSON.stringify(ov)).toEqual(['tube-length-valid']);
    }
  });

  it('明確 NaN：edgeA=NaN / tubeLength=NaN → all-finite 擋下', () => {
    const inv = triangularTube.invariants.find((i) => i.id === 'all-finite')!;
    for (const bad of [{ edgeA: NaN }, { tubeLength: NaN }]) {
      const params = resolveParams(triangularTube, bad);
      const result = triangularTube.generate(params);
      expect(inv.check(params, result), JSON.stringify(bad)).toMatchObject({ ok: false });
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
