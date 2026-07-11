import { describe, expect, it } from 'vitest';
import {
  computeImposition,
  fitCount,
  fitCountStride,
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
import { computeProfileStrides, manufacturingPaths, type ProfileStrides } from '@/core/profile';
import type { Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import productionPRaw from './fixtures/telescope-production-P.json';

// profile-spacing slice（docs/specs/2026-07-11-imposition-profile-spacing.md）：`shrunk`
// 輸入的 ProfileStrides 唯一合法產地是 `computeProfileStrides`（見該函式所在模組的
// docblock），這裡沿用 tests/profile.test.ts 已建立的 fixture 慣例（讀既有 JSON、不手打
// 第二份參數字面量）取得 telescope production-P 的 `.params`。
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

function productionPParams(): ProductionPParams {
  return (productionPRaw as { params: ProductionPParams }).params;
}

// 純函式測試——只吃/吐數字，不碰 boxes/*、manufacturingBounds（那是 imposition-anchor.test.ts
// 的整合錨職責，見 開發紀錄 介面說明「Consumes: manufacturingBounds（僅整合測試消費；
// 純函式只吃數字）」）。

/** ok:true 窄化＋失敗時把 errors 印進錯誤訊息，方便測試失敗時直接看到原因。 */
function assertOk(result: ImpositionResult): asserts result is Extract<ImpositionResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`預期 ok:true，但收到 errors：${JSON.stringify(result.errors)}`);
  }
}

// 數值錨的基準輸入（gate round 1 開發紀錄 附錄）：RTE 預設參數的製造 bounds 233.2×251，
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

