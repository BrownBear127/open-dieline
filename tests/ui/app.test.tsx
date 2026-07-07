import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BoxModule } from '@/core/types';
import { registerBox, _clearRegistry } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { App } from '@/ui/App';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';

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

  it('下載後 revoke 建立的 object URL（避免每次下載都洩漏一個 blob URL）', () => {
    render(<ExportBar boxId="rte" values={values} result={result} />);
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
    render(<ExportBar boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(capturedFilename).toBe('rte-55x55x117.svg');
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
    // 已在記憶體中的 reverseTuckEnd 物件手動呼叫 registerBox() 補回。本 describe 是
    // 檔案最後一個 block，此後沒有測試依賴 registry 狀態，此舉純粹是測試衛生。
    _clearRegistry();
    registerBox(reverseTuckEnd);
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
});
