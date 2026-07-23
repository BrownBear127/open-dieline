// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import { flattenSegment } from '@/fold/derive/flatten';
import type {
  BoxModule,
  DielinePath,
  GenerateResult,
  ResolvedParams,
} from '@/core/types';
import {
  assertBoxInvariants,
  completeUncutCreaseGaps,
  InvalidBoxParamsError,
  PanelizeError,
  panelizeFoldModel,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import {
  extractFaces,
  type PlanarSegmentInput,
} from '@/fold/derive/planar-faces';
import {
  ARC_TOLERANCE_MM,
  type FoldModel,
  type FoldStep,
  type Pt,
} from '@/fold/types';
import { sharedEdgeGapsAt } from '../helpers/trajectory';

type Overrides = Partial<Record<string, number | boolean | string>>;

const NO_STEPS: FoldStep[] = [];

function line(x1: number, y1: number, x2: number, y2: number) {
  return { kind: 'line' as const, x1, y1, x2, y2 };
}

function planarLine(
  pathId: string,
  kind: PlanarSegmentInput['kind'],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): PlanarSegmentInput {
  return { pathId, kind, polyline: [{ x: x1, y: y1 }, { x: x2, y: y2 }] };
}

function result(paths: DielinePath[]): GenerateResult {
  return {
    paths,
    texts: [],
    bounds: { minX: -20, minY: -20, maxX: 30, maxY: 32 },
  };
}

function outerRectangle(extraSegments: DielinePath['segments'] = [], inactiveSegments?: number[]): DielinePath {
  return {
    id: 'outer',
    type: 'cut',
    segments: [
      line(0, 0, 10, 0),
      line(10, 0, 10, 12),
      line(10, 12, 0, 12),
      line(0, 12, 0, 0),
      ...extraSegments,
    ],
    inactiveSegments,
  };
}

function threeBandResult(options: {
  slot?: boolean;
  equalHingeSegments?: boolean;
  danglingCut?: boolean;
  inactiveOuterSegment?: boolean;
  untaggedSecondCrease?: boolean;
} = {}): GenerateResult {
  const slotStart = options.equalHingeSegments ? 4 : 5;
  const slotEnd = options.equalHingeSegments ? 6 : 7;
  const outer = options.inactiveOuterSegment
    ? outerRectangle([line(2, 1, 8, 11)], [4])
    : outerRectangle();
  const firstBoundary: DielinePath[] = options.slot
    ? [
        { id: 'ab-left', type: 'crease', tags: ['fold:A>B'], segments: [line(0, 4, slotStart, 4)] },
        { id: 'ab-slot', type: 'cut', segments: [line(slotStart, 4, slotEnd, 4)] },
        { id: 'ab-right', type: 'crease', tags: ['fold:A>B'], segments: [line(slotEnd, 4, 10, 4)] },
      ]
    : [{ id: 'ab', type: 'crease', tags: ['fold:A>B'], segments: [line(0, 4, 10, 4)] }];
  const secondBoundary: DielinePath = {
    id: 'bc',
    type: 'crease',
    tags: options.untaggedSecondCrease ? undefined : ['fold:B>C'],
    segments: [line(0, 8, 10, 8)],
  };
  const dangling: DielinePath[] = options.danglingCut
    ? [{ id: 'dead-end', type: 'cut', segments: [line(5, 10, 5, 9)] }]
    : [];
  return result([outer, ...firstBoundary, secondBoundary, ...dangling]);
}

function nonAxialTwoOwnerSeamResult(): GenerateResult {
  return result([
    outerRectangle(),
    { id: 'ab', type: 'crease', tags: ['fold:A>B'], segments: [line(0, 4, 5, 4)] },
    { id: 'ab-diagonal-cut', type: 'cut', segments: [line(5, 4, 10, 6)] },
    { id: 'bc', type: 'crease', tags: ['fold:B>C'], segments: [line(0, 8, 10, 8)] },
  ]);
}

function threeBandAngles(): PanelAngleSpec[] {
  return [
    { id: 'A', foldAngle: 0 },
    { id: 'B', foldAngle: Math.PI / 2 },
    { id: 'C', foldAngle: -Math.PI / 3 },
  ];
}

function panelById(model: FoldModel, id: string) {
  const panel = model.panels.find((candidate) => candidate.id === id);
  expect(panel, `找不到 panel ${id}`).toBeDefined();
  return panel!;
}

function centroid(polygon: Pt[]): Pt {
  const sum = polygon.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

function expectChildOnLeft(model: FoldModel): void {
  for (const panel of model.panels.filter(({ parent }) => parent !== null)) {
    const hinge = panel.hingeLine!;
    const child = centroid(panel.polygon);
    const cross = (hinge.b.x - hinge.a.x) * (child.y - hinge.a.y)
      - (hinge.b.y - hinge.a.y) * (child.x - hinge.a.x);
    expect(cross, panel.id).toBeGreaterThan(0);
  }
}

function mirrored(resultToMirror: GenerateResult): GenerateResult {
  const mirrorX = (x: number) => 10 - x;
  return {
    ...resultToMirror,
    paths: resultToMirror.paths.map((path) => ({
      ...path,
      segments: path.segments.map((segment) => {
        if (segment.kind !== 'line') throw new Error('合成鏡射案例只使用 line');
        return line(mirrorX(segment.x1), segment.y1, mirrorX(segment.x2), segment.y2);
      }),
    })),
  };
}

function angleSpecsFromTags(generated: GenerateResult, rootId: string): PanelAngleSpec[] {
  const ids = new Set([rootId]);
  for (const tag of generated.paths.flatMap((path) => path.tags ?? [])) {
    const match = /^fold:([^>]+)>([^>]+)$/.exec(tag);
    if (match) {
      ids.add(match[1]!);
      ids.add(match[2]!);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b)).map((id) => ({
    id,
    foldAngle: id === rootId ? 0 : Math.PI / 2,
  }));
}

function activePanelizeInputs(generated: GenerateResult): PlanarSegmentInput[] {
  const inputs = generated.paths.flatMap((path) => {
    if (path.type !== 'cut' && path.type !== 'crease') return [];
    const kind: PlanarSegmentInput['kind'] = path.type;
    const inactive = new Set(path.inactiveSegments ?? []);
    return path.segments.flatMap((segment, index) => inactive.has(index)
      ? []
      : [{
          polyline: flattenSegment(segment, ARC_TOLERANCE_MM),
          pathId: path.id,
          kind,
        } satisfies PlanarSegmentInput]);
  });
  return completeUncutCreaseGaps(inputs);
}

function polygonArea(polygon: Pt[]): number {
  return Math.abs(polygon.reduce((sum, current, index) => {
    const next = polygon[(index + 1) % polygon.length]!;
    return sum + current.x * next.y - next.x * current.y;
  }, 0) / 2);
}

function generate(box: BoxModule, overrides: Overrides = {}): { params: ResolvedParams; result: GenerateResult } {
  const params = resolveParams(box, overrides);
  return { params, result: box.generate(params) };
}

describe('panelize 分面範圍與 tag 傳播', () => {
  it('dieline 原樣帶出全部 cut/crease segments，包含 inactive，排除其他線型', () => {
    const generated = threeBandResult({ inactiveOuterSegment: true });
    generated.paths.push({
      id: 'annotation-only',
      type: 'annotation',
      segments: [line(-10, -10, -5, -5)],
    });
    const model = panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS);
    const expected = generated.paths
      .filter(({ type }) => type === 'cut' || type === 'crease')
      .map(({ id, type, segments }) => ({ id, type, segments }));

    expect(model.dieline).toEqual(expected);
    expect(model.dieline.flatMap(({ segments }) => segments))
      .toContainEqual(generated.paths[0]!.segments[4]);
    expect(model.dieline).not.toBe(generated.paths);
    expect(model.dieline[0]!.segments).not.toBe(generated.paths[0]!.segments);
    expect(model.dieline[0]!.segments[0]).not.toBe(generated.paths[0]!.segments[0]);
  });

  it('三面二 crease 由共享 B 面收斂，單 crease leaf 隨鄰面定形', () => {
    const model = panelizeFoldModel(threeBandResult(), 'A', threeBandAngles(), NO_STEPS);

    expect(model.panels.map(({ id, parent }) => ({ id, parent }))).toEqual([
      { id: 'A', parent: null },
      { id: 'B', parent: 'A' },
      { id: 'C', parent: 'B' },
    ]);
    expect(model.panels.map(({ polygon }) => polygon.length)).toEqual([4, 4, 4]);
  });

  it('只有單一 tagged crease 的對稱兩面無法唯一定形時具名失敗', () => {
    const twoFaces = result([
      outerRectangle(),
      { id: 'ab', type: 'crease', tags: ['fold:A>B'], segments: [line(0, 6, 10, 6)] },
    ]);

    expect(() => panelizeFoldModel(twoFaces, 'A', threeBandAngles().slice(0, 2), NO_STEPS))
      .toThrowError(PanelizeError);
    expect(() => panelizeFoldModel(twoFaces, 'A', threeBandAngles().slice(0, 2), NO_STEPS))
      .toThrow(/無法唯一定形/);
  });

  it('active crease 未帶 fold role 時具名失敗', () => {
    expect(() => panelizeFoldModel(
      threeBandResult({ untaggedSecondCrease: true }),
      'A',
      threeBandAngles(),
      NO_STEPS,
    )).toThrow(/未標記 crease.*bc/);
  });

  it('mixed cut 只排除 inactive segment，外框 active segments 仍完整分面', () => {
    const model = panelizeFoldModel(
      threeBandResult({ inactiveOuterSegment: true }),
      'A',
      threeBandAngles(),
      NO_STEPS,
    );

    expect(model.panels).toHaveLength(3);
    expect(model.panels.every(({ polygon }) => polygon.length === 4)).toBe(true);
  });

  it('inactiveSegments 含越界索引時具名失敗', () => {
    const generated = threeBandResult();
    generated.paths[0] = { ...generated.paths[0]!, inactiveSegments: [99] };

    expect(() => panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS))
      .toThrow(/inactiveSegments.*越界索引/);
  });

  it('RTE tuckDepth=0 保留混合 cut 的水平外框並成功切出所有 active panels', () => {
    const generated = reverseTuckEnd.generate(resolveParams(reverseTuckEnd, { tuckDepth: 0 }));
    const model = panelizeFoldModel(generated, 'P1', angleSpecsFromTags(generated, 'P1'), NO_STEPS);

    expect(model.panels.some(({ id }) => id === 'topTuck' || id === 'bottomTuck')).toBe(false);
    expect(model.panels.map(({ id }) => id).sort()).toEqual(
      angleSpecsFromTags(generated, 'P1').map(({ id }) => id).sort(),
    );
  });

  it('非 role 未歸屬大面積面會附面積與質心具名失敗', () => {
    const generated = threeBandResult();
    generated.paths.push({
      id: 'large-unassigned-face',
      type: 'cut',
      segments: [line(0, 10, 10, 10)],
    });

    expect(() => panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS))
      .toThrowError(PanelizeError);
    expect(() => panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS))
      .toThrow(/非 role 未歸屬面.*面積=20\.000000mm².*質心=\(5\.000000, 11\.000000\)/);
  });

  it('TTSL default 僅容許三個小於 0.1mm² 的 noding 微屑面未歸屬', () => {
    const generated = tuckTopSnapLock.generate(resolveParams(tuckTopSnapLock));
    const graph = extractFaces(activePanelizeInputs(generated));
    const rolePathIds = new Set(generated.paths
      .filter(({ tags }) => tags?.some((tag) => tag.startsWith('fold:')))
      .map(({ id }) => id));
    const roleFaces = new Set(graph.adjacency
      .filter(({ sharedEdges }) => sharedEdges.some(({ kind, pathId }) =>
        kind === 'crease' && rolePathIds.has(pathId)))
      .flatMap(({ faceA, faceB }) => [faceA, faceB]));
    const unassignedAreas = graph.faces
      .filter((_, face) => !roleFaces.has(face))
      .map(({ outline }) => polygonArea(outline));

    expect(unassignedAreas).toHaveLength(3);
    expect(Math.max(...unassignedAreas)).toBeLessThan(0.1);
    expect(() => panelizeFoldModel(
      generated,
      'P1',
      angleSpecsFromTags(generated, 'P1'),
      NO_STEPS,
    )).not.toThrow();
  });
});

