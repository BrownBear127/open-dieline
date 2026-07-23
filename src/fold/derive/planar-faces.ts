import type { Pt } from '../types';

export type PlanarEdgeKind = 'cut' | 'crease';

export interface PlanarSegmentInput {
  polyline: Pt[];
  pathId: string;
  kind: PlanarEdgeKind;
}

export type Input = PlanarSegmentInput;

export interface PlanarFace {
  /** CCW 簡單多邊形，可為凹形。 */
  outline: Pt[];
  probeHit?: string;
}

export interface FaceGraphEdge {
  a: Pt;
  b: Pt;
  pathId: string;
  kind: PlanarEdgeKind;
}

export interface FaceGraph {
  /** 不含外部無界面。 */
  faces: PlanarFace[];
  /** 紙張外框，winding 為 CCW。 */
  outerBoundary: Pt[];
  adjacency: Array<{
    faceA: number;
    faceB: number;
    sharedEdges: FaceGraphEdge[];
  }>;
  danglingCuts: Array<{
    a: Pt;
    b: Pt;
    pathId: string;
    containingFace: number;
  }>;
}

export class PlanarFacesError extends Error {
  override readonly name = 'PlanarFacesError';
}

interface Source {
  pathId: string;
  kind: PlanarEdgeKind;
  synthetic?: boolean;
}

interface WorkingInput extends PlanarSegmentInput {
  synthetic?: boolean;
}

interface SnappedPoint extends Pt {
  key: string;
}

interface RawSegment {
  a: SnappedPoint;
  b: SnappedPoint;
  source: Source;
  splitParameters: number[];
}

interface GraphEdge {
  id: number;
  a: SnappedPoint;
  b: SnappedPoint;
  sources: Source[];
}

interface HalfEdge {
  edgeId: number;
  from: SnappedPoint;
  to: SnappedPoint;
  twin: number;
}

interface FaceWalk {
  outline: Pt[];
  area: number;
}

const DEFAULT_SNAP_TOLERANCE_MM = 1e-6;
export const JUNCTION_TOLERANCE_MM = 0.02;
const FACE_SAMPLE_OFFSET_MM = 1e-4;
/** 刀模讓位最多 3mm；互補的正交摺線可沿原軸補到共同理論角點。 */
const MAX_IMPLICIT_CREASE_GAP_MM = 3.01;

function cross(a: Pt, b: Pt): number {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

function pointOrder(a: Pt, b: Pt): number {
  return a.x - b.x || a.y - b.y;
}

function snapPoint(point: Pt, tolerance: number): SnappedPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new PlanarFacesError('所有 polyline 座標都必須是有限數');
  }

  const gridX = Math.round(point.x / tolerance);
  const gridY = Math.round(point.y / tolerance);
  if (!Number.isSafeInteger(gridX) || !Number.isSafeInteger(gridY)) {
    throw new PlanarFacesError('座標超出 snap 網格可安全表示範圍');
  }

  const x = gridX === 0 ? 0 : gridX * tolerance;
  const y = gridY === 0 ? 0 : gridY * tolerance;
  return { x, y, key: `${gridX}:${gridY}` };
}

function sourceKey(source: Source): string {
  return `${source.synthetic ? 'synthetic' : 'source'}\u0000${source.kind}\u0000${source.pathId}`;
}

function edgeKey(a: SnappedPoint, b: SnappedPoint): string {
  return pointOrder(a, b) <= 0 ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
}

function interpolate(a: Pt, b: Pt, parameter: number): Pt {
  return {
    x: a.x + (b.x - a.x) * parameter,
    y: a.y + (b.y - a.y) * parameter,
  };
}

function clampParameter(parameter: number): number {
  if (parameter <= 0) return 0;
  if (parameter >= 1) return 1;
  return parameter;
}

function addSplit(segment: RawSegment, parameter: number, tolerance: number): void {
  const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
  const parameterTolerance = tolerance / Math.max(length, tolerance);
  if (parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance) {
    segment.splitParameters.push(clampParameter(parameter));
  }
}

