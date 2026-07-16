import type { FoldModel } from './types';

export interface Vec3 { x: number; y: number; z: number }

type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

interface Transform {
  rotation: Mat3;
  translation: Vec3;
}

const IDENTITY: Transform = {
  rotation: [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ],
  translation: { x: 0, y: 0, z: 0 },
};

function multiplyMatrices(left: Mat3, right: Mat3): Mat3 {
  const result = new Array<number>(9).fill(0) as Mat3;

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let index = 0; index < 3; index += 1) {
        value += left[row * 3 + index]! * right[index * 3 + column]!;
      }
      result[row * 3 + column] = value;
    }
  }

  return result;
}

function rotate(matrix: Mat3, vector: Vec3): Vec3 {
  return {
    x: matrix[0] * vector.x + matrix[1] * vector.y + matrix[2] * vector.z,
    y: matrix[3] * vector.x + matrix[4] * vector.y + matrix[5] * vector.z,
    z: matrix[6] * vector.x + matrix[7] * vector.y + matrix[8] * vector.z,
  };
}

function applyTransform(transform: Transform, point: Vec3): Vec3 {
  const rotated = rotate(transform.rotation, point);

  return {
    x: rotated.x + transform.translation.x,
    y: rotated.y + transform.translation.y,
    z: rotated.z + transform.translation.z,
  };
}

function compose(parent: Transform, child: Transform): Transform {
  const childTranslation = rotate(parent.rotation, child.translation);

  return {
    rotation: multiplyMatrices(parent.rotation, child.rotation),
    translation: {
      x: childTranslation.x + parent.translation.x,
      y: childTranslation.y + parent.translation.y,
      z: childTranslation.z + parent.translation.z,
    },
  };
}

function hingeRotation(
  hinge: { a: { x: number; y: number }; b: { x: number; y: number } },
  angle: number,
): Transform {
  const axisX = hinge.b.x - hinge.a.x;
  const axisY = hinge.b.y - hinge.a.y;
  const axisLength = Math.hypot(axisX, axisY);
  const x = axisX / axisLength;
  const y = axisY / axisLength;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const oneMinusCosine = 1 - cosine;

  // Rodrigues' rotation formula: R = cosθ I + (1-cosθ) uuᵀ + sinθ [u]×.
  const rotation: Mat3 = [
    cosine + x * x * oneMinusCosine,
    x * y * oneMinusCosine,
    y * sine,
    y * x * oneMinusCosine,
    cosine + y * y * oneMinusCosine,
    -x * sine,
    -y * sine,
    x * sine,
    cosine,
  ];
  const pivot = { x: hinge.a.x, y: hinge.a.y, z: 0 };
  const rotatedPivot = rotate(rotation, pivot);

  return {
    rotation,
    translation: {
      x: pivot.x - rotatedPivot.x,
      y: pivot.y - rotatedPivot.y,
      z: pivot.z - rotatedPivot.z,
    },
  };
}

export function worldGeometry(model: FoldModel, pose: Map<string, number>): Map<string, Vec3[]> {
  const panelsById = new Map(model.panels.map((panel) => [panel.id, panel]));
  const transforms = new Map<string, Transform>();
  const visiting = new Set<string>();

  function cumulativeTransform(panel: FoldModel['panels'][number]): Transform {
    const cached = transforms.get(panel.id);
    if (cached) return cached;

    if (visiting.has(panel.id)) {
      throw new Error(`Cycle in fold panel hierarchy at "${panel.id}"`);
    }

    visiting.add(panel.id);

    let transform: Transform;
    if (panel.parent === null) {
      transform = IDENTITY;
    } else {
      const parent = panelsById.get(panel.parent)!;
      const parentTransform = cumulativeTransform(parent);
      const angle = pose.get(panel.id) ?? 0;
      transform = compose(parentTransform, hingeRotation(panel.hingeLine!, angle));
    }

    visiting.delete(panel.id);
    transforms.set(panel.id, transform);
    return transform;
  }

  const geometry = new Map<string, Vec3[]>();

  for (const panel of model.panels) {
    const transform = cumulativeTransform(panel);
    const angle = panel.parent === null ? 0 : (pose.get(panel.id) ?? 0);
    const liftRatio = panel.foldAngle === 0 ? 0 : Math.abs(angle) / Math.abs(panel.foldAngle);
    const liftAmount = (panel.liftOffset ?? 0) * liftRatio;
    const normal = rotate(transform.rotation, { x: 0, y: 0, z: 1 });

    // M0 uses a direct |angle|/|foldAngle| lift ratio. M1 may replace it with
    // the animation step's final-20% curve without changing this pose input.
    const vertices = panel.polygon.map((point) => {
      const world = applyTransform(transform, { x: point.x, y: point.y, z: 0 });
      return {
        x: world.x + normal.x * liftAmount,
        y: world.y + normal.y * liftAmount,
        z: world.z + normal.z * liftAmount,
      };
    });

    geometry.set(panel.id, vertices);
  }

  return geometry;
}
