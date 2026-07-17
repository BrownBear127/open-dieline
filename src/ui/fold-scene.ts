// 紙質感 noise 疊層參考 paper-design/shaders paper-texture（Apache-2.0）逐層移植
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Vec3 } from '../fold/pose3d';
import { worldGeometry } from '../fold/pose3d';
import { foldPose } from '../fold/schedule';
import type { FoldModel } from '../fold/types';

const PAPER_FALLBACK = '#FAF7F0'; // Source: src/styles/tokens.css --paper.
const CARD_COLOR = 0xffffff;
const CARD_ROUGHNESS = 0.9;
const CARD_METALNESS = 0;
const CAMERA_FOV_DEGREES = 35;
const CAMERA_FIT_DISTANCE_FACTOR = 2;
const CAMERA_ELEVATION_FACTOR = 0.28;
const CAMERA_NEAR_FACTOR = 0.001;
const CAMERA_FAR_FACTOR = 10;
const MIN_SCENE_SCALE = 1;
const MAX_PIXEL_RATIO = 2;
const SHADOW_TEXTURE_SIZE = 256;
const SHADOW_PADDING_FACTOR = 1.18;
const SHADOW_MIN_SPAN_FACTOR = 0.35;
const SHADOW_LIFT_OFFSET_FACTOR = 0.003;
const DIELINE_TO_THREE_Y = -1;
const PAPER_TEXTURE_SIZE = 512;
const PAPER_PATTERN_UNITS = 5;
const ROUGHNESS_COORDINATE_SCALE = 1.5;
const FIBER_SAMPLE_SIZE = 256;
const FIBER_SAMPLE_STRIDE = PAPER_TEXTURE_SIZE / FIBER_SAMPLE_SIZE;
const PAPER_LIGHT_VECTOR_LENGTH = Math.sqrt(6);
const ARTWORK_ACCENT = '#b3402a';
const ARTWORK_DARK = '#383530';
const ARTWORK_ALPHA = 0.88;

export function configureFoldRenderer(
  renderer: Pick<WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>,
): void {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
}

export interface PaperParams {
  contrast: number;
  roughness: number;
  fiber: number;
  fiberSize: number;
  crumples: number;
  crumpleSize: number;
  folds: number;
  foldCount: number;
  drops: number;
  fade: number;
  seed: number;
  bumpScale: number;
}

export const PAPER_PRESETS: Record<
  'subtle' | 'standard' | 'coarse',
  PaperParams
> = {
  subtle: {
    contrast: 0.4,
    roughness: 0.15,
    fiber: 0.18,
    fiberSize: 0.42,
    crumples: 0.24,
    crumpleSize: 0.42,
    folds: 0.22,
    foldCount: 4,
    drops: 0.12,
    fade: 0.28,
    seed: 1013,
    bumpScale: 0.012,
  },
  standard: {
    contrast: 0.6,
    roughness: 0.3,
    fiber: 0.3,
    fiberSize: 0.3,
    crumples: 0.5,
    crumpleSize: 0.3,
    folds: 0.5,
    foldCount: 6,
    drops: 0.3,
    fade: 0.2,
    seed: 3203,
    bumpScale: 0.022,
  },
  coarse: {
    contrast: 0.78,
    roughness: 0.48,
    fiber: 0.48,
    fiberSize: 0.2,
    crumples: 0.68,
    crumpleSize: 0.2,
    folds: 0.72,
    foldCount: 9,
    drops: 0.46,
    fade: 0.12,
    seed: 7919,
    bumpScale: 0.034,
  },
};

function paperHash(x: number, y: number, seed: number): number {
  let value = Math.imul(Math.floor(x), 374_761_393)
    + Math.imul(Math.floor(y), 668_265_263)
    + Math.imul(Math.trunc(seed * 1_000), 1_442_695_041);
  value = Math.imul(value ^ (value >>> 13), 1_274_126_177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffff_ffff;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function mix(first: number, second: number, amount: number): number {
  return first + (second - first) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clampUnit((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

function rotate2(x: number, y: number, angle: number): [number, number] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine * x - sine * y, sine * x + cosine * y];
}

function random2(x: number, y: number, seed: number): [number, number] {
  return [paperHash(x, y, seed + 19.19), paperHash(x, y, seed + 73.73)];
}

function valueNoise(
  x: number,
  y: number,
  seed: number,
): number {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const blendX = smoothstep(0, 1, fract(x));
  const blendY = smoothstep(0, 1, fract(y));
  const top = mix(
    paperHash(floorX, floorY, seed),
    paperHash(floorX + 1, floorY, seed),
    blendX,
  );
  const bottom = mix(
    paperHash(floorX, floorY + 1, seed),
    paperHash(floorX + 1, floorY + 1, seed),
    blendX,
  );
  return mix(top, bottom, blendY);
}

function fbm(x: number, y: number, seed: number): number {
  let total = 0;
  let amplitude = 0.4;
  for (let octave = 0; octave < 3; octave += 1) {
    total += valueNoise(x, y, seed) * amplitude;
    x *= 1.99;
    y *= 1.99;
    amplitude *= 0.65;
  }
  return total;
}

function roughnessNoise(x: number, y: number, seed: number): number {
  x *= 0.1;
  y *= 0.1;
  let total = 0;

  for (let octave = 0; octave < 3; octave += 1) {
    const floorX = Math.floor(x);
    const floorY = Math.floor(y);
    const ceilX = Math.ceil(x);
    const ceilY = Math.ceil(y);
    const alongYAtFloorX = mix(
      paperHash(floorX, floorY, seed),
      paperHash(floorX, ceilY, seed),
      fract(y),
    );
    const alongYAtCeilX = mix(
      paperHash(ceilX, floorY, seed),
      paperHash(ceilX, ceilY, seed),
      fract(y),
    );
    total += mix(alongYAtFloorX, alongYAtCeilX, fract(x));
    total += 0.2 / Math.exp(2 * Math.abs(Math.sin(0.2 * x + 0.5 * y)));
    x *= 2.1;
    y *= 2.1;
  }

  return total / 3;
}

function crumpledNoise(
  x: number,
  y: number,
  power: number,
  seed: number,
): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  let weightSum = 0;
  let crumple = 0;

  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const qX = cellX + offsetX;
      const qY = cellY + offsetY;
      const wrappedX = qX - Math.floor(qX / 8) * 8;
      const wrappedY = qY - Math.floor(qY / 8) * 8;
      const random = random2(wrappedX, wrappedY, seed);
      const distanceX = qX + random[0] - x;
      const distanceY = qY + random[1] - y;
      const weight = Math.pow(
        smoothstep(0, 1, 1 - Math.abs(distanceX)),
        power,
      ) * Math.pow(
        smoothstep(0, 1, 1 - Math.abs(distanceY)),
        power,
      );
      crumple += (0.5 + 0.5 * Math.sin((wrappedX + wrappedY * 5) * 8)) * weight;
      weightSum += weight;
    }
  }

  return Math.sqrt(weightSum === 0 ? 0 : crumple / weightSum) * 2;
}

