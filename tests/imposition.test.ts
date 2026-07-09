import { describe, expect, it } from 'vitest';
import {
  computeImposition,
  fitCount,
  resolveWorkingSheet,
  PAPER_PRESETS,
  FIT_EPSILON_MM,
  MAX_PREVIEW_INSTANCES,
  MIN_GAP_MM,
  MIN_DIMENSION_MM,
  MAX_DIMENSION_MM,
} from '@/core/imposition';
import type { ImpositionFieldError, ImpositionInput, ImpositionResult, SheetMode, SheetOrientation } from '@/core/imposition';

// 純函式測試——只吃/吐數字，不碰 boxes/*、manufacturingBounds（那是 imposition-anchor.test.ts
// 的整合錨職責，見 task-2-brief 介面說明「Consumes: manufacturingBounds（僅整合測試消費；
// 純函式只吃數字）」）。

/** ok:true 窄化＋失敗時把 errors 印進錯誤訊息，方便測試失敗時直接看到原因。 */
function assertOk(result: ImpositionResult): asserts result is Extract<ImpositionResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`預期 ok:true，但收到 errors：${JSON.stringify(result.errors)}`);
  }
}

// 數值錨的基準輸入（brief 驗收條件 1）：RTE 預設參數的製造 bounds 233.2×251，
// 31"×43" 直放整紙、咬口 20、gap 3。
const BASE_INPUT: ImpositionInput = {
  pieceW: 233.2,
  pieceH: 251,
  paperW: 787,
  paperH: 1092,
  orientation: 'portrait',
  mode: 'full',
  gripper: 20,
  gap: 3,
};

describe('具名常數', () => {
  it('PAPER_PRESETS：三種常用紙規（787×1092／635×889／686×991），id 唯一', () => {
    expect(PAPER_PRESETS).toHaveLength(3);
    const pairs = PAPER_PRESETS.map((p) => [p.w, p.h]);
    expect(pairs).toContainEqual([787, 1092]);
    expect(pairs).toContainEqual([635, 889]);
    expect(pairs).toContainEqual([686, 991]);
    expect(new Set(PAPER_PRESETS.map((p) => p.id)).size).toBe(3);
    for (const preset of PAPER_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it('FIT_EPSILON_MM／MIN_GAP_MM／MAX_PREVIEW_INSTANCES 數值', () => {
    expect(FIT_EPSILON_MM).toBe(1e-6);
    expect(MIN_GAP_MM).toBe(3);
    expect(MAX_PREVIEW_INSTANCES).toBe(500);
  });
});

describe('resolveWorkingSheet', () => {
  it('landscape：787×1092 來源 → w=較大邊(1092)，h=較小邊(787)', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'landscape', 'full', 20);
    expect(sheet.w).toBe(1092);
    expect(sheet.h).toBe(787);
    expect(sheet.usableW).toBe(1052);
    expect(sheet.usableH).toBe(747);
  });

  it('portrait：787×1092 來源已是直放形狀 → w=較小邊(787)，h=較大邊(1092)（identity）', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'portrait', 'full', 20);
    expect(sheet.w).toBe(787);
    expect(sheet.h).toBe(1092);
    expect(sheet.usableW).toBe(747);
    expect(sheet.usableH).toBe(1052);
  });

  it('portrait：來源本身是橫放形狀（1200×800）時仍正規化成 w=較小邊、h=較大邊', () => {
    const sheet = resolveWorkingSheet(1200, 800, 'portrait', 'full', 0);
    expect(sheet.w).toBe(800);
    expect(sheet.h).toBe(1200);
  });

  it('landscape：來源本身是直放形狀（800×1200）時正規化成 w=較大邊、h=較小邊', () => {
    const sheet = resolveWorkingSheet(800, 1200, 'landscape', 'full', 0);
    expect(sheet.w).toBe(1200);
    expect(sheet.h).toBe(800);
  });

  it('halfV 對「方向處理後」的 w 取半；halfH 對 h 取半', () => {
    const halfV = resolveWorkingSheet(787, 1092, 'portrait', 'halfV', 0);
    expect(halfV.w).toBe(393.5);
    expect(halfV.h).toBe(1092);

    const halfH = resolveWorkingSheet(787, 1092, 'portrait', 'halfH', 0);
    expect(halfH.w).toBe(787);
    expect(halfH.h).toBe(546);
  });

  it('咬口過大時可用區 clamp 至 0（不是負數）——合法輸入，非 domain 錯誤', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'portrait', 'full', 500);
    expect(sheet.usableW).toBe(0); // 787-1000=-213 → clamp 0
    expect(sheet.usableH).toBe(92); // 1092-1000=92，未觸底
  });
});

