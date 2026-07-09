import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { Segment } from '@/core/geometry';
import type { DielinePiece, GenerateResult } from '@/core/types';
import { MIN_GAP_MM } from '@/core/imposition';
import { ImpositionView } from '@/ui/ImpositionView';
import type { ImpositionState } from '@/ui/ImpositionView';

// ── fixtures ─────────────────────────────────────────────────────────────

function rectSegments(x: number, y: number, w: number, h: number): Segment[] {
  return [
    { kind: 'line', x1: x, y1: y, x2: x + w, y2: y },
    { kind: 'line', x1: x + w, y1: y, x2: x + w, y2: y + h },
    { kind: 'line', x1: x + w, y1: y + h, x2: x, y2: y + h },
    { kind: 'line', x1: x, y1: y + h, x2: x, y2: y },
  ];
}

// RTE 型單片盒型（無 pieces）：cut 幾何為 20×10 矩形，另一條 dimension 線把「宣告 bounds」
// 外擴到 150×150——用來驗證元件必須用 manufacturingBounds（20×10）而非 result.bounds
// （150×150，spec F1 硬規則），兩者在下面的紙規/咬口設定下會算出可分辨的不同排列結果。
const SINGLE_PIECE_RESULT: GenerateResult = {
  paths: [
    { id: 'cut-1', type: 'cut', segments: rectSegments(0, 0, 20, 10) },
    { id: 'dim-1', type: 'dimension', segments: [{ kind: 'line', x1: -50, y1: -50, x2: 100, y2: 100 }] },
  ],
  texts: [],
  bounds: { minX: -50, maxX: 100, minY: -50, maxY: 100 }, // 宣告 bounds：寬高皆 150（含標註外擴）
};

// 長窄件（製造 bounds 800×10）：在下面的紙規設定下，0° 方向該軸放不下（cols=0），
// 90° 方向正常計算——用來驗證「單一方向 0 模顯示放不下、另一方向仍正常排列」。
const LONG_THIN_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: rectSegments(0, 0, 800, 10) }],
  texts: [],
  bounds: { minX: 0, maxX: 800, minY: 0, maxY: 10 },
};

// 兩片盒型：片 A／片 B 幾何與宣告 bounds 一致（此 fixture 的重點是下拉選單行為，不是
// bounds 來源，SINGLE_PIECE_RESULT 已覆蓋 F1 硬規則）。
const MULTI_PIECE_RESULT: GenerateResult = {
  paths: [
    { id: 'a-cut', type: 'cut', segments: rectSegments(0, 0, 20, 10) },
    { id: 'b-cut', type: 'cut', segments: rectSegments(0, 0, 15, 15) },
  ],
  texts: [],
  bounds: { minX: 0, maxX: 20, minY: 0, maxY: 15 },
  pieces: [
    { id: 'piece-a', label: { zh: '下盒' }, pathIds: ['a-cut'], textIds: [], bounds: { minX: 0, maxX: 20, minY: 0, maxY: 10 } },
    { id: 'piece-b', label: { zh: '上蓋' }, pathIds: ['b-cut'], textIds: [], bounds: { minX: 0, maxX: 15, minY: 0, maxY: 15 } },
  ] satisfies DielinePiece[],
};

const BASE_STATE: ImpositionState = {
  pieceId: null,
  paperPresetId: 'custom',
  customW: 50,
  customH: 50,
  orientation: 'portrait',
  mode: 'full',
  gripper: 0,
  gap: 3,
};

// ── 兩卡並列＋列×行＝N 模＋利用率 ──────────────────────────────────────────

describe('ImpositionView — 兩方向卡片', () => {
  it('兩卡並列，各含「列×行＝N 模」與兩位小數利用率（customW=customH=50、製造 bounds 20×10 → 兩方向皆 8 模 64.00%）', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const card90 = screen.getByTestId('direction-card-90');
    expect(card0.textContent).toContain('2 列 × 4 行 ＝ 8 模');
    expect(card0.textContent).toContain('外接矩形利用率 64.00%');
    expect(card90.textContent).toContain('4 列 × 2 行 ＝ 8 模');
    expect(card90.textContent).toContain('外接矩形利用率 64.00%');
  });

  it('必須用製造 bounds（20×10）而非宣告 bounds（150×150，spec F1）：用宣告 bounds 會讓件比紙張還大、算出 0 模／放不下', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    const card0 = screen.getByTestId('direction-card-0');
    // 若誤用宣告 bounds（150×150 > 50×50 紙張），deg0 會是「放不下」；製造 bounds 路徑應為 8 模。
    expect(card0.textContent).not.toContain('放不下');
    expect(card0.textContent).toContain('8 模');
  });

  it('0 模方向顯示「放不下」且不渲染排列；另一方向正常排列（長窄件 800×10）', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 1000 };
    render(<ImpositionView result={LONG_THIN_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0'); // pieceForCols=800 > usableW=100 → 放不下
    const card90 = screen.getByTestId('direction-card-90'); // pieceForCols=10 → 7 模

    expect(card0.textContent).toContain('放不下');
    expect(within(card0).queryAllByTestId('preview-instance')).toHaveLength(0);

    expect(card90.textContent).toContain('7 模');
    expect(card90.textContent).toContain('56.00%');
    expect(within(card90).queryAllByTestId('preview-instance')).toHaveLength(7);
  });

  it('無「最佳／推薦」字樣（F9）：兩卡樣式對稱、不含推薦標記', () => {
    const { container } = render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(container.textContent).not.toMatch(/最佳|推薦/);
  });
});