function crumplesShape(x: number, y: number, seed: number): number {
  return crumpledNoise(x * 0.25, y * 0.25, 16, seed)
    * crumpledNoise(x * 0.5, y * 0.5, 2, seed);
}

function fiberNoiseFbm(x: number, y: number, seed: number): number {
  let total = 0;
  let amplitude = 1;

  for (let octave = 0; octave < 4; octave += 1) {
    [x, y] = rotate2(x, y, 0.7);
    total += valueNoise(x, y, seed) * amplitude;
    x *= 2;
    y *= 2;
    amplitude *= 0.6;
  }

  return total;
}

function fiberNoise(x: number, y: number, seed: number): number {
  const epsilon = 0.001;
  const horizontal = fiberNoiseFbm(x + epsilon, y, seed)
    - fiberNoiseFbm(x - epsilon, y, seed);
  const vertical = fiberNoiseFbm(x, y + epsilon, seed)
    - fiberNoiseFbm(x, y - epsilon, seed);
  return Math.hypot(horizontal, vertical) / (2 * epsilon);
}

function foldsNoise(
  x: number,
  y: number,
  params: PaperParams,
  seed: number,
): [number, number] {
  let nearestX = 0;
  let nearestY = 0;
  let nearestDistance = 9;
  const count = Math.min(15, Math.max(1, Math.round(params.foldCount)));

  for (let index = 0; index < count; index += 1) {
    const random = random2(index, index * params.seed, seed);
    const angle = random[0] * Math.PI * 2;
    const pointX = Math.cos(angle) * random[1];
    const pointY = Math.sin(angle) * random[1];
    const distance = Math.hypot(x - pointX, y - pointY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestX = x - pointX;
      nearestY = y - pointY;
    }
  }

  const attenuation = 1 - Math.pow(nearestDistance, 0.25);
  return [nearestX * attenuation, nearestY * attenuation];
}

function dropsNoise(x: number, y: number, params: PaperParams, seed: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const localX = fract(x);
  const localY = fract(y);
  let minimumDistance = 1;

  for (let neighborY = -1; neighborY <= 1; neighborY += 1) {
    for (let neighborX = -1; neighborX <= 1; neighborX += 1) {
      const random = random2(cellX + neighborX, cellY + neighborY, seed);
      const offsetX = 0.5 + 0.5 * Math.sin(
        10 * params.seed + Math.PI * 2 * random[0],
      );
      const offsetY = 0.5 + 0.5 * Math.sin(
        10 * params.seed + Math.PI * 2 * random[1],
      );
      const distance = Math.hypot(
        neighborX + offsetX - localX,
        neighborY + offsetY - localY,
      );
      minimumDistance = Math.min(minimumDistance, minimumDistance * distance);
    }
  }

  return 1 - smoothstep(0.05, 0.09, Math.pow(minimumDistance, 0.5));
}

interface PaperFieldSample {
  albedoAdjustment: number;
  height: number;
}

export interface PaperTextureCoordinates {
  patternX: number;
  patternY: number;
  roughnessX: number;
  roughnessY: number;
}

export function paperTextureCoordinatesAt(
  x: number,
  y: number,
): PaperTextureCoordinates {
  return {
    patternX: PAPER_PATTERN_UNITS * ((x + 0.5) / PAPER_TEXTURE_SIZE - 0.5),
    patternY: PAPER_PATTERN_UNITS * ((y + 0.5) / PAPER_TEXTURE_SIZE - 0.5),
    roughnessX: ROUGHNESS_COORDINATE_SCALE * (x + 0.5 - PAPER_TEXTURE_SIZE * 0.5),
    roughnessY: ROUGHNESS_COORDINATE_SCALE * (y + 0.5 - PAPER_TEXTURE_SIZE * 0.5),
  };
}

function fiberLayerAt(x: number, y: number, params: PaperParams): number {
  if (params.fiber === 0) return 0;

  const { patternX, patternY } = paperTextureCoordinatesAt(x, y);
  const size = Math.max(0.001, params.fiberSize);
  return 0.5 * params.fiber * (
    fiberNoise(2 / size * patternX, 2 / size * patternY, params.seed + 307) - 1
  );
}

function createFiberSamples(params: PaperParams): Float32Array {
  const rowSize = FIBER_SAMPLE_SIZE + 1;
  const samples = new Float32Array(rowSize ** 2);
  for (let y = 0; y < rowSize; y += 1) {
    for (let x = 0; x < rowSize; x += 1) {
      samples[y * rowSize + x] = fiberLayerAt(
        x * FIBER_SAMPLE_STRIDE,
        y * FIBER_SAMPLE_STRIDE,
        params,
      );
    }
  }
  return samples;
}

function interpolatedFiberAt(x: number, y: number, samples: Float32Array): number {
  const rowSize = FIBER_SAMPLE_SIZE + 1;
  const sampleX = x / FIBER_SAMPLE_STRIDE;
  const sampleY = y / FIBER_SAMPLE_STRIDE;
  const floorX = Math.floor(sampleX);
  const floorY = Math.floor(sampleY);
  const top = mix(
    samples[floorY * rowSize + floorX]!,
    samples[floorY * rowSize + floorX + 1]!,
    fract(sampleX),
  );
  const bottom = mix(
    samples[(floorY + 1) * rowSize + floorX]!,
    samples[(floorY + 1) * rowSize + floorX + 1]!,
    fract(sampleX),
  );
  return mix(top, bottom, fract(sampleY));
}