function nodePair(first: RawSegment, second: RawSegment, tolerance: number): void {
  const firstDirection = subtract(first.b, first.a);
  const secondDirection = subtract(second.b, second.a);
  const betweenStarts = subtract(second.a, first.a);
  const denominator = cross(firstDirection, secondDirection);
  const firstLength = Math.hypot(firstDirection.x, firstDirection.y);
  const secondLength = Math.hypot(secondDirection.x, secondDirection.y);
  const parallelTolerance = tolerance * Math.max(firstLength, secondLength, 1);

  if (Math.abs(denominator) > parallelTolerance) {
    const firstParameter = cross(betweenStarts, secondDirection) / denominator;
    const secondParameter = cross(betweenStarts, firstDirection) / denominator;
    const firstParameterTolerance = tolerance / Math.max(firstLength, tolerance);
    const secondParameterTolerance = tolerance / Math.max(secondLength, tolerance);
    if (
      firstParameter >= -firstParameterTolerance && firstParameter <= 1 + firstParameterTolerance &&
      secondParameter >= -secondParameterTolerance && secondParameter <= 1 + secondParameterTolerance
    ) {
      addSplit(first, firstParameter, tolerance);
      addSplit(second, secondParameter, tolerance);
    }
    return;
  }

  if (Math.abs(cross(betweenStarts, firstDirection)) > parallelTolerance) return;

  const firstLengthSquared = dot(firstDirection, firstDirection);
  const secondLengthSquared = dot(secondDirection, secondDirection);
  addSplit(first, dot(subtract(second.a, first.a), firstDirection) / firstLengthSquared, tolerance);
  addSplit(first, dot(subtract(second.b, first.a), firstDirection) / firstLengthSquared, tolerance);
  addSplit(second, dot(subtract(first.a, second.a), secondDirection) / secondLengthSquared, tolerance);
  addSplit(second, dot(subtract(first.b, second.a), secondDirection) / secondLengthSquared, tolerance);
}

function rawSegments(inputs: WorkingInput[], tolerance: number): RawSegment[] {
  const result: RawSegment[] = [];
  for (const input of inputs) {
    if (input.kind !== 'cut' && input.kind !== 'crease') {
      throw new PlanarFacesError(`不支援的線型：${String(input.kind)}`);
    }
    if (typeof input.pathId !== 'string' || input.pathId.length === 0) {
      throw new PlanarFacesError('每條輸入線都必須有非空 pathId');
    }

    for (let index = 1; index < input.polyline.length; index++) {
      const a = snapPoint(input.polyline[index - 1]!, tolerance);
      const b = snapPoint(input.polyline[index]!, tolerance);
      if (a.key === b.key) continue;
      result.push({
        a,
        b,
        source: { pathId: input.pathId, kind: input.kind, synthetic: input.synthetic },
        splitParameters: [0, 1],
      });
    }
  }
  return result;
}

function nodedEdges(inputs: WorkingInput[], tolerance: number): GraphEdge[] {
  const segments = rawSegments(inputs, tolerance);
  for (let first = 0; first < segments.length; first++) {
    for (let second = first + 1; second < segments.length; second++) {
      nodePair(segments[first]!, segments[second]!, tolerance);
    }
  }

  const merged = new Map<string, Omit<GraphEdge, 'id'> & { sourceKeys: Set<string> }>();
  for (const segment of segments) {
    const parameters = [...segment.splitParameters]
      .sort((a, b) => a - b)
      .filter((parameter, index, all) => index === 0 || Math.abs(parameter - all[index - 1]!) > 1e-12);

    for (let index = 1; index < parameters.length; index++) {
      const start = snapPoint(interpolate(segment.a, segment.b, parameters[index - 1]!), tolerance);
      const end = snapPoint(interpolate(segment.a, segment.b, parameters[index]!), tolerance);
      if (start.key === end.key) continue;
      const [a, b] = pointOrder(start, end) <= 0 ? [start, end] : [end, start];
      const key = edgeKey(a, b);
      const existing = merged.get(key);
      if (existing) {
        const keyForSource = sourceKey(segment.source);
        if (!existing.sourceKeys.has(keyForSource)) {
          existing.sourceKeys.add(keyForSource);
          existing.sources.push(segment.source);
        }
      } else {
        merged.set(key, {
          a,
          b,
          sources: [segment.source],
          sourceKeys: new Set([sourceKey(segment.source)]),
        });
      }
    }
  }

  return [...merged.values()].map(({ a, b, sources }, id) => ({ id, a, b, sources }));
}

