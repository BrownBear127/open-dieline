import { describe, expect, it } from 'vitest';
import { telescope } from '@/boxes/telescope';
import { resolveParams } from '@/core/registry';
import {
  buildTelescopeSceneSpec,
  createTelescopeWingAngleFn,
  TELESCOPE_TRAY_WINDOWS,
  telescopeRaiseYWallAngle,
  telescopeStaggeredWingAngles,
} from '@/fold/models/telescope';
import { foldPose } from '@/fold/schedule';

const deg = (value: number): number => (value * 180) / Math.PI;
const rad = (value: number): number => (value * Math.PI) / 180;

/** 錯階解的另一支（角撐往盒外折）——僅供不變式與包絡判準的 RED 佐證。 */
function outwardBranch(phi: number): { psiX: number; psiY: number } {
  const psiY = Math.asin(Math.min(1, Math.max(-1, Math.cos(phi) / (1 + Math.sin(phi)))));
  return { psiX: -Math.acos(Math.min(1, Math.max(-1, Math.cos(phi) - Math.sin(psiY) * Math.sin(phi)))), psiY };
}

describe('Telescope 錯階角撐 driver（Spec §4.4A）', () => {
  it('raiseX 段：x 翼維持共面、y 翼跟隨壁角', () => {
    for (const phiDeg of [0, 30, 60, 90]) {
      const { psiX, psiY } = telescopeStaggeredWingAngles('raiseX', rad(phiDeg));
      expect(psiX).toBe(0);
      expect(deg(psiY)).toBeCloseTo(phiDeg, 12);
    }
  });

  it.each([
    [0, 0, 90],
    [15, 39.8855422340557, 129.8855422340557],
    [45, 65.5301994792978, 155.5301994792978],
    [75, 82.43490572509836, 172.4349057250984],
    [90, 90, 180],
  ])('raiseY 盒內支逐點：φy=%d° → ψx=%f° / ψy=%f°', (phiDeg, psiXDeg, psiYDeg) => {
    const { psiX, psiY } = telescopeStaggeredWingAngles('raiseY', rad(phiDeg));
    expect(deg(psiX)).toBeCloseTo(psiXDeg, 4);
    expect(deg(psiY)).toBeCloseTo(psiYDeg, 4);
  });

  // 形式自洽檢查（**非**分支判準——見下一則：兩支皆滿足此恆等式）。
  it('ψy − ψx ≡ 90° 為閉式的全域恆等式', () => {
    for (let phiDeg = 0; phiDeg <= 90; phiDeg += 0.5) {
      const { psiX, psiY } = telescopeStaggeredWingAngles('raiseY', rad(phiDeg));
      expect(deg(psiY - psiX)).toBeCloseTo(90, 10);
    }
  });

  // 盒外支＝ψx' = −ψx、ψy' = 90° − ψx ⇒ ψy' − ψx' ≡ 90° 亦成立。
  // 故該恆等式**不具分支判別性**；判別靠 sign(ψx)（與終態包絡閘門並列）。
  it('恆等式對盒外支同樣成立＝它不是分支判準', () => {
    for (const phiDeg of [0, 15, 45, 75, 90]) {
      const { psiX, psiY } = outwardBranch(rad(phiDeg));
      expect(deg(psiY - psiX)).toBeCloseTo(90, 10);
    }
  });

  it('sign(ψx) 才是分支判準：盒內支 ψx ≥ 0、盒外支 ψx ≤ 0（僅分岔點重合）', () => {
    expect(telescopeStaggeredWingAngles('raiseY', 0).psiX).toBe(0);
    expect(outwardBranch(0).psiX).toBeCloseTo(0, 12);
    for (const phiDeg of [1, 15, 45, 75, 90]) {
      expect(telescopeStaggeredWingAngles('raiseY', rad(phiDeg)).psiX).toBeGreaterThan(0);
      expect(outwardBranch(rad(phiDeg)).psiX).toBeLessThan(0);
    }
  });

  // ψx = arccos(cos φy/(1+sin φy))；小角極限 cos φ/(1+sin φ) ≈ 1 − φ ⇒
  // ψx ≈ √(2φ)。⇒ raiseY 起點 dψx/dφy → ∞（分岔點的平方根奇點）。
  // 後果：φy 若對拍內進度線性排程，ψx 在拍首角速度無界＝撞 G3 閘門。
  // 緩解＝raiseY 拍的 φy 排程取 u²（則 ψx ∝ u·線性），plan 落實。
  it('ψx 在 raiseY 起點呈平方根律（G3 排程義務的依據）', () => {
    for (const phiDeg of [1e-4, 1e-2, 0.1, 1]) {
      const { psiX } = telescopeStaggeredWingAngles('raiseY', rad(phiDeg));
      expect(deg(psiX) / Math.sqrt(phiDeg)).toBeCloseTo(10.705, 1);
    }
  });

  it('兩式版與最簡式逐點相等（cos φy/(1+sin φy) 全域無 0/0）', () => {
    for (let phiDeg = 0; phiDeg <= 90; phiDeg += 1) {
      const phi = rad(phiDeg);
      const { psiX, psiY } = telescopeStaggeredWingAngles('raiseY', phi);
      const sinPsiY = Math.cos(phi) / (1 + Math.sin(phi));
      expect(Number.isFinite(sinPsiY)).toBe(true);
      expect(Math.sin(psiY)).toBeCloseTo(sinPsiY, 12);
      expect(Math.cos(psiX)).toBeCloseTo(Math.cos(phi) - sinPsiY * Math.sin(phi), 12);
    }
  });

  it('單一 wing driver 覆蓋 raiseX → hold → raiseY，兩交界連續', () => {
    const { raiseX, raiseY } = TELESCOPE_TRAY_WINDOWS.flapped;
    const span = raiseY[1] - raiseX[0];
    const raiseXEnd = (raiseX[1] - raiseX[0]) / span;
    const raiseYStart = (raiseY[0] - raiseX[0]) / span;
    const wingX = createTelescopeWingAngleFn('X', raiseXEnd, raiseYStart);
    const wingY = createTelescopeWingAngleFn('Y', raiseXEnd, raiseYStart);

    // raiseX 終點＝hold 起點
    expect(deg(wingX(raiseXEnd - 1e-9))).toBeCloseTo(0, 6);
    expect(deg(wingX(raiseXEnd + 1e-9))).toBeCloseTo(0, 6);
    expect(deg(wingY(raiseXEnd - 1e-9))).toBeCloseTo(90, 6);
    expect(deg(wingY(raiseXEnd + 1e-9))).toBeCloseTo(90, 6);
    // hold 終點＝raiseY 起點。⚠ 右極限容差需容納平方根奇點：
    // hold 終點＝raiseY 起點。φy = 90°·u² 讓拍首導數為零，平方根奇點被抵銷
    // （φy ≈ 1.3e-15° → ψx ≈ 3.9e-7°）；**容差刻意收到 6 位**——線性排程會在
    // 此處給出 0.0021°，本斷言即是排程回退的判別條件。
    expect(deg(wingX(raiseYStart - 1e-9))).toBeCloseTo(0, 6);
    expect(deg(wingX(raiseYStart + 1e-9))).toBeCloseTo(0, 6);
    expect(deg(wingY(raiseYStart - 1e-9))).toBeCloseTo(90, 6);
    expect(deg(wingY(raiseYStart + 1e-9))).toBeCloseTo(90, 6);
    // 終態＝角撐貼上短邊壁
    expect(deg(wingX(1))).toBeCloseTo(90, 10);
    expect(deg(wingY(1))).toBeCloseTo(180, 10);
  });

  it('hold 段全程恆定（角翼互卡與 y 內壁反摺期間角撐不動）', () => {
    const { raiseX, raiseY } = TELESCOPE_TRAY_WINDOWS.flapped;
    const span = raiseY[1] - raiseX[0];
    const raiseXEnd = (raiseX[1] - raiseX[0]) / span;
    const raiseYStart = (raiseY[0] - raiseX[0]) / span;
    const wingX = createTelescopeWingAngleFn('X', raiseXEnd, raiseYStart);
    const wingY = createTelescopeWingAngleFn('Y', raiseXEnd, raiseYStart);
    for (let i = 0; i <= 20; i += 1) {
      const u = raiseXEnd + ((raiseYStart - raiseXEnd) * i) / 20;
      expect(deg(wingX(u))).toBeCloseTo(0, 12);
      expect(deg(wingY(u))).toBeCloseTo(90, 12);
    }
  });

  it('段界順序非法時 fail-loud', () => {
    expect(() => createTelescopeWingAngleFn('X', 0, 0.5)).toThrow();
    expect(() => createTelescopeWingAngleFn('X', 0.6, 0.5)).toThrow();
    expect(() => createTelescopeWingAngleFn('X', 0.3, 1)).toThrow();
  });
});