describe('fitCountStride（profile-spacing spec F2：fitCount 的單一 stride 核心，fitCount 委託此函式）', () => {
  it('n 件放得下的一般公式：piece+(n-1)*stride ≤ available+eps——件寬 30、stride 40（非 piece+gap 的任意 stride）、available 190', () => {
    // 4 件：30+3*40=150≤190；5 件：30+4*40=190≤190（恰好，exact-fit）；6 件：30+5*40=230>190。
    expect(fitCountStride(190, 30, 40)).toBe(5);
  });

  it('略小於 exact-fit（−1e-3）→ 少一件；略大於 exact-fit（+1e-3）→ 仍同一件數（epsilon 防浮點誤判，同 fitCount 的 30/3.1/228.6 案例精神）', () => {
    expect(fitCountStride(190 - 1e-3, 30, 40)).toBe(4);
    expect(fitCountStride(190 + 1e-3, 30, 40)).toBe(5);
  });

  it('首件邊界：available+FIT_EPSILON_MM<piece → 0（spec F2 明文公式，非「available>0」這種寬鬆判準）', () => {
    expect(fitCountStride(29.999, 30, 40)).toBe(0); // 29.999+1e-6 仍 < 30
    expect(fitCountStride(30, 30, 40)).toBe(1); // 恰好 1 件
  });

  it('available／piece 非正 → 0（與 fitCount 既有語意一致）', () => {
    expect(fitCountStride(0, 30, 40)).toBe(0);
    expect(fitCountStride(-10, 30, 40)).toBe(0);
    expect(fitCountStride(100, 0, 40)).toBe(0);
    expect(fitCountStride(100, -5, 40)).toBe(0);
  });

  describe('stride 非正/非 finite 直呼防禦（spec 明文要求——這是 fitCountStride 相對 fitCount 新增的攻擊面：fitCount 委託時 stride=piece+gap 恆為正，但 fitCountStride 本身是公開函式，呼叫端可能直接餵 domain 驗證前的 shrunk.strideY）', () => {
    it('stride=0 → 0（不掛起：piece+(k-1)*0 不隨 k 增長，若無防禦「多一件就超額」的修正迴圈找不到終止點）', () => {
      const start = Date.now();
      expect(fitCountStride(1000, 30, 0)).toBe(0);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('stride 為負值 → 0（不掛起：piece+(k-1)*stride 隨 k 遞減，同上風險）', () => {
      const start = Date.now();
      expect(fitCountStride(1000, 30, -5)).toBe(0);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('stride=NaN → 0（不掛起）', () => {
      const start = Date.now();
      expect(fitCountStride(1000, 30, NaN)).toBe(0);
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('stride=Infinity → 0（不掛起；亦避免 (k-1)*Infinity 在 k=1 算出 0*Infinity=NaN 汙染 fits(1)）', () => {
      const start = Date.now();
      expect(fitCountStride(1000, 30, Infinity)).toBe(0);
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });

  describe('available=Infinity／極端量級（與既有 fitCount 的 review F1 反例同構，證明 fitCountStride 本身承接了無進展防護，不是只靠 fitCount 的委託關係間接受益）', () => {
    it('available=Infinity、正常 stride → 不掛起，回傳 Infinity（fits(k) 對任意有限 k 恆真，n 收斂在浮點無法再遞增之處）', () => {
      const start = Date.now();
      const result = fitCountStride(Infinity, 30, 40);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(result).toBe(Infinity);
    });

    it('available=1e20（IEEE-754 n+1===n 精度極限）→ 不掛起，回傳 finite', () => {
      const start = Date.now();
      const result = fitCountStride(1e20, 1, 4);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(Number.isFinite(result)).toBe(true);
    });
  });
});

describe('fitCount／fitCountStride — 委託等價 property 邊界抽測（spec 驗收 4：available=piece±{0.5,1,1.5}×FIT_EPSILON_MM）', () => {
  // 件 100、gap 5（stride=105）——刻意選不會讓「多 1 件」的門檻落在這幾個 epsilon 抖動範圍
  // 內的尺寸（下一件需要再 +105mm 可用區，遠大於幾個 μm 等級的 epsilon 抖動），確保這裡量的
  // 純粹是「首件邊界」本身的正確性，不與「第二件邊界」混在一起看。
  const piece = 100;
  const gap = 5;
  const stride = piece + gap;

  const boundaryCases: Array<{ label: string; epsMultiple: number; expectedN: number }> = [
    { label: 'piece−1.5ε → 0（首件邊界外側）', epsMultiple: -1.5, expectedN: 0 },
    { label: 'piece−1ε → 1（恰在既有 fitCount 語意的邊界上，接受）', epsMultiple: -1, expectedN: 1 },
    { label: 'piece−0.5ε → 1（spec F2 明文案例：既有實作接受，新式不得回 0）', epsMultiple: -0.5, expectedN: 1 },
    { label: 'piece+0.5ε → 1', epsMultiple: 0.5, expectedN: 1 },
    { label: 'piece+1ε → 1', epsMultiple: 1, expectedN: 1 },
    { label: 'piece+1.5ε → 1', epsMultiple: 1.5, expectedN: 1 },
  ];

  it.each(boundaryCases)('$label', ({ epsMultiple, expectedN }) => {
    const available = piece + epsMultiple * FIT_EPSILON_MM;
    expect(fitCountStride(available, piece, stride)).toBe(expectedN);
    expect(fitCount(available, piece, gap)).toBe(expectedN); // 委託等價：同一批邊界值兩函式逐字同答案
  });
});

describe('computeImposition — 數值錨（開發紀錄 附錄數值錨表 7 列，expected 硬編碼、不由被測函式導出）', () => {
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

  // 7 列逐列獨立驗算＋review plan review 交叉（見 開發紀錄 附錄；第 4 列由 review 雙分割反例
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
      label: '直放·整紙·90° 主·開轉（review 雙分割反例：right-full 的右側全高條帶能多塞一整排）',
      orientation: 'portrait', cutV: false, cutH: false, allowRotate: true, dir: 'deg90',
      cols: 2, rows: 4, gridCount: 8,
      fillSplit: 'right-full',
      bottomFill: { cols: 2, rows: 0, count: 0 },
      rightFill: { cols: 1, rows: 4, count: 4 },
      count: 12, totalCount: 12, utilization: 0.8173,
    },
    {
      label: '橫放·整紙·0° 主·開轉（gate 驗收反饋實證：下方空白可放 4 模卻沒算進去）',
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
  // 手算基準（見 開發紀錄 手算過程／review 手算抽驗，cols/rows/count 已驗證）：
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
    // final review review Minor：spec delta 要 8 組（原本 6 組只覆蓋 full/cutV/cutH 三種裁切，
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

describe('computeImposition — L 形補排極端/退化分支（開發紀錄 RED 項目①-⑧：既有極端測試全走 allowRotate=false，新分支需自己的驗收保護）', () => {
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

// ─────────────────────────────────────────────────────────────────────────
// profile-spacing slice（docs/specs/2026-07-11-imposition-profile-spacing.md）
// T2：core/imposition.ts 改造——shrunk 輸入、擇優、新輸出欄位。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 人造 Z-notch 幾何（T2 開工探針 `開發紀錄` 的正式版本，
 * 完整推導記 開發紀錄）：8 段 line 的矩形多邊形，bounds W=50×H=200。
 *   - 左段（x∈[0,10)）：材料 y∈[0,140]（頂到 y=0，未頂到 y=200）
 *   - 中段（x∈[10,40)）：材料 y∈[60,140]（純矩形 body，兩端皆未頂到邊界）
 *   - 右段（x∈(40,50]）：材料 y∈[60,200]（頂到 y=200，未頂到 y=0）
 * 任一欄都不同時頂到 y=0 與 y=200（避免單欄 same-slot 項本身就等於矩形上界 H+gap）——
 * strideY 因此有真實收縮空間；中段的兩條水平邊本身橫跨整個 x∈[0,60]，使 strideX 的
 * same-slot 項在中段恰為矩形上界（W+gap），無收縮空間可言。一軸真收縮、另一軸恆等於
 * 矩形，刻意設計成能乾淨區分「行縮／列縮」兩案，不互相汙染。
 *
 * RTE 真實幾何在任何紙規／方向／裁切組合下皆無法產生正數補排（獨立推導＋探針交叉驗證，
 * 見 開發紀錄「RTE 為何做不到正數補排」）：貪婪排列後的殘留空間恆 < 該軸實際
 * 採用的 stride（否則多排一件），而 RTE 的 W≈233.2／H≈251 太接近（長寬比 1.076），
 * 旋轉件所需的另一維度恆大於任一軸 stride，數學上不可能有正數補排——這正是 spec
 * 「其他 preset 或人造紙規找不到」時退回人造 fixture 的情況。本形狀的 W=50／H=200
 * （4 倍長寬比）刻意拉大差距解決這個問題。
 */
const Z_NOTCH_SEGMENTS: Segment[] = [
  { kind: 'line', x1: 0, y1: 140, x2: 40, y2: 140 },
  { kind: 'line', x1: 40, y1: 140, x2: 40, y2: 200 },
  { kind: 'line', x1: 40, y1: 200, x2: 50, y2: 200 },
  { kind: 'line', x1: 50, y1: 200, x2: 50, y2: 60 },
  { kind: 'line', x1: 50, y1: 60, x2: 10, y2: 60 },
  { kind: 'line', x1: 10, y1: 60, x2: 10, y2: 0 },
  { kind: 'line', x1: 10, y1: 0, x2: 0, y2: 0 },
  { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 140 },
];
const Z_NOTCH_GAP = 3;

/** 人造紙規（不對應任何 PAPER_PRESETS，landscape 正規化＋gripper=0 後 usableW=450／
 *  usableH=446）——尺寸選擇見 開發紀錄「正數補排案例」節的完整推導。 */
const POSITIVE_FILL_INPUT: ImpositionInput = {
  pieceW: 50,
  pieceH: 200,
  paperW: 450,
  paperH: 446,
  orientation: 'landscape',
  cutV: false,
  cutH: false,
  allowRotate: true,
  gripper: 0,
  gap: Z_NOTCH_GAP,
};

/** 產一個與 BASE_INPUT 同尺規、但開轉（L 形補排路徑）的輸入——domain 驗證測試的 shrunk
 *  組合大多刻意選在合法範圍內的數值，只讓「被測的那一條」規則觸發，不順帶啟用/停用其他
 *  分支，故 allowRotate 本身在這組測試裡不影響結果（domain 錯誤在算 sheet/direction 之前
 *  就短路），這裡開著純粹貼近真實呼叫情境。 */
const SHRUNK_DOMAIN_BASE_INPUT: ImpositionInput = { ...BASE_INPUT, allowRotate: true };

function syntheticRect(w: number, h: number): Segment[] {
  return [
    { kind: 'line', x1: 0, y1: 0, x2: w, y2: 0 },
    { kind: 'line', x1: w, y1: 0, x2: w, y2: h },
    { kind: 'line', x1: w, y1: h, x2: 0, y2: h },
    { kind: 'line', x1: 0, y1: h, x2: 0, y2: 0 },
  ];
}

describe('computeImposition — shrunk domain 驗證（profile-spacing spec F2b）', () => {
  it('shrunk 完全省略、與明確傳 undefined，逐字相同（spec F2b「只有 undefined 是缺省語意」——省略欄位與明確給 undefined 是同一件事，不是兩種不同狀態）', () => {
    const omitted = computeImposition(BASE_INPUT);
    const explicit = computeImposition({ ...BASE_INPUT, shrunk: undefined });
    expect(explicit).toEqual(omitted);
  });

  it('shrunk.gap !== input.gap → domain error field:gap（spec F2b v1.2·M2 機械驗證「這個 stride 是用哪個 gap 算的」；用不相關的 10×10 矩形建 shrunk，算出的 strideX/strideY=14 本身落在合法範圍內，隔離只讓 gap 不一致這一條觸發）', () => {
    const mismatchedGapShrunk = computeProfileStrides(syntheticRect(10, 10), 4); // input.gap 是 3
    const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: mismatchedGapShrunk });
    expect(result).toEqual({ ok: false, errors: [{ field: 'gap', reason: 'out-of-range' }] });
  });

  it('shrunk.strideX 超出矩形上界 → domain error field:shrunkStrideX（500×10 矩形、gap=3 與 input.gap 一致：strideX=503 遠超 pieceW(233.2)+gap+eps；strideY=13 遠低於 pieceH(251)+gap+eps，隔離只驗 X 軸）', () => {
    const bigXShrunk = computeProfileStrides(syntheticRect(500, 10), 3);
    const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: bigXShrunk });
    expect(result).toEqual({ ok: false, errors: [{ field: 'shrunkStrideX', reason: 'out-of-range' }] });
  });

  it('shrunk.strideY 超出矩形上界 → domain error field:shrunkStrideY（對稱案例：10×500 矩形）', () => {
    const bigYShrunk = computeProfileStrides(syntheticRect(10, 500), 3);
    const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: bigYShrunk });
    expect(result).toEqual({ ok: false, errors: [{ field: 'shrunkStrideY', reason: 'out-of-range' }] });
  });

  it('shrunk 的 gap 為 NaN（computeProfileStrides 本身不驗證 gap——T1 紀錄 記錄的既知殘留邊界，職責歸本輪；onlyAxis="y" 讓 strideX 明確 undefined，隔離只留一條 stride 錯誤）→ gap 不一致＋shrunkStrideY:not-finite 兩條並存（逐欄收集，非找到第一個就停）', () => {
    // gap=NaN 使 computeMinStride 內層迴圈找不到任何「兩者皆有限」的槽對候選，clamp 到
    // Math.max(NaN,0)=NaN——算出的 strideY 也是 NaN。NaN!==input.gap(3) 同時觸發「gap 不
    // 一致」；strideX 因 onlyAxis='y' 明確 undefined，不參與 X 軸檢查（缺省語意，非錯誤）。
    const nanShrunk = computeProfileStrides(syntheticRect(10, 10), NaN, 'y');
    const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: nanShrunk });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const asSet = new Set(result.errors.map((e) => `${e.field}:${e.reason}`));
      expect(asSet).toEqual(new Set(['gap:out-of-range', 'shrunkStrideY:not-finite']));
      expect(result.errors).toHaveLength(2);
    }
  });

  it('shrunk=null（型別繞過——ProfileStrides 是 opaque class，正常 TS 呼叫端不可能傳 null，這裡刻意脫離型別系統驗證 runtime 不崩潰、不是靜默當缺省處理）→ domain error field:shrunk', () => {
    const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: null as unknown as ProfileStrides });
    expect(result).toEqual({ ok: false, errors: [{ field: 'shrunk', reason: 'not-finite' }] });
  });

  it('onlyAxis 單軸缺省①：Y 軸真的有收縮但被 onlyAxis="x" 丟棄（只留 X，X 本來就等於矩形）→ 結果退化到「完全無 shrunk」的基線（證明被丟棄的軸真的回退矩形，不是誤用了另一軸的值）', () => {
    const znotchOnlyX = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP, 'x');
    const withOnlyX = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: znotchOnlyX });
    const withoutShrunk = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: undefined });
    expect(withOnlyX).toEqual(withoutShrunk);
  });

  it('onlyAxis 單軸缺省②：X 軸被 onlyAxis="y" 丟棄，但 X 本來就等於矩形（丟不丟都一樣）→ 結果與兩軸皆傳入逐字相同（證明缺省機制本身正確，不是巧合對上——丟棄一個「反正沒差」的軸不該改變任何數字）', () => {
    const znotchOnlyY = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP, 'y');
    const withOnlyY = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: znotchOnlyY });
    const withFullBothAxes = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP) });
    expect(withOnlyY).toEqual(withFullBothAxes);
  });

  describe('snapshot（shrunk 的 gap/strideX/strideY 三值恰讀一次進快照，同既有 gap/cutV 等欄位先例）', () => {
    it('三個 getter 各恰讀一次，且讀到的值正確參與計算（與等值的真實 ProfileStrides 呼叫結果逐字相同）', () => {
      // 232×197 矩形、gap=3 → strideX=235／strideY=200（皆落在合法範圍內，見上方 checkShrunkAxis 註解的界公式）。
      const plainEquivalent = computeProfileStrides(syntheticRect(232, 197), 3);
      let gapReads = 0;
      let strideXReads = 0;
      let strideYReads = 0;
      const hostile = {
        get gap() {
          gapReads += 1;
          return 3;
        },
        get strideX() {
          strideXReads += 1;
          return 235;
        },
        get strideY() {
          strideYReads += 1;
          return 200;
        },
      } as unknown as ProfileStrides;

      const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: hostile });
      expect(gapReads).toBe(1);
      expect(strideXReads).toBe(1);
      expect(strideYReads).toBe(1);
      expect(result).toEqual(computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: plainEquivalent }));
    });

    it('gap getter 第一次讀回 3（通過一致性檢查）、之後回 999——snapshot 保證計算只用第一次讀到的值（re-review 反例固化：同既有 input.gap 攻擊構造同一份紀律，見 computeImposition docblock）', () => {
      let gapReads = 0;
      const hostile = {
        get gap() {
          gapReads += 1;
          return gapReads === 1 ? 3 : 999;
        },
        strideX: 235,
        strideY: 200,
      } as unknown as ProfileStrides;

      const result = computeImposition({ ...SHRUNK_DOMAIN_BASE_INPUT, shrunk: hostile });
      expect(gapReads).toBe(1);
      // 若 gap 被重複讀取到 999，999!==input.gap(3) 會誤報「gap 不一致」——快照保護下
      // 應該只讀一次拿到 3，正常通過驗證走到 ok:true。
      expect(result.ok).toBe(true);
    });
  });
});

