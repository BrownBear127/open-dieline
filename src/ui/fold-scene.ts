// 紙質感 noise 疊層參考 paper-design/shaders paper-texture（Apache-2.0）逐層移植
import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  LineBasicMaterial,
  LineSegments,
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
import type { Transform, Vec3 } from '../fold/pose3d';
import {
  applyTransform,
  panelWorldTransform,
  worldGeometry,
} from '../fold/pose3d';
import { evaluateResolvedScenePiecePose } from '../fold/scene-pose';
import type {
  ResolvedScenePiece,
  ResolvedSceneSpec,
} from '../fold/scene-spec';
import { foldPose } from '../fold/schedule';
import type { FoldModel } from '../fold/types';
import {
  modelYToThree,
  modelVertexToThree,
  modelVertexToWorld,
  SCENE_TO_WORLD_QUATERNIONS,
  type FoldWorldUp,
} from '../fold/world-orientation';
import {
  PAPER_RECIPE_BASE_COLORS,
  type FoldRecipeName,
} from './fold-paper-colors';

// flatDielineUvFrame 由 ArtworkLayout 抽取層提供（TEMPLATE 與 3D UV
// 共用同一份 square frame 真相源）。這裡 import 再 re-export 回同名稱——
// 既有 fold-scene-geometry/fold-paper-texture 兩份測試 `import { flatDielineUvFrame }
// from '@/ui/fold-scene'` 零改動，且拿到的仍是同一顆 function reference（不是各自
// 維護一份公式）。
import { deriveArtworkLayout, flatDielineUvFrame } from './artwork-layout';
import type { ArtworkLayout, FlatDielineUvFrame } from './artwork-layout';
import { earClipIndices } from './triangulate';

export { flatDielineUvFrame };
export type { FlatDielineUvFrame };
export type { FoldRecipeName } from './fold-paper-colors';

const PAPER_FALLBACK = '#FAF7F0'; // Source: src/styles/tokens.css --paper.
const UNTINTED_MATERIAL_COLOR = 0xffffff;
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
const PAPER_TEXTURE_SIZE = 512;
const PAPER_PATTERN_UNITS = 5;
const ROUGHNESS_COORDINATE_SCALE = 1.5;
const FIBER_SAMPLE_SIZE = 256;
const FIBER_SAMPLE_STRIDE = PAPER_TEXTURE_SIZE / FIBER_SAMPLE_SIZE;
const PAPER_LIGHT_VECTOR_LENGTH = Math.sqrt(6);
const ARTWORK_ALPHA = 0.88;
const CUSTOM_ARTWORK_SIZE = 2048;
const SAMPLE_ARTWORK_URL = '/sample-artwork.webp';
const SEAM_COLOR = '#3a3a3a';
const SEAM_SURFACE_OFFSET_MM = 0.05;

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
  return renderPaperTextures(params, UNTINTED_MATERIAL_COLOR, false, true).bump!;
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

