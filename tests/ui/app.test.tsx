import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BoxModule, DielinePiece, GenerateResult, ResolvedParams } from '@/core/types';
import { registerBox, _clearRegistry, resolveParams } from '@/core/registry';
import { LINE_STYLES } from '@/core/styles';
import { App } from '@/ui/App';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { telescope } from '@/boxes/telescope';
import { OVERLAY_STROKE } from '@/overlay/state';
import { parseOverlaySvg } from '@/overlay/parse';
import { createOverlayLayer } from '@/overlay/layers';
import { manufacturingBounds } from '@/export/svg';
// T1 的 parseDxf 原本 export 於 tests/export/dxf.test.ts，供本檔重用、不重寫解析器；但靜態
// import 一個 *.test.ts 檔案會連帶重新執行它自己頂層的 describe（Vitest globals 模式下
// `describe`/`it` 是模組執行當下綁定的全域）——下面「ExportBar：下載 DXF」那組測試跑起來時，
// dxf.test.ts 自己的 12 個測試會在本檔案的測試報告裡「重複」出現一次（review F1，總數虛報
// 429，實際 417；兩邊斷言完全一致、無 flake，但重複執行本身就是缺陷，不該留著）。
// 修法：parseDxf（含型別）搬到 tests/export/dxf-helpers.ts——非 .test.ts 命名，Vitest 預設
// include glob 不會收集成測試檔，兩邊 import 都只拿函式本身、不再連帶重跑任何 describe。
import { parseDxf } from '../export/dxf-helpers';

// ── 測試專用 harness：Slice 3 gate round 1 T2 起，ExportBar 的 includeDimensions props 退役
// （匯出恆全量，見 plan「匯出恆全量」裁決）——這個 harness 本身不再需要管理任何額外 state，
// 純粹是為了讓下面既有測試維持同一種呼叫寫法（<ExportBarHarness boxId=... values=... .../>），
// 不必逐一改成直接呼叫 <ExportBar>，減少本次改動的差異噪音。
function ExportBarHarness({
  boxId,
  values,
  result,
  activePiece,
}: {
  boxId: string;
  values: ResolvedParams;
  result: GenerateResult;
  activePiece?: DielinePiece;
}) {
  return <ExportBar boxId={boxId} values={values} result={result} activePiece={activePiece} />;
}

// ── 測試專用 fake 盒型 1：不變式恆失敗，驗證警告條渲染（spec Step 1 第二案例指定的手法）──
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

// ── 測試專用 fake 盒型 4（FX3/FX5 回歸，Slice 3 final review）：無 pieces、無 L/W/D 宣告
// key，cut 幾何很小，但一條 dimension 線外擴出遠大於 cut hull 的 bounds——用來驗證①疊圖
// 快速對齊改用「製造 bounds」而非含標註外擴的 result.bounds（FX3）②全版檔名 fallback
// （無 L/W/D 時）同樣改用製造 bounds（FX5）。cut hull（唯一非 dimension path）＝
// x∈[0,20]、y∈[0,10]；宣告的 bounds 依三向等式含 dimension 外擴到 x∈[-30,50]、y∈[-30,40]
// （寬 80×高 70，若修前行為直接用 bounds 會得到這組偏大很多的數字）。
const dimBoundsBox: BoxModule = {
  meta: { id: 'test-dim-bounds-box', name: { zh: '測試標註外擴盒' }, intro: { zh: '' }, topology: 'linear' },
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
      description: { zh: '測試參數：本盒型幾何寫死常數，generate() 不消費它' },
    },
  ],
  invariants: [],
  generate: () => ({
    paths: [
      {
        id: 'cut-0',
        type: 'cut',
        segments: [
          { kind: 'line', x1: 0, y1: 0, x2: 20, y2: 0 },
          { kind: 'line', x1: 20, y1: 0, x2: 20, y2: 10 },
        ],
      },
      // 模擬尺寸標註線外擴出遠大於 cut hull 的包絡（同 Slice 2 FX3 教訓的現象，這裡刻意
      // 放大差距讓斷言不必依賴接近浮點誤差的容差）。
      { id: 'dim-0', type: 'dimension', segments: [{ kind: 'line', x1: -30, y1: -30, x2: 50, y2: 40 }] },
    ],
    texts: [],
    bounds: { minX: -30, maxX: 50, minY: -30, maxY: 40 }, // 依三向等式，含 dimension 的全幾何 hull
  }),
};

// ── 測試專用 fake 盒型 5（F3 review 修復回歸，2026-07-09）：只有 cut path＋texts，沒有任何
// dimension/annotation/bleed 路徑——用來驗證「尺寸標註」生成圖層列的 disabled 判斷必須同時看
// result.texts，不能只看 result.paths（v1 現實中標註線與文字成對出現、這個組合本身不可達，
// 這裡純粹證明 generatedHasContent 的邏輯本身正確，不依賴巧合）。
const textsOnlyBox: BoxModule = {
  meta: { id: 'test-texts-only-box', name: { zh: '測試純文字標註盒' }, intro: { zh: '' }, topology: 'linear' },
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
      description: { zh: '測試參數：本盒型幾何寫死常數，generate() 不消費它' },
    },
  ],
  invariants: [],
  generate: () => ({
    paths: [{ id: 'cut-0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
    texts: [{ id: 't-0', x: 5, y: 5, text: '10mm' }],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
  }),
};

registerBox(failingBox);
registerBox(cascadeBox);
registerBox(dimBoundsBox);
registerBox(piecesBox);
registerBox(textsOnlyBox);

// ─────────────────────────────────────────────────────────────────────────
// 全域測試 hook（v0.2.0 宣告視窗 AnnouncementModal）：預設 localStorage 為「已關閉」，
// 讓下面所有既有測試在 render(<App />) 時 modal 不會自動彈出。這不只是視覺上的乾淨——
// modal 標題文字本身就是「open-dieline」，跟 App.tsx 側欄 h1 完全同名；若 modal 同時
// 掛載，「App 冒煙測試」第一個 it 的 `screen.findByText('open-dieline')`（單數，預期
// 唯一匹配）會因為比對到兩個元素而丟出 multiple-elements 錯誤，其餘既有測試也可能因為
// 畫布/按鈕查詢意外撞名而變成假紅——這正是這個 describe 之外沒有其他測試特別处理
// localStorage 的原因：不處理的話不是「modal 蓋住看不到」（jsdom 沒有真實 layout，
// fireEvent 不做 hit-test），而是 DOM 查詢直接撞名報錯。
// AnnouncementModal 自己的行為測試（見檔案最後一個 describe）在各自的 it() 內用
// localStorage.clear()／setItem 覆寫這個預設，測完交給下面的 afterEach 收尾，
// 不會污染後續測試。
// ─────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
});

afterEach(() => {
  localStorage.clear();
});

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

  // ── Slice 3 gate round 1 T2：includeDimensions checkbox 退役，由 LayersPanel 的「尺寸標註」
  // 生成圖層可見性取代（T9 Fix Round 2 修復 3 的回歸測試改寫為圖層語意）──
  //
  // 根因（T9 當時）：ExportBar 原本自己 useState 管這顆 checkbox，只影響下載的 SVG；畫布
  // （Canvas.tsx）完全不知道這個 state 存在，永遠畫出尺寸標註，取消勾選對畫布無效。這條
  // 「畫布必須跟顯示開關同步」的驗收條件延續到新的圖層可見性機制，只是控制項換成
  // LayersPanel 的「尺寸標註」checkbox（generatedVisible.dimensions）。
  it('關閉「尺寸標註」生成圖層後畫布 dimension path 與文字消失；重新開啟後恢復', async () => {
    render(<App />);
    await screen.findByText('open-dieline');

    const checkbox = screen.getByLabelText('尺寸標註') as HTMLInputElement;
    expect(checkbox.checked).toBe(true); // 預設全開

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

  it('關閉「切割線」生成圖層後畫布 cut 樣式 path 消失、不影響 crease／dimension（驗證圖層過濾對四桶皆通用，非只認 dimensions 這一桶）', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    const cutSelector = `svg path[stroke="${LINE_STYLES.cut.stroke}"]`;
    const creaseSelector = `svg path[stroke="${LINE_STYLES.crease.stroke}"]`;
    expect(document.querySelectorAll(cutSelector).length).toBeGreaterThan(0);
    expect(document.querySelectorAll(creaseSelector).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('切割線'));

    expect(document.querySelectorAll(cutSelector).length).toBe(0);
    expect(document.querySelectorAll(creaseSelector).length).toBeGreaterThan(0); // 不受影響
  });
});

