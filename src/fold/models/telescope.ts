import { telescope } from '../../boxes/telescope';
import type { Segment } from '../../core/geometry';
import type {
  DielinePath,
  DielinePiece,
  GenerateResult,
  ResolvedParams,
} from '../../core/types';
import {
  assertBoxInvariants,
  InvalidBoxParamsError,
  panelizeFoldModel,
  type FoldOnlyInactiveSegments,
  type PanelAngleSpec,
} from '../derive/panelize';
import {
  defineFoldSceneSpec,
  type FoldSceneSpec,
  type Quaternion,
  type SceneKeyframe,
} from '../scene-spec';
import {
  ARC_TOLERANCE_MM,
  type FoldModel,
  type FoldStep,
  type Pt,
} from '../types';

const FOLD_ROLE_PATTERN = /^fold:([^>]+)>([^>]+)$/;
const ROOT_ID = 'floor';
const LINER_ROOT_ID = 'linerPad';
const ROLE_FRAGMENT_TOLERANCE_MM = 30;
const MIN_AUXILIARY_FACE_AREA_MM2 = 50;
const AUXILIARY_FACE_WIDTH_MM = 1;
const QUARTER_TURN = Math.PI / 2;
const THREE_QUARTER_TURN = (3 * Math.PI) / 4;

const AXIS_SIGNS = ['XNeg', 'XPos', 'YNeg', 'YPos'] as const;
const CORNERS = ['NegNeg', 'NegPos', 'PosNeg', 'PosPos'] as const;

export const TELESCOPE_FOLD_WINDOWS = {
  base: [0, 0.5],
  lid: [0.1, 0.55],
  liner: [0.15, 0.58],
} as const;

export const TELESCOPE_FOLD_WINDOWS_OFF = {
  base: [0, 0.62],
  lid: [0.05, 0.68],
} as const;

export const TELESCOPE_ASSEMBLY_WINDOWS = {
  // identity anchor → lift → move → drop
  liner: [0.6, 0.66, 0.72, 0.78],
  // identity anchor → lift → x-flip → move → drop
  lid: [0.8, 0.85, 0.9, 0.95, 1],
  lidOff: [0.7, 0.775, 0.85, 0.925, 1],
} as const;

export const TELESCOPE_TRAY_WINDOWS = {
  flapped: {
    pretuck: [0, 0.08],
    prefoldX: [0.08, 0.18],
    prefoldY: [0.18, 0.3],
    phaseA: [0.3, 0.65],
    phaseB: [0.65, 0.82],
    phaseC: [0.82, 1],
  },
  plain: {
    prefoldX: [0, 0.15],
    prefoldY: [0.15, 0.3],
    phaseA: [0.3, 0.65],
    phaseB: [0.65, 0.82],
    phaseCExt: [0.82, 1],
  },
} as const;

export interface TelescopeFlapDriverWindows {
  pretuckEnd: number;
  phaseCStart: number;
  phaseCMid: number;
  phaseCEnd: number;
}

function intervalProgress(value: number, start: number, end: number): number {
  if (value <= start) return 0;
  if (value >= end) return 1;
  return (value - start) / (end - start);
}

/** 五摺線頂點的 inward branch 閉式；輸入牆角 φ、輸出翼角 ψ（rad）。 */
export function telescopePsi(phi: number): number {
  return 2 * Math.atan((1 + Math.SQRT2) * Math.tan(phi / 2));
}

/**
 * phase A 與 phase B 合在同一 panel driver：
 * A 依 ψ(φ) 同步立壁，B 讓 X 翼壓貼左右壁、Y 翼反向退至 90°。
 */
export function createTelescopeWingAngleFn(
  axis: 'X' | 'Y',
  phaseASplit: number,
): (stepLocalT: number) => number {
  if (!(phaseASplit > 0 && phaseASplit < 1)) {
    throw new Error('Telescope wing phaseASplit 必須落在 0 與 1 之間');
  }
  return (stepLocalT) => {
    if (stepLocalT <= phaseASplit) {
      const phi = QUARTER_TURN * intervalProgress(
        stepLocalT,
        0,
        phaseASplit,
      );
      return telescopePsi(phi);
    }
    const pressProgress = intervalProgress(stepLocalT, phaseASplit, 1);
    const direction = axis === 'X' ? 1 : -1;
    return THREE_QUARTER_TURN
      + direction * (Math.PI / 4) * pressProgress;
  };
}

/** pretuck→hold→C tuck-seq 合在單一 panel driver；xNeg 先、xPos 後。 */
export function createTelescopeFlapAngleFn(
  xSign: 'Neg' | 'Pos',
  windows: TelescopeFlapDriverWindows,
): (stepLocalT: number) => number {
  const {
    pretuckEnd,
    phaseCStart,
    phaseCMid,
    phaseCEnd,
  } = windows;
  if (!(
    0 < pretuckEnd
    && pretuckEnd <= phaseCStart
    && phaseCStart < phaseCMid
    && phaseCMid < phaseCEnd
    && phaseCEnd <= 1
  )) {
    throw new Error('Telescope flap windows 必須依 pretuck→C 前半→C 後半嚴格排序');
  }

  return (stepLocalT) => {
    if (stepLocalT <= pretuckEnd) {
      return Math.PI * intervalProgress(stepLocalT, 0, pretuckEnd);
    }
    const foldStart = xSign === 'Neg' ? phaseCStart : phaseCMid;
    const foldEnd = xSign === 'Neg' ? phaseCMid : phaseCEnd;
    if (stepLocalT <= foldStart) return Math.PI;
    return Math.PI
      - QUARTER_TURN * intervalProgress(stepLocalT, foldStart, foldEnd);
  };
}