function paperFieldAt(
  x: number,
  y: number,
  params: PaperParams,
  sampledFiber?: number,
): PaperFieldSample {
  const {
    patternX,
    patternY,
    roughnessX,
    roughnessY,
  } = paperTextureCoordinatesAt(x, y);
  const roughness = roughnessNoise(roughnessX + 1, roughnessY, params.seed + 101)
    - roughnessNoise(roughnessX - 1, roughnessY, params.seed + 101);

  let crumples = 0;
  if (params.crumples !== 0) {
    const size = Math.max(0.001, params.crumpleSize);
    const crumpleX = fract(patternX * 0.02 / size - params.seed) * 32;
    const crumpleY = fract(patternY * 0.02 / size - params.seed) * 32;
    crumples = params.crumples * (
      crumplesShape(crumpleX + 0.05, crumpleY, params.seed + 211)
      - crumplesShape(crumpleX, crumpleY, params.seed + 211)
    );
  }

  let fiber = sampledFiber ?? fiberLayerAt(x, y, params);

  let [foldX, foldY] = rotate2(patternX * 0.12, patternY * 0.12, 4 * params.seed);
  let fold = foldsNoise(foldX, foldY, params, params.seed + 401);
  [foldX, foldY] = rotate2(
    foldX + 0.007 * Math.cos(params.seed),
    foldY + 0.007 * Math.cos(params.seed),
    0.01 * Math.sin(params.seed),
  );
  let secondFold = foldsNoise(foldX, foldY, params, params.seed + 401);

  let drops = params.drops * dropsNoise(
    patternX * 2,
    patternY * 2,
    params,
    params.seed + 503,
  );
  let fade = params.fade * fbm(
    0.17 * patternX + 10 * params.seed,
    0.17 * patternY + 10 * params.seed,
    params.seed + 601,
  );
  fade = clampUnit(8 * fade * fade * fade);

  const visibility = 1 - fade;
  fold = [fold[0] * visibility, fold[1] * visibility];
  secondFold = [secondFold[0] * visibility, secondFold[1] * visibility];
  crumples *= visibility;
  drops *= visibility;
  fiber *= mix(1, 0.5, fade);
  const fadedRoughness = roughness * mix(1, 0.5, fade);

  const contrast = clampUnit(params.contrast);
  const foldWeight = params.folds * Math.min(5 * contrast, 1) * 4;
  let normalX = foldWeight * Math.max(0, fold[0] + secondFold[0]);
  let normalY = foldWeight * Math.max(0, fold[1] + secondFold[1]);
  normalX += crumples + 3 * drops + params.roughness * 1.5 * fadedRoughness + fiber;
  normalY += crumples + 3 * drops + params.roughness * 1.5 * fadedRoughness + fiber;

  const normalZ = 9.5 - 9 * Math.pow(contrast, 0.1);
  const lambert = (
    normalX + 2 * normalY + normalZ
  ) / (Math.hypot(normalX, normalY, normalZ) * PAPER_LIGHT_VECTOR_LENGTH);
  const baseline = normalZ
    / (Math.abs(normalZ) * PAPER_LIGHT_VECTOR_LENGTH);

  return {
    albedoAdjustment: 0.6 * Math.pow(contrast, 0.4) * (lambert - baseline),
    height: clampUnit(0.5 + 0.035 * (normalX + normalY)),
  };
}

export function paperHeightAt(
  x: number,
  y: number,
  params: PaperParams,
): number {
  return paperFieldAt(x, y, params).height;
}

interface PaperTextureSet {
  albedo: CanvasTexture;
  bump: CanvasTexture;
}

function createPaperCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PAPER_TEXTURE_SIZE;
  canvas.height = PAPER_TEXTURE_SIZE;
  return canvas;
}

function createTexture(canvas: HTMLCanvasElement, isAlbedo: boolean): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  if (isAlbedo) texture.colorSpace = SRGBColorSpace;
  return texture;
}

function renderPaperTextures(
  params: PaperParams,
  cardColor: number,
  includeAlbedo: boolean,
  includeBump: boolean,
): { albedo: CanvasTexture | null; bump: CanvasTexture | null } {
  const albedoCanvas = includeAlbedo ? createPaperCanvas() : null;
  const bumpCanvas = includeBump ? createPaperCanvas() : null;
  const albedoContext = albedoCanvas?.getContext('2d') ?? null;
  const bumpContext = bumpCanvas?.getContext('2d') ?? null;
  const albedoImage = albedoContext?.createImageData(PAPER_TEXTURE_SIZE, PAPER_TEXTURE_SIZE);
  const bumpImage = bumpContext?.createImageData(PAPER_TEXTURE_SIZE, PAPER_TEXTURE_SIZE);
  const red = cardColor >> 16 & 0xff;
  const green = cardColor >> 8 & 0xff;
  const blue = cardColor & 0xff;

  if (albedoImage || bumpImage) {
    const fiberSamples = createFiberSamples(params);
    for (let pixel = 0; pixel < PAPER_TEXTURE_SIZE ** 2; pixel += 1) {
      const x = pixel % PAPER_TEXTURE_SIZE;
      const y = Math.floor(pixel / PAPER_TEXTURE_SIZE);
      const sample = paperFieldAt(
        x,
        y,
        params,
        interpolatedFiberAt(x, y, fiberSamples),
      );
      const offset = pixel * 4;
      if (albedoImage) {
        albedoImage.data[offset] = Math.round(
          clampUnit(red / 255 + sample.albedoAdjustment) * 255,
        );
        albedoImage.data[offset + 1] = Math.round(
          clampUnit(green / 255 + sample.albedoAdjustment) * 255,
        );
        albedoImage.data[offset + 2] = Math.round(
          clampUnit(blue / 255 + sample.albedoAdjustment) * 255,
        );
        albedoImage.data[offset + 3] = 255;
      }
      if (bumpImage) {
        const byte = Math.round(sample.height * 255);
        bumpImage.data[offset] = byte;
        bumpImage.data[offset + 1] = byte;
        bumpImage.data[offset + 2] = byte;
        bumpImage.data[offset + 3] = 255;
      }
    }
  }

  if (albedoContext && albedoImage) albedoContext.putImageData(albedoImage, 0, 0);
  if (bumpContext && bumpImage) bumpContext.putImageData(bumpImage, 0, 0);

  return {
    albedo: albedoCanvas ? createTexture(albedoCanvas, true) : null,
    bump: bumpCanvas ? createTexture(bumpCanvas, false) : null,
  };
}

function createPaperTextureSet(params: PaperParams, cardColor: number): PaperTextureSet {
  const textures = renderPaperTextures(params, cardColor, true, true);
  return { albedo: textures.albedo!, bump: textures.bump! };
}

export function createPaperAlbedoTexture(
  params: PaperParams,
  cardColor: number,
): CanvasTexture {
  return renderPaperTextures(params, cardColor, true, false).albedo!;
}

export function createPaperBumpTexture(params: PaperParams): CanvasTexture {
  return renderPaperTextures(params, CARD_COLOR, false, true).bump!;
}

export interface FoldRecipe {
  look: {
    cardColor: number;
    keyIntensity: number;
    keyColor: number;
    fillIntensity: number;
    fillColor: number;
    ambientIntensity: number;
    printOverlay: 'none';
  };
  paper: PaperParams;
}

export type FoldLook = FoldRecipe['look'];

export const FOLD_RECIPES: Record<'white' | 'kraft' | 'black', FoldRecipe> = {
  white: {
    look: {
      cardColor: 0xd1d0cc,
      keyIntensity: 2,
      keyColor: 0xffffff,
      fillIntensity: 2,
      fillColor: 0xdde8ff,
      ambientIntensity: 0.4,
      printOverlay: 'none',
    },
    paper: {
      contrast: 0.42,
      roughness: 0.23,
      fiber: 0,
      fiberSize: 0,
      crumples: 0.1,
      crumpleSize: 0,
      folds: 0.93,
      foldCount: 1,
      drops: 0,
      fade: 0.12,
      seed: 3203,
      bumpScale: 0.116,
    },
  },
  kraft: {
    look: {
      cardColor: 0x332615,
      keyIntensity: 6,
      keyColor: 0xfff1dd,
      fillIntensity: 3,
      fillColor: 0xdde8ff,
      ambientIntensity: 1.2,
      printOverlay: 'none',
    },
    paper: {
      contrast: 0.42,
      roughness: 0.23,
      fiber: 0,
      fiberSize: 0,
      crumples: 0.1,
      crumpleSize: 0,
      folds: 0.93,
      foldCount: 1,
      drops: 0,
      fade: 0.12,
      seed: 3203,
      bumpScale: 0.116,
    },
  },
  black: {
    look: {
      cardColor: 0x1c1a17,
      keyIntensity: 5,
      keyColor: 0xffffff,
      fillIntensity: 2,
      fillColor: 0xdde8ff,
      ambientIntensity: 0.35,
      printOverlay: 'none',
    },
    paper: {
      contrast: 0.36,
      roughness: 0.2,
      fiber: 0,
      fiberSize: 0,
      crumples: 0.1,
      crumpleSize: 0,
      folds: 0.93,
      foldCount: 1,
      drops: 0,
      fade: 0.12,
      seed: 3203,
      bumpScale: 0.116,
    },
  },
};

