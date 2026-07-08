/**
 * 天地盒生產刀模具名槽位對帳 fixture 測試（Slice 2 Task 5）。
 *
 * 這是整個 Slice 2 的保真證明：把「新模組 vs 生產刀模量測」的對帳固化成
 * fixture＋分層比對，而非散落在各處的手算斷言。比對規則見 spec §4.2（附錄
 * `.superpowers/sdd/量測附錄` 逐槽抄錄）：
 *   1. t 無關槽位（source=measured、tIndependent=true）：x 向 |生成−預期| ≤0.05
 *   2. t 相關槽位：公式自洽（生成值代公式驗）＋ x 向 |生成−量測| ≤0.15；
 *      corrected 槽（lid.x.outerWall/innerWall）只驗公式修正值 ≤0.05、不對量測——
 *      這兩槽是新模組刻意做生產品漏做的平齊補償，差值＝t 是設計意圖不是 bug。
 *   3. y 向：只驗序列完整性＋公式關係，不驗與生產品的絕對差（D12 單一等邊 margin
 *      定案的已知後果）。
 *   4. 內襯 golden：圍框 203.4×148.4、翻邊 10.9、段序 tab|203.4|148.4|203.4|148.4、
 *      壁高 60（§4.2 導出鏈公式自產，不引用重建 SVG 數值）。
 *
 * 抽駐留座標的做法沿用 tray.ts 的 tag 慣例（['<landmark>','<side>']，見 telescope.test.ts
 * 對 generateTray() 的既有測試），但這裡一律走完整的 telescope.generate() 管線（而非直接呼叫
 * generateTray()/generateLiner()）——這是本輪 要驗的「整合管線保真」，不是個別幾何單元。
 * 純測試模組，helper 與 index.ts 內部私有函式（未 export）同構但各自持有，不跨檔耦合。
 */
import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, hasSelfIntersection } from '@/core/geometry';
import type { DielinePath, GenerateResult, LineType } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { telescope } from '@/boxes/telescope';
import { deriveLinerFrame } from '@/boxes/telescope/liner';
import { validatePieces } from '@/core/pieces';
import fixtureRaw from './fixtures/telescope-reference.json';

// ─────────────────────────────────────────────────────────────────────────
// fixture 型別與載入
// ─────────────────────────────────────────────────────────────────────────

interface SlotFixture {
  name: string;
  expected: number | null;
  measured: number | null;
  lineType: string;
  source: 'measured' | 'corrected';
  tIndependent: boolean;
  /** true＝結構性槽位（無數值可比對，只驗線型序列，如 base.x.tuckFoldLine）。 */
  structural?: boolean;
  note?: string;
}

interface FixtureParams {
  baseLength: number;
  baseWidth: number;
  baseHeight: number;
  lidMargin: number;
  lidHeight: number;
  basePlatformWidth: number;
  lidPlatformWidth: number;
  thickness: number;
  linerEnabled: boolean;
  linerFitGap: number;
  // index signature：滿足 registry.ts OverrideMap（Partial<Record<string,...>>）的結構要求，
  // 讓 fixture.params 可直接傳給 resolveParams()，同時保留具名欄位的型別安全。
  [key: string]: number | boolean;
}

interface TelescopeReferenceFixture {
  params: FixtureParams;
  slots: SlotFixture[];
}

const fixture = fixtureRaw as TelescopeReferenceFixture;

// ─────────────────────────────────────────────────────────────────────────
// 幾何抽取 helper（沿用 tray.ts／telescope/index.ts 的 tag 慣例；各測試檔自持一份，
// 不 import 其他測試檔——避免執行到對方檔案頂層的 describe 造成重複註冊）
// ─────────────────────────────────────────────────────────────────────────

type LineSeg = Extract<Segment, { kind: 'line' }>;

/** 找出同時帶有 landmark 與 side 兩個 tag（可選再篩線型）的路徑。 */
function findTagged(paths: DielinePath[], landmark: string, side: string, type?: LineType): DielinePath[] {
  return paths.filter((p) => p.tags?.includes(landmark) && p.tags?.includes(side) && (type === undefined || p.type === type));
}

/** 單一 line segment 在指定 axis 上的駐留座標（非 line 或非該軸定值時擲錯）。 */
function alongOf(seg: Segment, axis: 'x' | 'y'): number {
  if (seg.kind !== 'line') throw new Error('alongOf: 預期 line segment');
  const [a1, a2] = axis === 'x' ? [seg.x1, seg.x2] : [seg.y1, seg.y2];
  if (Math.abs(a1 - a2) > 1e-9) throw new Error(`alongOf: 線段在 ${axis} 軸上不是定值（非該方向的駐留線）`);
  return a1;
}

/** 一組 segments 裡所有 line 端點在指定 axis 上的座標值（含重複）。 */
function allAlongValues(segs: Segment[], axis: 'x' | 'y'): number[] {
  const vals: number[] = [];
  for (const s of segs) {
    if (s.kind === 'line') vals.push(axis === 'x' ? s.x1 : s.y1, axis === 'x' ? s.x2 : s.y2);
  }
  return vals;
}

/** 某 landmark/side/軸/線型的所有候選駐留座標。 */
function creaseAlongValues(paths: DielinePath[], landmark: string, side: string, axis: 'x' | 'y', type: LineType): number[] {
  return allAlongValues(
    findTagged(paths, landmark, side, type).flatMap((p) => p.segments),
    axis,
  );
}

