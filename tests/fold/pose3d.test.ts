import { describe, expect, it } from 'vitest';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import type { FoldModel, Pt } from '@/fold/types';

const UNIT_SQUARE: Pt[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function expectVec(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
}

function singleChildModel(options?: {
  polygon?: Pt[];
  hingeLine?: { a: Pt; b: Pt };
  foldAngle?: number;
  liftOffset?: number;
}): FoldModel {
  const polygon = options?.polygon ?? UNIT_SQUARE;
  const hingeLine = options?.hingeLine ?? {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 },
  };

  return {
    panels: [
      { id: 'root', polygon, parent: null, foldAngle: 0 },
      {
        id: 'child',
        polygon,
        parent: 'root',
        hingeLine,
        foldAngle: options?.foldAngle ?? Math.PI / 2,
        liftOffset: options?.liftOffset,
      },
    ],
    steps: [{ panelIds: ['child'], t0: 0, t1: 1, ease: 'linear' }],
  };
}

function twoLevelModel(): FoldModel {
  return {
    panels: [
      { id: 'root', polygon: UNIT_SQUARE, parent: null, foldAngle: 0 },
      {
        id: 'A',
        polygon: UNIT_SQUARE,
        parent: 'root',
        hingeLine: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
        foldAngle: Math.PI / 2,
      },
      {
        id: 'B',
        polygon: UNIT_SQUARE,
        parent: 'A',
        hingeLine: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
        foldAngle: Math.PI / 2,
      },
    ],
    steps: [
      { panelIds: ['A'], t0: 0, t1: 0.5, ease: 'linear' },
      { panelIds: ['B'], t0: 0.5, t1: 1, ease: 'linear' },
    ],
  };
}

describe('worldGeometry', () => {
  it('繞 x 軸正向旋轉 π/2，將子面板的 y 座標轉為 z 座標', () => {
    const geometry = worldGeometry(
      singleChildModel(),
      new Map([['child', Math.PI / 2]]),
    );
    const child = geometry.get('child')!;

    expectVec(child[0]!, { x: 0, y: 0, z: 0 });
    expectVec(child[1]!, { x: 1, y: 0, z: 0 });
    expectVec(child[2]!, { x: 1, y: 0, z: 1 });
    expectVec(child[3]!, { x: 0, y: 0, z: 1 });
  });

  it('依 parent ∘ child 次序累積兩層非交換旋轉', () => {
    const geometry = worldGeometry(
      twoLevelModel(),
      new Map([
        ['A', Math.PI / 2],
        ['B', Math.PI / 2],
      ]),
    );
    const panelB = geometry.get('B')!;

    // Rx(π/2) · Ry(π/2) · (1, 0, 0) = (0, 1, 0)
    expectVec(panelB[1]!, { x: 0, y: 1, z: 0 });
    // Rx(π/2) · Ry(π/2) · (1, 1, 0) = (0, 1, 1)
    expectVec(panelB[2]!, { x: 0, y: 1, z: 1 });
  });

  it('所有角度為 0 時，保留所有面板的平面座標與頂點順序', () => {
    const model = twoLevelModel();
    const geometry = worldGeometry(model, new Map());

    for (const panel of model.panels) {
      const vertices = geometry.get(panel.id)!;
      expect(vertices).toHaveLength(panel.polygon.length);
      panel.polygon.forEach((point, index) => {
        expectVec(vertices[index]!, { x: point.x, y: point.y, z: 0 });
      });
    }
  });

  it('忽略 root 的 pose 角度', () => {
    const geometry = worldGeometry(
      singleChildModel(),
      new Map([['root', Math.PI / 2]]),
    );

    expectVec(geometry.get('root')![2]!, { x: 1, y: 1, z: 0 });
    expectVec(geometry.get('child')![2]!, { x: 1, y: 1, z: 0 });
  });

  it('反轉非原點 hinge 端點時，以同一旋轉中心反轉旋轉方向', () => {
    const polygon = [
      { x: 2, y: 3 },
      { x: 5, y: 3 },
      { x: 5, y: 4 },
      { x: 2, y: 4 },
    ];
    const forward = worldGeometry(
      singleChildModel({
        polygon,
        hingeLine: { a: { x: 2, y: 3 }, b: { x: 5, y: 3 } },
      }),
      new Map([['child', Math.PI / 2]]),
    ).get('child')!;
    const reversed = worldGeometry(
      singleChildModel({
        polygon,
        hingeLine: { a: { x: 5, y: 3 }, b: { x: 2, y: 3 } },
      }),
      new Map([['child', Math.PI / 2]]),
    ).get('child')!;

    expectVec(forward[2]!, { x: 5, y: 3, z: 1 });
    expectVec(forward[3]!, { x: 2, y: 3, z: 1 });
    expectVec(reversed[2]!, { x: 5, y: 3, z: -1 });
    expectVec(reversed[3]!, { x: 2, y: 3, z: -1 });
  });

  it('全角摺合時，沿摺後法向套用完整 liftOffset', () => {
    const geometry = worldGeometry(
      singleChildModel({ liftOffset: 1 }),
      new Map([['child', Math.PI / 2]]),
    );
    const child = geometry.get('child')!;

    // Rx(π/2) · (0, 0, 1) = (0, -1, 0)
    expectVec(child[0]!, { x: 0, y: -1, z: 0 });
    expectVec(child[1]!, { x: 1, y: -1, z: 0 });
    expectVec(child[2]!, { x: 1, y: -1, z: 1 });
    expectVec(child[3]!, { x: 0, y: -1, z: 1 });
  });

  it('按目前角度占 foldAngle 的比例線性套用 liftOffset', () => {
    const geometry = worldGeometry(
      singleChildModel({ liftOffset: 2 }),
      new Map([['child', Math.PI / 4]]),
    );

    expectVec(geometry.get('child')![0]!, {
      x: 0,
      y: -Math.SQRT1_2,
      z: Math.SQRT1_2,
    });
  });

  it('foldAngle 為 0 時不套用 liftOffset', () => {
    const geometry = worldGeometry(
      singleChildModel({ foldAngle: 0, liftOffset: 1 }),
      new Map([['child', Math.PI / 2]]),
    );

    expectVec(geometry.get('child')![2]!, { x: 1, y: 0, z: 1 });
  });

  it('遇到循環 parent 關係時直接失敗，不進入無限遞迴', () => {
    const model = twoLevelModel();
    model.panels[0]!.parent = 'B';

    expect(() => worldGeometry(model, new Map())).toThrow('Cycle in fold panel hierarchy');
  });
});
