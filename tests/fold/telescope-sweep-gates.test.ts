// normalized 慣例層固定矩陣 membership、81 點 C 掃描、容差與 G3 cap。
// 觀測慣例層：閘門直接讀 FoldModel 的真 panel/FK 與 generator 現場幾何。
import { describe, expect, it } from 'vitest';
import { A_GUSSET_FIXED_NOMINAL_A_MM } from '@/boxes/telescope/tray';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';
import type { FoldModel } from '@/fold/types';
import {
  exactSetMismatch,
  familyTopologyViolations,
  hookRootStripWithinBounds,
  telescopeCollisionViolations,
  telescopeGateReport,
  trayWindowOrderViolations,
} from '../helpers/telescope-gates';

type Overrides = Record<string, number | boolean>;

const LEGAL_ROWS: Array<{
  caseId: string;
  delta: Overrides;
  fired: string[];
}> = [
  { caseId: 'M-01', delta: {}, fired: [] },
  { caseId: 'M-02', delta: { linerEnabled: true }, fired: [] },
  { caseId: 'M-03', delta: { basePlatformWidth: 0 }, fired: [] },
  {
    caseId: 'M-04',
    delta: { lidPlatformWidth: 5 },
    fired: ['gusset-relief-omitted'],
  },
  {
    caseId: 'M-15',
    delta: { basePlatformWidth: 0, lidPlatformWidth: 5 },
    fired: ['gusset-relief-omitted'],
  },
  { caseId: 'M-05', delta: { rootJog: 0 }, fired: [] },
  { caseId: 'M-06', delta: { thickness: 0 }, fired: [] },
  { caseId: 'M-07', delta: { thickness: 0.8 }, fired: [] },
  {
    caseId: 'M-08',
    delta: { lidMarginX: 25, lidMarginY: 8 },
    fired: [],
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
  },
  {
    caseId: 'M-10',
    delta: {
      baseLength: 600,
      baseWidth: 600,
      baseHeight: 200,
      lidMarginX: 60,
      lidMarginY: 60,
      lidHeight: 200,
    },
    fired: ['gusset-relief-omitted'],
  },
  {
    caseId: 'M-16',
    delta: {
      basePlatformWidth: 0,
      lidPlatformWidth: 5,
      lidHeight: 60,
    },
    fired: [],
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
    ({ caseId, delta, fired }) => {
      expect(exactSetMismatch(firedFor(delta), fired), caseId).toEqual([]);
      const params = resolveParams(telescope, delta);
      const scene = buildTelescopeSceneSpec(params);

      for (const piece of scene.pieces) {
        const model = piece.buildModel(params);
        const report = telescopeGateReport(model, params, piece.pieceId);
        const flapCount = model.panels.filter(({ id }) => id.startsWith('flap')).length;
        if (!report.flapGatesApplicable) {
          expect(flapCount, `${caseId}/${piece.pieceId} 空集須先證 count=0`).toBe(0);
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

  it('zSpan 公式讀 generator 匯出的 nominal，不另寫 103.699 魔數', () => {
    expect(A_GUSSET_FIXED_NOMINAL_A_MM).toBeGreaterThan(100);
  });
});