/** P0 extension 在 B 後繞自身鉸包上相鄰 y 壁。 */
export function telescopeExtensionAngle(stepLocalT: number): number {
  const [start, end] = TELESCOPE_TRAY_WINDOWS.plain.phaseCExt;
  return QUARTER_TURN * intervalProgress(stepLocalT, start, end);
}

function point(horizontal: number, vertical: number): Pt {
  const result = {} as Pt;
  result.x = horizontal;
  result.y = vertical;
  return result;
}

/** Telescope panel id 唯一命名表；每片 tray 各自使用同一棵無 piece 前綴的樹。 */
export const TELESCOPE_PANEL_IDS = {
  floor: ROOT_ID,
  walls: AXIS_SIGNS.flatMap((axisSign) => [
    `wall${axisSign}-outer`,
    `wall${axisSign}-rim`,
    `wall${axisSign}-inner`,
    `wall${axisSign}-tongue`,
  ]),
  wings: CORNERS.flatMap((corner) => [
    `wingX${corner}`,
    `wingY${corner}`,
  ]),
  flaps: CORNERS.map((corner) => `flap${corner}`),
  gussetExtensions: CORNERS.map((corner) => `gussetExt${corner}`),
  linerPad: LINER_ROOT_ID,
  linerLegs: ['linerLegXNeg', 'linerLegXPos', 'linerLegYNeg', 'linerLegYPos'],
} as const;

function pieceResult(result: GenerateResult, piece: DielinePiece): GenerateResult {
  const pathIds = new Set(piece.pathIds);
  const textIds = new Set(piece.textIds);
  return {
    paths: result.paths.filter(({ id }) => pathIds.has(id)),
    texts: result.texts.filter(({ id }) => textIds.has(id)),
    bounds: { ...piece.bounds },
  };
}

