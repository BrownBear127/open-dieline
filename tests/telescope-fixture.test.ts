/**
 * 天地盒生產刀模具名槽位對帳 fixture 測試（Slice 2 Task 5）。
 *
 * 這是整個 Slice 2 的保真證明：把「新模組 vs 生產刀模量測」的對帳固化成
 * fixture＋分層比對，而非散落在各處的手算斷言。比對規則見 spec §4.2（附錄
 * `.superpowers/sdd/slice2-appendix.md` 逐槽抄錄）：
 *   1. t 無關槽位（source=measured、tIndependent=true）：|生成−預期| ≤0.05（x/y 向皆適用）
 *   2. t 相關槽位：公式自洽（生成值代公式驗）＋ |生成−量測| ≤0.15（x/y 向皆適用）；
 *      corrected 槽（lid.x.outerWall/innerWall）只驗公式修正值 ≤0.05、不對量測——
 *      這兩槽是新模組刻意做生產品漏做的平齊補償，差值＝t 是設計意圖不是 bug。
 *   3. y 向另有獨立的序列完整性驗證（見下方「y 向序列完整性」describe block）：外壁→
 *      〔平台〕→內壁→halfcut→舌片的序位與線型皆須正確——這層與規則 1/2 的數值比對正交，
 *      不互相取代（Slice 5 Fix2／SOL review：原規則 3「y 向不驗絕對差」的 blanket
 *      exemption 已刪除，y 向現在同走規則 1/2，見 judgeNumericSlot）。
 *   4. 內襯 golden（2026-07-09 T7 gate 反饋重定義：平台式腳架墊片，取代舊圍框版）：
 *      底面 176.4×121.4、攤平 206.4×151.4、腳架翼深 15（45° 斜切、免膠無 tab；
 *      §4.2 導出鏈公式自產，錨定下盒內淨）。
 *
 * 抽駐留座標的做法沿用 tray.ts 的 tag 慣例（['<landmark>','<side>']，見 telescope.test.ts
 * 對 generateTray() 的既有測試），但這裡一律走完整的 telescope.generate() 管線（而非直接呼叫
 * generateTray()/generateLiner()）——這是本 task 要驗的「整合管線保真」，不是個別幾何單元。
 * 純測試模組，helper 與 index.ts 內部私有函式（未 export）同構但各自持有，不跨檔耦合。
 */
import { describe, it, expect } from 'vitest';
import type { Segment } from '@/core/geometry';
import { hasNaN, hasSelfIntersection, segmentsBounds } from '@/core/geometry';
import type { DielinePath, GenerateResult, LineType } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { telescope, MIN_TONGUE_PERP_HALF } from '@/boxes/telescope';
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
  lidMarginX: number;
  lidMarginY: number;
  lidHeight: number;
  basePlatformWidth: number;
  lidPlatformWidth: number;
  thickness: number;
  // Slice 5 F3：與 thickness 解耦的三個獨立補償參數（原本這三處都讀 thickness）。
  rootJog: number;
  innerWallReduction: number;
  wallTopCompensation: number;
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

/**
 * y 向 wallRoot(front/back) 的 nominal＋offset 兩個駐留值（Slice 5 Fix2·SOL review
 * Finding 1 回歸修正）：B 款（薄壁角撐，platformWidth=0，如 lid）自本輪修正起，wallRoot
 * 自身只留中央 offset 一個值——nominal 移到相鄰角落 gussetFold 的 y 軸摺線端點（見
 * tray.ts buildWallRoot／buildGussetA 分工說明）。本檔既有的 doubleCreaseGap／panel span
 * 抽取式、judgeLineType 的 crease×2 判定、checkYProfileSequence 的序列基準點，原本都假設
 * wallRoot 自己就同時持有 nominal/offset 兩點；B 款現在要跨 entity 合併才推得出正確值，
 * 否則會把 central fold span（offset-to-offset）誤當成 side-root span（nominal-to-
 * nominal），多算 2×rootJog。A 款 wallRoot 自身仍有兩值，這裡對它是無害 no-op（own.length
 * 已經是 2，直接回傳，不觸發角落查找）。
 */
function yRootNominalOffset(paths: DielinePath[], side: 'front' | 'back'): number[] {
  const own = [...new Set(creaseAlongValues(paths, 'wallRoot', side, 'y', 'crease'))];
  if (own.length !== 1) return own;
  const offset = own[0]!;
  const corner = side === 'back' ? 'right-back' : 'right-front';
  const foldVals: number[] = [];
  for (const p of findTagged(paths, 'gussetFold', corner, 'crease')) {
    for (const s of p.segments) {
      // y 軸摺線＝沿 y 變化、x 定值的那一段（另一段是 x 軸摺線，會被這個篩選排除）。
      if (s.kind === 'line' && Math.abs(s.x1 - s.x2) < 1e-6 && Math.abs(s.y1 - s.y2) > 1e-6) {
        foldVals.push(s.y1, s.y2);
      }
    }
  }
  if (foldVals.length === 0) return own; // 防禦：找不到摺線就退回原值，下游容差會攔下異常
  const nominal = foldVals.reduce((best, v) => (Math.abs(v - offset) < Math.abs(best - offset) ? v : best), foldVals[0]!);
  return [offset, nominal];
}

