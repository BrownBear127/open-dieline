import type { ResolvedParams } from '../../core/types';
import type { FoldModel, FoldPanel, FoldStep, Pt } from '../types';
import { ARC_TOLERANCE_MM } from '../types';

const INWARD_FOLD_ANGLE = -Math.PI / 2;

function rectangle(left: number, top: number, right: number, bottom: number): Pt[] {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
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

function activeSteps(panels: FoldPanel[]): FoldStep[] {
  const panelIds = new Set(panels.map(({ id }) => id));
  const steps: FoldStep[] = [
    { panelIds: ['P2', 'P3', 'P4', 'glue'], t0: 0, t1: 0.35, ease: 'powerInOut' },
    { panelIds: ['bottomDustP2', 'bottomDustP4'], t0: 0.35, t1: 0.5, ease: 'backIn' },
    { panelIds: ['bottomLid'], t0: 0.5, t1: 0.64, ease: 'powerInOut' },
    { panelIds: ['bottomTuck'], t0: 0.6, t1: 0.72, ease: 'backIn' },
    { panelIds: ['topDustP2', 'topDustP4'], t0: 0.72, t1: 0.84, ease: 'backIn' },
    { panelIds: ['topLid'], t0: 0.84, t1: 0.95, ease: 'powerInOut' },
    { panelIds: ['topTuck'], t0: 0.92, t1: 1, ease: 'backIn' },
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
  const dustFlapDepth = params.dustFlapDepth as number;
  const glueSize = params.glueSize as number;
  const glueOnRight = params.glueSide === 'right';

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

  // topLid 寬=L、高=W（2D: top lid={x2,x3}=wP3、高 hLid=W，x 鏈含補償）。
  panels.push({
    id: 'topLid',
    polygon: rectangle(x2, -W, x3, 0),
    parent: 'P3',
    hingeLine: { a: { x: x2, y: 0 }, b: { x: x3, y: 0 } },
    foldAngle: INWARD_FOLD_ANGLE,
  });

  if (tuckDepth > 0) {
    // topTuck 寬=L、高=tuckDepth（2D: 寬以補償後 P3 邊界再扣 tuckClearance，輪廓含精確圓弧）。
    panels.push({
      id: 'topTuck',
      polygon: roundedTopRectangle(x2, -W - tuckDepth, x3, -W, tuckRadius),
      parent: 'topLid',
      hingeLine: { a: { x: x2, y: -W }, b: { x: x3, y: -W } },
      foldAngle: INWARD_FOLD_ANGLE,
      liftOffset: thickness,
    });
  }

  if (dustFlapDepth > 0) {
    // topDustP2 寬=W、高=dustFlapDepth（2D: 寬=wP2、另含 notch/arch；M0 以名義矩形近似）。
    panels.push({
      id: 'topDustP2',
      polygon: rectangle(x1, -dustFlapDepth, x2, 0),
      parent: 'P2',
      hingeLine: { a: { x: x1, y: 0 }, b: { x: x2, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
    // topDustP4 寬=W、高=dustFlapDepth（2D: 寬=wP4、另含 notch/arch；M0 以名義矩形近似）。
    panels.push({
      id: 'topDustP4',
      polygon: rectangle(x3, -dustFlapDepth, x4, 0),
      parent: 'P4',
      hingeLine: { a: { x: x3, y: 0 }, b: { x: x4, y: 0 } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
  }

  // bottomLid 寬=L、高=W（2D: bottom lid={x0,x1}=wP1、高 hLid=W，x 鏈含補償）。
  panels.push({
    id: 'bottomLid',
    polygon: rectangle(x0, D, x1, D + W),
    parent: 'P1',
    hingeLine: { a: { x: x1, y: D }, b: { x: x0, y: D } },
    foldAngle: INWARD_FOLD_ANGLE,
  });

  if (tuckDepth > 0) {
    // bottomTuck 寬=L、高=tuckDepth（2D: 寬以補償後 P1 邊界再扣 tuckClearance，輪廓含精確圓弧）。
    panels.push({
      id: 'bottomTuck',
      polygon: roundedBottomRectangle(x0, D + W, x1, D + W + tuckDepth, tuckRadius),
      parent: 'bottomLid',
      hingeLine: { a: { x: x1, y: D + W }, b: { x: x0, y: D + W } },
      foldAngle: INWARD_FOLD_ANGLE,
      liftOffset: thickness,
    });
  }

  if (dustFlapDepth > 0) {
    // bottomDustP2 寬=W、高=dustFlapDepth（2D: 寬=wP2、另含 notch/arch；M0 以名義矩形近似）。
    panels.push({
      id: 'bottomDustP2',
      polygon: rectangle(x1, D, x2, D + dustFlapDepth),
      parent: 'P2',
      hingeLine: { a: { x: x2, y: D }, b: { x: x1, y: D } },
      foldAngle: INWARD_FOLD_ANGLE,
    });
    // bottomDustP4 寬=W、高=dustFlapDepth（2D: 寬=wP4、另含 notch/arch；M0 以名義矩形近似）。
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
