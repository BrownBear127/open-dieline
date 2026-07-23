// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { InvalidBoxParamsError } from '@/fold/derive/panelize';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { worldGeometry } from '@/fold/pose3d';
import { FOLD_MODEL_BUILDERS } from '@/fold/registry';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel, Pt } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';
import {
  dist,
  distToPlane,
  endMainAxisAngle,
  faceAPlane,
  freeEdgeEndpoints,
  maxVertexDistToFinitePanel,
  slotSegmentFrom2D,
  slotWidthOf,
  tabSignedDistancesToSlotLine,
  tabSlotCrossSection,
  targetOf,
  TTB_LEGAL_COMBOS,
  WINGS,
  wingCoverage,
} from '../helpers/ttb-fold';

const DEFAULT_PANEL_IDS = [
  'faceA',
  'faceB',
  'faceC',
  'zoneDBase',
  'zoneDLip',
  'zoneDTab',
  'endStartMain',
  'endStartWingTop',
  'endStartWingBottom',
  'endEndMain',
  'endEndWingTop',
  'endEndWingBottom',
].sort();

function model(overrides: Record<string, number> = {}): FoldModel {
  return buildTtbFoldModel(resolveParams(triangularTube, overrides));
}

function panel(target: FoldModel, id: string): FoldPanel {
  const result = target.panels.find((candidate) => candidate.id === id);
  expect(result, `missing panel ${id}`).toBeDefined();
  return result!;
}

