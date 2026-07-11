/**
 * 天地盒雙壁 tray 幾何——上蓋／下盒共用的單片幾何 helper（Slice 2 Task 3）。
 *
 * 只產生「一個 tray」的幾何（四壁＋四角撐）；上蓋/下盒的組裝（呼叫本函式兩次＋內襯）
 * 是 T4 的事（`boxes/telescope/index.ts`，尚未建立）。座標單位一律 mm。
 * 純 TS 模組，不 import React 或任何 UI。
 *
 * 幾何 ground truth：天地盒生產刀模量測（見
 * `.superpowers/sdd/slice2-appendix.md`、coding-workspace 任務夾「天地盒量測表.md」，
 * 以及生產 SVG 原檔的逐線抽取——Fix Round 1，四個角落交叉驗證）。
 * 生產絕對座標只用來理解與校準比例常數，不進本檔——本檔只留參數化公式與具名常數。
 *
 * 角撐拓撲（兩款共同，生產檔證實）：角撐 web 與兩面牆是「同一張紙」——沿兩軸線
 * （面板邊線的延伸）以摺線（crease）相連到錨點，錨點之外牆的側邊才是 cut。
 * 對角線靠角落的一半是 cut（web 兩翼在角落附近分離）、外半是 crease（兩翼互摺收角）。
 * 牆側邊因此從「角落起算的錨點」才開始切（見 gussetAnchors）。
 */

import type { Bounds, Segment } from '@/core/geometry';
import { hasSelfIntersection, segmentsBounds } from '@/core/geometry';
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
 * 厚壁角撐（style A）45° 對角線半段的「單軸位移量」÷ 壁高。
 * ⚠ 25.2906 是 dx=dy 的單軸位移（45° 線），真歐氏長度＝×√2≈35.77mm——別拿這個
 * 常數直接對照實體樣張上的斜線長度。校準點＝A 片參照座標（H=60、platform=5）：
 * corner→mid 單軸位移 25.2906mm。只有一組校準資料，比例常數只綁 height
 * （brief「由壁高推導」）；與 platformWidth 的關係無資料可反推。
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

/** 薄壁角撐讓位弧（槽底出口圓角）半徑，brief 明列固定值。 */
const GUSSET_B_RELIEF_RADIUS = 5.0;

/**
 * 薄壁角撐 45° 出口 cut 轉垂直 cut 的轉角高度（相對牆根線）÷ 壁高。
 * 校準點＝B 片參照（H=45）：轉角在距根線 16.298mm 處。找不到與其他特徵的唯一結構
 * 推導（生產檔孤值），依 brief「與壁高聯動」以 H 比例參數化。
 */
const GUSSET_B_EXIT_RATIO = 16.298 / 45;

// ─────────────────────────────────────────────────────────────────────────
// A 款細節常數（Slice 5 F4／F6-A：U-notch＋halfcut 分段＋平台角撐周邊複合 relief 鏈）
// 全部固定 nominal，不隨壁長縮放（spec §縮放與降級規律 1）；精確座標來源＝T0 座標表
// `tests/fixtures/telescope-production-details.json`（獨立對算 100/100 CONFIRMED）。
// ─────────────────────────────────────────────────────────────────────────

/** U-notch 開口寬／底寬／深／圓角半徑（nominal，T0 逐點對算：ARC15/LINE100/101 等）。 */
const NOTCH_OPENING = 30;
const NOTCH_BASE = 26;
const NOTCH_DEPTH = 4.2;
const NOTCH_FILLET_R = 2;

/** 側壁（長壁）雙 notch 中心比例：±(29.3385/179)×sideRootSpan（spec §縮放與降級規律 2）。 */
const NOTCH_CENTER_RATIO = 29.3385 / 179;

/** notch 可容納安全邊（spec §縮放與降級表：上下壁「壁長≥30+2×5」／側壁「...且全形落在壁內」）。 */
const NOTCH_SAFETY_MARGIN = 5;

/**
 * A 款角撐周邊複合 relief 鏈消耗掉、halfcut 分段不覆蓋的兩端 reach（T0 逐點對算：
 * 長壁＝aGussetPeriphery_reliefChain 終點（LINE92 對應）距角落 21.5018mm；短壁＝
 * 平台端 fillet 下探鏈終點（LINE3 對應）距角落 2.0002mm——兩者皆是 buildAGussetPeriphery
 * 固定 (a,b) 鏈本身的端點，非獨立自由常數，僅在此重複具名供 halfcut 邊界計算查閱。
 */
const A_CHAIN_REACH_LONGWALL = 21.5018;
const A_CHAIN_REACH_SHORTWALL = 2.0002;

/** 平台端內縮量（長壁／短壁分列，spec nominal）與圓角半徑／可容納門檻。 */
const PLATFORM_END_INSET_LONGWALL = 4.5;
const PLATFORM_END_INSET_SHORTWALL = 5.0;
const PLATFORM_CORNER_R = 2.5;
const PLATFORM_CORNER_MIN_WIDTH = 2.5;

/**
 * A 款角撐周邊複合鏈——P 原檔 topLeft 角完整量得 16 段（spec F6 v1.3：10° cut 為樞紐，
 * 連接 45° gusset 對角線／外壁 crease／平台內縮垂直線），本檔實際消費 **13 段**
 * （扣除與既有 buildGussetA 幾何重複的 LINE57/58/202，見 A_GUSSET_OUTER_TL 註解；
 * Fix 5·2026-07-11：新 relief chain 13 段＋既有 gusset 對應 2 cut+1 crease＝合計覆蓋
 * P 的 16 primitive，先前註解／測試訊息誤植「14 段／扣 2 段」已更正）。
 *
 * **兩組手性模板（Fix 1·2026-07-11 SOL review H1）**：對角角落（topLeft↔bottomRight、
 * topRight↔bottomLeft）才是數學精確的 180° 旋轉；相鄰角落（topLeft↔topRight）不是
 * topLeft 的旋轉或鏡射——P 原檔在「平台端 zigzag」子鏈有真實走線差異（topLeft 的
 * LINE108 對應段 b 範圍 [-4.5014,52.9978]／57.4992mm，topRight 的 LINE64 對應段
 * b 範圍 [-4.5014,72.9968]／77.4982mm，相差整 20mm——對稱地 topLeft LINE113 對應段
 * 78.4578mm vs topRight LINE59 對應段 58.4588mm，即 fixture _meta.verification 記錄的
 * 「78.46 vs 58.46」手性不對稱）。先前實作誤把 topLeft 模板用 sx/sy 全部翻轉出四角，
 * 在相鄰角落（right-front／left-back）做出鏡射而非旋轉，偏差達 8.8-39mm（結構級）。
 * 修正：topLeft 模板（`_TL` 尾綴）供 left-front／right-back 使用；topRight 模板
 * （`_TR` 尾綴，2026-07-11 從 raw_elements.json 獨立補量，見
 * tests/fixtures/telescope-production-details.json 的 `topRightCorner_*` 三欄＋
 * `topRightCorner_note`）供 right-front／left-back 使用——見 buildAGussetChain 呼叫端
 * （generateTray 的 corner 迴圈按 sx===sy 選模板）。
 *
 * a＝沿長壁（x 向牆）向外距離、b＝沿短壁（y 向牆）向外距離；不試圖從參數重建內部頂點
 * （spec 明文）——固定 offset，僅角落本身隨 panelL/panelW 移動。
 */
interface ABPt {
  a: number;
  b: number;
}
interface ABLine {
  p1: ABPt;
  p2: ABPt;
  type: LineType;
}

/**
 * 外緣：10° cut 樞紐（LINE27，topLeft 模板）。
 *
 * T0 原始鏈另含 LINE57/58（角落→45° 對角線 tip 附近的兩段）與 LINE202（outerWall
 * 角落收邊 crease）——經對算腳本核對後確認兩者都與**既有**幾何重複：
 * - LINE57/58 與 buildGussetA 的 outerCut（V4→tip→V3，reach=height−wallTopCompensation，
 *   Fix 4·2026-07-11 更正——先前殘留的 height−thickness 舊公式已修正，見 buildGussetA）在
 *   production-P 座標下幾乎重合（相距 ≤0.1mm）；
 * - LINE202（root→outerWall 角落、固定 perp=corner）與 buildGussetA 的 x 軸 web 摺線
 *   （corner→v3，同樣固定 perp=corner）是同一條物理線的兩種公式表述，thickness＝
 *   wallTopCompensation 時（如 S5 全零等價形態）兩者座標完全相同，被「無同型重複線段」
 *   掃描抓到。
 *
 * 同一條物理刀模線在 T0 獨立量測中被判讀成「角撐周邊複合鏈」的一部分，但其實是既有
 * 對角線/web 摺線幾何的再測量，非新增細節——兩者用不同公式算（本鏈固定 offset vs.
 * outerCut/web 摺線的 reach 公式）在非 production-P 參數下會產生真交叉或精確重複
 * （cut 自撞掃描 24 組合／S5 全零掃描曾在此抓到），故不重複收錄。LINE27（10° cut）
 * 錨定的是 outerWall（topStartAlong，wallTopCompensation 公式）而非 v3/v4
 * （reach，wallTopCompensation 公式），是與既有幾何無關、確定新增的獨立特徵，保留。
 */
