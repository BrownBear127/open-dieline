import { describe, expect, it } from 'vitest';
import {
  defineFoldSceneSpec,
  type FoldScenePiece,
  type SceneKeyframe,
} from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';

const MODEL: FoldModel = {
  panels: [{
    id: 'root',
    polygon: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ],
    parent: null,
    foldAngle: 0,
  }],
  steps: [],
  dieline: [],
};

function piece(
  foldWindow: [number, number] = [0, 1],
  assemblyTrack: SceneKeyframe[] = [],
): FoldScenePiece {
  return {
    pieceId: 'piece',
    buildModel: () => MODEL,
    foldWindow,
    assemblyTrack,
  };
}

function keyframe(
  time: number,
  quaternion = { x: 0, y: 0, z: 0, w: 1 },
  position = { x: 0, y: 0, z: 0 },
): SceneKeyframe {
  return { time, position, quaternion };
}

describe('FoldSceneSpec foldWindow build-time validation', () => {
  it('accepts a finite strictly increasing window inside normalized time', () => {
    const spec = defineFoldSceneSpec({ pieces: [piece([0.2, 0.8])] });
    expect(spec.pieces[0]!.foldWindow).toEqual([0.2, 0.8]);
  });

  it.each([
    ['NaN start', [Number.NaN, 0.8]],
    ['infinite end', [0.2, Number.POSITIVE_INFINITY]],
    ['below zero', [-0.1, 0.8]],
    ['above one', [0.2, 1.1]],
    ['equal', [0.5, 0.5]],
    ['reversed', [0.8, 0.2]],
  ] as const)('fails loud for %s', (_label, foldWindow) => {
    expect(() => defineFoldSceneSpec({
      pieces: [piece([...foldWindow] as [number, number])],
    })).toThrow(/foldWindow/);
  });
});

describe('FoldSceneSpec assemblyTrack build-time validation', () => {
  it('accepts an empty track as the identity motion', () => {
    const spec = defineFoldSceneSpec({ pieces: [piece([0, 0.5], [])] });
    expect(spec.pieces[0]!.assemblyTrack).toEqual([]);
  });

  it('keeps the implicit identity anchor implicit and normalizes explicit quaternions', () => {
    const input = keyframe(0.75, { x: 0, y: 0, z: 0, w: 2 });
    const spec = defineFoldSceneSpec({ pieces: [piece([0, 0.5], [input])] });

    expect(spec.pieces[0]!.assemblyTrack).toHaveLength(1);
    expect(spec.pieces[0]!.assemblyTrack[0]).toEqual(
      keyframe(0.75, { x: 0, y: 0, z: 0, w: 1 }),
    );
    expect(spec.pieces[0]!.assemblyTrack[0]).not.toBe(input);
  });

  it.each([
    ['equal to fold end', [keyframe(0.5)]],
    ['before fold end', [keyframe(0.4)]],
  ] as const)('rejects a first explicit keyframe %s', (_label, assemblyTrack) => {
    expect(() => defineFoldSceneSpec({
      pieces: [piece([0, 0.5], [...assemblyTrack])],
    })).toThrow(/first keyframe/);
  });

  it.each([
    ['equal times', [keyframe(0.6), keyframe(0.6)]],
    ['reversed times', [keyframe(0.8), keyframe(0.7)]],
  ] as const)('rejects %s', (_label, assemblyTrack) => {
    expect(() => defineFoldSceneSpec({
      pieces: [piece([0, 0.5], [...assemblyTrack])],
    })).toThrow(/strictly increasing/);
  });

  it.each([
    ['NaN time', keyframe(Number.NaN)],
    ['infinite time', keyframe(Number.POSITIVE_INFINITY)],
    ['time below zero', keyframe(-0.1)],
    ['time above one', keyframe(1.1)],
    ['non-finite position', keyframe(0.75, undefined, { x: Number.NaN, y: 0, z: 0 })],
    ['non-finite quaternion', keyframe(0.75, { x: 0, y: 0, z: 0, w: Number.POSITIVE_INFINITY })],
  ] as const)('rejects %s', (_label, invalid) => {
    expect(() => defineFoldSceneSpec({
      pieces: [piece([0, 0.5], [invalid])],
    })).toThrow(/keyframe/);
  });

  it('rejects a zero quaternion', () => {
    expect(() => defineFoldSceneSpec({
      pieces: [piece([0, 0.5], [keyframe(0.75, { x: 0, y: 0, z: 0, w: 0 })])],
    })).toThrow(/zero quaternion/);
  });
});
