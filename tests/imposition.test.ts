import { describe, expect, it } from 'vitest';
import {
  computeImposition,
  fitCount,
  resolveWorkingSheet,
  PAPER_PRESETS,
  FIT_EPSILON_MM,
  MAX_PREVIEW_INSTANCES,
  MIN_GAP_MM,
} from '@/core/imposition';
import type { ImpositionInput, ImpositionResult, SheetMode, SheetOrientation } from '@/core/imposition';

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
  const MODES: readonly SheetMode[] = ['full', 'halfV', 'halfH'];

  const randomCases = Array.from({ length: 10 }, (_, i) => {
    const input: ImpositionInput = {
      pieceW: between(20, 150),
      pieceH: between(20, 150),
      paperW: between(400, 1200),
      paperH: between(400, 1200),
      orientation: rng() < 0.5 ? 'portrait' : 'landscape',
      mode: MODES[Math.floor(rng() * MODES.length)]!,
      gripper: between(0, 30),
      gap: between(3, 10),
    };
    return { i, input };
  });

  it.each(randomCases)('第 $i 組：deg90 等於 pieceW/pieceH 互換後的 deg0', ({ input }) => {
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
});

describe('computeImposition — 計算矩陣（portrait/landscape × full/halfV/halfH 六組合）', () => {
  // 手算基準（見 task-2-report.md 手算過程）：paperW=787,paperH=1092／piece 100×140／
  // 咬口 20／gap 3。expected 由 resolveWorkingSheet 轉換鏈＋fitCount 公式手算，
  // 不得由被測函式導出（防自我循環）。
  const piece = { pieceW: 100, pieceH: 140 };
  const commonFields = { paperW: 787, paperH: 1092, gripper: 20, gap: 3 };

  const cases: Array<{
    orientation: SheetOrientation;
    mode: SheetMode;
    deg0: { cols: number; rows: number; count: number };
    deg90: { cols: number; rows: number; count: number };
  }> = [
    { orientation: 'portrait', mode: 'full', deg0: { cols: 7, rows: 7, count: 49 }, deg90: { cols: 5, rows: 10, count: 50 } },
    { orientation: 'portrait', mode: 'halfV', deg0: { cols: 3, rows: 7, count: 21 }, deg90: { cols: 2, rows: 10, count: 20 } },
    { orientation: 'portrait', mode: 'halfH', deg0: { cols: 7, rows: 3, count: 21 }, deg90: { cols: 5, rows: 4, count: 20 } },
    { orientation: 'landscape', mode: 'full', deg0: { cols: 10, rows: 5, count: 50 }, deg90: { cols: 7, rows: 7, count: 49 } },
    { orientation: 'landscape', mode: 'halfV', deg0: { cols: 4, rows: 5, count: 20 }, deg90: { cols: 3, rows: 7, count: 21 } },
    { orientation: 'landscape', mode: 'halfH', deg0: { cols: 10, rows: 2, count: 20 }, deg90: { cols: 7, rows: 3, count: 21 } },
  ];

  it.each(cases)('$orientation × $mode', ({ orientation, mode, deg0, deg90 }) => {
    const result = computeImposition({ ...piece, ...commonFields, orientation, mode });
    assertOk(result);
    expect(result.deg0).toMatchObject(deg0);
    expect(result.deg90).toMatchObject(deg90);
  });

  it('三個 preset 各驗一個實際案例（787×1092 已於上方六組合覆蓋，這裡補 635×889／686×991）', () => {
    const r635 = computeImposition({ ...piece, paperW: 635, paperH: 889, gripper: 20, gap: 3, orientation: 'portrait', mode: 'full' });
    assertOk(r635);
    // usable = 635-40=595, 889-40=849；cols=fitCount(595,100,3)=5(5*100+4*3=512<=595,6*100+5*3=615>595)
    // rows=fitCount(849,140,3)=5(5*140+4*3=712<=849,6*140+5*3=855>849)
    expect(r635.deg0).toMatchObject({ cols: 5, rows: 5, count: 25 });

    const r686 = computeImposition({ ...piece, paperW: 686, paperH: 991, gripper: 20, gap: 3, orientation: 'portrait', mode: 'full' });
    assertOk(r686);
    // usable = 686-40=646, 991-40=951；cols=fitCount(646,100,3)=6(6*100+5*3=615<=646,7*100+6*3=718>646)
    // rows=fitCount(951,140,3)=6(6*140+5*3=855<=951,7*140+6*3=998>951)
    expect(r686.deg0).toMatchObject({ cols: 6, rows: 6, count: 36 });
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
});
