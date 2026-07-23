import type { Segment } from '@/core/geometry';
import type { GenerateResult } from '@/core/types';
import type { Pt } from '@/fold/types';

export const ORACLE_FLATTEN_TOLERANCE_MM = 0.01;
const SNAP_TOLERANCE_MM = 1e-7;
const JUNCTION_TOLERANCE_MM = 0.02;
const SAMPLE_OFFSET_MM = 1e-5;
const TWO_PI = 2 * Math.PI;

interface RawEdge {
  a: Pt;
  b: Pt;
  splitParameters: number[];
}

interface GraphPoint extends Pt {
  key: string;
}

interface GraphEdge {
  id: number;
  a: GraphPoint;
  b: GraphPoint;
}

interface HalfEdge {
  edgeId: number;
  from: GraphPoint;
  to: GraphPoint;
  twin: number;
}

interface FaceWalk {
  outline: Pt[];
  area: number;
}

export interface OracleRegion {
  polygons: Pt[][];
  perimeterMm: number;
  areaMm2: number;
}

function subtract(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x;
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

function interpolate(a: Pt, b: Pt, amount: number): Pt {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  };
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function arcSweep(segment: Extract<Segment, { kind: 'arc' }>): number {
  const raw = segment.ccw
    ? segment.startAngle - segment.endAngle
    : segment.endAngle - segment.startAngle;
  let magnitude = positiveModulo(raw, TWO_PI);
  if (magnitude < 1e-12 && Math.abs(raw) > 1e-12) magnitude = TWO_PI;
  return segment.ccw ? -magnitude : magnitude;
}

function cubicPoint(segment: Extract<Segment, { kind: 'bezier' }>, amount: number): Pt {
  const inverse = 1 - amount;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * amount;
  const c = 3 * inverse * amount * amount;
  const d = amount * amount * amount;
  return {
    x: a * segment.x1 + b * segment.c1x + c * segment.c2x + d * segment.x2,
    y: a * segment.y1 + b * segment.c1y + c * segment.c2y + d * segment.y2,
  };
}

/** 以二階導數上界決定固定取樣數，與 production 的遞迴控制多邊形 flatten 無共用。 */
export function oracleFlattenSegment(
  segment: Segment,
  toleranceMm = ORACLE_FLATTEN_TOLERANCE_MM,
): Pt[] {
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) {
    throw new Error(`oracle tolerance 必須是正有限數，收到 ${toleranceMm}`);
  }
  if (segment.kind === 'line') {
    return [{ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 }];
  }
  if (segment.kind === 'arc') {
    if (!(segment.r > 0) || toleranceMm >= 2 * segment.r) {
      throw new Error(`oracle arc 無法滿足 tolerance=${toleranceMm}, r=${segment.r}`);
    }
    const sweep = arcSweep(segment);
    const maxStep = 2 * Math.acos(1 - toleranceMm / segment.r);
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep));
    return Array.from({ length: count + 1 }, (_, index) => {
      const angle = segment.startAngle + sweep * (index / count);
      return {
        x: segment.cx + segment.r * Math.cos(angle),
        y: segment.cy + segment.r * Math.sin(angle),
      };
    });
  }

  const secondAtStart = {
    x: 6 * (segment.x1 - 2 * segment.c1x + segment.c2x),
    y: 6 * (segment.y1 - 2 * segment.c1y + segment.c2y),
  };
  const secondAtEnd = {
    x: 6 * (segment.c1x - 2 * segment.c2x + segment.x2),
    y: 6 * (segment.c1y - 2 * segment.c2y + segment.y2),
  };
  const secondDerivativeBound = Math.max(
    Math.hypot(secondAtStart.x, secondAtStart.y),
    Math.hypot(secondAtEnd.x, secondAtEnd.y),
  );
  const count = Math.max(1, Math.ceil(Math.sqrt(secondDerivativeBound / (8 * toleranceMm))));
  return Array.from({ length: count + 1 }, (_, index) => cubicPoint(segment, index / count));
}

