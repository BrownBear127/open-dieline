import type {
  BoxModule,
  DielinePath,
  GenerateResult,
  ResolvedParams,
} from '../../core/types';
import { flattenSegment } from './flatten';
import { applyTransform, panelWorldTransform } from '../pose3d';
import { foldPose } from '../schedule';
import {
  extractFaces,
  JUNCTION_TOLERANCE_MM,
  type FaceGraph,
  type PlanarSegmentInput,
} from './planar-faces';
import {
  ARC_TOLERANCE_MM,
  type FoldModel,
  type FoldDielinePath,
  type FoldPanel,
  type FoldStep,
  type Pt,
  type SeamSegment,
} from '../types';

export interface PanelAngleSpec {
  id: string;
  foldAngle: number;
  liftOffset?: number;
}

export interface HorizontalPanelSplitSpec {
  panelId: string;
  newPanelId: string;
  reparentChildId: string;
  splitY: number;
  foldAngle: number;
}

export class InvalidBoxParamsError extends Error {
  override readonly name = 'InvalidBoxParamsError';

  constructor(public invariantId: string, msg: string) {
    super(`盒型參數違反 invariant「${invariantId}」：${msg}`);
  }
}

export class PanelizeError extends Error {
  override readonly name = 'PanelizeError';
}

interface Role {
  tag: string;
  parentId: string;
  childId: string;
}

interface ClosureBoundary {
  tag: string;
  ownerAId: string;
  ownerBId: string;
}

interface CreaseCandidate {
  a: Pt;
  b: Pt;
  length: number;
  pathId: string;
}

interface RoleGroup extends Role {
  sourcePathIds: string[];
  candidates: CreaseCandidate[];
  faceA: number;
  faceB: number;
}

interface ClosureBoundaryGroup extends ClosureBoundary {
  sourcePathIds: string[];
  faceA: number;
  faceB: number;
}

const ROLE_PATTERN = /^fold:([^>]+)>([^>]+)$/;
const CLOSURE_BOUNDARY_PATTERN = /^fold-boundary:closure:([^>]+)>([^>]+)$/;
const GEOMETRY_TOLERANCE_MM = 1e-6;
const MAX_UNASSIGNED_FACE_AREA_MM2 = 0.5;

export type FoldOnlyInactiveSegments = ReadonlyMap<string, readonly number[]>;

export interface PanelizeOptions {
  roleFragmentToleranceMm?: number;
  maxUnassignedFaceAreaMm2?: number;
  ignoreAmbiguousDanglingCuts?: boolean;
}

function hasNearbyPoint(points: Pt[], target: Pt, tolerance: number): boolean {
  return points.some((point) => Math.hypot(point.x - target.x, point.y - target.y) <= tolerance);
}

export function completeUncutCreaseGaps(inputs: PlanarSegmentInput[]): PlanarSegmentInput[] {
  const cutEndpoints = inputs
    .filter(({ kind }) => kind === 'cut')
    .flatMap(({ polyline }) => [polyline[0]!, polyline[polyline.length - 1]!]);
  const creaseByPath = new Map<string, PlanarSegmentInput[]>();
  for (const input of inputs.filter(({ kind }) => kind === 'crease')) {
    const entries = creaseByPath.get(input.pathId) ?? [];
    entries.push(input);
    creaseByPath.set(input.pathId, entries);
  }

  const completions: PlanarSegmentInput[] = [];
  for (const [pathId, entries] of creaseByPath) {
    if (entries.length < 2) continue;
    const endpoints = entries.flatMap((entry) => [entry.polyline[0]!, entry.polyline[entry.polyline.length - 1]!]);
    let axisStart = endpoints[0]!;
    let axisEnd = endpoints[0]!;
    let axisLength = 0;
    for (let first = 0; first < endpoints.length; first++) {
      for (let second = first + 1; second < endpoints.length; second++) {
        const length = Math.hypot(
          endpoints[second]!.x - endpoints[first]!.x,
          endpoints[second]!.y - endpoints[first]!.y,
        );
        if (length > axisLength) {
          axisStart = endpoints[first]!;
          axisEnd = endpoints[second]!;
          axisLength = length;
        }
      }
    }
    const origin = axisStart;
    const direction = { x: axisEnd.x - origin.x, y: axisEnd.y - origin.y };
    const directionLength = Math.hypot(direction.x, direction.y);
    if (directionLength <= GEOMETRY_TOLERANCE_MM) continue;
    const unit = { x: direction.x / directionLength, y: direction.y / directionLength };
    const projected = entries.map((entry) => {
      const endpoints = [entry.polyline[0]!, entry.polyline[entry.polyline.length - 1]!];
      const sorted = endpoints
        .map((point) => ({ point, distance: (point.x - origin.x) * unit.x + (point.y - origin.y) * unit.y }))
        .sort((a, b) => a.distance - b.distance);
      return { start: sorted[0]!, end: sorted[1]! };
    }).sort((a, b) => a.start.distance - b.start.distance);
    const hasNonZeroEntry = projected.some(({ start, end }) =>
      end.distance - start.distance > GEOMETRY_TOLERANCE_MM);

    for (let index = 1; index < projected.length; index++) {
      const gapStart = projected[index - 1]!.end;
      const gapEnd = projected[index]!.start;
      if (gapEnd.distance - gapStart.distance <= GEOMETRY_TOLERANCE_MM) continue;
      if (
        hasNonZeroEntry
        && hasNearbyPoint(cutEndpoints, gapStart.point, JUNCTION_TOLERANCE_MM)
        && hasNearbyPoint(cutEndpoints, gapEnd.point, JUNCTION_TOLERANCE_MM)
      ) continue;
      completions.push({
        polyline: [gapStart.point, gapEnd.point],
        pathId,
        kind: 'crease',
      });
    }
  }
  return [...inputs, ...completions];
}