export type FoldRecipeName = keyof typeof FOLD_RECIPES;
export const FOLD_DEFAULT_RECIPE: 'kraft' = 'kraft';

function mapDielineY(y: number): number {
  if (y === 0) return 0;
  return y * DIELINE_TO_THREE_Y;
}

function writeThreeVertex(
  positions: Float32Array,
  offset: number,
  vertex: Vec3,
): void {
  positions[offset] = vertex.x;
  positions[offset + 1] = mapDielineY(vertex.y);
  positions[offset + 2] = vertex.z;
}

function writePosition(
  positions: Float32Array,
  offset: number,
  vertex: Vec3,
): void {
  positions[offset] = vertex.x;
  positions[offset + 1] = vertex.y;
  positions[offset + 2] = vertex.z;
}

function toThreeVertex(vertex: Vec3): Vec3 {
  return { x: vertex.x, y: mapDielineY(vertex.y), z: vertex.z };
}

function normalizedFaceNormal(first: Vec3, second: Vec3, third: Vec3): Vec3 | null {
  const abX = second.x - first.x;
  const abY = second.y - first.y;
  const abZ = second.z - first.z;
  const acX = third.x - first.x;
  const acY = third.y - first.y;
  const acZ = third.z - first.z;
  const normal = {
    x: abY * acZ - abZ * acY,
    y: abZ * acX - abX * acZ,
    z: abX * acY - abY * acX,
  };
  const length = Math.hypot(normal.x, normal.y, normal.z);

  if (length <= Number.EPSILON) return null;
  return {
    x: normal.x / length,
    y: normal.y / length,
    z: normal.z / length,
  };
}

function firstFaceNormal(vertices: Vec3[]): Vec3 | null {
  for (let firstIndex = 0; firstIndex < vertices.length - 2; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < vertices.length - 1; secondIndex += 1) {
      for (let thirdIndex = secondIndex + 1; thirdIndex < vertices.length; thirdIndex += 1) {
        const normal = normalizedFaceNormal(
          vertices[firstIndex]!,
          vertices[secondIndex]!,
          vertices[thirdIndex]!,
        );
        if (normal) return normal;
      }
    }
  }

  return null;
}

export interface FoldSceneOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onUserInteract?: () => void;
}

export type ArtworkMode = 'none' | 'sample';

export interface FoldSceneHandle {
  updatePose(t: number): void;
  replaceModel(model: FoldModel, opts?: { thickness?: number }): void;
  setAutoRotate(on: boolean): void;
  applyRecipe(name: FoldRecipeName): void;
  applyArtwork(mode: ArtworkMode): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface GeometryBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface ShadowPlacement {
  center: Vec3;
  size: { w: number; h: number };
}

interface ContactShadow {
  geometry: PlaneGeometry;
  material: MeshBasicMaterial;
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  texture: CanvasTexture;
}

/**
 * Fan-triangulates panel vertices while mapping dieline coordinates to Three.js.
 * Dielines use y-down coordinates; Three.js uses y-up, so y is always negated.
 */
export function panelGeometryPositions(worldVertices: Vec3[]): Float32Array {
  const triangleCount = Math.max(0, worldVertices.length - 2);
  const positions = new Float32Array(triangleCount * 9);
  const firstVertex = worldVertices[0];

  if (!firstVertex) return positions;

  let offset = 0;
  for (let index = 1; index < worldVertices.length - 1; index += 1) {
    writeThreeVertex(positions, offset, firstVertex);
    writeThreeVertex(positions, offset + 3, worldVertices[index]!);
    writeThreeVertex(positions, offset + 6, worldVertices[index + 1]!);
    offset += 9;
  }

  return positions;
}

/**
 * Builds a closed, thin panel solid in Three.js coordinates. The nominal
 * polygon remains the front face; board thickness extends behind it.
 */
export function panelSolidPositions(
  worldVertices: Vec3[],
  thickness: number,
): Float32Array {
  if (!(thickness > 0)) return panelGeometryPositions(worldVertices);

  const frontVertices = worldVertices.map(toThreeVertex);
  const normal = firstFaceNormal(frontVertices);
  if (!normal) return panelGeometryPositions(worldVertices);

  const backVertices = frontVertices.map((vertex) => ({
    x: vertex.x - normal.x * thickness,
    y: vertex.y - normal.y * thickness,
    z: vertex.z - normal.z * thickness,
  }));
  const faceTriangleCount = Math.max(0, frontVertices.length - 2);
  const sideTriangleCount = frontVertices.length * 2;
  const positions = new Float32Array(
    (faceTriangleCount * 2 + sideTriangleCount) * 9,
  );

  let offset = 0;
  for (let index = 1; index < frontVertices.length - 1; index += 1) {
    writePosition(positions, offset, frontVertices[0]!);
    writePosition(positions, offset + 3, frontVertices[index]!);
    writePosition(positions, offset + 6, frontVertices[index + 1]!);
    offset += 9;
  }

  for (let index = 1; index < backVertices.length - 1; index += 1) {
    writePosition(positions, offset, backVertices[0]!);
    writePosition(positions, offset + 3, backVertices[index + 1]!);
    writePosition(positions, offset + 6, backVertices[index]!);
    offset += 9;
  }

  for (let index = 0; index < frontVertices.length; index += 1) {
    const nextIndex = (index + 1) % frontVertices.length;
    const frontStart = frontVertices[index]!;
    const frontEnd = frontVertices[nextIndex]!;
    const backStart = backVertices[index]!;
    const backEnd = backVertices[nextIndex]!;

    writePosition(positions, offset, frontStart);
    writePosition(positions, offset + 3, backStart);
    writePosition(positions, offset + 6, backEnd);
    writePosition(positions, offset + 9, frontStart);
    writePosition(positions, offset + 12, backEnd);
    writePosition(positions, offset + 15, frontEnd);
    offset += 18;
  }

  return positions;
}

function paperColor(): Color {
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue('--paper')
    .trim();
  return new Color(token || PAPER_FALLBACK);
}

function createCardMaterial(thickness: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: CARD_COLOR,
    metalness: CARD_METALNESS,
    roughness: CARD_ROUGHNESS,
    side: thickness > 0 ? FrontSide : DoubleSide,
  });
}