export function polygonSignedArea(polygon: readonly Pt[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function polygonPerimeter(polygon: readonly Pt[]): number {
  let perimeter = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    perimeter += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return perimeter;
}

function snapPoint(point: Pt): GraphPoint {
  const gridX = Math.round(point.x / SNAP_TOLERANCE_MM);
  const gridY = Math.round(point.y / SNAP_TOLERANCE_MM);
  const x = gridX === 0 ? 0 : gridX * SNAP_TOLERANCE_MM;
  const y = gridY === 0 ? 0 : gridY * SNAP_TOLERANCE_MM;
  return { x, y, key: `${gridX}:${gridY}` };
}

function addSplit(edge: RawEdge, amount: number): void {
  const length = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
  const epsilon = SNAP_TOLERANCE_MM / Math.max(length, SNAP_TOLERANCE_MM);
  if (amount < -epsilon || amount > 1 + epsilon) return;
  edge.splitParameters.push(Math.max(0, Math.min(1, amount)));
}

function nodePair(first: RawEdge, second: RawEdge): void {
  const firstDirection = subtract(first.b, first.a);
  const secondDirection = subtract(second.b, second.a);
  const between = subtract(second.a, first.a);
  const denominator = cross(firstDirection, secondDirection);
  const scale = Math.max(
    Math.hypot(firstDirection.x, firstDirection.y),
    Math.hypot(secondDirection.x, secondDirection.y),
    1,
  );

  if (Math.abs(denominator) > SNAP_TOLERANCE_MM * scale) {
    addSplit(first, cross(between, secondDirection) / denominator);
    addSplit(second, cross(between, firstDirection) / denominator);
    return;
  }
  if (Math.abs(cross(between, firstDirection)) > SNAP_TOLERANCE_MM * scale) return;

  const firstLengthSquared = dot(firstDirection, firstDirection);
  const secondLengthSquared = dot(secondDirection, secondDirection);
  addSplit(first, dot(subtract(second.a, first.a), firstDirection) / firstLengthSquared);
  addSplit(first, dot(subtract(second.b, first.a), firstDirection) / firstLengthSquared);
  addSplit(second, dot(subtract(first.a, second.a), secondDirection) / secondLengthSquared);
  addSplit(second, dot(subtract(first.b, second.a), secondDirection) / secondLengthSquared);
}

function edgeKey(a: GraphPoint, b: GraphPoint): string {
  return a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
}

function graphEdges(polylines: readonly Pt[][]): GraphEdge[] {
  const raw: RawEdge[] = [];
  for (const polyline of polylines) {
    for (let index = 1; index < polyline.length; index++) {
      const a = snapPoint(polyline[index - 1]!);
      const b = snapPoint(polyline[index]!);
      if (a.key !== b.key) raw.push({ a, b, splitParameters: [0, 1] });
    }
  }

  for (let first = 0; first < raw.length; first++) {
    for (let second = first + 1; second < raw.length; second++) {
      nodePair(raw[first]!, raw[second]!);
    }
  }

  const merged = new Map<string, { a: GraphPoint; b: GraphPoint }>();
  for (const edge of raw) {
    const parameters = [...edge.splitParameters]
      .sort((a, b) => a - b)
      .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]!) > 1e-12);
    for (let index = 1; index < parameters.length; index++) {
      const a = snapPoint(interpolate(edge.a, edge.b, parameters[index - 1]!));
      const b = snapPoint(interpolate(edge.a, edge.b, parameters[index]!));
      if (a.key === b.key) continue;
      const key = edgeKey(a, b);
      if (!merged.has(key)) merged.set(key, a.key < b.key ? { a, b } : { a: b, b: a });
    }
  }
  return [...merged.values()].map(({ a, b }, id) => ({ id, a, b }));
}

function incidentEdges(edges: GraphEdge[]): Map<string, number[]> {
  const incident = new Map<string, number[]>();
  for (const edge of edges) {
    for (const point of [edge.a, edge.b]) {
      const entries = incident.get(point.key) ?? [];
      entries.push(edge.id);
      incident.set(point.key, entries);
    }
  }
  return incident;
}