/**
 * 「同線型（LineType）共線區間重疊」偵測（Slice 5 Fix2·SOL review Finding 1 新增，通用
 * helper 供之後 task 沿用；telescope.test.ts 另有一份供 generateTray() 單元層直測，這裡是
 * 全管線層，跟 SOL 實際發現 bug 的量測方式一致：production-P 參數＋telescope.generate()）
 * ——補既有兩種檢查之間的缺口：`hasSelfIntersection`（core/geometry.ts）刻意排除共線
 * 重疊（刀模轉角正常銜接），本檔既有的完全重複線段檢測（如有）只抓端點集合完全相同，
 * 兩者都抓不到「短線完整落在長線內」（jog 短段與角撐 y 軸摺線 0.5mm 重疊，Finding 1
 * 原始 bug）這種部分重複壓痕。回傳重疊描述陣列（空＝無重疊）。
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
  // 舌摺線兩端讓位段線型 2026-07-09 T7 gate 反饋改 crease→cut（維護者裁決·軋斷需求，見
  // tray.ts buildTongueFold 註解）；下面 4 條 innerWall／4 條 tuckFlap 抽取式原本查
  // tongueFold+crease，改查 tongueFold+cut——抽出的駐留座標數值不變（同一條線只換線型)。
  //
  // Slice 5 F4（base.x/y 兩組，A 款專屬）：base 改用 U-notch 拓撲後，tongueFold+cut
  // 變成 notch 本體（開口/底/圓角，沿線 along 座標不是單一定值，且底線比開口更靠近
  // wallTop，會讓 minAbsGap 誤抓到「開口−NOTCH_DEPTH」那個更近的值）——改查
  // tongueFold+halfcut（各段仍在同一 along=tongueFoldAlong，沿線定值可靠，B 款
  // lid.x/y 不受影響、繼續查 cut，因為 lid 舌根拓撲本次未動）。
  'base.x.innerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallTop', 'left', 'x', 'crease'), creaseAlongValues(b, 'tongueFold', 'left', 'x', 'halfcut')),
  'base.x.tuckFlap': (b) => maxAbsGap(creaseAlongValues(b, 'tongueFold', 'left', 'x', 'halfcut'), creaseAlongValues(b, 'tongueFlap', 'left', 'x', 'cut')),
  'base.y.doubleCreaseGap': (b) => creaseSpan(b, 'wallRoot', 'back', 'y', 'crease'),
  'base.y.outerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallRoot', 'back', 'y', 'crease'), creaseAlongValues(b, 'wallTop', 'back', 'y', 'crease')),
  'base.y.platform': (b) => creaseSpan(b, 'wallTop', 'back', 'y', 'crease'),
  'base.y.innerWall': (b) => minAbsGap(creaseAlongValues(b, 'wallTop', 'back', 'y', 'crease'), creaseAlongValues(b, 'tongueFold', 'back', 'y', 'halfcut')),
  'base.y.tuckFlap': (b) => maxAbsGap(creaseAlongValues(b, 'tongueFold', 'back', 'y', 'halfcut'), creaseAlongValues(b, 'tongueFlap', 'back', 'y', 'cut')),
  'lid.x.panel': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(l, 'wallRoot', 'right', 'x', 'crease')),
  'lid.x.outerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'left', 'x', 'crease'), creaseAlongValues(l, 'wallTop', 'left', 'x', 'crease')),
  // Slice 5 F5：B 款舌根拓撲整組復刻後，端段從 cut 改 crease（tongueFold+crease，0/1/2 段
  // 依三分支）、halfcut 中段的 along 值仍恆定（同 A 款既有修正手法，見 base.x.innerWall
  // 同款理由）——改查 tongueFold+halfcut，對 A/B 兩款、B 款三分支皆穩定可靠（halfcut
  // 永遠存在，即使分支 3「全 halfcut 無端段」）。
  'lid.x.innerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallTop', 'left', 'x', 'crease'), creaseAlongValues(l, 'tongueFold', 'left', 'x', 'halfcut')),
  'lid.x.tuckFlap': (_b, l) => maxAbsGap(creaseAlongValues(l, 'tongueFold', 'left', 'x', 'halfcut'), creaseAlongValues(l, 'tongueFlap', 'left', 'x', 'cut')),
  // Slice 5 Fix2（Finding 1）：doubleCreaseGap／panel 改走 yRootNominalOffset（不是直接
  // creaseAlongValues／creaseSpan）——B 款 wallRoot(y) 只留 offset，nominal 併入
  // gussetFold，見該 helper 註解。
  'lid.y.doubleCreaseGap': (_b, l) => {
    const vals = yRootNominalOffset(l, 'back');
    return vals.length < 2 ? 0 : Math.max(...vals) - Math.min(...vals);
  },
  'lid.y.outerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallRoot', 'back', 'y', 'crease'), creaseAlongValues(l, 'wallTop', 'back', 'y', 'crease')),
  // Slice 5 F5：同 lid.x.innerWall 理由——改查 tongueFold+halfcut（前後壁 hasDoubleRoot=true，
  // 端段亦從 cut 改 crease；V relief 是 tongueFold+cut 但只在壁兩端，非沿線定值不可靠）。
  'lid.y.innerWall': (_b, l) => minAbsGap(creaseAlongValues(l, 'wallTop', 'back', 'y', 'crease'), creaseAlongValues(l, 'tongueFold', 'back', 'y', 'halfcut')),
  'lid.y.tuckFlap': (_b, l) => maxAbsGap(creaseAlongValues(l, 'tongueFold', 'back', 'y', 'halfcut'), creaseAlongValues(l, 'tongueFlap', 'back', 'y', 'cut')),
  'lid.y.panel': (_b, l) => minAbsGap(yRootNominalOffset(l, 'front'), yRootNominalOffset(l, 'back')),
};

// Slice 5 F3：base.x.outerWall/innerWall、base.y.innerWall、base/lid.y.doubleCreaseGap、
// lid.y.innerWall 改讀 wallTopCompensation／innerWallReduction／rootJog（與 thickness
// 解耦，原本讀 thickness/2×thickness）。
// lid.x.outerWall/innerWall：B-06 左右壁特例移除，四面外壁不再吃 wallTopCompensation
// （上蓋恆傳 0，見 index.ts buildLidPiece）——公式因此單純化為 lidHeight／lidHeight−innerWallReduction，
// 不再是「corrected」（刻意偏離量測值），公式值現在直接等於量測值（見 fixture slots 對應更新）。
//
// Fix3（review，同批連動）：上述 7 槽（base.x.outerWall/innerWall、base.y.doubleCreaseGap/
// innerWall、lid.x.innerWall、lid.y.doubleCreaseGap/innerWall）公式改寫後不再含 thickness
// 任何一項，fixture 的 tIndependent 隨之由 false 改 true（欄位語意＝「公式是否含
// thickness」，非 x/y 軸限定；lid.x.outerWall 先前已由 T1 判為 true，這裡補齊其餘 6 槽）。
// 這 7 槽的 expected／measured 數值欄本身不動——只有分類旗標改變，比對基準從量測公差
// 0.15mm 收緊為設計 nominal 公差 0.05mm（見 judgeNumericSlot）。base.y.outerWall／
// lid.y.outerWall／lid.y.panel 公式雖然也不含 thickness，但那是 F1/既有設計本來就與 t
// 無關（非 F3 解耦造成的公式改寫），維持 tIndependent=false 不動——本次僅動「F3 決定的」
// 那 7 槽，不擴大到所有不含 thickness 的槽位。
const FORMULAS: Record<string, Formula> = {
  'base.x.panel': (p) => p.baseWidth,
  'base.x.outerWall': (p) => p.baseHeight - p.wallTopCompensation,
  'base.x.platform': (p) => p.basePlatformWidth,
  'base.x.innerWall': (p) => p.baseHeight - p.wallTopCompensation - p.innerWallReduction,
  'base.x.tuckFlap': () => TUCK_FLAP_DEPTH,
  'base.y.doubleCreaseGap': (p) => p.rootJog,
  'base.y.outerWall': (p) => p.baseHeight,
  'base.y.platform': (p) => p.basePlatformWidth,
  'base.y.innerWall': (p) => p.baseHeight - p.innerWallReduction,
  'base.y.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.x.panel': (p) => p.baseWidth + 2 * p.lidMarginX,
  'lid.x.outerWall': (p) => p.lidHeight,
  'lid.x.innerWall': (p) => p.lidHeight - p.innerWallReduction,
  'lid.x.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.y.doubleCreaseGap': (p) => p.rootJog,
  'lid.y.outerWall': (p) => p.lidHeight,
  'lid.y.innerWall': (p) => p.lidHeight - p.innerWallReduction,
  'lid.y.tuckFlap': () => TUCK_FLAP_DEPTH,
  'lid.y.panel': (p) => p.baseLength + 2 * p.lidMarginY,
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

  // Slice 5 Fix2（SOL review）：y 向「公式自洽即通過」的 blanket exemption 已刪除——
  // y 向數值比對從此與 x 向同走下面 corrected/tIndependent/measured 三分支，不再提早
  // return { ok: true }。y 向另有獨立的序列完整性驗證（見「y 向序列完整性」describe
  // block），與這裡的數值比對正交、不重複也不互相取代。

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

  // t 相關、非 corrected（x/y 向皆適用，Slice 5 Fix2 起 y 向不再豁免）：公式已驗（上方），
  // 再驗與量測絕對差 ≤0.15
  const diff = Math.abs(generated - slot.measured!);
  if (diff > MEASURED_TOL) {
    return { ok: false, reason: `t 相關槽 |生成−量測|=${diff.toFixed(4)} > ${MEASURED_TOL}` };
  }
  return { ok: true };
}

/**
 * tuckFoldLine 結構檢查：舌摺線應恆有 halfcut（中段），A/B 兩款各自的端段結構不同。
 *
 * Slice 5 F4（A 款專屬適配，語意不變——見 spec F4「invariant 更新」）：A 款（platformWidth
 * >0，如 base）舌根拓撲從「兩端 9mm cut＋單一中段 halfcut」改為「U-notch 切段＋多段
 * halfcut」——cut 段數＝5×notch 數（每個 notch 5 段：2 line＋2 arc＋1 底線）、halfcut
 * 段數＝2 或 3（依壁款）。用 cut path 是否帶 'uNotch' tag 判斷走哪組期望值——這是
 * tray.ts buildUNotches 的既有 tag 慣例，不是本測試發明的新概念。
 *
 * Slice 5 F5（B 款整組復刻，取代舊「兩端 9mm cut＋單一中段 halfcut」簡化語意）：端段
 * 從 cut 改 crease（0/1/2 段，依三分支：分支 1/2 有兩端＝2 段、分支 3 全省＝0 段——見
 * tray.ts buildBTongueTopology）；cut 型別只剩 V relief（僅 hasDoubleRoot 壁、E′≥7.5
 * 才生成，4 段＝2 個 V×2 線，無圓角）——0 或 4 段，不再是「恆有 2 段」。halfcut 恆存在
 * （即使分支 3 全省端段，halfcut 仍覆蓋整段）。
 */
function checkTuckFoldLineStructure(paths: DielinePath[], side: string): Verdict {
  const cut = findTagged(paths, 'tongueFold', side, 'cut');
  const crease = findTagged(paths, 'tongueFold', side, 'crease');
  const halfcut = findTagged(paths, 'tongueFold', side, 'halfcut');
  if (halfcut.length === 0) return { ok: false, reason: `tongueFold(${side}) 缺 halfcut（中段）` };

  const isAStyle = cut[0]?.tags?.includes('uNotch') ?? false;
  if (isAStyle) {
    if (cut.length === 0) return { ok: false, reason: `tongueFold(${side}) A 款缺 cut（U-notch，需軋斷）` };
    if (cut[0]!.segments.length % 5 !== 0 || cut[0]!.segments.length === 0) {
      return { ok: false, reason: `tongueFold(${side}) A 款 cut 段數應是 5 的倍數（每個 U-notch 5 段），實際 ${cut[0]!.segments.length}` };
    }
    if (halfcut[0]!.segments.length !== 2 && halfcut[0]!.segments.length !== 3) {
      return { ok: false, reason: `tongueFold(${side}) A 款 halfcut 應為 2 段（單 notch 壁）或 3 段（雙 notch 壁），實際 ${halfcut[0]!.segments.length}` };
    }
    return { ok: true };
  }

  // B 款：端段 crease 0 或 1 條 path（0/1/2 段皆合法，依三分支）；V relief cut 0 或 1 條
  // path（恰 4 段）；halfcut 恰 1 條 path、1 段（覆蓋整段，不論端段是否存在）。
  if (crease.length > 1) return { ok: false, reason: `tongueFold(${side}) B 款端段 crease 應恰 0 或 1 條 path，實際 ${crease.length}` };
  if (crease.length === 1 && crease[0]!.segments.length !== 1 && crease[0]!.segments.length !== 2) {
    return { ok: false, reason: `tongueFold(${side}) B 款端段 crease 段數應為 1 或 2，實際 ${crease[0]!.segments.length}` };
  }
  if (cut.length > 1) return { ok: false, reason: `tongueFold(${side}) B 款 V relief cut 應恰 0 或 1 條 path，實際 ${cut.length}` };
  if (cut.length === 1 && cut[0]!.segments.length !== 4) {
    return { ok: false, reason: `tongueFold(${side}) B 款 V relief cut 段數應為 4（2 個 V×2 線），實際 ${cut[0]!.segments.length}` };
  }
  if (halfcut[0]!.segments.length !== 1) {
    return { ok: false, reason: `tongueFold(${side}) halfcut 應恰有 1 段（中段），實際 ${halfcut[0]!.segments.length}` };
  }
  return { ok: true };
}

