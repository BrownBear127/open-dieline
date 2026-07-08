/**
 * 天地盒雙壁 tray 幾何——上蓋／下盒共用的單片幾何 helper（Slice 2 Task 3）。
 *
 * 只產生「一個 tray」的幾何（四壁＋四角撐）；上蓋/下盒的組裝（呼叫本函式兩次＋內襯）
 * 是 T4 的事（`boxes/telescope/index.ts`，尚未建立）。座標單位一律 mm。
 * 純 TS 模組，不 import React 或任何 UI。
 *
 * 幾何 ground truth：天地盒生產刀模量測（見
 * `.superpowers/sdd/量測附錄`、量測記錄，
 * 以及生產 SVG 原檔的逐線抽取——Fix Round 1，四個角落交叉驗證）。
 * 生產絕對座標只用來理解與校準比例常數，不進本檔——本檔只留參數化公式與具名常數。
 *
 * 角撐拓撲（兩款共同，生產檔證實）：角撐 web 與兩面牆是「同一張紙」——沿兩軸線
 * （面板邊線的延伸）以摺線（crease）相連到錨點，錨點之外牆的側邊才是 cut。
 * 對角線靠角落的一半是 cut（web 兩翼在角落附近分離）、外半是 crease（兩翼互摺收角）。
 * 牆側邊因此從「角落起算的錨點」才開始切（見 gussetAnchors）。
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
 * 舌摺線兩端讓位角撐的 crease 長度（halfcut 只在中段）。spec 原文用語「~9mm」，
 * 量測值 9.4mm（B 片：全長 197.2 vs 面板內圍 216，每端縮 9.4）——沒有第二筆資料點可
 * 反推與其他參數的線性關係，故取 spec 自己的近似值為固定具名常數（非 t 的函式；
 * 這是角撐讓位的結構淨空，不是紙厚補償）。
 */
const TONGUE_END_RECESS = 9;

/**
 * 厚壁角撐（style A）45° 對角線半段的「單軸位移量」÷ 壁高。
 * ⚠ 25.2906 是 dx=dy 的單軸位移（45° 線），真歐氏長度＝×√2≈35.77mm——別拿這個
 * 常數直接對照實體樣張上的斜線長度。校準點＝A 片參照座標（H=60、platform=5）：
 * corner→mid 單軸位移 25.2906mm。只有一組校準資料，比例常數只綁 height
 * （spec「由壁高推導」）；與 platformWidth 的關係無資料可反推。
 * 對照：style B 的對角線長度不是常數，由讓位槽幾何反推（見 bGussetFrame 的 tip 推導）。
 */
const GUSSET_A_DIAG_HALF_RATIO = 25.2906 / 60;

/**
 * 薄壁角撐（style B）讓位槽（hairpin）兩腿相對「向外法線方向」的傾角。
 * 生產參照兩腿實測 ±10.00°（相對牆根線的法線），固定角度、不隨壁高縮放。
 */
const GUSSET_B_LEG_TILT_RAD = (10 * Math.PI) / 180;

/**
 * 薄壁角撐頂小弧（hairpin 迴轉）半徑；弧頂與牆根線（面板邊線）相切
 * （生產參照 apex 距根線 0.002mm——當作精確相切反推整組幾何，見 bGussetFrame）。
 */
const GUSSET_B_TIP_RADIUS = 1.5;

/** 薄壁角撐讓位弧（槽底出口圓角）半徑，spec 明列固定值。 */
const GUSSET_B_RELIEF_RADIUS = 5.0;

/**
 * 薄壁角撐 45° 出口 cut 轉垂直 cut 的轉角高度（相對牆根線）÷ 壁高。
 * 校準點＝B 片參照（H=45）：轉角在距根線 16.298mm 處。找不到與其他特徵的唯一結構
 * 推導（生產檔孤值），依 spec「與壁高聯動」以 H 比例參數化。
 */
const GUSSET_B_EXIT_RATIO = 16.298 / 45;

// ─────────────────────────────────────────────────────────────────────────
// 內部型別
// ─────────────────────────────────────────────────────────────────────────

