import type { ResolvedParams } from '@/core/types';
import { evaluateScenePiecePose } from '@/fold/scene-pose';
import { telescopeLidPlanes } from '@/fold/models/telescope';
import type {
  FoldScenePiece,
  FoldSceneSpec,
} from '@/fold/scene-spec';
import type { FoldModel } from '@/fold/types';
import type { Vec3 } from '@/fold/pose3d';
import { earClipIndices } from '@/ui/triangulate';

const ORACLE_TOLERANCE_MM = 0.05;
/**
 * 上蓋落座間隙的**契約值**（AC-T4b）。刻意寫死、**不從 `TELESCOPE_SEAT_GAP_MM` 匯入**
 * ——期望值若從被測常數動態取得，兩邊永遠相等，閘門對「間隙被改掉」完全無感
 * （實測：把該常數歸零，本檔與 AC-T8a 全數照過）。改動生產常數時必須同步改這裡，
 * 那次同步就是刻意的人為確認動作。
 */
const SEAT_GAP_CONTRACT_MM = 0.05;
const VECTOR_TOLERANCE = 1e-6;
const ASSEMBLY_SAMPLES_PER_BEAT = 12;

type Triangle = [Vec3, Vec3, Vec3];

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function add(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function scale(vector: Vec3, factor: number): Vec3 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
    z: vector.z * factor,
  };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function unit(vector: Vec3): Vec3 {
  const magnitude = length(vector);
  if (magnitude <= VECTOR_TOLERANCE) {
    throw new Error('Telescope assembly oracle 遇到零向量');
  }
  return scale(vector, 1 / magnitude);
}

function bounds(points: Vec3[]): {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
} {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    minZ: Math.min(...points.map(({ z }) => z)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y)),
    maxZ: Math.max(...points.map(({ z }) => z)),
  };
}

function center(points: Vec3[]): { x: number; y: number } {
  const box = bounds(points);
  return {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  };
}

function requirePiece(scene: FoldSceneSpec, pieceId: string): FoldScenePiece {
  const piece = scene.pieces.find((candidate) => candidate.pieceId === pieceId);
  if (!piece) throw new Error(`Telescope assembly oracle 缺少 ${pieceId}`);
  return piece;
}

function requireGeometry(
  geometry: Map<string, Vec3[]>,
  panelId: string,
): Vec3[] {
  const points = geometry.get(panelId);
  if (!points) throw new Error(`Telescope assembly oracle 缺少 ${panelId}`);
  return points;
}

function rootAxes(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
  rootId: string,
): { x: Vec3; y: Vec3; normal: Vec3 } {
  const panel = model.panels.find(({ id }) => id === rootId);
  const world = requireGeometry(geometry, rootId);
  if (!panel) throw new Error(`Telescope assembly oracle 缺少 root ${rootId}`);
  const flatBounds = {
    minX: Math.min(...panel.polygon.map(({ x }) => x)),
    minY: Math.min(...panel.polygon.map(({ y }) => y)),
    maxX: Math.max(...panel.polygon.map(({ x }) => x)),
    maxY: Math.max(...panel.polygon.map(({ y }) => y)),
  };
  const nearestIndex = (x: number, y: number) => panel.polygon
    .map((point, index) => ({
      index,
      distance: Math.hypot(point.x - x, point.y - y),
    }))
    .sort((left, right) => left.distance - right.distance)[0]!.index;
  const origin = world[nearestIndex(flatBounds.minX, flatBounds.minY)]!;
  const xPoint = world[nearestIndex(flatBounds.maxX, flatBounds.minY)]!;
  const yPoint = world[nearestIndex(flatBounds.minX, flatBounds.maxY)]!;
  const x = unit(subtract(xPoint, origin));
  const y = unit(subtract(yPoint, origin));
  return { x, y, normal: unit(cross(x, y)) };
}

function nearlyEqual(
  violations: string[],
  label: string,
  actual: number,
  expected: number,
  tolerance = ORACLE_TOLERANCE_MM,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    violations.push(
      `${label}: actual=${actual.toFixed(6)} expected=${expected.toFixed(6)}`,
    );
  }
}

/**
 * 終態期望只由具名面、params 與 generator 尺寸公式建立；此函式不讀
 * assemblyTrack 的任何 keyframe／終點。
 */
export { SEAT_GAP_CONTRACT_MM };

