// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import type { GenerateResult } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { flattenSegment } from '@/fold/derive/flatten';
import {
  extractFaces,
  PlanarFacesError,
  type FaceGraph,
  type PlanarSegmentInput,
} from '@/fold/derive/planar-faces';
import type { Pt } from '@/fold/types';

const point = (x: number, y: number): Pt => ({ x, y });

function rectangle(): PlanarSegmentInput {
  return {
    polyline: [point(0, 0), point(10, 0), point(10, 10), point(0, 10), point(0, 0)],
    pathId: 'outline',
    kind: 'cut',
  };
}

function polygonArea(outline: Pt[]): number {
  return Math.abs(outline.reduce((sum, current, index) => {
    const next = outline[(index + 1) % outline.length]!;
    return sum + current.x * next.y - next.x * current.y;
  }, 0) / 2);
}

function edgeLength(edge: { a: Pt; b: Pt }): number {
  return Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
}

function distanceToLine(pointToMeasure: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx * (pointToMeasure.y - a.y) - dy * (pointToMeasure.x - a.x))
    / Math.hypot(dx, dy);
}

function activeGeometry(result: GenerateResult): PlanarSegmentInput[] {
  return result.paths.flatMap((path) => {
    if (path.type !== 'cut' && path.type !== 'crease') return [];
    const kind: PlanarSegmentInput['kind'] = path.type;
    const inactive = new Set(path.inactiveSegments ?? []);
    return path.segments.flatMap((segment, index) => inactive.has(index)
      ? []
      : [{
          polyline: flattenSegment(segment, 0.05),
          pathId: path.id,
          kind,
        } satisfies PlanarSegmentInput]);
  });
}

function logicalPanelCount(result: GenerateResult): number {
  return 1 + new Set(result.paths.flatMap((path) => path.tags?.filter((tag) => tag.startsWith('fold:')) ?? [])).size;
}

function findAdjacency(graph: FaceGraph, predicate: (pathIds: string[]) => boolean) {
  return graph.adjacency.find((entry) => predicate(entry.sharedEdges.map(({ pathId }) => pathId)));
}

