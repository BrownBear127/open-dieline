// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import {
  artworkLayoutSignature,
  artworkLayoutSignatureFromLayout,
  deriveArtworkLayout,
  flatDielineUvFrame,
  hashArtworkLayoutSignature,
} from '@/ui/artwork-layout';

function defaultModel() {
  return buildRteFoldModel(resolveParams(reverseTuckEnd, {}));
}

describe('deriveArtworkLayout', () => {
  it('完整 dieline 原樣帶入 layout 且不與 FoldModel 共用可變陣列', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);

    expect(layout.dieline).toEqual(model.dieline);
    expect(layout.dieline).not.toBe(model.dieline);
    expect(layout.dieline[0]!.segments).not.toBe(model.dieline[0]!.segments);
    expect(layout.dieline[0]!.segments[0]).not.toBe(model.dieline[0]!.segments[0]);
  });

  it('涵蓋 FoldModel 全部 panel id，與 builder 輸出集合一致', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);

    expect(layout.panels.map(({ id }) => id).sort())
      .toEqual(model.panels.map(({ id }) => id).sort());
  });

  it('每個 panel 的 polygon 與補償後真刀模在 t=0 的攤平幾何逐點相同', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);
    const flatGeometry = worldGeometry(model, foldPose(0, model));

    for (const panel of layout.panels) {
      const expected = flatGeometry.get(panel.id)!.map(({ x, y }) => ({ x, y }));
      expect(panel.polygon).toEqual(expected);
    }
  });

  it('seams 只帶出 FoldModel 的 flat points，不夾帶 owner 或來源 metadata', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);

    expect(layout.seams).toEqual((model.seams ?? []).map(({ points }) => ({ points })));
    expect(layout.seams).not.toBe(model.seams);
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

  it('square UV frame 與 flatDielineUvFrame 對同一份真刀模攤平幾何算出的結果相同', () => {
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

describe('artworkLayoutSignature', () => {
  it('紙厚改變補償後真實攤平版面時產生不同 signature', () => {
    const values = resolveParams(reverseTuckEnd, {});
    const changedThickness = { ...values, thickness: (values.thickness as number) + 0.1 };

    expect(artworkLayoutSignature(buildRteFoldModel(changedThickness)))
      .not.toBe(artworkLayoutSignature(buildRteFoldModel(values)));
  });

  it('L 改變面板 polygon 與 frame 時產生不同 signature（F6：必須 stale）', () => {
    const values = resolveParams(reverseTuckEnd, {});
    const changedLength = { ...values, L: (values.L as number) + 10 };

    expect(artworkLayoutSignature(buildRteFoldModel(changedLength)))
      .not.toBe(artworkLayoutSignature(buildRteFoldModel(values)));
  });
});

describe('artworkLayoutSignatureFromLayout', () => {
  it('對「已算好的 layout」與對其來源 model 呼叫 artworkLayoutSignature 產生逐字相同的字串（單一真相源，非各自複製一份公式）', () => {
    const model = defaultModel();
    const layout = deriveArtworkLayout(model);

    expect(artworkLayoutSignatureFromLayout(layout)).toBe(artworkLayoutSignature(model));
  });
});

describe('hashArtworkLayoutSignature', () => {
  it('對同一個簽章字串恆算出同一個 hash（deterministic）', () => {
    const signature = artworkLayoutSignature(defaultModel());

    expect(hashArtworkLayoutSignature(signature)).toBe(hashArtworkLayoutSignature(signature));
  });

  it('對不同簽章字串（L 改變）算出不同 hash', () => {
    const values = resolveParams(reverseTuckEnd, {});
    const changedLength = { ...values, L: (values.L as number) + 10 };
    const signatureA = artworkLayoutSignature(buildRteFoldModel(values));
    const signatureB = artworkLayoutSignature(buildRteFoldModel(changedLength));

    expect(hashArtworkLayoutSignature(signatureA)).not.toBe(hashArtworkLayoutSignature(signatureB));
  });

  it('回傳固定長度、純 hex 字元的字串（供 SVG data 屬性嵌入，不含需要跳脫的字元）', () => {
    const hash = hashArtworkLayoutSignature(artworkLayoutSignature(defaultModel()));

    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash.length).toBeGreaterThan(0);
  });

  // 單一 32-bit FNV-1a 碰撞機率過高（漏 stale
  // 警示，方向良性但仍值得收斂）。改雙獨立 32-bit FNV 變體拼接＝64-bit 指紋
  // （仍同步、零依賴）——16 hex 字元＝兩個 8-hex 區段串接，非同一次計算重複輸出。
  it('回傳 16 個 hex 字元（雙 32-bit FNV 變體拼接的 64-bit 指紋，非單一 32-bit 值）', () => {
    const hash = hashArtworkLayoutSignature(artworkLayoutSignature(defaultModel()));

    expect(hash).toHaveLength(16);
  });

  it('前後兩個 8-hex 區段不相同（兩個變體確實獨立運算，非把同一顆 32-bit hash 複製兩次）', () => {
    const hash = hashArtworkLayoutSignature(artworkLayoutSignature(defaultModel()));

    expect(hash.slice(0, 8)).not.toBe(hash.slice(8, 16));
  });

  it('對調字元順序（構造一對「同 multiset、不同順序」的字串）会产生不同 hash——非純字元計數雜湊', () => {
    // 若兩變體都只對字元計數/異或無序累加，順序調換會被抵消而撞出同 hash；
    // 前向＋反向兩趟遍歷對「順序」敏感，能分辨 'ab' 與 'ba' 這種簡單重排。
    expect(hashArtworkLayoutSignature('ab')).not.toBe(hashArtworkLayoutSignature('ba'));
  });
});