function panelIdsFromRoles(result: GenerateResult, rootId: string): string[] {
  const ids = new Set([rootId]);
  for (const tag of result.paths.flatMap(({ tags }) => tags ?? [])) {
    const match = FOLD_ROLE_PATTERN.exec(tag);
    if (!match) continue;
    ids.add(match[1]!);
    ids.add(match[2]!);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function panelAngles(result: GenerateResult, rootId: string): PanelAngleSpec[] {
  const panelIds = panelIdsFromRoles(result, rootId);
  const panelIdSet = new Set(panelIds);
  return panelIds.map((id) => {
    let foldAngle = 0;
    if (id !== rootId && rootId === LINER_ROOT_ID) {
      foldAngle = -QUARTER_TURN;
    } else if (/^wall[XY](?:Neg|Pos)-outer$/.test(id)) {
      foldAngle = QUARTER_TURN;
    } else if (/^wall[XY](?:Neg|Pos)-rim$/.test(id)) {
      foldAngle = id.startsWith('wallX') ? 0 : QUARTER_TURN;
    } else if (/^wall[XY](?:Neg|Pos)-inner$/.test(id)) {
      const rimId = id.replace(/-inner$/, '-rim');
      foldAngle = id.startsWith('wallY') && panelIdSet.has(rimId)
        ? QUARTER_TURN
        : Math.PI;
    } else if (/^wall[XY](?:Neg|Pos)-tongue$/.test(id)) {
      foldAngle = Math.PI;
    } else if (id.startsWith('wingX')) {
      foldAngle = Math.PI;
    } else if (id.startsWith('wingY')) {
      foldAngle = QUARTER_TURN;
    } else if (id.startsWith('flap')) {
      foldAngle = -QUARTER_TURN;
    } else if (id.startsWith('gussetExt')) {
      foldAngle = -QUARTER_TURN;
    }
    return { id, foldAngle };
  });
}

function step(
  panelIds: string[],
  window: readonly [number, number],
): FoldStep | null {
  return panelIds.length === 0
    ? null
    : {
      panelIds,
      t0: window[0],
      t1: window[1],
      ease: 'linear',
    };
}

function traySteps(panelIds: string[]): FoldStep[] {
  const hasFlaps = panelIds.some((id) => id.startsWith('flap'));
  const windows = hasFlaps
    ? TELESCOPE_TRAY_WINDOWS.flapped
    : TELESCOPE_TRAY_WINDOWS.plain;
  const matching = (pattern: RegExp): string[] =>
    panelIds.filter((id) => pattern.test(id));
  const steps = [
    step(
      matching(/^wallX(?:Neg|Pos)-(?:rim|inner|tongue)$/),
      windows.prefoldX,
    ),
    step(
      matching(/^wallY(?:Neg|Pos)-(?:rim|inner|tongue)$/),
      windows.prefoldY,
    ),
    step(matching(/^wall[XY](?:Neg|Pos)-outer$/), windows.phaseA),
    step(
      matching(/^wing[XY]/),
      [windows.phaseA[0], windows.phaseB[1]],
    ),
    !hasFlaps
      ? step(matching(/^gussetExt/), [
        TELESCOPE_TRAY_WINDOWS.plain.prefoldX[0],
        TELESCOPE_TRAY_WINDOWS.plain.phaseCExt[1],
      ])
      : null,
    hasFlaps
      ? step(matching(/^flap/), [
        TELESCOPE_TRAY_WINDOWS.flapped.pretuck[0],
        TELESCOPE_TRAY_WINDOWS.flapped.phaseC[1],
      ])
      : null,
  ];
  return steps.filter((candidate): candidate is FoldStep => candidate !== null);
}

function linerSteps(panelIds: string[]): FoldStep[] {
  const legIds = panelIds.filter((id) => id.startsWith('linerLeg'));
  const legStep = step(legIds, [0, 1]);
  return legStep === null ? [] : [legStep];
}

function withTrayAngleDrivers(model: FoldModel): FoldModel {
  const hasFlaps = model.panels.some(({ id }) => id.startsWith('flap'));
  const windows = hasFlaps
    ? TELESCOPE_TRAY_WINDOWS.flapped
    : TELESCOPE_TRAY_WINDOWS.plain;
  const phaseASplit = (
    (windows.phaseA[1] - windows.phaseA[0])
    / (windows.phaseB[1] - windows.phaseA[0])
  );
  const flapWindows: TelescopeFlapDriverWindows = {
    pretuckEnd: TELESCOPE_TRAY_WINDOWS.flapped.pretuck[1],
    phaseCStart: TELESCOPE_TRAY_WINDOWS.flapped.phaseC[0],
    phaseCMid: (
      TELESCOPE_TRAY_WINDOWS.flapped.phaseC[0]
      + TELESCOPE_TRAY_WINDOWS.flapped.phaseC[1]
    ) / 2,
    phaseCEnd: TELESCOPE_TRAY_WINDOWS.flapped.phaseC[1],
  };

  return {
    ...model,
    panels: model.panels.map((panel) => {
      if (panel.id.startsWith('wingX')) {
        return {
          ...panel,
          angleFn: createTelescopeWingAngleFn('X', phaseASplit),
        };
      }
      if (panel.id.startsWith('wingY')) {
        return {
          ...panel,
          angleFn: createTelescopeWingAngleFn('Y', phaseASplit),
        };
      }
      if (panel.id.startsWith('flap')) {
        const xSign = panel.id.slice('flap'.length).startsWith('Neg')
          ? 'Neg'
          : 'Pos';
        const magnitudeDriver = createTelescopeFlapAngleFn(xSign, flapWindows);
        return {
          ...panel,
          // canonical hinge 方向下負角才由 x 內壁掃入盒內；180° 時兩符號同姿態。
          angleFn: (stepLocalT) => -magnitudeDriver(stepLocalT),
        };
      }
      if (panel.id.startsWith('gussetExt')) {
        return {
          ...panel,
          // canonical hinge 方向下負角才由 x 內壁端部掃向 y 壁內側。
          angleFn: (stepLocalT) => {
            const angle = telescopeExtensionAngle(stepLocalT);
            return angle === 0 ? 0 : -angle;
          },
        };
      }
      return panel;
    }),
  };
}

function foldOnlyInactiveForPiece(
  result: GenerateResult,
  rootJog: number,
): {
  prepared: GenerateResult;
  inactive: FoldOnlyInactiveSegments;
} {
  const inactive = new Map<string, number[]>();
  const replacementSegments = new Map<string, Segment[]>();
  const syntheticTongueFolds: DielinePath[] = [];
  const syntheticTongueCaps: DielinePath[] = [];
  const syntheticGussetCuts: DielinePath[] = [];
  const syntheticRimCuts: DielinePath[] = [];
  const hasBPeriphery = result.paths.some(({ tags }) =>
    tags?.includes('bGussetPeriphery'));
  const hasAPeriphery = result.paths.some(({ tags }) =>
    tags?.includes('aGussetPeriphery'));
  if (!hasAPeriphery && !hasBPeriphery) {
    for (const path of result.paths.filter(({ tags, segments }) =>
      tags?.includes('wallTop')
      && segments.length === 2
      && segments.every((segment) => segment.kind === 'line'))) {
      const outer = path.segments[0] as Extract<Segment, { kind: 'line' }>;
      const inner = path.segments[1] as Extract<Segment, { kind: 'line' }>;
      const outerEndpoints = [
        point(outer.x1, outer.y1),
        point(outer.x2, outer.y2),
      ];
      const innerEndpoints = [
        point(inner.x1, inner.y1),
        point(inner.x2, inner.y2),
      ];
      for (const [index, start] of outerEndpoints.entries()) {
        const end = innerEndpoints
          .map((point) => ({
            point,
            distance: Math.hypot(point.x - start.x, point.y - start.y),
          }))
          .sort((a, b) => a.distance - b.distance)[0]!.point;
        syntheticRimCuts.push({
          id: `${path.id}::rim-boundary:${index}`,
          type: 'cut',
          tags: ['foldOnlyRimBoundary'],
          segments: [{
            kind: 'line',
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y,
          }],
        });
      }
    }
  }
  if (hasBPeriphery) {
    for (const path of result.paths.filter(({ tags, segments }) =>
      tags?.includes('gussetFold') && segments.length >= 3)) {
      const extensionHinge = path.segments[1];
      const side = path.tags?.find((tag) =>
        tag === 'right-back'
        || tag === 'right-front'
        || tag === 'left-back'
        || tag === 'left-front');
      const diagonal = result.paths.find((candidate) =>
        candidate.type === 'crease'
        && candidate.tags?.includes('gusset')
        && side !== undefined
        && candidate.tags.includes(side)
        && candidate.tags.some((tag) =>
          tag.startsWith('fold-boundary:closure:wingX')));
      const diagonalSegment = diagonal?.segments[0];
      if (extensionHinge?.kind !== 'line' || diagonalSegment?.kind !== 'line') {
        throw new Error(`Telescope P0 角落「${side ?? path.id}」缺少 extension 邊界`);
      }
      const roleChildren = (path.tags ?? []).flatMap((tag) => {
        const match = FOLD_ROLE_PATTERN.exec(tag);
        return match ? [match[2]!] : [];
      });
      const wingId = roleChildren.find((id) => id.startsWith('wingX'));
      const extensionId = roleChildren.find((id) => id.startsWith('gussetExt'));
      if (!wingId || !extensionId) {
        throw new Error(`Telescope P0 角落「${side ?? path.id}」缺少 wing/extension role`);
      }
      syntheticGussetCuts.push({
        id: `${path.id}::gusset-extension-boundary`,
        type: 'crease',
        tags: [`fold-boundary:closure:${wingId}>${extensionId}`],
        segments: [{
          kind: 'line',
          x1: extensionHinge.x1,
          y1: extensionHinge.y1,
          x2: diagonalSegment.x2,
          y2: diagonalSegment.y2,
        }],
      });
    }
  }
  const tongueRolePaths = new Map<string, DielinePath[]>();
  for (const path of result.paths) {
    const tongueRole = path.tags?.find((tag) =>
      FOLD_ROLE_PATTERN.test(tag) && tag.endsWith('-tongue'));
    if (!tongueRole) continue;
    const paths = tongueRolePaths.get(tongueRole) ?? [];
    paths.push(path);
    tongueRolePaths.set(tongueRole, paths);
  }
  const tonguePanelsBySide = {
    left: 'wallXNeg',
    right: 'wallXPos',
    front: 'wallYNeg',
    back: 'wallYPos',
  } as const;
  for (const tongueFlap of result.paths.filter(({ type, tags }) =>
    type === 'cut' && tags?.includes('tongueFlap'))) {
    const side = (Object.keys(tonguePanelsBySide) as Array<
      keyof typeof tonguePanelsBySide
    >).find((candidate) => tongueFlap.tags?.includes(candidate));
    if (!side) {
      throw new Error(`Telescope tongue flap「${tongueFlap.id}」缺少 side tag`);
    }
    const wallId = tonguePanelsBySide[side];
    const role = `fold:${wallId}-inner>${wallId}-tongue`;
    if (tongueRolePaths.has(role)) continue;
    const first = tongueFlap.segments[0];
    const last = tongueFlap.segments.at(-1);
    if (first?.kind !== 'line' || last?.kind !== 'line') {
      throw new Error(`Telescope tongue flap「${tongueFlap.id}」缺少直線端點`);
    }
    const fold: DielinePath = {
      id: `${tongueFlap.id}::fold-only-tongue-hinge`,
      type: 'crease',
      tags: [side, role, 'foldOnlyTongueHinge'],
      segments: [{
        kind: 'line',
        x1: first.x1,
        y1: first.y1,
        x2: last.x2,
        y2: last.y2,
      }],
    };
    syntheticTongueFolds.push(fold);
    tongueRolePaths.set(role, [fold]);
  }
  for (const paths of tongueRolePaths.values()) {
    const side = paths[0]!.tags?.find((tag) =>
      tag === 'left' || tag === 'right' || tag === 'front' || tag === 'back');
    const tongueFlap = result.paths.find((path) =>
      path.type === 'cut'
      && path.tags?.includes('tongueFlap')
      && side !== undefined
      && path.tags.includes(side));
    const firstFlapSegment = tongueFlap?.segments[0];
    const lastFlapSegment = tongueFlap?.segments.at(-1);
    const flapHingeEndpoints = firstFlapSegment?.kind === 'line'
      && lastFlapSegment?.kind === 'line'
      ? [
        point(firstFlapSegment.x1, firstFlapSegment.y1),
        point(lastFlapSegment.x2, lastFlapSegment.y2),
      ]
      : [];
    const semanticLineEndpoints = paths.flatMap(({ segments }) =>
      segments.flatMap((segment) => segment.kind === 'line'
        ? [
          point(segment.x1, segment.y1),
          point(segment.x2, segment.y2),
        ]
        : []));
    const lineEndpoints = flapHingeEndpoints.length === 2
      ? flapHingeEndpoints
      : semanticLineEndpoints;
    let first = lineEndpoints[0];
    let second = lineEndpoints[0];
    let maxDistance = -1;
    for (const a of lineEndpoints) {
      for (const b of lineEndpoints) {
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        if (distance > maxDistance) {
          first = a;
          second = b;
          maxDistance = distance;
        }
      }
    }
    if (!first || !second || maxDistance <= 0) {
      throw new Error('Telescope tongue fold 找不到有效直線範圍');
    }
    const carrier = paths.find(({ type }) => type === 'crease') ?? paths[0]!;
    replacementSegments.set(carrier.id, [{
      kind: 'line',
      x1: first.x,
      y1: first.y,
      x2: second.x,
      y2: second.y,
    }]);
    if (flapHingeEndpoints.length === 2 && (!hasBPeriphery && !hasAPeriphery)) {
      const wallSideEndpoints = result.paths
        .filter((path) =>
          path.tags?.includes('wallSide')
          && side !== undefined
          && path.tags.includes(side))
        .flatMap(({ segments }) => segments.flatMap((segment) =>
          segment.kind === 'line'
            ? [point(segment.x2, segment.y2)]
            : []));
      for (const [index, capEnd] of lineEndpoints.entries()) {
        const capStart = wallSideEndpoints
          .map((point) => ({
            point,
            distance: Math.hypot(point.x - capEnd.x, point.y - capEnd.y),
          }))
          .sort((a, b) => a.distance - b.distance)[0]?.point;
        if (
          capStart
          && Math.hypot(capEnd.x - capStart.x, capEnd.y - capStart.y) > 1e-7
        ) {
          syntheticTongueCaps.push({
            id: `${carrier.id}::tongue-cap:${index}`,
            type: 'cut',
            tags: ['foldOnlyTongueCap'],
            segments: [{
              kind: 'line',
              x1: capStart.x,
              y1: capStart.y,
              x2: capEnd.x,
              y2: capEnd.y,
            }],
          });
        }
      }
    }
    if (flapHingeEndpoints.length === 2 && (hasBPeriphery || hasAPeriphery)) {
      const useX = Math.abs(second.x - first.x) >= Math.abs(second.y - first.y);
      const semanticExtremes = [...semanticLineEndpoints]
        .sort((a, b) => {
          if (useX) return a.x - b.x;
          return a.y - b.y;
        })
        .filter((point, index, all) =>
          index === 0 || index === all.length - 1);
      for (const [index, capStart] of semanticExtremes.entries()) {
        const capEnd = lineEndpoints
          .map((point) => ({
            point,
            distance: Math.hypot(point.x - capStart.x, point.y - capStart.y),
          }))
          .sort((a, b) => a.distance - b.distance)[0]!.point;
        if (Math.hypot(capEnd.x - capStart.x, capEnd.y - capStart.y) > 1e-7) {
          syntheticTongueCaps.push({
            id: `${carrier.id}::tongue-cap:${index}`,
            type: 'cut',
            tags: ['foldOnlyTongueCap'],
            segments: [{
              kind: 'line',
              x1: capStart.x,
              y1: capStart.y,
              x2: capEnd.x,
              y2: capEnd.y,
            }],
          });
        }
      }
    }
    for (const path of paths) {
      if (path.id !== carrier.id) {
        inactive.set(path.id, path.segments.map((_, index) => index));
      }
    }
  }
  const wallSideLines = result.paths
    .filter(({ tags }) => tags?.includes('wallSide'))
    .flatMap(({ segments }) => segments.filter(
      (segment): segment is Extract<Segment, { kind: 'line' }> =>
        segment.kind === 'line',
    ));
  const bReliefEndpoints = result.paths
    .filter(({ tags }) =>
      tags?.includes('bGussetPeriphery') || tags?.includes('vRelief'))
    .flatMap(({ segments }) => segments.flatMap((segment) => {
      if (segment.kind === 'line') {
        return [
          point(segment.x1, segment.y1),
          point(segment.x2, segment.y2),
        ];
      }
      return [];
    }));
  const pointOnLineInterior = (
    candidate: Pt,
    segment: Extract<Segment, { kind: 'line' }>,
  ): boolean => {
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const lengthSquared = dx * dx + dy * dy;
    const ratio = ((candidate.x - segment.x1) * dx + (candidate.y - segment.y1) * dy)
      / lengthSquared;
    const cross = dx * (candidate.y - segment.y1) - dy * (candidate.x - segment.x1);
    return ratio > 1e-7
      && ratio < 1 - 1e-7
      && Math.abs(cross) / Math.sqrt(lengthSquared) < 1e-6;
  };

  const paths = result.paths.map((path): DielinePath => {
    const tongueReplacement = replacementSegments.get(path.id);
    if (tongueReplacement) {
      return {
        ...path,
        segments: tongueReplacement,
      };
    }
    if (
      hasBPeriphery
      && rootJog > 0
      && path.tags?.includes('gussetFold')
    ) {
      const pathTags = path.tags;
      const yHinge = path.segments.at(-1);
      const semanticTags = pathTags.filter((tag) =>
        FOLD_ROLE_PATTERN.test(tag));
      const yRole = semanticTags.at(-1);
      const match = yRole === undefined ? null : FOLD_ROLE_PATTERN.exec(yRole);
      const wingYId = match?.[2];
      if (
        yHinge?.kind !== 'line'
        || yRole === undefined
        || wingYId === undefined
        || !wingYId.startsWith('wingY')
      ) {
        throw new Error(`Telescope P0 gusset「${path.id}」缺少 y-web hinge`);
      }
      const length = Math.hypot(
        yHinge.x2 - yHinge.x1,
        yHinge.y2 - yHinge.y1,
      );
      const ratio = Math.min(rootJog / length, 1);
      const offsetX = yHinge.x1 + (yHinge.x2 - yHinge.x1) * ratio;
      const offsetY = yHinge.y1 + (yHinge.y2 - yHinge.y1) * ratio;
      const nonSemanticTags = pathTags.filter((tag) =>
        !FOLD_ROLE_PATTERN.test(tag));
      return {
        ...path,
        tags: [
          ...nonSemanticTags,
          ...semanticTags.slice(0, -1),
          `fold-boundary:closure:floor>${wingYId}`,
          yRole,
        ],
        segments: [
          ...path.segments.slice(0, -1).map((segment) => ({ ...segment })),
          {
            kind: 'line',
            x1: yHinge.x1,
            y1: yHinge.y1,
            x2: offsetX,
            y2: offsetY,
          },
          {
            kind: 'line',
            x1: offsetX,
            y1: offsetY,
            x2: yHinge.x2,
            y2: yHinge.y2,
          },
        ],
      };
    }
    if (
      bReliefEndpoints.length > 0
      && path.tags?.includes('wallSide')
    ) {
      const segments: Segment[] = [];
      const inactiveIndexes: number[] = [];
      for (const segment of path.segments) {
        if (segment.kind !== 'line') {
          segments.push({ ...segment });
          continue;
        }
        const split = bReliefEndpoints.find((point) =>
          pointOnLineInterior(point, segment));
        if (!split) {
          segments.push({ ...segment });
          continue;
        }
        segments.push(
          {
            ...segment,
            x2: split.x,
            y2: split.y,
          },
          {
            ...segment,
            x1: split.x,
            y1: split.y,
          },
        );
        inactiveIndexes.push(segments.length - 1);
      }
      if (inactiveIndexes.length > 0) inactive.set(path.id, inactiveIndexes);
      return { ...path, segments };
    }
    if (path.tags?.includes('aGussetPeriphery') && path.segments.length > 7) {
      inactive.set(path.id, [7]);
    }
    if (path.tags?.includes('uNotch')) {
      inactive.set(path.id, path.segments.map((_, index) => index));
    }
    if (path.tags?.includes('vRelief')) {
      const outsideBranches = path.segments.flatMap((segment, index) => {
        if (segment.kind !== 'line') return [index];
        const endpoints = [
          point(segment.x1, segment.y1),
          point(segment.x2, segment.y2),
        ];
        const joinsWallSide = endpoints.some((point) =>
          wallSideLines.some((wallSide) => pointOnLineInterior(point, wallSide)));
        return joinsWallSide ? [] : [index];
      });
      if (outsideBranches.length > 0) inactive.set(path.id, outsideBranches);
    }
    return {
      ...path,
      segments: path.segments.map((segment) => ({ ...segment })),
    };
  });
  return {
    prepared: {
      ...result,
      paths: [
        ...paths,
        ...syntheticTongueFolds,
        ...syntheticTongueCaps,
        ...syntheticGussetCuts,
        ...syntheticRimCuts,
      ],
    },
    inactive,
  };
}

function fullDielineGuide(result: GenerateResult): FoldModel['dieline'] {
  return result.paths.flatMap((path) =>
    path.type === 'cut' || path.type === 'crease'
      ? [{
        id: path.id,
        type: path.type,
        segments: path.segments.map((segment) => ({ ...segment })),
      }]
      : []);
}

function auxiliaryFaceAreaLimit(params: ResolvedParams, pieceId: string): number {
  if (pieceId === 'liner') return MIN_AUXILIARY_FACE_AREA_MM2;
  const heightKey = pieceId === 'base' ? 'baseHeight' : 'lidHeight';
  const wallHeight = params[heightKey];
  if (typeof wallHeight !== 'number') {
    throw new Error(`Telescope 缺少數值參數「${heightKey}」`);
  }
  // 被 relief 切出的非面板薄片最多按「一毫米寬 × 壁高」縮放；
  // 真正漏標的壁面面積遠大於此上限，仍會 fail-loud。
  return Math.max(
    MIN_AUXILIARY_FACE_AREA_MM2,
    wallHeight * AUXILIARY_FACE_WIDTH_MM,
  );
}

function buildPieceModel(
  params: ResolvedParams,
  pieceId: string,
  generated: GenerateResult,
): FoldModel {
  const piece = generated.pieces?.find(({ id }) => id === pieceId);
  if (!piece) throw new Error(`Telescope generate() 找不到 piece「${pieceId}」`);
  const scoped = pieceResult(generated, piece);
  const rootId = pieceId === 'liner' ? LINER_ROOT_ID : ROOT_ID;
  const rootJog = params.rootJog;
  if (typeof rootJog !== 'number') {
    throw new Error('Telescope 缺少數值參數「rootJog」');
  }
  const {
    prepared,
    inactive,
  } = foldOnlyInactiveForPiece(scoped, rootJog);
  const angles = panelAngles(prepared, rootId);
  const panelIds = angles.map(({ id }) => id);
  const model = panelizeFoldModel(
    prepared,
    rootId,
    angles,
    rootId === LINER_ROOT_ID
      ? linerSteps(panelIds)
      : traySteps(panelIds),
    ARC_TOLERANCE_MM,
    inactive,
    {
      roleFragmentToleranceMm: ROLE_FRAGMENT_TOLERANCE_MM,
      maxUnassignedFaceAreaMm2: auxiliaryFaceAreaLimit(params, pieceId),
      ignoreAmbiguousDanglingCuts: true,
    },
  );
  const scheduled = rootId === LINER_ROOT_ID
    ? model
    : withTrayAngleDrivers(model);
  return {
    ...scheduled,
    dieline: fullDielineGuide(scoped),
  };
}

const ASSEMBLY_CLEARANCE_MM = 20;

function quaternion(
  axisX: number,
  axisY: number,
  axisZ: number,
  scalar: number,
): Quaternion {
  const result = {} as Quaternion;
  result.x = axisX;
  result.y = axisY;
  result.z = axisZ;
  result.w = scalar;
  return result;
}

const IDENTITY_QUATERNION = quaternion(0, 0, 0, 1);
const X_FLIP_QUATERNION = quaternion(1, 0, 0, 0);

function position(
  horizontal: number,
  vertical: number,
  depth: number,
): SceneKeyframe['position'] {
  const result = {} as SceneKeyframe['position'];
  result.x = horizontal;
  result.y = vertical;
  result.z = depth;
  return result;
}

function numericParam(params: ResolvedParams, key: string): number {
  const value = params[key];
  if (typeof value !== 'number') {
    throw new Error(`Telescope 組裝軌缺少數值參數「${key}」`);
  }
  return value;
}

interface PieceCenter {
  horizontal: number;
  vertical: number;
}

function rootCenter(model: FoldModel, rootId: string): PieceCenter {
  const root = model.panels.find(({ id }) => id === rootId);
  if (!root) throw new Error(`Telescope 組裝軌缺少 root「${rootId}」`);
  const xs = root.polygon.map(({ x }) => x);
  const ys = root.polygon.map(({ y }) => y);
  return {
    horizontal: (Math.min(...xs) + Math.max(...xs)) / 2,
    vertical: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function keyframe(
  time: number,
  scenePosition: SceneKeyframe['position'],
  quaternion: Quaternion,
): SceneKeyframe {
  return {
    time,
    position: scenePosition,
    quaternion: { ...quaternion },
  };
}

function lidAssemblyTrack(
  times: typeof TELESCOPE_ASSEMBLY_WINDOWS.lid
    | typeof TELESCOPE_ASSEMBLY_WINDOWS.lidOff,
  sourceCenter: PieceCenter,
  targetCenter: PieceCenter,
  baseRim: number,
  lidHeight: number,
): SceneKeyframe[] {
  const lift = baseRim + lidHeight + ASSEMBLY_CLEARANCE_MM;
  const finalPosition = position(
    targetCenter.horizontal - sourceCenter.horizontal,
    // x 軸 180° 會把 absolute y 變成 -y，translation 需補回目標中心。
    targetCenter.vertical + sourceCenter.vertical,
    baseRim,
  );
  return [
    keyframe(times[0], position(0, 0, 0), IDENTITY_QUATERNION),
    keyframe(times[1], position(0, 0, lift), IDENTITY_QUATERNION),
    keyframe(
      times[2],
      position(0, 2 * sourceCenter.vertical, lift),
      X_FLIP_QUATERNION,
    ),
    keyframe(
      times[3],
      position(finalPosition.x, finalPosition.y, lift),
      X_FLIP_QUATERNION,
    ),
    keyframe(times[4], finalPosition, X_FLIP_QUATERNION),
  ];
}

function linerAssemblyTrack(
  sourceCenter: PieceCenter,
  targetCenter: PieceCenter,
  baseRim: number,
  linerDepth: number,
): SceneKeyframe[] {
  const lift = baseRim + linerDepth + ASSEMBLY_CLEARANCE_MM;
  const finalPosition = position(
    targetCenter.horizontal - sourceCenter.horizontal,
    targetCenter.vertical - sourceCenter.vertical,
    linerDepth,
  );
  const times = TELESCOPE_ASSEMBLY_WINDOWS.liner;
  return [
    keyframe(times[0], position(0, 0, 0), IDENTITY_QUATERNION),
    keyframe(times[1], position(0, 0, lift), IDENTITY_QUATERNION),
    keyframe(
      times[2],
      position(finalPosition.x, finalPosition.y, lift),
      IDENTITY_QUATERNION,
    ),
    keyframe(times[3], finalPosition, IDENTITY_QUATERNION),
  ];
}

function assemblyTracks(
  params: ResolvedParams,
  models: Map<string, FoldModel>,
  linerEnabled: boolean,
): Map<string, SceneKeyframe[]> {
  const baseModel = models.get('base');
  const lidModel = models.get('lid');
  if (!baseModel || !lidModel) {
    throw new Error('Telescope 組裝軌需要 base 與 lid model');
  }
  const baseCenter = rootCenter(baseModel, ROOT_ID);
  const lidCenter = rootCenter(lidModel, ROOT_ID);
  const baseHeight = numericParam(params, 'baseHeight');
  const platformWidth = numericParam(params, 'basePlatformWidth');
  const wallTopCompensation = numericParam(params, 'wallTopCompensation');
  const lidHeight = numericParam(params, 'lidHeight');
  const baseRim = Math.max(
    baseHeight,
    baseHeight - wallTopCompensation + platformWidth,
  );
  const lidTimes = linerEnabled
    ? TELESCOPE_ASSEMBLY_WINDOWS.lid
    : TELESCOPE_ASSEMBLY_WINDOWS.lidOff;
  const tracks = new Map<string, SceneKeyframe[]>([
    ['base', []],
    ['lid', lidAssemblyTrack(
      lidTimes,
      lidCenter,
      baseCenter,
      baseRim,
      lidHeight,
    )],
  ]);

  if (linerEnabled) {
    const linerModel = models.get('liner');
    if (!linerModel) throw new Error('Telescope liner on 態缺少 liner model');
    const linerCenter = rootCenter(linerModel, LINER_ROOT_ID);
    const linerDepth = numericParam(params, 'linerFlapDepth');
    tracks.set('liner', linerAssemblyTrack(
      linerCenter,
      baseCenter,
      baseRim,
      linerDepth,
    ));
  }
  return tracks;
}

export function buildTelescopeSceneSpec(params: ResolvedParams): FoldSceneSpec {
  const generated = telescope.generate(params);
  // 多條 error 同時觸發時以幾何主體不存在的原因先報，矩陣據此 fail-loud。
  for (const invariantId of [
    'tongue-flap-fits',
    'gusset-b-fits',
    'liner-flap-fits',
  ]) {
    const invariant = telescope.invariants.find(({ id }) => id === invariantId);
    const outcome = invariant?.check(params, generated);
    if (invariant && outcome && !outcome.ok) {
      throw new InvalidBoxParamsError(invariant.id, outcome.message.zh);
    }
  }
  assertBoxInvariants(telescope, params, generated);
  const pieces = generated.pieces;
  if (!pieces) {
    throw new Error('Telescope generate() 必須回傳 pieces');
  }
  const models = new Map(pieces.map((piece) => [
    piece.id,
    buildPieceModel(params, piece.id, generated),
  ]));
  const linerEnabled = params.linerEnabled !== false;
  const tracks = assemblyTracks(params, models, linerEnabled);
  return defineFoldSceneSpec({
    pieces: pieces.map((piece) => ({
      pieceId: piece.id,
      // SceneSpec 已由這份 params 綁定；同 params 呼叫重用同一批模型（避免每片再
      // generate）。契約=回傳「該 params」的模型：呼叫端帶不同 params 時重建，
      // 不得靜默回傳綁定 params 的 stale 模型。
      buildModel: (callParams: ResolvedParams) => {
        if (callParams && callParams !== params) {
          const rebuilt = buildTelescopeSceneSpec(callParams);
          const match = rebuilt.pieces.find(
            (candidate) => candidate.pieceId === piece.id,
          );
          if (!match) {
            throw new Error(`Telescope 重建後找不到 piece「${piece.id}」`);
          }
          return match.buildModel(callParams);
        }
        const model = models.get(piece.id);
        if (!model) {
          throw new Error(`Telescope generate() 找不到 piece「${piece.id}」`);
        }
        return model;
      },
      foldWindow: linerEnabled
        ? [...TELESCOPE_FOLD_WINDOWS[
          piece.id as keyof typeof TELESCOPE_FOLD_WINDOWS
        ]]
        : [...TELESCOPE_FOLD_WINDOWS_OFF[
          piece.id as keyof typeof TELESCOPE_FOLD_WINDOWS_OFF
        ]],
      assemblyTrack: tracks.get(piece.id) ?? [],
    })),
  });
}