function projectionOnSegment(point: Pt, a: Pt, b: Pt): {
  point: Pt;
  parameter: number;
  distance: number;
} {
  const direction = subtract(b, a);
  const lengthSquared = dot(direction, direction);
  const parameter = dot(subtract(point, a), direction) / lengthSquared;
  const projected = interpolate(a, b, parameter);
  return {
    point: projected,
    parameter,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
  };
}

function graphEdgeOrder(first: GraphEdge, second: GraphEdge): number {
  return pointOrder(first.a, second.a) || pointOrder(first.b, second.b);
}

function connectJunctions(inputs: WorkingInput[], tolerance: number): GraphEdge[] {
  const edges = nodedEdges(inputs, tolerance);
  const incident = incidentEdges(edges);
  const points = new Map<string, SnappedPoint>();
  for (const edge of edges) {
    points.set(edge.a.key, edge.a);
    points.set(edge.b.key, edge.b);
  }

  const replacements = new Map<string, Pt>();
  const endpointKeys = new Set(inputs.flatMap(({ polyline }) => {
    if (polyline.length === 0) return [];
    return [
      snapPoint(polyline[0]!, tolerance).key,
      snapPoint(polyline[polyline.length - 1]!, tolerance).key,
    ];
  }));
  const endpoints = [...endpointKeys]
    .flatMap((nodeKey) => {
      const point = points.get(nodeKey);
      return point ? [point] : [];
    })
    .sort(pointOrder);

  for (const endpoint of endpoints) {
    if (replacements.has(endpoint.key)) continue;
    const endpointEdgeIds = incident.get(endpoint.key) ?? [];
    const endpointTarget = endpoints
      .filter((candidate) => candidate.key !== endpoint.key && !replacements.has(candidate.key))
      .filter((candidate) => !(incident.get(candidate.key) ?? []).some((edgeId) => endpointEdgeIds.includes(edgeId)))
      .map((candidate) => ({
        point: candidate,
        distance: Math.hypot(candidate.x - endpoint.x, candidate.y - endpoint.y),
      }))
      .filter(({ distance }) => distance <= JUNCTION_TOLERANCE_MM)
      .sort((first, second) => first.distance - second.distance || pointOrder(first.point, second.point))[0];
    const segmentTarget = edges
      .filter(({ id }) => !endpointEdgeIds.includes(id))
      .map((edge) => ({ edge, projection: projectionOnSegment(endpoint, edge.a, edge.b) }))
      .filter(({ projection }) => projection.parameter > 0 && projection.parameter < 1)
      .filter(({ projection }) => projection.distance <= JUNCTION_TOLERANCE_MM)
      .sort((first, second) => first.projection.distance - second.projection.distance || graphEdgeOrder(first.edge, second.edge))[0];
    if (endpointTarget && (!segmentTarget || endpointTarget.distance <= segmentTarget.projection.distance)) {
      const endpointDegree = endpointEdgeIds.length;
      const targetDegree = (incident.get(endpointTarget.point.key) ?? []).length;
      let replacement = endpointTarget.point;
      if (endpointDegree > targetDegree) replacement = endpoint;
      if (endpointDegree === targetDegree && pointOrder(endpoint, endpointTarget.point) < 0) {
        replacement = endpoint;
      }
      replacements.set(endpoint.key, replacement);
      replacements.set(endpointTarget.point.key, replacement);
      continue;
    }
    if (segmentTarget) replacements.set(endpoint.key, segmentTarget.projection.point);
  }

  if (replacements.size === 0) return edges;
  const remappedInputs = edges.flatMap((edge) => edge.sources.map((source) => ({
    polyline: [replacements.get(edge.a.key) ?? edge.a, replacements.get(edge.b.key) ?? edge.b],
    pathId: source.pathId,
    kind: source.kind,
    synthetic: source.synthetic,
  })));
  return nodedEdges(remappedInputs, tolerance);
}

function rayPairIntersection(
  firstOrigin: Pt,
  firstDirection: Pt,
  secondOrigin: Pt,
  secondDirection: Pt,
  tolerance: number,
): { point: Pt; firstDistance: number; secondDistance: number } | undefined {
  const denominator = cross(firstDirection, secondDirection);
  if (Math.abs(denominator) <= tolerance) return undefined;
  const betweenOrigins = subtract(secondOrigin, firstOrigin);
  const firstDistance = cross(betweenOrigins, secondDirection) / denominator;
  const secondDistance = cross(betweenOrigins, firstDirection) / denominator;
  if (firstDistance < -tolerance || secondDistance < -tolerance) return undefined;
  return {
    point: {
      x: firstOrigin.x + firstDirection.x * firstDistance,
      y: firstOrigin.y + firstDirection.y * firstDistance,
    },
    firstDistance: Math.max(0, firstDistance),
    secondDistance: Math.max(0, secondDistance),
  };
}

