export const PAPER_RECIPE_BASE_COLORS = {
  white: 0xd1d0cc,
  kraft: 0x332615,
  black: 0x1c1a17,
} as const;

export type FoldRecipeName = keyof typeof PAPER_RECIPE_BASE_COLORS;
