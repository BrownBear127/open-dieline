import { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BoxModule, DielinePiece, GenerateResult, ResolvedParams } from '@/core/types';
import { registerBox, _clearRegistry } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { App } from '@/ui/App';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';

// ── 測試專用 harness：ExportBar 的 includeDimensions 改成受控 prop 後（T9 Fix Round 2
// 修復 3，state 提升到 App.tsx），底下「ExportBar：下載內容與 includeDimensions checkbox
// 傳遞」這組既有測試不能再靠 ExportBar 自己的 useState 顯示/切換 checkbox——這裡補一個
// 最小的本地 state 容器，行為等同 App.tsx 實際餵給 ExportBar 的方式，既有測試的互動流程
// （click checkbox → 觀察下載內容）不必改寫。
function ExportBarHarness({
  boxId,
  values,
  result,
  initialIncludeDimensions = true,
  activePiece,
}: {
  boxId: string;
  values: ResolvedParams;
  result: GenerateResult;
  initialIncludeDimensions?: boolean;
  activePiece?: DielinePiece;
}) {
  const [includeDimensions, setIncludeDimensions] = useState(initialIncludeDimensions);
  return (
    <ExportBar
      boxId={boxId}
      values={values}
      result={result}
      includeDimensions={includeDimensions}
      onIncludeDimensionsChange={setIncludeDimensions}
      activePiece={activePiece}
    />
  );
}

// ── 測試專用 fake 盒型 1：不變式恆失敗，驗證警告條渲染（brief Step 1 第二案例指定的手法）──
const failingBox: BoxModule = {
  meta: { id: 'test-fail-box', name: { zh: '測試失敗盒' }, intro: { zh: '' }, topology: 'linear' },
  params: [
    {
      key: 'x',
      label: { zh: 'X 值' },
      unit: 'mm',
      default: 10,
      min: 0,
      max: 100,
      step: 1,
      group: { zh: '測試群組' },
      description: { zh: '測試參數' },
    },
  ],
  invariants: [
    {
      id: 'always-fail',
      description: { zh: '測試用：永遠回報失敗，驗證 App 的警告條渲染路徑' },
      check: () => ({ ok: false, message: { zh: '測試不變式故意失敗：這是警告條文字' }, tags: ['x'] }),
    },
  ],
  generate: () => ({
    paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    texts: [],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  }),
};

// ── 測試專用 fake 盒型 2：D → lid 的 derivedDefault cascade，驗證未覆寫欄位隨上游即時重算顯示 ──
const cascadeBox: BoxModule = {
  meta: { id: 'test-cascade-box', name: { zh: '測試級聯盒' }, intro: { zh: '' }, topology: 'linear' },
  params: [
    {
      key: 'D',
      label: { zh: '深度 (D)' },
      unit: 'mm',
      default: 100,
      min: 0,
      max: 500,
      step: 1,
      group: { zh: '尺寸' },
      description: { zh: '測試參數' },
    },
    {
      key: 'lid',
      label: { zh: '蓋高 (lid)' },
      unit: 'mm',
      default: 0,
      min: 0,
      max: 500,
      step: 1,
      group: { zh: '尺寸' },
      description: { zh: '未覆寫時＝D×0.4，測試 derivedDefault cascade 顯示' },
      derivedDefault: (p) => (p.D as number) * 0.4,
    },
  ],
  invariants: [],
  generate: () => ({
    paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    texts: [],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  }),
};

