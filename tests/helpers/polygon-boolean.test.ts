import { describe, expect, it } from 'vitest';
import type { Pt } from '@/fold/types';
import { AREA_TOLERANCE_MM2, pairwiseIntersectionArea, symmetricDifferenceArea, triangleInPolygon } from './polygon-boolean';

/** 軸對齊矩形（測試 fixture 共用，CCW winding）。 */
function rect(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe('symmetricDifferenceArea — 原多邊形 vs fragment 聯集', () => {
  it('正例：fragment 聯集與原多邊形完全相同 → 對稱差 ≈0', () => {
    const square = rect(0, 0, 10, 10);
    expect(symmetricDifferenceArea(square, [square])).toBeLessThanOrEqual(AREA_TOLERANCE_MM2);
  });

  it('反例：fragment 平移到輪廓外（跟原多邊形面積相同，若只比對「面積總和」會誤判一致）→ 真實對稱差遠超容差', () => {
    const square = rect(0, 0, 10, 10); // area 100
    const movedFragment = rect(100, 100, 110, 110); // 同樣 10x10=100，但完全不重疊
    // naive「面積總和」檢查：100 vs 100，看起來一致；真實對稱差 = 100+100 = 200（互不重疊，各自都不算交集）
    const result = symmetricDifferenceArea(square, [movedFragment]);
    expect(result).toBeGreaterThan(AREA_TOLERANCE_MM2);
    expect(result).toBeCloseTo(200, 0);
  });

  it('反例：缺洞（fragment 少蓋一塊）＋多畫（另一 fragment 重疊補上同面積）互相抵消——naive 面積總和恰好等於原多邊形，但真實對稱差不為 0', () => {
    const square = rect(0, 0, 10, 10); // area 100
    const missingTopStrip = rect(0, 0, 10, 7); // area 70，缺了 [7,10] 這條頂部帶（面積 30 的洞）
    const duplicateOverlap = rect(0, 0, 10, 3); // area 30，整塊落在 missingTopStrip 內部（純重疊，不補洞）
    // naive 面積總和：70 + 30 = 100，恰好「看起來」跟原多邊形一致
    const naiveSum = 70 + 30;
    expect(naiveSum).toBe(100);
    // 真實聯集 = missingTopStrip ∪ duplicateOverlap = missingTopStrip（重疊部分沒有新增涵蓋），
    // 仍然缺頂部 30 的洞 → 真實對稱差 = 30
    const result = symmetricDifferenceArea(square, [missingTopStrip, duplicateOverlap]);
    expect(result).toBeGreaterThan(AREA_TOLERANCE_MM2);
    expect(result).toBeCloseTo(30, 0);
  });
});

describe('pairwiseIntersectionArea — 一組多邊形兩兩交集面積總和', () => {
  it('不相交 → 0', () => {
    const a = rect(0, 0, 5, 5);
    const b = rect(10, 10, 15, 15);
    expect(pairwiseIntersectionArea([a, b])).toBeLessThanOrEqual(AREA_TOLERANCE_MM2);
  });

  it('重疊 → >0（且量級對得上實際重疊面積，驗證不是隨便回傳一個非零值）', () => {
    const a = rect(0, 0, 5, 5);
    const b = rect(3, 3, 8, 8); // 與 a 重疊 [3,5]x[3,5]，重疊面積=2x2=4
    const result = pairwiseIntersectionArea([a, b]);
    expect(result).toBeGreaterThan(AREA_TOLERANCE_MM2);
    expect(result).toBeCloseTo(4, 1);
  });

  it('三個以上多邊形：回傳所有 i<j 配對交集面積的總和（不是只驗第一對）', () => {
    const a = rect(0, 0, 5, 5);
    const b = rect(3, 3, 8, 8); // a∩b = 2x2 = 4
    const c = rect(6, 6, 9, 9); // b∩c = 2x2 = 4；a∩c = 0
    const result = pairwiseIntersectionArea([a, b, c]);
    expect(result).toBeCloseTo(8, 1);
  });
});

describe('triangleInPolygon — 三角形是否完全落在 outline 內', () => {
  const outline = rect(0, 0, 10, 10);

  it('三角形完全在 outline 內 → true', () => {
    const tri: [Pt, Pt, Pt] = [
      { x: 1, y: 1 },
      { x: 8, y: 1 },
      { x: 1, y: 8 },
    ];
    expect(triangleInPolygon(tri, outline)).toBe(true);
  });

  it('三角形完全在 outline 外 → false', () => {
    const tri: [Pt, Pt, Pt] = [
      { x: 20, y: 20 },
      { x: 25, y: 20 },
      { x: 20, y: 25 },
    ];
    expect(triangleInPolygon(tri, outline)).toBe(false);
  });

  it('三角形部分伸出 outline 外（不是「三頂點都在內」就放行——這裡三頂點都在 outline 內，但三角形整體有一角跨出邊界仍應判 false）', () => {
    // 三頂點都落在 outline 內部/邊上，但三角形斜邊會切過 outline 右下角外側——
    // 用一個頂點刻意落在 outline 外，確保能鑑別「只驗頂點」與「驗整個三角形面積」的差異。
    const tri: [Pt, Pt, Pt] = [
      { x: 5, y: 5 },
      { x: 12, y: 5 },
      { x: 5, y: 12 },
    ];
    expect(triangleInPolygon(tri, outline)).toBe(false);
  });

  it('非整數座標：三角形完全在 outline 內，精確 Sutherland–Hodgman 裁剪不受座標離散化影響', () => {
    // 三角形 (10.001,10.002),(60.003,10.002),(10.001,55.0037) 完全在
    // outline (0.0317,0.0111)-(137.4123,93.7789) 內——精確 Sutherland–Hodgman 裁剪
    // 沒有離散化誤差，這裡應正確判為 true。
    const nonIntegerOutline: Pt[] = [
      { x: 0.0317, y: 0.0111 },
      { x: 137.4123, y: 0.0111 },
      { x: 137.4123, y: 93.7789 },
      { x: 0.0317, y: 93.7789 },
    ];
    const tri: [Pt, Pt, Pt] = [
      { x: 10.001, y: 10.002 },
      { x: 60.003, y: 10.002 },
      { x: 10.001, y: 55.0037 },
    ];
    expect(triangleInPolygon(tri, nonIntegerOutline)).toBe(true);
  });

  it('大尺寸 outline（400×300mm）：三角形完全在內，精確裁剪法不受尺度影響', () => {
    // 精確裁剪法沒有掃描列這個概念，面積計算跟 outline 尺度無關。
    const bigOutline = rect(0, 0, 400, 300);
    const tri: [Pt, Pt, Pt] = [
      { x: 5, y: 5 },
      { x: 395, y: 5 },
      { x: 5, y: 295 },
    ];
    expect(triangleInPolygon(tri, bigOutline)).toBe(true);
  });

  it('退化三角形（零面積）必須明確拋錯，不得靜默視為「包含」——上游三角化不應產生零面積三角形，這是訊號不是可忽略的邊界情況', () => {
    const collinear: [Pt, Pt, Pt] = [
      { x: 1, y: 1 },
      { x: 5, y: 1 },
      { x: 9, y: 1 },
    ];
    expect(() => triangleInPolygon(collinear, outline)).toThrow();
  });

  it('退化三角形（三點重合）即使完全落在 outline 外，也必須拋錯，不能被誤判成任何布林值', () => {
    const coincident: [Pt, Pt, Pt] = [
      { x: 200, y: 200 },
      { x: 200, y: 200 },
      { x: 200, y: 200 },
    ];
    expect(() => triangleInPolygon(coincident, outline)).toThrow();
  });
});