const A_GUSSET_OUTER_TL: ABLine[] = [{ p1: { a: 59.4995, b: 0 }, p2: { a: 64.4984, b: -0.8819 }, type: 'cut' }];

/** 平台端 relief zigzag（LINE108/109/110/111/112，topLeft 模板）。 */
const A_GUSSET_PLATFORM_RELIEF_TL: ABLine[] = [
  { p1: { a: 64.4984, b: -4.5014 }, p2: { a: 64.4984, b: 52.9978 }, type: 'cut' },
  { p1: { a: 93.8495, b: 52.9978 }, p2: { a: 64.4984, b: 52.9978 }, type: 'cut' },
  { p1: { a: 83.5801, b: 52.9978 }, p2: { a: 73.3072, b: 57.9967 }, type: 'cut' },
  { p1: { a: 73.3072, b: 57.9967 }, p2: { a: 73.3072, b: 72.9968 }, type: 'cut' },
  { p1: { a: 73.3072, b: 72.9968 }, p2: { a: 121.2003, b: 72.9968 }, type: 'cut' },
];

/** 內壁逼近 notch（LINE113/94/88/84/86/90/92，topLeft 模板）——終點 (123.2006,-21.5018) 即 halfcut 邊界。 */
const A_GUSSET_INNER_WALL_APPROACH_TL: ABLine[] = [
  { p1: { a: 121.2003, b: 72.9968 }, p2: { a: 121.2003, b: -5.461 }, type: 'cut' },
  { p1: { a: 121.2003, b: -5.461 }, p2: { a: 138.2007, b: -5.461 }, type: 'cut' },
  { p1: { a: 103.699, b: -5.461 }, p2: { a: 121.2003, b: -5.461 }, type: 'cut' },
  { p1: { a: 103.699, b: -2.5012 }, p2: { a: 103.699, b: -4.5014 }, type: 'cut' },
  { p1: { a: 103.699, b: -4.5014 }, p2: { a: 103.699, b: -5.461 }, type: 'cut' },
  { p1: { a: 121.2003, b: -5.461 }, p2: { a: 121.2003, b: -21.5018 }, type: 'cut' },
  { p1: { a: 121.2003, b: -21.5018 }, p2: { a: 123.2006, b: -21.5018 }, type: 'cut' },
];

/**
 * topRight 模板（Fix 1·2026-07-11 補量，raw_elements.json 獨立萃取——LINE12/55/56/203
 * 等 gid，見 tests/fixtures/telescope-production-details.json 的 `topRightCorner_*` 欄）。
 * OUTER（LINE12，10° cut）與 topLeft 的 LINE27 在 (a,b) 下精確相符（<0.0002mm）——這段
 * 本身無手性差異，數值與 A_GUSSET_OUTER_TL 相同。5 個錨點 a 值（59.4995/64.4984/
 * 121.2003/123.2006/138.2007）字面上刻意寫成與 topLeft 模板相同的常數，供 snapALongAnchor
 * 精確命中（兩模板獨立量測，同一 nominal 錨點的量測殘差 <0.0002mm，snap 後精確重合，
 * 與 topLeft 模板一致，見 buildAGussetChain 的 snapALongAnchor 呼叫）。
 */
const A_GUSSET_OUTER_TR: ABLine[] = [{ p1: { a: 59.4995, b: 0 }, p2: { a: 64.4984, b: -0.8819 }, type: 'cut' }];

/**
 * 平台端 relief zigzag（LINE64/60/61/62/63，topRight 模板）——與 topLeft 模板的結構性
 * 差異就在這裡：LINE64（LINE108 對應段）reach 到 b=72.9968（不是 topLeft 的 52.9978），
 * 對稱地 A_GUSSET_INNER_WALL_APPROACH_TR 的 LINE59 只到 b=52.9978（不是 topLeft 的
 * 72.9968）——「平台端 zigzag」在相鄰角落與 topLeft 走線交叉不同，非鏡射也非旋轉。
 */
const A_GUSSET_PLATFORM_RELIEF_TR: ABLine[] = [
  { p1: { a: 64.4984, b: -4.5014 }, p2: { a: 64.4984, b: 72.9968 }, type: 'cut' },
  { p1: { a: 91.8492, b: 52.9978 }, p2: { a: 121.2003, b: 52.9978 }, type: 'cut' },
  { p1: { a: 102.1185, b: 52.9978 }, p2: { a: 112.3879, b: 57.9967 }, type: 'cut' },
  { p1: { a: 112.3879, b: 57.9967 }, p2: { a: 112.3879, b: 72.9968 }, type: 'cut' },
  { p1: { a: 112.3879, b: 72.9968 }, p2: { a: 64.4984, b: 72.9968 }, type: 'cut' },
];

/** 內壁逼近 notch（LINE59/24/18/14/16/20/22，topRight 模板）——終點 (123.2006,-21.5018) 與 topLeft 模板相同（tongueFold/halfcut 邊界不受手性差異影響）。 */
const A_GUSSET_INNER_WALL_APPROACH_TR: ABLine[] = [
  { p1: { a: 121.2003, b: 52.9978 }, p2: { a: 121.2003, b: -5.461 }, type: 'cut' },
  { p1: { a: 121.2003, b: -5.461 }, p2: { a: 138.2007, b: -5.461 }, type: 'cut' },
  { p1: { a: 103.699, b: -5.461 }, p2: { a: 121.2003, b: -5.461 }, type: 'cut' },
  { p1: { a: 103.699, b: -2.5012 }, p2: { a: 103.699, b: -4.5014 }, type: 'cut' },
  { p1: { a: 103.699, b: -4.5014 }, p2: { a: 103.699, b: -5.461 }, type: 'cut' },
  { p1: { a: 121.2003, b: -5.461 }, p2: { a: 121.2003, b: -21.5018 }, type: 'cut' },
  { p1: { a: 121.2003, b: -21.5018 }, p2: { a: 123.2006, b: -21.5018 }, type: 'cut' },
];

/** topLeft／topRight 兩組模板的完整（13 段）陣列——buildAGussetChain 依角落選用。
 *  aGussetChainFits（可容納性判定，Fix 2）定義在 buildAGussetChain 之後——需要
 *  resolveAGussetChainPoints／snapALongAnchor／LongWallAnchors，見該處。 */
const A_GUSSET_CHAIN_TL: ABLine[] = [...A_GUSSET_OUTER_TL, ...A_GUSSET_PLATFORM_RELIEF_TL, ...A_GUSSET_INNER_WALL_APPROACH_TL];
const A_GUSSET_CHAIN_TR: ABLine[] = [...A_GUSSET_OUTER_TR, ...A_GUSSET_PLATFORM_RELIEF_TR, ...A_GUSSET_INNER_WALL_APPROACH_TR];

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
  /** 壁根雙摺線間距（Slice 5 F3，與 thickness 解耦）；hasDoubleRoot=false 的軸不吃這個值。 */
  rootJog: number;
  /** 內壁＝外壁－此值（Slice 5 F3，與 thickness 解耦，四面牆共用同一值）。 */
  innerWallReduction: number;
  /**
   * x 向牆（左右，先摺）外壁的頂緣平齊修正量（Slice 5 F3，與 thickness 解耦）。
   * 按件分流由呼叫端決定：base 傳真實參數值、lid 恆傳 0（B-06 特例移除，見
   * index.ts buildLidPiece）——generateTray 本身不知道「這是哪一件」，只忠實套用傳入值。
   */
  wallTopCompensation: number;
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
  rootJog: number,
  innerWallReduction: number,
  platformWidth: number,
): WallGeom {
  // 內壁＝外壁－innerWallReduction（單次扣減，Slice 5 F3 解耦：原本讀 2×thickness，
  // audit A-01——t 不再直接串這裡，見 index.ts params 宣告）。
  const innerLen = outerLen - innerWallReduction;
  const rootAlong = sign * alongHalfSpan;
  // 雙 crease 間距＝rootJog（F3 解耦：原本讀 thickness）；rootJog=0 時 doubleGap=0 →
  // outerStartAlong 與 rootAlong 重合，buildWallRoot 只畫一條線（collapse 語意見該函式，
  // 不再綁 thickness=0——見 rootJog 參數說明）。
  const doubleGap = hasDoubleRoot ? rootJog : 0;
  const outerStartAlong = rootAlong + sign * doubleGap;
  const topStartAlong = outerStartAlong + sign * outerLen;
  const topEndAlong = topStartAlong + sign * platformWidth;
  const tongueFoldAlong = topEndAlong + sign * innerLen;
  return { rootAlong, outerStartAlong, topStartAlong, topEndAlong, tongueFoldAlong, innerLen };
}