export const FOLD_RECIPES: Record<FoldRecipeName, FoldRecipe> = {
  white: {
    look: {
      cardColor: PAPER_RECIPE_BASE_COLORS.white,
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
      cardColor: PAPER_RECIPE_BASE_COLORS.kraft,
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
      cardColor: PAPER_RECIPE_BASE_COLORS.black,
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

export const FOLD_DEFAULT_RECIPE: 'kraft' = 'kraft';

function mapDielineY(y: number): number {
  return modelYToThree(y);
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
  return modelVertexToThree(vertex);
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

export type PhysicalPanelFace = 'front' | 'back';

export interface FoldedPanelFaceDiagnosis {
  panelId: string;
  exteriorFace: PhysicalPanelFace;
}

export interface PanelSurfaceGroup {
  start: number;
  count: number;
  materialIndex: 0 | 1;
}

export interface PanelSurfacePlan {
  artworkSide: typeof FrontSide | typeof BackSide;
  paperSide: typeof FrontSide | typeof BackSide;
  groups: PanelSurfaceGroup[];
}

export interface PanelOverlapPlan {
  /** Signed distance along the completed-fold exterior normal. */
  normalOffset: number;
  polygonOffsetUnits: number;
  renderOrder: number;
}

const SURFACE_GAP_MM = 0.05;

function verticesCenter(vertices: Vec3[]): Vec3 {
  return vertices.reduce((center, vertex) => ({
    x: center.x + vertex.x / vertices.length,
    y: center.y + vertex.y / vertices.length,
    z: center.z + vertex.z / vertices.length,
  }), { x: 0, y: 0, z: 0 });
}

/** Classifies the completed FoldModel face whose normal points away from the box center. */
export function diagnoseFoldedPanelFaces(model: FoldModel): FoldedPanelFaceDiagnosis[] {
  // 面朝向是剛體紙面性質——用名義（未收束）幾何診斷，避免 vertexClamp 移動
  // 前三頂點時翻轉 firstFaceNormal 的三角形。
  const geometry = worldGeometry(model, foldPose(1, model), { applyVertexClamp: false });
  const allVertices = [...geometry.values()].flat();
  const xs = allVertices.map(({ x }) => x);
  const ys = allVertices.map(({ y }) => y);
  const zs = allVertices.map(({ z }) => z);
  const boxCenter = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
  };

  return model.panels.map(({ id }) => {
    const vertices = geometry.get(id) ?? [];
    const normal = firstFaceNormal(vertices);
    if (normal === null) throw new Error(`Cannot diagnose folded face for panel "${id}"`);
    const center = verticesCenter(vertices);
    const outward = {
      x: center.x - boxCenter.x,
      y: center.y - boxCenter.y,
      z: center.z - boxCenter.z,
    };
    const score = normal.x * outward.x + normal.y * outward.y + normal.z * outward.z;
    return { panelId: id, exteriorFace: score > 0 ? 'front' : 'back' };
  });
}

function selectArtworkFace(
  model: FoldModel,
  diagnoses: FoldedPanelFaceDiagnosis[],
): PhysicalPanelFace {
  const frontCount = diagnoses.filter(({ exteriorFace }) => exteriorFace === 'front').length;
  const backCount = diagnoses.length - frontCount;
  if (frontCount !== backCount) return frontCount > backCount ? 'front' : 'back';

  const rootId = model.panels.find(({ parent }) => parent === null)?.id;
  return diagnoses.find(({ panelId }) => panelId === rootId)?.exteriorFace ?? 'back';
}

/** Selects one physical sheet side; a tied mixed model follows its root panel. */
export function foldedArtworkFace(model: FoldModel): PhysicalPanelFace {
  return selectArtworkFace(model, diagnoseFoldedPanelFaces(model));
}

/** Maps FoldModel physical faces onto the y-reflected, non-indexed renderer geometry. */
export function panelSurfacePlan(
  vertexCount: number,
  thickness: number,
  artworkFace: PhysicalPanelFace,
  faceVertexCount = Math.max(0, vertexCount - 2) * 3,
): PanelSurfacePlan {
  const artworkUsesFirstGroup = artworkFace === 'back';

  if (!(thickness > 0)) {
    return {
      artworkSide: artworkUsesFirstGroup ? FrontSide : BackSide,
      paperSide: artworkUsesFirstGroup ? BackSide : FrontSide,
      groups: [
        { start: 0, count: faceVertexCount, materialIndex: 0 },
        { start: 0, count: faceVertexCount, materialIndex: 1 },
      ],
    };
  }

  return {
    artworkSide: FrontSide,
    paperSide: FrontSide,
    groups: [
      { start: 0, count: faceVertexCount, materialIndex: artworkUsesFirstGroup ? 0 : 1 },
      {
        start: faceVertexCount,
        count: faceVertexCount,
        materialIndex: artworkUsesFirstGroup ? 1 : 0,
      },
      { start: faceVertexCount * 2, count: vertexCount * 6, materialIndex: 1 },
    ],
  };
}

function telescopePanelLayer(panelId: string): number | null {
  if (/^wingX(?:Neg|Pos){2}$/.test(panelId)) return -6;
  if (/^wingY(?:Neg|Pos){2}$/.test(panelId)) return -5;
  if (/^wall[XY](?:Neg|Pos)-outer$/.test(panelId)) return -4;
  if (/^wall[XY](?:Neg|Pos)-rim$/.test(panelId)) return -2;
  if (/^flapNeg(?:Neg|Pos)$/.test(panelId)) return 9;
  if (/^flapPos(?:Neg|Pos)$/.test(panelId)) return 10;
  // P0 extension 的 C-ext 終態在相鄰 y 壁上；-4 < 7 < 8 明確形成
  // wallY outer / extension / wallY inner 三明治（piece 前綴由呼叫端保留）。
  if (/^gussetExt(?:Neg|Pos){2}$/.test(panelId)) return 7;
  if (/^wall[XY](?:Neg|Pos)-inner$/.test(panelId)) return 8;
  if (/^wall[XY](?:Neg|Pos)-tongue$/.test(panelId)) return 9;
  return null;
}

/** Keeps physical closure layers separate without changing their flat polygons. */
export function panelOverlapPlan(scopedPanelId: string, thickness: number): PanelOverlapPlan {
  const panelId = scopedPanelId.includes(':')
    ? scopedPanelId.slice(scopedPanelId.indexOf(':') + 1)
    : scopedPanelId;
  // A full board thickness changes the physical layer; the extra gap prevents the two
  // touching solid faces from remaining coplanar. Zero-thickness card keeps the same gap.
  const layerOffset = Math.max(0, thickness) + SURFACE_GAP_MM;
  const telescopeLayer = telescopePanelLayer(panelId);
  if (telescopeLayer !== null) {
    return {
      normalOffset: telescopeLayer * layerOffset,
      polygonOffsetUnits: -telescopeLayer,
      renderOrder: telescopeLayer,
    };
  }

  const isTuck = panelId === 'topTuck' || panelId === 'bottomTuck';
  if (isTuck) {
    // A right-side glue flap overlaps topTuck after closure, so tucks occupy a
    // second inner layer instead of sharing the glue layer.
    return { normalOffset: -2 * layerOffset, polygonOffsetUnits: 0, renderOrder: -2 };
  }

  if (panelId === 'glue') {
    return { normalOffset: -layerOffset, polygonOffsetUnits: 1, renderOrder: -1 };
  }

  if (panelId === 'topDustP2' || panelId === 'topDustP4') {
    // 防塵翼摺序最早（activeSteps t0.6-0.72，先於 topTuck 0.72-0.85/0.84-0.92，
    // 更先於 topLid 0.85-1/0.92-1），物理上被 tuck、lid 依序蓋在外側，需要
    // 給專屬非零層，量級延續 topTuck 的 -2×layerOffset
    // 往內再退一階（-3×layerOffset／renderOrder -3），維持
    // dust < topTuck < topLid 的雙軸（normalOffset + renderOrder）相對關係。
    return { normalOffset: -3 * layerOffset, polygonOffsetUnits: 1, renderOrder: -3 };
  }

  // ttsl 底部 1-2-3 snap-lock 四片組——這四片彼此兩兩交疊（見
  // fold-overlap-diagnosis.test.ts 的 overlappingPairs），若都落下方的通用
  // fallback（0,0,0）會直接同層互撞、必破圖。分層依底部堆疊順序：
  // bottomReceiveP3（底層）< bottomLockP1（上層·視覺呈現「插進 P3 之上」）
  // < bottomWebP2/bottomWebP4（各自獨立層，兩者本身不交疊但仍分開，防未來
  // 幾何微調後意外重疊）。
  if (panelId === 'bottomReceiveP3') {
    // U 缺口接收片位於鎖片下層。
    return { normalOffset: -layerOffset, polygonOffsetUnits: 1, renderOrder: -1 };
  }

  if (panelId === 'bottomLockP1') {
    // 梯形鎖片摺序最後、尖端插進 P3 缺口——視覺呈現在 receive 之上，比照 RTE
    // lid（同樣是摺序最後、蓋在其餘層之上的最外層）偏移慣例。
    return { normalOffset: layerOffset, polygonOffsetUnits: 0, renderOrder: 1 };
  }

  if (panelId === 'bottomWebP2') {
    return { normalOffset: 2 * layerOffset, polygonOffsetUnits: -1, renderOrder: 2 };
  }

  if (panelId === 'bottomWebP4') {
    return { normalOffset: 3 * layerOffset, polygonOffsetUnits: -2, renderOrder: 3 };
  }

  // ttb（triangular-tube）沒有 lid/tuck/glue 詞彙，id（faceA/zoneDBase/endStartMain
  // 等）與 RTE/ttsl 無撞名，可安全獨立分支。盒身 faceA/faceB/faceC
  // 維持下方通用 fallback（0,0,0）當基準層——比照 RTE/ttsl 主體面板（P1/P4 等）慣例，
  // 只有蓋在主體上的附加片才需要專屬層。內外層序：
  //   zoneDTab（−2）< zoneDBase（−1）< faceA/faceB/faceC（0）
  //     < zoneDLip/endStartMain/endEndMain（+1）< 四 wing（+2）
  // normalOffset／renderOrder 兩軸同向遞增（避免單軸成立、另一軸反向導致繪製順序
  // 出錯）；polygonOffsetUnits 沿用既有反向遞減慣例。
  if (panelId === 'zoneDBase') {
    // 摺到 faceA 內側、蓋在 faceA 上——內側負層。
    return { normalOffset: -layerOffset, polygonOffsetUnits: 1, renderOrder: -1 };
  }

  if (panelId === 'zoneDTab') {
    // 穿過 slot 後進入盒內——比 zoneDBase 更內一層。
    return { normalOffset: -2 * layerOffset, polygonOffsetUnits: 2, renderOrder: -2 };
  }

  if (panelId === 'zoneDLip') {
    // 虛擬摺線把 lip 貼到 faceB 外側；與 faceB 基準層分開，避免共面閃爍。
    return { normalOffset: layerOffset, polygonOffsetUnits: -1, renderOrder: 1 };
  }

  if (panelId === 'endStartMain' || panelId === 'endEndMain') {
    // 立在端面——正層，比盒身（0）高一階。
    return { normalOffset: layerOffset, polygonOffsetUnits: -1, renderOrder: 1 };
  }

  const isTtbWing =
    panelId === 'endStartWingTop' ||
    panelId === 'endStartWingBottom' ||
    panelId === 'endEndWingTop' ||
    panelId === 'endEndWingBottom';
  if (isTtbWing) {
    // 防塵翼收盒內（藏在端蓋後·實體盒裝配驗證：翼外露即破圖）：零厚度下
    // 翼與側面共面，內/外純屬堆疊層序——負層讓 faceA/faceC 從外側蓋住翼。
    return { normalOffset: -2 * layerOffset, polygonOffsetUnits: 2, renderOrder: -2 };
  }

  const isLid = panelId === 'topLid' || panelId === 'bottomLid';
  if (!isLid) {
    return { normalOffset: 0, polygonOffsetUnits: 0, renderOrder: 0 };
  }

  return { normalOffset: layerOffset, polygonOffsetUnits: 0, renderOrder: 1 };
}

/** 非 root 的零摺角 rider 片透過 pose3d.ts 的 FK 恆等變換跟著 parent 剛體共動，
 * 本身沒有真實摺疊角度可用。
 * `panelRenderVertices` 對這類片的完成度訊號改用這裡算出的「parent 摺到多開」，
 * 呼叫端已經有 `pose`／`model`，不必在這裡重跑一次 schedule。一般（有真實 hinge）
 * 面板用不到這個值——`panelRenderVertices` 只在 `panel.foldAngle === 0` 時才會參考它。 */
export function parentFoldCompletion(
  panel: FoldModel['panels'][number],
  model: FoldModel,
  pose: Map<string, number>,
): number {
  if (panel.parent === null) return 0;
  const parent = model.panels.find((candidate) => candidate.id === panel.parent);
  if (!parent || parent.foldAngle === 0) return 0;
  const parentAngle = pose.get(parent.id) ?? 0;
  return Math.min(1, Math.abs(parentAngle) / Math.abs(parent.foldAngle));
}

/** Applies the render-only stacking distance as the panel approaches its folded pose.
 * `normalReference`：層位移方向屬剛體性質；vertexClamp 收束後的頂點可能讓 first-face
 * 三角形退化或翻轉（與 diagnoseFoldedPanelFaces 用名義幾何同理），呼叫端可另供
 * 未收束的名義頂點當方向來源。 */
export function panelRenderVertices(
  panel: FoldModel['panels'][number],
  vertices: Vec3[],
  angle: number,
  exteriorFace: PhysicalPanelFace,
  thickness: number,
  parentCompletion = 0,
  normalReference: Vec3[] = vertices,
): Vec3[] {
  const { normalOffset } = panelOverlapPlan(panel.id, thickness);
  if (normalOffset === 0) return vertices;
  // root 面板恆 foldAngle=0、無 parent 可跟——攤平時不推開。
  if (panel.foldAngle === 0 && panel.parent === null) return vertices;

  // 非 root 的 foldAngle=0 rider 自身角度恆為 0，完成度改跟 parent；
  // 一般面板仍用自身角度 / 自身 foldAngle 的比值。
  const foldCompletion =
    panel.foldAngle === 0
      ? Math.min(1, Math.max(0, parentCompletion))
      : Math.min(1, Math.abs(angle) / Math.abs(panel.foldAngle));
  if (foldCompletion === 0) return vertices;

  const normal = firstFaceNormal(normalReference);
  if (normal === null) return vertices;
  const exteriorDirection = exteriorFace === 'front' ? 1 : -1;
  const distance = normalOffset * foldCompletion * exteriorDirection;
  return vertices.map((vertex) => ({
    x: vertex.x + normal.x * distance,
    y: vertex.y + normal.y * distance,
    z: vertex.z + normal.z * distance,
  }));
}

export interface PanelRenderPoseContext {
  model: FoldModel;
  worldGeometryByPanel: ReadonlyMap<string, Vec3[]>;
  /** 實際送進 mesh buffer 的逐頂點座標（含 vertexClamp 收束＋顯示層位移）。
   * mesh 路徑必須吃這份，不得從 panel.polygon 重算——重算會繞過收束
   * （端封件曾因此在畫面上凸出 2.3mm 而數值閘門全綠）。 */
  renderedVerticesByPanel: ReadonlyMap<string, Vec3[]>;
  worldTransformByPanel: ReadonlyMap<string, Transform>;
  renderOffsetByPanel: ReadonlyMap<string, Vec3>;
}

/** 建立同一幀內 panel 與 seam 共用的世界變換及顯示層位移。 */
export function createPanelRenderPoseContext(
  model: FoldModel,
  pose: Map<string, number>,
  thickness: number,
  knownExteriorFaces?: ReadonlyMap<string, PhysicalPanelFace>,
): PanelRenderPoseContext {
  const worldGeometryByPanel = worldGeometry(model, pose);
  // 層位移的方向來源：未收束的名義幾何（剛體性質；收束頂點可能讓 first-face 退化/翻轉）。
  const nominalGeometryByPanel = worldGeometry(model, pose, { applyVertexClamp: false });
  const exteriorFaces = knownExteriorFaces ?? new Map(
    diagnoseFoldedPanelFaces(model).map(({ panelId, exteriorFace }) => [panelId, exteriorFace]),
  );
  const renderedVerticesByPanel = new Map<string, Vec3[]>();
  const worldTransformByPanel = new Map<string, Transform>();
  const renderOffsetByPanel = new Map<string, Vec3>();

  for (const panel of model.panels) {
    const worldVertices = worldGeometryByPanel.get(panel.id) ?? [];
    const renderedVertices = panelRenderVertices(
      panel,
      worldVertices,
      pose.get(panel.id) ?? 0,
      exteriorFaces.get(panel.id) ?? 'back',
      thickness,
      parentFoldCompletion(panel, model, pose),
      nominalGeometryByPanel.get(panel.id) ?? worldVertices,
    );
    renderedVerticesByPanel.set(panel.id, renderedVertices);
    const worldAnchor = worldVertices[0];
    const renderedAnchor = renderedVertices[0];
    worldTransformByPanel.set(panel.id, panelWorldTransform(model, pose, panel.id));
    renderOffsetByPanel.set(panel.id, worldAnchor && renderedAnchor
      ? {
          x: renderedAnchor.x - worldAnchor.x,
          y: renderedAnchor.y - worldAnchor.y,
          z: renderedAnchor.z - worldAnchor.z,
        }
      : { x: 0, y: 0, z: 0 });
  }

  return {
    model,
    worldGeometryByPanel,
    renderedVerticesByPanel,
    worldTransformByPanel,
    renderOffsetByPanel,
  };
}

/** 將 panel 攤平座標轉成含顯示層堆疊位移的世界座標。 */
export function panelRenderPoint(
  panelId: string,
  flatPoint: { x: number; y: number },
  poseContext: PanelRenderPoseContext,
): Vec3 {
  const transform = poseContext.worldTransformByPanel.get(panelId);
  const renderOffset = poseContext.renderOffsetByPanel.get(panelId);
  if (!transform || !renderOffset) {
    throw new Error(`Unknown render panel "${panelId}"`);
  }

  const worldPoint = applyTransform(transform, { ...flatPoint, z: 0 });
  return {
    x: worldPoint.x + renderOffset.x,
    y: worldPoint.y + renderOffset.y,
    z: worldPoint.z + renderOffset.z,
  };
}

/** 將 polyline 展開為 LineSegments 所需的相鄰點對。 */
export function expandPolylineSegments(points: readonly Vec3[]): Vec3[] {
  const expanded: Vec3[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    expanded.push(points[index]!, points[index + 1]!);
  }
  return expanded;
}

function renderedPanelVertices(
  panel: FoldModel['panels'][number],
  poseContext: PanelRenderPoseContext,
): Vec3[] {
  const vertices = poseContext.renderedVerticesByPanel.get(panel.id);
  if (!vertices) throw new Error(`Unknown render panel "${panel.id}"`);
  return vertices;
}

function seamLinePositions(
  seam: NonNullable<FoldModel['seams']>[number],
  poseContext: PanelRenderPoseContext,
  surfaceDirection: -1 | 1,
  assemblyDelta?: Transform,
): Float32Array {
  const panel = poseContext.model.panels.find(({ id }) => id === seam.ownerPanelId);
  if (!panel) throw new Error(`Unknown seam owner panel "${seam.ownerPanelId}"`);
  const normal = firstFaceNormal(renderedPanelVertices(panel, poseContext));
  if (!normal) throw new Error(`Cannot determine seam normal for panel "${panel.id}"`);
  const localPoints = expandPolylineSegments(
    seam.points.map((point) => panelRenderPoint(panel.id, point, poseContext)),
  );
  const points = assemblyDelta === undefined
    ? localPoints
    : localPoints.map((point) => applyTransform(assemblyDelta, point));
  const positions = new Float32Array(points.length * 3);
  const offset = SEAM_SURFACE_OFFSET_MM * surfaceDirection;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    writeThreeVertex(positions, index * 3, {
      x: point.x + normal.x * offset,
      y: point.y + normal.y * offset,
      z: point.z + normal.z * offset,
    });
  }

  return positions;
}

const P3_TEST_HOOKS_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'e2e';

export interface FoldSceneOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onUserInteract?: () => void;
}

export type ArtworkMode = 'none' | 'sample' | 'custom';

/**
 * 上傳對位 guard-rail：上傳檔宣告的對位 metadata，原樣存在
 * `CustomArtworkSource` 上（隨同一個物件一起被 FoldView 的 controlled-prop 提升
 * 機制持久化）。顯示層（FoldView）依「當前 boxId／當前 layout signature」對這份
 * metadata 即時求值＋套優先序，不在上傳當下就把警示「凍結」成固定字串——盒型/
 * 參數之後再變，警示會跟著重算（見 `evaluateArtworkWarnings`，artwork-source.ts）。
 */
export interface ArtworkAlignmentMetadata {
  /** 上傳檔宣告的 data-box-id；null＝檔案沒有這個屬性（一般手繪 SVG，非本工具模板）。 */
  boxId: string | null;
  /** 上傳檔宣告的 data-layout-hash；null＝檔案沒有這個屬性。 */
  layoutHash: string | null;
  /** 無頁框且 viewBox 長寬比偏離正方形超過容差——這是上傳當下就能確定的固定事實
   *  （不像 boxId／layoutHash 需要跟「現在」比對），故直接存布林值。 */
  aspectMismatch: boolean;
}

export interface CustomArtworkSource {
  canvas: HTMLCanvasElement;
  signature: string;
  /** 僅 SVG 上傳路徑會設置；PNG/JPEG 與編輯器合成的來源沒有這份 metadata
   *  （undefined＝「無法判斷」，顯示層不警示）。 */
  alignmentMetadata?: ArtworkAlignmentMetadata;
}

export interface FoldSceneHandle {
  updatePose(t: number): void;
  replaceModel(model: FoldModel, opts?: FoldSceneReplaceOptions): void;
  replaceScene(scene: ResolvedSceneSpec, opts?: FoldSceneReplaceOptions): void;
  setAutoRotate(on: boolean): void;
  applyRecipe(name: FoldRecipeName): void;
  applyArtwork(mode: ArtworkMode): void;
  installCustomSource(source: CustomArtworkSource): void;
  removeCustomSource(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface FoldSceneReplaceOptions {
  thickness?: number;
  worldUp?: FoldWorldUp;
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

/** 依攤平 polygon 的 triangle indices 寫入 Three.js 座標，並反轉 dieline y 軸。 */
export function panelGeometryPositions(
  worldVertices: Vec3[],
  triangleIndices: readonly number[],
): Float32Array {
  const positions = new Float32Array(triangleIndices.length * 3);
  for (let index = 0; index < triangleIndices.length; index += 1) {
    const vertex = worldVertices[triangleIndices[index]!];
    if (vertex) writeThreeVertex(positions, index * 3, vertex);
  }
  return positions;
}

/** 建立封閉薄板；名義 polygon 是正面，紙厚沿背面方向延伸。 */
export function panelSolidPositions(
  worldVertices: Vec3[],
  triangleIndices: readonly number[],
  thickness: number,
): Float32Array {
  if (!(thickness > 0)) return panelGeometryPositions(worldVertices, triangleIndices);

  const frontVertices = worldVertices.map(toThreeVertex);
  const normal = firstFaceNormal(frontVertices);
  if (!normal) return panelGeometryPositions(worldVertices, triangleIndices);

  const backVertices = frontVertices.map((vertex) => ({
    x: vertex.x - normal.x * thickness,
    y: vertex.y - normal.y * thickness,
    z: vertex.z - normal.z * thickness,
  }));
  const positions = new Float32Array(
    (triangleIndices.length * 2 + frontVertices.length * 6) * 3,
  );

  let offset = 0;
  for (const vertexIndex of triangleIndices) {
    writePosition(positions, offset, frontVertices[vertexIndex]!);
    offset += 3;
  }

  for (let index = 0; index < triangleIndices.length; index += 3) {
    writePosition(positions, offset, backVertices[triangleIndices[index]!]!);
    writePosition(positions, offset + 3, backVertices[triangleIndices[index + 2]!]!);
    writePosition(positions, offset + 6, backVertices[triangleIndices[index + 1]!]!);
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

function createCardMaterial(
  side: typeof FrontSide | typeof BackSide,
  polygonOffsetUnits = 0,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: UNTINTED_MATERIAL_COLOR,
    metalness: CARD_METALNESS,
    polygonOffset: polygonOffsetUnits !== 0,
    polygonOffsetFactor: 0,
    polygonOffsetUnits,
    roughness: CARD_ROUGHNESS,
    side,
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

function drawSampleArtwork(
  context: CanvasRenderingContext2D,
  flatGeometry: Map<string, Vec3[]>,
  image: HTMLImageElement,
): void {
  const frame = flatDielineUvFrame(flatGeometry);
  const width = context.canvas.width;
  const height = context.canvas.height;
  const toCanvas = ({ x, y }: { x: number; y: number }): { x: number; y: number } => ({
    x: (x - frame.minX + frame.offsetX) / frame.span * width,
    y: (y - frame.minY + frame.offsetY) / frame.span * height,
  });
  const pageStart = toCanvas({
    x: frame.minX - frame.offsetX,
    y: frame.minY - frame.offsetY,
  });
  const pageEnd = toCanvas({
    x: frame.minX - frame.offsetX + frame.span,
    y: frame.minY - frame.offsetY + frame.span,
  });

  context.save();
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = ARTWORK_ALPHA;
  context.drawImage(
    image,
    pageStart.x,
    pageStart.y,
    pageEnd.x - pageStart.x,
    pageEnd.y - pageStart.y,
  );
  context.restore();
}

function createSampleArtworkTexture(
  paperCanvas: HTMLCanvasElement,
  flatGeometry: Map<string, Vec3[]>,
  image: HTMLImageElement,
): CanvasTexture {
  const canvas = createPaperCanvas();
  const context = canvas.getContext('2d');
  if (context) {
    context.drawImage(paperCanvas, 0, 0);
    drawSampleArtwork(context, flatGeometry, image);
  }
  return createTexture(canvas, true);
}

export function createCustomArtworkTexture(
  paperCanvas: HTMLCanvasElement,
  source: CustomArtworkSource | null,
): CanvasTexture {
  if (source === null) throw new Error('Custom artwork source is not installed');

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CUSTOM_ARTWORK_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    context.drawImage(paperCanvas, 0, 0, CUSTOM_ARTWORK_SIZE, CUSTOM_ARTWORK_SIZE);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = ARTWORK_ALPHA;
    context.drawImage(source.canvas, 0, 0, CUSTOM_ARTWORK_SIZE, CUSTOM_ARTWORK_SIZE);
  }
  return createTexture(canvas, true);
}

export function artworkPointUv(
  vertex: Pick<Vec3, 'x' | 'y'>,
  frame: FlatDielineUvFrame,
): { u: number; v: number } {
  return {
    u: (vertex.x - frame.minX + frame.offsetX) / frame.span,
    v: 1 - (vertex.y - frame.minY + frame.offsetY) / frame.span,
  };
}

export function panelSolidUvs(
  flatVertices: ReadonlyArray<Pick<Vec3, 'x' | 'y'>>,
  triangleIndices: readonly number[],
  frame: FlatDielineUvFrame,
  thickness: number,
): Float32Array {
  const coordinates = flatVertices.map((vertex) => artworkPointUv(vertex, frame));
  const values: number[] = [];
  const write = (index: number): void => {
    const coordinate = coordinates[index];
    if (coordinate) values.push(coordinate.u, coordinate.v);
  };

  for (const index of triangleIndices) write(index);
  if (!(thickness > 0)) return new Float32Array(values);

  for (let index = 0; index < triangleIndices.length; index += 3) {
    write(triangleIndices[index]!);
    write(triangleIndices[index + 2]!);
    write(triangleIndices[index + 1]!);
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

export interface PanelArtworkUvs {
  layout: ArtworkLayout;
  uvs: Map<string, Float32Array>;
}

/** 正式 UV 輸入：panel polygons 與方形 frame 共同來自同一份 ArtworkLayout。 */
export function buildPanelArtworkUvs(
  model: FoldModel,
  thickness: number,
  triangulations?: ReadonlyMap<string, readonly number[]>,
): PanelArtworkUvs {
  const layout = deriveArtworkLayout(model);
  const uvs = new Map(layout.panels.map((panel) => [
    panel.id,
    panelSolidUvs(
      panel.polygon,
      triangulations?.get(panel.id) ?? earClipIndices(panel.polygon),
      layout.frame,
      thickness,
    ),
  ]));
  return { layout, uvs };
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
  geometryByPanel: ReadonlyMap<string, Vec3[]>,
  worldUp: FoldWorldUp,
): GeometryBounds | null {
  let bounds: GeometryBounds | null = null;

  for (const vertices of geometryByPanel.values()) {
    for (const vertex of vertices) {
      const world = modelVertexToWorld(vertex, worldUp);
      if (!bounds) {
        bounds = {
          minX: world.x,
          maxX: world.x,
          minY: world.y,
          maxY: world.y,
          minZ: world.z,
          maxZ: world.z,
        };
        continue;
      }

      bounds.minX = Math.min(bounds.minX, world.x);
      bounds.maxX = Math.max(bounds.maxX, world.x);
      bounds.minY = Math.min(bounds.minY, world.y);
      bounds.maxY = Math.max(bounds.maxY, world.y);
      bounds.minZ = Math.min(bounds.minZ, world.z);
      bounds.maxZ = Math.max(bounds.maxZ, world.z);
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
  /** OrbitControls uses the scene origin after the completed box is centered there. */
  target: Vec3;
  /** Fixed translation that places the completed-fold bounds center at the scene origin. */
  modelOffset: Vec3;
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

const TRAY_OPENING_ELEVATION_DEG = 75;
const TRAY_ASSEMBLY_ELEVATION_DEG = 30;

function smoothstepUnit(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function trayAssemblyStart(scene: ResolvedSceneSpec): number {
  const starts = scene.pieces
    .map(({ assemblyTrack }) => assemblyTrack[0]?.time)
    .filter((time): time is number => time !== undefined);
  return starts.length === 0 ? 1 : Math.min(...starts);
}

export function trayCameraElevation(
  time: number,
  assemblyStart: number,
): number {
  const normalized = assemblyStart > 0 ? time / assemblyStart : 1;
  return mix(
    TRAY_OPENING_ELEVATION_DEG,
    TRAY_ASSEMBLY_ELEVATION_DEG,
    smoothstepUnit(normalized),
  );
}


interface EvaluatedPieceRenderContext {
  assemblyDelta: Transform;
  poseContext: PanelRenderPoseContext;
}

function transformGeometryMap(
  geometry: ReadonlyMap<string, Vec3[]>,
  transform: Transform,
): Map<string, Vec3[]> {
  return new Map(
    [...geometry].map(([panelId, vertices]) => [
      panelId,
      vertices.map((vertex) => applyTransform(transform, vertex)),
    ]),
  );
}

function evaluatePieceRenderContext(
  piece: ResolvedScenePiece,
  time: number,
  thickness: number,
  knownExteriorFaces?: ReadonlyMap<string, PhysicalPanelFace>,
): EvaluatedPieceRenderContext {
  const evaluated = evaluateResolvedScenePiecePose(piece, time);
  const localContext = createPanelRenderPoseContext(
    piece.model,
    evaluated.foldAngles,
    thickness,
    knownExteriorFaces,
  );
  return {
    assemblyDelta: evaluated.assemblyDelta,
    poseContext: {
      ...localContext,
      worldGeometryByPanel: transformGeometryMap(
        localContext.worldGeometryByPanel,
        evaluated.assemblyDelta,
      ),
      renderedVerticesByPanel: transformGeometryMap(
        localContext.renderedVerticesByPanel,
        evaluated.assemblyDelta,
      ),
    },
  };
}

function mergeBounds(
  aggregate: GeometryBounds | null,
  next: GeometryBounds | null,
): GeometryBounds | null {
  if (next === null) return aggregate;
  if (aggregate === null) return { ...next };
  aggregate.minX = Math.min(aggregate.minX, next.minX);
  aggregate.maxX = Math.max(aggregate.maxX, next.maxX);
  aggregate.minY = Math.min(aggregate.minY, next.minY);
  aggregate.maxY = Math.max(aggregate.maxY, next.maxY);
  aggregate.minZ = Math.min(aggregate.minZ, next.minZ);
  aggregate.maxZ = Math.max(aggregate.maxZ, next.maxZ);
  return aggregate;
}

function sceneBoundsAt(
  scene: ResolvedSceneSpec,
  time: number,
  thickness: number,
  worldUp: FoldWorldUp,
): GeometryBounds | null {
  let bounds: GeometryBounds | null = null;
  for (const piece of scene.pieces) {
    const { poseContext } = evaluatePieceRenderContext(piece, time, thickness);
    bounds = mergeBounds(
      bounds,
      boundsForGeometry(poseContext.renderedVerticesByPanel, worldUp),
    );
  }
  return bounds;
}

const CAMERA_SWEEP_INTERVALS = 100;

function cameraSweepTimes(scene: ResolvedSceneSpec): number[] {
  const times = new Set<number>([0, 1]);
  for (let index = 0; index <= CAMERA_SWEEP_INTERVALS; index += 1) {
    times.add(index / CAMERA_SWEEP_INTERVALS);
  }
  for (const piece of scene.pieces) {
    times.add(piece.foldWindow[0]);
    times.add(piece.foldWindow[1]);
    for (const keyframe of piece.assemblyTrack) times.add(keyframe.time);
  }
  return [...times].sort((left, right) => left - right);
}

/** 多片場景以完整時間軸 sweep 合併取景，避免組裝軌中途越出 flat/final 外廓。 */
export function computeSceneCameraFrame(
  scene: ResolvedSceneSpec,
  thickness: number,
  worldUp: FoldWorldUp = 'tube',
): CameraFrame | null {
  const finalBounds = sceneBoundsAt(scene, 1, thickness, worldUp);
  if (finalBounds === null) return null;

  let sweepBounds: GeometryBounds | null = null;
  for (const time of cameraSweepTimes(scene)) {
    sweepBounds = mergeBounds(
      sweepBounds,
      sceneBoundsAt(scene, time, thickness, worldUp),
    );
  }
  if (sweepBounds === null) return null;

  const finalCenter = {
    x: (finalBounds.minX + finalBounds.maxX) / 2,
    y: (finalBounds.minY + finalBounds.maxY) / 2,
    z: (finalBounds.minZ + finalBounds.maxZ) / 2,
  };
  const focusDiagonal = boundsDiagonal(finalBounds);
  return {
    target: { x: 0, y: 0, z: 0 },
    modelOffset: {
      x: -finalCenter.x,
      y: -finalCenter.y,
      z: -finalCenter.z,
    },
    fitDiagonal: Math.max(boundsDiagonal(sweepBounds), focusDiagonal),
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
  camera.up.set(0, 1, 0);
  camera.position.set(0, 1.5, 4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  let activeLook = FOLD_RECIPES[FOLD_DEFAULT_RECIPE].look;
  let activePaper: PaperParams = { ...FOLD_RECIPES[FOLD_DEFAULT_RECIPE].paper };
  let activeArtwork: ArtworkMode = 'none';
  let customArtworkSource: CustomArtworkSource | null = null;
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

  const modelRoot = new Group();
  modelRoot.name = 'fold-model-root';
  scene.add(modelRoot);

  const sceneRoot = new Group();
  sceneRoot.name = 'fold-scene-root';
  modelRoot.add(sceneRoot);

  const panelRoot = new Group();
  panelRoot.name = 'fold-panel-root';
  sceneRoot.add(panelRoot);

  let contactShadow = createContactShadow();
  modelRoot.add(contactShadow.mesh);

  const panelMeshes = new Map<
    string,
    Mesh<BufferGeometry, MeshStandardMaterial[]>
  >();
  const panelMaterials = new Map<
    string,
    { artwork: MeshStandardMaterial; paper: MeshStandardMaterial }
  >();
  const seamMaterial = new LineBasicMaterial({
    color: SEAM_COLOR,
    opacity: 1,
    transparent: false,
  });
  type SeamLinePair = {
    negative: LineSegments<BufferGeometry, LineBasicMaterial>;
    positive: LineSegments<BufferGeometry, LineBasicMaterial>;
  };
  interface PieceRuntime {
    piece: ResolvedScenePiece;
    exteriorFaceByPanel: Map<string, PhysicalPanelFace>;
    seamLines: SeamLinePair[];
  }
  const pieceRuntimes = new Map<string, PieceRuntime>();
  const panelTriangulations = new Map<string, number[]>();
  let currentScene: ResolvedSceneSpec | null = null;
  let currentThickness = 0;
  let currentT = 0;
  let currentWorldUp: FoldWorldUp = 'tube';
  let cameraElevationScheduleActive = false;
  let cameraElevationScheduleEnd = 1;
  let frameId: number | null = null;
  let needsRender = true;
  let contextLost = false;
  let disposed = false;
  let sampleArtworkImage: HTMLImageElement | null = null;
  let sampleArtworkLoad: Promise<void> | null = null;

  const panelKey = (pieceId: string, panelId: string): string =>
    `${pieceId}:${panelId}`;

  const disposePanelTree = (): void => {
    for (const mesh of panelMeshes.values()) {
      mesh.geometry.dispose();
    }
    panelMeshes.clear();
    for (const runtime of pieceRuntimes.values()) {
      for (const { negative, positive } of runtime.seamLines) {
        negative.geometry.dispose();
        positive.geometry.dispose();
      }
    }
    panelRoot.clear();
    pieceRuntimes.clear();
    for (const { artwork, paper } of panelMaterials.values()) {
      artwork.dispose();
      paper.dispose();
    }
    panelMaterials.clear();
    panelTriangulations.clear();
  };

  const createSeamLine = (
    pieceId: string,
    seam: NonNullable<FoldModel['seams']>[number],
    seamIndex: number,
    surfaceDirection: -1 | 1,
    poseContext: PanelRenderPoseContext,
    assemblyDelta: Transform,
  ): LineSegments<BufferGeometry, LineBasicMaterial> => {
    const ownerPanelId = panelKey(pieceId, seam.ownerPanelId);
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        seamLinePositions(
          seam,
          poseContext,
          surfaceDirection,
          assemblyDelta,
        ),
        3,
      ),
    );
    const line = new LineSegments(geometry, seamMaterial);
    const surface = surfaceDirection === 1 ? 'positive' : 'negative';
    line.name = `fold-seam:${pieceId}:${seamIndex}:${surface}`;
    line.renderOrder = panelOverlapPlan(ownerPanelId, currentThickness).renderOrder;
    line.userData.ownerPanelId = ownerPanelId;
    line.userData.sourcePathId = seam.sourcePathId;
    line.userData.surfaceDirection = surfaceDirection;
    return line;
  };

  const buildPieceTree = (piece: ResolvedScenePiece): void => {
    const { model, pieceId } = piece;
    if (pieceRuntimes.has(pieceId)) {
      throw new Error(`ResolvedSceneSpec piece id 重複：「${pieceId}」`);
    }
    const pieceRoot = new Group();
    pieceRoot.name = `fold-piece:${pieceId}`;
    panelRoot.add(pieceRoot);

    const diagnoses = diagnoseFoldedPanelFaces(model);
    const artworkFace = selectArtworkFace(model, diagnoses);
    const exteriorFaceByPanel = new Map(
      diagnoses.map(({ panelId, exteriorFace }) => [panelId, exteriorFace]),
    );
    const { assemblyDelta, poseContext } = evaluatePieceRenderContext(
      piece,
      currentT,
      currentThickness,
      exteriorFaceByPanel,
    );
    const pieceTriangulations = new Map<string, number[]>();
    for (const panel of model.panels) {
      const triangleIndices = earClipIndices(panel.polygon);
      pieceTriangulations.set(panel.id, triangleIndices);
      panelTriangulations.set(panelKey(pieceId, panel.id), triangleIndices);
    }
    const panelArtworkUvs = buildPanelArtworkUvs(
      model,
      currentThickness,
      pieceTriangulations,
    );

    for (const panel of model.panels) {
      const scopedPanelId = panelKey(pieceId, panel.id);
      const geometry = new BufferGeometry();
      const triangleIndices = pieceTriangulations.get(panel.id)!;
      const vertices = renderedPanelVertices(panel, poseContext);
      const positions = panelSolidPositions(vertices, triangleIndices, currentThickness);
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute(
        'uv',
        new BufferAttribute(
          panelArtworkUvs.uvs.get(panel.id) ?? new Float32Array(),
          2,
        ),
      );
      const surfacePlan = panelSurfacePlan(
        panel.polygon.length,
        currentThickness,
        artworkFace,
        triangleIndices.length,
      );
      for (const group of surfacePlan.groups) {
        geometry.addGroup(group.start, group.count, group.materialIndex);
      }
      const overlapPlan = panelOverlapPlan(scopedPanelId, currentThickness);
      const artworkMaterial = createCardMaterial(
        surfacePlan.artworkSide,
        overlapPlan.polygonOffsetUnits,
      );
      const paperMaterial = createCardMaterial(
        surfacePlan.paperSide,
        overlapPlan.polygonOffsetUnits,
      );
      configurePaperMaterial(
        artworkMaterial,
        activePaper,
        paperAlbedoTexture,
        paperBumpTexture,
      );
      configurePaperMaterial(
        paperMaterial,
        activePaper,
        paperBaseAlbedoTexture,
        paperBumpTexture,
      );
      panelMaterials.set(scopedPanelId, {
        artwork: artworkMaterial,
        paper: paperMaterial,
      });

      const mesh = new Mesh(geometry, [artworkMaterial, paperMaterial]);
      mesh.name = `fold-panel:${scopedPanelId}`;
      mesh.renderOrder = overlapPlan.renderOrder;
      mesh.userData.panelId = scopedPanelId;
      panelMeshes.set(scopedPanelId, mesh);
      pieceRoot.add(mesh);
    }

    const seamLines: SeamLinePair[] = [];
    for (const [seamIndex, seam] of (model.seams ?? []).entries()) {
      const negative = createSeamLine(
        pieceId,
        seam,
        seamIndex,
        -1,
        poseContext,
        assemblyDelta,
      );
      const positive = createSeamLine(
        pieceId,
        seam,
        seamIndex,
        1,
        poseContext,
        assemblyDelta,
      );
      seamLines.push({ negative, positive });
      pieceRoot.add(negative, positive);
    }
    pieceRuntimes.set(pieceId, {
      piece,
      exteriorFaceByPanel,
      seamLines,
    });
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

  const updatePiecePose = (runtime: PieceRuntime): GeometryBounds | null => {
    const { piece, exteriorFaceByPanel } = runtime;
    const { model, pieceId } = piece;
    const { assemblyDelta, poseContext } = evaluatePieceRenderContext(
      piece,
      currentT,
      currentThickness,
      exteriorFaceByPanel,
    );

    for (const panel of model.panels) {
      const scopedPanelId = panelKey(pieceId, panel.id);
      const mesh = panelMeshes.get(scopedPanelId);
      const triangleIndices = panelTriangulations.get(scopedPanelId);
      if (!mesh || !triangleIndices) continue;
      const vertices = renderedPanelVertices(panel, poseContext);

      const attribute = mesh.geometry.getAttribute('position') as BufferAttribute;
      attribute.copyArray(panelSolidPositions(vertices, triangleIndices, currentThickness));
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }

    for (const [seamIndex, seam] of (model.seams ?? []).entries()) {
      const pair = runtime.seamLines[seamIndex];
      if (!pair) continue;
      for (const [surfaceDirection, line] of [
        [-1, pair.negative],
        [1, pair.positive],
      ] as const) {
        const attribute = line.geometry.getAttribute('position') as BufferAttribute;
        attribute.copyArray(seamLinePositions(
          seam,
          poseContext,
          surfaceDirection,
          assemblyDelta,
        ));
        attribute.needsUpdate = true;
        line.geometry.computeBoundingSphere();
      }
    }
    return boundsForGeometry(
      poseContext.renderedVerticesByPanel,
      currentWorldUp,
    );
  };

  const updateScenePose = (): GeometryBounds | null => {
    if (currentScene === null) return null;
    let bounds: GeometryBounds | null = null;
    for (const runtime of pieceRuntimes.values()) {
      bounds = mergeBounds(bounds, updatePiecePose(runtime));
    }
    if (bounds) updateContactShadow(bounds);
    needsRender = true;
    return bounds;
  };

  const updateScheduledCamera = (): void => {
    if (!cameraElevationScheduleActive) return;
    const target = {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    };
    const deltaX = camera.position.x - target.x;
    const deltaZ = camera.position.z - target.z;
    const azimuth = Math.atan2(deltaX, deltaZ) * 180 / Math.PI;
    const position = cameraOrbitPosition(
      target,
      camera.position.distanceTo(controls.target),
      azimuth,
      trayCameraElevation(currentT, cameraElevationScheduleEnd),
    );
    camera.position.set(position.x, position.y, position.z);
    controls.update();
    needsRender = true;
  };

  const fitCamera = (frame: CameraFrame): void => {
    const fitDiagonal = Math.max(frame.fitDiagonal, MIN_SCENE_SCALE);
    const focusDiagonal = Math.max(frame.focusDiagonal, MIN_SCENE_SCALE);
    const cameraDistance = fitDiagonal * CAMERA_FIT_DISTANCE_FACTOR;

    modelRoot.position.set(
      frame.modelOffset.x,
      frame.modelOffset.y,
      frame.modelOffset.z,
    );
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
    updateScheduledCamera();
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
    if (activeArtwork === 'none') {
      return paperBaseAlbedoTexture;
    }
    if (activeArtwork === 'custom') {
      return createCustomArtworkTexture(
        paperBaseAlbedoTexture.image as HTMLCanvasElement,
        customArtworkSource,
      );
    }
    const artworkModel = currentScene?.pieces.length === 1
      ? currentScene.pieces[0]!.model
      : null;
    if (artworkModel === null || sampleArtworkImage === null) {
      return paperBaseAlbedoTexture;
    }
    const flatGeometry = worldGeometry(artworkModel, foldPose(0, artworkModel));
    return createSampleArtworkTexture(
      paperBaseAlbedoTexture.image as HTMLCanvasElement,
      flatGeometry,
      sampleArtworkImage,
    );
  };

  const refreshArtworkAlbedo = (): void => {
    const previousAlbedoTexture = paperAlbedoTexture;
    paperAlbedoTexture = createActiveAlbedoTexture();
    for (const { artwork } of panelMaterials.values()) {
      configurePaperMaterial(
        artwork,
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

  const ensureSampleArtwork = (): void => {
    if (sampleArtworkImage !== null || sampleArtworkLoad !== null) return;
    const image = new Image();
    image.src = SAMPLE_ARTWORK_URL;
    try {
      sampleArtworkLoad = image.decode()
        .then(() => {
          if (disposed) return;
          sampleArtworkImage = image;
          if (activeArtwork === 'sample') refreshArtworkAlbedo();
        })
        .catch(() => undefined);
    } catch {
      sampleArtworkLoad = Promise.resolve();
    }
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
    for (const { artwork, paper } of panelMaterials.values()) {
      configurePaperMaterial(
        artwork,
        activePaper,
        paperAlbedoTexture,
        paperBumpTexture,
      );
      configurePaperMaterial(
        paper,
        activePaper,
        paperBaseAlbedoTexture,
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
    if (mode === 'custom' && customArtworkSource === null) {
      throw new Error('Custom artwork source is not installed');
    }
    if (mode === activeArtwork) return;
    activeArtwork = mode;
    refreshArtworkAlbedo();
    if (mode === 'sample') ensureSampleArtwork();
  };

  const installCustomSource = (source: CustomArtworkSource): void => {
    customArtworkSource = source;
    if (activeArtwork === 'custom') refreshArtworkAlbedo();
  };

  const removeCustomSource = (): void => {
    if (activeArtwork === 'custom') {
      activeArtwork = 'none';
      customArtworkSource = null;
      refreshArtworkAlbedo();
      return;
    }
    customArtworkSource = null;
  };

  let devSetLook: ((name: FoldRecipeName) => void) | null = null;
  let devSetCameraOrbit: ((azimuthDeg: number, elevationDeg: number) => void) | null = null;
  let devSetPanelVisible:
    ((panelId: string, visible: boolean) => boolean)
    | null = null;
  if (P3_TEST_HOOKS_ENABLED) {
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
    // 視覺歸因儀器：逐片顯隱＋截圖 diff 可判定「畫面上這塊像素屬於哪片 panel」
    // （殘留輪廓的 owner 認定不靠肉眼猜）。
    devSetPanelVisible = (
      panelId: string,
      visible: boolean,
    ): boolean => {
      const mesh = panelMeshes.get(panelId);
      if (!mesh) return false;
      mesh.visible = visible;
      markNeedsRender();
      return true;
    };
    (window as unknown as Record<string, unknown>).__p3SetPanelVisible =
      devSetPanelVisible;
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
    cameraElevationScheduleActive = false;
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

    modelRoot.remove(contactShadow.mesh);
    disposeContactShadow(contactShadow);
    contactShadow = createContactShadow();
    modelRoot.add(contactShadow.mesh);

    sceneRoot.remove(panelRoot);
    disposePanelTree();
    if (activeArtwork !== 'none') refreshArtworkAlbedo();
    if (currentScene) {
      for (const piece of currentScene.pieces) buildPieceTree(piece);
      updateScenePose();
    }
    sceneRoot.add(panelRoot);

    contextLost = false;
    markNeedsRender();
    opts.onContextRestored?.();
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  const replaceScene = (
    nextScene: ResolvedSceneSpec,
    replaceOpts: FoldSceneReplaceOptions = {},
  ): void => {
    currentScene = nextScene;
    currentThickness = replaceOpts.thickness ?? 0;
    currentWorldUp = replaceOpts.worldUp ?? 'tube';
    cameraElevationScheduleActive = currentWorldUp === 'tray';
    cameraElevationScheduleEnd = trayAssemblyStart(nextScene);
    const orientation = SCENE_TO_WORLD_QUATERNIONS[currentWorldUp];
    sceneRoot.quaternion.set(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );
    sceneRoot.updateMatrix();
    disposePanelTree();
    if (activeArtwork !== 'none') refreshArtworkAlbedo();
    try {
      for (const piece of nextScene.pieces) buildPieceTree(piece);
      updateScenePose();
      const frame = computeSceneCameraFrame(
        nextScene,
        currentThickness,
        currentWorldUp,
      );
      if (frame) fitCamera(frame);
      markNeedsRender();
    } catch (error) {
      disposePanelTree();
      currentScene = null;
      throw error;
    }
  };

  scheduleRender();

  return {
    updatePose(t) {
      currentT = Number.isFinite(t) ? t : 0;
      updateScenePose();
      updateScheduledCamera();
      scheduleRender();
    },
    replaceModel(model, replaceOpts = {}) {
      replaceScene({
        pieces: [{
          pieceId: 'single',
          model,
          foldWindow: [0, 1],
          assemblyTrack: [],
        }],
      }, replaceOpts);
    },
    replaceScene,
    setAutoRotate(on) {
      controls.autoRotate = on;
      markNeedsRender();
    },
    applyRecipe,
    applyArtwork,
    installCustomSource,
    removeCustomSource,
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (
        P3_TEST_HOOKS_ENABLED
        && devSetLook
        && (window as unknown as Record<string, unknown>).__p3SetLook === devSetLook
      ) {
        delete (window as unknown as Record<string, unknown>).__p3SetLook;
      }
      if (
        P3_TEST_HOOKS_ENABLED
        && devSetCameraOrbit
        && (window as unknown as Record<string, unknown>).__p3SetCameraOrbit === devSetCameraOrbit
      ) {
        delete (window as unknown as Record<string, unknown>).__p3SetCameraOrbit;
      }
      if (
        P3_TEST_HOOKS_ENABLED
        && devSetPanelVisible
        && (window as unknown as Record<string, unknown>).__p3SetPanelVisible
          === devSetPanelVisible
      ) {
        delete (window as unknown as Record<string, unknown>).__p3SetPanelVisible;
      }
      cancelRenderLoop();
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      controls.removeEventListener('change', onControlsChange);
      controls.removeEventListener('start', onControlsStart);
      controls.dispose();
      disposePanelTree();
      seamMaterial.dispose();
      if (paperAlbedoTexture !== paperBaseAlbedoTexture) {
        paperAlbedoTexture.dispose();
      }
      paperBaseAlbedoTexture.dispose();
      paperBumpTexture.dispose();
      disposeContactShadow(contactShadow);
      scene.clear();
      renderer.dispose();
      currentScene = null;
    },
  };
}
