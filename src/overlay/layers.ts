/**
 * 圖層資料模型（Slice 3 Task 1，spec §6 圖層系統）：生成 4 個固定圖層桶（cut/crease/halfcut/
 * dimensions）＋使用者可匯入多份 overlay 疊圖的圖層清單，純函式、UI 無關——本檔不 import
 * React 或任何 UI，圖層面板的畫面串接在 T2（`overlay/state.ts` 的 `OverlayState`/
 * `createOverlayState` 單一疊圖模型會被這裡的 `OverlayLayer`/`LayersState` 取代，見該檔
 * docblock 現況）。
 *
 * `initialScaleGuess`／`alignOffset`（`overlay/state.ts` 既有純函式）與 `segmentsBounds`
 * （`core/geometry.ts` 既有純函式）在這裡被 `createOverlayLayer` 消費、邏輯不重寫。
 * `layerKeyForLineType` 消費 `export/svg.ts` 的 `DIMENSION_LINE_TYPES`，避免「哪些線型算
 * 尺寸標註」在專案裡出現第三份定義（沿用該常數 docblock 的「過濾規則單一來源」精神）。
 */
import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { LineType } from '@/core/types';
import { DIMENSION_LINE_TYPES } from '@/export/svg';
import type { OverlayParseResult } from './parse';
import { alignOffset, initialScaleGuess } from './state';

/** 生成圖層的四個固定桶——畫布依線型分組後對應圖層面板的四個分區。 */
export type GeneratedLayerKey = 'cut' | 'crease' | 'halfcut' | 'dimensions';

/** 圖層面板的顯示順序；UI 遍歷用同一份陣列，不各自硬編字面量順序。 */
export const GENERATED_LAYER_ORDER: readonly GeneratedLayerKey[] = ['cut', 'crease', 'halfcut', 'dimensions'];

/** 圖層面板顯示用的中文標籤。 */
export const GENERATED_LAYER_LABEL: Readonly<Record<GeneratedLayerKey, string>> = {
  cut: '切割線',
  crease: '摺線',
  halfcut: '半刀',
  dimensions: '尺寸標註',
};

/**
 * LineType → 圖層桶。cut/crease/halfcut 對號；`DIMENSION_LINE_TYPES`（dimension/annotation）
 * → 'dimensions'；bleed → 'dimensions'（輔助線類；v1 無任何盒型產生 bleed path，這個分支
 * 不可達，僅為 exhaustive mapping——理由寫在這裡，不是靠測試斷言）。texts（DielineText）恆屬
 * 'dimensions'，v1 texts 全部來自 `dimensionLine` 標註（見 `export/svg.ts` 檔頭 docblock），
 * 呼叫端（T3/T4）不會拿 DielineText 呼叫這個函式，這裡不需要處理。
 */
export function layerKeyForLineType(t: LineType): GeneratedLayerKey {
  if (t === 'cut') return 'cut';
  if (t === 'crease') return 'crease';
  if (t === 'halfcut') return 'halfcut';
  if (DIMENSION_LINE_TYPES.has(t)) return 'dimensions'; // dimension／annotation
  return 'dimensions'; // 剩下只有 'bleed'
}

/** 單一使用者匯入的疊圖圖層（多層，取代 `overlay/state.ts` 的單一 `OverlayState`）。 */
export interface OverlayLayer {
  id: string;
  /** 來源檔名去 `.svg` 副檔名。 */
  name: string;
  /** parse 原始輸出，不預先套用 scale/offset——渲染時才套用，理由同 `OverlayState.segments`
   *  （見 `overlay/state.ts` docblock）。 */
  segments: Segment[];
  warnings: string[];
  scale: number;
  /** mm，套在 scale 之後。 */
  offsetX: number;
  offsetY: number;
  /** 0–1，預設 0.5。 */
  opacity: number;
  visible: boolean;
  /** 校準成功後標記為 true；目前無邏輯分支消費（單位覆蓋機制已於 gate round 1 退役）、保留
   *  供未來 UI 顯示已校準狀態。 */
  calibrated: boolean;
  /** `segmentsBounds(segments)`——未套 scale/offset 前的原始包絡。 */
  rawBounds: Bounds;
}

export interface LayersState {
  /** 四個生成圖層桶各自的顯示開關，預設全開。 */
  generatedVisible: Record<GeneratedLayerKey, boolean>;
  overlays: OverlayLayer[];
  /** 目前選中的 overlay 圖層 id——選中後才可拖曳/校準；null＝沒有選取。 */
  selectedOverlayId: string | null;
}

export function initialLayersState(): LayersState {
  return {
    generatedVisible: { cut: true, crease: true, halfcut: true, dimensions: true },
    overlays: [],
    selectedOverlayId: null,
  };
}

const DEFAULT_OVERLAY_OPACITY = 0.5;

/** 只去尾端的 `.svg` 副檔名（大小寫不拘）；沒有這個副檔名時原樣保留。 */
function stripSvgExtension(name: string): string {
  return name.replace(/\.svg$/i, '');
}

/**
 * 由 `parseOverlaySvg` 輸出＋檔名＋單位＋目前對齊目標建構一筆新的 `OverlayLayer`。
 *
 * 置中預設（gate 反饋①）：offset 用 `alignOffset(rawBounds, scale, targetBounds, 'center')`
 * ——多層情境下新增疊圖是常態操作，每次都先置中能立即看到疊圖疊在刀模上，比「offset 歸零」
 * （`overlay/state.ts` 舊版 `createOverlayState` 單層時的既有行為）更省一次手動對齊。
 *
 * `id` 由呼叫端（App.tsx，T2）遞增計數產生（如 `overlay-${n}`），不在這裡用 `Date.now()`
 * ——確定性，方便測試與重播疊圖清單。
 */
export function createOverlayLayer(
  parsed: OverlayParseResult,
  name: string,
  unit: 'pt' | 'mm' | 'px',
  targetBounds: Bounds,
  id: string,
): OverlayLayer {
  const scale = initialScaleGuess(parsed.sourceInfo, unit);
  const rawBounds = segmentsBounds(parsed.segments);
  const offset = alignOffset(rawBounds, scale, targetBounds, 'center');
  return {
    id,
    name: stripSvgExtension(name),
    segments: parsed.segments,
    warnings: parsed.warnings,
    scale,
    offsetX: offset.offsetX,
    offsetY: offset.offsetY,
    opacity: DEFAULT_OVERLAY_OPACITY,
    visible: true,
    calibrated: false,
    rawBounds,
  };
}

/** 不可變更新：`id` 命中的那一筆套用 `patch` 產生新物件，其餘筆維持原引用；回傳新陣列。 */
export function updateOverlayLayer(layers: OverlayLayer[], id: string, patch: Partial<OverlayLayer>): OverlayLayer[] {
  return layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer));
}

/** 不可變移除：回傳排除 `id` 那一筆之後的新陣列，原陣列不動。 */
export function removeOverlayLayer(layers: OverlayLayer[], id: string): OverlayLayer[] {
  return layers.filter((layer) => layer.id !== id);
}
