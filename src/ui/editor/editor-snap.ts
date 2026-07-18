export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SnapTargets {
  vertical: readonly number[];
  horizontal: readonly number[];
  disabled?: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface SnapMatch {
  distance: number;
  dx: number;
  dy: number;
}

function anchorPoints(bounds: AABB): Point[] {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: centerX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.minX, y: centerY },
    { x: centerX, y: centerY },
    { x: bounds.maxX, y: centerY },
    { x: bounds.minX, y: bounds.maxY },
    { x: centerX, y: bounds.maxY },
    { x: bounds.maxX, y: bounds.maxY },
  ];
}

function closerMatch(current: SnapMatch | null, candidate: SnapMatch): SnapMatch {
  if (current === null || candidate.distance < current.distance) return candidate;
  return current;
}

export function snapDelta(
  bounds: AABB,
  targets: SnapTargets,
  thresholdMm: number,
): { dx: number; dy: number } | null {
  if (targets.disabled || !Number.isFinite(thresholdMm) || thresholdMm < 0) return null;

  const anchors = anchorPoints(bounds);
  let match: SnapMatch | null = null;

  // Vertical matches are evaluated first so an equal horizontal distance does not replace them.
  for (const target of targets.vertical) {
    if (!Number.isFinite(target)) continue;
    for (const anchor of anchors) {
      const dx = target - anchor.x;
      const distance = Math.abs(dx);
      if (distance <= thresholdMm) {
        match = closerMatch(match, { distance, dx, dy: 0 });
      }
    }
  }

  for (const target of targets.horizontal) {
    if (!Number.isFinite(target)) continue;
    for (const anchor of anchors) {
      const dy = target - anchor.y;
      const distance = Math.abs(dy);
      if (distance <= thresholdMm) {
        match = closerMatch(match, { distance, dx: 0, dy });
      }
    }
  }

  return match === null ? null : { dx: match.dx, dy: match.dy };
}
