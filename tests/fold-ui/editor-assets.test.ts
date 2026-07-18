import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '@/ui/editor/editor-assets';

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

describe('AssetRegistry', () => {
  it('stores the native bitmap as an opaque handle with its intrinsic dimensions', () => {
    const registry = new AssetRegistry();
    const source = bitmap(640, 320);

    const id = registry.add(source);

    expect(id).toBe('asset-1');
    expect(registry.get(id)).toEqual({ bitmap: source, width: 640, height: 320 });
  });

  it('closes a bitmap exactly once after its final reference is released', () => {
    const registry = new AssetRegistry();
    const source = bitmap(20, 10);
    const id = registry.add(source);

    registry.retain(id);
    registry.release(id);
    expect(source.close).not.toHaveBeenCalled();

    registry.release(id);
    registry.release(id);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('allows the exact session pixel budget and rejects the next bitmap', () => {
    const registry = new AssetRegistry();
    const accepted = Array.from({ length: 4 }, () => bitmap(8192, 4096));
    const rejected = bitmap(1, 1);

    for (const source of accepted) registry.add(source);

    expect(() => registry.add(rejected)).toThrow(RangeError);
    expect(rejected.close).not.toHaveBeenCalled();
  });

  it('reclaims pixel budget when the final reference is released', () => {
    const registry = new AssetRegistry();
    const source = bitmap(8192, 4096);
    const id = registry.add(source);

    registry.release(id);

    expect(() => registry.add(bitmap(8192, 4096))).not.toThrow();
  });
});
