// normalized 慣例層固定矩陣 membership、81 點 C 掃描、容差與 G3 cap。
// 觀測慣例層：閘門直接讀 FoldModel 的真 panel/FK 與 generator 現場幾何。
import { describe, expect, it } from 'vitest';
import { A_GUSSET_FIXED_NOMINAL_A_MM } from '@/boxes/telescope/tray';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';
import type { FoldModel } from '@/fold/types';
import { foldPose } from '@/fold/schedule';
import { worldGeometry } from '@/fold/pose3d';
import {
  exactSetMismatch,
  familyTopologyViolations,
  halfTurnDirectionViolations,
  hookRootStripWithinBounds,
  telescopeCollisionViolations,
  telescopeGateReport,
  trayWindowOrderViolations,
} from '../helpers/telescope-gates';

type Overrides = Record<string, number | boolean>;

/**
 * 每片預期的**角鎖家族**。值取自實測（逐列 dump），不是推測。
 *
 * 為什麼要逐列宣告：閘門在域內沒有目標物時會靜默回空集，報告上與「跑過且通過」同值；
 * 而「空集須先證 count=0」只擋得住偵測邏輯壞掉（正則改壞卻仍有 panel），
 * 擋不住「這一列本來該有這族、結果整族沒生成」——那時 count 真的是 0，證明照樣通過。
 * 只有把預期寫成資料，家族憑空消失才會有訊號。
 */
type CornerLock = 'flap' | 'extension' | 'none';

const LEGAL_ROWS: Array<{
  caseId: string;
  delta: Overrides;
  fired: string[];
  corners: Record<string, CornerLock>;
}> = [
  { caseId: 'M-01', delta: {}, fired: [], corners: { base: 'flap', lid: 'extension' } },
  { caseId: 'M-02', delta: { linerEnabled: true }, fired: [], corners: { base: 'flap', lid: 'extension', liner: 'none' } },
  { caseId: 'M-03', delta: { basePlatformWidth: 0 }, fired: [], corners: { base: 'extension', lid: 'extension' } },
  {
    caseId: 'M-04',
    delta: { lidPlatformWidth: 5 },
    fired: ['gusset-relief-omitted'],
    corners: { base: 'flap', lid: 'none' },
  },
  {
    caseId: 'M-15',
    delta: { basePlatformWidth: 0, lidPlatformWidth: 5 },
    fired: ['gusset-relief-omitted'],
    corners: { base: 'extension', lid: 'none' },
  },
  { caseId: 'M-05', delta: { rootJog: 0 }, fired: [], corners: { base: 'flap', lid: 'extension' } },
  { caseId: 'M-06', delta: { thickness: 0 }, fired: [], corners: { base: 'flap', lid: 'extension' } },
  { caseId: 'M-07', delta: { thickness: 0.8 }, fired: [], corners: { base: 'flap', lid: 'extension' } },
  {
    caseId: 'M-08',
    // 兩軸放大量不等（本列的用意）。原值 25/8 的 X 已超出 schema max=10——
    // `resolveParams` 不 clamp，那一列因此在測一個 UI 到不了的狀態。
    // 改取兩端內的不等值，順帶各碰一次 max 與近 min。
    delta: { lidMarginX: 10, lidMarginY: 2 },
    fired: [],
    corners: { base: 'flap', lid: 'extension' },
  },
  {
    caseId: 'M-09',
    delta: {
      baseLength: 33,
      baseWidth: 33,
      baseHeight: 10,
      lidMarginX: 5,
      lidMarginY: 5,
      lidHeight: 17,
      linerFlapDepth: 5,
      linerEnabled: true,
    },
    fired: [
      'gusset-relief-omitted',
      'notch-omitted',
      'tongue-crease-shrunk',
    ],
    corners: { base: 'none', lid: 'extension', liner: 'none' },
  },
  {
    caseId: 'M-10',
    delta: {
      baseLength: 600,
      baseWidth: 600,
      baseHeight: 200,
      // 原值 60/60 同樣超出上蓋放大量 schema max=10（本列自稱「六參數皆取 schema max」，
      // 其中兩個其實在範圍外）。放大量改取實際 max。
      lidMarginX: 10,
      lidMarginY: 10,
      lidHeight: 200,
    },
    fired: ['gusset-relief-omitted'],
    corners: { base: 'none', lid: 'extension' },
  },
  {
    caseId: 'M-16',
    delta: {
      basePlatformWidth: 0,
      lidPlatformWidth: 5,
      lidHeight: 60,
    },
    fired: [],
    corners: { base: 'extension', lid: 'flap' },
  },
];

