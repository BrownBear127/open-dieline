import { tuckTopSnapLock } from '../../boxes/tuck-top-snap-lock';
import type { ResolvedParams } from '../../core/types';
import {
  assertBoxInvariants,
  panelizeFoldModel,
  type PanelAngleSpec,
} from '../derive/panelize';
import type { FoldModel, FoldStep } from '../types';

const OUTWARD_FOLD_ANGLE = -Math.PI / 2;

const TTSL_STEPS: FoldStep[] = [
  { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.3, ease: 'powerInOut' },
  { panelIds: ['bottomWebP2'], t0: 0.3, t1: 0.375, ease: 'backIn' },
  { panelIds: ['bottomWebP4'], t0: 0.375, t1: 0.45, ease: 'backIn' },
  { panelIds: ['bottomReceiveP3'], t0: 0.45, t1: 0.525, ease: 'backIn' },
  { panelIds: ['bottomLockP1'], t0: 0.525, t1: 0.6, ease: 'backIn' },
  { panelIds: ['topDustP2', 'topDustP4'], t0: 0.6, t1: 0.72, ease: 'backIn' },
  { panelIds: ['topTuck'], t0: 0.72, t1: 0.85, ease: 'backIn' },
  { panelIds: ['topLid'], t0: 0.85, t1: 1, ease: 'powerInOut' },
];

function TTSL_ANGLES(): PanelAngleSpec[] {
  return [
    'P1',
    'P2',
    'P3',
    'P4',
    'glue',
    'bottomLockP1',
    'bottomWebP2',
    'bottomReceiveP3',
    'bottomWebP4',
    'topLid',
    'topTuck',
    'topDustP2',
    'topDustP4',
  ].map((id) => ({
    id,
    foldAngle: id === 'P1' ? 0 : OUTWARD_FOLD_ANGLE,
  }));
}

export function buildTtslFoldModel(params: ResolvedParams): FoldModel {
  const result = tuckTopSnapLock.generate(params);
  assertBoxInvariants(tuckTopSnapLock, params, result);
  return panelizeFoldModel(result, 'P1', TTSL_ANGLES(), TTSL_STEPS);
}
