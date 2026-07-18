export const ASSET_REGISTRY_PIXEL_BUDGET = 134_217_728;

export interface AssetRecord {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface RegistryEntry extends AssetRecord {
  references: number;
  pixels: number;
}

/**
 * Owns native bitmap handles while editor state or history snapshots reference them.
 * A successful add transfers one reference to the registry; rejected handles remain
 * owned by the caller.
 */
export class AssetRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private nextId = 1;
  private pixels = 0;

  add(bitmap: ImageBitmap): string {
    const width = bitmap.width;
    const height = bitmap.height;
    const assetPixels = width * height;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || !Number.isSafeInteger(assetPixels)
    ) {
      throw new RangeError('Asset dimensions must be positive integers');
    }
    if (this.pixels + assetPixels > ASSET_REGISTRY_PIXEL_BUDGET) {
      throw new RangeError('Asset registry pixel budget exceeded');
    }

    const id = `asset-${this.nextId}`;
    this.nextId += 1;
    this.entries.set(id, {
      bitmap,
      width,
      height,
      references: 1,
      pixels: assetPixels,
    });
    this.pixels += assetPixels;
    return id;
  }

  get(id: string): AssetRecord {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown asset: ${id}`);
    return { bitmap: entry.bitmap, width: entry.width, height: entry.height };
  }

  retain(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown asset: ${id}`);
    entry.references += 1;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    entry.references -= 1;
    if (entry.references > 0) return;

    this.entries.delete(id);
    this.pixels -= entry.pixels;
    entry.bitmap.close();
  }
}