// ── 測試專用 fake 盒型 3：兩片 pieces（無 liner），驗證全版／單片視圖切換與單片匯出過濾 ──
// 幾何刻意寫死常數（不吃 params），讓片內容/bounds 是可預期的固定值，方便斷言過濾邊界
// （片A：一條水平線＋一個文字標註；片B：一條垂直線、無文字）。
const piecesBox: BoxModule = {
  meta: { id: 'test-pieces-box', name: { zh: '測試多片盒' }, intro: { zh: '' }, topology: 'nested' },
  params: [
    {
      key: 'x',
      label: { zh: 'X 值' },
      unit: 'mm',
      default: 10,
      min: 0,
      max: 100,
      step: 1,
      group: { zh: '測試群組' },
      description: { zh: '測試參數：本盒型幾何寫死常數，這個參數只用來讓盒型有至少一個宣告，generate() 不消費它' },
    },
  ],
  invariants: [],
  generate: () => ({
    paths: [
      { id: 'a-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
      { id: 'b-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 20, x2: 0, y2: 30 }] },
    ],
    texts: [{ id: 'a-t0', x: 5, y: 5, text: 'A標註' }],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 30 },
    pieces: [
      { id: 'piece-a', label: { zh: '片A' }, pathIds: ['a-p0'], textIds: ['a-t0'], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 } },
      { id: 'piece-b', label: { zh: '片B' }, pathIds: ['b-p0'], textIds: [], bounds: { minX: 0, maxX: 0, minY: 20, maxY: 30 } },
    ],
  }),
};

registerBox(failingBox);
registerBox(cascadeBox);
registerBox(piecesBox);