describe('fitCount', () => {
  it('exact fit：件寬 30、gap 3.1、available 228.6 → 7 件（浮點除法算出 6.999...，需 footprint 修正）', () => {
    expect(fitCount(228.6, 30, 3.1)).toBe(7);
  });

  it('略小於 exact fit（−1e-3）→ 少一件（6）', () => {
    expect(fitCount(228.6 - 1e-3, 30, 3.1)).toBe(6);
  });

  it('略大於 exact fit（+1e-3）→ 仍 7 件（不因浮點雜訊誤判超額而多算）', () => {
    expect(fitCount(228.6 + 1e-3, 30, 3.1)).toBe(7);
  });

  it('available 或 piece 非正 → 0（不進入 footprint 判準）', () => {
    expect(fitCount(0, 30, 3)).toBe(0);
    expect(fitCount(-10, 30, 3)).toBe(0);
    expect(fitCount(100, 0, 3)).toBe(0);
    expect(fitCount(100, -5, 3)).toBe(0);
  });

  it('gap=0 也能正確計算（gap 本身的合法性由 computeImposition 的 domain 驗證把關，fitCount 本身不擋）', () => {
    // 10 件 100mm 寬、gap=0、available=1000 → 恰好 10 件（無間距）
    expect(fitCount(1000, 100, 0)).toBe(10);
  });
});

describe('computeImposition — 數值錨（expected 硬編碼，brief 驗收條件 1）', () => {
  it('RTE 製造 bounds 233.2×251、31"×43" 直放整紙、咬口 20、gap 3 → deg0 12 模、deg90 8 模', () => {
    const result = computeImposition(BASE_INPUT);
    assertOk(result);

    expect(result.sheet).toEqual({ w: 787, h: 1092, usableW: 747, usableH: 1052 });

    expect(result.deg0).toMatchObject({ cols: 3, rows: 4, count: 12 });
    expect(result.deg0.utilization).toBeCloseTo(0.8173, 4);

    expect(result.deg90).toMatchObject({ cols: 2, rows: 4, count: 8 });
    expect(result.deg90.utilization).toBeCloseTo(0.5449, 4);
  });
});

describe('computeImposition — deg90 對稱性質（隨機十組，seed 固定可重現）', () => {
  // 簡易 LCG（Numerical Recipes 常數）：固定 seed 讓「隨機」測試可重現，避免 CI 偶發 flaky。
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const rng = makeRng(20260710);
  const between = (min: number, max: number) => min + rng() * (max - min);

  // review F4：LCG 只生成連續數值，不適合拿來抽 orientation/mode 這種離散類別——固定 seed
  // 下十組實際落點曾只覆蓋 3/6 種組合（portrait/landscape × full/halfV/halfH）、且 full
  // 分支完全缺席。改為分層／循環指定：ORIENTATIONS × MODES 的笛卡兒積固定排出 6 組合，
  // 10 組案例依索引 `i % 6` 循環取用，保證 6 種組合每種至少出現一次（i=0..5 各出現一次，
  // i=6..9 再覆蓋前 4 種各一次）；連續數值（pieceW/pieceH/paperW/paperH/gripper/gap）
  // 仍全部交給 LCG，可重現性不變。
  const ORIENTATIONS: readonly SheetOrientation[] = ['portrait', 'landscape'];
  const MODES: readonly SheetMode[] = ['full', 'halfV', 'halfH'];
  const COMBOS: ReadonlyArray<{ orientation: SheetOrientation; mode: SheetMode }> = ORIENTATIONS.flatMap((orientation) =>
    MODES.map((mode) => ({ orientation, mode })),
  );

  const randomCases = Array.from({ length: 10 }, (_, i) => {
    const combo = COMBOS[i % COMBOS.length]!;
    const input: ImpositionInput = {
      pieceW: between(20, 150),
      pieceH: between(20, 150),
      paperW: between(400, 1200),
      paperH: between(400, 1200),
      orientation: combo.orientation,
      mode: combo.mode,
      gripper: between(0, 30),
      gap: between(3, 10),
    };
    return { i, input };
  });

  it('十組案例的 orientation×mode 分層覆蓋六種組合（覆蓋率斷言，防止分層邏輯本身跟著退化）', () => {
    const covered = new Set(randomCases.map(({ input }) => `${input.orientation}:${input.mode}`));
    expect(covered.size).toBe(6);
  });

  it.each(randomCases)('第 $i 組（$input.orientation×$input.mode）：deg90 等於 pieceW/pieceH 互換後的 deg0', ({ input }) => {
    const swapped: ImpositionInput = { ...input, pieceW: input.pieceH, pieceH: input.pieceW };

    const result = computeImposition(input);
    const swappedResult = computeImposition(swapped);
    assertOk(result);
    assertOk(swappedResult);

    expect(result.deg90).toEqual(swappedResult.deg0);
  });
});