function comparePoints(a: Pt, b: Pt): number {
  return a.x - b.x || a.y - b.y;
}

function cleanPoint(point: Pt): Pt {
  return {
    x: Object.is(point.x, -0) ? 0 : point.x,
    y: Object.is(point.y, -0) ? 0 : point.y,
  };
}

function orderedEndpoints(a: Pt, b: Pt): [Pt, Pt] {
  return comparePoints(a, b) <= 0 ? [cleanPoint(a), cleanPoint(b)] : [cleanPoint(b), cleanPoint(a)];
}

function parseRole(tag: string): Role {
  const match = ROLE_PATTERN.exec(tag);
  if (!match || match[1] === match[2]) {
    throw new PanelizeError(`無效 fold role tag「${tag}」`);
  }
  return { tag, parentId: match[1]!, childId: match[2]! };
}

function parseClosureBoundary(tag: string): ClosureBoundary {
  const match = CLOSURE_BOUNDARY_PATTERN.exec(tag);
  if (!match || match[1] === match[2]) {
    throw new PanelizeError(`無效 fold closure boundary tag「${tag}」`);
  }
  return { tag, ownerAId: match[1]!, ownerBId: match[2]! };
}

function validatedIndexes(path: DielinePath, indexes: readonly number[], source: string): Set<number> {
  const inactive = new Set(indexes);
  if (
    inactive.size !== indexes.length
    || [...inactive].some((index) => !Number.isInteger(index) || index < 0 || index >= path.segments.length)
  ) {
    throw new PanelizeError(`path「${path.id}」的 ${source} 含重複或越界索引`);
  }
  return inactive;
}

function assertInactiveIndexes(
  path: DielinePath,
  foldOnlyInactive: FoldOnlyInactiveSegments,
): Set<number> {
  const inactive = validatedIndexes(path, path.inactiveSegments ?? [], 'inactiveSegments');
  const foldOnly = validatedIndexes(
    path,
    foldOnlyInactive.get(path.id) ?? [],
    'foldOnlyInactive',
  );
  return new Set([...inactive, ...foldOnly]);
}

function activeGeometry(
  result: GenerateResult,
  tolMm: number,
  foldOnlyInactive: FoldOnlyInactiveSegments,
): {
  inputs: PlanarSegmentInput[];
  rolesByPathId: Map<string, Role>;
  closureBoundariesByPathId: Map<string, ClosureBoundary>;
  creaseCandidatesByPathId: Map<string, CreaseCandidate[]>;
} {
  const inputs: PlanarSegmentInput[] = [];
  const rolesByPathId = new Map<string, Role>();
  const closureBoundariesByPathId = new Map<string, ClosureBoundary>();
  const creaseCandidatesByPathId = new Map<string, CreaseCandidate[]>();
  const pathIds = new Set<string>();

  for (const path of result.paths) {
    if (pathIds.has(path.id)) throw new PanelizeError(`path id「${path.id}」重複`);
    pathIds.add(path.id);
  }
  const unknownFoldOnlyPaths = [...foldOnlyInactive.keys()].filter((pathId) => !pathIds.has(pathId));
  if (unknownFoldOnlyPaths.length > 0) {
    throw new PanelizeError(`foldOnlyInactive 含未知 path id：${unknownFoldOnlyPaths.join(',')}`);
  }

  for (const path of result.paths) {
    const semanticTags = path.tags?.filter((tag) =>
      ROLE_PATTERN.test(tag) || CLOSURE_BOUNDARY_PATTERN.test(tag)) ?? [];
    const isSemanticFold = semanticTags.length > 0;
    if (path.type !== 'cut' && path.type !== 'crease' && !(path.type === 'halfcut' && isSemanticFold)) {
      continue;
    }

    const inactive = assertInactiveIndexes(path, foldOnlyInactive);
    const activeEntries = path.segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ index }) => !inactive.has(index));
    if (activeEntries.length === 0) continue;

    if (path.type === 'crease' && semanticTags.length === 0) {
      throw new PanelizeError(`未標記 crease「${path.id}」仍含 active segment`);
    }
    if (path.type === 'halfcut' && semanticTags.length === 0) continue;
    const semanticsFollowOriginalSegments = semanticTags.length === path.segments.length;
    if (
      isSemanticFold
      && semanticTags.length !== 1
      && !semanticsFollowOriginalSegments
      && semanticTags.length !== activeEntries.length
    ) {
      throw new PanelizeError(
        `fold path「${path.id}」的 semantic tag 數必須為 1、原始 segment 數或 active segment 數`,
      );
    }

    for (const [activeIndex, { segment, index }] of activeEntries.entries()) {
      let semanticTag = semanticTags[activeIndex];
      if (semanticTags.length === 1) {
        [semanticTag] = semanticTags;
      } else if (semanticsFollowOriginalSegments) {
        semanticTag = semanticTags[index];
      }
      const segmentPathId = semanticTags.length > 1
        ? `${path.id}::segment:${index}`
        : path.id;
      const kind = path.type === 'cut' ? 'cut' : 'crease';
      const polyline = flattenSegment(segment, tolMm);
      inputs.push({ polyline, pathId: segmentPathId, kind });
      if (!semanticTag) continue;
      if (ROLE_PATTERN.test(semanticTag)) {
        rolesByPathId.set(segmentPathId, parseRole(semanticTag));
      } else {
        closureBoundariesByPathId.set(segmentPathId, parseClosureBoundary(semanticTag));
      }
      if (!ROLE_PATTERN.test(semanticTag)) continue;
      if (segment.kind !== 'line') {
        throw new PanelizeError(`hinge crease「${segmentPathId}」必須是直線 segment`);
      }
      const a = cleanPoint({ x: segment.x1, y: segment.y1 });
      const b = cleanPoint({ x: segment.x2, y: segment.y2 });
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > GEOMETRY_TOLERANCE_MM) {
        const candidates = creaseCandidatesByPathId.get(segmentPathId) ?? [];
        candidates.push({ a, b, length, pathId: segmentPathId });
        creaseCandidatesByPathId.set(segmentPathId, candidates);
      }
    }
  }

  return {
    inputs: completeUncutCreaseGaps(inputs),
    rolesByPathId,
    closureBoundariesByPathId,
    creaseCandidatesByPathId,
  };
}

