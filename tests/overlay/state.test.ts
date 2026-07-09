import { describe, it, expect } from 'vitest';
import type { Bounds, Segment } from '@/core/geometry';
import type { OverlayParseResult } from '@/overlay/parse';
import {
  OVERLAY_STROKE,
  alignOffset,
  calibrateScale,
  findNearestOverlaySegment,
  initialScaleGuess,
} from '@/overlay/state';

describe('initialScaleGuess', () => {
  it('沒有 width 字尾時，pt/mm/px 三個下拉值各自回傳對應比例', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: null, viewBox: null };
    expect(initialScaleGuess(sourceInfo, 'pt')).toBeCloseTo(0.352778, 6);
    expect(initialScaleGuess(sourceInfo, 'mm')).toBe(1);
    expect(initialScaleGuess(sourceInfo, 'px')).toBeCloseTo(25.4 / 96, 6);
  });

  it('width="200mm" 自動判定為 mm，覆蓋 unit 下拉選的 pt', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '200mm', viewBox: null };
    expect(initialScaleGuess(sourceInfo, 'pt')).toBe(1);
  });

  it('width="595.28pt" 自動判定為 pt，覆蓋 unit 下拉選的 mm', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '595.28pt', viewBox: null };
    expect(initialScaleGuess(sourceInfo, 'mm')).toBeCloseTo(0.352778, 6);
  });

  it('width="800px"：px 字尾不觸發自動判定，回退用 unit 下拉值', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '800px', viewBox: null };
    expect(initialScaleGuess(sourceInfo, 'mm')).toBe(1);
  });

  it('width 為純數字無單位字尾：回退用 unit 下拉值', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '800', viewBox: null };
    expect(initialScaleGuess(sourceInfo, 'px')).toBeCloseTo(25.4 / 96, 6);
  });

  // ── FX6（Slice 3 final review，規格修正）：width 字尾＋viewBox 併存時，scale＝width 換算
  // 成 mm ÷ viewBox 寬度，不是只看字尾（見 initialScaleGuess 文件的完整推導）。────────────
  it('FX6：Illustrator 標準 A4 匯出（width="210mm" viewBox="0 0 595.28 841.89"）—— scale＝210÷595.28（viewBox 座標其實是 pt，非「1 使用者單位=1mm」）', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '210mm', viewBox: '0 0 595.28 841.89' };
    // 獨立 node -e 手算核對：210/595.28 ≈ 0.3527751646284102（非任意巧合——viewBox 寬度就是
    // 拿 210mm 除以「1pt=0.352778mm」反推出來的 72dpi 座標值，非本模組的 UNIT_TO_MM.pt 常數）。
    expect(initialScaleGuess(sourceInfo, 'px')).toBeCloseTo(210 / 595.28, 6);
    expect(initialScaleGuess(sourceInfo, 'px')).not.toBeCloseTo(1, 2); // 修前行為（字尾單獨判定 mm→1）不應再出現
  });

  it('FX6：width 為 pt 字尾＋viewBox 併存時同樣換算（非只有 mm 字尾才處理）——width="100pt" viewBox 寬 50 時 scale=(100×0.352778)/50', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '100pt', viewBox: '0 0 50 30' };
    expect(initialScaleGuess(sourceInfo, 'mm')).toBeCloseTo((100 * 0.352778) / 50, 6);
  });

  it('FX6：viewBox 格式無法解析（非 4 個數字）時，安全退回修前的字尾判定，不 throw／不產生 NaN', () => {
    const sourceInfo: OverlayParseResult['sourceInfo'] = { widthAttr: '210mm', viewBox: 'not-a-viewbox' };
    expect(initialScaleGuess(sourceInfo, 'px')).toBe(1); // 退回 UNIT_TO_MM.mm（同「無 viewBox」分支）
  });

  // 「無 viewBox 時維持修前字尾判定，不迴歸」已由上方第 2 個既有測試（width="200mm"
  // viewBox=null → pt 下拉 → 1）逐位元覆蓋，不重複新增——那個案例本身就是 FX6 修法的
  // 「不迴歸」分支，重寫一份幾乎相同的斷言不會提供新的保護面。
});