function interiorAngle(a: number, b: number, c: number): number {
  return Math.acos((a * a + b * b - c * c) / (2 * a * b));
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

function childSide(target: FoldPanel): number {
  const hinge = target.hingeLine!;
  const centroid = target.polygon.reduce(
    (sum, point) => ({
      x: sum.x + point.x / target.polygon.length,
      y: sum.y + point.y / target.polygon.length,
    }),
    { x: 0, y: 0 },
  );
  return (hinge.b.x - hinge.a.x) * (centroid.y - hinge.a.y)
    - (hinge.b.y - hinge.a.y) * (centroid.x - hinge.a.x);
}

describe('TTB FoldModel derived geometry', () => {
  it('uses one nine-vertex concave tab and retires every fragment id', () => {
    const target = model();
    const lip = panel(target, 'zoneDLip');
    const tab = panel(target, 'zoneDTab');

    expect(target.panels.map(({ id }) => id).sort()).toEqual(DEFAULT_PANEL_IDS);
    expect(lip.parent).toBe('zoneDBase');
    expect(lip.hingeLine?.virtual).toBe(true);
    expect(tab.parent).toBe('zoneDLip');
    expect(tab.polygon).toHaveLength(9);
    expect(isConcave(tab.polygon)).toBe(true);
    expect(target.panels.some(({ id }) => id.startsWith('zoneDTab.'))).toBe(false);
    expect(target.steps.flatMap(({ panelIds }) => panelIds)).toContain('zoneDTab');
  });

  it('keeps the three interior-angle substitutions with canonical hinge signs', () => {
    const target = model();
    const edgeA = 58.5;
    const edgeB = edgeA + 1.5;
    const edgeC = edgeA + 2.5;

    expect(panel(target, 'faceB').foldAngle)
      .toBeCloseTo(-(Math.PI - interiorAngle(edgeA, edgeB, edgeC)), 12);
    expect(panel(target, 'faceC').foldAngle)
      .toBeCloseTo(-(Math.PI - interiorAngle(edgeB, edgeC, edgeA)), 12);
    expect(panel(target, 'zoneDBase').foldAngle)
      .toBeCloseTo(-(Math.PI - interiorAngle(edgeC, edgeA, edgeB)), 12);
    expect(panel(target, 'zoneDLip').foldAngle)
      .toBeCloseTo(-(Math.PI - interiorAngle(edgeA, edgeB, edgeC)), 12);
    expect(panel(target, 'zoneDTab').foldAngle)
      .toBeCloseTo(-interiorAngle(edgeA, edgeB, edgeC), 12);
  });

  it('tracks every non-root panel to active tagged crease paths without exemptions', () => {
    const target = model();
    const nonRoot = target.panels.filter(({ parent }) => parent !== null);

    expect(nonRoot).toHaveLength(11);
    for (const candidate of nonRoot) {
      if (candidate.hingeLine?.virtual) {
        expect(candidate.hingeSourceCreaseIds, candidate.id).toBeUndefined();
      } else {
        expect(candidate.hingeSourceCreaseIds?.length, candidate.id).toBeGreaterThan(0);
      }
      expect(childSide(candidate), candidate.id).toBeGreaterThan(0);
    }
    expect(panel(target, 'faceB').hingeSourceCreaseIds).toHaveLength(2);
    expect(panel(target, 'zoneDTab').hingeSourceCreaseIds).toHaveLength(2);
  });

  it('fails loud when an error invariant rejects the parameters', () => {
    expect(() => model({ tubeLength: 60 })).toThrow(InvalidBoxParamsError);
  });
});

describe('TTB folded physical contracts', () => {
  it.each(TTB_LEGAL_COMBOS)('keeps the Zone D family inside edgeA and moves the tab off faceA: %j', (overrides) => {
    const params = resolveParams(triangularTube, overrides);
    const target = buildTtbFoldModel(params);
    const geometry = worldGeometry(target, foldPose(1, target));
    const edgeA = params.edgeA as number;

    for (const panelId of ['zoneDBase', 'zoneDLip', 'zoneDTab']) {
      for (const vertex of geometry.get(panelId) ?? []) {
        expect(vertex.y, `${panelId} protrudes past edgeA`).toBeLessThanOrEqual(edgeA + 0.01);
      }
    }

    const facePlane = faceAPlane(geometry);
    const tabDistances = geometry.get('zoneDTab')!.map((vertex) => distToPlane(vertex, facePlane));
    expect(Math.min(...tabDistances)).toBeGreaterThan(1);
  });

  it.each(TTB_LEGAL_COMBOS)('closes the side seam and keeps the single tab fully inserted past its slot: %j', (overrides) => {
    const params = resolveParams(triangularTube, overrides);
    const target = buildTtbFoldModel(params);
    const geometry = worldGeometry(target, foldPose(1, target));
    const seamA = freeEdgeEndpoints(geometry, 'faceA');
    const seamC = freeEdgeEndpoints(geometry, 'faceC');

    expect(dist(seamA[0], seamC[0])).toBeLessThan(0.01);
    expect(dist(seamA[1], seamC[1])).toBeLessThan(0.01);

    const slot = slotSegmentFrom2D(params);
    const signed = tabSignedDistancesToSlotLine(geometry, slot);
    expect(signed.rootSide).toBeLessThan(0);
    expect(signed.tipSide).toBeLessThan(0);
    const crossSection = tabSlotCrossSection(geometry, slot);
    expect(crossSection.tabFullWidth - slotWidthOf(params)).toBeCloseTo(16, 2);
  });

  it('retains the end-cap distance and coverage envelope across legal parameters', () => {
    for (const overrides of TTB_LEGAL_COMBOS) {
      const target = model(overrides);
      const geometry = worldGeometry(target, foldPose(1, target));

      for (const side of ['Start', 'End'] as const) {
        expect(endMainAxisAngle(geometry, `end${side}Main`)).toBeLessThan((6 * Math.PI) / 180);
      }
      for (const wing of WINGS) {
        expect(maxVertexDistToFinitePanel(geometry, wing, targetOf(wing))).toBeLessThanOrEqual(2.6);
        expect(wingCoverage(geometry, wing, targetOf(wing))).toBeGreaterThan(0.9);
      }
    }
  });
});

describe('TTB FoldModel integration contracts', () => {
  it('passes validation and remains registered', () => {
    expect(validateFoldModel(model())).toEqual([]);
    expect(FOLD_MODEL_BUILDERS.ttb).toBe(buildTtbFoldModel);
  });

  it('uses the sweep pre-curl, tail-first-completion fold schedule', () => {
    const target = model();
    expect(target.steps).toEqual([
      {
        panelIds: [
          'endStartWingTop',
          'endStartWingBottom',
          'endEndWingTop',
          'endEndWingBottom',
        ],
        t0: 0,
        t1: 0.22,
        ease: 'backIn',
      },
      { panelIds: ['endStartMain', 'endEndMain'], t0: 0.22, t1: 0.42, ease: 'powerInOut' },
      { panelIds: ['faceB', 'faceC'], t0: 0.42, t1: 0.72, ease: 'powerInOut' },
      { panelIds: ['zoneDBase'], t0: 0.55, t1: 0.9, ease: 'powerInOut' },
      { panelIds: ['zoneDLip'], t0: 0.55, t1: 0.85, ease: 'powerInOut' },
      { panelIds: ['zoneDTab'], t0: 0.58, t1: 0.85, ease: 'powerInOut' },
    ]);

    // 掃掠段（faceB/faceC 窗尾）zoneD 三 hinge 皆已捲入——非剛體直板。
    const sweepEnd = foldPose(0.72, target);
    expect(sweepEnd.get('zoneDBase')).not.toBe(0);
    expect(sweepEnd.get('zoneDLip')).not.toBe(0);
    expect(sweepEnd.get('zoneDTab')).not.toBe(0);
    // 尾鉤早收滿：base 收攏完成（t=0.9）時 lip/tab 已達目標角。
    const boundary = foldPose(0.9, target);
    expect(boundary.get('zoneDBase')).toBeCloseTo(panel(target, 'zoneDBase').foldAngle, 12);
    expect(boundary.get('zoneDLip')).toBeCloseTo(panel(target, 'zoneDLip').foldAngle, 12);
    expect(boundary.get('zoneDTab')).toBeCloseTo(panel(target, 'zoneDTab').foldAngle, 12);
    expect(foldPose(1, target).get('zoneDTab')).toBeCloseTo(panel(target, 'zoneDTab').foldAngle, 12);
  });
});
