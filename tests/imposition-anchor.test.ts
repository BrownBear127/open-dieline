import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { manufacturingBounds } from '@/core/bounds';
import { resolveParams } from '@/core/registry';
import { computeImposition } from '@/core/imposition';
import type { ImpositionInput, ImpositionResult } from '@/core/imposition';

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

    // 正確路徑：製造 bounds → 12/8 模（spec 驗收條件 1 數值錨）
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