describe('LayersPanel：生成圖層四列恆定顯示（cut/crease/halfcut/dimensions，Slice 3 gate round 1 T2）', () => {
  it('RTE（無 halfcut paths，見 reverse-tuck-end.ts 未使用 halfcut 線型）：halfcut 列 disabled 且 title 為「此盒型無半刀線」；其餘三列 enabled', async () => {
    render(<App />);
    await screen.findByText('open-dieline');

    const halfcutCheckbox = screen.getByLabelText('半刀') as HTMLInputElement;
    expect(halfcutCheckbox).toBeDisabled();
    expect(halfcutCheckbox.closest('label')).toHaveAttribute('title', '此盒型無半刀線');

    expect(screen.getByLabelText('切割線')).not.toBeDisabled();
    expect(screen.getByLabelText('摺線')).not.toBeDisabled();
    expect(screen.getByLabelText('尺寸標註')).not.toBeDisabled();
  });

  it('telescope（tray.ts 舌摺線中段有 halfcut）：halfcut 列 enabled，非恆定 disabled', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    await screen.findByLabelText(/下盒長度/);

    expect(screen.getByLabelText('半刀')).not.toBeDisabled();
  });

  it('F3：盒型有 texts 但無任何 dimension/annotation path 時，「尺寸標註」列仍 enabled（disabled 判斷需同時看 result.texts，非只看 result.paths；review finding，2026-07-09）', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'test-texts-only-box' } });
    await screen.findByLabelText(/X 值/);

    expect(screen.getByLabelText('尺寸標註')).not.toBeDisabled();
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

// ─────────────────────────────────────────────────────────────────────────
// T7 樣張 gate 第一輪維護者反饋修 3（2026-07-09）：多片盒型（天地盒）auto-fit 預設縮放 130%，
// RTE（單片）維持 1.0×fit 不變。jsdom 沒有真實 layout，containerRef 的 clientWidth/
// clientHeight 恆為 0——`computeFitScale` 因此對任何 bounds 都會被 MIN_SCALE 夾住（見
// Canvas.tsx computeFitScale：availableW/H 用 Math.max(0-FIT_PADDING,1)=1，newScale 遠小於
// MIN_SCALE），兩個盒型的「原始 fit scale」在這個測試環境下都收斂到同一個 MIN_SCALE 值，
// 剛好適合拿來驗證「倍率」本身：telescope 最終 scale ÷ RTE 最終 scale 應恰為 1.3。
// ─────────────────────────────────────────────────────────────────────────

describe('Canvas：多片盒型初始縮放 130%（T7 gate 反饋修 3）', () => {
  /** 從 svg 的 inline style.transform（"translate(...) scale(N)"）讀出目前的 scale 值。 */
  function readScale(svg: Element): number {
    const transform = (svg as HTMLElement).style.transform;
    const match = /scale\(([-\d.]+)\)/.exec(transform);
    if (!match) throw new Error(`readScale: 找不到 svg transform 裡的 scale(...)（實際值：${transform}）`);
    return parseFloat(match[1]!);
  }

  it('telescope（多片盒型，pieces 存在）掛載後初始 zoom＝RTE（單片，pieces undefined）的 1.3 倍', async () => {
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const telescopeResult = telescope.generate(resolveParams(telescope));
    expect(telescopeResult.pieces, 'sanity：telescope 應為多片盒型').toBeDefined();
    expect(rteResult.pieces, 'sanity：RTE 應為單片盒型').toBeUndefined();

    const { container: rteContainer } = render(<Canvas result={rteResult} highlightTags={null} invariantWarnings={[]} />);
    const { container: telescopeContainer } = render(<Canvas result={telescopeResult} highlightTags={null} invariantWarnings={[]} />);

    // mount 的 auto-fit 走 setTimeout(100ms)；等到 scale 從初始值 1 變動後再讀值。
    await waitFor(() => expect(readScale(rteContainer.querySelector('svg')!)).not.toBe(1));
    await waitFor(() => expect(readScale(telescopeContainer.querySelector('svg')!)).not.toBe(1));

    const rteScale = readScale(rteContainer.querySelector('svg')!);
    const telescopeScale = readScale(telescopeContainer.querySelector('svg')!);

    expect(rteScale, 'RTE 仍是 1.0×fit（不受 T7 修 3 影響）').toBeCloseTo(0.05, 6); // jsdom 下 fit 恆被夾在 MIN_SCALE=0.05
    expect(telescopeScale / rteScale, 'telescope＝RTE 的 1.3 倍（同一份 computeFitScale，只差 multiplier）').toBeCloseTo(1.3, 5);
  });
});

