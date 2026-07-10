import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { Segment } from '@/core/geometry';
import type { DielinePiece, GenerateResult } from '@/core/types';
import * as impositionCore from '@/core/imposition';
import { MIN_GAP_MM } from '@/core/imposition';
import { segmentsToSvgD } from '@/core/path';
import { ImpositionView, ImpositionControls, ImpositionResults } from '@/ui/ImpositionView';
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

// 1×1mm 極小件（RTE）：搭配 100×100 紙／gap 3 可得 25×25＝625 模，遠超
// MAX_PREVIEW_INSTANCES=500——review 測試縫 1「超 cap UI」專用 fixture。
const TINY_PIECE_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: rectSegments(0, 0, 1, 1) }],
  texts: [],
  bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
};

// 六線型混合（RTE，單片 12×12 製造 bounds）：cut/crease/halfcut 在 [0,10]×[0,10] 內，
// bleed 外擴到 [-1,11]（撐大 mb 但不影響「只有三線型可預覽」這件事要驗的內容），
// annotation/dimension 刻意落在 mb 排除範圍外——review 測試縫 2「線型 DOM 接線」用。
const SIX_LINE_TYPES_RESULT: GenerateResult = {
  paths: [
    { id: 'p-cut', type: 'cut', segments: rectSegments(0, 0, 10, 10) },
    { id: 'p-crease', type: 'crease', segments: [{ kind: 'line', x1: 2, y1: 2, x2: 8, y2: 8 }] },
    { id: 'p-halfcut', type: 'halfcut', segments: [{ kind: 'line', x1: 1, y1: 9, x2: 9, y2: 1 }] },
    { id: 'p-bleed', type: 'bleed', segments: [{ kind: 'line', x1: -1, y1: -1, x2: 11, y2: 11 }] },
    { id: 'p-annotation', type: 'annotation', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 5, y2: 5 }] },
    { id: 'p-dimension', type: 'dimension', segments: [{ kind: 'line', x1: -20, y1: -20, x2: 30, y2: 30 }] },
  ],
  texts: [],
  bounds: { minX: -20, maxX: 30, minY: -20, maxY: 30 },
};

// 兩片盒型，座標刻意遠離（0..10 vs 100..110）讓兩片的 segmentsToSvgD() 輸出字串不可能撞
// 相同值——review 測試縫 2「多片只畫所選 pathIds」用來斷言「未選片的線完全不出現在 DOM」。
const MULTI_PIECE_LINE_FILTER_RESULT: GenerateResult = {
  paths: [
    { id: 'a-cut', type: 'cut', segments: rectSegments(0, 0, 10, 10) },
    { id: 'b-cut', type: 'cut', segments: rectSegments(100, 100, 10, 10) },
  ],
  texts: [],
  bounds: { minX: 0, maxX: 110, minY: 0, maxY: 110 },
  pieces: [
    { id: 'piece-a', label: { zh: 'A' }, pathIds: ['a-cut'], textIds: [], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 } },
    { id: 'piece-b', label: { zh: 'B' }, pathIds: ['b-cut'], textIds: [], bounds: { minX: 100, maxX: 110, minY: 100, maxY: 110 } },
  ] satisfies DielinePiece[],
};

// 单片 20×10（同 SINGLE_PIECE_RESULT 的真實幾何）但 piece.bounds 故意偏離到 200×200——
// review 測試縫 5「piece.bounds 禁用」：若元件誤用 piece.bounds 而非 pathIds 重新算
// manufacturingBounds，件會比 50×50 紙張還大，算出「放不下」而非正確的 8 模。
const PIECE_BOUNDS_DIVERGENT_RESULT: GenerateResult = {
  paths: [{ id: 'a-cut', type: 'cut', segments: rectSegments(0, 0, 20, 10) }],
  texts: [],
  bounds: { minX: 0, maxX: 20, minY: 0, maxY: 10 },
  pieces: [
    { id: 'piece-a', label: { zh: '下盒' }, pathIds: ['a-cut'], textIds: [], bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 } },
  ] satisfies DielinePiece[],
};

// RTE、單一 cut path 為零寬直線（x 恆為 5）：manufacturingBounds 導出 pieceW=0，觸發
// checkDimension 的 not-positive——review 測試縫 3「整體錯誤：pieceW/pieceH invalid」用。
const DEGENERATE_ZERO_WIDTH_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: [{ kind: 'line', x1: 5, y1: 0, x2: 5, y2: 10 }] }],
  texts: [],
  bounds: { minX: 5, maxX: 5, minY: 0, maxY: 10 },
};

