import {
  CanvasTexture,
  ClampToEdgeWrapping,
  MeshStandardMaterial,
  SRGBColorSpace,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAPER_PRESETS,
  configurePaperMaterial,
  createPaperAlbedoTexture,
  createPaperBumpTexture,
  paperHeightAt,
  paperTextureCoordinatesAt,
  sampleArtworkPlan,
  type PaperParams,
} from '@/ui/fold-scene';

const PAPER_PARAM_KEYS = [
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

  it('does not force opposite edges to repeat', () => {
    const left = [31.5, 173.25, 411.75].map((y) => paperHeightAt(0, y, PAPER_PRESETS.standard));
    const right = [31.5, 173.25, 411.75]
      .map((y) => paperHeightAt(512, y, PAPER_PRESETS.standard));

    expect(right).not.toEqual(left);
  });
});

describe('paper texture coordinates', () => {
  it('maps the full texture width to five pattern units', () => {
    expect(paperTextureCoordinatesAt(-0.5, -0.5)).toMatchObject({
      patternX: -2.5,
      patternY: -2.5,
    });
    expect(paperTextureCoordinatesAt(511.5, 511.5)).toMatchObject({
      patternX: 2.5,
      patternY: 2.5,
    });
  });

  it('keeps roughness coordinates in texture-pixel space', () => {
    const first = paperTextureCoordinatesAt(100, 200);
    const nextPixel = paperTextureCoordinatesAt(101, 201);

    expect(nextPixel.roughnessX - first.roughnessX).toBeCloseTo(1.5, 12);
    expect(nextPixel.roughnessY - first.roughnessY).toBeCloseTo(1.5, 12);
  });
});

describe('PAPER_PRESETS', () => {
  it('defines complete finite subtle, standard, and coarse v2 parameter sets', () => {
    expect(Object.keys(PAPER_PRESETS)).toEqual(['subtle', 'standard', 'coarse']);

    for (const params of Object.values(PAPER_PRESETS)) {
      expect(Object.keys(params)).toEqual(PAPER_PARAM_KEYS);
      expect(PAPER_PARAM_KEYS.every((key) => Number.isFinite(params[key]))).toBe(true);
      expect(params.foldCount).toBeGreaterThanOrEqual(1);
      expect(params.foldCount).toBeLessThanOrEqual(15);
      expect(Number.isInteger(params.foldCount)).toBe(true);
    }
  });
});

describe('paper texture writers', () => {
  it('writes a 512px sRGB albedo map and a non-repeating grayscale bump map', () => {
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

    const albedo = createPaperAlbedoTexture(PAPER_PRESETS.standard, 0xc86432);
    const bump = createPaperBumpTexture(PAPER_PRESETS.standard);

    expect(albedo.image).toMatchObject({ width: 512, height: 512 });
    expect(bump.image).toMatchObject({ width: 512, height: 512 });
    expect(albedo.colorSpace).toBe(SRGBColorSpace);
    expect([albedo.wrapS, albedo.wrapT, bump.wrapS, bump.wrapT]).toEqual([
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
      ClampToEdgeWrapping,
    ]);
    expect(writtenImages).toHaveLength(2);
    expect(writtenImages[0]!.data[0]).toBeGreaterThan(0);
    expect(writtenImages[0]!.data[1]).toBeGreaterThan(0);
    expect(writtenImages[0]!.data[2]).toBeGreaterThan(0);
    expect(writtenImages[0]!.data[0]).toBeGreaterThan(writtenImages[0]!.data[1]!);
    expect(writtenImages[0]!.data[1]).toBeGreaterThan(writtenImages[0]!.data[2]!);
    expect(writtenImages[1]!.data[0]).toBe(writtenImages[1]!.data[1]);
    expect(writtenImages[1]!.data[1]).toBe(writtenImages[1]!.data[2]);
  });

  it('adds centered paper modulation visibly on black card stock', () => {
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

    createPaperAlbedoTexture(PAPER_PRESETS.standard, 0x1c1a17);

    const redValues = writtenImages[0]!.data.filter((_, index) => index % 4 === 0);
    expect(redValues.some((value) => value > 0x1c)).toBe(true);
    expect(redValues.some((value) => value < 0x1c)).toBe(true);
  });

  it('configures baked albedo, white material tint, and weak bump assistance', () => {
    const material = new MeshStandardMaterial({ color: 0x123456, roughness: 0.82 });
    const albedo = new CanvasTexture(document.createElement('canvas'));
    const bump = new CanvasTexture(document.createElement('canvas'));

    configurePaperMaterial(material, PAPER_PRESETS.standard, albedo, bump);

    expect(material.map).toBe(albedo);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.bumpMap).toBe(bump);
    expect(material.roughnessMap).toBeNull();
    expect(material.bumpScale).toBe(PAPER_PRESETS.standard.bumpScale);
    expect(material.roughness).toBe(0.82);
  });
});

describe('sampleArtworkPlan', () => {
  const flatGeometry = new Map([
    ['P1', [
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: 0 },
      { x: 100, y: 160, z: 0 },
      { x: 0, y: 160, z: 0 },
    ]],
    ['P2', [
      { x: 100, y: 0, z: 0 },
      { x: 140, y: 0, z: 0 },
      { x: 140, y: 160, z: 0 },
      { x: 100, y: 160, z: 0 },
    ]],
    ['P4', [
      { x: 240, y: 0, z: 0 },
      { x: 280, y: 0, z: 0 },
      { x: 280, y: 160, z: 0 },
      { x: 240, y: 160, z: 0 },
    ]],
    ['topLid', [
      { x: 140, y: -100, z: 0 },
      { x: 240, y: -100, z: 0 },
      { x: 240, y: 0, z: 0 },
      { x: 140, y: 0, z: 0 },
    ]],
    ['bottomLid', [
      { x: 0, y: 160, z: 0 },
      { x: 100, y: 160, z: 0 },
      { x: 100, y: 260, z: 0 },
      { x: 0, y: 260, z: 0 },
    ]],
  ]);

  it('deterministically derives panel-clipped artwork commands from the complete flat dieline', () => {
    const first = sampleArtworkPlan(flatGeometry);

    expect(sampleArtworkPlan(flatGeometry)).toEqual(first);
    expect(first.frame).toEqual({
      minX: 0,
      minY: -100,
      span: 360,
      offsetX: 40,
      offsetY: 0,
    });
    expect(first.commands.map(({ kind, panelId }) => [kind, panelId])).toEqual([
      ['rings', 'P1'],
      ['label', 'P1'],
      ['hatch', 'P2'],
      ['hatch', 'P4'],
      ['dot', 'topLid'],
      ['dot', 'bottomLid'],
    ]);
    expect(first.commands.every((command) => command.clipPolygon.length === 4)).toBe(true);
  });

  it('recomputes the centered P1 artwork when flat model dimensions change', () => {
    const widerGeometry = new Map(flatGeometry);
    widerGeometry.set('P1', [
      { x: 0, y: 0, z: 0 },
      { x: 180, y: 0, z: 0 },
      { x: 180, y: 220, z: 0 },
      { x: 0, y: 220, z: 0 },
    ]);

    const originalRings = sampleArtworkPlan(flatGeometry).commands.find(
      (command) => command.kind === 'rings',
    );
    const resizedRings = sampleArtworkPlan(widerGeometry).commands.find(
      (command) => command.kind === 'rings',
    );

    expect(originalRings).toMatchObject({ center: { x: 50, y: 80 } });
    expect(resizedRings).toMatchObject({ center: { x: 90, y: 110 } });
    expect(resizedRings).not.toEqual(originalRings);
  });
});
