import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { easings } from '@/fold/easings';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, FoldStep } from '@/fold/types';
import { TTB_LEGAL_COMBOS } from '../helpers/ttb-fold';

const EXPECTED_STEPS: FoldStep[] = [
  {
    panelIds: [
      'endStartWingTop',
      'endStartWingBottom',
      'endEndWingTop',
      'endEndWingBottom',
    ],
    t0: 0,
    t1: 0.22,
    ease: 'backIn',
  },
  { panelIds: ['endStartMain', 'endEndMain'], t0: 0.22, t1: 0.42, ease: 'powerInOut' },
  { panelIds: ['faceB', 'faceC'], t0: 0.42, t1: 0.72, ease: 'powerInOut' },
  { panelIds: ['zoneDBase'], t0: 0.55, t1: 0.9, ease: 'powerInOut' },
  { panelIds: ['zoneDLip'], t0: 0.55, t1: 0.85, ease: 'powerInOut' },
  { panelIds: ['zoneDTab'], t0: 0.58, t1: 0.85, ease: 'powerInOut' },
];

function model(): FoldModel {
  return buildTtbFoldModel(resolveParams(triangularTube));
}

const SWEEP_SAMPLE_TIMES = [0.75, 0.8, 0.85, 0.9] as const;
const ZONE_D_PANEL_IDS = ['zoneDBase', 'zoneDLip', 'zoneDTab'] as const;

