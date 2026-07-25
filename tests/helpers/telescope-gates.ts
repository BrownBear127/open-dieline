import { A_GUSSET_FIXED_NOMINAL_A_MM } from '@/boxes/telescope/tray';
import { telescope } from '@/boxes/telescope';
import type { GenerateResult, ResolvedParams } from '@/core/types';
import {
  applyTransform,
  panelWorldTransform,
  worldGeometry,
  type Vec3,
} from '@/fold/pose3d';
import { TELESCOPE_TRAY_WINDOWS } from '@/fold/models/telescope';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, Pt } from '@/fold/types';
import {
  diagnoseFoldedPanelFaces,
  firstFaceNormal,
  panelOverlapPlan,
} from '@/ui/fold-scene';
import { earClipIndices } from '@/ui/triangulate';

const GEOMETRY_TOLERANCE_MM = 0.05;
const NUMERIC_EPSILON = 1e-7;
const COPLANAR_TOLERANCE_MM = 1e-6;
const G3_RATE_CAP_DEG_PER_001T = 22.5;
const SWEEP_SAMPLES = 80;

type Window = readonly [number, number];
type TrayWindows = Record<string, Window>;
type Triangle = [Vec3, Vec3, Vec3];

interface Poly3 {
  id: string;
  points: Vec3[];
  triangles: Array<[number, number, number]>;
}

interface HookFormula {
  bandMm: number;
  zSpanMm: number;
}

interface HookMeasurement {
  bandMm: number;
  intersectionLengthMm: number;
}

function sampleWindows(windows: Window[]): number[] {
  const samples = windows.flatMap(([start, end]) =>
    Array.from(
      { length: SWEEP_SAMPLES + 1 },
      (_, index) => start + (end - start) * index / SWEEP_SAMPLES,
    ));
  return [...new Set(samples.map((sample) => sample.toFixed(12)))]
    .map(Number)
    .sort((left, right) => left - right);
}

function phaseSweepTimes(model: FoldModel): number[] {
  const windows = model.panels.some(({ id }) => id.startsWith('flap'))
    ? Object.values(TELESCOPE_TRAY_WINDOWS.flapped)
    : Object.values(TELESCOPE_TRAY_WINDOWS.plain);
  return sampleWindows(windows);
}

