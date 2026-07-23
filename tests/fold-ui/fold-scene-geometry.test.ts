// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/fold/pose3d';
import type { Pt } from '@/fold/types';
import {
  artworkPointUv,
  flatDielineUvFrame,
  panelGeometryPositions,
  panelSolidPositions,
  panelSolidUvs,
} from '@/ui/fold-scene';
import { earClipIndices } from '@/ui/triangulate';

function flatIndices(vertices: ReadonlyArray<Pick<Vec3, 'x' | 'y'>>): number[] {
  return earClipIndices(vertices.map(({ x, y }) => ({ x, y })));
}

function polygonArea(vertices: ReadonlyArray<Pick<Vec3, 'x' | 'y'>>): number {
  let doubledArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    doubledArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubledArea) / 2;
}

function positionsArea(positions: Float32Array): number {
  let area = 0;
  for (let offset = 0; offset < positions.length; offset += 9) {
    const ax = positions[offset]!;
    const ay = positions[offset + 1]!;
    const bx = positions[offset + 3]!;
    const by = positions[offset + 4]!;
    const cx = positions[offset + 6]!;
    const cy = positions[offset + 7]!;
    area += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return area;
}

describe('panelGeometryPositions', () => {
  it('triangulates a unit square and maps two-dimensional y down to Three.js y up', () => {
    const vertices: Vec3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];

    const positions = panelGeometryPositions(vertices, flatIndices(vertices));

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

  it('triangulates an eight-vertex convex tuck shape with equivalent area', () => {
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

    const positions = panelGeometryPositions(vertices, flatIndices(vertices));

    expect(positions).toHaveLength(54);
    expect(positionsArea(positions)).toBe(polygonArea(vertices));
  });

  it('preserves z coordinates for a non-planar folding state', () => {
    const vertices: Vec3[] = [
      { x: 0, y: 0, z: 1 },
      { x: 2, y: 0, z: 2 },
      { x: 2, y: 2, z: 3 },
      { x: 0, y: 2, z: 4 },
    ];

    const positions = panelGeometryPositions(vertices, flatIndices(vertices));

    expect([...positions].filter((_, index) => index % 3 === 2)).toEqual([
      1, 2, 3,
      1, 3, 4,
    ]);
  });
});

describe('panelSolidPositions', () => {
  const frontFacingSquare: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 1, y: 0, z: 0 },
  ];
  const indices = flatIndices(frontFacingSquare);

  it('extrudes a unit square behind its nominal front face and closes every side wall', () => {
    const positions = panelSolidPositions(frontFacingSquare, indices, 0.5);

    expect(positions).toHaveLength(36 * 3);
    expect([...positions]).toEqual([
      // Front face: two triangles on the nominal plane, facing Three.js +z.
      0, 0, 0, 0, -1, 0, 1, -1, 0,
      0, 0, 0, 1, -1, 0, 1, 0, 0,
      // Back face: reversed winding, displaced 0.5 along -z.
      0, 0, -0.5, 1, -1, -0.5, 0, -1, -0.5,
      0, 0, -0.5, 1, 0, -0.5, 1, -1, -0.5,
      // Side wall: (0, 0, 0) -> (0, -1, 0).
      0, 0, 0, 0, 0, -0.5, 0, -1, -0.5,
      0, 0, 0, 0, -1, -0.5, 0, -1, 0,
      // Side wall: (0, -1, 0) -> (1, -1, 0).
      0, -1, 0, 0, -1, -0.5, 1, -1, -0.5,
      0, -1, 0, 1, -1, -0.5, 1, -1, 0,
      // Side wall: (1, -1, 0) -> (1, 0, 0).
      1, -1, 0, 1, -1, -0.5, 1, 0, -0.5,
      1, -1, 0, 1, 0, -0.5, 1, 0, 0,
      // Side wall: (1, 0, 0) -> (0, 0, 0).
      1, 0, 0, 1, 0, -0.5, 0, 0, -0.5,
      1, 0, 0, 0, 0, -0.5, 0, 0, 0,
    ]);
  });

  it('returns the original flat triangulation when thickness is zero', () => {
    expect([...panelSolidPositions(frontFacingSquare, indices, 0)]).toEqual([
      ...panelGeometryPositions(frontFacingSquare, indices),
    ]);
  });

  it('places the back face on the negative-z side when the front faces positive z', () => {
    const positions = panelSolidPositions(frontFacingSquare, indices, 0.5);
    const frontZ = [...positions.slice(0, 18)].filter((_, index) => index % 3 === 2);
    const backZ = [...positions.slice(18, 36)].filter((_, index) => index % 3 === 2);

    expect(frontZ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(backZ).toEqual([-0.5, -0.5, -0.5, -0.5, -0.5, -0.5]);
  });
});

describe('whole-sheet flattened UVs', () => {
  const leftPanel: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 },
    { x: 0, y: 2, z: 0 },
  ];
  const rightPanel: Vec3[] = [
    { x: 2, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 2, z: 0 },
    { x: 2, y: 2, z: 0 },
  ];
  const flatGeometry = new Map([
    ['left', leftPanel],
    ['right', rightPanel],
  ]);
  const leftIndices = flatIndices(leftPanel);
  const rightIndices = flatIndices(rightPanel);

  it('centers the short bbox axis while preserving the long-axis scale', () => {
    const frame = flatDielineUvFrame(flatGeometry);

    expect(frame).toEqual({ minX: 0, minY: 0, span: 4, offsetX: 0, offsetY: 1 });
    expect([...panelSolidUvs(leftPanel, leftIndices, frame, 0)]).toEqual([
      0, 0.75,
      0.5, 0.75,
      0.5, 0.25,
      0, 0.75,
      0.5, 0.25,
      0, 0.25,
    ]);
  });

  it('gives shared dieline vertices identical UVs across adjacent panels', () => {
    const frame = flatDielineUvFrame(flatGeometry);
    const leftUvs = panelSolidUvs(leftPanel, leftIndices, frame, 0);
    const rightUvs = panelSolidUvs(rightPanel, rightIndices, frame, 0);

    expect([...leftUvs.slice(2, 4)]).toEqual([...rightUvs.slice(0, 2)]);
    expect([...leftUvs.slice(8, 10)]).toEqual([...rightUvs.slice(10, 12)]);
  });

  it('reuses corresponding front-face UVs for the back face and side walls', () => {
    const frame = flatDielineUvFrame(flatGeometry);
    const uvs = panelSolidUvs(leftPanel, leftIndices, frame, 0.5);

    expect(uvs).toHaveLength(panelSolidPositions(leftPanel, leftIndices, 0.5).length / 3 * 2);
    expect([...uvs.slice(12, 24)]).toEqual([
      0, 0.75,
      0.5, 0.25,
      0.5, 0.75,
      0, 0.75,
      0, 0.25,
      0.5, 0.25,
    ]);
    expect([...uvs.slice(24, 30)]).toEqual([
      0, 0.75,
      0, 0.75,
      0.5, 0.75,
    ]);
  });

  it('keeps checkerboard UV interpolation aligned on concave front, back, and thickness walls', () => {
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
    const frame = flatDielineUvFrame(new Map([
      ['concave', polygon.map((point) => ({ ...point, z: 0 }))],
    ]));
    const uvs = panelSolidUvs(polygon, indices, frame, 0.5);
    const faceVertexCount = indices.length;
    const samples = [0, Math.floor(indices.length / 6) * 3, indices.length - 3];
    const weights = [0.2, 0.3, 0.5] as const;
    const checker = ({ u, v }: { u: number; v: number }): number =>
      (Math.floor(u * 8) + Math.floor(v * 8)) % 2;

    for (const indexOffset of samples) {
      const frontOrder = indices.slice(indexOffset, indexOffset + 3);
      const backOrder = [frontOrder[0]!, frontOrder[2]!, frontOrder[1]!];
      for (const [faceOffset, order] of [[0, frontOrder], [faceVertexCount, backOrder]] as const) {
        const triangleNumber = indexOffset / 3;
        const uvVertexOffset = (faceOffset + triangleNumber * 3) * 2;
        const point = order.reduce((sum, vertexIndex, corner) => ({
          x: sum.x + polygon[vertexIndex]!.x * weights[corner]!,
          y: sum.y + polygon[vertexIndex]!.y * weights[corner]!,
        }), { x: 0, y: 0 });
        const interpolated = weights.reduce((sum, weight, corner) => ({
          u: sum.u + uvs[uvVertexOffset + corner * 2]! * weight,
          v: sum.v + uvs[uvVertexOffset + corner * 2 + 1]! * weight,
        }), { u: 0, v: 0 });
        const direct = artworkPointUv(point, frame);

        expect(interpolated.u).toBeCloseTo(direct.u, 6);
        expect(interpolated.v).toBeCloseTo(direct.v, 6);
        expect(checker(interpolated)).toBe(checker(direct));
      }
    }

    const sideUvOffset = faceVertexCount * 4;
    const first = artworkPointUv(polygon[0]!, frame);
    const next = artworkPointUv(polygon[1]!, frame);
    expect([...uvs.slice(sideUvOffset, sideUvOffset + 12)]).toEqual([
      first.u, first.v,
      first.u, first.v,
      next.u, next.v,
      first.u, first.v,
      next.u, next.v,
      next.u, next.v,
    ]);
  });
});
