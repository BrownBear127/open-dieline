import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { GenerateResult } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import type { FoldModel, Pt } from '@/fold/types';
import { sharedEdgeGapsAt, type SharedEdgeSample } from '../helpers/trajectory';

const GAP_TOLERANCE_MM = 1e-9;

function sampledPoints(a: Pt, b: Pt): Pt[] {
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    x: a.x + (b.x - a.x) * ratio,
    y: a.y + (b.y - a.y) * ratio,
  }));
}

function trajectoryTimes(model: FoldModel): number[] {
  const times = new Set([0, 0.25, 0.5, 0.75, 1]);
  for (const step of model.steps) {
    times.add(step.t0);
    times.add((step.t0 + step.t1) / 2);
    times.add(step.t1);
  }
  return [...times].sort((a, b) => a - b);
}

function expectClosedTrajectory(model: FoldModel, samples: SharedEdgeSample[]): void {
  let worst = { pair: '', t: 0, maxGapMm: 0 };

  for (const t of trajectoryTimes(model)) {
    for (const gap of sharedEdgeGapsAt(model, samples, t)) {
      if (gap.maxGapMm > worst.maxGapMm) worst = { ...gap, t };
    }
  }

  expect(
    worst.maxGapMm,
    `${worst.pair} 在 t=${worst.t.toFixed(6)} 的最大縫隙為 ${worst.maxGapMm.toFixed(6)}mm`,
  ).toBeLessThan(GAP_TOLERANCE_MM);
}

function firstPositiveBodyCrease(result: GenerateResult): { a: Pt; b: Pt } {
  const candidates = result.paths
    .filter((path) => path.type === 'crease' && path.tags?.includes('D'))
    .flatMap((path) => path.segments.flatMap((segment) => {
      if (segment.kind !== 'line' || Math.abs(segment.x1 - segment.x2) >= 1e-9) return [];
      return [{
        a: { x: segment.x1, y: segment.y1 },
        b: { x: segment.x2, y: segment.y2 },
      }];
    }))
    .filter(({ a, b }) => a.x > 0 && Math.abs(a.y - b.y) > 0)
    .sort((left, right) => left.a.x - right.a.x);

  expect(candidates.length, '2D generate() 應提供正 x 方向的盒身摺線').toBeGreaterThan(0);
  return candidates[0]!;
}

function generatedCreaseSample(
  result: GenerateResult,
  aPanelId: string,
  bPanelId: string,
): SharedEdgeSample {
  const crease = firstPositiveBodyCrease(result);
  return { aPanelId, bPanelId, points: sampledPoints(crease.a, crease.b) };
}

// 量測對象=hinge 座標綁定（snapped shared-edge 回歸鎖）；摺角物理由摺向 sabotage 矩陣把關。
describe('snapped shared-edge 的 hinge 座標綁定回歸鎖', () => {
  it('ttb zoneDTab 與 zoneDLip 的兩段 snapped shared-edge 座標在完整軌跡中維持綁定', () => {
    const params = resolveParams(triangularTube, {});
    const result = triangularTube.generate(params);
    const model = buildTtbFoldModel(params);
    const tab = model.panels.find((panel) => panel.id === 'zoneDTab');
    const creaseSegments = result.paths
      .filter((path) => path.type === 'crease' && path.tags?.includes('fold:zoneDBase>zoneDTab'))
      .flatMap((path) => path.segments)
      .filter((segment) => segment.kind === 'line');
    const samples: SharedEdgeSample[] = creaseSegments.map((segment) => ({
      aPanelId: 'zoneDLip',
      bPanelId: 'zoneDTab',
      points: sampledPoints(
        { x: segment.x1, y: segment.y1 },
        { x: segment.x2, y: segment.y2 },
      ),
    }));

    expect(tab).toBeDefined();
    expect(tab!.polygon).toHaveLength(9);
    expect(creaseSegments).toHaveLength(2);

    expectClosedTrajectory(model, samples);
  });

  it('rte parent-child snapped shared-edge 座標在完整軌跡中維持綁定', () => {
    const params = resolveParams(reverseTuckEnd, { thickness: 0 });
    const model = buildRteFoldModel(params);
    const sample = generatedCreaseSample(reverseTuckEnd.generate(params), 'P1', 'P2');

    expectClosedTrajectory(model, [sample]);
  });

  it('ttsl parent-child snapped shared-edge 座標在完整軌跡中維持綁定', () => {
    const params = resolveParams(tuckTopSnapLock, { thickness: 0 });
    const model = buildTtslFoldModel(params);
    const sample = generatedCreaseSample(tuckTopSnapLock.generate(params), 'P1', 'P2');

    expectClosedTrajectory(model, [sample]);
  });
});
