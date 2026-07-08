/**
 * RTE 反插式尾封盒（Reverse Tuck End）—— 移植保真模組。
 *
 * 幾何邏輯逐段對齊前身 `ReverseTuckEnd.ts`（唯讀參照，全 357 行，未修改：
 * /Users/fran/Desktop/trouver.crm-rebuild/components/Tools/Packaging/models/ReverseTuckEnd.ts）。
 * 座標鏈、糊邊、摩擦扣、避讓槽、標註線的計算方式與前身完全一致，只是輸出改為
 * 結構化 `Segment`（經 `PathBuilder`），並把摩擦扣/避讓槽/標註線的畫線邏輯換成呼叫
 * `core/primitives.ts`（Task 5 已從前身同一份程式碼抽出）。
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Segment } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import type { BoxInvariant, BoxModule, BoxParamDef, DielinePath, DielineText, GenerateResult, LineType, ResolvedParams } from '@/core/types';
import { registerBox } from '@/core/registry';
import { hasNaN, hasSelfIntersection, segmentsBounds } from '@/core/geometry';
import { GLUE_CHAMFER, LOCK_CHAMFER, frictionLock, reliefSlot, dimensionLine } from '@/core/primitives';

// ─────────────────────────────────────────────────────────────────────────
// 參數宣告
// ─────────────────────────────────────────────────────────────────────────
//
// 前身 BoxDimensions 型別（trouver.crm-rebuild/components/Tools/Packaging/types.ts）
// 為跨盒型參數聯集大袋子，RTE 專用欄位共 13 個：L/W/D/thickness/tuckDepth/tuckRadius/
// tuckClearance/tuckLock/dustFlapDepth/flapNotch/creaseRelief/glueSize/glueOnRight。
//
// Slice 1 曾只宣告 12 個、不含 thickness——前身 `generateReverseTuckEnd` 的幾何從未
// 讀取它（前身只用於舊 UI 的 auto-link 便利功能，不屬純幾何函式的移植範圍），若照單
// 全收會直接牴觸 spec §3.3「參數宣告即接線」（§8 假旋鈕測試正是為了強制這條規則；
// 詳細取捨記錄見 開發紀錄）。
//
// Slice 2（v1.2 spec §4.1）補上正式幾何意義：thickness 現在驅動一套具名的標準補償集
// （girth 面板遞增、插舌內縮 derivedDefault、防塵翼讓位——見下方 GIRTH_COMP_FROM_GLUE
// 與 generate() 對應段落），t=0 時所有補償歸零、與前身輸出等價（既有 fixture 不變、
// 只錨定 thickness=0 的組合）。至此 13 個欄位全數宣告，取捨記錄見 開發紀錄。
const params: BoxParamDef[] = [
  {
    key: 'L',
    label: { zh: '長度 (L)' },
    unit: 'mm',
    default: 55,
    min: 20,
    max: 500,
    step: 1,
    group: { zh: '尺寸' },
    description: { zh: '成品的長邊內尺寸，決定前後兩片面板（P1、P3）的寬度，是整體外觀比例的主要來源。' },
    highlightTags: ['L'],
  },
  {
    key: 'W',
    label: { zh: '寬度 (W)' },
    unit: 'mm',
    default: 55,
    min: 20,
    max: 500,
    step: 1,
    group: { zh: '尺寸' },
    description: {
      zh: '成品的短邊內尺寸，決定左右兩片側板（P2、P4）的寬度；同一個數字也決定上下蓋板要多高才能完全蓋住開口——蓋板高＝W。',
    },
    highlightTags: ['W'],
  },
  {
    key: 'D',
    label: { zh: '深度 (D)' },
    unit: 'mm',
    default: 117,
    min: 20,
    max: 500,
    step: 1,
    group: { zh: '尺寸' },
    description: { zh: '盒身的高度（開口到底部的距離），決定四片主面板與所有直向摺線的長度。' },
    highlightTags: ['D'],
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
      zh: '紙張厚度（caliper）。盒身面板依摺次遞增補償、插舌與讓位間隙隨之調整；設 0 可還原無補償的幾何。',
    },
    highlightTags: ['D', 'tuckDepth', 'flapNotch'],
  },
  {
    key: 'tuckDepth',
    label: { zh: '插舌深度' },
    unit: 'mm',
    default: 12,
    min: 0,
    max: 60,
    step: 1,
    group: { zh: '插舌與鎖扣' },
    description: { zh: '插舌伸進盒身的深度，決定上蓋抗拉開的力道。' },
    highlightTags: ['tuckDepth'],
  },
  {
    key: 'tuckRadius',
    label: { zh: '插舌圓角' },
    unit: 'mm',
    default: 3,
    min: 0,
    max: 15,
    step: 1,
    group: { zh: '插舌與鎖扣' },
    description: {
      zh: '插舌前緣兩個尖角的導圓半徑；設為 0 時插舌會變成直角矩形（前身在此有明確的兩分支：大於 0 走圓弧、等於 0 走直線）。',
    },
    highlightTags: ['tuckDepth'],
  },
  {
    key: 'tuckClearance',
    label: { zh: '插舌內縮' },
    unit: 'mm',
    default: 0.5,
    min: 0,
    max: 10,
    step: 0.5,
    group: { zh: '插舌與鎖扣' },
    description: { zh: '插舌左右兩側相對蓋板邊緣往內縮的量，讓插舌略窄於開口寬度，插入時才不會卡死。' },
    highlightTags: ['tuckDepth'],
    // 未手動覆寫時隨紙厚即時重算（插舌插入處內空因紙厚縮小，見 spec §4.1）；
    // auto/manual 機制由 core/registry.ts 的 resolveParams 既有支援，這裡只宣告公式。
    derivedDefault: (p) => 0.5 + (p.thickness as number),
  },
  {
    key: 'tuckLock',
    label: { zh: '摩擦扣寬度' },
    unit: 'mm',
    default: 20,
    min: 0,
    max: 60,
    step: 1,
    group: { zh: '插舌與鎖扣' },
    description: { zh: '蓋板摺線中央摩擦扣凸起的寬度；設為 0 會停用摩擦扣，摺線退化回一條完整直線（無凸起卡榫）。' },
    highlightTags: ['tuckLock'],
  },
  {
    key: 'dustFlapDepth',
    label: { zh: '防塵翼深度' },
    unit: 'mm',
    default: 14,
    min: 0,
    max: 60,
    step: 1,
    group: { zh: '防塵翼與糊邊' },
    description: { zh: '左右防塵翼向內摺入的深度，摺入後蓋住開口內側縫隙，阻擋灰塵與透光。' },
    highlightTags: ['dustFlapDepth'],
  },
  {
    key: 'flapNotch',
    label: { zh: '避讓槽寬' },
    unit: 'mm',
    default: 3,
    min: 0,
    max: 20,
    step: 0.5,
    group: { zh: '折線避讓公差' },
    description: { zh: '防塵翼根部 J 型避讓槽的開口寬度，切開摺線交會處的應力集中點，避免摺紙時把紙纖維撕裂。' },
    highlightTags: ['flapNotch'],
  },
  {
    key: 'creaseRelief',
    label: { zh: '折線避讓間隙' },
    unit: 'mm',
    default: 3,
    min: 0,
    max: 20,
    step: 0.5,
    group: { zh: '折線避讓公差' },
    description: {
      zh: '與避讓槽寬取兩者較大值，共同決定避讓槽的實際尺寸——這裡預留材料摺疊時需要的額外間隙（材質愈厚，摺線愈需要避讓空間）。',
    },
    highlightTags: ['flapNotch'],
  },
  {
    key: 'glueSize',
    label: { zh: '糊邊寬度' },
    unit: 'mm',
    default: 12,
    min: 5,
    max: 60,
    step: 1,
    group: { zh: '防塵翼與糊邊' },
    description: { zh: '糊邊（耳仔）的寬度，是黏合面板首尾兩端、把展開圖捲成筒狀盒身所需的多餘寬度。' },
    highlightTags: ['glueSize'],
  },
  {
    key: 'glueSide',
    label: { zh: '糊邊位置' },
    unit: 'enum',
    default: 'left',
    options: [
      { value: 'left', label: { zh: '左' } },
      { value: 'right', label: { zh: '右' } },
    ],
    group: { zh: '防塵翼與糊邊' },
    description: {
      zh: '糊邊黏貼在整排面板的左側或右側（前身 glueOnRight 布林旗標在此改為 enum）；只影響版面鏡像方向，不影響盒子本身結構。',
    },
    highlightTags: ['glueSize'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 生成
// ─────────────────────────────────────────────────────────────────────────

function addPath(paths: DielinePath[], type: LineType, tag: string | undefined, segments: Segment[]): void {
  if (segments.length === 0) return;
  paths.push({ id: `p-${paths.length}`, type, segments, tags: tag ? [tag] : undefined });
}

/**
 * girth 補償係數（審核條款：改動幾何行為只需修改這個表，不觸其餘程式碼——spec §4.1）。
 *
 * 索引依攤平圖「從糊邊側起算」的面板序 P1..P4：貼糊邊的面板不補償（+0），往外每過一道
 * 摺線多補一個紙厚（+t、+t），離糊邊最遠的面板累積 +2t——紙繞盒身一圈，外層每摺一次要
 * 多走約一個紙厚，離黏合基準面愈遠累積愈多。無前身 ground truth，數值為業界常規，
 * 定案依據＝獨立 review＋維護者生產經驗＋樣張 gate 實摺驗證。
 */
