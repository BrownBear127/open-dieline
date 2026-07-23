// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import type { BoxModule, DielinePath, GenerateResult, ResolvedParams } from '@/core/types';
import { resolveParams } from '@/core/registry';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { triangularTube } from '@/boxes/triangular-tube';

type Overrides = Partial<Record<string, number | boolean | string>>;
type PathWithInactiveSegments = DielinePath & { inactiveSegments?: number[] };

function generate(box: BoxModule, overrides: Overrides = {}): { params: ResolvedParams; result: GenerateResult } {
  const params = resolveParams(box, overrides);
  return { params, result: box.generate(params) };
}

function withoutAdditiveMetadata(result: GenerateResult): GenerateResult {
  return {
    ...result,
    paths: result.paths.map((path) => {
      const { tags: _tags, inactiveSegments: _inactiveSegments, ...geometry } = path as PathWithInactiveSegments;
      return geometry;
    }),
  };
}

function nonFoldTagMultiset(result: GenerateResult): string[] {
  return result.paths.flatMap((path) => path.tags?.filter((tag) => !tag.startsWith('fold:')) ?? []);
}

function foldTags(path: DielinePath): string[] {
  return path.tags?.filter((tag) => tag.startsWith('fold:')) ?? [];
}

function foldTagCounts(result: GenerateResult): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tag of result.paths.flatMap(foldTags)) counts[tag] = (counts[tag] ?? 0) + 1;
  return counts;
}

function allSegmentIndexes(path: DielinePath): number[] {
  return path.segments.map((_, index) => index);
}

function expectEveryCreaseClassified(result: GenerateResult): void {
  for (const path of result.paths.filter(({ type }) => type === 'crease')) {
    const roles = foldTags(path);
    const inactive = (path as PathWithInactiveSegments).inactiveSegments;
    const fullyInactive = inactive !== undefined && inactive.length === path.segments.length &&
      inactive.every((index, position) => index === position);

    expect(roles.every((tag) => /^fold:[A-Za-z0-9.]+>[A-Za-z0-9.]+$/.test(tag)), `${path.id} role tag 語法`).toBe(true);
    expect(
      (roles.length === 1 && inactive === undefined) || (roles.length === 0 && fullyInactive),
      `${path.id} crease 必須恰為 role 或全段 inactive：${JSON.stringify({ roles, inactive })}`,
    ).toBe(true);
  }

  for (const path of result.paths.filter(({ type }) => type === 'dimension' || type === 'annotation')) {
    expect(foldTags(path), `${path.id} ${path.type} 不得帶 fold role`).toEqual([]);
  }
}

const frozenCases: Array<{ name: string; box: BoxModule; overrides?: Overrides }> = [
  { name: 'RTE 預設', box: reverseTuckEnd },
  { name: 'RTE 雙側零寬', box: reverseTuckEnd, overrides: { L: 20, tuckClearance: 10, thickness: 0 } },
  { name: 'RTE 雙側零深', box: reverseTuckEnd, overrides: { tuckDepth: 0 } },
  { name: 'RTE 雙零態', box: reverseTuckEnd, overrides: { L: 20, tuckClearance: 10, thickness: 0, tuckDepth: 0 } },
  { name: 'RTE 單側零寬', box: reverseTuckEnd, overrides: { L: 20, tuckClearance: 10 } },
  { name: 'RTE 防塵翼零深', box: reverseTuckEnd, overrides: { dustFlapDepth: 0 } },
  { name: 'RTE 右糊邊最大紙厚', box: reverseTuckEnd, overrides: { glueSide: 'right', thickness: 0.8 } },
  { name: 'TTSL 預設左糊邊', box: tuckTopSnapLock },
  { name: 'TTSL 右糊邊最大紙厚', box: tuckTopSnapLock, overrides: { glueSide: 'right', thickness: 0.8 } },
  { name: 'TTB 預設', box: triangularTube },
  { name: 'TTB 短管', box: triangularTube, overrides: { tubeLength: 115 } },
  { name: 'TTB 最窄插舌', box: triangularTube, overrides: { tabWidth: 30 } },
];

