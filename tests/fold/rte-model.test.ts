// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { InvalidBoxParamsError } from '@/fold/derive/panelize';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { FOLD_SCENE_REGISTRY } from '@/fold/registry';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

const DEFAULT_PANEL_IDS = [
  'P1', 'P2', 'P3', 'P4', 'glue',
  'topLid', 'topTuck', 'topDustP2', 'topDustP4',
  'bottomLid', 'bottomTuck', 'bottomDustP2', 'bottomDustP4',
].sort();

function model(overrides: Record<string, number | string> = {}): FoldModel {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
}

function panel(target: FoldModel, id: string): FoldPanel {
  const result = target.panels.find((candidate) => candidate.id === id);
  expect(result, `missing panel ${id}`).toBeDefined();
  return result!;
}

function width(target: FoldPanel): number {
  const xs = target.polygon.map(({ x }) => x);
  return Math.max(...xs) - Math.min(...xs);
}

describe('RTE FoldModel derived geometry', () => {
  it('uses one top lid and one bottom lid for every friction-lock width', () => {
    for (const tuckLock of [0, 12, 20]) {
      const target = model({ tuckLock });
      expect(target.panels.map(({ id }) => id).sort()).toEqual(DEFAULT_PANEL_IDS);
      expect(panel(target, 'topTuck').parent).toBe('topLid');
      expect(panel(target, 'bottomTuck').parent).toBe('bottomLid');
      expect(target.panels.some(({ id }) => /(?:top|bottom)Lid[LCR]$/.test(id))).toBe(false);
    }
  });

  it('derives the friction-lock projection inside each single lid polygon', () => {
    const unlocked = model({ tuckLock: 0 });
    const locked = model({ tuckLock: 20 });

    expect(panel(locked, 'topLid').polygon).not.toEqual(panel(unlocked, 'topLid').polygon);
    expect(panel(locked, 'bottomLid').polygon).not.toEqual(panel(unlocked, 'bottomLid').polygon);
  });

  it('keeps the generator thickness compensation in the panelized body', () => {
    const params = resolveParams(reverseTuckEnd, {});
    const target = buildRteFoldModel(params);
    const thickness = params.thickness as number;

    expect(width(panel(target, 'P2'))).toBeCloseTo((params.W as number) + thickness, 9);
    expect(width(panel(target, 'P3'))).toBeCloseTo((params.L as number) + thickness, 9);
  });

  it('mirrors the glue parent with glueSide', () => {
    expect(panel(model({ glueSide: 'left' }), 'glue').parent).toBe('P1');
    expect(panel(model({ glueSide: 'right' }), 'glue').parent).toBe('P4');
  });

  it('retains rounded tuck geometry without renderer-only lift offsets', () => {
    for (const id of ['topTuck', 'bottomTuck']) {
      const target = panel(model(), id);
      expect(target.polygon.length).toBeGreaterThan(6);
      expect(target.liftOffset).toBeUndefined();
    }
  });

  it('fails loud when an error invariant rejects the parameters', () => {
    expect(() => model({ L: 20, tuckLock: 60 })).toThrow(InvalidBoxParamsError);
  });
});

describe('RTE FoldModel integration contracts', () => {
  it('passes validation and remains registered', () => {
    expect(validateFoldModel(model())).toEqual([]);
    const entry = FOLD_SCENE_REGISTRY.rte!;
    const params = resolveParams(reverseTuckEnd, {});
    expect(entry.capabilities.previewScene).toBe(true);
    expect(entry.sceneSpec!(params).pieces[0]!.buildModel(params)).toEqual(
      buildRteFoldModel(params),
    );
  });

  it('uses the single-lid fold schedule with tuck-before-lid ordering', () => {
    const steps = model().steps;
    expect(steps).toEqual([
      { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
      { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
      { panelIds: ['bottomTuck'], t0: 0.5, t1: 0.6, ease: 'backIn' },
      { panelIds: ['bottomLid'], t0: 0.6, t1: 0.72, ease: 'powerInOut' },
      { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
      { panelIds: ['topTuck'], t0: 0.84, t1: 0.92, ease: 'backIn' },
      { panelIds: ['topLid'], t0: 0.92, t1: 1, ease: 'powerInOut' },
    ]);
    expect(steps.find(({ panelIds }) => panelIds.includes('bottomTuck'))!.t1)
      .toBeLessThanOrEqual(steps.find(({ panelIds }) => panelIds.includes('bottomLid'))!.t0);
    expect(steps.find(({ panelIds }) => panelIds.includes('topTuck'))!.t1)
      .toBeLessThanOrEqual(steps.find(({ panelIds }) => panelIds.includes('topLid'))!.t0);
  });

  it('omits inactive tuck and dust panels together with empty steps', () => {
    const noTucks = model({ tuckDepth: 0 });
    expect(noTucks.panels).toHaveLength(11);
    expect(noTucks.panels.some(({ id }) => id === 'topTuck' || id === 'bottomTuck')).toBe(false);

    const lidsOnly = model({ tuckDepth: 0, dustFlapDepth: 0 });
    expect(lidsOnly.panels).toHaveLength(7);
    expect(lidsOnly.steps.every(({ panelIds }) => panelIds.length > 0)).toBe(true);
    expect(validateFoldModel(lidsOnly)).toEqual([]);
  });

  it('uses the canonical child-left hinge orientation and outward physical angle', () => {
    const target = model();
    const pose = foldPose(1, target);
    expect(pose.get('P1')).toBe(0);
    for (const candidate of target.panels.filter(({ parent }) => parent !== null)) {
      expect(candidate.foldAngle).toBeCloseTo(-Math.PI / 2, 12);
      expect(pose.get(candidate.id)).toBeCloseTo(-Math.PI / 2, 12);
    }
  });
});