describe('completeUncutCreaseGaps', () => {
  it('active cut 端點在 junction 容差內時保留開孔', () => {
    const inputs = [
      planarLine('fold', 'crease', 0, 0, 4, 0),
      planarLine('opening', 'cut', 4.01, 0, 5.99, 0),
      planarLine('fold', 'crease', 6, 0, 10, 0),
    ];

    expect(completeUncutCreaseGaps(inputs)).toEqual(inputs);
  });

  it('inactive cut 不在 active inputs 時補回 crease 斷口', () => {
    const inputs = [
      planarLine('fold', 'crease', 0, 0, 4, 0),
      planarLine('fold', 'crease', 6, 0, 10, 0),
    ];

    expect(completeUncutCreaseGaps(inputs)).toEqual([
      ...inputs,
      planarLine('fold', 'crease', 4, 0, 6, 0),
    ]);
  });
});

describe('panelize hinge 正規化', () => {
  it('logical group 取最長真 crease 並記錄全部來源 path id', () => {
    const model = panelizeFoldModel(
      threeBandResult({ slot: true }),
      'A',
      threeBandAngles(),
      NO_STEPS,
    );
    const panelB = panelById(model, 'B');

    expect(panelB.hingeLine).toEqual({ a: { x: 0, y: 4 }, b: { x: 5, y: 4 } });
    expect(panelB.hingeSourceCreaseIds).toEqual(['ab-left', 'ab-right']);
  });

  it('等長 canonical tie-break 取 post-mirror 最小端點，path 重排後不漂移', () => {
    const generated = threeBandResult({ slot: true, equalHingeSegments: true });
    const reordered = { ...generated, paths: [...generated.paths].reverse() };
    const first = panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS);
    const second = panelizeFoldModel(reordered, 'A', threeBandAngles(), NO_STEPS);

    expect(panelById(first, 'B').hingeLine).toEqual({ a: { x: 0, y: 4 }, b: { x: 4, y: 4 } });
    expect(second.panels).toEqual(first.panels);
  });

  it('原版與鏡射版皆把 a→b 正規化為 child 質心在左', () => {
    const original = panelizeFoldModel(threeBandResult(), 'A', threeBandAngles(), NO_STEPS);
    const mirroredModel = panelizeFoldModel(mirrored(threeBandResult()), 'A', threeBandAngles(), NO_STEPS);

    expectChildOnLeft(original);
    expectChildOnLeft(mirroredModel);
  });
});