/** 視覺 guide 單向搬運 2D generator 的完整繪製集；不套用 panelize 的 active 過濾。 */
function copyDieline(result: GenerateResult): FoldDielinePath[] {
  return result.paths.flatMap((path): FoldDielinePath[] => {
    if (path.type !== 'cut' && path.type !== 'crease') return [];
    return [{
      id: path.id,
      type: path.type,
      segments: path.segments.map((segment) => ({ ...segment })),
    }];
  });
}

function expectedPanelIds(roles: Iterable<Role>, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (const { parentId, childId } of roles) {
    ids.add(parentId);
    ids.add(childId);
  }
  return ids;
}

function sameSet<T>(first: Set<T>, second: Set<T>): boolean {
  return first.size === second.size && [...first].every((value) => second.has(value));
}

function validateAngles(angles: PanelAngleSpec[], expectedIds: Set<string>, rootId: string): Map<string, PanelAngleSpec> {
  const byId = new Map<string, PanelAngleSpec>();
  for (const angle of angles) {
    if (byId.has(angle.id)) throw new PanelizeError(`angles 含重複 panel id「${angle.id}」`);
    if (!Number.isFinite(angle.foldAngle) || (angle.liftOffset !== undefined && !Number.isFinite(angle.liftOffset))) {
      throw new PanelizeError(`angles 的 panel「${angle.id}」含非有限數`);
    }
    byId.set(angle.id, angle);
  }
  if (!sameSet(new Set(byId.keys()), expectedIds)) {
    throw new PanelizeError(
      `angles id 與 tag 傳播結果不一致：angles=[${[...byId.keys()].sort().join(',')}], tags=[${[...expectedIds].sort().join(',')}]`,
    );
  }
  if (byId.get(rootId)!.foldAngle !== 0) throw new PanelizeError(`angles 的 root「${rootId}」foldAngle 必須為 0`);
  return byId;
}

function validateRoleTree(roles: Iterable<Role>, expectedIds: Set<string>, rootId: string): Map<string, string> {
  const parentByChild = new Map<string, string>();
  const childrenByParent = new Map<string, string[]>();

  for (const { parentId, childId } of roles) {
    const existingParent = parentByChild.get(childId);
    if (existingParent !== undefined && existingParent !== parentId) {
      throw new PanelizeError(`panel「${childId}」同時宣告 parent「${existingParent}」與「${parentId}」`);
    }
    parentByChild.set(childId, parentId);
    const children = childrenByParent.get(parentId) ?? [];
    if (!children.includes(childId)) children.push(childId);
    childrenByParent.set(parentId, children);
  }

  if (parentByChild.has(rootId)) throw new PanelizeError(`root panel「${rootId}」不得有 parent`);
  for (const id of expectedIds) {
    if (id !== rootId && !parentByChild.has(id)) throw new PanelizeError(`panel「${id}」無法從 root「${rootId}」到達`);
  }

  const reachable = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  if (!sameSet(reachable, expectedIds)) {
    const unreachable = [...expectedIds].filter((id) => !reachable.has(id));
    throw new PanelizeError(`panel 無法從 root「${rootId}」到達：${unreachable.join(',')}`);
  }
  return parentByChild;
}

function distanceToLine(point: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx * (point.y - a.y) - dy * (point.x - a.x)) / Math.hypot(dx, dy);
}

function assertCollinear(candidates: CreaseCandidate[], tag: string): void {
  const reference = candidates[0];
  if (!reference) throw new PanelizeError(`fold group「${tag}」沒有非零長 crease segment`);
  for (const candidate of candidates.slice(1)) {
    if (
      distanceToLine(candidate.a, reference.a, reference.b) > GEOMETRY_TOLERANCE_MM
      || distanceToLine(candidate.b, reference.a, reference.b) > GEOMETRY_TOLERANCE_MM
    ) {
      throw new PanelizeError(`fold group「${tag}」的 crease segments 不共線`);
    }
  }
}

