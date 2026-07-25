import { describe, expect, it } from 'vitest';
import {
  assemblyDeltaAt,
  evaluateScenePiecePose,
  sceneFoldLocalT,
} from '@/fold/scene-pose';
import type { FoldScenePiece } from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';

const model: FoldModel = {
  panels: [{
    id: 'root',
    polygon: [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ],
    parent: null,
    foldAngle: 0,
  }],
  steps: [],
  dieline: [],
};

function piece(): FoldScenePiece {
  return {
    pieceId: 'sample',
    buildModel: () => model,
    foldWindow: [0.1, 0.4],
    assemblyTrack: [
      {
        time: 0.6,
        position: { x: 10, y: 0, z: 0 },
        // -identity 與 identity 是同一姿態；求值器必須走最短路徑，不得轉一圈。
        quaternion: { x: 0, y: 0, z: 0, w: -1 },
      },
      {
        time: 0.8,
        position: { x: 20, y: 0, z: 0 },
        quaternion: { x: -1, y: 0, z: 0, w: 0 },
      },
    ],
  };
}

describe('scene pose evaluator', () => {
  it('foldWindow t1 是隱含 identity 錨點，且 local fold time 會 clamp', () => {
    const subject = piece();
    expect(sceneFoldLocalT(subject, 0)).toBe(0);
    expect(sceneFoldLocalT(subject, 0.25)).toBeCloseTo(0.5, 12);
    expect(sceneFoldLocalT(subject, 0.4)).toBe(1);

    const transform = assemblyDeltaAt(subject, 0.4);
    expect(transform.translation).toEqual({ x: 0, y: 0, z: 0 });
    expect(transform.rotation).toEqual([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);
  });

  it('quaternion slerp 取 shortest path，assembly 在 FK 後套用', () => {
    const subject = piece();
    const midway = assemblyDeltaAt(subject, 0.5);
    expect(midway.translation.x).toBeCloseTo(5, 12);
    expect(midway.rotation).toEqual([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
    ]);

    const evaluated = evaluateScenePiecePose(subject, {}, 0.5);
    expect(evaluated.localT).toBe(1);
    expect(evaluated.worldGeometry.get('root')![0]).toEqual({
      x: 5,
      y: 0,
      z: 0,
    });
  });

  it('最後一個 keyframe 之後 hold 末值，不外插', () => {
    const subject = piece();
    expect(assemblyDeltaAt(subject, 0.9))
      .toEqual(assemblyDeltaAt(subject, 0.8));
  });
});