describe('panelize seam 兩層資料語義', () => {
  it('內部兩面 cut 各 owner 一份、死端一份，外框不進 seam', () => {
    const model = panelizeFoldModel(
      threeBandResult({ slot: true, equalHingeSegments: true, danglingCut: true }),
      'A',
      threeBandAngles(),
      NO_STEPS,
    );
    const slot = model.seams!.filter(({ sourcePathId }) => sourcePathId === 'ab-slot');
    const deadEnd = model.seams!.filter(({ sourcePathId }) => sourcePathId === 'dead-end');

    expect(slot).toHaveLength(2);
    expect(slot.map(({ ownerPanelId }) => ownerPanelId).sort()).toEqual(['A', 'B']);
    expect(deadEnd).toHaveLength(1);
    expect(deadEnd[0]!.ownerPanelId).toBe('C');
    expect(model.seams!.some(({ sourcePathId }) => sourcePathId === 'outer')).toBe(false);
  });

  it('hinge 軸 cut 的兩份 owner 在動畫中段世界座標恆重合', () => {
    const steps: FoldStep[] = [{ panelIds: ['B'], t0: 0, t1: 1, ease: 'linear' }];
    const model = panelizeFoldModel(
      threeBandResult({ slot: true, equalHingeSegments: true }),
      'A',
      threeBandAngles(),
      steps,
    );
    const slot = model.seams!.filter(({ sourcePathId }) => sourcePathId === 'ab-slot');
    const gaps = sharedEdgeGapsAt(model, [{
      aPanelId: slot[0]!.ownerPanelId,
      bPanelId: slot[1]!.ownerPanelId,
      points: slot[0]!.points,
    }], 0.5);

    expect(gaps[0]!.maxGapMm).toBeLessThan(1e-9);
  });

  it('非軸 2-owner seam 合法，兩份各隨 owner 摺開分離', () => {
    const model = panelizeFoldModel(
      nonAxialTwoOwnerSeamResult(),
      'A',
      threeBandAngles(),
      [{ panelIds: ['B'], t0: 0, t1: 1, ease: 'linear' }],
    );
    const seam = model.seams!.filter(({ sourcePathId }) => sourcePathId === 'ab-diagonal-cut');
    const gaps = sharedEdgeGapsAt(model, [{
      aPanelId: seam[0]!.ownerPanelId,
      bPanelId: seam[1]!.ownerPanelId,
      points: seam[0]!.points,
    }], 0.5);

    expect(seam).toHaveLength(2);
    expect(seam.map(({ ownerPanelId }) => ownerPanelId).sort()).toEqual(['A', 'B']);
    expect(gaps[0]!.maxGapMm).toBeGreaterThan(1);
  });
});

