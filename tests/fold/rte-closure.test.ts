import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel } from '@/fold/types';
import { CLOSURE_TOLERANCE_MM } from '@/fold/types';
import { validateFoldModel } from '@/fold/validate';

type Overrides = Partial<Record<string, number | boolean | string>>;

interface PlaneFrame {
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
  uLength: number;
  vLength: number;
}

interface SweepCase {
  label: string;
  overrides: Overrides;
}

const CLOSURE_MATRIX = [
  { thickness: 0, glueSide: 'left' },
  { thickness: 0, glueSide: 'right' },
  { thickness: 0.3, glueSide: 'left' },
  { thickness: 0.3, glueSide: 'right' },
  { thickness: 0.8, glueSide: 'left' },
  { thickness: 0.8, glueSide: 'right' },
] as const;

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
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

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: Vec3): Vec3 {
  const vectorLength = length(vector);
  expect(vectorLength, 'plane basis vector must have non-zero length').toBeGreaterThan(0);
  return {
    x: vector.x / vectorLength,
    y: vector.y / vectorLength,
    z: vector.z / vectorLength,
  };
}

function distance(left: Vec3, right: Vec3): number {
  return length(subtract(left, right));
}

function maximumPairedVertexGap(first: Vec3[], second: Vec3[]): number {
  const firstToSecond = first.map((point) => Math.min(...second.map((target) => distance(point, target))));
  const secondToFirst = second.map((point) => Math.min(...first.map((target) => distance(point, target))));
  return Math.max(...firstToSecond, ...secondToFirst);
}

function planeFrame(vertices: Vec3[]): PlaneFrame {
  expect(vertices.length, 'rectangle must provide four ordered vertices').toBeGreaterThanOrEqual(4);
  const origin = vertices[0]!;
  const u = subtract(vertices[1]!, origin);
  const v = subtract(vertices[3]!, origin);

  return {
    origin,
    uAxis: normalize(u),
    vAxis: normalize(v),
    normal: normalize(cross(u, v)),
    uLength: length(u),
    vLength: length(v),
  };
}

function worldPanel(geometry: Map<string, Vec3[]>, id: string): Vec3[] {
  const result = geometry.get(id);
  expect(result, `missing world geometry for ${id}`).toBeDefined();
  return result!;
}

function panelById(model: FoldModel, id: string): FoldModel['panels'][number] {
  const result = model.panels.find((target) => target.id === id);
  expect(result, `missing panel ${id}`).toBeDefined();
  return result!;
}

function worldVertexAt(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
  panelId: string,
  flatPoint: { x: number; y: number },
): Vec3 {
  const target = panelById(model, panelId);
  const index = target.polygon.findIndex(({ x, y }) => x === flatPoint.x && y === flatPoint.y);
  expect(index, `${panelId} must contain flat vertex (${flatPoint.x}, ${flatPoint.y})`).toBeGreaterThanOrEqual(0);
  return worldPanel(geometry, panelId)[index]!;
}

function polygonNormal(vertices: Vec3[]): Vec3 {
  for (let index = 1; index < vertices.length - 1; index += 1) {
    const normal = cross(
      subtract(vertices[index]!, vertices[0]!),
      subtract(vertices[index + 1]!, vertices[0]!),
    );
    if (length(normal) > CLOSURE_TOLERANCE_MM) return normalize(normal);
  }
  throw new Error('panel polygon must contain three non-collinear vertices');
}

