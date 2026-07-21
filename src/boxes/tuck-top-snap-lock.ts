/**
 * 插底盒（Tuck-Top Snap-Lock Carton）—— 反插式頂蓋 ＋ 1-2-3 / snap-lock 底封的刀模模組。
 *
 * 盒身四片面板一字排開（與 RTE 同拓撲），頂部為反插式插舌（P3 帶 cubic bezier 收窄弧的插舌、
 * P2/P4 防塵翼、P1 素邊），底部為 1-2-3 snap-lock 四片（P2/P4 先摺窄翼、P3 中央內縮缺口
 * 接收片、P1 梯形尖端最後鎖入 P3 缺口）。座標鏈依原始刀模量測值忠實復刻（1pt=0.352778mm
 * 換算後 local mm）：P1↔糊邊摺線→local x=0、頂摺線→local y=0、底摺線→local y=D。
 *
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 * 補償策略：snap-lock 底的非零紙厚咬合補償尚未經實體樣品驗證，本模組一律 thickness=0
 * 建構（不暴露 thickness 參數），幾何在 t=0 下正確。
 */

import type { Segment } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import type { BoxInvariant, BoxModule, BoxParamDef, DielinePath, DielineText, GenerateResult, LineType, ResolvedParams } from '@/core/types';
import { registerBox } from '@/core/registry';
import { hasNaN, hasSelfIntersection, segmentsBounds } from '@/core/geometry';
import { GLUE_CHAMFER, dimensionLine } from '@/core/primitives';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數（依原刀模量測值正規化·非預設 L/W 的縮放為經評估接受的近似）
// ─────────────────────────────────────────────────────────────────────────

/** 四分圓 cubic bezier 近似係數（圓角一律用 bezier·見檔頭）。 */
const KAPPA = 0.5523;

/**
 * 盒身 girth 補償係數（沿用 RTE·spec §4.1 同表）：面板序「從糊邊側起算」P1..P4，貼糊邊面板
 * 不補償（+0），往外每過一道摺線多補一個紙厚（+t、+t），離糊邊最遠面板累積 +2t。t=0 時歸零、
 * 與名義幾何等價。snap-lock 底/插舌不套此補償（見 generate 內說明·非零紙厚咬合待實體樣品驗證）。
 */
const GIRTH_COMP_FROM_GLUE = [0, 1, 1, 2] as const;

// 頂部反插插舌（P3）
// 插舌 fold 寬與尖端寬隨面板寬縮放（自面板邊界固定內縮·蓋板兩側緣因此恆為垂直、與盒身同寬）：
// fold 寬 = P3 寬 − 2×7.5、尖端寬 = P3 寬 − 2×15.25。原刀模 P3=85 → fold 70、尖端 54.5。
/** 插舌摺線每側自面板邊界的固定內縮（原刀模：(85−70)/2）。 */
const TUCK_FOLD_MARGIN = 7.5;
/** 插舌尖端平邊每側自面板邊界的固定內縮（原刀模：(85−54.5)/2）。 */
const TUCK_TIP_MARGIN = 15.25;
/** 蓋板高相對 W 的內縮（原刀模：W55 − flap 摺線 54 = 1）。 */
const TUCK_FOLD_INSET = 1.0;
/** 蓋板側邊比 flap 摺線多延伸的量（原刀模：54.797 − 54）。 */
const LID_SIDE_EXTRA = 0.797;
// 收窄弧 bezier 控制點與收窄弧根（相對插舌尖端角·原刀模 逐字·左半·右半鏡射）
const SH_BASE_DX = -14.944; // 收窄弧根相對尖端角 dx
const SH_BASE_DY = 13.691; // 收窄弧根相對尖端角 dy（向盒口方向為正）
const SH_C1_DX = -14.267;
const SH_C1_DY = 5.946;
const SH_C2_DX = -7.779;
const SH_C2_DY = 0.002;
/**
 * 頂部插舌所需的最小 P3 面板寬：尖端平邊寬（P3 寬 − 2×TUCK_TIP_MARGIN）必須為正，否則尖端
 * 兩角相交、兩側收窄弧自撞。下限＝2×TUCK_TIP_MARGIN（尖端寬歸零的退化點）。
 */
const TUCK_MIN_P3_WIDTH = 2 * TUCK_TIP_MARGIN;
// 頂部防塵翼（P2/P4）
/** 防塵翼摺線在靠斜切側的內縮（僅面板交界側需·自由邊側=0）。 */
const DF_FOLD_INSET_SLANT = 0.6;
/** 防塵翼斜切側先直上的高度。 */
const DF_SLANT_RISE = 5.997; // 原刀模 LINE1 終點 −5.997（kink 再降 DF_KINK 到 −7.997）
/** 防塵翼斜切側 2mm×2mm 折點（原刀模 LINE2·(85.602,−6)→(87.602,−8)）。 */
const DF_KINK = 2.0;
/** 防塵翼斜切段水平位移（自 kink 後折點到尖端·原刀模 LINE3）。 */
const DF_SLANT_DX = 6.159;
/** 防塵翼直邊側自面板邊的內縮。 */
const DF_STRAIGHT_INSET = 3.0;
/**
 * 兩側翼片交界的讓位切口深度（原刀模：翼片角回摺線的 −1.5mm 凹口·LINE9/ARC 端點皆落此）。
 * 頂部 P2↔P3 / P3↔P4 交界、防塵翼直邊側回摺線皆用此深度連續銜接（避免紙橋）。
 */
const CONNECTOR_DROP = 1.5;

// 底部 snap-lock 圓角
/** snap-lock 尖端/缺口轉角圓角半徑（3.5mm）。 */
const LOCK_CORNER_R = 3.5;
/** P1 梯形對角段佔全深比例（原刀模：28.003/38.548）——用比例確保 lockFlapDepth 調小仍穩健。 */
const TAB_DIAG_FRAC = 0.7265;
/** P2/P4 窄翼尖端寬（固定·非參數化·lockTaper 範疇）。 */
const WING_TIP_WIDTH = 22.652;
/** P2/P4 窄翼斜切段起點佔全深比例（原刀模：24.748/38.548）。 */
const WING_DIAG_FRAC = 0.642;
/** P3 外翼外緣自面板邊的內縮（notch-fits-panel 相依域用；底部基座角實際座標逐字複製 原刀模）。 */
const RECV_LEAF_RELIEF = 0.751;