describe('2D generator 幾何與既有 tags 凍結', () => {
  for (const { name, box, overrides } of frozenCases) {
    it(`${name}：移除 additive metadata 後 JSON.stringify 逐字不變`, () => {
      const { result } = generate(box, overrides);
      expect(JSON.stringify(withoutAdditiveMetadata(result))).toMatchSnapshot();
    });

    it(`${name}：既有非 fold:* tags multiset 逐條不變`, () => {
      const { result } = generate(box, overrides);
      expect(nonFoldTagMultiset(result)).toMatchSnapshot();
    });
  }
});

const rteBaseTags = ['fold:P1>P2', 'fold:P2>P3', 'fold:P3>P4'] as const;
const rteLidTags = ['fold:P3>topLid', 'fold:P1>bottomLid'] as const;
const rteTuckTags = ['fold:topLid>topTuck', 'fold:bottomLid>bottomTuck'] as const;
const rteDustTags = [
  'fold:P2>topDustP2',
  'fold:P4>topDustP4',
  'fold:P2>bottomDustP2',
  'fold:P4>bottomDustP4',
] as const;

interface RteCase {
  name: string;
  overrides?: Overrides;
  topTuck: boolean;
  bottomTuck: boolean;
  dust: boolean;
}

const rteCases: RteCase[] = [
  { name: '預設', topTuck: true, bottomTuck: true, dust: true },
  { name: 'tuckDepth=0', overrides: { tuckDepth: 0 }, topTuck: false, bottomTuck: false, dust: true },
  { name: 'tuckLock=0', overrides: { tuckLock: 0 }, topTuck: true, bottomTuck: true, dust: true },
  { name: 'dustFlapDepth=0', overrides: { dustFlapDepth: 0 }, topTuck: true, bottomTuck: true, dust: false },
  {
    name: 'L=20/tuckClearance=10/thickness=0 雙側零寬',
    overrides: { L: 20, tuckClearance: 10, thickness: 0 },
    topTuck: false,
    bottomTuck: false,
    dust: true,
  },
  {
    name: 'L=20/tuckClearance=10/default thickness 單側零寬',
    overrides: { L: 20, tuckClearance: 10 },
    topTuck: true,
    bottomTuck: false,
    dust: true,
  },
  {
    name: '雙零態',
    overrides: { L: 20, tuckClearance: 10, thickness: 0, tuckDepth: 0 },
    topTuck: false,
    bottomTuck: false,
    dust: true,
  },
  { name: '右糊邊', overrides: { glueSide: 'right' }, topTuck: true, bottomTuck: true, dust: true },
];

function expectedRteTags(testCase: RteCase): string[] {
  const glueTag = testCase.overrides?.glueSide === 'right' ? 'fold:P4>glue' : 'fold:P1>glue';
  return [
    ...rteBaseTags,
    glueTag,
    ...rteLidTags,
    ...(testCase.topTuck ? [rteTuckTags[0]] : []),
    ...(testCase.bottomTuck ? [rteTuckTags[1]] : []),
    ...(testCase.dust ? rteDustTags : []),
  ].sort();
}

