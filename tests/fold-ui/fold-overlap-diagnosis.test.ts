import { Vector2 } from 'three';
import { expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel } from '@/fold/types';
import { diagnoseFoldedPanelFaces } from '@/ui/fold-scene';

const EPSILON = 1e-7;

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
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

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function polygonNormal(vertices: Vec3[]): Vec3 {
  for (let index = 1; index < vertices.length - 1; index += 1) {
    const normal = cross(
      subtract(vertices[index]!, vertices[0]!),
      subtract(vertices[index + 1]!, vertices[0]!),
    );
    if (Math.hypot(normal.x, normal.y, normal.z) > EPSILON) return normalize(normal);
  }
  throw new Error('degenerate polygon');
}

function signedArea(points: Vector2[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    sum += points[index]!.x * points[next]!.y - points[next]!.x * points[index]!.y;
  }
  return sum / 2;
}

function lineIntersection(start: Vector2, end: Vector2, clipStart: Vector2, clipEnd: Vector2): Vector2 {
  const ray = end.clone().sub(start);
  const edge = clipEnd.clone().sub(clipStart);
  const denominator = ray.x * edge.y - ray.y * edge.x;
  const relative = clipStart.clone().sub(start);
  const t = (relative.x * edge.y - relative.y * edge.x) / denominator;
  return start.clone().add(ray.multiplyScalar(t));
}

function clipConvex(subject: Vector2[], rawClip: Vector2[]): Vector2[] {
  const clip = signedArea(rawClip) < 0 ? [...rawClip].reverse() : rawClip;
  let output = subject;

  for (let index = 0; index < clip.length; index += 1) {
    const clipStart = clip[index]!;
    const clipEnd = clip[(index + 1) % clip.length]!;
    const input = output;
    output = [];
    if (input.length === 0) break;

    const inside = (point: Vector2): boolean => {
      const edgeX = clipEnd.x - clipStart.x;
      const edgeY = clipEnd.y - clipStart.y;
      return edgeX * (point.y - clipStart.y) - edgeY * (point.x - clipStart.x) >= -EPSILON;
    };

    for (let subjectIndex = 0; subjectIndex < input.length; subjectIndex += 1) {
      const start = input[subjectIndex]!;
      const end = input[(subjectIndex + 1) % input.length]!;
      const startInside = inside(start);
      const endInside = inside(end);
      if (startInside && endInside) {
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd));
      } else if (endInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd), end);
      }
    }
  }

  return output;
}

function triangles(points: Vector2[]): Vector2[][] {
  // Match panelGeometryPositions exactly: the renderer uses a fan, including its
  // tuck-lock wing footprint, so the diagnosis measures rendered overlap rather than
  // an idealized polygon triangulation.
  return points.slice(1, -1).map((point, index) => [points[0]!, point, points[index + 2]!]);
}

function overlapArea(first: Vec3[], second: Vec3[]): number {
  const origin = first[0]!;
  const normal = polygonNormal(first);
  const secondNormal = polygonNormal(second);
  if (Math.abs(dot(normal, secondNormal)) < 1 - EPSILON) return 0;
  if (second.some((vertex) => Math.abs(dot(subtract(vertex, origin), normal)) > EPSILON)) return 0;

  const uAxis = normalize(subtract(first[1]!, origin));
  const vAxis = cross(normal, uAxis);
  const project = (vertex: Vec3): Vector2 => {
    const relative = subtract(vertex, origin);
    return new Vector2(dot(relative, uAxis), dot(relative, vAxis));
  };
  const firstTriangles = triangles(first.map(project));
  const secondTriangles = triangles(second.map(project));

  return firstTriangles.reduce((total, firstTriangle) => total + secondTriangles.reduce(
    (subtotal, secondTriangle) => subtotal + Math.abs(signedArea(clipConvex(firstTriangle, secondTriangle))),
    0,
  ), 0);
}

function overlappingPairs(model: FoldModel): string[] {
  const geometry = worldGeometry(model, foldPose(1, model));
  const pairs: string[] = [];
  for (let firstIndex = 0; firstIndex < model.panels.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < model.panels.length; secondIndex += 1) {
      const firstId = model.panels[firstIndex]!.id;
      const secondId = model.panels[secondIndex]!.id;
      const area = overlapArea(geometry.get(firstId)!, geometry.get(secondId)!);
      if (area > EPSILON) pairs.push(`${firstId}/${secondId}`);
    }
  }
  return pairs;
}

it('enumerates every completed area overlap for the default sliced-lid model', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));

  expect(diagnoseFoldedPanelFaces(model)).toEqual(model.panels.map(({ id }) => ({
    panelId: id,
    exteriorFace: 'front',
  })));
  expect(overlappingPairs(model)).toEqual([
    'P1/topTuck',
    'P3/bottomTuck',
    'P4/glue',
    'topLidL/topDustP2',
    'topLidR/topDustP4',
    'bottomLidL/bottomDustP4',
    'bottomLidR/bottomDustP2',
  ]);
});

it('moves the glue overlap to P1 when the glue flap is on the right', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { glueSide: 'right' }));

  expect(overlappingPairs(model)).toEqual([
    'P1/glue',
    'P1/topTuck',
    'P3/bottomTuck',
    'glue/topTuck',
    'topLidL/topDustP2',
    'topLidR/topDustP4',
    'bottomLidL/bottomDustP4',
    'bottomLidR/bottomDustP2',
  ]);
});

it('enumerates both dust overlaps for each unsliced lid when tuckLock is disabled', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { tuckLock: 0 }));

  expect(overlappingPairs(model)).toEqual([
    'P1/topTuck',
    'P3/bottomTuck',
    'P4/glue',
    'topLid/topDustP2',
    'topLid/topDustP4',
    'bottomLid/bottomDustP2',
    'bottomLid/bottomDustP4',
  ]);
});