const GIRTH_COMP_FROM_GLUE = [0, 1, 1, 2] as const;

function generate(p: ResolvedParams): GenerateResult {
  const L = p.L as number;
  const W = p.W as number;
  const D = p.D as number;
  const t = p.thickness as number;
  const tuckDepth = p.tuckDepth as number;
  const tuckRadius = p.tuckRadius as number;
  const tuckClearance = p.tuckClearance as number;
  const tuckLock = p.tuckLock as number;
  const dustFlapDepth = p.dustFlapDepth as number;
  const flapNotch = p.flapNotch as number;
  const creaseRelief = p.creaseRelief as number;
  const glueSize = p.glueSize as number;
  const glueOnRight = p.glueSide === 'right';

  // --- Dimensions Setup（前身 13-36 行；v1.2 girth 補償見 GIRTH_COMP_FROM_GLUE）---
  const wGlue = glueSize;
  // girth 補償：面板序依攤平圖「從糊邊側起算」，glueOnRight 時貼糊邊的面板換成 P4，
  // 整表反轉套用（reverse 不改變總和，t=0.4 校驗值見 spec §4.1）。
  const comp = glueOnRight ? [...GIRTH_COMP_FROM_GLUE].reverse() : GIRTH_COMP_FROM_GLUE;
  const wP1 = L + comp[0]! * t;
  const wP2 = W + comp[1]! * t;
  const wP3 = L + comp[2]! * t;
  const wP4 = W + comp[3]! * t;
  const hBody = D;
  const hLid = W; // 蓋板高＝W（開口深度）——不吃 girth 補償，開口配合改由 tuckClearance 吃 t，見不變式 lid-equals-w
  const hTuck = tuckDepth;
  const hDust = dustFlapDepth;
  const r = tuckRadius;

  // --- Relief / Slot Logic（前身 38-42 行：呼叫端算好 gap/notchHeight 再交給 primitives）---
  const xGapVal = Math.max(flapNotch > 0 ? flapNotch : 0, creaseRelief > 0 ? creaseRelief : 0);
  const reliefGap = (xGapVal > 0 ? xGapVal : 3) + t; // 防塵翼讓位：+t 讓翼片摺入時避開相鄰面板的紙厚干涉
  const notchHeight = Math.max(3, reliefGap * 0.6);
  const tInset = tuckClearance; // tuckClearance 的 derivedDefault 已把 +t 併入生效值（見參數宣告）

  // --- Coordinates (X Axis)（前身 44-65 行）---
  let x0 = 0;
  let x1 = 0;
  let x2 = 0;
  let x3 = 0;
  let x4 = 0;
  let xGlueStart = 0;
  let xGlueEnd = 0;

  if (glueOnRight) {
    x0 = 0;
    x1 = x0 + wP1;
    x2 = x1 + wP2;
    x3 = x2 + wP3;
    x4 = x3 + wP4;
    xGlueStart = x4;
    xGlueEnd = x4 + wGlue;
  } else {
    x0 = 0;
    x1 = x0 + wP1;
    x2 = x1 + wP2;
    x3 = x2 + wP3;
    x4 = x3 + wP4;
    xGlueStart = -wGlue;
    xGlueEnd = 0;
  }

  const yTop = 0;
  const yBot = hBody;

  const paths: DielinePath[] = [];
  const texts: DielineText[] = [];
  const push = (type: LineType, tag: string | undefined, segments: Segment[]) => addPath(paths, type, tag, segments);

  // --- 1. Main Body Creases（前身 87-102 行）---
  for (const x of [x1, x2, x3]) {
    push('crease', 'D', new PathBuilder().moveTo(x, yTop).lineTo(x, yBot).segments());
  }
  if (glueOnRight) {
    push('cut', 'D', new PathBuilder().moveTo(x0, yTop).lineTo(x0, yBot).segments());
    push('crease', 'D', new PathBuilder().moveTo(x4, yTop).lineTo(x4, yBot).segments());
  } else {
    push('crease', 'D', new PathBuilder().moveTo(x0, yTop).lineTo(x0, yBot).segments());
    push('cut', 'D', new PathBuilder().moveTo(x4, yTop).lineTo(x4, yBot).segments());
  }

  // --- 2. Glue Flap（前身 104-121 行，導角常數用 T5 的 GLUE_CHAMFER）---
  {
    const b = new PathBuilder();
    if (glueOnRight) {
      b.moveTo(x4, yTop)
        .lineTo(xGlueEnd, yTop + GLUE_CHAMFER)
        .lineTo(xGlueEnd, yBot - GLUE_CHAMFER)
        .lineTo(x4, yBot);
    } else {
      b.moveTo(x0, yTop)
        .lineTo(xGlueStart, yTop + GLUE_CHAMFER)
        .lineTo(xGlueStart, yBot - GLUE_CHAMFER)
        .lineTo(x0, yBot);
    }
    push('cut', 'glueSize', b.segments());
  }

  // --- 3. 摩擦扣（改呼叫 T5 primitives.frictionLock）---
  const drawLock = (xStart: number, xEnd: number, y: number, dir: 'up' | 'down') => {
    const { creases, cut } = frictionLock(xStart, xEnd, y, dir, tuckLock);
    push('crease', 'W', creases); // 前身註解：「Associated with Width usually (Lid)」
    push('cut', 'tuckLock', cut);
  };

  // --- 4. J-Hook 避讓槽（改呼叫 T5 primitives.reliefSlot）---
  const drawRelief = (cornerX: number, cornerY: number, side: 'left' | 'right', dir: 'top' | 'bottom') => {
    const { cut, end } = reliefSlot(cornerX, cornerY, side, dir, reliefGap, notchHeight);
    push('cut', 'flapNotch', cut);
    return end;
  };

  // --- 5. 頂部／底部週界共用結構 ---
  //
  // 前身 167-309 行的 TOP PERIMETER／BOTTOM PERIMETER 兩大段：蓋板（Lid）面板身分
  // 對調（top 蓋板在 P3＝x2–x3、bottom 蓋板在 P1＝x0–x1，素邊面板互換到另一側），
  // 這部分（素邊直線／蓋板側邊 cut／摩擦扣／插舌 cut／蓋板底邊 crease）可以乾淨地用
  // ySign（top=-1／bottom=+1）與 archSweep（top=1／bottom=0，對應前身 A_to 的 sweep
  // 參數在頂部固定傳 1、底部固定傳 0）參數化，兩側完全鏡像。
  //
  // 但兩片防塵翼（P2＝x1–x2、P4＝x3–x4）「非 relief 那個轉角」的畫法，前身本來就
  // 不是彼此鏡像——例如 P2-top 的素邊轉角公式是相對 y_tip 的 `y_tip+3`，P2-bottom
  // 對應轉角卻是相對 edgeY 的 `y_bot+3`；P4-bottom 完全沒有 relief（因為 bottom 的
  // 蓋板在 P1，P4 並不緊鄰蓋板——只有 top 的 P2、P4 兩側都緊鄰置中的蓋板 P3），
  // 且 P4-bottom 自己兩個轉角的畫法彼此也不對稱（x3 角是「fold→斜線→深度」三點，
  // x4 角是「深度→斜線直達近 fold」兩點，跳過中繼點）。這是前身本來的手刻不對稱
  // 細節，不是本次移植的誤差——依 spec 指示保真優先，兩片防塵翼各自用 side 分支
  // 逐字保留前身的原始運算式，不強行套用統一公式（已用預設參數逐行手算核對
  // 42 條 fixture path 全部吻合，見 開發紀錄「移植對照」）。
  const perimeter = (side: 'top' | 'bottom') => {
    const ySign = side === 'top' ? -1 : 1;
    const lockDir: 'up' | 'down' = side === 'top' ? 'up' : 'down';
    const archSweep: 0 | 1 = side === 'top' ? 1 : 0;
    const edgeY = side === 'top' ? yTop : yBot;
    const yTip = edgeY + ySign * hDust;
    const lid = side === 'top' ? { start: x2, end: x3 } : { start: x0, end: x1 };
    const plain = side === 'top' ? { start: x0, end: x1 } : { start: x2, end: x3 };

    // 素邊面板：單純 cut 直線（前身 P1-top「Main Width of P1」／P3-bottom「Cut Edge」）
    push('cut', 'L', new PathBuilder().moveTo(plain.start, edgeY).lineTo(plain.end, edgeY).segments());

    // P2 防塵翼（x1–x2）
    if (side === 'top') {
      const relief = drawRelief(x2, edgeY, 'left', 'top');
      const b = new PathBuilder()
        .moveTo(x1, edgeY)
        .lineTo(x1 + 3, yTip + 3)
        .lineTo(x1 + 3, yTip)
        .lineTo(relief.x, yTip)
        .lineTo(relief.x, relief.y);
      push('cut', 'dustFlapDepth', b.segments());
    } else {
      const relief = drawRelief(x1, edgeY, 'right', 'bottom');
      const b = new PathBuilder()
        .moveTo(relief.x, relief.y)
        .lineTo(relief.x, yTip)
        .lineTo(x2 - 3, yTip)
        .lineTo(x2 - 3, edgeY + 3)
        .lineTo(x2, edgeY);
      push('cut', 'dustFlapDepth', b.segments());
    }
    push('crease', 'dustFlapDepth', new PathBuilder().moveTo(x1, edgeY).lineTo(x2, edgeY).segments());

    // 蓋板面板：側邊 cut + 摩擦扣 + 插舌 cut + 底邊 crease（可乾淨參數化的部分）
    const yFold = edgeY + ySign * hLid;
    push('cut', 'W', new PathBuilder().moveTo(lid.start, edgeY).lineTo(lid.start, yFold).segments());
    push('cut', 'W', new PathBuilder().moveTo(lid.end, edgeY).lineTo(lid.end, yFold).segments());
    drawLock(lid.start, lid.end, yFold, lockDir);

    const yTuck = yFold + ySign * hTuck;
    const xt1 = lid.start + tInset;
    const xt2 = lid.end - tInset;
    // 插舌圓角鉗制（T9 樣張 gate 第二輪維護者反饋，修復 1）——前身既有 bug，等價移植照搬：
    // 垂直邊畫到 `yTuck - ySign*r`，r > hTuck 時這個點會越過摺線 yFold 翻到另一側（例如
    // top 側 ySign=-1 時算出 yTuck+r，r=14>hTuck=10 會得到 yFold 上方的 -51，超出
    // [yTuck,yFold]=[-65,-55] 的合法區間），垂直邊反向翻出、圓弧從錯位點畫回，自撞退化。
    // r 也不能超過插舌半寬，否則頂邊 `xt2-r` 會反轉到 `xt1+r` 左邊、兩段圓弧互相咬合。
    // 鉗制到兩者較小值，讓幾何永遠合法；tuck-radius-clamped 不變式另外示警「設定值未如實
    // 生效」（見下方 invariants）。預設參數 r=3 遠低於鉗制上限，effectiveR===r，行為不變。
    const tongueHalfWidth = (xt2 - xt1) / 2;
    const effectiveR = Math.max(0, Math.min(r, hTuck, tongueHalfWidth));
    const tongue = new PathBuilder().moveTo(lid.start, yFold).lineTo(xt1, yFold);
    if (effectiveR > 0) {
      tongue
        .lineTo(xt1, yTuck - ySign * effectiveR)
        .arcTo(effectiveR, archSweep, xt1 + effectiveR, yTuck)
        .lineTo(xt2 - effectiveR, yTuck)
        .arcTo(effectiveR, archSweep, xt2, yTuck - ySign * effectiveR)
        .lineTo(xt2, yFold);
    } else {
      tongue.lineTo(xt1, yTuck).lineTo(xt2, yTuck).lineTo(xt2, yFold);
    }
    tongue.lineTo(lid.end, yFold);
    push('cut', 'tuckDepth', tongue.segments());
    push('crease', 'L', new PathBuilder().moveTo(lid.start, edgeY).lineTo(lid.end, edgeY).segments());

    // P4 防塵翼（x3–x4）—— 只有 top 才緊鄰蓋板，才有 relief
    if (side === 'top') {
      const relief = drawRelief(x3, edgeY, 'right', 'top');
      const b = new PathBuilder()
        .moveTo(relief.x, relief.y)
        .lineTo(relief.x, yTip)
        .lineTo(x4 - 3, yTip)
        .lineTo(x4 - 3, edgeY - 3)
        .lineTo(x4, edgeY);
      push('cut', 'dustFlapDepth', b.segments());
    } else {
      const b = new PathBuilder()
        .moveTo(x3, edgeY)
        .lineTo(x3 + 3, edgeY + 3)
        .lineTo(x3 + 3, yTip)
        .lineTo(x4 - 3, yTip)
        .lineTo(x4, edgeY + 3)
        .lineTo(x4, edgeY);
      push('cut', 'dustFlapDepth', b.segments());
    }
    push('crease', 'dustFlapDepth', new PathBuilder().moveTo(x3, edgeY).lineTo(x4, edgeY).segments());
  };

  perimeter('top');
  perimeter('bottom');

  // --- 6. Dimensions（前身 311-335 行，改呼叫 T5 primitives.dimensionLine）---
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

  addDim(x1, yTop + hBody / 2, x2, yTop + hBody / 2, wP2, 0, 'W', 'h'); // P2 寬度
  addDim(x2, yTop + hBody / 2, x3, yTop + hBody / 2, wP3, 0, 'L', 'h'); // P3 長度
  addDim(x1, yTop, x1, yBot, hBody, -10, 'D', 'v'); // 盒身高度

  // --- Bounds（前身 337-348 行）---
  let minX: number;
  let maxX: number;
  if (glueOnRight) {
    minX = x0 - 20;
    maxX = xGlueEnd + 20;
  } else {
    minX = xGlueStart - 20;
    maxX = x4 + 20;
  }
  const minY = -hLid - hTuck - 20;
  const maxY = yBot + hLid + hTuck + 20;

  return { paths, texts, bounds: { minX, maxX, minY, maxY } };
}

