import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { computeCameraFrame } from '@/ui/fold-scene';

const params = resolveParams(reverseTuckEnd, {});
const model = buildRteFoldModel(params);
const L = params.L as number;
const W = params.W as number;
const D = params.D as number;
const thickness = params.thickness as number;

describe('computeCameraFrame', () => {
  it('自轉軸心＝摺合完成的盒體中心（非攤平大紙中心·2026-07-17 E2E 驗收裁決）', () => {
    // 舊行為的 bug：fitCamera 只在 replaceModel 時以「當下 pose」的外廓定 target，
    // scene 初始 t=0（攤平）→ 軸心落在大紙中心，盒子摺好後自轉變成繞行。
    const frame = computeCameraFrame(model);
    expect(frame).not.toBeNull();

    const tolerance = Math.max(2 * thickness, 1);
    expect(Math.abs(frame!.target.x - L / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(frame!.target.y - -D / 2)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(frame!.target.z - W / 2)).toBeLessThanOrEqual(tolerance);
  });

  it('取景對角線涵蓋攤平全紙、聚焦對角線貼近盒體（近縮放不被大紙鎖死）', () => {
    const frame = computeCameraFrame(model)!;

    // 攤平外廓直接由 2D 多邊形計算（t=0 世界幾何＝多邊形原位·y 取負·z=0），
    // 與實作的 worldGeometry 路徑獨立。
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const panel of model.panels) {
      for (const { x, y } of panel.polygon) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, -y);
        maxY = Math.max(maxY, -y);
      }
    }
    const flatDiagonal = Math.hypot(maxX - minX, maxY - minY);
    const boxDiagonal = Math.hypot(L, W, D);

    expect(frame.fitDiagonal).toBeGreaterThanOrEqual(flatDiagonal);
    expect(Math.abs(frame.focusDiagonal - boxDiagonal)).toBeLessThanOrEqual(Math.max(4 * thickness, 5));
    expect(frame.focusDiagonal).toBeLessThanOrEqual(frame.fitDiagonal);
  });
});