describe('computeImposition — 對開等式（halfV/halfH＝以「方向處理後」尺寸為整紙的計算）', () => {
  it('halfV：working w 為 full 模式 oriented w 的一半，h 與可用區高不變', () => {
    const full = computeImposition({ ...BASE_INPUT, mode: 'full' });
    const halfV = computeImposition({ ...BASE_INPUT, mode: 'halfV' });
    assertOk(full);
    assertOk(halfV);

    expect(halfV.sheet.w).toBeCloseTo(full.sheet.w / 2, 6);
    expect(halfV.sheet.h).toBe(full.sheet.h);
    expect(halfV.sheet.usableW).toBeCloseTo(full.sheet.w / 2 - 2 * BASE_INPUT.gripper, 6);
    expect(halfV.sheet.usableH).toBe(full.sheet.usableH);
  });

  it('halfH：working h 為 full 模式 oriented h 的一半，w 與可用區寬不變', () => {
    const full = computeImposition({ ...BASE_INPUT, mode: 'full' });
    const halfH = computeImposition({ ...BASE_INPUT, mode: 'halfH' });
    assertOk(full);
    assertOk(halfH);

    expect(halfH.sheet.h).toBeCloseTo(full.sheet.h / 2, 6);
    expect(halfH.sheet.w).toBe(full.sheet.w);
    expect(halfH.sheet.usableH).toBeCloseTo(full.sheet.h / 2 - 2 * BASE_INPUT.gripper, 6);
    expect(halfH.sheet.usableW).toBe(full.sheet.usableW);
  });

  // review F3：上面兩測試只證明 sheet 尺寸／可用區取半，沒有證明拼版「結果」（cols/rows/
  // count/utilization）等價——若未來計算誤用 full sheet 但 sheet 欄位本身仍正確，上面兩測試
  // 不會發現。這裡直接對 deg0/deg90 完整結果 hardcode expected（不透過二次呼叫
  // resolveWorkingSheet 比較，避免二次 orientation 交換的歧義，見 task-2-report.md 決策 6）。
  // 手算基準：BASE_INPUT piece=233.2×251、gripper=20、gap=3。
  it('halfV：deg0/deg90 完整結果（cols/rows/count/utilization）硬編碼', () => {
    // halfV sheet=393.5×1092，usable=353.5×1052（usableH 與 full 模式相同，halfV 只砍 w）。
    // deg0（pieceForCols=233.2, pieceForRows=251）：
    //   cols：1 件 footprint=233.2≤353.5；2 件=2×233.2+1×3=469.4>353.5，cols=1
    //   rows：與 full 模式 deg0 相同（usableH、pieceForRows 均未變）＝4；count=1×4=4
    //   utilization=4×233.2×251÷(393.5×1092)=4×58533.2÷429702=234132.8÷429702=0.544872...→0.5449
    // deg90（pieceForCols=251, pieceForRows=233.2）：
    //   cols：1 件=251≤353.5；2 件=2×251+1×3=505>353.5，cols=1
    //   rows：4 件=4×233.2+3×3=932.8+9=941.8≤1052；5 件=5×233.2+4×3=1166+12=1178>1052，rows=4
    //   count=1×4=4；utilization=4×251×233.2÷429702＝同上分子分母＝0.5449
    //   （deg0/deg90 數值相同純屬本案例 cols/rows 恰好都算出 1×4，非公式錯誤——
    //   分子分母來自同一個 piece 面積與 sheet 面積，只要 count 相同 utilization 必相同）
    const result = computeImposition({ ...BASE_INPUT, mode: 'halfV' });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 1, rows: 4, count: 4 });
    expect(result.deg0.utilization).toBeCloseTo(0.5449, 4);
    expect(result.deg90).toMatchObject({ cols: 1, rows: 4, count: 4 });
    expect(result.deg90.utilization).toBeCloseTo(0.5449, 4);
  });

  it('halfH：deg0/deg90 完整結果（cols/rows/count/utilization）硬編碼', () => {
    // halfH sheet=787×546，usable=747×506（usableW 與 full 模式相同，halfH 只砍 h）。
    // deg0（pieceForCols=233.2, pieceForRows=251）：
    //   cols：與 full 模式 deg0 相同（usableW 未變）＝3
    //   rows：2 件=2×251+1×3=502+3=505≤506；3 件=3×251+2×3=753+6=759>506，rows=2
    //   count=3×2=6；utilization=6×233.2×251÷(787×546)=6×58533.2÷429702=351199.2÷429702=0.817309...→0.8173
    // deg90（pieceForCols=251, pieceForRows=233.2）：
    //   cols：與 full 模式 deg90 相同（usableW 未變）＝2
    //   rows：2 件=2×233.2+1×3=466.4+3=469.4≤506；3 件=3×233.2+2×3=699.6+6=705.6>506，rows=2
    //   count=2×2=4；utilization=4×251×233.2÷429702=234132.8÷429702=0.544872...→0.5449
    const result = computeImposition({ ...BASE_INPUT, mode: 'halfH' });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 3, rows: 2, count: 6 });
    expect(result.deg0.utilization).toBeCloseTo(0.8173, 4);
    expect(result.deg90).toMatchObject({ cols: 2, rows: 2, count: 4 });
    expect(result.deg90.utilization).toBeCloseTo(0.5449, 4);
  });
});