describe('RTE role tags 與缺席面板覆蓋', () => {
  for (const testCase of rteCases) {
    it(`${testCase.name}：unique role tags 等於非 root 邏輯 panel，且 crease 無漏標`, () => {
      const { result } = generate(reverseTuckEnd, testCase.overrides);
      expect(Object.keys(foldTagCounts(result)).sort()).toEqual(expectedRteTags(testCase));
      expect(Object.values(foldTagCounts(result)).every((count) => count === 1)).toBe(true);
      expectEveryCreaseClassified(result);
    });
  }

  it('四種插舌狀態的 mixed cut、tuck crease 與 friction-lock cut 使用精確 inactiveSegments', () => {
    const cases = [
      { name: '雙有效', overrides: {}, tuckCut: undefined, tuckCrease: undefined, lockCut: undefined },
      { name: '零寬', overrides: { L: 20, tuckClearance: 10, thickness: 0 }, tuckCut: [1, 2, 3], tuckCrease: [0, 1], lockCut: [0, 1, 2] },
      { name: '零深', overrides: { tuckDepth: 0 }, tuckCut: [1, 3], tuckCrease: [0, 1], lockCut: [0, 1, 2] },
      { name: '雙零', overrides: { L: 20, tuckClearance: 10, thickness: 0, tuckDepth: 0 }, tuckCut: [1, 2, 3], tuckCrease: [0, 1], lockCut: [0, 1, 2] },
    ];

    for (const testCase of cases) {
      const { result } = generate(reverseTuckEnd, testCase.overrides);
      const tuckCuts = result.paths.filter((path) => path.type === 'cut' && path.tags?.includes('tuckDepth')) as PathWithInactiveSegments[];
      const tuckCreases = result.paths.filter((path) => path.type === 'crease' && path.tags?.includes('W')) as PathWithInactiveSegments[];
      const lockCuts = result.paths.filter((path) => path.type === 'cut' && path.tags?.includes('tuckLock')) as PathWithInactiveSegments[];

      expect(tuckCuts, `${testCase.name} top/bottom tuck cut`).toHaveLength(2);
      expect(tuckCreases, `${testCase.name} top/bottom tuck crease`).toHaveLength(2);
      expect(lockCuts, `${testCase.name} top/bottom friction-lock cut`).toHaveLength(2);
      for (const path of tuckCuts) expect(path.inactiveSegments, `${testCase.name} ${path.id} tuck cut`).toEqual(testCase.tuckCut);
      for (const path of tuckCreases) expect(path.inactiveSegments, `${testCase.name} ${path.id} tuck crease`).toEqual(testCase.tuckCrease);
      for (const path of lockCuts) expect(path.inactiveSegments, `${testCase.name} ${path.id} lock cut`).toEqual(testCase.lockCut);
    }
  });

  it('單側零寬停用 bottom tuck；0.3mm top tuck 保留 role，但停用放不下的 friction lock', () => {
    const { result } = generate(reverseTuckEnd, { L: 20, tuckClearance: 10 });
    const tuckCuts = result.paths.filter((path) => path.type === 'cut' && path.tags?.includes('tuckDepth')) as PathWithInactiveSegments[];
    const tuckCreases = result.paths.filter((path) => path.type === 'crease' && path.tags?.includes('W')) as PathWithInactiveSegments[];
    const lockCuts = result.paths.filter((path) => path.type === 'cut' && path.tags?.includes('tuckLock')) as PathWithInactiveSegments[];

    expect(tuckCuts.map(({ inactiveSegments }) => inactiveSegments)).toEqual([undefined, [1, 2, 3]]);
    expect(tuckCreases.map(({ inactiveSegments }) => inactiveSegments)).toEqual([undefined, [0, 1]]);
    expect(lockCuts.map(({ inactiveSegments }) => inactiveSegments)).toEqual([[0, 1, 2], [0, 1, 2]]);
    expect(foldTags(tuckCreases[0]!)).toEqual(['fold:topLid>topTuck']);
    expect(foldTags(tuckCreases[1]!)).toEqual([]);
  });

  it('dustFlapDepth=0 時四條 dust crease 全段 inactive', () => {
    const { result } = generate(reverseTuckEnd, { dustFlapDepth: 0 });
    const dustCreases = result.paths.filter((path) => path.type === 'crease' && path.tags?.includes('dustFlapDepth')) as PathWithInactiveSegments[];
    expect(dustCreases).toHaveLength(4);
    for (const path of dustCreases) expect(path.inactiveSegments).toEqual(allSegmentIndexes(path));
  });

  it('tuckDepth=0 時中間水平段維持 active，並與兩側蓋板外框連續', () => {
    const { result } = generate(reverseTuckEnd, { tuckDepth: 0 });
    const tuckCuts = result.paths.filter((path) => path.type === 'cut' && path.tags?.includes('tuckDepth')) as PathWithInactiveSegments[];
    expect(tuckCuts).toHaveLength(2);

    for (const path of tuckCuts) {
      const activeEntries = path.segments
        .map((segment, index) => ({ segment, index }))
        .filter(({ index }) => !path.inactiveSegments?.includes(index));
      expect(activeEntries.map(({ index }) => index)).toEqual([0, 2, 4]);
      const active = activeEntries.map(({ segment }) => segment);
      expect(active.every((segment) => segment.kind === 'line')).toBe(true);
      const lines = active as Array<Extract<(typeof active)[number], { kind: 'line' }>>;
      expect(lines[0]!.x2).toBe(lines[1]!.x1);
      expect(lines[1]!.x2).toBe(lines[2]!.x1);
      expect(lines.every((line) => line.y1 === line.y2 && line.y1 === lines[0]!.y1)).toBe(true);
    }
  });
});

