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

/**
 * per-piece 段序＝生產摺序（刀模編號 1→5），兩軸壁錯階而非同窗：
 * 1 prefoldX 左右內壁反摺 → 2 raiseX 左右壁立起（角撐隨之對摺貼平長壁）
 * → 3 interlock 角翼繞角互卡（P+）／extWrap 角撐延伸段包上相鄰 y 壁（P0）
 * → 4 raiseY 前後壁立起 90°（角撐同時被收上短邊壁·刀模標號「1」的三個箭頭）
 * → 5 closeY 前後內壁反摺 180° 蓋住角撐、舌片反向 90° 卡進盒內（標號「2」「3」）。
 *
 * ⚠ 短邊壁**不做預摺**（v15.3·對照生產刀模）：舌片是往盒內卡的，壁還躺著時
 * 這個動作沒有物理意義；且角撐必須先落到 y 外壁上、內壁才蓋下來，才形成
 * 「角撐被雙層壁夾住」的結構。長邊壁維持預摺後立起（構造不同·不動）。
 */
export const TELESCOPE_TRAY_WINDOWS = {
  flapped: {
    prefoldX: [0, 0.16],
    raiseX: [0.16, 0.44],
    interlock: [0.44, 0.62],
    raiseY: [0.62, 0.84],
    closeY: [0.84, 1],
  },
  plain: {
    prefoldX: [0, 0.18],
    raiseX: [0.18, 0.48],
    extWrap: [0.48, 0.64],
    raiseY: [0.64, 0.84],
    closeY: [0.84, 1],
  },
} as const;

/**
 * 互卡拍內的兩個子窗（§4.6 v15.2）：同一面 y 壁的左右兩翼**不得同窗**。
 *
 * 鉤式互扣在實體上是依序的——先摺一片，再讓另一片的鉤滑過它。v14 的
 * 「四翼同窗鏡像同時內擺」在零厚度剛體下必然互穿（實測沿壁重疊拍末 30.996mm、
 * G1 深度峰值 10.644358mm）。依 x 號分批：`flapNeg*` 先、`flapPos*` 後。
 */
export function telescopeInterlockSubWindows(): {
  first: readonly [number, number];
  second: readonly [number, number];
} {
  const [start, end] = TELESCOPE_TRAY_WINDOWS.flapped.interlock;
  const middle = (start + end) / 2;
  return { first: [start, middle], second: [middle, end] };
}

function intervalProgress(value: number, start: number, end: number): number {
  if (value <= start) return 0;
  if (value >= end) return 1;
  return (value - start) / (end - start);
}

const clampUnit = (value: number): number => Math.min(1, Math.max(-1, value));

/**
 * 錯階摺疊的角撐閉式解（rootJog=0 理想角落·與盒尺寸無關）。
 *
 * 第一段（左右壁 φx 由 0 轉到 90°，前後壁平躺）：ψx = 0、ψy = φx
 *   ——x 翼隨長壁立起維持共面，y 翼繞自身鉸同步轉起，角撐沿 45° 對角對摺貼平長壁。
 * 第二段（前後壁 φy 由 0 轉到 90°，左右壁鎖 90°）：
 *   sin ψy = cos φy/(1 + sin φy)、cos ψx = cos φy − sin ψy·sin φy
 *   ——角撐由長壁面被掃起、終態貼上短邊壁（生產摺序 5「包覆角撐」）。
 *   等價形式 (1−sin φy)/cos φy 在 φy=90° 為 0/0，禁用；上式全域數值穩定。
 *
 * 該方程組有兩支解（角撐往盒內／往盒外折），在 φy=0 處重合＝分岔點；
 * **取往盒內支**（ψy = π − arcsin(...)、ψx = +arccos(...)），否則終態四角
 * 外突於盒體包絡 50.58mm（縫仍閉合＝縫閘門看不到·需包絡判準才唯一定解）。
 *
 * 兩段在 (φx=90°, φy=0) 交界處連續（ψx=0、ψy=90°）。
 */
