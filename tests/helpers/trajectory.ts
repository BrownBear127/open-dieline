import { applyTransform, panelWorldTransform } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel, Pt } from '@/fold/types';

export interface SharedEdgeSample {
  aPanelId: string;
  bPanelId: string;
  points: Pt[];
}

export interface SharedEdgeGap {
  pair: string;
  maxGapMm: number;
}

function distanceBetween(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function sharedEdgeGapsAt(
  model: FoldModel,
  samples: SharedEdgeSample[],
  t: number,
): SharedEdgeGap[] {
  const pose = foldPose(t, model);

  return samples.map(({ aPanelId, bPanelId, points }) => {
    const aTransform = panelWorldTransform(model, pose, aPanelId);
    const bTransform = panelWorldTransform(model, pose, bPanelId);
    const maxGapMm = Math.max(
      ...points.map((point) => {
        const flatPoint = { ...point, z: 0 };
        return distanceBetween(
          applyTransform(aTransform, flatPoint),
          applyTransform(bTransform, flatPoint),
        );
      }),
    );

    return { pair: `${aPanelId}↔${bPanelId}`, maxGapMm };
  });
}