type Axis = 'x' | 'y';
type Sign = 1 | -1;
type Point = { x: number; y: number };
/** 角撐內部使用的「離角落」座標：a＝沿 x 軸向外距離、b＝沿 y 軸向外距離（恆正）。 */
type AB = { a: number; b: number };

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
 * 牆的兩條長邊 cut——只從「角撐錨點」（sideCutStart，離角落沿牆鏈方向的距離）切到
 * 舌摺線；角落到錨點那段是角撐 web 與牆相連的摺線（由 buildGusset* 以 crease 畫出，
 * 生產檔證實 web 與牆同紙相連，牆側邊在錨點前不得有 cut——否則 web 被切離、
 * 免膠角撐失效）。外壁／平台／內壁在錨點外共線，一條連續 cut 涵蓋即可。
 * 生產檔的側邊 cut 實際還內縮 2mm 並帶讓位小結構（未復刻，見 開發紀錄
 * Fix Round 1 的簡化清單）。
 */
function buildWallSideCuts(axis: Axis, sign: Sign, geom: WallGeom, perpHalf: number, sideCutStart: number, side: string): PathDescriptor {
  const startAlong = geom.rootAlong + sign * sideCutStart;
  const a1 = toXY(axis, startAlong, -perpHalf);
  const a2 = toXY(axis, geom.tongueFoldAlong, -perpHalf);
  const b1 = toXY(axis, startAlong, perpHalf);
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
 * 兩者剛好相等，見 開發紀錄 常數關係推導）。
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
  sideCutStart: number,
): PathDescriptor[] {
  const geom = computeWallGeom(sign, alongHalfSpan, outerLen, hasDoubleRoot, thickness, platformWidth);
  return [
    buildWallRoot(axis, geom, perpHalfSpan, hasDoubleRoot, thickness, side),
    buildWallSideCuts(axis, sign, geom, perpHalfSpan, sideCutStart, side),
    buildWallTop(axis, geom, perpHalfSpan, platformWidth, side),
    ...buildTongueFold(axis, geom, perpHalfSpan, side),
    buildTongueFlap(axis, sign, geom, perpHalfSpan, side),
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// 角撐（corner gusset）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 角撐 web 與牆相連的摺線錨點：沿 x 軸（x 向牆側邊）與沿 y 軸（y 向牆側邊）
 * 各自「角落→錨點」是 crease（web 摺線）、錨點之外才是牆側邊 cut。
 * style A：兩軸對稱共用 reach＝height−thickness（附錄 V3/V4 offset 精確相等的實證）。
 * style B：x 軸＝出口垂直 cut 的位置（2×reach − 出口轉角高，見 bGussetFrame p6）、
 * y 軸＝height（生產參照 45.074≈H；生產值是「tip→內縮 2mm 側邊」連線與軸線的交點，
 * 未復刻 2mm 內縮故取整為 H，殘差 74µm）。
 */
function gussetAnchors(useThickStyle: boolean, height: number, thickness: number): { x: number; y: number } {
  const reach = height - thickness;
  if (useThickStyle) {
    return { x: reach, y: reach };
  }
  return { x: 2 * reach - height * GUSSET_B_EXIT_RATIO, y: height };
}

/**
 * 厚壁角撐（style A，45° 斜角撐）——復刻生產 A 片四角實測結構：
 * 兩條 web 摺線（crease，角落沿兩軸到 V3/V4）＋ 45° 對角線（角落半段 cut、外半段
 * crease 到 tip）＋外緣斜切（cut：V4→tip→V3）。reach＝height−thickness 兩軸共用。
 * 生產檔另有 V3 之外的 −10° 短 cut、平台端讓位（R2.5 弧＋5mm 內縮側邊）未復刻
 * （簡化為錨點外沿軸線的直線側邊，見 開發紀錄 Fix Round 1）。
 */
function buildGussetA(cornerX: number, cornerY: number, sx: Sign, sy: Sign, height: number, thickness: number, side: string): PathDescriptor[] {
  const reach = height - thickness;
  const diagHalf = height * GUSSET_A_DIAG_HALF_RATIO;
  const mid = { x: cornerX + sx * diagHalf, y: cornerY + sy * diagHalf };
  const tip = { x: cornerX + sx * diagHalf * 2, y: cornerY + sy * diagHalf * 2 };
  const v3 = { x: cornerX + sx * reach, y: cornerY };
  const v4 = { x: cornerX, y: cornerY + sy * reach };

  const folds = new PathBuilder()
    .moveTo(cornerX, cornerY)
    .lineTo(v3.x, v3.y)
    .moveTo(cornerX, cornerY)
    .lineTo(v4.x, v4.y)
    .segments();
  const diagCut = new PathBuilder().moveTo(cornerX, cornerY).lineTo(mid.x, mid.y).segments();
  const diagCrease = new PathBuilder().moveTo(mid.x, mid.y).lineTo(tip.x, tip.y).segments();
  const outerCut = new PathBuilder().moveTo(v4.x, v4.y).lineTo(tip.x, tip.y).lineTo(v3.x, v3.y).segments();

  return [
    { type: 'crease', tags: ['gussetFold', side], segments: folds },
    { type: 'cut', tags: ['gusset', side], segments: diagCut },
    { type: 'crease', tags: ['gusset', side], segments: diagCrease },
    { type: 'cut', tags: ['gusset', side], segments: outerCut },
  ];
}

/** 薄壁角撐的骨架點（(a,b) 離角座標）；純數學，供 buildGussetB 映射與測試對照。 */
interface BGussetFrame {
  mid: AB;
  tip: AB;
  p1: AB;
  p2: AB;
  p3: AB;
  p4: AB;
  p5: AB;
  p6: AB;
  yEnd: AB;
}

/**
 * 薄壁角撐（style B）骨架推導——生產 B 片四角逐線抽取反推出的自洽幾何（Fix Round 1；
 * t=0 時對生產參照殘差 ≤0.003mm，唯 yEnd 取整為 H 差 0.074mm）：
 * - 讓位槽（hairpin）：兩腿相對向外法線 ±GUSSET_B_LEG_TILT，迴轉小弧 R1.5 的弧頂
 *   與牆根線（b=0）精確相切 → 槽軸在 a=reach（x 向牆頂位置）、切點 p1/p2 全由
 *   R×cos/sin(tilt) 推出。
 * - tip（對角線端點）＝內腿線與 45° 對角線（a=b）的交點——不是獨立常數。
 * - 出口：45° cut 沿直線 a+b＝2×reach（生產參照 p4/p5/p6 三點共線在此線上的實證），
 *   與外腿以 R5 圓角相接（轉角 125°，切點 p3/p4 由切線長 R·tan(轉角/2) 推出）；
 *   在 b＝EXIT_RATIO×H 處轉垂直 cut（p5→p6）落到牆根線。
 */
function bGussetFrame(height: number, thickness: number): BGussetFrame {
  const reach = height - thickness;
  const r15 = GUSSET_B_TIP_RADIUS;
  const r5 = GUSSET_B_RELIEF_RADIUS;
  const sinT = Math.sin(GUSSET_B_LEG_TILT_RAD);
  const cosT = Math.cos(GUSSET_B_LEG_TILT_RAD);
  const tanT = Math.tan(GUSSET_B_LEG_TILT_RAD);

  const legB = r15 * (1 - sinT); // 兩切點的 b（弧心在 b=r15、弧頂切 b=0）
  const p1: AB = { a: reach - r15 * cosT, b: legB };
  const p2: AB = { a: reach + r15 * cosT, b: legB };

  const tipS = (p1.a + p1.b * tanT) / (1 + tanT); // 內腿線 ∩ 對角線 a=b
  const tip: AB = { a: tipS, b: tipS };
  const mid: AB = { a: tipS / 2, b: tipS / 2 };

  const qb = (2 * reach - p2.a + p2.b * tanT) / (1 + tanT); // 外腿線 ∩ 出口線 a+b=2reach
  const q: AB = { a: 2 * reach - qb, b: qb };
  const turn = Math.acos(sinT * Math.SQRT1_2 + cosT * -Math.SQRT1_2); // 外腿→出口的轉角（125°）
  const tangentLen = r5 * Math.tan(turn / 2);
  const p3: AB = { a: q.a - tangentLen * sinT, b: q.b - tangentLen * cosT };
  const p4: AB = { a: q.a + tangentLen * Math.SQRT1_2, b: q.b - tangentLen * Math.SQRT1_2 };

  const exitB = height * GUSSET_B_EXIT_RATIO;
  const p5: AB = { a: 2 * reach - exitB, b: exitB };
  const p6: AB = { a: p5.a, b: 0 };
  const yEnd: AB = { a: 0, b: height };

  return { mid, tip, p1, p2, p3, p4, p5, p6, yEnd };
}

/** 依進出切線方向的外積決定 arcTo 的 sweep（四個角落 sx/sy 鏡射自動得到正確凹凸向）。 */
function sweepFor(inDir: Point, outDir: Point): 0 | 1 {
  return inDir.x * outDir.y - inDir.y * outDir.x > 0 ? 1 : 0;
}

/**
 * 薄壁角撐（style B，弧形讓位角撐）組裝：web 摺線×2＋對角線（cut 半段＋crease 半段）
 * ＋terminal cut（tip→y 軸錨點）＋讓位槽連續 cut 鏈（tip→p1→[R1.5]→p2→p3→[R5]→p4→p5→p6）。
 * 生產檔的 2mm 側邊內縮（鏈端實際落在內縮線上）未復刻——鏈端取整到軸線（殘差 ≤0.074mm）。
 */
function buildGussetB(cornerX: number, cornerY: number, sx: Sign, sy: Sign, height: number, thickness: number, side: string): PathDescriptor[] {
  const f = bGussetFrame(height, thickness);
  const m = (p: AB): Point => ({ x: cornerX + sx * p.a, y: cornerY + sy * p.b });
  const sinT = Math.sin(GUSSET_B_LEG_TILT_RAD);
  const cosT = Math.cos(GUSSET_B_LEG_TILT_RAD);
  const dir = (da: number, db: number): Point => ({ x: sx * da, y: sy * db });

  const mid = m(f.mid);
  const tip = m(f.tip);
  const p1 = m(f.p1);
  const p2 = m(f.p2);
  const p3 = m(f.p3);
  const p4 = m(f.p4);
  const p5 = m(f.p5);
  const p6 = m(f.p6);
  const yEnd = m(f.yEnd);

  const folds = new PathBuilder()
    .moveTo(cornerX, cornerY)
    .lineTo(p6.x, p6.y) // x 軸 web 摺線：角落→p6（出口垂直 cut 落點）
    .moveTo(cornerX, cornerY)
    .lineTo(yEnd.x, yEnd.y) // y 軸 web 摺線：角落→H
    .segments();
  const diagCut = new PathBuilder().moveTo(cornerX, cornerY).lineTo(mid.x, mid.y).segments();
  const diagCrease = new PathBuilder().moveTo(mid.x, mid.y).lineTo(tip.x, tip.y).segments();
  const terminalCut = new PathBuilder().moveTo(tip.x, tip.y).lineTo(yEnd.x, yEnd.y).segments();

  // 讓位槽鏈（一條連續 cut）：兩個圓角的 sweep 由進出切線方向外積決定
  const sweep15 = sweepFor(dir(sinT, -cosT), dir(sinT, cosT));
  const sweep5 = sweepFor(dir(sinT, cosT), dir(Math.SQRT1_2, -Math.SQRT1_2));
  const slot = new PathBuilder()
    .moveTo(tip.x, tip.y)
    .lineTo(p1.x, p1.y)
    .arcTo(GUSSET_B_TIP_RADIUS, sweep15, p2.x, p2.y)
    .lineTo(p3.x, p3.y)
    .arcTo(GUSSET_B_RELIEF_RADIUS, sweep5, p4.x, p4.y)
    .lineTo(p5.x, p5.y)
    .lineTo(p6.x, p6.y)
    .segments();

  return [
    { type: 'crease', tags: ['gussetFold', side], segments: folds },
    { type: 'cut', tags: ['gusset', side], segments: diagCut },
    { type: 'crease', tags: ['gusset', side], segments: diagCrease },
    { type: 'cut', tags: ['gusset', side], segments: terminalCut },
    { type: 'cut', tags: ['gusset', side], segments: slot },
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
  const useThickStyle = platformWidth > 0;
  const anchors = gussetAnchors(useThickStyle, height, thickness);

  const descriptors: PathDescriptor[] = [
    // x 向牆（左右，先摺）：單 crease 根、外壁＝height−t（頂緣平齊）；側邊 cut 自 anchors.x 起
    ...buildWall('x', -1, 'left', halfL, halfW, height - thickness, false, thickness, platformWidth, anchors.x),
    ...buildWall('x', 1, 'right', halfL, halfW, height - thickness, false, thickness, platformWidth, anchors.x),
    // y 向牆（前後，後摺）：雙 crease 根、外壁＝height（自雙 crease 外線起量）；側邊 cut 自 anchors.y 起
    ...buildWall('y', -1, 'front', halfW, halfL, height, true, thickness, platformWidth, anchors.y),
    ...buildWall('y', 1, 'back', halfW, halfL, height, true, thickness, platformWidth, anchors.y),
  ];

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
