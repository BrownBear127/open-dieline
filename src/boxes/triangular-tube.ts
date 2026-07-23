/**
 * 三角盒（Triangular Tube Box）—— 近等邊三角柱盒型的刀模模組。
 *
 * 盒身為三側面 Face A/B/C 沿管長（tubeLength）方向堆疊的三角柱；一端以 Zone D
 * friction-lock 插舌穿 A/B 邊界中央插槽鎖縱縫，兩端以「等邊內三角＋上下外翼插舌」封端口。
 * 座標鏈依三個參考尺寸的原刀模量測值忠實復刻（1pt=0.352778mm
 * 換算後 local mm）：左端 hinge→local x=0、右端 hinge→x=tubeLength、Face A 自由邊→y=0、
 * 剖面沿 +y 堆疊（A[0,edgeA] / B[edgeA,edgeA+edgeB] / C[..+edgeC] / Zone D 於 C 之後）。
 *
 * 剖面縮窄為單一尺度 `edgeA`（`edgeB=edgeA+1.5`／`edgeC=edgeA+2.5` 固定差值·近等邊族·
 * 三個參考尺寸全屬此族）＋獨立 `tubeLength`。三稜邊異角補償尚未經實體打樣驗證，
 * 本模組一律 thickness=0 建構（不暴露 thickness 參數），幾何在 t=0 下正確。
 *
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 * 外框封閉式與穿入比例封閉式的殘差極小（外框 <0.011mm·穿入比例 <0.2µm），係依三個參考尺寸逆向擬合得出。
 */

import type { Segment } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import type { BoxInvariant, BoxModule, BoxParamDef, DielinePath, DielineText, GenerateResult, LineType, ResolvedParams } from '@/core/types';
import { registerBox } from '@/core/registry';
import { hasSelfIntersection, segmentsBounds } from '@/core/geometry';
import { dimensionLine } from '@/core/primitives';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數（依原刀模量測值正規化）
// ─────────────────────────────────────────────────────────────────────────

// 剖面派生差值（三個參考尺寸固定·近等邊族）
const EDGE_B_DELTA = 1.5; // edgeB = edgeA + 1.5
const EDGE_C_DELTA = 2.5; // edgeC = edgeA + 2.5

// 固定製程常數（三個參考尺寸變異 <0.01mm·與盒尺寸脫鉤）
const BRIDGE_LEN = 4.999; // A/B 邊界橋接段
const RAMP_X_PROJ = 3.0; // A/B 斜坡 x 投影
const SLOT_OFFSET = 0.799; // 插槽相對 A/B 摺線的偏移（向 Face A 方向）
const NOTCH_WIDTH = 25.0; // Zone D 尖舌根部中央凹槽寬
const NOTCH_JOG_ABOVE = 0.699; // 凹槽垂直豁口頂（在 base 底之上·三個參考尺寸一致）
const NOTCH_FLOOR_BELOW = 0.801; // 凹槽底（在 base 底之下·NOTCH_JOG_ABOVE+此=1.5=notchJog）
const TAB_SLOT_MARGIN = 16.0; // 插舌與插槽配對機構的固定寬度差（slotWidth = tabWidth − 16·三個參考尺寸一致）
const TAB_SHOULDER_DEPTH = 7.0; // Zone D 肩部深（tabDepth override 時的分配比例分子·預設段深 7）
const TAB_TIP_DEPTH = 8.0; // Zone D 錐尖深（tabDepth override 時的分配比例分子·預設段深 8）
const TAB_INSERT_TOTAL = TAB_SHOULDER_DEPTH + TAB_TIP_DEPTH; // 插舌插入段（肩+錐尖）預設總深 15
const RELIEF_HINGE_END = 0.5; // 主 hinge 端點 relief（×4·H/Hb 距面角）
const RELIEF_BRIDGE_END = 0.7; // 橋接段 relief（×2·懸於 A/B 線下的豁口深）
const SHOULDER_TICK = 2.83; // 上翼片肩部折角（僅上翼有）
const HINGE_CORNER_GAP = 0.433; // corner→H 沿 d1 縮回（固定製程常數）
const WING_BASE_SEG_DEFAULT = 15.0; // 外翼 tick 切分預設值（無封閉式·經評估接受的近似·僅影響裝飾性缺口位置·摺後藏於內側）
const WING_SEG_CLAMP_MARGIN = 3.0; // tick 距 H/P3 的最小安全餘量