/**
 * 壁根摺線：x 向牆單 crease；y 向牆階梯 jog（Slice 5 F2，取代舊「中央面板兩條 full-length
 * 平行 crease」——那是量測表誤讀，生產檔其實是中央/側翼錯開、角落用短段接回，見
 * `dieline-audit-telescope.md` B-01）。rootJog=0 時 collapse 為單線（不得輸出兩條重合線，
 * 語意同 F3：門檻看 rootJog 不是 thickness）。
 *
 * 階梯 jog 結構（hasDoubleRoot 且 rootJog>0）：中央只留外移後那一條 crease（geom.
 * outerStartAlong，跨整個 perp 範圍、corner-to-corner）。兩端是否補 jog 短段接回 nominal
 * （geom.rootAlong）依 A／B 款而異，見下——不是隨意的風格差異，是與 buildGussetA／B 的
 * 角撐 y 軸 web 摺線分工互補而來，兩者合看才是完整的「中央→角落」路徑（Slice 5 Fix2·
 * SOL review Finding 1 逐 entity 對照 P 校正，取代本函式舊版「兩款座標集合相同、只差
 * 陣列連續性」的錯誤簡化——舊版兩款都對齊 nominal 角落起筆，與角撐摺線同線型共線重疊
 * rootJog，P 原檔逐 entity 對照後證實兩款都不該這樣畫）：
 *
 * - A 款（厚壁角撐，independentJogEntity=true，P:LINE204/206/207）：中央 crease 之外，
 *   兩端各補一段零 perp 位移、長度=rootJog 的獨立 jog 短段——3 個互不相連的獨立 entity。
 *   buildGussetA 的 y 軸 web 摺線起點已同步改讀 rootJog（見該函式），與這裡的 jog 短段
 *   在 offset 端精確相接、不重疊。
 * - B 款（薄壁角撐，independentJogEntity=false，P:LINE242）：只輸出中央 offset crease，
 *   不新增 jog 短段——nominal↔offset 這段區間本來就落在既有 buildGussetB 的 y 軸 web
 *   摺線（角落→H，跨度遠大於 jog、未變動）路徑內，另畫短段會與那條摺線同線型共線重疊
 *   rootJog（P 逐 entity 對照：LINE240/245 起點在 nominal 角落、範圍涵蓋 offset；LINE242
 *   只有中央線，沒有獨立短線 entity，兩者也不是一筆連續折線）。
 *
 * 兩款 segments 陣列座標集合因此不同（A 含 nomNeg/nomPos 端點、B 不含）——這不影響
 * doubleCreaseGap／centralFoldSpan／sideRootSpan 等既有數值錨（皆走 allAlongValues 寬鬆
 * 抽取，2 個相異駐留座標的語意不變）。
 */
function buildWallRoot(
  axis: Axis,
  geom: WallGeom,
  perpHalf: number,
  hasDoubleRoot: boolean,
  rootJog: number,
  side: string,
  independentJogEntity: boolean,
): PathDescriptor {
  if (!hasDoubleRoot || rootJog <= 0) {
    const p1 = toXY(axis, geom.rootAlong, -perpHalf);
    const p2 = toXY(axis, geom.rootAlong, perpHalf);
    const b = new PathBuilder().moveTo(p1.x, p1.y).lineTo(p2.x, p2.y);
    return { type: 'crease', tags: ['wallRoot', side], segments: b.segments() };
  }

  const nomNeg = toXY(axis, geom.rootAlong, -perpHalf);
  const offNeg = toXY(axis, geom.outerStartAlong, -perpHalf);
  const offPos = toXY(axis, geom.outerStartAlong, perpHalf);
  const nomPos = toXY(axis, geom.rootAlong, perpHalf);

  const b = new PathBuilder();
  if (independentJogEntity) {
    // A 款：中央 crease、負端 jog 短段、正端 jog 短段——三段各自 moveTo，互不相連。
    b.moveTo(offNeg.x, offNeg.y).lineTo(offPos.x, offPos.y);
    b.moveTo(nomNeg.x, nomNeg.y).lineTo(offNeg.x, offNeg.y);
    b.moveTo(offPos.x, offPos.y).lineTo(nomPos.x, nomPos.y);
  } else {
    // B 款：只輸出中央 offset crease；jog 區間已由 buildGussetB 的 y 軸 web 摺線涵蓋
    // （未變動的既有摺線本來就跨過 nominal／offset），不重畫短段——重畫會與那條摺線
    // 同線型共線重疊（Finding 1 修正：舊版在此多畫了 nomNeg→offNeg／offPos→nomPos）。
    b.moveTo(offNeg.x, offNeg.y).lineTo(offPos.x, offPos.y);
  }
  return { type: 'crease', tags: ['wallRoot', side], segments: b.segments() };
}

/**
 * 牆的兩條長邊 cut——只從「角撐錨點」（sideCutStart，離角落沿牆鏈方向的距離）切到
 * endAlong；角落到錨點那段是角撐 web 與牆相連的摺線（由 buildGusset* 以 crease 畫出，
 * 生產檔證實 web 與牆同紙相連，牆側邊在錨點前不得有 cut——否則 web 被切離、
 * 免膠角撐失效）。外壁／平台／內壁在錨點外共線，一條連續 cut 涵蓋即可。
 *
 * endAlong（Slice 5 F6-A 修正）：B 款仍到 geom.tongueFoldAlong（未變）；A 款改到
 * geom.topEndAlong——生產檔此段（topEndAlong→tongueFoldAlong）的牆緣不是簡單直線，
 * 已被 buildAGussetChain 的複合 relief 鏈（zigzag 穿越角落兩壁交界）取代，兩者在
 * along=topEndAlong 處以 T 型交會銜接、不重疊（見 task-3-report.md 對算過程；F4/F6-A
 * 前的簡化——側邊 cut 內縮 2mm 讓位小結構未復刻——到此正式取代）。
 */
function buildWallSideCuts(axis: Axis, sign: Sign, geom: WallGeom, perpHalf: number, sideCutStart: number, endAlong: number, side: string): PathDescriptor {
  const startAlong = geom.rootAlong + sign * sideCutStart;
  // A 款 endAlong（topStartAlong／topEndAlong，見上方呼叫端）在退化參數組合下可能與
  // startAlong 重合（如 S5 全零：rootJog=thickness=0 時 anchors.y 與 topStartAlong-距離
  // 剛好都等於 height）——退化為零長度時整段略過，不畫零長線（防禦，非幾何錯誤）。
  const b = new PathBuilder();
  if (Math.abs(endAlong - startAlong) > 1e-9) {
    const a1 = toXY(axis, startAlong, -perpHalf);
    const a2 = toXY(axis, endAlong, -perpHalf);
    const b1 = toXY(axis, startAlong, perpHalf);
    const b2 = toXY(axis, endAlong, perpHalf);
    b.moveTo(a1.x, a1.y).lineTo(a2.x, a2.y).moveTo(b1.x, b1.y).lineTo(b2.x, b2.y);
  }
  return { type: 'cut', tags: ['wallSide', side], segments: b.segments() };
}

/**
 * 壁頂：platform>0 兩條 crease；platform=0 單 crease（反折）。
 * A 款（Slice 5 F6）第二條（platform 端）crease 依壁款兩端各內縮 PLATFORM_END_INSET_*
 * （長壁 4.5／短壁 5.0，spec nominal）——內縮騰出的角落空間由 buildAPlatformCornerRelief
 * 的 R2.5 圓角／直角銜接補上（見 generateTray 角落迴圈）。內縮量 clamp 到 0（防禦：極端小
 * platformWidth 搭配極小 perpHalf 時不得產生負長度線）。
 */
function buildWallTop(axis: Axis, geom: WallGeom, perpHalf: number, platformWidth: number, side: string, hasDoubleRoot: boolean): PathDescriptor {
  const s1 = toXY(axis, geom.topStartAlong, -perpHalf);
  const e1 = toXY(axis, geom.topStartAlong, perpHalf);
  const b = new PathBuilder().moveTo(s1.x, s1.y).lineTo(e1.x, e1.y);
  if (platformWidth > 0) {
    const inset = hasDoubleRoot ? PLATFORM_END_INSET_SHORTWALL : PLATFORM_END_INSET_LONGWALL;
    const half = Math.max(perpHalf - inset, 0);
    const s2 = toXY(axis, geom.topEndAlong, -half);
    const e2 = toXY(axis, geom.topEndAlong, half);
    b.moveTo(s2.x, s2.y).lineTo(e2.x, e2.y);
  }
  return { type: 'crease', tags: ['wallTop', side], segments: b.segments() };
}

// ─────────────────────────────────────────────────────────────────────────
// B 款舌根拓撲＋V relief（Slice 5 F5）：取代舊「兩端 9mm cut 讓位＋單一中段 halfcut」
// 簡化語意——維護者裁決註記：P 的舌根兩端 crease 物理成立靠 V 形 detour 讓下方成為
// 非自由邊，復刻必須整組做（spec F5 開頭）。端段固定 nominal crease（左右壁 45、
// 前後壁 35）＋中段 halfcut 吃剩餘＋V relief（僅前後壁·hasDoubleRoot 壁）。
// 全部固定 nominal，不隨壁長縮放（spec §縮放與降級規律 1）；精確座標來源＝T0 座標表
// `tests/fixtures/telescope-production-details.json` 的 lid 區塊（獨立對算 100/100 CONFIRMED）。
// ─────────────────────────────────────────────────────────────────────────

/** 端段 crease nominal 長度：左右壁（longWall，x 向牆，hasDoubleRoot=false）45、前後壁（shortWall，y 向牆，hasDoubleRoot=true）35。 */
const B_TONGUE_END_LONGWALL = 45;
const B_TONGUE_END_SHORTWALL = 35;

/** 端段縮減分支 3 門檻（可用長度<此值→全 halfcut 無端段，spec F5 v1.2 H1）。 */
const B_TONGUE_MIN_SPAN = 10;

