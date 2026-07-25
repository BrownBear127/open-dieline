import type { ResolvedParams } from '../core/types';
import {
  applyTransform,
  worldGeometry as evaluateFoldGeometry,
  type Transform,
  type Vec3,
} from './pose3d';
import { foldPose } from './schedule';
import type {
  FoldScenePiece,
  Quaternion,
  ResolvedScenePiece,
  SceneKeyframe,
} from './scene-spec';

const IDENTITY_QUATERNION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
const IDENTITY_POSITION: Vec3 = { x: 0, y: 0, z: 0 };
const SLERP_EPSILON = 1e-8;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(left: number, right: number, progress: number): number {
  return left + (right - left) * progress;
}

function normalized(quaternion: Quaternion): Quaternion {
  const length = Math.hypot(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w,
  );
  if (length === 0) throw new Error('Scene quaternion 不得為零');
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length,
  };
}

function quaternionDot(left: Quaternion, right: Quaternion): number {
  return left.x * right.x
    + left.y * right.y
    + left.z * right.z
    + left.w * right.w;
}

function negate(quaternion: Quaternion): Quaternion {
  return {
    x: -quaternion.x,
    y: -quaternion.y,
    z: -quaternion.z,
    w: -quaternion.w,
  };
}

/** Quaternion shortest-path slerp；q 與 -q 視為同一姿態。 */
export function slerpQuaternion(
  from: Quaternion,
  to: Quaternion,
  progress: number,
): Quaternion {
  const left = normalized(from);
  let right = normalized(to);
  let cosine = quaternionDot(left, right);
  if (cosine < 0) {
    right = negate(right);
    cosine = -cosine;
  }
  const t = clamp01(progress);
  if (1 - cosine <= SLERP_EPSILON) {
    return normalized({
      x: interpolate(left.x, right.x, t),
      y: interpolate(left.y, right.y, t),
      z: interpolate(left.z, right.z, t),
      w: interpolate(left.w, right.w, t),
    });
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const denominator = Math.sin(angle);
  const leftWeight = Math.sin((1 - t) * angle) / denominator;
  const rightWeight = Math.sin(t * angle) / denominator;
  return {
    x: left.x * leftWeight + right.x * rightWeight,
    y: left.y * leftWeight + right.y * rightWeight,
    z: left.z * leftWeight + right.z * rightWeight,
    w: left.w * leftWeight + right.w * rightWeight,
  };
}

function interpolateKeyframes(
  from: SceneKeyframe,
  to: SceneKeyframe,
  time: number,
): SceneKeyframe {
  const progress = clamp01((time - from.time) / (to.time - from.time));
  return {
    time,
    position: {
      x: interpolate(from.position.x, to.position.x, progress),
      y: interpolate(from.position.y, to.position.y, progress),
      z: interpolate(from.position.z, to.position.z, progress),
    },
    quaternion: slerpQuaternion(from.quaternion, to.quaternion, progress),
  };
}

function quaternionTransform(
  position: Vec3,
  quaternion: Quaternion,
): Transform {
  const { x, y, z, w } = normalized(quaternion);
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    rotation: [
      1 - 2 * (yy + zz),
      2 * (xy - wz),
      2 * (xz + wy),
      2 * (xy + wz),
      1 - 2 * (xx + zz),
      2 * (yz - wx),
      2 * (xz - wy),
      2 * (yz + wx),
      1 - 2 * (xx + yy),
    ],
    translation: { ...position },
  };
}

export function sceneFoldLocalT(piece: SceneTiming, time: number): number {
  const [start, end] = piece.foldWindow;
  return clamp01((time - start) / (end - start));
}

/** foldWindow.t1 的隱含 identity anchor 會參與第一段內插；末幀後 hold。 */
export function assemblyDeltaAt(
  piece: SceneTiming,
  time: number,
): Transform {
  const foldEnd = piece.foldWindow[1];
  const anchor: SceneKeyframe = {
    time: foldEnd,
    position: IDENTITY_POSITION,
    quaternion: IDENTITY_QUATERNION,
  };
  if (time <= foldEnd || piece.assemblyTrack.length === 0) {
    return quaternionTransform(anchor.position, anchor.quaternion);
  }

  let previous = anchor;
  for (const keyframe of piece.assemblyTrack) {
    if (time <= keyframe.time) {
      const interpolated = interpolateKeyframes(previous, keyframe, time);
      return quaternionTransform(
        interpolated.position,
        interpolated.quaternion,
      );
    }
    previous = keyframe;
  }
  return quaternionTransform(previous.position, previous.quaternion);
}

export interface EvaluatedScenePiecePose {
  localT: number;
  foldAngles: Map<string, number>;
  assemblyDelta: Transform;
  worldGeometry: Map<string, Vec3[]>;
}

type SceneTiming = Pick<FoldScenePiece, 'foldWindow' | 'assemblyTrack'>;

function evaluateModelPose(
  piece: SceneTiming,
  model: ReturnType<FoldScenePiece['buildModel']>,
  time: number,
): EvaluatedScenePiecePose {
  const localT = sceneFoldLocalT(piece, time);
  const foldAngles = foldPose(localT, model);
  const localGeometry = evaluateFoldGeometry(model, foldAngles);
  const assemblyDelta = assemblyDeltaAt(piece, time);
  return {
    localT,
    foldAngles,
    assemblyDelta,
    worldGeometry: new Map(
      [...localGeometry].map(([panelId, points]) => [
        panelId,
        points.map((point) => applyTransform(assemblyDelta, point)),
      ]),
    ),
  };
}

/** scene world = assemblyDelta(global t) ∘ FK(piece-local t)。 */
export function evaluateScenePiecePose(
  piece: FoldScenePiece,
  params: ResolvedParams,
  time: number,
): EvaluatedScenePiecePose {
  return evaluateModelPose(piece, piece.buildModel(params), time);
}

/** runtime 版 evaluator：model 已於 replaceScene 前解析，不在 animation frame 重建。 */
export function evaluateResolvedScenePiecePose(
  piece: ResolvedScenePiece,
  time: number,
): EvaluatedScenePiecePose {
  return evaluateModelPose(piece, piece.model, time);
}