export function telescopeAssemblyOracleViolations(
  scene: FoldSceneSpec,
  params: ResolvedParams,
): string[] {
  const violations: string[] = [];
  const basePiece = requirePiece(scene, 'base');
  const lidPiece = requirePiece(scene, 'lid');
  const baseModel = basePiece.buildModel(params);
  const lidModel = lidPiece.buildModel(params);
  const base = evaluateScenePiecePose(basePiece, params, 1).worldGeometry;
  const lid = evaluateScenePiecePose(lidPiece, params, 1).worldGeometry;
  const baseFloor = requireGeometry(base, 'floor');
  const lidFloor = requireGeometry(lid, 'floor');
  const baseFloorBounds = bounds(baseFloor);
  const lidFloorBounds = bounds(lidFloor);
  const baseCenter = center(baseFloor);
  const lidCenter = center(lidFloor);

  const lidAxes = rootAxes(lidModel, lid, 'floor');
  nearlyEqual(violations, '⓪ lid x-axis', dot(lidAxes.x, { x: 1, y: 0, z: 0 }), 1, 1e-6);
  nearlyEqual(violations, '⓪ lid y-axis', dot(lidAxes.y, { x: 0, y: 1, z: 0 }), -1, 1e-6);
  nearlyEqual(violations, '⓪ lid inward normal', dot(lidAxes.normal, { x: 0, y: 0, z: 1 }), -1, 1e-6);

  nearlyEqual(violations, '① lid/base center x', lidCenter.x, baseCenter.x);
  nearlyEqual(violations, '① lid/base center y', lidCenter.y, baseCenter.y);

  const marginX = params.lidMarginX;
  const marginY = params.lidMarginY;
  if (typeof marginX !== 'number' || typeof marginY !== 'number') {
    violations.push('② 缺少 lidMarginX/Y');
  } else {
    nearlyEqual(
      violations,
      '② x margin left',
      baseFloorBounds.minX - lidFloorBounds.minX,
      marginX,
    );
    nearlyEqual(
      violations,
      '② x margin right',
      lidFloorBounds.maxX - baseFloorBounds.maxX,
      marginX,
    );
    nearlyEqual(
      violations,
      '② y margin front',
      baseFloorBounds.minY - lidFloorBounds.minY,
      marginY,
    );
    nearlyEqual(
      violations,
      '② y margin back',
      lidFloorBounds.maxY - baseFloorBounds.maxY,
      marginY,
    );
  }

  const baseRim = Math.max(...[...base]
    .filter(([panelId]) => panelId !== 'floor')
    .flatMap(([, points]) => points.map(({ z }) => z)));
  // 上蓋底板 panel 平面＝落座平面（seatPlane）；接觸面與外頂面由 model 層
  // 的面別約定導出（Spec §4.7）——oracle 不得自行從落座 z 反推面別。
  const lidSeatPlane = lidFloor.reduce((sum, { z }) => sum + z, 0)
    / lidFloor.length;
  const thickness = typeof params.thickness === 'number' ? params.thickness : 0;
  const innerWallReduction = typeof params.innerWallReduction === 'number'
    ? params.innerWallReduction
    : 0;
  const { contactPlane: lidContactPlane } = telescopeLidPlanes(
    lidSeatPlane,
    thickness,
    innerWallReduction,
  );
  const lidOuterWalls = [...lid]
    .filter(([panelId]) => /^wall[XY](?:Neg|Pos)-outer$/.test(panelId))
    .flatMap(([, points]) => points);
  const lidRim = Math.min(...lidOuterWalls.map(({ z }) => z));
  const lidHeight = params.lidHeight;
  // v15.6：期望值由 0 改為落座間隙。實體上兩面接觸（差 0），但零厚度渲染裡完全同高
  // 是深度測試的無解平手局（俯視實測 610px 下盒像素穿出上蓋）。
  // ⚠ 這**不是放寬容差**——容差仍是 ORACLE_TOLERANCE_MM，改的是具名期望值本身，
  // 且期望值取獨立契約常數（見 SEAT_GAP_CONTRACT_MM），不從生產常數動態推導。
  // v15.7：量測對象由 `floorInner` 改為 `contactPlane`。上蓋內壁反摺後短一個
  // innerWallReduction，其末端唇邊懸在底板下方、正好蓋住下盒壁頂——**它才是接觸面**。
  // 量錯面的症狀是唇邊切進下盒內壁 0.5mm，卻要靠把 lidMarginY 撐到 15mm 才躲得開。
  nearlyEqual(
    violations,
    '③ lidContactPlane-baseRim',
    lidContactPlane - baseRim,
    SEAT_GAP_CONTRACT_MM,
  );
  if (typeof lidHeight !== 'number') {
    violations.push('③ 缺少 lidHeight');
  } else {
    // 面別分離：③ 接觸＝面對面（lidFloorInner vs baseRim）；
    // ③b 幾何＝平面對平面（lidRim 與 seatPlane 同屬上蓋 panel 樹）。
    nearlyEqual(
      violations,
      '③b lidRim-lidSeatPlane',
      lidRim - lidSeatPlane,
      -lidHeight,
    );
  }

  const linerPiece = scene.pieces.find(({ pieceId }) => pieceId === 'liner');
  if (linerPiece) {
    const linerModel = linerPiece.buildModel(params);
    const liner = evaluateScenePiecePose(linerPiece, params, 1).worldGeometry;
    const pad = requireGeometry(liner, 'linerPad');
    const padCenter = center(pad);
    nearlyEqual(violations, '① liner/base center x', padCenter.x, baseCenter.x);
    nearlyEqual(violations, '① liner/base center y', padCenter.y, baseCenter.y);
    const baseFloorInner = baseFloor.reduce((sum, { z }) => sum + z, 0)
      / baseFloor.length;
    const linerPadTop = pad.reduce((sum, { z }) => sum + z, 0) / pad.length;
    const legPoints = linerModel.panels
      .filter(({ id }) => id.startsWith('linerLeg'))
      .flatMap(({ id }) => requireGeometry(liner, id));
    const linerLegTips = Math.min(...legPoints.map(({ z }) => z));
    const linerFlapDepth = params.linerFlapDepth;
    nearlyEqual(
      violations,
      '④ linerLegTips-baseFloorInner',
      linerLegTips - baseFloorInner,
      0,
    );
    if (typeof linerFlapDepth !== 'number') {
      violations.push('④ 缺少 linerFlapDepth');
    } else {
      nearlyEqual(
        violations,
        '④ linerPadTop-baseFloorInner',
        linerPadTop - baseFloorInner,
        linerFlapDepth,
      );
    }
  }
  return violations;
}