export function telescopeStaggeredWingAngles(
  stage: 'raiseX' | 'raiseY',
  phi: number,
): { psiX: number; psiY: number } {
  if (stage === 'raiseX') return { psiX: 0, psiY: phi };
  // 盒內支最簡式：ψx = arccos(cos φy/(1+sin φy))、ψy = ψx + 90°。
  // 由 arccos(s) = π/2 − arcsin(s) 可得 ψx + π/2 ≡ π − arcsin(s)，與兩式版逐位元同。
  const psiX = Math.acos(clampUnit(Math.cos(phi) / (1 + Math.sin(phi))));
  return { psiX, psiY: psiX + QUARTER_TURN };
}

/**
 * raiseY 拍的前後壁二面角排程（Spec §4.4A v15.1 平方根奇點條款）。
 *
 * 閉式在小角極限為 ψx ≈ √(2·φy)，故 `dψx/dφy` 在 φy→0 無界（實測 φy=0.01°
 * 時 53.5 度/度）。φy 若對拍內進度線性排程，角撐在 raiseY 拍首的角速度隨之
 * 無界——production 400 取樣實測 base 43.1753、lid 45.2694 °/0.01t，G3 必紅。
 * 取 φy = 90°·u² 讓拍首導數為零，ψx 隨 u 近似線性。
 *
 * **前後壁與角撐必須共用本函式**：閉式吃的是 y 壁的實際二面角，兩邊排程若
 * 不一致，角撐就相對於壁轉錯量。⚠ 此脫鉤**不會被縫閘門抓到**（實測對角縫
 * 仍為健康值 √2·rootJog），終態也仍然閉合——錯的只有中段軌跡。守門的是
 * `telescope-angle-driver` 的耦合斷言：由 pose 直讀壁角、再驗角撐是其函數。
 */
export function telescopeRaiseYWallAngle(beatProgress: number): number {
  const u = Math.min(1, Math.max(0, beatProgress));
  return QUARTER_TURN * u * u;
}

/**
 * 單一 panel driver 覆蓋兩個立壁段與其間的靜止段。
 * stepLocalT 為「wing step（raiseX 起 → raiseY 迄）」的局部進度。
 */
export function createTelescopeWingAngleFn(
  axis: 'X' | 'Y',
  raiseXEnd: number,
  raiseYStart: number,
): (stepLocalT: number) => number {
  if (!(raiseXEnd > 0 && raiseXEnd <= raiseYStart && raiseYStart < 1)) {
    throw new Error('Telescope wing 段界必須依 raiseX → hold → raiseY 嚴格排序');
  }
  return (stepLocalT) => {
    if (stepLocalT <= raiseXEnd) {
      const phiX = QUARTER_TURN * intervalProgress(stepLocalT, 0, raiseXEnd);
      const { psiX, psiY } = telescopeStaggeredWingAngles('raiseX', phiX);
      return axis === 'X' ? psiX : psiY;
    }
    if (stepLocalT <= raiseYStart) {
      // 角翼互卡／內壁反摺期間，角撐保持第一段終態（貼平長壁）。
      return axis === 'X' ? 0 : QUARTER_TURN;
    }
    const phiY = telescopeRaiseYWallAngle(
      intervalProgress(stepLocalT, raiseYStart, 1),
    );
    const { psiX, psiY } = telescopeStaggeredWingAngles('raiseY', phiY);
    return axis === 'X' ? psiX : psiY;
  };
}

/**
 * 上蓋落座時，**真正壓在下盒壁頂上的那個面**距其底板平面多深。
 *
 * 落座高度由「上蓋在下盒壁頂正上方的**最低**面」決定，而那不一定是底板：
 * 內壁自壁頂反摺後短了一個 `innerWallReduction`，其末端連同舌片形成一圈
 * **朝盒內的唇邊**，就懸在底板下方 `innerWallReduction` 處、正好蓋在下盒壁頂上。
 * 原式只算 `thickness`（把底板內面當接觸面），使唇邊比下盒壁頂低
 * `innerWallReduction − thickness`（預設 0.5mm）而切進下盒內壁——症狀是必須把
 * `lidMarginY` 撐到 15mm 才能讓唇邊水平躲開，看起來像「長向放大量有硬底限」，
 * 其實是落座高度算錯。實測：唇邊落差恆等於 `innerWallReduction`（0.8→0.800、
 * 1.2→1.200），且與紙厚無關。
 */
