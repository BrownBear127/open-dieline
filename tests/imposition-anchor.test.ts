import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { manufacturingBounds } from '@/core/bounds';
import { resolveParams } from '@/core/registry';
import { computeImposition, PAPER_PRESETS } from '@/core/imposition';
import type { ImpositionInput, ImpositionResult } from '@/core/imposition';
import { computeProfileStrides, manufacturingPaths } from '@/core/profile';
import { segmentsBounds, flattenBezier } from '@/core/geometry';
import type { Bounds, Segment } from '@/core/geometry';
import { Z_NOTCH_SEGMENTS, Z_NOTCH_GAP, POSITIVE_FILL_INPUT, Z_NOTCH_ANCHOR_DEG0, Z_NOTCH_ANCHOR_DEG90 } from './fixtures/z-notch';
import productionPRaw from './fixtures/telescope-production-P.json';

/**
 * 整合錨——驗收條件 1／2 全鏈：RTE 預設 generate → manufacturingBounds →
 * computeImposition，證明拼版必須用「製造 bounds」而不是 `GenerateResult.bounds`
 * （declared bounds，含四邊 20mm 畫布留白）。純函式本身的計算細節（fitCount 浮點
 * 案例、六組合矩陣、domain 驗證等）由 `tests/imposition.test.ts` 覆蓋，這裡只驗證
 * 「跟真實盒型 generate 串起來時，兩種 bounds 來源會算出不同、且不可回退」這件事。
 */

/** ok:true 窄化＋失敗時把 errors 印進錯誤訊息，方便測試失敗時直接看到原因。 */
function assertOk(result: ImpositionResult): asserts result is Extract<ImpositionResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`預期 ok:true，但收到 errors：${JSON.stringify(result.errors)}`);
  }
}

// 紙規／方向／裁切／咬口／gap——兩條路徑（製造 bounds vs declared bounds）共用同一組，
// 只有 pieceW/pieceH 的來源不同，才能乾淨地證明差異單純來自 bounds 選擇。allowRotate:false
// 保留補排功能加入前的整紙數字（12/8/6，本測試職責是 bounds 來源比較，不是補排邏輯）。
const SHEET_FIELDS = {
  paperW: 787,
  paperH: 1092,
  orientation: 'portrait' as const,
  cutV: false,
  cutH: false,
  allowRotate: false,
  gripper: 20,
  gap: 3,
};

