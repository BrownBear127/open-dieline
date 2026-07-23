import type { Pt } from '../fold/types';

export class TriangulationError extends Error {
  override readonly name = 'TriangulationError';
}

function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function signedArea(polygon: readonly Pt[]): number {
  const origin = polygon[0];
  if (!origin) return 0;
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    doubledArea += (current.x - origin.x) * (next.y - origin.y)
      - (next.x - origin.x) * (current.y - origin.y);
  }
  return doubledArea / 2;
}

function pointInTriangle(point: Pt, a: Pt, b: Pt, c: Pt, winding: 1 | -1, epsilon: number): boolean {
  return winding * cross(a, b, point) >= -epsilon
    && winding * cross(b, c, point) >= -epsilon
    && winding * cross(c, a, point) >= -epsilon;
}

function polygonEpsilon(polygon: readonly Pt[]): { coordinate: number; area: number } {
  const xs = polygon.map(({ x }) => x);
  const ys = polygon.map(({ y }) => y);
  const scale = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    1,
  );
  return {
    coordinate: scale * 1e-12,
    area: scale * scale * 1e-12,
  };
}

function assertValidVertices(polygon: readonly Pt[], coordinateEpsilon: number): void {
  if (polygon.length < 3) {
    throw new TriangulationError('三角化失敗：polygon 至少需要三個頂點');
  }
  for (const point of polygon) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TriangulationError('三角化失敗：polygon 頂點必須是有限座標');
    }
  }
  for (let first = 0; first < polygon.length; first += 1) {
    for (let second = first + 1; second < polygon.length; second += 1) {
      const a = polygon[first]!;
      const b = polygon[second]!;
      if (
        Math.abs(a.x - b.x) <= coordinateEpsilon
        && Math.abs(a.y - b.y) <= coordinateEpsilon
      ) {
        throw new TriangulationError(
          `三角化失敗：polygon 含重複頂點（indices ${first}, ${second}）`,
        );
      }
    }
  }
}

function convexFanIndices(
  polygon: readonly Pt[],
  winding: 1 | -1,
  areaEpsilon: number,
): number[] | null {
  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length]!;
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    if (winding * cross(previous, current, next) <= areaEpsilon) return null;
  }

  const indices: number[] = [];
  for (let index = 1; index < polygon.length - 1; index += 1) {
    indices.push(0, index, index + 1);
  }
  return indices;
}

function boundarySplitPosition(
  polygon: readonly Pt[],
  coordinateEpsilon: number,
  areaEpsilon: number,
): { vertex: number; edgeStart: number } | null {
  for (let vertex = 0; vertex < polygon.length; vertex += 1) {
    const point = polygon[vertex]!;
    for (let edgeStart = 0; edgeStart < polygon.length; edgeStart += 1) {
      const edgeEnd = (edgeStart + 1) % polygon.length;
      if (vertex === edgeStart || vertex === edgeEnd) continue;
      const a = polygon[edgeStart]!;
      const b = polygon[edgeEnd]!;
      if (Math.abs(cross(a, b, point)) > areaEpsilon) continue;
      const withinX = point.x > Math.min(a.x, b.x) + coordinateEpsilon
        && point.x < Math.max(a.x, b.x) - coordinateEpsilon;
      const withinY = point.y > Math.min(a.y, b.y) + coordinateEpsilon
        && point.y < Math.max(a.y, b.y) - coordinateEpsilon;
      if (withinX || withinY) return { vertex, edgeStart };
    }
  }
  return null;
}

function splitBoundaryTouch(
  vertexIndices: number[],
  split: { vertex: number; edgeStart: number },
): [number[], number[]] | null {
  const rotatedIndices = vertexIndices
    .slice(split.vertex)
    .concat(vertexIndices.slice(0, split.vertex));
  const edgeStart = (
    split.edgeStart - split.vertex + vertexIndices.length
  ) % vertexIndices.length;
  if (edgeStart < 2 || edgeStart > rotatedIndices.length - 3) return null;
  return [
    rotatedIndices.slice(0, edgeStart + 1),
    [rotatedIndices[0]!, ...rotatedIndices.slice(edgeStart + 1)],
  ];
}

