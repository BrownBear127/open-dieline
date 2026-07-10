import { describe, expect, it } from 'vitest';
import {
  computeImposition,
  fitCount,
  resolveWorkingSheet,
  isFiniteStripFill,
  PAPER_PRESETS,
  FIT_EPSILON_MM,
  MAX_PREVIEW_INSTANCES,
  MIN_GAP_MM,
  MIN_DIMENSION_MM,
  MAX_DIMENSION_MM,
} from '@/core/imposition';
import type { ImpositionFieldError, ImpositionInput, ImpositionResult, SheetOrientation, StripFill } from '@/core/imposition';

// 純函式測試——只吃/吐數字，不碰 boxes/*、manufacturingBounds（那是 imposition-anchor.test.ts
// 的整合錨職責，見 task-2-brief 介面說明「Consumes: manufacturingBounds（僅整合測試消費；
// 純函式只吃數字）」）。

/** ok:true 窄化＋失敗時把 errors 印進錯誤訊息，方便測試失敗時直接看到原因。 */
function assertOk(result: ImpositionResult): asserts result is Extract<ImpositionResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`預期 ok:true，但收到 errors：${JSON.stringify(result.errors)}`);
  }
}

// 數值錨的基準輸入（gate round 1 task-1-brief 附錄）：RTE 預設參數的製造 bounds 233.2×251，
// 31"×43" 直放整紙、咬口 20、gap 3。allowRotate:false／cutV:false／cutH:false 對應附錄錨表
// 第 1/2 列（關轉），是「補排功能加入前」的舊版數字——回歸保證的基準點。
const BASE_INPUT: ImpositionInput = {
  pieceW: 233.2,
  pieceH: 251,
  paperW: 787,
  paperH: 1092,
  orientation: 'portrait',
  cutV: false,
  cutH: false,
  allowRotate: false,
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
  it('landscape：787×1092 來源 → w=較大邊(1092)，h=較小邊(787)；fullW/fullH＝方向處理後、裁切前', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'landscape', false, false, 20);
    expect(sheet.w).toBe(1092);
    expect(sheet.h).toBe(787);
    expect(sheet.usableW).toBe(1052);
    expect(sheet.usableH).toBe(747);
    expect(sheet.fullW).toBe(1092);
    expect(sheet.fullH).toBe(787);
    expect(sheet.cutV).toBe(false);
    expect(sheet.cutH).toBe(false);
    expect(sheet.sections).toBe(1);
  });

  it('portrait：787×1092 來源已是直放形狀 → w=較小邊(787)，h=較大邊(1092)（identity）', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'portrait', false, false, 20);
    expect(sheet.w).toBe(787);
    expect(sheet.h).toBe(1092);
    expect(sheet.usableW).toBe(747);
    expect(sheet.usableH).toBe(1052);
    expect(sheet.fullW).toBe(787);
    expect(sheet.fullH).toBe(1092);
    expect(sheet.sections).toBe(1);
  });

  it('portrait：來源本身是橫放形狀（1200×800）時仍正規化成 w=較小邊、h=較大邊', () => {
    const sheet = resolveWorkingSheet(1200, 800, 'portrait', false, false, 0);
    expect(sheet.w).toBe(800);
    expect(sheet.h).toBe(1200);
  });

  it('landscape：來源本身是直放形狀（800×1200）時正規化成 w=較大邊、h=較小邊', () => {
    const sheet = resolveWorkingSheet(800, 1200, 'landscape', false, false, 0);
    expect(sheet.w).toBe(1200);
    expect(sheet.h).toBe(800);
  });

  it('cutV 對「方向處理後」的 w 取半；cutH 對 h 取半（各自獨立疊加，取代舊 halfV/halfH 單選）', () => {
    const cutV = resolveWorkingSheet(787, 1092, 'portrait', true, false, 0);
    expect(cutV.w).toBe(393.5);
    expect(cutV.h).toBe(1092);
    expect(cutV.fullW).toBe(787); // fullW/fullH 是裁切前尺寸，不受 cutV 影響
    expect(cutV.fullH).toBe(1092);
    expect(cutV.cutV).toBe(true);
    expect(cutV.cutH).toBe(false);
    expect(cutV.sections).toBe(2);

    const cutH = resolveWorkingSheet(787, 1092, 'portrait', false, true, 0);
    expect(cutH.w).toBe(787);
    expect(cutH.h).toBe(546);
    expect(cutH.fullW).toBe(787);
    expect(cutH.fullH).toBe(1092);
    expect(cutH.sections).toBe(2);
  });

  it('cutV+cutH 可疊加（四開）：w/h 皆取半，sections=4，fullW/fullH 仍是裁切前整張尺寸', () => {
    const quarter = resolveWorkingSheet(787, 1092, 'portrait', true, true, 20);
    expect(quarter.w).toBe(393.5);
    expect(quarter.h).toBe(546);
    expect(quarter.fullW).toBe(787);
    expect(quarter.fullH).toBe(1092);
    expect(quarter.usableW).toBe(353.5); // 393.5-40
    expect(quarter.usableH).toBe(506); // 546-40
    expect(quarter.cutV).toBe(true);
    expect(quarter.cutH).toBe(true);
    expect(quarter.sections).toBe(4);
  });

  it('咬口過大時可用區 clamp 至 0（不是負數）——合法輸入，非 domain 錯誤', () => {
    const sheet = resolveWorkingSheet(787, 1092, 'portrait', false, false, 500);
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

describe('computeImposition — 數值錨（task-1-brief 附錄數值錨表 7 列，expected 硬編碼、不由被測函式導出）', () => {
  interface AnchorRow {
    label: string;
    orientation: SheetOrientation;
    cutV: boolean;
    cutH: boolean;
    allowRotate: boolean;
    dir: 'deg0' | 'deg90';
    cols: number;
    rows: number;
    gridCount: number;
    fillSplit: 'bottom-full' | 'right-full' | null;
    bottomFill: { cols: number; rows: number; count: number } | null;
    rightFill: { cols: number; rows: number; count: number } | null;
    count: number;
    totalCount: number;
    utilization: number;
  }

  // 7 列逐列獨立驗算＋SOL plan review 交叉（見 task-1-brief 附錄；第 4 列由 SOL 雙分割反例
  // 修正 11→12）。paper/piece/gripper/gap 全 7 列共用（787×1092、233.2×251、20、3），
  // 只有 orientation/cutV/cutH/allowRotate/方向（deg0 或 deg90）逐列不同。
  const ANCHOR_ROWS: AnchorRow[] = [
    {
      label: '直放·整紙·0° 主·關轉',
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: false, dir: 'deg0',
      cols: 3, rows: 4, gridCount: 12,
      fillSplit: null, bottomFill: null, rightFill: null,
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '直放·整紙·90° 主·關轉',
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: false, dir: 'deg90',
      cols: 2, rows: 4, gridCount: 8,
      fillSplit: null, bottomFill: null, rightFill: null,
      count: 8, totalCount: 8, utilization: 0.5449,
    },
    {
      label: '直放·整紙·0° 主·開轉',
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: true, dir: 'deg0',
      cols: 3, rows: 4, gridCount: 12,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 2, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 4, count: 0 },
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '直放·整紙·90° 主·開轉（SOL 雙分割反例：right-full 的右側全高條帶能多塞一整排）',
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: true, dir: 'deg90',
      cols: 2, rows: 4, gridCount: 8,
      fillSplit: 'right-full',
      bottomFill: { cols: 2, rows: 0, count: 0 },
      rightFill: { cols: 1, rows: 4, count: 4 },
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '橫放·整紙·0° 主·開轉（法蘭 gate 反饋實證：下方空白可放 4 模卻沒算進去）',
      orientation: 'landscape', cutV: false, cutH: false, allowRotate: true, dir: 'deg0',
      cols: 4, rows: 2, gridCount: 8,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 4, rows: 1, count: 4 },
      rightFill: { cols: 0, rows: 2, count: 0 },
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '橫放·整紙·90° 主·開轉',
      orientation: 'landscape', cutV: false, cutH: false, allowRotate: true, dir: 'deg90',
      cols: 4, rows: 3, gridCount: 12,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 4, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 2, count: 0 },
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '直放·四開（cutV+cutH·子紙 393.5×546）·0° 主·開轉',
      orientation: 'portrait', cutV: true, cutH: true, allowRotate: true, dir: 'deg0',
      cols: 1, rows: 2, gridCount: 2,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 0, rows: 0, count: 0 },
      rightFill: { cols: 0, rows: 2, count: 0 },
      count: 2, totalCount: 8, utilization: 0.5449,
    },
  ];

  it.each(ANCHOR_ROWS)('$label', (row) => {
    const result = computeImposition({
      ...BASE_INPUT,
      orientation: row.orientation,
      cutV: row.cutV,
      cutH: row.cutH,
      allowRotate: row.allowRotate,
    });
    assertOk(result);
    const direction = result[row.dir];

    expect(direction.cols).toBe(row.cols);
    expect(direction.rows).toBe(row.rows);
    expect(direction.gridCount).toBe(row.gridCount);
    expect(direction.fillSplit).toBe(row.fillSplit);
    expect(direction.bottomFill).toEqual(row.bottomFill);
    expect(direction.rightFill).toEqual(row.rightFill);
    expect(direction.count).toBe(row.count);
    expect(direction.totalCount).toBe(row.totalCount);
    expect(direction.utilization).toBeCloseTo(row.utilization, 4);
  });

  it('回歸保證：allowRotate=false 時 sheet 逐字等於補排功能加入前的整紙 sheet（787×1092 portrait 咬口20）', () => {
    const result = computeImposition(BASE_INPUT);
    assertOk(result);
    expect(result.sheet).toEqual({
      w: 787, h: 1092, usableW: 747, usableH: 1052,
      fullW: 787, fullH: 1092, cutV: false, cutH: false, sections: 1,
    });
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

  // review F4：LCG 只生成連續數值，不適合拿來抽 orientation/cut 這種離散類別——固定 seed
  // 下十組實際落點曾只覆蓋 3/6 種組合、且 full 分支完全缺席。改為分層／循環指定：
  // ORIENTATIONS × CUT_COMBOS 的笛卡兒積固定排出 6 組合（full/cutV/cutH 三種裁切×兩方向；
  // quarter 已由上方數值錨表第 7 列與下方裁切等式/計算矩陣覆蓋，這裡不重複），10 組案例
  // 依索引 `i % 6` 循環取用，保證 6 種組合每種至少出現一次。連續數值（pieceW/pieceH/
  // paperW/paperH/gripper/gap）仍全部交給 LCG，可重現性不變。allowRotate 固定 true——
  // 對稱性質（deg90 of X 等於 deg0 of swap(X)）在 computeDirection 的參數層級成立
  // （sheet 不吃 piece 尺寸，兩側呼叫的 5 個參數逐一相同），與 allowRotate 值無關，固定
  // true 額外覆蓋補排邏輯本身也遵守這個對稱性質。
  const ORIENTATIONS: readonly SheetOrientation[] = ['portrait', 'landscape'];
  const CUT_COMBOS: ReadonlyArray<{ cutV: boolean; cutH: boolean }> = [
    { cutV: false, cutH: false },
    { cutV: true, cutH: false },
    { cutV: false, cutH: true },
  ];
  const COMBOS: ReadonlyArray<{ orientation: SheetOrientation; cutV: boolean; cutH: boolean }> = ORIENTATIONS.flatMap(
    (orientation) => CUT_COMBOS.map((cut) => ({ orientation, ...cut })),
  );

  const randomCases = Array.from({ length: 10 }, (_, i) => {
    const combo = COMBOS[i % COMBOS.length]!;
    const input: ImpositionInput = {
      pieceW: between(20, 150),
      pieceH: between(20, 150),
      paperW: between(400, 1200),
      paperH: between(400, 1200),
      orientation: combo.orientation,
      cutV: combo.cutV,
      cutH: combo.cutH,
      allowRotate: true,
      gripper: between(0, 30),
      gap: between(3, 10),
    };
    return { i, input };
  });

  it('十組案例的 orientation×cut 分層覆蓋六種組合（覆蓋率斷言，防止分層邏輯本身跟著退化）', () => {
    const covered = new Set(randomCases.map(({ input }) => `${input.orientation}:${input.cutV}:${input.cutH}`));
    expect(covered.size).toBe(6);
  });

  it.each(randomCases)('第 $i 組（$input.orientation cutV=$input.cutV cutH=$input.cutH）：deg90 等於 pieceW/pieceH 互換後的 deg0', ({ input }) => {
    const swapped: ImpositionInput = { ...input, pieceW: input.pieceH, pieceH: input.pieceW };

    const result = computeImposition(input);
    const swappedResult = computeImposition(swapped);
    assertOk(result);
    assertOk(swappedResult);

    expect(result.deg90).toEqual(swappedResult.deg0);
  });
});