// 同族的零「高」變體（y 恆為 7 的水平線）：pieceH=0。T3 re-review 以 mutation 證明只有
// pieceW 案例時，production 的 pieceH 錯誤分支可被刪除而全套仍綠——此 fixture 補上鑑別力。
const DEGENERATE_ZERO_HEIGHT_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 7, x2: 10, y2: 7 }] }],
  texts: [],
  bounds: { minX: 0, maxX: 10, minY: 7, maxY: 7 },
};

// allowRotate:false（T1 消費端最小遷移）：保留這個共用 fixture 底下所有既有數字錨（8 模等）
// 逐字不變——這個測試檔的職責是 UI 接線／欄位級行為，不是補排演算法本身（那是
// tests/imposition.test.ts 的職責，已有專屬的附錄數值錨表＋極端分支覆蓋）。
const BASE_STATE: ImpositionState = {
  pieceId: null,
  paperPresetId: 'custom',
  customW: 50,
  customH: 50,
  orientation: 'portrait',
  cutV: false,
  cutH: false,
  allowRotate: false,
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
      screen.getByText('以單件外接矩形估算，僅計單層 L 形 90° 補排；未計遞迴塞角、異形咬合、共刀、絲向及加工限制，不可直接作生產拼版。'),
    ).toBeInTheDocument();
  });
});

// ── 對開模式：每半張＋working 尺寸文字 ────────────────────────────────────

