// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { resolveParams } from '@/core/registry';
import type { BoxModule, GenerateResult, ResolvedParams } from '@/core/types';
import {
  clampFoldPanelsToBodyHull,
  panelizeFoldModel,
  splitFoldPanelHorizontally,
  type PanelAngleSpec,
} from '@/fold/derive/panelize';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel, TTB_BODY_HULL_CLAMP_SPEC } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import type { FoldDielinePath, FoldModel } from '@/fold/types';
import {
  artworkLayoutSignature,
  deriveArtworkLayout,
} from '@/ui/artwork-layout';
import { buildTemplateSvg } from '@/ui/fold-template';

type Overrides = Partial<Record<string, number | boolean | string>>;

interface SingleSourceCase {
  label: string;
  box: BoxModule;
  rootId: string;
  overrides: Overrides;
  build: (params: ResolvedParams) => FoldModel;
}

const BOX_CASES: SingleSourceCase[] = [
  {
    label: 'RTE',
    box: reverseTuckEnd,
    rootId: 'P1',
    overrides: {},
    build: buildRteFoldModel,
  },
  {
    label: 'TTSL',
    box: tuckTopSnapLock,
    rootId: 'P1',
    overrides: {},
    build: buildTtslFoldModel,
  },
  {
    label: 'TTB',
    box: triangularTube,
    rootId: 'faceA',
    overrides: {},
    build: buildTtbFoldModel,
  },
];

const SIGNATURE_CASES: SingleSourceCase[] = [
  ...[reverseTuckEnd, tuckTopSnapLock].flatMap((box) => {
    const base = BOX_CASES.find((testCase) => testCase.box === box)!;
    return ([0, 0.3, 0.8] as const).flatMap((thickness) =>
      (['left', 'right'] as const).map((glueSide) => ({
        ...base,
        label: `${base.label} glueSide=${glueSide}, thickness=${thickness}`,
        overrides: { glueSide, thickness },
      })));
  }),
  BOX_CASES[2]!,
];

const GUIDE_CASES: SingleSourceCase[] = [
  ...BOX_CASES,
  ...[
    ['RTE tuckLock=0', { tuckLock: 0 }],
    ['RTE tuckDepth=0', { tuckDepth: 0 }],
    ['RTE dustFlapDepth=0', { dustFlapDepth: 0 }],
    ['RTE single zero width', { L: 20, tuckClearance: 10 }],
    ['RTE double zero width', { L: 20, tuckClearance: 10, thickness: 0 }],
  ].map(([label, overrides]) => ({
    ...BOX_CASES[0]!,
    label: label as string,
    overrides: overrides as Overrides,
  })),
];

function resolved(testCase: SingleSourceCase): ResolvedParams {
  return resolveParams(testCase.box, testCase.overrides);
}

function reorderedResult(result: GenerateResult): GenerateResult {
  const paths = [...result.paths];
  const even = paths.filter((_, index) => index % 2 === 0).reverse();
  const odd = paths.filter((_, index) => index % 2 === 1).reverse();
  return { ...result, paths: [...odd, ...even] };
}

function angleSpecs(model: FoldModel): PanelAngleSpec[] {
  return model.panels.map(({ id, foldAngle, liftOffset }) => ({ id, foldAngle, liftOffset }));
}

function reproducePostProcessedModel(
  result: GenerateResult,
  testCase: SingleSourceCase,
  expected: FoldModel,
): FoldModel {
  const virtualPanels = expected.panels.filter(({ hingeLine }) => hingeLine?.virtual === true);
  const virtualIds = new Set(virtualPanels.map(({ id }) => id));
  let reproduced = panelizeFoldModel(
    result,
    testCase.rootId,
    angleSpecs(expected).filter(({ id }) => !virtualIds.has(id)),
    expected.steps.filter(({ panelIds }) => panelIds.every((id) => !virtualIds.has(id))),
  );

  for (const virtualPanel of virtualPanels) {
    const child = expected.panels.find(({ parent }) => parent === virtualPanel.id)!;
    reproduced = splitFoldPanelHorizontally(reproduced, {
      panelId: virtualPanel.parent!,
      newPanelId: virtualPanel.id,
      reparentChildId: child.id,
      splitY: virtualPanel.hingeLine!.a.y,
      foldAngle: virtualPanel.foldAngle,
    });
  }
  // 端封件視覺 allowance（vertexClamp）也屬後處理——expected 含收束頂點時重放。
  if (expected.panels.some(({ vertexClamp }) => vertexClamp !== undefined)) {
    reproduced = clampFoldPanelsToBodyHull(reproduced, TTB_BODY_HULL_CLAMP_SPEC);
  }
  return { ...reproduced, steps: expected.steps };
}

function expectedDieline(result: GenerateResult): FoldDielinePath[] {
  return result.paths.flatMap((path): FoldDielinePath[] => {
    if (path.type !== 'cut' && path.type !== 'crease') return [];
    return [{ id: path.id, type: path.type, segments: path.segments }];
  });
}

