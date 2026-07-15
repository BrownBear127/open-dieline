/**
 * 天地盒（Telescope）BoxModule 組裝——上蓋＋下盒（`tray.ts`，T3）＋內襯墊片
 * （`liner.ts`；2026-07-09 T7 gate 反饋重定義為平台式腳架，見該檔檔頭）三件套，
 * pieces 分組（spec §4.2／§3.3）。
 *
 * 版面（spec 明列）：lid 左、base 右（照生產版慣例）、liner 橫放下方，PIECE_GAP 分隔。
 * 每片用「量測 offset=0 的 bounds → 算出讓 bounds.min{X,Y} 落在目標點的位移 → 用該位移
 * 重新生成一次」的兩段式（`placeAt`）決定最終位置——不外露 tray.ts/liner.ts 的內部座標系
 * 假設（如「局部原點在面板中心」），只依賴兩者共同的公開契約：`bounds` 是回傳幾何的實際包絡。
 *
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Bounds } from '@/core/geometry';
import { hasNaN, segmentsBounds } from '@/core/geometry';
import { dimensionLine } from '@/core/primitives';
import { validatePieces } from '@/core/pieces';
import { registerBox } from '@/core/registry';
import type {
  BoxInvariant,
  BoxModule,
  BoxParamDef,
  DielinePath,
  DielinePiece,
  DielineText,
  GenerateResult,
  ResolvedParams,
} from '@/core/types';
import { generateTray } from '@/boxes/telescope/tray';
import { deriveLinerFrame, generateLiner } from '@/boxes/telescope/liner';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數
// ─────────────────────────────────────────────────────────────────────────

/** 片間版面間距（spec 明列）。 */
const PIECE_GAP = 20;

/**
 * 標註線外推距離——primitives.dimensionLine 的文字錨點相對量測線有固定位移
 * （'h' 為 offset−2、'v' 為 offset−4），offset 太小時文字會跑到路徑（含引出線）包絡外，
 * 讓 pieces.ts 的 piece-bounds-mismatch 不變式誤判（見 開發紀錄 安全邊界推導：
 * 'h' 需 offset≥2、'v' 需 offset≥4；這裡用 8 留出視覺上寬裕的邊界，第二層標註再 ×2 避免
 * 兩條標註線的文字互疊）。
 */
const DIM_OFFSET = 8;

const EPS = 1e-6;

// ─────────────────────────────────────────────────────────────────────────
// 參數宣告（spec §4.2 逐字，宣告序）
// ─────────────────────────────────────────────────────────────────────────

