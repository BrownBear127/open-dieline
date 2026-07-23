// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { BackSide, FrontSide } from 'three';
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import {
  diagnoseFoldedPanelFaces,
  foldedArtworkFace,
  panelOverlapPlan,
  panelRenderVertices,
  panelSurfacePlan,
} from '@/ui/fold-scene';

describe('folded artwork surface selection', () => {
  it('diagnoses the completed single-lid surfaces while retaining the front print side', () => {
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));

    expect(diagnoseFoldedPanelFaces(model)).toEqual(model.panels.map(({ id }) => ({
      panelId: id,
      exteriorFace: id === 'topLid' || id === 'topDustP2' ? 'back' : 'front',
    })));
    expect(foldedArtworkFace(model)).toBe('front');
  });

  it('assigns artwork only to the physical front face and plain paper to the inner face and walls', () => {
    expect(panelSurfacePlan(4, 0.5, 'front')).toEqual({
      artworkSide: FrontSide,
      paperSide: FrontSide,
      groups: [
        { start: 0, count: 6, materialIndex: 1 },
        { start: 6, count: 6, materialIndex: 0 },
        { start: 12, count: 24, materialIndex: 1 },
      ],
    });
  });

  it('renders opposite materials on the two sides of zero-thickness card', () => {
    expect(panelSurfacePlan(4, 0, 'front')).toEqual({
      artworkSide: BackSide,
      paperSide: FrontSide,
      groups: [
        { start: 0, count: 6, materialIndex: 0 },
        { start: 0, count: 6, materialIndex: 1 },
      ],
    });
  });

  it('uses the actual triangle-index count for a collinear boundary-touch panel', () => {
    expect(panelSurfacePlan(8, 0.5, 'front', 15)).toEqual({
      artworkSide: FrontSide,
      paperSide: FrontSide,
      groups: [
        { start: 0, count: 15, materialIndex: 1 },
        { start: 15, count: 15, materialIndex: 0 },
        { start: 30, count: 48, materialIndex: 1 },
      ],
    });
  });
});

describe('completed-fold overlap layering', () => {
  it('orders the glue seam and single-lid closure layers', () => {
    expect(panelOverlapPlan('P4', 0.5)).toEqual({
      normalOffset: 0,
      polygonOffsetUnits: 0,
      renderOrder: 0,
    });
    expect(panelOverlapPlan('glue', 0.5)).toEqual({
      normalOffset: -0.55,
      polygonOffsetUnits: 1,
      renderOrder: -1,
    });
    expect(panelOverlapPlan('topTuck', 0.5)).toEqual({
      normalOffset: -1.1,
      polygonOffsetUnits: 0,
      renderOrder: -2,
    });
    expect(panelOverlapPlan('bottomTuck', 0.5)).toEqual(
      panelOverlapPlan('topTuck', 0.5),
    );
    const topDustP2Plan = panelOverlapPlan('topDustP2', 0.5);
    expect(topDustP2Plan.normalOffset).toBeCloseTo(-1.65, 9);
    expect(topDustP2Plan.polygonOffsetUnits).toBe(1);
    expect(topDustP2Plan.renderOrder).toBe(-3);
    expect(panelOverlapPlan('topLid', 0.5)).toEqual({
      normalOffset: 0.55,
      polygonOffsetUnits: 0,
      renderOrder: 1,
    });
  });

  it('keeps a small non-zero separation in zero-thickness card mode', () => {
    expect(panelOverlapPlan('bottomLid', 0).normalOffset).toBe(0.05);
    expect(panelOverlapPlan('glue', 0).normalOffset).toBe(-0.05);
    expect(panelOverlapPlan('bottomTuck', 0).normalOffset).toBe(-0.1);
  });

  it('ramps the render-only layer offset with fold completion and leaves flat geometry unchanged', () => {
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { tuckLock: 0 }));
    const lid = model.panels.find(({ id }) => id === 'topLid')!;
    const vertices = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];

    expect(panelRenderVertices(lid, vertices, 0, 'front', 0.5)).toBe(vertices);
    expect(panelRenderVertices(lid, vertices, lid.foldAngle / 2, 'front', 0.5))
      .toEqual(vertices.map((vertex) => ({ ...vertex, z: 0.275 })));
    expect(panelRenderVertices(lid, vertices, lid.foldAngle, 'front', 0.5))
      .toEqual(vertices.map((vertex) => ({ ...vertex, z: 0.55 })));

    const tuck = model.panels.find(({ id }) => id === 'topTuck')!;
    expect(panelRenderVertices(tuck, vertices, tuck.foldAngle, 'front', 0.5))
      .toEqual(vertices.map((vertex) => ({ ...vertex, z: -1.1 })));
  });

  it.each([
    ['P4', 'glue'],
    ['P1', 'glue'],
    ['P1', 'topTuck'],
    ['P3', 'bottomTuck'],
    ['glue', 'topTuck'],
    ['topLid', 'topDustP2'],
    ['topLid', 'topDustP4'],
    ['bottomLid', 'bottomDustP2'],
    ['bottomLid', 'bottomDustP4'],
  ])('%s / %s no longer share the same depth layer', (first, second) => {
    const firstPlan = panelOverlapPlan(first, 0.5);
    const secondPlan = panelOverlapPlan(second, 0.5);

    expect(
      firstPlan.normalOffset !== secondPlan.normalOffset
      || firstPlan.polygonOffsetUnits !== secondPlan.polygonOffsetUnits,
    ).toBe(true);
  });
});
