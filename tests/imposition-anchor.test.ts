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

  it('25×35（635×889，usable 595×849）：新錨，獨立重導——0°=2×4=8（行縮：piece 251+3×strideY≈835.47≤849 容下 4 行，第 5 行 251+4×strideY≈1030.3>849 放不下）；90°=2×3=6、spacingAxis=null（這個紙規下收縮候選並非「沒有效果」，而是三案模數打平：矩形基線 251+2×254=759（2 欄）、列縮候選（cols 軸套用 shrunk.strideY≈194.825）251+2×194.825≈640.65 仍 >usableW=595 同樣只放得下 2 欄、行縮候選（RTE 無 strideX，rows 軸本來就沒有收縮能力，數字與矩形基線相同）三者 count 全部打平——平手選行縮（tie-break 預設值，見 core/imposition.ts pickRowShrink docblock「再平手取行縮」），但獲選軸（rows）沒有真收縮，因此如實回報 spacingAxis=null，不是「該欄未收縮」的另一種說法；2026-07 SOL review L1：原文誤述 tie-break 選列縮，方向與程式碼相反，已訂正）', () => {
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
// 真實最小距離 ≥ 取樣最小距離 − 2e（e 分別來自兩件各自的離散化誤差，三角不等式相加，
// 這裡的 2e 即下方 `errorBound`）。
//
// 斷言門檻＝`sampleDistance ≥ gap`（不是 `gap − errorBound`——2026-07 SOL review H1
// 抓出的方向錯誤）：若把門檻訂在 `gap − errorBound`，代入上一段的不等式會得到「真實最小
// 距離 ≥ gap − 2×errorBound」，比 spec 驗收 2 明文要求的「≥ gap −（誤差上界）」整整鬆了
// 一倍——`errorBound≈0.1002mm` 時，真實距離下探到 `2.7996mm`（已 <gap=3mm）仍會誤判
// 通過。改斷言 `sampleDistance ≥ gap`：代入「真實 ≥ 取樣 − errorBound」即得「真實
// ≥ gap − errorBound」，這才是 spec 字面要求的門檻。`errorBound` 本身仍然算出來、仍然
// 記錄在下面每個測試的註解裡（供讀者核對取樣密度是否夠細、判斷離散化本身是否可信），只是
// 不再被誤用去讓斷言門檻鬆一倍。DEG90/DEG0 grid×strip 這類「設計上恰好貼齊 gap」的案例
// （真實值恰好等於 gap）在 `sampleDistance ≥ gap` 這個門檻下依然通過（取樣值只會因誤差
// 略高於真實值，不會略低），不需要額外放寬。
// ─────────────────────────────────────────────────────────────────────────

interface Pt2D {
  x: number;
  y: number;
}

/** 統一取樣密度上限（mm）——line／bezier 直接控制弦長上界；arc 用同一個目標反解角步
 *  （見 discretizeArc）。0.1mm 遠小於刀模特徵尺度。RTE 案例真實最小距離 ≈3.8mm（≈0.8mm
 *  真實餘裕，0.1mm 遠小於這個餘裕，抽樣誤差不會製造假陽性）；但 Z-notch DEG0／DEG90
 *  grid×strip 案例（全枚舉後，見下方「間距不變式」describe block）真實全域最小距離恰＝gap
 *  （3mm，零餘裕——不是舊版誤測的 ≈10.44mm，那個數字來自只驗第 0 欄／第 0 件的單一件對，
 *  漏掉真正最緊的那一對，見 2026-07 SOL review H2）。這兩個案例沒有餘裕可言，正確性不能靠
 *  「取樣密度遠小於真實餘裕」這個論證，而是靠檔頭「誤差方向推論」的方向性保證（斷言門檻＝
 *  `sampleDistance ≥ gap`，見該段落）：取樣點集合是真實曲線的子集，取樣得到的最小距離只會
 *  因離散化誤差略高於真實最小距離，不會略低，所以即使真實值零餘裕貼齊 gap，這個門檻依然
 *  不會誤判通過一個真正低於 gap 的案例。效能上 RTE 單件離散化約 20000 點，配合下方
 *  minDistance 的排序+二分視窗剪枝，單次呼叫約 70-90ms（task-5-report.md 記錄了
 *  0.5/0.2/0.1/0.05/0.02/0.01mm 六級的實測時間/誤差權衡，0.1mm 是其中效能與誤差界都舒適
 *  的選擇）。 */
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

/** `bezier`：**獨立於 `core/geometry.ts` 既有 `flattenBezier` 的終止判準**（2026-07 SOL
 *  review M finding——原本這裡直接沿用共用的 `flattenBezier`：它的 `chordHeight()` 只採樣
 *  「曲線中點」`B(0.5)` 到弦（P0-P3 連線）的距離當判準，對多數曲線夠用，但對「控制點 P1/P2
 *  關於弦中點反對稱」的對稱 S 形曲線會被騙過——`B(0.5)=(P0+3P1+3P2+P3)/8`，反對稱項在這個
 *  加權平均下互相抵消，中點恰好落回弦上（高度＝0），即使曲線在其他 t 值大幅偏離弦。反例：
 *  `P0=(0,0) P1=(0,100) P2=(0.05,-100) P3=(0.05,0)`——弦長 0.05mm 遠小於 `maxSegLen`
 *  （0.1mm）不觸發長度分割，`chordHeight`=0 不觸發高度分割，`flattenBezier` 回傳「整條
 *  曲線＝1 條線段」，但曲線實際偏離該線段達數十 mm（見下方「S 形反例」測試的密集抽樣量測）
 *  ——宣稱的 `maxChordMM/2+chordTol≈0.0501mm` 誤差界對這類曲線完全不成立。
 *
 *  改用「控制多邊形到『有限弦段』的最大距離」（2026-07 SOL 窄 re-review M 第二輪 finding
 *  訂正後的版本——round-1 版本量到「無限延伸直線」，見下一段為何不夠）：曲線上任一點是
 *  `P0..P3` 的 Bernstein 凸組合，`P0`/`P3` 本身在弦段上（到弦段距離＝0），而「到一個凸集合
 *  的距離」本身是凸函式（標準結果：`d(·,S)` 對凸集合 `S` 是凸函式；弦段是兩點間的線段，
 *  凸集合），故曲線上任一點（= 該組控制點的 Bernstein 凸組合）到弦段的距離 ≤ 同一組
 *  Bernstein 權重對 `d(P0)`/`d(P1)`/`d(P2)`/`d(P3)` 的凸組合 ≤ `max(d(P1),d(P2))`
 *  （`d(P0)=d(P3)=0` 兩項不貢獻）——直接檢查兩個控制點本身到有限弦段的真實偏離，不是對
 *  曲線抽樣一個可能剛好騙過判準的單一點，S 形對稱造成的「抽樣點恰好歸零」問題不存在。深度
 *  上限命中時直接丟錯（不像 `core/geometry.ts` 的 `depth < MAX_FLATTEN_DEPTH` 讓超界的
 *  葉節點被靜默接受）——這裡在意的是「宣稱的誤差界是否真的成立」，靜默接受一個可能違反
 *  誤差界的葉節點會讓上面整套間距不變式失去意義。
 *
 *  **第二輪修正**（round-1 版本量到「無限延伸直線」而非有限弦段，被 2026-07 SOL 窄
 *  re-review 新反例打穿）：`P0=(0,0) P1=(100,0) P2=(-100,0) P3=(0.05,0)`——四個控制點
 *  的 y 座標全為 0，彼此共線（曲線因此整條都落在 `y=0` 上）。控制點到「無限直線 `y=0`」的
 *  垂直距離因此恆為 0（P1/P2 本身就在這條線上），即使它們的 x 座標（±100）遠遠超出弦段
 *  本身的範圍 `[0, 0.05]`；round-1 版 `controlPolygonHeight` 讀出 0、`segLen=0.05` 也
 *  小於 `maxSegLen`，判定「夠平」不細分。但真實曲線在 `t≈0.789` 附近回折到 `x≈-28.84`，
 *  遠遠偏出弦段範圍，到有限弦段最近端點的距離約 28.843mm，宣稱的誤差界完全不成立（見下方
 *  「SOL round-2 反例」測試的密集抽樣量測，以及本檔 M 驗紅記錄）。根源：「到無限直線的
 *  距離」只證得到「那條無限延伸直線」的偏離受控，證不到「題目真正在意的有限弦段」的偏離
 *  受控——兩者只有在控制點的垂足投影落在弦段範圍內時才相等，此反例故意讓投影落在弦段
 *  範圍外，兩個距離因此分道揚鑣；「到無限直線」的距離函式是仿射（affine）的特例、只是
 *  「到凸集合」這個更一般類別的其中一種，改量「到有限弦段」（上一段的凸集合論證，對任何
 *  凸集合都成立，不只是對直線這個特例）才是這個判準真正該檢查的量。 */
function distToChordSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (len * len)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function controlPolygonHeight(b: Extract<Segment, { kind: 'bezier' }>): number {
  const d1 = distToChordSegment(b.c1x, b.c1y, b.x1, b.y1, b.x2, b.y2);
  const d2 = distToChordSegment(b.c2x, b.c2y, b.x1, b.y1, b.x2, b.y2);
  return Math.max(d1, d2);
}

/** de Casteljau 對半分割——獨立重寫（不呼叫 `core/geometry.ts` 內部未 export 的
 *  `splitBezierAtMid`）。純代數對半分割（標準教科書算法，不是被驗證的 profile 近似手法
 *  本身），維持這條驗證路徑跟被驗證演算法零共用近似——同上方 arc 獨立重寫 sweep 方向計算
 *  的原則，現在 bezier 也一致。 */
function splitCubicAtMid(
  b: Extract<Segment, { kind: 'bezier' }>,
): { left: Extract<Segment, { kind: 'bezier' }>; right: Extract<Segment, { kind: 'bezier' }> } {
  const p0: Pt2D = { x: b.x1, y: b.y1 };
  const p1: Pt2D = { x: b.c1x, y: b.c1y };
  const p2: Pt2D = { x: b.c2x, y: b.c2y };
  const p3: Pt2D = { x: b.x2, y: b.y2 };
  const mid = (a: Pt2D, c: Pt2D): Pt2D => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123); // = 曲線在 t=0.5 的點
  return {
    left: { kind: 'bezier', x1: p0.x, y1: p0.y, c1x: p01.x, c1y: p01.y, c2x: p012.x, c2y: p012.y, x2: p0123.x, y2: p0123.y },
    right: { kind: 'bezier', x1: p0123.x, y1: p0123.y, c1x: p123.x, c1y: p123.y, c2x: p23.x, c2y: p23.y, x2: p3.x, y2: p3.y },
  };
}

/** 同 `core/geometry.ts` `MAX_FLATTEN_DEPTH`——純防護值，正常曲線與本檔用到的容差遠低於
 *  此深度就終止；`maxDepth` 參數化（預設仍是 24）供下方「深度上限命中時直接丟錯」測試用
 *  很小的 `maxDepth` 快速命中這條路徑，不需要真的遞迴 24 層。 */
const MAX_INDEPENDENT_FLATTEN_DEPTH = 24;

function flattenBezierIndependent(
  b: Extract<Segment, { kind: 'bezier' }>,
  chordTol: number,
  maxSegLen: number,
  depth = 0,
  maxDepth = MAX_INDEPENDENT_FLATTEN_DEPTH,
): Extract<Segment, { kind: 'line' }>[] {
  const segLen = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  const height = controlPolygonHeight(b);
  if (height > chordTol || segLen > maxSegLen) {
    if (depth >= maxDepth) {
      throw new Error(
        `flattenBezierIndependent：深度上限（${maxDepth}）命中但容差未滿足（controlPolygonHeight=${height}, segLen=${segLen}, chordTol=${chordTol}, maxSegLen=${maxSegLen}）——拒絕靜默接受一個可能違反誤差界的葉節點`,
      );
    }
    const { left, right } = splitCubicAtMid(b);
    return [
      ...flattenBezierIndependent(left, chordTol, maxSegLen, depth + 1, maxDepth),
      ...flattenBezierIndependent(right, chordTol, maxSegLen, depth + 1, maxDepth),
    ];
  }
  return [{ kind: 'line', x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }];
}

/** `chordTol` 取極小值，實際誤差由 `maxSegLen`（＝`maxChordMM`）主導，推理同 line；
 *  `pointErrorMM` 公式不變（`maxChordMM/2+chordTol`）——現在這個界對任何控制點形狀都真的
 *  成立（不再只是「通常成立、對稱 S 形例外」）。 */
function discretizeBezier(seg: Extract<Segment, { kind: 'bezier' }>, maxChordMM: number): { points: Pt2D[]; pointErrorMM: number } {
  const chordTol = 1e-4;
  const lines = flattenBezierIndependent(seg, chordTol, maxChordMM);
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
    // 斷言門檻＝gap（不是 gap-errorBound，見檔頭「誤差方向推論」2026-07 SOL review H1 訂正）。
    expect(observed).toBeGreaterThanOrEqual(gap);
    expect(observed).toBeCloseTo(3.8, 1); // 迴歸錨：真實最小距離的量級鎖定，抓未來意外變動（非本不變式斷言的必要部分）
  });

  it('Z-notch 正補排案例（POSITIVE_FILL_INPUT）DEG0：主格點邊界行（最後一行，全部欄）× 底條帶全部 instance 窮舉——收縮主格點×補排條帶的相鄰件對驗證幾何級間距（spec 驗收 2「擴展主格點×條帶件對」；2026-07 SOL review H2：原本只驗第 0 欄×第 0 件（10.44mm），獨立枚舉全部件對後整體最小值恰＝gap，見下方斷言與 report 附錄的完整枚舉記錄）', () => {
    const shrunk = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP);
    const result = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    assertOk(result);
    const deg0 = result.deg0;
    // 前提檢查：下面用到的 cols/rows/usedH/bottomFill 跟共用 fixture 權威值一致（T3 review Low
    // 同一紀律，防這裡跟 tests/imposition.test.ts／tests/imposition-preview.test.ts 各自維護
    // 一份、悄悄漂移）——這裡同時保證下面兩層迴圈非空（bottomFill.cols=2/rows=1、deg0.cols=8
    // 皆已鎖為正數，不會因為 fixture 改動讓迴圈悄悄變空、斷言在空集合上虛假通過）。
    expect(deg0).toMatchObject(Z_NOTCH_ANCHOR_DEG0);

    const mb = segmentsBounds(Z_NOTCH_SEGMENTS);
    const { points, maxPointErrorMM } = discretizePiece(Z_NOTCH_SEGMENTS, MAX_CHORD_MM);
    const errorBound = 2 * maxPointErrorMM;
    const gripper = POSITIVE_FILL_INPUT.gripper; // 0，僅為公式完整性保留，兩件共用同一個 gripper 不影響相對距離

    // 條帶內補排件固定用矩形 stride（spec F4「維持矩形」，見 core/imposition.ts pickFillSplit
    // docblock）；fillPieceForCols/fillPieceForRows 恆與主格點對調——deg0 呼叫時
    // pieceForCols=pieceW=50／pieceForRows=pieceH=200，對調後 fillPieceForCols=200（+gap=
    // 203＝條帶「cols」方向 stride）／fillPieceForRows=50（+gap=53＝條帶「rows」方向 stride）。
    const stripStrideCols = POSITIVE_FILL_INPUT.pieceH + Z_NOTCH_GAP;
    const stripStrideRows = POSITIVE_FILL_INPUT.pieceW + Z_NOTCH_GAP;

    // 主格點只需枚舉邊界行（r=rows-1，全部欄）：同欄內其餘行純粹是邊界行往上垂直平移
    // （translate 不改變 x），對固定 y 的底條帶而言恆更遠（平移量＝正的行 stride），邊界行
    // 是唯一可能貼近條帶的候選；但「欄」不能只驗 c=0——條帶橫跨整個可用寬度，哪一欄離哪個
    // 條帶 instance 最近沒有捷徑可省，必須逐欄枚舉（這正是原本只驗 c=0 漏掉 c=1 才是全域
    // 最小值的根因）。條帶側同理枚舉全部非零 instance（bottomFill.rows×cols）。
    let globalMin = Infinity;
    let globalMinAt = '';
    for (let c = 0; c < deg0.cols; c++) {
      const mainRow = localizeAndTranslate(points, mb, gripper + c * deg0.strideX, gripper + (deg0.rows - 1) * deg0.strideY);
      for (let sr = 0; sr < (deg0.bottomFill?.rows ?? 0); sr++) {
        for (let sc = 0; sc < (deg0.bottomFill?.cols ?? 0); sc++) {
          const stripInstance = rotate90AndTranslate(points, mb, gripper + sc * stripStrideCols, gripper + deg0.usedH + Z_NOTCH_GAP + sr * stripStrideRows);
          const d = minDistance(mainRow, stripInstance, PRUNE_WINDOW_MM);
          if (d < globalMin) {
            globalMin = d;
            globalMinAt = `main(c=${c}) × bottom(r=${sr},c=${sc})`;
          }
        }
      }
    }

    // 斷言門檻＝gap（見檔頭「誤差方向推論」2026-07 SOL review H1 訂正，同一修正也適用這裡；
    // errorBound 仍算出來供讀者核對取樣密度，不再用於鬆綁門檻）。
    expect(globalMin, `global min at ${globalMinAt}`).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
    // 全域最小值恰＝gap（3mm，不是舊版誤測的 10.44mm）——命中在 main(c=1)×bottom(r=0,c=0)
    // （task-5-report.md 附錄記錄完整枚舉數字＋mutation 驗紅）；這條邊界貼齊 gap 沒有多餘
    // 餘裕，digits=1 只鎖「差不多剛好=gap」這個事實，避免對浮點尾數過度脆弱。
    expect(globalMin).toBeCloseTo(3, 1);
  });

  it('Z-notch 正補排案例 DEG90：主格點邊界欄（最後一欄，全部行）× 右條帶全部 instance 窮舉——同一組輸入的另一方向，證明檢查邏輯不是只在 DEG0 湊巧成立（2026-07 SOL review H2：與 DEG0 同一缺陷，原本只驗第 0 行×第 0 件，獨立枚舉後全域最小值同樣恰＝gap，命中在不同的一組件對）', () => {
    const shrunk = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP);
    const result = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    assertOk(result);
    const deg90 = result.deg90;
    // 前提檢查：同 DEG0，順便保證 rightFill.cols=2/rows=2、deg90.rows=8 皆為正數，下面兩層
    // 迴圈非空。
    expect(deg90).toMatchObject(Z_NOTCH_ANCHOR_DEG90);

    const mb = segmentsBounds(Z_NOTCH_SEGMENTS);
    const { points, maxPointErrorMM } = discretizePiece(Z_NOTCH_SEGMENTS, MAX_CHORD_MM);
    const errorBound = 2 * maxPointErrorMM;
    const gripper = POSITIVE_FILL_INPUT.gripper;

    // deg90 呼叫時 pieceForCols=pieceH=200／pieceForRows=pieceW=50，補排對調後
    // fillPieceForCols=50（+gap=53＝條帶「cols」方向 stride）／fillPieceForRows=200
    // （+gap=203＝條帶「rows」方向 stride）——與 DEG0 恰好相反，見 pickFillSplit docblock。
    const stripStrideCols = POSITIVE_FILL_INPUT.pieceW + Z_NOTCH_GAP;
    const stripStrideRows = POSITIVE_FILL_INPUT.pieceH + Z_NOTCH_GAP;

    // 同 DEG0：主格點只需邊界欄（c=cols-1，全部行）；右條帶枚舉全部非零 instance
    // （rightFill.rows×cols）。
    let globalMin = Infinity;
    let globalMinAt = '';
    for (let r = 0; r < deg90.rows; r++) {
      const mainCol = rotate90AndTranslate(points, mb, gripper + (deg90.cols - 1) * deg90.strideX, gripper + r * deg90.strideY);
      for (let sr = 0; sr < (deg90.rightFill?.rows ?? 0); sr++) {
        for (let sc = 0; sc < (deg90.rightFill?.cols ?? 0); sc++) {
          const stripInstance = localizeAndTranslate(points, mb, gripper + deg90.usedW + Z_NOTCH_GAP + sc * stripStrideCols, gripper + sr * stripStrideRows);
          const d = minDistance(mainCol, stripInstance, PRUNE_WINDOW_MM);
          if (d < globalMin) {
            globalMin = d;
            globalMinAt = `main(r=${r}) × right(r=${sr},c=${sc})`;
          }
        }
      }
    }

    // 斷言門檻＝gap（同 DEG0／檔頭「誤差方向推論」2026-07 SOL review H1 訂正）。
    expect(globalMin, `global min at ${globalMinAt}`).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
    // 這組對恰好卡在 gap 邊界本身（task-5-report.md 記錄推導：strip 起點公式 usedW+gap 與
    // 主格點矩形右緣在這個方向剛好無多餘餘裕，不是誤差雜訊）——真實值＝gap，不是遠大於它；
    // digits=1 只鎖「差不多剛好=gap」這個事實，避免對浮點尾數過度脆弱。
    expect(globalMin).toBeCloseTo(3, 1);
  });
});