export interface TelescopeGateReport {
  flapGatesApplicable: boolean;
  violations: string[];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function add(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function scale(vector: Vec3, scalar: number): Vec3 {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function magnitude(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function unit(vector: Vec3): Vec3 {
  const length = magnitude(vector);
  if (length <= NUMERIC_EPSILON) {
    throw new Error('Telescope gate 無法正規化零向量');
  }
  return scale(vector, 1 / length);
}

function degrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function triangleNormal(triangle: Triangle): Vec3 {
  return unit(cross(
    subtract(triangle[1], triangle[0]),
    subtract(triangle[2], triangle[0]),
  ));
}

function dominantDropAxis(normal: Vec3): 'x' | 'y' | 'z' {
  const magnitudes = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (magnitudes.z >= magnitudes.x && magnitudes.z >= magnitudes.y) return 'z';
  return magnitudes.y >= magnitudes.x ? 'y' : 'x';
}

function project2(
  point: Vec3,
  drop: 'x' | 'y' | 'z',
): [number, number] {
  if (drop === 'z') return [point.x, point.y];
  if (drop === 'y') return [point.x, point.z];
  return [point.y, point.z];
}

function signedArea2(points: Array<[number, number]>): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function pointInTriangle2(
  point: [number, number],
  triangle: Array<[number, number]>,
  tolerance = NUMERIC_EPSILON,
): boolean {
  const oriented = signedArea2(triangle) < 0
    ? [triangle[0]!, triangle[2]!, triangle[1]!]
    : triangle;
  const orient = (
    a: [number, number],
    b: [number, number],
    p: [number, number],
  ) => (b[0] - a[0]) * (p[1] - a[1])
    - (b[1] - a[1]) * (p[0] - a[0]);
  return oriented.every((start, index) =>
    orient(start, oriented[(index + 1) % oriented.length]!, point) >= -tolerance);
}

function pointInTriangleProjection(
  point: Vec3,
  triangle: Triangle,
  normal: Vec3,
): boolean {
  const distance = dot(subtract(point, triangle[0]), normal);
  const projected = subtract(point, scale(normal, distance));
  const drop = dominantDropAxis(normal);
  return pointInTriangle2(
    project2(projected, drop),
    triangle.map((candidate) => project2(candidate, drop)),
  );
}

function segmentCrossesTriangleInterior(
  start: Vec3,
  end: Vec3,
  triangle: Triangle,
): boolean {
  const normal = cross(
    subtract(triangle[1], triangle[0]),
    subtract(triangle[2], triangle[0]),
  );
  const direction = subtract(end, start);
  const denominator = dot(normal, direction);
  if (Math.abs(denominator) < 1e-12) return false;
  const ratio = dot(normal, subtract(triangle[0], start)) / denominator;
  if (ratio <= 1e-9 || ratio >= 1 - 1e-9) return false;
  const intersection = add(start, scale(direction, ratio));
  const drop = dominantDropAxis(unit(normal));
  const projectedTriangle = triangle.map((point) => project2(point, drop));
  const projectedPoint = project2(intersection, drop);
  const oriented = signedArea2(projectedTriangle) < 0
    ? [
      projectedTriangle[0]!,
      projectedTriangle[2]!,
      projectedTriangle[1]!,
    ]
    : projectedTriangle;
  const orient = (
    a: [number, number],
    b: [number, number],
    p: [number, number],
  ) => (b[0] - a[0]) * (p[1] - a[1])
    - (b[1] - a[1]) * (p[0] - a[0]);
  return oriented.every((point, index) =>
    orient(
      point,
      oriented[(index + 1) % oriented.length]!,
      projectedPoint,
    ) > 1e-9);
}

function clipConvexPolygon(
  subject: Array<[number, number]>,
  clip: Array<[number, number]>,
): Array<[number, number]> {
  const clipPolygon = signedArea2(clip) < 0 ? [...clip].reverse() : clip;
  let output = subject;
  for (let index = 0; index < clipPolygon.length; index += 1) {
    const start = clipPolygon[index]!;
    const end = clipPolygon[(index + 1) % clipPolygon.length]!;
    const input = output;
    output = [];
    if (input.length === 0) break;
    const inside = (point: [number, number]) =>
      (end[0] - start[0]) * (point[1] - start[1])
      - (end[1] - start[1]) * (point[0] - start[0]) >= -1e-9;
    const intersection = (
      first: [number, number],
      second: [number, number],
    ): [number, number] => {
      const direction: [number, number] = [
        second[0] - first[0],
        second[1] - first[1],
      ];
      const edge: [number, number] = [
        end[0] - start[0],
        end[1] - start[1],
      ];
      const denominator = direction[0] * edge[1]
        - direction[1] * edge[0];
      if (Math.abs(denominator) < 1e-12) return second;
      const offset: [number, number] = [
        start[0] - first[0],
        start[1] - first[1],
      ];
      const ratio = (
        offset[0] * edge[1] - offset[1] * edge[0]
      ) / denominator;
      return [
        first[0] + ratio * direction[0],
        first[1] + ratio * direction[1],
      ];
    };
    for (let edgeIndex = 0; edgeIndex < input.length; edgeIndex += 1) {
      const current = input[edgeIndex]!;
      const previous = input[
        (edgeIndex + input.length - 1) % input.length
      ]!;
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(intersection(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(intersection(previous, current));
      }
    }
  }
  return output;
}

function pointToSegmentDistance2(
  point: [number, number],
  start: [number, number],
  end: [number, number],
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const ratio = Math.max(0, Math.min(1, (
    (point[0] - start[0]) * dx + (point[1] - start[1]) * dy
  ) / lengthSquared));
  return Math.hypot(
    point[0] - (start[0] + ratio * dx),
    point[1] - (start[1] + ratio * dy),
  );
}

function pointInPolygonWithTolerance(
  point: [number, number],
  polygon: Array<[number, number]>,
  tolerance: number,
): boolean {
  if (polygon.some((start, index) =>
    pointToSegmentDistance2(
      point,
      start,
      polygon[(index + 1) % polygon.length]!,
    ) <= tolerance)) {
    return true;
  }
  let inside = false;
  for (let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (
      (currentPoint[1] > point[1]) !== (previousPoint[1] > point[1])
    ) && point[0] < (
      (
        (previousPoint[0] - currentPoint[0])
        * (point[1] - currentPoint[1])
      ) / (previousPoint[1] - currentPoint[1])
      + currentPoint[0]
    );
    if (crosses) inside = !inside;
  }
  return inside;
}

function triangles(poly: Poly3): Triangle[] {
  return poly.triangles.map((indices) =>
    indices.map((index) => poly.points[index]!) as Triangle);
}

function polyFromWorld(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
  panelId: string,
): Poly3 {
  const panel = model.panels.find(({ id }) => id === panelId);
  const points = geometry.get(panelId);
  if (!panel || !points) throw new Error(`Telescope gate 找不到 panel「${panelId}」`);
  const indices = earClipIndices(panel.polygon);
  const triangleIndices: Array<[number, number, number]> = [];
  for (let index = 0; index < indices.length; index += 3) {
    triangleIndices.push([
      indices[index]!,
      indices[index + 1]!,
      indices[index + 2]!,
    ]);
  }
  return { id: panelId, points, triangles: triangleIndices };
}

function pairCrossing(left: Poly3, right: Poly3): {
  crossing: boolean;
  depthMm: number;
} {
  let crossing = false;
  let depthMm = 0;
  for (const leftTriangle of triangles(left)) {
    const leftNormal = triangleNormal(leftTriangle);
    for (const rightTriangle of triangles(right)) {
      const rightNormal = triangleNormal(rightTriangle);
      const parallel = magnitude(cross(leftNormal, rightNormal))
        <= COPLANAR_TOLERANCE_MM;
      const planeDistance = Math.max(...rightTriangle.map((point) =>
        Math.abs(dot(subtract(point, leftTriangle[0]), leftNormal))));
      if (parallel && planeDistance <= COPLANAR_TOLERANCE_MM) continue;
      const leftEdges: Array<[Vec3, Vec3]> = [
        [leftTriangle[0], leftTriangle[1]],
        [leftTriangle[1], leftTriangle[2]],
        [leftTriangle[2], leftTriangle[0]],
      ];
      const rightEdges: Array<[Vec3, Vec3]> = [
        [rightTriangle[0], rightTriangle[1]],
        [rightTriangle[1], rightTriangle[2]],
        [rightTriangle[2], rightTriangle[0]],
      ];
      const crosses = leftEdges.some(([start, end]) =>
        segmentCrossesTriangleInterior(start, end, rightTriangle))
        || rightEdges.some(([start, end]) =>
          segmentCrossesTriangleInterior(start, end, leftTriangle));
      if (!crosses) continue;
      crossing = true;
      for (const point of leftTriangle) {
        if (pointInTriangleProjection(point, rightTriangle, rightNormal)) {
          depthMm = Math.max(
            depthMm,
            Math.abs(dot(subtract(point, rightTriangle[0]), rightNormal)),
          );
        }
      }
      for (const point of rightTriangle) {
        if (pointInTriangleProjection(point, leftTriangle, leftNormal)) {
          depthMm = Math.max(
            depthMm,
            Math.abs(dot(subtract(point, leftTriangle[0]), leftNormal)),
          );
        }
      }
    }
  }
  return { crossing, depthMm };
}

function plane(poly: Poly3): { point: Vec3; normal: Vec3 } {
  const triangle = triangles(poly)[0]!;
  return { point: triangle[0], normal: triangleNormal(triangle) };
}

function isCoplanarLayerOverlap(left: Poly3, right: Poly3): boolean {
  const leftPlane = plane(left);
  const rightPlane = plane(right);
  if (
    magnitude(cross(leftPlane.normal, rightPlane.normal))
    > COPLANAR_TOLERANCE_MM
  ) {
    return false;
  }
  return right.points.every((point) =>
    Math.abs(dot(subtract(point, leftPlane.point), leftPlane.normal))
      <= COPLANAR_TOLERANCE_MM)
    && left.points.every((point) =>
      Math.abs(dot(subtract(point, rightPlane.point), rightPlane.normal))
        <= COPLANAR_TOLERANCE_MM);
}

function trianglePlaneSection(
  triangle: Triangle,
  planePoint: Vec3,
  planeNormal: Vec3,
): Vec3[] {
  const distances = triangle.map((point) =>
    dot(subtract(point, planePoint), planeNormal));
  const points: Vec3[] = [];
  const addUnique = (point: Vec3) => {
    if (!points.some((candidate) =>
      magnitude(subtract(candidate, point)) <= NUMERIC_EPSILON)) {
      points.push(point);
    }
  };
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(distances[index]!) <= NUMERIC_EPSILON) {
      addUnique(triangle[index]!);
    }
    const next = (index + 1) % 3;
    const startDistance = distances[index]!;
    const endDistance = distances[next]!;
    if (
      startDistance * endDistance
      >= -NUMERIC_EPSILON * NUMERIC_EPSILON
    ) continue;
    const ratio = startDistance / (startDistance - endDistance);
    addUnique(add(
      triangle[index]!,
      scale(subtract(triangle[next]!, triangle[index]!), ratio),
    ));
  }
  return points;
}

function pointOnBoundary(poly: Poly3, point: Vec3): boolean {
  return poly.points.some((start, index) => {
    const end = poly.points[(index + 1) % poly.points.length]!;
    const edge = subtract(end, start);
    const length = magnitude(edge);
    if (length <= NUMERIC_EPSILON) return false;
    const fromStart = subtract(point, start);
    const distance = magnitude(cross(edge, fromStart)) / length;
    const ratio = dot(fromStart, edge) / (length * length);
    return distance <= COPLANAR_TOLERANCE_MM
      && ratio >= -NUMERIC_EPSILON
      && ratio <= 1 + NUMERIC_EPSILON;
  });
}

function canonicalDirection(direction: Vec3): Vec3 {
  const first = [direction.x, direction.y, direction.z]
    .find((value) => Math.abs(value) > NUMERIC_EPSILON) ?? 0;
  return first < 0 ? scale(direction, -1) : direction;
}

function mergedIntersectionLength(
  segments: Array<[Vec3, Vec3]>,
  direction: Vec3,
): number {
  const intervals = segments
    .map(([start, end]) => [
      Math.min(dot(start, direction), dot(end, direction)),
      Math.max(dot(start, direction), dot(end, direction)),
    ] as [number, number])
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let active: [number, number] | undefined;
  for (const interval of intervals) {
    if (!active) {
      active = [...interval];
    } else if (interval[0] <= active[1] + NUMERIC_EPSILON) {
      active[1] = Math.max(active[1], interval[1]);
    } else {
      total += active[1] - active[0];
      active = [...interval];
    }
  }
  return total + (active ? active[1] - active[0] : 0);
}

function hookMeasurement(left: Poly3, right: Poly3): HookMeasurement | null {
  const leftPlane = plane(left);
  const rightPlane = plane(right);
  const rawDirection = cross(leftPlane.normal, rightPlane.normal);
  if (magnitude(rawDirection) <= COPLANAR_TOLERANCE_MM) return null;
  const direction = canonicalDirection(unit(rawDirection));
  const materialSegments: Array<[Vec3, Vec3]> = [];

  for (const leftTriangle of triangles(left)) {
    for (const rightTriangle of triangles(right)) {
      const leftSection = trianglePlaneSection(
        leftTriangle,
        rightTriangle[0],
        triangleNormal(rightTriangle),
      );
      const rightSection = trianglePlaneSection(
        rightTriangle,
        leftTriangle[0],
        triangleNormal(leftTriangle),
      );
      if (leftSection.length < 2 || rightSection.length < 2) continue;
      const leftRange = leftSection.map((point) => dot(point, direction));
      const rightRange = rightSection.map((point) => dot(point, direction));
      const start = Math.max(Math.min(...leftRange), Math.min(...rightRange));
      const end = Math.min(Math.max(...leftRange), Math.max(...rightRange));
      if (end - start <= NUMERIC_EPSILON) continue;
      const reference = leftSection[0]!;
      const referencePosition = dot(reference, direction);
      const pointAt = (position: number) => add(
        reference,
        scale(direction, position - referencePosition),
      );
      const segment: [Vec3, Vec3] = [pointAt(start), pointAt(end)];
      const midpoint = pointAt((start + end) / 2);
      if (!pointOnBoundary(left, midpoint) && !pointOnBoundary(right, midpoint)) {
        materialSegments.push(segment);
      }
    }
  }
  if (materialSegments.length === 0) return null;

  const signedRange = (
    poly: Poly3,
    targetPlane: ReturnType<typeof plane>,
  ) => {
    const distances = poly.points.map((point) =>
      dot(subtract(point, targetPlane.point), targetPlane.normal));
    const minimum = Math.min(...distances);
    const maximum = Math.max(...distances);
    return minimum < 0 && maximum > 0
      ? Math.min(-minimum, maximum)
      : 0;
  };
  return {
    bandMm: Math.min(
      signedRange(left, rightPlane),
      signedRange(right, leftPlane),
    ),
    intersectionLengthMm: mergedIntersectionLength(
      materialSegments,
      direction,
    ),
  };
}

function generatedPiece(
  params: ResolvedParams,
  pieceId: string,
): { generated: GenerateResult; pathIds: Set<string> } {
  const generated = telescope.generate(params);
  const piece = generated.pieces?.find(({ id }) => id === pieceId);
  if (!piece) throw new Error(`Telescope gate 找不到 generated piece「${pieceId}」`);
  return { generated, pathIds: new Set(piece.pathIds) };
}

function hookFormula(
  params: ResolvedParams,
  pieceId: string,
  cornerToken: string,
): HookFormula {
  const sideByCorner: Record<string, string> = {
    NegNeg: 'left-front',
    NegPos: 'left-back',
    PosNeg: 'right-front',
    PosPos: 'right-back',
  };
  const side = sideByCorner[cornerToken];
  if (!side) throw new Error(`Telescope gate 未知 corner「${cornerToken}」`);
  const { generated, pathIds } = generatedPiece(params, pieceId);
  const crease = generated.paths.find((path) =>
    pathIds.has(path.id)
    && path.type === 'crease'
    && path.tags?.includes('cornerFlapFold')
    && path.tags.includes(side));
  const hinge = crease?.segments[0];
  if (!crease || hinge?.kind !== 'line') {
    throw new Error(`${pieceId}/${cornerToken} 缺少 cornerFlapFold 現場線`);
  }
  const hingeDirection = {
    x: hinge.x2 - hinge.x1,
    y: hinge.y2 - hinge.y1,
  };
  const hingeLength = Math.hypot(hingeDirection.x, hingeDirection.y);
  const parallelDistances = generated.paths
    .filter((path) =>
      pathIds.has(path.id)
      && path.tags?.includes('aGussetPeriphery')
      && path.tags.includes(side))
    .flatMap(({ segments }) => segments)
    .flatMap((segment) => {
      if (segment.kind !== 'line') return [];
      const direction = {
        x: segment.x2 - segment.x1,
        y: segment.y2 - segment.y1,
      };
      const length = Math.hypot(direction.x, direction.y);
      const parallelError = Math.abs(
        hingeDirection.x * direction.y - hingeDirection.y * direction.x,
      ) / (hingeLength * length);
      if (parallelError > 1e-7) return [];
      const distance = Math.abs(
        hingeDirection.x * (segment.y1 - hinge.y1)
        - hingeDirection.y * (segment.x1 - hinge.x1)
      ) / hingeLength;
      return distance > NUMERIC_EPSILON ? [distance] : [];
    });
  const bandMm = Math.min(...parallelDistances);
  if (!Number.isFinite(bandMm)) {
    throw new Error(`${pieceId}/${cornerToken} 無法從 generator 現場重建 bandFormula`);
  }

  const isBase = pieceId === 'base';
  const height = params[isBase ? 'baseHeight' : 'lidHeight'];
  const platformWidth = params[
    isBase ? 'basePlatformWidth' : 'lidPlatformWidth'
  ];
  const innerWallReduction = params.innerWallReduction;
  const wallTopCompensation = isBase ? params.wallTopCompensation : 0;
  if (
    typeof height !== 'number'
    || typeof platformWidth !== 'number'
    || typeof innerWallReduction !== 'number'
    || typeof wallTopCompensation !== 'number'
  ) {
    throw new Error(`${pieceId} hook formula 缺少數值參數`);
  }
  const longOuterLength = height - wallTopCompensation;
  const distPlatformEnd = longOuterLength + platformWidth;
  const distTongueApproach = (
    longOuterLength
    + platformWidth
    + (longOuterLength - innerWallReduction)
    - 2
  );
  const range = [
    2 * distPlatformEnd - distTongueApproach,
    2 * distPlatformEnd - A_GUSSET_FIXED_NOMINAL_A_MM,
  ];
  return {
    bandMm,
    zSpanMm: Math.max(...range) - Math.min(...range),
  };
}

export function hookRootStripWithinBounds(
  formula: HookFormula,
  measurement: HookMeasurement,
): boolean {
  return (
    measurement.bandMm <= formula.bandMm + GEOMETRY_TOLERANCE_MM
    && measurement.intersectionLengthMm
      <= formula.zSpanMm + GEOMETRY_TOLERANCE_MM
  );
}

export function exactSetMismatch(
  actual: readonly string[],
  expected: readonly string[],
): string[] {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return [
    ...[...expectedSet]
      .filter((value) => !actualSet.has(value))
      .map((value) => `missing:${value}`),
    ...[...actualSet]
      .filter((value) => !expectedSet.has(value))
      .map((value) => `extra:${value}`),
  ].sort();
}

export function trayWindowOrderViolations(windows: TrayWindows): string[] {
  const order = [
    'pretuck',
    'prefoldX',
    'prefoldY',
    'phaseA',
    'phaseB',
    'phaseC',
    'phaseCExt',
  ].filter((name) => windows[name] !== undefined);
  const violations: string[] = [];
  for (const name of order) {
    const [start, end] = windows[name]!;
    if (
      !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end > 1
      || start >= end
    ) {
      violations.push(`${name} window 非法`);
    }
  }
  for (let index = 1; index < order.length; index += 1) {
    const previous = windows[order[index - 1]!]!;
    const current = windows[order[index]!]!;
    if (current[0] < previous[1] - NUMERIC_EPSILON) {
      violations.push(`${order[index - 1]} 與 ${order[index]} window overlap`);
    }
  }
  return violations;
}

export function familyTopologyViolations(model: FoldModel): string[] {
  const ids = model.panels.map(({ id }) => id);
  if (ids.includes('linerPad')) {
    const legs = ids.filter((id) => id.startsWith('linerLeg')).length;
    return legs === 4 ? [] : [`liner leg count=${legs}，預期 4`];
  }
  const wings = ids.filter((id) => id.startsWith('wing')).length;
  const flaps = ids.filter((id) => id.startsWith('flap')).length;
  const extensions = ids.filter((id) => id.startsWith('gussetExt')).length;
  const violations: string[] = [];
  if (wings !== 8) violations.push(`wing count=${wings}，預期 8`);
  if (![0, 4].includes(flaps)) {
    violations.push(`flap count=${flaps}，預期 0 或 4`);
  }
  if (![0, 4].includes(extensions)) {
    violations.push(`extension count=${extensions}，預期 0 或 4`);
  }
  if (flaps === 4 && extensions === 4) {
    violations.push('flap/extension family 不得同時存在');
  }
  return violations;
}

function oneStepViolations(model: FoldModel): string[] {
  return model.panels.flatMap((panel) => {
    if (panel.parent === null) return [];
    const count = model.steps.filter(({ panelIds }) =>
      panelIds.includes(panel.id)).length;
    return count === 1
      ? []
      : [`schedule:${panel.id} step count=${count}，預期 1`];
  });
}

function directionViolations(model: FoldModel): string[] {
  const violations: string[] = [];
  for (let sample = 0; sample <= SWEEP_SAMPLES; sample += 1) {
    const t = sample / SWEEP_SAMPLES;
    const pose = foldPose(t, model);
    for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
      const angle = pose.get(panel.id) ?? 0;
      if (
        panel.foldAngle !== 0
        && Math.sign(angle) === -Math.sign(panel.foldAngle)
        && Math.abs(degrees(angle)) > 0.5
      ) {
        violations.push(`G2:${panel.id}@${t.toFixed(4)} 摺向反轉`);
      }
      if (panel.foldAngle === 0 && Math.abs(angle) > 1e-12) {
        violations.push(`extensionIdentity:${panel.id}@${t.toFixed(4)}=${angle}`);
      }
    }
  }
  return violations;
}

function rateViolations(model: FoldModel): string[] {
  const violations: string[] = [];
  const samples = 400;
  let previous = foldPose(0, model);
  for (let sample = 1; sample <= samples; sample += 1) {
    const t = sample / samples;
    const pose = foldPose(t, model);
    for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
      const delta = Math.abs(
        (pose.get(panel.id) ?? 0) - (previous.get(panel.id) ?? 0),
      );
      const rate = degrees(delta) * (samples / 100);
      if (rate > G3_RATE_CAP_DEG_PER_001T + 1e-7) {
        violations.push(
          `G3:${panel.id}@${t.toFixed(4)}=${rate.toFixed(6)}°/0.01t`,
        );
      }
    }
    previous = pose;
  }
  return violations;
}

function bounds(points: Vec3[]): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    minZ: Math.min(...points.map(({ z }) => z)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y)),
    maxZ: Math.max(...points.map(({ z }) => z)),
  };
}

