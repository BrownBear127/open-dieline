import { reverseTuckEnd } from '../../boxes/reverse-tuck-end';
import type { ResolvedParams } from '../../core/types';
import {
  assertBoxInvariants,
  panelizeFoldModel,
  type PanelAngleSpec,
} from '../derive/panelize';
import type { FoldModel, FoldStep } from '../types';

const OUTWARD_FOLD_ANGLE = -Math.PI / 2;

const RTE_STEPS: FoldStep[] = [
  { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
  { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
  { panelIds: ['bottomTuck'], t0: 0.5, t1: 0.6, ease: 'backIn' },
  { panelIds: ['bottomLid'], t0: 0.6, t1: 0.72, ease: 'powerInOut' },
  { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
  { panelIds: ['topTuck'], t0: 0.84, t1: 0.92, ease: 'backIn' },
  { panelIds: ['topLid'], t0: 0.92, t1: 1, ease: 'powerInOut' },
];

function RTE_ANGLES(params: ResolvedParams): PanelAngleSpec[] {
  const length = params.L as number;
  const thickness = params.thickness as number;
  const clearance = params.tuckClearance as number;
  const tuckDepth = params.tuckDepth as number;
  const dustDepth = params.dustFlapDepth as number;
  const bottomLidWidth = length + (params.glueSide === 'right' ? 2 * thickness : 0);
  const topLidWidth = length + thickness;
  const hasTopTuck = tuckDepth > 0 && topLidWidth > 2 * clearance;
  const hasBottomTuck = tuckDepth > 0 && bottomLidWidth > 2 * clearance;

  const ids = [
    'P1',
    'P2',
    'P3',
    'P4',
    'glue',
    'topLid',
    ...(hasTopTuck ? ['topTuck'] : []),
    ...(dustDepth > 0 ? ['topDustP2', 'topDustP4'] : []),
    'bottomLid',
    ...(hasBottomTuck ? ['bottomTuck'] : []),
    ...(dustDepth > 0 ? ['bottomDustP2', 'bottomDustP4'] : []),
  ];

  return ids.map((id) => ({
    id,
    foldAngle: id === 'P1' ? 0 : OUTWARD_FOLD_ANGLE,
  }));
}

function activeSteps(angles: PanelAngleSpec[]): FoldStep[] {
  const activePanelIds = new Set(angles.map(({ id }) => id));
  return RTE_STEPS
    .map((step) => ({
      ...step,
      panelIds: step.panelIds.filter((id) => activePanelIds.has(id)),
    }))
    .filter(({ panelIds }) => panelIds.length > 0);
}

export function buildRteFoldModel(params: ResolvedParams): FoldModel {
  const result = reverseTuckEnd.generate(params);
  assertBoxInvariants(reverseTuckEnd, params, result);
  const angles = RTE_ANGLES(params);
  return panelizeFoldModel(result, 'P1', angles, activeSteps(angles));
}