export function configurePaperMaterial(
  material: MeshStandardMaterial,
  params: PaperParams,
  albedoMap: CanvasTexture,
  bumpMap: CanvasTexture,
): void {
  material.map = albedoMap;
  material.color.setHex(0xffffff);
  material.bumpMap = bumpMap;
  material.roughnessMap = null;
  material.bumpScale = params.bumpScale;
  material.needsUpdate = true;
}

export interface FlatDielineUvFrame {
  minX: number;
  minY: number;
  span: number;
  offsetX: number;
  offsetY: number;
}

interface ArtworkPoint {
  x: number;
  y: number;
}

interface ArtworkCommandBase {
  panelId: string;
  clipPolygon: ArtworkPoint[];
}

interface ArtworkRingsCommand extends ArtworkCommandBase {
  kind: 'rings';
  center: ArtworkPoint;
  radii: number[];
}

interface ArtworkLabelCommand extends ArtworkCommandBase {
  kind: 'label';
  center: ArtworkPoint;
  fontSize: number;
  text: 'SAMPLE';
}

interface ArtworkHatchCommand extends ArtworkCommandBase {
  kind: 'hatch';
  lines: Array<{ from: ArtworkPoint; to: ArtworkPoint }>;
}

interface ArtworkDotCommand extends ArtworkCommandBase {
  kind: 'dot';
  center: ArtworkPoint;
  radius: number;
}

export type SampleArtworkCommand =
  | ArtworkRingsCommand
  | ArtworkLabelCommand
  | ArtworkHatchCommand
  | ArtworkDotCommand;

export interface SampleArtworkPlan {
  frame: FlatDielineUvFrame;
  commands: SampleArtworkCommand[];
}

interface ArtworkBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function artworkPolygon(vertices: Vec3[] | undefined): ArtworkPoint[] {
  return vertices?.map(({ x, y }) => ({ x, y })) ?? [];
}