function silhouetteViolations(
  model: FoldModel,
  _params: ResolvedParams,
  pieceId: string,
): string[] {
  const geometry = worldGeometry(model, foldPose(1, model));
  const targetPose = new Map(model.panels.map(({ id, foldAngle }) => [
    id,
    foldAngle,
  ]));
  const targetGeometry = worldGeometry(model, targetPose);
  const violations: string[] = [];
  for (const [panelId, points] of geometry) {
    const targetPoints = targetGeometry.get(panelId);
    if (!targetPoints) {
      violations.push(`G5:${pieceId}/${panelId} 缺少 target silhouette`);
      continue;
    }
    const target = bounds(targetPoints);
    for (const point of points) {
      if (
        point.x < target.minX - GEOMETRY_TOLERANCE_MM
        || point.x > target.maxX + GEOMETRY_TOLERANCE_MM
        || point.y < target.minY - GEOMETRY_TOLERANCE_MM
        || point.y > target.maxY + GEOMETRY_TOLERANCE_MM
        || point.z < target.minZ - GEOMETRY_TOLERANCE_MM
        || point.z > target.maxZ + GEOMETRY_TOLERANCE_MM
      ) {
        violations.push(
          `G5:${panelId} silhouette (${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)})`,
        );
        break;
      }
    }
  }
  return violations;
}