/**
 * longWall（左右壁）兩端保留給角撐周邊複合鏈（bGussetPeriphery，F6-B）的區域——T0 逐點
 * 對算：lid 左壁 endTop_crease 起點距壁緣（panel corner）9.398mm（206.5373−197.1393，
 * 見 tests/fixtures/telescope-production-details.json 的 lid.longWall_stack_d_landmarks_mm
 * 與 tongueRoot.longWall.endTop_crease）。固定 nominal，不隨參數縮放（spec §縮放與降級
 * 規律 1）。shortWall（前後壁）的對應保留區＝V_RELIEF_INSET（V relief 自己的內縮量，
 * 兩者皆非獨立自由常數，是各自機制本身的固定量）。
 */
const B_TONGUE_RESERVED_LONGWALL = 9.398;

/** V relief 高×內縮（spec nominal 5×2.5，兩條 cut 直線無半徑，見 spec F5②）；MIN_END＝可容納門檻（E′≥7.5，2.5＋安全邊5）。 */
const V_RELIEF_HEIGHT = 5;
const V_RELIEF_INSET = 2.5;
const V_RELIEF_MIN_END = 7.5;

interface BTongueBranch {
  /** 端段實際長度（0＝分支 3，全 halfcut 無端段）。 */
  endLen: number;
}

/**
 * B 款端段縮減三分支（spec F5 v1.2 H1，逐分支明寫；reservedSpan＝扣掉 V relief／角撐
 * 周邊保留區後的可用舌摺線長度、eNominal＝該壁端段 nominal 45 或 35）：
 *   1. reservedSpan ≥ 2×eNominal+10：端段＝eNominal，不縮不警告
 *   2. 10 ≤ reservedSpan < 2×eNominal+10：端段縮至 (reservedSpan−10)/2＋warning
 *      `tongue-crease-shrunk`
 *   3. reservedSpan < 10：端段＝0（全 halfcut）＋warning `tongue-crease-omitted`
 * warning 由 index.ts 依同一公式獨立重算（同 notchDegradation 先例——本函式純幾何，
 * 不回報警告字串）。
 */
function bTongueBranch(reservedSpan: number, eNominal: number): BTongueBranch {
  if (reservedSpan >= 2 * eNominal + B_TONGUE_MIN_SPAN) return { endLen: eNominal };
  if (reservedSpan >= B_TONGUE_MIN_SPAN) return { endLen: (reservedSpan - B_TONGUE_MIN_SPAN) / 2 };
  return { endLen: 0 };
}

/**
 * V relief 一對（該壁兩端各一個，僅 hasDoubleRoot 壁——shortWall／前後壁——專屬，見
 * buildBTongueTopology 呼叫端；longWall 沒有 V relief 機制，其兩端讓位改由 F6-B 的
 * 角撐周邊複合鏈負責，見 B_TONGUE_RESERVED_LONGWALL 註解）：apex 落在 tongueFold 線上、
 * 距壁緣 V_RELIEF_INSET；兩臂落在壁緣（perp=±perpHalf），沿 along 軸方向偏移
 * ±V_RELIEF_HEIGHT/2（T0 對算：apex/arm 座標見 fixture lid.vReliefs 系列欄位）。
 * 兩條 full-cut 直線、無圓角（spec F5②）。
 */
function buildVReliefPair(axis: Axis, along: number, perpHalf: number, side: string): PathDescriptor {
  const b = new PathBuilder();
  for (const endSign of [-1, 1] as Sign[]) {
    const apex = toXY(axis, along, endSign * (perpHalf - V_RELIEF_INSET));
    const arm1 = toXY(axis, along - V_RELIEF_HEIGHT / 2, endSign * perpHalf);
    const arm2 = toXY(axis, along + V_RELIEF_HEIGHT / 2, endSign * perpHalf);
    b.moveTo(arm1.x, arm1.y).lineTo(apex.x, apex.y).lineTo(arm2.x, arm2.y);
  }
  return { type: 'cut', tags: ['tongueFold', 'vRelief', side], segments: b.segments() };
}

/**
 * B 款舌根拓撲組裝（取代舊 buildTongueFold「兩端 9mm cut 讓位＋單一中段 halfcut」語意，
 * Slice 5 F5 整組復刻）：端段 crease（0/1/2 段，依三分支）＋中段 halfcut＋V relief（僅
 * hasDoubleRoot 壁、E′≥7.5 才生成，spec §縮放與降級表）。
 *
 * reservedSpan／apex 位置：hasDoubleRoot 壁（shortWall，前後）保留區＝V_RELIEF_INSET
 * （V relief 自己的內縮量）；非 hasDoubleRoot 壁（longWall，左右）保留區＝
 * B_TONGUE_RESERVED_LONGWALL（角撐周邊複合鏈的固定消耗）——兩者皆為 T0 固定 nominal，
 * reservedSpan＝2×(perpHalf−保留區)，逐壁獨立算（不是全域常數）。innerHalf 對過窄的牆
 * 做防禦性鉗制（Math.max(...,0)，避免負值讓 perp 區間反轉）。
 */
function buildBTongueTopology(axis: Axis, geom: WallGeom, perpHalf: number, hasDoubleRoot: boolean, side: string): PathDescriptor[] {
  const eNominal = hasDoubleRoot ? B_TONGUE_END_SHORTWALL : B_TONGUE_END_LONGWALL;
  const reserved = hasDoubleRoot ? V_RELIEF_INSET : B_TONGUE_RESERVED_LONGWALL;
  const innerHalf = Math.max(perpHalf - reserved, 0);
  const { endLen } = bTongueBranch(2 * innerHalf, eNominal);
  const along = geom.tongueFoldAlong;

  const paths: PathDescriptor[] = [];
  if (endLen > 0) {
    const c1 = toXY(axis, along, -innerHalf);
    const c2 = toXY(axis, along, -innerHalf + endLen);
    const c3 = toXY(axis, along, innerHalf - endLen);
    const c4 = toXY(axis, along, innerHalf);
    const crease = new PathBuilder().moveTo(c1.x, c1.y).lineTo(c2.x, c2.y).moveTo(c3.x, c3.y).lineTo(c4.x, c4.y).segments();
    paths.push({ type: 'crease', tags: ['tongueFold', side], segments: crease });
  }

  const halfStart = -innerHalf + endLen;
  const halfEnd = innerHalf - endLen;
  if (halfEnd - halfStart > 1e-9) {
    const h1 = toXY(axis, along, halfStart);
    const h2 = toXY(axis, along, halfEnd);
    const halfcut = new PathBuilder().moveTo(h1.x, h1.y).lineTo(h2.x, h2.y).segments();
    paths.push({ type: 'halfcut', tags: ['tongueFold', side], segments: halfcut });
  }

  if (hasDoubleRoot && endLen >= V_RELIEF_MIN_END) {
    paths.push(buildVReliefPair(axis, along, perpHalf, side));
  }
  return paths;
}

// ─────────────────────────────────────────────────────────────────────────
// A 款舌根拓撲（Slice 5 F4）：U-notch 切段取代舊「halfcut 中段＋兩端 9mm cut」讓位語意。
// ─────────────────────────────────────────────────────────────────────────

/**
 * 單一 U-notch full-cut：開口 30mm 在 alongOpening（＝tongueFoldAlong，與壁緣重合，
 * 開口本身不畫線——自然邊界，見下方 note）；沿 sign 反方向（往根部）深入 NOTCH_DEPTH
 * 到「底」26mm 直線；兩側各一個 R2 quarter arc 轉接，arc 與開口之間有一小段沿 along 軸
 * 的直線（長度＝DEPTH−R，非獨立常數）——T0 逐點對算（ARC15＋LINE101 等）反推出的精確
 * 結構：開口邊本身（30mm 跨距）沒有對應的 cut 線段，因為那個位置就是 tongueFold 本身的
 * 自然邊界（該範圍內 halfcut 也不畫，見 buildAHalfcutSegments）。
 */
function uNotchSegments(axis: Axis, alongOpening: number, sign: Sign, perpCenter: number): Segment[] {
  const halfOpen = NOTCH_OPENING / 2;
  const halfBase = NOTCH_BASE / 2;
  const alongBase = alongOpening - sign * NOTCH_DEPTH;
  const alongArcEnd = alongBase + sign * NOTCH_FILLET_R;

  const openNeg = toXY(axis, alongOpening, perpCenter - halfOpen);
  const arcEndNeg = toXY(axis, alongArcEnd, perpCenter - halfOpen);
  const baseNeg = toXY(axis, alongBase, perpCenter - halfBase);
  const basePos = toXY(axis, alongBase, perpCenter + halfBase);
  const arcEndPos = toXY(axis, alongArcEnd, perpCenter + halfOpen);
  const openPos = toXY(axis, alongOpening, perpCenter + halfOpen);

  const sweepNeg = sweepFor({ x: arcEndNeg.x - openNeg.x, y: arcEndNeg.y - openNeg.y }, { x: baseNeg.x - arcEndNeg.x, y: baseNeg.y - arcEndNeg.y });
  const sweepPos = sweepFor({ x: arcEndPos.x - basePos.x, y: arcEndPos.y - basePos.y }, { x: openPos.x - arcEndPos.x, y: openPos.y - arcEndPos.y });

  return new PathBuilder()
    .moveTo(openNeg.x, openNeg.y)
    .lineTo(arcEndNeg.x, arcEndNeg.y)
    .arcTo(NOTCH_FILLET_R, sweepNeg, baseNeg.x, baseNeg.y)
    .lineTo(basePos.x, basePos.y)
    .arcTo(NOTCH_FILLET_R, sweepPos, arcEndPos.x, arcEndPos.y)
    .lineTo(openPos.x, openPos.y)
    .segments();
}

