/**
 * 天地盒內襯圍框——L 形斷面落地圍框的帶狀攤平幾何（Slice 2 Task 4）。
 *
 * 構造參照（唯讀、只借拓撲不借數值）：coding-workspace 任務夾
 * `feature/2026/07/07-open-dieline/gen_liner.py`（原檔遺失後的重建腳本）——
 * tab｜長壁｜短壁｜長壁｜短壁 交替的攤平帶，每段壁頂向上翻邊（45° 梯形讓位）。
 * 本檔的 frameL/frameW/flange 由 spec §4.2 導出鏈公式重新推導（等邊 lidMargin
 * 假設下兩方向翻邊相同，見 deriveLinerFrame），不是抄 gen_liner.py 的常數。
 *
 * tab 45° 斜切：gen_liner.py 原始座標（tip 落在 x=5）代入其 TAB=15 反而量不出
 * 45°（dx=10,dy=5，26.57°非 45°）——與其自身註解「45° 斜切 5mm」矛盾，判斷是
 * 重建腳本的手誤（此腳本本身就是「原檔遺失後的重建」，非生產 ground truth）。
 * 本檔改採真 45°（dx=dy=GLUE_CHAMFER）以符合 brief 明文的「45°」與「GLUE_CHAMFER」
 * 語意，tip 因此內縮到 TAB−GLUE_CHAMFER（見 generateLiner 內註解）。
 *
 * 純 TS 模組，不 import React 或任何 UI。座標單位一律 mm。
 */

import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import { PathBuilder } from '@/core/path';
import { GLUE_CHAMFER, dimensionLine } from '@/core/primitives';
import type { DielinePath, DielineText, LineType } from '@/core/types';

// ─────────────────────────────────────────────────────────────────────────
// 具名常數
// ─────────────────────────────────────────────────────────────────────────

/** 黏合 tab 深度（照量測／brief 明列，非 thickness 的函式）。 */
const LINER_TAB = 15;

/**
 * 內襯翻邊最小可用寬度——小於此值時 flange 已窄到難以穩定黏貼／卡入下盒外壁，
 * `liner-flange-fits` 不變式（index.ts）以此為警告門檻（spec §4.2）。
 */
export const MIN_FLANGE = 5;

/** 標註線與量測點的安全外推距離——見 index.ts 同名常數的完整推導註解（primitives.dimensionLine
 * 的文字錨點相對量測點有固定位移，需 offset 夠大文字才不會跑到路徑包絡外）。 */
const DIM_OFFSET = 8;

// ─────────────────────────────────────────────────────────────────────────
// 導出鏈
// ─────────────────────────────────────────────────────────────────────────

export interface LinerFrameInputs {
  baseLength: number;
  baseWidth: number;
  lidMargin: number;
  thickness: number;
  fitGap: number;
}

export interface LinerFrame {
  /** 圍框外圍，對應 baseLength 軸（brief 導出鏈的「長壁」）。 */
  frameL: number;
  /** 圍框外圍，對應 baseWidth 軸（brief 導出鏈的「短壁」）。 */
  frameW: number;
  /** 翻邊寬（兩方向共用同一值，等邊 lidMargin 下代數化簡的結果）。 */
  flange: number;
}

/**
 * 內襯導出鏈（spec §4.2；brief 逐字公式）——由上蓋/下盒的套合幾何反推，無獨立尺寸參數：
 * 圍框外圍＝上蓋內淨−2×fitGap（扣一次，對上蓋側）；翻邊寬代數化簡後＝
 * lidMargin−4t−2×fitGap（内含對下盒側的第二次扣）。
 */
export function deriveLinerFrame(p: LinerFrameInputs): LinerFrame {
  const lidPanelL = p.baseLength + 2 * p.lidMargin;
  const lidPanelW = p.baseWidth + 2 * p.lidMargin;
  const lidInnerL = lidPanelL - 4 * p.thickness;
  const lidInnerW = lidPanelW - 4 * p.thickness;
  const frameL = lidInnerL - 2 * p.fitGap;
  const frameW = lidInnerW - 2 * p.fitGap;
  const flange = p.lidMargin - 4 * p.thickness - 2 * p.fitGap;
  return { frameL, frameW, flange };
}

