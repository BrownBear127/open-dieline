import { triangularTube } from '../../boxes/triangular-tube';
import type { ResolvedParams } from '../../core/types';
import {
  assertBoxInvariants,
  clampFoldPanelsToBodyHull,
  panelizeFoldModel,
  splitFoldPanelHorizontally,
  type PanelAngleSpec,
} from '../derive/panelize';
import type { FoldModel, FoldStep } from '../types';

const OUTWARD_QUARTER_TURN = -Math.PI / 2;

/** 端封件視覺 allowance 的收束 spec（oracle 測試重放後處理用·勿與 builder 分歧）。 */
export const TTB_BODY_HULL_CLAMP_SPEC = {
  bodyPanelIds: ['faceA', 'faceB', 'faceC'],
  targetPanelIds: [
    'endStartMain',
    'endStartWingTop',
    'endStartWingBottom',
    'endEndMain',
    'endEndWingTop',
    'endEndWingBottom',
  ],
} as const;

const EDGE_B_DELTA = 1.5;
const EDGE_C_DELTA = 2.5;

const TTB_STEPS: FoldStep[] = [
  {
    panelIds: [
      'endStartWingTop',
      'endStartWingBottom',
      'endEndWingTop',
      'endEndWingBottom',
    ],
    t0: 0,
    t1: 0.22,
    ease: 'backIn',
  },
  { panelIds: ['endStartMain', 'endEndMain'], t0: 0.22, t1: 0.42, ease: 'powerInOut' },
  { panelIds: ['faceB', 'faceC'], t0: 0.42, t1: 0.72, ease: 'powerInOut' },
  // zoneD 掃掠漸進預彎：三 hinge 提早進掃掠段（0.42-0.72）同步捲入，
  // lip/tab 先於 base 收滿（「尾鉤早收滿」——半開的鉤在 base 收攏中段會掃穿盒底，
  // 全收攏的鉤外伸半徑最小）。時窗須過 ttb-sweep-gates 物理閘門（自交/反向/角速度/捲入）。
  { panelIds: ['zoneDBase'], t0: 0.55, t1: 0.9, ease: 'powerInOut' },
  { panelIds: ['zoneDLip'], t0: 0.55, t1: 0.85, ease: 'powerInOut' },
  { panelIds: ['zoneDTab'], t0: 0.58, t1: 0.85, ease: 'powerInOut' },
];

/** 餘弦定理：對邊 c 的內角（夾在 a、b 兩邊之間）。 */
function interiorAngle(a: number, b: number, c: number): number {
  return Math.acos((a * a + b * b - c * c) / (2 * a * b));
}

function TTB_ANGLES(params: ResolvedParams): PanelAngleSpec[] {
  const edgeA = params.edgeA as number;
  const edgeB = edgeA + EDGE_B_DELTA;
  const edgeC = edgeA + EDGE_C_DELTA;

  return [
    { id: 'faceA', foldAngle: 0 },
    {
      id: 'faceB',
      foldAngle: -(Math.PI - interiorAngle(edgeA, edgeB, edgeC)),
    },
    {
      id: 'faceC',
      foldAngle: -(Math.PI - interiorAngle(edgeB, edgeC, edgeA)),
    },
    {
      id: 'zoneDBase',
      foldAngle: -(Math.PI - interiorAngle(edgeC, edgeA, edgeB)),
    },
    { id: 'zoneDTab', foldAngle: -interiorAngle(edgeA, edgeB, edgeC) },
    { id: 'endStartMain', foldAngle: OUTWARD_QUARTER_TURN },
    { id: 'endStartWingTop', foldAngle: OUTWARD_QUARTER_TURN },
    { id: 'endStartWingBottom', foldAngle: OUTWARD_QUARTER_TURN },
    { id: 'endEndMain', foldAngle: OUTWARD_QUARTER_TURN },
    { id: 'endEndWingTop', foldAngle: OUTWARD_QUARTER_TURN },
    { id: 'endEndWingBottom', foldAngle: OUTWARD_QUARTER_TURN },
  ];
}

export function buildTtbFoldModel(params: ResolvedParams): FoldModel {
  const result = triangularTube.generate(params);
  assertBoxInvariants(triangularTube, params, result);
  const model = panelizeFoldModel(result, 'faceA', TTB_ANGLES(params), TTB_STEPS);
  const edgeA = params.edgeA as number;
  const edgeB = edgeA + EDGE_B_DELTA;
  const edgeC = edgeA + EDGE_C_DELTA;
  const split = splitFoldPanelHorizontally(model, {
    panelId: 'zoneDBase',
    newPanelId: 'zoneDLip',
    reparentChildId: 'zoneDTab',
    splitY: edgeA + edgeB + edgeC + edgeA,
    foldAngle: -(Math.PI - interiorAngle(edgeA, edgeB, edgeC)),
  });
  // 端封件視覺 allowance：刀模的 friction-fit 補償材料（鎖縫角懸出 2.28mm）僅存在
  // 於 2D 輸出，3D 呈現以 vertexClamp 收束進盒體輪廓——否則零厚度剛體下顯示成
  // 端蓋/翼破圖凸出。
  return clampFoldPanelsToBodyHull(split, TTB_BODY_HULL_CLAMP_SPEC);
}
