import { describe, expect, it } from 'vitest';
import { FOLD_RECIPES } from '@/ui/fold-scene';
import { PAPER_RECIPE_BASE_COLORS } from '@/ui/fold-paper-colors';

describe('fold recipe selection', () => {
  it('exposes only the three owner-selected production recipes', () => {
    expect(Object.keys(FOLD_RECIPES)).toEqual(['white', 'kraft', 'black']);
  });

  it('keeps the shared representative color for every production recipe', () => {
    expect(PAPER_RECIPE_BASE_COLORS).toEqual({
      white: 0xd1d0cc,
      kraft: 0x332615,
      black: 0x1c1a17,
    });
    for (const name of Object.keys(PAPER_RECIPE_BASE_COLORS) as Array<keyof typeof FOLD_RECIPES>) {
      expect(FOLD_RECIPES[name].look.cardColor).toBe(PAPER_RECIPE_BASE_COLORS[name]);
    }
  });

  it('keeps every production recipe complete at both look and paper layers', () => {
    for (const recipe of Object.values(FOLD_RECIPES)) {
      expect(Object.keys(recipe.look)).toEqual([
        'cardColor',
        'keyIntensity',
        'keyColor',
        'fillIntensity',
        'fillColor',
        'ambientIntensity',
        'printOverlay',
      ]);
      expect(Object.keys(recipe.paper)).toEqual([
        'contrast',
        'roughness',
        'fiber',
        'fiberSize',
        'crumples',
        'crumpleSize',
        'folds',
        'foldCount',
        'drops',
        'fade',
        'seed',
        'bumpScale',
      ]);
    }
  });
});