function healCreaseGaps(inputs: PlanarSegmentInput[], tolerance: number): GraphEdge[] {
  const edges = connectJunctions(inputs, tolerance);
  const incident = incidentEdges(edges);
  const connectorKeys = new Set<string>();
  const connectors: WorkingInput[] = [];
  const creaseTerminals = [...incident].flatMap(([nodeKey, edgeIds]) => {
    const originEdge = edges[edgeIds[0]!]!;
    const origin = originEdge.a.key === nodeKey ? originEdge.a : originEdge.b;
    const byPath = new Map<string, GraphEdge>();
    for (const edgeId of edgeIds) {
      const edge = edges[edgeId]!;
      for (const source of edge.sources) {
        if (source.kind === 'crease' && !source.synthetic && !byPath.has(source.pathId)) {
          byPath.set(source.pathId, edge);
        }
      }
    }
    return [...byPath].flatMap(([pathId, edge]) => {
      const sourceEdgeCount = edgeIds.filter((edgeId) => edges[edgeId]!.sources.some(
        (source) => source.pathId === pathId && source.kind === 'crease' && !source.synthetic,
      )).length;
      if (sourceEdgeCount !== 1) return [];
      const inner = edge.a.key === nodeKey ? edge.b : edge.a;
      const outward = subtract(origin, inner);
      const length = Math.hypot(outward.x, outward.y);
      return [{
        origin,
        direction: { x: outward.x / length, y: outward.y / length },
        incidentCount: edgeIds.length,
      }];
    });
  });

  const addConnector = (origin: SnappedPoint, target: SnappedPoint): void => {
    if (origin.key === target.key) return;
    const key = edgeKey(origin, target);
    if (connectorKeys.has(key)) return;
    connectorKeys.add(key);
    connectors.push({
      polyline: [origin, target],
      pathId: `__implicit-crease-gap-${connectorKeys.size}`,
      kind: 'cut',
      synthetic: true,
    });
  };

  for (let firstIndex = 0; firstIndex < creaseTerminals.length; firstIndex++) {
    const first = creaseTerminals[firstIndex]!;
    for (let secondIndex = firstIndex + 1; secondIndex < creaseTerminals.length; secondIndex++) {
      const second = creaseTerminals[secondIndex]!;
      if (first.origin.key === second.origin.key || (first.incidentCount > 1 && second.incidentCount > 1)) continue;
      const firstAxisAligned = Math.abs(first.direction.x) <= tolerance || Math.abs(first.direction.y) <= tolerance;
      const secondAxisAligned = Math.abs(second.direction.x) <= tolerance || Math.abs(second.direction.y) <= tolerance;
      if (!firstAxisAligned || !secondAxisAligned) continue;
      if (Math.abs(cross(first.direction, second.direction)) < 0.25) continue;
      const intersection = rayPairIntersection(
        first.origin,
        first.direction,
        second.origin,
        second.direction,
        tolerance,
      );
      if (!intersection || Math.max(intersection.firstDistance, intersection.secondDistance) > MAX_IMPLICIT_CREASE_GAP_MM + tolerance) {
        continue;
      }
      const target = snapPoint(intersection.point, tolerance);
      addConnector(first.origin, target);
      addConnector(second.origin, target);
    }
  }

  const connectorTargetCounts = new Map<string, { point: SnappedPoint; count: number }>();
  for (const connector of connectors) {
    const target = snapPoint(connector.polyline[connector.polyline.length - 1]!, tolerance);
    const existing = connectorTargetCounts.get(target.key);
    connectorTargetCounts.set(target.key, { point: target, count: (existing?.count ?? 0) + 1 });
  }
  for (const { point: hub, count } of connectorTargetCounts.values()) {
    if (count < 3) continue;
    const reliefTarget = edges
      .filter(({ sources }) => sources.some(({ kind, synthetic }) => kind === 'cut' && !synthetic))
      .map((edge) => ({ edge, projection: projectionOnSegment(hub, edge.a, edge.b) }))
      .filter(({ projection }) => projection.parameter >= 0 && projection.parameter <= 1)
      .filter(({ projection }) => projection.distance > tolerance)
      .filter(({ projection }) => projection.distance <= MAX_IMPLICIT_CREASE_GAP_MM + tolerance)
      .sort((first, second) => first.projection.distance - second.projection.distance || graphEdgeOrder(first.edge, second.edge))[0];
    if (reliefTarget) addConnector(hub, snapPoint(reliefTarget.projection.point, tolerance));
  }

  return connectors.length === 0 ? edges : connectJunctions([...inputs, ...connectors], tolerance);
}