function project2(
  point: Vec3,
  drop: 'x' | 'y' | 'z',
): [number, number] {
  if (drop === 'z') return [point.x, point.y];
  if (drop === 'y') return [point.x, point.z];
  return [point.y, point.z];
}

function dominantDropAxis(normal: Vec3): 'x' | 'y' | 'z' {
  const absolute = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (absolute.z >= absolute.x && absolute.z >= absolute.y) return 'z';
  return absolute.y >= absolute.x ? 'y' : 'x';
}

function segmentCrossesTriangle(
  start: Vec3,
  end: Vec3,
  triangle: Triangle,
): boolean {
  const normal = cross(
    subtract(triangle[1], triangle[0]),
    subtract(triangle[2], triangle[0]),
  );
  const direction = subtract(end, start);
  const denominator = dot(normal, direction);
  if (Math.abs(denominator) < 1e-12) return false;
  const ratio = dot(normal, subtract(triangle[0], start)) / denominator;
  if (ratio <= 1e-8 || ratio >= 1 - 1e-8) return false;
  const hit = add(start, scale(direction, ratio));
  const drop = dominantDropAxis(unit(normal));
  const a = project2(triangle[0], drop);
  const b = project2(triangle[1], drop);
  const c = project2(triangle[2], drop);
  const point = project2(hit, drop);
  const orient = (
    left: [number, number],
    right: [number, number],
    candidate: [number, number],
  ) => (right[0] - left[0]) * (candidate[1] - left[1])
    - (right[1] - left[1]) * (candidate[0] - left[0]);
  const signs = [
    orient(a, b, point),
    orient(b, c, point),
    orient(c, a, point),
  ];
  return signs.every((value) => value > 1e-8)
    || signs.every((value) => value < -1e-8);
}

function panelTriangles(
  model: FoldModel,
  geometry: Map<string, Vec3[]>,
): Array<{ panelId: string; triangles: Triangle[] }> {
  return model.panels.map((panel) => {
    const points = requireGeometry(geometry, panel.id);
    const indices = earClipIndices(panel.polygon);
    const triangles: Triangle[] = [];
    for (let index = 0; index < indices.length; index += 3) {
      triangles.push([
        points[indices[index]!]!,
        points[indices[index + 1]!]!,
        points[indices[index + 2]!]!,
      ]);
    }
    return { panelId: panel.id, triangles };
  });
}

function trianglesCross(left: Triangle, right: Triangle): boolean {
  const leftEdges: Array<[Vec3, Vec3]> = [
    [left[0], left[1]],
    [left[1], left[2]],
    [left[2], left[0]],
  ];
  const rightEdges: Array<[Vec3, Vec3]> = [
    [right[0], right[1]],
    [right[1], right[2]],
    [right[2], right[0]],
  ];
  return leftEdges.some(([start, end]) =>
    segmentCrossesTriangle(start, end, right))
    || rightEdges.some(([start, end]) =>
      segmentCrossesTriangle(start, end, left));
}

