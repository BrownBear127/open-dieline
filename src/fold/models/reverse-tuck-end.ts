import type { ResolvedParams } from '../../core/types';
import type { FoldModel, FoldPanel, FoldStep, Pt } from '../types';
import { ARC_TOLERANCE_MM } from '../types';

const INWARD_FOLD_ANGLE = -Math.PI / 2;
// Mirrors core/primitives.frictionLock; rte-reconcile guards these nominal 3D vertices
// against the compensated 2D output without coupling the fold chunk to 2D path builders.
const FRICTION_LOCK_HEIGHT = 1.5;
const FRICTION_LOCK_CHAMFER = 2;

function rectangle(left: number, top: number, right: number, bottom: number): Pt[] {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function rotatePolygon(polygon: Pt[], startIndex: number): Pt[] {
  return [...polygon.slice(startIndex), ...polygon.slice(0, startIndex)];
}

function lidWingWidth(lidWidth: number, tuckLock: number): number {
  // The 2D generator permits an over-wide lock and reports it as an invariant. Three equal
  // hinges keep all slices valid when two literal tuckLock segments would consume LidC.
  return 2 * tuckLock < lidWidth ? tuckLock : lidWidth / 3;
}

function arcPoints(
  center: Pt,
  radius: number,
  startAngle: number,
  endAngle: number,
): Pt[] {
  const sweep = endAngle - startAngle;
  const toleranceRatio = Math.min(1, ARC_TOLERANCE_MM / radius);
  const maxSegmentAngle = 2 * Math.acos(1 - toleranceRatio);
  const segmentCount = Math.max(2, Math.ceil(Math.abs(sweep) / maxSegmentAngle));

  return Array.from({ length: segmentCount }, (_, index) => {
    const angle = startAngle + sweep * ((index + 1) / segmentCount);
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    };
  });
}

function roundedTopRectangle(
  left: number,
  top: number,
  right: number,
  bottom: number,
  requestedRadius: number,
): Pt[] {
  const radius = Math.max(0, Math.min(requestedRadius, bottom - top, (right - left) / 2));
  if (radius === 0) return rectangle(left, top, right, bottom);

  return [
    { x: left, y: bottom },
    { x: left, y: top + radius },
    ...arcPoints({ x: left + radius, y: top + radius }, radius, Math.PI, 1.5 * Math.PI),
    { x: right - radius, y: top },
    ...arcPoints({ x: right - radius, y: top + radius }, radius, 1.5 * Math.PI, 2 * Math.PI),
    { x: right, y: bottom },
  ];
}

function roundedBottomRectangle(
  left: number,
  top: number,
  right: number,
  bottom: number,
  requestedRadius: number,
): Pt[] {
  const radius = Math.max(0, Math.min(requestedRadius, bottom - top, (right - left) / 2));
  if (radius === 0) return rectangle(left, top, right, bottom);

  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom - radius },
    ...arcPoints({ x: right - radius, y: bottom - radius }, radius, 0, Math.PI / 2),
    { x: left + radius, y: bottom },
    ...arcPoints({ x: left + radius, y: bottom - radius }, radius, Math.PI / 2, Math.PI),
  ];
}