describe('BoxInvariant severity 與 builder 邊界', () => {
  it('三盒 invariant 全數顯式分類，warning ID 清單凍結為三條', () => {
    const boxes = [reverseTuckEnd, tuckTopSnapLock, triangularTube];
    const all = boxes.flatMap((box) => box.invariants);

    expect(all.every(({ severity }) => severity === 'error' || severity === 'warning')).toBe(true);
    expect(all.filter(({ severity }) => severity === 'warning').map(({ id }) => id).sort()).toEqual([
      'receive-depth-vs-corner',
      'snap-lock-engagement-firm',
      'tuck-radius-clamped',
    ]);
  });

  it.each([
    ['RTE', reverseTuckEnd, { tuckLock: 2 }, 'tuck-lock-fits'],
    ['TTSL', tuckTopSnapLock, { tuckDepth: 0 }, 'tuck-depth-within-body'],
    ['TTB', triangularTube, { tubeLength: 80, tabWidth: 100 }, 'tab-base-geometry'],
  ] as const)('%s 真 error 違反會拋具名 InvalidBoxParamsError', (_name, box, overrides, invariantId) => {
    const generated = generate(box, overrides);

    try {
      assertBoxInvariants(box, generated.params, generated.result);
      throw new Error('預期 assertBoxInvariants 拋錯');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidBoxParamsError);
      expect((error as InvalidBoxParamsError).invariantId).toBe(invariantId);
    }
  });

  it.each([
    ['RTE radius 鉗制', reverseTuckEnd, { tuckRadius: 14, tuckDepth: 10 }],
    ['TTSL 淺咬合', tuckTopSnapLock, { lockFlapDepth: 34 }],
    ['TTSL 缺口圓角鉗制', tuckTopSnapLock, { lockReceiveDepth: 1 }],
  ] as const)('%s warning 違反不阻擋建模', (_name, box, overrides) => {
    const generated = generate(box, overrides);
    expect(() => assertBoxInvariants(box, generated.params, generated.result)).not.toThrow();
  });
});