function trackSampleTimes(piece: FoldScenePiece): number[] {
  if (piece.assemblyTrack.length === 0) return [];
  const times = piece.assemblyTrack.map(({ time }) => time);
  return times.slice(0, -1).flatMap((start, index) => {
    const end = times[index + 1]!;
    return Array.from(
      { length: ASSEMBLY_SAMPLES_PER_BEAT + 1 },
      (_, sample) => start
        + (end - start) * sample / ASSEMBLY_SAMPLES_PER_BEAT,
    );
  });
}

/** 幕一／幕二跨 piece 的零厚度材料面逐拍掃描。 */
export function telescopeAssemblyClearanceViolations(
  scene: FoldSceneSpec,
  params: ResolvedParams,
): string[] {
  const violations: string[] = [];
  for (const movingPiece of scene.pieces.filter(
    ({ assemblyTrack }) => assemblyTrack.length > 0,
  )) {
    const others = scene.pieces.filter((piece) => piece !== movingPiece);
    for (const time of trackSampleTimes(movingPiece)) {
      const movingModel = movingPiece.buildModel(params);
      const movingGeometry = evaluateScenePiecePose(
        movingPiece,
        params,
        time,
      ).worldGeometry;
      const movingPanels = panelTriangles(movingModel, movingGeometry);
      for (const other of others) {
        const otherModel = other.buildModel(params);
        const otherGeometry = evaluateScenePiecePose(
          other,
          params,
          time,
        ).worldGeometry;
        const otherPanels = panelTriangles(otherModel, otherGeometry);
        const linerSeatStart = movingPiece.pieceId === 'liner'
          ? movingPiece.assemblyTrack[2]?.time
          : undefined;
        if (
          other.pieceId === 'base'
          && linerSeatStart !== undefined
          && time >= linerSeatStart - VECTOR_TOLERANCE
        ) {
          // 幕一末拍是沿 z 將較小的 liner 垂直送入 base；此段是具名 seating
          // corridor，終態由 oracle ④（腳尖/平台高）與中心對齊另行鎖定。
          const padBounds = bounds(requireGeometry(movingGeometry, 'linerPad'));
          const floorBounds = bounds(requireGeometry(otherGeometry, 'floor'));
          if (
            padBounds.minX < floorBounds.minX - ORACLE_TOLERANCE_MM
            || padBounds.maxX > floorBounds.maxX + ORACLE_TOLERANCE_MM
            || padBounds.minY < floorBounds.minY - ORACLE_TOLERANCE_MM
            || padBounds.maxY > floorBounds.maxY + ORACLE_TOLERANCE_MM
          ) {
            violations.push(`liner↔base@${time.toFixed(4)} seating corridor 越界`);
          }
          continue;
        }
        pairScan:
        for (const left of movingPanels) {
          for (const right of otherPanels) {
            if (left.triangles.some((leftTriangle) =>
              right.triangles.some((rightTriangle) =>
                trianglesCross(leftTriangle, rightTriangle)))) {
              violations.push(
                `${movingPiece.pieceId}↔${other.pieceId}@${time.toFixed(4)} `
                + `${left.panelId}↔${right.panelId}`,
              );
              break pairScan;
            }
          }
        }
      }
    }
  }
  return [...new Set(violations)];
}

export interface TelescopeRuntimeManifest {
  modelIds: string[];
  meshIds: string[];
  seamIds: string[];
  trackIds: string[];
  boundsIds: string[];
  collisionPairs: string[];
}

export function telescopeRuntimeManifest(
  scene: FoldSceneSpec,
  params: ResolvedParams,
): TelescopeRuntimeManifest {
  const models = scene.pieces.map((piece) => ({
    piece,
    model: piece.buildModel(params),
  }));
  return {
    modelIds: models.map(({ piece }) => piece.pieceId),
    meshIds: models.flatMap(({ piece, model }) =>
      model.panels.map(({ id }) => `${piece.pieceId}/${id}`)),
    seamIds: models.flatMap(({ piece, model }) =>
      model.steps.flatMap(({ panelIds }) =>
        panelIds.map((panelId) => `${piece.pieceId}/${panelId}`))),
    trackIds: scene.pieces
      .filter(({ assemblyTrack }) => assemblyTrack.length > 0)
      .map(({ pieceId }) => pieceId),
    boundsIds: scene.pieces.map(({ pieceId }) => pieceId),
    collisionPairs: scene.pieces.flatMap((left, index) =>
      scene.pieces.slice(index + 1)
        .map((right) => `${left.pieceId}↔${right.pieceId}`)),
  };
}