function closestFlatPointPairs(
  left: Pt[],
  right: Pt[],
  maximumFlatDistance: number,
): Array<[Pt, Pt]> {
  const candidates = left.flatMap((leftPoint) =>
    right.map((rightPoint) => ({
      left: leftPoint,
      right: rightPoint,
      distance: Math.hypot(
        leftPoint.x - rightPoint.x,
        leftPoint.y - rightPoint.y,
      ),
    })))
    .filter(({ distance }) => distance <= maximumFlatDistance)
    .sort((first, second) => first.distance - second.distance);
  const pairs: Array<[Pt, Pt]> = [];
  const usedLeft = new Set<Pt>();
  const usedRight = new Set<Pt>();
  for (const candidate of candidates) {
    if (usedLeft.has(candidate.left) || usedRight.has(candidate.right)) continue;
    pairs.push([candidate.left, candidate.right]);
    usedLeft.add(candidate.left);
    usedRight.add(candidate.right);
  }
  return pairs;
}

function pointOnSegment2(point: Pt, start: Pt, end: Pt): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length <= NUMERIC_EPSILON) return false;
  const crossValue = Math.abs(
    dx * (point.y - start.y) - dy * (point.x - start.x),
  ) / length;
  const ratio = (
    (point.x - start.x) * dx + (point.y - start.y) * dy
  ) / (length * length);
  return crossValue <= 1e-6
    && ratio >= -NUMERIC_EPSILON
    && ratio <= 1 + NUMERIC_EPSILON;
}

function sharedBoundaryPointPairs(
  left: Pt[],
  right: Pt[],
): Array<[Pt, Pt]> {
  const points: Pt[] = [];
  const addUnique = (point: Pt) => {
    if (!points.some((candidate) =>
      Math.hypot(candidate.x - point.x, candidate.y - point.y) <= 1e-6)) {
      points.push({ ...point });
    }
  };
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex]!;
    const leftEnd = left[(leftIndex + 1) % left.length]!;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightStart = right[rightIndex]!;
      const rightEnd = right[(rightIndex + 1) % right.length]!;
      for (const point of [leftStart, leftEnd]) {
        if (pointOnSegment2(point, rightStart, rightEnd)) addUnique(point);
      }
      for (const point of [rightStart, rightEnd]) {
        if (pointOnSegment2(point, leftStart, leftEnd)) addUnique(point);
      }
    }
  }
  return points.map((point) => [point, { ...point }]);
}

function worldPoint(
  model: FoldModel,
  pose: Map<string, number>,
  panelId: string,
  point: Pt,
): Vec3 {
  return applyTransform(
    panelWorldTransform(model, pose, panelId),
    { x: point.x, y: point.y, z: 0 },
  );
}