// ─────────────────────────────────────────────────────────────────────────
// 幾何生成
// ─────────────────────────────────────────────────────────────────────────

export interface LinerOpts extends LinerFrameInputs {
  /** 圍框壁高＝baseHeight（頂緣與下盒盒口齊平，見 spec §4.2 導出鏈）。 */
  baseHeight: number;
  idPrefix: string;
  offsetX: number;
  offsetY: number;
}

interface PathDescriptor {
  type: LineType;
  tags: string[];
  segments: Segment[];
}

/** 平移一組 Segment（同 tray.ts 的 translateSegments 慣例；各檔各自持有，避免跨檔耦合）。 */
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

/** 四段壁的寬度序（brief：長壁｜短壁｜長壁｜短壁 交替，對應 frameL/frameW）。 */
function wallSegments(frame: LinerFrame): Array<{ width: number; tag: string }> {
  return [
    { width: frame.frameL, tag: 'long' },
    { width: frame.frameW, tag: 'short' },
    { width: frame.frameL, tag: 'long' },
    { width: frame.frameW, tag: 'short' },
  ];
}

/**
 * 黏合 tab（梯形，cut+根部 crease）：root 於 x=LINER_TAB（全高 crease，與第一段壁相接的摺線），
 * tip 內縮至 x=LINER_TAB−GLUE_CHAMFER、45° 斜切讓 tip 的平邊比 root 短 2×GLUE_CHAMFER
 * （上下各切掉一個 GLUE_CHAMFER×GLUE_CHAMFER 直角三角形，非 gen_liner.py 的不對稱斜率）。
 */
function buildTab(yFold: number, yBot: number): PathDescriptor[] {
  const tipX = LINER_TAB - GLUE_CHAMFER;
  const cut = new PathBuilder()
    .moveTo(LINER_TAB, yFold)
    .lineTo(tipX, yFold + GLUE_CHAMFER)
    .lineTo(tipX, yBot - GLUE_CHAMFER)
    .lineTo(LINER_TAB, yBot)
    .segments();
  const crease = new PathBuilder().moveTo(LINER_TAB, yFold).lineTo(LINER_TAB, yBot).segments();
  return [
    { type: 'cut', tags: ['linerTab'], segments: cut },
    { type: 'crease', tags: ['linerTab', 'root'], segments: crease },
  ];
}

/** 壁帶底邊（tab 根到右端，一條連續 cut）＋右端封邊（最後一段壁的外緣，與 tab 隔著整條壁帶相黏成環）。 */
function buildBottomAndSeal(totalWidth: number, yFold: number, yBot: number): PathDescriptor[] {
  const bottom = new PathBuilder().moveTo(LINER_TAB, yBot).lineTo(totalWidth, yBot).segments();
  const seal = new PathBuilder().moveTo(totalWidth, yBot).lineTo(totalWidth, yFold).segments();
  return [
    { type: 'cut', tags: ['linerWall', 'bottom'], segments: bottom },
    { type: 'cut', tags: ['linerWall', 'end'], segments: seal },
  ];
}

/**
 * 四段壁的摺線與翻邊梯形：壁-壁摺線（除最後一段——右緣是外緣 cut，留給黏合，非摺線）、
 * 壁-翻邊摺線、翻邊梯形輪廓 cut（45° 讓位，高度＝flange，等邊 margin 下四段共用同一值）。
 */
