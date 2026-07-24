// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { Vector2 } from 'three';
import { expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { triangularTube } from '@/boxes/triangular-tube';
import { tuckTopSnapLock } from '@/boxes/tuck-top-snap-lock';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { buildTtslFoldModel } from '@/fold/models/tuck-top-snap-lock';
import { buildTelescopeSceneSpec } from '@/fold/models/telescope';
import { worldGeometry, type Vec3 } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import type { FoldModel } from '@/fold/types';
import {
  diagnoseFoldedPanelFaces,
  panelOverlapPlan,
  panelRenderVertices,
  parentFoldCompletion,
  type PhysicalPanelFace,
} from '@/ui/fold-scene';
import { earClipIndices } from '@/ui/triangulate';

const EPSILON = 1e-7;

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
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

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function polygonNormal(vertices: Vec3[]): Vec3 {
  for (let index = 1; index < vertices.length - 1; index += 1) {
    const normal = cross(
      subtract(vertices[index]!, vertices[0]!),
      subtract(vertices[index + 1]!, vertices[0]!),
    );
    if (Math.hypot(normal.x, normal.y, normal.z) > EPSILON) return normalize(normal);
  }
  throw new Error('degenerate polygon');
}

function signedArea(points: Vector2[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    sum += points[index]!.x * points[next]!.y - points[next]!.x * points[index]!.y;
  }
  return sum / 2;
}

function lineIntersection(start: Vector2, end: Vector2, clipStart: Vector2, clipEnd: Vector2): Vector2 {
  const ray = end.clone().sub(start);
  const edge = clipEnd.clone().sub(clipStart);
  const denominator = ray.x * edge.y - ray.y * edge.x;
  const relative = clipStart.clone().sub(start);
  const t = (relative.x * edge.y - relative.y * edge.x) / denominator;
  return start.clone().add(ray.multiplyScalar(t));
}

function clipConvex(subject: Vector2[], rawClip: Vector2[]): Vector2[] {
  const clip = signedArea(rawClip) < 0 ? [...rawClip].reverse() : rawClip;
  let output = subject;

  for (let index = 0; index < clip.length; index += 1) {
    const clipStart = clip[index]!;
    const clipEnd = clip[(index + 1) % clip.length]!;
    const input = output;
    output = [];
    if (input.length === 0) break;

    const inside = (point: Vector2): boolean => {
      const edgeX = clipEnd.x - clipStart.x;
      const edgeY = clipEnd.y - clipStart.y;
      return edgeX * (point.y - clipStart.y) - edgeY * (point.x - clipStart.x) >= -EPSILON;
    };

    for (let subjectIndex = 0; subjectIndex < input.length; subjectIndex += 1) {
      const start = input[subjectIndex]!;
      const end = input[(subjectIndex + 1) % input.length]!;
      const startInside = inside(start);
      const endInside = inside(end);
      if (startInside && endInside) {
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd));
      } else if (endInside) {
        output.push(lineIntersection(start, end, clipStart, clipEnd), end);
      }
    }
  }

  return output;
}

function triangles(points: Vector2[], indices: number[]): Vector2[][] {
  const result: Vector2[][] = [];
  for (let index = 0; index < indices.length; index += 3) {
    result.push([
      points[indices[index]!]!,
      points[indices[index + 1]!]!,
      points[indices[index + 2]!]!,
    ]);
  }
  return result;
}

function overlapTriangleIndices(model: FoldModel, panelIndex: number): number[] {
  const panel = model.panels[panelIndex]!;
  // TTSL 接收片是本檔唯一的單一凹面板，重疊量測須沿用正式渲染的 ear-clipping。
  if (panel.id === 'bottomReceiveP3') return earClipIndices(panel.polygon);
  const indices: number[] = [];
  for (let index = 1; index < panel.polygon.length - 1; index += 1) {
    indices.push(0, index, index + 1);
  }
  return indices;
}

function overlapArea(
  first: Vec3[],
  second: Vec3[],
  firstIndices: number[],
  secondIndices: number[],
): number {
  const origin = first[0]!;
  const normal = polygonNormal(first);
  const secondNormal = polygonNormal(second);
  if (Math.abs(dot(normal, secondNormal)) < 1 - EPSILON) return 0;
  if (second.some((vertex) => Math.abs(dot(subtract(vertex, origin), normal)) > EPSILON)) return 0;

  const uAxis = normalize(subtract(first[1]!, origin));
  const vAxis = cross(normal, uAxis);
  const project = (vertex: Vec3): Vector2 => {
    const relative = subtract(vertex, origin);
    return new Vector2(dot(relative, uAxis), dot(relative, vAxis));
  };
  const firstTriangles = triangles(first.map(project), firstIndices);
  const secondTriangles = triangles(second.map(project), secondIndices);

  return firstTriangles.reduce((total, firstTriangle) => total + secondTriangles.reduce(
    (subtotal, secondTriangle) => subtotal + Math.abs(signedArea(clipConvex(firstTriangle, secondTriangle))),
    0,
  ), 0);
}

