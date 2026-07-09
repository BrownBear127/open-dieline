import { describe, it, expect } from 'vitest';
import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { OverlayParseResult } from '@/overlay/parse';
import { initialScaleGuess } from '@/overlay/state';
import {
  GENERATED_LAYER_LABEL,
  GENERATED_LAYER_ORDER,
  createOverlayLayer,
  initialLayersState,
  layerKeyForLineType,
  removeOverlayLayer,
  updateOverlayLayer,
} from '@/overlay/layers';
import type { OverlayLayer } from '@/overlay/layers';

describe('layerKeyForLineType', () => {
  it('cut/crease/halfcut 直接對號入座', () => {
    expect(layerKeyForLineType('cut')).toBe('cut');
    expect(layerKeyForLineType('crease')).toBe('crease');
    expect(layerKeyForLineType('halfcut')).toBe('halfcut');
  });

  it('dimension/annotation（DIMENSION_LINE_TYPES）都歸 dimensions', () => {
    expect(layerKeyForLineType('dimension')).toBe('dimensions');
    expect(layerKeyForLineType('annotation')).toBe('dimensions');
  });

  it('bleed 也歸 dimensions（v1 無盒型產生 bleed path，此分支理論不可達，僅測 exhaustive mapping 行為）', () => {
    expect(layerKeyForLineType('bleed')).toBe('dimensions');
  });
});

describe('GENERATED_LAYER_ORDER / GENERATED_LAYER_LABEL', () => {
  it('四個生成圖層桶固定順序與中文標籤（T2/T3/T4 逐字消費的契約，鎖字面值防打字錯誤迴歸）', () => {
    expect(GENERATED_LAYER_ORDER).toEqual(['cut', 'crease', 'halfcut', 'dimensions']);
    expect(GENERATED_LAYER_LABEL).toEqual({ cut: '切割線', crease: '摺線', halfcut: '半刀', dimensions: '尺寸標註' });
  });
});

describe('initialLayersState', () => {
  it('generatedVisible 四鍵全 true、overlays 空、selectedOverlayId null', () => {
    const state = initialLayersState();
    expect(state.generatedVisible).toEqual({ cut: true, crease: true, halfcut: true, dimensions: true });
    expect(state.overlays).toEqual([]);
    expect(state.selectedOverlayId).toBeNull();
  });
});

describe('createOverlayLayer', () => {
  const segments: Segment[] = [
    { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
    { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
  ];
  const parsed: OverlayParseResult = {
    segments,
    warnings: ['測試警告'],
    sourceInfo: { widthAttr: null, viewBox: null },
  };
  const targetBounds: Bounds = { minX: 100, maxX: 200, minY: 50, maxY: 150 };

  it('scale 用 initialScaleGuess、offset 用 alignOffset center 手算值、opacity 0.5、visible true、calibrated false、segments 引用相等（不預變換）', () => {
    const layer = createOverlayLayer(parsed, 'foo.svg', 'mm', targetBounds, 'overlay-1');

    expect(layer.scale).toBe(initialScaleGuess(parsed.sourceInfo, 'mm')); // = 1（mm、無 width 字尾）
    // rawBounds = segmentsBounds(segments) = {minX:0,maxX:10,minY:0,maxY:20}；scale=1
    // rawCenter = ((0+10)/2,(0+20)/2)*1 = (5,10)；targetCenter = ((100+200)/2,(50+150)/2) = (150,100)
    // → offset = targetCenter - rawCenter = (145, 90)（手算值，獨立於呼叫 alignOffset 本身核對）
    expect(layer.offsetX).toBe(145);
    expect(layer.offsetY).toBe(90);
    expect(layer.id).toBe('overlay-1');
    expect(layer.name).toBe('foo');
    expect(layer.segments).toBe(segments); // 引用相等，不預變換
    expect(layer.warnings).toEqual(['測試警告']);
    expect(layer.opacity).toBe(0.5);
    expect(layer.visible).toBe(true);
    expect(layer.calibrated).toBe(false);
    expect(layer.rawBounds).toEqual(segmentsBounds(segments));
  });

  it('name 去 .svg 副檔名：大小寫不拘、只去尾端一次（"my.svg.backup.svg"→"my.svg.backup"）、無副檔名時原樣保留', () => {
    expect(createOverlayLayer(parsed, 'BAR.SVG', 'mm', targetBounds, 'overlay-2').name).toBe('BAR');
    expect(createOverlayLayer(parsed, 'my.svg.backup.svg', 'mm', targetBounds, 'overlay-3').name).toBe('my.svg.backup');
    expect(createOverlayLayer(parsed, 'baz', 'mm', targetBounds, 'overlay-4').name).toBe('baz');
  });
});

function makeLayer(id: string): OverlayLayer {
  return {
    id,
    name: id,
    segments: [],
    warnings: [],
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    opacity: 0.5,
    visible: true,
    calibrated: false,
    rawBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  };
}

describe('updateOverlayLayer', () => {
  it('patch 命中 id 的那一筆 offsetX → 回傳新陣列，該筆是新物件，其他筆維持原引用，原陣列不 mutate', () => {
    const layerA = makeLayer('a');
    const layerB = makeLayer('b');
    const layers = [layerA, layerB];

    const result = updateOverlayLayer(layers, 'a', { offsetX: 999 });

    expect(result).not.toBe(layers); // 新陣列
    expect(result[0]).not.toBe(layerA); // 命中的那筆是新物件
    expect(result[0]!.offsetX).toBe(999);
    expect(result[1]).toBe(layerB); // 未命中的那筆維持原引用
    expect(layers[0]).toBe(layerA); // 原陣列的元素沒被換掉
    expect(layerA.offsetX).toBe(0); // 原物件沒被 mutate
  });

  it('id 不存在 → 回傳新陣列，內容每筆仍是原引用', () => {
    const layerA = makeLayer('a');
    const layers = [layerA];
    const result = updateOverlayLayer(layers, 'nonexistent', { offsetX: 1 });
    expect(result).not.toBe(layers);
    expect(result[0]).toBe(layerA);
  });
});

describe('removeOverlayLayer', () => {
  it('移除指定 id 後長度 -1，原陣列不 mutate', () => {
    const layerA = makeLayer('a');
    const layerB = makeLayer('b');
    const layers = [layerA, layerB];

    const result = removeOverlayLayer(layers, 'a');

    expect(result.length).toBe(1);
    expect(result[0]).toBe(layerB);
    expect(layers.length).toBe(2); // 原陣列不 mutate
    expect(layers).toEqual([layerA, layerB]);
  });

  it('id 不存在 → 回傳長度不變的新陣列，內容仍是原引用', () => {
    const layerA = makeLayer('a');
    const layers = [layerA];
    const result = removeOverlayLayer(layers, 'nonexistent');
    expect(result).not.toBe(layers);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(layerA);
  });
});
