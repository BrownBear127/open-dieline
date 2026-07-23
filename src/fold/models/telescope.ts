import { telescope } from '../../boxes/telescope';
import type { Segment } from '../../core/geometry';
import type {
  DielinePath,
  DielinePiece,
  GenerateResult,
  ResolvedParams,
} from '../../core/types';
import {
  panelizeFoldModel,
  type FoldOnlyInactiveSegments,
  type PanelAngleSpec,
} from '../derive/panelize';
import {
  defineFoldSceneSpec,
  type FoldSceneSpec,
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
const TRAY_FOLD_ANGLE = -Math.PI / 2;
const LINER_FOLD_ANGLE = Math.PI / 2;
const ROLE_FRAGMENT_TOLERANCE_MM = 30;
const MIN_AUXILIARY_FACE_AREA_MM2 = 50;
const AUXILIARY_FACE_WIDTH_MM = 1;

const AXIS_SIGNS = ['XNeg', 'XPos', 'YNeg', 'YPos'] as const;
const CORNERS = ['NegNeg', 'NegPos', 'PosNeg', 'PosPos'] as const;

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
  const childAngle = rootId === LINER_ROOT_ID
    ? LINER_FOLD_ANGLE
    : TRAY_FOLD_ANGLE;
  return panelIdsFromRoles(result, rootId).map((id) => ({
    id,
    foldAngle: id === rootId ? 0 : childAngle,
  }));
}

function placeholderSteps(angles: PanelAngleSpec[], rootId: string): FoldStep[] {
  const panelIds = angles
    .map(({ id }) => id)
    .filter((id) => id !== rootId);
  return panelIds.length === 0
    ? []
    : [{ panelIds, t0: 0, t1: 1, ease: 'linear' }];
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

function buildPieceModel(params: ResolvedParams, pieceId: string): FoldModel {
  const generated = telescope.generate(params);
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
  const model = panelizeFoldModel(
    prepared,
    rootId,
    angles,
    placeholderSteps(angles, rootId),
    ARC_TOLERANCE_MM,
    inactive,
    {
      roleFragmentToleranceMm: ROLE_FRAGMENT_TOLERANCE_MM,
      maxUnassignedFaceAreaMm2: auxiliaryFaceAreaLimit(params, pieceId),
      ignoreAmbiguousDanglingCuts: true,
    },
  );
  return {
    ...model,
    dieline: fullDielineGuide(scoped),
  };
}

export function buildTelescopeSceneSpec(params: ResolvedParams): FoldSceneSpec {
  const generated = telescope.generate(params);
  if (!generated.pieces) {
    throw new Error('Telescope generate() 必須回傳 pieces');
  }
  return defineFoldSceneSpec({
    pieces: generated.pieces.map((piece) => ({
      pieceId: piece.id,
      buildModel: (buildParams) => buildPieceModel(buildParams, piece.id),
      foldWindow: [0, 1],
      assemblyTrack: [],
    })),
  });
}