describe('App 冒煙測試', () => {
  it('起站→選 RTE→調 L→畫布 path 數不變且幾何改變', async () => {
    render(<App />);
    expect(await screen.findByText('open-dieline')).toBeInTheDocument();
    const before = document.querySelectorAll('svg path').length;
    const dBefore = Array.from(document.querySelectorAll('svg path')).map((el) => el.getAttribute('d'));
    const input = screen.getByLabelText(/長.*L/);
    fireEvent.change(input, { target: { value: '80' } });
    expect(document.querySelectorAll('svg path').length).toBe(before); // path 數不因 L 改變
    const dAfter = Array.from(document.querySelectorAll('svg path')).map((el) => el.getAttribute('d'));
    expect(dAfter).not.toEqual(dBefore); // 幾何隨 L 改變（d 屬性不同於改變前）
  });

  it('不變式 not-ok 顯示警告條（fake registry entry 注入必敗 invariant）', async () => {
    render(<App />);
    const select = screen.getByLabelText(/盒型/);
    fireEvent.change(select, { target: { value: 'test-fail-box' } });
    expect(await screen.findByText('測試不變式故意失敗：這是警告條文字')).toBeInTheDocument();
  });

  it('derivedDefault：未覆寫欄位隨上游參數即時重算顯示（顯示值＝生成值，spec §3.3）', async () => {
    render(<App />);
    const select = screen.getByLabelText(/盒型/);
    fireEvent.change(select, { target: { value: 'test-cascade-box' } });

    const lidInput = (await screen.findByLabelText(/蓋高.*lid/i)) as HTMLInputElement;
    expect(Number(lidInput.value)).toBeCloseTo(100 * 0.4); // D 預設 100 → lid 顯示 40（未覆寫）

    const dInput = screen.getByLabelText(/深度.*D/) as HTMLInputElement;
    fireEvent.change(dInput, { target: { value: '200' } });

    expect(Number(lidInput.value)).toBeCloseTo(200 * 0.4); // lid 仍未覆寫，隨 D 即時重算為 80
  });

  // ── Slice 2 Task 6 規格點 4：derivedDefault auto/manual 回歸，用真實 RTE 案例補斷言
  // （機制本身是 Slice 1 useParams 既有行為，這裡不是在測新程式碼，是把「thickness→
  // tuckClearance」這組真實生產參數的 cascade 釘成回歸測試，跟上面用假盒型驗證泛用機制互補）。
  it('RTE 真實案例：調整紙厚→插舌內縮顯示值跟動；手動覆寫插舌內縮後，紙厚變動不再洗掉覆寫值', async () => {
    render(<App />);
    const thicknessInput = screen.getByLabelText(/紙厚/) as HTMLInputElement;
    const tuckClearanceInput = screen.getByLabelText(/插舌內縮/) as HTMLInputElement;

    expect(Number(thicknessInput.value)).toBeCloseTo(0.3); // RTE 預設紙厚
    expect(Number(tuckClearanceInput.value)).toBeCloseTo(0.8); // derivedDefault = 0.5 + thickness，未覆寫

    fireEvent.change(thicknessInput, { target: { value: '0.5' } });
    expect(Number(tuckClearanceInput.value)).toBeCloseTo(1.0); // 仍未覆寫，隨紙厚即時重算 = 0.5 + 0.5

    fireEvent.change(tuckClearanceInput, { target: { value: '3' } }); // 手動覆寫
    expect(Number(tuckClearanceInput.value)).toBeCloseTo(3);

    fireEvent.change(thicknessInput, { target: { value: '0.6' } });
    expect(Number(tuckClearanceInput.value)).toBeCloseTo(3); // 已覆寫，紙厚再變動也不被洗掉
  });

  it('覆寫參數後顯示「↺」重設鈕，點擊後恢復未覆寫的顯示值', async () => {
    render(<App />);
    const input = screen.getByLabelText(/長.*L/) as HTMLInputElement;
    expect(input.value).toBe('55'); // RTE 預設 L=55
    fireEvent.change(input, { target: { value: '80' } });
    expect(input.value).toBe('80');

    const resetBtn = await screen.findByRole('button', { name: /重設.*長度/ });
    fireEvent.click(resetBtn);
    expect(input.value).toBe('55'); // 恢復預設
  });

  // ── T9 Fix Round 2 修復 3：includeDimensions state 提升到 App.tsx，畫布同步 ──
  //
  // 根因：ExportBar 原本自己 useState 管這顆 checkbox，只影響下載的 SVG；畫布
  // （Canvas.tsx）完全不知道這個 state 存在，永遠畫出尺寸標註，取消勾選對畫布無效。
  it('取消勾選「含尺寸標註」後畫布 dimension path 與文字消失；重新勾選後恢復', async () => {
    render(<App />);
    await screen.findByText('open-dieline');

    const checkbox = screen.getByLabelText(/含尺寸標註/) as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // 預設勾選

    const dimStrokeSelector = `svg path[stroke="${LINE_STYLES.dimension.stroke}"]`;
    expect(document.querySelectorAll(dimStrokeSelector).length).toBeGreaterThan(0); // 預設畫布有 dimension 線
    expect(document.querySelectorAll('svg text').length).toBeGreaterThan(0); // 預設畫布有標註文字

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(document.querySelectorAll(dimStrokeSelector).length).toBe(0); // 取消勾選後 dimension path 消失
    expect(document.querySelectorAll('svg text').length).toBe(0); // 文字也消失

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(document.querySelectorAll(dimStrokeSelector).length).toBeGreaterThan(0); // 重新勾選後恢復
    expect(document.querySelectorAll('svg text').length).toBeGreaterThan(0);
  });
});

