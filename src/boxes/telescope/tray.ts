/**
 * 天地盒雙壁 tray 幾何——上蓋／下盒共用的單片幾何 helper（Slice 2 Task 3）。
 *
 * 只產生「一個 tray」的幾何（四壁＋四角撐）；上蓋/下盒的組裝（呼叫本函式兩次＋內襯）
 * 是 T4 的事（`boxes/telescope/index.ts`，尚未建立）。座標單位一律 mm。
 * 純 TS 模組，不 import React 或任何 UI。
 *
 * 幾何 ground truth：天地盒生產刀模量測（見
 * `.superpowers/sdd/slice2-appendix.md`、coding-workspace 任務夾「天地盒量測表.md」）。
 * 生產絕對座標只用來理解與校準比例常數，不進本檔——本檔只留參數化公式與具名常數
 * （見下方 GUSSET_* 常數的校準來源註解）。
 */

import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import type { DielinePath, DielineText, LineType } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數
// ─────────────────────────────────────────────────────────────────────────

/** 插底舌全深（中段），固定常數（量測表：兩片皆 15.0mm，非 t 相關）。 */
const TUCK_FLAP_DEPTH = 15;

/** 插底舌兩端淺深——量測表「7.5+7.5 梯形」＝全深的一半，非獨立常數。 */
const TUCK_FLAP_SHALLOW_DEPTH = TUCK_FLAP_DEPTH / 2;

/**
 * 舌摺線兩端讓位角撐的 crease 長度（halfcut 只在中段）。brief 原文用語「~9mm」，
 * 量測值 9.4mm（B 片：全長 197.2 vs 面板內圍 216，每端縮 9.4）——沒有第二筆資料點可
 * 反推與其他參數的線性關係，故取 brief 自己的近似值為固定具名常數（非 t 的函式；
 * 這是角撐讓位的結構淨空，不是紙厚補償）。
 */
const TONGUE_END_RECESS = 9;

/**
 * 厚壁角撐（style A）45° 斜線半段長 ÷ 壁高：校準點＝附錄 A 片座標反推
 * corner→mid（cut）長度 25.2906mm，H=60 → 25.2906/60 ≈ 0.42151。
 * 只有一組校準資料，無法反推「跟 platformWidth 的關係」——比例常數只綁 height，
 * 與 brief 措辭「由壁高推導」一致；T5 具名槽位對帳會驗證最終殘差。
 */
const GUSSET_A_DIAG_HALF_RATIO = 25.2906 / 60;

/**
 * 厚壁角撐（style A）兩軸對稱共用的「reach」＝該 tray 的 x 向外壁長（height−thickness）。
 * 非獨立常數：附錄座標實測 V3/V4 offset 精確相等（59.4994mm，見 task-3-report.md 計算
 * 記錄），證實角撐用同一個 reach 值對稱套用在兩軸，而非個別方向壁高各自推算
 * （y 向外壁 60.0mm 略高於 x 向 59.5mm，角撐仍統一用 x 向值）。
 */

/**
 * 薄壁角撐（style B）45° crease 長 ÷ 壁高：校準點＝附錄 B 片座標反推
 * corner→p1 長度 26.2922mm，H=45 → 26.2922/45 ≈ 0.58427。
 */
const GUSSET_B_CREASE_RATIO = 26.2922 / 45;

/** 薄壁角撐讓位弧半徑，brief 明列固定值（非比例）。 */
const GUSSET_B_RELIEF_RADIUS = 5.0;

/** 薄壁角撐頂小弧半徑，brief 明列固定值（bezier 反解近似值，非比例）。 */
const GUSSET_B_TIP_RADIUS = 1.5;

// ─────────────────────────────────────────────────────────────────────────
// 內部型別
// ─────────────────────────────────────────────────────────────────────────

type Axis = 'x' | 'y';
type Sign = 1 | -1;
type Point = { x: number; y: number };

/** 尚未指定 id 的路徑描述——generateTray 統一在最後指派 id 並套用 offsetX/offsetY 平移。 */
interface PathDescriptor {
  type: LineType;
  tags: string[];
  segments: Segment[];
}

export interface TrayOpts {
  panelL: number;
  panelW: number;
  height: number;
  platformWidth: number;
  thickness: number;
  idPrefix: string;
  offsetX: number;
  offsetY: number;
}