function overlappingPairs(model: FoldModel): string[] {
  const geometry = worldGeometry(model, foldPose(1, model));
  const pairs: string[] = [];
  for (let firstIndex = 0; firstIndex < model.panels.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < model.panels.length; secondIndex += 1) {
      const firstId = model.panels[firstIndex]!.id;
      const secondId = model.panels[secondIndex]!.id;
      const area = overlapArea(
        geometry.get(firstId)!,
        geometry.get(secondId)!,
        overlapTriangleIndices(model, firstIndex),
        overlapTriangleIndices(model, secondIndex),
      );
      if (area > EPSILON) pairs.push(`${firstId}/${secondId}`);
    }
  }
  return pairs;
}

it('enumerates every completed area overlap for the default single-lid model', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));

  expect(diagnoseFoldedPanelFaces(model)).toEqual(model.panels.map(({ id }) => ({
    panelId: id,
    exteriorFace: id === 'topLid' || id === 'topDustP2' ? 'back' : 'front',
  })));
  expect(overlappingPairs(model)).toEqual([
    'topLid/topDustP2',
    'topLid/topDustP4',
    'bottomLid/bottomDustP2',
    'bottomLid/bottomDustP4',
  ]);
});

it('moves the glue overlap to P1 when the glue flap is on the right', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { glueSide: 'right' }));

  expect(overlappingPairs(model)).toEqual([
    'glue/topTuck',
    'topLid/topDustP2',
    'topLid/topDustP4',
    'bottomLid/bottomDustP2',
    'bottomLid/bottomDustP4',
  ]);
});

it('enumerates both dust overlaps for each unsliced lid when tuckLock is disabled', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, { tuckLock: 0 }));

  expect(overlappingPairs(model)).toEqual([
    'topLid/topDustP2',
    'topLid/topDustP4',
    'bottomLid/bottomDustP2',
    'bottomLid/bottomDustP4',
  ]);
});

/** ttsl（tuck-top-snap-lock）全部落 fallback（0,0,0）的字面量——面板 id 沒被
 * panelOverlapPlan 任何分支認得時的預設值（見 fold-scene.ts:886 頂端註解）。 */
const FALLBACK_OVERLAP_PLAN = { normalOffset: 0, polygonOffsetUnits: 0, renderOrder: 0 };

function telescopePieceModel(pieceId: string): FoldModel {
  const params = resolveParams(telescope, {});
  const piece = buildTelescopeSceneSpec(params).pieces
    .find((candidate) => candidate.pieceId === pieceId);
  if (!piece) throw new Error(`找不到 telescope piece ${pieceId}`);
  return piece.buildModel(params);
}