describe('computeImposition — RTE 錨（27"×39" 直放·咬口 20·gap 3·profile-aware 收縮，profile-spacing spec 驗收 1/2/6）', () => {
  const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
  const rteSegments = manufacturingPaths(rteResult).flatMap((p) => p.segments);
  const rteBounds = segmentsBounds(rteSegments);
  // 程式化派生 pieceW/pieceH（不手打 233.2/251）——與 shrunk 算自同一份幾何，貼近 spec F2b
  // 呼叫鏈「算 pieceW/pieceH 與 ProfileStrides 後傳入」的真實用法，避免手打值與幾何實際
  // bounds 有微小落差時兩者不同步（這正是 shrunk.gap 一致性檢查要防的同一類事故，這裡在
  // 測試端也依樣避免）。
  const pieceW = rteBounds.maxX - rteBounds.minX;
  const pieceH = rteBounds.maxY - rteBounds.minY;
  const gap = 3;
  const shrunk = computeProfileStrides(rteSegments, gap);

  const rteInput: ImpositionInput = {
    pieceW,
    pieceH,
    paperW: 686,
    paperH: 991, // PAPER_PRESETS 的 '27x39'
    orientation: 'portrait',
    cutV: false,
    cutH: false,
    allowRotate: true,
    gripper: 20,
    gap,
    shrunk,
  };

  it('0°：行縮擇優，主格點 2×4=8（strideY 收縮把 rows 從矩形排列的 3 撐到 4；strideX 恆等於矩形——RTE 左右緣平直豎線，無收縮空間）', () => {
    const result = computeImposition(rteInput);
    assertOk(result);
    expect(result.deg0).toMatchObject({
      cols: 2,
      rows: 4,
      gridCount: 8,
      count: 8,
      totalCount: 8,
      spacingAxis: 'rows',
      strideX: 236.2, // =矩形 W+gap（233.2+3），未收縮向
      usedW: 469.4, // =2×233.2+1×3（矩形 stride）
    });
    expect(result.deg0.strideY).toBe(shrunk.strideY); // 逐位元＝shrunk 實際算出的值，不是另一個重算出的數字
    expect(result.deg0.strideY).toBeCloseTo(194.825, 2); // T1 紀錄 獨立重導值（見 tests/profile.test.ts 同一錨）
    expect(result.deg0.usedH).toBeCloseTo(pieceH + 3 * shrunk.strideY!, 6); // n=4→piece+(4-1)×stride
    expect(result.deg0.utilization).toBeCloseTo(0.6888, 4);
  });

  it('90°：列縮擇優，主格點 3×4=12（stride 兩軸對調——cols 軸這次用的是原 strideY，rows 軸用原 strideX＝矩形）', () => {
    const result = computeImposition(rteInput);
    assertOk(result);
    expect(result.deg90).toMatchObject({
      cols: 3,
      rows: 4,
      gridCount: 12,
      count: 12,
      totalCount: 12,
      spacingAxis: 'cols',
      strideY: 236.2, // 矩形——對調後這一卡的 rows 軸用的是原 strideX 那個數字
      usedH: 941.8, // =4×233.2+3×3（矩形 stride）
    });
    expect(result.deg90.strideX).toBe(shrunk.strideY); // 對調：cols 軸這次用的是原 strideY
    expect(result.deg90.usedW).toBeCloseTo(pieceH + 2 * shrunk.strideY!, 6); // n=3→piece+(3-1)×stride
    // >1：矩形互疊可逾 100%（spec F6 明文的既知現象「RTE 90°＝103.3%」附近，非 bug；
    // 收縮排列下鄰行/鄰列的外接矩形本來就會互相重疊，utilization 分子仍用矩形面積計算）。
    expect(result.deg90.utilization).toBeCloseTo(1.0332, 4);
    expect(result.deg90.utilization).toBeGreaterThan(1);
  });

  it('兩方向補排皆為 0（spec 驗收 6：該紙規條帶不足容納旋轉件，程式化驗證條帶尺寸本身而不只驗 count）', () => {
    const result = computeImposition(rteInput);
    assertOk(result);
    expect(result.deg0.bottomFill?.count).toBe(0);
    expect(result.deg0.rightFill?.count).toBe(0);
    expect(result.deg90.bottomFill?.count).toBe(0);
    expect(result.deg90.rightFill?.count).toBe(0);

    // 親算條帶尺寸（見 開發紀錄 完整推導）：spec 源起表的「173.6/116.3」「4.9/6.2」
    // 是用探針 v2 的舊 strideY=193.57 算的（spec v1.2·H 已明文降級該探針值為機制參考、
    // 非實作值的界）；這裡用 T1 實作的真實 strideY（194.825...）重新推導右條帶寬與
        // 底條帶高，量級與方向一致（皆遠小於旋轉件所需的另一維度），結論不變——不是巧合對上
    // 探針的舊數字，是用真正的實作值獨立驗證過。
    const usableW = 646; // 686-2×20
    const usableH = 951; // 991-2×20
    const rightStrip0 = usableW - result.deg0.usedW - gap;
    const bottomStrip0 = usableH - result.deg0.usedH - gap;
    expect(rightStrip0).toBeLessThan(pieceH); // ≈173.6<251：容不下旋轉件所需寬度
    expect(bottomStrip0).toBeLessThan(pieceW); // ≈112.5<233.2：容不下旋轉件所需高度

    const rightStrip90 = usableW - result.deg90.usedW - gap;
    const bottomStrip90 = usableH - result.deg90.usedH - gap;
    expect(rightStrip90).toBeLessThan(pieceH); // ≈2.35<251
    expect(bottomStrip90).toBeLessThan(pieceW); // ≈6.2<233.2
  });
});

