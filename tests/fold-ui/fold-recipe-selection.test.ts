import { describe, expect, it } from 'vitest';
import { FOLD_RECIPES } from '@/ui/fold-scene';

describe('fold recipe selection', () => {
  it('exposes only the three owner-selected production recipes', () => {
    expect(Object.keys(FOLD_RECIPES)).toEqual(['white', 'kraft', 'black']);
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
