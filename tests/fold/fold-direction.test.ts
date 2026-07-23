import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import {
  applyTransform,
  panelWorldTransform,
  type Vec3,
} from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldPanel, Pt } from '@/fold/types';

type AngleKind = 'π' | 'π/2' | '餘弦角';

interface DirectionCase {
  label: string;
  params: ResolvedParams;
  build: (params: ResolvedParams) => FoldModel;
  expectedKinds: AngleKind[];
}

const NORMAL_TOLERANCE = 1e-8;
const SABOTAGE_MINIMUM_GAP = 1e-3;

const CASES: readonly DirectionCase[] = [
  {
    label: 'rte/預設',
    params: resolveParams(reverseTuckEnd),
    build: buildRteFoldModel,
    expectedKinds: ['π/2'],
  },
  {
    label: 'ttsl/左糊邊×最大紙厚',
    params: resolveParams(tuckTopSnapLock, { glueSide: 'left', thickness: 0.8 }),
    build: buildTtslFoldModel,
    expectedKinds: ['π/2'],
  },
  {
    label: 'ttsl/右糊邊×最大紙厚',
    params: resolveParams(tuckTopSnapLock, { glueSide: 'right', thickness: 0.8 }),
    build: buildTtslFoldModel,
    expectedKinds: ['π/2'],
  },
  {
    label: 'ttb/預設',
    params: resolveParams(triangularTube),
    build: buildTtbFoldModel,
    expectedKinds: ['π/2', '餘弦角'],
  },
];

function subtract(first: Vec3, second: Vec3): Vec3 {
  return { x: first.x - second.x, y: first.y - second.y, z: first.z - second.z };
}

function add(first: Vec3, second: Vec3): Vec3 {
  return { x: first.x + second.x, y: first.y + second.y, z: first.z + second.z };
}

function scale(vector: Vec3, amount: number): Vec3 {
  return { x: vector.x * amount, y: vector.y * amount, z: vector.z * amount };
}