it('assigns non-fallback, correctly ordered overlap plans to every ttsl panel that geometrically overlaps another', () => {
  const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, { thickness: 0 }));

  // 每片 exterior face 選對（比照 RTE 案例·純幾何檢查，panelOverlapPlan 無關）。
  expect(diagnoseFoldedPanelFaces(model)).toEqual(model.panels.map(({ id }) => ({
    panelId: id,
    exteriorFace: id === 'topLid' || id === 'topDustP2' || id === 'topDustP4'
      ? 'back'
      : 'front',
  })));

  const pairs = overlappingPairs(model);
  expect(pairs).toEqual([
    'P4/glue',
    'bottomLockP1/bottomWebP2',
    'bottomLockP1/bottomReceiveP3',
    'bottomLockP1/bottomWebP4',
    'bottomWebP2/bottomReceiveP3',
    'bottomReceiveP3/bottomWebP4',
    'topLid/topDustP2',
    'topLid/topDustP4',
  ]);

  // 底部四片組（底部層序）＋頂部 topLid/topTuck/topDustP2/topDustP4＋glue：
  // 每片都必須拿到 panelOverlapPlan 的專屬分支，不能落在「面板 id 沒認得」的
  // fallback 上——fallback 對這些會交疊的面板來說＝必破圖。topDustP2/topDustP4
  // 也在此列，即使功能上暫無 z-fighting，仍須有專屬分層。
  const mustNotFallback = [
    'bottomLockP1',
    'bottomWebP2',
    'bottomWebP4',
    'bottomReceiveP3',
    'topLid',
    'topTuck',
    'topDustP2',
    'topDustP4',
    'glue',
  ];
  for (const panelId of mustNotFallback) {
    expect(panelOverlapPlan(panelId, 0)).not.toEqual(FALLBACK_OVERLAP_PLAN);
  }

  const receivePlan = panelOverlapPlan('bottomReceiveP3', 0);

  // 底部層序：bottomReceiveP3（底層）< bottomLockP1（上層·視覺呈現「插進 P3 之上」）。
  // normalOffset 與 renderOrder 兩軸都必須同向遞增，否則「單軸成立、另一軸反向」
  // 這種失效模式（renderOrder 沒真的跟著翻回來）不會被任何斷言抓到。
  const lockPlan = panelOverlapPlan('bottomLockP1', 0);
  expect(receivePlan.normalOffset).toBeLessThan(lockPlan.normalOffset);
  expect(receivePlan.renderOrder).toBeLessThan(lockPlan.renderOrder);
  // polygonOffsetUnits 軸刻意設計成與 normalOffset/renderOrder 反向遞減
  // （receive=1 > lock=0，越往內層 units 越大）——GL polygonOffset 語意下
  // units 越小越貼近鏡頭，這一軸的用途是替深度緩衝在浮點誤差邊界再補一層
  // 保險，不是要重覆 normalOffset 的堆疊方向，故此處明確記錄成反向斷言，
  // 而非要求同向。
  expect(receivePlan.polygonOffsetUnits).toBeGreaterThan(lockPlan.polygonOffsetUnits);

  // 頂部層序：topDustP2/topDustP4（摺序最早、被蓋在最內層）< topTuck < topLid，
  // 比照上面 receive/lock 的雙軸（normalOffset + renderOrder）斷言方式，防同一種
  // 「單軸成立、另一軸反向」失效模式。
  const topDustP2Plan = panelOverlapPlan('topDustP2', 0);
  const topDustP4Plan = panelOverlapPlan('topDustP4', 0);
  const topTuckPlan = panelOverlapPlan('topTuck', 0);
  const topLidPlan = panelOverlapPlan('topLid', 0);
  expect(topDustP4Plan).toEqual(topDustP2Plan);
  expect(topDustP2Plan.normalOffset).toBeLessThan(topTuckPlan.normalOffset);
  expect(topDustP2Plan.renderOrder).toBeLessThan(topTuckPlan.renderOrder);
  expect(topTuckPlan.normalOffset).toBeLessThan(topLidPlan.normalOffset);
  expect(topTuckPlan.renderOrder).toBeLessThan(topLidPlan.renderOrder);

  // 通盤驗證：對每一組實際幾何交疊的 panel pair，兩片的 overlapPlan 不可完全相同
  // （相同＝共用同一層＝z-fighting）。這條把「分層是否正確」直接綁定在真實幾何
  // 交疊上，而不是自己列一份可能漏面板的清單。
  for (const pair of pairs) {
    const [firstId, secondId] = pair.split('/') as [string, string];
    expect(panelOverlapPlan(firstId, 0)).not.toEqual(panelOverlapPlan(secondId, 0));
  }
});

