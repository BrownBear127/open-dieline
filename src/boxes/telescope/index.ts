/**
 * 天地盒（Telescope）BoxModule 組裝——上蓋＋下盒（`tray.ts`，T3）＋內襯圍框
 * （`liner.ts`）三件套，pieces 分組（spec §4.2／§3.3）。
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
import { deriveLinerFrame, generateLiner, MIN_FLANGE } from '@/boxes/telescope/liner';

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
    label: { zh: '下盒長度' },
    unit: 'mm',
    default: 179,
    min: 30,
    max: 600,
    step: 0.5,
    group: { zh: '尺寸' },
    description: {
      zh: '下盒主面板長邊尺寸（製造尺寸，與生產刀模直接對帳）；同時決定上蓋面板長邊（＋2×上蓋放大量）與內襯圍框長壁的套合基準。',
    },
    highlightTags: ['baseLength'],
  },
  {
    key: 'baseWidth',
    label: { zh: '下盒寬度' },
    unit: 'mm',
    default: 124,
    min: 30,
    max: 600,
    step: 0.5,
    group: { zh: '尺寸' },
    description: {
      zh: '下盒主面板短邊尺寸；同時決定上蓋面板短邊（＋2×上蓋放大量）與內襯圍框短壁的套合基準。',
    },
    highlightTags: ['baseWidth'],
  },
  {
    key: 'baseHeight',
    label: { zh: '下盒壁高' },
    unit: 'mm',
    default: 60,
    min: 10,
    max: 200,
    step: 0.5,
    group: { zh: '尺寸' },
    description: {
      zh: '下盒後摺壁的名義全高；先摺壁自動再減一個紙厚做「頂緣平齊」修正，讓四片牆摺起後頂緣切齊。內襯圍框壁高與此共用同一個值，圍框頂緣因此與下盒盒口齊平。',
    },
    highlightTags: ['baseHeight'],
  },
  {
    key: 'lidMargin',
    label: { zh: '上蓋放大量' },
    unit: 'mm',
    default: 13.5,
    min: 1,
    max: 40,
    step: 0.1,
    group: { zh: '套合' },
    description: {
      zh: '上蓋面板相對下盒面板的等邊放大量——長寬同時各加 2×此值，決定上蓋能套住下盒多深。同時是內襯翻邊寬度的主要來源：太小會讓翻邊窄到放不下內襯（見 liner-flange-fits 警告）。',
    },
    highlightTags: ['lidMargin'],
  },
  {
    key: 'lidHeight',
    label: { zh: '上蓋壁高' },
    unit: 'mm',
    default: 45,
    min: 10,
    max: 200,
    step: 0.5,
    group: { zh: '尺寸' },
    description: { zh: '上蓋後摺壁的名義全高；先摺壁同樣做頂緣平齊修正（−1 個紙厚）。' },
    highlightTags: ['lidHeight'],
  },
  {
    key: 'basePlatformWidth',
    label: { zh: '下盒壁頂平台寬' },
    unit: 'mm',
    default: 5,
    min: 0,
    max: 15,
    step: 0.5,
    group: { zh: '壁款' },
    description: {
      zh: '下盒壁頂平台寬度；設 0＝薄壁單線反折（配弧形讓位角撐），大於 0＝厚壁平台（配 45° 斜角撐）。角撐款式跟隨這個值自動切換，不是獨立開關。',
    },
    highlightTags: ['wallTop'],
  },
  {
    key: 'lidPlatformWidth',
    label: { zh: '上蓋壁頂平台寬' },
    unit: 'mm',
    default: 0,
    min: 0,
    max: 15,
    step: 0.5,
    group: { zh: '壁款' },
    description: {
      zh: '上蓋壁頂平台寬度（生產品為薄壁單線反折，預設 0）。設 0 且壁高偏低時，薄壁角撐的讓位槽會擠壓變形，見 gusset-b-fits 警告。',
    },
    highlightTags: ['wallTop'],
  },
  {
    key: 'thickness',
    label: { zh: '紙厚' },
    unit: 'mm',
    default: 0.3,
    min: 0,
    max: 0.8,
    step: 0.1,
    group: { zh: '材質' },
    description: {
      zh: '紙張厚度（caliper）。驅動內外壁差、雙摺線間距、內襯套合間隙等全套補償；設 0 可還原無補償的幾何（後摺壁雙 crease collapse 為單線）。',
    },
    highlightTags: ['wallRoot'],
  },
  {
    key: 'linerEnabled',
    label: { zh: '內襯圍框' },
    unit: 'bool',
    default: true,
    group: { zh: '內襯' },
    description: {
      zh: '是否產生內襯圍框片。關閉時只輸出上蓋／下盒兩片，套合與定位需另外自理（如緊配或腰封）。',
    },
    highlightTags: ['linerTab', 'linerWall', 'linerFlange'],
  },
  {
    key: 'linerFitGap',
    label: { zh: '內襯套合間隙' },
    unit: 'mm',
    default: 0.5,
    min: 0.2,
    max: 2,
    step: 0.1,
    group: { zh: '內襯' },
    description: {
      zh: '內襯與上蓋內緣、內襯與下盒外緣，各留一次的套合間隙（導出鏈扣兩次，不是同一份間隙重複扣）；愈大內襯愈鬆好裝、翻邊也愈窄。',
    },
    highlightTags: ['linerFlange'],
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
    y: minAbsGap(creaseAlongValues(paths, 'wallRoot', 'front', 'y'), creaseAlongValues(paths, 'wallRoot', 'back', 'y')),
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
 * height 量測起點用 panelW/2+thickness（後摺壁外壁量測起點是雙 crease 的外線，見 tray.ts
 * 「y 向 outerWall＝H，自雙 crease 外線起量」），純視覺標註微差（≤0.8mm）不影響任何不變式。
 */