const params: BoxParamDef[] = [
  {
    key: 'baseLength',
    label: { zh: '下盒長度', en: 'Base length' },
    unit: 'mm',
    default: 179,
    min: 30,
    max: 600,
    step: 0.5,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '下盒主面板長邊尺寸（製造尺寸，與生產刀模直接對帳）；同時決定上蓋面板長邊（＋2×上蓋放大量）與內襯墊片底面長邊的套合基準（內襯現在錨定下盒內淨，見 linerFitGap）。',
      en: 'Base main-panel long-side manufacturing dimension, for direct comparison with the production dieline; also sets the lid-panel long side (+ 2× lid oversize) and the fit reference for the liner-pad long side. The liner is anchored to the base inside dimensions; see linerFitGap.',
    },
    highlightTags: ['baseLength'],
  },
  {
    key: 'baseWidth',
    label: { zh: '下盒寬度', en: 'Base width' },
    unit: 'mm',
    default: 124,
    min: 30,
    max: 600,
    step: 0.5,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '下盒主面板短邊尺寸；同時決定上蓋面板短邊（＋2×上蓋放大量）與內襯墊片底面短邊的套合基準。',
      en: 'Base main-panel short-side dimension; also sets the lid-panel short side (+ 2× lid oversize) and the fit reference for the liner-pad short side.',
    },
    highlightTags: ['baseWidth'],
  },
  {
    key: 'baseHeight',
    label: { zh: '下盒壁高', en: 'Base wall height' },
    unit: 'mm',
    default: 60,
    min: 10,
    max: 200,
    step: 0.5,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '下盒後摺壁的名義全高；先摺壁（左右壁）另再減一個壁頂平齊補償量（wallTopCompensation）做「頂緣平齊」修正，讓四片牆摺起後頂緣切齊（Slice 5 F3 解耦：此修正原讀紙厚，現改讀獨立參數）。內襯墊片的腳架深度（linerFlapDepth）不得超過此值，否則內襯會頂出盒口（見 liner-flap-fits 警告）。',
      en: 'Nominal full height of the base second-fold walls; the first-fold left and right walls are reduced by wallTopCompensation so all four top edges finish flush. As of Slice 5 F3, this correction reads an independent parameter rather than board caliper. Liner leg depth (linerFlapDepth) must not exceed this value or the liner will project above the box opening; see the liner-flap-fits warning.',
    },
    highlightTags: ['baseHeight'],
  },
  {
    key: 'lidMarginX',
    label: { zh: '上蓋放大量（短向）', en: 'Lid oversize (short axis)' },
    unit: 'mm',
    default: 13.5,
    min: 5,
    max: 60,
    step: 0.5,
    group: { id: 'fit', zh: '套合', en: 'Fit' },
    description: {
      zh: '上蓋面板短向（對應 baseWidth／x 向先摺壁）相對下盒的等邊放大量——決定上蓋短向能套住下盒多深。Slice 5 F1：原單一 lidMargin 拆兩軸，取消 y 向測試豁免後兩軸皆為可獨立覆蓋的一般參數（無 derivedDefault）。（2026-07-09 T7 gate 重定義：內襯不再錨定上蓋，此參數與內襯幾何無關——見 linerFlapDepth。）',
      en: 'Equal per-side lid oversize on the short axis, corresponding to baseWidth and the x-axis first-fold walls; determines the lid-to-base fit on the short axis. Slice 5 F1 split the former lidMargin into two independently overridable axes with no derivedDefault and removed the y-axis test exemption. Since the 2026-07-09 T7 gate redefinition, the liner is no longer anchored to the lid, so this parameter does not affect liner geometry; see linerFlapDepth.',
    },
    highlightTags: ['lidMarginX'],
  },
  {
    key: 'lidMarginY',
    label: { zh: '上蓋放大量（長向）', en: 'Lid oversize (long axis)' },
    unit: 'mm',
    default: 18.5,
    min: 5,
    max: 60,
    step: 0.5,
    group: { id: 'fit', zh: '套合', en: 'Fit' },
    description: {
      zh: '上蓋面板長向（對應 baseLength／y 向後摺壁）相對下盒的等邊放大量。與 lidMarginX 各自獨立（Slice 5 F1：生產刀模長短向放大量本不相等 13.5≠18.5，拆分後才能逐線復刻；取消 y 向測試豁免）。',
      en: 'Equal per-side lid oversize on the long axis, corresponding to baseLength and the y-axis second-fold walls. Independent of lidMarginX: Slice 5 F1 separated the unequal production-dieline oversizes (13.5≠18.5) for line-by-line reproduction and removed the y-axis test exemption.',
    },
    highlightTags: ['lidMarginY'],
  },
  {
    key: 'lidHeight',
    label: { zh: '上蓋壁高', en: 'Lid wall height' },
    unit: 'mm',
    default: 45,
    min: 10,
    max: 200,
    step: 0.5,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '上蓋後摺壁的名義全高；B-06（Slice 5 F3）：上蓋左右壁的頂緣平齊特例已移除，四面外壁恆等高（不吃 wallTopCompensation，不再有「−1 個紙厚」修正）。',
      en: 'Nominal full height of the lid second-fold walls. Under B-06 (Slice 5 F3), the flush-top exception for the left and right lid walls has been removed: all four outer walls remain equal in height, do not use wallTopCompensation, and no longer receive the −1 board-caliper correction.',
    },
    highlightTags: ['lidHeight'],
  },
  {
    key: 'basePlatformWidth',
    label: { zh: '下盒壁頂平台寬', en: 'Base platform width' },
    unit: 'mm',
    default: 5,
    min: 0,
    max: 15,
    step: 0.5,
    group: { id: 'wallStyle', zh: '壁款', en: 'Wall style' },
    description: {
      zh: '下盒壁頂平台寬度；設 0＝薄壁單線反折（配弧形讓位角撐），大於 0＝厚壁平台（配 45° 斜角撐）。角撐款式跟隨這個值自動切換，不是獨立開關。',
      en: 'Base wall-top platform width; 0 produces a thin-wall single-line return fold with curved relief gussets, while a value above 0 produces a thick-wall platform with 45° mitred gussets. Gusset style follows this value automatically and is not a separate control.',
    },
    highlightTags: ['wallTop'],
  },
  {
    key: 'lidPlatformWidth',
    label: { zh: '上蓋壁頂平台寬', en: 'Lid platform width' },
    unit: 'mm',
    default: 0,
    min: 0,
    max: 15,
    step: 0.5,
    group: { id: 'wallStyle', zh: '壁款', en: 'Wall style' },
    description: {
      zh: '上蓋壁頂平台寬度（生產品為薄壁單線反折，預設 0）。設 0 且壁高偏低時，薄壁角撐的讓位槽會擠壓變形，見 gusset-b-fits 警告。',
      en: 'Lid wall-top platform width; the production form uses a thin-wall single-line return fold, default 0. At 0 with a low wall height, the thin-wall gusset relief can compress and deform; see the gusset-b-fits warning.',
    },
    highlightTags: ['wallTop'],
  },
  {
    key: 'thickness',
    label: { zh: '紙厚', en: 'Board caliper' },
    unit: 'mm',
    default: 0.3,
    min: 0,
    max: 0.8,
    step: 0.01,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '紙張厚度（caliper）。驅動內襯套合間隙（linerFitGap 換算）與角撐對角線位置（reach＝壁高－紙厚）。Slice 5 F3 解耦（audit A-01）：不再直接驅動壁根雙摺線間距與內外壁差，改由 rootJog／innerWallReduction／wallTopCompensation 三個獨立參數負責——設 0 不會讓這三處補償跟著歸零，見各自的參數說明。',
      en: 'Board caliper; drives the converted liner fit gap (linerFitGap) and gusset diagonal position (reach = wall height − board caliper). Following the Slice 5 F3 decoupling (audit A-01), it no longer drives the wall-root double-crease spacing or the inner-to-outer wall difference directly; rootJog, innerWallReduction, and wallTopCompensation now control those independently. Setting caliper to 0 does not zero those three compensations; see their parameter descriptions.',
    },
    highlightTags: ['gusset'],
  },
  {
    key: 'rootJog',
    label: { zh: '壁根位移量', en: 'Root jog' },
    unit: 'mm',
    default: 0.5,
    min: 0,
    max: 3,
    step: 0.1,
    group: { id: 'compensation', zh: '補償', en: 'Compensation' },
    description: {
      zh: '後摺壁（y 向）壁根雙摺線之間的間距——與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。設 0 時雙摺線 collapse 為單一 crease（不論紙厚是否為 0）。Slice 5 T2 起這個位移量會進一步變成壁根階梯 stagger 的 jog 幅度，本階段（T1）幾何形狀仍是現行雙摺線，只有數值來源改讀這個參數。',
      en: 'Spacing between the double creases at the wall root of the y-axis second-fold walls; an independent parameter decoupled from board caliper in Slice 5 F3 (audit A-01). At 0, the double creases collapse into a single crease regardless of caliper. From Slice 5 T2, this offset also becomes the jog amplitude of the staggered wall root; at the present T1 stage, the geometry remains the current double crease and only the value source changes.',
    },
    highlightTags: ['wallRoot'],
  },
  {
    key: 'innerWallReduction',
    label: { zh: '內壁縮減量', en: 'Inner-wall reduction' },
    unit: 'mm',
    default: 0.8,
    min: 0,
    max: 5,
    step: 0.1,
    group: { id: 'compensation', zh: '補償', en: 'Compensation' },
    description: {
      zh: '牆的內壁（面向盒內、舌摺線起點）相對外壁的縮減量——內壁＝外壁－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀 2×紙厚）。base／lid、x 向／y 向四面牆共用同一個值。',
      en: 'Reduction of the inner wall, facing the box interior at the tongue-crease origin, relative to the outer wall: inner wall = outer wall − this value. Decoupled from board caliper in Slice 5 F3 (audit A-01; formerly 2× board caliper), this value is shared by all base and lid walls on both the x and y axes.',
    },
    highlightTags: ['tongueFold'],
  },
  {
    key: 'wallTopCompensation',
    label: { zh: '壁頂平齊補償', en: 'Wall-top compensation' },
    unit: 'mm',
    default: 0.5,
    min: 0,
    max: 5,
    step: 0.1,
    group: { id: 'compensation', zh: '補償', en: 'Compensation' },
    description: {
      zh: '下盒左右外壁（先摺壁）的頂緣平齊修正量——外壁＝下盒壁高－此值，與紙厚解耦的獨立參數（Slice 5 F3，audit A-01：原本讀紙厚）。只影響下盒：上蓋左右壁的平齊特例已移除（B-06），四面外壁恆＝壁高，不吃這個補償。',
      en: 'Flush-top correction for the left and right base outer walls (first-fold walls): outer wall = base wall height − this value. Decoupled from board caliper in Slice 5 F3 (audit A-01), it affects the base only. The lid-wall exception was removed under B-06; all four lid outer walls remain equal to the wall height and do not use this compensation.',
    },
    highlightTags: ['wallTop'],
  },
  {
    key: 'linerEnabled',
    label: { zh: '內襯墊片', en: 'Liner pad' },
    unit: 'bool',
    default: true,
    group: { id: 'liner', zh: '內襯', en: 'Liner' },
    description: {
      zh: '是否產生內襯墊片（2026-07-09 T7 gate 反饋重定義：平台式腳架墊片，放進下盒貼底、把物品墊高）。關閉時只輸出上蓋／下盒兩片，套合與定位需另外自理（如緊配或腰封）。',
      en: 'Liner-pad generation; under the 2026-07-09 T7 gate redefinition, produces a platform liner seated against the base with downward legs that raise the contents. When disabled, only the lid and base pieces are generated; fit and positioning require a separate solution, such as a friction fit or belly band.',
    },
    highlightTags: ['linerPad', 'linerFlap'],
  },
  {
    key: 'linerFitGap',
    label: { zh: '內襯套合間隙', en: 'Liner fit gap' },
    unit: 'mm',
    default: 0.5,
    min: 0.2,
    max: 2,
    step: 0.1,
    group: { id: 'liner', zh: '內襯', en: 'Liner' },
    description: {
      zh: '內襯底面對下盒內淨，四邊各留一次的套合間隙（2026-07-09 T7 gate 重定義：內襯改為平台式、底面錨定下盒內淨，此間隙只扣一次，不再是舊圍框版「上蓋一次＋下盒一次」的雙重扣）；愈大底面愈小、內襯愈鬆好放入。',
      en: 'Per-side fit gap between the liner base and the base inside dimensions. Under the 2026-07-09 T7 gate redefinition, the platform liner is anchored to the base interior and this gap is deducted once, replacing the former frame liner’s double deduction for lid and base. A larger gap produces a smaller, looser liner that is easier to insert.',
    },
    highlightTags: ['linerPad'],
  },
  {
    key: 'linerFlapDepth',
    label: { zh: '內襯腳架深度', en: 'Liner leg depth' },
    unit: 'mm',
    default: 15,
    min: 5,
    max: 60,
    step: 0.5,
    group: { id: 'liner', zh: '內襯', en: 'Liner' },
    description: {
      zh: '內襯四翼向下摺的深度＝腳架高度，也就是物品被墊高的量（2026-07-09 T7 gate 反饋新增：平台式內襯重定義，維護者提供正確形式）。太深會頂出下盒盒口（見 liner-flap-fits 警告），太深也可能讓翼片外緣反轉（同一警告的另一條件）。',
      en: 'Downward fold depth of the liner’s four flaps = leg height and the amount by which the contents are raised. Added with the 2026-07-09 T7 gate redefinition of the platform liner. Excessive depth can project above the base opening or reverse the flap’s outer edge; see both conditions in the liner-flap-fits warning.',
    },
    highlightTags: ['linerFlap'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// B 款（薄壁弧形讓位角撐）最小壁高——解析推導（開發紀錄 concern 的精確化）
// ─────────────────────────────────────────────────────────────────────────

// 複製自 tray.ts 的 style-B 角撐私有常數（tray.ts 未 export 且依 spec 指示不得修改；
// 若未來 tray.ts 調整這些值，這裡需要同步更新——見 開發紀錄 concern）。
const B_LEG_TILT_RAD = (10 * Math.PI) / 180;
const B_TIP_RADIUS = 1.5;
const B_RELIEF_RADIUS = 5.0;
const B_EXIT_RATIO = 16.298 / 45;

/**
 * B 款讓位槽（hairpin＋R5 讓位弧）在幾何上不反轉的最小壁高——解析推導，非拍腦袋。
 *
 * tray.ts 的 bGussetFrame 對每個角落算出一條讓位槽鏈 tip→p1→(R1.5)→p2→p3→(R5)→p4→p5→p6；
 * p3/p4 是 R5 圓角與「外腿線」「45°出口線 a+b=2·reach」的切點，切線長固定
 * ＝tangentLen=R5·tan(turn/2)（turn 是兩線夾角，純由 tilt 角度決定，不隨壁高縮放）。
 * p5（出口線轉垂直的轉角）在出口線上的位置＝exitB=height·B_EXIT_RATIO；q（外腿線與
 * 出口線的交點，p4 由此退 tangentLen 而來）的位置與 tip 同一參數式、只吃 reach=height−t。
 * 壁高過矮時 exitB 會追上甚至反超 q，讓位槽鏈失去正確順序、R5 圓角在該處反轉自撞
 * （開發紀錄 記錄的「出口轉角高超過槽底」）。
 *
 * 用「q.b − exitB ≥ tangentLen/√2」（沿出口線的距離門檻，√2 因 45° 線的座標差與弦長差
 * √2 倍）反解 height，得到門檻＝thickness 的一次函數。已用 generateTray+hasSelfIntersection
 * 對 t∈{0,0.1,...,0.8} 二分搜尋驗證，閉式解與搜尋結果殘差 <1e-5mm（見 開發紀錄）。
 */
export function minStyleBHeight(thickness: number): number {
  const sinT = Math.sin(B_LEG_TILT_RAD);
  const cosT = Math.cos(B_LEG_TILT_RAD);
  const tanT = Math.tan(B_LEG_TILT_RAD);
  const legB = B_TIP_RADIUS * (1 - sinT);
  const k1 = B_TIP_RADIUS * cosT - legB * tanT; // tip/q 的 b 參數式：(reach−k1)/k2
  const k2 = 1 + tanT;
  const turn = Math.acos(sinT * Math.SQRT1_2 - cosT * Math.SQRT1_2);
  const tangentLen = B_RELIEF_RADIUS * Math.tan(turn / 2);
  const minGapAlongExit = tangentLen / Math.SQRT2;
  // (reach−k1)/k2 − height·EXIT_RATIO ≥ minGapAlongExit，reach=height−thickness，解 height：
  return (minGapAlongExit * k2 + thickness + k1) / (1 - B_EXIT_RATIO * k2);
}

// ─────────────────────────────────────────────────────────────────────────
// U-notch／平台角圓角可容納降級（Slice 5 F4／F6-A，spec §縮放與降級規律）
// ─────────────────────────────────────────────────────────────────────────

// 複製自 tray.ts 的 A 款細節私有常數（tray.ts 未 export；若該檔調整這些值，這裡需要
// 同步更新——同上方 B 款角撐/插底舌常數的先例）。
const NOTCH_OPENING_MM = 30;
const NOTCH_CENTER_RATIO_TS = 29.3385 / 179;
const NOTCH_SAFETY_MARGIN_MM = 5;
const PLATFORM_CORNER_MIN_WIDTH_MM = 2.5;

/**
 * 單一壁的 notch 降級狀態（spec §縮放與降級表逐字對應 tray.ts 的 longWallNotchPlan／
 * shortWallNotchPlan，這裡獨立重算供 invariant 用，不 import tray.ts 私有函式）：
 * 長壁（2 notch，isLongWall=true）先驗兩個能否都放下，放不下先退化為單一置中
 * （notch-reduced），連單一都放不下才全省（notch-omitted）；短壁（1 notch 置中）
 * 放不下直接全省。回傳 undefined＝可容納、無降級。
 */
function notchDegradation(wallSpan: number, isLongWall: boolean): 'notch-reduced' | 'notch-omitted' | undefined {
  const minSpanForOne = NOTCH_OPENING_MM + 2 * NOTCH_SAFETY_MARGIN_MM;
  if (isLongWall) {
    const center = NOTCH_CENTER_RATIO_TS * wallSpan;
    const halfOpen = NOTCH_OPENING_MM / 2;
    const twoFits = 2 * center - NOTCH_OPENING_MM >= NOTCH_SAFETY_MARGIN_MM && center + halfOpen <= wallSpan / 2;
    if (twoFits) return undefined;
    return wallSpan >= minSpanForOne ? 'notch-reduced' : 'notch-omitted';
  }
  return wallSpan >= minSpanForOne ? undefined : 'notch-omitted';
}

/**
 * 兩件（base／lid）裡 platformWidth>0（A 款）的那些，各自長壁／短壁 span 是否命中
 * 指定降級狀態——notch-reduced／notch-omitted 兩條 invariant 共用同一次掃描。
 * 長壁 span＝該片後摺壁面板邊長（base＝baseLength、lid＝baseLength+2×lidMarginY）；
 * 短壁 span＝先摺壁面板邊長（base＝baseWidth、lid＝baseWidth+2×lidMarginX）——見
 * generate() 的 lidPanelX/lidPanelY 推導、tray.ts 的長壁/短壁對應（longWall=x 向牆
 * ＝panelW 方向＝baseLength 軸、shortWall=y 向牆＝panelL 方向＝baseWidth 軸）。
 */
function anyNotchDegradation(params: ResolvedParams, want: 'notch-reduced' | 'notch-omitted'): boolean {
  const baseLength = params.baseLength as number;
  const baseWidth = params.baseWidth as number;
  const lidMarginX = params.lidMarginX as number;
  const lidMarginY = params.lidMarginY as number;
  const pieces: Array<[number, number, number]> = [
    [params.basePlatformWidth as number, baseLength, baseWidth],
    [params.lidPlatformWidth as number, baseLength + 2 * lidMarginY, baseWidth + 2 * lidMarginX],
  ];
  for (const [platformWidth, longSpan, shortSpan] of pieces) {
    if (platformWidth <= 0) continue;
    if (notchDegradation(longSpan, true) === want) return true;
    if (notchDegradation(shortSpan, false) === want) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// B 款舌根端段縮減／V relief 可容納降級（Slice 5 F5，spec §縮放與降級表）
// ─────────────────────────────────────────────────────────────────────────

// 複製自 tray.ts 的 B 款舌根拓撲私有常數（tray.ts 未 export；若該檔調整這些值，這裡需要
// 同步更新——同上方 A 款 notch 常數的先例）。
const B_TONGUE_END_LONGWALL = 45;
const B_TONGUE_END_SHORTWALL = 35;
const B_TONGUE_MIN_SPAN = 10;
const B_TONGUE_RESERVED_LONGWALL = 9.398;
const V_RELIEF_INSET_MM = 2.5;
const V_RELIEF_MIN_END_MM = 7.5;

/**
 * 單一壁縮減後的可用舌摺線長度（reservedSpan，逐字對應 tray.ts buildBTongueTopology 的
 * innerHalf×2 推導）：longWall（左右壁）保留區＝角撐周邊複合鏈固定消耗；shortWall
 * （前後壁）保留區＝V relief 自己的內縮量。wallSpan＝該壁全跨（＝2×perpHalf）。
 */
function bTongueReservedSpan(wallSpan: number, isLongWall: boolean): number {
  const reserved = isLongWall ? B_TONGUE_RESERVED_LONGWALL : V_RELIEF_INSET_MM;
  return 2 * Math.max(wallSpan / 2 - reserved, 0);
}

/**
 * 端段縮減三分支（spec F5 v1.2 H1，逐字對應 tray.ts bTongueBranch，這裡獨立重算供
 * invariant 用）。回傳 undefined＝分支 1（不縮不警告）。
 */
function bTongueDegradation(reservedSpan: number, eNominal: number): 'tongue-crease-shrunk' | 'tongue-crease-omitted' | undefined {
  if (reservedSpan >= 2 * eNominal + B_TONGUE_MIN_SPAN) return undefined;
  if (reservedSpan >= B_TONGUE_MIN_SPAN) return 'tongue-crease-shrunk';
  return 'tongue-crease-omitted';
}

/**
 * 兩件（base／lid）裡 platformWidth=0（B 款）的那些，各自長壁／短壁 span 是否命中指定
 * 降級狀態——tongue-crease-shrunk／tongue-crease-omitted 兩條 invariant 共用同一次掃描。
 * span 定義同 anyNotchDegradation（A 款換 B 款判準：platformWidth<=0）。
 */
function anyBTongueDegradation(params: ResolvedParams, want: 'tongue-crease-shrunk' | 'tongue-crease-omitted'): boolean {
  const baseLength = params.baseLength as number;
  const baseWidth = params.baseWidth as number;
  const lidMarginX = params.lidMarginX as number;
  const lidMarginY = params.lidMarginY as number;
  const pieces: Array<[number, number, number]> = [
    [params.basePlatformWidth as number, baseLength, baseWidth],
    [params.lidPlatformWidth as number, baseLength + 2 * lidMarginY, baseWidth + 2 * lidMarginX],
  ];
  for (const [platformWidth, longSpan, shortSpan] of pieces) {
    if (platformWidth > 0) continue; // A 款無此細節（U-notch 拓撲，見 anyNotchDegradation）
    const longDeg = bTongueDegradation(bTongueReservedSpan(longSpan, true), B_TONGUE_END_LONGWALL);
    const shortDeg = bTongueDegradation(bTongueReservedSpan(shortSpan, false), B_TONGUE_END_SHORTWALL);
    if (longDeg === want || shortDeg === want) return true;
  }
  return false;
}

/**
 * V relief 可容納（spec §縮放與降級表）：依附 shortWall（hasDoubleRoot=true，唯一有
 * V relief 的壁款，見 tray.ts buildBTongueTopology）端段實際長 E′——分支 1 用 nominal
 * 35、分支 2 用縮減值、分支 3（endLen=0）恆不生成（E′<7.5 恆成立）。longWall 沒有
 * V relief 機制，不參與此判定。
 */
function anyReliefOmitted(params: ResolvedParams): boolean {
  const baseWidth = params.baseWidth as number;
  const lidMarginX = params.lidMarginX as number;
  const pieces: Array<[number, number]> = [
    [params.basePlatformWidth as number, baseWidth],
    [params.lidPlatformWidth as number, baseWidth + 2 * lidMarginX],
  ];
  for (const [platformWidth, shortSpan] of pieces) {
    if (platformWidth > 0) continue;
    const reservedSpan = bTongueReservedSpan(shortSpan, false);
    let endLen: number;
    if (reservedSpan >= 2 * B_TONGUE_END_SHORTWALL + B_TONGUE_MIN_SPAN) endLen = B_TONGUE_END_SHORTWALL;
    else if (reservedSpan >= B_TONGUE_MIN_SPAN) endLen = (reservedSpan - B_TONGUE_MIN_SPAN) / 2;
    else endLen = 0;
    if (endLen < V_RELIEF_MIN_END_MM) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// A 款角撐周邊複合 relief 鏈可容納性（Fix 2·2026-07-11 review H2，取代先前的
// 無條件縮放安全網——tray.ts 的 buildAGussetChain 已改為固定 nominal＋放不下就整鏈省略）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 複合 relief 鏈是否被 tray.ts 省略——**直接檢查生成結果**（`aGussetPeriphery` tag 是否
 * 存在），不獨立重算可容納公式。這裡跟 notchDegradation／anyNotchDegradation 的「獨立
 * 重算」慣例不同——是刻意的：tray.ts 的可容納判定除了單純的 b 軸（notch/壁界）門檻，
 * 還疊了一層 a 軸自撞自檢（aGussetChainSelfIntersects，見 tray.ts buildAGussetChain
 * 之後的 aGussetChainFits 註解），公式牽涉 hasSelfIntersection＋兩個模板的完整幾何，
 * 獨立重算會複製一大段 tray.ts 邏輯、兩處還可能漂移出不一致判定——改為直接讀生成結果，
 * 保證這條 invariant 與 tray.ts 的實際輸出**恆一致**（不會有「幾何已省略但沒警告」或
 * 「幾何仍在但誤警告」的兩處公式對不齊）。
 */
function anyGussetChainOmitted(params: ResolvedParams, result: GenerateResult): boolean {
  const pieces: Array<['base' | 'lid', number]> = [
    ['base', params.basePlatformWidth as number],
    ['lid', params.lidPlatformWidth as number],
  ];
  for (const [pieceId, platformWidth] of pieces) {
    if (platformWidth <= 0) continue; // useThickStyle=false，鏈本來就不適用（B 款無此細節）
    const piece = result.pieces!.find((p) => p.id === pieceId)!;
    const hasChain = result.paths.some((p) => piece.pathIds.includes(p.id) && p.tags?.includes('aGussetPeriphery'));
    if (!hasChain) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// 插底舌梯形最小垂直半跨——解析推導（T5 param-sweep 挖出的退化區，fix wave F1）
// ─────────────────────────────────────────────────────────────────────────

// 複製自 tray.ts 的插底舌私有常數（tray.ts 未 export；若該檔調整這些值，這裡需要
// 同步更新——同上方 B 款角撐常數的先例）。
const TUCK_FLAP_DEPTH = 15;
const TUCK_FLAP_SHALLOW_DEPTH = TUCK_FLAP_DEPTH / 2;
const TONGUE_END_RECESS = 9;

/**
 * 插底舌梯形不反轉的最小「牆垂直半跨」（perpHalf＝該牆所在面板另一軸邊長的一半）。
 *
 * tray.ts 的 buildTongueFlap 讓梯形全深段兩端點落在 perpB＝−perpHalf＋recess＋
 * TUCK_FLAP_SHALLOW_DEPTH、perpC＝perpHalf−recess−TUCK_FLAP_SHALLOW_DEPTH
 * （recess＝min(TONGUE_END_RECESS, perpHalf)）；順序不反轉需要 perpB ≤ perpC ⇔
 * perpHalf ≥ recess＋TUCK_FLAP_SHALLOW_DEPTH。perpHalf ≥ TONGUE_END_RECESS 時門檻
 * ＝RECESS＋SHALLOW＝16.5；perpHalf < TONGUE_END_RECESS 時（recess 被鉗到 perpHalf）
 * 條件化為 0 ≥ SHALLOW 恆不成立——兩段合併後退化條件就是 perpHalf < 16.5。
 * 恰在 16.5 時全深段長度歸零（退化但不交叉）。已用 generateTray＋hasSelfIntersection
 * 對 baseLength 二分搜尋驗證：32（perpHalf=16）自撞、33（perpHalf=16.5）乾淨
 * （tests/telescope-fixture.test.ts 的 tongue-flap-fits 邊界測試釘住這組錨）。
 */
export const MIN_TONGUE_PERP_HALF = TONGUE_END_RECESS + TUCK_FLAP_SHALLOW_DEPTH;

/**
 * B 款（platformWidth=0）longWall 專屬的插底舌梯形最小垂直半跨——MIN_TONGUE_PERP_HALF
 * 的姊妹推導，門檻代數完全同構，唯一差異是 recess 換成 B 款 longWall 的真實值。
 *
 * tray.ts 的 buildWall 只在 B 款 longWall（!independentJogEntity && !hasDoubleRoot，即
 * platformWidth<=0 且該壁為左右壁）把 buildTongueFlap 的 recess 從通用
 * TONGUE_END_RECESS(9) 換成 bLongWallFlapRecess＝B_TONGUE_RESERVED_LONGWALL(9.398)＋
 * innerWallReduction（F1 review Fix，2026-07-11——見該函式 docblock 與呼叫端
 * flapRecess 分流條件）；shortWall 與 A 款 longWall 不受影響，仍沿用 undefined→
 * TONGUE_END_RECESS，門檻不變仍是 MIN_TONGUE_PERP_HALF。
 *
 * 代入 MIN_TONGUE_PERP_HALF 同一套代數（perpHalf≥recess 時門檻＝recess＋SHALLOW；
 * perpHalf<recess 時 recess 被鉗到 perpHalf、條件恆真——兩段合併，退化條件就是
 * perpHalf < B_TONGUE_RESERVED_LONGWALL+innerWallReduction+TUCK_FLAP_SHALLOW_DEPTH）：
 * production 預設 innerWallReduction=0.8 時＝17.698（對應面板邊長 35.396mm），比原
 * MIN_TONGUE_PERP_HALF(16.5mm／33mm) 更緊——若沿用舊門檻，面板邊長落在
 * [33,35.396) 這個窗口時 B 款 longWall 插底舌已實際自撞但不變式仍回報正常（review
 * re-review Medium finding，2026-07-11：baseLength=34＋basePlatformWidth=0 實測驗證，
 * 見 開發紀錄 concern 1 fix 段的重現紀錄；已用 generateTray+
 * hasSelfIntersection 對 baseLength 掃描驗證：35.39（perpHalf=17.695）自撞、35.396
 * （perpHalf=17.698）乾淨，門檻精確落在此處）。
 */
function minBLongWallPerpHalf(innerWallReduction: number): number {
  return B_TONGUE_RESERVED_LONGWALL + innerWallReduction + TUCK_FLAP_SHALLOW_DEPTH;
}

// ─────────────────────────────────────────────────────────────────────────
// 從生成幾何反推量測值——rim-flush／pieces-identity 兩條不變式共用
// ─────────────────────────────────────────────────────────────────────────

/** 某 landmark/side/軸的所有候選駐留座標（crease 型別；沿用 tray.ts 的 tag 慣例 ['<landmark>','<side>']）。 */
function creaseAlongValues(paths: DielinePath[], landmark: string, side: string, axis: 'x' | 'y'): number[] {
  const vals: number[] = [];
  for (const p of paths) {
    if (p.type !== 'crease' || !p.tags?.includes(landmark) || !p.tags?.includes(side)) continue;
    for (const s of p.segments) {
      if (s.kind === 'line') vals.push(axis === 'x' ? s.x1 : s.y1, axis === 'x' ? s.x2 : s.y2);
    }
  }
  return vals;
}

/**
 * y 向 wallRoot(front/back) 的 nominal＋offset 兩個駐留值（Slice 5 Fix2·review
 * Finding 1 回歸修正）：B 款（薄壁角撐，platformWidth=0，如 lid）自本輪修正起，
 * wallRoot 自身只留中央 offset 一個值——nominal 移到相鄰角落 gussetFold 的 y 軸摺線
 * 端點（tray.ts buildWallRoot／buildGussetA 分工說明）。measuredPanel 這類「從幾何反推
 * 量測值」的函式原本假設 wallRoot 自己就同時持有 nominal/offset 兩點，B 款現在要跨
 * entity 合併才推得出正確的 nominal-to-nominal 跨距——否則 pieces-identity 會把 lid.y
 * 誤測成多算 2×rootJog（central fold span，不是 side-root span）。A 款（厚壁角撐）
 * wallRoot 自身仍有兩值，這裡對它是無害 no-op（不觸發角落查找，直接回傳既有值）。
 */
function yRootAlongsWithNominal(paths: DielinePath[], side: 'front' | 'back'): number[] {
  const own = [...new Set(creaseAlongValues(paths, 'wallRoot', side, 'y'))];
  if (own.length !== 1) return own;
  const offset = own[0]!;
  const corner = side === 'back' ? 'right-back' : 'right-front';
  const foldVals: number[] = [];
  for (const p of paths) {
    if (p.type !== 'crease' || !p.tags?.includes('gussetFold') || !p.tags?.includes(corner)) continue;
    for (const s of p.segments) {
      // y 軸摺線＝沿 y 變化、x 定值的那一段（另一段是 x 軸摺線，會被這個篩選排除）。
      if (s.kind === 'line' && Math.abs(s.x1 - s.x2) < 1e-6 && Math.abs(s.y1 - s.y2) > 1e-6) {
        foldVals.push(s.y1, s.y2);
      }
    }
  }
  if (foldVals.length === 0) return own; // 防禦：找不到摺線就退回原值，下游容差會攔下異常
  const nominal = foldVals.reduce((best, v) => (Math.abs(v - offset) < Math.abs(best - offset) ? v : best), foldVals[0]!);
  return [offset, nominal];
}

/**
 * 兩組候選駐留座標之間的「最小絕對距離」——雙 crease（後摺壁根）／雙 wallTop（厚壁平台）
 * 等有多個候選值時，穩健抓出真正相鄰的那一對：不相關的配對距離（面板全寬等級）遠大於
 * 相鄰配對距離（紙厚或平台寬等級），取最小值即為相鄰對，不需要知道座標系符號/方向。
 */
function minAbsGap(as: number[], bs: number[]): number {
  let min = Infinity;
  for (const a of as) {
    for (const b of bs) min = Math.min(min, Math.abs(b - a));
  }
  return min;
}

/** 單片（base 或 lid）主面板的 x/y 實測尺寸——由左右／前後兩側 wallRoot 的距離反推。 */
function measuredPanel(paths: DielinePath[]): { x: number; y: number } {
  return {
    x: minAbsGap(creaseAlongValues(paths, 'wallRoot', 'left', 'x'), creaseAlongValues(paths, 'wallRoot', 'right', 'x')),
    // y 向用 yRootAlongsWithNominal（非直接 creaseAlongValues）：B 款 wallRoot 只剩 offset，
    // 需要跨 entity 合併回 nominal 才能量出正確的 side-root（nominal-to-nominal）跨距。
    y: minAbsGap(yRootAlongsWithNominal(paths, 'front'), yRootAlongsWithNominal(paths, 'back')),
  };
}

/** 單片先摺壁（x 向）／後摺壁（y 向）外壁高——由 wallRoot 到最近一條 wallTop 候選值反推。 */
function measuredOuterWalls(paths: DielinePath[]): { x: number; y: number } {
  return {
    x: minAbsGap(creaseAlongValues(paths, 'wallRoot', 'left', 'x'), creaseAlongValues(paths, 'wallTop', 'left', 'x')),
    y: minAbsGap(creaseAlongValues(paths, 'wallRoot', 'back', 'y'), creaseAlongValues(paths, 'wallTop', 'back', 'y')),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 生成——版面組裝
// ─────────────────────────────────────────────────────────────────────────

type TrayResult = { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds };

/** 量測 build(0,0) 的 bounds，算出讓 bounds.min{X,Y} 落在指定目標點的位移，重新生成一次到位。 */
function placeAt<T extends { bounds: Bounds }>(build: (offsetX: number, offsetY: number) => T, targetMinX: number, targetMinY: number): T {
  const atOrigin = build(0, 0);
  const dx = targetMinX - atOrigin.bounds.minX;
  const dy = targetMinY - atOrigin.bounds.minY;
  return build(dx, dy);
}

/** 一組（dimension DielinePath＋DielineText）——base/lid 三條尺寸標註共用的 boilerplate。 */
function makeDimension(
  idPrefix: string,
  index: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string,
  offset: number,
  orientation: 'h' | 'v',
  tag: string,
  anchor: 'start' | 'middle',
): { path: DielinePath; text: DielineText } {
  const { paths: segs, text } = dimensionLine(x1, y1, x2, y2, label, offset, orientation);
  return {
    path: { id: `${idPrefix}-dim-${index}`, type: 'dimension', segments: segs, tags: [tag] },
    text: { id: `${idPrefix}-dimt-${index}`, x: text.x, y: text.y, text: text.text, rotation: text.rotation, fontSize: 3, anchor },
  };
}

/**
 * 幫一個 tray 結果加上 3 條尺寸標註（面板 L×W＋壁高，spec 明列）：L 沿 bounds.maxY 下方、
 * W 沿 bounds.maxX 右方、height 用 2×DIM_OFFSET 再外推一層避免跟 W 的標註線視覺重疊。
 * height 量測起點用 panelW/2+rootJog（後摺壁外壁量測起點是雙 crease 的外線，見 tray.ts
 * 「y 向 outerWall＝H，自雙 crease 外線起量」，雙 crease 間距＝rootJog）。Slice 5 Fix1
 * review：F3 解耦後雙 crease 間距已不是 thickness，這裡若仍讀 thickness 會讓標註起點偏離
 * 實際外線（預設 t=0.3/rootJog=0.5 會偏 0.2mm）——改讀 rootJog 才會精確對齊，不再是「純視覺
 * 微差」。
 */
function addTrayDimensions(
  tray: TrayResult,
  panelL: number,
  panelW: number,
  height: number,
  rootJog: number,
  idPrefix: string,
  offsetX: number,
  offsetY: number,
  tagL: string,
  tagW: string,
  tagH: string,
): TrayResult {
  const yEdge = offsetY + panelW / 2 + rootJog;
  const dims = [
    makeDimension(idPrefix, 0, offsetX - panelL / 2, tray.bounds.maxY, offsetX + panelL / 2, tray.bounds.maxY, `${panelL}mm`, DIM_OFFSET, 'h', tagL, 'middle'),
    makeDimension(idPrefix, 1, tray.bounds.maxX, offsetY - panelW / 2, tray.bounds.maxX, offsetY + panelW / 2, `${panelW}mm`, DIM_OFFSET, 'v', tagW, 'start'),
    makeDimension(idPrefix, 2, tray.bounds.maxX, yEdge, tray.bounds.maxX, yEdge + height, `${height}mm`, DIM_OFFSET * 2, 'v', tagH, 'start'),
  ];
  const paths = [...tray.paths, ...dims.map((d) => d.path)];
  const texts = [...tray.texts, ...dims.map((d) => d.text)];
  return { paths, texts, bounds: segmentsBounds(paths.flatMap((p) => p.segments)) };
}

function buildBasePiece(
  baseWidth: number,
  baseLength: number,
  baseHeight: number,
  basePlatformWidth: number,
  thickness: number,
  rootJog: number,
  innerWallReduction: number,
  wallTopCompensation: number,
  offsetX: number,
  offsetY: number,
): TrayResult {
  const tray = generateTray({
    panelL: baseWidth,
    panelW: baseLength,
    height: baseHeight,
    platformWidth: basePlatformWidth,
    thickness,
    rootJog,
    innerWallReduction,
    wallTopCompensation,
    idPrefix: 'base',
    offsetX,
    offsetY,
  });
  return addTrayDimensions(tray, baseWidth, baseLength, baseHeight, rootJog, 'base', offsetX, offsetY, 'baseWidth', 'baseLength', 'baseHeight');
}

function buildLidPiece(
  lidPanelX: number,
  lidPanelY: number,
  lidHeight: number,
  lidPlatformWidth: number,
  thickness: number,
  rootJog: number,
  innerWallReduction: number,
  offsetX: number,
  offsetY: number,
): TrayResult {
  const tray = generateTray({
    panelL: lidPanelX,
    panelW: lidPanelY,
    height: lidHeight,
    platformWidth: lidPlatformWidth,
    thickness,
    rootJog,
    innerWallReduction,
    // B-06：上蓋左右壁的頂緣平齊特例移除，四面外壁恆＝壁高，不吃 wallTopCompensation
    // （下盒才吃，見 buildBasePiece）——寫死 0，不對外露出成 buildLidPiece 的參數
    // （上蓋幾何本來就與這個補償無關，不是「使用者可能想調的值」）。
    wallTopCompensation: 0,
    idPrefix: 'lid',
    offsetX,
    offsetY,
  });
  return addTrayDimensions(tray, lidPanelX, lidPanelY, lidHeight, rootJog, 'lid', offsetX, offsetY, 'lidMarginX', 'lidMarginY', 'lidHeight');
}

function toPiece(id: string, label: DielinePiece['label'], r: TrayResult): DielinePiece {
  return { id, label, pathIds: r.paths.map((p) => p.id), textIds: r.texts.map((t) => t.id), bounds: r.bounds };
}

function generate(p: ResolvedParams): GenerateResult {
  const baseLength = p.baseLength as number;
  const baseWidth = p.baseWidth as number;
  const baseHeight = p.baseHeight as number;
  const lidMarginX = p.lidMarginX as number;
  const lidMarginY = p.lidMarginY as number;
  const lidHeight = p.lidHeight as number;
  const basePlatformWidth = p.basePlatformWidth as number;
  const lidPlatformWidth = p.lidPlatformWidth as number;
  const thickness = p.thickness as number;
  const rootJog = p.rootJog as number;
  const innerWallReduction = p.innerWallReduction as number;
  const wallTopCompensation = p.wallTopCompensation as number;
  const linerEnabled = p.linerEnabled as boolean;
  const linerFitGap = p.linerFitGap as number;
  const linerFlapDepth = p.linerFlapDepth as number;

  // D12：baseWidth 對 x 向（先摺壁）、baseLength 對 y 向（後摺壁）——見 開發紀錄 上游 handoff。
  // F1：lidMargin 拆兩軸，x 向吃 lidMarginX、y 向吃 lidMarginY（各自獨立，不可交叉套用）。
  const lidPanelX = baseWidth + 2 * lidMarginX;
  const lidPanelY = baseLength + 2 * lidMarginY;

  // 版面：lid 左（原點對齊 0,0）、base 右（lid 寬＋PIECE_GAP 起）、liner 橫放下方。
  const lidFinal = placeAt((ox, oy) => buildLidPiece(lidPanelX, lidPanelY, lidHeight, lidPlatformWidth, thickness, rootJog, innerWallReduction, ox, oy), 0, 0);
  const baseFinal = placeAt(
    (ox, oy) => buildBasePiece(baseWidth, baseLength, baseHeight, basePlatformWidth, thickness, rootJog, innerWallReduction, wallTopCompensation, ox, oy),
    lidFinal.bounds.maxX + PIECE_GAP,
    0,
  );
  const topH = Math.max(lidFinal.bounds.maxY, baseFinal.bounds.maxY);
  const linerFinal = linerEnabled
    ? placeAt(
        (ox, oy) => generateLiner({ baseLength, baseWidth, thickness, fitGap: linerFitGap, flapDepth: linerFlapDepth, idPrefix: 'liner', offsetX: ox, offsetY: oy }),
        0,
        topH + PIECE_GAP,
      )
    : undefined;

  const pieces: DielinePiece[] = linerEnabled
    ? [
        toPiece('base', { zh: '下盒', en: 'Base' }, baseFinal),
        toPiece('lid', { zh: '上蓋', en: 'Lid' }, lidFinal),
        toPiece('liner', { zh: '內襯', en: 'Liner' }, linerFinal!),
      ]
    : [toPiece('base', { zh: '下盒', en: 'Base' }, baseFinal), toPiece('lid', { zh: '上蓋', en: 'Lid' }, lidFinal)];

  const allResults = linerEnabled ? [baseFinal, lidFinal, linerFinal!] : [baseFinal, lidFinal];
  const paths = allResults.flatMap((r) => r.paths);
  const texts = allResults.flatMap((r) => r.texts);
  const bounds = segmentsBounds(paths.flatMap((path) => path.segments));

  return { paths, texts, bounds, pieces };
}

// ─────────────────────────────────────────────────────────────────────────
// 不變式
// ─────────────────────────────────────────────────────────────────────────
//
// FX4（whole-branch review 查證結論：是 bug，非「tags 本來就是參數定位用途」）：`tags`
// 欄位的唯一消費者是 Canvas.tsx 的 highlightTags 機制——`highlightSet` 由 hover 高亮
// （ParamPanel 讀 `BoxParamDef.highlightTags`）∪ 不變式警告的 `tags` 聯集而成，
// `isHighlighted` 拿它比對每條 `DielinePath.tags`（見 tray.ts/liner.ts 的 push 慣例，
// 標的是 'wallRoot'/'wallTop'/'gusset'/'tongueFlap'/'linerFlap' 這類幾何 tag，不是
// `BoxParamDef.key`）——這條鏈路裡沒有第二個「參數定位」用途。RTE 的不變式 tags 剛好
// 常等於參數 key，只是因為 RTE 自己的 `path.tags`／`param.highlightTags` 也剛好用參數 key
// 當 vocabulary（見 reverse-tuck-end.ts 的 push('cut','tuckLock',...) 與同名 param）；
// telescope 的 `BoxParamDef.highlightTags` 從一開始就改用幾何 tag（見上方 params 宣告，
// basePlatformWidth/thickness/linerFitGap 的 highlightTags 分別是 'wallTop'/'wallRoot'/
// 'linerPad'，不是參數自己的 key），下面幾條不變式當初卻直接複製 RTE 的「回傳參數 key」
// 寫法，導致 tags 對不上任何真實 path——Canvas 高亮變成無聲的 no-op（review 抓到的
// gusset-b-fits 只是其中一個例子）。本檔 telescope-fixture.test.ts 的 BOUNDARY_EXEMPT_TAGS
// 表（cut 自撞豁免用途，另一條獨立機制）早就把 gusset-b-fits/tongue-flap-fits/
// liner-flap-fits 對應到 'gusset'/'tongueFlap'/'linerFlap' 這組幾何 tag，等於這個
// codebase 自己的另一處已經印證了正確 vocabulary 是什麼——這裡改成一致。
// 修法：tags 改回傳 tray.ts/liner.ts 實際使用的幾何 tag（liner-flange-fits／rim-flush／
// gusset-b-fits／tongue-flap-fits 四條）；pieces-identity 本來就用 baseLength/baseWidth/
// lidMargin（這三個字串同時也是 index.ts 自己 makeDimension() 蓋的 dimension path 的
// tag，見 buildBasePiece/buildLidPiece 呼叫 addTrayDimensions 傳入的 tagL/tagW/tagH），
// 已經對得上真實 path，不用改（Slice 5 F1 追記：lidMargin 拆 lidMarginX/lidMarginY 兩軸後，
// 這條原則不變——兩個新 key 同樣對得上 addTrayDimensions 的 tagL/tagW，見 buildLidPiece）。
//
// 2026-07-09 T7 gate 追記：liner-flange-fits 已因內襯重定義（平台式，見 liner.ts 檔頭）
// 整條作廢，改名 liner-flap-fits（語意與 tag 隨新幾何換新，上面 FX4 敘述的原則不變）。

const invariants: BoxInvariant[] = [
  {
    id: 'pieces-valid',
    description: {
      zh: 'pieces 完整性（spec §3.3）：片 id 唯一、每片非空、path/text 歸屬聯集＝全集且兩兩不交、各片 bounds 涵蓋成員且兩兩不重疊、總 bounds＝全片 hull＝全幾何 hull。',
    },
    check(_params, result) {
      const v = validatePieces(result);
      if (!v.ok) return { ok: false, message: { zh: v.message, en: v.message } };
      return { ok: true };
    },
  },
  {
    id: 'liner-flap-fits',
    description: {
      zh: '2026-07-09 T7 gate 反饋重定義（取代 liner-flange-fits）：內襯平台式腳架的參數域邊界，3 條件依序檢查——① 底面尺寸（padL/padW，由下盒內淨與套合間隙導出）必須為正值，否則底面幾何不存在（極端參數才會踩到，例如 baseLength/linerFitGap 超出宣告 UI 範圍）；② 腳架深度（linerFlapDepth）不得超過下盒壁高（baseHeight），否則內襯會頂出下盒盒口；③ 腳架深度不得超過底面邊長（padL 或 padW）的一半，否則翼片外緣反轉自撞（梯形「外緣＝邊長−2×flapDepth」的幾何推論）。只在 linerEnabled 時適用（同 liner-flange-fits 舊慣例：關閉內襯的純二件式盒沒有內襯幾何，警告無意義）。',
    },
    check(params) {
      if (!(params.linerEnabled as boolean)) {
        return { ok: true };
      }
      const baseHeight = params.baseHeight as number;
      const linerFlapDepth = params.linerFlapDepth as number;
      const frame = deriveLinerFrame({
        baseLength: params.baseLength as number,
        baseWidth: params.baseWidth as number,
        thickness: params.thickness as number,
        fitGap: params.linerFitGap as number,
      });

      if (frame.padL <= 0 || frame.padW <= 0) {
        return {
          ok: false,
          message: {
            zh: `內襯底面尺寸（${frame.padL.toFixed(2)}×${frame.padW.toFixed(2)}mm）非正值，參數組合下底面幾何不存在`,
            en: `Liner base dimensions (${frame.padL.toFixed(2)}×${frame.padW.toFixed(2)}mm) are not positive; no base geometry exists for this parameter combination.`,
          },
          tags: ['baseLength', 'baseWidth', 'linerPad'],
        };
      }

      if (linerFlapDepth > baseHeight) {
        return {
          ok: false,
          message: {
            zh: `內襯腳架深度 ${linerFlapDepth}mm 超過下盒壁高 ${baseHeight}mm，內襯會頂出盒口`,
            en: `Liner leg depth ${linerFlapDepth}mm exceeds the base wall height of ${baseHeight}mm; the liner will project above the box opening.`,
          },
          tags: ['baseHeight', 'linerFlap'],
        };
      }

      const minPadEdge = Math.min(frame.padL, frame.padW);
      if (linerFlapDepth > minPadEdge / 2) {
        return {
          ok: false,
          message: {
            zh: `內襯腳架深度 ${linerFlapDepth}mm 超過底面較短邊長 ${minPadEdge.toFixed(2)}mm 的一半，翼片外緣已反轉自撞`,
            en: `Liner leg depth ${linerFlapDepth}mm exceeds half the shorter base edge of ${minPadEdge.toFixed(2)}mm; the flap’s outer edge has reversed and self-intersected.`,
          },
          tags: ['baseLength', 'baseWidth', 'linerFlap'],
        };
      }

      return { ok: true };
    },
  },
  {
    id: 'pieces-identity',
    description: {
      zh: 'base 片主面板實測必須等於 baseLength×baseWidth；lid 片主面板實測必須等於 baseWidth＋2×lidMarginX（x 向）與 baseLength＋2×lidMarginY（y 向）——Slice 5 F1 拆兩軸後 X/Y 各自獨立驗證（從生成幾何反推，防止 lid/base 整包對調，也防兩軸放大量算錯軸）。',
    },
    check(params, result) {
      const tol = 0.05; // mm，量測反推容差（跟 T3 的 t-無關槽位對帳同一量級）
      const base = result.pieces!.find((piece) => piece.id === 'base')!;
      const lid = result.pieces!.find((piece) => piece.id === 'lid')!;
      const baseMeasured = measuredPanel(result.paths.filter((path) => base.pathIds.includes(path.id)));
      const lidMeasured = measuredPanel(result.paths.filter((path) => lid.pathIds.includes(path.id)));
      const baseWidth = params.baseWidth as number;
      const baseLength = params.baseLength as number;
      const lidMarginX = params.lidMarginX as number;
      const lidMarginY = params.lidMarginY as number;
      const checks: Array<[string, number, number, string[]]> = [
        ['base.x（=baseWidth）', baseMeasured.x, baseWidth, ['baseWidth']],
        ['base.y（=baseLength）', baseMeasured.y, baseLength, ['baseLength']],
        ['lid.x（=baseWidth+2×lidMarginX）', lidMeasured.x, baseWidth + 2 * lidMarginX, ['baseWidth', 'lidMarginX']],
        ['lid.y（=baseLength+2×lidMarginY）', lidMeasured.y, baseLength + 2 * lidMarginY, ['baseLength', 'lidMarginY']],
      ];
      for (const [label, actual, expected, tags] of checks) {
        if (Math.abs(actual - expected) > tol) {
          return {
            ok: false,
            message: {
              zh: `${label} 主面板實測 ${actual.toFixed(2)}mm 應為 ${expected.toFixed(2)}mm（pieces 身分可能對調或算錯）`,
              en: `${label} main panel measures ${actual.toFixed(2)}mm; expected ${expected.toFixed(2)}mm. Piece identities may be swapped or miscalculated.`,
            },
            tags,
          };
        }
      }
      return { ok: true };
    },
  },
  {
    id: 'rim-flush',
    description: {
      zh: 'Slice 5 F3 分流（H4）：下盒（base）先摺壁（x 向）外壁高必須等於後摺壁（y 向）外壁高減 wallTopCompensation；上蓋（lid）B-06 左右壁特例移除，先摺壁外壁高必須直接等於後摺壁外壁高（四面等高，不作任何補償）。base／lid 兩條規則各自獨立驗（從生成幾何反推，非只驗參數）。',
    },
    check(params, result) {
      const wallTopCompensation = params.wallTopCompensation as number;

      const basePiece = result.pieces!.find((piece) => piece.id === 'base')!;
      const baseWalls = measuredOuterWalls(result.paths.filter((path) => basePiece.pathIds.includes(path.id)));
      if (Math.abs(baseWalls.x - (baseWalls.y - wallTopCompensation)) > EPS) {
        return {
          ok: false,
          message: {
            zh: `base 片先摺壁外壁高 ${baseWalls.x.toFixed(3)}mm 應等於後摺壁 ${baseWalls.y.toFixed(3)}mm − 壁頂平齊補償 ${wallTopCompensation}mm`,
            en: `Base first-fold outer-wall height ${baseWalls.x.toFixed(3)}mm should equal second-fold wall height ${baseWalls.y.toFixed(3)}mm − wall-top compensation ${wallTopCompensation}mm.`,
          },
          // FX4：'wallTopCompensation' 不是任何 path 的 tag（tray.ts 的壁根 crease 用
          // 'wallRoot'，也是這個參數自己宣告的 highlightTags），改對。
          tags: ['wallRoot'],
        };
      }

      const lidPiece = result.pieces!.find((piece) => piece.id === 'lid')!;
      const lidWalls = measuredOuterWalls(result.paths.filter((path) => lidPiece.pathIds.includes(path.id)));
      if (Math.abs(lidWalls.x - lidWalls.y) > EPS) {
        return {
          ok: false,
          message: {
            zh: `lid 片先摺壁外壁高 ${lidWalls.x.toFixed(3)}mm 應等於後摺壁 ${lidWalls.y.toFixed(3)}mm（B-06：左右壁特例移除，四面外壁應等高）`,
            en: `Lid first-fold outer-wall height ${lidWalls.x.toFixed(3)}mm should equal second-fold wall height ${lidWalls.y.toFixed(3)}mm. Under B-06, the left/right-wall exception is removed and all four outer walls should be equal in height.`,
          },
          tags: ['wallRoot'],
        };
      }

      return { ok: true };
    },
  },
  {
    id: 'gusset-b-fits',
    description: {
      zh: '薄壁（platformWidth=0）角撐用固定半徑的讓位弧，壁高過矮時讓位槽會反轉自撞——門檻隨紙厚微調（見 minStyleBHeight 推導）。spec 允許 baseHeight/lidHeight 低至 10mm，這裡只警告不擋，讓使用者知道幾何已退化。',
    },
    check(params) {
      const t = params.thickness as number;
      const minH = minStyleBHeight(t);
      const checks: Array<[string, number, number]> = [
        ['basePlatformWidth', params.basePlatformWidth as number, params.baseHeight as number],
        ['lidPlatformWidth', params.lidPlatformWidth as number, params.lidHeight as number],
      ];
      for (const [platformKey, platformWidth, height] of checks) {
        if (platformWidth === 0 && height < minH) {
          return {
            ok: false,
            message: {
              zh: `${platformKey}=0（薄壁角撐）時壁高 ${height}mm 低於 ${minH.toFixed(1)}mm，讓位槽幾何已擠壓變形`,
              en: `With ${platformKey}=0 (thin-wall gusset), wall height ${height}mm is below ${minH.toFixed(1)}mm; the relief geometry has compressed and deformed.`,
            },
            // FX4：platformKey（'basePlatformWidth'/'lidPlatformWidth'）不是任何 path 的
            // tag，退化的讓位槽幾何本身標的是 'gusset'（tray.ts buildGussetA/buildGussetB），改對。
            tags: ['gusset'],
          };
        }
      }
      return { ok: true };
    },
  },
  {
    id: 'tongue-flap-fits',
    description: {
      zh: '插底舌兩端各留一段角撐讓位、45° 過渡再各吃掉半個全深——牆的垂直半跨（＝面板另一軸邊長的一半）小於兩者之和時，梯形全深段的兩端點順序反轉、插底舌 cut 自我交叉。shortWall 與 A 款（platformWidth>0）longWall 讓位＝TONGUE_END_RECESS(9)，門檻＝MIN_TONGUE_PERP_HALF(16.5mm，對應面板邊長 33mm)；B 款（platformWidth=0）longWall 讓位改用角撐周邊複合鏈的接合 recess（B_TONGUE_RESERVED_LONGWALL+innerWallReduction，恆≥9），門檻改用 minBLongWallPerpHalf（production 預設 innerWallReduction=0.8 時＝17.698mm，對應面板邊長 35.396mm；F1 review Fix，2026-07-11——同步門檻見該函式 docblock，re-review Medium finding）。上蓋面板恆比下盒大（Slice 5 F1 拆兩軸後：x 向 +2×lidMarginX、y 向 +2×lidMarginY，兩者下限皆 5），實務上由下盒兩邊長把關，上蓋兩列為防禦性保留（防未來參數域調整）。只警告不擋（同 gusset-b-fits 慣例），讓使用者知道幾何已退化。',
    },
    check(params) {
      const baseLength = params.baseLength as number;
      const baseWidth = params.baseWidth as number;
      const lidMarginX = params.lidMarginX as number;
      const lidMarginY = params.lidMarginY as number;
      const innerWallReduction = params.innerWallReduction as number;
      const basePlatformWidth = params.basePlatformWidth as number;
      const lidPlatformWidth = params.lidPlatformWidth as number;
      // B 款（platformWidth<=0，同 tray.ts useThickStyle=platformWidth>0 的反相判準，見
      // anyBTongueDegradation 先例）longWall 門檻改用 minBLongWallPerpHalf；其餘（A 款
      // longWall、shortWall 不分款式）沿用原 MIN_TONGUE_PERP_HALF——只有 longWall 受影響，
      // 因 tray.ts buildWall 的 flapRecess 只在 !independentJogEntity && !hasDoubleRoot
      // （B 款＋longWall）時才傳 recessOverride，shortWall 恆為 undefined。
      const baseLongWallMin = basePlatformWidth <= 0 ? minBLongWallPerpHalf(innerWallReduction) : MIN_TONGUE_PERP_HALF;
      const lidLongWallMin = lidPlatformWidth <= 0 ? minBLongWallPerpHalf(innerWallReduction) : MIN_TONGUE_PERP_HALF;
      // 每片×每軸：x 向牆（左右壁）的舌片沿面板 y 邊分佈（perpHalf＝panelW/2）、
      // y 向牆（前後壁）沿面板 x 邊（perpHalf＝panelL/2）——見 tray.ts generateTray 的
      // buildWall 呼叫（perpHalfSpan 參數）。lid 的 panelL＝baseWidth+2×lidMarginX（x 向，
      // 決定前後壁 perpHalf）、panelW＝baseLength+2×lidMarginY（y 向，決定左右壁
      // perpHalf）——Slice 5 F1 拆兩軸後這裡要對到各自正確的那個 margin，不可交叉套用
      // （見 generate() 的 lidPanelX/lidPanelY 推導，同一組軸對應關係）。
      // FX4：baseLength/baseWidth/lidMarginX/lidMarginY 這些字串本身有效（同時是 index.ts
      // 自己蓋的 dimension path tag，見上方檔頭註解），但真正退化的幾何是插底舌本身，補上
      // 'tongueFlap'（tray.ts buildTongueFlap 的 tag）讓高亮同時點出實際自撞的那段輪廓。
      const checks: Array<[string, number, string[], number]> = [
        ['base 片左右壁的插底舌所在邊 baseLength', baseLength, ['baseLength', 'tongueFlap'], baseLongWallMin],
        ['base 片前後壁的插底舌所在邊 baseWidth', baseWidth, ['baseWidth', 'tongueFlap'], MIN_TONGUE_PERP_HALF],
        ['lid 片左右壁的插底舌所在邊 baseLength＋2×lidMarginY', baseLength + 2 * lidMarginY, ['baseLength', 'lidMarginY', 'tongueFlap'], lidLongWallMin],
        ['lid 片前後壁的插底舌所在邊 baseWidth＋2×lidMarginX', baseWidth + 2 * lidMarginX, ['baseWidth', 'lidMarginX', 'tongueFlap'], MIN_TONGUE_PERP_HALF],
      ];
      for (const [label, edge, tags, minPerpHalf] of checks) {
        if (edge / 2 < minPerpHalf) {
          const minEdge = 2 * minPerpHalf;
          return {
            ok: false,
            message: {
              zh: `${label}＝${edge}mm 低於插底舌讓位所需的最小邊長 ${minEdge}mm，該側插底舌梯形已反轉自撞`,
              en: `${label}=${edge}mm is below the minimum edge length of ${minEdge}mm required for the bottom-lock tongue relief; the tongue trapezoid on this side has reversed and self-intersected.`,
            },
            tags,
          };
        }
      }
      return { ok: true };
    },
  },
  {
    id: 'notch-reduced',
    description: {
      zh: 'Slice 5 F4／spec §縮放與降級表：A 款（platformWidth>0）側壁雙 U-notch 若中心距/開口不足以並存兩個（2×比例中心距−30<5，或有一個超出壁內），先退化為單一置中 notch。只警告不擋，讓使用者知道細節已降級（tray.ts longWallNotchPlan 的同一門檻，這裡獨立重算供 UI 警告用）。',
    },
    check(params) {
      if (!anyNotchDegradation(params, 'notch-reduced')) return { ok: true };
      return {
        ok: false,
        message: {
          zh: '側壁雙 U-notch 放不下兩個，已退化為單一置中 notch（notch-reduced）',
          en: 'Two side-wall U-notches do not fit; reduced to one centred notch (notch-reduced).',
        },
        tags: ['tongueFold', 'uNotch'],
      };
    },
  },
  {
    id: 'notch-omitted',
    description: {
      zh: 'Slice 5 F4／spec §縮放與降級表：A 款（platformWidth>0）U-notch（側壁單一置中或上下壁）若壁長不足 30+2×5=40mm，該 notch 全省（結構主體仍合法，只是不再有這個功能性讓位槽）。只警告不擋。',
    },
    check(params) {
      if (!anyNotchDegradation(params, 'notch-omitted')) return { ok: true };
      return {
        ok: false,
        message: {
          zh: 'U-notch 壁長不足 40mm，已全部省略（notch-omitted）',
          en: 'Wall length is below the 40mm required for a U-notch; all U-notches omitted (notch-omitted).',
        },
        tags: ['tongueFold', 'uNotch'],
      };
    },
  },
  {
    id: 'platform-corner-omitted',
    description: {
      zh: 'Slice 5 F6-A／spec §縮放與降級表：A 款平台端 R2.5 圓角需 platformWidth≥2.5mm 才有意義，否則降級為直角轉接（platform-corner-omitted）。只警告不擋。',
    },
    check(params) {
      const basePlatformWidth = params.basePlatformWidth as number;
      const lidPlatformWidth = params.lidPlatformWidth as number;
      const degraded = (basePlatformWidth > 0 && basePlatformWidth < PLATFORM_CORNER_MIN_WIDTH_MM) || (lidPlatformWidth > 0 && lidPlatformWidth < PLATFORM_CORNER_MIN_WIDTH_MM);
      if (!degraded) return { ok: true };
      return {
        ok: false,
        message: {
          zh: `平台端寬度低於 ${PLATFORM_CORNER_MIN_WIDTH_MM}mm，角落圓角降級為直角（platform-corner-omitted）`,
          en: `Platform-end width is below ${PLATFORM_CORNER_MIN_WIDTH_MM}mm; corner radius reduced to a square corner (platform-corner-omitted).`,
        },
        tags: ['platformCorner'],
      };
    },
  },
  {
    id: 'gusset-relief-omitted',
    description: {
      zh: 'Fix 2·2026-07-11 review H2／spec §縮放與降級規律「放不下就省略＋警告」：A 款角撐周邊複合 relief 鏈（aGussetPeriphery）尺寸固定 nominal 不隨壁高縮放（Fix 3 取代先前的無條件縮放安全網），壁長過短（與 U-notch 或壁界衝突）或壁高極端偏離校準值（鏈自身因錨點校正而扭曲自撞）時整鏈省略，只警告不擋。與 notch-reduced/notch-omitted 各自獨立判斷（鏈可能省略但 notch 仍可容納，反之亦然）。',
    },
    check(params, result) {
      if (!anyGussetChainOmitted(params, result)) return { ok: true };
      return {
        ok: false,
        message: {
          zh: 'A 款角撐周邊複合 relief 鏈與 U-notch／壁界衝突，或壁高偏離校準值致鏈自身扭曲自撞，已整鏈省略（gusset-relief-omitted）',
          en: 'Type A gusset perimeter relief chain conflicts with a U-notch or wall boundary, or wall height has distorted the chain into self-intersection; entire chain omitted (gusset-relief-omitted).',
        },
        tags: ['aGussetPeriphery'],
      };
    },
  },
  {
    id: 'tongue-crease-shrunk',
    description: {
      zh: 'Slice 5 F5／spec §縮放與降級表：B 款（platformWidth=0）舌根端段縮減分支 2——扣除 V relief／角撐周邊保留區後的可用舌摺線長度 reservedSpan 若 10≤reservedSpan<2×E+10（E＝該壁端段 nominal 45/35），端段縮至 (reservedSpan−10)/2。只警告不擋。',
    },
    check(params) {
      if (!anyBTongueDegradation(params, 'tongue-crease-shrunk')) return { ok: true };
      return {
        ok: false,
        message: {
          zh: 'B 款舌根端段可用長度不足 nominal，已縮減（tongue-crease-shrunk）',
          en: 'Available length at the Type B tongue-root end segment is below nominal; segment shortened (tongue-crease-shrunk).',
        },
        tags: ['tongueFold'],
      };
    },
  },
  {
    id: 'tongue-crease-omitted',
    description: {
      zh: 'Slice 5 F5／spec §縮放與降級表：B 款舌根端段縮減分支 3——可用舌摺線長度 reservedSpan<10 時端段全省，整段改 halfcut。只警告不擋。',
    },
    check(params) {
      if (!anyBTongueDegradation(params, 'tongue-crease-omitted')) return { ok: true };
      return {
        ok: false,
        message: {
          zh: 'B 款舌根端段可用長度過短，已全省改 halfcut（tongue-crease-omitted）',
          en: 'Available length at the Type B tongue-root end segment is too short; segment omitted and replaced with a half-cut (tongue-crease-omitted).',
        },
        tags: ['tongueFold'],
      };
    },
  },
  {
    id: 'relief-omitted',
    description: {
      zh: 'Slice 5 F5／spec §縮放與降級表：V relief 依附端段（僅 shortWall／前後壁）——端段實際長 E′<7.5（2.5＋安全邊5）時省略 V relief；分支 3（無端段）恆省略。只警告不擋。',
    },
    check(params) {
      if (!anyReliefOmitted(params)) return { ok: true };
      return {
        ok: false,
        message: {
          zh: 'V relief 依附端段過短，已省略（relief-omitted）',
          en: 'End segment supporting the V relief is too short; relief omitted (relief-omitted).',
        },
        tags: ['tongueFold', 'vRelief'],
      };
    },
  },
  {
    id: 'no-nan',
    description: { zh: '所有幾何座標必須是有效數字；任何 NaN 代表參數鏈某處算式除零或讀到未定義值。' },
    check(_params, result) {
      if (hasNaN(result.paths.flatMap((p) => p.segments))) {
        return { ok: false, message: { zh: '偵測到 NaN 座標', en: 'NaN coordinate detected.' } };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-bleed',
    description: { zh: 'v1 尚不支援出血線（bleed）——不得產生 bleed 線型的路徑（spec §8 全盒型通則）。' },
    check(_params, result) {
      if (result.paths.some((p) => p.type === 'bleed')) {
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
    description: { zh: '回傳的 bounds 必須完整涵蓋所有路徑的實際範圍，否則畫布視窗或匯出裁切框會裁掉部分幾何。' },
    check(_params, result) {
      const actual = segmentsBounds(result.paths.flatMap((p) => p.segments));
      const boundsEps = 0.01;
      const ok =
        actual.minX >= result.bounds.minX - boundsEps &&
        actual.maxX <= result.bounds.maxX + boundsEps &&
        actual.minY >= result.bounds.minY - boundsEps &&
        actual.maxY <= result.bounds.maxY + boundsEps;
      if (!ok) {
        return {
          ok: false,
          message: { zh: 'bounds 未完整涵蓋所有路徑的實際範圍', en: 'Bounds do not fully cover the actual extent of all paths.' },
        };
      }
      return { ok: true };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 模組匯出與自我註冊
// ─────────────────────────────────────────────────────────────────────────

export const telescope: BoxModule = {
  meta: {
    id: 'telescope',
    name: { zh: '天地盒 (Telescope Box)', en: 'Telescope Box' },
    intro: {
      zh: '上蓋與下盒共用同一套免膠雙壁 tray 拓撲、上蓋依長短向分別放大套住下盒（Slice 5 F1：lidMarginX／lidMarginY 兩軸獨立，不再是單一等邊放大量）；內襯墊片放進下盒貼底，四翼向下摺成腳架把物品墊高（2026-07-09 T7 gate 反饋重定義：平台式，取代舊圍框版）。',
      en: 'Lid and base share the same glueless double-wall tray topology; the lid expands independently along the long and short axes to fit over the base (Slice 5 F1: separate lidMarginX and lidMarginY, replacing a single equal oversize). The liner pad seats against the base with four flaps folded down as legs to raise the contents, following the 2026-07-09 T7 gate redefinition from the former frame liner.',
    },
    topology: 'nested',
  },
  params,
  invariants,
  generate,
};

registerBox(telescope);