function subtract(first: Vec3, second: Vec3): Vec3 {
  return { x: first.x - second.x, y: first.y - second.y, z: first.z - second.z };
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

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

interface InwardPlane { origin: Vec3; normal: Vec3 }

/**
 * 慣例層：hull 是 t=1 faceA/B/C 三個完成態面板的向內半空間交集；每個頂點只有在
 * 三個 signed distance 皆非負時才算進入，深度取到最近 hull 面的距離。
 */
function completedBodyHull(target: FoldModel): InwardPlane[] {
  const completed = worldGeometry(target, foldPose(1, target));
  const faces = ['faceA', 'faceB', 'faceC'].map((id) => completed.get(id)!);
  const interior = faces.flat().reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y, z: sum.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  const vertexCount = faces.reduce((sum, face) => sum + face.length, 0);
  interior.x /= vertexCount;
  interior.y /= vertexCount;
  interior.z /= vertexCount;

  return faces.map((face) => {
    const origin = face[0]!;
    let normal = normalize(cross(subtract(face[1]!, origin), subtract(face[face.length - 1]!, origin)));
    if (dot(subtract(interior, origin), normal) < 0) {
      normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    }
    return { origin, normal };
  });
}

function maximumHullPenetration(vertices: Vec3[], hull: InwardPlane[]): number {
  return Math.max(0, ...vertices.map((point) => {
    const distances = hull.map(({ origin, normal }) => dot(subtract(point, origin), normal));
    return distances.every((distance) => distance >= -1e-9) ? Math.max(0, Math.min(...distances)) : 0;
  }));
}

function sweepPenetrationTable(
  target: FoldModel,
): Record<(typeof ZONE_D_PANEL_IDS)[number], number[]> {
  const hull = completedBodyHull(target);
  return Object.fromEntries(ZONE_D_PANEL_IDS.map((panelId) => [
    panelId,
    SWEEP_SAMPLE_TIMES.map((time) => {
      const geometry = worldGeometry(target, foldPose(time, target));
      return maximumHullPenetration(geometry.get(panelId)!, hull);
    }),
  ])) as Record<(typeof ZONE_D_PANEL_IDS)[number], number[]>;
}

function expectStepProgress(
  target: FoldModel,
  time: number,
  step: FoldStep,
  progress: 0 | 0.5 | 1,
): void {
  const pose = foldPose(time, target);
  for (const panelId of step.panelIds) {
    const panel = target.panels.find(({ id }) => id === panelId)!;
    const expectedAngle = progress === 0
      ? 0
      : panel.foldAngle * easings[step.ease](progress);
    expect(pose.get(panelId), `${panelId} at t=${time}`).toBeCloseTo(expectedAngle, 12);
  }
}

// 觀測慣例層：掃掠漸進預彎（候選 C）schedule 在 default＋TTB_LEGAL_COMBOS、
// t={.75,.8,.85,.9} 的實測表。非零值為設計內行為：t=0.85/0.9 的 tab 深度
// ≈2.6mm 是入槽完成後的盒內深度；combo 4/6（edgeA 20 微型盒、tabDepth 30
// 長舌）的中段非零＝極端比例下預彎鉤提早入 hull（零厚度剛體簽名·與端蓋
// 懸出同族 park·真解=紙厚建模）。本表當回歸哨兵：變更後深度不得超出 +0.1mm。
const SWEEP_PRECURL_BASELINE_MM = [
  {
    zoneDBase: [0, 0, 0, 0],
    zoneDLip: [0, 0, 0, 5.062616992290714e-14],
    zoneDTab: [0, 0, 0, 2.6475781174074484],
  },
  {
    zoneDBase: [0, 0, 0, 0],
    zoneDLip: [0, 0, 0, 5.062616992290714e-14],
    zoneDTab: [0, 0, 0, 2.6475781174074484],
  },
  {
    zoneDBase: [0, 0, 0, 0],
    zoneDLip: [0, 0, 0, 9.947598300641403e-14],
    zoneDTab: [0, 0, 0, 2.635395281643315],
  },
  {
    zoneDBase: [0, 0, 3.552713678800501e-14, 2.90878432451791e-14],
    zoneDLip: [0, 0, 0, 0],
    zoneDTab: [0, 0, 0, 2.622777415463357],
  },
  {
    zoneDBase: [0, 0, 0, 1.7763568394002505e-15],
    zoneDLip: [0, 0, 0.5150810840490965, 1.5765166949677223e-14],
    zoneDTab: [2.4593961317531567, 3.280600947650866, 2.2745700679674936, 2.7308940999572195],
  },
  {
    zoneDBase: [3.552713678800501e-15, 0, 0, 0],
    zoneDLip: [0, 0, 0, 5.084821452783217e-14],
    zoneDTab: [0, 0, 0, 2.6475781174074524],
  },
  {
    zoneDBase: [3.552713678800501e-15, 0, 7.105427357601002e-15, 1.1324274851176597e-14],
    zoneDLip: [0, 0, 0.11068379766101089, 0],
    zoneDTab: [4.395210601746129, 4.783001686152488, 1.9243317561040492, 2.668975478712051],
  },
] satisfies Array<Record<(typeof ZONE_D_PANEL_IDS)[number], number[]>>;

describe('TTB fold schedule', () => {
  it('掃掠預彎不變式：zoneD 三 hinge 於掃掠段起彎、尾鉤（lip/tab）先於 base 收滿', () => {
    const steps = model().steps;

    expect(steps).toEqual(EXPECTED_STEPS);
    const sweep = steps.find((step) => step.panelIds.includes('faceC'))!;
    const [base, lip, tab] = steps.slice(-3);
    // 掃掠段捲入：三 hinge 皆在 faceB/faceC 窗內起彎（剛體直板根除）。
    expect(base!.t0).toBeGreaterThanOrEqual(sweep.t0);
    expect(base!.t0).toBeLessThan(sweep.t1);
    expect(lip!.t0).toBeLessThan(sweep.t1);
    expect(tab!.t0).toBeLessThan(sweep.t1);
    // 尾鉤早收滿：半開的鉤在 base 收攏中段會掃穿盒底，lip/tab 須先於 base 到位。
    expect(lip!.t0).toBeLessThanOrEqual(tab!.t0);
    expect(lip!.t1).toBeLessThanOrEqual(base!.t1);
    expect(tab!.t1).toBeLessThanOrEqual(base!.t1);
    expect(base!.t1).toBeLessThanOrEqual(0.9);
  });

  it('基線量測：default＋TTB_LEGAL_COMBOS 的 zoneD 家族中段 hull 內側深度', () => {
    const measured = TTB_LEGAL_COMBOS.map((overrides) =>
      sweepPenetrationTable(buildTtbFoldModel(resolveParams(triangularTube, overrides))));

    expect(measured).toHaveLength(SWEEP_PRECURL_BASELINE_MM.length);
    measured.forEach((table, comboIndex) => {
      ZONE_D_PANEL_IDS.forEach((panelId) => {
        table[panelId].forEach((depth, timeIndex) => {
          const baseline = SWEEP_PRECURL_BASELINE_MM[comboIndex]![panelId][timeIndex]!;
          expect(
            depth,
            `combo=${comboIndex} panel=${panelId} t=${SWEEP_SAMPLE_TIMES[timeIndex]} baseline=${baseline}`,
          ).toBeLessThanOrEqual(baseline + 0.1);
        });
      });
    });
  });

  it('每個 step 在自己的 t0/t1 邊界精確落在 0/全值，不受窗口重疊影響', () => {
    const target = model();

    EXPECTED_STEPS.forEach((step) => {
      expectStepProgress(target, step.t0, step, 0);
      expectStepProgress(target, step.t1, step, 1);
    });
  });

  it('每個階段中點依各自 easing 公式計算，backIn 保留反向 anticipation', () => {
    const target = model();

    EXPECTED_STEPS.forEach((step) => {
      const midpoint = (step.t0 + step.t1) / 2;
      expectStepProgress(target, midpoint, step, 0.5);
      if (step.ease === 'backIn') {
        expect(easings[step.ease](0.5)).toBeLessThan(0);
      }
    });
  });
});