function groupRoles(
  graph: FaceGraph,
  rolesByPathId: Map<string, Role>,
  candidatesByPathId: Map<string, CreaseCandidate[]>,
  roleFragmentToleranceMm: number,
): RoleGroup[] {
  const grouped = new Map<string, { role: Role; pathIds: Set<string>; candidates: CreaseCandidate[] }>();
  for (const [pathId, role] of rolesByPathId) {
    const entry = grouped.get(role.tag) ?? { role, pathIds: new Set<string>(), candidates: [] };
    entry.pathIds.add(pathId);
    entry.candidates.push(...(candidatesByPathId.get(pathId) ?? []));
    grouped.set(role.tag, entry);
  }

  return [...grouped.values()].map(({ role, pathIds, candidates }) => {
    const allMatchingAdjacencies = graph.adjacency.filter(({ sharedEdges }) =>
      sharedEdges.some(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId)));
    const adjacencyLength = (adjacency: FaceGraph['adjacency'][number]): number =>
      adjacency.sharedEdges
        .filter(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId))
        .reduce((total, { a, b }) => total + Math.hypot(b.x - a.x, b.y - a.y), 0);
    const sortedAdjacencies = [...allMatchingAdjacencies]
      .sort((a, b) => adjacencyLength(b) - adjacencyLength(a));
    const ignoredLength = sortedAdjacencies
      .slice(1)
      .reduce((total, adjacency) => total + adjacencyLength(adjacency), 0);
    const matchingAdjacencies = sortedAdjacencies.length > 1
      && ignoredLength <= roleFragmentToleranceMm
      ? sortedAdjacencies.slice(0, 1)
      : sortedAdjacencies;
    const pairKeys = new Set(matchingAdjacencies.map(({ faceA, faceB }) => `${faceA}:${faceB}`));
    const seenPathIds = new Set(matchingAdjacencies.flatMap(({ sharedEdges }) => sharedEdges
      .filter(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId))
      .map(({ pathId }) => pathId)));
    if (!sameSet(seenPathIds, pathIds)) {
      const missing = [...pathIds].filter((pathId) => !seenPathIds.has(pathId));
      throw new PanelizeError(`fold group「${role.tag}」的 crease 未形成兩面共邊：${missing.join(',')}`);
    }
    if (pairKeys.size !== 1) {
      throw new PanelizeError(
        `fold group「${role.tag}」必須恰對應一組相鄰面，實際為 ${pairKeys.size} 組`
        + `（${matchingAdjacencies.map(({ faceA, faceB, sharedEdges }) =>
          `${faceA}:${faceB}=${sharedEdges
            .filter(({ pathId }) => pathIds.has(pathId))
            .map(({ a, b }) => `(${a.x},${a.y})→(${b.x},${b.y})`)
            .join('+')}`).join(',')}）`,
      );
    }
    const adjacency = matchingAdjacencies[0]!;
    const snappedCandidates = adjacency.sharedEdges
      .filter(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId))
      .map(({ a, b, pathId }) => ({
        a: cleanPoint(a),
        b: cleanPoint(b),
        length: Math.hypot(b.x - a.x, b.y - a.y),
        pathId,
      }));
    assertCollinear(snappedCandidates, role.tag);
    return {
      ...role,
      sourcePathIds: [...pathIds].sort(),
      candidates: snappedCandidates,
      faceA: adjacency.faceA,
      faceB: adjacency.faceB,
    };
  }).sort((a, b) => a.tag.localeCompare(b.tag));
}

function groupClosureBoundaries(
  graph: FaceGraph,
  boundariesByPathId: Map<string, ClosureBoundary>,
): ClosureBoundaryGroup[] {
  const grouped = new Map<string, {
    boundary: ClosureBoundary;
    pathIds: Set<string>;
  }>();
  for (const [pathId, boundary] of boundariesByPathId) {
    const entry = grouped.get(boundary.tag) ?? {
      boundary,
      pathIds: new Set<string>(),
    };
    entry.pathIds.add(pathId);
    grouped.set(boundary.tag, entry);
  }

  return [...grouped.values()].map(({ boundary, pathIds }) => {
    const matchingAdjacencies = graph.adjacency.filter(({ sharedEdges }) =>
      sharedEdges.some(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId)));
    const pairKeys = new Set(matchingAdjacencies.map(({ faceA, faceB }) => `${faceA}:${faceB}`));
    const seenPathIds = new Set(matchingAdjacencies.flatMap(({ sharedEdges }) => sharedEdges
      .filter(({ kind, pathId }) => kind === 'crease' && pathIds.has(pathId))
      .map(({ pathId }) => pathId)));
    if (!sameSet(seenPathIds, pathIds)) {
      const missing = [...pathIds].filter((pathId) => !seenPathIds.has(pathId));
      throw new PanelizeError(
        `closure boundary「${boundary.tag}」未形成兩面共邊：${missing.join(',')}`,
      );
    }
    if (pairKeys.size !== 1) {
      throw new PanelizeError(
        `closure boundary「${boundary.tag}」必須恰對應一組相鄰面，實際為 ${pairKeys.size} 組`,
      );
    }
    const adjacency = matchingAdjacencies[0]!;
    return {
      ...boundary,
      sourcePathIds: [...pathIds].sort(),
      faceA: adjacency.faceA,
      faceB: adjacency.faceB,
    };
  }).sort((a, b) => a.tag.localeCompare(b.tag));
}

function intersectCandidates(target: Set<string>, allowed: Set<string>): boolean {
  let changed = false;
  for (const value of [...target]) {
    if (!allowed.has(value)) {
      target.delete(value);
      changed = true;
    }
  }
  return changed;
}

function faceAreaAndCentroid(outline: Pt[]): { area: number; centroid: Pt } {
  let twiceSignedArea = 0;
  let centroidXNumerator = 0;
  let centroidYNumerator = 0;
  for (let index = 0; index < outline.length; index++) {
    const current = outline[index]!;
    const next = outline[(index + 1) % outline.length]!;
    const cross = current.x * next.y - next.x * current.y;
    twiceSignedArea += cross;
    centroidXNumerator += (current.x + next.x) * cross;
    centroidYNumerator += (current.y + next.y) * cross;
  }
  const area = Math.abs(twiceSignedArea) / 2;
  return {
    area,
    centroid: {
      x: centroidXNumerator / (3 * twiceSignedArea),
      y: centroidYNumerator / (3 * twiceSignedArea),
    },
  };
}