describe('alignOffset', () => {
  const raw: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 20 };
  const scale = 2;

  it("'top-left'：raw×scale 的左上角對齊 target 左上角", () => {
    const target: Bounds = { minX: 100, maxX: 200, minY: 50, maxY: 90 };
    // offsetX = target.minX - raw.minX*scale = 100 - 0 = 100；offsetY 同理 = 50 - 0 = 50
    expect(alignOffset(raw, scale, target, 'top-left')).toEqual({ offsetX: 100, offsetY: 50 });
  });

  it("'center'：raw×scale 的幾何中心對齊 target 中心", () => {
    const target: Bounds = { minX: 100, maxX: 140, minY: 50, maxY: 130 };
    // rawCenter = ((0+10)/2, (0+20)/2)*scale = (5,10)*2 = (10,20)
    // targetCenter = ((100+140)/2, (50+130)/2) = (120,90) → offset = (110,70)
    expect(alignOffset(raw, scale, target, 'center')).toEqual({ offsetX: 110, offsetY: 70 });
  });

  it("'bbox'：兩軸尺寸都在 target 的 5% 容差內 → 兩軸都用中心微調（等同 'center' 結果）", () => {
    const bboxRaw: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    const bboxScale = 10; // scaled raw：100×100
    // target 寬 98（|100-98|=2 ≤ 98*0.05=4.9 → 接近）、高 102（|100-102|=2 ≤ 102*0.05=5.1 → 接近）
    const target: Bounds = { minX: 5, maxX: 103, minY: 20, maxY: 122 };
    // rawCenter = (5,5)*10 = (50,50)；targetCenter = (54,71) → offset = (4,21)
    expect(alignOffset(bboxRaw, bboxScale, target, 'bbox')).toEqual({ offsetX: 4, offsetY: 21 });
  });

  it("'bbox'：兩軸尺寸都與 target 差距超過 5% 容差 → 兩軸都退回左上對齊（等同 'top-left' 結果）", () => {
    const bboxRaw: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    const bboxScale = 10; // scaled raw：100×100
    // target 寬高皆 50（差 50，遠超 50*0.05=2.5 容差）
    const target: Bounds = { minX: 5, maxX: 55, minY: 20, maxY: 70 };
    expect(alignOffset(bboxRaw, bboxScale, target, 'bbox')).toEqual({ offsetX: 5, offsetY: 20 });
  });

  it("'bbox'：只有 X 軸尺寸接近、Y 軸差距過大 → 每軸獨立判斷（X 中心微調、Y 左上對齊）", () => {
    const bboxRaw: Bounds = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    const bboxScale = 10; // scaled raw：100×100
    // X：target 寬 98（接近）；Y：target 高 50（差 50，不接近）
    const target: Bounds = { minX: 5, maxX: 103, minY: 20, maxY: 70 };
    // X 中心微調：rawCenterX=50, targetCenterX=54 → offsetX=4
    // Y 左上對齊：offsetY = target.minY - raw.minY*scale = 20 - 0 = 20
    expect(alignOffset(bboxRaw, bboxScale, target, 'bbox')).toEqual({ offsetX: 4, offsetY: 20 });
  });
});

// createOverlayState／OverlayState 已於 Slice 3 gate round 1 T2 隨 OverlayPanel→LayersPanel
// 遷移退役（單一疊圖模型被 `overlay/layers.ts` 的 `OverlayLayer`/`LayersState` 取代）；等價
// 的建構邏輯（scale/rawBounds/opacity/visible/calibrated 預設值＋ segments 不預變換）已在
// `tests/overlay/layers.test.ts` 的 `createOverlayLayer` 測試覆蓋，這裡不重複驗證一份即將
// 刪除的死程式碼。