describe('computeImposition — telescope 退化（shrunk 提供但零收益，與省略 shrunk 逐字相同；spec 驗收 3 的延伸——額外驗證「傳入零收益 shrunk」路徑，不只驗「完全省略」路徑）', () => {
  const productionP = productionPParams();
  const teleResult = telescope.generate(resolveParams(telescope, productionP));
  const basePiece = teleResult.pieces!.find((p) => p.id === 'base')!;
  const baseSegments = manufacturingPaths(teleResult, basePiece).flatMap((p) => p.segments);
  const baseBounds = segmentsBounds(baseSegments);
  const pieceW = baseBounds.maxX - baseBounds.minX;
  const pieceH = baseBounds.maxY - baseBounds.minY;
  const gap = 3;
  const shrunk = computeProfileStrides(baseSegments, gap);

  const teleInput: ImpositionInput = {
    pieceW,
    pieceH,
    paperW: 1200,
    paperH: 1200, // 人造大紙規（不對應任何 preset），純粹確保放得下數件，讓 L 形補排路徑一併退化
    orientation: 'portrait',
    cutV: false,
    cutH: false,
    allowRotate: true,
    gripper: 10,
    gap,
  };

  it('十字形件（telescope base）的 shrunk 兩軸皆退化為矩形——傳入 shrunk 與完全省略，computeImposition 完整結果（含 L 形補排、新四欄）逐字相同', () => {
    const withShrunk = computeImposition({ ...teleInput, shrunk });
    const withoutShrunk = computeImposition({ ...teleInput, shrunk: undefined });
    expect(withShrunk).toEqual(withoutShrunk);
  });

  it('spacingAxis 兩方向皆 null（零收益，不因 tie-break 內部確定性選了行縮候選就誤標成「有收縮」）', () => {
    const result = computeImposition({ ...teleInput, shrunk });
    assertOk(result);
    expect(result.deg0.spacingAxis).toBeNull();
    expect(result.deg90.spacingAxis).toBeNull();
    expect(result.deg0.strideX).toBeCloseTo(pieceW + gap, 6);
    expect(result.deg0.strideY).toBeCloseTo(pieceH + gap, 6);
    expect(result.deg90.strideX).toBeCloseTo(pieceH + gap, 6);
    expect(result.deg90.strideY).toBeCloseTo(pieceW + gap, 6);
  });
});