function incidentEdges(edges: GraphEdge[]): Map<string, number[]> {
  const incident = new Map<string, number[]>();
  for (const edge of edges) {
    for (const endpoint of [edge.a.key, edge.b.key]) {
      const entries = incident.get(endpoint) ?? [];
      entries.push(edge.id);
      incident.set(endpoint, entries);
    }
  }
  return incident;
}

function findBridges(edges: GraphEdge[], incident: Map<string, number[]>): Set<number> {
  const visitedAt = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<number>();
  let clock = 0;

  const visit = (nodeKey: string, parentEdge: number | undefined): void => {
    const discovery = clock++;
    visitedAt.set(nodeKey, discovery);
    low.set(nodeKey, discovery);

    for (const edgeId of incident.get(nodeKey) ?? []) {
      if (edgeId === parentEdge) continue;
      const edge = edges[edgeId]!;
      const other = edge.a.key === nodeKey ? edge.b.key : edge.a.key;
      const otherDiscovery = visitedAt.get(other);
      if (otherDiscovery === undefined) {
        visit(other, edgeId);
        low.set(nodeKey, Math.min(low.get(nodeKey)!, low.get(other)!));
        if (low.get(other)! > discovery) bridges.add(edgeId);
      } else {
        low.set(nodeKey, Math.min(low.get(nodeKey)!, otherDiscovery));
      }
    }
  };

  for (const nodeKey of incident.keys()) {
    if (!visitedAt.has(nodeKey)) visit(nodeKey, undefined);
  }
  return bridges;
}

function assertNoDanglingCreases(
  edges: GraphEdge[],
  bridges: Set<number>,
  faces: PlanarFace[],
  tolerance: number,
): void {
  const dangling: string[] = [];
  const participatingCreasePaths = new Set(
    edges
      .filter(({ id }) => !bridges.has(id))
      .flatMap(({ sources }) => sources)
      .filter(({ kind, synthetic }) => kind === 'crease' && !synthetic)
      .map(({ pathId }) => pathId),
  );
  for (const edgeId of bridges) {
    const edge = edges[edgeId]!;
    const crease = edge.sources.find(({ kind, synthetic }) => kind === 'crease' && !synthetic);
    const midpoint = interpolate(edge.a, edge.b, 0.5);
    if (
      crease &&
      !participatingCreasePaths.has(crease.pathId) &&
      faces.some(({ outline }) => pointInPolygon(midpoint, outline, tolerance))
    ) {
      dangling.push(`pathId=${crease.pathId}，edge=(${edge.a.x},${edge.a.y})→(${edge.b.x},${edge.b.y})`);
    }
  }
  if (dangling.length > 0) throw new PlanarFacesError(`懸空 crease 無法形成面：${dangling.join('；')}`);
}