describe('raiseY 排程與平方根奇點（Spec §4.4A v15.1）', () => {
  it('端點與拍首零導數', () => {
    expect(telescopeRaiseYWallAngle(0)).toBe(0);
    expect(deg(telescopeRaiseYWallAngle(1))).toBeCloseTo(90, 12);
    // 拍首導數：φy(h)/h → 0（線性排程此值恆為 90°）。
    for (const h of [1e-3, 1e-4, 1e-5]) {
      expect(deg(telescopeRaiseYWallAngle(h)) / h).toBeLessThan(0.1);
    }
    expect(telescopeRaiseYWallAngle(-1)).toBe(0);
    expect(deg(telescopeRaiseYWallAngle(2))).toBeCloseTo(90, 12);
  });

  it('拍首角撐角速度有界——線性排程在同一口徑下必超 G3 cap', () => {
    const { raiseY } = TELESCOPE_TRAY_WINDOWS.plain;
    const beat = raiseY[1] - raiseY[0];
    const dt = 0.0025; // G3 的 400 取樣口徑
    const du = dt / beat;
    const psiAt = (phi: number): number =>
      deg(telescopeStaggeredWingAngles('raiseY', phi).psiX);

    // 現行排程：拍首第一個取樣步的角撐位移。
    const scheduled = psiAt(telescopeRaiseYWallAngle(du)) / (dt / 0.01);
    expect(scheduled).toBeLessThan(22.5);
    expect(scheduled).toBeCloseTo(5.077499, 4);

    // 反事實：φy 線性排程 → 同一步位移超 cap（本條即 G3 先驗 RED 的可執行化）。
    const linear = psiAt(rad(90) * du) / (dt / 0.01);
    expect(linear).toBeGreaterThan(22.5);
    expect(linear).toBeCloseTo(45.269352, 4);
  });

  it('角撐角度是 y 壁「實際」二面角的函數——壁與角撐排程不得脫鉤', () => {
    const params = resolveParams(telescope, {});
    for (const piece of buildTelescopeSceneSpec(params).pieces) {
      if (piece.pieceId === 'liner') continue;
      const model = piece.buildModel(params);
      const windows = model.panels.some(({ id }) => id.startsWith('flap'))
        ? TELESCOPE_TRAY_WINDOWS.flapped
        : TELESCOPE_TRAY_WINDOWS.plain;
      for (let i = 0; i <= 20; i += 1) {
        const t = windows.raiseY[0]
          + ((windows.raiseY[1] - windows.raiseY[0]) * i) / 20;
        const pose = foldPose(t, model);
        // 壁的角度由 pose 直讀（消費端實際看到的值），不重算排程。
        const phiY = pose.get('wallYNeg-outer')!;
        const expected = telescopeStaggeredWingAngles('raiseY', phiY);
        expect(deg(pose.get('wingXNegNeg')!)).toBeCloseTo(deg(expected.psiX), 9);
        expect(deg(pose.get('wingYNegNeg')!)).toBeCloseTo(deg(expected.psiY), 9);
      }
    }
  });
});
