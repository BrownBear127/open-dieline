import type { EaseName } from './types';

export const easings: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  powerInOut: (u) => (u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2),
  backIn: (u) => {
    const c = 1.70158 * 1.5;
    return (c + 1) * u ** 3 - c * u ** 2;
  },
};