/** 兩組候選駐留座標之間的最小絕對距離（抓出真正相鄰的那一對，見 index.ts 同名 helper 的推導）。 */
function minAbsGap(as: number[], bs: number[]): number {
  let min = Infinity;
  for (const a of as) for (const b of bs) min = Math.min(min, Math.abs(b - a));
  return min;
}

/** 兩組候選駐留座標之間的最大絕對距離（抽「全深」用，如 tuckFlap 的最深點）。 */
function maxAbsGap(as: number[], bs: number[]): number {
  let max = -Infinity;
  for (const a of as) for (const b of bs) max = Math.max(max, Math.abs(b - a));
  return max;
}

/** 同一 tag 底下相異駐留座標的跨距（如 wallTop 兩條 crease 的間距＝platform；少於 2 相異值回 0）。 */
function creaseSpan(paths: DielinePath[], landmark: string, side: string, axis: 'x' | 'y', type: LineType): number {
  const vals = [...new Set(creaseAlongValues(paths, landmark, side, axis, type))];
  if (vals.length < 2) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

// ─────────────────────────────────────────────────────────────────────────
// 每槽的抽取函式與公式（照附錄槽位表逐槽對應；x 向用 side='left'、y 向用 side='back'，
// 與 index.ts 私有 helper／telescope.test.ts 既有測試同一慣例——四面牆鏡射對稱，
// 單側抽取足以代表）
// ─────────────────────────────────────────────────────────────────────────

/** 插底舌全深固定常數——照 tray.ts 同名私有常數（該檔未 export，這裡獨立持有一份）。 */
const TUCK_FLAP_DEPTH = 15;

type Extractor = (basePaths: DielinePath[], lidPaths: DielinePath[]) => number;
type Formula = (p: FixtureParams) => number;

const EXTRACTORS: Record<string, Extractor> = {
  'base.x.panel': (b) => minAbsGap(creaseAlongValues(b, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(b, 'wallRoot', 'right', 'x', 'crease')),
  'base.x.outerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(b, 'wallTop', 'left', 'x', 'crease')),
  'base.x.platform': (b) => creaseSpan(b, 'wallTop', 'left', 'x', 'crease'),
  'base.x.innerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallTop', 'left', 'x', 'crease'), creaseAlongValues(b, 'tongueFold', 'left', 'x', 'crease')),
  'base.x.tuckFlap': (b) => maxAbsGap(creaseAlongValues(b, 'tongueFold', 'left', 'x', 'crease'), creaseAlongValues(b, 'tongueFlap', 'left', 'x', 'cut')),
  'base.y.doubleCreaseGap': (b) => creaseSpan(b, 'wallRoot', 'back', 'y', 'crease'),
  'base.y.outerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallRoot', 'back', 'y', 'crease'), creaseAlongValues(b, 'wallTop', 'back', 'y', 'crease')),
  'base.y.platform': (b) => creaseSpan(b, 'wallTop', 'back', 'y', 'crease'),
  'base.y.innerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallTop', 'back', 'y', 'crease'), creaseAlongValues(b, 'tongueFold', 'back', 'y', 'crease')),
  'base.y.tuckFlap': (b) => maxAbsGap(creaseAlongValues(b, 'tongueFold', 'back', 'y', 'crease'), creaseAlongValues(b, 'tongueFlap', 'back', 'y', 'cut')),
  'lid.x.panel': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(l, 'wallRoot', 'right', 'x', 'crease')),
  'lid.x.outerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(l, 'wallTop', 'left', 'x', 'crease')),
  'lid.x.innerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallTop', 'left', 'x', 'crease'), creaseAlongValues(l, 'tongueFold', 'left', 'x', 'crease')),
  'lid.x.tuckFlap': (_b, l) => maxAbsGap(creaseAlongValues(l, 'tongueFold', 'left', 'x', 'crease'), creaseAlongValues(l, 'tongueFlap', 'left', 'x', 'cut')),
  'lid.y.doubleCreaseGap': (_b, l) => creaseSpan(l, 'wallRoot', 'back', 'y', 'crease'),
  'lid.y.outerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'back', 'y', 'crease'), creaseAlongValues(l, 'wallTop', 'back', 'y', 'crease')),
  'lid.y.innerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallTop', 'back', 'y', 'crease'), creaseAlongValues(l, 'tongueFold', 'back', 'y', 'crease')),
  'lid.y.tuckFlap': (_b, l) => maxAbsGap(creaseAlongValues(l, 'tongueFold', 'back', 'y', 'crease'), creaseAlongValues(l, 'tongueFlap', 'back', 'y', 'cut')),
  'lid.y.panel': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'front', 'y', 'crease'), creaseAlongValues(l, 'wallRoot', 'back', 'y', 'crease')),
};

