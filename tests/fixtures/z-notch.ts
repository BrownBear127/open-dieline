import type { Segment } from '@/core/geometry';
import type { DirectionResult, ImpositionInput } from '@/core/imposition';

// profile-spacing slice（docs/specs/2026-07-11-imposition-profile-spacing.md）：人造
// Z-notch 幾何＋權威錨值的單一來源。T3 review Low 修正——原本 `tests/imposition.test.ts`
// 的「正數補排案例」與 `tests/imposition-preview.test.ts` 的「正數補排＋收縮並存」各自
// 獨立手打同一份 `Z_NOTCH_SEGMENTS`/`Z_NOTCH_GAP`/`POSITIVE_FILL_INPUT` 與這裡算出的錨值
// 數字，只靠一個「前提檢查」測試互相對照；若一檔幾何+預期一起更新、另一檔忘了同步，
// 兩檔會各自維持內部一致而測不出分歧。抽成這個共用 fixture 後，任一處改壞這裡的數字都
// 會讓兩個測試檔一起紅（見兩檔 import 處）。

/**
 * 人造 Z-notch 幾何（T2 開工探針 `.superpowers/sdd/probe-positive-fill.mts` 的正式版本，
 * 完整推導記 task-2-report.md）：8 段 line 的矩形多邊形，bounds W=50×H=200。
 *   - 左段（x∈[0,10)）：材料 y∈[0,140]（頂到 y=0，未頂到 y=200）
 *   - 中段（x∈[10,40)）：材料 y∈[60,140]（純矩形 body，兩端皆未頂到邊界）
 *   - 右段（x∈(40,50]）：材料 y∈[60,200]（頂到 y=200，未頂到 y=0）
 * 任一欄都不同時頂到 y=0 與 y=200（避免單欄 same-slot 項本身就等於矩形上界 H+gap）——
 * strideY 因此有真實收縮空間；strideX 無收縮空間的成因（SOL T2 review Low 2 修正原述）：
 * y=60 與 y=140 的邊界槽同時收到外側豎線（x=0 或 x=50）與水平邊（x∈[0,40]／[10,50]）
 * 的貢獻，該槽包絡因此涵蓋 x=0..50 全寬，same-slot 項＝W+gap=53=矩形上界。一軸真收縮、
 * 另一軸恆等於矩形，刻意設計成能乾淨區分「行縮／列縮」兩案，不互相汙染。
 *
 * RTE 真實幾何在任何紙規下**最終擇優結果**皆無正數補排（SOL T2 review Low 1 修正原
 * 「任何候選」過強表述——未獲選的矩形候選確實可能補排，如 usable 500×494 的 0° 矩形
 * 候選=主格 2＋底排 1，但行縮候選主格 4 必勝出；SOL 掃整數紙規＋200 萬組隨機連續紙規
 * 零反例）：收縮候選的殘留恆 < 該軸實際 stride（0° 行縮 strideY=194.825、90° 列縮
 * cols stride 同為 194.825——**非矩形 236.2**），而旋轉件所需另一維 ≥ min(W,H)=233.2
 * > 194.825；未縮候選若靠殘留補到一排，收縮候選在同紙規至少多出同等主格數（count
 * 平手時 gridCount／行縮規則勝出）。這正是 brief「找不到真實正補排案例」退回人造
 * fixture 的情況。本形狀的 W=50／H=200（4 倍長寬比）刻意拉大差距解決這個問題。
 */
export const Z_NOTCH_SEGMENTS: Segment[] = [
  { kind: 'line', x1: 0, y1: 140, x2: 40, y2: 140 },
  { kind: 'line', x1: 40, y1: 140, x2: 40, y2: 200 },
  { kind: 'line', x1: 40, y1: 200, x2: 50, y2: 200 },
  { kind: 'line', x1: 50, y1: 200, x2: 50, y2: 60 },
  { kind: 'line', x1: 50, y1: 60, x2: 10, y2: 60 },
  { kind: 'line', x1: 10, y1: 60, x2: 10, y2: 0 },
  { kind: 'line', x1: 10, y1: 0, x2: 0, y2: 0 },
  { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 140 },
];
export const Z_NOTCH_GAP = 3;

/** 人造紙規（不對應任何 PAPER_PRESETS，landscape 正規化＋gripper=0 後 usableW=450／
 *  usableH=446）——尺寸選擇見 task-2-report.md「正數補排案例」節的完整推導。 */
export const POSITIVE_FILL_INPUT: ImpositionInput = {
  pieceW: 50,
  pieceH: 200,
  paperW: 450,
  paperH: 446,
  orientation: 'landscape',
  cutV: false,
  cutH: false,
  allowRotate: true,
  gripper: 0,
  gap: Z_NOTCH_GAP,
};

/**
 * 權威錨值（withShrunk 案例）：`computeProfileStrides(Z_NOTCH_SEGMENTS, Z_NOTCH_GAP)` 餵入
 * `computeImposition({ ...POSITIVE_FILL_INPUT, shrunk })` 算出的 deg0/deg90 完整結果，
 * `utilization` 除外（浮點除法結果，兩個消費檔各自用 `toBeCloseTo` 驗）。
 * `tests/imposition.test.ts`「正數補排案例」與 `tests/imposition-preview.test.ts`
 * 「正數補排＋收縮並存」共用同一組數字——見檔頭說明。
 */
export const Z_NOTCH_ANCHOR_DEG0: Omit<DirectionResult, 'utilization'> = {
  cols: 8,
  rows: 2,
  gridCount: 16,
  fillSplit: 'bottom-full',
  bottomFill: { cols: 2, rows: 1, count: 2 }, // 收縮版：底條帶（100mm 高）放得下 2 件旋轉件
  rightFill: { cols: 0, rows: 6, count: 0 },
  count: 18,
  totalCount: 18,
  spacingAxis: 'rows',
  strideX: 53,
  strideY: 143,
  usedW: 421,
  usedH: 343,
};

export const Z_NOTCH_ANCHOR_DEG90: Omit<DirectionResult, 'utilization'> = {
  cols: 2,
  rows: 8,
  gridCount: 16,
  fillSplit: 'bottom-full',
  bottomFill: { cols: 8, rows: 0, count: 0 },
  rightFill: { cols: 2, rows: 2, count: 4 }, // 收縮版：右條帶（104mm 寬）放得下 4 件旋轉件
  count: 20,
  totalCount: 20,
  spacingAxis: 'cols',
  strideX: 143,
  strideY: 53,
  usedW: 343,
  usedH: 421,
};