describe('extractFaces 合成拓撲', () => {
  it('矩形外框加一條貫穿 crease：抽出兩面與一組 crease 相鄰關係', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'fold', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(2);
    expect(graph.outerBoundary).toHaveLength(4);
    expect(graph.faces.every(({ outline }) => polygonArea(outline) === 50)).toBe(true);
    expect(graph.adjacency).toEqual([
      {
        faceA: expect.any(Number),
        faceB: expect.any(Number),
        sharedEdges: [{ a: point(0, 5), b: point(10, 5), pathId: 'fold', kind: 'crease' }],
      },
    ]);
  });

  it('A/B crease 被中央 cut 打斷：仍是兩面，且共享邊保留兩段 crease 與中段 cut', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(4, 5)], pathId: 'fold-left', kind: 'crease' },
      { polyline: [point(4, 5), point(6, 5)], pathId: 'slot', kind: 'cut' },
      { polyline: [point(6, 5), point(10, 5)], pathId: 'fold-right', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(2);
    expect(graph.adjacency).toHaveLength(1);
    expect(graph.adjacency[0]!.sharedEdges.map(({ pathId, kind }) => ({ pathId, kind }))).toEqual([
      { pathId: 'fold-left', kind: 'crease' },
      { pathId: 'slot', kind: 'cut' },
      { pathId: 'fold-right', kind: 'crease' },
    ]);
  });

  it('面內死端 slit：不新增面，並歸入 containingFace', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(5, 0), point(5, 4)], pathId: 'slit', kind: 'cut' },
    ]);

    expect(graph.faces).toHaveLength(1);
    expect(graph.adjacency).toHaveLength(0);
    expect(graph.danglingCuts).toEqual([
      { a: point(5, 0), b: point(5, 4), pathId: 'slit', containingFace: 0 },
    ]);
  });

  it('面外死端 cut 找不到 containingFace 時具名失敗', () => {
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(20, 20), point(21, 20)], pathId: 'orphan-cut', kind: 'cut' },
    ])).toThrowError(PlanarFacesError);
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(20, 20), point(21, 20)], pathId: 'orphan-cut', kind: 'cut' },
    ])).toThrow(/死端 cut.*orphan-cut.*歸屬/);
  });

  it('T-junction 端點相差 1e-7：snap 後成為同一節點並抽出三面', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'horizontal', kind: 'crease' },
      { polyline: [point(5, 0), point(5, 5 + 1e-7)], pathId: 'vertical', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(3);
    expect(graph.adjacency).toHaveLength(3);
    expect(graph.adjacency.flatMap(({ sharedEdges }) => sharedEdges).some(({ a, b }) =>
      (a.x === 5 && a.y === 5) || (b.x === 5 && b.y === 5))).toBe(true);
  });

  it('T-junction 端點距段內 0.003mm：junction 容差連接後抽出三面', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'horizontal', kind: 'crease' },
      { polyline: [point(5, 0), point(5, 4.997)], pathId: 'vertical', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(3);
    expect(graph.adjacency).toHaveLength(3);
  });

  it('T-junction 端點距段內 0.5mm：維持開放並沿用懸空 crease 具名失敗', () => {
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'horizontal', kind: 'crease' },
      { polyline: [point(5, 0), point(5, 4.5)], pathId: 'open-gap', kind: 'crease' },
    ])).toThrowError(PlanarFacesError);
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'horizontal', kind: 'crease' },
      { polyline: [point(5, 0), point(5, 4.5)], pathId: 'open-gap', kind: 'crease' },
    ])).toThrow(/懸空 crease.*open-gap/);
  });

  it('自由懸空 crease：具名拋出 PlanarFacesError', () => {
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(4, 5)], pathId: 'dangling-fold', kind: 'crease' },
    ])).toThrowError(PlanarFacesError);
    expect(() => extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(4, 5)], pathId: 'dangling-fold', kind: 'crease' },
    ])).toThrow(/懸空 crease.*dangling-fold/);
  });

  it('互補的水平／垂直 crease 讓位缺口：沿原方向補到共同交點，不形成斜接', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(4, 5)], pathId: 'horizontal-gap', kind: 'crease' },
      { polyline: [point(5, 6), point(5, 10)], pathId: 'vertical-gap', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(2);
    expect(graph.adjacency).toHaveLength(1);
    expect(graph.adjacency[0]!.sharedEdges.map(({ pathId }) => pathId)).toEqual([
      'horizontal-gap',
      'vertical-gap',
    ]);
  });

  it('L 形凹外框：保留單一 CCW 簡單凹面', () => {
    const graph = extractFaces([{
      polyline: [
        point(0, 0), point(4, 0), point(4, 2), point(2, 2), point(2, 4), point(0, 4), point(0, 0),
      ],
      pathId: 'concave-outline',
      kind: 'cut',
    }]);

    expect(graph.faces).toHaveLength(1);
    expect(graph.faces[0]!.outline).toHaveLength(6);
    expect(polygonArea(graph.faces[0]!.outline)).toBe(12);
  });

  it('兩條貫穿線真交叉：交點成節並抽出四面', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(10, 5)], pathId: 'horizontal', kind: 'crease' },
      { polyline: [point(5, 0), point(5, 10)], pathId: 'vertical', kind: 'crease' },
    ]);

    expect(graph.faces).toHaveLength(4);
    expect(graph.adjacency).toHaveLength(4);
  });

  it('共線重疊與重複段：合併為無重複的十毫米共享邊', () => {
    const graph = extractFaces([
      rectangle(),
      { polyline: [point(0, 5), point(7, 5)], pathId: 'overlap', kind: 'crease' },
      { polyline: [point(3, 5), point(10, 5)], pathId: 'overlap', kind: 'crease' },
      { polyline: [point(3, 5), point(7, 5)], pathId: 'overlap', kind: 'crease' },
      { polyline: [point(2, 2), point(2, 2)], pathId: 'zero', kind: 'cut' },
    ]);

    expect(graph.faces).toHaveLength(2);
    expect(graph.adjacency).toHaveLength(1);
    expect(graph.adjacency[0]!.sharedEdges.reduce((sum, edge) => sum + edgeLength(edge), 0)).toBe(10);
  });
});

