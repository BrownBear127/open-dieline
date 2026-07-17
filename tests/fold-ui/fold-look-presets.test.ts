import { describe, expect, it } from 'vitest';
import {
  FOLD_LOOK_PRESETS,
  lookNeedsPaperTextureRegeneration,
} from '@/ui/fold-scene';

describe('FOLD_LOOK_PRESETS', () => {
  it('defines all four direction looks while preserving the plain paper baseline', () => {
    expect(Object.keys(FOLD_LOOK_PRESETS)).toEqual([
      'plain',
      'kraft',
      'black',
      'engineering',
    ]);
    expect(FOLD_LOOK_PRESETS.plain).toEqual({
      // T2.5b fix3·待 owner 調參定案。
      cardColor: 0xf4f1ea,
      roughness: 0.9,
      metalness: 0,
      keyIntensity: 2,
      keyColor: 0xffffff,
      fillIntensity: 2,
      fillColor: 0xdde8ff,
      ambientIntensity: 0.4,
      printOverlay: 'none',
    });
    expect(FOLD_LOOK_PRESETS.black).toMatchObject({
      keyIntensity: 5,
      fillIntensity: 2,
      ambientIntensity: 0.35,
    });
    expect(Object.values(FOLD_LOOK_PRESETS).every(({ metalness }) => metalness === 0)).toBe(true);
  });

  it('regenerates paper textures only when the look card color changes', () => {
    expect(lookNeedsPaperTextureRegeneration(
      FOLD_LOOK_PRESETS.plain,
      { ...FOLD_LOOK_PRESETS.plain, keyIntensity: 11 },
    )).toBe(false);
    expect(lookNeedsPaperTextureRegeneration(
      FOLD_LOOK_PRESETS.plain,
      { ...FOLD_LOOK_PRESETS.plain, cardColor: 0xffffff },
    )).toBe(true);
  });
});