const FORMULAS: Record<string, Formula> = {
  'base.x.panel': (p) => p.baseWidth,
  'base.x.outerWall': (p) => p.baseHeight - p.thickness,
  'base.x.platform': (p) => p.basePlatformWidth,
  'base.x.innerWall': (p) => p.baseHeight - 3 * p.thickness,
  'base.x.tuckFlap': () => TUCK_FLAP_DEPTH,
  'base.y.doubleCreaseGap': (p) => p.thickness,
  'base.y.outerWall': (p) => p.baseHeight,
  'base.y.platform': (p) => p.basePlatformWidth,
  'base.y.innerWall': (p) => p.baseHeight - 2 * p.thickness,
  'base.y.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.x.panel': (p) => p.baseWidth + 2 * p.lidMargin,
  'lid.x.outerWall': (p) => p.lidHeight - p.thickness,
  'lid.x.innerWall': (p) => p.lidHeight - 3 * p.thickness,
  'lid.x.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.y.doubleCreaseGap': (p) => p.thickness,
  'lid.y.outerWall': (p) => p.lidHeight,
  'lid.y.innerWall': (p) => p.lidHeight - 2 * p.thickness,
  'lid.y.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.y.panel': (p) => p.baseLength + 2 * p.lidMargin,
};

// ─────────────────────────────────────────────────────────────────────────
// 分層判定（純函式，回傳 {ok,reason} 而非直接 expect——這樣才能在「防假陽性」測試裡
// 餵故意錯誤的值驗證判定邏輯真的有牙齒，而不是只靠肉眼看一次）
// ─────────────────────────────────────────────────────────────────────────

interface Verdict {
  ok: boolean;
  reason?: string;
}

const FORMULA_EPS = 1e-6; // 純浮點加減鏈，理論上應精確相等，容差只吸收浮點雜訊
const T_INDEPENDENT_TOL = 0.05;
const CORRECTED_TOL = 0.05;
const MEASURED_TOL = 0.15;

/**
 * 對單一數值槽套用 spec §4.2 三層規則。formulaValue 由呼叫端算好傳入（見下方測試迴圈），
 * 讓這個函式保持純粹、可單獨用構造出的假資料測試（見「防假陽性」describe block）。
 */
function judgeNumericSlot(slot: SlotFixture, generated: number, formulaValue: number): Verdict {
  const formulaDiff = Math.abs(generated - formulaValue);
  if (formulaDiff > FORMULA_EPS) {
    return { ok: false, reason: `公式不自洽：生成 ${generated} vs 公式值 ${formulaValue}（差 ${formulaDiff.toFixed(4)} > ${FORMULA_EPS}）` };
  }

  const axis = slot.name.includes('.x.') ? 'x' : 'y';
  if (axis === 'y') {
    return { ok: true }; // y 向：公式已驗過，不驗與生產品的絕對差（spec §4.2 規則 3）
  }

  if (slot.source === 'corrected') {
    const diff = Math.abs(generated - slot.expected!);
    if (diff > CORRECTED_TOL) {
      return { ok: false, reason: `corrected 槽 |生成−修正值|=${diff.toFixed(4)} > ${CORRECTED_TOL}（不得對量測值放寬）` };
    }
    return { ok: true };
  }

  if (slot.tIndependent) {
    const diff = Math.abs(generated - slot.expected!);
    if (diff > T_INDEPENDENT_TOL) {
      return { ok: false, reason: `t 無關槽 |生成−預期|=${diff.toFixed(4)} > ${T_INDEPENDENT_TOL}` };
    }
    return { ok: true };
  }

  // t 相關、x 向、非 corrected：公式已驗（上方），再驗 x 向與量測絕對差 ≤0.15
  const diff = Math.abs(generated - slot.measured!);
  if (diff > MEASURED_TOL) {
    return { ok: false, reason: `t 相關槽 |生成−量測|=${diff.toFixed(4)} > ${MEASURED_TOL}` };
  }
  return { ok: true };
}

/** base.x.tuckFoldLine 結構檢查：舌摺線應同時有 halfcut（中段 1 段）與 crease（兩端共 2 段）。 */
function checkTuckFoldLineStructure(paths: DielinePath[], side: string): Verdict {
  const crease = findTagged(paths, 'tongueFold', side, 'crease');
  const halfcut = findTagged(paths, 'tongueFold', side, 'halfcut');
  if (crease.length === 0) return { ok: false, reason: `tongueFold(${side}) 缺 crease（兩端讓位角撐）` };
  if (halfcut.length === 0) return { ok: false, reason: `tongueFold(${side}) 缺 halfcut（中段）` };
  if (crease[0]!.segments.length !== 2) {
    return { ok: false, reason: `tongueFold(${side}) crease 應恰有 2 段（兩端），實際 ${crease[0]!.segments.length}` };
  }
  if (halfcut[0]!.segments.length !== 1) {
    return { ok: false, reason: `tongueFold(${side}) halfcut 應恰有 1 段（中段），實際 ${halfcut[0]!.segments.length}` };
  }
  return { ok: true };
}

/**
 * y 向剖面序列完整性（spec §4.2 規則 3）：外壁→〔平台〕→內壁→halfcut→舌片的序位、線型皆須
 * 正確——用「離內側 root 座標的絕對距離」嚴格遞增來判斷序位（正負號無關，四面牆鏡射對稱通用）。
 */