it('assigns non-fallback, correctly ordered overlap plans to every ttb panel that geometrically overlaps another', () => {
  const model = buildTtbFoldModel(resolveParams(triangularTube, {}));

  expect(panelOverlapPlan('zoneDLip', 0)).not.toEqual(panelOverlapPlan('faceB', 0));

  // 每片 exterior face 選對（比照 RTE/ttsl 案例·純幾何檢查，panelOverlapPlan 無關）。
  expect(diagnoseFoldedPanelFaces(model)).toEqual([
    { panelId: 'faceA', exteriorFace: 'front' },
    { panelId: 'faceB', exteriorFace: 'back' },
    { panelId: 'faceC', exteriorFace: 'front' },
    { panelId: 'zoneDBase', exteriorFace: 'front' },
    { panelId: 'zoneDLip', exteriorFace: 'front' },
    { panelId: 'zoneDTab', exteriorFace: 'back' },
    { panelId: 'endStartMain', exteriorFace: 'front' },
    { panelId: 'endStartWingTop', exteriorFace: 'front' },
    { panelId: 'endStartWingBottom', exteriorFace: 'front' },
    { panelId: 'endEndMain', exteriorFace: 'front' },
    { panelId: 'endEndWingTop', exteriorFace: 'front' },
    { panelId: 'endEndWingBottom', exteriorFace: 'front' },
  ]);

  const pairs = overlappingPairs(model);
  expect(pairs).toEqual([
    'faceA/zoneDBase',
    'faceB/zoneDLip',
  ]);

  // ttb 沒有 lid/tuck/glue 詞彙、id 與 RTE/ttsl 無撞名——盒身
  // faceA/faceB/faceC 維持通用 fallback（0,0,0）當基準層（比照 RTE/ttsl 主體面板
  // P1/P4 等既有慣例，只有蓋在主體上的附加片才需要專屬層）；zoneDBase/zoneDLip/
  // zoneDTab/端封六片是附加層，全部必須拿到專屬分支，即使功能上暫無
  // z-fighting，仍須明確分層而非依賴對方非零。
  const mustNotFallback = [
    'zoneDBase',
    'zoneDLip',
    'zoneDTab',
    'endStartMain',
    'endEndMain',
    'endStartWingTop',
    'endStartWingBottom',
    'endEndWingTop',
    'endEndWingBottom',
  ];
  for (const panelId of mustNotFallback) {
    expect(panelOverlapPlan(panelId, 0)).not.toEqual(FALLBACK_OVERLAP_PLAN);
  }

  const tabPlan = panelOverlapPlan('zoneDTab', 0);
  const lipPlan = panelOverlapPlan('zoneDLip', 0);

  // 盒身三面（faceA/faceB/faceC）同一基準層（0 基準層）。
  const bodyPlan = panelOverlapPlan('faceA', 0);
  expect(panelOverlapPlan('faceB', 0)).toEqual(bodyPlan);
  expect(panelOverlapPlan('faceC', 0)).toEqual(bodyPlan);

  const basePlan = panelOverlapPlan('zoneDBase', 0);
  const endMainPlan = panelOverlapPlan('endStartMain', 0);
  expect(panelOverlapPlan('endEndMain', 0)).toEqual(endMainPlan);
  const wingIds = ['endStartWingTop', 'endStartWingBottom', 'endEndWingTop', 'endEndWingBottom'];
  const wingPlan = panelOverlapPlan(wingIds[0]!, 0);
  for (const wingId of wingIds) {
    expect(panelOverlapPlan(wingId, 0)).toEqual(wingPlan);
  }

  // 層序：zoneDTab（穿過 slot 後進入盒內）/wing（防塵翼收盒內·藏端蓋後）
  // < zoneDBase（貼 faceA 內側）< 盒身（faceA/faceB/faceC，0 基準）< zoneDLip/endMain（外層）。
  // normalOffset 與 renderOrder 兩軸都必須同向遞增，否則「單軸成立、另一軸反向」
  // 這種失效模式（renderOrder 沒真的跟著翻回來）不會被任何斷言抓到（比照上方 ttsl
  // receive/lock、dust/tuck/lid 斷言方式）。
  expect(tabPlan.normalOffset).toBeLessThan(basePlan.normalOffset);
  expect(tabPlan.renderOrder).toBeLessThan(basePlan.renderOrder);
  expect(basePlan.normalOffset).toBeLessThan(bodyPlan.normalOffset);
  expect(basePlan.renderOrder).toBeLessThan(bodyPlan.renderOrder);
  expect(bodyPlan.normalOffset).toBeLessThan(endMainPlan.normalOffset);
  expect(bodyPlan.renderOrder).toBeLessThan(endMainPlan.renderOrder);
  expect(bodyPlan.normalOffset).toBeLessThan(lipPlan.normalOffset);
  expect(bodyPlan.renderOrder).toBeLessThan(lipPlan.renderOrder);
  expect(wingPlan.normalOffset).toBeLessThan(basePlan.normalOffset);
  expect(wingPlan.renderOrder).toBeLessThan(basePlan.renderOrder);

  // polygonOffsetUnits 軸沿用既有反向遞減慣例（越往內層 units 越大，見上方 ttsl
  // receive/lock 註解）——同向遞增的是 normalOffset/renderOrder，這一軸刻意反向。
  expect(tabPlan.polygonOffsetUnits).toBeGreaterThan(basePlan.polygonOffsetUnits);
  expect(basePlan.polygonOffsetUnits).toBeGreaterThan(bodyPlan.polygonOffsetUnits);
  expect(bodyPlan.polygonOffsetUnits).toBeGreaterThan(endMainPlan.polygonOffsetUnits);
  expect(wingPlan.polygonOffsetUnits).toBeGreaterThan(bodyPlan.polygonOffsetUnits);

  // 通盤驗證：對每一組實際幾何交疊的 panel pair，兩片的 overlapPlan 不可完全相同
  // （相同＝共用同一層＝z-fighting）。
  for (const pair of pairs) {
    const [firstId, secondId] = pair.split('/') as [string, string];
    expect(panelOverlapPlan(firstId, 0)).not.toEqual(panelOverlapPlan(secondId, 0));
  }
});