function parseTemplateDieline(svg: string): FoldDielinePath[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const elements = Array.from(doc.getElementsByTagName('*'))
    .filter((element) => element.hasAttribute('data-dieline-path-id'));
  const paths = new Map<string, FoldDielinePath>();
  for (const element of elements) {
    const id = element.getAttribute('data-dieline-path-id')!;
    const type = element.getAttribute('data-dieline-type') as FoldDielinePath['type'];
    const kind = element.getAttribute('data-dieline-kind');
    const path = paths.get(id) ?? { id, type, segments: [] };
    if (kind === 'line') {
      path.segments.push({
        kind,
        x1: Number(element.getAttribute('x1')),
        y1: Number(element.getAttribute('y1')),
        x2: Number(element.getAttribute('x2')),
        y2: Number(element.getAttribute('y2')),
      });
    } else if (kind === 'arc') {
      path.segments.push({
        kind,
        cx: Number(element.getAttribute('data-cx')),
        cy: Number(element.getAttribute('data-cy')),
        r: Number(element.getAttribute('data-r')),
        startAngle: Number(element.getAttribute('data-start-angle')),
        endAngle: Number(element.getAttribute('data-end-angle')),
        ccw: element.getAttribute('data-ccw') === 'true',
      });
    } else if (kind === 'bezier') {
      path.segments.push({
        kind,
        x1: Number(element.getAttribute('data-x1')),
        y1: Number(element.getAttribute('data-y1')),
        c1x: Number(element.getAttribute('data-c1x')),
        c1y: Number(element.getAttribute('data-c1y')),
        c2x: Number(element.getAttribute('data-c2x')),
        c2y: Number(element.getAttribute('data-c2y')),
        x2: Number(element.getAttribute('data-x2')),
        y2: Number(element.getAttribute('data-y2')),
      });
    } else {
      throw new Error(`unexpected guide segment kind: ${kind}`);
    }
    paths.set(id, path);
  }
  return [...paths.values()];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('signature 決定性與 path 重排穩定', () => {
  it.each(SIGNATURE_CASES)('$label：同 params 兩次 build 的 signature 逐字相同', (testCase) => {
    const params = resolved(testCase);
    expect(artworkLayoutSignature(testCase.build(params)))
      .toBe(artworkLayoutSignature(testCase.build(params)));
  });

  it.each(BOX_CASES)('$label：path 重排不改 signature、panel id 或 canonical polygon', (testCase) => {
    const params = resolved(testCase);
    const generated = testCase.box.generate(params);
    const expected = testCase.build(params);
    const reordered = reproducePostProcessedModel(
      reorderedResult(generated),
      testCase,
      expected,
    );

    expect(artworkLayoutSignature(reordered)).toBe(artworkLayoutSignature(expected));
    expect(reordered.panels.map(({ id }) => id)).toEqual(expected.panels.map(({ id }) => id));
    expect(reordered.panels.map(({ id, polygon }) => ({ id, polygon })))
      .toEqual(expected.panels.map(({ id, polygon }) => ({ id, polygon })));
  });
});

describe('TEMPLATE、ArtworkLayout 與 2D 刀模三方 segment oracle', () => {
  it.each(GUIDE_CASES)('$label：cut/crease 全量繪製集逐 segment 相同', (testCase) => {
    const params = resolved(testCase);
    const generated = testCase.box.generate(params);
    const model = testCase.build(params);
    const layout = deriveArtworkLayout(model);
    const svg = buildTemplateSvg(layout, {
      boxId: testCase.box.meta.id,
      label: testCase.label,
      lang: 'zh',
    });

    expect(model.dieline).toEqual(expectedDieline(generated));
    expect(layout.dieline).toEqual(expectedDieline(generated));
    expect(parseTemplateDieline(svg)).toEqual(expectedDieline(generated));
  });
});

describe('單一來源掃描', () => {
  it('fold model 骨架沒有 x/y 座標 literal', () => {
    const directory = resolve('src/fold/models');
    for (const path of sourceFiles(directory)) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/\b[xy]\s*:/);
    }
  });

  it('src/ui 沒有退役 fragment id', () => {
    const forbidden = /\b(?:topLid[CLR]|bottomLid[CLR]|bottomReceiveP3\.(?:L|C|R)|zoneDTab\.(?:L|center|R))\b/;
    for (const path of sourceFiles(resolve('src/ui'))) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(forbidden);
    }
  });

  it('repo TypeScript 不再引用退役的 panel-edge guide 重建 helper', () => {
    const retiredName = ['dedup', 'Cut', 'Edges'].join('');
    for (const directory of ['src', 'tests', 'e2e']) {
      for (const path of sourceFiles(resolve(directory))) {
        expect(readFileSync(path, 'utf8'), path).not.toContain(retiredName);
      }
    }
  });
});

describe('TEMPLATE seams 層退役', () => {
  it.each(BOX_CASES)('$label：FoldModel seam metadata 保留，但模板不另建重複圖層', (testCase) => {
    const model = testCase.build(resolved(testCase));
    const layout = deriveArtworkLayout(model);
    expect(layout.seams).toEqual((model.seams ?? []).map(({ points }) => ({ points })));

    const doc = new DOMParser().parseFromString(buildTemplateSvg(layout, {
      boxId: testCase.box.meta.id,
      label: testCase.label,
      lang: 'zh',
    }), 'image/svg+xml');
    const layers = Array.from(doc.getElementsByTagName('g'))
      .filter((element) => element.getAttribute('id') === 'TEMPLATE_SEAMS');
    expect(layers).toHaveLength(0);
    expect(parseTemplateDieline(doc.documentElement.outerHTML)).toEqual(layout.dieline);
  });
});