function buildWallsAndFlanges(frame: LinerFrame, yFold: number, yBot: number): PathDescriptor[] {
  const descriptors: PathDescriptor[] = [];
  const segs = wallSegments(frame);
  const yTop = yFold - frame.flange;
  let x = LINER_TAB;
  for (let i = 0; i < segs.length; i++) {
    const { width, tag } = segs[i]!;
    const x2 = x + width;
    if (i < segs.length - 1) {
      descriptors.push({
        type: 'crease',
        tags: ['linerWall', tag, 'fold'],
        segments: new PathBuilder().moveTo(x2, yFold).lineTo(x2, yBot).segments(),
      });
    }
    descriptors.push({
      type: 'crease',
      tags: ['linerFlange', tag, 'fold'],
      segments: new PathBuilder().moveTo(x, yFold).lineTo(x2, yFold).segments(),
    });
    descriptors.push({
      type: 'cut',
      tags: ['linerFlange', tag],
      segments: new PathBuilder()
        .moveTo(x, yFold)
        .lineTo(x + frame.flange, yTop)
        .lineTo(x2 - frame.flange, yTop)
        .lineTo(x2, yFold)
        .segments(),
    });
    x = x2;
  }
  return descriptors;
}

/** 帶長／壁高兩條尺寸標註（brief：liner 標「帶長＋壁高」）；offset 皆用正值外推，見 DIM_OFFSET 註解。 */
function buildDimensions(totalWidth: number, wallH: number, yFold: number, yBot: number): { descriptors: PathDescriptor[]; texts: Omit<DielineText, 'id'>[] } {
  const descriptors: PathDescriptor[] = [];
  const texts: Omit<DielineText, 'id'>[] = [];

  const lenDim = dimensionLine(LINER_TAB, yBot, totalWidth, yBot, `${(totalWidth - LINER_TAB).toFixed(1)}mm`, DIM_OFFSET, 'h');
  descriptors.push({ type: 'dimension', tags: ['linerLen'], segments: lenDim.paths });
  texts.push({ x: lenDim.text.x, y: lenDim.text.y, text: lenDim.text.text, rotation: lenDim.text.rotation, fontSize: 3, anchor: 'middle' });

  const heightDim = dimensionLine(totalWidth, yFold, totalWidth, yBot, `${wallH.toFixed(1)}mm`, DIM_OFFSET, 'v');
  descriptors.push({ type: 'dimension', tags: ['linerHeight'], segments: heightDim.paths });
  texts.push({ x: heightDim.text.x, y: heightDim.text.y, text: heightDim.text.text, rotation: heightDim.text.rotation, fontSize: 3, anchor: 'start' });

  return { descriptors, texts };
}

/**
 * 內襯圍框攤平帶生成——局部座標原點＝tab 根左上角外緣（非置中），y 向下為壁帶方向
 * （沿用 gen_liner.py 的構造慣例，純視覺方向不影響正確性）。
 */
export function generateLiner(opts: LinerOpts): { paths: DielinePath[]; texts: DielineText[]; bounds: Bounds } {
  const frame = deriveLinerFrame(opts);
  const wallH = opts.baseHeight;
  const yFold = frame.flange;
  const yBot = frame.flange + wallH;
  const totalWidth = LINER_TAB + wallSegments(frame).reduce((sum, s) => sum + s.width, 0);

  const { descriptors: dimDescriptors, texts: dimTexts } = buildDimensions(totalWidth, wallH, yFold, yBot);

  const descriptors: PathDescriptor[] = [
    ...buildTab(yFold, yBot),
    ...buildBottomAndSeal(totalWidth, yFold, yBot),
    ...buildWallsAndFlanges(frame, yFold, yBot),
    ...dimDescriptors,
  ];

  const paths: DielinePath[] = descriptors
    .filter((d) => d.segments.length > 0)
    .map((d, i) => ({
      id: `${opts.idPrefix}-p-${i}`,
      type: d.type,
      segments: translateSegments(d.segments, opts.offsetX, opts.offsetY),
      tags: d.tags,
    }));

  const texts: DielineText[] = dimTexts.map((t, i) => ({
    ...t,
    id: `${opts.idPrefix}-t-${i}`,
    x: t.x + opts.offsetX,
    y: t.y + opts.offsetY,
  }));

  const bounds = segmentsBounds(paths.flatMap((p) => p.segments));
  return { paths, texts, bounds };
}