function expectLidSlicesCoplanarAndJoined(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
  side: 'top' | 'bottom',
  label: string,
): void {
  const ids = [`${side}LidL`, `${side}LidC`, `${side}LidR`];
  const centerVertices = worldPanel(geometry, ids[1]!);
  const centerNormal = polygonNormal(centerVertices);
  const centerOrigin = centerVertices[0]!;

  for (const id of ids) {
    const vertices = worldPanel(geometry, id);
    expect(
      dot(polygonNormal(vertices), centerNormal),
      `${label}: ${id} normal must match ${ids[1]}`,
    ).toBeGreaterThan(1 - CLOSURE_TOLERANCE_MM);
    for (const [index, vertex] of vertices.entries()) {
      expect(
        Math.abs(dot(subtract(vertex, centerOrigin), centerNormal)),
        `${label}: ${id} vertex ${index} plane distance`,
      ).toBeLessThan(CLOSURE_TOLERANCE_MM);
    }
  }

  const seamPairs: ReadonlyArray<readonly [string, string]> = [
    [ids[0]!, ids[1]!],
    [ids[1]!, ids[2]!],
  ];
  for (const [leftId, rightId] of seamPairs) {
    const leftPanel = panelById(model, leftId);
    const rightPanel = panelById(model, rightId);
    const shared = leftPanel.polygon.filter((point) => rightPanel.polygon.some(
      (candidate) => candidate.x === point.x && candidate.y === point.y,
    ));
    expect(shared, `${label}: ${leftId}/${rightId} flat seam endpoints`).toHaveLength(2);
    for (const point of shared) {
      expect(
        distance(
          worldVertexAt(model, geometry, leftId, point),
          worldVertexAt(model, geometry, rightId, point),
        ),
        `${label}: ${leftId}/${rightId} world seam at (${point.x}, ${point.y})`,
      ).toBeLessThan(CLOSURE_TOLERANCE_MM);
    }
  }
}

function expectWithinTolerance(actual: number, expected: number, label: string): void {
  expect(
    Math.abs(actual - expected),
    `${label}: expected ${expected}mm, received ${actual}mm`,
  ).toBeLessThan(CLOSURE_TOLERANCE_MM);
}

function expectEdgesCoincide(actual: Vec3[], expected: Vec3[], label: string): void {
  expect(actual, `${label}: edge vertex count`).toHaveLength(expected.length);
  const maximumGap = maximumPairedVertexGap(actual, expected);
  expect(maximumGap, `${label}: maximum paired vertex gap`).toBeLessThan(CLOSURE_TOLERANCE_MM);
}

function expectCoplanarRectangleOverlap(
  subject: Vec3[],
  targetRectangle: Vec3[],
  label: string,
): void {
  const target = planeFrame(targetRectangle);

  for (const [index, vertex] of subject.entries()) {
    const relative = subtract(vertex, target.origin);
    const planeDistance = Math.abs(dot(relative, target.normal));
    const u = dot(relative, target.uAxis);
    const v = dot(relative, target.vAxis);

    expect(planeDistance, `${label}: vertex ${index} plane distance`).toBeLessThan(CLOSURE_TOLERANCE_MM);
    expect(u, `${label}: vertex ${index} u projection lower bound`).toBeGreaterThanOrEqual(-CLOSURE_TOLERANCE_MM);
    expect(u, `${label}: vertex ${index} u projection upper bound`).toBeLessThanOrEqual(
      target.uLength + CLOSURE_TOLERANCE_MM,
    );
    expect(v, `${label}: vertex ${index} v projection lower bound`).toBeGreaterThanOrEqual(-CLOSURE_TOLERANCE_MM);
    expect(v, `${label}: vertex ${index} v projection upper bound`).toBeLessThanOrEqual(
      target.vLength + CLOSURE_TOLERANCE_MM,
    );
  }
}

function expectParallelPlaneDistance(
  firstRectangle: Vec3[],
  secondRectangle: Vec3[],
  expectedDistance: number,
  label: string,
): void {
  const first = planeFrame(firstRectangle);
  const second = planeFrame(secondRectangle);
  const parallelError = Math.abs(Math.abs(dot(first.normal, second.normal)) - 1);
  expect(parallelError, `${label}: plane normals must be parallel`).toBeLessThan(CLOSURE_TOLERANCE_MM);

  for (const [index, vertex] of secondRectangle.entries()) {
    const planeDistance = Math.abs(dot(subtract(vertex, first.origin), first.normal));
    expectWithinTolerance(planeDistance, expectedDistance, `${label}: vertex ${index} plane distance`);
  }
}

function expectAllVerticesFinite(geometry: Map<string, Vec3[]>, label: string): void {
  for (const [panelId, vertices] of geometry) {
    for (const [index, vertex] of vertices.entries()) {
      expect(
        [vertex.x, vertex.y, vertex.z].every(Number.isFinite),
        `${label}: ${panelId} vertex ${index} must be finite`,
      ).toBe(true);
    }
  }
}

