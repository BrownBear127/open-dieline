// normalized 慣例層：拓撲計數、索引、進度與容差依測試契約固定。
// 觀測慣例層：座標、距離與面積 golden 取自 2D generate() 實際輸出或其補償後幾何。
import { describe, expect, it } from 'vitest';
import { triangularTube } from '@/boxes/triangular-tube';
import { resolveParams } from '@/core/registry';
import { buildTtbFoldModel } from '@/fold/models/triangular-tube';
import { worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import { validateFoldModel } from '@/fold/validate';
import {
  dist,
  distToPlane,
  endMainAxisAngle,
  faceAPlane,
  freeEdgeEndpoints,
  maxVertexDistToFinitePanel,
  slotSegmentFrom2D,
  slotWidthOf,
  tabSignedDistancesToSlotLine,
  tabSlotCrossSection,
  wingCoverage,
} from '../helpers/ttb-fold';

/**
 * ttb-closure.test.ts — 整合驗收視角。
 *
 * 單一 describe/單一 it，跑 default 參數，一次驗證「盒子真的能摺起來」的四項閉合條件：
 *
 *   1. 側縫端點世界重合 ≤0.01mm（faceA/faceC 自由邊端點）。
 *   2. tab 整片越過 slot、離開 faceA，並保留 16mm 配對寬度差。
 *   3. 端封 endMain 垂直管軸（結構性 0）。
 *   4. wing golden（凍結值，同 default 案例）。
 *
 * sweep/矩陣驗證（TTB_LEGAL_COMBOS、板距/覆蓋率 matrix 下限等）留在 ttb-model.test.ts，
 * 本檔不重複。
 *
 * helper 全部從 `tests/helpers/ttb-fold.ts` 引入，供本檔＋`tests/fold/ttb-reconcile.test.ts`
 * ＋`ttb-model.test.ts` 三方共用同一份實作。
 */
const p = (o = {}) => resolveParams(triangularTube, o);

describe('ttb closure（整合驗收·default 參數）', () => {
  it('盒子真的能摺起來：側縫重合 + tab 跨 slot + 端封垂直管軸 + wing golden + validate 零 error', () => {
    const params = p();
    const m = buildTtbFoldModel(params);
    expect(validateFoldModel(m)).toEqual([]);
    const geo = worldGeometry(m, foldPose(1, m));

    // 1. 側縫端點世界重合（faceA 自由邊 vs faceC 自由邊，t=1 應完全貼合）。
    const seamA = freeEdgeEndpoints(geo, 'faceA');
    const seamC = freeEdgeEndpoints(geo, 'faceC');
    expect(dist(seamA[0], seamC[0])).toBeLessThan(0.01);
    expect(dist(seamA[1], seamC[1])).toBeLessThan(0.01);

    // 2. tab 已整片穿過 slot 進入盒內，且仍保留與 slot 的 16mm 配對寬度差。
    const slot = slotSegmentFrom2D(params);
    const sd = tabSignedDistancesToSlotLine(geo, slot);
    expect(sd.rootSide).toBeLessThan(0);
    expect(sd.tipSide).toBeLessThan(0);
    const cross = tabSlotCrossSection(geo, slot);
    expect(cross.tabFullWidth - slotWidthOf(params)).toBeCloseTo(16, 2);
    const facePlane = faceAPlane(geo);
    for (const vertex of geo.get('zoneDTab')!) {
      expect(distToPlane(vertex, facePlane)).toBeGreaterThan(1);
    }

    // 3. 端封 endMain 垂直管軸（H/Hb 是 endMain 自己 hinge 的軸上兩點，
    // 只受 faceB 累積變換影響，faceB hinge 軸沿全域 x）。
    for (const side of ['Start', 'End'] as const) {
      expect(endMainAxisAngle(geo, `end${side}Main`)).toBeLessThan((6 * Math.PI) / 180); // 端封垂直管軸 ±6°容差
    }

    // 4. wing golden（default 案例凍結值·±0.05/±0.005 容差）。
    // 觀測慣例層：G6 面外彎入（normalOffset）設計下的凍結值——WingBottom 為
    // edge-on panel，面內收束不成比例（外距 2.385mm 需 60mm 剪移·形狀剪歪），
    // 改沿法向彎入殼內：角落回貼 faceC ≈0.01、掃掠中段保持剛體形狀。
    // WingTop 面內收束不變（1.952）。
    for (const side of ['Start', 'End'] as const) {
      expect(maxVertexDistToFinitePanel(geo, `end${side}WingTop`, 'faceA')).toBeCloseTo(1.952, 1);
      expect(maxVertexDistToFinitePanel(geo, `end${side}WingBottom`, 'faceC')).toBeCloseTo(0.01, 1);
      expect(wingCoverage(geo, `end${side}WingTop`, 'faceA')).toBeCloseTo(1.0, 2);
      expect(wingCoverage(geo, `end${side}WingBottom`, 'faceC')).toBeCloseTo(1.0, 2);
    }
  });
});
