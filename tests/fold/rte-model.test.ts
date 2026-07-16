import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { FOLD_MODEL_BUILDERS } from '@/fold/registry';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

const EXPECTED_PANEL_IDS = [
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

function defaultModel(): FoldModel {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
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
  it('預設參數建立精確的 13 面板集合', () => {
    const model = defaultModel();

    expect(model.panels).toHaveLength(13);
    expect(model.panels.map(({ id }) => id).sort()).toEqual(EXPECTED_PANEL_IDS);
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
  });
});

describe('RTE FoldModel integration contracts', () => {
  it('預設模型通過 validateFoldModel', () => {
    expect(validateFoldModel(defaultModel())).toEqual([]);
  });

  it('registry 以 rte id 提供 RTE builder', () => {
    expect(FOLD_MODEL_BUILDERS).toEqual({ rte: buildRteFoldModel });
  });

  it('建立指定摺序與時間範圍', () => {
    expect(defaultModel().steps).toEqual([
      { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
      { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
      { panelIds: ['bottomLid'], t0: 0.5, t1: 0.64, ease: 'powerInOut' },
      { panelIds: ['bottomTuck'], t0: 0.6, t1: 0.72, ease: 'backIn' },
      { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
      { panelIds: ['topLid'], t0: 0.84, t1: 0.95, ease: 'powerInOut' },
      { panelIds: ['topTuck'], t0: 0.92, t1: 1, ease: 'backIn' },
    ]);
  });

  it('tuckDepth=0 時省略兩片插舌並移除空摺序', () => {
    const params = resolveParams(reverseTuckEnd, { tuckDepth: 0 });
    const model = buildRteFoldModel(params);

    expect(model.panels).toHaveLength(11);
    expect(model.panels.some(({ id }) => id === 'topTuck' || id === 'bottomTuck')).toBe(false);
    expect(model.steps.every(({ panelIds }) => panelIds.length > 0)).toBe(true);
    expect(validateFoldModel(model)).toEqual([]);
  });

  it('tuckDepth=0 且 dustFlapDepth=0 時只保留七片非零面板', () => {
    const params = resolveParams(reverseTuckEnd, { tuckDepth: 0, dustFlapDepth: 0 });
    const model = buildRteFoldModel(params);

    expect(model.panels).toHaveLength(7);
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
    const topLid = geometry.get('topLid')!;
    const bottomLid = geometry.get('bottomLid')!;

    expect(p3.every(({ z }) => Math.abs(z - W) < 1e-9)).toBe(true);
    expectBoundsClose(coordinateBounds(p3.map(({ x }) => x)), [0, L]);
    expect(topLid.every(({ y }) => Math.abs(y) < 1e-9)).toBe(true);
    expect(bottomLid.every(({ y }) => Math.abs(y - D) < 1e-9)).toBe(true);
    expectBoundsClose(coordinateBounds(topLid.map(({ z }) => z)), [0, W]);
    expectBoundsClose(coordinateBounds(bottomLid.map(({ z }) => z)), [0, W]);
  });
});
