import { CanvasTexture, MeshStandardMaterial, RepeatWrapping } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAPER_PRESETS,
  configurePaperMaterial,
  createPaperBumpTexture,
  createPaperRoughnessTexture,
  paperHeightAt,
  type PaperParams,
} from '@/ui/fold-scene';

const PAPER_PARAM_KEYS = [
  'fiberStrength',
  'fiberScale',
  'grainStrength',
  'crumpleStrength',
  'crumpleScale',
  'bumpScale',
  'roughnessBase',
  'roughnessVariation',
  'seed',
] satisfies Array<keyof PaperParams>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('paperHeightAt', () => {
  it('is strictly deterministic for identical inputs and changes with the seed', () => {
    const params = PAPER_PRESETS.standard;
    const first = paperHeightAt(137.25, 91.75, params);

    expect(paperHeightAt(137.25, 91.75, params)).toBe(first);
    expect(paperHeightAt(137.25, 91.75, { ...params, seed: params.seed + 1 })).not.toBe(first);
  });

  it('stays within the normalized range across 100 deterministic sample points', () => {
    for (let index = 0; index < 100; index += 1) {
      const x = (index * 137.3 + 17) % 512;
      const y = (index * 241.7 + 29) % 512;
      expect(paperHeightAt(x, y, PAPER_PRESETS.coarse)).toBeGreaterThanOrEqual(0);
      expect(paperHeightAt(x, y, PAPER_PRESETS.coarse)).toBeLessThanOrEqual(1);
    }
  });

  it('joins exactly across the 512-pixel horizontal and vertical tile boundaries', () => {
    for (const coordinate of [0, 31.5, 173.25, 511.75]) {
      expect(paperHeightAt(0, coordinate, PAPER_PRESETS.standard)).toBeCloseTo(
        paperHeightAt(512, coordinate, PAPER_PRESETS.standard),
        6,
      );
      expect(paperHeightAt(coordinate, 0, PAPER_PRESETS.standard)).toBeCloseTo(
        paperHeightAt(coordinate, 512, PAPER_PRESETS.standard),
        6,
      );
    }
  });
});

describe('PAPER_PRESETS', () => {
  it('defines complete finite subtle, standard, and coarse parameter sets', () => {
    expect(Object.keys(PAPER_PRESETS)).toEqual(['subtle', 'standard', 'coarse']);

    for (const params of Object.values(PAPER_PRESETS)) {
      expect(Object.keys(params)).toEqual(PAPER_PARAM_KEYS);
      expect(PAPER_PARAM_KEYS.every((key) => Number.isFinite(params[key]))).toBe(true);
    }
  });
});

describe('paper texture writers', () => {
  it('writes repeatable 512px grayscale bump and roughness textures to canvas', () => {
    const writtenImages: ImageData[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
        colorSpace: 'srgb',
      }),
      putImageData: (imageData: ImageData) => writtenImages.push(imageData),
    }) as unknown as CanvasRenderingContext2D);

    const bump = createPaperBumpTexture(PAPER_PRESETS.standard);
    const roughness = createPaperRoughnessTexture({
      ...PAPER_PRESETS.standard,
      roughnessBase: 0.75,
      roughnessVariation: 0,
    });

    expect(bump.image).toMatchObject({ width: 512, height: 512 });
    expect(roughness.image).toMatchObject({ width: 512, height: 512 });
    expect([bump.wrapS, bump.wrapT, roughness.wrapS, roughness.wrapT]).toEqual([
      RepeatWrapping,
      RepeatWrapping,
      RepeatWrapping,
      RepeatWrapping,
    ]);
    expect(writtenImages).toHaveLength(2);
    expect([...writtenImages[1]!.data.slice(0, 8)]).toEqual([
      191, 191, 191, 255,
      191, 191, 191, 255,
    ]);
  });

  it('configures the material maps, bump scale, and roughness multiplier', () => {
    const material = new MeshStandardMaterial({ roughness: 0.2 });
    const bump = new CanvasTexture(document.createElement('canvas'));
    const roughness = new CanvasTexture(document.createElement('canvas'));

    configurePaperMaterial(material, PAPER_PRESETS.standard, bump, roughness);

    expect(material.bumpMap).toBe(bump);
    expect(material.roughnessMap).toBe(roughness);
    expect(material.bumpScale).toBe(PAPER_PRESETS.standard.bumpScale);
    expect(material.roughness).toBe(1);
  });
});
