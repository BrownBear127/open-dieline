// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import { InvalidBoxParamsError } from '@/fold/derive/panelize';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel } from '@/fold/types';
import { CLOSURE_TOLERANCE_MM } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

type Overrides = Partial<Record<string, number | boolean | string>>;

const CLOSURE_MATRIX = [
  { thickness: 0, glueSide: 'left' },
  { thickness: 0, glueSide: 'right' },
  { thickness: 0.3, glueSide: 'left' },
  { thickness: 0.3, glueSide: 'right' },
  { thickness: 0.8, glueSide: 'left' },
  { thickness: 0.8, glueSide: 'right' },
] as const;

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function magnitude(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normal(vertices: Vec3[]): Vec3 {
  const value = cross(subtract(vertices[1]!, vertices[0]!), subtract(vertices[3]!, vertices[0]!));
  const size = magnitude(value);
  return { x: value.x / size, y: value.y / size, z: value.z / size };
}

function geometryPanel(geometry: Map<string, Vec3[]>, id: string): Vec3[] {
  const result = geometry.get(id);
  expect(result, `missing geometry for ${id}`).toBeDefined();
  return result!;
}

function panelWidth(model: FoldModel, id: string): number {
  const target = model.panels.find((candidate) => candidate.id === id);
  expect(target, `missing panel ${id}`).toBeDefined();
  const xs = target!.polygon.map(({ x }) => x);
  return Math.max(...xs) - Math.min(...xs);
}

function planeDistance(first: Vec3[], second: Vec3[]): number {
  return Math.abs(dot(subtract(second[0]!, first[0]!), normal(first)));
}

function expectFinite(model: FoldModel, progress: number): void {
  const geometry = worldGeometry(model, foldPose(progress, model));
  for (const [id, vertices] of geometry) {
    expect(vertices.every(({ x, y, z }) => [x, y, z].every(Number.isFinite)), id).toBe(true);
  }
}

function failingErrorInvariantIds(params: ResolvedParams): string[] {
  const generated = reverseTuckEnd.generate(params);
  return reverseTuckEnd.invariants
    .filter(({ severity, check }) => severity !== 'warning' && !check(params, generated).ok)
    .map(({ id }) => id);
}

function parameterCases(): Array<{ label: string; overrides: Overrides }> {
  const cases: Array<{ label: string; overrides: Overrides }> = [];
  for (const definition of reverseTuckEnd.params) {
    if (definition.unit === 'enum') {
      cases.push(...definition.options!.map(({ value }) => ({
        label: `${definition.key}=${value}`,
        overrides: { [definition.key]: value },
      })));
      continue;
    }
    if (definition.unit === 'bool') {
      cases.push(...[false, true].map((value) => ({
        label: `${definition.key}=${value}`,
        overrides: { [definition.key]: value },
      })));
      continue;
    }
    cases.push(...[definition.min!, definition.max!].map((value) => ({
      label: `${definition.key}=${value}`,
      overrides: { [definition.key]: value },
    })));
  }
  return cases;
}

describe('RTE world-space closure matrix — 補償後觀測', () => {
  for (const { thickness, glueSide } of CLOSURE_MATRIX) {
    it(`thickness=${thickness}, glueSide=${glueSide}: t=0/0.5/1 remains finite and closes on compensated planes`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const model = buildRteFoldModel(params);
      expect(validateFoldModel(model)).toEqual([]);

      for (const progress of [0, 0.5, 1]) expectFinite(model, progress);

      const flat = worldGeometry(model, foldPose(0, model));
      for (const target of model.panels) {
        expect(geometryPanel(flat, target.id)).toEqual(target.polygon.map(({ x, y }) => ({ x, y, z: 0 })));
      }

      const folded = worldGeometry(model, foldPose(1, model));
      const topLid = geometryPanel(folded, 'topLid');
      const bottomLid = geometryPanel(folded, 'bottomLid');
      expect(topLid.every(({ y }) => Math.abs(y) < CLOSURE_TOLERANCE_MM)).toBe(true);
      expect(bottomLid.every(({ y }) => Math.abs(y - (params.D as number)) < CLOSURE_TOLERANCE_MM)).toBe(true);

      expect(planeDistance(geometryPanel(folded, 'P1'), geometryPanel(folded, 'P3')))
        .toBeCloseTo(panelWidth(model, 'P2'), 9);
      expect(planeDistance(geometryPanel(folded, 'P2'), geometryPanel(folded, 'P4')))
        .toBeCloseTo(panelWidth(model, 'P3'), 9);

      expect(model.panels.filter(({ id }) => id === 'topLid' || id === 'bottomLid')).toHaveLength(2);
      expect(model.panels.some(({ id }) => /(?:top|bottom)Lid[LCR]$/.test(id))).toBe(false);
    });
  }
});

describe('RTE FoldModel parameter sweep', () => {
  const cases = parameterCases();

  it('covers both endpoints of all 13 geometry-affecting parameters', () => {
    expect(reverseTuckEnd.params).toHaveLength(13);
    expect(cases).toHaveLength(26);
  });

  for (const { label, overrides } of cases) {
    it(`${label}: either fails its declared invariant or produces a valid finite model`, () => {
      const params = resolveParams(reverseTuckEnd, overrides);
      const failingIds = failingErrorInvariantIds(params);
      if (failingIds.length > 0) {
        expect(() => buildRteFoldModel(params)).toThrow(InvalidBoxParamsError);
        return;
      }

      const model = buildRteFoldModel(params);
      expect(validateFoldModel(model)).toEqual([]);
      for (const progress of [0, 0.5, 1]) expectFinite(model, progress);
      expect(model.panels.some(({ id }) => /(?:top|bottom)Lid[LCR]$/.test(id))).toBe(false);
    });
  }

  it.each([
    { L: 20, W: 20, D: 20, tuckDepth: 0, tuckRadius: 0, tuckClearance: 0, tuckLock: 0, dustFlapDepth: 0, flapNotch: 0, creaseRelief: 0, glueSize: 5 },
    { L: 500, W: 500, D: 500, tuckDepth: 60, tuckRadius: 15, tuckClearance: 10, tuckLock: 60, dustFlapDepth: 60, flapNotch: 20, creaseRelief: 20, glueSize: 60 },
    { tuckRadius: 15, tuckDepth: 0 },
    { tuckRadius: 15, tuckDepth: 60, tuckClearance: 10, L: 20 },
    { flapNotch: 0, creaseRelief: 20, dustFlapDepth: 60 },
    { glueSize: 60, glueSide: 'right', thickness: 0.8 },
  ] as Overrides[])('interacting extremes %# honor invariant and finite-geometry contracts', (overrides) => {
    const params = resolveParams(reverseTuckEnd, overrides);
    if (failingErrorInvariantIds(params).length > 0) {
      expect(() => buildRteFoldModel(params)).toThrow(InvalidBoxParamsError);
      return;
    }
    const model = buildRteFoldModel(params);
    expect(validateFoldModel(model)).toEqual([]);
    expectFinite(model, 1);
  });
});