// ─────────────────────────────────────────────────────────────────────────
// 不變式
// ─────────────────────────────────────────────────────────────────────────

const invariants: BoxInvariant[] = [
  {
    id: 'unfold-width',
    description: {
      zh: '展開總寬必須等於四片主面板加糊邊（L+W+L+W+glueSize），再加 girth 補償總量 4×紙厚（面板序遞增係數 [0,1,1,2] 加總＝4，glueOnRight 只改變分配順序、不改變總和），外加左右各 20mm 的畫布邊距——這是驗證整條 X 座標鏈沒有算錯的最直接方式。',
    },
    check(params, result) {
      const L = params.L as number;
      const W = params.W as number;
      const glueSize = params.glueSize as number;
      const t = params.thickness as number;
      const expected = L + W + L + W + 4 * t + glueSize + 40; // 40 = 左右各 20mm 邊距；4t = girth 補償總量
      const actual = result.bounds.maxX - result.bounds.minX;
      if (Math.abs(actual - expected) > 0.01) {
        return {
          ok: false,
          message: { zh: `展開總寬應為 ${expected}mm（含邊距），實際為 ${actual}mm` },
          tags: ['L', 'W', 'glueSize', 'thickness'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'lid-equals-w',
    description: {
      zh: '上蓋／下蓋沿摺線方向的高度必須等於盒寬 W——蓋板需要完全覆蓋開口，而開口的深度就是 W，蓋板矮了會露餡、高了會多餘的材料浪費。上蓋、下蓋各自的兩側邊都要驗到，缺一側也算不通過。',
    },
    check(params, result) {
      const w = params.W as number;
      // 位置特徵鎖定「數的是哪四條」：perimeter('top') 的 lid.start/lid.end 各一條、
      // perimeter('bottom') 的 lid.start/lid.end 各一條，四條都是「鉛直線」（起訖點 x
      // 座標相同——見 generate() 內 `push('cut','W', moveTo(lid.start,edgeY).lineTo(lid.start,yFold))`
      // 這類呼叫，起訖 x 恆為同一個變數）且長度＝hLid＝W。只用「長度＝W」篩選會被任何巧合
      // 等長但方向不對的線段魚目混珠（見測試「4 條斜線」案例），也無法分辨「少畫一側蓋板」
      // 這種缺漏（舊版 .some() 只要 1 條符合就整體判定通過）——因此除了長度還要求鉛直，
      // 且要求數量 ≥4（上蓋 2＋下蓋 2）。
      const VERTICAL_EPS = 0.01;
      const lidSideCuts = result.paths
        .filter((p) => p.type === 'cut' && p.tags?.includes('W'))
        .flatMap((p) => p.segments)
        .filter((s): s is Extract<Segment, { kind: 'line' }> => s.kind === 'line')
        .filter((s) => Math.abs(s.x1 - s.x2) < VERTICAL_EPS)
        .filter((s) => Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - w) < 0.01);
      if (lidSideCuts.length < 4) {
        return {
          ok: false,
          message: {
            zh: `蓋板側邊鉛直 cut 線應有 4 條（上蓋 2＋下蓋 2，長度皆＝W=${w}mm），實際只找到 ${lidSideCuts.length} 條`,
          },
          tags: ['W'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'tuck-lock-fits',
    description: {
      zh: '摩擦扣寬度必須能放進蓋板所在面板的可用寬度內、且不能窄到讓卡榫梯形反折自撞——寬度失控時刀模會切出面板外或產生無法摺疊的自交幾何。',
    },
    check(params, _result) {
      const L = params.L as number;
      const tuckLock = params.tuckLock as number;
      // 本不變式純參數驗算（跟其餘 4 條不同，不需要從 result 反推——tuckLock 是否放得下
      // 由宣告的 L 與 tuckLock 兩個參數就能算完，不必等 generate() 真的跑出幾何才知道）。
      // 上限用 L：摩擦扣座落在 perimeter() 的 lid.start~lid.end 跨距（top＝wP3、bottom＝
      // wP1，兩者皆＝L——見「移植對照表」的 x 座標鏈，P1/P3 用 L 當寬度、P2/P4 才用 W；
      // W 決定的是「蓋板高」hLid＝摺線到插舌尖端的垂直距離，跟蓋板攤平後的水平跨距是
      // 兩個不同的量）。已用 L≠W 的區分性參數（L=40,W=90）實測：frictionLock 產生的
      // cut x 範圍精確等於 [lid.start, lid.end]（寬度 40＝L，與 W=90 無關），
      // tuckLock=50>40=L 時 cut 範圍確實溢出 lid 跨距——證實正確上限是 L。
      if (tuckLock > 0 && tuckLock > L) {
        return {
          ok: false,
          message: { zh: `摩擦扣寬 ${tuckLock}mm 超過蓋板可容納寬度 ${L}mm，會切出面板外` },
          tags: ['tuckLock', 'L'],
        };
      }
      // 下限：LOCK_CHAMFER（兩側導角，各 2mm）總和＝4mm。frictionLock 的梯形頂邊兩端點
      // 是 xLeft+LOCK_CHAMFER 與 xRight-LOCK_CHAMFER；當 lockWidth<2×LOCK_CHAMFER 時
      // 這兩點會交叉（左端點跑到右端點右邊），畫出來的頂邊方向反轉，梯形變成自交的
      // 「反折」蝴蝶結形狀而非正常梯形（已實測 tuckLock=2/3.9 時頂邊 x1>x2 反轉，
      // tuckLock=4 剛好退化成頂點重合的三角形、tuckLock=5 起才是正常梯形）。
      if (tuckLock > 0 && tuckLock < 2 * LOCK_CHAMFER) {
        return {
          ok: false,
          message: { zh: `摩擦扣寬 ${tuckLock}mm 小於兩側導角總和 ${2 * LOCK_CHAMFER}mm，卡榫梯形會反折自撞` },
          tags: ['tuckLock'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-nan',
    description: { zh: '所有幾何座標必須是有效數字；任何 NaN 代表參數鏈某處算式除零或讀到未定義值，畫布/匯出會整個崩潰。' },
    check(_params, result) {
      const allSegs = result.paths.flatMap((p) => p.segments);
      if (hasNaN(allSegs)) {
        return { ok: false, message: { zh: '偵測到 NaN 座標' } };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-bleed',
    description: { zh: 'v1 尚不支援出血線（bleed）——盒型不得產生 bleed 線型的路徑，避免下游畫布/匯出誤判成尚未支援的線型。' },
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
      const allSegs = result.paths.flatMap((p) => p.segments);
      const actual = segmentsBounds(allSegs);
      const EPS = 0.01;
      const ok =
        actual.minX >= result.bounds.minX - EPS &&
        actual.maxX <= result.bounds.maxX + EPS &&
        actual.minY >= result.bounds.minY - EPS &&
        actual.maxY <= result.bounds.maxY + EPS;
      if (!ok) {
        return { ok: false, message: { zh: 'bounds 未完整涵蓋所有路徑的實際範圍' } };
      }
      return { ok: true };
    },
  },
  {
    id: 'tuck-radius-clamped',
    description: {
      zh: '插舌圓角半徑不能超過插舌深度、也不能超過插舌開口的半寬，否則轉角垂直邊會在摺線兩側反向翻出、頂邊方向反轉造成自撞（見 generate() 的 effectiveR 鉗制）。generate() 已鉗制實際繪製半徑，幾何永遠合法；這條不變式純粹示警「tuckRadius 設定值沒有如實生效」，讓使用者知道畫出來的圓角比他設的小。',
    },
    check(params, _result) {
      // 純參數驗算（跟 tuck-lock-fits 同類手法）：鉗制上限只由 tuckDepth／L／tuckClearance
      // 三個宣告參數決定，見 generate() 的 tongueHalfWidth = (xt2-xt1)/2，其中 xt2-xt1 =
      // 插舌所在面板跨距（P1/P3 皆為 L，見 tuck-lock-fits 註解的移植對照）減去左右各一個
      // tuckClearance，即 L - 2*tuckClearance。
      const tuckDepth = params.tuckDepth as number;
      const tuckRadius = params.tuckRadius as number;
      const L = params.L as number;
      const tuckClearance = params.tuckClearance as number;
      const tongueHalfWidth = (L - 2 * tuckClearance) / 2;
      const limit = Math.max(0, Math.min(tuckDepth, tongueHalfWidth));
      const EPS = 0.001;
      if (tuckRadius > limit + EPS) {
        return {
          ok: false,
          message: { zh: `插舌圓角 ${tuckRadius}mm 超過幾何上限 ${limit}mm（受插舌深度/寬度限制），已鉗制繪製` },
          tags: ['tuckRadius', 'tuckDepth'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'no-cut-self-intersection',
    description: {
      zh: '所有 cut 類路徑的線段兩兩之間不得真交叉（內部交點；共享端點的正常轉角銜接不算）——真交叉代表幾何已退化成自撞的翻折形狀（例如插舌圓角鉗制前，r 過大時垂直邊反向翻出貫穿圓弧），刀模無法沿這種路徑正確裁切。dimension/annotation 不參與這條檢查。',
    },
    check(_params, result) {
      const cutSegments = result.paths.filter((p) => p.type === 'cut').flatMap((p) => p.segments);
      if (hasSelfIntersection(cutSegments)) {
        return { ok: false, message: { zh: 'cut 路徑偵測到自撞（線段真交叉），幾何已退化成無法裁切的翻折形狀' } };
      }
      return { ok: true };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// 模組匯出與自我註冊
// ─────────────────────────────────────────────────────────────────────────

export const reverseTuckEnd: BoxModule = {
  meta: {
    id: 'rte',
    name: { zh: '反插式尾封盒 (Reverse Tuck End, RTE)' },
    intro: {
      zh: '前後左右四片面板一字排開展開的盒型；上下蓋板各以插舌卡入摩擦扣固定開口，兩側防塵翼摺入遮擋縫隙，免膠帶封口。',
    },
    topology: 'linear',
  },
  params,
  invariants,
  generate,
};

registerBox(reverseTuckEnd);
