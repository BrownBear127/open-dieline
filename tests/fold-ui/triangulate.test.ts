// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import type { Pt } from '@/fold/types';
import { earClipIndices, TriangulationError } from '@/ui/triangulate';
import {
  AREA_TOLERANCE_MM2,
  triangleInPolygon,
} from '../helpers/polygon-boolean';

function signedArea(polygon: readonly Pt[]): number {
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    doubledArea += current.x * next.y - next.x * current.y;
  }
  return doubledArea / 2;
}

function trianglesFromIndices(polygon: Pt[], indices: number[]): Array<[Pt, Pt, Pt]> {
  const triangles: Array<[Pt, Pt, Pt]> = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    triangles.push([
      polygon[indices[offset]!]!,
      polygon[indices[offset + 1]!]!,
      polygon[indices[offset + 2]!]!,
    ]);
  }
  return triangles;
}

describe('earClipIndices', () => {
  it('triangulates a convex polygon with the same total area and stable indices', () => {
    const polygon: Pt[] = [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 2 },
      { x: 4, y: 4 },
      { x: 1, y: 4 },
      { x: 0, y: 3 },
    ];

    const first = earClipIndices(polygon);
    const second = earClipIndices(polygon);
    const triangleArea = trianglesFromIndices(polygon, first)
      .reduce((sum, triangle) => sum + Math.abs(signedArea(triangle)), 0);

    expect(first).toEqual(second);
    expect(first).toHaveLength((polygon.length - 2) * 3);
    expect(Math.abs(triangleArea - Math.abs(signedArea(polygon))))
      .toBeLessThanOrEqual(AREA_TOLERANCE_MM2);
  });

  it('keeps every triangle inside a nine-vertex concave outline with a collinear boundary point', () => {
    const polygon: Pt[] = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
      { x: 0, y: 3 },
    ];

    const indices = earClipIndices(polygon);
    const triangles = trianglesFromIndices(polygon, indices);
    const triangleArea = triangles
      .reduce((sum, triangle) => sum + Math.abs(signedArea(triangle)), 0);

    expect(indices).toHaveLength((polygon.length - 2) * 3);
    expect(triangles.every((triangle) => triangleInPolygon(triangle, polygon))).toBe(true);
    expect(Math.abs(triangleArea - Math.abs(signedArea(polygon))))
      .toBeLessThanOrEqual(AREA_TOLERANCE_MM2);
  });

  it.each([
    ['fewer than three vertices', [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
    ['repeated vertices', [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
      { x: 2, y: 0 },
    ]],
    ['zero polygon area', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]],
  ] as const)('throws a named error for %s', (_label, polygon) => {
    expect(() => earClipIndices([...polygon])).toThrowError(TriangulationError);
  });

  it('throws a named error when a non-simple polygon has no valid ear', () => {
    const crossed: Pt[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 },
      { x: 3, y: 3 },
    ];

    expect(() => earClipIndices(crossed)).toThrowError(TriangulationError);
  });

  it.each([
    ['default', {}],
    ['extreme length and clearance', { L: 65, tuckClearance: 3 }],
  ] as const)('triangulates every existing RTE panel for %s parameters', (_label, overrides) => {
    const model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));

    for (const panel of model.panels) {
      expect(
        () => earClipIndices(panel.polygon),
        `panel ${panel.id}: ${JSON.stringify(panel.polygon)}`,
      ).not.toThrow();
    }
  });
});
