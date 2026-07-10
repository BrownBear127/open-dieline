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

// 4×2mm 小片（RTE）：搭配 17×11 橫放紙／gripper0／gap3／allowRotate:true，0° 卡在主格點
// 之外用 right-full 補上 1×2=2 件（gridCount4＋補2＝6模）、90° 卡剛好鋪滿無補排（gridCount8＝
// count8）——同一份 fixture 同時覆蓋「整紙有補排」與「整紙無補排（不顯示＋補0）」兩種卡片
// 文字格式（T3「卡片文字格式」RED）。數字已用獨立 computeImposition 呼叫驗算（非憑空推算，
// 過程見 開發紀錄 附錄），不是由被測元件反推（spec F8 鐵則）。
const FILL_FORMAT_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: rectSegments(0, 0, 4, 2) }],
  texts: [],
  bounds: { minX: 0, maxX: 4, minY: 0, maxY: 2 },
};

// 40×20mm 件（RTE）：final review review Medium「production-chain 一致性」測試專用 fixture——
// 搭配 214×134 landscape／cutV+cutH／allowRotate:true／gripper0／gap3，用來把 core
// `pickFillSplit` 與 preview `directionInstances` 兩處各自重算的 usedW/usedH 接在同一條真實
// 渲染鏈上鎖死：0° 卡 7 模/子紙(28模)、90° 卡 6 模/子紙(24模)。數字已用獨立 computeImposition
// 呼叫驗算（非憑空推算，過程見 開發紀錄 附錄），不是由被測元件反推（spec F8 鐵則）。
const PRODUCTION_CHAIN_PIECE_RESULT: GenerateResult = {
  paths: [{ id: 'cut-1', type: 'cut', segments: rectSegments(0, 0, 40, 20) }],
  texts: [],
  bounds: { minX: 0, maxX: 40, minY: 0, maxY: 20 },
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

// ── 卡片文字格式：整紙有補排（T3） ──────────────────────────────────────────

describe('ImpositionView — 卡片文字格式：整紙有補排（T3）', () => {
  it('0° 卡有補排（gridCount4＋補2＝6模）顯示「＋ 補 N」；90° 卡無補排（count8）沿用舊格式、不顯示「＋ 補 0」', () => {
    const state: ImpositionState = {
      ...BASE_STATE,
      customW: 17,
      customH: 11,
      orientation: 'landscape',
      gripper: 0,
      gap: 3,
      allowRotate: true,
    };
    render(<ImpositionView result={FILL_FORMAT_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0'); // cols=2,rows=2,gridCount=4,補2＝6模
    expect(card0.textContent).toContain('2 列 × 2 行 ＋ 補 2 ＝ 6 模');
    expect(card0.textContent).toContain('外接矩形利用率 25.67%');

    const card90 = screen.getByTestId('direction-card-90'); // cols=4,rows=2,無補排，8模
    expect(card90.textContent).toContain('4 列 × 2 行 ＝ 8 模');
    expect(card90.textContent).not.toContain('＋ 補');
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
  it('對開 V：working 尺寸文字含全紙／半張子紙／可用區數字（T3：裁切時全紙＋子紙兩層資訊，測數字存在不測全文；customW=100,customH=200,gripper=10 → 全紙100.0×200.0、半張子紙50.0×200.0、可用30.0×180.0）；卡片文字改「每半張 N 模 × 2 ＝ M 模」格式、不再顯示「N 列」', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: false };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const sizeText = screen.getByText(/全紙/).textContent ?? '';
    expect(sizeText).toContain('100.0'); // fullW
    expect(sizeText).toContain('200.0'); // fullH（＝workingSheet.h，cutH 為 false）
    expect(sizeText).toContain('50.0'); // workingSheet.w（V 切半：100/2）
    expect(sizeText).toContain('30.0'); // usableW
    expect(sizeText).toContain('180.0'); // usableH

    const card0 = screen.getByTestId('direction-card-0'); // cols=1,rows=14,count=14,totalCount=28
    expect(card0.textContent).toContain('每半張');
    expect(card0.textContent).toContain('14 模');
    expect(card0.textContent).toContain('28 模'); // totalCount＝count×2
    expect(card0.textContent).not.toMatch(/\d+\s*列/); // 裁切格式整套替換,不是在整紙格式後加註記
  });

  it('整紙模式（非對開）：不顯示「每半張」，working 尺寸文字維持整紙舊格式逐字不變（回歸，spec 附錄「回歸保證」）', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').textContent).not.toContain('每半張');
    expect(screen.getByText('工作尺寸：50.0 × 50.0 mm（可用區 50.0 × 50.0 mm）')).toBeInTheDocument();
  });
});

// ── toolbar 按鈕組（T4：紙規／方向／裁切／旋轉全面改按鈕，取代 T1「作業模式」四選一
// 暫時下拉；裁切改成 cutV/cutH 各自獨立 toggle，可疊加＝四開，不再是四選一映射） ────────

describe('ImpositionControls — toolbar 按鈕組（T4）', () => {
  it('紙規 4 顆按鈕（3 preset＋自訂）：aria-pressed 反映 state.paperPresetId，點擊呼叫 onChange', () => {
    const onChange = vi.fn();
    render(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, paperPresetId: '31x43' }} onChange={onChange} />,
    );

    const paperGroup = within(screen.getByRole('group', { name: '紙規' }));
    expect(paperGroup.getByRole('button', { name: /31/ })).toHaveAttribute('aria-pressed', 'true');
    expect(paperGroup.getByRole('button', { name: /25/ })).toHaveAttribute('aria-pressed', 'false');
    expect(paperGroup.getByRole('button', { name: /27/ })).toHaveAttribute('aria-pressed', 'false');
    expect(paperGroup.getByRole('button', { name: '自訂' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(paperGroup.getByRole('button', { name: /25/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ paperPresetId: '25x35' }));

    fireEvent.click(paperGroup.getByRole('button', { name: '自訂' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ paperPresetId: 'custom' }));
  });

  it('自訂紙規選中時展開 W/H 輸入；選 preset 時收合（isCustomPaper 沿用既有計算，僅觸發方式從 select 改按鈕）', () => {
    const { rerender } = render(<ImpositionControls result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);
    expect(screen.getByLabelText('W (mm)')).toBeInTheDocument(); // BASE_STATE.paperPresetId==='custom'
    expect(screen.getByLabelText('H (mm)')).toBeInTheDocument();

    rerender(<ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, paperPresetId: '31x43' }} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('W (mm)')).toBeNull();
    expect(screen.queryByLabelText('H (mm)')).toBeNull();
  });

  it('方向 2 顆按鈕（直放/橫放）：aria-pressed 反映 state.orientation，點擊呼叫 onChange', () => {
    const onChange = vi.fn();
    render(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, orientation: 'portrait' }} onChange={onChange} />,
    );

    const orientationGroup = within(screen.getByRole('group', { name: '方向' }));
    expect(orientationGroup.getByRole('button', { name: '直放' })).toHaveAttribute('aria-pressed', 'true');
    expect(orientationGroup.getByRole('button', { name: '橫放' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(orientationGroup.getByRole('button', { name: '橫放' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ orientation: 'landscape' }));
  });

  it('裁切 2 顆按鈕（對開V/對開H）：各自獨立 toggle、可疊加＝四開，不是互斥四選一', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, cutV: false, cutH: false }} onChange={onChange} />,
    );

    const cutGroup = within(screen.getByRole('group', { name: '裁切' }));
    expect(cutGroup.getByRole('button', { name: '對開 V' })).toHaveAttribute('aria-pressed', 'false');
    expect(cutGroup.getByRole('button', { name: '對開 H' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(cutGroup.getByRole('button', { name: '對開 V' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cutV: true, cutH: false }));

    // cutH 的點擊不受 cutV 目前是否按下影響（獨立 toggle，不是四選一映射的一部分）。
    rerender(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, cutV: true, cutH: false }} onChange={onChange} />,
    );
    fireEvent.click(within(screen.getByRole('group', { name: '裁切' })).getByRole('button', { name: '對開 H' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cutV: true, cutH: true }));

    rerender(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, cutV: true, cutH: true }} onChange={onChange} />,
    );
    const bothPressedGroup = within(screen.getByRole('group', { name: '裁切' }));
    expect(bothPressedGroup.getByRole('button', { name: '對開 V' })).toHaveAttribute('aria-pressed', 'true');
    expect(bothPressedGroup.getByRole('button', { name: '對開 H' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('裁切 (cutV=false, cutH=true) 組合：H 選中、V 未選中兩鈕皆斷言，並從此態點擊 H 驗證回到 (false, false)（review 覆蓋缺口——原本 4 種疊加組合只驗了 3 種）', () => {
    const onChange = vi.fn();
    render(
      <ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, cutV: false, cutH: true }} onChange={onChange} />,
    );

    const cutGroup = within(screen.getByRole('group', { name: '裁切' }));
    expect(cutGroup.getByRole('button', { name: '對開 V' })).toHaveAttribute('aria-pressed', 'false');
    expect(cutGroup.getByRole('button', { name: '對開 H' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(cutGroup.getByRole('button', { name: '對開 H' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cutV: false, cutH: false }));
  });

  it('可轉 90° 按鈕：aria-pressed 反映 state.allowRotate，點擊呼叫 onChange 取反（取代 T1 的 checkbox）', () => {
    const onChange = vi.fn();
    render(<ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, allowRotate: false }} onChange={onChange} />);

    const rotateButton = screen.getByRole('button', { name: /可轉 90/ });
    expect(rotateButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(rotateButton);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ allowRotate: true }));
  });

  it('咬口／刀線間距輸入仍在、欄位錯誤紅字仍在（沿用既有 domain 驗證接線，未受按鈕化影響）', () => {
    render(<ImpositionControls result={SINGLE_PIECE_RESULT} state={{ ...BASE_STATE, gap: 2.9 }} onChange={vi.fn()} />);
    expect(screen.getByLabelText('咬口 (mm)')).toBeInTheDocument();
    expect(screen.getByLabelText('刀線間距 (mm)')).toBeInTheDocument();
    expect(screen.getByText(`不得小於 ${MIN_GAP_MM}mm`)).toBeInTheDocument();
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

// ── T3：全紙預覽 SVG 結構（全紙外框恆在＋裁切中線＋每子紙分區＋non-scaling-stroke，
// 取代舊「對開切線與區域幾何（review 測試縫 4）」的單子紙視圖測試） ─────────────────

describe('ImpositionView — 全紙預覽 SVG 結構（T3 重寫）', () => {
  it('viewBox 恆為 fullW×fullH，不因裁切而改變（同一份紙規，切前切後比較——gate 驗收反饋「紙不動,只有可落版區域變」）', () => {
    const flat: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200 };
    const { rerender } = render(<ImpositionView result={SINGLE_PIECE_RESULT} state={flat} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').querySelector('svg')).toHaveAttribute('viewBox', '0 0 100 200');

    rerender(<ImpositionView result={SINGLE_PIECE_RESULT} state={{ ...flat, cutV: true }} onChange={vi.fn()} />);
    expect(screen.getByTestId('direction-card-0').querySelector('svg')).toHaveAttribute('viewBox', '0 0 100 200');
  });

  it('全紙外框恆顯示 fullSheet 尺寸（裁切時不縮小），帶 non-scaling-stroke', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: false };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const frame = within(screen.getByTestId('direction-card-0')).getByTestId('sheet-frame');
    expect(frame).toHaveAttribute('width', '100');
    expect(frame).toHaveAttribute('height', '200');
    expect(frame).toHaveAttribute('vector-effect', 'non-scaling-stroke');
  });

  it('cutV：cut-line-v 畫在 x=fullW/2、跨滿全高；不畫 cut-line-h', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, cutV: true, cutH: false };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const line = within(card0).getByTestId('cut-line-v');
    expect(line).toHaveAttribute('x1', '50');
    expect(line).toHaveAttribute('x2', '50');
    expect(line).toHaveAttribute('y1', '0');
    expect(line).toHaveAttribute('y2', '200');
    expect(line).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    expect(within(card0).queryByTestId('cut-line-h')).toBeNull();
  });

  it('cutH：cut-line-h 畫在 y=fullH/2、跨滿全寬', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, cutV: false, cutH: true };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const line = within(screen.getByTestId('direction-card-0')).getByTestId('cut-line-h');
    expect(line).toHaveAttribute('x1', '0');
    expect(line).toHaveAttribute('x2', '100');
    expect(line).toHaveAttribute('y1', '100');
    expect(line).toHaveAttribute('y2', '100');
  });

  it('四開（cutV+cutH）：cut-line-v／cut-line-h 同時出現＋四個 section 依左上/右上/左下/右下排列＋translate 位移正確', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: true };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    expect(within(card0).getByTestId('cut-line-v')).toBeInTheDocument();
    expect(within(card0).getByTestId('cut-line-h')).toBeInTheDocument();

    const sections = within(card0).getAllByTestId('section');
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.getAttribute('transform'))).toEqual([
      'translate(0 0)',
      'translate(50 0)',
      'translate(0 100)',
      'translate(50 100)',
    ]);
  });

  it('每子紙咬口區／可用區尺寸＝workingSheet.w/h、usableW/usableH，四個 section 內一致（同版複製）', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: true };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const sections = within(screen.getByTestId('direction-card-0')).getAllByTestId('section');
    expect(sections).toHaveLength(4);
    for (const section of sections) {
      const gripperZone = within(section).getByTestId('gripper-zone');
      expect(gripperZone).toHaveAttribute('width', '50'); // workingSheet.w
      expect(gripperZone).toHaveAttribute('height', '100'); // workingSheet.h

      const usableZone = within(section).getByTestId('usable-zone');
      expect(usableZone).toHaveAttribute('x', '10'); // gripper
      expect(usableZone).toHaveAttribute('y', '10');
      expect(usableZone).toHaveAttribute('width', '30'); // usableW = 50 - 2*10
      expect(usableZone).toHaveAttribute('height', '80'); // usableH = 100 - 2*10
      expect(usableZone).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    }
  });

  it('每子紙同一份排列（同版複製）：四開情境下每個 section 的 preview-instance 數量都等於 direction.count（不是 totalCount）', () => {
    const state: ImpositionState = { ...BASE_STATE, customW: 100, customH: 200, gripper: 10, cutV: true, cutH: true };
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0'); // cols=1,rows=6,count=6,totalCount=24（獨立 computeImposition 驗算）
    expect(card0.textContent).toContain('每四開 6 模 × 4 ＝ 24 模');
    const sections = within(card0).getAllByTestId('section');
    for (const section of sections) {
      expect(within(section).getAllByTestId('preview-instance')).toHaveLength(6);
    }
    expect(within(card0).getAllByTestId('preview-instance')).toHaveLength(24);
  });

  it('跨子紙 remainingBudget 鏈＋四開漏報回歸（spec 附錄）：每子紙 150、全紙 600、cap 500 → 依左上/右上/左下/右下順序扣預算，前三子紙各拿滿 150、第四子紙只拿 50，總數恰 500 且顯示截斷提示', () => {
    const state: ImpositionState = {
      ...BASE_STATE,
      customW: 114,
      customH: 74,
      orientation: 'landscape',
      cutV: true,
      cutH: true,
      gripper: 0,
      gap: 3,
      allowRotate: false,
    };
    render(<ImpositionView result={TINY_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0'); // cols=15,rows=10,count=150,totalCount=600（獨立驗算）
    expect(card0.textContent).toContain('每四開 150 模 × 4 ＝ 600 模');

    const sections = within(card0).getAllByTestId('section');
    expect(sections).toHaveLength(4);
    const perSectionCounts = sections.map((s) => within(s).getAllByTestId('preview-instance').length);
    expect(perSectionCounts).toEqual([150, 150, 150, 50]); // 左上/右上/左下/右下順序，不均分

    expect(within(card0).getAllByTestId('preview-instance')).toHaveLength(500); // renderedCount=min(600,500)
    expect(within(card0).getByText('數量過大，預覽已簡化')).toBeInTheDocument(); // totalCount(600) > renderedCount(500)
  });

  it('paths 帶 vector-effect=non-scaling-stroke，strokeWidth＝LINE_STYLES 原始值（不再乘 PREVIEW_STROKE_SCALE）', () => {
    render(<ImpositionView result={SINGLE_PIECE_RESULT} state={BASE_STATE} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const path = within(card0).getAllByTestId('preview-instance')[0]!.querySelector('path')!;
    expect(path).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    expect(path).toHaveAttribute('stroke-width', '0.4'); // LINE_STYLES.cut.strokeWidth，未乘舊 PREVIEW_STROKE_SCALE(6)
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

// ── gate round 1 final review review Medium：usedW/usedH 兩處實作（core `pickFillSplit`／preview
// `directionInstances`）各自重算，公式現在代數一致（final review 已驗證），但沒有測試把兩者
// 接在同一條真實鏈上——上面的預覽測試多半用手寫 DirectionResult，四開 UI 測試（全紙預覽 SVG
// 結構區塊）走 allowRotate:false（無補排分支）。將來兩處只改一處，本檔其餘測試仍可能全綠，
// 實際 SVG 補排件卻偏移/重疊/消失。本區塊改用真 `computeImposition` 輸出餵真
// `directionInstances`／真 `SectionGroup` 渲染鏈，不手寫 DirectionResult。──────────────────

describe('ImpositionView — production-chain usedW/usedH 一致性（gate round 1 final review review Medium）', () => {
  it('40×20 件／214×134 landscape 四開／allowRotate:true：真 computeImposition→真 directionInstances→真 SectionGroup 全鏈，鎖死 0° 卡 7 模/子紙(28模)＋90° 卡 6 模/子紙(24模)、補排件旋轉方向（0° 卡補件轉 90°／90° 卡補件不轉）、全部 instance 落在子紙 107×67 界內、SVG 序列化無 NaN/Infinity', () => {
    const state: ImpositionState = {
      ...BASE_STATE,
      customW: 214,
      customH: 134,
      orientation: 'landscape',
      cutV: true,
      cutH: true,
      allowRotate: true,
      gripper: 0,
      gap: 3,
    };
    const { container } = render(<ImpositionView result={PRODUCTION_CHAIN_PIECE_RESULT} state={state} onChange={vi.fn()} />);

    const card0 = screen.getByTestId('direction-card-0');
    const card90 = screen.getByTestId('direction-card-90');

    // 卡片文字鎖總數（controller 手算＋獨立 computeImposition 呼叫驗算，見 fixture 註解）。
    expect(card0.textContent).toContain('每四開 7 模 × 4 ＝ 28 模');
    expect(card90.textContent).toContain('每四開 6 模 × 4 ＝ 24 模');

    // ① 兩卡各 4 個 section（四開＝2×2 子紙）。
    const sections0 = within(card0).getAllByTestId('section');
    const sections90 = within(card90).getAllByTestId('section');
    expect(sections0).toHaveLength(4);
    expect(sections90).toHaveLength(4);

    // ② 每 section 的 preview-instance 數一致（同版複製，見 `SectionGroup` docblock）。
    for (const section of sections0) {
      expect(within(section).getAllByTestId('preview-instance')).toHaveLength(7);
    }
    for (const section of sections90) {
      expect(within(section).getAllByTestId('preview-instance')).toHaveLength(6);
    }

    // ③④ 解析每個 instance 的 transform：`PreviewInstance.cellX/cellY` 沒有直接暴露成 DOM
    // 屬性，從 transform 字串的第一個 `translate(x y)` 還原（與 `buildGrid` 寫入的值逐字
    // 相同）；`rotate(90)` 是否存在決定這個 instance 的 cellW/cellH 是否對調（見
    // impositionPreview.ts `buildGrid` docblock）。
    const PIECE_W = 40;
    const PIECE_H = 20;
    const SUBSHEET_W = 107; // sheet.w（cutV+cutH 後的子紙寬，gripper=0 時與 usableW 相同）
    const SUBSHEET_H = 67; // sheet.h（同上，與 usableH 相同）
    const EPS = 1e-6;

    function countRotatedAndCheckBounds(section: HTMLElement): number {
      const instances = within(section).getAllByTestId('preview-instance');
      let rotatedCount = 0;
      for (const inst of instances) {
        const transform = inst.getAttribute('transform') ?? '';
        const originMatch = transform.match(/^translate\(([-\d.]+) ([-\d.]+)\)/);
        expect(originMatch).not.toBeNull();
        const cellX = Number(originMatch![1]);
        const cellY = Number(originMatch![2]);
        const hasRotate = transform.includes('rotate(90)');
        if (hasRotate) rotatedCount++;
        const cellW = hasRotate ? PIECE_H : PIECE_W;
        const cellH = hasRotate ? PIECE_W : PIECE_H;
        expect(cellX + cellW).toBeLessThanOrEqual(SUBSHEET_W + EPS);
        expect(cellY + cellH).toBeLessThanOrEqual(SUBSHEET_H + EPS);
      }
      return rotatedCount;
    }

    for (const section of sections0) {
      // 0° 卡：6 個主格點不轉＋1 個補排件轉 90°（core `pickFillSplit` docblock：補排件永遠是
      // 主格點方向「旋轉 90°」後的 footprint）。
      expect(countRotatedAndCheckBounds(section)).toBe(1);
    }
    for (const section of sections90) {
      // 90° 卡：4 個主格點本身已轉 90°、2 個補排件轉回 0°（跟 0° 卡互補，見同一份 docblock）。
      expect(countRotatedAndCheckBounds(section)).toBe(4);
    }

    // ⑤ SVG 序列化不含 NaN/Infinity（深度防禦：usedW/usedH 算式若有負值/除零污染會流出這裡）。
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });
});