describe('extractFaces 真實 generate() 幾何', () => {
  it('ttb 預設：全部 active 幾何面數等於 logical panel 數，zoneDNotch T-junction 成節', () => {
    const result = triangularTube.generate(resolveParams(triangularTube));
    const graph = extractFaces(activeGeometry(result));
    const notchPath = result.paths.find((path) => path.tags?.includes('zoneDNotch'))!;
    const notchDangling = graph.danglingCuts.filter(({ pathId }) => pathId === notchPath.id);

    expect(graph.faces).toHaveLength(logicalPanelCount(result));
    expect(notchDangling).toHaveLength(2);
    expect(notchDangling.every(({ a, b }) => a.y === b.y || a.x === b.x)).toBe(true);
  });

  it('ttb 預設：abSlot 打斷的 A/B 相鄰 sharedEdges 含兩段 crease', () => {
    const result = triangularTube.generate(resolveParams(triangularTube));
    const graph = extractFaces(activeGeometry(result));
    const abCreaseIds = result.paths
      .filter((path) => path.tags?.includes('fold:faceA>faceB'))
      .map(({ id }) => id);
    const abSlotId = result.paths.find((path) => path.tags?.includes('abSlot'))!.id;
    const adjacency = findAdjacency(graph, (pathIds) =>
      abCreaseIds.every((id) => pathIds.includes(id)) && pathIds.includes(abSlotId));

    expect(adjacency).toBeDefined();
    expect(adjacency!.sharedEdges.filter(({ pathId, kind }) =>
      kind === 'crease' && abCreaseIds.includes(pathId))).toHaveLength(2);
  });

  it('ttb p-4 全七段分成軸段 2、非軸 2-owner 3、dead-end 2', () => {
    const result = triangularTube.generate(resolveParams(triangularTube));
    const graph = extractFaces(activeGeometry(result));
    const abCreaseIds = result.paths
      .filter((path) => path.tags?.includes('fold:faceA>faceB'))
      .map(({ id }) => id);
    const abSlot = result.paths.find((path) => path.tags?.includes('abSlot'))!;
    const adjacency = findAdjacency(graph, (pathIds) =>
      abCreaseIds.every((id) => pathIds.includes(id)) && pathIds.includes(abSlot.id))!;
    const axis = adjacency.sharedEdges.find(({ pathId, kind }) =>
      kind === 'crease' && abCreaseIds.includes(pathId))!;
    const sharedCuts = adjacency.sharedEdges.filter(({ pathId, kind }) =>
      kind === 'cut' && pathId === abSlot.id);
    const axialCuts = sharedCuts.filter(({ a, b }) =>
      distanceToLine(a, axis.a, axis.b) <= 1e-6
      && distanceToLine(b, axis.a, axis.b) <= 1e-6);
    const nonAxialCuts = sharedCuts.filter((edge) => !axialCuts.includes(edge));
    const deadEnds = graph.danglingCuts.filter(({ pathId }) => pathId === abSlot.id);

    expect(abSlot.id).toBe('p-4');
    expect(abSlot.segments).toHaveLength(7);
    expect(axialCuts).toHaveLength(2);
    expect(nonAxialCuts).toHaveLength(3);
    expect(deadEnds).toHaveLength(2);
    expect(new Set(deadEnds.map(({ containingFace }) => containingFace))).toHaveLength(1);
  });

  it('ttsl 0.003mm 外框斷口：左右糊邊皆由 junction 容差閉合', () => {
    for (const glueSide of ['left', 'right'] as const) {
      const result = tuckTopSnapLock.generate(resolveParams(tuckTopSnapLock, { glueSide }));
      const graph = extractFaces(activeGeometry(result));

      expect(graph.faces.length, glueSide).toBeGreaterThanOrEqual(logicalPanelCount(result));
      expect(graph.danglingCuts.some(({ pathId }) => pathId === 'p-4'), glueSide).toBe(false);
    }
  });
});