export function telescopeLidSeatDrop(
  thickness: number,
  innerWallReduction: number,
): number {
  return Math.max(thickness, innerWallReduction);
}

/**
 * 上蓋落座的三個高度基準（Spec §4.7）。零厚度模型只有一個 panel 平面，
 * 但物理上有三個面，AC-T4b（接觸）與 AC-T8a（外高）量的不是同一個。
 *
 * 約定：**上蓋底板的 panel 平面代表其外表面**，材料向盒內佔一個紙厚。
 *
 * - `seatPlane`      assemblyTrack 落座的 panel 平面（nominal）
 *                    ＝ baseRim + {@link telescopeLidSeatDrop} + {@link TELESCOPE_SEAT_GAP_MM}
 * - `floorInner`     上蓋底板內面 ＝ seatPlane − thickness
 * - `contactPlane`   **真正壓在下盒壁頂上的面** ＝ seatPlane − seatDrop
 *                    （v15.7：內壁唇邊比底板低 innerWallReduction，通常它才是接觸面；
 *                    AC-T4b 量的是這個，不是 floorInner）
 * - `closedOuterTop` 閉合盒外頂面 ＝ seatPlane
 *
 * 消費端**必須**經由本函式取面，不得自行從 assemblyTrack 落座 z 反推面別
 * （原缺陷即 oracle 直讀落座 z 當作接觸面）。
 */
