import type { ResolvedParams } from '../core/types';
import { buildRteFoldModel } from './models/reverse-tuck-end';
import type { FoldModel } from './types';

export const FOLD_MODEL_BUILDERS: Record<string, (p: ResolvedParams) => FoldModel> = {
  rte: buildRteFoldModel,
};