// 剖面驅動係數（依三個參考尺寸擬合·殘差 <0.02mm）
const TRIANGLE_SIDE_DELTA = 0.25; // triangleSide = edgeB − 0.25（等邊·非 Heron）
const APEX_HEIGHT_RATIO = 0.86603; // √3/2（等邊高）
const TAB_BASE_DEPTH_DELTA = 0.5; // tabBaseDepth = edgeC + 0.5（基座＝蓋面·隨剖面 derived·不暴露）
const CENTRAL_ZONE_DELTA = 19.0; // tabWidth derivedDefault = edgeC + 19（未 override 時 slotWidth 還原 edgeC+3）
const TOP_LONG_EDGE_DELTA = 0.76; // topLongEdge = edgeA − 0.76（上插舌長邊·伸入 Face A）
const BOT_LONG_EDGE_DELTA = 1.25; // botLongEdge = edgeC − 1.25（下插舌長邊·伸入 Face C）
// 主 hinge 摺線長 flapMainHingeLen = edgeB − 1，隱含由 H/Hb 兩端各縮 RELIEF_HINGE_END(0.5) 得出。
const WING_REACH_SLOPE = 0.6649; // WING_REACH = 0.6649·edgeB + 0.2426（經評估接受的近似·來自兩個獨立參考尺寸的線性擬合）
const WING_REACH_INTERCEPT = 0.2426;

// 合法域常數
const TUBELENGTH_SAFETY_MARGIN = 3.0; // 額外餘量·保 abEndCrease≥1.5（端封摺線不退化）；tubeLength 下限依 slotWidth 動態算
const EDGEA_MATH_MIN = 1.5; // edgeA 數學下限（三角不等式代數解·UI min 20 已涵蓋）
const INSERTION_RATIO_MIN = 0.3; // 穿入比例合法下限
const INSERTION_RATIO_MAX = 0.95; // 穿入比例合法上限
const TAB_ROOT_MIN = 1.0; // 凹槽兩側 tab 根摺線最小長度（插舌寬下限＝notch 25 + 2×此）
const TAB_INSERT_MIN = 6.0; // 插舌插入段（肩+錐尖）最小總深（淺於此鎖扣失效風險）

// 方向向量家族（三個參考尺寸 <0.01°·右端；左端 X 分量取負）
type Vec = readonly [number, number];
const SIN60 = 0.8660254;
const D1: Vec = [0.5, -SIN60]; // −60°（上翼 base/third/apex 回邊）
const D2: Vec = [SIN60, 0.5]; // +30°（⊥ d1·topLongEdge 方向）
const D1M: Vec = [0.5, SIN60]; // +60°（下翼單一路徑）
const D2M: Vec = [SIN60, -0.5]; // −30°（botLongEdge 方向）
const TICK: Vec = [Math.cos((-15 * Math.PI) / 180), Math.sin((-15 * Math.PI) / 180)]; // −15°

type Pt = readonly [number, number];
/** p + s·v（沿方向 v 走 s；sgn 對 x 分量鏡射：+1 右端、−1 左端）。 */
function step(p: Pt, v: Vec, s: number, sgn: 1 | -1): Pt {
  return [p[0] + sgn * v[0] * s, p[1] + v[1] * s];
}