/** 一面壁上全部 U-notch 合併成一條 cut path（centers 為空＝該壁全省，回傳 null）。 */
function buildUNotches(axis: Axis, alongOpening: number, sign: Sign, centers: number[], side: string): PathDescriptor | null {
  if (centers.length === 0) return null;
  const segments = centers.flatMap((c) => uNotchSegments(axis, alongOpening, sign, c));
  return { type: 'cut', tags: ['tongueFold', 'uNotch', side], segments };
}

/**
 * 側壁（長壁，2 notch）中心規劃（spec §縮放與降級規律）：中心＝±NOTCH_CENTER_RATIO×壁長；
 * 可容納條件＝兩中心距−開口寬≥安全邊 且 兩 notch 全形落在壁內——否則先退化為單一置中
 * notch（notch-reduced），仍放不下（壁長<開口+2×安全邊）→ 全省（notch-omitted）。
 * warning 欄位供 index.ts 對照用（本函式純幾何，不依賴它；index.ts 依同一門檻獨立重算）。
 */
function longWallNotchPlan(wallSpan: number): { centers: number[]; warning?: string } {
  const center = NOTCH_CENTER_RATIO * wallSpan;
  const halfOpen = NOTCH_OPENING / 2;
  const twoNotchFits = 2 * center - NOTCH_OPENING >= NOTCH_SAFETY_MARGIN && center + halfOpen <= wallSpan / 2;
  if (twoNotchFits) return { centers: [-center, center] };
  if (wallSpan >= NOTCH_OPENING + 2 * NOTCH_SAFETY_MARGIN) return { centers: [0], warning: 'notch-reduced' };
  return { centers: [], warning: 'notch-omitted' };
}

/** 上下壁（短壁，1 notch 置中）規劃：放不下（壁長<開口+2×安全邊）就全省。 */
function shortWallNotchPlan(wallSpan: number): { centers: number[]; warning?: string } {
  if (wallSpan >= NOTCH_OPENING + 2 * NOTCH_SAFETY_MARGIN) return { centers: [0] };
  return { centers: [], warning: 'notch-omitted' };
}

/**
 * A 款 halfcut 分段：wall 的 perp 範圍先扣掉兩端角撐周邊複合鏈消耗的 reach
 * （A_CHAIN_REACH_*，該鏈自身的固定終點，見常數註解），再扣掉每個 notch 的開口寬，
 * 剩餘區間依序畫 halfcut（notchCenters 已由呼叫端保證遞增排序）。此式對 0/1/2 個
 * notch 一致成立：邊界陣列長度＝2+2×notchCount，依序兩兩配對即為各段。
 */
function buildAHalfcutSegments(axis: Axis, along: number, perpHalf: number, chainReach: number, notchCenters: number[], side: string): PathDescriptor {
  const halfOpen = NOTCH_OPENING / 2;
  const reach = Math.min(chainReach, perpHalf);
  const boundaries = [-perpHalf + reach, ...notchCenters.flatMap((c) => [c - halfOpen, c + halfOpen]), perpHalf - reach];
  const b = new PathBuilder();
  for (let i = 0; i + 1 < boundaries.length; i += 2) {
    const gapLen = boundaries[i + 1]! - boundaries[i]!;
    if (gapLen <= 1e-9) continue; // 防禦：極端參數把某段壓到零長，略過不畫零長線
    const p1 = toXY(axis, along, boundaries[i]!);
    const p2 = toXY(axis, along, boundaries[i + 1]!);
    b.moveTo(p1.x, p1.y).lineTo(p2.x, p2.y);
  }
  return { type: 'halfcut', tags: ['tongueFold', side], segments: b.segments() };
}

/**
 * A 款舌根拓撲組裝（取代 B 款沿用的 buildTongueFold）：U-notch（依壁款 1 或 2 個，
 * 降級見 longWallNotchPlan／shortWallNotchPlan）＋halfcut 分段。notch 全省時
 * buildUNotches 回傳 null，只剩 halfcut 一條（此時 buildAHalfcutSegments 的 boundaries
 * 退化為 [start,end]，整段一條 halfcut，等同無 notch 情形下的合理簡化）。
 */