function seamFormulaViolations(
  model: FoldModel,
  params: ResolvedParams,
): string[] {
  const rootJog = params.rootJog;
  if (typeof rootJog !== 'number') return ['seamFormula:缺少 rootJog'];
  const floor = model.panels.find(({ id }) => id === 'floor');
  if (!floor) return [];
  const violations: string[] = [];
  for (const corner of ['NegNeg', 'NegPos', 'PosNeg', 'PosPos']) {
    const wingX = model.panels.find(({ id }) => id === `wingX${corner}`)!;
    const wingY = model.panels.find(({ id }) => id === `wingY${corner}`)!;
    const diagonalPairs = (
      sharedBoundaryPointPairs(wingX.polygon, wingY.polygon).length > 0
        ? sharedBoundaryPointPairs(wingX.polygon, wingY.polygon)
        : closestFlatPointPairs(
          wingX.polygon,
          wingY.polygon,
          Math.SQRT2 * rootJog + 0.1,
        )
    ).slice(0, 2);
    const floorPairs = (
      sharedBoundaryPointPairs(floor.polygon, wingY.polygon).length > 0
        ? sharedBoundaryPointPairs(floor.polygon, wingY.polygon)
        : closestFlatPointPairs(
          floor.polygon,
          wingY.polygon,
          rootJog * 2 + 0.1,
        )
    ).slice(0, 2);
    if (diagonalPairs.length === 0) {
      violations.push(`diagonalWingSeamGap:${corner} 無量測點`);
    }
    if (floorPairs.length === 0) {
      violations.push(`floorWingYJogSeparation:${corner} 無量測點`);
    }
    for (const t of phaseSweepTimes(model)) {
      const pose = foldPose(t, model);
      const diagonalGap = Math.max(0, ...diagonalPairs.map(([xPoint, yPoint]) =>
        magnitude(subtract(
          worldPoint(model, pose, wingX.id, xPoint),
          worldPoint(model, pose, wingY.id, yPoint),
        ))));
      if (diagonalGap > Math.SQRT2 * rootJog + GEOMETRY_TOLERANCE_MM) {
        violations.push(
          `diagonalWingSeamGap:${corner}@${t.toFixed(4)}=${diagonalGap.toFixed(6)}`,
        );
        break;
      }
      const outerY = `wallY${corner.endsWith('Neg') ? 'Neg' : 'Pos'}-outer`;
      const phi = Math.abs(pose.get(outerY) ?? 0);
      const jogGap = Math.max(0, ...floorPairs.map(([floorPoint, wingPoint]) =>
        magnitude(subtract(
          worldPoint(model, pose, floor.id, floorPoint),
          worldPoint(model, pose, wingY.id, wingPoint),
        ))));
      const jogLimit = 2 * rootJog * Math.sin(phi / 2)
        + GEOMETRY_TOLERANCE_MM;
      if (jogGap > jogLimit) {
        violations.push(
          `floorWingYJogSeparation:${corner}@${t.toFixed(4)}=${jogGap.toFixed(6)}>${jogLimit.toFixed(6)}`,
        );
        break;
      }
    }
  }
  return violations;
}

function polygonOverlapArea(
  left: Poly3,
  right: Poly3,
  targetNormal: Vec3,
): number {
  const drop = dominantDropAxis(targetNormal);
  let normalComponent: keyof Vec3;
  if (drop === 'x') {
    normalComponent = 'x';
  } else if (drop === 'y') {
    normalComponent = 'y';
  } else {
    normalComponent = 'z';
  }
  let area = 0;
  for (const leftTriangle of triangles(left)) {
    for (const rightTriangle of triangles(right)) {
      const clipped = clipConvexPolygon(
        leftTriangle.map((point) => project2(point, drop)),
        rightTriangle.map((point) => project2(point, drop)),
      );
      if (clipped.length >= 3) area += Math.abs(signedArea2(clipped));
    }
  }
  return area / Math.max(
    Math.abs(targetNormal[normalComponent]),
    NUMERIC_EPSILON,
  );
}

function finalFlapViolations(
  model: FoldModel,
  params: ResolvedParams,
  pieceId: string,
): string[] {
  const flapIds = model.panels
    .filter(({ id }) => id.startsWith('flap'))
    .map(({ id }) => id);
  if (flapIds.length === 0) return [];
  const geometry = worldGeometry(model, foldPose(1, model), {
    applyVertexClamp: false,
  });
  const violations: string[] = [];
  for (const flapId of flapIds) {
    const corner = flapId.slice('flap'.length);
    const ySign = corner.endsWith('Neg') ? 'Neg' : 'Pos';
    const wallId = `wallY${ySign}-inner`;
    const flap = polyFromWorld(model, geometry, flapId);
    const wall = polyFromWorld(model, geometry, wallId);
    const flapPanel = model.panels.find(({ id }) => id === flapId)!;
    const hinge = flapPanel.hingeLine;
    if (!hinge) {
      violations.push(`flapWallCoplanarity:${flapId} 缺少 hinge`);
      continue;
    }
    const targetPlaneY = (
      worldPoint(model, foldPose(1, model), flapId, hinge.a).y
      + worldPoint(model, foldPose(1, model), flapId, hinge.b).y
    ) / 2;
    const distance = Math.max(...flap.points.map(({ y }) =>
      Math.abs(y - targetPlaneY)));
    if (distance > GEOMETRY_TOLERANCE_MM) {
      violations.push(
        `flapWallCoplanarity:${flapId}=${distance.toFixed(6)}mm`,
      );
    }
    const wallPlane = plane(wall);
    const drop = dominantDropAxis(wallPlane.normal);
    const root = geometry.get('floor');
    const height = params[pieceId === 'base' ? 'baseHeight' : 'lidHeight'];
    const platformWidth = params[
      pieceId === 'base' ? 'basePlatformWidth' : 'lidPlatformWidth'
    ];
    const wallTopCompensation = pieceId === 'base'
      ? params.wallTopCompensation
      : 0;
    if (
      !root
      || typeof height !== 'number'
      || typeof platformWidth !== 'number'
      || typeof wallTopCompensation !== 'number'
    ) {
      violations.push(`flapContainment:${flapId} 缺少 silhouette 公式輸入`);
      continue;
    }
    const formula = hookFormula(params, pieceId, corner);
    const rootXs = root.map(({ x }) => x);
    const wall2: Array<[number, number]> = [
      [Math.min(...rootXs) - formula.bandMm, 0],
      [Math.max(...rootXs) + formula.bandMm, 0],
      [
        Math.max(...rootXs) + formula.bandMm,
        height - wallTopCompensation + platformWidth,
      ],
      [
        Math.min(...rootXs) - formula.bandMm,
        height - wallTopCompensation + platformWidth,
      ],
    ];
    const outside = flap.points.filter((point) =>
      !pointInPolygonWithTolerance(
        project2(point, drop),
        wall2,
        GEOMETRY_TOLERANCE_MM,
      ));
    if (outside.length > 0) {
      violations.push(
        `flapContainment:${flapId} outside=${outside.length} `
        + outside.map((point) => JSON.stringify(project2(point, drop))).join(','),
      );
    }
  }

  for (const ySign of ['Neg', 'Pos'] as const) {
    const left = polyFromWorld(model, geometry, `flapNeg${ySign}`);
    const right = polyFromWorld(model, geometry, `flapPos${ySign}`);
    const wall = polyFromWorld(model, geometry, `wallY${ySign}-inner`);
    const overlap = polygonOverlapArea(left, right, plane(wall).normal);
    if (overlap <= NUMERIC_EPSILON) {
      violations.push(
        `flapPairInterlockOverlap:Y${ySign}=${overlap.toFixed(9)}mm2`,
      );
    }
  }
  return violations;
}

function hingeArcResidualMm(
  panel: FoldModel['panels'][number],
  hinge: NonNullable<FoldModel['panels'][number]['hingeLine']>,
): number {
  const axisX = hinge.b.x - hinge.a.x;
  const axisY = hinge.b.y - hinge.a.y;
  const length = Math.hypot(axisX, axisY);
  if (length <= NUMERIC_EPSILON) return 0;
  return Math.max(0, ...panel.polygon.flatMap((point) => {
    const projection = (
      (point.x - hinge.a.x) * axisX
      + (point.y - hinge.a.y) * axisY
    ) / length;
    return [-projection, projection - length];
  }));
}

function finalEnvelopeAllowance(
  params: ResolvedParams,
  pieceId: string,
  panelId: string,
): { id: string; residualMm: number } {
  if (!panelId.startsWith('flap')) return { id: 'none', residualMm: 0 };
  return {
    id: 'jog-hook-root-strip',
    residualMm: hookFormula(
      params,
      pieceId,
      panelId.slice('flap'.length),
    ).bandMm,
  };
}