describe('discretizeBezier 的獨立控制多邊形終止判準（2026-07 SOL review M finding：core/geometry.ts flattenBezier 的中點抽樣判準可被對稱 S 形曲線騙過，本檔已改用不受此類曲線影響的判準，見上方 discretizeBezier 群組函式 docblock）', () => {
  it('對稱 S 形三次貝茲反例：flattenBezier（共用工具）回傳單一線段、宣稱誤差 0.0501mm 但真實偏離達數十 mm；discretizeBezier（本檔獨立判準）正確細分，密集抽樣驗證真實誤差確實落在宣稱界內', () => {
    // P0/P3 定弦（y=0 這條線）；P1/P2 關於弦中點 (chordLen/2, 0) 反對稱（y 分量正負相反、
    // x 分量對稱）——de Casteljau 中點 B(0.5)=(P0+3P1+3P2+P3)/8=(chordLen/2, 0)，反對稱項
    // 互相抵消，恰好落回弦上，見上方函式 docblock 的推導。
    const chordLen = 0.05; // 遠小於 MAX_CHORD_MM=0.1，長度判準本身不會觸發細分
    const bulge = 100; // 刻意誇張的橫向偏移，讓「中點恰好歸零」與「真實偏離」的落差無可忽視
    const sCurve: Extract<Segment, { kind: 'bezier' }> = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 0,
      c1y: bulge,
      c2x: chordLen,
      c2y: -bulge,
      x2: chordLen,
      y2: 0,
    };

    // 現象記錄（不是回歸測試 core/geometry.ts 本身——那個函式不在本 slice 修改範圍，這裡只
    // 記錄「為什麼本檔選擇不再依賴它」的具體證據）：中點抽樣判準＋長度判準都判定「夠平」，
    // 完全不細分。
    const sharedUtilityLines = flattenBezier(sCurve, 1e-4, MAX_CHORD_MM);
    expect(sharedUtilityLines).toHaveLength(1);
    expect(sharedUtilityLines[0]).toMatchObject({ x1: 0, y1: 0, x2: chordLen, y2: 0 });

    // 本檔獨立判準：控制多邊形高度＝100（遠超 chordTol=1e-4），正確強制細分（斷言 1：細分
    // 數量足夠——不是回傳 1 條線段就收工）。
    const { points, pointErrorMM } = discretizeBezier(sCurve, MAX_CHORD_MM);
    expect(points.length).toBeGreaterThan(100);

    // 密集抽樣真實貝茲曲線（獨立參數式公式，不呼叫 discretizeBezier/flattenBezierIndependent
    // 內部任何東西）驗證：任一真實曲線點到最近取樣頂點的距離確實 ≤ 宣稱的 pointErrorMM
    // （斷言 2：誤差真實受控，不是憑空宣稱——同 line/arc 的「到最近取樣點」誤差定義，見檔頭
    // 間距不變式驗證工具的說明）。
    let maxRealDeviation = 0;
    const SAMPLES = 5000;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const mt = 1 - t;
      const bx = mt ** 3 * sCurve.x1 + 3 * mt ** 2 * t * sCurve.c1x + 3 * mt * t ** 2 * sCurve.c2x + t ** 3 * sCurve.x2;
      const by = mt ** 3 * sCurve.y1 + 3 * mt ** 2 * t * sCurve.c1y + 3 * mt * t ** 2 * sCurve.c2y + t ** 3 * sCurve.y2;
      let nearest = Infinity;
      for (const p of points) {
        const d = Math.hypot(bx - p.x, by - p.y);
        if (d < nearest) nearest = d;
      }
      if (nearest > maxRealDeviation) maxRealDeviation = nearest;
    }
    expect(maxRealDeviation).toBeLessThanOrEqual(pointErrorMM);
  });

  it('flattenBezierIndependent 深度上限命中時直接丟錯，不靜默接受可能違反誤差界的葉節點（M finding 第二項要求；用不可能滿足的 chordTol=0 ＋極小 maxDepth 快速命中，不需要真的遞迴到 24 層）', () => {
    const curve: Extract<Segment, { kind: 'bezier' }> = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 1,
      c1y: 1,
      c2x: 2,
      c2y: -1,
      x2: 3,
      y2: 0,
    };
    expect(() => flattenBezierIndependent(curve, 0, 100, 0, 2)).toThrow(/深度上限/);

    // 對照：同一條曲線用真實使用的容差（chordTol=1e-4／maxSegLen=0.1／maxDepth=24 預設）
    // 不會撞上深度上限，正常路徑不受這條防線影響。
    expect(() => flattenBezierIndependent(curve, 1e-4, MAX_CHORD_MM)).not.toThrow();
  });

  it('SOL round-2 反例：控制點與弦共線但投影落在有限弦段外——到「無限直線」的距離讀出 0，到「有限弦段」的距離才讀出真實偏離（2026-07 SOL 窄 re-review M 第二輪 finding：round-1 版 controlPolygonHeight 用 distToChordLine 量控制點到「弦所在無限延伸直線」的垂直距離，這個反例的控制點恰好也在那條直線上，垂直距離恆為 0，即使控制點的座標遠遠超出弦段本身的範圍，判準也讀不出來，見下方函式 docblock「第二輪修正」段的完整推導）', () => {
    // P0/P3 定弦（y=0 這條線，弦長僅 0.05mm）；P1=(100,0)/P2=(-100,0) 的 y 分量也是 0——
    // 四個控制點的 y 座標全為 0，彼此共線，曲線因此整條都落在 y=0 上（貝茲曲線的 y(t) 是
    // 四個控制點 y 座標的 Bernstein 加權和，四個都是 0，加權和恆為 0）。控制點到「無限直線
    // y=0」的垂直距離因此恆為 0（P1/P2 本身就在這條線上）——但它們的 x 座標（±100）遠遠
    // 超出弦段本身的範圍 `[0, 0.05]`，到「有限弦段」的距離（端點外投影 clamp 到端點）其實
    // 很大：P1=(100,0) 投影超出 x2=0.05 這端，clamp 後距離＝100−0.05=99.95；P2=(-100,0)
    // 投影超出 x1=0 這端，clamp 後距離＝100。
    const chordLen = 0.05;
    const foldbackCurve: Extract<Segment, { kind: 'bezier' }> = {
      kind: 'bezier',
      x1: 0,
      y1: 0,
      c1x: 100,
      c1y: 0,
      c2x: -100,
      c2y: 0,
      x2: chordLen,
      y2: 0,
    };

    // 獨立參數式公式密集抽樣真實曲線（跟上方 S 形反例測試同一手法，不呼叫
    // discretizeBezier/flattenBezierIndependent/controlPolygonHeight 內部任何東西）——
    // 先確認「真實曲線到有限弦段 `[(0,0),(0.05,0)]` 的最大偏離」這個現象本身的量級，這是
    // 曲線的客觀事實，跟判準怎麼實作無關（斷言 1：量級證據，brief 記錄真實偏離 ≈28.843mm，
    // 命中在 t≈0.789 附近曲線回折到 x≈-28.84，遠遠偏出弦段範圍）。
    let maxDeviationFromFiniteChord = 0;
    const SAMPLES = 5000;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const mt = 1 - t;
      const bx = mt ** 3 * foldbackCurve.x1 + 3 * mt ** 2 * t * foldbackCurve.c1x + 3 * mt * t ** 2 * foldbackCurve.c2x + t ** 3 * foldbackCurve.x2;
      const by = mt ** 3 * foldbackCurve.y1 + 3 * mt ** 2 * t * foldbackCurve.c1y + 3 * mt * t ** 2 * foldbackCurve.c2y + t ** 3 * foldbackCurve.y2;
      const clampedX = Math.min(chordLen, Math.max(0, bx)); // by 恆為 0，最近弦段點的 y 分量恆為 0
      const d = Math.hypot(bx - clampedX, by);
      if (d > maxDeviationFromFiniteChord) maxDeviationFromFiniteChord = d;
    }
    expect(maxDeviationFromFiniteChord).toBeGreaterThan(25); // 量級證據：真實偏離達數十 mm，不是雜訊

    // 斷言 2（真正鑑別新舊判準的斷言）：discretizeBezier 必須正確細分這條曲線，使得任一
    // 真實曲線點到最近取樣頂點的距離確實 ≤ 宣稱的 pointErrorMM——同上方 S 形反例測試「斷言
    // 1：細分數量足夠」＋「斷言 2：誤差真實受控」兩件事一起驗。round-1 版（到無限直線的
    // 距離）在這個反例上 controlPolygonHeight 讀出 0、segLen=0.05<maxSegLen 也不觸發，
    // 完全不細分，這裡會紅（見 report「M 驗紅」附的實際失敗輸出）；round-2 版（到有限弦段
    // 的距離）讀出 max(99.95,100)=100，正確觸發細分，這裡才會綠。
    const { points, pointErrorMM } = discretizeBezier(foldbackCurve, MAX_CHORD_MM);
    expect(points.length).toBeGreaterThan(100);

    let maxRealDeviation = 0;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const mt = 1 - t;
      const bx = mt ** 3 * foldbackCurve.x1 + 3 * mt ** 2 * t * foldbackCurve.c1x + 3 * mt * t ** 2 * foldbackCurve.c2x + t ** 3 * foldbackCurve.x2;
      const by = mt ** 3 * foldbackCurve.y1 + 3 * mt ** 2 * t * foldbackCurve.c1y + 3 * mt * t ** 2 * foldbackCurve.c2y + t ** 3 * foldbackCurve.y2;
      let nearest = Infinity;
      for (const p of points) {
        const d = Math.hypot(bx - p.x, by - p.y);
        if (d < nearest) nearest = d;
      }
      if (nearest > maxRealDeviation) maxRealDeviation = nearest;
    }
    expect(maxRealDeviation).toBeLessThanOrEqual(pointErrorMM);
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
    expect(withoutShrunk.deg0.utilization).toBe(0.5399715809633642); // 逐位元精確值，非只是數值接近（2026-07 SOL review L2）
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
    expect(withoutShrunk.deg90.utilization).toBe(0.5399715809633642); // 逐位元精確值，非只是數值接近（2026-07 SOL review L2）
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
    expect(withoutShrunk.deg0.utilization).toBe(0.5416641187568089); // 逐位元精確值，非只是數值接近（2026-07 SOL review L2）
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
    expect(withoutShrunk.deg90.utilization).toBe(0.5416641187568089); // 逐位元精確值，非只是數值接近（2026-07 SOL review L2）
  });
});