function expectDustPanelsInsideOpening(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
  L: number,
  W: number,
  label: string,
): void {
  for (const panelId of ['topDustP2', 'bottomDustP2', 'topDustP4', 'bottomDustP4']) {
    const target = model.panels.find(({ id }) => id === panelId);
    if (target?.hingeLine === undefined) {
      throw new Error(`${label}: missing flat panel or hinge for ${panelId}`);
    }
    const hinge = target.hingeLine;
    const vertices = worldPanel(geometry, panelId);

    for (const [index, vertex] of vertices.entries()) {
      expect(vertex.x, `${label}: ${panelId} vertex ${index} opening x lower bound`)
        .toBeGreaterThanOrEqual(-CLOSURE_TOLERANCE_MM);
      expect(vertex.x, `${label}: ${panelId} vertex ${index} opening x upper bound`)
        .toBeLessThanOrEqual(L + CLOSURE_TOLERANCE_MM);
      expect(vertex.z, `${label}: ${panelId} vertex ${index} opening z lower bound`)
        .toBeGreaterThanOrEqual(-W - CLOSURE_TOLERANCE_MM);
      expect(vertex.z, `${label}: ${panelId} vertex ${index} opening z upper bound`)
        .toBeLessThanOrEqual(CLOSURE_TOLERANCE_MM);

      const flatVertex = target.polygon[index]!;
      const isHingeVertex = [hinge.a, hinge.b]
        .some(({ x, y }) => flatVertex.x === x && flatVertex.y === y);
      if (isHingeVertex) continue;

      if (panelId.endsWith('P2')) {
        expect(vertex.x, `${label}: ${panelId} non-hinge vertex ${index} folds inward from P2`)
          .toBeLessThanOrEqual(L + CLOSURE_TOLERANCE_MM);
      } else {
        expect(vertex.x, `${label}: ${panelId} non-hinge vertex ${index} folds inward from P4`)
          .toBeGreaterThanOrEqual(-CLOSURE_TOLERANCE_MM);
      }
    }
  }
}

function singleParameterCases(): SweepCase[] {
  return reverseTuckEnd.params.flatMap((param): SweepCase[] => {
    if (param.unit === 'enum') {
      const options = param.options ?? [];
      expect(options, `${param.key} enum options`).toHaveLength(2);
      return [
        { label: `${param.key}=min(${options[0]!.value})`, overrides: { [param.key]: options[0]!.value } },
        { label: `${param.key}=max(${options[1]!.value})`, overrides: { [param.key]: options[1]!.value } },
      ];
    }

    expect(param.min, `${param.key}.min`).toBeDefined();
    expect(param.max, `${param.key}.max`).toBeDefined();
    return [
      { label: `${param.key}=min(${param.min})`, overrides: { [param.key]: param.min! } },
      { label: `${param.key}=max(${param.max})`, overrides: { [param.key]: param.max! } },
    ];
  });
}

function assertSweepCase({ label, overrides }: SweepCase): void {
  it(`${label}: builder 與完整摺合流程不 throw、模型有效且座標 finite`, () => {
    let model: FoldModel | undefined;
    expect(() => {
      model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
    }, label).not.toThrow();

    expect(model, `${label}: builder must return a model`).toBeDefined();
    if (model === undefined) throw new Error(`${label}: builder did not return a model`);
    const builtModel = model;

    expect(validateFoldModel(builtModel), label).toEqual([]);
    expect(
      builtModel.panels.every((target) => target.polygon.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))),
      `${label}: flat polygon vertices must be finite`,
    ).toBe(true);

    const poses = new Map<number, ReturnType<typeof foldPose>>();
    for (const t of [0, 0.5, 1]) {
      expect(() => {
        poses.set(t, foldPose(t, builtModel));
      }, `${label}: foldPose(${t})`).not.toThrow();
    }

    let foldedGeometry: Map<string, Vec3[]> | undefined;
    expect(() => {
      foldedGeometry = worldGeometry(builtModel, poses.get(1)!);
    }, `${label}: worldGeometry(t=1)`).not.toThrow();
    expect(foldedGeometry, `${label}: worldGeometry must return geometry`).toBeDefined();
    expectAllVerticesFinite(foldedGeometry!, `${label}: t=1`);

    if (overrides.tuckLock === 0) {
      expect(builtModel.panels.filter(({ id }) => /^(top|bottom)Lid[CLR]$/.test(id))).toHaveLength(0);
      expect(builtModel.panels.filter(({ id }) => id === 'topLid' || id === 'bottomLid')).toHaveLength(2);
    } else {
      expect(builtModel.panels.filter(({ id }) => /^(top|bottom)Lid[CLR]$/.test(id))).toHaveLength(6);
      expectLidSlicesCoplanarAndJoined(builtModel, foldedGeometry!, 'top', `${label}: top lid slices`);
      expectLidSlicesCoplanarAndJoined(builtModel, foldedGeometry!, 'bottom', `${label}: bottom lid slices`);
    }
  });
}

