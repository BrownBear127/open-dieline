export const PAPER_RECIPE_BASE_COLORS = {
  white: 0xd1d0cc,
  kraft: 0x332615,
  black: 0x1c1a17,
} as const;

export type FoldRecipeName = keyof typeof PAPER_RECIPE_BASE_COLORS;
export type PaperRecipeBaseColor = (typeof PAPER_RECIPE_BASE_COLORS)[FoldRecipeName];

export function paperColorCss(color: PaperRecipeBaseColor): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