describe('computeImposition — 計算矩陣（portrait/landscape × full/halfV/halfH 六組合）', () => {
  // 手算基準（見 task-2-report.md 手算過程／review 手算抽驗，cols/rows/count 已驗證）：
  // paperW=787,paperH=1092／piece 100×140／咬口 20／gap 3。expected 由 resolveWorkingSheet
  // 轉換鏈＋fitCount 公式手算，不得由被測函式導出（防自我循環）。
  //
  // utilization 手算（review F2 新增）：working sheet 面積固定兩種——full 模式
  // 787×1092＝859404；halfV/halfH 砍其中一邊得一半＝429702（halfV：393.5×1092＝429702；
  // halfH：787×546＝429702，兩者剛好都是 859404 的一半）。piece 面積固定
  // 100×140＝14000（deg0/deg90 的 pieceForCols×pieceForRows 乘積相同，跟方向無關）。
  // utilization＝count×14000÷working面積：
  //   portrait×full   deg0 49×14000=686000÷859404=0.798227...→0.7982
  //                   deg90 50×14000=700000÷859404=0.814517...→0.8145
  //   portrait×halfV  deg0 21×14000=294000÷429702=0.684195...→0.6842
  //                   deg90 20×14000=280000÷429702=0.651614...→0.6516
  //   portrait×halfH  deg0 21×14000=294000÷429702=0.684195...→0.6842（面積同 halfV：787×546=429702）
  //                   deg90 20×14000=280000÷429702=0.651614...→0.6516
  //   landscape×full  deg0 50×14000=700000÷859404=0.814517...→0.8145（跟 portrait×full 的
  //                   deg90 同值——同一組 cols/rows 換到另一方向，count 相同）
  //                   deg90 49×14000=686000÷859404=0.798227...→0.7982
  //   landscape×halfV deg0 20×14000=280000÷429702=0.651614...→0.6516
  //                   deg90 21×14000=294000÷429702=0.684195...→0.6842
  //   landscape×halfH deg0 20×14000=280000÷429702=0.651614...→0.6516
  //                   deg90 21×14000=294000÷429702=0.684195...→0.6842
  const piece = { pieceW: 100, pieceH: 140 };
  const commonFields = { paperW: 787, paperH: 1092, gripper: 20, gap: 3 };

  const cases: Array<{
    orientation: SheetOrientation;
    mode: SheetMode;
    deg0: { cols: number; rows: number; count: number; utilization: number };
    deg90: { cols: number; rows: number; count: number; utilization: number };
  }> = [
    {
      orientation: 'portrait',
      mode: 'full',
      deg0: { cols: 7, rows: 7, count: 49, utilization: 0.7982 },
      deg90: { cols: 5, rows: 10, count: 50, utilization: 0.8145 },
    },
    {
      orientation: 'portrait',
      mode: 'halfV',
      deg0: { cols: 3, rows: 7, count: 21, utilization: 0.6842 },
      deg90: { cols: 2, rows: 10, count: 20, utilization: 0.6516 },
    },
    {
      orientation: 'portrait',
      mode: 'halfH',
      deg0: { cols: 7, rows: 3, count: 21, utilization: 0.6842 },
      deg90: { cols: 5, rows: 4, count: 20, utilization: 0.6516 },
    },
    {
      orientation: 'landscape',
      mode: 'full',
      deg0: { cols: 10, rows: 5, count: 50, utilization: 0.8145 },
      deg90: { cols: 7, rows: 7, count: 49, utilization: 0.7982 },
    },
    {
      orientation: 'landscape',
      mode: 'halfV',
      deg0: { cols: 4, rows: 5, count: 20, utilization: 0.6516 },
      deg90: { cols: 3, rows: 7, count: 21, utilization: 0.6842 },
    },
    {
      orientation: 'landscape',
      mode: 'halfH',
      deg0: { cols: 10, rows: 2, count: 20, utilization: 0.6516 },
      deg90: { cols: 7, rows: 3, count: 21, utilization: 0.6842 },
    },
  ];

  it.each(cases)('$orientation × $mode', ({ orientation, mode, deg0, deg90 }) => {
    const result = computeImposition({ ...piece, ...commonFields, orientation, mode });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: deg0.cols, rows: deg0.rows, count: deg0.count });
    expect(result.deg0.utilization).toBeCloseTo(deg0.utilization, 4);
    expect(result.deg90).toMatchObject({ cols: deg90.cols, rows: deg90.rows, count: deg90.count });
    expect(result.deg90.utilization).toBeCloseTo(deg90.utilization, 4);
  });

  it('三個 preset 各驗一個實際案例（787×1092 已於上方六組合覆蓋，這裡補 635×889／686×991，兩方向完整結果）', () => {
    // 635×889：usable=595×849（635-40=595, 889-40=849）。
    // deg0：cols=fitCount(595,100,3)=5（5×100+4×3=512≤595；6×100+5×3=615>595）
    //       rows=fitCount(849,140,3)=5（5×140+4×3=712≤849；6×140+5×3=855>849）；count=25
    //       utilization=25×100×140÷(635×889)=25×14000÷564515=350000÷564515=0.620001...→0.6200
    // deg90：cols=fitCount(595,140,3)=4（4×140+3×3=569≤595；5×140+4×3=712>595）
    //        rows=fitCount(849,100,3)=8（8×100+7×3=821≤849；9×100+8×3=924>849）；count=32
    //        utilization=32×14000÷564515=448000÷564515=0.793602...→0.7936
    const r635 = computeImposition({ ...piece, paperW: 635, paperH: 889, gripper: 20, gap: 3, orientation: 'portrait', mode: 'full' });
    assertOk(r635);
    expect(r635.deg0).toMatchObject({ cols: 5, rows: 5, count: 25 });
    expect(r635.deg0.utilization).toBeCloseTo(0.62, 4);
    expect(r635.deg90).toMatchObject({ cols: 4, rows: 8, count: 32 });
    expect(r635.deg90.utilization).toBeCloseTo(0.7936, 4);

    // 686×991：usable=646×951（686-40=646, 991-40=951）。
    // deg0：cols=fitCount(646,100,3)=6（6×100+5×3=615≤646；7×100+6×3=718>646）
    //       rows=fitCount(951,140,3)=6（6×140+5×3=855≤951；7×140+6×3=998>951）；count=36
    //       utilization=36×14000÷679826=504000÷679826=0.741366...→0.7414
    // deg90：cols=fitCount(646,140,3)=4（4×140+3×3=569≤646；5×140+4×3=712>646）
    //        rows=fitCount(951,100,3)=9（9×100+8×3=924≤951；10×100+9×3=1027>951）；count=36
    //        utilization=36×14000÷679826=0.741366...→0.7414（跟 deg0 同值——count 剛好相同，非錯誤）
    const r686 = computeImposition({ ...piece, paperW: 686, paperH: 991, gripper: 20, gap: 3, orientation: 'portrait', mode: 'full' });
    assertOk(r686);
    expect(r686.deg0).toMatchObject({ cols: 6, rows: 6, count: 36 });
    expect(r686.deg0.utilization).toBeCloseTo(0.7414, 4);
    expect(r686.deg90).toMatchObject({ cols: 4, rows: 9, count: 36 });
    expect(r686.deg90.utilization).toBeCloseTo(0.7414, 4);
  });

  it('自訂紙規（非 preset 尺寸，review F2）：1000×800、landscape、full，兩方向完整結果', () => {
    // 自訂紙規 1000×800（不在 PAPER_PRESETS 內）。orientation=landscape：longSide=1000
    // 已是較大邊，identity 轉換，w=1000,h=800。usable=1000-40=960×800-40=760。
    // deg0（pieceForCols=100,pieceForRows=140）：
    //   cols=fitCount(960,100,3)=9（9×100+8×3=924≤960；10×100+9×3=1027>960）
    //   rows=fitCount(760,140,3)=5（5×140+4×3=712≤760；6×140+5×3=855>760）；count=45
    //   utilization=45×14000÷(1000×800)=630000÷800000=0.7875（整除，非近似）
    // deg90（pieceForCols=140,pieceForRows=100）：
    //   cols=fitCount(960,140,3)=6（6×140+5×3=855≤960；7×140+6×3=998>960）
    //   rows=fitCount(760,100,3)=7（7×100+6×3=718≤760；8×100+7×3=821>760）；count=42
    //   utilization=42×14000÷800000=588000÷800000=0.735（整除，非近似）
    const custom = computeImposition({
      ...piece,
      paperW: 1000,
      paperH: 800,
      gripper: 20,
      gap: 3,
      orientation: 'landscape',
      mode: 'full',
    });
    assertOk(custom);
    expect(custom.sheet).toEqual({ w: 1000, h: 800, usableW: 960, usableH: 760 });
    expect(custom.deg0).toMatchObject({ cols: 9, rows: 5, count: 45 });
    expect(custom.deg0.utilization).toBeCloseTo(0.7875, 4);
    expect(custom.deg90).toMatchObject({ cols: 6, rows: 7, count: 42 });
    expect(custom.deg90.utilization).toBeCloseTo(0.735, 4);
  });
});