function bridgeIds(edges: GraphEdge[]): Set<number> {
  const incident = incidentEdges(edges);
  const visited = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  let clock = 0;

  const visit = (nodeKey: string, parentEdge?: number): void => {
    clock += 1;
    visited.set(nodeKey, clock);
    low.set(nodeKey, clock);
    for (const edgeId of incident.get(nodeKey) ?? []) {
      if (edgeId === parentEdge) continue;
      const edge = edges[edgeId]!;
      const other = edge.a.key === nodeKey ? edge.b.key : edge.a.key;
      const seen = visited.get(other);
      if (seen === undefined) {
        visit(other, edgeId);
        low.set(nodeKey, Math.min(low.get(nodeKey)!, low.get(other)!));
        if (low.get(other)! > visited.get(nodeKey)!) bridges.add(edgeId);
      } else {
        low.set(nodeKey, Math.min(low.get(nodeKey)!, seen));
      }
    }
  };

  for (const key of incident.keys()) {
    if (!visited.has(key)) visit(key);
  }
  return bridges;
}

function faceWalks(edges: GraphEdge[]): FaceWalk[] {
  const bridges = bridgeIds(edges);
  const halfEdges: HalfEdge[] = [];
  const outgoing = new Map<string, number[]>();

  const addOutgoing = (key: string, index: number): void => {
    const entries = outgoing.get(key) ?? [];
    entries.push(index);
    outgoing.set(key, entries);
  };

  for (const edge of edges) {
    if (bridges.has(edge.id)) continue;
    const forward = halfEdges.length;
    halfEdges.push({ edgeId: edge.id, from: edge.a, to: edge.b, twin: forward + 1 });
    halfEdges.push({ edgeId: edge.id, from: edge.b, to: edge.a, twin: forward });
    addOutgoing(edge.a.key, forward);
    addOutgoing(edge.b.key, forward + 1);
  }

  for (const entries of outgoing.values()) {
    entries.sort((firstIndex, secondIndex) => {
      const first = halfEdges[firstIndex]!;
      const second = halfEdges[secondIndex]!;
      const firstAngle = Math.atan2(first.to.y - first.from.y, first.to.x - first.from.x);
      const secondAngle = Math.atan2(second.to.y - second.from.y, second.to.x - second.from.x);
      return firstAngle - secondAngle || first.edgeId - second.edgeId;
    });
  }

  const next = halfEdges.map((halfEdge) => {
    const entries = outgoing.get(halfEdge.to.key)!;
    const twinIndex = entries.indexOf(halfEdge.twin);
    return entries[(twinIndex - 1 + entries.length) % entries.length]!;
  });
  const visited = new Set<number>();
  const walks: FaceWalk[] = [];
  for (let start = 0; start < halfEdges.length; start++) {
    if (visited.has(start)) continue;
    const outline: Pt[] = [];
    let current = start;
    do {
      if (visited.has(current)) throw new Error('oracle half-edge walk 未閉合');
      visited.add(current);
      outline.push({ x: halfEdges[current]!.from.x, y: halfEdges[current]!.from.y });
      current = next[current]!;
      if (outline.length > halfEdges.length) throw new Error('oracle half-edge walk 超出上限');
    } while (current !== start);
    const area = polygonSignedArea(outline);
    if (Math.abs(area) > SNAP_TOLERANCE_MM * SNAP_TOLERANCE_MM) walks.push({ outline, area });
  }
  return walks;
}

function pointOnSegment(point: Pt, a: Pt, b: Pt): boolean {
  const direction = subtract(b, a);
  const offset = subtract(point, a);
  return Math.abs(cross(direction, offset)) <= SNAP_TOLERANCE_MM * Math.max(1, Math.hypot(direction.x, direction.y))
    && dot(offset, subtract(point, b)) <= SNAP_TOLERANCE_MM * SNAP_TOLERANCE_MM;
}

