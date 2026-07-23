import { describe, expect, it } from 'vitest';
import {
  createTelescopeFlapAngleFn,
  createTelescopeWingAngleFn,
  telescopeExtensionAngle,
  telescopePsi,
} from '@/fold/models/telescope';

const deg = (value: number): number => (value * 180) / Math.PI;

describe('Telescope angle drivers', () => {
  it.each([
    [0, 0],
    [22.5, 51.302213877065554],
    [45, 90],
    [67.5, 116.40925966400458],
    [90, 135],
  ])('ψ 閉式逐點重現 spike 取樣：φ=%d° → ψ=%d°', (phiDeg, psiDeg) => {
    expect(deg(telescopePsi((phiDeg * Math.PI) / 180))).toBeCloseTo(psiDeg, 12);
  });

  it('翼以單一 driver 合併 A 閉式與 B 反向線性，交界連續', () => {
    const split = 0.35 / (0.35 + 0.17);
    const wingX = createTelescopeWingAngleFn('X', split);
    const wingY = createTelescopeWingAngleFn('Y', split);

    for (const driver of [wingX, wingY]) {
      expect(deg(driver(split - 1e-9))).toBeCloseTo(135, 6);
      expect(deg(driver(split))).toBeCloseTo(135, 12);
      expect(deg(driver(split + 1e-9))).toBeCloseTo(135, 6);
    }
    expect(deg(wingX(1))).toBeCloseTo(180, 12);
    expect(deg(wingY(1))).toBeCloseTo(90, 12);
  });

  it('角翼以單一 driver 完成 pretuck、hold 與 sx 分批 C，所有交界連續', () => {
    const xNeg = createTelescopeFlapAngleFn('Neg', {
      pretuckEnd: 0.08,
      phaseCStart: 0.82,
      phaseCMid: 0.91,
      phaseCEnd: 1,
    });
    const xPos = createTelescopeFlapAngleFn('Pos', {
      pretuckEnd: 0.08,
      phaseCStart: 0.82,
      phaseCMid: 0.91,
      phaseCEnd: 1,
    });

    expect(deg(xNeg(0))).toBe(0);
    expect(deg(xNeg(0.08))).toBeCloseTo(180, 12);
    expect(deg(xNeg(0.82))).toBeCloseTo(180, 12);
    expect(deg(xNeg(0.91))).toBeCloseTo(90, 12);
    expect(deg(xNeg(1))).toBeCloseTo(90, 12);

    expect(deg(xPos(0.82))).toBeCloseTo(180, 12);
    expect(deg(xPos(0.91))).toBeCloseTo(180, 12);
    expect(deg(xPos(1))).toBeCloseTo(90, 12);
  });

  it('gusset extension driver 全窗恆為 identity', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(telescopeExtensionAngle(t)).toBe(0);
    }
  });
});