// snap-lock 四欄的預設隨長寬比例縮放（derivedDefault·使用者可 override）。比例取自原刀模
// P3=85/W=55 的量測值，代入 L=85/W=55 精確還原原值（38.5/11/39.5/31.5）。此比例下咬合恆過：
// overlapDepth = 2·(0.7W) − 0.2W − W = 0.2W > 0；插入餘隙 = (Rw−Tw)/2 = (8/85)·L/2 恆正且 Tw<Rw。
/** 底片深度佔盒寬比例（原刀模：38.5/55）。 */
const LOCK_FLAP_DEPTH_RATIO = 0.7;
/** 接收缺口內縮佔盒寬比例（原刀模：11/55）。 */
const LOCK_RECEIVE_DEPTH_RATIO = 0.2;
/** 接收缺口寬佔盒長比例（原刀模：39.5/85）。 */
const LOCK_RECEIVE_WIDTH_RATIO = 39.5 / 85;
/** 鎖入尖端寬佔盒長比例（原刀模：31.5/85）。 */
const LOCK_TAB_WIDTH_RATIO = 31.5 / 85;

// ─────────────────────────────────────────────────────────────────────────
// 參數宣告
// ─────────────────────────────────────────────────────────────────────────
//
// 只宣告「真正驅動幾何」的欄位：每個宣告參數取第二有效值都必須改變輸出，否則屬未接線的假旋鈕。
// 命名對齊 `reverse-tuck-end.ts` 公開欄位（L/W/D/glueSize/glueSide/tuckDepth/dustFlapDepth）。
// 不宣告 thickness（一律 t=0）、tuckRadius/tuckClearance/tuckLock/flapNotch/creaseRelief
// （本盒頂為固定 bezier 收窄弧＋無 friction lock·這些欄位不驅動任何幾何·宣告即假旋鈕）。
const params: BoxParamDef[] = [
  {
    key: 'L',
    label: { zh: '長度 (L)', en: 'Length (L)' },
    unit: 'mm',
    default: 85,
    min: 20,
    max: 500,
    step: 1,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '成品的長邊內尺寸，決定前後兩片面板（P1、P3）的寬度；P3 為頂部插舌與底部接收片所在。',
      en: 'Finished long-side inside dimension; sets the width of the front and back panels (P1 and P3). P3 carries the top tuck and the bottom receiving panel.',
    },
    highlightTags: ['L'],
  },
  {
    key: 'W',
    label: { zh: '寬度 (W)', en: 'Width (W)' },
    unit: 'mm',
    default: 55,
    min: 20,
    max: 500,
    step: 1,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '成品的短邊內尺寸，決定左右兩片側板（P2、P4）的寬度，也決定頂蓋要多高才能蓋住開口。',
      en: 'Finished short-side inside dimension; sets the width of the left and right side panels (P2 and P4) and the height the top closure needs to cover the opening.',
    },
    highlightTags: ['W'],
  },
  {
    key: 'D',
    label: { zh: '深度 (D)', en: 'Depth (D)' },
    unit: 'mm',
    default: 125,
    min: 20,
    max: 500,
    step: 1,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '盒身的高度（開口到底部的距離），決定四片主面板與所有直向摺線的長度。',
      en: 'Body depth, measured from the opening to the base; sets the length of all four main panels and every vertical crease.',
    },
    highlightTags: ['D'],
  },
  {
    key: 'thickness',
    label: { zh: '紙厚', en: 'Board caliper' },
    unit: 'mm',
    default: 0.3,
    min: 0,
    max: 0.8,
    step: 0.1,
    group: { id: 'dimensions', zh: '尺寸與材質', en: 'Dimensions & board' },
    description: {
      zh: '紙張厚度（caliper）。盒身四片面板依摺次遞增補償（沿用 RTE），設 0 可還原無補償幾何。snap-lock 底封的非零紙厚咬合補償尚需白樣驗證，本層底封尺寸維持名義值。',
      en: 'Board caliper; applies progressive per-fold compensation to the four body panels (inherited from RTE). A value of 0 restores the uncompensated geometry. Non-zero-thickness engagement compensation for the snap-lock base still awaits white-sample validation, so the base dimensions stay nominal.',
    },
    highlightTags: ['D'],
  },
  {
    key: 'tuckDepth',
    label: { zh: '插舌深度', en: 'Tuck depth' },
    unit: 'mm',
    default: 18,
    min: 4,
    max: 60,
    step: 1,
    group: { id: 'tuckLock', zh: '插舌與鎖扣', en: 'Tuck & lock' },
    description: {
      zh: '頂部插舌自摺線伸進盒身的深度，決定上蓋抗拉開的力道。',
      en: 'Depth the top tuck extends past its crease into the body; determines the top closure’s resistance to pull-out.',
    },
    highlightTags: ['tuckDepth'],
  },
  {
    key: 'dustFlapDepth',
    label: { zh: '防塵翼深度', en: 'Dust-flap depth' },
    unit: 'mm',
    default: 31.6,
    min: 5,
    max: 60,
    step: 0.5,
    group: { id: 'dustGlue', zh: '防塵翼與糊邊', en: 'Dust flaps & glue' },
    description: {
      zh: '左右防塵翼（P2、P4）向內摺入的深度，摺入後蓋住開口內側縫隙，阻擋灰塵與透光。',
      en: 'Inward fold depth of the left and right dust flaps (P2, P4); covers the inner gaps around the opening to block dust and light.',
    },
    highlightTags: ['dustFlapDepth'],
  },
  {
    key: 'lockFlapDepth',
    label: { zh: '底片深度', en: 'Base-flap depth' },
    unit: 'mm',
    default: 38.5,
    min: 10,
    max: 250,
    step: 0.5,
    group: { id: 'snapLock', zh: 'Snap-lock 底', en: 'Snap-lock base' },
    description: {
      zh: '底部四片（P1 尖端、P2/P4 窄翼、P3 兩外翼）自摺線到最深裁切邊的統一深度。留空時隨盒寬自動縮放（0.7×W）。',
      en: 'Shared depth of all four base flaps (the P1 tip, the P2/P4 wings, and the two P3 leaves) from crease to the deepest cut edge. Left blank, it scales with the box width (0.7 × W).',
    },
    highlightTags: ['lockFlapDepth'],
    derivedDefault: (p) => LOCK_FLAP_DEPTH_RATIO * (p.W as number),
  },
  {
    key: 'lockReceiveWidth',
    label: { zh: '接收缺口寬', en: 'Receiving-notch width' },
    unit: 'mm',
    default: 39.5,
    min: 10,
    max: 400,
    step: 0.5,
    group: { id: 'snapLock', zh: 'Snap-lock 底', en: 'Snap-lock base' },
    description: {
      zh: 'P3 接收片中央向內縮的缺口寬度，供 P1 梯形尖端插入鎖定；必須大於 P1 尖端寬才能插入。留空時隨盒長自動縮放（39.5/85×L）。',
      en: 'Width of the central recessed notch on the P3 receiving panel that the P1 trapezoidal tip inserts into; must exceed the P1 tip width to admit it. Left blank, it scales with the box length (39.5/85 × L).',
    },
    highlightTags: ['lockReceiveWidth'],
    derivedDefault: (p) => LOCK_RECEIVE_WIDTH_RATIO * (p.L as number),
  },
  {
    key: 'lockReceiveDepth',
    label: { zh: '接收缺口內縮', en: 'Receiving-notch inset' },
    unit: 'mm',
    default: 11.0,
    min: 1,
    max: 100,
    step: 0.5,
    group: { id: 'snapLock', zh: 'Snap-lock 底', en: 'Snap-lock base' },
    description: {
      zh: 'P3 接收缺口內緣比兩側外翼內縮的量，決定 P1 尖端插入後的咬合重疊深度。留空時隨盒寬自動縮放（0.2×W）。',
      en: 'How much shallower the P3 notch inner edge sits than the two outer leaves; sets the engagement overlap once the P1 tip is inserted. Left blank, it scales with the box width (0.2 × W).',
    },
    highlightTags: ['lockReceiveWidth'],
    derivedDefault: (p) => LOCK_RECEIVE_DEPTH_RATIO * (p.W as number),
  },
  {
    key: 'lockTabWidth',
    label: { zh: '鎖入尖端寬', en: 'Locking-tab width' },
    unit: 'mm',
    default: 31.5,
    min: 5,
    max: 400,
    step: 0.5,
    group: { id: 'snapLock', zh: 'Snap-lock 底', en: 'Snap-lock base' },
    description: {
      zh: 'P1 梯形尖端的平邊寬度，插入 P3 接收缺口完成鎖定；必須窄於接收缺口寬並留足插入餘隙。留空時隨盒長自動縮放（31.5/85×L）。',
      en: 'Flat-tip width of the P1 trapezoidal tab that locks into the P3 receiving notch; must be narrower than the notch and leave adequate insertion clearance. Left blank, it scales with the box length (31.5/85 × L).',
    },
    highlightTags: ['lockTabWidth'],
    derivedDefault: (p) => LOCK_TAB_WIDTH_RATIO * (p.L as number),
  },
  {
    key: 'glueSize',
    label: { zh: '糊邊寬度', en: 'Glue-flap width' },
    unit: 'mm',
    default: 18,
    min: 5,
    max: 60,
    step: 1,
    group: { id: 'dustGlue', zh: '防塵翼與糊邊', en: 'Dust flaps & glue' },
    description: {
      zh: '糊邊（耳仔）的寬度，是黏合面板首尾兩端、把展開圖捲成筒狀盒身所需的多餘寬度。',
      en: 'Glue-flap width; provides the overlap required to join the first and last body panels and form the flat layout into a tube.',
    },
    highlightTags: ['glueSize'],
  },
  {
    key: 'glueSide',
    label: { zh: '糊邊位置', en: 'Glue-flap side' },
    unit: 'enum',
    default: 'left',
    options: [
      { value: 'left', label: { zh: '左', en: 'Left' } },
      { value: 'right', label: { zh: '右', en: 'Right' } },
    ],
    group: { id: 'dustGlue', zh: '防塵翼與糊邊', en: 'Dust flaps & glue' },
    description: {
      zh: '糊邊黏貼在整排面板的左側或右側；只影響版面鏡像方向，不影響盒子本身結構。',
      en: 'Glue-flap position on the left or right of the panel run; mirrors the layout without changing the box structure.',
    },
    highlightTags: ['glueSize'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// snap-lock 摺後咬合純函數（三級契約：硬性失敗／建議警告／通過）
// ─────────────────────────────────────────────────────────────────────────

/** 咬合建議下限（比照 RTE `LOCK_CHAMFER×2`·經評估接受的近似值·以實體樣品終驗）。 */
const SNAP_LOCK_MIN_OVERLAP = 4.0;
/** 最小插入餘隙（每側·經評估接受的防呆值）。 */
const SNAP_LOCK_MIN_CLEARANCE = 1.0;

export interface SnapLockClosure {
  pass: boolean;
  warnings: string[];
  overlapDepth: number;
  clearance: number;
  gapP2P4: number;
  results: { tag: string; ok: boolean }[];
}

/**
 * P1 尖端插入 P3 接收缺口的摺後 2D 咬合檢查。
 * 三級契約：`overlapDepth≤0` hard FAIL（根本沒插進去）／`0<x<4` warning（不進 pass·咬合可能不足）／
 * `≥4` 乾淨過。`pass` 只由 hard 條件決定，`warnings` 獨立回傳。thickness=0 平面投影，
 * 3D 摺疊順序不在本層處理範圍。
 */
export function checkSnapLockClosure(params: {
  L: number;
  W: number;
  lockFlapDepth: number;
  lockReceiveWidth: number;
  lockReceiveDepth: number;
  lockTabWidth: number;
}): SnapLockClosure {
  const { L, W, lockFlapDepth: F, lockReceiveWidth: Rw, lockReceiveDepth: Rd, lockTabWidth: Tw } = params;
  const results: { tag: string; ok: boolean }[] = [];

  // (a) 基礎合法域
  results.push({ tag: 'flapDepthWithinBox', ok: F < W });
  results.push({ tag: 'receiveDepthBounded', ok: 0 < Rd && Rd < F });
  results.push({ tag: 'tabNarrowerThanNotch', ok: Tw < Rw }); // 嚴格小於（原刀模量得每側約 4mm 餘隙·否證等寬）
  const clearance = (Rw - Tw) / 2;
  results.push({ tag: 'minInsertionClearance', ok: clearance >= SNAP_LOCK_MIN_CLEARANCE });

  // (b) 核心咬合重疊深度——三級契約：硬性條件只驗 overlapDepth>0
  const overlapDepth = 2 * F - Rd - W;
  results.push({ tag: 'overlapExists', ok: overlapDepth > 0 });
  const warnings: string[] = [];
  if (overlapDepth > 0 && overlapDepth < SNAP_LOCK_MIN_OVERLAP) {
    warnings.push(
      `overlapShallow: 咬合僅 ${overlapDepth.toFixed(2)}mm < ${SNAP_LOCK_MIN_OVERLAP}mm 建議下限，咬合可能不足（白樣驗證）`,
    );
  }

  // (c) P2/P4 非干涉
  results.push({ tag: 'narrowFlapsNonCollision', ok: 2 * F < L });

  const pass = results.every((r) => r.ok); // warnings 不參與 pass
  return { pass, warnings, overlapDepth, clearance, gapP2P4: L - 2 * F, results };
}

// ─────────────────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────────────────

function addPath(paths: DielinePath[], type: LineType, tag: string | undefined, segments: Segment[]): void {
  if (segments.length === 0) return;
  paths.push({ id: `p-${paths.length}`, type, segments, tags: tag ? [tag] : undefined });
}

/** 沿目前畫筆位置畫一段收圓角的 bezier 到 (bx,by)，轉角 K=(kx,ky)（四分圓 kappa 近似）。 */
function roundCorner(b: PathBuilder, ax: number, ay: number, kx: number, ky: number, bx: number, by: number): void {
  b.bezierTo(ax + KAPPA * (kx - ax), ay + KAPPA * (ky - ay), bx + KAPPA * (kx - bx), by + KAPPA * (ky - by), bx, by);
}

/**
 * 兩側翼片交界的讓位凸口（原刀模 c+s 雙 bezier·觸摺線於峰頂）：
 * 自 (fromX, −drop) 升到峰 (peakX, 0) 再回落到 (toX, −drop)，把兩片刀線連續銜接、切斷紙橋。
 * 兩端點分別與兩側翼片端點重合（fromX=防塵翼直邊、toX=蓋板側邊）。
 */
function boundaryBump(fromX: number, toX: number, drop: number): Segment[] {
  const peakX = (fromX + toX) / 2;
  const b = new PathBuilder().moveTo(fromX, -drop);
  roundCorner(b, fromX, -drop, fromX, 0, peakX, 0); // 由直邊垂直升到峰、峰頂水平（轉角 K=(fromX,0)）
  roundCorner(b, peakX, 0, toX, 0, toX, -drop); // 峰頂水平回落到直邊（轉角 K=(toX,0)）
  return b.segments();
}

/** 把一組 segment 對垂直軸 x=axis 水平鏡射（glueSide='right' 版型；bezier/line 皆只翻 x）。 */
function mirrorSegmentsX(segs: Segment[], axis: number): Segment[] {
  const fx = (x: number): number => 2 * axis - x;
  return segs.map((s): Segment => {
    if (s.kind === 'line') return { kind: 'line', x1: fx(s.x1), y1: s.y1, x2: fx(s.x2), y2: s.y2 };
    if (s.kind === 'bezier')
      return { kind: 'bezier', x1: fx(s.x1), y1: s.y1, c1x: fx(s.c1x), c1y: s.c1y, c2x: fx(s.c2x), c2y: s.c2y, x2: fx(s.x2), y2: s.y2 };
    // arc（本模組不產生·防禦性完整處理）
    return { kind: 'arc', cx: fx(s.cx), cy: s.cy, r: s.r, startAngle: Math.PI - s.startAngle, endAngle: Math.PI - s.endAngle, ccw: !s.ccw };
  });
}

function generate(p: ResolvedParams): GenerateResult {
  const L = p.L as number;
  const W = p.W as number;
  const D = p.D as number;
  const tuckDepth = p.tuckDepth as number;
  const dustFlapDepth = p.dustFlapDepth as number;
  const F = p.lockFlapDepth as number;
  const Rw = p.lockReceiveWidth as number;
  const Rd = p.lockReceiveDepth as number;
  const Tw = p.lockTabWidth as number;
  const glueSize = p.glueSize as number;
  const t = p.thickness as number;
  const glueOnRight = p.glueSide === 'right';

  // 盒身 girth 補償（沿用 RTE）：面板序「從糊邊側起算」每過一道摺線多補一個紙厚，
  // 係數 [0,1,1,2]（總和 4）。此處恆以 glueSide='left' 版型建構（comp 不反轉），glueSide='right'
  // 於最後整體鏡射——鏡射把 [0,1,1,2] 版型翻成 [2,1,1,0]，與 RTE glueOnRight 反轉表等價。
  // ⚠️ snap-lock 底部與插舌收窄弧為固定復刻幾何·**不另套紙厚咬合補償**（非零紙厚咬合待實體樣品
  // 驗證）；t 只驅動盒身面板寬（＝x 邊界位移），底封/插舌內部尺寸維持名義值。
  const wP1 = L + GIRTH_COMP_FROM_GLUE[0] * t;
  const wP2 = W + GIRTH_COMP_FROM_GLUE[1] * t;
  const wP3 = L + GIRTH_COMP_FROM_GLUE[2] * t;
  const wP4 = W + GIRTH_COMP_FROM_GLUE[3] * t;

  // 面板邊界（glueSide='left' 版型；'right' 於最後整體鏡射）。
  const x0 = 0;
  const x1 = x0 + wP1;
  const x2 = x1 + wP2;
  const x3 = x2 + wP3;
  const x4 = x3 + wP4;
  const cx1 = (x0 + x1) / 2;
  const cx2 = (x1 + x2) / 2;
  const cx3 = (x2 + x3) / 2;
  const cx4 = (x3 + x4) / 2;
  const yTop = 0;
  const yBot = D;

  const paths: DielinePath[] = [];
  const texts: DielineText[] = [];
  const push = (type: LineType, tag: string | undefined, segments: Segment[]) => addPath(paths, type, tag, segments);

  // ── 盒身：主摺線 + 糊邊 ────────────────────────────────────────────────
  for (const x of [x1, x2, x3]) {
    push('crease', 'D', new PathBuilder().moveTo(x, yTop).lineTo(x, yBot).segments());
  }
  push('crease', 'D', new PathBuilder().moveTo(x0, yTop).lineTo(x0, yBot).segments()); // 糊邊摺線
  push('cut', 'D', new PathBuilder().moveTo(x4, yTop).lineTo(x4, yBot).segments()); // 自由邊
  push(
    'cut',
    'glueSize',
    new PathBuilder()
      .moveTo(x0, yTop)
      .lineTo(-glueSize, yTop + GLUE_CHAMFER)
      .lineTo(-glueSize, yBot - GLUE_CHAMFER)
      .lineTo(x0 + 0.751, yBot + 0.003) // 底角與 P1 梯形基座左角重合（原刀模 LINE20/LINE21 起點）
      .segments(),
  );

  // ── 頂部：P1 素邊 + P2/P4 防塵翼 + P3 反插插舌（全刀線連續銜接）─────────
  const yFF = -(W - TUCK_FOLD_INSET); // 插舌 flap 摺線
  const yLidBot = yFF - LID_SIDE_EXTRA; // 蓋板側邊底
  // P1 素邊直切（延伸到 P2 斜切摺角·原刀模 LINE19+LINE0 連續）
  push('cut', 'L', new PathBuilder().moveTo(x0, yTop).lineTo(x1 + DF_FOLD_INSET_SLANT, yTop).segments());

  // P2/P4 防塵翼（mirror=true 時斜切在自由邊側·直邊回摺線由 boundaryBump 連到蓋板）
  const dustFlap = (xL: number, xR: number, mirror: boolean, slantInset: number): void => {
    const mx = (x: number): number => (mirror ? xL + xR - x : x);
    const yTip = -dustFlapDepth;
    const foldSlant = mx(xL + slantInset);
    const kinkX = mx(xL + slantInset + DF_KINK);
    // DF_SLANT_DX＝自 foldSlant 到斜邊終點的「總」水平位移（原刀模 6.159）·kink 只是途中折點，
    // 不再累加 DF_KINK（否則斜邊終點 x 會多偏移一個折點量·原刀模值為 91.761）。
    const tipSlant = mx(xL + slantInset + DF_SLANT_DX);
    const straight = mx(xR - DF_STRAIGHT_INSET);
    // 斜切側：fold→直上→2mm 折點→長斜切→尖端平邊→直邊側直上到讓位深度（−CONNECTOR_DROP）
    const b = new PathBuilder()
      .moveTo(foldSlant, yTop)
      .lineTo(foldSlant, -DF_SLANT_RISE)
      .lineTo(kinkX, -DF_SLANT_RISE - DF_KINK) // 原刀模 LINE2 折點（−6→−8）
      .lineTo(tipSlant, yTip)
      .lineTo(straight, yTip)
      .lineTo(straight, -CONNECTOR_DROP);
    push('cut', 'dustFlapDepth', b.segments());
    push('crease', 'dustFlapDepth', new PathBuilder().moveTo(foldSlant, yTop).lineTo(straight, yTop).segments());
  };
  dustFlap(x1, x2, false, DF_FOLD_INSET_SLANT); // P2：斜切靠 P1（內縮 0.6）
  dustFlap(x3, x4, true, 0); // P4：斜切靠自由邊（無內縮·與自由邊重合）

  // 交界讓位凸口（P2 直邊 x2−3 ↔ 蓋板左側 x2；蓋板右側 x3 ↔ P4 直邊 x3+3）
  push('cut', 'dustFlapDepth', boundaryBump(x2 - DF_STRAIGHT_INSET, x2, CONNECTOR_DROP));
  push('cut', 'dustFlapDepth', boundaryBump(x3 + DF_STRAIGHT_INSET, x3, CONNECTOR_DROP));

  // P3 反插插舌（對稱於 cx3·蓋板側邊自 −CONNECTOR_DROP 起與 boundaryBump 銜接）
  {
    const yTip = yFF - tuckDepth; // 尖端平邊
    // fold/尖端角自面板邊界固定內縮（隨 P3 寬縮放）——蓋板兩側緣因此恆與盒身面板邊界 x2/x3 對齊
    // 而垂直、尖端角與收窄弧根落點相對面板邊固定（避免非預設 L 時蓋板出現斜線）。
    const tipL = x2 + TUCK_TIP_MARGIN;
    const tipR = x3 - TUCK_TIP_MARGIN;
    const foldL = x2 + TUCK_FOLD_MARGIN;
    const foldR = x3 - TUCK_FOLD_MARGIN;
    const sblx = tipL + SH_BASE_DX;
    const sbly = yTip + SH_BASE_DY;
    const sbrx = tipR - SH_BASE_DX;
    const sbry = sbly;

    // 蓋板兩側邊（自讓位深度 −CONNECTOR_DROP 起·與 boundaryBump 端點重合）
    push('cut', 'W', new PathBuilder().moveTo(x2, -CONNECTOR_DROP).lineTo(x2, yLidBot).segments());
    push('cut', 'W', new PathBuilder().moveTo(x3, -CONNECTOR_DROP).lineTo(x3, yLidBot).segments());
    // 蓋板開口摺線 + 插舌摺線
    push('crease', 'L', new PathBuilder().moveTo(x2, yTop).lineTo(x3, yTop).segments());
    push('crease', 'W', new PathBuilder().moveTo(foldL, yFF).lineTo(foldR, yFF).segments());
    // 插舌外框輪廓：蓋板底左角 → 收窄弧根 → 收窄弧 → 尖端平邊 → 收窄弧 → 收窄弧根 → 蓋板底右角
    const b = new PathBuilder()
      .moveTo(x2, yLidBot)
      .lineTo(sblx, sbly)
      .bezierTo(tipL + SH_C1_DX, yTip + SH_C1_DY, tipL + SH_C2_DX, yTip + SH_C2_DY, tipL, yTip)
      .lineTo(tipR, yTip)
      .bezierTo(tipR - SH_C2_DX, yTip + SH_C2_DY, tipR - SH_C1_DX, yTip + SH_C1_DY, sbrx, sbry)
      .lineTo(x3, yLidBot);
    push('cut', 'tuckDepth', b.segments());
    // 兩側 straddle 避讓槽（自蓋板底角沿摺線到 fold 寬邊·止於插舌摺線端點·連續不懸空）
    push('cut', 'tuckDepth', new PathBuilder().moveTo(x2, yLidBot).lineTo(foldL, yLidBot).lineTo(foldL, yFF).segments());
    push('cut', 'tuckDepth', new PathBuilder().moveTo(x3, yLidBot).lineTo(foldR, yLidBot).lineTo(foldR, yFF).segments());
  }

  // ── 底部：snap-lock 四片（座標逐字復刻 原刀模·交界用 ARC10/11/12 雙 bezier 連接）──
  const yLockTip = yBot + F;

  // 底摺線（原刀模 各片獨立·y=yBot+0.003·端點內縮·自由邊側齊 x4）
  const cY = yBot + 0.003;
  push('crease', 'D', new PathBuilder().moveTo(x0 + 0.751, cY).lineTo(x1 - 0.75, cY).segments());
  push('crease', 'D', new PathBuilder().moveTo(x1 + 0.75, cY).lineTo(x2 - 0.748, cY).segments());
  push('crease', 'D', new PathBuilder().moveTo(x2 + 0.751, cY).lineTo(x3 - 0.75, cY).segments());
  push('crease', 'D', new PathBuilder().moveTo(x3 + 0.75, cY).lineTo(x4, cY).segments());

  // 交界讓位連接段（原刀模對應相對座標序列 逐字·雙 cubic bezier·各交界獨立照抄非共用模板）。
  // pts = [start, c1a, c2a, mid, c1b, c2b, end]，每點為 (相對 anchorX 的 dx, 相對 yBot 的 dy)。
  const ARC10 = [[0.750, 1.016], [0.750, 0.455], [0.295, 0.003], [-0.263, 0.003], [-0.570, 0.003], [-0.862, 0.141], [-1.053, 0.381]];
  const ARC11 = [[0.751, 1.083], [0.751, 0.483], [0.268, 0.0], [-0.332, 0.0], [-0.600, 0.0], [-0.861, 0.099], [-1.058, 0.279]];
  const ARC12 = [[1.060, 0.282], [0.616, -0.120], [-0.069, -0.085], [-0.467, 0.360], [-0.647, 0.557], [-0.746, 0.818], [-0.746, 1.086]];
  const pushConn = (anchorX: number, pts: number[][]): void => {
    const P = (i: number): [number, number] => [anchorX + pts[i]![0]!, yBot + pts[i]![1]!];
    const b = new PathBuilder().moveTo(...P(0));
    b.bezierTo(...P(1), ...P(2), ...P(3));
    b.bezierTo(...P(4), ...P(5), ...P(6));
    push('cut', 'lockFlapDepth', b.segments());
  };
  pushConn(x1, ARC10); // P2 窄翼直邊頂 → P1 梯形基座右角
  pushConn(x2, ARC11); // P3 左外翼頂 → P2 窄翼斜切基座
  pushConn(x3, ARC12); // P4 窄翼斜切基座 → P3 右外翼頂

  // P1 梯形尖端（尖端對稱於 cx1·基座角＝原刀模·左角接糊邊/ARC 端點）
  {
    const tipHalf = Tw / 2;
    const vertHalf = tipHalf + LOCK_CORNER_R;
    const yVertBot = yLockTip - LOCK_CORNER_R;
    const yVertTop = yBot + F * TAB_DIAG_FRAC;
    const b = new PathBuilder()
      .moveTo(x0 + 0.751, yBot + 0.003) // 基座左角（原刀模 LINE21 起點·＝糊邊底角）
      .lineTo(cx1 - vertHalf, yVertTop)
      .lineTo(cx1 - vertHalf, yVertBot);
    roundCorner(b, cx1 - vertHalf, yVertBot, cx1 - vertHalf, yLockTip, cx1 - tipHalf, yLockTip);
    b.lineTo(cx1 + tipHalf, yLockTip);
    roundCorner(b, cx1 + tipHalf, yLockTip, cx1 + vertHalf, yLockTip, cx1 + vertHalf, yVertBot);
    b.lineTo(cx1 + vertHalf, yVertTop).lineTo(x1 - 1.053, yBot + 0.381); // 基座右角（＝ARC10 端點）
    push('cut', 'lockTabWidth', b.segments());
  }

  // P2/P4 窄翼（直邊側與斜切基座角＝原刀模·P4 直邊在自由邊 x4·頂緣齊 cY）
  const wing = (straightX: number, dir: 1 | -1, straightTopY: number, baseTaperX: number, baseTaperY: number): void => {
    const tipOuter = straightX + dir * WING_TIP_WIDTH;
    const vertX = straightX + dir * (WING_TIP_WIDTH + LOCK_CORNER_R);
    const yVertTop = yBot + F * WING_DIAG_FRAC;
    const yVertBot = yLockTip - LOCK_CORNER_R;
    const b = new PathBuilder()
      .moveTo(straightX, straightTopY)
      .lineTo(straightX, yLockTip) // 直邊（原刀模 LINE29/LINE40）
      .lineTo(tipOuter, yLockTip); // 尖端平邊
    roundCorner(b, tipOuter, yLockTip, vertX, yLockTip, vertX, yVertBot);
    b.lineTo(vertX, yVertTop).lineTo(baseTaperX, baseTaperY); // 直上 + 斜切到基座角
    push('cut', 'lockFlapDepth', b.segments());
  };
  wing(x1 + 0.75, 1, yBot + 1.016, x2 - 1.058, yBot + 0.279); // P2（直邊靠 P1·頂接 ARC10 start）
  wing(x4, -1, yBot + 0.003, x3 + 1.06, yBot + 0.282); // P4（直邊＝自由邊·基座接 ARC12 start）

  // P3 接收片（缺口對稱於 cx3·兩外翼頂＝原刀模 ARC11 start / ARC12 end）
  {
    const notchHalf = Rw / 2;
    const yNotch = yLockTip - Rd; // 缺口內緣
    const notchVL = cx3 - notchHalf;
    const notchVR = cx3 + notchHalf;
    // 缺口圓角鉗制：圓角半徑不得超過缺口內縮深度 Rd，否則圓弧超過缺口內緣、
    // 缺口輪廓反折自撞。鉗到 min(LOCK_CORNER_R, Rd)；receive-depth-vs-corner 不變式另示警。
    const rc = Math.min(LOCK_CORNER_R, Rd);
    const leafInnerL = notchVL - rc; // 左翼底右緣（缺口圓角前）
    const leafInnerR = notchVR + rc;
    const yNotchCornerTop = yLockTip - rc;
    // 左翼：外緣頂（原刀模 LINE30 頂＝ARC11 start）→ 尖端 → 翼底 → 圓角 → 缺口 → 右翼外緣頂（ARC12 end）
    const b = new PathBuilder()
      .moveTo(x2 + 0.751, yBot + 1.083)
      .lineTo(x2 + 0.751, yLockTip)
      .lineTo(leafInnerL, yLockTip);
    roundCorner(b, leafInnerL, yLockTip, notchVL, yLockTip, notchVL, yNotchCornerTop);
    b.lineTo(notchVL, yNotch).lineTo(notchVR, yNotch).lineTo(notchVR, yNotchCornerTop);
    roundCorner(b, notchVR, yNotchCornerTop, notchVR, yLockTip, leafInnerR, yLockTip);
    b.lineTo(x3 - 0.746, yLockTip).lineTo(x3 - 0.746, yBot + 1.086);
    push('cut', 'lockReceiveWidth', b.segments());
  }

  // ── 標註尺寸（W/L/D·對齊 RTE addDim 慣例）─────────────────────────────
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
    push('dimension', tag, dimPaths);
    texts.push({ id: `t-${texts.length}`, x: text.x, y: text.y, text: text.text, rotation: text.rotation, fontSize: 3.5, anchor: 'middle' });
  };
  addDim(x1, yTop + D / 2, x2, yTop + D / 2, W, 0, 'W', 'h'); // P2 寬度
  addDim(x2, yTop + D / 2, x3, yTop + D / 2, L, 0, 'L', 'h'); // P3 長度
  addDim(x1, yTop, x1, yBot, D, -10, 'D', 'v'); // 盒身高度
  void cx2;
  void cx4;

  // ── glueSide='right'：整體水平鏡射 ───────────────────────────────────
  if (glueOnRight) {
    const axis = L + W; // 面板列中心
    for (const path of paths) {
      (path as { segments: Segment[] }).segments = mirrorSegmentsX(path.segments, axis);
    }
    for (const tx of texts) {
      (tx as { x: number }).x = 2 * axis - tx.x;
    }
  }

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
    id: 'snap-lock-closure',
    description: {
      zh: 'P1 梯形尖端必須真正插入 P3 接收缺口（摺後 2D 咬合重疊深度 > 0），且尖端寬必須小於缺口寬並留足插入餘隙、底片深度不超過盒寬、P2/P4 窄翼不對撞——任一必要條件失敗代表底封幾何無法鎖定。',
    },
    check(params) {
      const closure = checkSnapLockClosure({
        L: params.L as number,
        W: params.W as number,
        lockFlapDepth: params.lockFlapDepth as number,
        lockReceiveWidth: params.lockReceiveWidth as number,
        lockReceiveDepth: params.lockReceiveDepth as number,
        lockTabWidth: params.lockTabWidth as number,
      });
      if (!closure.pass) {
        const failed = closure.results.filter((r) => !r.ok).map((r) => r.tag).join('、');
        return {
          ok: false,
          message: {
            zh: `snap-lock 底封咬合檢查未通過（失敗條件：${failed}；重疊深度 ${closure.overlapDepth.toFixed(2)}mm）`,
            en: `Snap-lock base closure check failed (failing conditions: ${failed}; overlap depth ${closure.overlapDepth.toFixed(2)}mm).`,
          },
          tags: ['lockFlapDepth', 'lockReceiveWidth', 'lockReceiveDepth', 'lockTabWidth'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 淺咬合警告透傳：checkSnapLockClosure 的 warnings（0<overlap<4mm）以 not-ok
    // 通道示警（沿 RTE tuck-radius-clamped 慣例——本 codebase 以 not-ok invariant 當 UI 警告條），
    // 讓「插進去了但咬合可能不足」不被 pass 吞掉。overlap≤0 由 snap-lock-closure hard 擋，此條僅示警。
    id: 'snap-lock-engagement-firm',
    description: {
      zh: 'P1 尖端插入 P3 缺口的咬合重疊深度建議 ≥ 4mm——低於此仍有重疊，但實體樣品可能鬆動，建議打樣驗證。',
    },
    check(params) {
      const closure = checkSnapLockClosure({
        L: params.L as number,
        W: params.W as number,
        lockFlapDepth: params.lockFlapDepth as number,
        lockReceiveWidth: params.lockReceiveWidth as number,
        lockReceiveDepth: params.lockReceiveDepth as number,
        lockTabWidth: params.lockTabWidth as number,
      });
      if (closure.pass && closure.warnings.length > 0) {
        return {
          ok: false,
          message: {
            zh: `咬合重疊僅 ${closure.overlapDepth.toFixed(2)}mm < 4mm 建議下限，咬合可能不足（白樣驗證·非幾何錯誤）`,
            en: `Engagement overlap is only ${closure.overlapDepth.toFixed(2)}mm, below the 4mm advisory minimum; the lock may be loose (white-sample validation; not a geometry error).`,
          },
          tags: ['lockFlapDepth', 'lockReceiveDepth'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'tuck-depth-within-body',
    description: {
      zh: '頂部插舌深度必須為正且不超過盒身高度 D——插舌深度為零代表沒有插舌無法反插固定，超過盒身高度則插舌會頂到盒底。',
    },
    check(params) {
      const tuckDepth = params.tuckDepth as number;
      const D = params.D as number;
      if (!(tuckDepth > 0 && tuckDepth <= D)) {
        return {
          ok: false,
          message: {
            zh: `插舌深度 ${tuckDepth}mm 必須 > 0 且 ≤ 盒身高度 D=${D}mm`,
            en: `Tuck depth ${tuckDepth}mm must be > 0 and ≤ body depth D=${D}mm.`,
          },
          tags: ['tuckDepth', 'D'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 頂部插舌隨面板寬縮放（尖端寬＝P3 寬 − 2×TUCK_TIP_MARGIN）；P3 寬小於退化下限時尖端寬歸零、
    // 兩側收窄弧相交自撞。相依下限＝2×TUCK_TIP_MARGIN（用補償後 P3 實寬判定·不誤擋合法紙厚輸入）。
    id: 'top-tuck-fits-panel',
    description: {
      zh: '頂部插舌尖端平邊寬＝P3 面板寬減兩側固定內縮；P3 面板寬須大於退化下限，否則尖端寬歸零、兩側收窄弧相交自撞。',
    },
    check(params) {
      const L = params.L as number;
      const p3w = L + GIRTH_COMP_FROM_GLUE[2] * (params.thickness as number);
      if (p3w <= TUCK_MIN_P3_WIDTH + 1e-6) {
        return {
          ok: false,
          message: {
            zh: `P3 面板寬 ${p3w.toFixed(2)}mm 過小：頂部插舌需 > ${TUCK_MIN_P3_WIDTH.toFixed(2)}mm（否則尖端平邊寬歸零、收窄弧自撞）`,
            en: `P3 panel width ${p3w.toFixed(2)}mm is too small: the top tuck requires > ${TUCK_MIN_P3_WIDTH.toFixed(2)}mm or the tip flat collapses to zero and the shoulders self-intersect.`,
          },
          tags: ['L', 'tuckDepth'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 邊界情形：固定 3.5mm 缺口圓角在 lockReceiveDepth 小於它時倒折（generate 已鉗制幾何·此條示警）。
    id: 'receive-depth-vs-corner',
    description: {
      zh: '接收缺口內縮深度必須 ≥ 缺口轉角圓角半徑（3.5mm），否則圓角超過缺口內緣、缺口輪廓反折自撞（幾何已鉗制圓角以免崩潰，此條示警設定值退化）。',
    },
    check(params) {
      const Rd = params.lockReceiveDepth as number;
      if (Rd < LOCK_CORNER_R - 1e-6) {
        return {
          ok: false,
          message: {
            zh: `接收缺口內縮 ${Rd}mm 小於缺口圓角半徑 ${LOCK_CORNER_R}mm，缺口輪廓會反折（圓角已鉗制）`,
            en: `Receiving-notch inset ${Rd}mm is less than the notch corner radius ${LOCK_CORNER_R}mm; the notch outline folds back (corner radius has been clamped).`,
          },
          tags: ['lockReceiveDepth', 'lockReceiveWidth'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 相依合法域：缺口 + 兩外翼（含圓角與避讓）必須容於 P3 面板寬 L。
    id: 'notch-fits-panel',
    description: {
      zh: 'P3 接收缺口寬加上兩側外翼（含圓角與避讓內縮）必須容於面板長度 L，否則外翼寬度退化為負、缺口切出面板外。',
    },
    check(params) {
      const L = params.L as number;
      const Rw = params.lockReceiveWidth as number;
      // 同 top-tuck：用補償後 P3 實際寬（如 L=85,t=0.8,Rw=76→P3 實寬 85.8 容得下）。
      const p3w = L + GIRTH_COMP_FROM_GLUE[2] * (params.thickness as number);
      const maxRw = p3w - 2 * (RECV_LEAF_RELIEF + LOCK_CORNER_R + 0.5);
      if (Rw > maxRw + 1e-6) {
        return {
          ok: false,
          message: {
            zh: `接收缺口寬 ${Rw}mm 過大：需 ≤ ${maxRw.toFixed(2)}mm（含兩側外翼圓角與避讓·才容於 P3 寬 ${p3w.toFixed(2)}mm）`,
            en: `Receiving-notch width ${Rw}mm is too large: it must be ≤ ${maxRw.toFixed(2)}mm to leave room for both leaves (corners and relief) within the P3 width ${p3w.toFixed(2)}mm.`,
          },
          tags: ['lockReceiveWidth', 'L'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 相依合法域：固定折點/斜切的防塵翼需最小盒寬 W 才不退化。
    id: 'dust-flap-fits-panel',
    description: {
      zh: '防塵翼的固定折點與斜切段（2mm 折點 + 斜切位移 + 直邊內縮）需要最小盒寬 W；W 太小時斜切尖端會超過直邊、防塵翼輪廓退化。',
    },
    check(params) {
      const W = params.W as number;
      const need = DF_FOLD_INSET_SLANT + DF_KINK + DF_SLANT_DX + DF_STRAIGHT_INSET + 0.5;
      if (W < need - 1e-6) {
        return {
          ok: false,
          message: {
            zh: `寬度 W=${W}mm 過小：固定折點/斜切的防塵翼需 W ≥ ${need.toFixed(2)}mm`,
            en: `Width W=${W}mm is too small: the dust flap with its fixed kink and taper requires W ≥ ${need.toFixed(2)}mm.`,
          },
          tags: ['W', 'dustFlapDepth'],
        };
      }
      return { ok: true };
    },
  },
  {
    // 所有數值必須 Number.isFinite——不只擋 NaN，也擋 Infinity（否則 bounds 超出範圍）。
    id: 'all-finite',
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
    description: {
      zh: '所有 cut 類路徑的線段兩兩之間不得真交叉（內部交點；共享端點的正常轉角銜接不算）——真交叉代表幾何已退化成自撞的翻折形狀，刀模無法沿這種路徑正確裁切。dimension/annotation 不參與這條檢查。',
    },
    check(_params, result) {
      const cutSegments = result.paths.filter((pp) => pp.type === 'cut').flatMap((pp) => pp.segments);
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

export const tuckTopSnapLock: BoxModule = {
  meta: {
    id: 'ttsl',
    name: { zh: '插底盒', en: 'Tuck-Top Snap-Lock Carton' },
    intro: {
      zh: '前後左右四片面板一字排開的盒型；頂部以反插式插舌卡入固定開口、兩側防塵翼摺入遮縫，底部為 1-2-3 snap-lock 四片——先摺兩側窄翼與接收片，再把梯形尖端插入中央缺口鎖定，免膠免膠帶封底。',
      en: 'Four front, back, left, and right panels in a single flat run; the top secures the opening with a reverse tuck and side dust flaps, while the base uses a 1-2-3 snap-lock of four flaps—the side wings and receiving panel fold first, then a trapezoidal tip locks into the central notch. No glue or tape at the base.',
    },
    topology: 'linear',
  },
  params,
  invariants,
  generate,
};

registerBox(tuckTopSnapLock);