function triangulateSimpleLoop(
  vertexIndices: number[],
  polygon: readonly Pt[],
  areaEpsilon: number,
): number[] {
  const area = signedArea(polygon);
  if (Math.abs(area) <= areaEpsilon) {
    throw new TriangulationError('三角化失敗：polygon 面積為零');
  }
  const winding: 1 | -1 = area > 0 ? 1 : -1;
  const fan = convexFanIndices(polygon, winding, areaEpsilon);
  if (fan) return fan.map((index) => vertexIndices[index]!);

  const remaining = polygon.map((_, index) => index);
  const indices: number[] = [];

  while (remaining.length > 3) {
    let earPosition = -1;

    for (let position = 0; position < remaining.length; position += 1) {
      const previousIndex = remaining[(position - 1 + remaining.length) % remaining.length]!;
      const currentIndex = remaining[position]!;
      const nextIndex = remaining[(position + 1) % remaining.length]!;
      const previous = polygon[previousIndex]!;
      const current = polygon[currentIndex]!;
      const next = polygon[nextIndex]!;

      if (winding * cross(previous, current, next) <= areaEpsilon) continue;

      const containsVertex = remaining.some((candidateIndex) => {
        if (
          candidateIndex === previousIndex
          || candidateIndex === currentIndex
          || candidateIndex === nextIndex
        ) return false;
        return pointInTriangle(
          polygon[candidateIndex]!,
          previous,
          current,
          next,
          winding,
          areaEpsilon,
        );
      });
      if (containsVertex) continue;

      earPosition = position;
      indices.push(
        vertexIndices[previousIndex]!,
        vertexIndices[currentIndex]!,
        vertexIndices[nextIndex]!,
      );
      break;
    }

    if (earPosition < 0) {
      throw new TriangulationError('三角化失敗：找不到可裁切的 ear');
    }
    remaining.splice(earPosition, 1);
  }

  const [a, b, c] = remaining;
  if (
    a === undefined
    || b === undefined
    || c === undefined
    || winding * cross(polygon[a]!, polygon[b]!, polygon[c]!) <= areaEpsilon
  ) {
    throw new TriangulationError('三角化失敗：剩餘 triangle 退化');
  }
  indices.push(vertexIndices[a]!, vertexIndices[b]!, vertexIndices[c]!);
  return indices;
}

function removeCollinearSpikes(
  vertexIndices: number[],
  flatPolygon: readonly Pt[],
  areaEpsilon: number,
): number[] {
  const cleaned = [...vertexIndices];
  let changed = true;
  while (changed && cleaned.length >= 3) {
    changed = false;
    for (let index = 0; index < cleaned.length; index += 1) {
      const previous = flatPolygon[cleaned[(index - 1 + cleaned.length) % cleaned.length]!]!;
      const current = flatPolygon[cleaned[index]!]!;
      const next = flatPolygon[cleaned[(index + 1) % cleaned.length]!]!;
      if (Math.abs(cross(previous, current, next)) > areaEpsilon) continue;
      const incomingX = current.x - previous.x;
      const incomingY = current.y - previous.y;
      const outgoingX = next.x - current.x;
      const outgoingY = next.y - current.y;
      if (incomingX * outgoingX + incomingY * outgoingY > 0) continue;
      cleaned.splice(index, 1);
      changed = true;
      break;
    }
  }
  return cleaned;
}

/** 以原 polygon 頂點位置輸出穩定 triangle indices；不複製或重排頂點。 */
export function earClipIndices(flatPolygon: Pt[]): number[] {
  const epsilon = polygonEpsilon(flatPolygon);
  assertValidVertices(flatPolygon, epsilon.coordinate);

  const triangulateLoop = (inputIndices: number[]): number[] => {
    const vertexIndices = removeCollinearSpikes(inputIndices, flatPolygon, epsilon.area);
    const polygon = vertexIndices.map((index) => flatPolygon[index]!);
    const split = boundarySplitPosition(polygon, epsilon.coordinate, epsilon.area);
    if (split) {
      const loops = splitBoundaryTouch(vertexIndices, split);
      if (loops) return loops.flatMap(triangulateLoop);
    }
    return triangulateSimpleLoop(vertexIndices, polygon, epsilon.area);
  };

  return triangulateLoop(flatPolygon.map((_, index) => index));
}
