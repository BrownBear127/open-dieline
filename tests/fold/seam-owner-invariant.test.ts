import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import type { FoldModel, Pt } from '@/fold/types';

const TOLERANCE_MM = 1e-6;

function distanceToSegment(point: Pt, start: Pt, end: Pt): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.y - (start.y + projection * dy),
  );
}

function pointInPolygon(point: Pt, polygon: Pt[]): boolean {
  if (polygon.some((start, index) =>
    distanceToSegment(point, start, polygon[(index + 1) % polygon.length]!) <= TOLERANCE_MM)) {
    return true;
  }

  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function expectSeamsInsideOwners(model: FoldModel): void {
  const panels = new Map(model.panels.map((panel) => [panel.id, panel]));
  for (const seam of model.seams ?? []) {
    const owner = panels.get(seam.ownerPanelId);
    expect(owner, seam.ownerPanelId).toBeDefined();
    for (const point of seam.points) {
      expect(
        pointInPolygon(point, owner!.polygon),
        `${seam.sourcePathId} point (${point.x}, ${point.y}) outside ${owner!.id}`,
      ).toBe(true);
    }
  }
}

describe('all fold models keep every seam vertex inside its owner polygon', () => {
  it.each([
    ['rte', () => buildRteFoldModel(resolveParams(reverseTuckEnd, {}))],
    ['ttsl', () => buildTtslFoldModel(resolveParams(tuckTopSnapLock, {}))],
    ['ttb', () => buildTtbFoldModel(resolveParams(triangularTube, {}))],
  ] as const)('%s', (_boxId, build) => {
    expectSeamsInsideOwners(build());
  });
});