function finalExtensionViolations(model: FoldModel): string[] {
  const extensionIds = model.panels
    .filter(({ id }) => id.startsWith('gussetExt'))
    .map(({ id }) => id);
  if (extensionIds.length === 0) return [];

  const violations: string[] = [];
  // 延伸段在包覆拍開始前必須恆為 identity（§4.6 extensionBeforeWrapIdentity）。
  const wrapStart = TELESCOPE_TRAY_WINDOWS.plain.extWrap[0];
  const earlyMotion = new Set<string>();
  for (let sample = 0; sample <= SWEEP_SAMPLES; sample += 1) {
    const t = wrapStart * sample / SWEEP_SAMPLES;
    const pose = foldPose(t, model);
    for (const extensionId of extensionIds) {
      const angle = pose.get(extensionId) ?? 0;
      if (
        Math.abs(angle) > NUMERIC_EPSILON
        && !earlyMotion.has(extensionId)
      ) {
        earlyMotion.add(extensionId);
        violations.push(
          `extensionBeforeWrapIdentity:${extensionId}@${t.toFixed(4)}=${angle}`,
        );
      }
    }
  }

  const finalPose = foldPose(1, model);
  const geometry = worldGeometry(model, finalPose, { applyVertexClamp: false });
  for (const extensionId of extensionIds) {
    const extensionPanel = model.panels.find(({ id }) => id === extensionId)!;
    const hinge = extensionPanel.hingeLine;
    if (!hinge) {
      violations.push(`extensionWallCoplanarity:${extensionId} 缺少 hinge`);
      continue;
    }
    const targetPlaneY = (
      worldPoint(model, finalPose, extensionId, hinge.a).y
      + worldPoint(model, finalPose, extensionId, hinge.b).y
    ) / 2;
    const extension = polyFromWorld(model, geometry, extensionId);
    const distance = Math.max(...extension.points.map(({ y }) =>
      Math.abs(y - targetPlaneY)));
    if (distance > GEOMETRY_TOLERANCE_MM) {
      violations.push(
        `extensionWallCoplanarity:${extensionId}=${distance.toFixed(6)}mm`,
      );
    }

    const corner = extensionId.slice('gussetExt'.length);
    const ySign = corner.endsWith('Neg') ? 'Neg' : 'Pos';
    const wall = polyFromWorld(model, geometry, `wallY${ySign}-inner`);
    const drop = dominantDropAxis(plane(wall).normal);
    const wall2 = wall.points.map((point) => project2(point, drop));
    const hingeArcResidual = hingeArcResidualMm(extensionPanel, hinge);
    const outside = extension.points.filter((point) =>
      !pointInPolygonWithTolerance(
        project2(point, drop),
        wall2,
        hingeArcResidual + GEOMETRY_TOLERANCE_MM,
      ));
    if (outside.length > 0) {
      violations.push(
        `extensionContainment:${extensionId} outside=${outside.length} `
        + `allowance=hinge-arc-residual:${hingeArcResidual.toFixed(6)}mm`,
      );
    }
  }
  return violations;
}

function finalEnvelopeViolations(
  model: FoldModel,
  params: ResolvedParams,
  pieceId: string,
): string[] {
  if (pieceId === 'liner') return [];
  const geometry = worldGeometry(model, foldPose(1, model), {
    applyVertexClamp: false,
  });
  const outerWallPoints = model.panels
    .filter(({ id }) => /^wall[XY](?:Neg|Pos)-outer$/.test(id))
    .flatMap(({ id }) => geometry.get(id) ?? []);
  if (outerWallPoints.length === 0) {
    return [`finalEnvelope:${pieceId} 缺少 outer wall 包絡`];
  }
  const envelope = bounds(outerWallPoints);
  const violations: string[] = [];
  for (const [panelId, points] of geometry) {
    const allowance = finalEnvelopeAllowance(params, pieceId, panelId);
    const maximumResidual = Math.max(0, ...points.map((point) => Math.max(
      envelope.minX - point.x,
      point.x - envelope.maxX,
      envelope.minY - point.y,
      point.y - envelope.maxY,
    )));
    if (maximumResidual > allowance.residualMm + GEOMETRY_TOLERANCE_MM) {
      violations.push(
        `finalEnvelope:${pieceId}/${panelId} residual=${maximumResidual.toFixed(6)}mm `
        + `allowance=${allowance.id}:${allowance.residualMm.toFixed(6)}mm`,
      );
    }
  }
  return violations;
}

function namedPairIds(model: FoldModel): Array<{
  left: string;
  right: string;
  family: string;
  corner?: string;
}> {
  const ids = new Set(model.panels.map(({ id }) => id));
  const pairs: Array<{
    left: string;
    right: string;
    family: string;
    corner?: string;
  }> = [];
  for (const corner of ['NegNeg', 'NegPos', 'PosNeg', 'PosPos']) {
    const xSign = corner.startsWith('Neg') ? 'Neg' : 'Pos';
    const ySign = corner.endsWith('Neg') ? 'Neg' : 'Pos';
    const candidates = [
      [`wingX${corner}`, `wingY${corner}`, 'wingX↔wingY'],
      [`wingX${corner}`, `wallY${ySign}-outer`, 'wingX↔wallY'],
      [`wingY${corner}`, `wallX${xSign}-outer`, 'wingY↔wallX'],
      [`wingX${corner}`, `wallX${xSign}-outer`, 'wingX↔selfWall'],
      [`wingY${corner}`, `wallY${ySign}-outer`, 'wingY↔selfWall'],
      [`flap${corner}`, `wingX${corner}`, 'flap↔wingX'],
      [`flap${corner}`, `wingY${corner}`, 'flap↔wingY'],
      [`flap${corner}`, `wallX${xSign}-inner`, 'flap↔wallX'],
      [`flap${corner}`, `wallY${ySign}-inner`, 'flap↔wallY'],
      [`gussetExt${corner}`, `wingX${corner}`, 'extension↔wingX'],
      [`gussetExt${corner}`, `wingY${corner}`, 'extension↔wingY'],
      [`gussetExt${corner}`, `wallX${xSign}-inner`, 'extension↔wallX'],
      [`gussetExt${corner}`, `wallY${ySign}-inner`, 'extension↔wallY'],
    ] as const;
    for (const [left, right, family] of candidates) {
      if (ids.has(left) && ids.has(right)) {
        pairs.push({ left, right, family, corner });
      }
    }
  }
  for (const ySign of ['Neg', 'Pos'] as const) {
    const left = `flapNeg${ySign}`;
    const right = `flapPos${ySign}`;
    if (ids.has(left) && ids.has(right)) {
      pairs.push({ left, right, family: 'flap↔flap' });
    }
  }
  return pairs;
}

/**
 * 貼向 y 壁的層間剝離上界＝`reach × sin(離就位還差的角) + 容差`。
 *
 * ⚠ 驅動角不一定是被量那片自己的（v15.2 錯階段序重取）：角翼在 interlock 拍
 * 就已轉到 −90° 定住，最後的貼合是 y 壁在 raiseY 拍轉完成的。只讀角翼自身殘餘
 * 角會得到 0，把純粹「壁還沒轉完」的殘餘誤判成 G1（M-05 rootJog=0 實證）。
 * 故取「被量片」與「共量的壁」兩者殘餘角的較大者。t=1 時兩者皆 0，上界退化
 * 為純容差——**不會掩蓋真碰撞**。
 */
function closeYWindow(model: FoldModel): Window {
  return model.panels.some(({ id }) => id.startsWith('flap'))
    ? TELESCOPE_TRAY_WINDOWS.flapped.closeY
    : TELESCOPE_TRAY_WINDOWS.plain.closeY;
}

function isInsideCloseY(model: FoldModel, t: number): boolean {
  const [start, end] = closeYWindow(model);
  return t > start + NUMERIC_EPSILON && t < end - NUMERIC_EPSILON;
}