describe('RTE world-space closure matrix', () => {
  for (const { thickness, glueSide } of CLOSURE_MATRIX) {
    it(`thickness=${thickness}, glueSide=${glueSide}: t=0/0.5/1 geometry satisfies closure contracts`, () => {
      const params = resolveParams(reverseTuckEnd, { thickness, glueSide });
      const model = buildRteFoldModel(params);
      const L = params.L as number;
      const W = params.W as number;
      const D = params.D as number;
      const x0 = 0;
      const x1 = L;
      const x2 = L + W;
      const x3 = 2 * L + W;

      const folded = worldGeometry(model, foldPose(1, model));
      const p1 = worldPanel(folded, 'P1');
      const p2 = worldPanel(folded, 'P2');
      const p3 = worldPanel(folded, 'P3');
      const p4 = worldPanel(folded, 'P4');
      const glue = worldPanel(folded, 'glue');
      expectLidSlicesCoplanarAndJoined(model, folded, 'top', `thickness=${thickness}, glueSide=${glueSide}`);
      expectLidSlicesCoplanarAndJoined(model, folded, 'bottom', `thickness=${thickness}, glueSide=${glueSide}`);

      expectDustPanelsInsideOpening(model, folded, L, W, `thickness=${thickness}, glueSide=${glueSide}`);

      expectEdgesCoincide([p4[1]!, p4[2]!], [p1[0]!, p1[3]!], 'P4 free edge ↔ P1 fixed edge');

      const glueTarget = glueSide === 'left' ? p4 : p1;
      expectCoplanarRectangleOverlap(glue, glueTarget, `glue ↔ ${glueSide === 'left' ? 'P4' : 'P1'}`);

      expectParallelPlaneDistance(p1, p3, W, 'P1 ↔ P3');
      expectParallelPlaneDistance(p2, p4, L, 'P2 ↔ P4');

      expectEdgesCoincide([
        worldVertexAt(model, folded, 'topLidL', { x: x2, y: -W }),
        worldVertexAt(model, folded, 'topLidR', { x: x3, y: -W }),
      ], [p1[0]!, p1[1]!], 'top lid free corners ↔ P1 top edge');
      expectEdgesCoincide([
        worldVertexAt(model, folded, 'bottomLidL', { x: x0, y: D + W }),
        worldVertexAt(model, folded, 'bottomLidR', { x: x1, y: D + W }),
      ], [p3[2]!, p3[3]!], 'bottom lid free corners ↔ P3 bottom edge');

      const flat = worldGeometry(model, foldPose(0, model));
      for (const target of model.panels) {
        const flatVertices = worldPanel(flat, target.id);
        for (const [index, original] of target.polygon.entries()) {
          const vertex = flatVertices[index]!;
          expectWithinTolerance(vertex.x, original.x, `${target.id} vertex ${index} flat x`);
          expectWithinTolerance(vertex.y, original.y, `${target.id} vertex ${index} flat y`);
          expectWithinTolerance(vertex.z, 0, `${target.id} vertex ${index} flat z`);
        }
      }

      expectAllVerticesFinite(worldGeometry(model, foldPose(0.5, model)), 't=0.5');
    });
  }
});

