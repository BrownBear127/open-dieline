// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import { InvalidBoxParamsError } from '@/fold/derive/panelize';
import { mirrorFoldModel } from '@/fold/mirror';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import { FOLD_SCENE_REGISTRY } from '@/fold/registry';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel, Pt } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

const DEFAULT_PANEL_IDS = [
  'P1', 'P2', 'P3', 'P4', 'glue',
  'bottomLockP1', 'bottomWebP2', 'bottomReceiveP3', 'bottomWebP4',
  'topLid', 'topTuck', 'topDustP2', 'topDustP4',
].sort();

function model(overrides: Record<string, number | string> = {}): FoldModel {
  return buildTtslFoldModel(resolveParams(tuckTopSnapLock, overrides));
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

function isConcave(polygon: Pt[]): boolean {
  const signs = new Set<number>();
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const c = polygon[(index + 2) % polygon.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) signs.add(Math.sign(cross));
  }
  return signs.size > 1;
}

describe('TTSL FoldModel derived geometry', () => {
  it('uses the single concave receiving panel and retires all receiver fragments', () => {
    for (const glueSide of ['left', 'right'] as const) {
      const target = model({ glueSide });
      expect(target.panels.map(({ id }) => id).sort()).toEqual(DEFAULT_PANEL_IDS);
      expect(panel(target, 'bottomReceiveP3').parent).toBe('P3');
      expect(isConcave(panel(target, 'bottomReceiveP3').polygon)).toBe(true);
      expect(target.panels.some(({ id }) => /^bottomReceiveP3\./.test(id))).toBe(false);
    }
  });

  it('retains curved tuck, lock, wing, and receiving outlines without renderer lift offsets', () => {
    const target = model();
    for (const id of ['topTuck', 'bottomLockP1', 'bottomWebP2', 'bottomReceiveP3']) {
      expect(panel(target, id).polygon.length, id).toBeGreaterThan(6);
      expect(panel(target, id).liftOffset, id).toBeUndefined();
    }
  });

  it('keeps generator thickness compensation in the panelized body', () => {
    const params = resolveParams(tuckTopSnapLock, {});
    const target = buildTtslFoldModel(params);
    const thickness = params.thickness as number;

    expect(width(panel(target, 'P2'))).toBeCloseTo((params.W as number) + thickness, 9);
    expect(width(panel(target, 'P3'))).toBeCloseTo((params.L as number) + thickness, 9);
  });

  it('consumes post-mirror geometry while preserving the tagged glue parent', () => {
    expect(panel(model({ glueSide: 'left' }), 'glue').parent).toBe('P1');
    expect(panel(model({ glueSide: 'right' }), 'glue').parent).toBe('P1');
  });

  it('fails loud when an error invariant rejects the parameters', () => {
    expect(() => model({ lockReceiveWidth: 10, lockTabWidth: 40 })).toThrow(InvalidBoxParamsError);
  });
});

describe('TTSL FoldModel integration contracts', () => {
  it('passes validation and remains registered', () => {
    expect(validateFoldModel(model())).toEqual([]);
    const entry = FOLD_SCENE_REGISTRY.ttsl!;
    const params = resolveParams(tuckTopSnapLock, {});
    expect(entry.capabilities.previewScene).toBe(true);
    expect(entry.sceneSpec!(params).pieces[0]!.buildModel(params)).toEqual(
      buildTtslFoldModel(params),
    );
  });

  it('uses the single-receiver physical fold schedule', () => {
    expect(model().steps).toEqual([
      { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.3, ease: 'powerInOut' },
      { panelIds: ['bottomWebP2'], t0: 0.3, t1: 0.375, ease: 'backIn' },
      { panelIds: ['bottomWebP4'], t0: 0.375, t1: 0.45, ease: 'backIn' },
      { panelIds: ['bottomReceiveP3'], t0: 0.45, t1: 0.525, ease: 'backIn' },
      { panelIds: ['bottomLockP1'], t0: 0.525, t1: 0.6, ease: 'backIn' },
      { panelIds: ['topDustP2', 'topDustP4'], t0: 0.6, t1: 0.72, ease: 'backIn' },
      { panelIds: ['topTuck'], t0: 0.72, t1: 0.85, ease: 'backIn' },
      { panelIds: ['topLid'], t0: 0.85, t1: 1, ease: 'powerInOut' },
    ]);
  });

  it('tracks every non-root hinge back to one active crease path', () => {
    const target = model();
    const nonRoot = target.panels.filter(({ parent }) => parent !== null);
    expect(nonRoot).toHaveLength(12);
    expect(nonRoot.every(({ hingeSourceCreaseIds }) => hingeSourceCreaseIds?.length === 1)).toBe(true);
  });

  it('uses canonical child-left hinges and the outward physical angle throughout the trajectory', () => {
    const target = model();
    const pose = foldPose(1, target);
    expect(pose.get('P1')).toBe(0);
    for (const candidate of target.panels.filter(({ parent }) => parent !== null)) {
      expect(candidate.foldAngle).toBeCloseTo(-Math.PI / 2, 12);
      expect(pose.get(candidate.id)).toBeCloseTo(-Math.PI / 2, 12);
    }
  });
});

it('mirrorFoldModel remains immutable while it has no production caller', () => {
  const source = model({ glueSide: 'left' });
  const before = JSON.stringify(source);
  mirrorFoldModel(source, 140);
  expect(JSON.stringify(source)).toBe(before);
});

it('mirrorFoldModel mirrors line/arc/bezier dieline geometry and flips arc sweep', () => {
  const source = model({ glueSide: 'left' });
  source.dieline = [{
    id: 'mixed-guide',
    type: 'cut',
    segments: [
      { kind: 'line', x1: 1, y1: 2, x2: 3, y2: 4 },
      { kind: 'arc', cx: 5, cy: 6, r: 7, startAngle: 0.25, endAngle: 1.5, ccw: true },
      {
        kind: 'bezier',
        x1: 8,
        y1: 9,
        c1x: 10,
        c1y: 11,
        c2x: 12,
        c2y: 13,
        x2: 14,
        y2: 15,
      },
    ],
  }];

  const mirrored = mirrorFoldModel(source, 20);

  expect(mirrored.dieline).toEqual([{
    id: 'mixed-guide',
    type: 'cut',
    segments: [
      { kind: 'line', x1: 39, y1: 2, x2: 37, y2: 4 },
      {
        kind: 'arc',
        cx: 35,
        cy: 6,
        r: 7,
        startAngle: Math.PI - 0.25,
        endAngle: Math.PI - 1.5,
        ccw: false,
      },
      {
        kind: 'bezier',
        x1: 32,
        y1: 9,
        c1x: 30,
        c1y: 11,
        c2x: 28,
        c2y: 13,
        x2: 26,
        y2: 15,
      },
    ],
  }]);
  expect(mirrored.dieline).not.toBe(source.dieline);
  expect(mirrored.dieline[0]!.segments).not.toBe(source.dieline[0]!.segments);
});