function slicedLidPanels(
  side: 'top' | 'bottom',
  left: number,
  right: number,
  hingeY: number,
  depth: number,
  tuckLock: number,
  parent: string,
): FoldPanel[] {
  const width = right - left;
  const wingWidth = lidWingWidth(width, tuckLock);
  const centerLeft = left + wingWidth;
  const centerRight = right - wingWidth;
  const centerX = (left + right) / 2;
  const lockLeft = centerX - tuckLock / 2;
  const lockRight = centerX + tuckLock / 2;
  const bottomLeftPolygon: Pt[] = [
    { x: left, y: hingeY },
    { x: centerLeft, y: hingeY },
    { x: centerLeft, y: hingeY + depth },
    { x: centerX, y: hingeY + depth },
    { x: centerX, y: hingeY + depth + FRICTION_LOCK_HEIGHT },
    { x: lockLeft + FRICTION_LOCK_CHAMFER, y: hingeY + depth + FRICTION_LOCK_HEIGHT },
    { x: lockLeft, y: hingeY + depth },
    { x: left, y: hingeY + depth },
  ];
  const bottomCenterPolygon = rectangle(centerLeft, hingeY, centerRight, hingeY + depth);
  const bottomRightPolygon: Pt[] = [
    { x: centerRight, y: hingeY },
    { x: right, y: hingeY },
    { x: right, y: hingeY + depth },
    { x: lockRight, y: hingeY + depth },
    { x: lockRight - FRICTION_LOCK_CHAMFER, y: hingeY + depth + FRICTION_LOCK_HEIGHT },
    { x: centerX, y: hingeY + depth + FRICTION_LOCK_HEIGHT },
    { x: centerX, y: hingeY + depth },
    { x: centerRight, y: hingeY + depth },
  ];

  const topY = (point: Pt): Pt => ({ x: point.x, y: 2 * hingeY - point.y });
  const polygons = side === 'bottom'
    ? [
        rotatePolygon(bottomLeftPolygon, 2),
        bottomCenterPolygon,
        rotatePolygon(bottomRightPolygon, 7),
      ]
    : [
        rotatePolygon(bottomLeftPolygon.map(topY).reverse(), 5),
        bottomCenterPolygon.map(topY).reverse(),
        bottomRightPolygon.map(topY).reverse(),
      ];
  const prefix = side === 'top' ? 'topLid' : 'bottomLid';
  const hingeSegments = side === 'top'
    ? [[left, centerLeft], [centerLeft, centerRight], [centerRight, right]]
    : [[centerLeft, left], [centerRight, centerLeft], [right, centerRight]];

  return (['L', 'C', 'R'] as const).map((suffix, index) => ({
    id: `${prefix}${suffix}`,
    polygon: polygons[index]!,
    parent,
    hingeLine: {
      a: { x: hingeSegments[index]![0]!, y: hingeY },
      b: { x: hingeSegments[index]![1]!, y: hingeY },
    },
    foldAngle: INWARD_FOLD_ANGLE,
  }));
}