// ─────────────────────────────────────────────────────────────────────────
// 參數宣告
// ─────────────────────────────────────────────────────────────────────────
//
// 只宣告「真正驅動幾何」的欄位：每個宣告參數取第二有效值都必須改變輸出，否則屬未接線的假旋鈕。
// edgeA（單一剖面尺度）＋tubeLength；edgeB/edgeC 為 derived（不暴露·固定差值）；
// thickness 鎖 0 不暴露（三稜異角補償待實體打樣驗證）。
const params: BoxParamDef[] = [
  {
    key: 'edgeA',
    label: { zh: '三角邊長 (A)', en: 'Cross-section edge (A)' },
    unit: 'mm',
    default: 58.5,
    min: 20,
    max: 250,
    step: 1,
    group: { id: 'dimensions', zh: '尺寸', en: 'Dimensions' },
    description: {
      zh: '三角形的基準邊長，決定三側面寬度（另兩邊為 A+1.5／A+2.5 的近等邊三角形），也決定端封三角與外翼、尖端插舌全部尺寸。',
      en: 'Base edge of the triangular cross-section; sets the three face widths (the other two are A+1.5 and A+2.5, a near-equilateral triangle) and scales the end-seal triangle, wings, and the tapered tab.',
    },
    highlightTags: ['edgeA'],
  },
  {
    key: 'tubeLength',
    label: { zh: '盒身長度 (L)', en: 'Tube length (L)' },
    unit: 'mm',
    default: 135,
    min: 30,
    max: 500,
    step: 1,
    group: { id: 'dimensions', zh: '尺寸', en: 'Dimensions' },
    description: {
      zh: '三角形盒身沿軸向的長度（兩端封口之間的距離），決定盒身高度與 A/B 邊界端摺線（abEndCrease）長度。',
      en: 'Axial length of the triangular body (distance between the two end seals); sets the body height and the A/B boundary end-crease (abEndCrease) length.',
    },
    highlightTags: ['tubeLength'],
  },
  {
    // 插舌寬度（tab 基座寬 centralZoneWidth）：預設隨剖面 derived（edgeC+19），可 override 獨立調整。
    // 配對的中央插槽（插舌孔）隨動 slotWidth = tabWidth − 16——舌為主、孔跟隨，連帶 abEndCrease／
    // 穿入比例／tubeLength 下限全鏈隨動。未覆寫＝精確復刻原刀模。
    key: 'tabWidth',
    label: { zh: '插舌寬度', en: 'Tab width' },
    unit: 'mm',
    default: 80, // = derived @ edgeA=58.5（edgeC+19）；derivedDefault 隨 edgeA 重算
    min: 30,
    max: 300,
    step: 0.5,
    group: { id: 'tabLock', zh: '插舌與鎖扣', en: 'Tab & lock' },
    description: {
      zh: '插舌基座的寬度；配對的中央插槽寬度隨之改變（兩者差固定 16mm）。預設隨三角尺寸自動換算，可自行調整。',
      en: 'Width of the tab base; the paired central slot width follows it (a fixed 16mm difference). Defaults to a value derived from the cross-section and can be adjusted independently.',
    },
    highlightTags: ['zoneD', 'abSlot'],
    derivedDefault: (p) => (p.edgeA as number) + EDGE_C_DELTA + CENTRAL_ZONE_DELTA,
  },
  {
    // 插舌深度（插入段＝肩+錐尖總深）：預設固定 15（7+8），可 override 獨立調整（按 7:8 分配兩段）。
    // 基座深（蓋面）回歸 edgeC+0.5 derived·不受此參數影響（基座摺過去是盒身結構）。
    key: 'tabDepth',
    label: { zh: '插舌深度', en: 'Tab depth' },
    unit: 'mm',
    default: 15, // = 肩 7 + 錐尖 8（固定·不隨 edgeA）
    min: 6,
    max: 60,
    step: 0.5,
    group: { id: 'tabLock', zh: '插舌與鎖扣', en: 'Tab & lock' },
    description: {
      zh: '插舌插入插槽的段深（收窄段＋尖端·預設 15mm），兩段以固定比例分配；可自行調整。',
      en: 'Depth of the tab’s insertion segment (shoulder plus tapered tip); the two parts split by a fixed ratio. Defaults to 15mm and can be adjusted independently.',
    },
    highlightTags: ['zoneD'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 派生尺寸（單一來源·generate 與 invariant 共用）
// ─────────────────────────────────────────────────────────────────────────

interface Derived {
  edgeA: number;
  edgeB: number;
  edgeC: number;
  tubeLength: number;
  triangleSide: number;
  flapApexHeight: number;
  flapApexOffset: number;
  slotWidth: number;
  tabBaseDepth: number;
  tabShoulderDepth: number;
  tabTipDepth: number;
  centralZoneWidth: number;
  topLongEdge: number;
  botLongEdge: number;
  wingReach: number;
  abEndCrease: number;
  insertionRatio: number;
}

// 插舌參數（derived-default 可 override）：
//  · tabWidth＝插舌基座寬（centralZoneWidth）；配對的插槽隨動 slotWidth = tabWidth − TAB_SLOT_MARGIN
//    （未 override 時 tabWidth=edgeC+19 → slotWidth=edgeC+3·精確復刻）。
//  · tabDepth＝插舌插入段（肩+錐尖）總深；按 7:8 分配兩段。基座深（蓋面）回歸 edgeC+0.5 derived·不受此參數影響。
function derive(edgeA: number, tubeLength: number, tabWidth: number, tabDepth: number): Derived {
  const edgeB = edgeA + EDGE_B_DELTA;
  const edgeC = edgeA + EDGE_C_DELTA;
  const triangleSide = edgeB - TRIANGLE_SIDE_DELTA;
  const centralZoneWidth = tabWidth;
  const slotWidth = tabWidth - TAB_SLOT_MARGIN;
  return {
    edgeA,
    edgeB,
    edgeC,
    tubeLength,
    triangleSide,
    flapApexHeight: triangleSide * APEX_HEIGHT_RATIO,
    flapApexOffset: triangleSide / 2,
    slotWidth,
    tabBaseDepth: edgeC + TAB_BASE_DEPTH_DELTA,
    tabShoulderDepth: (tabDepth * TAB_SHOULDER_DEPTH) / TAB_INSERT_TOTAL,
    tabTipDepth: (tabDepth * TAB_TIP_DEPTH) / TAB_INSERT_TOTAL,
    centralZoneWidth,
    topLongEdge: edgeA - TOP_LONG_EDGE_DELTA,
    botLongEdge: edgeC - BOT_LONG_EDGE_DELTA,
    wingReach: WING_REACH_SLOPE * edgeB + WING_REACH_INTERCEPT,
    abEndCrease: (tubeLength - slotWidth - 2 * BRIDGE_LEN - 2 * RAMP_X_PROJ) / 2,
    insertionRatio: slotWidth / centralZoneWidth,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────────────────

function addPath(paths: DielinePath[], type: LineType, tags: string[], segments: Segment[]): void {
  if (segments.length === 0) return;
  paths.push({ id: `p-${paths.length}`, type, segments, tags: tags.length ? tags : undefined });
}

/** 一端端封（三角 crease + 上下外翼 cut + hinge relief）的所有幾何。sgn=+1 右端(hingeX=tubeLength)、−1 左端(hingeX=0)。 */
interface EndFlap {
  H: Pt;
  Hb: Pt;
  apex: Pt;
  corner1: Pt;
  corner2: Pt;
  upperWing: Segment[]; // H→P1→P2→P3→P4→apex（含 hinge relief 前綴）
  lowerWing: Segment[]; // apex→Q2→Q1→Hb
  hingeRel010: Segment[]; // 兩段 hinge relief（Face A 邊→H·Hb→Face C 邊）
}

function buildEndFlap(d: Derived, hingeX: number, sgn: 1 | -1): EndFlap {
  const yAB = d.edgeA;
  const yBC = d.edgeA + d.edgeB;
  const faceBmid = d.edgeA + d.edgeB / 2;

  const H: Pt = [hingeX, yAB + RELIEF_HINGE_END];
  const Hb: Pt = [hingeX, yBC - RELIEF_HINGE_END];
  const cornerX = hingeX + sgn * HINGE_CORNER_GAP * 0.5;
  const corner1: Pt = [cornerX, faceBmid - d.flapApexOffset];
  const corner2: Pt = [cornerX, faceBmid + d.flapApexOffset];
  const apex: Pt = [hingeX + sgn * (HINGE_CORNER_GAP * 0.5 + d.flapApexHeight), faceBmid];

  // 外翼四遠端頂點封閉式——P3 由 H 沿 d1/d2 定位·不依賴 tick 切分。
  const P3 = step(step(H, D1, d.wingReach, sgn), D2, SHOULDER_TICK / Math.SQRT2, sgn);
  const P4 = step(P3, D2, d.topLongEdge, sgn);
  const Q1 = step(Hb, D1M, d.wingReach, sgn);
  const Q2 = step(Q1, D2M, d.botLongEdge, sgn);

  // tick 切分為自由參數（無封閉式）：wingBaseSeg 預設 15·clamp 保 tick 距 H/P3 各 ≥3。
  const sum13 = d.wingReach - SHOULDER_TICK / Math.SQRT2; // = wingBaseSeg + thirdSeg 的 d1 投影和
  const wingBaseSeg = Math.max(WING_SEG_CLAMP_MARGIN, Math.min(WING_BASE_SEG_DEFAULT, sum13 - WING_SEG_CLAMP_MARGIN));
  const P1 = step(H, D1, wingBaseSeg, sgn);
  const P2 = step(P1, TICK, SHOULDER_TICK, sgn);

  const upperWing = new PathBuilder()
    .moveTo(H[0], H[1])
    .lineTo(P1[0], P1[1])
    .lineTo(P2[0], P2[1])
    .lineTo(P3[0], P3[1])
    .lineTo(P4[0], P4[1])
    .lineTo(apex[0], apex[1])
    .segments();
  const lowerWing = new PathBuilder()
    .moveTo(apex[0], apex[1])
    .lineTo(Q2[0], Q2[1])
    .lineTo(Q1[0], Q1[1])
    .lineTo(Hb[0], Hb[1])
    .segments();
  // hinge relief（Face A 邊底→H·Hb→Face C 邊頂）——把兩條 0.5 relief 接進外框。
  const hingeRel010 = [
    ...new PathBuilder().moveTo(hingeX, yAB).lineTo(H[0], H[1]).segments(),
    ...new PathBuilder().moveTo(Hb[0], Hb[1]).lineTo(hingeX, yBC).segments(),
  ];

  return { H, Hb, apex, corner1, corner2, upperWing, lowerWing, hingeRel010 };
}

function generate(p: ResolvedParams): GenerateResult {
  const edgeA = p.edgeA as number;
  const tubeLength = p.tubeLength as number;
  const d = derive(edgeA, tubeLength, p.tabWidth as number, p.tabDepth as number);

  const yFaceA = 0;
  const yAB = d.edgeA;
  const yBC = d.edgeA + d.edgeB;
  const yCD = d.edgeA + d.edgeB + d.edgeC;
  const yZoneBaseBot = yCD + d.tabBaseDepth;
  const yShoulderBot = yZoneBaseBot + d.tabShoulderDepth;
  const yApexD = yShoulderBot + d.tabTipDepth;
  const tubeCenter = tubeLength / 2;

  const paths: DielinePath[] = [];
  const texts: DielineText[] = [];
  const push = (type: LineType, tags: string[], segments: Segment[]) => addPath(paths, type, tags, segments);

  // ── 全長摺線 B/C、C/D（貫穿全長水平線：y 位置隨 edgeA、長度隨 tubeLength·雙掛）──
  push('crease', ['edgeA', 'tubeLength', 'bcCrease', 'fold:faceB>faceC'], new PathBuilder().moveTo(0, yBC).lineTo(tubeLength, yBC).segments());
  push('crease', ['edgeA', 'tubeLength', 'cdCrease', 'fold:faceC>zoneDBase'], new PathBuilder().moveTo(0, yCD).lineTo(tubeLength, yCD).segments());

  // ── A/B 邊界複合結構（兩端 crease + 橋接 + 斜坡 + 中央插槽 cut）────────
  // A/B crease 兩端（y 位置隨 edgeA、長度/位置隨 tubeLength·雙掛）
  push('crease', ['edgeA', 'tubeLength', 'abCrease', 'fold:faceA>faceB'], new PathBuilder().moveTo(0, yAB).lineTo(d.abEndCrease, yAB).segments());
  push('crease', ['edgeA', 'tubeLength', 'abCrease', 'fold:faceA>faceB'], new PathBuilder().moveTo(tubeLength - d.abEndCrease, yAB).lineTo(tubeLength, yAB).segments());
  // 中央插槽複合 cut（左 relief → 橋接 → 斜坡 → 插槽 → 斜坡 → 橋接 → 右 relief·單一連續路徑·兩端 relief 末端 degree-1）
  const bridgeL = d.abEndCrease;
  const bridgeR = tubeLength - d.abEndCrease;
  const slotL = bridgeL + BRIDGE_LEN + RAMP_X_PROJ;
  const slotR = bridgeR - BRIDGE_LEN - RAMP_X_PROJ;
  const ySlot = yAB - SLOT_OFFSET;
  push(
    'cut',
    ['edgeA', 'tubeLength', 'abSlot'],
    new PathBuilder()
      .moveTo(bridgeL, yAB + RELIEF_BRIDGE_END) // 左 relief 末端（懸於 A/B 線下·degree-1）
      .lineTo(bridgeL, yAB)
      .lineTo(bridgeL + BRIDGE_LEN, yAB) // 橋接
      .lineTo(slotL, ySlot) // 斜坡
      .lineTo(slotR, ySlot) // 插槽（穿孔 cut）
      .lineTo(bridgeR - BRIDGE_LEN, yAB) // 斜坡
      .lineTo(bridgeR, yAB) // 橋接
      .lineTo(bridgeR, yAB + RELIEF_BRIDGE_END) // 右 relief 末端（degree-1）
      .segments(),
  );

  // ── 端封（左右）：三角 crease + 上下外翼 + hinge relief ────────────────
  for (const [hingeX, sgn, side] of [[tubeLength, 1 as const, 'End'], [0, -1 as const, 'Start']] as const) {
    const ef = buildEndFlap(d, hingeX, sgn);
    // 端封內三角兩邊 crease（apex→corner1·apex→corner2）
    push('crease', ['edgeA', 'endTriangle', `fold:end${side}Main>end${side}WingTop`], new PathBuilder().moveTo(ef.apex[0], ef.apex[1]).lineTo(ef.corner1[0], ef.corner1[1]).segments());
    push('crease', ['edgeA', 'endTriangle', `fold:end${side}Main>end${side}WingBottom`], new PathBuilder().moveTo(ef.apex[0], ef.apex[1]).lineTo(ef.corner2[0], ef.corner2[1]).segments());
    // 主 hinge 摺線（H→Hb·長 flapMainHingeLen=edgeB−1）
    push('crease', ['edgeA', 'hingeCrease', `fold:faceB>end${side}Main`], new PathBuilder().moveTo(ef.H[0], ef.H[1]).lineTo(ef.Hb[0], ef.Hb[1]).segments());
    // 外翼 cut（上/下）＋ hinge relief（接進外框）
    push('cut', ['edgeA', 'endWing'], ef.upperWing);
    push('cut', ['edgeA', 'endWing'], ef.lowerWing);
    push('cut', ['edgeA', 'sideEdge'], ef.hingeRel010);
    // Face A 側邊 cut（自由邊角→hinge 上 relief 起點）
    push('cut', ['edgeA', 'sideEdge'], new PathBuilder().moveTo(hingeX, yFaceA).lineTo(hingeX, yAB).segments());
    // Face C 側邊 cut（hinge 下 relief 終點→C/D）＋ Zone D base 側邊 cut
    push('cut', ['edgeA', 'sideEdge'], new PathBuilder().moveTo(hingeX, yBC).lineTo(hingeX, yCD).segments());
    push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(hingeX, yCD).lineTo(hingeX, yZoneBaseBot).segments());
  }

  // ── Face A 自由邊（管長頂）────────────────────────────────────────────
  push('cut', ['tubeLength', 'faceFree'], new PathBuilder().moveTo(0, yFaceA).lineTo(tubeLength, yFaceA).segments());

  // ── Zone D 尖舌（base 底 + tab root crease + notch + 肩 + 錐尖）────────
  const tabRootStart = tubeCenter - d.centralZoneWidth / 2;
  const tabRootEnd = tubeCenter + d.centralZoneWidth / 2;
  const notchStart = tubeCenter - NOTCH_WIDTH / 2;
  const notchEnd = tubeCenter + NOTCH_WIDTH / 2;
  // base 底外側 cut（tab 兩旁）
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(0, yZoneBaseBot).lineTo(tabRootStart, yZoneBaseBot).segments());
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(tabRootEnd, yZoneBaseBot).lineTo(tubeLength, yZoneBaseBot).segments());
  // tab root crease（notch 兩側·長 tabRootCreaseLen）
  push('crease', ['edgeA', 'tabRootCrease', 'fold:zoneDBase>zoneDTab'], new PathBuilder().moveTo(tabRootStart, yZoneBaseBot).lineTo(notchStart, yZoneBaseBot).segments());
  push('crease', ['edgeA', 'tabRootCrease', 'fold:zoneDBase>zoneDTab'], new PathBuilder().moveTo(notchEnd, yZoneBaseBot).lineTo(tabRootEnd, yZoneBaseBot).segments());
  // notch（U 形 relief·兩 jog 頂 degree-1）
  push(
    'cut',
    ['edgeA', 'zoneDNotch'],
    new PathBuilder()
      .moveTo(notchStart, yZoneBaseBot - NOTCH_JOG_ABOVE) // 左 jog 頂（degree-1）
      .lineTo(notchStart, yZoneBaseBot + NOTCH_FLOOR_BELOW)
      .lineTo(notchEnd, yZoneBaseBot + NOTCH_FLOOR_BELOW) // 凹槽底
      .lineTo(notchEnd, yZoneBaseBot - NOTCH_JOG_ABOVE) // 右 jog 頂（degree-1）
      .segments(),
  );
  // 肩 + 錐尖（tab 外框·左右肩邊→錐尖單點）
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(tabRootStart, yZoneBaseBot).lineTo(tabRootStart, yShoulderBot).segments());
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(tabRootEnd, yZoneBaseBot).lineTo(tabRootEnd, yShoulderBot).segments());
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(tabRootStart, yShoulderBot).lineTo(tubeCenter, yApexD).segments());
  push('cut', ['edgeA', 'zoneD'], new PathBuilder().moveTo(tabRootEnd, yShoulderBot).lineTo(tubeCenter, yApexD).segments());

  // ── 標註尺寸（tubeLength 水平 + edgeA/B/C 三段垂直·對齊 RTE addDim 慣例）──
  const addDim = (
    dx1: number,
    dy1: number,
    dx2: number,
    dy2: number,
    labelVal: number,
    offset: number,
    tag: string,
    orientation: 'h' | 'v',
  ) => {
    const { paths: dimPaths, text } = dimensionLine(dx1, dy1, dx2, dy2, `${labelVal.toFixed(0)}mm`, offset, orientation);
    push('dimension', [tag], dimPaths);
    texts.push({ id: `t-${texts.length}`, x: text.x, y: text.y, text: text.text, rotation: text.rotation, fontSize: 3.5, anchor: 'middle' });
  };
  const faceBmid = d.edgeA + d.edgeB / 2;
  const vDimX = -(d.flapApexHeight + 22); // 垂直尺寸線置於左翼尖外側（清空區）
  addDim(0, faceBmid, tubeLength, faceBmid, tubeLength, 0, 'tubeLength', 'h'); // 管長
  addDim(vDimX, yFaceA, vDimX, yAB, d.edgeA, 0, 'edgeA', 'v'); // Face A
  addDim(vDimX, yAB, vDimX, yBC, d.edgeB, 0, 'edgeA', 'v'); // Face B
  addDim(vDimX, yBC, vDimX, yCD, d.edgeC, 0, 'edgeA', 'v'); // Face C

  // ── Bounds ─────────────────────────────────────────────────────────────
  const margin = 20;
  const allSegs = paths.flatMap((pp) => pp.segments);
  const gb = segmentsBounds(allSegs);
  const bounds = {
    minX: gb.minX - margin,
    maxX: gb.maxX + margin,
    minY: gb.minY - margin,
    maxY: gb.maxY + margin,
  };

  return { paths, texts, bounds };
}