describe('computeImposition — 裁切等式（cutV/cutH＝以「方向處理後」尺寸為子紙的計算；取代舊 halfV/halfH 單選）', () => {
  it('cutV：working w 為整紙模式 oriented w 的一半，h 與可用區高不變', () => {
    const full = computeImposition({ ...BASE_INPUT, cutV: false, cutH: false });
    const cutV = computeImposition({ ...BASE_INPUT, cutV: true, cutH: false });
    assertOk(full);
    assertOk(cutV);

    expect(cutV.sheet.w).toBeCloseTo(full.sheet.w / 2, 6);
    expect(cutV.sheet.h).toBe(full.sheet.h);
    expect(cutV.sheet.usableW).toBeCloseTo(full.sheet.w / 2 - 2 * BASE_INPUT.gripper, 6);
    expect(cutV.sheet.usableH).toBe(full.sheet.usableH);
  });

  it('cutH：working h 為整紙模式 oriented h 的一半，w 與可用區寬不變', () => {
    const full = computeImposition({ ...BASE_INPUT, cutV: false, cutH: false });
    const cutH = computeImposition({ ...BASE_INPUT, cutV: false, cutH: true });
    assertOk(full);
    assertOk(cutH);

    expect(cutH.sheet.h).toBeCloseTo(full.sheet.h / 2, 6);
    expect(cutH.sheet.w).toBe(full.sheet.w);
    expect(cutH.sheet.usableH).toBeCloseTo(full.sheet.h / 2 - 2 * BASE_INPUT.gripper, 6);
    expect(cutH.sheet.usableW).toBe(full.sheet.usableW);
  });

  // review F3：上面兩測試只證明 sheet 尺寸／可用區取半，沒有證明拼版「結果」（cols/rows/
  // gridCount/count/utilization）等價——這裡直接對 deg0/deg90 完整結果 hardcode expected。
  // allowRotate 沿用 BASE_INPUT 預設 false（回歸保證：與加入補排前的舊 halfV/halfH 數字
  // 逐字相同）。手算基準：BASE_INPUT piece=233.2×251、gripper=20、gap=3。
  it('cutV：deg0/deg90 完整結果（cols/rows/gridCount/count/utilization）硬編碼，回歸舊 halfV 數字', () => {
    // cutV sheet=393.5×1092，usable=353.5×1052（usableH 與整紙相同，cutV 只砍 w）。
    // deg0（pieceForCols=233.2, pieceForRows=251）：
    //   cols：1 件 footprint=233.2≤353.5；2 件=2×233.2+1×3=469.4>353.5，cols=1
    //   rows：與整紙 deg0 相同（usableH、pieceForRows 均未變）＝4；gridCount=1×4=4
    //   utilization=4×233.2×251÷(393.5×1092)=234132.8÷429702=0.544872...→0.5449
    // deg90（pieceForCols=251, pieceForRows=233.2）：
    //   cols：1 件=251≤353.5；2 件=2×251+1×3=505>353.5，cols=1
    //   rows：4 件=4×233.2+3×3=941.8≤1052；5 件=1178>1052，rows=4
    //   gridCount=1×4=4；utilization 同上分子分母＝0.5449
    const result = computeImposition({ ...BASE_INPUT, cutV: true, cutH: false });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 1, rows: 4, gridCount: 4, count: 4 });
    expect(result.deg0.utilization).toBeCloseTo(0.5449, 4);
    expect(result.deg90).toMatchObject({ cols: 1, rows: 4, gridCount: 4, count: 4 });
    expect(result.deg90.utilization).toBeCloseTo(0.5449, 4);
  });

  it('cutH：deg0/deg90 完整結果（cols/rows/gridCount/count/utilization）硬編碼，回歸舊 halfH 數字', () => {
    // cutH sheet=787×546，usable=747×506（usableW 與整紙相同，cutH 只砍 h）。
    // deg0：cols 與整紙 deg0 相同（usableW 未變）＝3；rows：2 件=505≤506；3 件=759>506，
    //   rows=2；gridCount=3×2=6；utilization=6×58533.2÷429702=0.817309...→0.8173
    // deg90：cols 與整紙 deg90 相同＝2；rows：2 件=469.4≤506；3 件=705.6>506，rows=2；
    //   gridCount=2×2=4；utilization=4×58533.2÷429702=0.544872...→0.5449
    const result = computeImposition({ ...BASE_INPUT, cutV: false, cutH: true });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 3, rows: 2, gridCount: 6, count: 6 });
    expect(result.deg0.utilization).toBeCloseTo(0.8173, 4);
    expect(result.deg90).toMatchObject({ cols: 2, rows: 2, gridCount: 4, count: 4 });
    expect(result.deg90.utilization).toBeCloseTo(0.5449, 4);
  });
});