/** slot 名尾段 → 該槽 lineType 宣告所落的 landmark（F6；x 向槽查 left、y 向槽查 back，同 EXTRACTORS 慣例）。 */
const SLOT_LINETYPE_LANDMARKS: Record<string, string> = {
  panel: 'wallRoot',
  platform: 'wallTop',
  doubleCreaseGap: 'wallRoot',
  tuckFlap: 'tongueFlap',
  tuckFoldLine: 'tongueFold',
};

/**
 * fixture 的 lineType 宣告 vs 生成幾何（fix wave F6）：該槽對應 tag 的 path 線型／數量須與
 * 宣告一致，讓 lineType 欄位真正參與逐槽判定而非裝飾。「—」＝附錄未對該槽宣告線型
 * （外壁/內壁這類跨距槽，兩端分屬其他槽位的線），跳過；未知字串一律 fail（防 fixture
 * 拼錯被靜默跳過）。
 */
function judgeLineType(slot: SlotFixture, paths: DielinePath[]): Verdict {
  if (slot.lineType === '—') return { ok: true };
  const leaf = slot.name.split('.').pop()!;
  const landmark = SLOT_LINETYPE_LANDMARKS[leaf];
  if (!landmark) return { ok: false, reason: `lineType「${slot.lineType}」無對應 landmark 映射（槽名 ${slot.name}）` };
  const axis: 'x' | 'y' = slot.name.includes('.x.') ? 'x' : 'y';
  const side = axis === 'x' ? 'left' : 'back';

  if (slot.lineType === 'crease（單）' || slot.lineType === 'crease×2') {
    const ps = findTagged(paths, landmark, side, 'crease');
    if (ps.length !== 1) return { ok: false, reason: `${landmark}(${side}) 應恰有 1 條 crease path，實際 ${ps.length}` };
    // Slice 5 F2：wallRoot 階梯 jog 段（rootJog>0）含零 perp 位移的短接段，該段在 along
    // 軸上「不是定值」（一端 nominal、一端 offset）——alongOf 會擲錯，改用寬鬆的
    // allAlongValues（不假設每段是定值線，只收集所有端點座標）取相異值計數，語意不變
    // （crease（單）＝1 相異值、crease×2＝2 相異值，段數本身不是這裡要驗的東西）。
    //
    // Slice 5 Fix2（Finding 1）：wallRoot(y) 的 crease×2 判定改走 yRootNominalOffset——
    // B 款 wallRoot 自身現在只留 offset 一個值，nominal 併入 gussetFold，要跨 entity
    // 合併才驗得出「2 個相異值」（A 款自身仍有兩值，merge 對它是無害 no-op）。其餘
    // landmark／軸（x 向 wallRoot、wallTop 等）不受影響，維持原本只看自身 segments 的路徑。
    const distinct = landmark === 'wallRoot' && axis === 'y' ? new Set(yRootNominalOffset(paths, 'back')).size : new Set(allAlongValues(ps[0]!.segments, axis)).size;
    const want = slot.lineType === 'crease（單）' ? 1 : 2;
    if (distinct !== want) return { ok: false, reason: `${landmark}(${side}) 駐留座標應有 ${want} 個相異值（${slot.lineType}），實際 ${distinct}` };
    return { ok: true };
  }
  if (slot.lineType === 'cut') {
    const ps = findTagged(paths, landmark, side, 'cut');
    if (ps.length !== 1) return { ok: false, reason: `${landmark}(${side}) 應恰有 1 條 cut path，實際 ${ps.length}` };
    return { ok: true };
  }
  if (slot.lineType === 'halfcut 中段＋cut 兩端') return checkTuckFoldLineStructure(paths, side);
  return { ok: false, reason: `未知的 lineType 宣告「${slot.lineType}」` };
}

/**
 * y 向剖面序列完整性（spec §4.2 規則 3）：外壁→〔平台〕→內壁→halfcut→舌片的序位、線型皆須
 * 正確——用「離內側 root 座標的絕對距離」嚴格遞增來判斷序位（正負號無關，四面牆鏡射對稱通用）。
 */