it('enumerates every completed telescope overlap before assigning render layers', () => {
  const models = {
    base: telescopePieceModel('base'),
    lid: telescopePieceModel('lid'),
  };
  const pairsByPiece = {
    base: overlappingPairs(models.base),
    lid: overlappingPairs(models.lid),
  };
  expect(pairsByPiece).toEqual({
    base: [
      'flapNegNeg/flapPosNeg',
      'flapNegPos/flapPosPos',
      'wallXNeg-inner/wallXNeg-outer',
      'wallXNeg-inner/wallXNeg-rim',
      'wallXNeg-inner/wallXNeg-tongue',
      'wallXNeg-inner/wingXNegNeg',
      'wallXNeg-inner/wingXNegPos',
      'wallXNeg-inner/wingYNegNeg',
      'wallXNeg-inner/wingYNegPos',
      'wallXNeg-outer/wallXNeg-tongue',
      'wallXNeg-outer/wingXNegNeg',
      'wallXNeg-outer/wingXNegPos',
      'wallXNeg-outer/wingYNegNeg',
      'wallXNeg-outer/wingYNegPos',
      'wallXNeg-tongue/wingXNegNeg',
      'wallXNeg-tongue/wingXNegPos',
      'wallXNeg-tongue/wingYNegNeg',
      'wallXNeg-tongue/wingYNegPos',
      'wallXPos-inner/wallXPos-outer',
      'wallXPos-inner/wallXPos-rim',
      'wallXPos-inner/wallXPos-tongue',
      'wallXPos-inner/wingXPosNeg',
      'wallXPos-inner/wingXPosPos',
      'wallXPos-inner/wingYPosNeg',
      'wallXPos-inner/wingYPosPos',
      'wallXPos-outer/wallXPos-tongue',
      'wallXPos-outer/wingXPosNeg',
      'wallXPos-outer/wingXPosPos',
      'wallXPos-outer/wingYPosNeg',
      'wallXPos-outer/wingYPosPos',
      'wallXPos-tongue/wingXPosNeg',
      'wallXPos-tongue/wingXPosPos',
      'wallXPos-tongue/wingYPosNeg',
      'wallXPos-tongue/wingYPosPos',
      'wallYNeg-inner/wallYNeg-tongue',
      'wallYPos-inner/wallYPos-tongue',
      'wingXNegNeg/wingYNegNeg',
      'wingXNegPos/wingYNegPos',
      'wingXPosNeg/wingYPosNeg',
      'wingXPosPos/wingYPosPos',
    ],
    lid: [
      'wallXNeg-inner/wallXNeg-outer',
      'wallXNeg-inner/wallXNeg-tongue',
      'wallXNeg-inner/wingXNegNeg',
      'wallXNeg-inner/wingXNegPos',
      'wallXNeg-inner/wingYNegNeg',
      'wallXNeg-inner/wingYNegPos',
      'wallXNeg-outer/wallXNeg-tongue',
      'wallXNeg-outer/wingXNegNeg',
      'wallXNeg-outer/wingXNegPos',
      'wallXNeg-outer/wingYNegNeg',
      'wallXNeg-outer/wingYNegPos',
      'wallXPos-inner/wallXPos-outer',
      'wallXPos-inner/wallXPos-tongue',
      'wallXPos-inner/wingXPosNeg',
      'wallXPos-inner/wingXPosPos',
      'wallXPos-inner/wingYPosNeg',
      'wallXPos-inner/wingYPosPos',
      'wallXPos-outer/wallXPos-tongue',
      'wallXPos-outer/wingXPosNeg',
      'wallXPos-outer/wingXPosPos',
      'wallXPos-outer/wingYPosNeg',
      'wallXPos-outer/wingYPosPos',
      'wallYNeg-inner/wallYNeg-outer',
      'wallYNeg-inner/wallYNeg-tongue',
      'wallYNeg-outer/wallYNeg-tongue',
      'wallYPos-inner/wallYPos-outer',
      'wallYPos-inner/wallYPos-tongue',
      'wallYPos-outer/wallYPos-tongue',
      'wingXNegNeg/wingYNegNeg',
      'wingXNegPos/wingYNegPos',
      'wingXPosNeg/wingYPosNeg',
      'wingXPosPos/wingYPosPos',
    ],
  });

  for (const [pieceId, pairs] of Object.entries(pairsByPiece)) {
    for (const pair of pairs) {
      const [firstId, secondId] = pair.split('/') as [string, string];
      const firstPlan = panelOverlapPlan(`${pieceId}:${firstId}`, 0);
      const secondPlan = panelOverlapPlan(`${pieceId}:${secondId}`, 0);
      expect(firstPlan, `${pieceId}:${firstId}`).not.toEqual(FALLBACK_OVERLAP_PLAN);
      expect(secondPlan, `${pieceId}:${secondId}`).not.toEqual(FALLBACK_OVERLAP_PLAN);
      expect(firstPlan, `${pieceId}:${pair}`).not.toEqual(secondPlan);
    }
  }

  for (const ySign of ['Neg', 'Pos']) {
    const outer = panelOverlapPlan(`base:wallY${ySign}-outer`, 0);
    const xNeg = panelOverlapPlan(`base:flapNeg${ySign}`, 0);
    const xPos = panelOverlapPlan(`base:flapPos${ySign}`, 0);
    const inner = panelOverlapPlan(`base:wallY${ySign}-inner`, 0);
    expect(outer).not.toEqual(xNeg);
    expect(inner).not.toEqual(xNeg);
    expect(outer).not.toEqual(xPos);
    expect(inner).not.toEqual(xPos);
    expect(xNeg.normalOffset).toBeLessThan(xPos.normalOffset);
    expect(xNeg.renderOrder).toBeLessThan(xPos.renderOrder);
    expect(outer).not.toEqual(inner);
    expect(outer.renderOrder).not.toBe(inner.renderOrder);
  }

  for (const corner of ['NegNeg', 'NegPos', 'PosNeg', 'PosPos']) {
    const ySign = corner.endsWith('Neg') ? 'Neg' : 'Pos';
    const outer = panelOverlapPlan(`lid:wallY${ySign}-outer`, 0);
    const extension = panelOverlapPlan(`lid:gussetExt${corner}`, 0);
    const inner = panelOverlapPlan(`lid:wallY${ySign}-inner`, 0);
    expect(outer.normalOffset).toBeLessThan(extension.normalOffset);
    expect(extension.normalOffset).toBeLessThan(inner.normalOffset);
    expect(outer.renderOrder).toBeLessThan(extension.renderOrder);
    expect(extension.renderOrder).toBeLessThan(inner.renderOrder);
  }
});