describe('Canvas 高亮疊加', () => {
  it('highlightTags 命中的 path 疊加亮色描邊（#FF6B00），未命中的不受影響', () => {
    const result = {
      paths: [
        { id: 'p-L', type: 'cut' as const, tags: ['L'], segments: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 10, y2: 0 }] },
        { id: 'p-W', type: 'cut' as const, tags: ['W'], segments: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 0, y2: 10 }] },
      ],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const { container } = render(<Canvas result={result} highlightTags={['L']} invariantWarnings={[]} />);
    expect(container.querySelectorAll('path[stroke="#FF6B00"]').length).toBe(1); // 只有 tag=L 的 path 疊加高亮
  });

  it('不變式警告的 tags 併入高亮集合（與 hover 高亮同一機制，聯集）', () => {
    const result = {
      paths: [{ id: 'p-x', type: 'cut' as const, tags: ['x'], segments: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const { container } = render(
      <Canvas result={result} highlightTags={null} invariantWarnings={[{ message: { zh: '警告' }, tags: ['x'] }]} />,
    );
    expect(container.querySelectorAll('path[stroke="#FF6B00"]').length).toBe(1); // 沒有 hover，純由警告 tags 觸發高亮
  });

  it('無警告時不顯示警告條；有警告時顯示 message.zh', () => {
    const result = {
      paths: [{ id: 'p-0', type: 'cut' as const, segments: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const { rerender, queryByText } = render(<Canvas result={result} highlightTags={null} invariantWarnings={[]} />);
    expect(queryByText(/警告/)).not.toBeInTheDocument();

    rerender(<Canvas result={result} highlightTags={null} invariantWarnings={[{ message: { zh: '幾何超出範圍警告' } }]} />);
    expect(queryByText('幾何超出範圍警告')).toBeInTheDocument();
  });
});

describe('ExportBar：下載內容與 includeDimensions checkbox 傳遞', () => {
  // 明確標註參數型別為 Blob（即使實作忽略它）：讓 `.mock.calls[0][0]` 型別正確推斷成 Blob，
  // 而不是從「忽略參數」的箭頭函式推斷出空 tuple `[]`（那樣下面讀 `calls[0]![0]` 會型別錯誤）。
  const createObjectURLMock = vi.fn((_blob: Blob) => 'blob:mock-url');
  // revokeObjectURL 同步 stub 成 mock：即使目前這個 jsdom 版本原生就有 revokeObjectURL
  // （不像 createObjectURL 那樣完全未實作），也要換成 vi.fn() 才能斷言「確實被呼叫、
  // 且參數等於 createObjectURL 回傳的同一個 url」——這是驗證 blob URL 洩漏修復本身，
  // 不只是「呼叫時不會炸」。
  const revokeObjectURLMock = vi.fn((_url: string) => undefined);

  beforeEach(() => {
    // jsdom 未原生實作 createObjectURL；直接賦值提供 mock（vi.spyOn 對「原生不存在的方法」無法攔截）。
    (URL as unknown as { createObjectURL: typeof createObjectURLMock }).createObjectURL = createObjectURLMock;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURLMock }).revokeObjectURL = revokeObjectURLMock;
  });

  afterEach(() => {
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
  });

  const result = {
    paths: [
      { id: 'p-0', type: 'cut' as const, segments: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 10, y2: 0 }] },
      { id: 'p-1', type: 'dimension' as const, segments: [{ kind: 'line' as const, x1: 0, y1: 5, x2: 10, y2: 5 }] },
    ],
    texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  };
  const values = { L: 55, W: 55, D: 117 };

  it('預設勾選「含尺寸標註」：下載內容含 dimension 線與文字', async () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(text).toContain('10mm');
  });

  it('取消勾選「含尺寸標註」後：下載內容不含 dimension 線與文字', async () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByLabelText(/含尺寸標註/));
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).not.toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(text).not.toContain('10mm');
  });

  it('下載後 revoke 建立的 object URL（避免每次下載都洩漏一個 blob URL）', () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url'); // revoke 的必須是同一個 createObjectURL 回傳的 url
  });

  it('觸發下載時 <a> 的 download 檔名為 rte-{L}x{W}x{D}.svg（spec §6.2 命名慣例，boxId 前綴泛化）', () => {
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(capturedFilename).toBe('rte-55x55x117.svg');
    clickSpy.mockRestore();
  });
});