describe('imposition 整合錨——製造 bounds vs declared bounds（spec F1／驗收條件 1、2）', () => {
  it('RTE 預設參數：製造 bounds 路徑算出 12/8 模；改用 declared bounds（result.bounds，273.2×291）算出 6 模', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));

    // 製造 bounds（排除尺寸標註後的緊 bounds）——正確路徑
    const mfgBounds = manufacturingBounds(result);
    const mfgInput: ImpositionInput = {
      ...SHEET_FIELDS,
      pieceW: mfgBounds.maxX - mfgBounds.minX,
      pieceH: mfgBounds.maxY - mfgBounds.minY,
    };
    const mfgResult = computeImposition(mfgInput);
    assertOk(mfgResult);

    // declared bounds（`result.bounds`，含四邊 20mm 畫布留白）——回退用這個會算錯
    const declaredInput: ImpositionInput = {
      ...SHEET_FIELDS,
      pieceW: result.bounds.maxX - result.bounds.minX,
      pieceH: result.bounds.maxY - result.bounds.minY,
    };
    const declaredResult = computeImposition(declaredInput);
    assertOk(declaredResult);

    // 先確認兩個 bounds 來源本身數值不同（233.2×251 vs 273.2×291），才談得上下游算出不同模數
    expect(mfgInput.pieceW).toBeCloseTo(233.2, 2);
    expect(mfgInput.pieceH).toBeCloseTo(251, 2);
    expect(declaredInput.pieceW).toBeCloseTo(273.2, 2);
    expect(declaredInput.pieceH).toBeCloseTo(291, 2);

    // 正確路徑：製造 bounds → 12/8 模（brief 驗收條件 1 數值錨）
    expect(mfgResult.deg0.count).toBe(12);
    expect(mfgResult.deg90.count).toBe(8);

    // 回退路徑：declared bounds → 6 模——用四邊各 20mm 留白的較大 bounds 當件尺寸，
    // 拼版拼得更鬆，模數只有正確答案的一半
    expect(declaredResult.deg0.count).toBe(6);

    // 硬規則斷言（spec 驗收條件 2）：兩條路徑必須不同——如果實作或呼叫端不小心
    // 回退用 declared bounds，這裡會抓到（防回退 declared bounds）
    expect(mfgResult.deg0.count).not.toBe(declaredResult.deg0.count);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// profile-spacing slice Task 5——整合錨（spec 驗收 1／2／3／6 收攏）
// docs/specs/2026-07-11-imposition-profile-spacing.md v1.4
// ═══════════════════════════════════════════════════════════════════════════

describe('computeImposition — RTE 三 preset 錨（profile-spacing spec 驗收 1：27×39/31×43 既有單元/UI 級錨的整合鏈引用確認＋25×35 新錨）', () => {
  const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
  const rteSegments = manufacturingPaths(rteResult).flatMap((p) => p.segments);
  const rteBounds = segmentsBounds(rteSegments);
  const pieceW = rteBounds.maxX - rteBounds.minX;
  const pieceH = rteBounds.maxY - rteBounds.minY;
  const gap = 3;
  const shrunk = computeProfileStrides(rteSegments, gap);

  function computeAtPreset(presetId: string): Extract<ImpositionResult, { ok: true }> {
    const preset = PAPER_PRESETS.find((p) => p.id === presetId)!;
    const result = computeImposition({
      pieceW,
      pieceH,
      paperW: preset.w,
      paperH: preset.h,
      orientation: 'portrait',
      cutV: false,
      cutH: false,
      allowRotate: true,
      gripper: 20,
      gap,
      shrunk,
    });
    assertOk(result);
    return result;
  }

  it('27×39（686×991）：0°=2×4=8、90°=3×4=12——tests/imposition.test.ts「RTE 錨」describe block 既有單元級錨的整合鏈引用確認（這裡走 generate→manufacturingPaths→computeImposition 全鏈，不是手打 pieceW/H 的純函式輸入，兩條路徑對同一組數字互相佐證）', () => {
    const result = computeAtPreset('27x39');
    expect(result.deg0).toMatchObject({ cols: 2, rows: 4, gridCount: 8, count: 8, spacingAxis: 'rows' });
    expect(result.deg90).toMatchObject({ cols: 3, rows: 4, gridCount: 12, count: 12, spacingAxis: 'cols' });
    expect(result.deg0.bottomFill?.count).toBe(0);
    expect(result.deg0.rightFill?.count).toBe(0);
    expect(result.deg90.bottomFill?.count).toBe(0);
    expect(result.deg90.rightFill?.count).toBe(0);
  });

  it('31×43（787×1092，App 預設紙規）：0°=3×5=15、90°=3×4=12——tests/imposition-app.test.tsx T4 既有 UI 級錨（probe-task4-app-default.mts 獨立重導 bit-exact）的整合鏈引用確認', () => {
    const result = computeAtPreset('31x43');
    expect(result.deg0).toMatchObject({ cols: 3, rows: 5, gridCount: 15, count: 15, spacingAxis: 'rows' });
    expect(result.deg90).toMatchObject({ cols: 3, rows: 4, gridCount: 12, count: 12, spacingAxis: 'cols' });
    expect(result.deg0.bottomFill?.count).toBe(0);
    expect(result.deg0.rightFill?.count).toBe(0);
    expect(result.deg90.bottomFill?.count).toBe(0);
    expect(result.deg90.rightFill?.count).toBe(0);
  });

  it('25×35（635×889，usable 595×849）：新錨，獨立重導——0°=2×4=8（行縮：piece 251+3×strideY≈835.47≤849 容下 4 行，第 5 行 251+4×strideY≈1030.3>849 放不下）；90°=2×3=6、spacingAxis=null（這個紙規下收縮候選並非「沒有效果」，而是恰好卡在門檻：cols 軸套用 shrunk.strideY≈194.825 後 251+2×194.825≈640.65 仍 >usableW=595，擠不出第 3 欄，與矩形候選 251+2×254=759（同樣只放得下 2 欄）打平——两案 count 相同，tie-break 選列縮但如實回報零收益，不是「該欄未收縮」的另一種說法）', () => {
    const result = computeAtPreset('25x35');

    expect(result.sheet.usableW).toBeCloseTo(595, 6);
    expect(result.sheet.usableH).toBeCloseTo(849, 6);

    expect(result.deg0).toMatchObject({
      cols: 2,
      rows: 4,
      gridCount: 8,
      count: 8,
      totalCount: 8,
      spacingAxis: 'rows',
      strideX: 236.2, // 矩形（233.2+3），未收縮向——RTE 左右緣平直，無收縮空間
    });
    expect(result.deg0.strideY).toBe(shrunk.strideY); // 逐位元＝shrunk 實際算出的值，不是另一個重算出的數字
    expect(result.deg0.usedH).toBeCloseTo(pieceH + 3 * shrunk.strideY!, 6); // n=4→piece+(4-1)×stride
    expect(result.deg0.bottomFill?.count).toBe(0);
    expect(result.deg0.rightFill?.count).toBe(0);

    expect(result.deg90).toMatchObject({
      cols: 2,
      rows: 3,
      gridCount: 6,
      count: 6,
      totalCount: 6,
      spacingAxis: null, // 見本測試標題推導：收縮候選在這個紙規沒有真的多擠出一欄，如實回報零收益
      strideX: 254, // 矩形（251+3）
      strideY: 236.2, // 矩形（233.2+3）
    });
    expect(result.deg90.bottomFill?.count).toBe(0);
    expect(result.deg90.rightFill?.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 間距不變式驗證工具（spec 驗收 2）——刻意獨立於 core/profile.ts 的近似手法：
// 不呼叫 computeProfileEnvelope／computeMinStride 或其內部的 arc-bbox／bezier-凸包
// 近似，只把 computeProfileStrides 的輸出（strideX/strideY 數字）當黑盒。這裡用另一條
// 算法路徑（真弧參數化取點＋de Casteljau bezier 折線＋直線均勻細分）重新離散化邊界，
// 若這裡跟 core 用同一套近似，被驗證的假設出錯時兩邊會一起錯、測試量不出真正的問題；
// 換一條獨立路徑才能提供有意義的交叉驗證。
//
// 誤差方向推論（供讀者核對，非窮舉式證明）：對離散取樣點集合 S⊂真實曲線 C，
// 「S 內兩點的最小距離」恆 ≥「C 上兩點的真實最小距離」（S 是 C 的子集，子集最小值不可能
// 小於全集最小值）；反過來，S 的取樣密度若保證「C 上任一點到 S 最近點的距離 ≤ e」，則可推得
// 真實最小距離 ≥ 取樣最小距離 − 2e（e 分別來自兩件各自的離散化誤差，三角不等式相加）。
// 因此：斷言「取樣最小距離 ≥ gap − errorBound」若成立，嚴格意義上只保證「真實最小距離
// ≥ gap − 2×errorBound」；本檔刻意把 errorBound 壓到遠小於 gap（毫米量級的百分之幾），
// 這個「差 2 倍」在數值上可忽略，同時仍允許 grid×strip 這類「設計上恰好貼齊 gap」的案例
// （無多餘餘裕）通過，不會因為方向反了而誤判合法排列為撞刀（見下方 DEG90 grid×strip 案例，
// 真實值恰好等於 gap）。
// ─────────────────────────────────────────────────────────────────────────

interface Pt2D {
  x: number;
  y: number;
}

/** 統一取樣密度上限（mm）——line／bezier 直接控制弦長上界；arc 用同一個目標反解角步
 *  （見 discretizeArc）。0.1mm 遠小於刀模特徵尺度，也遠小於下面觀測到的真實間距餘裕
 *  （RTE 案例真實最小距離 ≈3.8mm、Z-notch DEG0 grid×strip 案例 ≈10.44mm）；效能上
 *  RTE 單件離散化約 20000 點，配合下方 minDistance 的排序+二分視窗剪枝，單次呼叫
 *  約 70-90ms（task-5-report.md 記錄了 0.5/0.2/0.1/0.05/0.02/0.01mm 六級的實測時間/
 *  誤差權衡，0.1mm 是其中效能與誤差界都舒適的選擇）。 */
const MAX_CHORD_MM = 0.1;

/** `line`：本身即直線，取樣密度只影響「真實邊界點到最近取樣點」的間距誤差，上界＝半個
 *  弦長（`n=ceil(length/maxChordMM)` 保證每段 ≤ maxChordMM，最壞情況在相鄰兩取樣點正
 *  中間）。 */
function discretizeLine(seg: Extract<Segment, { kind: 'line' }>, maxChordMM: number): { points: Pt2D[]; pointErrorMM: number } {
  const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
  const n = Math.max(1, Math.ceil(len / maxChordMM));
  const points: Pt2D[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    points.push({ x: seg.x1 + t * (seg.x2 - seg.x1), y: seg.y1 + t * (seg.y2 - seg.y1) });
  }
  return { points, pointErrorMM: len / n / 2 };
}

/** `arc`：圓心＋半徑＋角度參數化的真弧取點（不是弦線、也不是 core/profile.ts `contributeArc`
 *  用的 bbox 保守替代）——sweep 方向計算獨立重寫，不呼叫 `core/geometry.ts` 內部未 export
 *  的 `flattenArc`（維持這條驗證路徑跟被驗證演算法零共用近似）。角步由目標弦長反解
 *  （`2r·sin(θ/2)=maxChordMM` → `θ=2·asin(maxChordMM/(2r))`），「真實邊界點到最近取樣點」
 *  誤差＝半弦長＋弦高（sagitta，brief 明文公式 `r(1−cos(θ/2))`，兩者同方向疊加，保守）。 */
function discretizeArc(seg: Extract<Segment, { kind: 'arc' }>, maxChordMM: number): { points: Pt2D[]; pointErrorMM: number } {
  const TWO_PI = 2 * Math.PI;
  const normalizeAngle = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  const rawSweep = seg.ccw ? seg.startAngle - seg.endAngle : seg.endAngle - seg.startAngle;
  let sweep = normalizeAngle(rawSweep);
  if (sweep < 1e-9 && Math.abs(rawSweep) > 1e-9) sweep = TWO_PI; // 整圈退化（同 flattenArc 的判斷準則，這裡獨立重算，不依賴它）

  const targetStepRad = seg.r > maxChordMM / 2 ? 2 * Math.asin(Math.min(1, maxChordMM / (2 * seg.r))) : sweep;
  const steps = Math.max(1, Math.ceil(sweep / targetStepRad));
  const dir = seg.ccw ? -1 : 1;
  const points: Pt2D[] = [];
  for (let i = 0; i <= steps; i++) {
    const theta = seg.startAngle + dir * sweep * (i / steps);
    points.push({ x: seg.cx + seg.r * Math.cos(theta), y: seg.cy + seg.r * Math.sin(theta) });
  }
  const actualStepRad = sweep / steps;
  const sagitta = seg.r * (1 - Math.cos(actualStepRad / 2));
  const chordLen = 2 * seg.r * Math.sin(actualStepRad / 2);
  return { points, pointErrorMM: chordLen / 2 + sagitta };
}

/** `bezier`：沿用 `core/geometry.ts` 既有 `flattenBezier`（de Casteljau 遞迴細分，`chordTol`
 *  即顯式弦高誤差界）——這是自撞偵測共用的通用幾何工具（遞迴細分成折線），不是被驗證的
 *  profile 近似手法本身（`core/profile.ts` 對 bezier 用的是「逐槽控制點凸包」，是不同算法），
 *  重用不影響這條驗證路徑的獨立性。`chordTol` 取極小值，實際誤差由 `maxSegLen`（＝
 *  `maxChordMM`）主導，推理同 line。 */
function discretizeBezier(seg: Extract<Segment, { kind: 'bezier' }>, maxChordMM: number): { points: Pt2D[]; pointErrorMM: number } {
  const chordTol = 1e-4;
  const lines = flattenBezier(seg, chordTol, maxChordMM);
  const points: Pt2D[] = [{ x: lines[0]!.x1, y: lines[0]!.y1 }, ...lines.map((l) => ({ x: l.x2, y: l.y2 }))];
  return { points, pointErrorMM: maxChordMM / 2 + chordTol };
}

function discretizeSegment(seg: Segment, maxChordMM: number): { points: Pt2D[]; pointErrorMM: number } {
  if (seg.kind === 'line') return discretizeLine(seg, maxChordMM);
  if (seg.kind === 'arc') return discretizeArc(seg, maxChordMM);
  return discretizeBezier(seg, maxChordMM);
}

/** 整件離散化：全部 segment 取樣點聯集＋這件「任一真實邊界點到最近取樣點」的誤差上界
 *  （取各 segment 誤差的最大值——單一 segment 的最壞情況即整件最壞情況，不同 segment 的
 *  誤差不會疊加到同一個點上）。 */
function discretizePiece(segments: Segment[], maxChordMM: number): { points: Pt2D[]; maxPointErrorMM: number } {
  const points: Pt2D[] = [];
  let maxPointErrorMM = 0;
  for (const seg of segments) {
    const { points: segPoints, pointErrorMM } = discretizeSegment(seg, maxChordMM);
    points.push(...segPoints);
    if (pointErrorMM > maxPointErrorMM) maxPointErrorMM = pointErrorMM;
  }
  return { points, maxPointErrorMM };
}

function translatePts(points: Pt2D[], dx: number, dy: number): Pt2D[] {
  return points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** d=90 的絕對座標變換——比照 `src/ui/impositionPreview.ts` `buildGrid` 的
 *  `translate(cellX cellY) translate(h 0) rotate(90) translate(-minX -minY)` 變換鏈手算
 *  展開（`rotate(90)` 對點的效果 `(x,y)→(−y,x)`，見該檔 docblock）：
 *    `X_abs = (mb.maxY − y) + cellX`；`Y_abs = (x − mb.minX) + cellY`
 *  只借用這個代數展開結果（純幾何事實，變換鏈本身不是被驗證的收縮演算法），不呼叫
 *  `directionInstances`（它回傳 SVG transform 字串，這裡需要的是點座標本身）。 */
function rotate90AndTranslate(points: Pt2D[], mb: Bounds, cellX: number, cellY: number): Pt2D[] {
  return points.map((p) => ({ x: mb.maxY - p.y + cellX, y: p.x - mb.minX + cellY }));
}

/** d=0 的絕對座標變換：`translate(cellX cellY) translate(-minX -minY)`。 */
function localizeAndTranslate(points: Pt2D[], mb: Bounds, cellX: number, cellY: number): Pt2D[] {
  return points.map((p) => ({ x: p.x - mb.minX + cellX, y: p.y - mb.minY + cellY }));
}

function lowerBoundIdx(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundIdx(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 剪枝搜尋視窗（mm）——遠大於 gap(3) 與本檔任何用到的誤差界（≤0.11mm），保證真正的
 *  全域最小值不會被剪枝誤刪（見 `minDistance` docblock）。 */
const PRUNE_WINDOW_MM = 15;

/** 兩點集最小歐氏距離——排序＋二分搜尋視窗剪枝（brief「或帶正確剪枝——|Δx|≥門檻可跳」的
 *  完整版：對 x 排序後，每個 A 點只需檢查 B 中 x 落在 `[a.x−window, a.x+window]` 的候選，
 *  內層再用 `|Δy|≥window` 續剪）。任兩點只要 `|Δx|≥window` 或 `|Δy|≥window`，其歐氏距離
 *  必 ≥window（距離 ≥ 任一軸投影差的絕對值），不可能是全域最小值的候選，跳過安全——
 *  剪枝只影響效能，`window` 設得遠大於 gap＋誤差界時不影響「找到的最小值是否正確」。 */
function minDistance(ptsA: Pt2D[], ptsB: Pt2D[], window: number): number {
  const sortedB = [...ptsB].sort((p, q) => p.x - q.x);
  const bx = sortedB.map((p) => p.x);
  let min = Infinity;
  for (const a of ptsA) {
    const lo = lowerBoundIdx(bx, a.x - window);
    const hi = upperBoundIdx(bx, a.x + window);
    for (let i = lo; i < hi; i++) {
      const b = sortedB[i]!;
      const dy = a.y - b.y;
      if (Math.abs(dy) >= window) continue;
      const dx = a.x - b.x;
      const d = Math.hypot(dx, dy);
      if (d < min) min = d;
    }
  }
  return min;
}

describe('computeImposition — 間距不變式（profile-spacing spec 驗收 2：幾何級證明，獨立於 core/profile.ts 內部近似手法）', () => {
  it('RTE 27×39 行縮：第 n 行與第 n+1 行（垂直位移 strideY）任兩邊界點對歐氏距離 ≥ gap − 離散誤差上界（cols 軸未收縮，異欄件由矩形 strideX 分離已保證 ≥gap——見 spec F3「禁止雙向同時收縮」的對角安全論證，只需驗同欄相鄰行）', () => {
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const rteSegments = manufacturingPaths(rteResult).flatMap((p) => p.segments);
    const gap = 3;
    const shrunk = computeProfileStrides(rteSegments, gap);
    const strideY = shrunk.strideY!;

    const { points, maxPointErrorMM } = discretizePiece(rteSegments, MAX_CHORD_MM);
    const errorBound = 2 * maxPointErrorMM; // 兩件（A/B）各自的最近取樣點誤差相加（三角不等式，見檔頭說明）

    const pieceA = points;
    const pieceB = translatePts(points, 0, strideY); // 第 n+1 行＝第 n 行純垂直平移 strideY

    const observed = minDistance(pieceA, pieceB, PRUNE_WINDOW_MM);

    // 實測（task-5-report.md 記錄完整推導）：maxChordMM=0.1mm → maxPointErrorMM≈0.0501mm、
    // errorBound≈0.1002mm；observed≈3.8001mm——真實幾何在這組相鄰行有 ≈0.8mm 餘裕，不是
    // 卡在邊界（strideY 的保守公式用 dxMin 下界高估 √ 校正項，見 computeMinStride docblock）。
    expect(observed).toBeGreaterThanOrEqual(gap - errorBound);
    expect(observed).toBeCloseTo(3.8, 1); // 迴歸錨：真實最小距離的量級鎖定，抓未來意外變動（非本不變式斷言的必要部分）
  });

  it('Z-notch 正補排案例（POSITIVE_FILL_INPUT）DEG0：主格點最後一行 vs 底條帶第一行——收縮主格點×補排條帶的相鄰件對同樣驗證幾何級間距（spec 驗收 2「擴展主格點×條帶件對」）', () => {
    const shrunk = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP);
    const result = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    assertOk(result);
    const deg0 = result.deg0;
    // 前提檢查：下面用到的 cols/rows/usedH 跟共用 fixture 權威值一致（T3 review Low 同一紀律，
    // 防這裡跟 tests/imposition.test.ts／tests/imposition-preview.test.ts 各自維護一份、悄悄漂移）。
    expect(deg0).toMatchObject(Z_NOTCH_ANCHOR_DEG0);

    const mb = segmentsBounds(Z_NOTCH_SEGMENTS);
    const { points, maxPointErrorMM } = discretizePiece(Z_NOTCH_SEGMENTS, MAX_CHORD_MM);
    const errorBound = 2 * maxPointErrorMM;
    const gripper = POSITIVE_FILL_INPUT.gripper; // 0，僅為公式完整性保留，兩件共用同一個 gripper 不影響相對距離

    // 主格點最後一行（r=rows-1, c=0），d=0（deg0 卡主方向，不轉向）。
    const mainLastRow = localizeAndTranslate(points, mb, gripper + 0 * deg0.strideX, gripper + (deg0.rows - 1) * deg0.strideY);
    // 底條帶第一行（r=0, c=0），d=90（fillDir 與主方向相反，見 pickFillSplit／buildGrid docblock）。
    const bottomStripFirst = rotate90AndTranslate(points, mb, gripper, gripper + deg0.usedH + Z_NOTCH_GAP);

    const observed = minDistance(mainLastRow, bottomStripFirst, PRUNE_WINDOW_MM);
    expect(observed).toBeGreaterThanOrEqual(Z_NOTCH_GAP - errorBound);
    expect(observed).toBeCloseTo(10.44, 1); // 迴歸錨：這組主格×條帶對本身餘裕很大，非緊繃邊界
  });

  it('Z-notch 正補排案例 DEG90：主格點最後一欄 vs 右條帶第一欄——同一組輸入的另一方向，證明檢查邏輯不是只在 DEG0 湊巧成立', () => {
    const shrunk = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP);
    const result = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    assertOk(result);
    const deg90 = result.deg90;
    expect(deg90).toMatchObject(Z_NOTCH_ANCHOR_DEG90);

    const mb = segmentsBounds(Z_NOTCH_SEGMENTS);
    const { points, maxPointErrorMM } = discretizePiece(Z_NOTCH_SEGMENTS, MAX_CHORD_MM);
    const errorBound = 2 * maxPointErrorMM;
    const gripper = POSITIVE_FILL_INPUT.gripper;

    // 主格點最後一欄（r=0, c=cols-1），d=90（deg90 卡主方向）。
    const mainLastCol = rotate90AndTranslate(points, mb, gripper + (deg90.cols - 1) * deg90.strideX, gripper + 0 * deg90.strideY);
    // 右條帶第一欄（r=0, c=0），d=0（fillDir 相反）。
    const rightStripFirst = localizeAndTranslate(points, mb, gripper + deg90.usedW + Z_NOTCH_GAP, gripper);

    const observed = minDistance(mainLastCol, rightStripFirst, PRUNE_WINDOW_MM);
    expect(observed).toBeGreaterThanOrEqual(Z_NOTCH_GAP - errorBound);
    // 這組對恰好卡在 gap 邊界本身（task-5-report.md 記錄推導：strip 起點公式 usedW+gap 與
    // 主格點矩形右緣在這個方向剛好無多餘餘裕，不是誤差雜訊）——真實值＝gap，不是遠大於它；
    // digits=1 只鎖「差不多剛好=gap」這個事實，避免對浮點尾數過度脆弱。
    expect(observed).toBeCloseTo(3, 1);
  });
});

// production-P 參數形狀（沿用 tests/imposition.test.ts 已建立的慣例：讀既有 JSON、不手打
// 第二份參數字面量）——本檔獨立一份小介面，不跨檔 import 測試工具（各測試檔自成一體）。
interface ProductionPParams {
  baseLength: number;
  baseWidth: number;
  baseHeight: number;
  lidMarginX: number;
  lidMarginY: number;
  lidHeight: number;
  basePlatformWidth: number;
  lidPlatformWidth: number;
  thickness: number;
  rootJog: number;
  innerWallReduction: number;
  wallTopCompensation: number;
  linerEnabled: boolean;
  [key: string]: number | boolean;
}

describe('computeImposition — telescope production-P 逐片迴歸鎖（profile-spacing spec 驗收 3：與 0f837fa〔profile-spacing slice 開工前基線〕逐字相同）', () => {
  // 0f837fa 基線數字的取得方式（task-5-report.md 記錄完整過程）：用 git worktree checkout
  // 0f837fa，對同一組 pieceW/H／preset／gripper/gap 輸入跑「當時版本」的 computeImposition
  // （該版本完全沒有 shrunk 概念，`fitCount` 是獨立公式、DirectionResult 沒有 strideX/Y／
  // usedW/H／spacingAxis 四個新欄位）；再與 HEAD（本 slice）省略 shrunk 的呼叫結果逐欄比對，
  // 確認 0f837fa→HEAD 的 `core/imposition.ts` 變更（`fitCount` 改委託 `fitCountStride`、
  // `usedW`/`usedH` 欄位化等）對「不帶 shrunk」的既有輸出零漂移（`utilization` 公式逐字
  // 相同、`count`/`gridCount` 由同一份委託後 fitCount 整數值驅動，非只是數值相近）。本測試
  // 把兩份探針比對的結論固化成可重跑的迴歸鎖，往後不必每次重開 worktree。

  const productionP = (productionPRaw as { params: ProductionPParams }).params;
  const teleResult = telescope.generate(resolveParams(telescope, productionP));
  const basePiece = teleResult.pieces!.find((p) => p.id === 'base')!; // 下盒
  const lidPiece = teleResult.pieces!.find((p) => p.id === 'lid')!; // 上蓋

  const baseBounds = manufacturingBounds(teleResult, basePiece);
  const lidBounds = manufacturingBounds(teleResult, lidPiece);

  function runBoth(pieceW: number, pieceH: number, preset: { w: number; h: number }, segments: Segment[], gripper: number, gap: number) {
    const baseInput: ImpositionInput = {
      pieceW,
      pieceH,
      paperW: preset.w,
      paperH: preset.h,
      orientation: 'portrait',
      cutV: false,
      cutH: false,
      allowRotate: true,
      gripper,
      gap,
    };
    const withoutShrunk = computeImposition(baseInput);
    const shrunk = computeProfileStrides(segments, gap);
    const withShrunk = computeImposition({ ...baseInput, shrunk });
    return { withoutShrunk, withShrunk };
  }

  it('下盒（base）@ 27×39：與 0f837fa 基線逐字相同（cols/rows/gridCount/fillSplit/bottomFill/rightFill/count/totalCount/utilization 全欄——0f837fa 的 DirectionResult 沒有 strideX/Y／usedW/H／spacingAxis，故不比對那四欄）；帶 shrunk 與不帶結果 toEqual（十字形件零收益，補齊 base 片在額外 preset 上的樣本——T2「telescope 退化」只驗過 1200×1200 人造大紙規）', () => {
    const pieceW = baseBounds.maxX - baseBounds.minX;
    const pieceH = baseBounds.maxY - baseBounds.minY;
    const segments = manufacturingPaths(teleResult, basePiece).flatMap((p) => p.segments);
    const preset = PAPER_PRESETS.find((p) => p.id === '27x39')!;
    const { withoutShrunk, withShrunk } = runBoth(pieceW, pieceH, preset, segments, 20, 3);

    assertOk(withoutShrunk);
    assertOk(withShrunk);
    expect(withShrunk).toEqual(withoutShrunk); // 收縮＝矩形退化（十字形件零收益，shrunk.strideX/Y 與矩形逐位元相等）

    expect(withoutShrunk.deg0).toMatchObject({
      cols: 1,
      rows: 2,
      gridCount: 2,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 1, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 2, count: 0 },
      count: 2,
      totalCount: 2,
    });
    expect(withoutShrunk.deg0.utilization).toBeCloseTo(0.5399715809633642, 12);
    expect(withoutShrunk.deg90).toMatchObject({
      cols: 1,
      rows: 2,
      gridCount: 2,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 1, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 1, count: 0 },
      count: 2,
      totalCount: 2,
    });
    expect(withoutShrunk.deg90.utilization).toBeCloseTo(0.5399715809633642, 12);
  });

  it('上蓋（lid）@ 25×35：與 0f837fa 基線逐字相同；帶 shrunk 與不帶結果 toEqual（補齊 lid 片樣本——這個 preset 剛好讓 deg0.bottomFill 算出非零 count=1，一併驗證「有 L 形補排」路徑在迴歸鎖下也不漂移，不是只覆蓋全零退化的情形）', () => {
    const pieceW = lidBounds.maxX - lidBounds.minX;
    const pieceH = lidBounds.maxY - lidBounds.minY;
    const segments = manufacturingPaths(teleResult, lidPiece).flatMap((p) => p.segments);
    const preset = PAPER_PRESETS.find((p) => p.id === '25x35')!;
    const { withoutShrunk, withShrunk } = runBoth(pieceW, pieceH, preset, segments, 20, 3);

    assertOk(withoutShrunk);
    assertOk(withShrunk);
    expect(withShrunk).toEqual(withoutShrunk);

    expect(withoutShrunk.deg0).toMatchObject({
      cols: 1,
      rows: 1,
      gridCount: 1,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 1, rows: 1, count: 1 },
      rightFill: { cols: 0, rows: 1, count: 0 },
      count: 2,
      totalCount: 2,
    });
    expect(withoutShrunk.deg0.utilization).toBeCloseTo(0.5416641187568089, 12);
    expect(withoutShrunk.deg90).toMatchObject({
      cols: 1,
      rows: 2,
      gridCount: 2,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 1, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 1, count: 0 },
      count: 2,
      totalCount: 2,
    });
    expect(withoutShrunk.deg90.utilization).toBeCloseTo(0.5416641187568089, 12);
  });
});