const ttslExpectedCounts: Record<string, number> = {
  'fold:P1>P2': 1,
  'fold:P2>P3': 1,
  'fold:P3>P4': 1,
  'fold:P1>glue': 1,
  'fold:P1>bottomLockP1': 1,
  'fold:P2>bottomWebP2': 1,
  'fold:P3>bottomReceiveP3': 1,
  'fold:P4>bottomWebP4': 1,
  'fold:P3>topLid': 1,
  'fold:topLid>topTuck': 1,
  'fold:P2>topDustP2': 1,
  'fold:P4>topDustP4': 1,
};

describe('TTSL role tags', () => {
  for (const glueSide of ['left', 'right'] as const) {
    it(`${glueSide} 版型完整對應現行邏輯 panel 樹`, () => {
      const { result } = generate(tuckTopSnapLock, { glueSide });
      expect(foldTagCounts(result)).toEqual(ttslExpectedCounts);
      expectEveryCreaseClassified(result);
    });
  }
});

const ttbExpectedCounts: Record<string, number> = {
  'fold:faceA>faceB': 2,
  'fold:faceB>faceC': 1,
  'fold:faceC>zoneDBase': 1,
  'fold:zoneDBase>zoneDTab': 2,
  'fold:faceB>endStartMain': 1,
  'fold:endStartMain>endStartWingTop': 1,
  'fold:endStartMain>endStartWingBottom': 1,
  'fold:faceB>endEndMain': 1,
  'fold:endEndMain>endEndWingTop': 1,
  'fold:endEndMain>endEndWingBottom': 1,
};

describe('TTB role tags', () => {
  for (const [name, overrides] of [
    ['預設', {}],
    ['最短代表管長', { tubeLength: 115 }],
    ['公開最窄插舌', { tabWidth: 30 }],
  ] as const) {
    it(`${name}：分段 logical crease group 共用同一 role tag`, () => {
      const { result } = generate(triangularTube, overrides);
      expect(foldTagCounts(result)).toEqual(ttbExpectedCounts);
      expect(Object.keys(foldTagCounts(result))).toHaveLength(10);
      expectEveryCreaseClassified(result);
    });
  }
});

describe('no-cut-self-intersection inactive segment 豁免', () => {
  const invariant = reverseTuckEnd.invariants.find(({ id }) => id === 'no-cut-self-intersection')!;

  it('active×active 真交叉仍判定不通過', () => {
    const { params } = generate(reverseTuckEnd);
    const result: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }] },
        { id: 'p-1', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 10, x2: 10, y2: 0 }] },
      ],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    expect(invariant.check(params, result)).toMatchObject({ ok: false });
  });

  it('至少一方 inactive 的交叉不參與判定', () => {
    const { params } = generate(reverseTuckEnd);
    const result: GenerateResult = {
      paths: [
        { id: 'p-0', type: 'cut', inactiveSegments: [0], segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }] },
        { id: 'p-1', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 10, x2: 10, y2: 0 }] },
      ],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    expect(invariant.check(params, result)).toMatchObject({ ok: true });
  });

  for (const thickness of [0, 0.3] as const) {
    for (const glueSide of ['left', 'right'] as const) {
      it(`L=20/tuckClearance=10/thickness=${thickness}/${glueSide} 版型通過`, () => {
        const { params, result } = generate(reverseTuckEnd, { L: 20, tuckClearance: 10, thickness, glueSide });
        expect(invariant.check(params, result)).toMatchObject({ ok: true });
      });
    }
  }
});