function artworkBounds(polygon: ArtworkPoint[]): ArtworkBounds | null {
  if (polygon.length === 0) return null;
  const xs = polygon.map(({ x }) => x);
  const ys = polygon.map(({ y }) => y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function artworkCenter(bounds: ArtworkBounds): ArtworkPoint {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function hatchLines(
  bounds: ArtworkBounds,
  spacing: number,
): ArtworkHatchCommand['lines'] {
  const start = Math.floor((bounds.minY - bounds.maxX) / spacing) - 1;
  const end = Math.ceil((bounds.maxY - bounds.minX) / spacing) + 1;
  const padding = bounds.maxY - bounds.minY;
  const lines: ArtworkHatchCommand['lines'] = [];

  for (let index = start; index <= end; index += 1) {
    const intercept = index * spacing;
    const fromX = bounds.minX - padding;
    const toX = bounds.maxX + padding;
    lines.push({
      from: { x: fromX, y: fromX + intercept },
      to: { x: toX, y: toX + intercept },
    });
  }
  return lines;
}

/** Derives deterministic sample-art commands in the same flat frame used by UVs. */
export function sampleArtworkPlan(
  flatGeometry: Map<string, Vec3[]>,
): SampleArtworkPlan {
  const frame = flatDielineUvFrame(flatGeometry);
  const commands: SampleArtworkCommand[] = [];
  const mainPolygon = artworkPolygon(flatGeometry.get('P1'));
  const mainBounds = artworkBounds(mainPolygon);

  if (mainBounds) {
    const center = artworkCenter(mainBounds);
    const size = Math.min(
      mainBounds.maxX - mainBounds.minX,
      mainBounds.maxY - mainBounds.minY,
    );
    commands.push({
      kind: 'rings',
      panelId: 'P1',
      clipPolygon: mainPolygon,
      center,
      radii: [0.2, 0.32, 0.44].map((ratio) => size * ratio),
    });
    commands.push({
      kind: 'label',
      panelId: 'P1',
      clipPolygon: mainPolygon,
      center,
      fontSize: size * 0.16,
      text: 'SAMPLE',
    });
  }

  for (const panelId of ['P2', 'P4']) {
    const polygon = artworkPolygon(flatGeometry.get(panelId));
    const bounds = artworkBounds(polygon);
    if (!bounds) continue;
    commands.push({
      kind: 'hatch',
      panelId,
      clipPolygon: polygon,
      lines: hatchLines(bounds, frame.span / 28),
    });
  }

  for (const [legacyPanelId, centerPanelId] of [
    ['topLid', 'topLidC'],
    ['bottomLid', 'bottomLidC'],
  ] as const) {
    const panelId = flatGeometry.has(legacyPanelId) ? legacyPanelId : centerPanelId;
    const polygon = artworkPolygon(flatGeometry.get(panelId));
    const bounds = artworkBounds(polygon);
    if (!bounds) continue;
    commands.push({
      kind: 'dot',
      panelId,
      clipPolygon: polygon,
      center: artworkCenter(bounds),
      radius: Math.min(
        bounds.maxX - bounds.minX,
        bounds.maxY - bounds.minY,
      ) * 0.08,
    });
  }

  return { frame, commands };
}

export function flatDielineUvFrame(
  flatGeometry: Map<string, Vec3[]>,
): FlatDielineUvFrame {
  const vertices = [...flatGeometry.values()].flat();
  if (vertices.length === 0) {
    return { minX: 0, minY: 0, span: 1, offsetX: 0, offsetY: 0 };
  }

  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  const span = Math.max(width, height, Number.EPSILON);

  return {
    minX,
    minY,
    span,
    offsetX: (span - width) / 2,
    offsetY: (span - height) / 2,
  };
}

function drawSampleArtwork(
  context: CanvasRenderingContext2D,
  flatGeometry: Map<string, Vec3[]>,
): void {
  const { frame, commands } = sampleArtworkPlan(flatGeometry);
  const width = context.canvas.width;
  const height = context.canvas.height;
  const toCanvas = ({ x, y }: ArtworkPoint): ArtworkPoint => ({
    x: (x - frame.minX + frame.offsetX) / frame.span * width,
    y: (y - frame.minY + frame.offsetY) / frame.span * height,
  });
  const toPixels = (value: number): number => value / frame.span * width;

  context.save();
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = ARTWORK_ALPHA;

  for (const command of commands) {
    context.save();
    context.beginPath();
    command.clipPolygon.forEach((point, index) => {
      const mapped = toCanvas(point);
      if (index === 0) context.moveTo(mapped.x, mapped.y);
      else context.lineTo(mapped.x, mapped.y);
    });
    context.closePath();
    context.clip();

    if (command.kind === 'rings') {
      const center = toCanvas(command.center);
      context.strokeStyle = ARTWORK_ACCENT;
      context.lineWidth = Math.max(2, width * 0.004);
      for (const radius of command.radii) {
        context.beginPath();
        context.arc(center.x, center.y, toPixels(radius), 0, Math.PI * 2);
        context.stroke();
      }
    } else if (command.kind === 'label') {
      const center = toCanvas(command.center);
      context.fillStyle = ARTWORK_DARK;
      context.font = `600 ${Math.max(10, toPixels(command.fontSize))}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(command.text, center.x, center.y);
    } else if (command.kind === 'hatch') {
      context.strokeStyle = ARTWORK_ACCENT;
      context.lineWidth = Math.max(1, width * 0.0025);
      context.beginPath();
      for (const line of command.lines) {
        const from = toCanvas(line.from);
        const to = toCanvas(line.to);
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
      }
      context.stroke();
    } else {
      const center = toCanvas(command.center);
      context.fillStyle = ARTWORK_ACCENT;
      context.beginPath();
      context.arc(center.x, center.y, toPixels(command.radius), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }
  context.restore();
}

function createSampleArtworkTexture(
  paperCanvas: HTMLCanvasElement,
  flatGeometry: Map<string, Vec3[]>,
): CanvasTexture {
  const canvas = createPaperCanvas();
  const context = canvas.getContext('2d');
  if (context) {
    context.drawImage(paperCanvas, 0, 0);
    drawSampleArtwork(context, flatGeometry);
  }
  return createTexture(canvas, true);
}

function flatUv(
  vertex: Pick<Vec3, 'x' | 'y'>,
  frame: FlatDielineUvFrame,
): { u: number; v: number } {
  return {
    u: (vertex.x - frame.minX + frame.offsetX) / frame.span,
    v: 1 - (vertex.y - frame.minY + frame.offsetY) / frame.span,
  };
}

export function panelSolidUvs(
  flatVertices: Vec3[],
  frame: FlatDielineUvFrame,
  thickness: number,
): Float32Array {
  const coordinates = flatVertices.map((vertex) => flatUv(vertex, frame));
  const values: number[] = [];
  const write = (index: number): void => {
    const coordinate = coordinates[index];
    if (coordinate) values.push(coordinate.u, coordinate.v);
  };

  for (let index = 1; index < coordinates.length - 1; index += 1) {
    write(0);
    write(index);
    write(index + 1);
  }
  if (!(thickness > 0)) return new Float32Array(values);

  for (let index = 1; index < coordinates.length - 1; index += 1) {
    write(0);
    write(index + 1);
    write(index);
  }
  for (let index = 0; index < coordinates.length; index += 1) {
    const nextIndex = (index + 1) % coordinates.length;
    write(index);
    write(index);
    write(nextIndex);
    write(index);
    write(nextIndex);
    write(nextIndex);
  }

  return new Float32Array(values);
}

function createContactShadow(): ContactShadow {
  const canvas = document.createElement('canvas');
  canvas.width = SHADOW_TEXTURE_SIZE;
  canvas.height = SHADOW_TEXTURE_SIZE;

  const context = canvas.getContext('2d');
  if (context) {
    const center = SHADOW_TEXTURE_SIZE / 2;
    const gradient = context.createRadialGradient(
      center,
      center,
      0,
      center,
      center,
      center,
    );
    gradient.addColorStop(0, 'rgba(25, 23, 18, 0.24)');
    gradient.addColorStop(0.48, 'rgba(25, 23, 18, 0.12)');
    gradient.addColorStop(1, 'rgba(25, 23, 18, 0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);
  }

  const texture = new CanvasTexture(canvas);
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicMaterial({
    depthWrite: false,
    map: texture,
    side: DoubleSide,
    transparent: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'fold-contact-shadow';
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;

  return { geometry, material, mesh, texture };
}

function disposeContactShadow(shadow: ContactShadow): void {
  shadow.geometry.dispose();
  shadow.material.dispose();
  shadow.texture.dispose();
}

function boundsForGeometry(
  geometryByPanel: Map<string, Vec3[]>,
): GeometryBounds | null {
  let bounds: GeometryBounds | null = null;

  for (const vertices of geometryByPanel.values()) {
    for (const vertex of vertices) {
      const y = mapDielineY(vertex.y);
      if (!bounds) {
        bounds = {
          minX: vertex.x,
          maxX: vertex.x,
          minY: y,
          maxY: y,
          minZ: vertex.z,
          maxZ: vertex.z,
        };
        continue;
      }

      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, vertex.z);
      bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
    }
  }

  return bounds;
}

function boundsDiagonal(bounds: GeometryBounds): number {
  return Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
}

/** Places a padded contact shadow on the XZ ground plane below the model. */
export function shadowPlacement(bounds: GeometryBounds): ShadowPlacement {
  const diagonal = Math.max(boundsDiagonal(bounds), MIN_SCENE_SCALE);
  const minimumSpan = diagonal * SHADOW_MIN_SPAN_FACTOR;

  return {
    center: {
      x: (bounds.minX + bounds.maxX) / 2,
      y: bounds.minY - diagonal * SHADOW_LIFT_OFFSET_FACTOR,
      z: (bounds.minZ + bounds.maxZ) / 2,
    },
    size: {
      w: Math.max(
        (bounds.maxX - bounds.minX) * SHADOW_PADDING_FACTOR,
        minimumSpan,
      ),
      h: Math.max(
        (bounds.maxZ - bounds.minZ) * SHADOW_PADDING_FACTOR,
        minimumSpan,
      ),
    },
  };
}

export interface CameraFrame {
  /** 自轉／注視軸心＝摺合完成（t=1）的盒體中心（2026-07-17 法蘭 E2E 裁決）。 */
  target: Vec3;
  /** 取景對角線＝攤平（t=0）極端外廓——相機距離／far／maxDistance 以此定，全程不出框。 */
  fitDiagonal: number;
  /** 聚焦對角線＝盒體外廓——near／minDistance 以此定，近縮放不被大紙鎖死。 */
  focusDiagonal: number;
}

export function cameraOrbitPosition(
  target: Vec3,
  distance: number,
  azimuthDeg: number,
  elevationDeg: number,
): Vec3 {
  const azimuth = azimuthDeg * Math.PI / 180;
  const elevation = elevationDeg * Math.PI / 180;
  const horizontalDistance = distance * Math.cos(elevation);

  return {
    x: target.x + horizontalDistance * Math.sin(azimuth),
    y: target.y + distance * Math.sin(elevation),
    z: target.z + horizontalDistance * Math.cos(azimuth),
  };
}

/**
 * 相機框架與「當下 pose」解耦：軸心永遠是盒體中心，不隨 replaceModel 當下的
 * t 漂移（舊行為在 scene 初始 t=0 時把軸心定在攤平大紙中心，自轉變成繞行）。
 */
export function computeCameraFrame(model: FoldModel): CameraFrame | null {
  const foldedBounds = boundsForGeometry(worldGeometry(model, foldPose(1, model)));
  const flatBounds = boundsForGeometry(worldGeometry(model, foldPose(0, model)));
  if (!foldedBounds || !flatBounds) return null;

  const focusDiagonal = boundsDiagonal(foldedBounds);
  return {
    target: {
      x: (foldedBounds.minX + foldedBounds.maxX) / 2,
      y: (foldedBounds.minY + foldedBounds.maxY) / 2,
      z: (foldedBounds.minZ + foldedBounds.maxZ) / 2,
    },
    fitDiagonal: Math.max(boundsDiagonal(flatBounds), focusDiagonal),
    focusDiagonal,
  };
}

/**
 * Creates a FoldModel-driven Three.js scene with an on-demand render loop.
 */
export function createFoldScene(
  canvas: HTMLCanvasElement,
  opts: FoldSceneOptions = {},
): FoldSceneHandle {
  let viewportWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
  let viewportHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);

  const createRenderer = (): WebGLRenderer => {
    const nextRenderer = new WebGLRenderer({ canvas, antialias: true });
    configureFoldRenderer(nextRenderer);
    nextRenderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    );
    nextRenderer.setSize(viewportWidth, viewportHeight, false);
    return nextRenderer;
  };

  let renderer = createRenderer();
  const scene = new Scene();
  scene.background = paperColor();

  const camera = new PerspectiveCamera(
    CAMERA_FOV_DEGREES,
    viewportWidth / viewportHeight,
    0.1,
    100,
  );
  camera.position.set(0, 1.5, 4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  let activeLook = FOLD_RECIPES[FOLD_DEFAULT_RECIPE].look;
  let activePaper: PaperParams = { ...FOLD_RECIPES[FOLD_DEFAULT_RECIPE].paper };
  let activeArtwork: ArtworkMode = 'none';
  const initialPaperTextures = createPaperTextureSet(activePaper, activeLook.cardColor);
  let paperBaseAlbedoTexture = initialPaperTextures.albedo;
  let paperAlbedoTexture = paperBaseAlbedoTexture;
  let paperBumpTexture = initialPaperTextures.bump;
  let keyLightBaseIntensity = activeLook.keyIntensity;
  let fillLightBaseIntensity = activeLook.fillIntensity;
  const ambient = new AmbientLight(0xffffff, activeLook.ambientIntensity);
  const keyLight = new PointLight(activeLook.keyColor, keyLightBaseIntensity);
  const fillLight = new PointLight(activeLook.fillColor, fillLightBaseIntensity);
  const keyLightOffset = new Vector3(-0.42, 0.48, -0.58);
  const fillLightOffset = new Vector3(0.52, 0.08, -0.36);
  scene.add(ambient, keyLight, fillLight);

  const panelRoot = new Group();
  panelRoot.name = 'fold-panel-root';
  scene.add(panelRoot);

  let contactShadow = createContactShadow();
  scene.add(contactShadow.mesh);

  const panelMeshes = new Map<
    string,
    Mesh<BufferGeometry, MeshStandardMaterial>
  >();
  let panelMaterial: MeshStandardMaterial | null = null;
  let currentModel: FoldModel | null = null;
  let currentThickness = 0;
  let currentT = 0;
  let frameId: number | null = null;
  let needsRender = true;
  let contextLost = false;
  let disposed = false;

  const disposePanelTree = (): void => {
    for (const mesh of panelMeshes.values()) {
      mesh.geometry.dispose();
    }
    panelMeshes.clear();
    panelRoot.clear();
    panelMaterial?.dispose();
    panelMaterial = null;
  };

  const buildPanelTree = (model: FoldModel): void => {
    panelMaterial = createCardMaterial(currentThickness);
    configurePaperMaterial(
      panelMaterial,
      activePaper,
      paperAlbedoTexture,
      paperBumpTexture,
    );
    const geometryByPanel = worldGeometry(model, foldPose(currentT, model));
    const flatGeometryByPanel = worldGeometry(model, foldPose(0, model));
    const uvFrame = flatDielineUvFrame(flatGeometryByPanel);

    for (const panel of model.panels) {
      const geometry = new BufferGeometry();
      const vertices = geometryByPanel.get(panel.id) ?? [];
      const flatVertices = flatGeometryByPanel.get(panel.id) ?? [];
      const positions = panelSolidPositions(vertices, currentThickness);
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute(
        'uv',
        new BufferAttribute(
          panelSolidUvs(flatVertices, uvFrame, currentThickness),
          2,
        ),
      );

      const mesh = new Mesh(geometry, panelMaterial);
      mesh.name = `fold-panel:${panel.id}`;
      mesh.userData.panelId = panel.id;
      panelMeshes.set(panel.id, mesh);
      panelRoot.add(mesh);
    }
  };

  const updateContactShadow = (bounds: GeometryBounds): void => {
    const placement = shadowPlacement(bounds);

    contactShadow.mesh.position.set(
      placement.center.x,
      placement.center.y,
      placement.center.z,
    );
    contactShadow.mesh.scale.set(placement.size.w, placement.size.h, 1);
  };

  const updateModelPose = (): GeometryBounds | null => {
    if (!currentModel) return null;

    const pose = foldPose(currentT, currentModel);
    const geometryByPanel = worldGeometry(currentModel, pose);

    for (const panel of currentModel.panels) {
      const mesh = panelMeshes.get(panel.id);
      const vertices = geometryByPanel.get(panel.id);
      if (!mesh || !vertices) continue;

      const attribute = mesh.geometry.getAttribute('position') as BufferAttribute;
      attribute.copyArray(panelSolidPositions(vertices, currentThickness));
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }

    const bounds = boundsForGeometry(geometryByPanel);
    if (bounds) updateContactShadow(bounds);
    needsRender = true;
    return bounds;
  };

  const fitCamera = (frame: CameraFrame): void => {
    const fitDiagonal = Math.max(frame.fitDiagonal, MIN_SCENE_SCALE);
    const focusDiagonal = Math.max(frame.focusDiagonal, MIN_SCENE_SCALE);
    const cameraDistance = fitDiagonal * CAMERA_FIT_DISTANCE_FACTOR;

    controls.target.set(frame.target.x, frame.target.y, frame.target.z);
    camera.position.set(
      frame.target.x,
      frame.target.y + fitDiagonal * CAMERA_ELEVATION_FACTOR,
      frame.target.z + cameraDistance,
    );
    camera.near = Math.max(focusDiagonal * CAMERA_NEAR_FACTOR, 0.01);
    camera.far = Math.max(fitDiagonal * CAMERA_FAR_FACTOR, 100);
    camera.updateProjectionMatrix();
    controls.minDistance = focusDiagonal * 0.2;
    controls.maxDistance = fitDiagonal * 6;
    controls.update();
  };

  const updateLightRig = (): void => {
    const distance = Math.max(
      camera.position.distanceTo(controls.target),
      MIN_SCENE_SCALE,
    );
    const intensityScale = distance * distance;

    // Codrops camera-relative rig: offsets rotate with the camera quaternion.
    keyLight.position
      .copy(keyLightOffset)
      .multiplyScalar(distance)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);
    fillLight.position
      .copy(fillLightOffset)
      .multiplyScalar(distance)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);
    keyLight.intensity = keyLightBaseIntensity * intensityScale;
    fillLight.intensity = fillLightBaseIntensity * intensityScale;
  };

  const renderFrame = (): void => {
    frameId = null;
    if (disposed || contextLost) return;

    const controlsChanged = controls.update();
    if (needsRender || controlsChanged || controls.autoRotate) {
      updateLightRig();
      renderer.render(scene, camera);
      needsRender = false;
    }

    if (controlsChanged || controls.autoRotate) scheduleRender();
  };

  function scheduleRender(): void {
    if (disposed || contextLost || frameId !== null) return;
    frameId = requestAnimationFrame(renderFrame);
  }

  const markNeedsRender = (): void => {
    needsRender = true;
    scheduleRender();
  };

  const applyLook = (look: FoldLook): void => {
    activeLook = look;
    keyLightBaseIntensity = look.keyIntensity;
    fillLightBaseIntensity = look.fillIntensity;
    keyLight.color.setHex(look.keyColor);
    fillLight.color.setHex(look.fillColor);
    ambient.intensity = look.ambientIntensity;
    updateLightRig();
  };

  const createActiveAlbedoTexture = (): CanvasTexture => {
    if (activeArtwork === 'none' || currentModel === null) {
      return paperBaseAlbedoTexture;
    }
    const flatGeometry = worldGeometry(currentModel, foldPose(0, currentModel));
    return createSampleArtworkTexture(
      paperBaseAlbedoTexture.image as HTMLCanvasElement,
      flatGeometry,
    );
  };

  const refreshArtworkAlbedo = (): void => {
    const previousAlbedoTexture = paperAlbedoTexture;
    paperAlbedoTexture = createActiveAlbedoTexture();
    if (panelMaterial) {
      configurePaperMaterial(
        panelMaterial,
        activePaper,
        paperAlbedoTexture,
        paperBumpTexture,
      );
    }
    if (previousAlbedoTexture !== paperBaseAlbedoTexture) {
      previousAlbedoTexture.dispose();
    }
    markNeedsRender();
  };

  const applyPaper = (params: PaperParams): void => {
    const nextParams = { ...params };
    const nextTextures = createPaperTextureSet(nextParams, activeLook.cardColor);
    const previousBaseAlbedoTexture = paperBaseAlbedoTexture;
    const previousAlbedoTexture = paperAlbedoTexture;
    const previousBumpTexture = paperBumpTexture;

    activePaper = nextParams;
    paperBaseAlbedoTexture = nextTextures.albedo;
    paperAlbedoTexture = createActiveAlbedoTexture();
    paperBumpTexture = nextTextures.bump;
    if (panelMaterial) {
      configurePaperMaterial(
        panelMaterial,
        activePaper,
        paperAlbedoTexture,
        paperBumpTexture,
      );
    }
    if (previousAlbedoTexture !== previousBaseAlbedoTexture) {
      previousAlbedoTexture.dispose();
    }
    previousBaseAlbedoTexture.dispose();
    previousBumpTexture.dispose();
    markNeedsRender();
  };

  const applyRecipe = (name: FoldRecipeName): void => {
    const recipe = FOLD_RECIPES[name];
    applyLook(recipe.look);
    applyPaper(recipe.paper);
  };

  const applyArtwork = (mode: ArtworkMode): void => {
    if (mode === activeArtwork) return;
    activeArtwork = mode;
    refreshArtworkAlbedo();
  };

  let devSetLook: ((name: FoldRecipeName) => void) | null = null;
  let devSetCameraOrbit: ((azimuthDeg: number, elevationDeg: number) => void) | null = null;
  if (import.meta.env.DEV) {
    devSetLook = applyRecipe;
    devSetCameraOrbit = (azimuthDeg: number, elevationDeg: number) => {
      const target = {
        x: controls.target.x,
        y: controls.target.y,
        z: controls.target.z,
      };
      const position = cameraOrbitPosition(
        target,
        camera.position.distanceTo(controls.target),
        azimuthDeg,
        elevationDeg,
      );
      camera.position.set(position.x, position.y, position.z);
      controls.update();
      markNeedsRender();
    };
    (window as unknown as Record<string, unknown>).__p3SetLook = devSetLook;
    (window as unknown as Record<string, unknown>).__p3SetCameraOrbit = devSetCameraOrbit;
  }

  const resize = (width: number, height: number): void => {
    viewportWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
    viewportHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
    camera.aspect = viewportWidth / viewportHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewportWidth, viewportHeight, false);
    markNeedsRender();
  };

  const onControlsChange = (): void => markNeedsRender();
  const onControlsStart = (): void => {
    controls.autoRotate = false;
    opts.onUserInteract?.();
    markNeedsRender();
  };
  controls.addEventListener('change', onControlsChange);
  controls.addEventListener('start', onControlsStart);

  const cancelRenderLoop = (): void => {
    if (frameId === null) return;
    cancelAnimationFrame(frameId);
    frameId = null;
  };

  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed) return;
    contextLost = true;
    cancelRenderLoop();
    opts.onContextLost?.();
  };

  const onContextRestored = (): void => {
    if (disposed) return;

    renderer.dispose();
    renderer = createRenderer();

    scene.remove(contactShadow.mesh);
    disposeContactShadow(contactShadow);
    contactShadow = createContactShadow();
    scene.add(contactShadow.mesh);

    scene.remove(panelRoot);
    disposePanelTree();
    if (currentModel) {
      buildPanelTree(currentModel);
      updateModelPose();
    }
    scene.add(panelRoot);

    contextLost = false;
    markNeedsRender();
    opts.onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  scheduleRender();

  return {
    updatePose(t) {
      currentT = Number.isFinite(t) ? t : 0;
      updateModelPose();
      scheduleRender();
    },
    replaceModel(model, replaceOpts = {}) {
      currentModel = model;
      currentThickness = replaceOpts.thickness ?? 0;
      disposePanelTree();
      if (activeArtwork === 'sample') refreshArtworkAlbedo();
      buildPanelTree(model);
      updateModelPose();
      const frame = computeCameraFrame(model);
      if (frame) fitCamera(frame);
      markNeedsRender();
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
      markNeedsRender();
    },
    applyRecipe,
    applyArtwork,
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (
        import.meta.env.DEV
        && devSetLook
        && (window as unknown as Record<string, unknown>).__p3SetLook === devSetLook
      ) {
        delete (window as unknown as Record<string, unknown>).__p3SetLook;
      }
      if (
        import.meta.env.DEV
        && devSetCameraOrbit
        && (window as unknown as Record<string, unknown>).__p3SetCameraOrbit === devSetCameraOrbit
      ) {
        delete (window as unknown as Record<string, unknown>).__p3SetCameraOrbit;
      }
      cancelRenderLoop();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      controls.removeEventListener('change', onControlsChange);
      controls.removeEventListener('start', onControlsStart);
      controls.dispose();
      disposePanelTree();
      if (paperAlbedoTexture !== paperBaseAlbedoTexture) {
        paperAlbedoTexture.dispose();
      }
      paperBaseAlbedoTexture.dispose();
      paperBumpTexture.dispose();
      disposeContactShadow(contactShadow);
      scene.clear();
      renderer.dispose();
      currentModel = null;
    },
  };
}
