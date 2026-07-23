import type { ResolvedParams } from '../core/types';
import { buildRteFoldModel } from './models/reverse-tuck-end';
import { buildTtbFoldModel } from './models/triangular-tube';
import { buildTtslFoldModel } from './models/tuck-top-snap-lock';
import type { FoldModel } from './types';

export const FOLD_MODEL_BUILDERS: Record<string, (p: ResolvedParams) => FoldModel> = {
  rte: buildRteFoldModel,
  ttsl: buildTtslFoldModel,
  ttb: buildTtbFoldModel,
};