describe('ImpositionView — 對開模式', () => {
  it('對開 V：顯示「每半張」與 working 尺寸文字（customW=100,customH=200,gripper=10 → working 50.0×200.0，可用區 30.0×180.0）', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: false };
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

// ── 作業模式 select 映射表（Fix 4·gate round 1 T1 review Low：舊測試只選 halfV 一項，
// 未覆蓋 full/halfH/quarter，映射本身正確〔review 已驗〕，這裡純補測試鑑別力）──────

describe('ImpositionControls — 作業模式 select 映射表（Fix 4）', () => {
  const MODE_TABLE: { value: 'full' | 'halfV' | 'halfH' | 'quarter'; cutV: boolean; cutH: boolean }[] = [
    { value: 'full', cutV: false, cutH: false },
    { value: 'halfV', cutV: true, cutH: false },
    { value: 'halfH', cutV: false, cutH: true },
    { value: 'quarter', cutV: true, cutH: true },
  ];

  it.each(MODE_TABLE)('select→state：選「$value」→ onChange 收到 cutV=$cutV、cutH=$cutH', ({ value, cutV, cutH }) => {
    const onChange = vi.fn();
    render(<ImpositionControls result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('作業模式'), { target: { value } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cutV, cutH }));
  });

  it.each(MODE_TABLE)('state→select 回讀：cutV=$cutV、cutH=$cutH → 下拉顯示「$value」', ({ value, cutV, cutH }) => {
    const state: ImpositionState = { ...BASE_STATE, cutV, cutH };
    render(<ImpositionControls result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    expect((screen.getByLabelText('作業模式') as HTMLSelectElement).value).toBe(value);
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

// ── F6 review Medium 1（fix round 1）：stale piece 不得退全版，須 fail loud ───

describe('ImpositionView — F6 stale piece fail loud（review Medium 1）', () => {
  it('多片盒型 pieceId=null（尚未選定／T4 fallback 前過渡態）→ 不得退全版：兩卡「—」、零排列、顯示整體錯誤', () => {
    const state: ImpositionState = { ...BASE_STATE, pieceId: null };
    render(<ImpositionView result={MULTI_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
    expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
    expect(screen.getByTestId('imposition-general-error')).toBeInTheDocument();
    expect(screen.getByText('請選擇拼版的件')).toBeInTheDocument();
  });

  it('多片盒型 pieceId 對到不存在的 id（stale，如剛被刪除的片）→ 同樣 fail loud，不退全版', () => {
    const state: ImpositionState = { ...BASE_STATE, pieceId: 'ghost' };
    render(<ImpositionView result={MULTI_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
    expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
    expect(screen.getByTestId('imposition-general-error')).toBeInTheDocument();
  });

  it('RTE（result.pieces 為 undefined）不受 stalePiece 規則影響：回歸防護，確保修復沒有誤傷既有全版行為', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').textContent).toContain('8 模');
    expect(screen.queryByTestId('imposition-general-error')).toBeNull();
  });
});

// ── review 測試縫 5：piece.bounds 禁用（F1 硬規則第二層鎖） ──────────────────

describe('ImpositionView — piece.bounds 禁用（review 測試縫 5）', () => {
  it('piece.bounds 故意偏離 path-derived 幾何（200×200 vs 真實 20×10）→ 拼版仍用製造 bounds，8 模而非「放不下」', () => {
    const state: ImpositionState = { ...BASE_STATE, pieceId: 'piece-a' };
    render(<ImpositionView result={PIECE_BOUNDS_DIVERGENT_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    expect(card0.textContent).not.toContain('放不下');
    expect(card0.textContent).toContain('2 列 × 4 行 ＝ 8 模');
  });
});

// ── review 測試縫 1：超 cap UI ────────────────────────────────────────────

describe('ImpositionView — 超 cap 預覽（review 測試縫 1）', () => {
  it('1×1 件＋100×100 紙＋gap3（25×25=625 模，超過 MAX_PREVIEW_INSTANCES=500）→ 精確 count 顯示、恰 500 個 instance、逐字簡化提示', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 100 };
    render(<ImpositionView result={TINY_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    expect(card0.textContent).toContain('25 列 × 25 行 ＝ 625 模');
    expect(within(card0).getAllByTestId('preview-instance')).toHaveLength(500);
    expect(within(card0).getByText('數量過大，預覽已簡化')).toBeInTheDocument();
  });

  it('count 恰為 MAX_PREVIEW_INSTANCES（cap 邊界，不超過）→ 不顯示簡化提示，instance 數＝count', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 80, orientation: 'landscape' };
    render(<ImpositionView result={TINY_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    expect(card0.textContent).toContain('25 列 × 20 行 ＝ 500 模');
    expect(within(card0).getAllByTestId('preview-instance')).toHaveLength(500);
    expect(within(card0).queryByText('數量過大，預覽已簡化')).toBeNull();
  });
});

// ── review 測試縫 2：線型 DOM 接線 ─────────────────────────────────────────

describe('ImpositionView — 線型 DOM 接線（review 測試縫 2）', () => {
  it('六線型混合：instance 內只渲染 cut/crease/halfcut 的 <path>，dimension/annotation/bleed 不出現', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 50, customH: 50 };
    render(<ImpositionView result={SIX_LINE_TYPES_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const instanceGroups = within(card0).getAllByTestId('preview-instance');
    expect(instanceGroups.length).toBeGreaterThan(0);

    for (const group of instanceGroups) {
      const strokes = Array.from(group.querySelectorAll('path')).map((el) => el.getAttribute('stroke'));
      expect(strokes).toHaveLength(3); // cut+crease+halfcut，一個 instance 恰三條線
      expect(strokes.slice().sort()).toEqual(['#000000', '#00FF00', '#FFFF00'].sort()); // cut/crease/halfcut
      expect(strokes).not.toContain('#FF00FF'); // bleed
      expect(strokes).not.toContain('#888888'); // annotation
      expect(strokes).not.toContain('#3B82F6'); // dimension
    }
  });

  it('多片：預覽只畫所選片的 pathIds，不混入未選片的線', () => {
    const state: ImpositionState = { ...BASE_STATE, pieceId: 'piece-a' };
    render(<ImpositionView result={MULTI_PIECE_LINE_FILTER_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const expectedD = segmentsToSvgD(rectSegments(0, 0, 10, 10));
    const unexpectedD = segmentsToSvgD(rectSegments(100, 100, 10, 10));

    const ds = Array.from(card0.querySelectorAll('[data-testid="preview-instance"] path')).map((el) => el.getAttribute('d'));
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d === expectedD)).toBe(true);
    expect(ds).not.toContain(unexpectedD);
  });
});

// ── review 測試縫 3：整體錯誤（pieceW/pieceH invalid、result:internal） ──────

describe('ImpositionView — 整體錯誤（review 測試縫 3）', () => {
  it('pieceW 由製造 bounds 導出為 0（degenerate 零寬幾何）→ 整體錯誤＋兩卡「—」＋零排列', () => {
    render(<ImpositionView result={DEGENERATE_ZERO_WIDTH_RESULT} state={BASE_STATE} onChange={vi.fn()} />);

    expect(screen.getByTestId('imposition-general-error')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
    expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
  });

  it('pieceH 由製造 bounds 導出為 0（degenerate 零高幾何）→ 整體錯誤＋兩卡「—」＋零排列', () => {
    render(<ImpositionView result={DEGENERATE_ZERO_HEIGHT_RESULT} state={BASE_STATE} onChange={vi.fn()} />);

    expect(screen.getByTestId('imposition-general-error')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
    expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
  });

  it('result:internal（深度防禦分支，domain 驗證已擋、正常輸入理論上不可達；用 spy 直接釘住 UI 對這個錯誤碼的反應）→ 整體錯誤＋兩卡「—」＋零排列', () => {
    const spy = vi.spyOn(impositionCore, 'computeImposition').mockReturnValue({
      ok: false,
      errors: [{ field: 'result', reason: 'internal' }],
    });

    try {
      render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);

      expect(screen.getByTestId('imposition-general-error')).toBeInTheDocument();
      expect(within(screen.getByTestId('direction-card-0')).getByText('—')).toBeInTheDocument();
      expect(within(screen.getByTestId('direction-card-90')).getByText('—')).toBeInTheDocument();
      expect(screen.queryAllByTestId('preview-instance')).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── review 測試縫 4：對開切線與區域幾何 ────────────────────────────────────

describe('ImpositionView — 對開切線與區域幾何（review 測試縫 4）', () => {
  it('對開 V：切線 x＝workingSheet.w、跨滿 fullSheet 高度；原紙外框＝fullSheet 尺寸；working half 可用區與原紙外框分離', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: false };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const halfLine = within(card0).getByTestId('half-cut-line');
    expect(halfLine).toHaveAttribute('x1', '50');
    expect(halfLine).toHaveAttribute('x2', '50');
    expect(halfLine).toHaveAttribute('y1', '0');
    expect(halfLine).toHaveAttribute('y2', '200');

    const svg = card0.querySelector('svg')!;
    expect(svg).toHaveAttribute('viewBox', '0 0 100 200'); // fullSheet＝未切半的整張紙

    const rects = svg.querySelectorAll('rect');
    // DOM 順序：[0]=原紙外框、[1]=working half 咬口區（全範圍）、[2]=可用區（扣咬口）。
    expect(rects[0]).toHaveAttribute('width', '100');
    expect(rects[0]).toHaveAttribute('height', '200');
    expect(rects[1]).toHaveAttribute('width', '50'); // workingSheet.w（V 切半：100/2）
    expect(rects[1]).toHaveAttribute('height', '200');
    expect(rects[2]).toHaveAttribute('width', '30'); // usableW = 50 - 2*10
    expect(rects[2]).toHaveAttribute('height', '180'); // usableH = 200 - 2*10
  });

  it('對開 H：切線 y＝workingSheet.h、跨滿 fullSheet 寬度', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: false, cutH: true };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const halfLine = within(card0).getByTestId('half-cut-line');
    expect(halfLine).toHaveAttribute('x1', '0');
    expect(halfLine).toHaveAttribute('x2', '100');
    expect(halfLine).toHaveAttribute('y1', '100');
    expect(halfLine).toHaveAttribute('y2', '100');
  });
});

// ── review Medium 2：ImpositionControls／ImpositionResults 可獨立掛載 ────────

describe('ImpositionControls／ImpositionResults — 獨立掛載（review Medium 2）', () => {
  it('ImpositionControls 單獨掛載：渲染控制項並可透過 onChange 更新 state（不依賴 ImpositionResults）', () => {
    const onChange = vi.fn();
    render(<ImpositionControls result={MULTI_PIECE_RESULT} state={{ ...BASE_STATE, pieceId: 'piece-a' }} onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: '件' })).toBeInTheDocument();
    expect(screen.queryByTestId('direction-card-0')).toBeNull(); // 結果卡不屬於 Controls

    const gapInput = screen.getByLabelText('刀線間距 (mm)');
    fireEvent.change(gapInput, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gap: 5 }));
  });

  it('ImpositionResults 單獨掛載：渲染兩張方向卡片＋界線聲明（不依賴 ImpositionControls，無需 onChange）', () => {
    render(<ImpositionResults result={SINGLE_PIECE_RESULT} state={BASE_STATE} />);

    expect(screen.getByTestId('direction-card-0').textContent).toContain('8 模');
    expect(screen.getByTestId('direction-card-90').textContent).toContain('8 模');
    expect(
      screen.getByText('以單件外接矩形估算，僅計單層 L 形 90° 補排；未計遞迴塞角、異形咬合、共刀、絲向及加工限制，不可直接作生產拼版。'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '件' })).toBeNull(); // 控制項不屬於 Results
  });
});