// ---------------------------------------------------------------------------
// render 位移：驗證 `panelRenderVertices`
// （fold-scene.ts:988）在實際渲染頂點上的位移等於 overlapPlan 宣告的 normalOffset。
//
// 公式（fold-scene.ts:996-1007）：
//   distance = normalOffset × foldCompletion × exteriorDirection
// normalOffset 本身已經含 layerOffset（:889 `layerOffset = thickness + SURFACE_GAP_MM`），
// 因此 t=1（foldCompletion=1）時位移絕對值 = abs(normalOffset)，不得再乘一次
// layerOffset；t=0（foldCompletion=0）時位移必為 0。

/** 具代表性的非零渲染紙厚（第三方渲染參數，跟盒型自身 thickness 參數是兩回事）。
 * 特意選非零、非 1 的值：這個選值能區分「乘一次 layerOffset」與「乘兩次 layerOffset」
 * （layerOffset=thickness+0.05=0.45mm，跟 1 差很多）。 */
const RENDER_THICKNESS_MM = 0.4;
const DISPLACEMENT_TOLERANCE_MM = 0.01;

// SURFACE_GAP_MM（fold-scene.ts:795）未 export，這裡獨立重算一份當 oracle——不從
// panelOverlapPlan 動態推導 layerOffset，理由見下方 GOLDEN_DISPLACEMENT_MULTIPLIER 註解。
// 這個值須與正式來源的 SURFACE_GAP_MM 保持同步，下面「declared vs golden」那條斷言
// 對此提供約束。
const SURFACE_GAP_MM_INDEPENDENT = 0.05;
const LAYER_OFFSET_MM = RENDER_THICKNESS_MM + SURFACE_GAP_MM_INDEPENDENT;

/** 每片面板「應該」的位移絕對值＝倍數 × layerOffset，倍數逐字對照
 * fold-scene.ts:886-984 各分支的 `±N × layerOffset` 寫法，寫死成獨立 oracle——
 * 不透過呼叫 panelOverlapPlan 動態取得期望值，期望值獨立於被測函式的計算，
 * 不會跟著錯誤值一起漂移。 */
const GOLDEN_DISPLACEMENT_MULTIPLIER: Record<string, number> = {
  bottomReceiveP3: 1,
  bottomLockP1: 1,
  bottomWebP2: 2,
  bottomWebP4: 3,
  topLid: 1,
  topTuck: 2,
  topDustP2: 3,
  topDustP4: 3,
  glue: 1,
  zoneDBase: 1,
  zoneDLip: 1,
  zoneDTab: 2,
  endStartMain: 1,
  endEndMain: 1,
  endStartWingTop: 2,
  endStartWingBottom: 2,
  endEndWingTop: 2,
  endEndWingBottom: 2,
  bottomLid: 1,
  bottomTuck: 2,
  'wallXNeg-outer': 4,
  'wallXNeg-rim': 2,
  'wallXNeg-inner': 8,
  'wallXNeg-tongue': 9,
  'wallYNeg-outer': 4,
  'wallYNeg-inner': 8,
  wingXNegNeg: 6,
  wingYNegNeg: 5,
  flapNegNeg: 9,
  flapPosNeg: 10,
  gussetExtNegNeg: 7,
};