describe('computeImposition — 計算矩陣（portrait/landscape × full/cutV/cutH 六組合，allowRotate=false 回歸保證）', () => {
  // 手算基準（見 task-2-report.md 手算過程／review 手算抽驗，cols/rows/count 已驗證）：
  // paperW=787,paperH=1092／piece 100×140／咬口 20／gap 3。expected 由 resolveWorkingSheet
  // 轉換鏈＋fitCount 公式手算，不得由被測函式導出（防自我循環）。allowRotate=false，數字與
  // 補排功能加入前逐字相同（回歸保證）。
  //
  // utilization 手算：working sheet 面積固定兩種——full 模式 787×1092＝859404；cutV/cutH
  // 砍其中一邊得一半＝429702（cutV：393.5×1092＝429702；cutH：787×546＝429702）。
  // piece 面積固定 100×140＝14000。utilization＝count×14000÷working面積：
  //   portrait×full  deg0 49×14000=686000÷859404=0.798227...→0.7982
  //                  deg90 50×14000=700000÷859404=0.814517...→0.8145
  //   portrait×cutV  deg0 21×14000=294000÷429702=0.684195...→0.6842
  //                  deg90 20×14000=280000÷429702=0.651614...→0.6516
  //   portrait×cutH  deg0 21×14000=294000÷429702=0.684195...→0.6842（面積同 cutV：787×546=429702）
  //                  deg90 20×14000=280000÷429702=0.651614...→0.6516
  //   landscape×full deg0 50×14000=700000÷859404=0.814517...→0.8145
  //                  deg90 49×14000=686000÷859404=0.798227...→0.7982
  //   landscape×cutV deg0 20×14000=280000÷429702=0.651614...→0.6516
  //                  deg90 21×14000=294000÷429702=0.684195...→0.6842
  //   landscape×cutH deg0 20×14000=280000÷429702=0.651614...→0.6516
  //                  deg90 21×14000=294000÷429702=0.684195...→0.6842
  const piece = { pieceW: 100, pieceH: 140 };
  const commonFields = { paperW: 787, paperH: 1092, gripper: 20, gap: 3 };

  const cases: Array<{
    orientation: SheetOrientation;
    cutV: boolean;
    cutH: boolean;
    deg0: { cols: number; rows: number; count: number; utilization: number };
    deg90: { cols: number; rows: number; count: number; utilization: number };
  }> = [
    {
      orientation: 'portrait', cutV: false, cutH: false,
      deg0: { cols: 7, rows: 7, count: 49, utilization: 0.7982 },
      deg90: { cols: 5, rows: 10, count: 50, utilization: 0.8145 },
    },
    {
      orientation: 'portrait', cutV: true, cutH: false,
      deg0: { cols: 3, rows: 7, count: 21, utilization: 0.6842 },
      deg90: { cols: 2, rows: 10, count: 20, utilization: 0.6516 },
    },
    {
      orientation: 'portrait', cutV: false, cutH: true,
      deg0: { cols: 7, rows: 3, count: 21, utilization: 0.6842 },
      deg90: { cols: 5, rows: 4, count: 20, utilization: 0.6516 },
    },
    {
      orientation: 'landscape', cutV: false, cutH: false,
      deg0: { cols: 10, rows: 5, count: 50, utilization: 0.8145 },
      deg90: { cols: 7, rows: 7, count: 49, utilization: 0.7982 },
    },
    {
      orientation: 'landscape', cutV: true, cutH: false,
      deg0: { cols: 4, rows: 5, count: 20, utilization: 0.6516 },
      deg90: { cols: 3, rows: 7, count: 21, utilization: 0.6842 },
    },
    {
      orientation: 'landscape', cutV: false, cutH: true,
      deg0: { cols: 10, rows: 2, count: 20, utilization: 0.6516 },
      deg90: { cols: 7, rows: 3, count: 21, utilization: 0.6842 },
    },
    // final review Opus Minor：spec delta 要 8 組（原本 6 組只覆蓋 full/cutV/cutH 三種裁切，
    // 缺四開 cutV+cutH）。四開子紙尺寸與上方「裁切等式」describe 的 cutV／cutH 手算結果可疊
    // 加驗證（portrait：cutV 子紙 393.5×1092、cutH 子紙 787×546 → 四開＝393.5×546；landscape
    // 同理＝546×393.5，長短邊對調）。expected 由 resolveWorkingSheet 轉換鏈＋fitCount 公式
    // 手算、並以獨立 computeImposition 呼叫交叉核對（非由被測函式反推，防自我循環）：
    //   portrait×quarter sheet=393.5×546,usable=353.5×506：
    //     deg0（pieceForCols=100,pieceForRows=140）
    //       cols=fitCount(353.5,100,3)=3（3×100+2×3=306≤353.5；4×100+3×3=409>353.5）
    //       rows=fitCount(506,140,3)=3（3×140+2×3=426≤506；4×140+3×3=569>506）；count=9
    //       utilization=9×14000÷(393.5×546)=126000÷214851=0.586453...→0.5865
    //     deg90（pieceForCols=140,pieceForRows=100）
    //       cols=fitCount(353.5,140,3)=2（2×140+1×3=283≤353.5；3×140+2×3=426>353.5）
    //       rows=fitCount(506,100,3)=4（4×100+3×3=409≤506；5×100+4×3=512>506）；count=8
    //       utilization=8×14000÷214851=112000÷214851=0.521291...→0.5213
    //   landscape×quarter sheet=546×393.5,usable=506×353.5（子紙長短邊對調，數字與 portrait
    //   互換——同一份 787×1092 紙轉 90° 看，跟「deg90 對稱性質」describe 驗證的鏡射關係一致）：
    //     deg0（pieceForCols=100,pieceForRows=140）
    //       cols=fitCount(506,100,3)=4（4×100+3×3=409≤506；5×100+4×3=512>506）
    //       rows=fitCount(353.5,140,3)=2（2×140+1×3=283≤353.5；3×140+2×3=426>353.5）；count=8
    //       utilization=8×14000÷(546×393.5)=112000÷214851=0.521291...→0.5213（與 portrait deg90 同值：面積與 count 皆相同）
    //     deg90（pieceForCols=140,pieceForRows=100）
    //       cols=fitCount(506,140,3)=3（3×140+2×3=426≤506；4×140+3×3=569>506）
    //       rows=fitCount(353.5,100,3)=3（3×100+2×3=306≤353.5；4×100+3×3=409>353.5）；count=9
    //       utilization=9×14000÷214851=126000÷214851=0.586453...→0.5865（與 portrait deg0 同值）
    {
      orientation: 'portrait', cutV: true, cutH: true,
      deg0: { cols: 3, rows: 3, count: 9, utilization: 0.5865 },
      deg90: { cols: 2, rows: 4, count: 8, utilization: 0.5213 },
    },
    {
      orientation: 'landscape', cutV: true, cutH: true,
      deg0: { cols: 4, rows: 2, count: 8, utilization: 0.5213 },
      deg90: { cols: 3, rows: 3, count: 9, utilization: 0.5865 },
    },
  ];

  it.each(cases)('$orientation × cutV=$cutV,cutH=$cutH', ({ orientation, cutV, cutH, deg0, deg90 }) => {
    const result = computeImposition({ ...piece, ...commonFields, orientation, cutV, cutH, allowRotate: false });
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
    //       utilization=25×100×140÷(635×889)=350000÷564515=0.620001...→0.6200
    // deg90：cols=fitCount(595,140,3)=4（4×140+3×3=569≤595；5×140+4×3=712>595）
    //        rows=fitCount(849,100,3)=8（8×100+7×3=821≤849；9×100+8×3=924>849）；count=32
    //        utilization=32×14000÷564515=448000÷564515=0.793602...→0.7936
    const r635 = computeImposition({
      ...piece, paperW: 635, paperH: 889, gripper: 20, gap: 3,
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: false,
    });
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
    //        utilization=36×14000÷679826=0.741366...→0.7414（跟 deg0 同值——count 剛好相同）
    const r686 = computeImposition({
      ...piece, paperW: 686, paperH: 991, gripper: 20, gap: 3,
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: false,
    });
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
      cutV: false,
      cutH: false,
      allowRotate: false,
    });
    assertOk(custom);
    expect(custom.sheet).toEqual({
      w: 1000, h: 800, usableW: 960, usableH: 760,
      fullW: 1000, fullH: 800, cutV: false, cutH: false, sections: 1,
    });
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
  // 0° 方向該軸放不下）、pieceH=50（很窄，90° 旋轉後放得下）。allowRotate 沿用 BASE_INPUT
  // 預設 false——這裡只驗主格點行為（回歸保證），allowRotate=true 版本見下方極端分支①。
  it('單一方向放不下、另一方向正常計算：長窄件 800×50（0° 該方向放不下→count 0；90° 正常）', () => {
    // 沿用 BASE_INPUT 的紙規/gripper/gap（787×1092、咬口20、gap3）→ usable=747×1052。
    // deg0（pieceForCols=800, pieceForRows=50）：
    //   cols=fitCount(747,800,3)：1 件 footprint=800>747，放不下 → cols=0
    //   rows=fitCount(1052,50,3)=19（19×50+18×3=950+54=1004≤1052；20×50+19×3=1000+57=1057>1052）
    //   gridCount=cols×rows=0×19=0（任一向 0 → 該方向 N=0，即使 rows 本身算出非零）；utilization=0
    // deg90（pieceForCols=50, pieceForRows=800）：
    //   cols=fitCount(747,50,3)=14（14×50+13×3=700+39=739≤747；15×50+14×3=750+42=792>747）
    //   rows=fitCount(1052,800,3)：1 件=800≤1052；2 件=2×800+1×3=1603>1052 → rows=1
    //   gridCount=14×1=14（正常、非零）
    //   utilization=14×50×800÷(787×1092)=560000÷859404=0.651614...→0.6516
    const input: ImpositionInput = { ...BASE_INPUT, pieceW: 800, pieceH: 50 };
    const result = computeImposition(input);
    assertOk(result);

    expect(result.deg0).toMatchObject({ cols: 0, rows: 19, count: 0 });
    expect(result.deg0.utilization).toBe(0);

    expect(result.deg90).toMatchObject({ cols: 14, rows: 1, count: 14 });
    expect(result.deg90.utilization).toBeCloseTo(0.6516, 4);
  });
});