function buildATongueTopology(axis: Axis, geom: WallGeom, perpHalf: number, sign: Sign, hasDoubleRoot: boolean, side: string): PathDescriptor[] {
  const wallSpan = perpHalf * 2;
  const plan = hasDoubleRoot ? shortWallNotchPlan(wallSpan) : longWallNotchPlan(wallSpan);
  const chainReach = hasDoubleRoot ? A_CHAIN_REACH_SHORTWALL : A_CHAIN_REACH_LONGWALL;
  const notchPath = buildUNotches(axis, geom.tongueFoldAlong, sign, plan.centers, side);
  const halfcut = buildAHalfcutSegments(axis, geom.tongueFoldAlong, perpHalf, chainReach, plan.centers, side);
  return notchPath ? [notchPath, halfcut] : [halfcut];
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
  rootJog: number,
  innerWallReduction: number,
  platformWidth: number,
  sideCutStart: number,
  independentJogEntity: boolean,
): PathDescriptor[] {
  const geom = computeWallGeom(sign, alongHalfSpan, outerLen, hasDoubleRoot, rootJog, innerWallReduction, platformWidth);
  // independentJogEntity＝useThickStyle（generateTray 呼叫端傳入，見該函式）：A 款
  // （platformWidth>0）舌根用 U-notch 切段拓撲（Slice 5 F4）；B 款（platformWidth=0）
  // 用端段 crease＋中段 halfcut＋V relief 整組拓撲（Slice 5 F5，取代舊「兩端 9mm cut
  // 讓位」簡化語意，見 buildBTongueTopology）。
  const tongueParts = independentJogEntity
    ? buildATongueTopology(axis, geom, perpHalfSpan, sign, hasDoubleRoot, side)
    : buildBTongueTopology(axis, geom, perpHalfSpan, hasDoubleRoot, side);
  // A 款側邊 cut 提早收筆——該段牆緣由角落複合 relief 鏈（buildAGussetChain／
  // buildAPlatformCornerRelief）取代（見 buildWallSideCuts 註解）；B 款不變。長壁
  // （hasDoubleRoot=false）鏈從 topEndAlong 開始佔用該側邊（LINE108 一類）；短壁
  // （hasDoubleRoot=true）鏈從 topStartAlong 就開始（buildAPlatformCornerRelief 的
  // P0＝LINE39 起點，即 topStartAlong 角落端）——兩者在 P 原檔本就不對稱（見 task-3-
  // report.md 對算過程），不是筆誤。
  const sideCutEnd = !independentJogEntity ? geom.tongueFoldAlong : hasDoubleRoot ? geom.topStartAlong : geom.topEndAlong;
  return [
    buildWallRoot(axis, geom, perpHalfSpan, hasDoubleRoot, rootJog, side, independentJogEntity),
    buildWallSideCuts(axis, sign, geom, perpHalfSpan, sideCutStart, sideCutEnd, side),
    buildWallTop(axis, geom, perpHalfSpan, platformWidth, side, hasDoubleRoot),
    ...tongueParts,
    buildTongueFlap(axis, sign, geom, perpHalfSpan, side),
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// 角撐（corner gusset）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 角撐 web 與牆相連的摺線錨點：沿 x 軸（x 向牆側邊）與沿 y 軸（y 向牆側邊）
 * 各自「角落→錨點」是 crease（web 摺線）、錨點之外才是牆側邊 cut。
 * style A：兩軸對稱共用 reach＝height−wallTopCompensation（附錄 V3/V4 offset 精確相等的
 * 實證——Fix 4·2026-07-11 SOL review M4：先前殘留 height−thickness 舊公式是 T1 參數遷移
 * 漏網——T1 已把壁頂補償與 thickness 解耦，這裡沒跟上；P 實測長壁 outerWall=59.4995mm，
 * height−wallTopCompensation=59.5（差 0.0005mm ✓ 在 ±0.05 容差內），舊公式
 * height−thickness=59.56（差 0.0605mm，超容差）。兩軸相等這個既有結論不變，只修正
 * 「共用哪個公式」）。
 * style B：x 軸＝出口垂直 cut 的位置（2×reach − 出口轉角高，見 bGussetFrame p6，reach 仍用
 * height−thickness——style B 未受本次修正影響，見該函式）、y 軸＝height（生產參照
 * 45.074≈H；生產值是「tip→內縮 2mm 側邊」連線與軸線的交點，未復刻 2mm 內縮故取整為 H，
 * 殘差 74µm）。
 */
function gussetAnchors(useThickStyle: boolean, height: number, thickness: number, wallTopCompensation: number): { x: number; y: number } {
  if (useThickStyle) {
    const reach = height - wallTopCompensation;
    return { x: reach, y: reach };
  }
  const reach = height - thickness;
  return { x: 2 * reach - height * GUSSET_B_EXIT_RATIO, y: height };
}

/**
 * 厚壁角撐（style A，45° 斜角撐）——復刻生產 A 片四角實測結構：
 * 兩條 web 摺線（crease，角落沿兩軸到 V3/V4）＋ 45° 對角線（角落半段 cut、外半段
 * crease 到 tip）＋外緣斜切（cut：V4→tip→V3）。reach＝height−wallTopCompensation 兩軸
 * 共用（Fix 4·2026-07-11，見 gussetAnchors 註解——與該函式同一公式來源，呼叫端
 * 傳入同一個 wallTopCompensation 值，兩處自動同步，不會各自漂移）。
 * 生產檔另有 V3 之外的 −10° 短 cut、平台端讓位（R2.5 弧＋5mm 內縮側邊）未復刻
 * （簡化為錨點外沿軸線的直線側邊，見 task-3-report.md Fix Round 1）。
 *
 * y 軸 web 摺線起點＝offset（Slice 5 Fix2·SOL review Finding 1）：不是角落 (cornerX,cornerY)
 * 本身，是 (cornerX, cornerY+sy×rootJog)——與相鄰 y 向牆 wallRoot 的 jog 短段在 offset 端
 * 精確相接，避免兩者同線型共線重疊 rootJog（P 逐 entity 對照：LINE214/215 起點在 offset，
 * 不在 nominal 角落）。x 軸摺線（→v3）不受影響，仍從角落起筆——x 向牆沒有 jog。rootJog≤0
 * 時 Math.max(...,0) 收斂回舊行為（起點＝角落，與 v3 一致）。
 */
function buildGussetA(
  cornerX: number,
  cornerY: number,
  sx: Sign,
  sy: Sign,
  height: number,
  wallTopCompensation: number,
  rootJog: number,
  side: string,
): PathDescriptor[] {
  const reach = height - wallTopCompensation;
  const diagHalf = height * GUSSET_A_DIAG_HALF_RATIO;
  const mid = { x: cornerX + sx * diagHalf, y: cornerY + sy * diagHalf };
  const tip = { x: cornerX + sx * diagHalf * 2, y: cornerY + sy * diagHalf * 2 };
  const v3 = { x: cornerX + sx * reach, y: cornerY };
  const v4 = { x: cornerX, y: cornerY + sy * reach };
  const yFoldStart = { x: cornerX, y: cornerY + sy * Math.max(rootJog, 0) };

  const folds = new PathBuilder()
    .moveTo(cornerX, cornerY)
    .lineTo(v3.x, v3.y)
    .moveTo(yFoldStart.x, yFoldStart.y)
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
// A 款平台與角撐周邊複合 relief 鏈（Slice 5 F6-A）
// ─────────────────────────────────────────────────────────────────────────

/** (a,b) 點映射到實際座標——同 buildGussetB 的 m() 慣例：corner+sx×a+sy×b。 */
function abToXY(cornerX: number, cornerY: number, sx: Sign, sy: Sign, p: ABPt): Point {
  return { x: cornerX + sx * p.a, y: cornerY + sy * p.b };
}

/**
 * 長壁（a 方向）沿線關鍵錨點的參數化距離（自角落起量）——與 computeWallGeom 用同一組
 * 公式重算，取代 A_GUSSET_* 常數表裡對應的「T0 原始量測固定值」（59.4995/64.4984/
 * 121.2003/123.2006）。這幾個點同時也是 buildWallTop（topStartAlong／topEndAlong）
 * ／buildWallSideCuts（sideCutEnd）／notch（tongueFoldAlong）等既有參數化幾何的錨點，
 * 若鏈自己用固定量測值（含 P 量測殘差，量級 0.001–0.002mm）而非現場重算值，兩者會出現
 * 極小但非零的座標差，恰好落在 hasSelfIntersection 的 CROSS_EPS(1e-7) 之上，被誤判為
 * 真交叉（cut 自撞掃描 24 組合曾在此抓到，見 task-3-report.md）。
 */
interface LongWallAnchors {
  distOuter: number;
  distPlatformEnd: number;
  distTongueApproach: number;
  distTongueFold: number;
}

function snapALongAnchor(raw: number, anchors: LongWallAnchors): number {
  if (raw === 59.4995) return anchors.distOuter;
  if (raw === 64.4984) return anchors.distPlatformEnd;
  if (raw === 121.2003) return anchors.distTongueApproach;
  if (raw === 123.2006) return anchors.distTongueFold;
  // 138.2007（LINE94 終點）＝tongueFold 距離＋插底舌全深（TUCK_FLAP_DEPTH）——牆鏈
  // 在這個方向的絕對最深點，與 buildTongueFlap 的深度錨共用同一終點，見 hasNaN／bounds
  // 獨立公式測試（task-3-report.md：0.0007mm 量測殘差曾在此讓 bbox 錨對不上）。
  if (raw === 138.2007) return anchors.distTongueFold + TUCK_FLAP_DEPTH;
  return raw;
}

/**
 * A 款角撐周邊 13 段複合 relief 鏈（template 參數＝A_GUSSET_CHAIN_TL 或 _TR，見常數區塊
 * 與呼叫端 generateTray 的模板選擇）：逐段獨立 moveTo（鏈本身在 P 原檔含多處分岔／T 型
 * 交會，不是單一連續折線，見任務報告連通性分析）——每段依 ABLine.type 各自輸出
 * cut／crease（僅 outer 組的 outerWall 收邊線是 crease，其餘皆 cut）。
 *
 * **不縮放，固定 nominal（Fix 3·2026-07-11 SOL review M3——取代先前的無條件 a 縮放安全網）**：
 * spec §縮放與降級規律明定「細節尺寸固定 nominal」，先前版本按長壁 outerLen 比例
 * （anchors.distOuter/59.5）縮放鏈的 a 座標，對所有 H≠60 的組合都縮放（H=90→1.5×），
 * 違反這條規則——production-P（H=60）因比例恰為 1 才「看起來」正確，是假綠燈。改為固定
 * nominal＋Fix 2 的 aGussetChainFits 可容納判定（放不下就整鏈省略＋警告），不再縮放。
 *
 * **錨點校正仍保留**：snapALongAnchor 把「已知等於某既有參數化幾何點」的 5 個 a 值
 * （59.4995/64.4984/121.2003/123.2006/138.2007，兩模板字面值刻意相同，見常數區塊）換成
 * 現場重算值——這不是「縮放」，是接縫對齊：這幾點同時也是 buildWallTop／buildWallSideCuts／
 * notch 等既有參數化幾何的連接點，就算固定 nominal 下的 production-P，量測殘差
 * （量級 0.0001–0.002mm）也會讓兩邊座標出現非零但落在 CROSS_EPS(1e-7) 之上的縫，被
 * hasSelfIntersection 誤判為真交叉——這幾個「連接點」需要精確重合，其餘（鏈內部頂點）
 * 維持固定 nominal 不校正（spec 明文不從參數重建內部頂點）。
 */
/** template 的每段解出實際 (p1,p2,type)——buildAGussetChain（實際輸出）與
 *  aGussetChainFits 的自撞自檢（Fix 2）共用同一份錨點校正邏輯，避免兩處各自維護、
 *  漂移出不一致的判定。 */
function resolveAGussetChainPoints(cornerX: number, cornerY: number, sx: Sign, sy: Sign, anchors: LongWallAnchors, template: ABLine[]): Array<{ p1: Point; p2: Point; type: LineType }> {
  const resolve = (p: ABPt): ABPt => ({ a: snapALongAnchor(p.a, anchors), b: p.b });
  return template.map((l) => ({
    p1: abToXY(cornerX, cornerY, sx, sy, resolve(l.p1)),
    p2: abToXY(cornerX, cornerY, sx, sy, resolve(l.p2)),
    type: l.type,
  }));
}

function buildAGussetChain(cornerX: number, cornerY: number, sx: Sign, sy: Sign, anchors: LongWallAnchors, template: ABLine[], side: string): PathDescriptor[] {
  const byType = new Map<LineType, Segment[]>();
  for (const { p1, p2, type } of resolveAGussetChainPoints(cornerX, cornerY, sx, sy, anchors, template)) {
    const segs = byType.get(type) ?? [];
    segs.push(...new PathBuilder().moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).segments());
    byType.set(type, segs);
  }
  return [...byType.entries()].map(([type, segments]) => ({ type, tags: ['aGussetPeriphery', side], segments }));
}

/**
 * 複合 relief 鏈可容納性（Fix 2·2026-07-11 SOL review H2，取代先前的無條件 a 縮放安全網）：
 * 兩層判定都不成立才算可容納，任一層失敗＝整鏈省略＋warning（index.ts 對應
 * `gusset-relief-omitted`，同一門檻獨立重算）。
 *
 * ①**b 軸——與 U-notch 或壁界衝突**：鏈的內壁逼近段在 b 軸最深處＝A_CHAIN_REACH_LONGWALL，
 * 這是鏈從角落沿長壁佔用的區域；notch 若擺在這個區域內會與鏈真自交（S2/S3 掃描抓到，
 * 先前被測試「降級時排除 uNotch」豁免掩蓋）。壁界＝兩端鏈區不得互相重疊
 * （wallSpan≥2×reach）；notch 衝突＝任一 notch 開口邊緣不得落進鏈區。
 *
 * ②**a 軸——鏈自身不得因錨點校正而扭曲成自撞**：Fix 3 移除縮放後，鏈的 5 個已知錨點
 * （59.4995/64.4984/121.2003/123.2006/138.2007）會被 snapALongAnchor 換成現場重算值
 * （隨 height/wallTopCompensation/platformWidth/innerWallReduction 變動），但鏈的其餘
 * 內部頂點維持 T0 固定 nominal（不隨這些參數變動，spec 明文不從參數重建內部頂點）。
 * 當現場錨點值大幅偏離 T0 校準值（height=60 時 distOuter≈59.5）——例如 height 很小
 * 時錨點被壓縮到遠小於固定內部頂點、height 很大時錨點被拉伸到遠大於固定內部頂點——
 * 兩者的相對順序/間距關係跟 T0 原始設計不再一致，鏈會扭曲出真自撞（param-sweep
 * baseHeight∈{15,150} 兩端都曾在此抓到，不縮放的固定 nominal 是必然結果，不是遺漏）。
 * 用 hasSelfIntersection 直接檢查解出的鏈段（不含其餘幾何）最穩健——不必手推一條
 * 覆蓋所有參數交互作用的封閉不等式，直接量測「鏈本身還是不是一個合法形狀」。兩個模板
 * （TL／TR）分別檢查，任一自撞就整鏈（四角同時）省略——維持四角對稱，不留半邊鏈的怪狀態。
 */
function aGussetChainSelfIntersects(anchors: LongWallAnchors, template: ABLine[]): boolean {
  const segments: Segment[] = resolveAGussetChainPoints(0, 0, 1, 1, anchors, template).flatMap(({ p1, p2 }) => new PathBuilder().moveTo(p1.x, p1.y).lineTo(p2.x, p2.y).segments());
  return hasSelfIntersection(segments);
}

function aGussetChainFits(wallSpan: number, notchCenters: number[], anchors: LongWallAnchors): boolean {
  const halfOpen = NOTCH_OPENING / 2;
  const reachZoneStart = wallSpan / 2 - A_CHAIN_REACH_LONGWALL;
  if (reachZoneStart < 0) return false;
  if (!notchCenters.every((c) => Math.abs(c) + halfOpen <= reachZoneStart)) return false;
  if (aGussetChainSelfIntersects(anchors, A_GUSSET_CHAIN_TL)) return false;
  if (aGussetChainSelfIntersects(anchors, A_GUSSET_CHAIN_TR)) return false;
  return true;
}

/**
 * 平台端圓角轉接＋短壁逼近 halfcut 邊界的下探鏈（T0 逐點對算：LINE39/ARC6/LINE40＋
 * 短壁下探 3 段，六點一筆連續 cut）。platformWidth≥PLATFORM_CORNER_MIN_WIDTH 時 R2.5
 * 圓角轉接（spec §縮放與降級表）；否則降級為直角（兩短邊直接以直線相接，platform-
 * corner-omitted，警告由 index.ts 依同一門檻獨立重算）。
 *
 * **不縮放，固定 nominal（Fix 3·2026-07-11）**：p4/p5/p6（106.6976/109.6998/124.6999，
 * 鏈本身固定 offset）先前按短壁 outerLen 比例縮放，同 buildAGussetChain 違反 spec「固定
 * nominal」規則已移除。p0（LINE39 起點＝短壁 topStartAlong 角落端，與 buildWallSideCuts
 * 的 sideCutEnd 共用同一點——短壁側邊 cut 從這裡收筆，見 buildWall）／p2/p3（buildWallTop
 * 內縮 crease 端點）維持現場值（shortDistOuter／shortDistPlatformEnd 由呼叫端傳入，本來
 * 就不是常數表字面值）——避免與既有參數化幾何出現次毫米級縫隙/交叉；p1（R2.5 圓角另一端）
 * 改由 p3.b−R 現場算出，不是固定 offset——確保圓角兩端點距離恆等於 R，arcTo 幾何合法。
 */
function buildAPlatformCornerRelief(cornerX: number, cornerY: number, sx: Sign, sy: Sign, platformWidth: number, shortDistOuter: number, shortDistPlatformEnd: number, side: string): PathDescriptor {
  const pt = (a: number, b: number): Point => abToXY(cornerX, cornerY, sx, sy, { a, b });
  const p0 = abToXY(cornerX, cornerY, sx, sy, { a: 0, b: shortDistOuter });
  const p1 = abToXY(cornerX, cornerY, sx, sy, { a: 0, b: shortDistPlatformEnd - PLATFORM_CORNER_R });
  const p2 = abToXY(cornerX, cornerY, sx, sy, { a: -2.5012, b: shortDistPlatformEnd });
  const p3 = abToXY(cornerX, cornerY, sx, sy, { a: -5.0024, b: shortDistPlatformEnd });
  const p4 = pt(-5.0024, 106.6976);
  const p5 = pt(-2.0002, 109.6998);
  const p6 = pt(-2.0002, 124.6999);

  const b = new PathBuilder().moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
  if (platformWidth >= PLATFORM_CORNER_MIN_WIDTH) {
    const sweep = sweepFor({ x: p1.x - p0.x, y: p1.y - p0.y }, { x: p3.x - p2.x, y: p3.y - p2.y });
    b.arcTo(PLATFORM_CORNER_R, sweep, p2.x, p2.y);
  } else {
    b.lineTo(p2.x, p2.y);
  }
  b.lineTo(p3.x, p3.y).lineTo(p4.x, p4.y).lineTo(p5.x, p5.y).lineTo(p6.x, p6.y);
  return { type: 'cut', tags: ['platformCorner', side], segments: b.segments() };
}

// ─────────────────────────────────────────────────────────────────────────
// B 款角撐周邊（Slice 5 F6-B）：4 個 R2 quarter turn＋2mm 側邊內縮，R1.5/R5 核心
// （buildGussetB 既有幾何）不動。與 A 款「兩組手性模板＋180° 旋轉」不同——經 (a,b)
// 局部座標驗證，B 款周邊四角鏡射對稱、單一模板即可涵蓋（四角數值一致 <0.005mm，
// 任務報告驗證腳本記錄），故只需一組模板＋標準 sx/sy 鏡射實例化。
// ─────────────────────────────────────────────────────────────────────────

/** B 款角撐周邊 R2 圓角半徑（spec nominal，T0：bGussetPeripheryR measured 2.0003）。 */
const B_PERIPHERY_FILLET_R = 2.0;

/**
 * B 款角撐周邊固定 nominal 模板——**a 存偏移量、相對 distTongueFold（呼叫端傳入相鄰
 * longWall 現場算的 tongueFoldAlong 距角落距離）**，不是相對角落的絕對值（Fix wave，
 * 本 task 實作期間 hasSelfIntersection 掃描抓到的教訓）：P6 的 a 偏移恰為
 * +TUCK_FLAP_DEPTH（=15，見 buildBGussetPeriphery 呼叫端 chainAReach=distTongueFold+
 * TUCK_FLAP_DEPTH，精確、非巧合）——這證實整條鏈其實是釘在 tongueFoldAlong 這個
 * 「相鄰牆自身的既有參數化基準點」上，不是釘在角落本身；若仍用「相對角落的固定絕對值」
 * （T0 原始量測在 production-P 下的字面值），innerWallReduction 改變會讓 tongueFoldAlong
 * 位移、但模板的 a 不會跟著動，兩者錯開後 P2/P3/P4/P5 就會落進相鄰壁 buildTongueFlap
 * 的淺深矩形／45° 斜邊範圍內，造成假交叉（S1 param-sweep innerWallReduction=max(5)
 * 抓到：P3→P4 穿過 tongueFlap 淺深矩形邊、P4→P5 穿過其 45° 斜邊）。改用偏移量後，鏈
 * 的內部形狀仍是 T0 固定 nominal（spec §縮放與降級規律 1，只有「基準點」現場算，不是
 * 內部頂點被參數重建）——production-P 下（distTongueFold=89.2）偏移量還原回 T0 原始
 * 量測的絕對值，數值不變。
 *
 * P0 在壁根線（b=0）、P0→P1 為 2mm 側邊內縮、P1→P2→(R2 quarter turn)→P3 為圓角轉接、
 * P3→P4→P5 沿線接近 tongueFoldAlong（P3/P4 偏移為負＝落在 tongueFoldAlong 之前，避開
 * buildTongueFlap 的淺深矩形；P5 偏移<TUCK_FLAP_SHALLOW_DEPTH＝落在其 45° 斜邊之前）。
 * 全程一筆連續 cut（T0：lineType 皆 cut，無 crease）。
 */
const B_PERIPHERY_TEMPLATE_OFFSET: Record<'p0' | 'p1' | 'p2' | 'p3' | 'p4' | 'p5', ABPt> = {
  p0: { a: -15.4995, b: 0 },
  p1: { a: -15.4995, b: -2.0 },
  p2: { a: -3.9988, b: -2.0 },
  p3: { a: -1.9987, b: -4.0 },
  p4: { a: -1.9987, b: -9.398 },
  p5: { a: 6.7009, b: -9.398 },
};

/**
 * P6（鏈終點）的 a 偏移固定為 TUCK_FLAP_DEPTH（見模板註解）；b 不能沿用 T0 固定量測值——
 * 這個端點是鏈與相鄰 longWall 的 buildTongueFlap 全深角點的連接點（同一物理位置，兩種
 * 公式各自表述）：真正終點是 buildTongueFlap 梯形本身的轉角（recess+
 * TUCK_FLAP_SHALLOW_DEPTH，即該函式的 perpB／perpC），改由呼叫端傳入的 xWallPerpHalf
 * 現場算 recess（同 buildTongueFlap 的 Math.min(TONGUE_END_RECESS,perpHalf) 鉗制邏輯），
 * 讓 P6 與 tongueFlap 角點精確重合（觸而不穿），不再假交叉。
 */
function bPeripheryTailB(xWallPerpHalf: number): number {
  const recess = Math.min(TONGUE_END_RECESS, xWallPerpHalf);
  return -(recess + TUCK_FLAP_SHALLOW_DEPTH);
}

/**
 * B 款角撐周邊組裝：P0→P1→P2→(R2 quarter turn)→P3→P4→P5→P6 一筆連續 cut。distTongueFold＝
 * 相鄰 longWall 的 tongueFoldAlong 距角落距離（呼叫端傳入，見 generateTray 的
 * longAnchors.distTongueFold——該公式對 platformWidth=0 一樣成立，不專屬 A 款）；
 * chainAReach＝distTongueFold+TUCK_FLAP_DEPTH，供 P6 與 buildTongueFlap 全深終點對齊。
 * sweep 由 P1→P2／P3→P4 的實際切線方向外積決定（sweepFor，四個角落 sx/sy 鏡射自動得到
 * 正確凹凸向，同 buildGussetA/B、uNotchSegments 既有慣例，不手動硬編 sweep 常數）。
 */
function buildBGussetPeriphery(cornerX: number, cornerY: number, sx: Sign, sy: Sign, distTongueFold: number, xWallPerpHalf: number, side: string): PathDescriptor {
  const t = B_PERIPHERY_TEMPLATE_OFFSET;
  const resolve = (p: ABPt): ABPt => ({ a: distTongueFold + p.a, b: p.b });
  const p0 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p0));
  const p1 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p1));
  const p2 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p2));
  const p3 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p3));
  const p4 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p4));
  const p5 = abToXY(cornerX, cornerY, sx, sy, resolve(t.p5));
  const p6 = abToXY(cornerX, cornerY, sx, sy, { a: distTongueFold + TUCK_FLAP_DEPTH, b: bPeripheryTailB(xWallPerpHalf) });

  const sweep = sweepFor({ x: p2.x - p1.x, y: p2.y - p1.y }, { x: p4.x - p3.x, y: p4.y - p3.y });
  const segments = new PathBuilder()
    .moveTo(p0.x, p0.y)
    .lineTo(p1.x, p1.y)
    .lineTo(p2.x, p2.y)
    .arcTo(B_PERIPHERY_FILLET_R, sweep, p3.x, p3.y)
    .lineTo(p4.x, p4.y)
    .lineTo(p5.x, p5.y)
    .lineTo(p6.x, p6.y)
    .segments();
  return { type: 'cut', tags: ['bGussetPeriphery', side], segments };
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
  const { panelL, panelW, height, platformWidth, thickness, rootJog, innerWallReduction, wallTopCompensation } = opts;
  const halfL = panelL / 2;
  const halfW = panelW / 2;
  const useThickStyle = platformWidth > 0;
  // 角撐對角線位置（reach）：style A 用 wallTopCompensation（Fix 4·2026-07-11，見
  // gussetAnchors 註解——修正 T1 參數遷移漏網的 height−thickness 舊公式）；style B
  // 仍直接吃 thickness（未受本次修正影響，見該函式）。
  const anchors = gussetAnchors(useThickStyle, height, thickness, wallTopCompensation);

  const descriptors: PathDescriptor[] = [
    // x 向牆（左右，先摺）：單 crease 根、外壁＝height−wallTopCompensation（頂緣平齊修正，
    // F3 解耦改讀 wallTopCompensation；呼叫端分流：base 傳真實參數值、lid 恆傳 0——
    // B-06 特例移除，見 index.ts buildLidPiece）；側邊 cut 自 anchors.x 起。x 向牆
    // hasDoubleRoot=false，independentJogEntity 不生效，仍統一傳 useThickStyle 保持簽名一致。
    ...buildWall('x', -1, 'left', halfL, halfW, height - wallTopCompensation, false, rootJog, innerWallReduction, platformWidth, anchors.x, useThickStyle),
    ...buildWall('x', 1, 'right', halfL, halfW, height - wallTopCompensation, false, rootJog, innerWallReduction, platformWidth, anchors.x, useThickStyle),
    // y 向牆（前後，後摺）：階梯 jog 根（F2，中央 offset 起筆；A 款另補兩端短段接回
    // nominal、B 款不補——區間已由角撐 y 軸 web 摺線涵蓋，Slice 5 Fix2·SOL review
    // Finding 1 校正，見 buildWallRoot/buildGussetA docblock）、外壁＝height（自 jog 外線
    // 起量，base／lid 皆不作平齊補償——spec F3「前後外壁 H」兩件一致）；側邊 cut 自
    // anchors.y 起。entity 形態判準跟 useThickStyle 走——與角撐 A/B 款判準一致（生產上
    // 兩者同源於厚壁/薄壁角撐）。
    ...buildWall('y', -1, 'front', halfW, halfL, height, true, rootJog, innerWallReduction, platformWidth, anchors.y, useThickStyle),
    ...buildWall('y', 1, 'back', halfW, halfL, height, true, rootJog, innerWallReduction, platformWidth, anchors.y, useThickStyle),
  ];

  // A 款角撐周邊鏈的長壁（x 向牆）／短壁（y 向牆）錨點距離（自角落沿各自 along 軸），
  // 與 computeWallGeom 同公式重算——供 buildAGussetChain/buildAPlatformCornerRelief
  // 把常數表的固定量測值換成現場值，見 snapALongAnchor 註解。x 向牆 hasDoubleRoot=false
  // 恆無 jog；y 向牆 hasDoubleRoot=true，距離自 root_nominal 起量須含 rootJog。
  const longOuterLen = height - wallTopCompensation;
  const longAnchors: LongWallAnchors = {
    distOuter: longOuterLen,
    distPlatformEnd: longOuterLen + platformWidth,
    distTongueApproach: longOuterLen + platformWidth + (longOuterLen - innerWallReduction) - 2,
    distTongueFold: longOuterLen + platformWidth + (longOuterLen - innerWallReduction),
  };
  const shortDistOuter = rootJog + height;
  const shortDistPlatformEnd = shortDistOuter + platformWidth;

  // 複合 relief 鏈可容納性（Fix 2）：長壁（x 向牆，2-notch）span＝panelW，與 buildATongueTopology
  // 內部呼叫 longWallNotchPlan 用同一輸入——這裡重算一次（純函式，成本可忽略）取得目前實際
  // 會生成的 notch 中心列，供 aGussetChainFits 判斷放不放得下；不可容納時整鏈省略＋
  // index.ts 對應 warning（同一門檻獨立重算，見該檔 gussetChainFits）。
  const chainFits = useThickStyle ? aGussetChainFits(panelW, longWallNotchPlan(panelW).centers, longAnchors) : true;

  for (const { sx, sy, label } of CORNERS) {
    const cornerX = sx * halfL;
    const cornerY = sy * halfW;
    descriptors.push(
      ...(useThickStyle
        ? buildGussetA(cornerX, cornerY, sx, sy, height, wallTopCompensation, rootJog, label)
        : buildGussetB(cornerX, cornerY, sx, sy, height, thickness, label)),
    );
    if (useThickStyle) {
      // A 款平台端＋角撐周邊複合 relief 鏈（Slice 5 F6-A；Fix 1 兩手性模板）：對角角落配對
      // （left-front↔right-back、right-front↔left-back）各自 180° 旋轉——sx===sy 的兩角
      // （left-front、right-back）用 topLeft 模板，sx!==sy 的兩角（right-front、left-back）
      // 用 topRight 模板（見常數區塊 A_GUSSET_CHAIN_TL/_TR 註解：相鄰角落不是同一模板的鏡射，
      // 是獨立量測的不同拓撲）。
      if (chainFits) {
        const template = sx === sy ? A_GUSSET_CHAIN_TL : A_GUSSET_CHAIN_TR;
        descriptors.push(...buildAGussetChain(cornerX, cornerY, sx, sy, longAnchors, template, label));
      }
      descriptors.push(buildAPlatformCornerRelief(cornerX, cornerY, sx, sy, platformWidth, shortDistOuter, shortDistPlatformEnd, label));
    } else {
      // B 款角撐周邊（Slice 5 F6-B）：單一模板四角鏡射對稱，見 buildBGussetPeriphery 區塊註解。
      // distTongueFold＝longAnchors.distTongueFold（相鄰 x 向牆——即 longWall——自己的
      // tongueFoldAlong 距角落距離，該公式對 platformWidth=0 一樣成立）；xWallPerpHalf＝
      // halfW，供 P6 與該牆 buildTongueFlap 角點精確重合（見 bPeripheryTailB）。
      descriptors.push(buildBGussetPeriphery(cornerX, cornerY, sx, sy, longAnchors.distTongueFold, halfW, label));
    }
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
