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
import { hasNaN, segmentsBounds } from '@/core/geometry';
import { GLUE_CHAMFER, frictionLock, reliefSlot, dimensionLine } from '@/core/primitives';

// ─────────────────────────────────────────────────────────────────────────
// 參數宣告
// ─────────────────────────────────────────────────────────────────────────
//
// 前身 BoxDimensions 型別（trouver.crm-rebuild/components/Tools/Packaging/types.ts）
// 為跨盒型參數聯集大袋子，RTE 專用欄位共 13 個：L/W/D/thickness/tuckDepth/tuckRadius/
// tuckClearance/tuckLock/dustFlapDepth/flapNotch/creaseRelief/glueSize/glueOnRight。
//
// 這裡只宣告 12 個，**不含 thickness**——經 grep 驗證，前身 `generateReverseTuckEnd`
// 的解構賦值（該檔 3-11 行）完全不含 thickness，全檔 357 行也無任何一處讀取它；
// thickness 在前身只用於「舊 UI 的 auto-link 便利功能」（React 元件狀態，index.tsx
// 121-150 行：thickness 改變時「建議」creaseRelief=thickness*2、flapNotch=relief+1），
// 不屬於這個純幾何函式的移植範圍，brief 也未要求移植 UI 狀態邏輯。
//
// 若把 thickness 也宣告進來，會直接牴觸 spec §3.3 的明文規則「參數宣告即接線——
// 盒型不得宣告 generate 未使用的參數」（§8 假旋鈕測試正是為了強制這條規則存在），
// 且無法在不破壞等價驗收（fixture 由不吃 thickness 的前身函式產生）的前提下，
// 賦予它任何真實幾何效果——兩個目標無法同時滿足時，spec 的明文架構規則優先於
// brief 表格的字面列舉（brief 表格很可能是機械抄錄 BoxDimensions 聯集型別時，
// 沒有逐一核對 generate() 是否真的用到每個欄位）。詳細取捨記錄見 task-6-report.md。
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

function generate(p: ResolvedParams): GenerateResult {
  const L = p.L as number;
  const W = p.W as number;
  const D = p.D as number;
  const tuckDepth = p.tuckDepth as number;
  const tuckRadius = p.tuckRadius as number;
  const tuckClearance = p.tuckClearance as number;
  const tuckLock = p.tuckLock as number;
  const dustFlapDepth = p.dustFlapDepth as number;
  const flapNotch = p.flapNotch as number;
  const creaseRelief = p.creaseRelief as number;
  const glueSize = p.glueSize as number;
  const glueOnRight = p.glueSide === 'right';

  // --- Dimensions Setup（前身 13-36 行）---
  const wGlue = glueSize;
  const wP1 = L;
  const wP2 = W;
  const wP3 = L;
  const wP4 = W;
  const hBody = D;
  const hLid = W; // 蓋板高＝W（開口深度），見不變式 lid-equals-w
  const hTuck = tuckDepth;
  const hDust = dustFlapDepth;
  const r = tuckRadius;

  // --- Relief / Slot Logic（前身 38-42 行：呼叫端算好 gap/notchHeight 再交給 primitives）---
  const xGapVal = Math.max(flapNotch > 0 ? flapNotch : 0, creaseRelief > 0 ? creaseRelief : 0);
  const reliefGap = xGapVal > 0 ? xGapVal : 3;
  const notchHeight = Math.max(3, reliefGap * 0.6);
  const tInset = tuckClearance;

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
  // 細節，不是本次移植的誤差——依 brief 指示保真優先，兩片防塵翼各自用 side 分支
  // 逐字保留前身的原始運算式，不強行套用統一公式（已用預設參數逐行手算核對
  // 42 條 fixture path 全部吻合，見 task-6-report.md「移植對照」）。
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
    const tongue = new PathBuilder().moveTo(lid.start, yFold).lineTo(xt1, yFold);
    if (r > 0) {
      tongue
        .lineTo(xt1, yTuck - ySign * r)
        .arcTo(r, archSweep, xt1 + r, yTuck)
        .lineTo(xt2 - r, yTuck)
        .arcTo(r, archSweep, xt2, yTuck - ySign * r)
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
      zh: '展開總寬必須等於四片主面板加糊邊（L+W+L+W+glueSize），外加左右各 20mm 的畫布邊距——這是驗證整條 X 座標鏈沒有算錯的最直接方式。',
    },
    check(params, result) {
      const L = params.L as number;
      const W = params.W as number;
      const glueSize = params.glueSize as number;
      const expected = L + W + L + W + glueSize + 40; // 40 = 左右各 20mm 邊距
      const actual = result.bounds.maxX - result.bounds.minX;
      if (Math.abs(actual - expected) > 0.01) {
        return {
          ok: false,
          message: { zh: `展開總寬應為 ${expected}mm（含邊距），實際為 ${actual}mm` },
          tags: ['L', 'W', 'glueSize'],
        };
      }
      return { ok: true };
    },
  },
  {
    id: 'lid-equals-w',
    description: {
      zh: '上蓋／下蓋沿摺線方向的高度必須等於盒寬 W——蓋板需要完全覆蓋開口，而開口的深度就是 W，蓋板矮了會露餡、高了會多餘的材料浪費。',
    },
    check(params, result) {
      const w = params.W as number;
      const lidCuts = result.paths.filter((p) => p.type === 'cut' && p.tags?.includes('W'));
      const lengths = lidCuts
        .flatMap((p) => p.segments)
        .filter((s): s is Extract<Segment, { kind: 'line' }> => s.kind === 'line')
        .map((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1));
      const ok = lengths.some((len) => Math.abs(len - w) < 0.01);
      if (!ok) {
        return { ok: false, message: { zh: `找不到長度等於 W(${w}mm) 的蓋板側邊 cut 線段` }, tags: ['W'] };
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
];

// ─────────────────────────────────────────────────────────────────────────
// 模組匯出與自我註冊
// ─────────────────────────────────────────────────────────────────────────

export const reverseTuckEnd: BoxModule = {
  meta: {
    id: 'rte',
    name: { zh: '反插式尾封盒 (Reverse Tuck End, RTE)' },
    intro: {
      zh: '業界標準代號 ECMA A10.20，前後左右四片面板一字排開展開的盒型；上下蓋板各以插舌卡入摩擦扣固定開口，兩側防塵翼摺入遮擋縫隙，免膠帶封口。',
    },
    topology: 'linear',
  },
  params,
  invariants,
  generate,
};

registerBox(reverseTuckEnd);