describe('Canvas：pieces 全版／單片視圖切換（Slice 2 Task 6，spec §4.2）', () => {
  it('result.pieces 存在時顯示「全版」＋按 pieces 序排列的各片按鈕；RTE（pieces undefined）不顯示', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    // 預設盒型是 RTE：pieces undefined，不該出現任何切換按鈕。
    expect(screen.queryByRole('button', { name: '全版' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-pieces-box' } });

    expect(await screen.findByRole('button', { name: '全版' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /^(全版|片A|片B)$/ });
    expect(buttons.map((b) => b.textContent)).toEqual(['全版', '片A', '片B']); // 全版固定第一，其後照 pieces 陣列序
  });

  it('點選單片按鈕後，畫布只渲染該片的 paths/texts（依 pathIds/textIds 集合過濾，非猜測 index）', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-pieces-box' } });
    await screen.findByRole('button', { name: '全版' });

    // 全版：2 條 path（a-p0/b-p0）＋ 1 個 text（屬於片A 的 a-t0）。
    expect(document.querySelectorAll('svg path').length).toBe(2);
    expect(screen.getByText('A標註')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '片A' }));
    expect(document.querySelectorAll('svg path').length).toBe(1); // 只剩 a-p0
    expect(screen.getByText('A標註')).toBeInTheDocument(); // a-t0 屬於片A，仍在

    fireEvent.click(screen.getByRole('button', { name: '片B' }));
    expect(document.querySelectorAll('svg path').length).toBe(1); // 只剩 b-p0
    expect(screen.queryByText('A標註')).not.toBeInTheDocument(); // a-t0 屬於片A 不屬於片B，應消失

    fireEvent.click(screen.getByRole('button', { name: '全版' }));
    expect(document.querySelectorAll('svg path').length).toBe(2); // 切回全版，恢復兩片內容
    expect(screen.getByText('A標註')).toBeInTheDocument();
  });

  it('單片視圖 viewBox 用該片 bounds 外加邊距；全版視圖仍是 result.bounds 原值、不加邊距', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-pieces-box' } });
    await screen.findByRole('button', { name: '全版' });

    const svg = document.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 30'); // 全版：result.bounds 原值，無邊距

    fireEvent.click(screen.getByRole('button', { name: '片A' }));
    // 片A bounds={minX:0,maxX:10,minY:0,maxY:5}，PIECE_VIEW_PADDING=20 外擴：
    // viewBox = "-20 -20 50 45"（width=10+2*20=50, height=5+2*20=45）
    expect(svg.getAttribute('viewBox')).toBe('-20 -20 50 45');
  });

  it('切換盒型時視圖重置回全版：選片後切走再切回，不殘留舊 pieceId（規格點 6）', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-pieces-box' } });
    await screen.findByRole('button', { name: '全版' });

    fireEvent.click(screen.getByRole('button', { name: '片A' }));
    expect(screen.getByRole('button', { name: '片A' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'rte' } });
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-pieces-box' } });

    await screen.findByRole('button', { name: '全版' });
    expect(screen.getByRole('button', { name: '全版' })).toHaveAttribute('aria-pressed', 'true'); // 重置回全版
    expect(screen.getByRole('button', { name: '片A' })).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelectorAll('svg path').length).toBe(2); // 全版內容，非殘留片A 的過濾內容
  });
});