function addTrayDimensions(
  tray: TrayResult,
  panelL: number,
  panelW: number,
  height: number,
  thickness: number,
  idPrefix: string,
  offsetX: number,
  offsetY: number,
  tagL: string,
  tagW: string,
  tagH: string,
): TrayResult {
  const yEdge = offsetY + panelW / 2 + thickness;
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
  offsetX: number,
  offsetY: number,
): TrayResult {
  const tray = generateTray({ panelL: baseWidth, panelW: baseLength, height: baseHeight, platformWidth: basePlatformWidth, thickness, idPrefix: 'base', offsetX, offsetY });
  return addTrayDimensions(tray, baseWidth, baseLength, baseHeight, thickness, 'base', offsetX, offsetY, 'baseWidth', 'baseLength', 'baseHeight');
}

function buildLidPiece(
  lidPanelX: number,
  lidPanelY: number,
  lidHeight: number,
  lidPlatformWidth: number,
  thickness: number,
  offsetX: number,
  offsetY: number,
): TrayResult {
  const tray = generateTray({ panelL: lidPanelX, panelW: lidPanelY, height: lidHeight, platformWidth: lidPlatformWidth, thickness, idPrefix: 'lid', offsetX, offsetY });
  return addTrayDimensions(tray, lidPanelX, lidPanelY, lidHeight, thickness, 'lid', offsetX, offsetY, 'lidMargin', 'lidMargin', 'lidHeight');
}

function toPiece(id: string, label: string, r: TrayResult): DielinePiece {
  return { id, label: { zh: label }, pathIds: r.paths.map((p) => p.id), textIds: r.texts.map((t) => t.id), bounds: r.bounds };
}

