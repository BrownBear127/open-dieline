import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/fold/pose3d';
import { panelGeometryPositions } from '@/ui/fold-scene';

describe('panelGeometryPositions', () => {
  it('triangulates a unit square and maps two-dimensional y down to Three.js y up', () => {
    const vertices: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];

    const positions = panelGeometryPositions(vertices);

    expect(positions).toHaveLength(18);
    expect([...positions]).toEqual([
      0, 0, 0,
      1, 0, 0,
      1, -1, 0,
      0, 0, 0,
      1, -1, 0,
      0, -1, 0,
    ]);
  });

  it('fans an eight-vertex convex tuck shape from its first vertex', () => {
    const vertices: Vec3[] = [
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 4, y: 1, z: 0 },
      { x: 4, y: 3, z: 0 },
      { x: 3, y: 4, z: 0 },
      { x: 1, y: 4, z: 0 },
      { x: 0, y: 3, z: 0 },
    ];

    const positions = panelGeometryPositions(vertices);

    expect(positions).toHaveLength(54);
    expect([...positions.slice(0, 9)]).toEqual([
      0, -1, 0,
      1, 0, 0,
      3, 0, 0,
    ]);
    expect([...positions.slice(-9)]).toEqual([
      0, -1, 0,
      1, -4, 0,
      0, -3, 0,
    ]);
  });

  it('preserves z coordinates for a non-planar folding state', () => {
    const vertices: Vec3[] = [
      { x: 0, y: 0, z: 1 },
      { x: 2, y: 0, z: 2 },
      { x: 2, y: 2, z: 3 },
      { x: 0, y: 2, z: 4 },
    ];

    const positions = panelGeometryPositions(vertices);

    expect([...positions].filter((_, index) => index % 3 === 2)).toEqual([
      1, 2, 3,
      1, 3, 4,
    ]);
  });
});