function assignFaces(
  graph: FaceGraph,
  groups: RoleGroup[],
  panelIds: Set<string>,
  maxUnassignedFaceAreaMm2: number,
): Map<number, string> {
  const allConstraints = groups.map((group) => ({
    tag: group.tag,
    firstId: group.parentId,
    secondId: group.childId,
    faceA: group.faceA,
    faceB: group.faceB,
  }));
  const roleFaces = new Set(allConstraints.flatMap(({ faceA, faceB }) => [faceA, faceB]));
  const oversizedUnassignedFaces = graph.faces
    .map(({ outline }, face) => ({ face, ...faceAreaAndCentroid(outline) }))
    .filter(({ face, area }) => !roleFaces.has(face) && area >= maxUnassignedFaceAreaMm2);
  if (oversizedUnassignedFaces.length > 0) {
    throw new PanelizeError(`非 role 未歸屬面超過 ${maxUnassignedFaceAreaMm2}mm²：${oversizedUnassignedFaces
      .map(({ face, area, centroid }) =>
        `face ${face} 面積=${area.toFixed(6)}mm²，質心=(${centroid.x.toFixed(6)}, ${centroid.y.toFixed(6)})`)
      .join('; ')}`);
  }
  const candidates = new Map([...roleFaces].map((face) => [face, new Set(panelIds)]));
  for (const constraint of allConstraints) {
    const allowed = new Set([constraint.firstId, constraint.secondId]);
    intersectCandidates(candidates.get(constraint.faceA)!, allowed);
    intersectCandidates(candidates.get(constraint.faceB)!, allowed);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const constraint of allConstraints) {
      const first = candidates.get(constraint.faceA)!;
      const second = candidates.get(constraint.faceB)!;
      if (first.size === 0 || second.size === 0) {
        throw new PanelizeError(
          `fold boundary「${constraint.tag}」的 tag 約束互相衝突`
          + `（faces=${constraint.faceA}:${constraint.faceB},`
          + ` candidates=[${[...first].join(',')}]/[${[...second].join(',')}],`
          + ` owners=${constraint.firstId}/${constraint.secondId},`
          + ` faceAConstraints=${allConstraints
            .filter(({ faceA, faceB }) =>
              faceA === constraint.faceA || faceB === constraint.faceA)
            .map(({ tag }) => tag).join('+')},`
          + ` faceBConstraints=${allConstraints
            .filter(({ faceA, faceB }) =>
              faceA === constraint.faceB || faceB === constraint.faceB)
            .map(({ tag }) => tag).join('+')}）`,
        );
      }
      if (first.size === 1) {
        const known = [...first][0]!;
        const other = known === constraint.firstId ? constraint.secondId : constraint.firstId;
        changed = intersectCandidates(second, new Set([other])) || changed;
      }
      if (second.size === 1) {
        const known = [...second][0]!;
        const other = known === constraint.firstId ? constraint.secondId : constraint.firstId;
        changed = intersectCandidates(first, new Set([other])) || changed;
      }
    }
  }

  const ambiguous = [...candidates]
    .map(([face, ids]) => ({ face, ids: [...ids].sort() }))
    .filter(({ ids }) => ids.length !== 1);
  if (ambiguous.length > 0) {
    throw new PanelizeError(`面 id 無法唯一定形：${ambiguous.map(({ face, ids }) => `${face}=[${ids.join(',')}]`).join('; ')}`);
  }

  const assignment = new Map([...candidates].map(([face, ids]) => [face, [...ids][0]!]));
  if (new Set(assignment.values()).size !== panelIds.size || assignment.size !== panelIds.size) {
    throw new PanelizeError('tag 傳播未形成 face 與 panel id 的一對一對應');
  }
  for (const constraint of allConstraints) {
    const actual = new Set([
      assignment.get(constraint.faceA)!,
      assignment.get(constraint.faceB)!,
    ]);
    if (!sameSet(actual, new Set([constraint.firstId, constraint.secondId]))) {
      throw new PanelizeError(`fold boundary「${constraint.tag}」的面配對與 role 不一致`);
    }
  }
  return assignment;
}

function validateClosureAssignments(
  boundaries: ClosureBoundaryGroup[],
  assignment: Map<number, string>,
): void {
  for (const boundary of boundaries) {
    const owners = new Set([
      assignment.get(boundary.faceA),
      assignment.get(boundary.faceB),
    ]);
    if (
      owners.has(undefined)
      || !sameSet(
        owners as Set<string>,
        new Set([boundary.ownerAId, boundary.ownerBId]),
      )
    ) {
      throw new PanelizeError(
        `closure boundary「${boundary.tag}」的面配對與 owner 不一致`,
      );
    }
  }
}

function canonicalPolygon(polygon: Pt[]): Pt[] {
  const points = polygon.map(cleanPoint);
  let start = 0;
  for (let index = 1; index < points.length; index++) {
    if (comparePoints(points[index]!, points[start]!) < 0) start = index;
  }
  return [...points.slice(start), ...points.slice(0, start)];
}

function horizontalIntersection(start: Pt, end: Pt, splitY: number): Pt {
  const ratio = (splitY - start.y) / (end.y - start.y);
  return { x: start.x + (end.x - start.x) * ratio, y: splitY };
}

function clipPolygonAtY(polygon: Pt[], splitY: number, keepAbove: boolean): Pt[] {
  const result: Pt[] = [];
  const inside = (point: Pt): boolean => keepAbove ? point.y <= splitY : point.y >= splitY;

  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index]!;
    const end = polygon[(index + 1) % polygon.length]!;
    const startInside = inside(start);
    const endInside = inside(end);

    if (startInside && endInside) {
      result.push(end);
    } else if (startInside) {
      result.push(horizontalIntersection(start, end, splitY));
    } else if (endInside) {
      result.push(horizontalIntersection(start, end, splitY), end);
    }
  }

  return canonicalPolygon(result);
}

