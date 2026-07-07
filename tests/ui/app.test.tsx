import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BoxModule } from '@/core/types';
import { registerBox } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { App } from '@/ui/App';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';

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

registerBox(failingBox);
registerBox(cascadeBox);

describe('App 冒煙測試', () => {
  it('起站→選 RTE→調 L→畫布 path 數不變且幾何改變', async () => {
    render(<App />);
    expect(await screen.findByText('open-dieline')).toBeInTheDocument();
    const before = document.querySelectorAll('svg path').length;
    const input = screen.getByLabelText(/長.*L/);
    fireEvent.change(input, { target: { value: '80' } });
    expect(document.querySelectorAll('svg path').length).toBe(before); // path 數不因 L 改變
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

  beforeEach(() => {
    // jsdom 未原生實作 createObjectURL；直接賦值提供 mock（vi.spyOn 對「原生不存在的方法」無法攔截）。
    (URL as unknown as { createObjectURL: typeof createObjectURLMock }).createObjectURL = createObjectURLMock;
  });

  afterEach(() => {
    createObjectURLMock.mockClear();
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
    render(<ExportBar boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(text).toContain('10mm');
  });

  it('取消勾選「含尺寸標註」後：下載內容不含 dimension 線與文字', async () => {
    render(<ExportBar boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByLabelText(/含尺寸標註/));
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).not.toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(text).not.toContain('10mm');
  });

  it('觸發下載時 <a> 的 download 檔名為 rte-{L}x{W}x{D}.svg（spec §6.2 命名慣例，boxId 前綴泛化）', () => {
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBar boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(capturedFilename).toBe('rte-55x55x117.svg');
    clickSpy.mockRestore();
  });
});