function goldenDisplacementMm(panelId: string): number {
  const multiplier = GOLDEN_DISPLACEMENT_MULTIPLIER[panelId];
  if (multiplier === undefined) {
    throw new Error(`no golden displacement multiplier registered for panel "${panelId}"`);
  }
  return multiplier * LAYER_OFFSET_MM;
}

/** 驗證單一面板的兩項條件：①宣告值與 golden 表一致；②實際渲染位移
 * 達到 golden 值。 */
function expectRenderDisplacementMatchesGolden(
  model: FoldModel,
  panelId: string,
  pose: Map<string, number>,
  geometry: Map<string, Vec3[]>,
  faces: Map<string, PhysicalPanelFace>,
): void {
  const golden = goldenDisplacementMm(panelId);
  expect(Math.abs(panelOverlapPlan(panelId, RENDER_THICKNESS_MM).normalOffset)).toBeCloseTo(golden, 5);
  const displacement = measureRenderDisplacement(
    model, panelId, pose, geometry, faces, RENDER_THICKNESS_MM,
  );
  expect(Math.abs(displacement - golden)).toBeLessThanOrEqual(DISPLACEMENT_TOLERANCE_MM);
}

function exteriorFaceMap(model: FoldModel): Map<string, PhysicalPanelFace> {
  return new Map(
    diagnoseFoldedPanelFaces(model).map(({ panelId, exteriorFace }) => [panelId, exteriorFace]),
  );
}

/** 量測單一面板在給定 pose 下的實際渲染位移量值（沿面法向平移，全頂點應一致）。 */
function measureRenderDisplacement(
  model: FoldModel,
  panelId: string,
  pose: Map<string, number>,
  geometry: Map<string, Vec3[]>,
  faces: Map<string, PhysicalPanelFace>,
  thickness: number,
): number {
  const panel = model.panels.find((candidate) => candidate.id === panelId)!;
  const nominal = geometry.get(panelId)!;
  const rendered = panelRenderVertices(
    panel,
    nominal,
    pose.get(panelId) ?? 0,
    faces.get(panelId)!,
    thickness,
    parentFoldCompletion(panel, model, pose),
  );

  const magnitudes = nominal.map((vertex, index) => {
    const displaced = subtract(rendered[index]!, vertex);
    return Math.hypot(displaced.x, displaced.y, displaced.z);
  });

  // panelRenderVertices 是整片沿單一法向平移（非逐頂點各自變形）——位移量在頂點間須一致，
  // 這是獨立於 abs(normalOffset) 比對的檢查。
  for (const magnitude of magnitudes) {
    expect(magnitude).toBeCloseTo(magnitudes[0]!, 6);
  }
  return magnitudes[0]!;
}

it('ttsl: t=1 底部咬合四片＋頂部 topLid/topTuck/topDustP2/topDustP4/glue 的實際渲染位移絕對值等於 abs(normalOffset)', () => {
  const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, { thickness: 0 }));
  const pose = foldPose(1, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  const targets = [
    'bottomReceiveP3',
    'bottomLockP1',
    'bottomWebP2',
    'bottomWebP4',
    'topLid',
    'topTuck',
    'topDustP2',
    'topDustP4',
    'glue',
  ];

  for (const panelId of targets) {
    expectRenderDisplacementMatchesGolden(model, panelId, pose, geometry, faces);
  }
});

it('telescope: T11 手填 golden 覆蓋反摺、互卡、y 壁 extension 三明治與 jog 家族', () => {
  const base = telescopePieceModel('base');
  const lid = telescopePieceModel('lid');
  for (const [model, targets] of [
    [base, [
      'wallXNeg-outer',
      'wallXNeg-rim',
      'wallXNeg-inner',
      'wallXNeg-tongue',
      'wingXNegNeg',
      'wingYNegNeg',
      'flapNegNeg',
      'flapPosNeg',
    ]],
    [lid, ['wallYNeg-outer', 'gussetExtNegNeg', 'wallYNeg-inner']],
  ] as const) {
    const pose = foldPose(1, model);
    const geometry = worldGeometry(model, pose);
    const faces = exteriorFaceMap(model);
    for (const panelId of targets) {
      expectRenderDisplacementMatchesGolden(
        model,
        panelId,
        pose,
        geometry,
        faces,
      );
    }
  }
});