function activeSteps(panels: FoldPanel[]): FoldStep[] {
  const panelIds = new Set(panels.map(({ id }) => id));
  // 摺序物理約束（2026-07-17 法蘭 E2E 裁決）：tuck 是 lid 的子面板，插舌時間窗
  // 必須在蓋板起摺前收完——蓋板帶著已折好的插舌蓋上；反序插舌會穿盒壁。
  const steps: FoldStep[] = [
    { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
    { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
    { panelIds: ['bottomTuck'], t0: 0.5, t1: 0.6, ease: 'backIn' },
    {
      panelIds: ['bottomLid', 'bottomLidL', 'bottomLidC', 'bottomLidR'],
      t0: 0.6,
      t1: 0.72,
      ease: 'powerInOut',
    },
    { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
    { panelIds: ['topTuck'], t0: 0.84, t1: 0.92, ease: 'backIn' },
    {
      panelIds: ['topLid', 'topLidL', 'topLidC', 'topLidR'],
      t0: 0.92,
      t1: 1,
      ease: 'powerInOut',
    },
  ];

  return steps
    .map((step) => ({ ...step, panelIds: step.panelIds.filter((id) => panelIds.has(id)) }))
    .filter(({ panelIds: ids }) => ids.length > 0);
}

export function buildRteFoldModel(params: ResolvedParams): FoldModel {
  const L = params.L as number;
  const W = params.W as number;
  const D = params.D as number;
  const thickness = params.thickness as number;
  const tuckDepth = params.tuckDepth as number;
  const tuckRadius = params.tuckRadius as number;
  const tuckClearance = params.tuckClearance as number;
  const tuckLock = params.tuckLock as number;
  const dustFlapDepth = params.dustFlapDepth as number;
  const flapNotch = params.flapNotch as number;
  const creaseRelief = params.creaseRelief as number;
  const glueSize = params.glueSize as number;
  const glueOnRight = params.glueSide === 'right';

  // 插舌 x 範圍＝蓋板邊界各內縮 tuckClearance（2D: xt1/xt2=lid.start+tInset/lid.end−tInset）。
  // tuckClearance 是 resolved 參數值（derivedDefault 已含 +t）——resolved 值進名義模型；
  // 鉗制到蓋板半寬（2D tongueHalfWidth 鉗制同精神）；clearance 吃光蓋板寬（tongueWidth=0）
  // 時插舌實體不存在＝面板缺席（零值語義同精神·2D 對應 tongue 退化 invariant 示警面）。
  const tuckInset = Math.max(0, Math.min(tuckClearance, L / 2));
  const tongueWidth = L - 2 * tuckInset;
  const hasTuck = tuckDepth > 0 && tongueWidth > 0;

  // 防塵翼「蓋板鄰側」尖端內縮＝2D 呼叫端 xGapVal 同式（||3 floor 同 2D reliefGap）；
  // 名義空間不含 generate 層的裸 +t 紙厚讓位（D10 規則：resolved 參數值進模型、
  // generate 層厚度調整與 comp[]×t 同類排除）。J-hook 曲線細節不進 M1——尖端內縮的
  // 梯形是名義近似（M0「名義矩形近似」同精神·M2 視覺輪再議）。
  const xGapVal = Math.max(flapNotch > 0 ? flapNotch : 0, creaseRelief > 0 ? creaseRelief : 0);
  const dustRelief = Math.min(xGapVal > 0 ? xGapVal : 3, W / 2);

  const hasTuckLock = tuckLock > 0;
  const effectiveLidWingWidth = lidWingWidth(L, tuckLock);

  const x0 = 0;
  const x1 = L;
  const x2 = L + W;
  const x3 = 2 * L + W;
  const x4 = 2 * L + 2 * W;

  const panels: FoldPanel[] = [
    // P1 寬=L（2D: wP1=L+comp[0]×t）；FoldModel 保留成品名義尺寸。
    { id: 'P1', polygon: rectangle(x0, 0, x1, D), parent: null, foldAngle: 0 },
    // P2 寬=W（2D: wP2=W+comp[1]×t）；FoldModel 不含 girth 補償。
    {
      id: 'P2',
      polygon: rectangle(x1, 0, x2, D),
      parent: 'P1',
      hingeLine: { a: { x: x1, y: 0 }, b: { x: x1, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    },
    // P3 寬=L（2D: wP3=L+comp[2]×t）；FoldModel 不含 girth 補償。
    {
      id: 'P3',
      polygon: rectangle(x2, 0, x3, D),
      parent: 'P2',
      hingeLine: { a: { x: x2, y: 0 }, b: { x: x2, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    },
    // P4 寬=W（2D: wP4=W+comp[3]×t）；FoldModel 不含 girth 補償。
    {
      id: 'P4',
      polygon: rectangle(x3, 0, x4, D),
      parent: 'P3',
      hingeLine: { a: { x: x3, y: 0 }, b: { x: x3, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    },
  ];

  if (glueOnRight) {
    // glue 寬=glueSize、位於 x4 右側（2D: wGlue=glueSize，掛右側補償後 x4）。
    panels.push({
      id: 'glue',
      polygon: rectangle(x4, 0, x4 + glueSize, D),
      parent: 'P4',
      hingeLine: { a: { x: x4, y: 0 }, b: { x: x4, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  } else {
    // glue 寬=glueSize、位於 x0 左側（2D: wGlue=glueSize，掛左側補償前 x0）。
    panels.push({
      id: 'glue',
      polygon: rectangle(x0 - glueSize, 0, x0, D),
      parent: 'P1',
      hingeLine: { a: { x: x0, y: D }, b: { x: x0, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  // tuckLock=0 preserves the M1 single-panel ids. A positive lock splits the lid into
  // coplanar L/C/R siblings; L/R each carry half of the 2D friction-lock trapezoid.
  if (hasTuckLock) {
    panels.push(...slicedLidPanels('top', x2, x3, 0, W, tuckLock, 'P3'));
  } else {
    panels.push({
      id: 'topLid',
      polygon: rectangle(x2, -W, x3, 0),
      parent: 'P3',
      hingeLine: { a: { x: x2, y: 0 }, b: { x: x3, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  if (hasTuck) {
    // topTuck 寬=L−2×tuckClearance、高=tuckDepth（2D: xt1/xt2=蓋板邊界∓tInset·:428-429）；
    // hinge 跟插舌基邊同縮（仍落在蓋板 y=-W 單一邊內·validate 含中點規則滿足）。
    panels.push({
      id: 'topTuck',
      polygon: roundedTopRectangle(x2 + tuckInset, -W - tuckDepth, x3 - tuckInset, -W, tuckRadius),
      parent: hasTuckLock ? 'topLidC' : 'topLid',
      hingeLine: {
        a: { x: Math.max(x2 + tuckInset, x2 + effectiveLidWingWidth), y: -W },
        b: { x: Math.min(x3 - tuckInset, x3 - effectiveLidWingWidth), y: -W },
      },
      foldAngle: INWARD_FOLD_ANGLE,
      liftOffset: thickness,
    });
  }

  if (dustFlapDepth > 0) {
    // topDustP2 高=dustFlapDepth·尖端在蓋板側（x2·緊鄰 topLid=P3）內縮 dustRelief
    //（2D drawRelief(x2,…,'left','top')）；hinge 全寬不變（2D crease x1..x2 全跨）。
    panels.push({
      id: 'topDustP2',
      polygon: [
        { x: x1, y: -dustFlapDepth },
        { x: x2 - dustRelief, y: -dustFlapDepth },
        { x: x2, y: 0 },
        { x: x1, y: 0 },
      ],
      parent: 'P2',
      hingeLine: { a: { x: x1, y: 0 }, b: { x: x2, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
    // topDustP4 尖端在蓋板側（x3）內縮 dustRelief（2D drawRelief(x3,…,'right','top')）。
    panels.push({
      id: 'topDustP4',
      polygon: [
        { x: x3 + dustRelief, y: -dustFlapDepth },
        { x: x4, y: -dustFlapDepth },
        { x: x4, y: 0 },
        { x: x3, y: 0 },
      ],
      parent: 'P4',
      hingeLine: { a: { x: x3, y: 0 }, b: { x: x4, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  if (hasTuckLock) {
    panels.push(...slicedLidPanels('bottom', x0, x1, D, W, tuckLock, 'P1'));
  } else {
    panels.push({
      id: 'bottomLid',
      polygon: rectangle(x0, D, x1, D + W),
      parent: 'P1',
      hingeLine: { a: { x: x1, y: D }, b: { x: x0, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  if (hasTuck) {
    // bottomTuck 寬=L−2×tuckClearance、高=tuckDepth（2D 同 topTuck·蓋板換 P1 側）；
    // hinge 端點順序保留原方向（a 在 x 大側）。
    panels.push({
      id: 'bottomTuck',
      polygon: roundedBottomRectangle(x0 + tuckInset, D + W, x1 - tuckInset, D + W + tuckDepth, tuckRadius),
      parent: hasTuckLock ? 'bottomLidC' : 'bottomLid',
      hingeLine: {
        a: { x: Math.min(x1 - tuckInset, x1 - effectiveLidWingWidth), y: D + W },
        b: { x: Math.max(x0 + tuckInset, x0 + effectiveLidWingWidth), y: D + W },
      },
      foldAngle: INWARD_FOLD_ANGLE,
      liftOffset: thickness,
    });
  }

  if (dustFlapDepth > 0) {
    // bottomDustP2 尖端在蓋板側（x1·bottom 蓋板=P1）內縮 dustRelief
    //（2D drawRelief(x1,…,'right','bottom')）；hinge 全寬不變。
    panels.push({
      id: 'bottomDustP2',
      polygon: [
        { x: x1, y: D },
        { x: x2, y: D },
        { x: x2, y: D + dustFlapDepth },
        { x: x1 + dustRelief, y: D + dustFlapDepth },
      ],
      parent: 'P2',
      hingeLine: { a: { x: x2, y: D }, b: { x: x1, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
    // bottomDustP4 維持名義矩形——2D 真相如此：bottom 蓋板在 P1，P4 不緊鄰蓋板、
    // 本來就沒有 relief（src/boxes/reverse-tuck-end.ts:378-386 手刻不對稱紀錄）。
    panels.push({
      id: 'bottomDustP4',
      polygon: rectangle(x3, D, x4, D + dustFlapDepth),
      parent: 'P4',
      hingeLine: { a: { x: x4, y: D }, b: { x: x3, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  return { panels, steps: activeSteps(panels) };
}
