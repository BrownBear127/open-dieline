import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import {
  buildTelescopeSceneSpec,
  TELESCOPE_FOLD_WINDOWS,
  TELESCOPE_TRAY_WINDOWS,
  telescopeInterlockSubWindows,
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

  it('default base P+：錯階五拍嚴格串行且無縫覆蓋 [0,1]，multi-phase panel 各只有單 step', () => {
    const base = model('base');
    const flap = base.panels.find(({ id }) => id === 'flapNegNeg')!;
    const wingX = base.panels.find(({ id }) => id === 'wingXNegNeg')!;
    const wingY = base.panels.find(({ id }) => id === 'wingYNegNeg')!;

    // Spec §4.6 五拍（v14 錯階生產摺序）。
    const windows = TELESCOPE_TRAY_WINDOWS.flapped;
    expect(windows).toEqual({
      prefoldX: [0, 0.16],
      raiseX: [0.16, 0.44],
      interlock: [0.44, 0.62],
      raiseY: [0.62, 0.84],
      closeY: [0.84, 1],
    });
    // 串行性寫成結構斷言：前拍終點＝後拍起點，首尾貼齊 0/1。
    const ordered = Object.values(windows);
    expect(ordered[0]![0]).toBe(0);
    expect(ordered.at(-1)![1]).toBe(1);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]![0], `第 ${i + 1} 拍起點`).toBe(ordered[i - 1]![1]);
    }

    // 同壁左右翼**不得同窗**（§4.6 v15.2·鉤式互扣在實體上是依序的）。
    // 同一 y 壁的一對＝x 號相反、y 號相同：flapNegNeg↔flapPosNeg。
    const { first, second } = telescopeInterlockSubWindows();
    expect(first[0]).toBe(windows.interlock[0]);
    expect(second[1]).toBe(windows.interlock[1]);
    expect(second[0]).toBe(first[1]);
    for (const [early, late] of [
      ['flapNegNeg', 'flapPosNeg'],
      ['flapNegPos', 'flapPosPos'],
    ] as const) {
      expect(stepFor(base, early)).toHaveLength(1);
      expect(stepFor(base, late)).toHaveLength(1);
      expect(stepFor(base, early)[0]).toMatchObject({ t0: first[0], t1: first[1] });
      expect(stepFor(base, late)[0]).toMatchObject({ t0: second[0], t1: second[1] });
      // 先摺的那片在後摺的那片開始動之前就已到位（＝真的錯開，不是只有窗不同）。
      const atHandover = foldPose(second[0], base);
      expect(atHandover.get(early)).toBeCloseTo(-Math.PI / 2, 12);
      expect(atHandover.get(late)).toBeCloseTo(0, 12);
    }
    // 角撐單一 step 橫跨 raiseX → hold → raiseY（driver 內部再分段）。
    expect(stepFor(base, wingX.id)).toHaveLength(1);
    expect(stepFor(base, wingX.id)[0]).toMatchObject({
      t0: windows.raiseX[0],
      t1: windows.raiseY[1],
    });
    expect(stepFor(base, wingY.id)).toHaveLength(1);

    // hold 段（interlock 全程）角撐靜止於第一段終態＝貼平長壁。
    for (const t of [windows.raiseX[1], windows.interlock[0], windows.interlock[1]]) {
      expect(foldPose(t, base).get(wingX.id), `t=${t}`).toBeCloseTo(0, 12);
      expect(foldPose(t, base).get(wingY.id), `t=${t}`).toBeCloseTo(Math.PI / 2, 12);
    }
    // 角翼在 interlock 拍內完成互卡，之後不再動。
    expect(foldPose(windows.interlock[0], base).get(flap.id)).toBeCloseTo(0, 12);
    expect(foldPose(windows.interlock[1], base).get(flap.id)).toBeCloseTo(-Math.PI / 2, 12);
    expect(foldPose(1, base).get(flap.id)).toBeCloseTo(-Math.PI / 2, 12);
    // 終態＝角撐被短邊壁收走。
    const atEnd = foldPose(1, base);
    expect(atEnd.get(wingX.id)).toBeCloseTo(Math.PI / 2, 12);
    expect(atEnd.get(wingY.id)).toBeCloseTo(Math.PI, 12);
  });

  it('default lid P0：無角翼，延伸段在 extWrap 拍（與 P+ interlock 同位）包上相鄰 y 壁', () => {
    const lid = model('lid');
    const flaps = lid.panels.filter(({ id }) => id.startsWith('flap'));
    const extensions = lid.panels.filter(({ id }) => id.startsWith('gussetExt'));

    expect(flaps).toHaveLength(0);
    expect(extensions).toHaveLength(4);
    expect(TELESCOPE_TRAY_WINDOWS.plain).toEqual({
      prefoldX: [0, 0.18],
      raiseX: [0.18, 0.48],
      extWrap: [0.48, 0.64],
      raiseY: [0.64, 0.84],
      closeY: [0.84, 1],
    });
    // 第三拍在兩家族同位＝raiseX 之後、raiseY 之前（Spec §4.6：兩個角鎖家族共用同一條斷言）。
    const { raiseX, extWrap, raiseY } = TELESCOPE_TRAY_WINDOWS.plain;
    expect(extWrap[0]).toBe(raiseX[1]);
    expect(extWrap[1]).toBe(raiseY[0]);

    for (const extension of extensions) {
      expect(stepFor(lid, extension.id)).toHaveLength(1);
      expect(stepFor(lid, extension.id)[0]).toMatchObject({
        t0: extWrap[0],
        t1: extWrap[1],
      });
      // extensionBeforeWrapIdentity：包覆拍開始前恆為 identity。
      for (const t of [0, 0.1, raiseX[0], (raiseX[0] + raiseX[1]) / 2, extWrap[0]]) {
        expect(foldPose(t, lid).get(extension.id), `t=${t}`).toBe(0);
      }
      expect(foldPose((extWrap[0] + extWrap[1]) / 2, lid).get(extension.id))
        .toBeLessThan(0);
      // 拍末到位後不再動。
      expect(foldPose(extWrap[1], lid).get(extension.id)).toBeCloseTo(-Math.PI / 2, 12);
      expect(foldPose(1, lid).get(extension.id)).toBeCloseTo(-Math.PI / 2, 12);
    }
  });

  it('M-16 由真實 flap count 切換 family：base 走 P0(extWrap)、lid 走 P+(interlock)', () => {
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
    // 家族由 panel 存在性決定（Spec §4.6），非參數旗標。
    expect(stepFor(lid, 'flapNegNeg').at(0)).toMatchObject({
      t0: telescopeInterlockSubWindows().first[0],
      t1: telescopeInterlockSubWindows().first[1],
    });
    expect(stepFor(lid, 'flapPosNeg').at(0)).toMatchObject({
      t0: telescopeInterlockSubWindows().second[0],
      t1: telescopeInterlockSubWindows().second[1],
    });
    const baseExtension = base.panels.find(({ id }) => id.startsWith('gussetExt'))!;
    expect(stepFor(base, baseExtension.id).at(0)).toMatchObject({
      t0: TELESCOPE_TRAY_WINDOWS.plain.extWrap[0],
      t1: TELESCOPE_TRAY_WINDOWS.plain.extWrap[1],
    });
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