describe('computeImposition — 輸入 domain', () => {
  it('gap:2.9 → below-min（表廠硬下限，不是「非正」——domain 表 F3 的具體例子）', () => {
    const result = computeImposition({ ...BASE_INPUT, gap: 2.9 });
    expect(result).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'below-min' }] });
  });

  type PositiveField = 'pieceW' | 'pieceH' | 'paperW' | 'paperH';
  const positiveFields: readonly PositiveField[] = ['pieceW', 'pieceH', 'paperW', 'paperH'];

  function withField(field: PositiveField, value: number): ImpositionInput {
    return { ...BASE_INPUT, [field]: value };
  }

  describe.each(positiveFields)('%s（finite 且 > 0）', (field) => {
    it('NaN → not-finite', () => {
      expect(computeImposition(withField(field, NaN))).toEqual({ ok: false, errors: [{ field, reason: 'not-finite' }] });
    });
    it('Infinity → not-finite', () => {
      expect(computeImposition(withField(field, Infinity))).toEqual({ ok: false, errors: [{ field, reason: 'not-finite' }] });
    });
    it('0 → not-positive', () => {
      expect(computeImposition(withField(field, 0))).toEqual({ ok: false, errors: [{ field, reason: 'not-positive' }] });
    });
    it('負值 → not-positive', () => {
      expect(computeImposition(withField(field, -10))).toEqual({ ok: false, errors: [{ field, reason: 'not-positive' }] });
    });
  });

  describe('gap（非正也歸 below-min——MIN_GAP_MM=3 已涵蓋「非正」情況，不另立 not-positive）', () => {
    it('NaN → not-finite', () => {
      expect(computeImposition({ ...BASE_INPUT, gap: NaN })).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'not-finite' }] });
    });
    it('Infinity → not-finite', () => {
      expect(computeImposition({ ...BASE_INPUT, gap: Infinity })).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'not-finite' }] });
    });
    it('0 → below-min', () => {
      expect(computeImposition({ ...BASE_INPUT, gap: 0 })).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'below-min' }] });
    });
    it('負值 → below-min', () => {
      expect(computeImposition({ ...BASE_INPUT, gap: -5 })).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'below-min' }] });
    });
  });

  describe('gripper（finite 且 ≥ 0——0 合法，跟 paper*/piece* 的「必須 > 0」不同）', () => {
    it('NaN → not-finite', () => {
      expect(computeImposition({ ...BASE_INPUT, gripper: NaN })).toEqual({ ok: false, errors: [{ field: 'gripper', reason: 'not-finite' }] });
    });
    it('Infinity → not-finite', () => {
      expect(computeImposition({ ...BASE_INPUT, gripper: Infinity })).toEqual({
        ok: false,
        errors: [{ field: 'gripper', reason: 'not-finite' }],
      });
    });
    it('0 → 合法（ok:true），可用區等於未扣咬口的整張尺寸', () => {
      const result = computeImposition({ ...BASE_INPUT, gripper: 0 });
      assertOk(result);
      expect(result.sheet.usableW).toBe(result.sheet.w);
      expect(result.sheet.usableH).toBe(result.sheet.h);
    });
    it('負值 → not-positive', () => {
      expect(computeImposition({ ...BASE_INPUT, gripper: -5 })).toEqual({
        ok: false,
        errors: [{ field: 'gripper', reason: 'not-positive' }],
      });
    });

    it('過大（400，可用區 ≤ 0）→ 合法非錯誤，兩方向 count／utilization 皆 0（放不下，不是輸入錯誤）', () => {
      const result = computeImposition({ ...BASE_INPUT, gripper: 400 });
      assertOk(result);
      expect(result.sheet.usableW).toBe(0); // 787-800=-13 → clamp 0
      expect(result.deg0.count).toBe(0);
      expect(result.deg90.count).toBe(0);
      expect(result.deg0.utilization).toBe(0);
      expect(result.deg90.utilization).toBe(0);
    });
  });

  it('多欄同時無效 → 逐欄收集全部 errors（不是找到第一個就停）', () => {
    const result = computeImposition({ ...BASE_INPUT, paperW: NaN, gap: 1, gripper: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const asSet = new Set(result.errors.map((e) => `${e.field}:${e.reason}`));
      expect(asSet).toEqual(new Set(['paperW:not-finite', 'gap:below-min', 'gripper:not-positive']));
      expect(result.errors).toHaveLength(3);
    }
  });

  // review F5：目前只測「咬口過大 → 兩方向同時 0」，未鎖住「單一方向放不下、另一方向
  // 正常」的驗收條件（spec 驗收條件 5）。用細長件證明：pieceW=800（比 usableW=747 寬，
  // 0° 方向該軸放不下）、pieceH=50（很窄，90° 旋轉後放得下）。
  it('單一方向放不下、另一方向正常計算：長窄件 800×50（0° 該方向放不下→count 0；90° 正常）', () => {
    // 沿用 BASE_INPUT 的紙規/gripper/gap（787×1092、咬口20、gap3）→ usable=747×1052。
    // deg0（pieceForCols=800, pieceForRows=50）：
    //   cols=fitCount(747,800,3)：1 件 footprint=800>747，放不下 → cols=0
    //   rows=fitCount(1052,50,3)=19（19×50+18×3=950+54=1004≤1052；20×50+19×3=1000+57=1057>1052）
    //   count=cols×rows=0×19=0（任一向 0 → 該方向 N=0，即使 rows 本身算出非零）；utilization=0
    // deg90（pieceForCols=50, pieceForRows=800）：
    //   cols=fitCount(747,50,3)=14（14×50+13×3=700+39=739≤747；15×50+14×3=750+42=792>747）
    //   rows=fitCount(1052,800,3)：1 件=800≤1052；2 件=2×800+1×3=1603>1052 → rows=1
    //   count=14×1=14（正常、非零）
    //   utilization=14×50×800÷(787×1092)=14×40000÷859404=560000÷859404=0.651614...→0.6516
    const input: ImpositionInput = { ...BASE_INPUT, pieceW: 800, pieceH: 50 };
    const result = computeImposition(input);
    assertOk(result);

    expect(result.deg0).toMatchObject({ cols: 0, rows: 19, count: 0 });
    expect(result.deg0.utilization).toBe(0);

    expect(result.deg90).toMatchObject({ cols: 14, rows: 1, count: 14 });
    expect(result.deg90.utilization).toBeCloseTo(0.6516, 4);
  });
});

