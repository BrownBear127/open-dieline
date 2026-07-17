import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { FOLD_MODEL_BUILDERS } from '@/fold/registry';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

const LEGACY_PANEL_IDS = [
  'P1',
  'P2',
  'P3',
  'P4',
  'bottomDustP2',
  'bottomDustP4',
  'bottomLid',
  'bottomTuck',
  'glue',
  'topDustP2',
  'topDustP4',
  'topLid',
  'topTuck',
].sort();

const SLICED_PANEL_IDS = [
  'P1',
  'P2',
  'P3',
  'P4',
  'bottomDustP2',
  'bottomDustP4',
  'bottomLidC',
  'bottomLidL',
  'bottomLidR',
  'bottomTuck',
  'glue',
  'topDustP2',
  'topDustP4',
  'topLidC',
  'topLidL',
  'topLidR',
  'topTuck',
].sort();

function defaultModel(): FoldModel {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
}

function legacyModel(): FoldModel {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, { tuckLock: 0 }));
}

function panel(model: FoldModel, id: string): FoldPanel {
  const result = model.panels.find((candidate) => candidate.id === id);
  expect(result, `missing panel ${id}`).toBeDefined();
  return result!;
}

function xBounds(target: FoldPanel): [number, number] {
  const xs = target.polygon.map((point) => point.x);
  return [Math.min(...xs), Math.max(...xs)];
}

function coordinateBounds(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}