function checkYProfileSequence(paths: DielinePath[], side: 'back' | 'front', platformWidth: number): Verdict {
  const rootPath = findTagged(paths, 'wallRoot', side, 'crease');
  if (rootPath.length !== 1) return { ok: false, reason: `wallRoot(${side}) 應恰有 1 條 path，實際 ${rootPath.length}` };
  if (rootPath[0]!.segments.length !== 2) {
    return { ok: false, reason: `wallRoot(${side}) y 向應為雙 crease（2 段），實際 ${rootPath[0]!.segments.length}` };
  }
  const rootAlongs = [...new Set(rootPath[0]!.segments.map((s) => alongOf(s, 'y')))].sort((a, b) => a - b);
  if (rootAlongs.length !== 2) return { ok: false, reason: `wallRoot(${side}) 雙 crease 應有 2 相異座標，實際 ${rootAlongs.length}` };
  const innerRoot = rootAlongs[0]!;

  const topPath = findTagged(paths, 'wallTop', side, 'crease');
  if (topPath.length !== 1) return { ok: false, reason: `wallTop(${side}) 應恰有 1 條 path，實際 ${topPath.length}` };
  const expectedTopLines = platformWidth > 0 ? 2 : 1;
  if (topPath[0]!.segments.length !== expectedTopLines) {
    return {
      ok: false,
      reason: `wallTop(${side}) 線段數應為 ${expectedTopLines}（platform=${platformWidth}），實際 ${topPath[0]!.segments.length}`,
    };
  }
  const topAlongs = [...new Set(topPath[0]!.segments.map((s) => alongOf(s, 'y')))].sort(
    (a, b) => Math.abs(a - innerRoot) - Math.abs(b - innerRoot),
  );

  const foldStruct = checkTuckFoldLineStructure(paths, side);
  if (!foldStruct.ok) return foldStruct;
  const foldAlong = alongOf(findTagged(paths, 'tongueFold', side, 'crease')[0]!.segments[0]!, 'y');

  const flapPath = findTagged(paths, 'tongueFlap', side, 'cut');
  if (flapPath.length !== 1) return { ok: false, reason: `tongueFlap(${side}) 應恰有 1 條 cut path，實際 ${flapPath.length}` };
  const flapAlongs = allAlongValues(flapPath[0]!.segments, 'y');
  const flapDeepest = flapAlongs.reduce((best, v) => (Math.abs(v - foldAlong) > Math.abs(best - foldAlong) ? v : best), flapAlongs[0]!);

  const distances = [Math.abs(rootAlongs[1]! - innerRoot), ...topAlongs.map((v) => Math.abs(v - innerRoot)), Math.abs(foldAlong - innerRoot), Math.abs(flapDeepest - innerRoot)];
  for (let i = 1; i < distances.length; i++) {
    if (!(distances[i]! > distances[i - 1]!)) {
      return { ok: false, reason: `序位第 ${i} 項（${distances[i]}）未嚴格遠於前一項（${distances[i - 1]}）——序列錯位` };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────
// 生成一次，供本檔所有 describe 共用（fixture 參數固定，不需每個 it() 各自重算）
// ─────────────────────────────────────────────────────────────────────────

const fixtureResolvedParams = resolveParams(telescope, fixture.params);
const fixtureResult = telescope.generate(fixtureResolvedParams);
const basePiece = fixtureResult.pieces!.find((p) => p.id === 'base')!;
const lidPiece = fixtureResult.pieces!.find((p) => p.id === 'lid')!;
const basePaths = fixtureResult.paths.filter((p) => basePiece.pathIds.includes(p.id));
const lidPaths = fixtureResult.paths.filter((p) => lidPiece.pathIds.includes(p.id));

describe('telescope: 生產刀模具名槽位分層對帳（Slice 2 Task 5）', () => {
  it('fixture 參數生成的 GenerateResult 通過 pieces 完整性（validatePieces）', () => {
    expect(validatePieces(fixtureResult)).toEqual({ ok: true });
  });

  it('fixture 槽位數＝20（base 11 + lid 9，逐槽對照附錄，防漏槽/多槽/重複命名）', () => {
    expect(fixture.slots).toHaveLength(20);
    expect(fixture.slots.filter((s) => s.name.startsWith('base.'))).toHaveLength(11);
    expect(fixture.slots.filter((s) => s.name.startsWith('lid.'))).toHaveLength(9);
    expect(new Set(fixture.slots.map((s) => s.name)).size, '槽名不可重複').toBe(20);
  });

  describe('逐槽分層比對', () => {
    for (const slot of fixture.slots) {
      const tag = slot.structural ? '結構（線型序列）' : `source=${slot.source}${slot.tIndependent ? '、t無關' : ''}`;
      it(`${slot.name}（${tag}）`, () => {
        const paths = slot.name.startsWith('base.') ? basePaths : lidPaths;

        if (slot.structural) {
          const side = slot.name.includes('.x.') ? 'left' : 'back';
          const verdict = checkTuckFoldLineStructure(paths, side);
          expect(verdict.ok, verdict.reason).toBe(true);
          return;
        }

        const extractor = EXTRACTORS[slot.name];
        const formula = FORMULAS[slot.name];
        expect(extractor, `${slot.name}: fixture 與測試映射不同步——缺抽取函式`).toBeDefined();
        expect(formula, `${slot.name}: fixture 與測試映射不同步——缺公式函式`).toBeDefined();

        const generated = extractor!(basePaths, lidPaths);
        const formulaValue = formula!(fixture.params);
        // sanity：公式值應與 fixture.expected 一致（兩個獨立來源——fixture 作者手填 vs
        // 這裡重新推導的公式函式——本該完全一致，不一致代表 fixture 手誤或公式理解有誤）
        expect(Math.abs(formulaValue - slot.expected!), `${slot.name}: fixture.expected 與公式值不一致`).toBeLessThanOrEqual(1e-9);

        const verdict = judgeNumericSlot(slot, generated, formulaValue);
        expect(verdict.ok, `${slot.name}: ${verdict.reason ?? ''}（生成=${generated.toFixed(4)}）`).toBe(true);
      });
    }
  });

  describe('y 向序列完整性（規則 3：結構＋公式，不驗絕對值——附錄未逐槽列出但 spec 明文要求）', () => {
    it('base y 向（platform=5，back 側）：外壁→平台→內壁→halfcut→舌片序位正確', () => {
      const verdict = checkYProfileSequence(basePaths, 'back', fixture.params.basePlatformWidth);
      expect(verdict.ok, verdict.reason).toBe(true);
    });

    it('lid y 向（platform=0，back 側）：外壁→內壁→halfcut→舌片序位正確（無平台段）', () => {
      const verdict = checkYProfileSequence(lidPaths, 'back', fixture.params.lidPlatformWidth);
      expect(verdict.ok, verdict.reason).toBe(true);
    });
  });

  describe('內襯 golden（規則 4：圍框 203.4×148.4、翻邊 10.9、段序 tab|L|W|L|W、壁高 60）', () => {
    it('deriveLinerFrame 公式值（單元層，等邊 margin＋t=0.4 自產，不引用重建 SVG 數值）', () => {
      const frame = deriveLinerFrame({
        baseLength: fixture.params.baseLength,
        baseWidth: fixture.params.baseWidth,
        lidMargin: fixture.params.lidMargin,
        thickness: fixture.params.thickness,
        fitGap: fixture.params.linerFitGap,
      });
      expect(frame.frameL, '圍框外圍（長壁側）').toBeCloseTo(203.4, 6);
      expect(frame.frameW, '圍框外圍（短壁側）').toBeCloseTo(148.4, 6);
      expect(frame.flange, '翻邊寬').toBeCloseTo(10.9, 6);
    });

    it('整合管線（telescope.generate 實際組裝的 liner 片）：段序 tab|203.4|148.4|203.4|148.4、壁高 60', () => {
      const linerPiece = fixtureResult.pieces!.find((p) => p.id === 'liner')!;
      const linerPaths = fixtureResult.paths.filter((p) => linerPiece.pathIds.includes(p.id));

      const tabRoot = linerPaths.find((p) => p.type === 'crease' && p.tags?.includes('linerTab') && p.tags?.includes('root'));
      expect(tabRoot, '應有 linerTab+root 摺線').toBeDefined();
      const tabRootSeg = tabRoot!.segments[0] as LineSeg;
      expect(tabRootSeg.x1, 'tab 根摺線應為鉛直線（x1=x2）').toBeCloseTo(tabRootSeg.x2, 6);
      expect(Math.abs(tabRootSeg.y2 - tabRootSeg.y1), '壁高＝baseHeight＝60').toBeCloseTo(60, 6);

      const folds = linerPaths.filter((p) => p.type === 'crease' && p.tags?.includes('linerWall') && p.tags?.includes('fold'));
      expect(folds, '4 段壁應有 3 條壁間摺線（最後一段是外緣，不摺）').toHaveLength(3);
      const foldXs = folds.map((p) => (p.segments[0] as LineSeg).x1);

      const seal = linerPaths.find((p) => p.type === 'cut' && p.tags?.includes('linerWall') && p.tags?.includes('end'));
      expect(seal, '應有 linerWall+end 封邊').toBeDefined();
      const sealX = (seal!.segments[0] as LineSeg).x1;

      const boundaries = [tabRootSeg.x1, ...foldXs, sealX].sort((a, b) => a - b);
      expect(boundaries, '應有 5 個邊界（tab 根 + 3 條壁間摺線 + 封邊）').toHaveLength(5);
      const widths = boundaries.slice(1).map((x, i) => x - boundaries[i]!);
      expect(widths[0], '段序第 1 段＝長壁 frameL').toBeCloseTo(203.4, 6);
      expect(widths[1], '段序第 2 段＝短壁 frameW').toBeCloseTo(148.4, 6);
      expect(widths[2], '段序第 3 段＝長壁 frameL').toBeCloseTo(203.4, 6);
      expect(widths[3], '段序第 4 段＝短壁 frameW').toBeCloseTo(148.4, 6);
    });
  });

  describe('防假陽性：judgeNumericSlot 對刻意錯誤值必須標記 not-ok（不能只靠肉眼驗一次）', () => {
    it('t 無關槽：生成值偏移超過 0.05 應被抓到', () => {
      const slot: SlotFixture = { name: 'base.x.panel', expected: 124, measured: 124, lineType: 'x', source: 'measured', tIndependent: true };
      expect(judgeNumericSlot(slot, 124.2, 124).ok, '偏移 0.2 > 0.05 應 fail').toBe(false);
      expect(judgeNumericSlot(slot, 124.0, 124).ok, '對照組：正確值應 pass（判定器不能永遠回傳 false）').toBe(true);
    });

    it('t 相關 x 向槽：公式對但與量測差超過 0.15 應被抓到', () => {
      const slot: SlotFixture = { name: 'base.x.outerWall', expected: 59.6, measured: 59.6 - 0.2, lineType: '—', source: 'measured', tIndependent: false };
      expect(judgeNumericSlot(slot, 59.6, 59.6).ok, '量測差 0.2 > 0.15 應 fail（即使公式自洽）').toBe(false);
    });

    it('t 相關 x 向槽：公式不自洽應被抓到（即使碰巧接近量測值）', () => {
      const slot: SlotFixture = { name: 'base.x.innerWall', expected: 58.8, measured: 58.7, lineType: '—', source: 'measured', tIndependent: false };
      expect(judgeNumericSlot(slot, 58.9, 58.8).ok, '生成值與公式值差 0.1 > 1e-6 應 fail').toBe(false);
    });

    it('corrected 槽：偏移超過 0.05 應被抓到（不得對量測放寬）', () => {
      const slot: SlotFixture = { name: 'lid.x.outerWall', expected: 44.6, measured: 45.0, lineType: '—', source: 'corrected', tIndependent: false };
      expect(judgeNumericSlot(slot, 44.7, 44.6).ok, '偏移 0.1 > 0.05 應 fail').toBe(false);
      // 刻意驗證「不得對量測放寬」：若誤把 measured 當比對基準，44.7 對 45.0 差 0.3 也會被
      // ≤0.15 攔下——但這裡要確認就算生成值恰好等於 measured(45.0)，也必須 fail（因為
      // corrected 槽的比對基準是修正值 expected，不是 measured）。
      expect(judgeNumericSlot(slot, 45.0, 44.6).ok, '生成值等於量測值也應 fail（corrected 槽不對量測）').toBe(false);
    });

    it('y 向槽：公式不自洽應被抓到（即使沒有量測比對這層）', () => {
      const slot: SlotFixture = { name: 'base.y.outerWall', expected: 60, measured: 60, lineType: '—', source: 'measured', tIndependent: false };
      expect(judgeNumericSlot(slot, 61, 60).ok, 'y 向生成值偏移應被公式層抓到').toBe(false);
      expect(judgeNumericSlot(slot, 60, 60).ok, '對照組：y 向公式自洽應 pass').toBe(true);
    });

    it('結構檢查：故意拿掉 halfcut/crease 其中一種型別應被抓到', () => {
      const onlyCrease: DielinePath[] = [{ id: 'x', type: 'crease', tags: ['tongueFold', 'left'], segments: [] }];
      expect(checkTuckFoldLineStructure(onlyCrease, 'left').ok, '缺 halfcut 應 fail').toBe(false);
      const onlyHalfcut: DielinePath[] = [{ id: 'x', type: 'halfcut', tags: ['tongueFold', 'left'], segments: [] }];
      expect(checkTuckFoldLineStructure(onlyHalfcut, 'left').ok, '缺 crease 應 fail').toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step 6：天地盒版 param-sweep（重用 Slice 1 掃描骨架：tests/boxes/param-sweep.test.ts
// 的 assertSafe 慣例——不判斷幾何「對不對」，只判斷「不崩潰、無 NaN、bounds 有限」這條
// 最低限度安全網，額外疊天地盒特有的兩項：cut 無自撞、不變式全過或正確警告。
//
// 「全過或正確警告」的判準：telescope 的 7 條不變式裡，pieces-valid／pieces-identity／
// rim-flush／no-nan／no-bleed／bounds-cover 這 6 條是「恆真」不變式（由生成幾何的結構
// 保證，任何合法參數組合下都不該 not-ok，若 not-ok 代表真的有 bug）；liner-flange-fits／
// gusset-b-fits 兩條才是「設計上的參數域邊界」，允許 not-ok（如 margin 太小、薄壁角撐壁高
// 太矮），但警告訊息必須是非空字串（「正確警告」而非崩潰或回傳殘缺物件）。
//
// 「cut 無自撞」的例外（實測發現，見下方「已知問題」describe block）：gusset-b-fits／
// liner-flange-fits 這兩條「參數域邊界」不變式一旦 not-ok，代表該組合本來就是文件化的
// 退化區（薄壁角撐壁高太矮、內襯翻邊變負值）——退化區裡 cut 自撞是「已被正確警告」的
// 後果，不是新發現的沉默 bug，此時不再額外要求 cut 乾淨。只有在兩條邊界不變式都 ok:true
// （代表「這組參數理應是健康的」）時才嚴格要求 cut 無自撞——這樣才能讓「confuse 自撞」
// 真正對應「不變式沒接住的沉默退化」，而不是把已知、已警告的邊界又重複標記一次。
//
// 只新增 tests/telescope-fixture.test.ts＋tests/fixtures/telescope-reference.json 兩檔的
// 限制下，這個 describe block 只能放在本檔（不能另開 tests/boxes/telescope-param-sweep.test.ts），
// 故獨立成本檔案尾端一個區塊，並在獨立 commit 加入。
// ─────────────────────────────────────────────────────────────────────────

const ALWAYS_OK_INVARIANTS = new Set(['pieces-valid', 'pieces-identity', 'rim-flush', 'no-nan', 'no-bleed', 'bounds-cover']);
/** 「參數域邊界」不變式——not-ok 時代表已知、已警告的退化區，cut 自撞不再視為新問題（見上方說明）。 */
const BOUNDARY_INVARIANTS = new Set(['gusset-b-fits', 'liner-flange-fits']);

type Overrides = Partial<Record<string, number | boolean | string>>;

/** 對單一組參數斷言天地盒版安全網：不 throw、無 NaN、bounds 有限、不變式全過或正確警告；
 *  cut 無自撞只在兩條邊界不變式都 ok 時嚴格要求（見上方區塊說明）。 */
function assertTelescopeSafe(label: string, overrides: Overrides): void {
  it(`${label}：generate 不 throw、無 NaN、bounds 有限、不變式全過或正確警告（cut 自撞見邊界不變式）`, () => {
    let params: ReturnType<typeof resolveParams> | undefined;
    let result: GenerateResult | undefined;

    expect(() => {
      params = resolveParams(telescope, overrides);
      result = telescope.generate(params);
    }, label).not.toThrow();

    const segs = result!.paths.flatMap((p) => p.segments);
    expect(hasNaN(segs), `${label}：不應有 NaN`).toBe(false);

    for (const [k, v] of Object.entries(result!.bounds)) {
      expect(Number.isFinite(v), `${label}：bounds.${k} 應為有限值，實際 ${v}`).toBe(true);
    }

    let boundaryFired = false;
    for (const inv of telescope.invariants) {
      let outcome: ReturnType<typeof inv.check> | undefined;
      expect(() => {
        outcome = inv.check(params!, result!);
      }, `${label}：不變式 ${inv.id} 不應 throw`).not.toThrow();

      if (ALWAYS_OK_INVARIANTS.has(inv.id)) {
        expect(outcome, `${label}：${inv.id} 屬恆真不變式，應恆過`).toMatchObject({ ok: true });
      } else if (!outcome!.ok) {
        expect(typeof outcome!.message.zh, `${label}：${inv.id} 警告需帶 message.zh 字串`).toBe('string');
        expect(outcome!.message.zh.length, `${label}：${inv.id} 警告訊息不可為空字串`).toBeGreaterThan(0);
        if (BOUNDARY_INVARIANTS.has(inv.id)) boundaryFired = true;
      }
    }

    if (!boundaryFired) {
      const cutSegs = result!.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
      expect(hasSelfIntersection(cutSegs), `${label}：cut 不應自撞（無邊界不變式警告，理應是健康幾何）`).toBe(false);
    }
  });
}

describe('telescope: param-sweep（Step 6，天地盒版；重用 Slice 1 掃描骨架）', () => {
  describe('單一 mm 參數 min/max（其餘維持預設，同 RTE tier 1）', () => {
    // baseLength/baseWidth 的宣告 min=30 落在下方「已知問題」的 tongueFlap 自撞退化區
    // （perpHalf=15<16.5 門檻，見下方 describe block 的精確推導與二分搜尋驗證）——那條
    // 退化路徑目前沒有任何不變式接住（不像 gusset-b-fits/liner-flange-fits 有警告），
    // 是本次 sweep 挖到的沉默 bug，不在本輪 對帳範圍內（src/ 不得動）。這裡「跳過真正
    // min」不是要藏起來——下面的「已知問題」block 會用真正的 min=30 明確斷言 bug 現狀，
    // 讓它變成被追蹤的已知缺口而非靜默消失；一般安全網掃描則改用safely-above-threshold
    // 的 40（見該 block 的門檻推導），繼續驗證「低值但非已知退化區」的行為。
    for (const p of telescope.params) {
      if (p.unit !== 'mm') continue;
      if (p.key === 'baseLength' || p.key === 'baseWidth') {
        assertTelescopeSafe(`${p.key}=40（非宣告 min=30——真正 min 見下方已知問題 block）`, { [p.key]: 40 });
      } else if (p.min !== undefined) {
        assertTelescopeSafe(`${p.key}=min(${p.min})`, { [p.key]: p.min });
      }
      if (p.max !== undefined) assertTelescopeSafe(`${p.key}=max(${p.max})`, { [p.key]: p.max });
    }
  });

  describe('角撐款式×壁高×紙厚 三值交叉（base 側；驅動 gusset-b-fits 與 A/B 款切換）', () => {
    for (const basePlatformWidth of [0, 5, 15]) {
      for (const baseHeight of [15, 60, 150]) {
        for (const thickness of [0, 0.4, 0.8]) {
          assertTelescopeSafe(`basePlatformWidth=${basePlatformWidth}, baseHeight=${baseHeight}, thickness=${thickness}`, {
            basePlatformWidth,
            baseHeight,
            thickness,
          });
        }
      }
    }
  });

  describe('角撐款式×壁高 交叉（lid 側；thickness 固定預設 0.3，避免案例數過度膨脹）', () => {
    for (const lidPlatformWidth of [0, 5, 15]) {
      for (const lidHeight of [15, 45, 150]) {
        assertTelescopeSafe(`lidPlatformWidth=${lidPlatformWidth}, lidHeight=${lidHeight}`, { lidPlatformWidth, lidHeight });
      }
    }
  });

  describe('內襯翻邊邊界 三值交叉（lidMargin×linerFitGap；驅動 liner-flange-fits）', () => {
    for (const lidMargin of [1, 13.5, 40]) {
      for (const linerFitGap of [0.2, 0.5, 2]) {
        assertTelescopeSafe(`lidMargin=${lidMargin}, linerFitGap=${linerFitGap}`, { lidMargin, linerFitGap });
      }
    }
    assertTelescopeSafe('linerEnabled=false + lidMargin=1（關內襯時翻邊警告應被閘門擋下，不得假警告）', {
      linerEnabled: false,
      lidMargin: 1,
    });
  });

  describe('全域極端組合（同 RTE「全部參數同時取 min/max」慣例）', () => {
    // baseLength/baseWidth 用 40（非宣告 min=30）：理由同上——真正 min 落在已知的
    // tongueFlap 自撞退化區，這裡驗證的是「其餘參數同時極端」的交互作用，不是重複
    // 撞同一個已知缺口。
    assertTelescopeSafe('全部關鍵參數同時取 min（baseLength/baseWidth 用 40，見上方說明）', {
      baseLength: 40,
      baseWidth: 40,
      baseHeight: 10,
      lidMargin: 1,
      lidHeight: 10,
      basePlatformWidth: 0,
      lidPlatformWidth: 0,
      thickness: 0,
      linerFitGap: 0.2,
    });
    assertTelescopeSafe('全部關鍵參數同時取 max', {
      baseLength: 600,
      baseWidth: 600,
      baseHeight: 200,
      lidMargin: 40,
      lidHeight: 200,
      basePlatformWidth: 15,
      lidPlatformWidth: 15,
      thickness: 0.8,
      linerFitGap: 2,
    });
    assertTelescopeSafe('大長寬比面板（baseLength=max, baseWidth=40，見上方說明）', { baseLength: 600, baseWidth: 40 });
    assertTelescopeSafe('大長寬比面板反向（baseLength=40, baseWidth=max，見上方說明）', { baseLength: 40, baseWidth: 600 });
    assertTelescopeSafe('linerEnabled=false + 壁高極端（不對稱 tall/short＋薄壁）', {
      linerEnabled: false,
      baseHeight: 200,
      lidHeight: 10,
      basePlatformWidth: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 已知問題（Step 6 param-sweep 挖到，出了具名槽位對帳的範圍；src/ 依 task 限制不得動，
// 回報而非硬調——見 開發紀錄 concerns）。
//
// tray.ts 的 buildTongueFlap 用兩個固定常數（TONGUE_END_RECESS=9、
// TUCK_FLAP_SHALLOW_DEPTH=7.5）鉗制插底舌兩端的讓位，但沒有對「牆的垂直半跨
// （perpHalf＝對向牆的半跨距）是否容得下這兩個常數」做防禦——當 perpHalf < 16.5
// （＝TONGUE_END_RECESS+TUCK_FLAP_SHALLOW_DEPTH）時，梯形的兩個「全深」端點
// （p3/p4，見 tray.ts buildTongueFlap 內的 perpB/perpC）順序反轉，插底舌 cut 從
// 六邊形退化成自我交叉的蝴蝶結。二分搜尋確認門檻精確在 perpHalf=16.5（baseLength/
// baseWidth＝33）：32 仍自撞、33 起乾淨。
//
// 這條路徑目前沒有任何不變式攔截（不像 gusset-b-fits／liner-flange-fits 有警告
// 訊息），且可在宣告的合法參數範圍內觸發（baseLength/baseWidth 宣告 min=30，
// 15 < 16.5——宣告下界本身就在退化區內；baseWidth 過大＋lidMargin 過小的組合也
// 能從 lid 側觸發同一條路徑）。建議後續開一個新不變式（如比照 gusset-b-fits 的
// 「tongue-flap-fits」）在 perpHalf 過窄時警告，而不是靜默產出自撞幾何。
//
// 下面用真正的宣告 min（30）明確斷言 bug 現狀，讓這個缺口留下追蹤——若未來 tray.ts
// 修好這條路徑，這裡會變紅，屆時應改寫本 describe block（而不是被悄悄遺忘）。
// ─────────────────────────────────────────────────────────────────────────

describe('已知問題（tongueFlap 自撞，src/ 未觸碰、留待後續 task 修——見 開發紀錄）', () => {
  it('baseLength=30（宣告 min）：base 片 x 向兩側 tongueFlap 已知自撞（未被任何不變式攔截）', () => {
    const params = resolveParams(telescope, { baseLength: 30 });
    const result = telescope.generate(params);
    const piece = result.pieces!.find((p) => p.id === 'base')!;
    const cutSegs = result.paths.filter((p) => piece.pathIds.includes(p.id) && p.type === 'cut').flatMap((p) => p.segments);
    expect(hasSelfIntersection(cutSegs), '已知 bug：perpHalf=15<16.5 門檻，tongueFlap 梯形反轉自撞').toBe(true);
    for (const inv of telescope.invariants) {
      expect(inv.check(params, result), `已知 bug：目前無不變式攔截此路徑（${inv.id} 不應標記它）`).toMatchObject({ ok: true });
    }
  });

  it('baseLength=33（門檻邊界）乾淨、32 仍自撞——二分搜尋確認精確門檻＝perpHalf 16.5mm', () => {
    const clean = telescope.generate(resolveParams(telescope, { baseLength: 33 }));
    const broken = telescope.generate(resolveParams(telescope, { baseLength: 32 }));
    const cutOf = (r: GenerateResult) => {
      const piece = r.pieces!.find((p) => p.id === 'base')!;
      return r.paths.filter((p) => piece.pathIds.includes(p.id) && p.type === 'cut').flatMap((p) => p.segments);
    };
    expect(hasSelfIntersection(cutOf(clean)), 'baseLength=33（perpHalf=16.5）應乾淨').toBe(false);
    expect(hasSelfIntersection(cutOf(broken)), 'baseLength=32（perpHalf=16）應仍自撞').toBe(true);
  });
});