function polygonCentroid(polygon: Pt[]): Pt {
  const total = polygon.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / polygon.length, y: total.y / polygon.length };
}

function canonicalCrease(candidates: CreaseCandidate[], childPolygon: Pt[]): { a: Pt; b: Pt } {
  const sorted = [...candidates].sort((first, second) => {
    const lengthDifference = second.length - first.length;
    if (Math.abs(lengthDifference) > GEOMETRY_TOLERANCE_MM) return lengthDifference;
    const [firstMin, firstMax] = orderedEndpoints(first.a, first.b);
    const [secondMin, secondMax] = orderedEndpoints(second.a, second.b);
    return comparePoints(firstMin, secondMin) || comparePoints(firstMax, secondMax) || first.pathId.localeCompare(second.pathId);
  });
  let { a, b } = sorted[0]!;
  a = cleanPoint(a);
  b = cleanPoint(b);
  const child = polygonCentroid(childPolygon);
  const side = (b.x - a.x) * (child.y - a.y) - (b.y - a.y) * (child.x - a.x);
  if (Math.abs(side) <= GEOMETRY_TOLERANCE_MM) {
    throw new PanelizeError('child 質心落在 hinge 軸上，無法正規化 a→b 方向');
  }
  if (side < 0) [a, b] = [b, a];
  return { a, b };
}

function buildSeams(
  graph: FaceGraph,
  faceAssignments: Map<number, string>,
): SeamSegment[] {
  const seams: SeamSegment[] = [];
  for (const adjacency of graph.adjacency) {
    const owners = [adjacency.faceA, adjacency.faceB]
      .map((face) => faceAssignments.get(face))
      .filter((owner): owner is string => owner !== undefined);
    if (owners.length !== 2) continue;
    for (const edge of adjacency.sharedEdges.filter(({ kind }) => kind === 'cut')) {
      // 非軸 shared cut 是已切開的兩片紙邊；兩份各隨 owner 摺開分離是正確物理。
      for (const ownerPanelId of owners) {
        seams.push({
          points: [cleanPoint(edge.a), cleanPoint(edge.b)],
          ownerPanelId,
          sourcePathId: edge.pathId,
        });
      }
    }
  }
  for (const cut of graph.danglingCuts) {
    const ownerPanelId = faceAssignments.get(cut.containingFace);
    if (ownerPanelId === undefined) continue;
    seams.push({
      points: [cleanPoint(cut.a), cleanPoint(cut.b)],
      ownerPanelId,
      sourcePathId: cut.pathId,
    });
  }
  return seams.sort((first, second) =>
    first.sourcePathId.localeCompare(second.sourcePathId)
    || comparePoints(first.points[0]!, second.points[0]!)
    || comparePoints(first.points[1]!, second.points[1]!)
    || first.ownerPanelId.localeCompare(second.ownerPanelId));
}

export function assertBoxInvariants(
  box: BoxModule,
  params: ResolvedParams,
  result: GenerateResult,
): void {
  for (const invariant of box.invariants) {
    const outcome = invariant.check(params, result);
    if (!outcome.ok && (invariant.severity ?? 'error') === 'error') {
      throw new InvalidBoxParamsError(invariant.id, outcome.message.zh);
    }
  }
}

export function panelizeFoldModel(
  result: GenerateResult,
  rootId: string,
  angles: PanelAngleSpec[],
  steps: FoldStep[],
  tolMm = ARC_TOLERANCE_MM,
  foldOnlyInactive: FoldOnlyInactiveSegments = new Map(),
  options: PanelizeOptions = {},
): FoldModel {
  const {
    roleFragmentToleranceMm = 0,
    maxUnassignedFaceAreaMm2 = MAX_UNASSIGNED_FACE_AREA_MM2,
    ignoreAmbiguousDanglingCuts = false,
  } = options;
  if (!Number.isFinite(roleFragmentToleranceMm) || roleFragmentToleranceMm < 0) {
    throw new PanelizeError('roleFragmentToleranceMm 必須是非負有限數');
  }
  if (!Number.isFinite(maxUnassignedFaceAreaMm2) || maxUnassignedFaceAreaMm2 <= 0) {
    throw new PanelizeError('maxUnassignedFaceAreaMm2 必須是正有限數');
  }
  const {
    inputs,
    rolesByPathId,
    closureBoundariesByPathId,
    creaseCandidatesByPathId,
  } = activeGeometry(result, tolMm, foldOnlyInactive);
  const ids = expectedPanelIds(rolesByPathId.values(), rootId);
  const anglesById = validateAngles(angles, ids, rootId);
  const parentByChild = validateRoleTree(rolesByPathId.values(), ids, rootId);
  const graph = extractFaces(inputs, undefined, ignoreAmbiguousDanglingCuts);
  const groups = groupRoles(
    graph,
    rolesByPathId,
    creaseCandidatesByPathId,
    roleFragmentToleranceMm,
  );
  const closureBoundaries = groupClosureBoundaries(graph, closureBoundariesByPathId);
  const faceAssignments = assignFaces(
    graph,
    groups,
    ids,
    maxUnassignedFaceAreaMm2,
  );
  validateClosureAssignments(closureBoundaries, faceAssignments);
  const faceByPanelId = new Map([...faceAssignments].map(([face, panelId]) => [panelId, face]));
  const groupByChildId = new Map(groups.map((group) => [group.childId, group]));

  const panels: FoldPanel[] = angles.map((angle) => {
    const face = faceByPanelId.get(angle.id)!;
    const polygon = canonicalPolygon(graph.faces[face]!.outline);
    if (angle.id === rootId) {
      return { id: angle.id, polygon, parent: null, foldAngle: angle.foldAngle, liftOffset: angle.liftOffset };
    }
    const group = groupByChildId.get(angle.id);
    if (!group) throw new PanelizeError(`panel「${angle.id}」缺少 hinge group`);
    return {
      id: angle.id,
      polygon,
      parent: parentByChild.get(angle.id)!,
      hingeLine: canonicalCrease(group.candidates, polygon),
      hingeSourceCreaseIds: [...group.sourcePathIds],
      foldAngle: anglesById.get(angle.id)!.foldAngle,
      liftOffset: angle.liftOffset,
    };
  });

  return {
    panels,
    steps: steps.map((step) => ({ ...step, panelIds: [...step.panelIds] })),
    dieline: copyDieline(result),
    seams: buildSeams(graph, faceAssignments),
  };
}

