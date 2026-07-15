/**
 * 顯示層線型樣式（Spec §5·Phase 2 拆層）——畫布與拼版預覽消費；匯出（export/）
 * 禁止 import 本模組（G4 gate 強制）。僅覆寫 stroke 色；strokeWidth/dasharray
 * 自 LINE_STYLES 程式繼承，禁止在此重新宣告數值（M2 事故家族防範）。
 * stroke 用 CSS var——tokens.css 是色值唯一真相源（byte-parity 鏈）。
 * 純 TS 模組，不 import React 或任何 UI。
 */
import { LINE_STYLES } from '@/core/styles';
import type { LineType } from '@/core/types';

/** Spec §5 表（2026-07-15 裁定 Q3+D8）——顯示 stroke 映射，僅此一欄可異於匯出層 */
const DISPLAY_STROKE: Readonly<Record<LineType, string>> = {
  cut: 'var(--cut)',
  crease: 'var(--crease)',
  halfcut: 'var(--brass)',
  bleed: '#FF00FF',
  annotation: 'var(--ink-soft)',
  dimension: 'var(--ink-soft)',
};

export const DISPLAY_LINE_STYLES: Readonly<Record<LineType, { stroke: string; strokeWidth: number; dasharray?: string }>> =
  Object.fromEntries(
    (Object.keys(LINE_STYLES) as LineType[]).map((t) => [t, { ...LINE_STYLES[t], stroke: DISPLAY_STROKE[t] }]),
  ) as Record<LineType, { stroke: string; strokeWidth: number; dasharray?: string }>;