// ─────────────────────────────────────────────────────────────────────────
// 座標系工具
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把「沿牆延伸方向（along）／垂直方向（perp）」這組局部座標映射成 (x,y)。
 * x-axis 牆（左右，先摺）：along＝x、perp＝y。y-axis 牆（前後，後摺）：along＝y、perp＝x。
 * 這個映射讓四面牆共用同一套斷面計算函式，不必分別手刻 x/y 兩份幾何。
 */
function toXY(axis: Axis, along: number, perp: number): Point {
  return axis === 'x' ? { x: along, y: perp } : { x: perp, y: along };
}

/** 平移一組 Segment（座標系統一，供 offsetX/offsetY 版面位移使用；immutable，回傳新物件）。 */
function translateSegments(segs: Segment[], dx: number, dy: number): Segment[] {
  return segs.map((s) => {
    if (s.kind === 'line') {
      return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy };
    }
    if (s.kind === 'arc') {
      return { ...s, cx: s.cx + dx, cy: s.cy + dy };
    }
    return {
      ...s,
      x1: s.x1 + dx,
      y1: s.y1 + dy,
      c1x: s.c1x + dx,
      c1y: s.c1y + dy,
      c2x: s.c2x + dx,
      c2y: s.c2y + dy,
      x2: s.x2 + dx,
      y2: s.y2 + dy,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 單側牆斷面幾何計算
// ─────────────────────────────────────────────────────────────────────────

/** 單側牆斷面各分界的 along 座標（局部，未含 offsetX/offsetY）。 */
interface WallGeom {
  rootAlong: number;
  outerStartAlong: number; // 雙 crease 外線（x 向牆＝rootAlong，無雙線）
  topStartAlong: number;
  topEndAlong: number; // platformWidth=0 時與 topStartAlong 相同
  tongueFoldAlong: number;
  innerLen: number;
}

function computeWallGeom(
  sign: Sign,
  alongHalfSpan: number,
  outerLen: number,
  hasDoubleRoot: boolean,
  thickness: number,
  platformWidth: number,
): WallGeom {
  const innerLen = outerLen - 2 * thickness;
  const rootAlong = sign * alongHalfSpan;
  // 雙 crease 間距＝thickness；t=0 時 doubleGap=0 → outerStartAlong 與 rootAlong 重合，
  // buildWallRoot 只畫一條線（collapse 語意見該函式）。
  const doubleGap = hasDoubleRoot ? thickness : 0;
  const outerStartAlong = rootAlong + sign * doubleGap;
  const topStartAlong = outerStartAlong + sign * outerLen;
  const topEndAlong = topStartAlong + sign * platformWidth;
  const tongueFoldAlong = topEndAlong + sign * innerLen;
  return { rootAlong, outerStartAlong, topStartAlong, topEndAlong, tongueFoldAlong, innerLen };
}

/** 壁根摺線：x 向牆單 crease；y 向牆雙 crease（t=0 collapse 為單線，不得輸出兩條重合線）。 */
function buildWallRoot(axis: Axis, geom: WallGeom, perpHalf: number, hasDoubleRoot: boolean, thickness: number, side: string): PathDescriptor {
  const p1 = toXY(axis, geom.rootAlong, -perpHalf);
  const p2 = toXY(axis, geom.rootAlong, perpHalf);
  const b = new PathBuilder().moveTo(p1.x, p1.y).lineTo(p2.x, p2.y);
  if (hasDoubleRoot && thickness > 0) {
    const q1 = toXY(axis, geom.outerStartAlong, -perpHalf);
    const q2 = toXY(axis, geom.outerStartAlong, perpHalf);
    b.moveTo(q1.x, q1.y).lineTo(q2.x, q2.y);
  }
  return { type: 'crease', tags: ['wallRoot', side], segments: b.segments() };
}

/**
 * 牆的兩條長邊 cut（root 到舌摺線，滿版 perp 寬）——外壁／平台／內壁三段共線，
 * 用一條連續 cut 涵蓋即可，不必依外壁/平台/內壁分三段畫（cut 本身不在乎中間穿過幾條
 * 垂直 crease）。
 */
function buildWallSideCuts(axis: Axis, geom: WallGeom, perpHalf: number, side: string): PathDescriptor {
  const a1 = toXY(axis, geom.rootAlong, -perpHalf);
  const a2 = toXY(axis, geom.tongueFoldAlong, -perpHalf);
  const b1 = toXY(axis, geom.rootAlong, perpHalf);
  const b2 = toXY(axis, geom.tongueFoldAlong, perpHalf);
  const b = new PathBuilder().moveTo(a1.x, a1.y).lineTo(a2.x, a2.y).moveTo(b1.x, b1.y).lineTo(b2.x, b2.y);
  return { type: 'cut', tags: ['wallSide', side], segments: b.segments() };
}

/** 壁頂：platform>0 兩條 crease（相距 platformWidth）；platform=0 單 crease（反折）。 */
function buildWallTop(axis: Axis, geom: WallGeom, perpHalf: number, platformWidth: number, side: string): PathDescriptor {
  const s1 = toXY(axis, geom.topStartAlong, -perpHalf);
  const e1 = toXY(axis, geom.topStartAlong, perpHalf);
  const b = new PathBuilder().moveTo(s1.x, s1.y).lineTo(e1.x, e1.y);
  if (platformWidth > 0) {
    const s2 = toXY(axis, geom.topEndAlong, -perpHalf);
    const e2 = toXY(axis, geom.topEndAlong, perpHalf);
    b.moveTo(s2.x, s2.y).lineTo(e2.x, e2.y);
  }
  return { type: 'crease', tags: ['wallTop', side], segments: b.segments() };
}

/**
 * 舌摺線：中段 halfcut＋兩端各 TONGUE_END_RECESS 長的 crease（讓位角撐，見量測表
 * 「舌片兩端讓位」）。recess 對過窄的牆做防禦性鉗制（避免 perp 區間反轉）。
 */
function buildTongueFold(axis: Axis, geom: WallGeom, perpHalf: number, side: string): PathDescriptor[] {
  const recess = Math.min(TONGUE_END_RECESS, perpHalf);
  const along = geom.tongueFoldAlong;
  const pA = toXY(axis, along, -perpHalf);
  const pB = toXY(axis, along, -perpHalf + recess);
  const pC = toXY(axis, along, perpHalf - recess);
  const pD = toXY(axis, along, perpHalf);
  const crease = new PathBuilder()
    .moveTo(pA.x, pA.y)
    .lineTo(pB.x, pB.y)
    .moveTo(pC.x, pC.y)
    .lineTo(pD.x, pD.y)
    .segments();
  const halfcut = new PathBuilder().moveTo(pB.x, pB.y).lineTo(pC.x, pC.y).segments();
  return [
    { type: 'crease', tags: ['tongueFold', side], segments: crease },
    { type: 'halfcut', tags: ['tongueFold', side], segments: halfcut },
  ];
}

/**
 * 插底舌梯形 cut：兩端深 TUCK_FLAP_SHALLOW_DEPTH、中段全深 TUCK_FLAP_DEPTH、45° 過渡。
 * 過渡跨度＝TUCK_FLAP_SHALLOW_DEPTH（因全深＝2×淺深，45° 表示 perp 跨度＝along 跨度，
 * 兩者剛好相等，見 task-3-report.md 常數關係推導）。
 */
function buildTongueFlap(axis: Axis, sign: Sign, geom: WallGeom, perpHalf: number, side: string): PathDescriptor {
  const recess = Math.min(TONGUE_END_RECESS, perpHalf);
  const along0 = geom.tongueFoldAlong;
  const alongShallow = along0 + sign * TUCK_FLAP_SHALLOW_DEPTH;
  const alongFull = along0 + sign * TUCK_FLAP_DEPTH;
  const perpA = -perpHalf + recess;
  const perpB = perpA + TUCK_FLAP_SHALLOW_DEPTH;
  const perpD = perpHalf - recess;
  const perpC = perpD - TUCK_FLAP_SHALLOW_DEPTH;

  const p1 = toXY(axis, along0, perpA);
  const p2 = toXY(axis, alongShallow, perpA);
  const p3 = toXY(axis, alongFull, perpB);
  const p4 = toXY(axis, alongFull, perpC);
  const p5 = toXY(axis, alongShallow, perpD);
  const p6 = toXY(axis, along0, perpD);
  const segments = new PathBuilder()
    .moveTo(p1.x, p1.y)
    .lineTo(p2.x, p2.y)
    .lineTo(p3.x, p3.y)
    .lineTo(p4.x, p4.y)
    .lineTo(p5.x, p5.y)
    .lineTo(p6.x, p6.y)
    .segments();
  return { type: 'cut', tags: ['tongueFlap', side], segments };
}

/** 組裝單一側牆的完整斷面（root→側邊 cut→壁頂→舌摺線→插底舌）。 */
function buildWall(
  axis: Axis,
  sign: Sign,
  side: string,
  alongHalfSpan: number,
  perpHalfSpan: number,
  outerLen: number,
  hasDoubleRoot: boolean,
  thickness: number,
  platformWidth: number,
): PathDescriptor[] {
  const geom = computeWallGeom(sign, alongHalfSpan, outerLen, hasDoubleRoot, thickness, platformWidth);
  return [
    buildWallRoot(axis, geom, perpHalfSpan, hasDoubleRoot, thickness, side),
    buildWallSideCuts(axis, geom, perpHalfSpan, side),
    buildWallTop(axis, geom, perpHalfSpan, platformWidth, side),
    ...buildTongueFold(axis, geom, perpHalfSpan, side),
    buildTongueFlap(axis, sign, geom, perpHalfSpan, side),
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// 角撐（corner gusset）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 厚壁角撐（style A，45° 斜角撐）：面板角沿 45° 斜線出（cut 半段＋crease 半段連續，
 * 各長 GUSSET_A_DIAG_HALF_RATIO×height）到 tip，再由 tip 分別以直線 cut 接回兩軸上、
 * 距角落 reach（＝x 向外壁長 height−t，兩軸對稱共用同一值）的 V3／V4——外緣斜切。
 * 這條 45° 對角線把整個風箏形分成兩個三角形，讓角撐能沿對角摺起貼合盒角。
 * 復刻自附錄 A 片座標（角落/中點/tip/V3/V4 五點結構逐一驗證，見 task-3-report.md）。
 */
function buildGussetA(cornerX: number, cornerY: number, sx: Sign, sy: Sign, height: number, thickness: number, side: string): PathDescriptor[] {
  const reach = height - thickness;
  const diagHalf = height * GUSSET_A_DIAG_HALF_RATIO;
  const mid = { x: cornerX + sx * diagHalf, y: cornerY + sy * diagHalf };
  const tip = { x: cornerX + sx * diagHalf * 2, y: cornerY + sy * diagHalf * 2 };
  const v3 = { x: cornerX + sx * reach, y: cornerY };
  const v4 = { x: cornerX, y: cornerY + sy * reach };

  const cut = new PathBuilder()
    .moveTo(cornerX, cornerY)
    .lineTo(mid.x, mid.y)
    .moveTo(tip.x, tip.y)
    .lineTo(v3.x, v3.y)
    .moveTo(tip.x, tip.y)
    .lineTo(v4.x, v4.y)
    .segments();
  const crease = new PathBuilder().moveTo(mid.x, mid.y).lineTo(tip.x, tip.y).segments();

  return [
    { type: 'cut', tags: ['gusset', side], segments: cut },
    { type: 'crease', tags: ['gusset', side], segments: crease },
  ];
}

/**
 * 從 tip 沿切線圓角轉往 target 方向的 cut（style B 角撐的讓位弧／頂小弧共用邏輯）。
 *
 * turn＝diag 方向與「tip→target」方向的夾角；切線長 armLen = radius·tan(turn/2)——
 * 90° 轉角時 armLen=radius，與 reverse-tuck-end.ts 的 tuckRadius 圓角慣例一致（已用
 * 90° 案例驗算核對，見 task-3-report.md）。sweep 由 diag×dir 外積正負決定圓角凹凸
 * 方向，對四個角落（sx/sy 四種組合）都自動算出正確方向，不需個別鏡射特判。
 * 圓角不強求與 45° crease 完全相切（tip 端可能有極小轉角）——這是「先理解復刻、
 * 再參數化」的簡化（brief 允許，T5 對帳驗證最終正確性），已用四種 H/t/platform
 * 組合驗證 chord ≤ 2×radius 恆成立（不會撞上 arcTo 的「弦長超過直徑」錯誤）。
 */
function buildFilletArm(tip: Point, diag: Point, target: Point, radius: number): Segment[] {
  const dx = target.x - tip.x;
  const dy = target.y - tip.y;
  const dLen = Math.hypot(dx, dy);
  const dirX = dx / dLen;
  const dirY = dy / dLen;
  const dot = Math.max(-1, Math.min(1, diag.x * dirX + diag.y * dirY));
  const turn = Math.acos(dot);
  const armLen = radius * Math.tan(turn / 2);
  const armEnd = { x: tip.x + dirX * armLen, y: tip.y + dirY * armLen };
  const sweep: 0 | 1 = diag.x * dirY - diag.y * dirX > 0 ? 1 : 0;
  return new PathBuilder().moveTo(tip.x, tip.y).arcTo(radius, sweep, armEnd.x, armEnd.y).lineTo(target.x, target.y).segments();
}

/**
 * 薄壁角撐（style B，弧形讓位角撐）：面板角沿 45° crease（長 GUSSET_B_CREASE_RATIO×height）
 * 到 tip，再由 tip 分別以「讓位弧 R=5.0」「角撐頂小弧 R=1.5」轉向兩軸上的 V3／V4
 * （reach 與 style A 共用同一 height−thickness 公式）。復刻自附錄 B 片座標的四段特徵
 * （45° crease／斜 cut／讓位弧 R5／頂小弧 R1.5），因參照座標本身有缺段（量測表原檔才有
 * 完整逐線座標），改用「同一組切線圓角公式、兩種半徑」的自洽重建，不強行拼湊缺段座標。
 */
function buildGussetB(cornerX: number, cornerY: number, sx: Sign, sy: Sign, height: number, thickness: number, side: string): PathDescriptor[] {
  const reach = height - thickness;
  const creaseLen = height * GUSSET_B_CREASE_RATIO;
  const diag = { x: sx / Math.SQRT2, y: sy / Math.SQRT2 };
  const tip = { x: cornerX + diag.x * creaseLen, y: cornerY + diag.y * creaseLen };
  const v3 = { x: cornerX + sx * reach, y: cornerY };
  const v4 = { x: cornerX, y: cornerY + sy * reach };

  const crease = new PathBuilder().moveTo(cornerX, cornerY).lineTo(tip.x, tip.y).segments();
  const armToV3 = buildFilletArm(tip, diag, v3, GUSSET_B_RELIEF_RADIUS);
  const armToV4 = buildFilletArm(tip, diag, v4, GUSSET_B_TIP_RADIUS);

  return [
    { type: 'crease', tags: ['gusset', side], segments: crease },
    { type: 'cut', tags: ['gusset', side], segments: [...armToV3, ...armToV4] },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────────────────

const CORNERS: Array<{ sx: Sign; sy: Sign; label: string }> = [
  { sx: 1, sy: 1, label: 'right-back' },
  { sx: 1, sy: -1, label: 'right-front' },
  { sx: -1, sy: 1, label: 'left-back' },
  { sx: -1, sy: -1, label: 'left-front' },
];

/**
 * 天地盒單片 tray 幾何（上蓋／下盒共用；差別只在呼叫端傳入不同參數，見 T4 組裝）。
 * 面板中心為局部原點，x 向＝panelL（先摺壁·左右）、y 向＝panelW（後摺壁·前後）。
 * dimension 標註不在本函式範圍（texts 恆為空陣列）——由 T4 的 BoxModule 組裝統一加。
 */
export function generateTray(opts: TrayOpts): { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds } {
  const { panelL, panelW, height, platformWidth, thickness } = opts;
  const halfL = panelL / 2;
  const halfW = panelW / 2;

  const descriptors: PathDescriptor[] = [
    // x 向牆（左右，先摺）：單 crease 根、外壁＝height−t（頂緣平齊）
    ...buildWall('x', -1, 'left', halfL, halfW, height - thickness, false, thickness, platformWidth),
    ...buildWall('x', 1, 'right', halfL, halfW, height - thickness, false, thickness, platformWidth),
    // y 向牆（前後，後摺）：雙 crease 根、外壁＝height（自雙 crease 外線起量）
    ...buildWall('y', -1, 'front', halfW, halfL, height, true, thickness, platformWidth),
    ...buildWall('y', 1, 'back', halfW, halfL, height, true, thickness, platformWidth),
  ];

  const useThickStyle = platformWidth > 0;
  for (const { sx, sy, label } of CORNERS) {
    const cornerX = sx * halfL;
    const cornerY = sy * halfW;
    descriptors.push(
      ...(useThickStyle
        ? buildGussetA(cornerX, cornerY, sx, sy, height, thickness, label)
        : buildGussetB(cornerX, cornerY, sx, sy, height, thickness, label)),
    );
  }

  const paths: DielinePath[] = descriptors
    .filter((d) => d.segments.length > 0)
    .map((d, i) => ({
      id: `${opts.idPrefix}-p-${i}`,
      type: d.type,
      segments: translateSegments(d.segments, opts.offsetX, opts.offsetY),
      tags: d.tags,
    }));

  const bounds = segmentsBounds(paths.flatMap((p) => p.segments));
  return { paths, texts: [], bounds };
}
