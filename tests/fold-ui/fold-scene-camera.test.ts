import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { worldGeometry } from '@/fold/pose3d';
import { foldPose } from '@/fold/schedule';
import {
  cameraOrbitPosition,
  computeCameraFrame,
  shadowPlacement,
  type GeometryBounds,
} from '@/ui/fold-scene';

const params = resolveParams(reverseTuckEnd, {});
const model = buildRteFoldModel(params);
const L = params.L as number;
const W = params.W as number;
const D = params.D as number;
const thickness = params.thickness as number;

function boundsAt(t: number): GeometryBounds {
  const geometry = worldGeometry(model, foldPose(t, model));
  const bounds: GeometryBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };

  for (const vertices of geometry.values()) {
    for (const vertex of vertices) {
      bounds.minX = Math.min(bounds.minX, vertex.x);
      bounds.maxX = Math.max(bounds.maxX, vertex.x);
      bounds.minY = Math.min(bounds.minY, -vertex.y);
      bounds.maxY = Math.max(bounds.maxY, -vertex.y);
      bounds.minZ = Math.min(bounds.minZ, vertex.z);
      bounds.maxZ = Math.max(bounds.maxZ, vertex.z);
    }
  }

  return bounds;
}

function boundsDiagonal(bounds: GeometryBounds): number {
  return Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  );
}

describe('computeCameraFrame', () => {
  it('自轉軸心＝摺合完成的盒體中心（非攤平大紙中心·2026-07-17 法蘭 E2E 裁決）', () => {
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

describe('cameraOrbitPosition', () => {
  it('orbits around the frame target while preserving the fitted distance', () => {
    const target = { x: 10, y: -4, z: 3 };
    const distance = 120;
    const position = cameraOrbitPosition(target, distance, 35, 25);

    expect(Math.hypot(
      position.x - target.x,
      position.y - target.y,
      position.z - target.z,
    )).toBeCloseTo(distance, 10);
    expect(position.x).toBeGreaterThan(target.x);
    expect(position.y).toBeGreaterThan(target.y);
    expect(position.z).toBeGreaterThan(target.z);
  });
});

describe('shadowPlacement', () => {
  it('places the contact shadow below the folded box bottom by the diagonal offset', () => {
    const bounds = boundsAt(1);
    const diagonal = Math.max(boundsDiagonal(bounds), 1);
    const placement = shadowPlacement(bounds);

    expect(placement.center).toEqual({
      x: (bounds.minX + bounds.maxX) / 2,
      y: bounds.minY - diagonal * 0.003,
      z: (bounds.minZ + bounds.maxZ) / 2,
    });
  });

  it('derives its width and height from the x/z footprint rather than x/y', () => {
    const bounds = boundsAt(1);
    const diagonal = Math.max(boundsDiagonal(bounds), 1);
    const minSpan = diagonal * 0.35;
    const placement = shadowPlacement(bounds);
    const expectedZHeight = Math.max((bounds.maxZ - bounds.minZ) * 1.18, minSpan);
    const oldYHeight = Math.max((bounds.maxY - bounds.minY) * 1.18, minSpan);

    expect(placement.size.w).toBe(Math.max((bounds.maxX - bounds.minX) * 1.18, minSpan));
    expect(placement.size.h).toBe(expectedZHeight);
    expect(placement.size.h).not.toBe(oldYHeight);
  });

  it('keeps a valid minimum footprint for the flat pose', () => {
    const bounds = boundsAt(0);
    const minimumSpan = Math.max(boundsDiagonal(bounds), 1) * 0.35;

    expect(() => shadowPlacement(bounds)).not.toThrow();
    expect(shadowPlacement(bounds).size.w).toBeGreaterThanOrEqual(minimumSpan);
    expect(shadowPlacement(bounds).size.h).toBeGreaterThanOrEqual(minimumSpan);
  });
});