function signedArea(outline: Pt[]): number {
  let twiceArea = 0;
  for (let index = 0; index < outline.length; index++) {
    const current = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function simplifyOutline(outline: Pt[], tolerance: number): Pt[] {
  const simplified = outline.map(({ x, y }) => ({ x, y }));
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    for (let index = 0; index < simplified.length; index++) {
      const previous = simplified[(index - 1 + simplified.length) % simplified.length]!;
      const current = simplified[index]!;
      const next = simplified[(index + 1) % simplified.length]!;
      const before = subtract(current, previous);
      const after = subtract(next, current);
      const scale = Math.max(Math.hypot(before.x, before.y), Math.hypot(after.x, after.y), 1);
      if (Math.abs(cross(before, after)) <= tolerance * scale && dot(before, after) >= 0) {
        simplified.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return simplified;
}

function faceWalks(edges: GraphEdge[], bridges: Set<number>, tolerance: number): {
  halfEdges: HalfEdge[];
  walks: FaceWalk[];
  halfEdgeWalk: number[];
} {
  const halfEdges: HalfEdge[] = [];
  const outgoing = new Map<string, number[]>();

  const addOutgoing = (nodeKey: string, halfEdgeIndex: number): void => {
    const entries = outgoing.get(nodeKey) ?? [];
    entries.push(halfEdgeIndex);
    outgoing.set(nodeKey, entries);
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

  const nextHalfEdge = halfEdges.map((halfEdge) => {
    const atDestination = outgoing.get(halfEdge.to.key)!;
    const twinPosition = atDestination.indexOf(halfEdge.twin);
    return atDestination[(twinPosition - 1 + atDestination.length) % atDestination.length]!;
  });
  const halfEdgeWalk = Array<number>(halfEdges.length).fill(-1);
  const walks: FaceWalk[] = [];

  for (let start = 0; start < halfEdges.length; start++) {
    if (halfEdgeWalk[start] !== -1) continue;
    const walkIndex = walks.length;
    const walked: number[] = [];
    let current = start;
    do {
      if (halfEdgeWalk[current] !== -1) {
        throw new PlanarFacesError('半邊走訪在閉合前進入既有面，拓撲不一致');
      }
      halfEdgeWalk[current] = walkIndex;
      walked.push(current);
      current = nextHalfEdge[current]!;
      if (walked.length > halfEdges.length) throw new PlanarFacesError('半邊走訪未能閉合');
    } while (current !== start);

    const outline = simplifyOutline(walked.map((index) => halfEdges[index]!.from), tolerance);
    const area = signedArea(outline);
    if (Math.abs(area) <= tolerance * tolerance) {
      throw new PlanarFacesError('抽出的面積為零或低於 snap 容差');
    }
    walks.push({ outline, area });
  }

  return { halfEdges, walks, halfEdgeWalk };
}

function pointOnSegment(point: Pt, a: Pt, b: Pt, tolerance: number): boolean {
  const direction = subtract(b, a);
  const offset = subtract(point, a);
  return Math.abs(cross(direction, offset)) <= tolerance * Math.max(Math.hypot(direction.x, direction.y), 1) &&
    dot(offset, subtract(point, b)) <= tolerance * tolerance;
}

function pointInPolygon(point: Pt, polygon: Pt[], tolerance: number): boolean {
  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const current = polygon[index]!;
    const previous = polygon[previousIndex]!;
    if (pointOnSegment(point, previous, current, tolerance)) return true;
    if (
      (current.y > point.y) !== (previous.y > point.y) &&
      point.x < ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x
    ) inside = !inside;
  }
  return inside;
}

function offsetMidpointSamples(a: Pt, b: Pt): [Pt, Pt] {
  const midpoint = interpolate(a, b, 0.5);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const offsetX = (-dy / length) * FACE_SAMPLE_OFFSET_MM;
  const offsetY = (dx / length) * FACE_SAMPLE_OFFSET_MM;
  return [
    { x: midpoint.x + offsetX, y: midpoint.y + offsetY },
    { x: midpoint.x - offsetX, y: midpoint.y - offsetY },
  ];
}

function containingFaces(point: Pt, faces: PlanarFace[], tolerance: number): number[] {
  return faces.flatMap(({ outline }, face) => pointInPolygon(point, outline, tolerance) ? [face] : []);
}

export function extractFaces(
  inputs: PlanarSegmentInput[],
  snapTolMm = DEFAULT_SNAP_TOLERANCE_MM,
): FaceGraph {
  if (!Number.isFinite(snapTolMm) || snapTolMm <= 0) {
    throw new PlanarFacesError(`snapTolMm 必須是大於 0 的有限數（收到 ${snapTolMm}）`);
  }

  const edges = healCreaseGaps(inputs, snapTolMm);
  if (edges.length === 0) throw new PlanarFacesError('輸入沒有可形成面的非零長線段');
  const incident = incidentEdges(edges);
  const bridges = findBridges(edges, incident);
  const { halfEdges, walks, halfEdgeWalk } = faceWalks(edges, bridges, snapTolMm);
  const exteriorWalks = walks
    .map((walk, index) => ({ walk, index }))
    .filter(({ walk }) => walk.area < 0);
  if (exteriorWalks.length !== 1) {
    throw new PlanarFacesError(`預期一個連通紙張外框，實際找到 ${exteriorWalks.length} 個外部面`);
  }

  const boundedWalks = walks
    .map((walk, index) => ({ walk, index }))
    .filter(({ walk }) => walk.area > 0);
  if (boundedWalks.length === 0) throw new PlanarFacesError('輸入未形成任何有限面');

  const walkToFace = new Map<number, number>();
  const faces = boundedWalks.map(({ walk, index }, faceIndex) => {
    walkToFace.set(index, faceIndex);
    return { outline: walk.outline };
  });
  assertNoDanglingCreases(edges, bridges, faces, snapTolMm);
  const exterior = exteriorWalks[0]!.walk.outline;
  const outerBoundary = [...exterior].reverse();

  const halfEdgesByEdge = new Map<number, number[]>();
  for (let index = 0; index < halfEdges.length; index++) {
    const entries = halfEdgesByEdge.get(halfEdges[index]!.edgeId) ?? [];
    entries.push(index);
    halfEdgesByEdge.set(halfEdges[index]!.edgeId, entries);
  }

  const adjacencyByPair = new Map<string, FaceGraph['adjacency'][number]>();
  for (const edge of edges) {
    if (bridges.has(edge.id)) continue;
    const edgeHalfEdges = halfEdgesByEdge.get(edge.id)!;
    const firstFace = walkToFace.get(halfEdgeWalk[edgeHalfEdges[0]!]!);
    const secondFace = walkToFace.get(halfEdgeWalk[edgeHalfEdges[1]!]!);
    if (firstFace === undefined || secondFace === undefined || firstFace === secondFace) continue;
    const faceA = Math.min(firstFace, secondFace);
    const faceB = Math.max(firstFace, secondFace);
    const key = `${faceA}:${faceB}`;
    const sources = edge.sources.filter(({ synthetic }) => !synthetic);
    if (sources.length === 0) continue;
    const adjacency = adjacencyByPair.get(key) ?? { faceA, faceB, sharedEdges: [] };
    for (const source of sources) {
      adjacency.sharedEdges.push({
        a: { x: edge.a.x, y: edge.a.y },
        b: { x: edge.b.x, y: edge.b.y },
        pathId: source.pathId,
        kind: source.kind,
      });
    }
    adjacencyByPair.set(key, adjacency);
  }

  const danglingCuts: FaceGraph['danglingCuts'] = [];
  for (const edgeId of bridges) {
    const edge = edges[edgeId]!;
    const cutSources = edge.sources.filter(({ kind, synthetic }) => kind === 'cut' && !synthetic);
    if (cutSources.length === 0) continue;
    const pathIds = [...new Set(cutSources.map(({ pathId }) => pathId))].sort();
    const sampledFaces = offsetMidpointSamples(edge.a, edge.b)
      .map((sample) => containingFaces(sample, faces, snapTolMm));
    if (sampledFaces.some((hits) => hits.length !== 1)) {
      throw new PlanarFacesError(
        `死端 cut「${pathIds.join(',')}」邊界外偏移採樣仍歧義，找不到唯一 containingFace 歸屬`
        + `（edge=(${edge.a.x},${edge.a.y})→(${edge.b.x},${edge.b.y})，`
        + `兩側命中=${sampledFaces.map((hits) => `[${hits.join(',')}]`).join('/')}）`,
      );
    }
    const firstFace = sampledFaces[0]![0]!;
    const secondFace = sampledFaces[1]![0]!;
    if (firstFace !== secondFace) {
      const faceA = Math.min(firstFace, secondFace);
      const faceB = Math.max(firstFace, secondFace);
      const key = `${faceA}:${faceB}`;
      const adjacency = adjacencyByPair.get(key) ?? { faceA, faceB, sharedEdges: [] };
      for (const source of cutSources) {
        adjacency.sharedEdges.push({
          a: { x: edge.a.x, y: edge.a.y },
          b: { x: edge.b.x, y: edge.b.y },
          pathId: source.pathId,
          kind: source.kind,
        });
      }
      adjacencyByPair.set(key, adjacency);
      continue;
    }
    for (const source of cutSources) {
      danglingCuts.push({
        a: { x: edge.a.x, y: edge.a.y },
        b: { x: edge.b.x, y: edge.b.y },
        pathId: source.pathId,
        containingFace: firstFace,
      });
    }
  }

  return {
    faces,
    outerBoundary,
    adjacency: [...adjacencyByPair.values()],
    danglingCuts,
  };
}