function pointInPolygon(point: Pt, polygon: readonly Pt[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous]!;
    const b = polygon[index]!;
    if (pointOnSegment(point, a, b)) return true;
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function sampleInside(face: FaceWalk): Pt {
  const a = face.outline[0]!;
  const b = face.outline[1]!;
  const midpoint = interpolate(a, b, 0.5);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return {
    x: midpoint.x - (dy / length) * SAMPLE_OFFSET_MM,
    y: midpoint.y + (dx / length) * SAMPLE_OFFSET_MM,
  };
}

function closedPolygonPolylines(polygons: readonly Pt[][]): Pt[][] {
  return polygons.map((polygon) => [...polygon, polygon[0]!]);
}

function coverageCount(point: Pt, polygons: readonly Pt[][]): number {
  return polygons.reduce((count, polygon) => count + (pointInPolygon(point, polygon) ? 1 : 0), 0);
}

function closeEndpointJunctions(polylines: readonly Pt[][]): Pt[][] {
  const endpoints = polylines.flatMap((polyline, polylineIndex) => {
    if (polyline.length === 0) return [];
    return [
      { point: polyline[0]!, polylineIndex },
      { point: polyline[polyline.length - 1]!, polylineIndex },
    ];
  });
  const candidates = endpoints.flatMap((first, firstIndex) => endpoints
    .slice(firstIndex + 1)
    .map((second) => ({
      first,
      second,
      distance: Math.hypot(first.point.x - second.point.x, first.point.y - second.point.y),
    })))
    .filter(({ first, second, distance }) =>
      first.polylineIndex !== second.polylineIndex
      && distance > SNAP_TOLERANCE_MM
      && distance <= JUNCTION_TOLERANCE_MM);
  candidates.sort((first, second) => first.distance - second.distance);

  const connected = new Set<Pt>();
  const connectors: Pt[][] = [];
  for (const { first, second } of candidates) {
    if (connected.has(first.point) || connected.has(second.point)) continue;
    connected.add(first.point);
    connected.add(second.point);
    connectors.push([first.point, second.point]);
  }
  return [...polylines.map((polyline) => [...polyline]), ...connectors];
}

export function oracleCutRegion(
  result: GenerateResult,
  toleranceMm = ORACLE_FLATTEN_TOLERANCE_MM,
): OracleRegion {
  const polylines: Pt[][] = [];
  for (const path of result.paths.filter(({ type }) => type === 'cut')) {
    const inactive = new Set(path.inactiveSegments ?? []);
    for (const [index, segment] of path.segments.entries()) {
      if (!inactive.has(index)) polylines.push(oracleFlattenSegment(segment, toleranceMm));
    }
  }
  const walks = faceWalks(graphEdges(closeEndpointJunctions(polylines)));
  const polygons = walks.filter(({ area }) => area > 0).map(({ outline }) => outline);
  const exterior = walks.filter(({ area }) => area < 0);
  if (polygons.length === 0 || exterior.length === 0) {
    throw new Error('oracle active cut 未形成有限紙張區域');
  }
  return {
    polygons,
    perimeterMm: exterior.reduce((sum, face) => sum + polygonPerimeter(face.outline), 0),
    areaMm2: polygons.reduce((sum, polygon) => sum + Math.abs(polygonSignedArea(polygon)), 0),
  };
}

/** 從已解析的折線重建有限區域，供 2D 刀模以外的幾何消費者共用同一套 oracle。 */
export function oraclePolylineRegion(polylines: readonly Pt[][]): OracleRegion {
  const walks = faceWalks(graphEdges(closeEndpointJunctions(polylines)));
  const polygons = walks.filter(({ area }) => area > 0).map(({ outline }) => outline);
  const exterior = walks.filter(({ area }) => area < 0);
  if (polygons.length === 0 || exterior.length === 0) {
    throw new Error('oracle 折線未形成有限區域');
  }
  return {
    polygons,
    perimeterMm: exterior.reduce((sum, face) => sum + polygonPerimeter(face.outline), 0),
    areaMm2: polygons.reduce((sum, polygon) => sum + Math.abs(polygonSignedArea(polygon)), 0),
  };
}

export function symmetricDifferenceArea(first: readonly Pt[][], second: readonly Pt[][]): number {
  const edges = graphEdges([
    ...closedPolygonPolylines(first),
    ...closedPolygonPolylines(second),
  ]);
  return faceWalks(edges)
    .filter(({ area }) => area > 0)
    .reduce((sum, face) => {
      const sample = sampleInside(face);
      const inFirst = coverageCount(sample, first) > 0;
      const inSecond = coverageCount(sample, second) > 0;
      return sum + (inFirst !== inSecond ? face.area : 0);
    }, 0);
}

export function overlappingArea(polygons: readonly Pt[][]): number {
  const edges = graphEdges(closedPolygonPolylines(polygons));
  return faceWalks(edges)
    .filter(({ area }) => area > 0)
    .reduce((sum, face) => {
      const count = coverageCount(sampleInside(face), polygons);
      return sum + (count > 1 ? face.area * (count - 1) : 0);
    }, 0);
}