/** Fold-only post-process: split one derived panel without changing the 2D generator. */
export function splitFoldPanelHorizontally(
  model: FoldModel,
  spec: HorizontalPanelSplitSpec,
): FoldModel {
  const sourcePanel = model.panels.find(({ id }) => id === spec.panelId);
  const childPanel = model.panels.find(({ id }) => id === spec.reparentChildId);
  if (!sourcePanel || !childPanel) {
    throw new PanelizeError(
      `horizontal split 找不到 panel「${spec.panelId}」或 child「${spec.reparentChildId}」`,
    );
  }
  // 單一 child 契約：本 helper 只重掛 reparentChildId。被切 panel 若另有 child，
  // 其 hinge 可能落在 lip 區而被靜默留在主體上，故 fail-loud 擋掉非預期樹形。
  if (childPanel.parent !== spec.panelId) {
    throw new PanelizeError(
      `horizontal split child「${spec.reparentChildId}」的 parent 不是「${spec.panelId}」`,
    );
  }
  const otherChildren = model.panels.filter(
    (panel) => panel.parent === spec.panelId && panel.id !== spec.reparentChildId,
  );
  if (otherChildren.length > 0) {
    throw new PanelizeError(
      `horizontal split「${spec.panelId}」有未支援的其他 child：${otherChildren.map(({ id }) => id).join(',')}`,
    );
  }

  const sourcePolygon = clipPolygonAtY(sourcePanel.polygon, spec.splitY, true);
  const newPolygon = clipPolygonAtY(sourcePanel.polygon, spec.splitY, false);
  const hingePoints = newPolygon
    .filter(({ y }) => y === spec.splitY)
    .sort((first, second) => first.x - second.x);
  const hingeStart = hingePoints[0];
  const hingeEnd = hingePoints[hingePoints.length - 1];
  if (
    !hingeStart
    || !hingeEnd
    || Math.hypot(hingeEnd.x - hingeStart.x, hingeEnd.y - hingeStart.y) <= GEOMETRY_TOLERANCE_MM
  ) {
    throw new PanelizeError(`horizontal split「${spec.panelId}」沒有形成有效 hinge`);
  }

  const splitPanel: FoldPanel = {
    id: spec.newPanelId,
    polygon: newPolygon,
    parent: spec.panelId,
    hingeLine: { a: hingeStart, b: hingeEnd, virtual: true },
    foldAngle: spec.foldAngle,
  };
  const panels = model.panels.flatMap((panel) => {
    if (panel.id === spec.panelId) return [{ ...panel, polygon: sourcePolygon }, splitPanel];
    if (panel.id === spec.reparentChildId) return [{ ...panel, parent: spec.newPanelId }];
    return [panel];
  });
  const seams = model.seams?.map((seam) => {
    const belongsToSplitPanel = seam.ownerPanelId === spec.panelId
      && seam.points.every(({ y }) => y >= spec.splitY - GEOMETRY_TOLERANCE_MM)
      && seam.points.some(({ y }) => y > spec.splitY + GEOMETRY_TOLERANCE_MM);
    return belongsToSplitPanel ? { ...seam, ownerPanelId: spec.newPanelId } : seam;
  });

  return { ...model, panels, seams };
}

/** 貼合容差：與 hull 邊共面的 panel（翼躺側面）外距≈0±噪音，收剪保留 ≤0.01mm。 */
const CLAMP_CONTACT_TOLERANCE_MM = 0.01;
/** 收束位移比例上限（相對 t=1 世界外距）：edge-on panel（剖面投影成線，如
 * WingBottom）的面內最短修正路徑會爆炸——實測外距 2.385mm 需 60mm 面內剪移，
 * 收完仍在殼內但形狀全毀（掃掠中段肉眼可見翼歪斜）。超過上限＝面內收束
 * 不成比例，改走面外彎入（normalOffset）。 */
const CLAMP_DISPLACEMENT_RATIO_CAP = 3;
/** 面外彎入上限：紙角受擠微彎的合理量級（實測 WingBottom 需 ~2.39mm）。
 * 超過＝此收束 spec 對該盒型不適用，fail-loud。 */
const CLAMP_NORMAL_OFFSET_CAP_MM = 3;

export interface BodyHullClampSpec {
  /** 定義盒體剖面凸包的 panel（如 faceA/faceB/faceC）。 */
  bodyPanelIds: readonly string[];
  /** 要收束的 panel（如端封件家族）。 */
  targetPanelIds: readonly string[];
}