describe('ExportBar：pieces 存在時的「匯出目前視圖」（全版＋單片，Slice 2 Task 6）', () => {
  const createObjectURLMock = vi.fn((_blob: Blob) => 'blob:mock-url-pieces');
  const revokeObjectURLMock = vi.fn((_url: string) => undefined);

  beforeEach(() => {
    (URL as unknown as { createObjectURL: typeof createObjectURLMock }).createObjectURL = createObjectURLMock;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURLMock }).revokeObjectURL = revokeObjectURLMock;
  });

  afterEach(() => {
    createObjectURLMock.mockClear();
    revokeObjectURLMock.mockClear();
  });

  const piecesResult: GenerateResult = {
    paths: [
      { id: 'a-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
      { id: 'b-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 20, x2: 0, y2: 30 }] },
    ],
    texts: [{ id: 'a-t0', x: 5, y: 5, text: 'A標註' }],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 30 },
    pieces: [
      { id: 'piece-a', label: { zh: '片A' }, pathIds: ['a-p0'], textIds: ['a-t0'], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 } },
      { id: 'piece-b', label: { zh: '片B' }, pathIds: ['b-p0'], textIds: [], bounds: { minX: 0, maxX: 0, minY: 20, maxY: 30 } },
    ],
  };
  const values = { x: 10 };

  it('pieces 存在時按鈕文字為「匯出目前視圖」（不是「下載 SVG」）', () => {
    render(<ExportBarHarness boxId="test-pieces-box" values={values} result={piecesResult} />);
    expect(screen.getByRole('button', { name: '匯出目前視圖' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下載 SVG' })).not.toBeInTheDocument();
  });

  it('全版視圖（activePiece 未傳）匯出內容含兩片全部 paths/texts——與既有整版行為相同', async () => {
    render(<ExportBarHarness boxId="test-pieces-box" values={values} result={piecesResult} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).toContain('M0.00,0.00 L10.00,0.00'); // a-p0
    expect(text).toContain('M0.00,20.00 L0.00,30.00'); // b-p0
    expect(text).toContain('A標註');
  });

  it('單片視圖（activePiece=片A）匯出內容只含該片 paths/texts，不含片B', async () => {
    const pieceA = piecesResult.pieces![0]!;
    render(<ExportBarHarness boxId="test-pieces-box" values={values} result={piecesResult} activePiece={pieceA} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).toContain('M0.00,0.00 L10.00,0.00'); // a-p0 仍在
    expect(text).toContain('A標註');
    expect(text).not.toContain('M0.00,20.00 L0.00,30.00'); // b-p0 不該出現
  });

  it('單片匯出檔名為 {boxId}-{pieceId}-{L}x{W}.svg（L/W 取片 bounds 尺寸，fmt 2 位小數）', () => {
    const pieceA = piecesResult.pieces![0]!; // bounds {minX:0,maxX:10,minY:0,maxY:5} → L=10.00 W=5.00
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="test-pieces-box" values={values} result={piecesResult} activePiece={pieceA} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    expect(capturedFilename).toBe('test-pieces-box-piece-a-10.00x5.00.svg');
    clickSpy.mockRestore();
  });
});

describe('useParams：切換盒型時不因殘留 overrides 而 crash（final review 雙 reviewer 獨立重現）', () => {
  // 第二個測試盒型：故意只宣告 x 一個參數（不含 L/W/D），確保從 RTE 切過來時，
  // RTE 殘留的 overrides（如 {L: 80}）一定踩到「新盒型未宣告該 key」分支——
  // 逼出 useParams.ts 的 useMemo 在切盒當輪、trackedBoxId 尚未同步前，
  // 用「新 mod ＋ 舊 overrides」呼叫 resolveParams 而擲錯的 bug（render-phase reset
  // 要下一輪才生效，這一輪本身需要 guard，見 useParams.ts 內對應註解）。
  const tinyBox: BoxModule = {
    meta: { id: 'test-tiny-box', name: { zh: '測試極簡盒' }, intro: { zh: '' }, topology: 'linear' },
    params: [
      {
        key: 'x',
        label: { zh: 'X 值' },
        unit: 'mm',
        default: 1,
        min: 0,
        max: 100,
        step: 1,
        group: { zh: '測試群組' },
        description: { zh: '測試參數：故意只宣告 x，不含 L/W/D，用來踩到「切盒後 overrides 殘留」分支' },
      },
    ],
    invariants: [],
    generate: () => ({
      paths: [{ id: 'p-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    }),
  };

  registerBox(tinyBox);

  afterEach(() => {
    // registry 是模組層級全域 Map；本 describe 額外註冊了 tinyBox，用完清空避免殘留。
    // 清空後 RTE 不會因為重新 import 就恢復註冊（ES module cache——reverseTuckEnd.ts
    // 頂層的 registerBox(reverseTuckEnd) 只在模組第一次載入時執行過一次），這裡直接用
    // 已在記憶體中的 reverseTuckEnd 物件手動呼叫 registerBox() 補回。telescope 同一道理
    // 也要補回（Slice 2 Task 6 新增：本 describe 後面的「RTE↔telescope 真雙盒」測試需要
    // telescope 存在於 registry——這個 afterEach 在同一個 describe 內每個 it() 之後都會跑，
    // 若不補回，第一個測試跑完就把 telescope 清掉了，後面的測試會在還沒進到它們自己的
    // 斷言之前就先讀到「telescope 未註冊」）。本 describe 是檔案最後一個 block，此後沒有
    // 測試依賴 registry 狀態，此舉純粹是測試衛生。
    _clearRegistry();
    registerBox(reverseTuckEnd);
    registerBox(telescope);
  });

  it('改 override 後切換盒型不 crash：新盒型正常渲染其自身參數', async () => {
    render(<App />);
    const input = screen.getByLabelText(/長.*L/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '80' } }); // 製造 RTE 的殘留 override {L: 80}

    const select = screen.getByLabelText(/盒型/);
    expect(() => {
      fireEvent.change(select, { target: { value: 'test-tiny-box' } });
    }).not.toThrow();

    expect(await screen.findByLabelText(/X 值/)).toBeInTheDocument();
  });

  // ── Slice 2 Task 6 規格點 5：Slice 1 這條切盒 guard 只用過假盒型（tinyBox）驗證過，這裡
  // 換成真正的兩個已註冊盒型（RTE／telescope）雙向切換，是這條 guard 第一次在真實雙盒場景
  // 下被實戰驗證——telescope 透過 App.tsx 頂部的 side-effect import 在模組載入時就已註冊，
  // 不需要額外 registerBox()。
  it('RTE↔telescope 真雙盒雙向切換不 crash，天地盒的視圖切換按鈕正確渲染（首次雙盒實戰）', async () => {
    render(<App />);
    expect(screen.getByLabelText(/長.*L/)).toBeInTheDocument(); // 起始為 RTE

    const select = screen.getByLabelText(/盒型/);
    expect(() => {
      fireEvent.change(select, { target: { value: 'telescope' } });
    }).not.toThrow();

    expect(await screen.findByLabelText(/下盒長度/)).toBeInTheDocument(); // telescope 專屬參數出現
    // telescope 預設 linerEnabled=true → pieces=[base,lid,liner]，切換按鈕依序：全版/下盒/上蓋/內襯
    const switchButtons = screen.getAllByRole('button', { name: /^(全版|下盒|上蓋|內襯)$/ });
    expect(switchButtons.map((b) => b.textContent)).toEqual(['全版', '下盒', '上蓋', '內襯']);

    expect(() => {
      fireEvent.change(select, { target: { value: 'rte' } });
    }).not.toThrow();
    expect(await screen.findByLabelText(/長.*L/)).toBeInTheDocument(); // 切回 RTE，參數面板正確重置
    expect(screen.queryByRole('button', { name: '全版' })).not.toBeInTheDocument(); // RTE 無切換按鈕
  });

  it('天地盒選定單片後切走再切回，視圖重置回全版（不殘留舊 pieceId，規格點 6 真盒版）', async () => {
    render(<App />);
    const select = screen.getByLabelText(/盒型/);
    fireEvent.change(select, { target: { value: 'telescope' } });
    await screen.findByRole('button', { name: '內襯' });

    fireEvent.click(screen.getByRole('button', { name: '內襯' }));
    expect(screen.getByRole('button', { name: '內襯' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(select, { target: { value: 'rte' } });
    fireEvent.change(select, { target: { value: 'telescope' } });

    expect(await screen.findByRole('button', { name: '全版' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '內襯' })).toHaveAttribute('aria-pressed', 'false');
  });
});
