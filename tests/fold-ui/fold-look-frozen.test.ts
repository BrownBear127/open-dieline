// 法蘭定案 2026-07-17 M2 視覺輪·受鎖：改值必先過 owner。
import { describe, expect, it } from 'vitest';
import { FOLD_DEFAULT_RECIPE, FOLD_RECIPES } from '@/ui/fold-scene';

describe('frozen fold recipes', () => {
  it.each([
    ['white.look.cardColor', FOLD_RECIPES.white.look.cardColor, 0xd1d0cc],
    ['white.look.keyIntensity', FOLD_RECIPES.white.look.keyIntensity, 2],
    ['white.look.keyColor', FOLD_RECIPES.white.look.keyColor, 0xffffff],
    ['white.look.fillIntensity', FOLD_RECIPES.white.look.fillIntensity, 2],
    ['white.look.fillColor', FOLD_RECIPES.white.look.fillColor, 0xdde8ff],
    ['white.look.ambientIntensity', FOLD_RECIPES.white.look.ambientIntensity, 0.4],
    ['white.look.printOverlay', FOLD_RECIPES.white.look.printOverlay, 'none'],
    ['white.paper.contrast', FOLD_RECIPES.white.paper.contrast, 0.42],
    ['white.paper.roughness', FOLD_RECIPES.white.paper.roughness, 0.23],
    ['white.paper.fiber', FOLD_RECIPES.white.paper.fiber, 0],
    ['white.paper.fiberSize', FOLD_RECIPES.white.paper.fiberSize, 0],
    ['white.paper.crumples', FOLD_RECIPES.white.paper.crumples, 0.1],
    ['white.paper.crumpleSize', FOLD_RECIPES.white.paper.crumpleSize, 0],
    ['white.paper.folds', FOLD_RECIPES.white.paper.folds, 0.93],
    ['white.paper.foldCount', FOLD_RECIPES.white.paper.foldCount, 1],
    ['white.paper.drops', FOLD_RECIPES.white.paper.drops, 0],
    ['white.paper.fade', FOLD_RECIPES.white.paper.fade, 0.12],
    ['white.paper.seed', FOLD_RECIPES.white.paper.seed, 3203],
    ['white.paper.bumpScale', FOLD_RECIPES.white.paper.bumpScale, 0.116],

    ['kraft.look.cardColor', FOLD_RECIPES.kraft.look.cardColor, 0x332615],
    ['kraft.look.keyIntensity', FOLD_RECIPES.kraft.look.keyIntensity, 6],
    ['kraft.look.keyColor', FOLD_RECIPES.kraft.look.keyColor, 0xfff1dd],
    ['kraft.look.fillIntensity', FOLD_RECIPES.kraft.look.fillIntensity, 3],
    ['kraft.look.fillColor', FOLD_RECIPES.kraft.look.fillColor, 0xdde8ff],
    ['kraft.look.ambientIntensity', FOLD_RECIPES.kraft.look.ambientIntensity, 1.2],
    ['kraft.look.printOverlay', FOLD_RECIPES.kraft.look.printOverlay, 'none'],
    ['kraft.paper.contrast', FOLD_RECIPES.kraft.paper.contrast, 0.42],
    ['kraft.paper.roughness', FOLD_RECIPES.kraft.paper.roughness, 0.23],
    ['kraft.paper.fiber', FOLD_RECIPES.kraft.paper.fiber, 0],
    ['kraft.paper.fiberSize', FOLD_RECIPES.kraft.paper.fiberSize, 0],
    ['kraft.paper.crumples', FOLD_RECIPES.kraft.paper.crumples, 0.1],
    ['kraft.paper.crumpleSize', FOLD_RECIPES.kraft.paper.crumpleSize, 0],
    ['kraft.paper.folds', FOLD_RECIPES.kraft.paper.folds, 0.93],
    ['kraft.paper.foldCount', FOLD_RECIPES.kraft.paper.foldCount, 1],
    ['kraft.paper.drops', FOLD_RECIPES.kraft.paper.drops, 0],
    ['kraft.paper.fade', FOLD_RECIPES.kraft.paper.fade, 0.12],
    ['kraft.paper.seed', FOLD_RECIPES.kraft.paper.seed, 3203],
    ['kraft.paper.bumpScale', FOLD_RECIPES.kraft.paper.bumpScale, 0.116],

    ['black.look.cardColor', FOLD_RECIPES.black.look.cardColor, 0x1c1a17],
    ['black.look.keyIntensity', FOLD_RECIPES.black.look.keyIntensity, 5],
    ['black.look.keyColor', FOLD_RECIPES.black.look.keyColor, 0xffffff],
    ['black.look.fillIntensity', FOLD_RECIPES.black.look.fillIntensity, 2],
    ['black.look.fillColor', FOLD_RECIPES.black.look.fillColor, 0xdde8ff],
    ['black.look.ambientIntensity', FOLD_RECIPES.black.look.ambientIntensity, 0.35],
    ['black.look.printOverlay', FOLD_RECIPES.black.look.printOverlay, 'none'],
    ['black.paper.contrast', FOLD_RECIPES.black.paper.contrast, 0.36],
    ['black.paper.roughness', FOLD_RECIPES.black.paper.roughness, 0.2],
    ['black.paper.fiber', FOLD_RECIPES.black.paper.fiber, 0],
    ['black.paper.fiberSize', FOLD_RECIPES.black.paper.fiberSize, 0],
    ['black.paper.crumples', FOLD_RECIPES.black.paper.crumples, 0.1],
    ['black.paper.crumpleSize', FOLD_RECIPES.black.paper.crumpleSize, 0],
    ['black.paper.folds', FOLD_RECIPES.black.paper.folds, 0.93],
    ['black.paper.foldCount', FOLD_RECIPES.black.paper.foldCount, 1],
    ['black.paper.drops', FOLD_RECIPES.black.paper.drops, 0],
    ['black.paper.fade', FOLD_RECIPES.black.paper.fade, 0.12],
    ['black.paper.seed', FOLD_RECIPES.black.paper.seed, 3203],
    ['black.paper.bumpScale', FOLD_RECIPES.black.paper.bumpScale, 0.116],
  ])('%s is owner-locked', (_field, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('defaults to the owner-selected kraft recipe', () => {
    expect(FOLD_DEFAULT_RECIPE).toBe('kraft');
  });
});
