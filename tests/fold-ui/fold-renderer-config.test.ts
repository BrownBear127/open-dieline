import { ACESFilmicToneMapping, NoToneMapping } from 'three';
import { describe, expect, it } from 'vitest';
import { configureFoldRenderer } from '@/ui/fold-scene';

describe('fold renderer configuration', () => {
  it('enables ACES filmic tone mapping at the default exposure', () => {
    const renderer = {
      toneMapping: NoToneMapping,
      toneMappingExposure: 0.5,
    };

    configureFoldRenderer(renderer);

    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});