// ── 界線聲明 ─────────────────────────────────────────────────────────────

describe('ImpositionView — 界線聲明', () => {
  it('固定顯示界線聲明，逐字相符', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(
      screen.getByText('以單件外接矩形估算；未計混向、塞角、共刀、絲向及加工限制，不可直接作生產拼版。'),
    ).toBeInTheDocument();
  });
});

// ── 對開模式：每半張＋working 尺寸文字 ────────────────────────────────────

describe('ImpositionView — 對開模式', () => {
  it('對開 V：顯示「每半張」與 working 尺寸文字（customW=100,customH=200,gripper=10 → working 50.0×200.0，可用區 30.0×180.0）', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, mode: 'halfV' };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    expect(
      screen.getByText('工作尺寸：50.0 × 200.0 mm（可用區 30.0 × 180.0 mm）'),
    ).toBeInTheDocument();

    const card0 = screen.getByTestId('direction-card-0'); // cols=1,rows=14,count=14
    expect(card0.textContent).toContain('每半張');
    expect(card0.textContent).toContain('14 模');
  });

  it('整紙模式（非對開）：不顯示「每半張」', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').textContent).not.toContain('每半張');
  });
});

// ── invalid 輸入：欄位錯誤＋結果「—」＋不渲染排列 ──────────────────────────

describe('ImpositionView — 輸入 domain 錯誤', () => {
  it('gap=2.9（below MIN_GAP_MM）→ 欄位錯誤標示＋兩卡結果「—」＋不渲染任何排列', () => {
    const state: ImpositionState = { ...BASE_STATE, gap: 2.9 };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    expect(screen.getByText(`不得小於 ${MIN_GAP_MM}mm`)).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
    expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
    // 沒有工作尺寸文字（sheet 沒有算出來）
    expect(screen.queryByText(/工作尺寸/)).toBeNull();
  });

  it('paperW/paperH 自訂欄位無效（NaN）→ 欄位錯誤標示在對應輸入框旁', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: NaN };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);
    expect(screen.getByText('請輸入有效數字')).toBeInTheDocument();
  });
});

// ── 件選擇：多片盒型下拉逐件／RTE 顯示「整件」無下拉 ─────────────────────────

describe('ImpositionView — 件選擇', () => {
  it('多片盒型：件下拉逐件列出（label.zh），選擇不同片會呼叫 onChange 更新 pieceId', () => {
    const onChange = vi.fn();
    const state: ImpositionState = { ...BASE_STATE, pieceId: 'piece-a' };
    render(<ImpositionView result={MULTI_PIECE_RESULT} state={state} onChange={onChange} />);

    const select = screen.getByRole('combobox', { name: '件' });
    expect(within(select).getByText('下盒')).toBeInTheDocument();
    expect(within(select).getByText('上蓋')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'piece-b' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pieceId: 'piece-b' }));
  });

  it('RTE（result.pieces 為 undefined）：顯示「整件」，無件下拉', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByText('整件')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '件' })).toBeNull();
  });
});

// ── 即時性（驗收條件 9 抽驗）：state 改值 → 重新渲染後兩卡與預覽同步重算 ───────

describe('ImpositionView — 即時性（重新渲染即重算，抽驗）', () => {
  it('gripper 改值 → 重新渲染後結果同步變化', () => {
    const { rerender } = render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').textContent).toContain('8 模');

    const changed: ImpositionState = { ...BASE_STATE, gripper: 40 }; // 咬口過大：50-80<0 → clamp 0 usable
    rerender(<ImpositionView result={SINGLE_PIECE_RESULT} state={changed} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').textContent).toContain('放不下');
  });
});