describe('ExportBar：下載內容恆含尺寸標註（includeDimensions checkbox 已於 Slice 3 gate round 1 T2 退役，plan 裁決「匯出恆全量」——畫布圖層可見性純顯示，不影響匯出）', () => {
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

  it('下載內容恆含 dimension 線與文字（無 checkbox 可關閉；T4 才接手依圖層分 g 分組）', async () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    const text = await blob.text();
    expect(text).toContain(`stroke="${LINE_STYLES.dimension.stroke}"`);
    expect(text).toContain('10mm');
  });

  it('ExportBar 不再渲染「含尺寸標註」checkbox（props/UI 一併退役）', () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    expect(screen.queryByLabelText(/含尺寸標註/)).not.toBeInTheDocument();
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

  it('FX5：無 L/W/D 盒型的全版檔名 fallback 排除標註外擴，改用製造 bounds（cut hull 20×10，非含 dimension 的 bounds 80×70；Slice 2 FX3 當時只修了單片，這裡補上全版 fallback）', () => {
    const dimParams = resolveParams(dimBoundsBox);
    const dimResult = dimBoundsBox.generate(dimParams);
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="test-dim-bounds-box" values={dimParams} result={dimResult} />);
    fireEvent.click(screen.getByRole('button', { name: /下載 SVG/ }));
    // 製造 bounds（排除 dim-0）＝cut hull：x∈[0,20]、y∈[0,10] → 20.00×10.00；
    // 修前行為（直接用 result.bounds，含 dimension 外擴至 [-30,50]x[-30,40]）會得到 80.00×70.00。
    expect(capturedFilename).toBe('test-dim-bounds-box-20.00x10.00.svg');
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

  it('單片匯出檔名為 {boxId}-{pieceId}-{L}x{W}.svg（L/W 取片非 dimension paths 的 hull，fmt 2 位小數；FX3 修正後 pieceA 的 path 是水平線，height=0）', () => {
    const pieceA = piecesResult.pieces![0]!; // bounds {minX:0,maxX:10,minY:0,maxY:5}——maxY=5 其實來自 a-t0 文字座標，不是幾何本身
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="test-pieces-box" values={values} result={piecesResult} activePiece={pieceA} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    // FX3 修前：直接用 piece.bounds（含 a-t0 文字帶出的 maxY=5）→ 'test-pieces-box-piece-a-10.00x5.00.svg'。
    // FX3 修後：只量非 dimension 的 path 幾何（唯一成員 a-p0 是 y=0 的水平線）→ height=0。
    expect(capturedFilename).toBe('test-pieces-box-piece-a-10.00x0.00.svg');
    clickSpy.mockRestore();
  });

  it('FX3：piece.bounds 因含尺寸標註線而外擴時，檔名改用非 dimension paths 的 hull，不再把標註延伸算進去', () => {
    const pieceWithDim: GenerateResult = {
      paths: [
        {
          id: 'cut-0',
          type: 'cut',
          segments: [
            { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
            { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 20 },
          ],
        },
        // 模擬尺寸標註線外擴出比實際製造幾何更大的包絡（spec 描述的「大 ~10mm」現象）。
        { id: 'dim-0', type: 'dimension', segments: [{ kind: 'line', x1: -5, y1: -8, x2: 15, y2: 30 }] },
      ],
      texts: [],
      // 依 pieces-valid 三向等式，piece.bounds 必須涵蓋含 dimension 在內的全部成員。
      bounds: { minX: -5, maxX: 15, minY: -8, maxY: 30 },
      pieces: [
        {
          id: 'piece-x',
          label: { zh: '片X' },
          pathIds: ['cut-0', 'dim-0'],
          textIds: [],
          bounds: { minX: -5, maxX: 15, minY: -8, maxY: 30 },
        },
      ],
    };
    const pieceX = pieceWithDim.pieces![0]!;
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="test-pieces-box" values={{}} result={pieceWithDim} activePiece={pieceX} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    // 非 dimension（cut-0）的 hull：x∈[0,10]、y∈[0,20] → 10.00×20.00；
    // 若沿用修前行為（直接用 piece.bounds）會得到 20.00×38.00（明顯偏大）。
    expect(capturedFilename).toBe('test-pieces-box-piece-x-10.00x20.00.svg');
    clickSpy.mockRestore();
  });

  it('FX1：全版匯出（activePiece 未傳）用真實 telescope 盒型——values 無 L/W/D 鍵，檔名改用 bounds 尺寸，不再退化成含 "?" 的檔名', () => {
    const params = resolveParams(telescope);
    const result = telescope.generate(params);
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    // telescope 有 pieces，按鈕文字是「匯出目前視圖」；activePiece 不傳＝全版匯出路徑。
    render(<ExportBarHarness boxId="telescope" values={params} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖' }));
    expect(capturedFilename, '修前：telescope 無 L/W/D 鍵，全部 fallback 成 "?"').not.toContain('?');
    expect(capturedFilename).toMatch(/^telescope-\d+\.\d{2}x\d+\.\d{2}\.svg$/);
    clickSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 Task 2：ExportBar 接 DXF 下載——消費 T1 的 `toDxfDocument`（export/dxf.ts），
// 與 SVG 按鈕並列。檔名沿用同一套 buildFilename／buildPieceFilename（副檔名參數化為
// 'dxf'，不重寫檔名邏輯）；下載機制（Blob→object URL→<a download>→click→revoke）也是
// 同一份共用 helper，不是第二條手刻下載路徑。
// ─────────────────────────────────────────────────────────────────────────
describe('ExportBar：下載 DXF（Slice 3 Task 2，接 export/dxf.ts 的 toDxfDocument）', () => {
  const createObjectURLMock = vi.fn((_blob: Blob) => 'blob:mock-url-dxf');
  const revokeObjectURLMock = vi.fn((_url: string) => undefined);

  beforeEach(() => {
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

  it('全版 DXF 下載觸發：內容含 AC1009 與 CUT 層、dimension/texts 恆被排除（writer 裁決，includeDimensions 對 DXF 無效）、MIME 為 application/dxf', async () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: '下載 DXF' }));
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/dxf');
    const text = await blob.text();
    expect(text).toContain('AC1009');
    expect(text).toContain('CUT');
    expect(text).not.toContain('10mm'); // texts 恆排除（DXF 恆排除標註，與畫布圖層可見性/SVG 匯出恆全量互相獨立）
  });

  it('下載後 revoke 建立的 object URL（與 SVG 共用同一份下載清理邏輯）', () => {
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: '下載 DXF' }));
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url-dxf');
  });

  it('觸發下載時 <a> 的 download 檔名為 rte-{L}x{W}x{D}.dxf（沿用 buildFilename，副檔名參數化為 dxf）', () => {
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="rte" values={values} result={result} />);
    fireEvent.click(screen.getByRole('button', { name: '下載 DXF' }));
    expect(capturedFilename).toBe('rte-55x55x117.dxf');
    clickSpy.mockRestore();
  });

  it('FX1：telescope（無 L/W/D 鍵）DXF 檔名改用 bounds fallback（同 SVG 模式），不退化成含 "?" 的檔名', () => {
    const params = resolveParams(telescope);
    const teleResult = telescope.generate(params);
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="telescope" values={params} result={teleResult} />);
    fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖（DXF）' }));
    expect(capturedFilename).not.toContain('?');
    expect(capturedFilename).toMatch(/^telescope-\d+\.\d{2}x\d+\.\d{2}\.dxf$/);
    clickSpy.mockRestore();
  });

  it('FX5：無 L/W/D 盒型的全版 DXF 檔名 fallback 同樣排除標註外擴（與 SVG 共用 buildFilename／manufacturingBounds，見 ExportBar.tsx exportFilename）', () => {
    const dimParams = resolveParams(dimBoundsBox);
    const dimResult = dimBoundsBox.generate(dimParams);
    let capturedFilename = '';
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        capturedFilename = this.download;
      });
    render(<ExportBarHarness boxId="test-dim-bounds-box" values={dimParams} result={dimResult} />);
    fireEvent.click(screen.getByRole('button', { name: '下載 DXF' }));
    expect(capturedFilename).toBe('test-dim-bounds-box-20.00x10.00.dxf');
    clickSpy.mockRestore();
  });

  describe('單片視圖過濾（同一份 scopeResultToPiece，複用 SVG 單片匯出的過濾邏輯）', () => {
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
    const pieceA = piecesResult.pieces![0]!;

    it('全版視圖（activePiece 未傳）DXF 內容含兩片全部實體（parseDxf 驗數，對照組）', async () => {
      render(<ExportBarHarness boxId="test-pieces-box" values={{}} result={piecesResult} />);
      fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖（DXF）' }));
      const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
      const text = await blob.text();
      expect(parseDxf(text).entities).toHaveLength(2); // a-p0 + b-p0
    });

    it('單片視圖（activePiece=片A）DXF 內容只含該片實體（parseDxf 驗實體數，複用 T1 helper 不重寫解析）', async () => {
      render(<ExportBarHarness boxId="test-pieces-box" values={{}} result={piecesResult} activePiece={pieceA} />);
      fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖（DXF）' }));
      const blob = createObjectURLMock.mock.calls[0]![0] as Blob;
      const text = await blob.text();
      const parsed = parseDxf(text);
      expect(parsed.entities).toHaveLength(1); // 只剩 a-p0，b-p0 被過濾掉
      expect(parsed.entities[0]!.layer).toBe('CUT');
    });

    it('單片 DXF 檔名沿用 buildPieceFilename、副檔名為 .dxf', () => {
      let capturedFilename = '';
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
          capturedFilename = this.download;
        });
      render(<ExportBarHarness boxId="test-pieces-box" values={{}} result={piecesResult} activePiece={pieceA} />);
      fireEvent.click(screen.getByRole('button', { name: '匯出目前視圖（DXF）' }));
      // pieceA 非 dimension 幾何只有 a-p0（y=0 水平線）：length=10、height=0（與既有 SVG 同案例同數值，見 FX3）。
      expect(capturedFilename).toBe('test-pieces-box-piece-a-10.00x0.00.dxf');
      clickSpy.mockRestore();
    });
  });

  it('pieces 存在時 DXF 按鈕與 SVG 按鈕並列，兩者互不影響（SVG 按鈕文字不受本次改動影響）', () => {
    const piecesResult: GenerateResult = {
      paths: [{ id: 'a-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }],
      texts: [],
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 },
      pieces: [{ id: 'piece-a', label: { zh: '片A' }, pathIds: ['a-p0'], textIds: [], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 5 } }],
    };
    render(<ExportBarHarness boxId="test-pieces-box" values={{}} result={piecesResult} />);
    expect(screen.getByRole('button', { name: '匯出目前視圖' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '匯出目前視圖（DXF）' })).toBeInTheDocument();
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
    // 清空後任何盒型都不會因為重新 import 就恢復註冊（ES module cache——各盒型頂層的
    // registerBox(...) 呼叫只在模組第一次載入時執行過一次），這裡直接用已在記憶體中的
    // 物件手動呼叫 registerBox() 全部補回：reverseTuckEnd／telescope 之外，本檔頂部
    // 額外 registerBox() 過的四個 fake 盒型（failingBox/cascadeBox/dimBoundsBox/
    // piecesBox）也一併復原（Slice 3 gate round 1 T2 根治 infra debt：修前只復原
    // RTE／telescope，本 describe **之後**若有測試需要透過 `<App/>` 盒型下拉切到某個
    // fake 盒型，必須先手動呼叫已退役的 `ensureRegistered()` workaround補救——現在
    // afterEach 直接復原全部，不再需要那個 workaround）。本 describe 是檔案最後一個
    // block，此後沒有測試依賴 registry 狀態，此舉純粹是測試衛生＋消除未來新增測試時
    // 需要記得手動補註冊的隱性負擔。
    _clearRegistry();
    registerBox(reverseTuckEnd);
    registerBox(telescope);
    registerBox(failingBox);
    registerBox(cascadeBox);
    registerBox(dimBoundsBox);
    registerBox(piecesBox);
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

  // ── FX5（whole-branch review 修復）：selectedPieceId 復活 snap-back ──
  //
  // 根因：selectedPieceId 指向的片因為參數變動（非切盒型）而從 result.pieces 消失時
  // （例如選定內襯單片視圖後關閉 linerEnabled），activePiece 的「找不到就視為全版」防呆
  // 只保證「這一輪」畫面正確，但 selectedPieceId 這顆 state 本身沒有被清掉——之後只要
  // pieces 又重新包含同一個 id（重新打開 linerEnabled），沒有任何點擊動作就會自動跳回
  // 原本選定的單片視圖。修法：App.tsx 新增一個 effect，在 selectedPieceId 指向的片消失時
  // 把 state 本身也清成 null。

  it('FX5：選內襯單片後關閉 linerEnabled（fallback 全版），重新打開後不應無點擊自動跳回內襯視圖（selectedPieceId 復活 snap-back 回歸）', async () => {
    render(<App />);
    const select = screen.getByLabelText(/盒型/);
    fireEvent.change(select, { target: { value: 'telescope' } });
    await screen.findByRole('button', { name: '內襯' });

    fireEvent.click(screen.getByRole('button', { name: '內襯' }));
    expect(screen.getByRole('button', { name: '內襯' })).toHaveAttribute('aria-pressed', 'true');

    const linerCheckbox = screen.getByLabelText(/內襯墊片/) as HTMLInputElement;
    expect(linerCheckbox.checked).toBe(true);

    fireEvent.click(linerCheckbox); // 關閉 linerEnabled → 'liner' 片消失，fallback 回全版
    await waitFor(() => expect(screen.queryByRole('button', { name: '內襯' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '全版' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(linerCheckbox); // 重新打開 linerEnabled → 'liner' 片重新出現
    await screen.findByRole('button', { name: '內襯' });

    // 核心斷言（修前會失敗）：沒有任何點擊「內襯」按鈕的動作，selectedPieceId 這顆 state
    // 若沒被清成 null，'liner' 片一旦重新出現就會立刻復活成單片視圖——必須停留在全版。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '全版' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: '內襯' })).toHaveAttribute('aria-pressed', 'false');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FX4（whole-branch review 修復，UI 層驗證）：telescope 不變式警告觸發時，Canvas 必須
// 真的出現高亮 path——修前 gusset-b-fits 回傳 tags=[platformKey]（參數名），對不到任何
// 真實 path 的 tags（tray.ts 的角撐幾何用 'gusset'），高亮是無聲的 no-op；telescope.test.ts
// 已有單元層級的「tags 命中真實 path tag 字典」驗證，這裡另外從真實 UI 渲染路徑補一條
// 端到端證據：實際觸發警告後，畫布 DOM 裡確實多出一個 stroke="#FF6B00" 的 <path>。
// ─────────────────────────────────────────────────────────────────────────

describe('telescope 不變式警告 tags 對應真實幾何（FX4，Canvas 高亮命中而非 no-op）', () => {
  it('gusset-b-fits 觸發時，畫布應出現至少一個高亮 path（修前 tags=[platformKey] 對不到任何 path，高亮是無聲的 no-op）', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    const lidHeightInput = (await screen.findByLabelText(/上蓋壁高/)) as HTMLInputElement;
    expect(document.querySelectorAll('path[stroke="#FF6B00"]').length, '尚未觸發警告前不應有高亮').toBe(0);

    // lidPlatformWidth 預設 0（薄壁角撐），H=15 低於 minStyleBHeight(thickness=0.3) 門檻
    // （≈16.635）→ 觸發 gusset-b-fits，且不會連帶觸發其他不變式（見 telescope.test.ts
    // 既有測試「lidHeight 剛好低於門檻...」同一組態）。
    fireEvent.change(lidHeightInput, { target: { value: '15' } });

    await screen.findByText(/讓位槽幾何已擠壓變形/); // 先確認警告條真的出現
    expect(
      document.querySelectorAll('path[stroke="#FF6B00"]').length,
      "gusset-b-fits 警告觸發後應有真實 path 被高亮（tags=['gusset'] 命中 tray.ts 的角撐 path）",
    ).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v0.2.0 AnnouncementModal（公開發布宣告視窗）——每個 it() 自己決定 localStorage 起始
// 狀態（覆寫檔案頂部全域 beforeEach 的預設 dismissed=true），不依賴彼此的執行順序。
// ─────────────────────────────────────────────────────────────────────────
describe('AnnouncementModal：v0.2.0 公開發布宣告視窗', () => {
  it('首次訪問（localStorage 無 dismiss key）自動顯示，含 role=dialog/aria-modal/aria-label 基本盤', async () => {
    localStorage.clear(); // 覆寫全域 beforeEach 的預設 dismissed=true，模擬「從未關過」
    render(<App />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', '關於 open-dieline');
  });

  it('已關過（localStorage 已有 dismiss key）不自動顯示', () => {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
    render(<App />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('點右上「關閉」× 鈕：modal 關閉且寫入 localStorage dismiss key', async () => {
    localStorage.clear();
    render(<App />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '關閉' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe('true');
  });

  it('點 backdrop（卡片外的半透明區域）：modal 關閉且寫入 localStorage dismiss key', async () => {
    localStorage.clear();
    render(<App />);
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(dialog.parentElement!); // backdrop 是 dialog 的直接父層（fixed inset-0 那層）

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe('true');
  });

  it('點卡片內部（非按鈕）：不應觸發 backdrop 的關閉（stopPropagation 生效，冒泡不到 backdrop）', async () => {
    localStorage.clear();
    render(<App />);
    const dialog = await screen.findByRole('dialog');

    fireEvent.click(within(dialog).getByText(/一個開源的印刷刀模/));

    expect(screen.getByRole('dialog')).toBeInTheDocument(); // 仍在，未被誤關
  });

  it('點卡片底部「開始使用」：modal 關閉且寫入 localStorage dismiss key', async () => {
    localStorage.clear();
    render(<App />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '開始使用' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe('true');
  });

  it('按 Esc：modal 關閉且寫入 localStorage dismiss key（與滑鼠三種關閉方式同效）', async () => {
    localStorage.clear();
    render(<App />);
    await screen.findByRole('dialog');

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe('true');
  });

  it('關閉後重新掛載（模擬重新整理頁面）不再自動顯示', async () => {
    localStorage.clear();
    const { unmount } = render(<App />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '開始使用' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    unmount(); // 卸載後重新掛載一個全新的 App instance，模擬瀏覽器重新載入頁面
    render(<App />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // localStorage 記住，不再自動顯示
  });

  it('header「關於」鈕：已關過的狀態下仍可隨時重新開啟 modal', async () => {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true'); // 模擬已經關過、不會自動顯示
    render(<App />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '關於' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('重新開啟後仍可用「開始使用」關閉（關閉路徑不因「已是 dismissed」而失效，重寫同樣的值是無害 no-op）', async () => {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '關於' }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '開始使用' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY)).toBe('true');
  });

  it('連結 href/target/rel 正確：Konvolut→https://konvolut.art，Substack→https://konvolut.substack.com，皆開新分頁', async () => {
    localStorage.clear();
    render(<App />);
    const dialog = await screen.findByRole('dialog');

    const konvolutLink = within(dialog).getByRole('link', { name: 'Konvolut' });
    expect(konvolutLink).toHaveAttribute('href', 'https://konvolut.art');
    expect(konvolutLink).toHaveAttribute('target', '_blank');
    expect(konvolutLink).toHaveAttribute('rel', 'noopener noreferrer');

    const substackLink = within(dialog).getByRole('link', { name: 'Substack' });
    expect(substackLink).toHaveAttribute('href', 'https://konvolut.substack.com');
    expect(substackLink).toHaveAttribute('target', '_blank');
    expect(substackLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('維護者定稿文案關鍵片段逐字呈現（不可誤刪或改寫）：產品定位／使用注意三則／授權與商業聯絡信箱', async () => {
    localStorage.clear();
    render(<App />);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/反向插舌盒（RTE）與天地盒三件套/)).toBeInTheDocument();
    expect(within(dialog).getByText(/・產出的刀模僅供打樣與學習參考/)).toBeInTheDocument();
    expect(within(dialog).getByText(/・紙厚補償係數以特定紙材（黑卡 0\.4mm 級）的生產經驗校準/)).toBeInTheDocument();
    expect(within(dialog).getByText(/非商業使用授權（PolyForm Noncommercial 1\.0\.0）/)).toBeInTheDocument();
    expect(within(dialog).getByText(/hello@konvolut\.art/)).toBeInTheDocument();
  });

  it('既有 UI 測試不受影響：modal 顯示中（未關過）不妨礙既有畫布/參數面板的查詢與互動', async () => {
    localStorage.clear(); // 刻意模擬「modal 正在顯示」的最壞情況，驗證底層 UI 仍可查詢/互動
    render(<App />);
    await screen.findByRole('dialog');

    // 側欄的長度輸入框與畫布 path 不受 modal 掛載影響（jsdom 無真實 layout/hit-test，
    // fireEvent 直接對節點派送事件，modal 是否視覺蓋住不影響底層元素可查詢/可互動）。
    const input = screen.getByLabelText(/長.*L/) as HTMLInputElement;
    const before = document.querySelectorAll('svg path').length;
    fireEvent.change(input, { target: { value: '80' } });
    expect(document.querySelectorAll('svg path').length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 gate round 1 T2：OverlayPanel 單一疊圖模型退役，改 LayersPanel 多層模型
// （`overlay/layers.ts` 的 `OverlayLayer[]`）。fixture SVG 沿用 Task 4 既有設計（一條
// <line> 產生 1 個可手算 rawBounds 的 segment＋一個 <text> 觸發「未支援標籤」警告，
// 同時涵蓋「匯入成功」與「警告顯示」兩條路徑）。width="100"（無 mm/pt 字尾）搭配
// LayersPanel 預設 unit='pt'：scale 恆為 initialScaleGuess 的 pt 比例（0.352778）。
//
// 語意變更（對照舊 OverlayPanel 逐項核對，見 開發紀錄 self-review）：
// - 匯入不再是「offset 歸零」，改「置中預設」＋自動選中新層（gate 反饋①，createOverlayLayer）。
// - 快速對齊三鈕（左上/中心/bbox）退役，改「重新置中」單鈕（恆用 'center' 模式）。
// - 「清除」（整個疊圖歸零）退役，改逐層「刪除」（removeOverlayLayer，見多層獨立控制 describe）。
// - 單位下拉的「已校準後變更提示覆蓋」（pendingUnitOverride）子功能退役：多層下「改單位」
//   語意不再良定義（下拉是「下一次匯入」的解讀依據，不是任一層的可編輯屬性；OverlayLayer
//   本身也沒有 sourceInfo 可回頭重算，T1 契約不重新定義），改為單純「不影響既有圖層」。
// ─────────────────────────────────────────────────────────────────────────
describe('LayersPanel：疊圖匯入/顯示/透明度/校準/重新置中（Slice 3 gate round 1 T2，取代 OverlayPanel）', () => {
  const overlaySvgText =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">' +
    '<line x1="0" y1="0" x2="100" y2="50" /><text x="10" y="10">ignored</text></svg>';

  function makeOverlayFile(): File {
    return new File([overlaySvgText], 'overlay.svg', { type: 'image/svg+xml' });
  }

  /** 匯入 fixture SVG 並等到畫布出現洋紅疊圖 path（FileReader 非同步，見 LayersPanel.tsx）。 */
  async function importOverlay(): Promise<void> {
    const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeOverlayFile()] } });
    await waitFor(() => {
      expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
    });
  }

  it('匯入生產 SVG 後，畫布出現洋紅疊圖：獨立 <g transform> 包一個 fill=none 的 path', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    await importOverlay();

    const overlayPath = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!;
    expect(overlayPath).toHaveAttribute('fill', 'none');
    expect(overlayPath.parentElement?.tagName.toLowerCase()).toBe('g');
    expect(overlayPath.parentElement).toHaveAttribute('transform', expect.stringContaining('scale('));
  });

  it('匯入自動置中並選中（gate 反饋①）：offset/scale 等於獨立呼叫 createOverlayLayer 對同一 targetBounds 的計算結果，不是舊行為的 offset 歸零', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    await importOverlay();

    // 獨立重算（不讀實作內部變數）：RTE 預設參數的製造 bounds＋fixture 同一份 parse 結果，
    // 餵進 T1 的 createOverlayLayer（id 值不影響 offset/scale，隨便填）。
    const rteResult = reverseTuckEnd.generate(resolveParams(reverseTuckEnd));
    const target = manufacturingBounds(rteResult);
    const parsed = parseOverlaySvg(overlaySvgText);
    const expected = createOverlayLayer(parsed, 'overlay.svg', 'pt', target, 'irrelevant-id');

    const overlayGroup = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.parentElement!;
    const match = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(overlayGroup.getAttribute('transform') ?? '');
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeCloseTo(expected.offsetX);
    expect(Number(match![2])).toBeCloseTo(expected.offsetY);
    expect(Number(match![3])).toBeCloseTo(expected.scale);
  });

  it('FX1：匯入含 <circle> 的 SVG → 疊圖 path 的 d 非空、含兩段 A 指令弧（修前 full-circle 單一 arc 在 SVG A 指令語意下起訖點重合＝零渲染，畫布上完全隱形；見 overlay/parse.ts circleToSegments 文件）', async () => {
    const circleSvgText = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="5"/></svg>';
    const circleFile = new File([circleSvgText], 'circle.svg', { type: 'image/svg+xml' });

    render(<App />);
    await screen.findByText('open-dieline');
    const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [circleFile] } });
    await waitFor(() => {
      expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
    });

    const d = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.getAttribute('d')!;
    expect(d.length).toBeGreaterThan(0);
    const arcCommandCount = (d.match(/A/g) ?? []).length;
    expect(arcCommandCount).toBe(2); // 兩個半圓 arc，各自投影成一個 SVG A 指令
  });

  it('警告清單顯示（parseOverlaySvg 既有的未支援標籤警告，顯示在該層列下方，原樣人話呈現）', async () => {
    render(<App />);
    await importOverlay();
    expect(screen.getByText('<text> ×1 未匯入')).toBeInTheDocument();
  });

  it('透明度 slider 改變 → 疊圖 path 的 stroke-opacity 跟著變（0–1 比例，UI 顯示 0–100%）', async () => {
    render(<App />);
    await importOverlay();
    const readOverlayPath = () => document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!;
    expect(readOverlayPath()).toHaveAttribute('stroke-opacity', '0.5'); // 預設 50%

    const slider = screen.getByLabelText(/透明度/) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '20' } });

    expect(readOverlayPath()).toHaveAttribute('stroke-opacity', '0.2');
  });

  it('「顯示疊圖」開關取消勾選後疊圖消失，重新勾選後恢復', async () => {
    render(<App />);
    await importOverlay();

    const toggle = screen.getByLabelText(/顯示疊圖/) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
  });

  it('FX2：「顯示疊圖」取消勾選後，「校準」鈕 disabled，避免對隱藏疊圖進行校準改 scale', async () => {
    render(<App />);
    await importOverlay();

    const calibrateButton = screen.getByRole('button', { name: '校準' });
    expect(calibrateButton).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText(/顯示疊圖/));
    expect(calibrateButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/顯示疊圖/));
    expect(calibrateButton).not.toBeDisabled();
  });

  it('未選中時「校準」鈕 disabled（Canvas 校準對象＝選中層，未選中不可達）：取消選中後鈕鎖住，重新選中後恢復', async () => {
    render(<App />);
    await importOverlay(); // 匯入自動選中

    const calibrateButton = screen.getByRole('button', { name: '校準' });
    expect(calibrateButton).not.toBeDisabled();

    fireEvent.click(screen.getByText('overlay')); // 點列名＝取消選中（見 stripSvgExtension，檔名去 .svg 後顯示 "overlay"）
    expect(calibrateButton).toBeDisabled();

    fireEvent.click(screen.getByText('overlay')); // 再點一次＝重新選中
    expect(calibrateButton).not.toBeDisabled();
  });

  it('「重新置中」：切換盒型後點擊，offset 重算為新盒型的置中目標（而非停留在舊值——證明真的重算，不是不小心一直是同一個 no-op 值）', async () => {
    render(<App />);
    await importOverlay(); // 在 RTE 上匯入，自動置中於 RTE 的 manufacturingBounds

    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    await screen.findByLabelText(/下盒長度/);

    // 疊圖跨盒型保留（spec 明文裁決），此時 offset 仍是 RTE 置中值，尚未跟著新盒型重算。
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();

    const parsed = parseOverlaySvg(overlaySvgText);
    const rteTarget = manufacturingBounds(reverseTuckEnd.generate(resolveParams(reverseTuckEnd)));
    const telescopeTarget = manufacturingBounds(telescope.generate(resolveParams(telescope)));
    const expectedBefore = createOverlayLayer(parsed, 'overlay.svg', 'pt', rteTarget, 'x');
    const expectedAfter = createOverlayLayer(parsed, 'overlay.svg', 'pt', telescopeTarget, 'x');
    // sanity：兩個目標的置中值必須真的不同，測試才有區分力（若剛好相同，點不點「重新置中」都看不出差異）。
    expect(expectedAfter.offsetX).not.toBeCloseTo(expectedBefore.offsetX);

    const readOffsetX = () => {
      const g = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.parentElement!;
      return Number(/translate\(([-\d.]+)/.exec(g.getAttribute('transform') ?? '')![1]);
    };
    expect(readOffsetX()).toBeCloseTo(expectedBefore.offsetX); // 尚未點擊，仍是 RTE 置中值

    fireEvent.click(screen.getByRole('button', { name: '重新置中' }));

    expect(readOffsetX()).toBeCloseTo(expectedAfter.offsetX); // 重算為 telescope 的置中值
  });

  it('「重新置中」鈕未選中任何層時 disabled', async () => {
    render(<App />);
    await importOverlay();
    fireEvent.click(screen.getByText('overlay')); // 取消選中

    expect(screen.getByRole('button', { name: '重新置中' })).toBeDisabled();
  });

  it('單位下拉只影響下一次匯入，不回頭改變已匯入圖層的 scale（retroactive 覆蓋對話框功能隨多層化退役——下拉不再對應任一層可編輯屬性，見 開發紀錄 裁量說明）', async () => {
    render(<App />);
    await importOverlay(); // 預設 unit='pt' 匯入
    const readOverlayScale = () => {
      const transform = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.parentElement!.getAttribute('transform') ?? '';
      return Number(/scale\(([-\d.]+)\)/.exec(transform)![1]);
    };
    const scaleBefore = readOverlayScale();

    fireEvent.change(screen.getByLabelText(/單位/), { target: { value: 'mm' } });

    expect(readOverlayScale()).toBeCloseTo(scaleBefore, 6); // 已匯入圖層不受影響
    expect(screen.queryByText(/切換單位將覆蓋/)).not.toBeInTheDocument(); // 沒有 retroactive 覆蓋對話框
  });

  it('刪除圖層後該層與其控制項（顯示開關／透明度／校準鈕／warnings）消失，匯入區塊仍在', async () => {
    render(<App />);
    await importOverlay();

    fireEvent.click(screen.getByRole('button', { name: '刪除' }));

    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/顯示疊圖/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/透明度/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '校準' })).not.toBeInTheDocument();
    // 匯入區塊本身仍在，刪除不等於整個面板消失
    expect(screen.getByLabelText(/匯入生產 SVG/)).toBeInTheDocument();
  });

  // file input 是 uncontrolled 元件：真實瀏覽器對「選了同一個檔案」不會觸發 onChange（value
  // 沒變）。舊 OverlayPanel 只在「清除」時重掛載；多層模型沒有整體「清除」動作了，改成
  // 每次成功匯入都重掛載，讓使用者可以連續匯入同名檔案（多層情境下這是合理新增用例——
  // 例如同一份生產檔想疊兩份比較不同 offset）。直接斷言 DOM 節點身分變化：不用
  // `fireEvent.change` 兩次比對行為，因為 RTL 的 fireEvent 是無條件派送合成事件，不會重現
  // 「瀏覽器發現 value 沒變就不派送原生 change 事件」這個真實限制。
  it('每次成功匯入後 file input 重新掛載（key 遞增），不必等到刪除才能重新匯入同名檔案', async () => {
    render(<App />);
    const inputBefore = screen.getByLabelText(/匯入生產 SVG/);
    await importOverlay();
    const inputAfter = screen.getByLabelText(/匯入生產 SVG/);
    expect(inputAfter).not.toBe(inputBefore); // 不同 DOM 節點＝真的重新掛載，不只是清空 value
  });

  it('F2：匯入讀檔期間（onload 觸發前）若有其他圖層狀態變更，讀檔完成後兩者都保留、不被 stale 快照覆蓋（review finding，2026-07-09）', async () => {
    render(<App />);
    await screen.findByText('open-dieline');

    const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
    // 觸發匯入：reader.readAsText 已排入非同步佇列，onload 這一刻尚未執行（既有 importOverlay()
    // helper 需要 await waitFor 才等得到疊圖出現，證明 onload 確實延後於這行呼叫本身完成）。
    fireEvent.change(input, { target: { files: [makeOverlayFile()] } });
    // 緊接著（onload 還沒機會執行的同一輪同步程式碼）觸發另一個圖層狀態變更：尺寸標註可見性。
    fireEvent.click(screen.getByLabelText('尺寸標註'));
    expect((screen.getByLabelText('尺寸標註') as HTMLInputElement).checked).toBe(false); // 中途變更立即生效

    await waitFor(() => {
      expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
    });

    // 兩個變更都在：疊圖 append 成功（onload 完成）＋中途的尺寸標註切換沒有被 stale onload 蓋回 true
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
    expect((screen.getByLabelText('尺寸標註') as HTMLInputElement).checked).toBe(false);
  });
});

describe('LayersPanel：多層獨立控制（Slice 3 gate round 1 T2，取代單體 OverlayPanel 語意）', () => {
  const svgA = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="100" y2="50" /></svg>';
  const svgB = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><line x1="0" y1="0" x2="80" y2="40" /></svg>';

  async function importFile(text: string, name: string): Promise<void> {
    const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
    const file = new File([text], name, { type: 'image/svg+xml' });
    const before = document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`).length;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`).length).toBe(before + 1);
    });
  }

  it('匯入兩份檔案 → 兩個獨立圖層，opacity/visible 互不影響；後匯入者自動選中（stroke 較粗）', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    await importFile(svgA, 'layer-a.svg');
    await importFile(svgB, 'layer-b.svg');

    const paths = Array.from(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`));
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.getAttribute('stroke-opacity') === '0.5')).toBe(true); // 兩層預設 opacity 皆 0.5

    const widths = paths.map((p) => Number(p.getAttribute('stroke-width')));
    // 後匯入者（layer-b，索引 1）自動選中，選中層 stroke 加粗，應比未選中的 layer-a 粗。
    expect(widths[1]).toBeGreaterThan(widths[0]!);

    const rowA = screen.getByText('layer-a').closest('[data-testid^="overlay-layer-"]') as HTMLElement;
    const sliderA = within(rowA).getByLabelText(/透明度/) as HTMLInputElement;
    fireEvent.change(sliderA, { target: { value: '20' } });

    const pathsAfterOpacity = Array.from(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`));
    expect(pathsAfterOpacity[0]).toHaveAttribute('stroke-opacity', '0.2'); // 只有 layer-a 變
    expect(pathsAfterOpacity[1]).toHaveAttribute('stroke-opacity', '0.5'); // layer-b 不受影響

    const visibleA = within(rowA).getByLabelText(/顯示疊圖/) as HTMLInputElement;
    fireEvent.click(visibleA);
    expect(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`)).toHaveLength(1); // 只剩 layer-b
  });

  it('點列名切換選中：選中 layer-a 後 layer-a 校準鈕 enabled、layer-b 校準鈕 disabled（校準對象只能是選中層）', async () => {
    render(<App />);
    await screen.findByText('open-dieline');
    await importFile(svgA, 'layer-a.svg');
    await importFile(svgB, 'layer-b.svg'); // 匯入後自動選中 layer-b

    const rowA = screen.getByText('layer-a').closest('[data-testid^="overlay-layer-"]') as HTMLElement;
    const rowB = screen.getByText('layer-b').closest('[data-testid^="overlay-layer-"]') as HTMLElement;
    expect(within(rowA).getByRole('button', { name: '校準' })).toBeDisabled();
    expect(within(rowB).getByRole('button', { name: '校準' })).not.toBeDisabled();

    fireEvent.click(within(rowA).getByText('layer-a')); // 選中 layer-a

    expect(within(rowA).getByRole('button', { name: '校準' })).not.toBeDisabled();
    expect(within(rowB).getByRole('button', { name: '校準' })).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slice 3 Task 5：點選校準（spec §5「點選一段線、輸入實際 mm」）。fixture 刻意用單一水平線
// （raw x1=0,y1=0,x2=40,y2=0）：rawLength=40 是可手算的整數，calibrateScale(40mm 校準值) 的
// 期望值不必依賴浮點誤差容忍以外的猜測。unit 用 LayersPanel 預設值 'pt'（width="100" 無
// mm/pt 字尾不觸發自動判定）→ initialScaleGuess=0.352778，跟既有 T4 describe 同一慣例。
//
// 座標鏈 mock 手法：Canvas.tsx 的校準點擊用 `getBoundingClientRect()` 換算滑鼠事件座標→SVG
// viewBox 座標（見 Canvas.tsx 開頭 docblock 對 jsdom 量測限制的說明）——jsdom 預設回傳全 0
// 的 rect，這裡用 `vi.spyOn` 把「目前渲染的 svg」的 rect mock 成與 viewBox 等寬高、
// left/top=0，讓 client 像素座標→viewBox 座標的換算變成單位映射（不必額外處理 pan/zoom）。
//
// Slice 3 gate round 1 T2：校準對象從單體 OverlayState 改為「選中的 overlay 層」——這裡
// 每個測試都只匯入單一層（該層匯入時自動選中，見 LayersPanel 的多層獨立控制 describe），
// 所以校準流程本身（點選/輸入/確認/Esc/visible gate）跟舊版逐一對照下來語意不變，只是
// hit-test/回寫的對象內部從 `overlay` 單一 prop 換成 `layers.selectedOverlayId` 指到的那筆。
// ─────────────────────────────────────────────────────────────────────────
describe('LayersPanel＋Canvas：點選校準（Slice 3 Task 5 語意延續，校準對象＝選中層）', () => {
  const overlaySvgText = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="40" y2="0" /></svg>';

  function makeOverlayFile(): File {
    return new File([overlaySvgText], 'calib.svg', { type: 'image/svg+xml' });
  }

  /** 匯入 fixture 並回傳匯入完成當下的 offset（Slice 3 gate round 1 T2 起匯入即置中，gate
   *  反饋①，見 createOverlayLayer）——offset 不再恆為 (0,0)，下面的點擊座標換算需要這個值，
   *  在匯入當下（疊圖必定 visible）就近讀取並回傳，呼叫端不必自己再讀一次 DOM（FX2 那組
   *  測試後續會把疊圖隱藏，那之後就讀不到 path 了，見下方 clickFixtureLineMidpoint 的用法）。 */
  async function importOverlay(): Promise<{ offsetX: number; offsetY: number }> {
    const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeOverlayFile()] } });
    await waitFor(() => {
      expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
    });
    const transform = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.parentElement!.getAttribute('transform') ?? '';
    const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform)!;
    return { offsetX: Number(match[1]), offsetY: Number(match[2]) };
  }

  /** DOMRect 最小可用 mock：只填測試實際會讀到的欄位＋型別要求的其餘欄位補 0。 */
  function mockRect(overrides: Partial<DOMRect>): DOMRect {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}), ...overrides } as DOMRect;
  }

  /** mock 目前畫布 svg 的 rect＝與 viewBox 同寬高、left/top=0；回傳 viewBox 的 minX/minY 供呼叫端算 clientX/Y。 */
  function mockSvgRectToViewBox(): { vbMinX: number; vbMinY: number } {
    const svg = document.querySelector('svg')!;
    const viewBox = svg.getAttribute('viewBox')!;
    const [vbMinX, vbMinY, vbWidth, vbHeight] = viewBox.split(' ').map(Number);
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(mockRect({ width: vbWidth, height: vbHeight }));
    return { vbMinX: vbMinX!, vbMinY: vbMinY! };
  }

  /**
   * 點擊 fixture 線段中點：raw(20,0)，套用 `offset`（`importOverlay()` 回傳值）與 scale 後的
   * mm 座標為 `(offset.offsetX + 20×0.352778, offset.offsetY)`。mock 的 rect.left/top=0，
   * Canvas.tsx 換算式為 `mmX = minX + (clientX-0)/width*viewW`（width===viewW 時比例為 1）
   * ── 也就是 `mmX = minX + clientX`，要讓 mmX 落在目標值，clientX 必須是「目標 mm 值 −
   * minX」（不是 minX + 目標值，那樣會把 minX 算兩次）。
   */
  function clickFixtureLineMidpoint(offset: { offsetX: number; offsetY: number }): void {
    const { vbMinX, vbMinY } = mockSvgRectToViewBox();
    const svg = document.querySelector('svg')!;
    fireEvent.click(svg, { clientX: offset.offsetX + 20 * 0.352778 - vbMinX, clientY: offset.offsetY - vbMinY });
  }

  /**
   * F1 review finding 修復：pan 拖曳放開的瞬間，native browser 的 click 事件只要
   * mousedown／mouseup 落在同一元素就會 fire——不管中間游標移動多遠（DOM 規格既定行為）。
   * jsdom 的 `fireEvent` 不會像真實瀏覽器一樣從一段拖曳序列自動合成/抑制 click，所以要手動
   * 模擬完整序列：mousedown(遠處)→mousemove(終點)→mouseup(終點)→click(終點)，落點選在
   * fixture 線段中點（沒有 guard 的話會落在 hit-test 容差內、被誤判成一次點選）。起點與終點
   * 相距 50 螢幕像素，遠超過拖曳判定門檻（Canvas.tsx DRAG_CLICK_THRESHOLD_PX，~4px 級）。
   */
  function dragThenClickFixtureLineMidpoint(offset: { offsetX: number; offsetY: number }): void {
    const { vbMinX, vbMinY } = mockSvgRectToViewBox();
    const svg = document.querySelector('svg')!;
    const targetX = offset.offsetX + 20 * 0.352778 - vbMinX;
    const targetY = offset.offsetY - vbMinY;
    fireEvent.mouseDown(svg, { clientX: targetX - 50, clientY: targetY - 50 });
    fireEvent.mouseMove(svg, { clientX: targetX, clientY: targetY });
    fireEvent.mouseUp(svg, { clientX: targetX, clientY: targetY });
    fireEvent.click(svg, { clientX: targetX, clientY: targetY });
  }

  /**
   * F1 對照組：同座標的 mousedown→mouseup→click（無位移）——完整模擬「這其實是一次單純點擊」
   * 的滑鼠序列，用來驗證 guard 只擋「有位移的拖曳」，不誤傷既有的點選行為。
   */
  function clickFixtureLineMidpointViaFullSequence(offset: { offsetX: number; offsetY: number }): void {
    const { vbMinX, vbMinY } = mockSvgRectToViewBox();
    const svg = document.querySelector('svg')!;
    const targetX = offset.offsetX + 20 * 0.352778 - vbMinX;
    const targetY = offset.offsetY - vbMinY;
    fireEvent.mouseDown(svg, { clientX: targetX, clientY: targetY });
    fireEvent.mouseUp(svg, { clientX: targetX, clientY: targetY });
    fireEvent.click(svg, { clientX: targetX, clientY: targetY });
  }

  function readOverlayScale(): number {
    const transform = document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)!.parentElement!.getAttribute('transform') ?? '';
    return Number(/scale\(([-\d.]+)\)/.exec(transform)![1]);
  }

  it('LayersPanel「校準」鈕進校準模式：Canvas 顯示提示條；鈕變成「取消校準」，再點一次退出', async () => {
    render(<App />);
    await importOverlay();

    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    expect(await screen.findByText(/點選 overlay 上一段已知長度的線/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消校準' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消校準' }));
    expect(screen.queryByText(/點選 overlay 上一段已知長度的線/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '校準' })).toBeInTheDocument();
  });

  it('happy path：進模式→點選線段→輸入 100→確認→scale 依 calibrateScale 更新（100/40=2.5）、退出校準模式', async () => {
    render(<App />);
    const offset = await importOverlay();
    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    clickFixtureLineMidpoint(offset);

    const mmInput = await screen.findByLabelText(/該線段實際長度/);
    fireEvent.change(mmInput, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    await waitFor(() => expect(readOverlayScale()).toBeCloseTo(2.5, 6));
    expect(screen.queryByText(/點選 overlay 上一段已知長度的線/)).not.toBeInTheDocument(); // 模式已退出
    expect(screen.queryByLabelText(/該線段實際長度/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '校準' })).toBeInTheDocument(); // 鈕字回「校準」
  });

  it('FX2：校準模式中途關閉「顯示疊圖」後，畫布 hit-test 不再命中疊圖線段（防禦性 gate，LayersPanel 的鈕本身此時已 disabled，這裡驗證 Canvas 端獨立的第二道防線）', async () => {
    render(<App />);
    const offset = await importOverlay();
    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    fireEvent.click(screen.getByLabelText(/顯示疊圖/)); // 校準模式中途隱藏疊圖（checkbox 不因 calibrating 而 disabled）

    clickFixtureLineMidpoint(offset); // 用匯入當下讀到的 offset：疊圖現在隱藏，DOM 上已無 path 可讀

    // 修前：hit-test 沒 gate visible，仍會命中線段、跳出行內輸入表單。修後：不命中，
    // 提示條停在「請點選」狀態，沒有任何段被選中。
    expect(screen.queryByLabelText(/該線段實際長度/)).not.toBeInTheDocument();
    expect(screen.getByText(/點選 overlay 上一段已知長度的線/)).toBeInTheDocument();
  });

  it('F1：pan 拖曳放開不誤觸校準點選（mousedown 遠處→mousemove→mouseup/click 落在線段 hit-test 容差內）', async () => {
    render(<App />);
    const offset = await importOverlay();
    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    dragThenClickFixtureLineMidpoint(offset);

    // 沒有任何段被選中：行內輸入表單未出現，提示條仍是「請點選」而非顯示已選段。
    expect(screen.queryByLabelText(/該線段實際長度/)).not.toBeInTheDocument();
    expect(screen.getByText(/點選 overlay 上一段已知長度的線/)).toBeInTheDocument();
  });

  it('F1 對照組：無位移的 mousedown→mouseup→click（同座標）仍正常選中線段，既有點選行為不迴歸', async () => {
    render(<App />);
    const offset = await importOverlay();
    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    clickFixtureLineMidpointViaFullSequence(offset);

    expect(await screen.findByLabelText(/該線段實際長度/)).toBeInTheDocument(); // 有選中線段，表單出現
  });

  it('Esc 退出校準模式：scale 不變（未套用任何校準結果）', async () => {
    render(<App />);
    await importOverlay();
    const before = readOverlayScale();

    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByText(/點選 overlay 上一段已知長度的線/)).not.toBeInTheDocument();
    expect(readOverlayScale()).toBeCloseTo(before, 6);
    expect(screen.getByRole('button', { name: '校準' })).toBeInTheDocument();
  });

  it('輸入 ≤0：不套用＋提示，仍在校準模式（修正後可重新送出成功）', async () => {
    render(<App />);
    const offset = await importOverlay();
    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);
    clickFixtureLineMidpoint(offset);

    const mmInput = await screen.findByLabelText(/該線段實際長度/);
    fireEvent.change(mmInput, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    expect(await screen.findByText(/請輸入大於 0 的數字/)).toBeInTheDocument();
    expect(screen.getByLabelText(/該線段實際長度/)).toBeInTheDocument(); // 未退出校準模式

    fireEvent.change(mmInput, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));
    await waitFor(() => expect(readOverlayScale()).toBeCloseTo(2.5, 6));
    expect(screen.queryByText(/點選 overlay 上一段已知長度的線/)).not.toBeInTheDocument();
  });

  it('校準中途切換選中層——pickedSegmentIndex 須清除，須重新點選新層才能確認，不會把 scale 寫進切換前的舊層（review finding F1，雙軌審查 2026-07-09，與本檔既有的拖曳 guard F1 是不同回合的不同 finding，僅巧合同名）', async () => {
    render(<App />);
    await screen.findByText('open-dieline');

    const svgA = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="40" y2="0" /></svg>';
    const svgB = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="60" y2="0" /></svg>';
    const fileInput = () => screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;

    fireEvent.change(fileInput(), { target: { files: [new File([svgA], 'f1-a.svg', { type: 'image/svg+xml' })] } });
    await waitFor(() => expect(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`).length).toBe(1));
    fireEvent.change(fileInput(), { target: { files: [new File([svgB], 'f1-b.svg', { type: 'image/svg+xml' })] } });
    await waitFor(() => expect(document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`).length).toBe(2));
    // 匯入後自動選中後匯入者（f1-b，見「多層獨立控制」describe 的既有驗證）。

    function readTransform(el: Element): { offsetX: number; offsetY: number; scale: number } {
      const t = el.getAttribute('transform') ?? '';
      const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t)!;
      return { offsetX: Number(m[1]), offsetY: Number(m[2]), scale: Number(m[3]) };
    }
    function clickMidpoint(group: Element, rawHalfX: number): void {
      const { vbMinX, vbMinY } = mockSvgRectToViewBox();
      const { offsetX, offsetY, scale } = readTransform(group);
      fireEvent.click(document.querySelector('svg')!, { clientX: offsetX + rawHalfX * scale - vbMinX, clientY: offsetY - vbMinY });
    }
    const groupOf = (index: number) => document.querySelectorAll(`path[stroke="${OVERLAY_STROKE}"]`)[index]!.parentElement!;
    const scaleBInitial = readTransform(groupOf(1)).scale;

    // f1-b 是選中層，啟動校準（作用於 b）
    const rowB = screen.getByText('f1-b').closest('[data-testid^="overlay-layer-"]') as HTMLElement;
    fireEvent.click(within(rowB).getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);

    // 點選 b 的線段中點（raw 線段 x2=60，中點 rawHalfX=30）→ 出現行內輸入框
    clickMidpoint(groupOf(1), 30);
    expect(await screen.findByLabelText(/該線段實際長度/)).toBeInTheDocument();

    // 校準中途切選 f1-a（點列名，LayersPanel 未鎖定這個互動——這正是 F1 finding 的成因）
    fireEvent.click(screen.getByText('f1-a'));

    // 斷言：輸入框消失（pickedSegmentIndex 已清）＋確認流程不可達；校準模式本身沒有退出
    expect(screen.queryByLabelText(/該線段實際長度/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確認' })).not.toBeInTheDocument();
    expect(screen.getByText(/點選 overlay 上一段已知長度的線/)).toBeInTheDocument();

    // 重新點選 a 的線段（raw 線段 x2=40，中點 rawHalfX=20）→ 確認後 scale 寫進 a
    clickMidpoint(groupOf(0), 20);
    const mmInput2 = await screen.findByLabelText(/該線段實際長度/);
    fireEvent.change(mmInput2, { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '確認' }));

    // scale 寫進 a（100/40=2.5）且值正確；b 的 scale 全程不變（從未被確認過）
    await waitFor(() => expect(readTransform(groupOf(0)).scale).toBeCloseTo(2.5, 6));
    expect(readTransform(groupOf(1)).scale).toBeCloseTo(scaleBInitial, 6);
  });

  // 舊測試「單位下拉：校準過後變更單位提示覆蓋」已隨 pendingUnitOverride 子功能退役移除
  // （見上方 LayersPanel 匯入 describe 的「單位下拉只影響下一次匯入」測試，驗證新的簡化語意：
  // 校準過的層不會被單位下拉悄悄改掉 scale，因為下拉現在完全不回頭觸碰任何既有層）。
});