function checkYProfileSequence(paths: DielinePath[], side: 'back' | 'front', platformWidth: number): Verdict {
  const rootPath = findTagged(paths, 'wallRoot', side, 'crease');
  if (rootPath.length !== 1) return { ok: false, reason: `wallRoot(${side}) 應恰有 1 條 path，實際 ${rootPath.length}` };
  // Slice 5 F2：階梯 jog 取代舊「雙 crease 根」（固定 2 段）——A 款段數是 3（中央 offset
  // crease＋兩端 jog 短段）、B 款只有 1 段（Slice 5 Fix2·Finding 1：nominal 併入
  // gussetFold，不重畫 jog，見 yRootNominalOffset）。語意上真正要保證的是能湊出「2 個
  // 相異駐留座標」（nominal/offset 階梯 jog）——A 款兩者都在 wallRoot 自身、B 款 nominal
  // 要跨 entity 合併，故改用 yRootNominalOffset（內部對 A 款是無害 no-op）取相異值。
  const rootAlongs = yRootNominalOffset(paths, side).sort((a, b) => a - b);
  if (rootAlongs.length !== 2) {
    return { ok: false, reason: `wallRoot(${side}) y 向應有 2 個相異駐留座標（nominal/offset 階梯 jog，A 款自身持有／B 款併 gussetFold），實際 ${rootAlongs.length}` };
  }
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
  // Slice 5 F4：改用 halfcut 段取 foldAlong（沿線各段 along 皆定值＝tongueFoldAlong）——
  // A 款的 cut 段落是 U-notch 本體，端點座標各異（開口/底/圓角），非單一 along 定值線，
  // 直接用第一段會擲錯或取到錯的值（同 telescope.test.ts 的 x/y 向間距測試同款修正）。
  const foldAlong = alongOf(findTagged(paths, 'tongueFold', side, 'halfcut')[0]!.segments[0]!, 'y');

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

/**
 * 合成一組「健康形狀」的 y 向剖面資料（fix wave F4 負類測試用；back 側、platform=5 型）：
 * 雙 crease 根（gap 0.4）→ 壁頂兩線（60.4/65.4）→ 舌摺線（crease 兩端＋halfcut 中段，
 * 224.6）→ 插底舌斜線（最深 239.6）。數值只需序位正確，不對應任何真實參數組。
 * 舌摺線兩端線型：A 款讓位角撐（cut，2026-07-09 T7 gate 反饋·軋斷需求）與 B 款端段
 * （crease，Slice 5 F5 整組復刻）不同——這裡走 checkTuckFoldLineStructure 的 B 款分支
 * （'fc' 無 'uNotch' tag），改用 crease 對齊該分支的新結構（端段 crease、V relief 才是
 * cut，本合成剖面不含 V relief）。
 */
function syntheticYProfile(): DielinePath[] {
  const yLine = (y: number): Segment => ({ kind: 'line', x1: 0, y1: y, x2: 10, y2: y });
  return [
    { id: 'r', type: 'crease', tags: ['wallRoot', 'back'], segments: [yLine(100), yLine(100.4)] },
    { id: 't', type: 'crease', tags: ['wallTop', 'back'], segments: [yLine(160.4), yLine(165.4)] },
    { id: 'fc', type: 'crease', tags: ['tongueFold', 'back'], segments: [yLine(224.6), yLine(224.6)] },
    { id: 'fh', type: 'halfcut', tags: ['tongueFold', 'back'], segments: [yLine(224.6)] },
    { id: 'fl', type: 'cut', tags: ['tongueFlap', 'back'], segments: [{ kind: 'line', x1: 0, y1: 224.6, x2: 5, y2: 239.6 }] },
  ];
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

        // fixture 宣告的 lineType 也參與判定（fix wave F6）：槽位對應 tag 的線型/數量須一致
        const ltVerdict = judgeLineType(slot, paths);
        expect(ltVerdict.ok, `${slot.name}: lineType 宣告不符——${ltVerdict.reason ?? ''}`).toBe(true);

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

    it('base y 向 front 側（F7）：序位正確——back/front 兩側皆驗，防單側正確另一側鏡射錯位', () => {
      const verdict = checkYProfileSequence(basePaths, 'front', fixture.params.basePlatformWidth);
      expect(verdict.ok, verdict.reason).toBe(true);
    });

    it('lid y 向 front 側（F7）：序位正確', () => {
      const verdict = checkYProfileSequence(lidPaths, 'front', fixture.params.lidPlatformWidth);
      expect(verdict.ok, verdict.reason).toBe(true);
    });

    it('負類（F4）：合成錯序／漏槽／錯線型的 y 向剖面應被抓到（照 checkTuckFoldLineStructure fail-case 先例）', () => {
      const valid = syntheticYProfile();
      expect(checkYProfileSequence(valid, 'back', 5).ok, '對照組：合成的健康剖面應 pass（否則以下 fail 全是誤報）').toBe(true);

      // 錯序：舌摺線（cut＋halfcut）搬到壁頂之前（y=130 < 160.4）→ 距離序列非嚴格遞增
      const yLine130: Segment = { kind: 'line', x1: 0, y1: 130, x2: 10, y2: 130 };
      const misordered = valid.map((p) => (p.tags?.includes('tongueFold') ? { ...p, segments: p.segments.map(() => yLine130) } : p));
      expect(checkYProfileSequence(misordered, 'back', 5).ok, '錯序（舌摺線插到壁頂之前）應 fail').toBe(false);

      // 漏槽：整條壁頂 path 不見
      const missing = valid.filter((p) => !p.tags?.includes('wallTop'));
      expect(checkYProfileSequence(missing, 'back', 5).ok, '漏槽（缺壁頂）應 fail').toBe(false);

      // 錯線型：壁根從 crease 變 cut（雙 crease 根的線型錯畫）
      const wrongType = valid.map((p) => (p.tags?.includes('wallRoot') ? { ...p, type: 'cut' as LineType } : p));
      expect(checkYProfileSequence(wrongType, 'back', 5).ok, '錯線型（壁根 crease 變 cut）應 fail').toBe(false);
    });
  });

  describe('內襯 golden（2026-07-09 T7 gate 反饋重定義：平台式——底面 176.4×121.4、攤平 206.4×151.4、翼深 15）', () => {
    it('deriveLinerFrame 公式值（單元層，t=0.4/fitGap=0.5 自產，brief 驗算錨；不再吃 lidMargin）', () => {
      const frame = deriveLinerFrame({
        baseLength: fixture.params.baseLength,
        baseWidth: fixture.params.baseWidth,
        thickness: fixture.params.thickness,
        fitGap: fixture.params.linerFitGap,
      });
      expect(frame.padL, '底面長邊（對應 baseLength 軸）').toBeCloseTo(176.4, 6);
      expect(frame.padW, '底面短邊（對應 baseWidth 軸）').toBeCloseTo(121.4, 6);
    });

    it('整合管線（telescope.generate 實際組裝的 liner 片）：底面周界四條 crease、四翼 cut 各 3 段、45° 斜切、攤平 206.4×151.4', () => {
      const linerPiece = fixtureResult.pieces!.find((p) => p.id === 'liner')!;
      const linerPaths = fixtureResult.paths.filter((p) => linerPiece.pathIds.includes(p.id));

      const padCreases = linerPaths.filter((p) => p.type === 'crease' && p.tags?.includes('linerPad'));
      expect(padCreases, '底面周界四條 crease（top/bottom/left/right）').toHaveLength(4);

      const flapCuts = linerPaths.filter((p) => p.type === 'cut' && p.tags?.includes('linerFlap'));
      expect(flapCuts, '四翼各一條 cut').toHaveLength(4);
      for (const flap of flapCuts) {
        expect(flap.segments, '每翼 cut＝斜切→外緣→斜切，共 3 段').toHaveLength(3);
        const [slantA, , slantB] = flap.segments as LineSeg[];
        expect(Math.abs(slantA!.x2 - slantA!.x1), '斜切 |dx|＝flapDepth＝15').toBeCloseTo(15, 6);
        expect(Math.abs(slantA!.y2 - slantA!.y1), '斜切 |dy|＝flapDepth（45°）').toBeCloseTo(15, 6);
        expect(Math.abs(slantB!.x2 - slantB!.x1)).toBeCloseTo(15, 6);
        expect(Math.abs(slantB!.y2 - slantB!.y1)).toBeCloseTo(15, 6);
      }

      // 不殘留圍框版的 tab/wall 舊 tag（免膠無 tab，構造徹底重定義）。
      const staleTags = linerPaths.flatMap((p) => p.tags ?? []).filter((t) => t === 'linerTab' || t === 'linerWall');
      expect(staleTags, '不應殘留圍框版的 linerTab/linerWall tag').toEqual([]);

      // 只量 crease/cut（實際製造幾何），排除 dimension 標註線——同 ExportBar.tsx FX3 教訓：
      // 標註線因 DIM_OFFSET 外推會把 piece.bounds 撐大，直接拿 piece.bounds 驗會跟這組自檢錨對不上。
      const geomOnly = segmentsBounds(linerPaths.filter((p) => p.type !== 'dimension').flatMap((p) => p.segments));
      expect(geomOnly.maxX - geomOnly.minX, '攤平外圍寬＝padW+2×flapDepth＝121.4+30').toBeCloseTo(151.4, 6);
      expect(geomOnly.maxY - geomOnly.minY, '攤平外圍高＝padL+2×flapDepth＝176.4+30').toBeCloseTo(206.4, 6);
    });
  });

  describe('防假陽性：judgeNumericSlot 對刻意錯誤值必須標記 not-ok（不能只靠肉眼驗一次）', () => {
    it('t 無關槽：生成值偏移超過 0.05 應被 T_INDEPENDENT_TOL 分支抓到（F3 修正）', () => {
      const slot: SlotFixture = { name: 'base.x.panel', expected: 124, measured: 124, lineType: 'x', source: 'measured', tIndependent: true };
      // F3 教訓：generated 必須＝formulaValue，否則 1e-6 公式閘先攔、目標分支永不執行——
      // 那樣的測試「會綠」的原因是錯的（把 T_INDEPENDENT_TOL 改掉或刪分支照樣綠）。
      // 這裡讓公式閘通過（124.2==124.2），偏移由 t 無關分支攔，並斷言 reason 出自該分支。
      const v = judgeNumericSlot(slot, 124.2, 124.2);
      expect(v.ok, '偏移 0.2 > 0.05 應 fail').toBe(false);
      expect(v.reason, '必須由 t 無關分支攔下（非公式閘）').toContain('t 無關');
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

    it('corrected 槽：偏移超過 0.05 應被 CORRECTED_TOL 分支抓到、且不得對量測放寬（F3 修正）', () => {
      const slot: SlotFixture = { name: 'lid.x.outerWall', expected: 44.6, measured: 45.0, lineType: '—', source: 'corrected', tIndependent: false };
      // F3 教訓同上：generated 必須＝formulaValue 才會真正走進 corrected 分支。
      const v1 = judgeNumericSlot(slot, 44.7, 44.7);
      expect(v1.ok, '偏移 0.1 > 0.05 應 fail').toBe(false);
      expect(v1.reason, '必須由 corrected 分支攔下（非公式閘）').toContain('corrected');
      // 「不得對量測放寬」的真正驗證：生成值恰等於量測值 45.0（模擬有人把平齊修正「修」回
      // 生產品行為——公式函式與生成一起被改成 H，公式閘因此通過），仍必須 fail：corrected
      // 槽的比對基準是修正值 expected=44.6，不是 measured=45.0。
      const v2 = judgeNumericSlot(slot, 45.0, 45.0);
      expect(v2.ok, '生成值等於量測值也應 fail（corrected 槽不對量測）').toBe(false);
      expect(v2.reason, '必須由 corrected 分支攔下').toContain('corrected');
    });

    it('y 向槽：公式不自洽應被抓到（公式層是第一道 gate，先於 corrected/tIndependent/measured 分支）', () => {
      // 標題括號原文「即使沒有量測比對這層」是 Fix2 前的舊敘述（y 向曾整層豁免量測比對）；
      // Fix2 刪除 y 向 blanket exemption 後 y 向也會走量測比對分支，這裡改用中性敘述——
      // 本測試的重點只在「公式不自洽必在第一道 gate 被攔下」，與 y 向是否還豁免無關。
      const slot: SlotFixture = { name: 'base.y.outerWall', expected: 60, measured: 60, lineType: '—', source: 'measured', tIndependent: false };
      expect(judgeNumericSlot(slot, 61, 60).ok, 'y 向生成值偏移應被公式層抓到').toBe(false);
      expect(judgeNumericSlot(slot, 60, 60).ok, '對照組：y 向公式自洽且與量測相符應 pass').toBe(true);
    });

    it('y 向槽：公式自洽但與量測差超過 0.15 應被抓到（Slice 5 Fix2 核心迴歸：y 向不得比 x 向寬鬆，防豁免變相回歸）', () => {
      const slot: SlotFixture = { name: 'lid.y.panel', expected: 216, measured: 216 - 0.2, lineType: '—', source: 'measured', tIndependent: false };
      const v = judgeNumericSlot(slot, 216, 216);
      expect(v.ok, '量測差 0.2 > 0.15 應 fail——y 向若仍暗中享有 blanket exemption，這裡會錯誤地 pass').toBe(false);
      expect(v.reason, '必須由量測分支攔下（非公式閘，因為公式自洽 216=216）').toContain('量測');
    });

    it('結構檢查：故意拿掉 halfcut/cut 其中一種型別應被抓到', () => {
      const onlyCut: DielinePath[] = [{ id: 'x', type: 'cut', tags: ['tongueFold', 'left'], segments: [] }];
      expect(checkTuckFoldLineStructure(onlyCut, 'left').ok, '缺 halfcut 應 fail').toBe(false);
      const onlyHalfcut: DielinePath[] = [{ id: 'x', type: 'halfcut', tags: ['tongueFold', 'left'], segments: [] }];
      expect(checkTuckFoldLineStructure(onlyHalfcut, 'left').ok, '缺 cut 應 fail').toBe(false);
    });

    it('lineType 判定（F6）：宣告 crease×2 但幾何只有單線／宣告 cut 但 path 缺失／未知宣告字串應被抓到', () => {
      const singleRoot: DielinePath[] = [
        { id: 'r', type: 'crease', tags: ['wallRoot', 'back'], segments: [{ kind: 'line', x1: 0, y1: 5, x2: 9, y2: 5 }] },
      ];
      const gapSlot: SlotFixture = { name: 'base.y.doubleCreaseGap', expected: 0.4, measured: 0.5, lineType: 'crease×2', source: 'measured', tIndependent: false };
      expect(judgeLineType(gapSlot, singleRoot).ok, '雙 crease 宣告 vs 單線幾何應 fail').toBe(false);

      const flapSlot: SlotFixture = { name: 'base.x.tuckFlap', expected: 15, measured: 15, lineType: 'cut', source: 'measured', tIndependent: true };
      expect(judgeLineType(flapSlot, []).ok, 'cut 宣告 vs 缺 path 應 fail').toBe(false);
      expect(judgeLineType({ ...flapSlot, lineType: 'cutt' }, []).ok, '未知 lineType 字串應 fail（防 fixture 拼錯被靜默跳過）').toBe(false);

      // 對照組：真實幾何 vs 真實 fixture 宣告的全數 pass 已由「逐槽分層比對」迴圈涵蓋，不重複
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 F2：wallRoot 階梯 jog——production-P 驗收錨（centralFoldSpan/sideRootSpan）＋
// 全管線層級的結構斷言。fixture 本身的 rootJog=0.4（延續 T1 與舊 thickness 耦合值，
// 見檔頭 note），與 spec F2 的驗收錨 180.0/217.0（需 rootJog=0.5）不同一組參數，故這裡
// 用 resolveParams 直接疊 production-P 的 baseLength/lidMarginY/rootJog，不動 fixture
// 本身（Global Constraint：telescope-reference.json 既有數值欄不動）。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: F2 央/側 fold span 錨（production-P 值，spec F2 驗收）', () => {
  /** production-P 的 baseLength/lidMarginY/rootJog（spec F2 驗收錨用這組值，非 fixture 預設）。 */
  const productionOverrides = { baseLength: 179, lidMarginY: 18.5, rootJog: 0.5 };

  it('下盒：central fold span=180.0、side-root span=179.0（±0.1，P measured 179.998/179.003）', () => {
    const result = telescope.generate(resolveParams(telescope, productionOverrides));
    const piece = result.pieces!.find((p) => p.id === 'base')!;
    const paths = result.paths.filter((p) => piece.pathIds.includes(p.id));
    const front = creaseAlongValues(paths, 'wallRoot', 'front', 'y', 'crease');
    const back = creaseAlongValues(paths, 'wallRoot', 'back', 'y', 'crease');
    expect(minAbsGap(front, back), 'side-root span＝baseLength（兩側翼 nominal 對 nominal）').toBeCloseTo(179, 1);
    expect(maxAbsGap(front, back), 'central fold span＝baseLength+2×rootJog（中央 offset 對 offset）').toBeCloseTo(180, 1);
  });

  it('上蓋：central fold span=217.0、side-root span=216.0（±0.1，P measured 217.001/215.999）', () => {
    const result = telescope.generate(resolveParams(telescope, productionOverrides));
    const piece = result.pieces!.find((p) => p.id === 'lid')!;
    const paths = result.paths.filter((p) => piece.pathIds.includes(p.id));
    // Slice 5 Fix2（Finding 1）：B 款 wallRoot(y) 自身只留 offset，改用 yRootNominalOffset
    // 跨 entity 合併回 nominal（gussetFold 的 y 軸摺線端點）——否則 front/back 各只剩
    // 1 個值，minAbsGap／maxAbsGap 會退化成同一個數字（central span，多算 2×rootJog）。
    const front = yRootNominalOffset(paths, 'front');
    const back = yRootNominalOffset(paths, 'back');
    expect(minAbsGap(front, back), 'side-root span＝baseLength+2×lidMarginY').toBeCloseTo(216, 1);
    expect(maxAbsGap(front, back), 'central fold span＝216+2×rootJog').toBeCloseTo(217, 1);
  });

  it('結構斷言（全管線）：base/lid 的 wallRoot(back) 皆非兩條 full-length 平行 crease——中央只 1 段有 perp 延伸；A 款另補 2 段零 perp 位移 jog 短段、B 款不補（Slice 5 Fix2·Finding 1：B 款 jog 區間併入 gussetFold，不重畫，見 tray.ts buildWallRoot）', () => {
    const result = telescope.generate(resolveParams(telescope, productionOverrides));
    for (const pieceId of ['base', 'lid'] as const) {
      const piece = result.pieces!.find((p) => p.id === pieceId)!;
      const paths = result.paths.filter((p) => piece.pathIds.includes(p.id));
      const root = findTagged(paths, 'wallRoot', 'back', 'crease');
      expect(root, `${pieceId} wallRoot(back) 應恰有 1 條 path`).toHaveLength(1);

      const perpExtentSegs = root[0]!.segments.filter((s) => s.kind === 'line' && Math.abs(s.x2 - s.x1) > 1e-6);
      expect(perpExtentSegs, `${pieceId}: 應只有 1 段有 perp 延伸（中央 offset crease），不是 2 段 full-length 平行線`).toHaveLength(1);

      const jogSegs = root[0]!.segments.filter((s) => {
        if (s.kind !== 'line') return false;
        return Math.abs(s.x2 - s.x1) < 1e-9 && Math.abs(s.y2 - s.y1) > 1e-9;
      });
      const wantJogSegs = pieceId === 'base' ? 2 : 0;
      expect(jogSegs, `${pieceId}: A 款應有 2 段零 perp 位移的 jog 短段、B 款不應新增（區間併入 gussetFold）`).toHaveLength(wantJogSegs);
    }
  });

  it('B 款（lid）entity 結構驗證（全管線）：wallRoot(back) 僅中央 offset crease 一段，nominal 由相鄰角落 gussetFold 的 y 軸摺線合併回來、間距＝rootJog（Finding 1）', () => {
    const result = telescope.generate(resolveParams(telescope, productionOverrides));
    const piece = result.pieces!.find((p) => p.id === 'lid')!;
    const paths = result.paths.filter((p) => piece.pathIds.includes(p.id));
    const merged = yRootNominalOffset(paths, 'back').sort((a, b) => a - b);
    expect(merged, 'wallRoot(back) 自身只有 offset 一值，nominal 應能從 gussetFold 合併回來，共 2 值').toHaveLength(2);
    expect(merged[1]! - merged[0]!, 'nominal/offset 間距＝rootJog').toBeCloseTo(productionOverrides.rootJog, 6);
  });

  it('無同線型共線區間重疊（production-P 參數，base/lid 全管線）：Finding 1 原始 bug——jog 短段與角撐 y 軸摺線重疊 0.5mm——不得再現', () => {
    const result = telescope.generate(resolveParams(telescope, productionOverrides));
    for (const pieceId of ['base', 'lid'] as const) {
      const piece = result.pieces!.find((p) => p.id === pieceId)!;
      const paths = result.paths.filter((p) => piece.pathIds.includes(p.id));
      const overlaps = findCollinearOverlaps(paths);
      expect(overlaps, `${pieceId}: ${overlaps.join('; ')}`).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 F4／F6-A（Task 3）production-P 錨：U-notch＋halfcut 分段＋平台角撐周邊複合
// relief 鏈。全部用 spec §fixture 的 production-P 完整參數組（附錄 B），非部分 override——
// 這批錨（halfcut 總長／feature 計數／bbox／無自撞/無重疊）需要「下盒全套」正確才會通過，
// 部分參數覆寫測不出遺漏。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: F4／F6-A production-P 錨（Slice 5 Task 3 驗收）', () => {
  const productionP = {
    baseLength: 179,
    baseWidth: 124,
    baseHeight: 60,
    lidMarginX: 13.5,
    lidMarginY: 18.5,
    lidHeight: 45,
    basePlatformWidth: 5,
    lidPlatformWidth: 0,
    thickness: 0.44,
    rootJog: 0.5,
    innerWallReduction: 0.8,
    wallTopCompensation: 0.5,
    linerEnabled: false,
  };
  const result = telescope.generate(resolveParams(telescope, productionP));
  const basePiece = result.pieces!.find((p) => p.id === 'base')!;
  const lidPiece = result.pieces!.find((p) => p.id === 'lid')!;
  const basePaths = result.paths.filter((p) => basePiece.pathIds.includes(p.id));
  const lidPaths = result.paths.filter((p) => lidPiece.pathIds.includes(p.id));
  const baseGeomOnly = basePaths.filter((p) => p.type !== 'dimension');
  const lidGeomOnly = lidPaths.filter((p) => p.type !== 'dimension');

  it('下盒 halfcut 總長 332.0±0.5（P measured 331.999，F4 驗收錨）', () => {
    const halfcutPaths = basePaths.filter((p) => p.type === 'halfcut' && p.tags?.includes('tongueFold'));
    let total = 0;
    for (const p of halfcutPaths) {
      for (const s of p.segments) {
        if (s.kind === 'line') total += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      }
    }
    expect(Math.abs(total - 332.0), `halfcut 總長 ${total.toFixed(4)}mm`).toBeLessThanOrEqual(0.5);
  });

  it('feature 計數（feature-normalized，spec M5）：6 個 U-notch（30 段=6×5）、12 個 R2 圓角、4 個 R2.5 平台角圓角', () => {
    const notchPaths = baseGeomOnly.filter((p) => p.tags?.includes('uNotch'));
    const totalNotchSegs = notchPaths.reduce((s, p) => s + p.segments.length, 0);
    expect(totalNotchSegs, '6 個 U-notch，每個 5 段（2 直線＋2 圓角＋1 底線）＝30 段').toBe(30);

    const r2Arcs = notchPaths.flatMap((p) => p.segments).filter((s): s is Extract<Segment, { kind: 'arc' }> => s.kind === 'arc');
    expect(r2Arcs, '12 個 R2 quarter arc（每個 notch 2 個 R2）').toHaveLength(12);
    for (const a of r2Arcs) expect(a.r, 'notch 圓角半徑＝R2').toBeCloseTo(2, 6);

    const cornerPaths = baseGeomOnly.filter((p) => p.tags?.includes('platformCorner'));
    const r25Arcs = cornerPaths.flatMap((p) => p.segments).filter((s): s is Extract<Segment, { kind: 'arc' }> => s.kind === 'arc');
    expect(r25Arcs, '4 個平台角 R2.5 圓角（每角一個）').toHaveLength(4);
    for (const a of r25Arcs) expect(a.r, '平台角圓角半徑＝R2.5').toBeCloseTo(2.5, 6);
  });

  it('攤平外框 bbox（僅製造幾何，不含標註）：下盒 400.403×458.403、上蓋 359.399×425.401（±0.15，spec F8）', () => {
    const baseBounds = segmentsBounds(baseGeomOnly.flatMap((p) => p.segments));
    const lidBounds = segmentsBounds(lidGeomOnly.flatMap((p) => p.segments));
    expect(Math.abs(baseBounds.maxX - baseBounds.minX - 400.403), '下盒寬').toBeLessThanOrEqual(0.15);
    expect(Math.abs(baseBounds.maxY - baseBounds.minY - 458.403), '下盒高').toBeLessThanOrEqual(0.15);
    expect(Math.abs(lidBounds.maxX - lidBounds.minX - 359.399), '上蓋寬（F4/F6-A 只動下盒，上蓋應不受影響）').toBeLessThanOrEqual(0.15);
    expect(Math.abs(lidBounds.maxY - lidBounds.minY - 425.401), '上蓋高（同上）').toBeLessThanOrEqual(0.15);
  });

  it('無 NaN、下盒 cut 無自撞、無同線型共線區間重疊（production-P 完整參數，含 thickness=0.44）', () => {
    expect(hasNaN(basePaths.flatMap((p) => p.segments)), 'hasNaN').toBe(false);
    const cutSegs = basePaths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
    expect(hasSelfIntersection(cutSegs), 'cut 無自撞').toBe(false);
    const overlaps = findCollinearOverlaps(basePaths);
    expect(overlaps, overlaps.join('; ')).toEqual([]);
  });

});

// ─────────────────────────────────────────────────────────────────────────
// Slice 5 Task 4：F5／F6-B production-P 錨——B 款舌根拓撲整組＋V relief＋角撐周邊，全部用
// production-P 完整參數組（同上一 describe block 的 productionP 常數，各自獨立重算一份，
// 不共用變數——避免跨 describe block 隱性耦合）。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: F5／F6-B production-P 錨（Slice 5 Task 4 驗收）', () => {
  const productionP = {
    baseLength: 179,
    baseWidth: 124,
    baseHeight: 60,
    lidMarginX: 13.5,
    lidMarginY: 18.5,
    lidHeight: 45,
    basePlatformWidth: 5,
    lidPlatformWidth: 0,
    thickness: 0.44,
    rootJog: 0.5,
    innerWallReduction: 0.8,
    wallTopCompensation: 0.5,
    linerEnabled: false,
  };
  const result = telescope.generate(resolveParams(telescope, productionP));
  const lidPiece = result.pieces!.find((p) => p.id === 'lid')!;
  const lidPaths = result.paths.filter((p) => lidPiece.pathIds.includes(p.id));
  const lidGeomOnly = lidPaths.filter((p) => p.type !== 'dimension');

  function lidHalfcutTotal(): number {
    const halfcutPaths = lidPaths.filter((p) => p.type === 'halfcut' && p.tags?.includes('tongueFold'));
    let total = 0;
    for (const p of halfcutPaths) {
      for (const s of p.segments) {
        if (s.kind === 'line') total += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      }
    }
    return total;
  }

  it('上蓋 halfcut 總長 366.4±0.5（P measured 366.402，F5 驗收錨）', () => {
    const total = lidHalfcutTotal();
    expect(Math.abs(total - 366.4), `halfcut 總長 ${total.toFixed(4)}mm`).toBeLessThanOrEqual(0.5);
  });

  it('mutation 自證：把 halfcutPaths 過濾條件改壞（模擬漏抓段）必須讓上一則錨值偏離超出容差——證明斷言真的在量東西', () => {
    // 不改 production 碼（會影響平行測試），改在這裡重放同一計算但故意漏篩 tongueFold tag
    // （會多算 wallSide／tongueFlap 等其他 halfcut——這裡沒有其他 halfcut 型別，改用「只算
    // 一半 path」模擬漏抓，證明「總長對」不是因為斷言範圍太寬鬆而巧合通過）。
    const halfcutPaths = lidPaths.filter((p) => p.type === 'halfcut' && p.tags?.includes('tongueFold'));
    expect(halfcutPaths.length, 'production-P 上蓋應有 4 條 halfcut path（左右前後各一）').toBe(4);
    let brokenTotal = 0;
    for (const p of halfcutPaths.slice(0, halfcutPaths.length - 1)) {
      // 暫壞：只取前 n-1 條（模擬漏掉一條壁的 halfcut）
      for (const s of p.segments) if (s.kind === 'line') brokenTotal += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    }
    expect(Math.abs(brokenTotal - 366.4), '暫壞版本（漏一條壁）應明顯偏離 366.4（證明錨有牙齒，非巧合通過）').toBeGreaterThan(0.5);
  });

  it('V relief×4：nominal 5×2.5、每個 2 條 cut 直線、無圓角（feature-normalized 全域計數）', () => {
    const vReliefPaths = lidGeomOnly.filter((p) => p.tags?.includes('vRelief'));
    expect(vReliefPaths, '前後壁各一條 vRelief path（每條含兩端共 2 個 V）').toHaveLength(2);
    const allSegs = vReliefPaths.flatMap((p) => p.segments);
    expect(allSegs, '2 條 path×4 段＝8 段（4 個 V×2 線）').toHaveLength(8);
    expect(allSegs.every((s) => s.kind === 'line'), 'V relief 全為直線，無圓角').toBe(true);
    for (const s of allSegs as LineSeg[]) {
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      expect(len, 'V 臂長＝√(inset²+(height/2)²)＝√(2.5²+2.5²)（nominal 5×2.5）').toBeCloseTo(Math.hypot(2.5, 2.5), 1);
    }
  });

  it('B 款角撐周邊 R2×4：4 個角落各恰 1 個 R2 圓角（feature-normalized 全域計數，R1.5/R5 核心不重複列入）', () => {
    const periPaths = lidGeomOnly.filter((p) => p.tags?.includes('bGussetPeriphery'));
    expect(periPaths, '4 個角落各 1 條 bGussetPeriphery path').toHaveLength(4);
    const r2Arcs = periPaths.flatMap((p) => p.segments).filter((s): s is Extract<Segment, { kind: 'arc' }> => s.kind === 'arc');
    expect(r2Arcs, '4 個 R2 圓角（每角 1 個，不含 buildGussetB 既有的 R1.5/R5）').toHaveLength(4);
    for (const a of r2Arcs) expect(a.r, 'B 款角撐周邊圓角半徑＝R2').toBeCloseTo(2, 6);
  });

  it('無 NaN、上蓋 cut 無自撞、無同線型共線區間重疊（production-P 完整參數，含 thickness=0.44）', () => {
    expect(hasNaN(lidPaths.flatMap((p) => p.segments)), 'hasNaN').toBe(false);
    const cutSegs = lidPaths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
    expect(hasSelfIntersection(cutSegs), 'cut 無自撞').toBe(false);
    const overlaps = findCollinearOverlaps(lidPaths);
    expect(overlaps, overlaps.join('; ')).toEqual([]);
  });

  it('攤平外框 bbox 不受影響：上蓋 359.399×425.401（±0.15，同 F4/F6-A 錨——F5/F6-B 新增幾何皆落在既有 tongueFlap 包絡內）', () => {
    const lidBounds = segmentsBounds(lidGeomOnly.flatMap((p) => p.segments));
    expect(Math.abs(lidBounds.maxX - lidBounds.minX - 359.399), '上蓋寬').toBeLessThanOrEqual(0.15);
    expect(Math.abs(lidBounds.maxY - lidBounds.minY - 425.401), '上蓋高').toBeLessThanOrEqual(0.15);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Step 6：天地盒版 param-sweep（重用 Slice 1 掃描骨架：tests/boxes/param-sweep.test.ts
// 的 assertSafe 慣例——不判斷幾何「對不對」，只判斷「不崩潰、無 NaN、bounds 有限」這條
// 最低限度安全網，額外疊天地盒特有的兩項：不變式全過或正確警告、cut 無自撞（範圍化豁免，
// 見下）。
//
// 「全過或正確警告」的判準：telescope 的 9 條不變式裡，pieces-valid／pieces-identity／
// rim-flush／no-nan／no-bleed／bounds-cover 這 6 條是「恆真」不變式（由生成幾何的結構
// 保證，任何合法參數組合下都不該 not-ok，若 not-ok 代表真的有 bug）；liner-flap-fits
// （2026-07-09 T7 gate 重定義，取代 liner-flange-fits）／gusset-b-fits／tongue-flap-fits
// （fix wave F1 新增）三條是「設計上的參數域邊界」，允許 not-ok（腳架過深或底面過小、
// 薄壁角撐壁高太矮、面板邊過短），但警告訊息必須是非空字串
//（「正確警告」而非崩潰或回傳殘缺物件）。
//
// cut 自撞的「範圍化豁免」（fix wave F5——取代第一版的全域豁免）：邊界不變式警告觸發時，
// 只豁免「該警告能解釋」的 tag 範圍（tongue-flap-fits→tongueFlap、gusset-b-fits→gusset、
// liner-flap-fits→linerFlap 翼片），其餘 cut 照驗——全域豁免會讓一個 gusset 警告遮蔽掉舌片
// 或內襯的新自撞；範圍化才能讓豁免精確對應「已警告的已知退化」，其餘部位的自撞仍是紅燈。
//
// 只新增 tests/telescope-fixture.test.ts＋tests/fixtures/telescope-reference.json 兩檔的
// 限制下（F1 例外授權動 src/boxes/telescope/index.ts），這個 describe block 放在本檔尾端。
// ─────────────────────────────────────────────────────────────────────────

const ALWAYS_OK_INVARIANTS = new Set(['pieces-valid', 'pieces-identity', 'rim-flush', 'no-nan', 'no-bleed', 'bounds-cover']);

/**
 * 「參數域邊界」不變式 → 該警告能解釋（豁免）的 cut path tag 範圍（fix wave F5）。
 * 警告觸發時只有這些 tag 的 cut 允許自撞——tray.ts 修好對應幾何後可逐項收窄。
 */
const BOUNDARY_EXEMPT_TAGS: Record<string, readonly string[]> = {
  // Slice 5 F6-B：B 款角撐周邊（bGussetPeriphery）的 a 軸終點（chainAReach，隨 height/
  // wallTopCompensation/innerWallReduction 現場算）與 b 軸終點（recess+
  // TUCK_FLAP_SHALLOW_DEPTH＝16.5，同 MIN_TONGUE_PERP_HALF 門檻）分別與 gusset-b-fits／
  // tongue-flap-fits 兩條既有不變式的觸發條件同源（同一 minStyleBHeight／perpHalf<16.5
  // 退化點）——壁高過矮或面板邊過短時周邊鏈跟著退化自撞，豁免範圍隨兩條既有不變式擴充
  // （見 tray.ts buildBGussetPeriphery／bPeripheryTailB 註解）。
  'gusset-b-fits': ['gusset', 'bGussetPeriphery'],
  'tongue-flap-fits': ['tongueFlap', 'bGussetPeriphery'],
  // 2026-07-09 T7 gate 重定義：liner-flange-fits→liner-flap-fits；豁免範圍改為新幾何
  // 的翼片 cut tag（'linerFlap'）——平台式重定義後底面 crease 不含 cut，'linerPad' 不需要豁免。
  'liner-flap-fits': ['linerFlap'],
  // Slice 5 F4／F6-A：platform-corner-omitted 降級影響的幾何 tag（tray.ts buildAPlatformCornerRelief）
  // 仍需豁免（直角轉接本身不产生自撞問題，此條純粹是既有的合法幾何 tag 範圍）。
  'platform-corner-omitted': ['platformCorner'],
  // Fix 2·2026-07-11 SOL review H2：notch-reduced／notch-omitted 先前豁免 'uNotch' 是
  // 掩蓋 uNotch×aGussetPeriphery 真自交的權宜之計（見下方 gusset-relief-omitted）——
  // tray.ts 已改為鏈本身放不下就整鏈省略，notch 自己的幾何從不自撞，兩條豁免範圍收窄為
  // 空陣列（保留分類完備性紀錄，不再實際豁免任何 tag——S1-S4 全部走未過濾 cut 自交斷言）。
  'notch-reduced': [],
  'notch-omitted': [],
  // Fix 2·2026-07-11：複合 relief 鏈（aGussetPeriphery）放不下時整鏈省略，不留半成品
  // 幾何——warning 是合法降級聲明，不是自交豁免，同樣不實際豁免任何 tag。
  'gusset-relief-omitted': [],
  // Slice 5 F5：B 款端段縮減三分支（分支 2/3）與 V relief 可容納降級——三者皆為「端段/
  // V relief 縮到剩餘長度」的合法幾何變化（crease 縮短、halfcut 補滿、V relief 省略），
  // 不產生自撞問題，同 notch-reduced/notch-omitted 先例不實際豁免任何 tag。
  'tongue-crease-shrunk': [],
  'tongue-crease-omitted': [],
  'relief-omitted': [],
};

type Overrides = Partial<Record<string, number | boolean | string>>;

/** 對單一組參數斷言天地盒版安全網：不 throw、無 NaN、bounds 有限、不變式全過或正確警告、
 *  cut 無自撞（已觸發之邊界警告的對應 tag 範圍豁免，其餘照驗——見上方區塊說明）。 */
function assertTelescopeSafe(label: string, overrides: Overrides): void {
  it(`${label}：generate 不 throw、無 NaN、bounds 有限、不變式全過或正確警告、cut 無自撞（豁免已警告範圍）`, () => {
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

    const exemptTags = new Set<string>();
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
        for (const tag of BOUNDARY_EXEMPT_TAGS[inv.id] ?? []) exemptTags.add(tag);
      }
    }

    // cut 自撞恆驗（F5）：只扣掉「已觸發警告能解釋」的 tag 範圍，其餘 cut 一律要乾淨
    const nonExemptCutSegs = result!.paths
      .filter((p) => p.type === 'cut' && !p.tags?.some((t) => exemptTags.has(t)))
      .flatMap((p) => p.segments);
    expect(
      hasSelfIntersection(nonExemptCutSegs),
      `${label}：cut 不應自撞（已扣除被邊界警告豁免的範圍：${[...exemptTags].join('、') || '無'}）`,
    ).toBe(false);
  });
}

describe('telescope: param-sweep（Step 6，天地盒版；重用 Slice 1 掃描骨架）', () => {
  it('不變式分類完備：每條不變式都被歸入「恆真」或「邊界豁免表」（新增不變式時必須更新分類）', () => {
    // 沒有這條 guard，新不變式會默默走進 else 分支被當成邊界類（警告不豁免任何範圍），
    // 上方註解的「12 條＝6 恆真＋6 邊界」（Slice 5 F4/F6-A 新增 notch-reduced／
    // notch-omitted／platform-corner-omitted 三條）也會無聲過期——結構性釘住分類完備性。
    const classified = new Set([...ALWAYS_OK_INVARIANTS, ...Object.keys(BOUNDARY_EXEMPT_TAGS)]);
    expect(telescope.invariants.map((i) => i.id).sort()).toEqual([...classified].sort());
  });

  describe('單一 mm 參數 min/max（其餘維持預設，同 RTE tier 1）', () => {
    // baseLength/baseWidth 的宣告 min=30 落在 tongueFlap 反轉退化區（perpHalf=15<16.5），
    // F1 之後由 tongue-flap-fits 不變式正確警告、F5 的範圍化豁免接住舌片自撞——
    // 掃描因此可以直接用真正的宣告 min（fix wave F2：測試期待的是「有正確警告」，
    // 不是「壞幾何存在」或跳過參數點）。
    for (const p of telescope.params) {
      if (p.unit !== 'mm') continue;
      if (p.min !== undefined) assertTelescopeSafe(`${p.key}=min(${p.min})`, { [p.key]: p.min });
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

  describe('內襯腳架邊界 三值交叉（baseHeight×linerFlapDepth；驅動 liner-flap-fits 條件 1「腳架深度超過壁高」，2026-07-09 T7 gate 重定義取代舊 lidMargin×linerFitGap 交叉——liner 不再錨定 lidMargin）', () => {
    for (const baseHeight of [10, 60, 200]) {
      for (const linerFlapDepth of [5, 15, 60]) {
        assertTelescopeSafe(`baseHeight=${baseHeight}, linerFlapDepth=${linerFlapDepth}`, { baseHeight, linerFlapDepth });
      }
    }
    assertTelescopeSafe('linerEnabled=false + baseHeight=10（關內襯時腳架警告應被閘門擋下，不得假警告）', {
      linerEnabled: false,
      baseHeight: 10,
    });
  });

  describe('內襯底面邊界 三值交叉（baseWidth×linerFlapDepth；驅動 liner-flap-fits 條件 3「翼片外緣反轉」）', () => {
    for (const baseWidth of [30, 124, 600]) {
      for (const linerFlapDepth of [5, 15, 60]) {
        assertTelescopeSafe(`baseWidth=${baseWidth}, linerFlapDepth=${linerFlapDepth}`, { baseWidth, linerFlapDepth });
      }
    }
  });

  describe('全域極端組合（同 RTE「全部參數同時取 min/max」慣例）', () => {
    // 全部用真正的宣告 min（F2 revert）：baseLength/baseWidth=30 會觸發 tongue-flap-fits、
    // 壁高 10＋薄壁觸發 gusset-b-fits、腳架深度（linerFlapDepth 未覆寫＝預設 15）＞壁高 10
    // 觸發 liner-flap-fits（2026-07-09 平台式重定義後 lidMargin 與內襯無關，min 組合改由
    // 這條件觸發）——三條邊界警告各自豁免自己的 tag 範圍，其餘 cut 照驗（F5）。
    // Slice 5 F1／F3：lidMargin 拆 lidMarginX/lidMarginY（min=5/max=60）；新增
    // rootJog/innerWallReduction/wallTopCompensation 一併推到 min/max——三者皆由
    // generateTray 自我一致地消費（rim-flush/pieces-identity 為結構性恆真，見該不變式
    // 推導），推到極端不會產生新的「必過」不變式失敗，只強化這組極端組合的覆蓋面。
    assertTelescopeSafe('全部關鍵參數同時取 min', {
      baseLength: 30,
      baseWidth: 30,
      baseHeight: 10,
      lidMarginX: 5,
      lidMarginY: 5,
      lidHeight: 10,
      basePlatformWidth: 0,
      lidPlatformWidth: 0,
      thickness: 0,
      rootJog: 0,
      innerWallReduction: 0,
      wallTopCompensation: 0,
      linerFitGap: 0.2,
    });
    assertTelescopeSafe('全部關鍵參數同時取 max', {
      baseLength: 600,
      baseWidth: 600,
      baseHeight: 200,
      lidMarginX: 60,
      lidMarginY: 60,
      lidHeight: 200,
      basePlatformWidth: 15,
      lidPlatformWidth: 15,
      thickness: 0.8,
      rootJog: 3,
      innerWallReduction: 5,
      wallTopCompensation: 5,
      linerFitGap: 2,
    });
    assertTelescopeSafe('大長寬比面板（baseLength=max, baseWidth=min）', { baseLength: 600, baseWidth: 30 });
    assertTelescopeSafe('大長寬比面板反向（baseLength=min, baseWidth=max）', { baseLength: 30, baseWidth: 600 });
    assertTelescopeSafe('linerEnabled=false + 壁高極端（不對稱 tall/short＋薄壁）', {
      linerEnabled: false,
      baseHeight: 200,
      lidHeight: 10,
      basePlatformWidth: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// tongue-flap-fits 邊界行為（fix wave F1/F2——原「已知問題」block 改寫）。
//
// T5 param-sweep 挖出 tray.ts buildTongueFlap 在 perpHalf<16.5mm（TONGUE_END_RECESS＋
// TUCK_FLAP_SHALLOW_DEPTH，門檻代數推導見 index.ts MIN_TONGUE_PERP_HALF 的註解）時
// 插底舌梯形反轉自撞；F1 依 gusset-b-fits 先例補了參數公式型警告不變式（只加不變式、
// 不動幾何）。本 block 驗證「警告正確觸發」——測試期待的是有正確警告，不是壞幾何存在；
// 幾何本身仍自撞的現狀記為該警告的豁免案例（見最後一個 it）——若未來 tray.ts 修好
// 幾何，該 it 變紅，屆時應移除豁免案例、並考慮收窄 BOUNDARY_EXEMPT_TAGS 的 tongueFlap 項。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope: tongue-flap-fits 邊界行為（F1 警告不變式）', () => {
  const inv = () => telescope.invariants.find((i) => i.id === 'tongue-flap-fits')!;

  it('baseLength=30（宣告 min）：警告觸發、訊息含最小安全邊長提示（2×16.5=33）、tags 指向 baseLength', () => {
    const params = resolveParams(telescope, { baseLength: 30 });
    const outcome = inv().check(params, telescope.generate(params));
    expect(outcome.ok, '30 < 33 應警告').toBe(false);
    if (!outcome.ok) {
      expect(outcome.message.zh, '警告訊息應含最小安全邊長提示').toContain(`${2 * MIN_TONGUE_PERP_HALF}`);
      expect(outcome.tags, '應指向可調的參數').toContain('baseLength');
    }
  });

  it('baseWidth 側同樣把關（前後壁的舌片沿 baseWidth 邊分佈）', () => {
    const params = resolveParams(telescope, { baseWidth: 30 });
    const outcome = inv().check(params, telescope.generate(params));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.tags).toContain('baseWidth');
  });

  it('門檻邊界（獨立二分搜尋錨）：baseLength=33 不警告且 base 片 cut 幾何乾淨；32 警告', () => {
    const at33 = resolveParams(telescope, { baseLength: 33 });
    const r33 = telescope.generate(at33);
    expect(inv().check(at33, r33), '33＝2×MIN_TONGUE_PERP_HALF 恰在門檻上，不警告').toMatchObject({ ok: true });
    const piece33 = r33.pieces!.find((p) => p.id === 'base')!;
    const cut33 = r33.paths.filter((p) => piece33.pathIds.includes(p.id) && p.type === 'cut').flatMap((p) => p.segments);
    expect(hasSelfIntersection(cut33), 'baseLength=33（perpHalf=16.5）幾何應乾淨').toBe(false);

    const at32 = resolveParams(telescope, { baseLength: 32 });
    expect(inv().check(at32, telescope.generate(at32)), '32 < 33 應警告').toMatchObject({ ok: false });
  });

  it('豁免案例現狀記錄：baseLength=30 時 base 片 tongueFlap cut 仍自撞（已被 F1 警告涵蓋；tray.ts 修好幾何時本 it 變紅→移除豁免）', () => {
    const params = resolveParams(telescope, { baseLength: 30 });
    const result = telescope.generate(params);
    const piece = result.pieces!.find((p) => p.id === 'base')!;
    const flapSegs = result.paths
      .filter((p) => piece.pathIds.includes(p.id) && p.type === 'cut' && p.tags?.includes('tongueFlap'))
      .flatMap((p) => p.segments);
    expect(hasSelfIntersection(flapSegs), '幾何現狀：警告觸發下舌片仍自撞（BOUNDARY_EXEMPT_TAGS 豁免的正當性依據）').toBe(true);
  });
});