describe('panelize 輸入合約與決定性', () => {
  it.each([
    ['少 id', threeBandAngles().slice(0, 2)],
    ['多 id', [...threeBandAngles(), { id: 'D', foldAngle: 0 }]],
    ['錯 id', threeBandAngles().map((angle) => angle.id === 'C' ? { ...angle, id: 'D' } : angle)],
  ])('angles %s 時具名失敗', (_name, angles) => {
    expect(() => panelizeFoldModel(threeBandResult(), 'A', angles, NO_STEPS)).toThrow(/angles/);
  });

  it('paths 打亂後 panel polygon、hingeLine 與 trace multiset 全不變', () => {
    const generated = threeBandResult({ slot: true, equalHingeSegments: true, danglingCut: true });
    const reordered = {
      ...generated,
      paths: [generated.paths[3]!, generated.paths[0]!, generated.paths[5]!, generated.paths[2]!, generated.paths[4]!, generated.paths[1]!],
    };
    const first = panelizeFoldModel(generated, 'A', threeBandAngles(), NO_STEPS);
    const second = panelizeFoldModel(reordered, 'A', threeBandAngles(), NO_STEPS);

    expect(second.panels).toEqual(first.panels);
    expect(second.panels.flatMap(({ hingeSourceCreaseIds }) => hingeSourceCreaseIds ?? []).sort()).toEqual(
      first.panels.flatMap(({ hingeSourceCreaseIds }) => hingeSourceCreaseIds ?? []).sort(),
    );
  });
});
