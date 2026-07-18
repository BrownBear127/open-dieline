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
  it('diagnoses one physical front-side print surface for every completed RTE panel', () => {
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));

    expect(diagnoseFoldedPanelFaces(model)).toEqual(model.panels.map(({ id }) => ({
      panelId: id,
      exteriorFace: 'front',
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
});

describe('completed-fold overlap layering', () => {
  it('orders the glue seam, closure layers, and sliced-lid overlaps', () => {
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
    expect(panelOverlapPlan('topDustP2', 0.5)).toEqual({
      normalOffset: 0,
      polygonOffsetUnits: 0,
      renderOrder: 0,
    });
    expect(panelOverlapPlan('topLidC', 0.5)).toEqual({
      normalOffset: 0.55,
      polygonOffsetUnits: 0,
      renderOrder: 1,
    });
    expect(panelOverlapPlan('topLidL', 0.5)).toEqual({
      normalOffset: 0.55,
      polygonOffsetUnits: -1,
      renderOrder: 2,
    });
    expect(panelOverlapPlan('topLidR', 0.5)).toEqual(
      panelOverlapPlan('topLidL', 0.5),
    );
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
    ['topLidL', 'topLidC'],
    ['topLidL', 'topDustP2'],
    ['topLidC', 'topLidR'],
    ['topLidR', 'topDustP4'],
    ['bottomLidL', 'bottomLidC'],
    ['bottomLidL', 'bottomDustP4'],
    ['bottomLidC', 'bottomLidR'],
    ['bottomLidR', 'bottomDustP2'],
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
