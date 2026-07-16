import { easings } from './easings';
import type { FoldModel, FoldStep } from './types';

function localProgress(t: number, step: FoldStep): number {
  if (t <= step.t0) return 0;
  if (t >= step.t1) return 1;
  return (t - step.t0) / (step.t1 - step.t0);
}

export function foldPose(t: number, model: FoldModel): Map<string, number> {
  const clampedT = Math.max(0, Math.min(1, t));
  const pose = new Map<string, number>();

  for (const panel of model.panels) {
    const step = model.steps.find((candidate) => candidate.panelIds.includes(panel.id));
    if (panel.parent === null || step === undefined) {
      pose.set(panel.id, 0);
      continue;
    }

    const progress = localProgress(clampedT, step);
    const angle = progress === 0 ? 0 : panel.foldAngle * easings[step.ease](progress);
    pose.set(panel.id, angle);
  }

  return pose;
}