describe('RTE FoldModel parameter sweep', () => {
  const parameterCases = singleParameterCases();

  it('13 parameters each contribute one min and one max case', () => {
    expect(reverseTuckEnd.params).toHaveLength(13);
    expect(parameterCases).toHaveLength(26);
  });

  describe('single-parameter min/max', () => {
    for (const testCase of parameterCases) assertSweepCase(testCase);
  });

  describe('20 copied interacting-extreme combinations', () => {
    // 照抄 tests/boxes/param-sweep.test.ts combos（未 export·B1 禁改既有檔）
    const combos: SweepCase[] = [
      {
        label: '1. 全部參數同時取 min',
        overrides: {
          L: 20, W: 20, D: 20, tuckDepth: 0, tuckRadius: 0, tuckClearance: 0,
          tuckLock: 0, dustFlapDepth: 0, flapNotch: 0, creaseRelief: 0, glueSize: 5,
        },
      },
      {
        label: '2. 全部參數同時取 max',
        overrides: {
          L: 500, W: 500, D: 500, tuckDepth: 60, tuckRadius: 15, tuckClearance: 10,
          tuckLock: 60, dustFlapDepth: 60, flapNotch: 20, creaseRelief: 20, glueSize: 60,
        },
      },
      {
        label: '3. tuckRadius=max 但 tuckDepth=min（鉗制應把 effectiveR 壓到 0）',
        overrides: { tuckRadius: 15, tuckDepth: 0 },
      },
      {
        label: '4. tuckRadius=max + tuckDepth=max + tuckClearance=max + L=min（插舌半寬鉗制到 0 的邊界情形）',
        overrides: { tuckRadius: 15, tuckDepth: 60, tuckClearance: 10, L: 20 },
      },
      {
        label: '5. tuckRadius=max + tuckDepth=max + tuckClearance=min + L=min（半寬鉗制生效但非 0）',
        overrides: { tuckRadius: 15, tuckDepth: 60, tuckClearance: 0, L: 20 },
      },
      {
        label: '6. tuckLock=max 遠超蓋板寬 L=min（frictionLock 幾何超出面板，仍不應崩潰）',
        overrides: { tuckLock: 60, L: 20 },
      },
      {
        label: '7. tuckLock=min（停用摩擦扣）+ 其餘鎖扣/插舌相關取 max',
        overrides: { tuckLock: 0, tuckDepth: 60, tuckRadius: 15 },
      },
      {
        label: '8. flapNotch=max + creaseRelief=min + dustFlapDepth=max（避讓槽 gap 走 flapNotch 分支）',
        overrides: { flapNotch: 20, creaseRelief: 0, dustFlapDepth: 60 },
      },
      {
        label: '9. flapNotch=min + creaseRelief=max（避讓槽 gap 走 creaseRelief 分支）',
        overrides: { flapNotch: 0, creaseRelief: 20 },
      },
      {
        label: '10. flapNotch=min + creaseRelief=min（reliefGap 落回 fallback 值 3）',
        overrides: { flapNotch: 0, creaseRelief: 0 },
      },
      {
        label: '11. glueSize=max + glueSide=right',
        overrides: { glueSize: 60, glueSide: 'right' },
      },
      {
        label: '12. glueSize=min + glueSide=left',
        overrides: { glueSize: 5, glueSide: 'left' },
      },
      {
        label: '13. W=min + D=max + L=max（薄蓋板＋長身體＋長面板）',
        overrides: { W: 20, D: 500, L: 500 },
      },
      {
        label: '14. W=max + D=min + L=min（巨大蓋板＋極短身體＋窄面板，hLid 主導 bounds）',
        overrides: { W: 500, D: 20, L: 20 },
      },
      {
        label: '15. tuckDepth=max + tuckRadius=min（大深度直角插舌）',
        overrides: { tuckDepth: 60, tuckRadius: 0 },
      },
      {
        label: '16. tuckDepth=min + tuckRadius=min + tuckClearance=max + L=min（零深度插舌退化為零寬度）',
        overrides: { tuckDepth: 0, tuckRadius: 0, tuckClearance: 10, L: 20 },
      },
      {
        label: '17. dustFlapDepth=min（零高度防塵翼）+ 其餘避讓參數 max',
        overrides: { dustFlapDepth: 0, flapNotch: 20, creaseRelief: 20 },
      },
      {
        label: '18. 插舌與避讓同時 max：tuckDepth/flapNotch/creaseRelief/dustFlapDepth 皆 max',
        overrides: { tuckDepth: 60, flapNotch: 20, creaseRelief: 20, dustFlapDepth: 60 },
      },
      {
        label: '19. tuckRadius=max + tuckClearance=max + tuckDepth=min + L=min（雙重鉗制路徑同時觸發）',
        overrides: { tuckRadius: 15, tuckClearance: 10, tuckDepth: 0, L: 20 },
      },
      {
        label: '20. W=min + tuckDepth=max（插舌深度遠超蓋板高）',
        overrides: { W: 20, tuckDepth: 60 },
      },
    ];

    it('copied combination count remains 20', () => {
      expect(combos).toHaveLength(20);
    });

    for (const testCase of combos) assertSweepCase(testCase);
  });
});