describe('computeImposition／fitCount — 尺寸安全界（review F1：1e20 死循環／1e-200 NaN 反例＋深度防禦）', () => {
  it('紙規 1e20（原本讓 fitCount 於 IEEE-754 n+1===n 精度極限死循環）→ typed invalid，不掛起', () => {
    // paperW=paperH=1e20 皆 > MAX_DIMENSION_MM(1e6)，domain 現在會先擋下——
    // 不再讓計算鏈走到 fitCount 才發生死循環。
    const result = computeImposition({ ...BASE_INPUT, paperW: 1e20, paperH: 1e20 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const asSet = new Set(result.errors.map((e) => `${e.field}:${e.reason}`));
      expect(asSet).toEqual(new Set(['paperW:out-of-range', 'paperH:out-of-range']));
    }
  });

  it('紙與件 W/H 全設 1e-200（原本讓 utilization 分母/分子下溢為 0 → NaN）→ typed invalid', () => {
    // 1e-200 皆 > 0（不是 not-positive），但 < MIN_DIMENSION_MM(0.01)，四欄各自
    // 落在新增的 out-of-range 分支。
    const result = computeImposition({
      ...BASE_INPUT,
      paperW: 1e-200,
      paperH: 1e-200,
      pieceW: 1e-200,
      pieceH: 1e-200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const asSet = new Set(result.errors.map((e) => `${e.field}:${e.reason}`));
      expect(asSet).toEqual(
        new Set(['paperW:out-of-range', 'paperH:out-of-range', 'pieceW:out-of-range', 'pieceH:out-of-range']),
      );
    }
  });

  it('paperW/paperH 恰為 MAX_DIMENSION_MM（1e6）邊界值仍合法（不誤傷邊界本身）', () => {
    const result = computeImposition({ ...BASE_INPUT, paperW: MAX_DIMENSION_MM, paperH: MAX_DIMENSION_MM });
    expect(result.ok).toBe(true);
  });

  it('paperW 超過 MAX_DIMENSION_MM 一點點（1e6+1）→ out-of-range', () => {
    const result = computeImposition({ ...BASE_INPUT, paperW: MAX_DIMENSION_MM + 1 });
    expect(result).toEqual({ ok: false, errors: [{ field: 'paperW', reason: 'out-of-range' }] });
  });

  it('paperW 恰為 MIN_DIMENSION_MM（0.01）邊界值仍合法（domain 通過，僅排列本身放不下）', () => {
    const result = computeImposition({ ...BASE_INPUT, paperW: MIN_DIMENSION_MM, paperH: MIN_DIMENSION_MM });
    expect(result.ok).toBe(true);
  });

  it('paperW 低於 MIN_DIMENSION_MM（0.005，仍 > 0）→ out-of-range（跟 not-positive 分開判斷）', () => {
    const result = computeImposition({ ...BASE_INPUT, paperW: 0.005 });
    expect(result).toEqual({ ok: false, errors: [{ field: 'paperW', reason: 'out-of-range' }] });
  });

  it('gripper 超過 MAX_DIMENSION_MM → out-of-range', () => {
    const result = computeImposition({ ...BASE_INPUT, gripper: MAX_DIMENSION_MM + 1 });
    expect(result).toEqual({ ok: false, errors: [{ field: 'gripper', reason: 'out-of-range' }] });
  });

  it('gap 超過 MAX_DIMENSION_MM → out-of-range', () => {
    const result = computeImposition({ ...BASE_INPUT, gap: MAX_DIMENSION_MM + 1 });
    expect(result).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'out-of-range' }] });
  });

  // review F1「有 domain 前提外的防護證明」：以下直接測 fitCount 本身（繞過
  // computeImposition 的 domain 驗證），證明無進展防護是 fitCount 自身的防禦，
  // 不是靠呼叫端的 domain 檢查才不掛起。
  describe('fitCount 直接單元測試（domain 前提外，證明無進展防護本身生效）', () => {
    it('available=1e20（review 原始反例參數：paperW=1e20、gripper=0、gap=3 換算後的 usableW）不死循環，回傳 finite', () => {
      const start = Date.now();
      const result = fitCount(1e20, 1, 3);
      const elapsed = Date.now() - start;
      expect(Number.isFinite(result)).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('available=Infinity（review 明列的直接反例 fitCount(Infinity,30,3)）不死循環，立即返回', () => {
      const start = Date.now();
      const result = fitCount(Infinity, 30, 3);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
      // 回傳值本身非 finite（Infinity）——這正是為什麼 computeImposition 仍需回傳前的
      // 第二道 finite 檢查（見上方 out-of-range 測試）：fitCount 的無進展防護只保證
      // 「不掛起」，不保證回傳值本身有意義。
      expect(result).toBe(Infinity);
    });

    it('available=Number.MAX_SAFE_INTEGER 量級仍正常終止並回傳 finite 整數', () => {
      const result = fitCount(Number.MAX_SAFE_INTEGER, 1, 3);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('input snapshot（re-review 反例固化：getter 屬性 domain 驗證後變值）', () => {
    it('gap getter 第一次讀回 3（過 domain）、之後回 Infinity——snapshot 保證計算用同一組值', () => {
      // T2 re-review 的攻擊構造：JS 屬性可以是 getter、每次讀值可不同。修復前
      // collectDomainErrors 與 computeDirection 各自讀 input.gap，第二次讀到 Infinity
      // 命中 finite 防禦分支、誤報 {field:'paperW', reason:'out-of-range'}。修復後
      // computeImposition 進場對每個屬性恰讀一次建 snapshot——本測試的 getter 只會被
      // 讀到第一個值 3，計算結果與 plain object 輸入完全一致。
      let gapReads = 0;
      const hostile = {
        pieceW: 233.2,
        pieceH: 251,
        paperW: 787,
        paperH: 1092,
        orientation: 'portrait',
        mode: 'full',
        gripper: 20,
        get gap() {
          gapReads += 1;
          return gapReads === 1 ? 3 : Infinity;
        },
      } as ImpositionInput;

      const result = computeImposition(hostile);
      expect(gapReads).toBe(1);
      expect(result).toEqual(
        computeImposition({
          pieceW: 233.2,
          pieceH: 251,
          paperW: 787,
          paperH: 1092,
          orientation: 'portrait',
          mode: 'full',
          gripper: 20,
          gap: 3,
        }),
      );
    });

    it('內部錯誤表示為 {field:"result", reason:"internal"}——不誤導輸入欄位歸因（型別對）', () => {
      // 防禦分支在 snapshot＋domain 上下界後不可達（數值上界證明見 computeImposition
      // docblock），無法從公開 API 觸發——這裡只鎖住型別 union 接受 internal 變體，
      // 供 UI 端窮舉 reason 時必須處理「整體錯誤」分支。
      const internalError: ImpositionFieldError = { field: 'result', reason: 'internal' };
      expect(internalError.field).toBe('result');
    });
  });
});