/**
 * closeY 蓋合路線閘門（v15.4·取代 depth 成為此拍的判別條件）。
 *
 * 內壁必須「繞過盒口、從盒外上方盪入」，而不是從盒內或盒底方向掃上來。
 * 兩條路線的接觸深度同量級（depth 不可分），但**中段姿態正交可分**：
 * 走對路線時，內壁在拍中段整片高於盒口平面；走錯時則不會。
 * 另斷言終態確實回到壁面（避免「高著就不下來」通過本條）。
 */
function closeYRouteViolations(model: FoldModel): string[] {
  const violations: string[] = [];
  const [start, end] = closeYWindow(model);
  const finalGeometry = worldGeometry(
    model,
    foldPose(1, model),
    { applyVertexClamp: false },
  );
  for (const sign of ['Neg', 'Pos'] as const) {
    const innerId = `wallY${sign}-inner`;
    const outerId = `wallY${sign}-outer`;
    if (!finalGeometry.has(innerId) || !finalGeometry.has(outerId)) continue;
    const rim = Math.max(...finalGeometry.get(outerId)!.map(({ z }) => z));

    // 中段：內壁全片須高於盒口（＝走盒外上方那條路）。
    const mid = (start + end) / 2;
    const midPoints = worldGeometry(
      model,
      foldPose(mid, model),
      { applyVertexClamp: false },
    ).get(innerId)!;
    const lowest = Math.min(...midPoints.map(({ z }) => z));
    if (lowest < rim - GEOMETRY_TOLERANCE_MM) {
      violations.push(
        `closeYRoute:${innerId}@${mid.toFixed(4)} 最低點 z=${lowest.toFixed(6)}`
        + ` < 盒口 ${rim.toFixed(6)}（未走盒外上方路線）`,
      );
    }
    // 終態：必須真的落回壁面（不得停在盒口之上）。
    // ⚠ 量**形心**不量最高頂點：內壁輪廓可有超出鉸線的小塊（M-10 實測 2.202mm），
    // 摺完自然翹在盒口上方，那是輪廓特徵不是「沒蓋合」。形心對兩者可分——
    // 沒蓋合時形心仍在盒口高度，蓋合後形心落到壁高中段。
    const finalPoints = finalGeometry.get(innerId)!;
    const centroidZ = finalPoints.reduce((sum, { z }) => sum + z, 0)
      / finalPoints.length;
    if (centroidZ > rim - GEOMETRY_TOLERANCE_MM) {
      violations.push(
        `closeYRoute:${innerId}@1 終態形心 z=${centroidZ.toFixed(6)}`
        + ` 未低於盒口 ${rim.toFixed(6)}（未蓋合）`,
      );
    }
  }
  return violations;
}

function wallLayerPeelLimit(
  model: FoldModel,
  pose: ReadonlyMap<string, number>,
  panelId: string,
  coPanelId?: string,
): number | null {
  const panel = model.panels.find(({ id }) => id === panelId);
  const hinge = panel?.hingeLine;
  if (!panel || !hinge) return null;
  const axisX = hinge.b.x - hinge.a.x;
  const axisY = hinge.b.y - hinge.a.y;
  const axisLength = Math.hypot(axisX, axisY);
  if (axisLength <= NUMERIC_EPSILON) return null;
  const reach = Math.max(...panel.polygon.map((point) =>
    Math.abs(
      axisX * (point.y - hinge.a.y)
      - axisY * (point.x - hinge.a.x),
    ) / axisLength));
  const remainingFor = (id: string): number => {
    const candidate = model.panels.find((entry) => entry.id === id);
    if (!candidate) return 0;
    return Math.abs(
      Math.abs(pose.get(id) ?? 0) - Math.abs(candidate.foldAngle),
    );
  };
  const remainingAngle = Math.min(
    Math.PI / 2,
    Math.max(
      remainingFor(panelId),
      coPanelId === undefined ? 0 : remainingFor(coPanelId),
    ),
  );
  return reach * Math.sin(remainingAngle) + GEOMETRY_TOLERANCE_MM;
}

/** 真實紙盒壁的最大疊層數＝外壁＋角撐＋內壁 ＝ 3 張紙。
 * `normalOffset` 是**實體位移**，位移超過真實疊層深度就不再是「表現疊層」，
 * 而是把紙搬到別的地方去（修正前實測最大 3.500mm ＝ 11.7 倍紙厚）。 */
const RENDER_STACK_MAX_LAYERS = 3;
/** 兩片的外法向要多平行才值得比內外——角撐/角翼摺到壁面上後與該壁同向；
 * 舌片橫躺盒底時法向朝下，與壁不同族，不該互比。 */
const RENDER_STACK_PARALLEL_DOT = 0.99;
/** 與 fold-scene.ts 的 SURFACE_GAP_MM 同值。獨立寫一份當 oracle——期望值不從
 * 被測函式動態推導，才不會跟著錯值一起漂移（沿用本檔既有慣例）。 */
const RENDER_SURFACE_GAP_MM = 0.05;

interface RenderStackEntry {
  panelId: string;
  /** 外法向單位向量（遠離盒心）＝ 面法向 × exteriorDirection。 */
  outward: Vec3;
  /** 名義幾何（真實紙面）沿外法向的位置——**外部 ground truth**，非由層號推得。 */
  nominalPos: number;
  normalOffset: number;
}

/**
 * 顯示層位移的兩條物理約束（AC-T9 家族）。
 *
 * 為什麼需要這條閘門：`normalOffset` 與 `renderOrder` 曾共用同一組層號，而層號是
 * **繪製順序 rank**（跨度 16 階）。當它同時被當成實體位移，位移量級（±3.5mm）
 * 就與真實層距（platformWidth 5mm）同量級，足以把本該收在裡面的角翼推到外壁
 * 之外——畫面上看到的薄片外露。
 *
 * 兩條判準：
 *  ① **位移預算**：|normalOffset| ≤ 3 層。純量級，抓「排序 rank 當位移」這類錯誤。
 *  ② **順序不得反轉**：對外法向近乎平行、且**名義幾何本身就分得開**的兩片，
 *     位移後的內外順序必須與名義一致。名義幾何由摺疊運動學決定、不由層號表決定，
 *     ⇒ 這條的參照物在被測設計之外，閘門不會與設計自洽地一起錯。
 *     名義上共面的兩片不設約束：它們的先後本來就只能由層號表宣告。
 *
 * ⚠ **兩條並不正交**（sabotage 實測·別高估 ②）：把角撐 −1 與先摺角翼 −3 對調
 * （量級仍在預算內、只有順序錯），②**沒有命中**——名義間隙 4.5mm 遠大於 2 層
 * 位移 0.7mm，符號翻不過來。②實質上只在「位移量級接近名義間隙」時才有判別力，
 * 亦即多半由①一併涵蓋。**「合法量級下的層序錯」目前無機器判準**：零厚度模型裡
 * 共面兩片的內外純屬宣告，沒有可量的外部錨。此限制屬已知，不得以①的綠燈代表
 * 層序已驗證。交疊片之間「plan 必須相異」另由 fold-overlap-diagnosis 逐 pair 守住。
 */
