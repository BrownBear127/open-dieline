/**
 * 生成圖層的資料模型（純型別/映射，無 UI 依賴）——4 個固定圖層桶（cut/crease/halfcut/
 * dimensions）的 key／顯示順序／中文標籤，以及 LineType → 桶的映射函式。
 *
 * **搬遷紀錄（Slice 3 gate round 1 T4）**：原本定義在 `overlay/layers.ts`（T1 出處）。T4
 * 要讓 `export/svg.ts`（匯出層）消費這裡的 `layerKeyForLineType` 等介面做 g 圖層分組，但
 * `overlay/layers.ts` 當時 import `export/svg.ts` 的 `DIMENSION_LINE_TYPES` 來實作
 * `layerKeyForLineType`——若 svg.ts 反過來 import overlay/layers.ts，會構成
 * export→overlay→export 的模組循環依賴。搬到這裡（core/ 沒有上游依賴、export/ 與 overlay/
 * 都已經單向依賴 core/）解開這個循環；`overlay/layers.ts` 改成單純 re-export，既有消費者
 * （`ui/LayersPanel.tsx`／`ui/Canvas.tsx`／`tests/overlay/layers.test.ts`）的
 * `@/overlay/layers` import 路徑不變。
 *
 * 附帶結果：`layerKeyForLineType` 改寫後不再需要 `DIMENSION_LINE_TYPES`——見下方函式
 * docblock；`overlay/layers.ts` 因此完全不再 import `export/svg.ts` 的任何東西（原本唯一的
 * 理由就是這個函式）。
 */
import type { LineType } from '@/core/types';

/** 生成圖層的四個固定桶——畫布依線型分組後對應圖層面板的四個分區，也是 SVG 匯出 <g> 分組單位。 */
export type GeneratedLayerKey = 'cut' | 'crease' | 'halfcut' | 'dimensions';

/** 圖層面板／SVG 匯出 <g> 的顯示順序；遍歷用同一份陣列，不各自硬編字面量順序。 */
export const GENERATED_LAYER_ORDER: readonly GeneratedLayerKey[] = ['cut', 'crease', 'halfcut', 'dimensions'];

/** 圖層面板顯示用的中文標籤；SVG 匯出 <g> 的 data-name 也讀這份（見 export/svg.ts）。 */
export const GENERATED_LAYER_LABEL: Readonly<Record<GeneratedLayerKey, string>> = {
  cut: '切割線',
  crease: '摺線',
  halfcut: '半刀',
  dimensions: '尺寸標註',
};

/**
 * LineType → 圖層桶。cut/crease/halfcut 直接對號；其餘（dimension／annotation／bleed）全部
 * 收斂到 'dimensions'——v1 無任何盒型產生 bleed path，這個分支理論不可達，僅為 exhaustive
 * mapping，理由寫在這裡不是靠測試斷言。
 *
 * 這裡不需要（也不能）依賴 `export/svg.ts` 的 `DIMENSION_LINE_TYPES` 來判斷 dimension／
 * annotation 該不該歸 'dimensions'：`LineType` 只有 6 種值，前三個 if 攔截 cut/crease/
 * halfcut 後，剩下就只有 dimension／annotation／bleed 三種，全部收斂到同一個結果，直接
 * fallback 即可——跟搬遷前「先查 Set 再 fallback、但兩個分支回傳值相同」的版本逐位元組
 * 行為相同（見上方檔頭搬遷紀錄）。
 *
 * texts（DielineText）恆屬 'dimensions'，v1 texts 全部來自 `dimensionLine` 標註（見
 * `export/svg.ts` 檔頭 docblock），呼叫端不會拿 DielineText 呼叫這個函式，這裡不需要處理。
 */
export function layerKeyForLineType(t: LineType): GeneratedLayerKey {
  if (t === 'cut') return 'cut';
  if (t === 'crease') return 'crease';
  if (t === 'halfcut') return 'halfcut';
  return 'dimensions'; // 剩下只有 dimension／annotation／bleed
}