function expectBoundsClose(actual: [number, number], expected: [number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
}

describe('RTE FoldModel unit geometry', () => {
  it('tuckLock=20 將上下蓋各分成 L/C/R，並以 2D frictionLock 去補償座標形成梯形凸片', () => {
    const model = defaultModel();

    expect(model.panels).toHaveLength(17);
    expect(model.panels.map(({ id }) => id).sort()).toEqual(SLICED_PANEL_IDS);

    expect(panel(model, 'topLidL').polygon).toEqual([
      { x: 130, y: -55 },
      { x: 130, y: 0 },
      { x: 110, y: 0 },
      { x: 110, y: -55 },
      { x: 127.5, y: -55 },
      { x: 129.5, y: -56.5 },
      { x: 137.5, y: -56.5 },
      { x: 137.5, y: -55 },
    ]);
    expect(panel(model, 'topLidR').polygon).toEqual([
      { x: 145, y: -55 },
      { x: 137.5, y: -55 },
      { x: 137.5, y: -56.5 },
      { x: 145.5, y: -56.5 },
      { x: 147.5, y: -55 },
      { x: 165, y: -55 },
      { x: 165, y: 0 },
      { x: 145, y: 0 },
    ]);
    expect(panel(model, 'bottomLidL').polygon).toEqual([
      { x: 20, y: 172 },
      { x: 27.5, y: 172 },
      { x: 27.5, y: 173.5 },
      { x: 19.5, y: 173.5 },
      { x: 17.5, y: 172 },
      { x: 0, y: 172 },
      { x: 0, y: 117 },
      { x: 20, y: 117 },
    ]);
    expect(panel(model, 'bottomLidR').polygon).toEqual([
      { x: 35, y: 172 },
      { x: 35, y: 117 },
      { x: 55, y: 117 },
      { x: 55, y: 172 },
      { x: 37.5, y: 172 },
      { x: 35.5, y: 173.5 },
      { x: 27.5, y: 173.5 },
      { x: 27.5, y: 172 },
    ]);

    expect(panel(model, 'topLidC').hingeLine).toEqual({ a: { x: 130, y: 0 }, b: { x: 145, y: 0 } });
    expect(panel(model, 'bottomLidC').hingeLine).toEqual({ a: { x: 35, y: 117 }, b: { x: 20, y: 117 } });
    expect(panel(model, 'topTuck').parent).toBe('topLidC');
    expect(panel(model, 'bottomTuck').parent).toBe('bottomLidC');
  });

  it('tuckLock=0 維持 13 片單 lid 與既有 id', () => {
    const model = legacyModel();

    expect(model.panels).toHaveLength(13);
    expect(model.panels.map(({ id }) => id).sort()).toEqual(LEGACY_PANEL_IDS);
    expect(panel(model, 'topTuck').parent).toBe('topLid');
    expect(panel(model, 'bottomTuck').parent).toBe('bottomLid');
  });

  it('使用成品名義尺寸建立 P2 與 P3，不加入紙厚補償', () => {
    const params = resolveParams(reverseTuckEnd, {});
    const model = buildRteFoldModel(params);
    const L = params.L as number;
    const W = params.W as number;

    expect(params.thickness).not.toBe(0);
    expect(xBounds(panel(model, 'P2'))).toEqual([L, L + W]);
    expect(xBounds(panel(model, 'P3'))).toEqual([L + W, 2 * L + W]);
  });

  it('glueSide=right 時將膠舌鏡像到 P4 右側', () => {
    const params = resolveParams(reverseTuckEnd, { glueSide: 'right' });
    const model = buildRteFoldModel(params);
    const L = params.L as number;
    const W = params.W as number;
    const x4 = 2 * L + 2 * W;

    expect(panel(model, 'glue').parent).toBe('P4');
    expect(xBounds(panel(model, 'glue'))).toEqual([x4, x4 + (params.glueSize as number)]);
  });

  it('以離散弧點形成插舌圓角，並為插舌保留紙厚讓位', () => {
    const params = resolveParams(reverseTuckEnd, {});
    const model = buildRteFoldModel(params);
    const topTuck = panel(model, 'topTuck');
    const bottomTuck = panel(model, 'bottomTuck');

    expect(topTuck.polygon.length).toBeGreaterThan(6);
    expect(bottomTuck.polygon.length).toBeGreaterThan(6);
    expect(topTuck.liftOffset).toBe(params.thickness);
    expect(bottomTuck.liftOffset).toBe(params.thickness);
    expect(topTuck.parent).toBe('topLidC');
    expect(bottomTuck.parent).toBe('bottomLidC');
  });
});

describe('RTE FoldModel integration contracts', () => {
  it('預設模型通過 validateFoldModel', () => {
    expect(validateFoldModel(defaultModel())).toEqual([]);
  });

  it('L=20、tuckLock=60 的極端 fallback 維持有效模型與三等分 lid hinges', () => {
    const L = 20;
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { L, tuckLock: 60 }));

    expect(validateFoldModel(model)).toEqual([]);
    for (const side of ['top', 'bottom'] as const) {
      const hingeWidths = ['L', 'C', 'R'].map((suffix) => {
        const hinge = panel(model, `${side}Lid${suffix}`).hingeLine;
        expect(hinge, `${side}Lid${suffix} must have a fallback hinge`).toBeDefined();
        return Math.abs(hinge!.b.x - hinge!.a.x);
      });
      for (const width of hingeWidths) expect(width).toBeCloseTo(L / 3, 12);
      expect(hingeWidths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(L, 12);
    }
  });

  it('registry 以 rte id 提供 RTE builder', () => {
    expect(FOLD_MODEL_BUILDERS).toEqual({ rte: buildRteFoldModel });
  });

  it('建立指定摺序與時間範圍', () => {
    expect(defaultModel().steps).toEqual([
      { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
      { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
      { panelIds: ['bottomTuck'], t0: 0.5, t1: 0.6, ease: 'backIn' },
      { panelIds: ['bottomLidL', 'bottomLidC', 'bottomLidR'], t0: 0.6, t1: 0.72, ease: 'powerInOut' },
      { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
      { panelIds: ['topTuck'], t0: 0.84, t1: 0.92, ease: 'backIn' },
      { panelIds: ['topLidL', 'topLidC', 'topLidR'], t0: 0.92, t1: 1, ease: 'powerInOut' },
    ]);
  });

  it('插舌先於蓋板收摺（實體用法：插舌折進去才蓋蓋子·上下蓋皆然）', () => {
    // 2026-07-17 法蘭 E2E 裁決：tuck 是 lid 的子面板，tuck 時間窗先收完、
    // lid 才起摺＝「蓋板帶著已折好的插舌蓋上」；反序會讓插舌穿過盒壁。
    const steps = defaultModel().steps;
    const windowOf = (id: string) => steps.find((step) => step.panelIds.includes(id))!;

    for (const [tuck, lids] of [
      ['bottomTuck', ['bottomLidL', 'bottomLidC', 'bottomLidR']],
      ['topTuck', ['topLidL', 'topLidC', 'topLidR']],
    ] as const) {
      for (const lid of lids) {
        expect(windowOf(tuck).t1, `${tuck} 須在 ${lid} 起摺前收完`)
          .toBeLessThanOrEqual(windowOf(lid).t0);
      }
    }
  });

  it('tuckDepth=0 時省略兩片插舌並移除空摺序', () => {
    const params = resolveParams(reverseTuckEnd, { tuckDepth: 0 });
    const model = buildRteFoldModel(params);

    expect(model.panels).toHaveLength(15);
    expect(model.panels.some(({ id }) => id === 'topTuck' || id === 'bottomTuck')).toBe(false);
    expect(model.steps.every(({ panelIds }) => panelIds.length > 0)).toBe(true);
    expect(validateFoldModel(model)).toEqual([]);
  });

  it('tuckDepth=0 且 dustFlapDepth=0 時保留盒身、膠舌與六片 lid 分片', () => {
    const params = resolveParams(reverseTuckEnd, { tuckDepth: 0, dustFlapDepth: 0 });
    const model = buildRteFoldModel(params);

    expect(model.panels).toHaveLength(11);
    expect(model.steps.every(({ panelIds }) => panelIds.length > 0)).toBe(true);
    expect(validateFoldModel(model)).toEqual([]);
  });
});

describe('RTE FoldModel end-to-end fold', () => {
  it('t=1 時 root 保持 0，所有非 root 面板到達正負 π/2', () => {
    const model = defaultModel();
    const pose = foldPose(1, model);

    expect(pose.get('P1')).toBe(0);
    for (const target of model.panels.filter(({ parent }) => parent !== null)) {
      expect(Math.abs(pose.get(target.id)!)).toBeCloseTo(Math.PI / 2, 12);
    }
  });

  it('t=1 時盒身閉合，P3 與 P1 平行相距 W，頂底蓋落在開口平面', () => {
    const params = resolveParams(reverseTuckEnd, {});
    const model = buildRteFoldModel(params);
    const geometry = worldGeometry(model, foldPose(1, model));
    const L = params.L as number;
    const W = params.W as number;
    const D = params.D as number;
    const p3 = geometry.get('P3')!;
    const topLids = ['topLidL', 'topLidC', 'topLidR'].flatMap((id) => geometry.get(id)!);
    const bottomLids = ['bottomLidL', 'bottomLidC', 'bottomLidR'].flatMap((id) => geometry.get(id)!);

    expect(p3.every(({ z }) => Math.abs(z - W) < 1e-9)).toBe(true);
    expectBoundsClose(coordinateBounds(p3.map(({ x }) => x)), [0, L]);
    expect(topLids.every(({ y }) => Math.abs(y) < 1e-9)).toBe(true);
    expect(bottomLids.every(({ y }) => Math.abs(y - D) < 1e-9)).toBe(true);
    expectBoundsClose(coordinateBounds(topLids.map(({ z }) => z)), [-1.5, W]);
    expectBoundsClose(coordinateBounds(bottomLids.map(({ z }) => z)), [0, W + 1.5]);
  });
});