export function renderStackViolations(
  model: FoldModel,
  pieceId: string,
  thickness = 0.3,
): string[] {
  const violations: string[] = [];
  const pose = foldPose(1, model);
  // 位移方向取名義（未收束）幾何，與 panelRenderVertices 的 normalReference 同源。
  const nominal = worldGeometry(model, pose, { applyVertexClamp: false });
  const exteriorFaces = new Map(
    diagnoseFoldedPanelFaces(model).map(({ panelId, exteriorFace }) => [panelId, exteriorFace]),
  );
  const layerOffset = Math.max(0, thickness) + RENDER_SURFACE_GAP_MM;
  const budget = RENDER_STACK_MAX_LAYERS * layerOffset + GEOMETRY_TOLERANCE_MM;

  const entries: RenderStackEntry[] = [];
  for (const panel of model.panels) {
    const points = nominal.get(panel.id) ?? [];
    if (points.length < 3) continue;
    const normal = firstFaceNormal(points);
    if (!normal) continue;
    const { normalOffset } = panelOverlapPlan(`${pieceId}:${panel.id}`, thickness);
    if (Math.abs(normalOffset) > budget) {
      violations.push(
        `renderStack:budget ${pieceId}:${panel.id} |normalOffset|=`
        + `${Math.abs(normalOffset).toFixed(3)}mm > ${budget.toFixed(3)}mm`
        + `（${RENDER_STACK_MAX_LAYERS} 層 × ${layerOffset.toFixed(3)}mm）`,
      );
    }
    const outward = scale(normal, exteriorFaces.get(panel.id) === 'front' ? 1 : -1);
    const centroid = scale(
      points.reduce((acc, point) => add(acc, point), { x: 0, y: 0, z: 0 }),
      1 / points.length,
    );
    entries.push({
      panelId: panel.id,
      outward,
      nominalPos: dot(centroid, outward),
      normalOffset,
    });
  }

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left]!;
      const b = entries[right]!;
      const alignment = dot(a.outward, b.outward);
      if (alignment < RENDER_STACK_PARALLEL_DOT) continue;
      // 兩片投影到同一條軸（a 的外法向）才可比。
      const bNominalOnA = b.nominalPos * alignment;
      const nominalGap = a.nominalPos - bNominalOnA;
      if (Math.abs(nominalGap) <= GEOMETRY_TOLERANCE_MM) continue;
      const renderedGap = (a.nominalPos + a.normalOffset)
        - (bNominalOnA + b.normalOffset);
      if (Math.sign(nominalGap) === Math.sign(renderedGap)) continue;
      violations.push(
        `renderStack:inversion ${pieceId} ${a.panelId} vs ${b.panelId}`
        + ` 名義 ${nominalGap.toFixed(3)}mm → 渲染 ${renderedGap.toFixed(3)}mm（內外顛倒）`,
      );
    }
  }

  return violations;
}

export function telescopeCollisionViolations(
  model: FoldModel,
  params: ResolvedParams,
  pieceId: string,
): string[] {
  if (pieceId === 'liner') return [];
  const violations: string[] = [];
  const pairs = namedPairIds(model);
  for (const t of phaseSweepTimes(model)) {
    const pose = foldPose(t, model);
    const geometry = worldGeometry(model, pose, { applyVertexClamp: false });
    for (const pair of pairs) {
      const left = polyFromWorld(model, geometry, pair.left);
      const right = polyFromWorld(model, geometry, pair.right);
      // 終態同層接觸是 renderer 的 layer-overlap；只有整對面確實共面才跳過。
      // 非共面 pair 一律繼續走 crossing/depth G1，不得按 phase blanket skip。
      if (isCoplanarLayerOverlap(left, right)) continue;
      const crossing = pairCrossing(left, right);
      if (!crossing.crossing) continue;
      if (
        pair.family === 'flap↔flap'
        && Math.abs(t - 1) <= NUMERIC_EPSILON
      ) continue;
      if (
        pair.corner
        && (pair.family === 'flap↔wingX' || pair.family === 'flap↔wingY')
        && t >= TELESCOPE_TRAY_WINDOWS.flapped.interlock[0] - NUMERIC_EPSILON
      ) {
        const formula = hookFormula(params, pieceId, pair.corner);
        const measurement = hookMeasurement(left, right);
        if (measurement) {
          const flapAngle = pose.get(pair.left) ?? Math.PI;
          const peelAngle = Math.max(0, Math.PI - Math.abs(flapAngle));
          const analyticLimit = (
            formula.bandMm * Math.sin(peelAngle)
            + GEOMETRY_TOLERANCE_MM
          );
          if (
            hookRootStripWithinBounds(formula, measurement)
            && measurement.bandMm <= analyticLimit
          ) continue;
          violations.push(
            `hook-root-strip:${pair.left}↔${pair.right}@${t.toFixed(4)} band=${measurement.bandMm.toFixed(6)}/${analyticLimit.toFixed(6)} span=${measurement.intersectionLengthMm.toFixed(6)}/${(formula.zSpanMm + GEOMETRY_TOLERANCE_MM).toFixed(6)}`,
          );
          continue;
        }
      }
      // ── closeY 內壁蓋合：深度**不是**判準（v15.4） ──
      // 短邊內壁在 closeY 拍由盒外上方繞過盒口盪入、蓋住已就位的角部件（實體照片
      // 04→07 拆解序證實）。零厚度剛體下，內壁與角部件終態相距僅一個 rootJog，
      // 掃掠必然穿過——且**正確與錯誤的掃法穿透深度同量級**，depth 對兩者不可分。
      // 故此拍此 pair 不以 depth 判定；判別力改由 `closeYRouteViolations()` 的
      // 「翻越盒口路線」斷言承擔（正交量：中段的 z 與離牆距離，非接觸深度）。
      // 僅豁免拍內部；拍端點（角部件就位前／內壁到位後）照常走 G1。
      if (
        /↔wallY$/.test(pair.family)
        && /-inner$/.test(pair.right)
        && isInsideCloseY(model, t)
      ) continue;
      if (
        pair.family === 'flap↔wallY'
        && t >= TELESCOPE_TRAY_WINDOWS.flapped.interlock[0] - NUMERIC_EPSILON
      ) {
        // flap 以豎直 hinge 貼向 y wall 時，零厚度剛體的可見剝離深度上界，
        // 由當片 hinge reach × 尚未到位角的 sin 現場推導；超界仍是 G1。
        // 共量的壁＝該 pair 右側所屬的 y 外壁（raiseY 拍才轉完）。
        const layerPeelLimit = wallLayerPeelLimit(
          model,
          pose,
          pair.left,
          pair.right.replace(/-(?:inner|rim|tongue)$/, '-outer'),
        );
        if (
          layerPeelLimit !== null
          && crossing.depthMm <= layerPeelLimit
        ) {
          continue;
        }
      }
      if (
        pair.family === 'extension↔wallY'
        && t >= TELESCOPE_TRAY_WINDOWS.plain.extWrap[0] - NUMERIC_EPSILON
      ) {
        // 共量的壁＝該 pair 右側所屬的 y 外壁（raiseY 拍才轉完）。
        const layerPeelLimit = wallLayerPeelLimit(
          model,
          pose,
          pair.left,
          pair.right.replace(/-(?:inner|rim|tongue)$/, '-outer'),
        );
        if (
          layerPeelLimit !== null
          && crossing.depthMm <= layerPeelLimit
        ) {
          continue;
        }
      }
      if (crossing.depthMm > 0.02) {
        violations.push(
          `G1:${pair.family}:${pair.left}↔${pair.right}@${t.toFixed(4)} depth=${crossing.depthMm.toFixed(6)}`,
        );
      }
    }
  }
  return violations;
}

export function telescopeGateReport(
  model: FoldModel,
  params: ResolvedParams,
  pieceId: string,
): TelescopeGateReport {
  const flapCount = model.panels.filter(({ id }) => id.startsWith('flap')).length;
  const violations = [
    ...familyTopologyViolations(model),
    ...oneStepViolations(model),
    ...directionViolations(model),
    ...rateViolations(model),
    ...silhouetteViolations(model, params, pieceId),
  ];
  if (pieceId !== 'liner') {
    violations.push(
      ...seamFormulaViolations(model, params),
      ...finalFlapViolations(model, params, pieceId),
      ...finalExtensionViolations(model),
      ...finalEnvelopeViolations(model, params, pieceId),
      ...closeYRouteViolations(model),
      ...renderStackViolations(model, pieceId),
      ...telescopeCollisionViolations(model, params, pieceId),
    );
  }
  return {
    flapGatesApplicable: flapCount === 4,
    violations: [...new Set(violations)],
  };
}