function dot(first: Vec3, second: Vec3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function cross(first: Vec3, second: Vec3): Vec3 {
  return {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vec3): Vec3 {
  return scale(vector, 1 / length(vector));
}

function centroid(polygon: Pt[]): Pt {
  return polygon.reduce(
    (sum, point) => ({
      x: sum.x + point.x / polygon.length,
      y: sum.y + point.y / polygon.length,
    }),
    { x: 0, y: 0 },
  );
}

function rotateAroundAxis(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(
    add(scale(vector, cosine), scale(cross(axis, vector), sine)),
    scale(axis, dot(axis, vector) * (1 - cosine)),
  );
}

function angleKind(panel: FoldPanel): AngleKind {
  const magnitude = Math.abs(panel.foldAngle);
  if (Math.abs(magnitude - Math.PI) < 1e-10) return 'π';
  if (Math.abs(magnitude - Math.PI / 2) < 1e-10) return 'π/2';
  return '餘弦角';
}

function activeMidpoint(model: FoldModel, panelId: string): number {
  const step = model.steps.find(({ panelIds }) => panelIds.includes(panelId));
  if (step === undefined) throw new Error(`panel「${panelId}」缺少 fold step`);
  return (step.t0 + step.t1) / 2;
}

function worldNormal(model: FoldModel, t: number, panelId: string): Vec3 {
  const transform = panelWorldTransform(model, foldPose(t, model), panelId);
  const origin = applyTransform(transform, { x: 0, y: 0, z: 0 });
  const tip = applyTransform(transform, { x: 0, y: 0, z: 1 });
  return normalize(subtract(tip, origin));
}

function directionError(expected: FoldModel, actual: FoldModel, panelId: string, t: number): number {
  const expectedPanel = expected.panels.find(({ id }) => id === panelId)!;
  const pose = foldPose(t, expected);
  const parentTransform = panelWorldTransform(expected, pose, expectedPanel.parent!);
  const hingeStart = applyTransform(parentTransform, { ...expectedPanel.hingeLine!.a, z: 0 });
  const hingeEnd = applyTransform(parentTransform, { ...expectedPanel.hingeLine!.b, z: 0 });
  const axis = normalize(subtract(hingeEnd, hingeStart));
  const parentNormal = worldNormal(expected, t, expectedPanel.parent!);
  const expectedAngle = pose.get(panelId)!;
  const expectedNormal = rotateAroundAxis(parentNormal, axis, expectedAngle);
  const flatCentroid = applyTransform(parentTransform, { ...centroid(expectedPanel.polygon), z: 0 });
  const expectedCentroid = add(
    hingeStart,
    rotateAroundAxis(subtract(flatCentroid, hingeStart), axis, expectedAngle),
  );
  const actualTransform = panelWorldTransform(actual, foldPose(t, actual), panelId);
  const actualCentroid = applyTransform(actualTransform, { ...centroid(expectedPanel.polygon), z: 0 });
  return Math.max(
    length(subtract(worldNormal(actual, t, panelId), expectedNormal)),
    length(subtract(actualCentroid, expectedCentroid)),
  );
}

function cloneModel(model: FoldModel): FoldModel {
  return {
    panels: model.panels.map((panel) => ({
      ...panel,
      polygon: panel.polygon.map((point) => ({ ...point })),
      hingeLine: panel.hingeLine === undefined
        ? undefined
        : {
            a: { ...panel.hingeLine.a },
            b: { ...panel.hingeLine.b },
            virtual: panel.hingeLine.virtual,
          },
      hingeSourceCreaseIds: panel.hingeSourceCreaseIds === undefined
        ? undefined
        : [...panel.hingeSourceCreaseIds],
    })),
    steps: model.steps.map((step) => ({ ...step, panelIds: [...step.panelIds] })),
    dieline: model.dieline.map((path) => ({
      ...path,
      segments: path.segments.map((segment) => ({ ...segment })),
    })),
    seams: model.seams?.map((seam) => ({
      ...seam,
      points: seam.points.map((point) => ({ ...point })),
    })),
  };
}

function reverseHinge(model: FoldModel, panelId: string): FoldModel {
  const sabotaged = cloneModel(model);
  const panel = sabotaged.panels.find(({ id }) => id === panelId)!;
  panel.hingeLine = { a: panel.hingeLine!.b, b: panel.hingeLine!.a };
  return sabotaged;
}

function flipSign(model: FoldModel, panelId: string): FoldModel {
  const sabotaged = cloneModel(model);
  const panel = sabotaged.panels.find(({ id }) => id === panelId)!;
  panel.foldAngle *= -1;
  return sabotaged;
}

function targetsByKind(model: FoldModel): Map<AngleKind, FoldPanel[]> {
  const result = new Map<AngleKind, FoldPanel[]>();
  for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
    const kind = angleKind(panel);
    const targets = result.get(kind) ?? [];
    targets.push(panel);
    result.set(kind, targets);
  }
  return result;
}

describe('摺向 sabotage 覆蓋矩陣', () => {
  for (const testCase of CASES) {
    const baseline = testCase.build(testCase.params);
    const byKind = targetsByKind(baseline);

    it(`${testCase.label} 摺角類型完整`, () => {
      expect([...byKind.keys()].sort()).toEqual([...testCase.expectedKinds].sort());
    });

    for (const [kind, panels] of byKind) {
      it(`${testCase.label}/${kind} 正常：各 step 中段與 t=1 面法向正確`, () => {
        for (const panel of panels) {
          expect(directionError(baseline, baseline, panel.id, activeMidpoint(baseline, panel.id)), panel.id)
            .toBeLessThan(NORMAL_TOLERANCE);
          expect(directionError(baseline, baseline, panel.id, 1), panel.id)
            .toBeLessThan(NORMAL_TOLERANCE);
        }
      });

      it(`${testCase.label}/${kind} hinge 反轉：中段必被抓，t=1 依角度等價性判定`, () => {
        for (const panel of panels) {
          const sabotaged = reverseHinge(baseline, panel.id);
          expect(
            directionError(baseline, sabotaged, panel.id, activeMidpoint(baseline, panel.id)),
            panel.id,
          ).toBeGreaterThan(SABOTAGE_MINIMUM_GAP);
          const finalError = directionError(baseline, sabotaged, panel.id, 1);
          if (kind === 'π') {
            expect(finalError, `${panel.id} 的 ±π 終點等價`).toBeLessThan(NORMAL_TOLERANCE);
          } else {
            expect(finalError, panel.id).toBeGreaterThan(SABOTAGE_MINIMUM_GAP);
          }
        }
      });

      it(`${testCase.label}/${kind} 符號翻轉：中段必被抓，t=1 依角度等價性判定`, () => {
        for (const panel of panels) {
          const sabotaged = flipSign(baseline, panel.id);
          expect(
            directionError(baseline, sabotaged, panel.id, activeMidpoint(baseline, panel.id)),
            panel.id,
          ).toBeGreaterThan(SABOTAGE_MINIMUM_GAP);
          const finalError = directionError(baseline, sabotaged, panel.id, 1);
          if (kind === 'π') {
            expect(finalError, `${panel.id} 的 ±π 終點等價`).toBeLessThan(NORMAL_TOLERANCE);
          } else {
            expect(finalError, panel.id).toBeGreaterThan(SABOTAGE_MINIMUM_GAP);
          }
        }
      });
    }
  }

  it('zoneDLip 與 zoneDTab 合成 -π，重疊判別窗中點依序位於 0.7 與 0.715', () => {
    const baseline = buildTtbFoldModel(resolveParams(triangularTube));
    const lip = baseline.panels.find(({ id }) => id === 'zoneDLip')!;
    const tab = baseline.panels.find(({ id }) => id === 'zoneDTab')!;

    expect(lip.foldAngle + tab.foldAngle).toBeCloseTo(-Math.PI, 12);
    expect(activeMidpoint(baseline, 'zoneDLip')).toBeCloseTo(0.7, 12);
    expect(activeMidpoint(baseline, 'zoneDTab')).toBeCloseTo(0.715, 12);
  });
});