it('ttsl: t=0（攤平）位移必為 0——foldCompletion 未開始不推開', () => {
  const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, { thickness: 0 }));
  const pose = foldPose(0, model);
  const geometry = worldGeometry(model, pose);
  // t=0 時 diagnoseFoldedPanelFaces 用的是 t=1 完成姿態的分類（純幾何、跟 t 無關），
  // exteriorFace 分類本身不隨 t 改變，沿用同一份即可。
  const faces = exteriorFaceMap(model);

  for (const panelId of [
    'bottomReceiveP3', 'bottomLockP1', 'bottomWebP2', 'bottomWebP4', 'topLid', 'topTuck',
  ]) {
    const displacement = measureRenderDisplacement(
      model, panelId, pose, geometry, faces, RENDER_THICKNESS_MM,
    );
    expect(displacement).toBe(0);
  }
});

it('ttsl: 層序相對關係以位移後的實際渲染座標驗證（bottomReceiveP3 實際低於 bottomLockP1）', () => {
  const model = buildTtslFoldModel(resolveParams(tuckTopSnapLock, { thickness: 0 }));
  const pose = foldPose(1, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  const receiveNominal = geometry.get('bottomReceiveP3')!;
  const lockNominal = geometry.get('bottomLockP1')!;
  const receivePanel = model.panels.find((p) => p.id === 'bottomReceiveP3')!;
  const lockPanel = model.panels.find((p) => p.id === 'bottomLockP1')!;
  const receiveRendered = panelRenderVertices(
    receivePanel, receiveNominal, pose.get('bottomReceiveP3') ?? 0,
    faces.get('bottomReceiveP3')!, RENDER_THICKNESS_MM,
  );
  const lockRendered = panelRenderVertices(
    lockPanel, lockNominal, pose.get('bottomLockP1') ?? 0,
    faces.get('bottomLockP1')!, RENDER_THICKNESS_MM,
  );

  // 兩片摺平後共平面（同一法向）——用該法向當高度軸比較位移後的實際座標，
  // 而非只比較 overlapPlan 的 normalOffset 設定值。
  const normal = polygonNormal(receiveNominal);
  const heightOf = (vertices: Vec3[]) => dot(vertices[0]!, normal);
  expect(heightOf(receiveRendered)).toBeLessThan(heightOf(lockRendered));
});

it('ttb: t=1 Zone D 家族與端封六片的實際渲染位移絕對值等於 abs(normalOffset)', () => {
  const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
  const pose = foldPose(1, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  const targets = [
    'zoneDBase',
    'zoneDLip',
    'zoneDTab',
    'endStartMain',
    'endEndMain',
    'endStartWingTop',
    'endStartWingBottom',
    'endEndWingTop',
    'endEndWingBottom',
  ];

  for (const panelId of targets) {
    expectRenderDisplacementMatchesGolden(model, panelId, pose, geometry, faces);
  }
});

it('ttb: t=0（攤平）位移必為 0', () => {
  const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
  const pose = foldPose(0, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  for (const panelId of ['zoneDBase', 'zoneDLip', 'zoneDTab', 'endStartMain', 'endStartWingTop']) {
    const displacement = measureRenderDisplacement(
      model, panelId, pose, geometry, faces, RENDER_THICKNESS_MM,
    );
    expect(displacement).toBe(0);
  }
});

it('ttb: 實際渲染座標分開 faceA/zoneDBase 與 faceB/zoneDLip 兩組共面幾何', () => {
  const model = buildTtbFoldModel(resolveParams(triangularTube, {}));
  const pose = foldPose(1, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  const render = (panelId: string): Vec3[] => {
    const panel = model.panels.find((p) => p.id === panelId)!;
    const nominal = geometry.get(panelId)!;
    return panelRenderVertices(
      panel, nominal, pose.get(panelId) ?? 0, faces.get(panelId)!, RENDER_THICKNESS_MM,
    );
  };

  const faceA = geometry.get('faceA')!;
  const faceANormal = polygonNormal(faceA);
  const faceAHeight = dot(faceA[0]!, faceANormal);
  const baseHeight = dot(render('zoneDBase')[0]!, faceANormal);
  expect(baseHeight).toBeLessThan(faceAHeight);

  const faceB = geometry.get('faceB')!;
  const faceBNormal = polygonNormal(faceB);
  const faceBHeight = dot(faceB[0]!, faceBNormal);
  const lipHeight = dot(render('zoneDLip')[0]!, faceBNormal);
  // 分離量須達 SURFACE_GAP（0.05mm）量級——任意非零擋不住 z-fighting 回歸
  expect(Math.abs(lipHeight - faceBHeight)).toBeGreaterThanOrEqual(0.045);
});

it('RTE 對照組：位移公式全盒型共用', () => {
  const model = buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
  const pose = foldPose(1, model);
  const geometry = worldGeometry(model, pose);
  const faces = exteriorFaceMap(model);

  for (const panelId of ['topTuck', 'glue', 'topLid', 'bottomTuck']) {
    expectRenderDisplacementMatchesGolden(model, panelId, pose, geometry, faces);
  }
});