describe('OVERLAY_STROKE', () => {
  it('固定為 brief 規格值（洋紅），供 Canvas 疊繪與測試共用同一來源', () => {
    expect(OVERLAY_STROKE).toBe('#FF00FF');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 Task 5：calibrateScale——線段自身「弦長」（line/bezier 端點距、arc 起訖點弦長，
// 都不是弧長／曲線長，見 brief「使用者量的是實體兩點間距離」）→ actualMm/rawLength。
// ─────────────────────────────────────────────────────────────────────────
describe('calibrateScale', () => {
  it('line：端點距為 rawLength（3-4-5 直角三角形，弦長=5）', () => {
    const seg: Segment = { kind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 };
    expect(calibrateScale(seg, 100)).toBeCloseTo(100 / 5, 6); // 100mm / 5 = 20
  });

  it('arc：弦長＝起訖點直線距離（非弧長）——半圓（0°→180°，r=5）弦長＝直徑=10', () => {
    const seg: Segment = { kind: 'arc', cx: 0, cy: 0, r: 5, startAngle: 0, endAngle: Math.PI, ccw: false };
    // 起點(5,0)、訖點(-5,0)，弦長=10；若誤用弧長（半圓周長=5π≈15.71）結果會不同，藉此區分實作正確性
    expect(calibrateScale(seg, 25)).toBeCloseTo(25 / 10, 6); // 2.5
  });

  it('bezier：端點弦長，忽略控制點（控制點差很多但端點相同時，結果不變）', () => {
    const segA: Segment = { kind: 'bezier', x1: 0, y1: 0, c1x: 1, c1y: 1, c2x: 2, c2y: 2, x2: 6, y2: 8 };
    const segB: Segment = { kind: 'bezier', x1: 0, y1: 0, c1x: -50, c1y: 80, c2x: 999, c2y: -1, x2: 6, y2: 8 };
    // 端點距 = sqrt(6²+8²) = 10，兩者端點相同，控制點差異不影響 rawLength
    expect(calibrateScale(segA, 50)).toBeCloseTo(5, 6); // 50/10
    expect(calibrateScale(segB, 50)).toBeCloseTo(5, 6);
  });

  it('零長線段（起訖點重合）→ rawLength=0，回傳 Infinity（不特別防呆——呼叫端 hit-test 已排除零長段可選取，見 findNearestOverlaySegment）', () => {
    const seg: Segment = { kind: 'line', x1: 5, y1: 5, x2: 5, y2: 5 };
    expect(calibrateScale(seg, 10)).toBe(Infinity);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 Task 5：findNearestOverlaySegment——校準模式 hit-test 純函式，在 overlay 原始座標系
// 中找最近線段。line 直接算、arc 用 5° 步進折線近似、bezier 用既有 flattenBezier。
// ─────────────────────────────────────────────────────────────────────────
describe('findNearestOverlaySegment', () => {
  const lineSeg: Segment = { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }; // index 0
  const arcSeg: Segment = { kind: 'arc', cx: 100, cy: 100, r: 10, startAngle: 0, endAngle: Math.PI / 2, ccw: false }; // index 1，起點 (110,100)
  const bezierSeg: Segment = { kind: 'bezier', x1: 200, y1: 200, c1x: 200.5, c1y: 200, c2x: 201, c2y: 200, x2: 203, y2: 200 }; // index 2，端點共線（y=200）、弦長 3 < maxSegLen(5) → flattenBezier 只會回傳一段折線
  const zeroSeg: Segment = { kind: 'line', x1: 50, y1: 50, x2: 50, y2: 50 }; // index 3，零長

  it('line：點到線段垂直距離在閾值內 → 命中，distance 為精確垂直距離', () => {
    const result = findNearestOverlaySegment([lineSeg], { x: 5, y: 0.5 }, 1);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(result!.distance).toBeCloseTo(0.5, 6);
  });

  it('line：投影落在端點外時退回端點距離（點在 x=-5，垂足超出線段範圍）', () => {
    const result = findNearestOverlaySegment([lineSeg], { x: -5, y: 0 }, 10);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeCloseTo(5, 6); // 退回到端點 (0,0) 的距離
  });

  it('距離超過閾值 → null', () => {
    expect(findNearestOverlaySegment([lineSeg], { x: 5, y: 2 }, 1)).toBeNull();
  });

  it('閾值邊界：distance 恰等於 threshold → 命中（<=）；threshold 略小於 distance → null', () => {
    expect(findNearestOverlaySegment([lineSeg], { x: 5, y: 1 }, 1)).not.toBeNull(); // distance=1, threshold=1
    expect(findNearestOverlaySegment([lineSeg], { x: 5, y: 1 }, 0.99)).toBeNull();
  });

  it('arc：命中 arc 自身取樣起點（5° 步進折線的第一個點，理論距離為 0）', () => {
    const result = findNearestOverlaySegment([arcSeg], { x: 110, y: 100 }, 0.01);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(result!.distance).toBeCloseTo(0, 6);
  });

  it('bezier：命中端點共線折線（弦上一點，理論距離為 0）', () => {
    const result = findNearestOverlaySegment([bezierSeg], { x: 201.5, y: 200 }, 0.01);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(result!.distance).toBeCloseTo(0, 6);
  });

  it('零長線段：即使點擊位置與零長段完全重合，仍不命中（忽略點擊，呼應 brief 邊界規則）', () => {
    expect(findNearestOverlaySegment([zeroSeg], { x: 50, y: 50 }, 5)).toBeNull();
  });

  it('零長線段混在其他線段中：不會被選中，即使空間上它離點擊位置最近', () => {
    // zeroSeg(index1) 在 (50,50) 距離=0，lineSeg(index0) 距離遠超閾值 5 → 排除零長段後應為 null
    const result = findNearestOverlaySegment([lineSeg, zeroSeg], { x: 50, y: 50 }, 5);
    expect(result).toBeNull();
  });

  it('多線段：回傳距離最近的一段（非陣列順序優先）', () => {
    const far: Segment = { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }; // index 0，距 (5,4) 為 4
    const near: Segment = { kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5 }; // index 1，距 (5,4) 為 1
    const result = findNearestOverlaySegment([far, near], { x: 5, y: 4 }, 10);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
    expect(result!.distance).toBeCloseTo(1, 6);
  });

  it('空陣列 → null', () => {
    expect(findNearestOverlaySegment([], { x: 0, y: 0 }, 100)).toBeNull();
  });
});