function generate(p: ResolvedParams): GenerateResult {
  const baseLength = p.baseLength as number;
  const baseWidth = p.baseWidth as number;
  const baseHeight = p.baseHeight as number;
  const lidMargin = p.lidMargin as number;
  const lidHeight = p.lidHeight as number;
  const basePlatformWidth = p.basePlatformWidth as number;
  const lidPlatformWidth = p.lidPlatformWidth as number;
  const thickness = p.thickness as number;
  const linerEnabled = p.linerEnabled as boolean;
  const linerFitGap = p.linerFitGap as number;

  // D12：baseWidth 對 x 向（先摺壁）、baseLength 對 y 向（後摺壁）——見 開發紀錄 上游 handoff。
  const lidPanelX = baseWidth + 2 * lidMargin;
  const lidPanelY = baseLength + 2 * lidMargin;

  // 版面：lid 左（原點對齊 0,0）、base 右（lid 寬＋PIECE_GAP 起）、liner 橫放下方。
  const lidFinal = placeAt((ox, oy) => buildLidPiece(lidPanelX, lidPanelY, lidHeight, lidPlatformWidth, thickness, ox, oy), 0, 0);
  const baseFinal = placeAt(
    (ox, oy) => buildBasePiece(baseWidth, baseLength, baseHeight, basePlatformWidth, thickness, ox, oy),
    lidFinal.bounds.maxX + PIECE_GAP,
    0,
  );
  const topH = Math.max(lidFinal.bounds.maxY, baseFinal.bounds.maxY);
  const linerFinal = linerEnabled
    ? placeAt((ox, oy) => generateLiner({ baseLength, baseWidth, baseHeight, lidMargin, thickness, fitGap: linerFitGap, idPrefix: 'liner', offsetX: ox, offsetY: oy }), 0, topH + PIECE_GAP)
    : undefined;

  const pieces: DielinePiece[] = linerEnabled
    ? [toPiece('base', '下盒', baseFinal), toPiece('lid', '上蓋', lidFinal), toPiece('liner', '內襯', linerFinal!)]
    : [toPiece('base', '下盒', baseFinal), toPiece('lid', '上蓋', lidFinal)];

  const allResults = linerEnabled ? [baseFinal, lidFinal, linerFinal!] : [baseFinal, lidFinal];
  const paths = allResults.flatMap((r) => r.paths);
  const texts = allResults.flatMap((r) => r.texts);
  const bounds = segmentsBounds(paths.flatMap((path) => path.segments));

  return { paths, texts, bounds, pieces };
}

// ─────────────────────────────────────────────────────────────────────────
// 不變式
// ─────────────────────────────────────────────────────────────────────────

