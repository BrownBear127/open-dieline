/**
 * 線型樣式表——LINE_STYLES 是畫布 JSX 與 SVG 匯出共用的唯一樣式來源（spec §3.2）。
 *
 * 禁止在 Canvas.tsx / export/svg.ts 內散落字面量色碼；新增或調整線型樣式只改這裡一處。
 * 顏色與線寬慣例對齊法蘭生產檔與印刷業界慣例（黑=cut、綠=crease、黃=halfcut，見 spec §6.1）。
 * 純 TS 模組，不 import React 或任何 UI。
 */

import type { LineType } from '@/core/types';

export const LINE_STYLES: Record<LineType, { stroke: string; strokeWidth: number; dasharray?: string }> = {
  cut: { stroke: '#000000', strokeWidth: 0.4 },
  crease: { stroke: '#00FF00', strokeWidth: 0.4, dasharray: '4 2' },
  halfcut: { stroke: '#FFFF00', strokeWidth: 0.4, dasharray: '1 1' },
  bleed: { stroke: '#FF00FF', strokeWidth: 0.3 },
  annotation: { stroke: '#888888', strokeWidth: 0.25 },
  dimension: { stroke: '#3B82F6', strokeWidth: 0.25 },
};
