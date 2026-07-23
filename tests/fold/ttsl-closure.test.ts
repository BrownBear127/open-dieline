// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import { applyTransform, panelWorldTransform, worldGeometry, type Vec3 } from '@/fold/pose3d';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import { foldPose } from '@/fold/schedule';
import { CLOSURE_TOLERANCE_MM, type FoldModel, type FoldPanel, type Pt } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

const CLOSURE_MATRIX = [
  { thickness: 0, glueSide: 'left' },
  { thickness: 0, glueSide: 'right' },
  { thickness: 0.3, glueSide: 'left' },
  { thickness: 0.3, glueSide: 'right' },
  { thickness: 0.8, glueSide: 'left' },
  { thickness: 0.8, glueSide: 'right' },
] as const;

const BOTTOM_PANEL_IDS = ['bottomLockP1', 'bottomWebP2', 'bottomReceiveP3', 'bottomWebP4'];

function panel(model: FoldModel, id: string): FoldPanel {
  const result = model.panels.find((candidate) => candidate.id === id);
  expect(result, `missing panel ${id}`).toBeDefined();
  return result!;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  expect(length).toBeGreaterThan(0);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function expectFinite(model: FoldModel, progress: number): void {
  const geometry = worldGeometry(model, foldPose(progress, model));
  for (const [id, vertices] of geometry) {
    expect(vertices.every(({ x, y, z }) => [x, y, z].every(Number.isFinite)), id).toBe(true);
  }
}

function transformPoints(model: FoldModel, panelId: string, points: Pt[]): Vec3[] {
  const pose = foldPose(1, model);
  const transform = panelWorldTransform(model, pose, panelId);
  return points.map(({ x, y }) => applyTransform(transform, { x, y, z: 0 }));
}

function projectedInterval(points: Vec3[], origin: Vec3, axis: Vec3): { min: number; max: number } {
  const values = points.map((point) => dot(subtract(point, origin), axis));
  return { min: Math.min(...values), max: Math.max(...values) };
}

function snapLockFeatures(model: FoldModel, receiveDepth: number): {
  tip: { min: number; max: number };
  notch: { min: number; max: number };
  tipDepth: number;
  notchDepth: number;
} {
  const lock = panel(model, 'bottomLockP1');
  const receive = panel(model, 'bottomReceiveP3');
  const maxLockY = Math.max(...lock.polygon.map(({ y }) => y));
  const maxReceiveY = Math.max(...receive.polygon.map(({ y }) => y));
  const tipLocal = lock.polygon.filter(({ y }) => Math.abs(y - maxLockY) < 1e-6);
  const notchLocal = receive.polygon.filter(({ y }) => Math.abs(y - (maxReceiveY - receiveDepth)) < 1e-6);
  expect(tipLocal.length).toBeGreaterThanOrEqual(2);
  expect(notchLocal.length).toBeGreaterThanOrEqual(2);

  const pose = foldPose(1, model);
  const lockHinge = lock.hingeLine!;
  const lockParentTransform = panelWorldTransform(model, pose, lock.parent!);
  const origin = applyTransform(lockParentTransform, { ...lockHinge.a, z: 0 });
  const lockAxisEnd = applyTransform(lockParentTransform, { ...lockHinge.b, z: 0 });
  const lengthAxis = normalize(subtract(lockAxisEnd, origin));

  const web = panel(model, 'bottomWebP2');
  const webParentTransform = panelWorldTransform(model, pose, web.parent!);
  const widthStart = applyTransform(webParentTransform, { ...web.hingeLine!.a, z: 0 });
  const widthEnd = applyTransform(webParentTransform, { ...web.hingeLine!.b, z: 0 });
  const widthAxis = normalize(subtract(widthEnd, widthStart));
  const tipWorld = transformPoints(model, lock.id, tipLocal);
  const notchWorld = transformPoints(model, receive.id, notchLocal);

  return {
    tip: projectedInterval(tipWorld, origin, lengthAxis),
    notch: projectedInterval(notchWorld, origin, lengthAxis),
    tipDepth: Math.abs(dot(subtract(tipWorld[0]!, origin), widthAxis)),
    notchDepth: Math.abs(dot(subtract(notchWorld[0]!, origin), widthAxis)),
  };
}

describe('TTSL world-space closure matrix — compensated derived geometry', () => {
  for (const { thickness, glueSide } of CLOSURE_MATRIX) {
    it(`thickness=${thickness}, glueSide=${glueSide}: t=0/0.5/1 stays finite and top/base panels close on their planes`, () => {
      const params = resolveParams(tuckTopSnapLock, { thickness, glueSide });
      const model = buildTtslFoldModel(params);
      expect(validateFoldModel(model)).toEqual([]);
      for (const progress of [0, 0.5, 1]) expectFinite(model, progress);

      const flat = worldGeometry(model, foldPose(0, model));
      for (const target of model.panels) {
        expect(flat.get(target.id)).toEqual(target.polygon.map(({ x, y }) => ({ x, y, z: 0 })));
      }

      const folded = worldGeometry(model, foldPose(1, model));
      expect(folded.get('topLid')!.every(({ y }) => Math.abs(y) < CLOSURE_TOLERANCE_MM)).toBe(true);
      for (const id of BOTTOM_PANEL_IDS) {
        const vertices = folded.get(id)!;
        const planeY = vertices[0]!.y;
        expect(vertices.every(({ y }) => Math.abs(y - planeY) < CLOSURE_TOLERANCE_MM), id).toBe(true);
      }
      expect(model.panels.some(({ id }) => /^bottomReceiveP3\./.test(id))).toBe(false);
    });
  }
});

describe('TTSL t=1 snap-lock engagement from the single receiving panel', () => {
  for (const overrides of [
    {},
    { glueSide: 'right' },
    { L: 120, W: 80, D: 90 },
    { L: 60, W: 40, D: 45, glueSide: 'right' },
  ]) {
    it(`${JSON.stringify(overrides)}: lock tip interval is contained by the receiving notch and reaches deeper`, () => {
      const params = resolveParams(tuckTopSnapLock, overrides);
      const model = buildTtslFoldModel(params);
      const feature = snapLockFeatures(model, params.lockReceiveDepth as number);

      expect(feature.tip.min).toBeGreaterThan(feature.notch.min);
      expect(feature.tip.max).toBeLessThan(feature.notch.max);
      expect(feature.tipDepth).toBeGreaterThan(feature.notchDepth);
    });
  }
});
