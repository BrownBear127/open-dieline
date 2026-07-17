import { describe, expect, it } from 'vitest';
import { FOLD_LOOK_PRESETS } from '@/ui/fold-scene';

describe('FOLD_LOOK_PRESETS', () => {
  it('defines all four direction looks while preserving the plain paper baseline', () => {
    expect(Object.keys(FOLD_LOOK_PRESETS)).toEqual([
      'plain',
      'kraft',
      'black',
      'engineering',
    ]);
    expect(FOLD_LOOK_PRESETS.plain).toEqual({
      cardColor: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      keyIntensity: 24,
      keyColor: 0xffffff,
      fillIntensity: 12,
      fillColor: 0xdde8ff,
      ambientIntensity: 1.5,
      printOverlay: 'none',
    });
    expect(FOLD_LOOK_PRESETS.black).toMatchObject({
      keyIntensity: 5,
      fillIntensity: 2,
      ambientIntensity: 0.35,
    });
    expect(Object.values(FOLD_LOOK_PRESETS).every(({ metalness }) => metalness === 0)).toBe(true);
  });
});
