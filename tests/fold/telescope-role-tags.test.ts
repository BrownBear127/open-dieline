import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import type { DielinePath, GenerateResult } from '@/core/types';

function piecePaths(result: GenerateResult, pieceId: string): DielinePath[] {
  const piece = result.pieces!.find(({ id }) => id === pieceId)!;
  return result.paths.filter(({ id }) => piece.pathIds.includes(id));
}

function tagged(paths: DielinePath[], ...tags: string[]): DielinePath {
  const path = paths.find((candidate) => tags.every((tag) => candidate.tags?.includes(tag)));
  expect(path, `找不到 tags=${tags.join(',')} 的 path`).toBeDefined();
  return path!;
}

function typedTagged(
  paths: DielinePath[],
  type: DielinePath['type'],
  ...tags: string[]
): DielinePath {
  const path = paths.find((candidate) =>
    candidate.type === type && tags.every((tag) => candidate.tags?.includes(tag)));
  expect(path, `找不到 type=${type} tags=${tags.join(',')} 的 path`).toBeDefined();
  return path!;
}

function semantics(path: DielinePath): string[] {
  return path.tags?.filter((tag) =>
    tag.startsWith('fold:') || tag.startsWith('fold-boundary:')) ?? [];
}

describe('telescope 2D crease role tags', () => {
  const generated = telescope.generate(resolveParams(telescope, {}));
  const base = piecePaths(generated, 'base');
  const lid = piecePaths(generated, 'lid');
  const liner = piecePaths(generated, 'liner');

  it('P+ wall chains distinguish root, both rim hinges, and tongue hinge', () => {
    expect(semantics(tagged(base, 'wallRoot', 'left'))).toEqual([
      'fold:floor>wallXNeg-outer',
    ]);
    expect(semantics(tagged(base, 'wallTop', 'left'))).toEqual([
      'fold:wallXNeg-outer>wallXNeg-rim',
      'fold:wallXNeg-rim>wallXNeg-inner',
    ]);
    expect(semantics(typedTagged(base, 'halfcut', 'tongueFold', 'left'))).toEqual([
      'fold:wallXNeg-inner>wallXNeg-tongue',
    ]);
  });

  it('P+ y-wall jog marks the central hinge and two closure subsegments separately', () => {
    expect(semantics(tagged(base, 'wallRoot', 'front'))).toEqual([
      'fold:floor>wallYNeg-outer',
      'fold-boundary:closure:floor>wingYNegNeg',
      'fold-boundary:closure:floor>wingYPosNeg',
    ]);
  });

  it('P+ gusset and corner flap identify both wing hinges, diagonal closure, and flap hinge', () => {
    expect(semantics(tagged(base, 'gussetFold', 'right-back'))).toEqual([
      'fold:wallXPos-outer>wingXPosPos',
      'fold:wallYPos-outer>wingYPosPos',
    ]);
    expect(semantics(typedTagged(base, 'crease', 'gusset', 'right-back'))).toEqual([
      'fold-boundary:closure:wingXPosPos>wingYPosPos',
    ]);
    expect(semantics(tagged(base, 'cornerFlapFold', 'right-back'))).toEqual([
      'fold:wallXPos-inner>flapPosPos',
    ]);
  });

  it('P0 wall and gusset split the x extension plus y jog boundary from the true hinges', () => {
    expect(semantics(tagged(lid, 'wallTop', 'left'))).toEqual([
      'fold:wallXNeg-outer>wallXNeg-inner',
    ]);
    expect(semantics(tagged(lid, 'gussetFold', 'right-back'))).toEqual([
      'fold:wallXPos-outer>wingXPosPos',
      'fold:wallXPos-inner>gussetExtPosPos',
      'fold:wallYPos-outer>wingYPosPos',
    ]);
    expect(semantics(typedTagged(lid, 'crease', 'gusset', 'right-back'))).toEqual([
      'fold-boundary:closure:wingXPosPos>wingYPosPos',
    ]);
  });

  it('liner pad edges each name one stable leg child', () => {
    expect(liner.filter(({ type }) => type === 'crease').map((path) => semantics(path)))
      .toEqual([
        ['fold:linerPad>linerLegXNeg'],
        ['fold:linerPad>linerLegXPos'],
        ['fold:linerPad>linerLegYNeg'],
        ['fold:linerPad>linerLegYPos'],
      ]);
  });
});