const FORBIDDEN_ROWS = [
  {
    caseId: 'M-11',
    delta: { linerEnabled: true, baseHeight: 10 },
    invariantId: 'liner-flap-fits',
  },
  {
    caseId: 'M-12',
    delta: { lidHeight: 16.5 },
    invariantId: 'gusset-b-fits',
  },
  {
    caseId: 'M-13',
    delta: { baseLength: 40, baseWidth: 30, linerEnabled: true },
    invariantId: 'tongue-flap-fits',
  },
] as const;

function firedFor(delta: Overrides): string[] {
  const params = resolveParams(telescope, delta);
  const generated = telescope.generate(params);
  return telescope.invariants
    .filter((invariant) => !invariant.check(params, generated).ok)
    .map(({ id }) => id)
    .sort();
}

function buildPiece(
  delta: Overrides,
  pieceId: string,
): { model: FoldModel; params: ReturnType<typeof resolveParams> } {
  const params = resolveParams(telescope, delta);
  const piece = buildTelescopeSceneSpec(params).pieces
    .find((candidate) => candidate.pieceId === pieceId);
  expect(piece, `找不到 ${pieceId}`).toBeDefined();
  return { model: piece!.buildModel(params), params };
}

describe('Telescope 12 列合法／禁止參數矩陣', () => {
  it.each(LEGAL_ROWS)(
    '$caseId：fired 精確匹配且所有 per-piece hard gates 通過',
    ({ caseId, delta, fired, corners }) => {
      expect(exactSetMismatch(firedFor(delta), fired), caseId).toEqual([]);
      const params = resolveParams(telescope, delta);
      const scene = buildTelescopeSceneSpec(params);

      for (const piece of scene.pieces) {
        const model = piece.buildModel(params);
        const report = telescopeGateReport(model, params, piece.pieceId);
        // ① 角鎖家族逐列對預期——閘門空跑（域內無目標物）與「跑過且通過」在報告上同值，
        //    而 count=0 的證明只擋得住偵測邏輯壞掉。家族憑空消失只有靠宣告過的預期才看得見。
        const countOf = (prefix: string) => model.panels
          .filter(({ id }) => id.startsWith(prefix)).length;
        const expectedCorner = corners[piece.pieceId];
        expect(expectedCorner, `${caseId}/${piece.pieceId} 未宣告預期角鎖家族`).toBeDefined();
        expect(
          [countOf('flap'), countOf('gussetExt')],
          `${caseId}/${piece.pieceId} 角鎖家族應為 ${expectedCorner}`,
        ).toEqual({ flap: [4, 0], extension: [0, 4], none: [0, 0] }[expectedCorner!]);
        // ② 旗標必須與實際家族一致（旗標本身也可能算錯）。
        expect(report.flapGatesApplicable, `${caseId}/${piece.pieceId} flap 旗標`)
          .toBe(expectedCorner === 'flap');
        expect(report.extensionGatesApplicable, `${caseId}/${piece.pieceId} 延伸段旗標`)
          .toBe(expectedCorner === 'extension');
        // ③ ±180° 反摺閘門空跑時，同樣先證該片真的沒有半圈反摺 panel。
        if (!report.halfTurnGatesApplicable) {
          expect(
            model.panels.filter((panel) => (
              panel.parent !== null
              && panel.angleFn === undefined
              && Math.abs(Math.abs(panel.foldAngle) - Math.PI) < 1e-9
            )).length,
            `${caseId}/${piece.pieceId} ±180° 反摺空集須先證 count=0`,
          ).toBe(0);
        }
        expect(
          report.violations,
          `${caseId}/${piece.pieceId}\n${report.violations.join('\n')}`,
        ).toEqual([]);
      }
    },
    30_000,
  );

  it.each(FORBIDDEN_ROWS)(
    '$caseId：build 以 $invariantId fail-loud',
    ({ delta, invariantId }) => {
      const params = resolveParams(telescope, delta);
      expect(() => buildTelescopeSceneSpec(params)).toThrow(invariantId);
    },
  );

  it('矩陣每個 override 都必須落在 schema 宣告範圍內', () => {
    // `resolveParams` 不 clamp，所以超範圍的 override 會被照單全收——
    // 那一列就變成在測一個 UI 產生不了的狀態（M-08 的 lidMarginX=25 曾如此，
    // 直到上蓋放大量 schema 由 [5,60] 改成 [1,10] 才顯露）。
    const declared = new Map(telescope.params.map((param) => [param.key, param]));
    for (const { caseId, delta } of LEGAL_ROWS) {
      for (const [key, value] of Object.entries(delta)) {
        const param = declared.get(key);
        expect(param, `${caseId}: 未宣告的參數 ${key}`).toBeDefined();
        if (typeof value !== 'number') continue;
        const { min, max } = param as { min?: number; max?: number };
        if (typeof min === 'number') {
          expect(value, `${caseId}: ${key}=${value} 低於 schema min=${min}`)
            .toBeGreaterThanOrEqual(min);
        }
        if (typeof max === 'number') {
          expect(value, `${caseId}: ${key}=${value} 高於 schema max=${max}`)
            .toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it('warning fired 多一條或少一條都會被 exact matcher 拒絕', () => {
    const expected = ['gusset-relief-omitted'];
    expect(exactSetMismatch([], expected)).not.toEqual([]);
    expect(exactSetMismatch(
      ['gusset-relief-omitted', 'notch-omitted'],
      expected,
    )).not.toEqual([]);
  });
});

describe('Telescope gate sabotage', () => {
  it('extension 回退 identity 會被終態包絡閘門抓到', () => {
    const { model, params } = buildPiece({}, 'lid');
    const broken: FoldModel = {
      ...model,
      panels: model.panels.map((panel) => panel.id.startsWith('gussetExt')
        ? { ...panel, angleFn: () => 0 }
        : panel),
    };

    expect(telescopeGateReport(broken, params, 'lid').violations)
      .toContainEqual(expect.stringContaining('finalEnvelope'));
  });

  // 180° 反摺的旋向：兩拍各一條——prefoldX 的 x 內壁（判別軸＝出紙面 z）、
  // closeY 的 y 內壁（判別軸＝水平 y）。兩者判別軸不同，所以必須各驗一次，
  // 不能只驗一個就宣稱「180° 拍都守住了」。
  const flipHalfTurn = (model: FoldModel, pattern: RegExp): FoldModel => ({
    ...model,
    panels: model.panels.map((panel) => (
      pattern.test(panel.id) && Math.abs(Math.abs(panel.foldAngle) - Math.PI) < 1e-9
        ? { ...panel, foldAngle: -panel.foldAngle }
        : panel
    )),
  });

  it.each([
    ['prefoldX 的 x 內壁', /^wallX(?:Neg|Pos)-inner$/],
    ['closeY 的 y 內壁', /^wallY(?:Neg|Pos)-inner$/],
  ] as const)('%s 旋向反轉 → halfTurnDirection 紅（lid 無壁頂平台 ⇒ 內葉為 180° 反摺）', (_label, pattern) => {
    const { model } = buildPiece({}, 'lid');
    const broken = flipHalfTurn(model, pattern);

    expect(halfTurnDirectionViolations(model)).toEqual([]);
    expect(halfTurnDirectionViolations(broken))
      .toContainEqual(expect.stringContaining('halfTurnDirection'));
  });

  it('旋向反轉時**終態**閘門全部照綠——這正是本條存在的理由', () => {
    const { model, params } = buildPiece({}, 'lid');
    const broken = flipHalfTurn(model, /^wall[XY](?:Neg|Pos)-inner$/);

    // 終態逐頂點完全相同：R(+π) 與 R(−π) 是同一個旋轉。
    const before = worldGeometry(model, foldPose(1, model));
    const after = worldGeometry(broken, foldPose(1, broken));
    for (const [id, vertices] of before) {
      const flipped = after.get(id)!;
      for (const [index, vertex] of vertices.entries()) {
        expect(Math.hypot(
          vertex.x - flipped[index]!.x,
          vertex.y - flipped[index]!.y,
          vertex.z - flipped[index]!.z,
        ), `${id}[${index}] 終態位移`).toBeLessThan(1e-9);
      }
    }
    // 其餘閘門（含既有 G2 摺向）也照綠——G2 拿 pose 角度跟同一個 foldAngle 比號（自指）。
    const surviving = telescopeGateReport(broken, params, 'lid').violations
      .filter((violation) => !violation.startsWith('halfTurnDirection'));
    expect(surviving).toEqual([]);
  });

  it('角度偏移會被 flapWallCoplanarity 抓到', () => {
    const { model, params } = buildPiece({}, 'base');
    const broken: FoldModel = {
      ...model,
      panels: model.panels.map((panel) => panel.id === 'flapNegNeg'
        ? {
          ...panel,
          angleFn: (t) => (panel.angleFn?.(t) ?? 0) + 0.1,
        }
        : panel),
    };

    expect(telescopeGateReport(broken, params, 'base').violations)
      .toContainEqual(expect.stringContaining('flapWallCoplanarity'));
  });

  it('phase C flap 與 wall 非共面互穿仍由 G1 判定，不得 blanket skip', () => {
    const { params } = buildPiece({}, 'base');
    const broken: FoldModel = {
      panels: [
        {
          id: 'wallXNeg-inner',
          polygon: [
            { x: -2, y: -2 },
            { x: 2, y: -2 },
            { x: 2, y: 2 },
            { x: -2, y: 2 },
          ],
          parent: null,
          foldAngle: 0,
        },
        {
          id: 'flapNegNeg',
          polygon: [
            { x: -1, y: -1 },
            { x: 1, y: -1 },
            { x: 1, y: 1 },
            { x: -1, y: 1 },
          ],
          parent: 'wallXNeg-inner',
          hingeLine: {
            a: { x: -1, y: 0 },
            b: { x: 1, y: 0 },
          },
          foldAngle: Math.PI / 2,
        },
      ],
      steps: [{
        panelIds: ['flapNegNeg'],
        t0: 0.82,
        t1: 1,
        ease: 'linear',
      }],
      dieline: [],
    };

    expect(telescopeCollisionViolations(broken, params, 'base'))
      .toContainEqual(expect.stringContaining('G1:flap↔wall'));
  });

  it('相位窗重疊會 fail-loud', () => {
    expect(trayWindowOrderViolations({
      pretuck: [0, 0.08],
      prefoldX: [0.08, 0.2],
      prefoldY: [0.19, 0.3],
      phaseA: [0.3, 0.65],
      phaseB: [0.65, 0.82],
      phaseC: [0.82, 1],
    })).not.toEqual([]);
  });

  it('應存在的翼消失會 fail-loud', () => {
    const { model } = buildPiece({}, 'base');
    const broken: FoldModel = {
      ...model,
      panels: model.panels.filter(({ id }) => id !== 'wingXNegNeg'),
    };

    expect(familyTopologyViolations(broken))
      .toContainEqual(expect.stringContaining('wing count'));
  });

  it('hook-root-strip allowance 不得比公式 +0.05mm 更鬆', () => {
    const formula = { bandMm: 1, zSpanMm: 2 };
    expect(hookRootStripWithinBounds(formula, {
      bandMm: 1.05,
      intersectionLengthMm: 2.05,
    })).toBe(true);
    expect(hookRootStripWithinBounds(formula, {
      bandMm: 1.050001,
      intersectionLengthMm: 2,
    })).toBe(false);
    expect(hookRootStripWithinBounds(formula, {
      bandMm: 1,
      intersectionLengthMm: 2.050001,
    })).toBe(false);
  });

  it('A 款鉤葉 nominal a 錨仍是 generator 與閘門共用的同一個值', () => {
    // ⚠ 這條原本叫「zSpan 公式讀 generator 匯出的 nominal，不另寫 103.699 魔數」，
    // 斷言卻只是 `> 100`——任何大於 100 的值都綠，擋不住它自稱要擋的東西。
    // 「閘門不另寫魔數」其實由 import 結構保證（telescope-gates.ts 直接 import 本常數），
    // 測試加不了東西。這裡改為守真正還會漂移的一件事：generator 的線段模板與
    // 閘門公式必須引用**同一個**常數，值也必須仍等於刀模上的那個錨點。
    expect(A_GUSSET_FIXED_NOMINAL_A_MM).toBe(103.699);
  });
});
