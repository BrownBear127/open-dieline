import { describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { manufacturingBounds } from '@/core/bounds';
import { resolveParams } from '@/core/registry';

describe('manufacturingBounds', () => {
  it('RTE 預設參數從 core 入口取得 233.2×251 的製造 bounds', () => {
    const result = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const bounds = manufacturingBounds(result);

    expect(Math.abs(bounds.maxX - bounds.minX - 233.2)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(bounds.maxY - bounds.minY - 251)).toBeLessThanOrEqual(0.01);
  });

  it('天地盒單片製造 bounds 嚴格小於片 bounds，證明已排除標註外擴', () => {
    const result = telescope.generate(resolveParams(telescope));
    const piece = result.pieces![0]!;
    const bounds = manufacturingBounds(result, piece);

    expect(bounds.maxX - bounds.minX).toBeLessThan(piece.bounds.maxX - piece.bounds.minX);
    expect(bounds.maxY - bounds.minY).toBeLessThan(piece.bounds.maxY - piece.bounds.minY);
  });
});