describe('computeImposition — L 形補排極端/退化分支（task-1-brief RED 項目①-⑧：既有極端測試全走 allowRotate=false，新分支需自己的驗收保護）', () => {
  it('①piece=800×50＋開轉：0° 方向 gridCount=0（放不下）→ fillSplit/兩 fill＝null、count=0（不因 allowRotate=true 就硬補排一個不存在的主格點）', () => {
    const result = computeImposition({ ...BASE_INPUT, pieceW: 800, pieceH: 50, allowRotate: true });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 0, rows: 19, gridCount: 0 });
    expect(result.deg0.fillSplit).toBeNull();
    expect(result.deg0.bottomFill).toBeNull();
    expect(result.deg0.rightFill).toBeNull();
    expect(result.deg0.count).toBe(0);
  });

  it('②可用區一軸為 0（usableW=0，usableH>0）／兩軸皆 0：gridCount 恆 0，補排短路（不因另一軸有空間就誤算 fill）', () => {
    // gripper=400：787-800=-13→usableW clamp 0；1092-800=292→usableH>0（一軸 0）。
    const oneAxisZero = computeImposition({ ...BASE_INPUT, allowRotate: true, gripper: 400 });
    assertOk(oneAxisZero);
    expect(oneAxisZero.sheet.usableW).toBe(0);
    expect(oneAxisZero.sheet.usableH).toBeGreaterThan(0);
    expect(oneAxisZero.deg0.gridCount).toBe(0);
    expect(oneAxisZero.deg0.fillSplit).toBeNull();
    expect(oneAxisZero.deg0.bottomFill).toBeNull();
    expect(oneAxisZero.deg0.rightFill).toBeNull();
    expect(oneAxisZero.deg0.count).toBe(0);

    // gripper=600：787-1200<0→0；1092-1200<0→0（兩軸皆 0）。
    const bothAxesZero = computeImposition({ ...BASE_INPUT, allowRotate: true, gripper: 600 });
    assertOk(bothAxesZero);
    expect(bothAxesZero.sheet.usableW).toBe(0);
    expect(bothAxesZero.sheet.usableH).toBe(0);
    expect(bothAxesZero.deg0.gridCount).toBe(0);
    expect(bothAxesZero.deg0.fillSplit).toBeNull();
    expect(bothAxesZero.deg0.count).toBe(0);
  });

  it('③usedH+gap>usableH（條帶高度演算後轉負）→ 該條帶結構強制 {cols:0,rows:0,count:0}，不是「寬算出非零、高算出 0」的中間態', () => {
    // 100×100 方紙、gripper0、gap3（MIN_GAP_MM 下限）、piece 30×48：deg0 主格點
    // cols=3,rows=2（usedH=99），usableH-usedH-gap=100-99-3=-2<0——bottom-full 分割的
    // 底條帶高度為負，強制整條帶 {0,0,0}。
    const result = computeImposition({
      pieceW: 30, pieceH: 48, paperW: 100, paperH: 100,
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: true,
      gripper: 0, gap: 3,
    });
    assertOk(result);
    expect(result.deg0).toMatchObject({ cols: 3, rows: 2, gridCount: 6 });
    expect(result.deg0.fillSplit).toBe('bottom-full');
    expect(result.deg0.bottomFill).toEqual({ cols: 0, rows: 0, count: 0 });
    expect(result.deg0.rightFill).toEqual({ cols: 0, rows: 3, count: 0 });
    expect(result.deg0.count).toBe(6);
  });

  it('④單欄（cols=1，deg0）／單列（rows=1，deg90）：usedW/usedH 於 n=1 時不多扣一個 gap（誤扣會讓補排的 exact-fit 邊界跑掉）', () => {
    // 200×200 方紙、gripper0、gap10、piece 140×50：deg0 主格點 cols=1×rows=3；deg90 主格點
    // cols=3×rows=1——同一組輸入從兩個方向分別驗 usedW（deg0）與 usedH（deg90）在 n=1 時的
    // 正確性。條帶寬/高刻意卡在補排 footprint 的 exact-fit 邊界，usedW/usedH 算錯一個 gap
    // 就會讓 fitCount 跨越邊界（1→0），比對純數字 count 更有鑑別力。
    const result = computeImposition({
      pieceW: 140, pieceH: 50, paperW: 200, paperH: 200,
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: true,
      gripper: 0, gap: 10,
    });
    assertOk(result);

    expect(result.deg0).toMatchObject({ cols: 1, rows: 3, gridCount: 3 });
    expect(result.deg0.fillSplit).toBe('bottom-full');
    expect(result.deg0.bottomFill).toEqual({ cols: 3, rows: 0, count: 0 });
    expect(result.deg0.rightFill).toEqual({ cols: 1, rows: 1, count: 1 }); // usedW=140 算對才有這 1 件
    expect(result.deg0.count).toBe(4);

    expect(result.deg90).toMatchObject({ cols: 3, rows: 1, gridCount: 3 });
    expect(result.deg90.fillSplit).toBe('bottom-full');
    expect(result.deg90.bottomFill).toEqual({ cols: 1, rows: 1, count: 1 }); // usedH=140 算對才有這 1 件
    expect(result.deg90.rightFill).toEqual({ cols: 0, rows: 2, count: 0 });
    expect(result.deg90.count).toBe(4);
  });

  it('⑤⑧paper=MAX_DIMENSION_MM＋piece=MIN_DIMENSION_MM＋四開＋開轉：新欄位全 finite、totalCount 為安全整數（深查兩 fill 的巢狀 cols/rows/count，不只外層 total）', () => {
    const result = computeImposition({
      pieceW: MIN_DIMENSION_MM, pieceH: MIN_DIMENSION_MM,
      paperW: MAX_DIMENSION_MM, paperH: MAX_DIMENSION_MM,
      orientation: 'portrait', cutV: true, cutH: true, allowRotate: true,
      gripper: 0, gap: MIN_GAP_MM,
    });
    assertOk(result);
    expect(result.sheet.sections).toBe(4);
    expect(Number.isFinite(result.sheet.fullW)).toBe(true);
    expect(Number.isFinite(result.sheet.fullH)).toBe(true);

    for (const direction of [result.deg0, result.deg90]) {
      expect(Number.isFinite(direction.cols)).toBe(true);
      expect(Number.isFinite(direction.rows)).toBe(true);
      expect(Number.isFinite(direction.gridCount)).toBe(true);
      expect(Number.isFinite(direction.count)).toBe(true);
      expect(Number.isSafeInteger(direction.totalCount)).toBe(true);
      expect(Number.isFinite(direction.utilization)).toBe(true);
      // 深查兩條帶的巢狀欄位（isFiniteDirectionResult 的第二道防線覆蓋範圍）——不只頂層
      // count/totalCount，bottomFill/rightFill（若非 null）自身的 cols/rows/count 也逐一驗。
      for (const fill of [direction.bottomFill, direction.rightFill]) {
        if (fill !== null) {
          expect(Number.isFinite(fill.cols)).toBe(true);
          expect(Number.isFinite(fill.rows)).toBe(true);
          expect(Number.isFinite(fill.count)).toBe(true);
        }
      }
    }
  });

  it('⑥殘留條帶 exact-fit／差 FIT_EPSILON_MM 邊界（fitCount 的浮點容差在「條帶」整合路徑上依然生效，不只獨立呼叫 fitCount 本身才有）', () => {
    // 531.7×32 landscape、gripper0、gap3.1、piece 300×30：deg0 主格點 1×1（usedW=300,usedH=30，
    // 皆 n=1 不扣 gap）。右條帶寬度＝531.7-300-3.1=228.6，恰是 FIT_EPSILON_MM docblock 的
    // 經典邊界（件寬 30、gap 3.1、7 件 footprint 理論值恰為 228.6）——驗證這個邊界在「條帶」
    // 整合路徑（usableW-usedW-gap 算出來的寬度）上仍受 FIT_EPSILON_MM 保護。底條帶高度
    // 32-30-3.1=-1.1<0，兩分割皆強制 {0,0,0}，排除底條帶對 tie-break 的干擾，只看右條帶。
    const build = (pieceWDelta: number) =>
      computeImposition({
        pieceW: 300 + pieceWDelta, pieceH: 30, paperW: 531.7, paperH: 32,
        orientation: 'landscape', cutV: false, cutH: false, allowRotate: true,
        gripper: 0, gap: 3.1,
      });

    const exact = build(0);
    assertOk(exact);
    expect(exact.deg0.bottomFill).toEqual({ cols: 0, rows: 0, count: 0 });
    expect(exact.deg0.rightFill).toEqual({ cols: 7, rows: 0, count: 0 });

    // usedW 變大 1e-3 → 右條帶寬度變小 1e-3（228.599）→ 少一件（6，同 fitCount 的「略小於」行為）。
    const narrower = build(1e-3);
    assertOk(narrower);
    expect(narrower.deg0.rightFill).toEqual({ cols: 6, rows: 0, count: 0 });

    // usedW 變小 1e-3 → 右條帶寬度變大 1e-3（228.601）→ 仍 7 件，不因浮點雜訊多算一件。
    const wider = build(-1e-3);
    assertOk(wider);
    expect(wider.deg0.rightFill).toEqual({ cols: 7, rows: 0, count: 0 });
  });

  it('⑦cutV/cutH/allowRotate getter 各恰讀一次——snapshot 擴欄後三個新布林欄位同樣只透過快照讀一次', () => {
    let cutVReads = 0;
    let cutHReads = 0;
    let allowRotateReads = 0;
    const hostile = {
      pieceW: 233.2,
      pieceH: 251,
      paperW: 787,
      paperH: 1092,
      orientation: 'portrait',
      get cutV() {
        cutVReads += 1;
        return false;
      },
      get cutH() {
        cutHReads += 1;
        return false;
      },
      get allowRotate() {
        allowRotateReads += 1;
        return true;
      },
      gripper: 20,
      gap: 3,
    } as ImpositionInput;

    const result = computeImposition(hostile);
    expect(cutVReads).toBe(1);
    expect(cutHReads).toBe(1);
    expect(allowRotateReads).toBe(1);
    expect(result).toEqual(
      computeImposition({
        pieceW: 233.2,
        pieceH: 251,
        paperW: 787,
        paperH: 1092,
        orientation: 'portrait',
        cutV: false,
        cutH: false,
        allowRotate: true,
        gripper: 20,
        gap: 3,
      }),
    );
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
        cutV: false,
        cutH: false,
        allowRotate: false,
        gripper: 20,
        get gap() {
          gapReads += 1;
          return gapReads === 1 ? 3 : Infinity;
        },
      } as ImpositionInput;

      const result = computeImposition(hostile);
      expect(gapReads).toBe(1);
      expect(result).toEqual(computeImposition(BASE_INPUT));
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

describe('isFiniteStripFill（Fix 3·gate round 1 T1 review Low：export 供獨立測試——原本是私有 helper，只能透過 isFiniteDirectionResult／computeImposition 間接測，正常輸入路徑必然餵 finite 值，把這個呼叫刪掉測試也照樣綠、無鑑別力；export 後逐欄注入 NaN/Infinity 直接斷言拒絕）', () => {
  const VALID_FILL: StripFill = { cols: 2, rows: 3, count: 6 };

  it('null 是合法值（fillSplit=null 時兩 fill 皆為 null）→ 視為通過', () => {
    expect(isFiniteStripFill(null)).toBe(true);
  });

  it('三欄皆 finite → 通過', () => {
    expect(isFiniteStripFill(VALID_FILL)).toBe(true);
  });

  it('cols 為 NaN → 拒絕', () => {
    expect(isFiniteStripFill({ ...VALID_FILL, cols: NaN })).toBe(false);
  });

  it('rows 為 Infinity → 拒絕', () => {
    expect(isFiniteStripFill({ ...VALID_FILL, rows: Infinity })).toBe(false);
  });

  it('count 為 NaN → 拒絕', () => {
    expect(isFiniteStripFill({ ...VALID_FILL, count: NaN })).toBe(false);
  });
});
