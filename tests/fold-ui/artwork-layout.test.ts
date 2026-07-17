import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import { deriveArtworkLayout, flatDielineUvFrame } from '@/ui/artwork-layout';

function defaultModel() {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
}

describe('deriveArtworkLayout', () => {
  it('涵蓋 FoldModel 全部 panel id，與 builder 輸出集合一致', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);

    expect(layout.panels.map(({ id }) => id).sort())
      .toEqual(model.panels.map(({ id }) => id).sort());
  });

  it('每個 panel 的 polygon 與 worldGeometry(model, foldPose(0)) 名義攤平幾何逐點相同（F1.0 唯一真相源）', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);
    const flatGeometry = worldGeometry(model, foldPose(0, model));

    for (const panel of layout.panels) {
      const expected = flatGeometry.get(panel.id)!.map(({ x, y }) => ({ x, y }));
      expect(panel.polygon).toEqual(expected);
    }
  });

  it('root 面板（P1）沒有 hinge；其餘 non-root 面板 hinge 與 FoldModel 原始 hingeLine 逐值相同', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);
    const byId = new Map(layout.panels.map((panel) => [panel.id, panel]));

    expect(byId.get('P1')!.hinge).toBeUndefined();
    for (const panel of model.panels) {
      if (panel.parent === null) continue;
      expect(byId.get(panel.id)!.hinge).toEqual(panel.hingeLine);
    }
  });

  it('square UV frame 與既有 flatDielineUvFrame(flatGeometry) 對同一份名義幾何算出的結果相同', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);
    const flatGeometry = worldGeometry(model, foldPose(0, model));

    expect(layout.frame).toEqual(flatDielineUvFrame(flatGeometry));
  });

  it('square UV frame 以最長軸為 span，並把全部 panel 角點包在 [0,1] UV 內', () => {
    const layout = deriveArtworkLayout(defaultModel());
    const points = layout.panels.flatMap(({ polygon }) => polygon);
    const xs = points.map(({ x }) => x);
    const ys = points.map(({ y }) => y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    expect(layout.frame.span).toBeCloseTo(Math.max(width, height), 10);
    for (const point of points) {
      const u = (point.x - layout.frame.minX + layout.frame.offsetX) / layout.frame.span;
      const v = 1 - (point.y - layout.frame.minY + layout.frame.offsetY) / layout.frame.span;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('tuckLock=0（單片 lid）／tuckDepth=0（無插舌）／兩者皆零 三種變體不拋錯，面板數與 builder 輸出一致', () => {
    for (const overrides of [{ tuckLock: 0 }, { tuckDepth: 0 }, { tuckDepth: 0, dustFlapDepth: 0 }]) {
      const model = buildRteFoldModel(resolveParams(reverseTuckEnd, overrides));
      const layout = deriveArtworkLayout(model);
      expect(layout.panels).toHaveLength(model.panels.length);
    }
  });
});

describe('flatDielineUvFrame — fold-scene re-export 為同一顆函式（F1.0 單一真相源，非各自複製一份公式）', () => {
  it('@/ui/fold-scene 匯出的 flatDielineUvFrame 與 @/ui/artwork-layout 是同一個 function reference', async () => {
    const foldScene = await import('@/ui/fold-scene');
    expect(foldScene.flatDielineUvFrame).toBe(flatDielineUvFrame);
  });
});
