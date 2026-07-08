import { describe, it, expect } from 'vitest';
import type { Bounds, Segment } from '@/core/geometry';
import type { OverlayParseResult } from '@/overlay/parse';
import { OVERLAY_STROKE, alignOffset, createOverlayState, initialScaleGuess } from '@/overlay/state';

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

describe('createOverlayState', () => {
  it('由 parseOverlaySvg 輸出＋unit 建構初始狀態：segments/warnings 原樣帶入、scale 用 initialScaleGuess、offset 歸零、opacity 預設 0.5、visible 預設開、rawBounds 用 segmentsBounds', () => {
    const segments: Segment[] = [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 20 }];
    const parseResult: OverlayParseResult = {
      segments,
      warnings: ['測試警告'],
      sourceInfo: { widthAttr: null, viewBox: null },
    };
    const state = createOverlayState(parseResult, 'mm');
    expect(state.segments).toBe(segments); // 不複製、不預先套用 scale/offset
    expect(state.warnings).toEqual(['測試警告']);
    expect(state.scale).toBe(1); // unit='mm' 且無 width 字尾自動判定
    expect(state.offsetX).toBe(0);
    expect(state.offsetY).toBe(0);
    expect(state.opacity).toBe(0.5);
    expect(state.visible).toBe(true);
    expect(state.rawBounds).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 20 });
  });

  it('空 segments：rawBounds 回退 segmentsBounds 的空陣列慣例 {0,0,0,0}', () => {
    const parseResult: OverlayParseResult = { segments: [], warnings: [], sourceInfo: { widthAttr: null, viewBox: null } };
    const state = createOverlayState(parseResult, 'pt');
    expect(state.rawBounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });
});

describe('OVERLAY_STROKE', () => {
  it('固定為 spec 規格值（洋紅），供 Canvas 疊繪與測試共用同一來源', () => {
    expect(OVERLAY_STROKE).toBe('#FF00FF');
  });
});