/** Fold-only post-process：計算 target panels 越界頂點的收束目標（vertexClamp），
 * 使 t=1 摺合後不超出 body panels 的剖面 (y,z) 凸包。polygon 本身不動——攤平=
 * 真刀模不變式保留；worldGeometry 依摺疊完成度把頂點 lerp 到 target，
 * ＝刀模 friction-fit 補償材料在 3D 摺合時「壓進」盒體輪廓的零厚度近似。 */
export function clampFoldPanelsToBodyHull(model: FoldModel, spec: BodyHullClampSpec): FoldModel {
  const pose = foldPose(1, model);
  const bodyPoints: [number, number][] = spec.bodyPanelIds.flatMap((id) => {
    const panel = model.panels.find((candidate) => candidate.id === id);
    if (!panel) throw new PanelizeError(`body hull clamp 找不到 panel「${id}」`);
    const transform = panelWorldTransform(model, pose, id);
    return panel.polygon.map((point) => {
      const world = applyTransform(transform, { x: point.x, y: point.y, z: 0 });
      return [world.y, world.z] as [number, number];
    });
  });

  // Andrew monotone chain 凸包（逆時針）
  const sorted = [...bodyPoints].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const halfHull = (input: [number, number][]) => {
    const out: [number, number][] = [];
    for (const point of input) {
      while (out.length >= 2) {
        const [o, q] = [out[out.length - 2]!, out[out.length - 1]!];
        if ((q[0] - o[0]) * (point[1] - o[1]) - (q[1] - o[1]) * (point[0] - o[0]) <= 0) out.pop();
        else break;
      }
      out.push(point);
    }
    return out;
  };
  const lower = halfHull(sorted);
  const upper = halfHull([...sorted].reverse());
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];

  const panels = model.panels.map((panel) => {
    if (!spec.targetPanelIds.includes(panel.id)) return panel;
    const transform = panelWorldTransform(model, pose, panel.id);

    // 每條 hull 邊的「有號外距」＝2D panel 座標的仿射泛函 f(p)=α·px+β·py+γ
    // （逆時針凸包外側為正·單位=世界 mm）：以三個基準點求係數。
    const functionals = hull.map((a, i) => {
      const b = hull[(i + 1) % hull.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const outsideAt = (px: number, py: number, pz = 0): number => {
        const world = applyTransform(transform, { x: px, y: py, z: pz });
        const crossV = (b[0] - a[0]) * (world.z - a[1]) - (b[1] - a[1]) * (world.y - a[0]);
        return -crossV / len;
      };
      const gamma = outsideAt(0, 0);
      return {
        alpha: outsideAt(1, 0) - gamma,
        beta: outsideAt(0, 1) - gamma,
        zeta: outsideAt(0, 0, 1) - gamma,
        gamma,
      };
    });

    const clamp: { index: number; target: Pt; normalOffset?: number }[] = [];
    panel.polygon.forEach((point, index) => {
      const evaluate = (p: Pt, pz = 0) =>
        functionals.map(({ alpha, beta, zeta, gamma }) => alpha * p.x + beta * p.y + zeta * pz + gamma);
      const initialOutside = Math.max(...evaluate(point));
      if (initialOutside <= CLAMP_CONTACT_TOLERANCE_MM) return;

      // 逐約束投影（affine level-set 投影·迭代收斂多約束角點）
      let target: Pt = { x: point.x, y: point.y };
      for (let round = 0; round < 4; round += 1) {
        functionals.forEach(({ alpha, beta, gamma }) => {
          const value = alpha * target.x + beta * target.y + gamma;
          const gradSq = alpha * alpha + beta * beta;
          if (value <= CLAMP_CONTACT_TOLERANCE_MM || gradSq < 1e-12) return;
          target = { x: target.x - (value * alpha) / gradSq, y: target.y - (value * beta) / gradSq };
        });
      }
      const displacement = Math.hypot(target.x - point.x, target.y - point.y);

      // 面內收束不成比例（edge-on：剖面投影成線·面內移動幾乎不減外距）→
      // 改走面外彎入：沿 panel 局部 z 解 1D 投影（紙角受擠微彎的零厚度近似）。
      if (displacement > initialOutside * CLAMP_DISPLACEMENT_RATIO_CAP) {
        let normalOffset = 0;
        for (let round = 0; round < 4; round += 1) {
          functionals.forEach(({ alpha, beta, zeta, gamma }) => {
            const value = alpha * point.x + beta * point.y + zeta * normalOffset + gamma;
            if (value <= CLAMP_CONTACT_TOLERANCE_MM || Math.abs(zeta) < 1e-6) return;
            normalOffset -= value / zeta;
          });
        }
        if (
          Math.abs(normalOffset) > CLAMP_NORMAL_OFFSET_CAP_MM
          || evaluate(point, normalOffset).some((v) => v > CLAMP_CONTACT_TOLERANCE_MM * 2)
        ) {
          throw new PanelizeError(
            `body hull clamp 無法收束 panel「${panel.id}」頂點 ${index}：面內位移 ${displacement.toFixed(1)}mm 不成比例、面外彎入 ${normalOffset.toFixed(1)}mm 超限或無解`,
          );
        }
        clamp.push({ index, target: { x: point.x, y: point.y }, normalOffset });
        return;
      }

      if (evaluate(target).some((v) => v > CLAMP_CONTACT_TOLERANCE_MM * 2)) {
        throw new PanelizeError(`body hull clamp 無法把 panel「${panel.id}」頂點 ${index} 投影進盒體輪廓`);
      }
      clamp.push({ index, target });
    });

    return clamp.length === 0 ? panel : { ...panel, vertexClamp: clamp };
  });

  return { ...model, panels };
}
