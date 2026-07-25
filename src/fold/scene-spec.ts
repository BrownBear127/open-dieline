import type { ResolvedParams } from '../core/types';
import type { Vec3 } from './pose3d';
import type { FoldModel } from './types';

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface SceneKeyframe {
  time: number;
  position: Vec3;
  quaternion: Quaternion;
}

export interface FoldScenePiece {
  pieceId: string;
  buildModel: (params: ResolvedParams) => FoldModel;
  foldWindow: [number, number];
  assemblyTrack: SceneKeyframe[];
}

export interface FoldSceneSpec {
  pieces: FoldScenePiece[];
}

export interface ResolvedScenePiece {
  pieceId: string;
  model: FoldModel;
  foldWindow: [number, number];
  assemblyTrack: SceneKeyframe[];
}

export interface ResolvedSceneSpec {
  pieces: ResolvedScenePiece[];
}

function validateFoldWindow(piece: FoldScenePiece): void {
  const [t0, t1] = piece.foldWindow;
  if (
    !Number.isFinite(t0)
    || !Number.isFinite(t1)
    || t0 < 0
    || t1 > 1
    || t0 >= t1
  ) {
    throw new Error(
      `FoldSceneSpec piece "${piece.pieceId}" foldWindow must satisfy 0 ≤ t0 < t1 ≤ 1`,
    );
  }
}

function finiteVector(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function normalizeAssemblyTrack(piece: FoldScenePiece): SceneKeyframe[] {
  const normalized: SceneKeyframe[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;

  for (const [index, keyframe] of piece.assemblyTrack.entries()) {
    const { time, position, quaternion } = keyframe;
    if (
      !Number.isFinite(time)
      || time < 0
      || time > 1
      || !finiteVector([position.x, position.y, position.z])
      || !finiteVector([quaternion.x, quaternion.y, quaternion.z, quaternion.w])
    ) {
      throw new Error(
        `FoldSceneSpec piece "${piece.pieceId}" keyframe ${index} must use finite normalized-time and transform values`,
      );
    }
    if (time <= previousTime) {
      throw new Error(
        `FoldSceneSpec piece "${piece.pieceId}" keyframe times must be strictly increasing`,
      );
    }

    const magnitude = Math.hypot(
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    );
    if (magnitude === 0) {
      throw new Error(
        `FoldSceneSpec piece "${piece.pieceId}" keyframe ${index} has a zero quaternion`,
      );
    }

    normalized.push({
      time,
      position: { ...position },
      quaternion: {
        x: quaternion.x / magnitude,
        y: quaternion.y / magnitude,
        z: quaternion.z / magnitude,
        w: quaternion.w / magnitude,
      },
    });
    previousTime = time;
  }

  const first = normalized[0];
  if (first !== undefined && first.time <= piece.foldWindow[1]) {
    throw new Error(
      `FoldSceneSpec piece "${piece.pieceId}" first keyframe must be after foldWindow t1`,
    );
  }
  return normalized;
}

/** 建立並驗證 normalized scene 契約；回傳值會承載 build 期完成的正規化結果。 */
export function defineFoldSceneSpec(spec: FoldSceneSpec): FoldSceneSpec {
  return {
    pieces: spec.pieces.map((piece) => {
      validateFoldWindow(piece);
      return {
        ...piece,
        foldWindow: [...piece.foldWindow],
        assemblyTrack: normalizeAssemblyTrack(piece),
      };
    }),
  };
}

/** 將綁定 params 的 scene builder 一次求值，runtime 後續逐幀只讀已解析 model。 */
export function resolveFoldSceneSpec(
  spec: FoldSceneSpec,
  params: ResolvedParams,
): ResolvedSceneSpec {
  return {
    pieces: spec.pieces.map((piece) => ({
      pieceId: piece.pieceId,
      model: piece.buildModel(params),
      foldWindow: [...piece.foldWindow],
      assemblyTrack: piece.assemblyTrack.map((keyframe) => ({
        time: keyframe.time,
        position: { ...keyframe.position },
        quaternion: { ...keyframe.quaternion },
      })),
    })),
  };
}