export function telescopeLidPlanes(
  seatPlane: number,
  thickness: number,
  innerWallReduction = 0,
): {
  seatPlane: number;
  floorInner: number;
  contactPlane: number;
  closedOuterTop: number;
} {
  return {
    seatPlane,
    floorInner: seatPlane - thickness,
    contactPlane: seatPlane - telescopeLidSeatDrop(thickness, innerWallReduction),
    closedOuterTop: seatPlane,
  };
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
      // 壁頂平台，**四面同構**（v15.4）：刀模四面各有兩條 rim crease
      // （`fold:wall*-outer>wall*-rim` 與 `fold:wall*-rim>wall*-inner`·皆 type=crease），
      // 段寬同為 platformWidth。原碼長邊壁給 0°＝當平台不存在，使長邊壁比短邊壁
      // 高出一個 platformWidth（實測 pw=5 時 64.50 vs 60.00），角翼隨父鏈浮出盒口。
      foldAngle = QUARTER_TURN;
    } else if (/^wall[XY](?:Neg|Pos)-inner$/.test(id)) {
      // 有平台時內壁只需再轉 90° 即垂下；無平台時是壁頂 180° 對摺。
      const rimId = id.replace(/-inner$/, '-rim');
      foldAngle = panelIdSet.has(rimId) ? QUARTER_TURN : Math.PI;
    } else if (/^wall[XY](?:Neg|Pos)-tongue$/.test(id)) {
      // 短邊壁舌片往**反方向** 90°：由內壁下緣橫出、卡進盒內（刀模標號「3」）。
      // 長邊壁維持 180° 貼回內壁（構造不同·帶插片且被角撐包覆·不動）。
      foldAngle = id.startsWith('wallY') ? -QUARTER_TURN : Math.PI;
    } else if (id.startsWith('wingX')) {
      // 錯階摺序終態＝角撐被短邊壁收走（生產摺序 5）；非舊「壓貼長壁」的 180°/90°。
      foldAngle = QUARTER_TURN;
    } else if (id.startsWith('wingY')) {
      foldAngle = Math.PI;
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
    step(matching(/^wallX(?:Neg|Pos)-outer$/), windows.raiseX),
    // 短邊壁：先立壁（角撐同拍被收上來），內壁與舌片在其後才動。
    step(matching(/^wallY(?:Neg|Pos)-outer$/), windows.raiseY),
    step(
      matching(/^wallY(?:Neg|Pos)-(?:rim|inner|tongue)$/),
      windows.closeY,
    ),
    step(
      matching(/^wing[XY]/),
      [windows.raiseX[0], windows.raiseY[1]],
    ),
    // 同壁左右翼錯開先後（§4.6 v15.2）——四翼仍在同一拍內完成。
    hasFlaps
      ? step(matching(/^flapNeg/), telescopeInterlockSubWindows().first)
      : step(matching(/^gussetExt/), TELESCOPE_TRAY_WINDOWS.plain.extWrap),
    hasFlaps
      ? step(matching(/^flapPos/), telescopeInterlockSubWindows().second)
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
  // wing step 橫跨 raiseX → hold → raiseY；換算兩個段界在該 step 的局部座標。
  const wingSpan = windows.raiseY[1] - windows.raiseX[0];
  const raiseXEnd = (windows.raiseX[1] - windows.raiseX[0]) / wingSpan;
  const raiseYStart = (windows.raiseY[0] - windows.raiseX[0]) / wingSpan;

  return {
    ...model,
    panels: model.panels.map((panel) => {
      if (panel.id.startsWith('wingX')) {
        return {
          ...panel,
          angleFn: createTelescopeWingAngleFn('X', raiseXEnd, raiseYStart),
        };
      }
      if (panel.id.startsWith('wingY')) {
        return {
          ...panel,
          angleFn: createTelescopeWingAngleFn('Y', raiseXEnd, raiseYStart),
        };
      }
      // 前後壁與角撐共用 raiseY 排程（§4.4A 奇點條款）；該 step 的局部進度
      // 就是拍內進度，不需換算。
      if (/^wallY(?:Neg|Pos)-outer$/.test(panel.id)) {
        return { ...panel, angleFn: telescopeRaiseYWallAngle };
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

/**
 * 上蓋落座間隙（v15.6）。
 *
 * 實體上上蓋底板內面就是**壓在**下盒壁頂上、兩面接觸；但零厚度渲染裡「完全同高」
 * 對深度測試是無解的平手局——兩者同為 z=60.000 時俯視實測有 610px 下盒像素穿出
 * 上蓋（null-control=0·全部落在上蓋剪影內·成因分離：戳穿 0 片／深度精度
 * 0 片／精確共面 6 片）。
 *
 * 與 `fold-scene.ts` 的 `SURFACE_GAP_MM` **同值同語義**（「兩個接觸的實體面不得
 * 保持共面」），差別只在作用範圍：那個管片內疊層，這個管片與片之間。
 * 兩者刻意不互相 import——渲染層不該被幾何層依賴，數值一致由 AC-T4b 的具名
 * 期望值（`lidFloorInner − baseRim = TELESCOPE_SEAT_GAP_MM`）綁住。
 */
export const TELESCOPE_SEAT_GAP_MM = 0.05;

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
  thickness: number,
  innerWallReduction: number,
): SceneKeyframe[] {
  const lift = baseRim + lidHeight + ASSEMBLY_CLEARANCE_MM;
  const finalPosition = position(
    targetCenter.horizontal - sourceCenter.horizontal,
    // x 軸 180° 會把 absolute y 變成 -y，translation 需補回目標中心。
    targetCenter.vertical + sourceCenter.vertical,
    baseRim + telescopeLidSeatDrop(thickness, innerWallReduction)
      + TELESCOPE_SEAT_GAP_MM,
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
  // 下盒壁頂＝baseHeight。原碼另取 `baseHeight − wallTopCompensation + platformWidth`
  // 的較大者（預設 64.5）＝**遷就 rim 摺角 bug 造成的長邊壁凸出**（v15.4 已修源頭）；
  // 該補償項連帶把上蓋抬高一個 platformWidth，AC-T4b 卻因兩邊同錯而恆綠。
  const baseRim = baseHeight;
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
      numericParam(params, 'thickness'),
      numericParam(params, 'innerWallReduction'),
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
  const linerEnabled = params.linerEnabled === true;
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