// ─────────────────────────────────────────────────────────────────────────
// 不變式
// ─────────────────────────────────────────────────────────────────────────

const invariants: BoxInvariant[] = [
  {
    id: 'friction-lock-insertion',
    severity: 'error',
    description: {
      zh: '尖端插舌穿中央插槽的鎖定：插槽寬與插舌寬之比介於 [0.30, 0.95]——太小鎖不住、太大插舌整段穿過會鬆。插槽寬隨插舌寬改變（slotWidth = tabWidth − 16），比例＝(tabWidth−16)/tabWidth·只由插舌寬決定。',
    },
    check(params) {
      const d = derive(params.edgeA as number, params.tubeLength as number, params.tabWidth as number, params.tabDepth as number);
      if (d.insertionRatio < INSERTION_RATIO_MIN || d.insertionRatio > INSERTION_RATIO_MAX) {
        return {
          ok: false,
          message: {
            zh: `friction-lock 穿入比例 ${d.insertionRatio.toFixed(3)} 需介於 [${INSERTION_RATIO_MIN}, ${INSERTION_RATIO_MAX}]（插槽寬 ${d.slotWidth.toFixed(1)} / 插舌寬 ${d.centralZoneWidth.toFixed(1)}）`,
            en: `Friction-lock insertion ratio ${d.insertionRatio.toFixed(3)} must be within [${INSERTION_RATIO_MIN}, ${INSERTION_RATIO_MAX}] (slot ${d.slotWidth.toFixed(1)} / tab ${d.centralZoneWidth.toFixed(1)}).`,
          },
          tags: ['tabWidth'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'tab-base-geometry',
    severity: 'error',
    description: {
      zh: '插舌寬須容得下中央缺口（≥ 缺口寬 25mm + 兩側根摺線）且不超過盒身寬（否則基座切出盒身、base 底摺線自撞）；插舌深（收窄段+尖端的插入段）須 ≥ 6mm（小於此鎖扣失效）。',
    },
    check(params) {
      const tabWidth = params.tabWidth as number;
      const tabDepth = params.tabDepth as number;
      const tubeLength = params.tubeLength as number;
      const minWidth = NOTCH_WIDTH + 2 * TAB_ROOT_MIN;
      if (tabWidth < minWidth - 1e-6 || tabWidth > tubeLength + 1e-6 || tabDepth < TAB_INSERT_MIN - 1e-6) {
        return {
          ok: false,
          message: {
            zh: `插舌幾何越界：寬 ${tabWidth}mm 需 ∈ [${minWidth.toFixed(1)}, 盒身寬 ${tubeLength}]、插入段深 ${tabDepth}mm 需 ≥ ${TAB_INSERT_MIN}mm`,
            en: `Tab geometry out of range: width ${tabWidth}mm must be in [${minWidth.toFixed(1)}, tube length ${tubeLength}] and insertion depth ${tabDepth}mm must be ≥ ${TAB_INSERT_MIN}mm.`,
          },
          tags: ['tabWidth', 'tabDepth'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'tube-length-valid',
    severity: 'error',
    description: {
      zh: '盒身長度須 ≥ slotWidth + 18.998——數學下限 slotWidth+15.998 保 A/B 端摺線 abEndCrease≥0，額外 3.0 安全餘量保 abEndCrease≥1.5。slotWidth 隨插舌寬改變（=tabWidth−16），下限隨之計算，插舌寬變大時同步提高。',
    },
    check(params) {
      const d = derive(params.edgeA as number, params.tubeLength as number, params.tabWidth as number, params.tabDepth as number);
      const floor = d.slotWidth + 2 * BRIDGE_LEN + 2 * RAMP_X_PROJ + TUBELENGTH_SAFETY_MARGIN;
      if (d.tubeLength < floor - 1e-6) {
        return {
          ok: false,
          message: {
            zh: `盒身長度 ${d.tubeLength}mm 過小：需 ≥ ${floor.toFixed(2)}mm（含安全餘量·保 A/B 端摺線 ≥1.5mm），否則插槽切出盒身或與斜段對撞`,
            en: `Tube length ${d.tubeLength}mm is too small: it must be ≥ ${floor.toFixed(2)}mm (including safety margin so the A/B end crease stays ≥1.5mm); otherwise the slot cuts outside the tube or collides with the ramps.`,
          },
          tags: ['tubeLength'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'cross-section-non-degenerate',
    severity: 'error',
    description: {
      zh: 'edgeA 必須 > 1.5mm——近等邊三角形不等式代數解（edgeA+(edgeA+1.5) > (edgeA+2.5)+0.5，得 edgeA>1.5），低於此端封等邊三角形退化。UI min 20 已遠高於此下限。',
    },
    check(params) {
      const edgeA = params.edgeA as number;
      if (edgeA <= EDGEA_MATH_MIN) {
        return {
          ok: false,
          message: {
            zh: `三角邊長 edgeA=${edgeA}mm 必須 > ${EDGEA_MATH_MIN}mm（近等邊三角形不等式下限），否則端封三角形退化`,
            en: `Cross-section edge edgeA=${edgeA}mm must be > ${EDGEA_MATH_MIN}mm (the near-equilateral triangle-inequality floor); below it the end-seal triangle degenerates.`,
          },
          tags: ['edgeA'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'all-finite',
    severity: 'error',
    description: { zh: '所有幾何座標與 bounds 必須是有限數（Number.isFinite）——NaN 或 Infinity 都代表參數鏈超出範圍/除零，畫布與匯出會崩潰或裁切失效。' },
    check(_params, result) {
      const coords: number[] = [];
      for (const pp of result.paths) {
        for (const s of pp.segments) {
          if (s.kind === 'line') coords.push(s.x1, s.y1, s.x2, s.y2);
          else if (s.kind === 'bezier') coords.push(s.x1, s.y1, s.c1x, s.c1y, s.c2x, s.c2y, s.x2, s.y2);
          else coords.push(s.cx, s.cy, s.r, s.startAngle, s.endAngle);
        }
      }
      coords.push(result.bounds.minX, result.bounds.maxX, result.bounds.minY, result.bounds.maxY);
      if (!coords.every((v) => Number.isFinite(v))) {
        return {
          ok: false,
          message: { zh: '偵測到非有限座標（NaN 或 Infinity）', en: 'Non-finite coordinate detected (NaN or Infinity).' },
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-bleed',
    severity: 'error',
    description: { zh: 'v1 尚不支援出血線（bleed）——盒型不得產生 bleed 線型的路徑，避免下游畫布/匯出誤判成尚未支援的線型。' },
    check(_params, result) {
      if (result.paths.some((pp) => pp.type === 'bleed')) {
        return {
          ok: false,
          message: { zh: '不應出現 bleed 線型路徑（v1 尚未支援）', en: 'Bleed paths should not be present; v1 does not support them.' },
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'bounds-cover',
    severity: 'error',
    description: { zh: '回傳的 bounds 必須完整涵蓋所有路徑的實際範圍，否則畫布視窗或匯出裁切框會裁掉部分幾何。' },
    check(_params, result) {
      const allSegs = result.paths.flatMap((pp) => pp.segments);
      const actual = segmentsBounds(allSegs);
      const EPS = 0.01;
      const ok =
        actual.minX >= result.bounds.minX - EPS &&
        actual.maxX <= result.bounds.maxX + EPS &&
        actual.minY >= result.bounds.minY - EPS &&
        actual.maxY <= result.bounds.maxY + EPS;
      if (!ok) {
        return { ok: false, message: { zh: 'bounds 未完整涵蓋所有路徑的實際範圍', en: 'Bounds do not fully cover the actual extent of all paths.' } };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-cut-self-intersection',
    severity: 'error',
    description: {
      zh: '所有 cut 類路徑的線段兩兩之間不得真交叉（內部交點；共享端點的正常轉角銜接不算）——真交叉代表幾何已退化成自撞的翻折形狀，刀模無法沿這種路徑正確裁切。dimension/annotation 不參與這條檢查。',
    },
    check(_params, result) {
      const cutSegments = result.paths
        .filter((pp) => pp.type === 'cut')
        .flatMap((pp) => pp.segments.filter((_, index) => !pp.inactiveSegments?.includes(index)));
      if (hasSelfIntersection(cutSegments)) {
        return {
          ok: false,
          message: {
            zh: 'cut 路徑偵測到自撞（線段真交叉），幾何已退化成無法裁切的翻折形狀',
            en: 'Cut-path self-intersection detected: line segments cross and the geometry has collapsed into an uncuttable folded form.',
          },
        };
      }
      return { ok: true };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 模組匯出與自我註冊
// ─────────────────────────────────────────────────────────────────────────

export const triangularTube: BoxModule = {
  meta: {
    id: 'ttb',
    name: { zh: '三角盒', en: 'Triangular Tube Box' },
    intro: {
      zh: '近等邊三角形盒型：三側面依序排列成三角形筒身，一端以尖端插舌穿中央插槽鎖住側縫，兩端以等邊三角形摺下封口、上下外翼插舌伸入另一片面板固定，免膠封端。',
      en: 'A near-equilateral triangular prism: three faces arranged along the length form a triangular tube, one seam locked by a tapered tab through a central slot, and each end sealed by an equilateral triangle folded down with upper and lower wing tabs tucked into the adjacent face. No glue at the ends.',
    },
    topology: 'linear',
  },
  params,
  invariants,
  generate,
};

registerBox(triangularTube);