describe('computeImposition — 正數補排案例（人造 Z-notch 幾何，profile-spacing spec 驗收 6：收縮主格點＋條帶補排並存）', () => {
  const shrunk = computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP);

  it('探針錨：strideX=53（=矩形 50+3，無收縮）／strideY=143（<矩形 200+3=203，真實收縮 60mm）', () => {
    expect(shrunk.strideX).toBe(53);
    expect(shrunk.strideY).toBe(143);
  });

  it('0°：行縮擇優（strideY=143），gridCount 與「無 shrunk」基線打平（8×2=16）但底條帶多補 2 件（count=18>16）——直接證明 spec F3「比最終 count 不只比 gridCount」的必要性：只看 gridCount 這裡會判兩案平手、漏掉收縮案真正勝出的理由', () => {
    const withShrunk = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    const baseline = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: undefined });
    assertOk(withShrunk);
    assertOk(baseline);

    expect(withShrunk.deg0.gridCount).toBe(baseline.deg0.gridCount); // 16=16，gridCount 打平
    // toMatchObject 逐欄核對（不用 toEqual）：utilization 是浮點除法結果，另外用
    // toBeCloseTo 斷言（見下一行）——這裡列出 DirectionResult 除 utilization 外的全部
    // 12 個欄位，鑑別力等同 toEqual 排除 utilization 這一欄。
    expect(withShrunk.deg0).toMatchObject({
      cols: 8,
      rows: 2,
      gridCount: 16,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 2, rows: 1, count: 2 }, // 收縮版：底條帶（100mm 高）放得下 2 件旋轉件
      rightFill: { cols: 0, rows: 6, count: 0 },
      count: 18,
      totalCount: 18,
      spacingAxis: 'rows',
      strideX: 53,
      strideY: 143,
      usedW: 421,
      usedH: 343,
    });
    expect(withShrunk.deg0.utilization).toBeCloseTo(0.8969, 4);

    expect(baseline.deg0).toMatchObject({
      cols: 8,
      rows: 2,
      gridCount: 16,
      bottomFill: { cols: 2, rows: 0, count: 0 }, // 矩形版：底條帶只有 40mm 高（<50mm 需求），補排 0
      count: 16,
      totalCount: 16,
      spacingAxis: null,
    });
    expect(withShrunk.deg0.count).toBeGreaterThan(baseline.deg0.count); // 18>16——收縮讓補排「多出」的件數，不是 gridCount 本身變多
  });

  it('90°：列縮擇優（cols 軸用原 strideY=143），gridCount 與基線打平（2×8=16）但右條帶多補 4 件（count=20>16）——同一組輸入的另一方向也成立，證明擇優邏輯不是只在某個特定軸向湊巧成立', () => {
    const withShrunk = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    const baseline = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk: undefined });
    assertOk(withShrunk);
    assertOk(baseline);

    expect(withShrunk.deg90.gridCount).toBe(baseline.deg90.gridCount); // 16=16
    expect(withShrunk.deg90).toMatchObject({
      cols: 2,
      rows: 8,
      gridCount: 16,
      fillSplit: 'bottom-full',
      bottomFill: { cols: 8, rows: 0, count: 0 },
      rightFill: { cols: 2, rows: 2, count: 4 }, // 收縮版：右條帶（104mm 寬）放得下 4 件旋轉件
      count: 20,
      totalCount: 20,
      spacingAxis: 'cols',
      strideX: 143,
      strideY: 53,
      usedW: 343,
      usedH: 421,
    });
    expect(withShrunk.deg90.utilization).toBeCloseTo(0.9965, 4);

    expect(baseline.deg90).toMatchObject({
      cols: 2,
      rows: 8,
      gridCount: 16,
      rightFill: { cols: 0, rows: 2, count: 0 }, // 矩形版：右條帶只有 44mm 寬（<200mm 需求），補排 0
      count: 16,
      totalCount: 16,
      spacingAxis: null,
    });
    expect(withShrunk.deg90.count).toBeGreaterThan(baseline.deg90.count); // 20>16
  });

  it('間距不變式的最小驗證：收縮後主格點兩軸 stride 皆 ≥ gap（幾何級的完整不變式證明是 T5 職責，這裡只驗本輪 輸出的欄位本身沒有低於物理下限——真正撞刀的數字不可能通過這條檢查）', () => {
    const result = computeImposition({ ...POSITIVE_FILL_INPUT, shrunk });
    assertOk(result);
    expect(result.deg0.strideX).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
    expect(result.deg0.strideY).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
    expect(result.deg90.strideX).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
    expect(result.deg90.strideY).toBeGreaterThanOrEqual(Z_NOTCH_GAP);
  });
});
