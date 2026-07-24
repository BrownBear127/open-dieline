import type { Vec3 } from './pose3d';
import type { Quaternion } from './scene-spec';

export type FoldWorldUp = 'tube' | 'tray';

const QUARTER_TURN_COMPONENT = Math.SQRT1_2;

/** Scene-root rotations after the renderer's dieline-y mapping has been applied. */
export const SCENE_TO_WORLD_QUATERNIONS: Readonly<
  Record<FoldWorldUp, Readonly<Quaternion>>
> = Object.freeze({
  tube: Object.freeze({ x: 0, y: 0, z: 0, w: 1 }),
  tray: Object.freeze({
    x: -QUARTER_TURN_COMPONENT,
    y: 0,
    z: 0,
    w: QUARTER_TURN_COMPONENT,
  }),
});

/** Renderer coordinate layer: dieline/model y is inverted before entering Three.js. */
export function modelYToThree(y: number): number {
  return y === 0 ? 0 : -y;
}

export function modelVertexToThree(vertex: Vec3): Vec3 {
  return {
    x: vertex.x,
    y: modelYToThree(vertex.y),
    z: vertex.z,
  };
}

function rotateByQuaternion(vertex: Vec3, quaternion: Quaternion): Vec3 {
  const { x, y, z, w } = quaternion;
  const doubledCross = {
    x: 2 * (y * vertex.z - z * vertex.y),
    y: 2 * (z * vertex.x - x * vertex.z),
    z: 2 * (x * vertex.y - y * vertex.x),
  };
  return {
    x: vertex.x + w * doubledCross.x
      + (y * doubledCross.z - z * doubledCross.y),
    y: vertex.y + w * doubledCross.y
      + (z * doubledCross.x - x * doubledCross.z),
    z: vertex.z + w * doubledCross.z
      + (x * doubledCross.y - y * doubledCross.x),
  };
}

/** Full model → renderer → production-world point pipeline used by bounds oracles. */
export function modelVertexToWorld(
  vertex: Vec3,
  worldUp: FoldWorldUp,
): Vec3 {
  return rotateByQuaternion(
    modelVertexToThree(vertex),
    SCENE_TO_WORLD_QUATERNIONS[worldUp],
  );
}
