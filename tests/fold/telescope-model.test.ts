import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import type { GenerateResult, ResolvedParams } from '@/core/types';
import { flattenSegment } from '@/fold/derive/flatten';
import {
  buildTelescopeSceneSpec,
  TELESCOPE_PANEL_IDS,
} from '@/fold/models/telescope';
import type { FoldModel, Pt } from '@/fold/types';

type Overrides = Partial<Record<string, number | boolean>>;
type ParentRows = Array<[id: string, parent: string | null]>;

function params(overrides: Overrides = {}): ResolvedParams {
  return resolveParams(telescope, overrides);
}

function pieceModel(
  resolved: ResolvedParams,
  pieceId: string,
): FoldModel {
  const piece = buildTelescopeSceneSpec(resolved).pieces
    .find((candidate) => candidate.pieceId === pieceId);
  expect(piece, `找不到 scene piece ${pieceId}`).toBeDefined();
  return piece!.buildModel(resolved);
}

const CORNERS = ['NegNeg', 'NegPos', 'PosNeg', 'PosPos'] as const;
const WALLS = [
  ['X', 'Neg'],
  ['X', 'Pos'],
  ['Y', 'Neg'],
  ['Y', 'Pos'],
] as const;

function trayParents(family: 'P0' | 'P+', chainFits = true): ParentRows {
  const rows: ParentRows = [[TELESCOPE_PANEL_IDS.floor, null]];
  for (const [axis, sign] of WALLS) {
    const outer = `wall${axis}${sign}-outer`;
    const inner = `wall${axis}${sign}-inner`;
    rows.push([outer, TELESCOPE_PANEL_IDS.floor]);
    if (family === 'P+') {
      const rim = `wall${axis}${sign}-rim`;
      rows.push([rim, outer], [inner, rim]);
    } else {
      rows.push([inner, outer]);
    }
    rows.push([`wall${axis}${sign}-tongue`, inner]);
  }
  for (const corner of CORNERS) {
    const xSign = corner.startsWith('Neg') ? 'Neg' : 'Pos';
    const ySign = corner.endsWith('Neg') ? 'Neg' : 'Pos';
    rows.push(
      [`wingX${corner}`, `wallX${xSign}-outer`],
      [`wingY${corner}`, `wallY${ySign}-outer`],
    );
    if (family === 'P+' && chainFits) {
      rows.push([`flap${corner}`, `wallX${xSign}-inner`]);
    }
    if (family === 'P0') {
      rows.push([`gussetExt${corner}`, `wallX${xSign}-inner`]);
    }
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}

function actualParents(model: FoldModel): ParentRows {
  return model.panels
    .map(({ id, parent }) => [id, parent] satisfies [string, string | null])
    .sort(([a], [b]) => a.localeCompare(b));
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function pointKey(point: Pt): string {
  return `${rounded(point.x)},${rounded(point.y)}`;
}

function undirectedEdgeKey(a: Pt, b: Pt): string {
  const first = pointKey(a);
  const second = pointKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function modelBoundarySignature(model: FoldModel): string[] {
  const counts = new Map<string, number>();
  for (const panel of model.panels) {
    for (let index = 0; index < panel.polygon.length; index++) {
      const key = undirectedEdgeKey(
        panel.polygon[index]!,
        panel.polygon[(index + 1) % panel.polygon.length]!,
      );
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count === 1)
    .map(([key]) => key)
    .sort();
}

function dielineBoundarySignature(
  paths: FoldModel['dieline'],
): string[] {
  return paths.flatMap(({ type, segments }) =>
    segments.flatMap((segment) => {
      const points = flattenSegment(segment, 0.05);
      return points.slice(0, -1).map((point, index) =>
        `${type}:${undirectedEdgeKey(point, points[index + 1]!)}`);
    })).sort();
}

function guidePointBounds(model: FoldModel): [number, number, number, number] {
  const points = model.dieline.flatMap(({ segments }) =>
    segments.flatMap((segment) => flattenSegment(segment, 0.05)));
  return [
    rounded(Math.min(...points.map(({ x }) => x))),
    rounded(Math.min(...points.map(({ y }) => y))),
    rounded(Math.max(...points.map(({ x }) => x))),
    rounded(Math.max(...points.map(({ y }) => y))),
  ];
}

function panelPointBounds(model: FoldModel): [number, number, number, number] {
  const points = model.panels.flatMap(({ polygon }) => polygon);
  return [
    rounded(Math.min(...points.map(({ x }) => x))),
    rounded(Math.min(...points.map(({ y }) => y))),
    rounded(Math.max(...points.map(({ x }) => x))),
    rounded(Math.max(...points.map(({ y }) => y))),
  ];
}

function sourcePiece(generated: GenerateResult, pieceId: string) {
  return generated.pieces!.find((piece) => piece.id === pieceId)!;
}

describe('Telescope per-piece fold topology', () => {
  it('default：base=P+ chainFits、lid=P0、liner=5 面', () => {
    const resolved = params();
    const scene = buildTelescopeSceneSpec(resolved);

    expect(scene.pieces.map(({ pieceId }) => pieceId)).toEqual(['base', 'lid', 'liner']);
    expect(actualParents(pieceModel(resolved, 'base'))).toEqual(trayParents('P+', true));
    expect(actualParents(pieceModel(resolved, 'lid'))).toEqual(trayParents('P0'));
    expect(actualParents(pieceModel(resolved, 'liner'))).toEqual([
      ['linerLegXNeg', 'linerPad'],
      ['linerLegXPos', 'linerPad'],
      ['linerLegYNeg', 'linerPad'],
      ['linerLegYPos', 'linerPad'],
      ['linerPad', null],
    ]);
  });

  it('P+ chainFits=false：角翼與 2D relief 鏈同時省略', () => {
    const resolved = params({ lidPlatformWidth: 5 });

    expect(actualParents(pieceModel(resolved, 'base'))).toEqual(trayParents('P+', true));
    expect(actualParents(pieceModel(resolved, 'lid'))).toEqual(trayParents('P+', false));
  });

  it('M-16：lid P+ 有四翼，base P0 無翼且保留四個 gusset extension', () => {
    const resolved = params({
      basePlatformWidth: 0,
      lidPlatformWidth: 5,
      lidHeight: 60,
    });
    const base = pieceModel(resolved, 'base');
    const lid = pieceModel(resolved, 'lid');

    expect(actualParents(base)).toEqual(trayParents('P0'));
    expect(actualParents(lid)).toEqual(trayParents('P+', true));
    expect(base.panels.filter(({ id }) => id.startsWith('flap'))).toHaveLength(0);
    expect(lid.panels.filter(({ id }) => id.startsWith('flap'))).toHaveLength(4);
  });

  it('liner off：scene 僅保留 lid/base 兩片', () => {
    const resolved = params({ linerEnabled: false });

    expect(buildTelescopeSceneSpec(resolved).pieces.map(({ pieceId }) => pieceId))
      .toEqual(['base', 'lid']);
  });

  it.each([
    ['M-05 rootJog=0', { rootJog: 0 }, [29, 25, 5]],
    [
      'M-09 最小合法包絡',
      {
        baseLength: 33,
        baseWidth: 33,
        baseHeight: 10,
        lidMarginX: 5,
        lidMarginY: 5,
        lidHeight: 17,
        linerFlapDepth: 5,
      },
      [25, 25, 5],
    ],
    [
      'M-10 schema max',
      {
        baseLength: 600,
        baseWidth: 600,
        baseHeight: 200,
        lidMarginX: 60,
        lidMarginY: 60,
        lidHeight: 200,
      },
      [25, 25, 5],
    ],
  ] as const)(
    '%s：合法尺寸仍能建立完整 per-piece topology',
    (_label, overrides, expectedCounts) => {
      const resolved = params(overrides);
      const models = buildTelescopeSceneSpec(resolved).pieces
        .map((piece) => piece.buildModel(resolved));

      expect(models.map(({ panels }) => panels.length)).toEqual(expectedCounts);
    },
  );

});

describe('Telescope AC-T1 flat-space identity', () => {
  it.each(['lid', 'base', 'liner'] as const)(
    'default %s：模型維持 2D 絕對座標，guide 全量逐值複製',
    (pieceId) => {
      const resolved = params();
      const generated = telescope.generate(resolved);
      const piece = sourcePiece(generated, pieceId);
      const expectedGuide: FoldModel['dieline'] = generated.paths.flatMap(
        ({ id, type, segments }) =>
          piece.pathIds.includes(id) && (type === 'cut' || type === 'crease')
            ? [{ id, type, segments }]
            : [],
      );
      const model = pieceModel(resolved, pieceId);

      expect(model.dieline).toEqual(expectedGuide);
      expect(dielineBoundarySignature(model.dieline))
        .toEqual(dielineBoundarySignature(expectedGuide));
      expect(modelBoundarySignature(model).length).toBeGreaterThan(0);
      expect(panelPointBounds(model)).toEqual(guidePointBounds(model));
    },
  );
});
