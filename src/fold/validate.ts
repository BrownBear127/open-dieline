import type { FoldModel } from './types';

type FoldPanel = FoldModel['panels'][number];
type Pt = FoldPanel['polygon'][number];

const EDGE_TOLERANCE = 1e-6;

function isFinitePoint(point: Pt): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function pointToSegmentDistance(point: Pt, start: Pt, end: Pt): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const closestX = start.x + clampedProjection * dx;
  const closestY = start.y + clampedProjection * dy;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

function isPointOnPolygonEdge(point: Pt, polygon: Pt[]): boolean {
  if (!isFinitePoint(point) || polygon.length < 2 || !polygon.every(isFinitePoint)) {
    return false;
  }

  return polygon.some((start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    return pointToSegmentDistance(point, start, end) < EDGE_TOLERANCE;
  });
}

function signedPolygonArea(polygon: Pt[]): number {
  return polygon.reduce((twiceArea, point, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    return twiceArea + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function validateParentChain(
  panel: FoldPanel,
  rootId: string | undefined,
  panelsById: Map<string, FoldPanel>,
  errors: string[],
): void {
  const path: string[] = [];
  const visited = new Set<string>();
  let current = panel;

  while (true) {
    if (visited.has(current.id)) {
      const cycleStart = path.indexOf(current.id);
      const cycle = [...path.slice(cycleStart), current.id].map((id) => `"${id}"`).join(' -> ');
      errors.push(`Panel "${panel.id}" parent chain contains a cycle: ${cycle}.`);
      return;
    }

    visited.add(current.id);
    path.push(current.id);

    if (current.parent === null) {
      if (rootId !== undefined && current.id !== rootId) {
        errors.push(`Panel "${panel.id}" is not connected to root "${rootId}".`);
      }
      return;
    }

    const parent = panelsById.get(current.parent);
    if (parent === undefined) {
      const rootLabel = rootId === undefined ? 'a root' : `root "${rootId}"`;
      errors.push(
        `Panel "${panel.id}" cannot reach ${rootLabel} because parent "${current.parent}" does not exist.`,
      );
      return;
    }
    current = parent;
  }
}

export function validateFoldModel(model: FoldModel): string[] {
  const errors: string[] = [];
  const panelsById = new Map<string, FoldPanel>();

  for (const panel of model.panels) {
    if (panelsById.has(panel.id)) {
      errors.push(`Duplicate panel id "${panel.id}".`);
    } else {
      panelsById.set(panel.id, panel);
    }
  }

  const roots = model.panels.filter((panel) => panel.parent === null);
  if (roots.length !== 1) {
    errors.push(`Model must have exactly one root; found ${roots.length}.`);
  }
  for (const root of roots) {
    if (root.foldAngle !== 0) {
      errors.push(`Root panel "${root.id}" foldAngle must be 0.`);
    }
  }

  for (const panel of model.panels) {
    if (!Number.isFinite(panel.foldAngle)) {
      errors.push(`Panel "${panel.id}" foldAngle must be finite.`);
    }
    if (panel.liftOffset !== undefined && !Number.isFinite(panel.liftOffset)) {
      errors.push(`Panel "${panel.id}" liftOffset must be finite.`);
    }

    panel.polygon.forEach((point, index) => {
      if (!isFinitePoint(point)) {
        errors.push(`Panel "${panel.id}" polygon vertex ${index} coordinates must be finite.`);
      }
    });
    if (panel.polygon.length < 3) {
      errors.push(`Panel "${panel.id}" polygon must have at least 3 vertices.`);
    } else if (panel.polygon.every(isFinitePoint) && signedPolygonArea(panel.polygon) <= 0) {
      errors.push(`Panel "${panel.id}" polygon must have positive area.`);
    }

    if (panel.parent !== null) {
      if (!panelsById.has(panel.parent)) {
        errors.push(`Panel "${panel.id}" references missing parent "${panel.parent}".`);
      }
      if (panel.parent === panel.id) {
        errors.push(`Panel "${panel.id}" must not be self-parented.`);
      }
      if (panel.hingeLine === undefined) {
        errors.push(`Panel "${panel.id}" must have a hingeLine because it is not a root.`);
      }
    }

    if (panel.hingeLine !== undefined) {
      const { a, b } = panel.hingeLine;
      const aIsFinite = isFinitePoint(a);
      const bIsFinite = isFinitePoint(b);
      if (!aIsFinite) {
        errors.push(`Panel "${panel.id}" hingeLine endpoint a coordinates must be finite.`);
      }
      if (!bIsFinite) {
        errors.push(`Panel "${panel.id}" hingeLine endpoint b coordinates must be finite.`);
      }
      if (aIsFinite && bIsFinite && Math.hypot(b.x - a.x, b.y - a.y) <= 0) {
        errors.push(`Panel "${panel.id}" hingeLine length must be greater than 0.`);
      }

      const parent = panel.parent === null ? undefined : panelsById.get(panel.parent);
      if (parent !== undefined) {
        if (!isPointOnPolygonEdge(a, parent.polygon)) {
          errors.push(`Panel "${panel.id}" hingeLine endpoint a must lie on an edge of parent "${parent.id}".`);
        }
        if (!isPointOnPolygonEdge(b, parent.polygon)) {
          errors.push(`Panel "${panel.id}" hingeLine endpoint b must lie on an edge of parent "${parent.id}".`);
        }
      }
    }
  }

  const rootId = roots.length === 1 ? roots[0]!.id : undefined;
  for (const panel of model.panels) {
    validateParentChain(panel, rootId, panelsById, errors);
  }

  model.steps.forEach((step, stepIndex) => {
    const seenStepPanelIds = new Set<string>();
    for (const panelId of step.panelIds) {
      if (!panelsById.has(panelId)) {
        errors.push(`Step ${stepIndex} references missing panel "${panelId}".`);
      }
      if (seenStepPanelIds.has(panelId)) {
        errors.push(`Step ${stepIndex} contains duplicate panel id "${panelId}".`);
      }
      seenStepPanelIds.add(panelId);
    }

    if (!Number.isFinite(step.t0)) {
      errors.push(`Step ${stepIndex} t0 must be finite.`);
    }
    if (!Number.isFinite(step.t1)) {
      errors.push(`Step ${stepIndex} t1 must be finite.`);
    }
    if (
      Number.isFinite(step.t0)
      && Number.isFinite(step.t1)
      && !(0 <= step.t0 && step.t0 < step.t1 && step.t1 <= 1)
    ) {
      errors.push(`Step ${stepIndex} must satisfy 0 <= t0 < t1 <= 1.`);
    }
  });

  for (const panel of model.panels) {
    const stepCount = model.steps.filter((step) => step.panelIds.includes(panel.id)).length;
    if (panel.parent === null && stepCount > 0) {
      errors.push(`Root panel "${panel.id}" must not belong to any step.`);
    } else if (panel.parent !== null && stepCount !== 1) {
      errors.push(`Panel "${panel.id}" belongs to ${stepCount} steps; every non-root panel must belong to exactly one.`);
    }
  }

  return errors;
}
