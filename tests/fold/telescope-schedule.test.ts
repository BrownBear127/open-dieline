import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import {
  buildTelescopeSceneSpec,
  TELESCOPE_FOLD_WINDOWS,
  TELESCOPE_TRAY_WINDOWS,
} from '@/fold/models/telescope';
import { foldPose } from '@/fold/schedule';

function model(pieceId: 'base' | 'lid' | 'liner', overrides = {}) {
  const params = resolveParams(telescope, overrides);
  const piece = buildTelescopeSceneSpec(params).pieces
    .find((candidate) => candidate.pieceId === pieceId);
  expect(piece, `找不到 ${pieceId}`).toBeDefined();
  return piece!.buildModel(params);
}

function stepFor(
  foldModel: ReturnType<typeof model>,
  panelId: string,
) {
  return foldModel.steps.filter(({ panelIds }) => panelIds.includes(panelId));
}

describe('Telescope per-piece schedule', () => {
  it('scene 以 TELESCOPE_FOLD_WINDOWS 建立 base/lid/liner 三片 foldWindow', () => {
    const params = resolveParams(telescope, { linerEnabled: true });
    const scene = buildTelescopeSceneSpec(params);

    expect(scene.pieces.map(({ pieceId, foldWindow }) => [pieceId, foldWindow]))
      .toEqual([
        ['base', TELESCOPE_FOLD_WINDOWS.base],
        ['lid', TELESCOPE_FOLD_WINDOWS.lid],
        ['liner', TELESCOPE_FOLD_WINDOWS.liner],
      ]);
  });

  it('default base：pretuck→prefold-x→prefold-y→A→B→C 串行，multi-phase panel 各只有單 step', () => {
    const base = model('base');
    const flap = base.panels.find(({ id }) => id === 'flapNegNeg')!;
    const wingX = base.panels.find(({ id }) => id === 'wingXNegNeg')!;
    const wingY = base.panels.find(({ id }) => id === 'wingYNegNeg')!;

    expect(TELESCOPE_TRAY_WINDOWS.flapped).toEqual({
      pretuck: [0, 0.08],
      prefoldX: [0.08, 0.18],
      prefoldY: [0.18, 0.3],
      phaseA: [0.3, 0.65],
      phaseB: [0.65, 0.82],
      phaseC: [0.82, 1],
    });
    expect(stepFor(base, flap.id)).toHaveLength(1);
    expect(stepFor(base, flap.id)[0]).toMatchObject({ t0: 0, t1: 1 });
    expect(stepFor(base, wingX.id)).toHaveLength(1);
    expect(stepFor(base, wingX.id)[0]).toMatchObject({ t0: 0.3, t1: 0.82 });
    expect(stepFor(base, wingY.id)).toHaveLength(1);

    const atAEnd = foldPose(0.65, base);
    const atBEnd = foldPose(0.82, base);
    expect(atAEnd.get(wingX.id)).toBeCloseTo((3 * Math.PI) / 4, 12);
    expect(atAEnd.get(wingY.id)).toBeCloseTo((3 * Math.PI) / 4, 12);
    expect(atBEnd.get(wingX.id)).toBeCloseTo(Math.PI, 12);
    expect(atBEnd.get(wingY.id)).toBeCloseTo(Math.PI / 2, 12);
    expect(atBEnd.get(flap.id)).toBeCloseTo(-Math.PI, 12);
    expect(foldPose(1, base).get(flap.id)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('default lid P0：flap count=0 後省略 pretuck，extension 在 B 後獨立完成 C-ext', () => {
    const lid = model('lid');
    const flaps = lid.panels.filter(({ id }) => id.startsWith('flap'));
    const extensions = lid.panels.filter(({ id }) => id.startsWith('gussetExt'));

    expect(flaps).toHaveLength(0);
    expect(extensions).toHaveLength(4);
    expect(TELESCOPE_TRAY_WINDOWS.plain).toEqual({
      prefoldX: [0, 0.15],
      prefoldY: [0.15, 0.3],
      phaseA: [0.3, 0.65],
      phaseB: [0.65, 0.82],
      phaseCExt: [0.82, 1],
    });
    const { phaseB, phaseCExt } = TELESCOPE_TRAY_WINDOWS.plain;
    expect(phaseCExt[0]).toBe(phaseB[1]);
    expect(phaseCExt[1]).toBe(1);
    for (const extension of extensions) {
      expect(stepFor(lid, extension.id)).toHaveLength(1);
      expect(stepFor(lid, extension.id)[0]).toMatchObject({ t0: 0, t1: 1 });
      for (const t of [0, 0.15, 0.3, phaseB[0], phaseB[1]]) {
        expect(foldPose(t, lid).get(extension.id)).toBe(0);
      }
      expect(foldPose((phaseCExt[0] + phaseCExt[1]) / 2, lid).get(extension.id))
        .toBeLessThan(0);
      expect(foldPose(1, lid).get(extension.id)).toBeCloseTo(-Math.PI / 2, 12);
    }
  });

  it('M-16 由真實 flap count 切換 family：base 省略 C、lid 啟用 C', () => {
    const overrides = {
      basePlatformWidth: 0,
      lidPlatformWidth: 5,
      lidHeight: 60,
    };
    const base = model('base', overrides);
    const lid = model('lid', overrides);
    const baseFlaps = base.panels.filter(({ id }) => id.startsWith('flap'));
    const lidFlaps = lid.panels.filter(({ id }) => id.startsWith('flap'));

    expect(baseFlaps).toHaveLength(0);
    expect(lidFlaps).toHaveLength(4);
    expect(stepFor(lid, lidFlaps[0]!.id).at(0)).toMatchObject({ t0: 0, t1: 1 });
  });

  it('liner 四腿在自己的單一窗下摺，off 態不建立 liner piece', () => {
    const liner = model('liner', { linerEnabled: true });
    const legs = liner.panels.filter(({ id }) => id.startsWith('linerLeg'));

    expect(legs).toHaveLength(4);
    for (const leg of legs) {
      expect(stepFor(liner, leg.id)).toHaveLength(1);
      expect(foldPose(1, liner).get(leg.id)).toBeCloseTo(-Math.PI / 2, 12);
    }

    const off = resolveParams(telescope, { linerEnabled: false });
    expect(buildTelescopeSceneSpec(off).pieces.some(({ pieceId }) => pieceId === 'liner'))
      .toBe(false);
  });

  it.each([
    ['default base', 'base', {}],
    ['default lid', 'lid', {}],
    [
      'M-16 lid',
      'lid',
      { basePlatformWidth: 0, lidPlatformWidth: 5, lidHeight: 60 },
    ],
    ['liner', 'liner', { linerEnabled: true }],
  ] as const)('%s：每個非 root panel 恰屬於一個 step', (_label, pieceId, overrides) => {
    const foldModel = model(pieceId, overrides);
    for (const panel of foldModel.panels.filter(({ parent }) => parent !== null)) {
      expect(stepFor(foldModel, panel.id), panel.id).toHaveLength(1);
    }
  });
});