const invariants: BoxInvariant[] = [
  {
    id: 'pieces-valid',
    description: {
      zh: 'pieces 完整性（spec §3.3）：片 id 唯一、每片非空、path/text 歸屬聯集＝全集且兩兩不交、各片 bounds 涵蓋成員且兩兩不重疊、總 bounds＝全片 hull＝全幾何 hull。',
    },
    check(_params, result) {
      const v = validatePieces(result);
      if (!v.ok) return { ok: false, message: { zh: v.message } };
      return { ok: true };
    },
  },
  {
    id: 'liner-flange-fits',
    description: {
      zh: '內襯翻邊寬（lidMargin−4×thickness−2×linerFitGap）必須至少留 MIN_FLANGE=5mm 才穩定——太窄的翻邊難以可靠固定內襯，需要調大 margin 或調小 fitGap。',
    },
    check(params) {
      const frame = deriveLinerFrame({
        baseLength: params.baseLength as number,
        baseWidth: params.baseWidth as number,
        lidMargin: params.lidMargin as number,
        thickness: params.thickness as number,
        fitGap: params.linerFitGap as number,
      });
      if (frame.flange < MIN_FLANGE) {
        return {
          ok: false,
          message: { zh: `內襯翻邊寬 ${frame.flange.toFixed(2)}mm 小於最小可用寬度 ${MIN_FLANGE}mm，margin 太小放不下內襯` },
          tags: ['lidMargin', 'linerFitGap'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'pieces-identity',
    description: {
      zh: 'base 片主面板實測必須等於 baseLength×baseWidth、lid 片主面板實測必須等於（baseLength/baseWidth）＋2×lidMargin（從生成幾何反推，防止 lid/base 整包對調）。',
    },
    check(params, result) {
      const tol = 0.05; // mm，量測反推容差（跟 T3 的 t-無關槽位對帳同一量級）
      const base = result.pieces!.find((piece) => piece.id === 'base')!;
      const lid = result.pieces!.find((piece) => piece.id === 'lid')!;
      const baseMeasured = measuredPanel(result.paths.filter((path) => base.pathIds.includes(path.id)));
      const lidMeasured = measuredPanel(result.paths.filter((path) => lid.pathIds.includes(path.id)));
      const baseWidth = params.baseWidth as number;
      const baseLength = params.baseLength as number;
      const lidMargin = params.lidMargin as number;
      const checks: Array<[string, number, number]> = [
        ['base.x（=baseWidth）', baseMeasured.x, baseWidth],
        ['base.y（=baseLength）', baseMeasured.y, baseLength],
        ['lid.x（=baseWidth+2×lidMargin）', lidMeasured.x, baseWidth + 2 * lidMargin],
        ['lid.y（=baseLength+2×lidMargin）', lidMeasured.y, baseLength + 2 * lidMargin],
      ];
      for (const [label, actual, expected] of checks) {
        if (Math.abs(actual - expected) > tol) {
          return {
            ok: false,
            message: { zh: `${label} 主面板實測 ${actual.toFixed(2)}mm 應為 ${expected.toFixed(2)}mm（pieces 身分可能對調或算錯）` },
            tags: ['baseLength', 'baseWidth', 'lidMargin'],
          };
        }
      }
      return { ok: true };
    },
  },
  {
    id: 'rim-flush',
    description: {
      zh: '每片先摺壁（x 向）外壁高必須等於後摺壁（y 向）外壁高減一個紙厚（頂緣平齊修正），base／lid 兩片皆驗（從生成幾何反推，非只驗參數）。',
    },
    check(params, result) {
      const t = params.thickness as number;
      for (const pieceId of ['base', 'lid'] as const) {
        const piece = result.pieces!.find((candidate) => candidate.id === pieceId)!;
        const walls = measuredOuterWalls(result.paths.filter((path) => piece.pathIds.includes(path.id)));
        if (Math.abs(walls.x - (walls.y - t)) > EPS) {
          return {
            ok: false,
            message: { zh: `${pieceId} 片先摺壁外壁高 ${walls.x.toFixed(3)}mm 應等於後摺壁 ${walls.y.toFixed(3)}mm − 紙厚 ${t}mm` },
            tags: ['thickness'],
          };
        }
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
            message: { zh: `${platformKey}=0（薄壁角撐）時壁高 ${height}mm 低於 ${minH.toFixed(1)}mm，讓位槽幾何已擠壓變形` },
            tags: [platformKey],
          };
        }
      }
      return { ok: true };
    },
  },
  {
    id: 'no-nan',
    description: { zh: '所有幾何座標必須是有效數字；任何 NaN 代表參數鏈某處算式除零或讀到未定義值。' },
    check(_params, result) {
      if (hasNaN(result.paths.flatMap((p) => p.segments))) {
        return { ok: false, message: { zh: '偵測到 NaN 座標' } };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-bleed',
    description: { zh: 'v1 尚不支援出血線（bleed）——不得產生 bleed 線型的路徑（spec §8 全盒型通則）。' },
    check(_params, result) {
      if (result.paths.some((p) => p.type === 'bleed')) {
        return { ok: false, message: { zh: '不應出現 bleed 線型路徑（v1 尚未支援）' } };
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
      if (!ok) return { ok: false, message: { zh: 'bounds 未完整涵蓋所有路徑的實際範圍' } };
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
    name: { zh: '天地盒 (Telescope Box)' },
    intro: {
      zh: '上蓋與下盒共用同一套免膠雙壁 tray 拓撲、上蓋等邊放大套住下盒；內襯圍框墊出兩者的套合間隙，頂緣與下盒盒口齊平。',
    },
    topology: 'nested',
  },
  params,
  invariants,
  generate,
};

registerBox(telescope);
