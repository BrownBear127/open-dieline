/**
 * App：拼版模式切換與 state 生命週期（Slice 4 Task 4，spec F6／「組裝」段）。
 *
 * 只測 App.tsx 這一層新增的整合邏輯（頂部模式切換鈕、`appMode`、`impositionState` 的
 * 初值／fallback／模式往返／calibrating 互斥）——`ImpositionControls`/`ImpositionResults`
 * 內部的欄位級行為（domain 錯誤／預覽／對開語義等）已由 `tests/imposition-view.test.tsx`
 * 覆蓋，這裡不重複；`computeImposition` 的計算矩陣／浮點邊界已由 `tests/imposition.test.ts`
 * 覆蓋，這裡只在驗收條件 1 的數值錨（RTE 預設參數）上做一次 App 層級的端到端抽驗。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { BoxModule } from '@/core/types';
import { registerBox } from '@/core/registry';
import { App } from '@/ui/App';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { OVERLAY_STROKE } from '@/overlay/state';

// ── 測試專用 fake 盒型（review Medium 1 回歸 fixture）：兩片 pieces，非首位片刻意沿用
// telescope 既有的 'lid' id——用來重現「換盒型只看舊 pieceId 是否仍存在於新盒型」的契約
// 缺陷（若只靠 stillValid 檢查，telescope 選定 'lid' 後切到本盒型，會誤判「仍合法」而錯留在
// 同名的 'lid'——本盒型的第二片，而非 F6「切盒即第一片」規則要求的 pieces[0]＝'new-first'）。
// 幾何刻意寫死常數（不吃 params），本盒型的 registry 隔離同 tests/ui/app.test.tsx 慣例：
// Vitest 預設每個測試檔案各自獨立的模組（含 registry 單例 Map），跟其他測試檔案註冊的
// box id 不會衝突；'lid' 只是 GenerateResult.pieces 裡的「片 id」，不是 registry 的盒型 id，
// 跟 telescope 自己的 'lid' 片同名本來就是這個回歸測試要驗證的情境，不是意外衝突。
const sharedLidBox: BoxModule = {
  meta: { id: 'test-shared-lid-box', name: { zh: '測試共享lid盒' }, intro: { zh: '' }, topology: 'nested' },
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
      { id: 'nf-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] },
      { id: 'lid-p0', type: 'cut', segments: [{ kind: 'line', x1: 0, y1: 20, x2: 10, y2: 20 }] },
    ],
    texts: [],
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 20 },
    pieces: [
      { id: 'new-first', label: { zh: '新片一' }, pathIds: ['nf-p0'], textIds: [], bounds: { minX: 0, maxX: 10, minY: 0, maxY: 0 } },
      { id: 'lid', label: { zh: '共享lid片' }, pathIds: ['lid-p0'], textIds: [], bounds: { minX: 0, maxX: 10, minY: 20, maxY: 20 } },
    ],
  }),
};

registerBox(sharedLidBox);

// 同 tests/ui/app.test.tsx 慣例：modal 標題文字與 App 側欄 h1 同為「open-dieline」，
// 不先關閉的話兩者同時掛載會讓任何撞名查詢丟 multiple-elements 錯誤。
beforeEach(() => {
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
});

afterEach(() => {
  localStorage.clear();
});

function switchToImposition(): void {
  fireEvent.click(screen.getByRole('button', { name: '拼版估算' }));
}

function switchToDesign(): void {
  fireEvent.click(screen.getByRole('button', { name: '刀模設計' }));
}

// ── overlay 匯入 harness（review Medium 2 沿用既有「拼版模式與 calibrating 互斥」describe
// 區塊的 helper，搬到模組層級供「模式往返 state 保留」describe 共用，避免兩處各自定義一份
// 重複的匯入邏輯）。──
const overlaySvgText =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="40" y2="0" /></svg>';

function makeOverlayFile(): File {
  return new File([overlaySvgText], 'calib.svg', { type: 'image/svg+xml' });
}

async function importOverlay(): Promise<void> {
  const input = screen.getByLabelText(/匯入生產 SVG/) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [makeOverlayFile()] } });
  await waitFor(() => {
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument();
  });
}

describe('App：模式切換顯隱（spec「組裝」段：LayersPanel/ExportBar ↔ 拼版控制、Canvas ↔ 拼版預覽、ParamPanel／盒型選擇不隨模式隱藏）', () => {
  it('預設（刀模設計）模式：LayersPanel／ExportBar／ParamPanel 可見，拼版控制／結果不可見', () => {
    render(<App />);

    expect(screen.getByText('生成圖層')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下載 SVG' })).toBeInTheDocument();
    expect(screen.getByLabelText(/長.*L/)).toBeInTheDocument();

    expect(screen.queryByText('拼版設定')).not.toBeInTheDocument();
    expect(screen.queryByTestId('direction-card-0')).not.toBeInTheDocument();
  });

  it('切到拼版估算：LayersPanel／ExportBar 消失、ImpositionControls／ImpositionResults 出現，ParamPanel／盒型選擇仍在', () => {
    render(<App />);
    switchToImposition();

    expect(screen.queryByText('生成圖層')).not.toBeInTheDocument();
    expect(screen.queryByText('對照圖層')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下載 SVG' })).not.toBeInTheDocument();

    expect(screen.getByLabelText(/長.*L/)).toBeInTheDocument(); // ParamPanel 保留
    expect(screen.getByLabelText(/盒型/)).toBeInTheDocument(); // 盒型選擇保留

    expect(screen.getByText('拼版設定')).toBeInTheDocument(); // ImpositionControls
    expect(screen.getByTestId('direction-card-0')).toBeInTheDocument(); // ImpositionResults
    expect(screen.getByTestId('direction-card-90')).toBeInTheDocument();
  });

  it('切回刀模設計：ImpositionControls／ImpositionResults 消失，LayersPanel／ExportBar 恢復', () => {
    render(<App />);
    switchToImposition();
    switchToDesign();

    expect(screen.queryByText('拼版設定')).not.toBeInTheDocument();
    expect(screen.queryByTestId('direction-card-0')).not.toBeInTheDocument();
    expect(screen.getByText('生成圖層')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下載 SVG' })).toBeInTheDocument();
  });

  it('頂部模式切換鈕的 aria-pressed 正確反映目前模式', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: '刀模設計' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '拼版估算' })).toHaveAttribute('aria-pressed', 'false');

    switchToImposition();
    expect(screen.getByRole('button', { name: '刀模設計' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '拼版估算' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('App：拼版預設值與即時性（spec 驗收條件 1 數值錨＋驗收條件 9）', () => {
  it('RTE 預設參數進拼版模式：0°＝3列×4行＝12模、90°＝2列×4行＝12模（allowRotate 預設 true，90° 卡含 L 形補排 1×4=4 件，gate round 1 T1 數值錨表第 3/4 列）', () => {
    render(<App />);
    switchToImposition();

    const card0 = screen.getByTestId('direction-card-0');
    const card90 = screen.getByTestId('direction-card-90');
    // 用 .* 跳過排版用的全形符號（＝/×），只鎖字面數字本身，避免測試對特殊字元的脆弱依賴。
    // cols/rows 顯示主格點（語意不變）；模數＝count（gridCount＋補排），App 預設
    // allowRotate:true 讓 90° 卡從舊版 8 模變成 12 模（right-full 補上 1×4=4 件）。
    expect(within(card0).getByText(/3\s*列.*4\s*行.*12\s*模/)).toBeInTheDocument();
    expect(within(card90).getByText(/2\s*列.*4\s*行.*12\s*模/)).toBeInTheDocument();
  });

  it('拼版模式下直接調整盒參數（L，不需切回設計模式——ParamPanel 兩模式皆可調）→ 方向卡即時重算（驗收條件9 抽驗一組）', () => {
    render(<App />);
    switchToImposition();

    const card0Before = screen.getByTestId('direction-card-0').textContent;

    const lengthInput = screen.getByLabelText(/長.*L/);
    fireEvent.change(lengthInput, { target: { value: '150' } });

    const card0After = screen.getByTestId('direction-card-0').textContent;
    expect(card0After).not.toBe(card0Before);
  });
});

describe('App：模式往返 state 保留（spec F6「模式往返」：逐欄列舉，不用「任何參數」概括；review Medium 2——完整旅程逐欄鎖住，另補 state 分離與 overlay 保留兩項斷言）', () => {
  it('逐欄寫入非預設值（盒型參數／拼版件選擇／紙規 preset／自訂 W-H／方向／作業模式／咬口／gap）→ design↔imposition 往返 → 逐欄斷言保留；並驗證 impositionState.pieceId 與 selectedPieceId 互不污染、overlay 資料往返後仍存在', async () => {
    render(<App />);

    // ── overlay：design 模式先匯入一份疊圖（layersState），驗證模式往返不會讓它消失 ──
    await importOverlay();

    // ── 換到天地盒（telescope）：才有「拼版件選擇」與「design 模式片選擇」兩個欄位可測 ──
    const boxSelect = screen.getByLabelText(/盒型/);
    fireEvent.change(boxSelect, { target: { value: 'telescope' } });
    const lidButton = await screen.findByRole('button', { name: '上蓋' }); // 等切盒完成（telescope 的片切換鈕出現）

    // ── design 模式：選單片視圖「上蓋」(lid)——之後驗證這顆 selectedPieceId 不受拼版端的
    //    pieceId 改動污染（F6「state 分離」，跟下面拼版件選擇刻意選不同片）。
    fireEvent.click(lidButton);
    expect(lidButton).toHaveAttribute('aria-pressed', 'true');

    // ── 盒型參數：下盒長度 179(預設)→250，驗證 ParamPanel 的 values 不因模式往返而重置 ──
    const baseLengthInput = screen.getByLabelText('下盒長度') as HTMLInputElement;
    fireEvent.change(baseLengthInput, { target: { value: '250' } });
    expect(baseLengthInput.value).toBe('250');

    switchToImposition();

    const pieceSelect = screen.getByLabelText('件') as HTMLSelectElement;
    await waitFor(() => expect(pieceSelect.value).toBe('base')); // 初始 fallback pieces[0]

    // ── 拼版件選擇：改選「內襯」(liner)——刻意跟上面 design 模式選的「上蓋」(lid) 不同片。
    fireEvent.change(pieceSelect, { target: { value: 'liner' } });
    expect(pieceSelect.value).toBe('liner');

    // ── 紙規 preset → 自訂：同時覆蓋「紙規 preset」與「自訂 W/H」兩欄（App 初始化預設值為
    //    PAPER_PRESETS[0]＝'31x43'／787×1092，見 App.tsx impositionState 初值）。
    const paperPresetSelect = screen.getByLabelText('紙規') as HTMLSelectElement;
    expect(paperPresetSelect.value).toBe('31x43');
    fireEvent.change(paperPresetSelect, { target: { value: 'custom' } });
    expect(paperPresetSelect.value).toBe('custom');

    const customWInput = screen.getByLabelText('W (mm)') as HTMLInputElement;
    const customHInput = screen.getByLabelText('H (mm)') as HTMLInputElement;
    fireEvent.change(customWInput, { target: { value: '900' } });
    fireEvent.change(customHInput, { target: { value: '1200' } });

    // ── 方向：portrait(預設)→landscape ──
    const orientationSelect = screen.getByLabelText('方向') as HTMLSelectElement;
    fireEvent.change(orientationSelect, { target: { value: 'landscape' } });

    // ── 作業模式：full(預設)→halfV ──
    const modeSelect = screen.getByLabelText('作業模式') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'halfV' } });

    // ── 咬口：20(預設)→15 ──
    const gripperInput = screen.getByLabelText(/咬口/) as HTMLInputElement;
    fireEvent.change(gripperInput, { target: { value: '15' } });

    // ── 刀線間距(gap)：3=MIN_GAP_MM(預設)→6 ──
    const gapInput = screen.getByLabelText(/刀線間距/) as HTMLInputElement;
    fireEvent.change(gapInput, { target: { value: '6' } });

    // ── 往返 1／2：切回設計模式——斷言 design 端沒被上面拼版端的一連串改動污染，
    //    overlay／盒型參數也還在。 ──
    switchToDesign();

    // selectedPieceId 未被 impositionState.pieceId('liner') 污染，仍是設計模式選的「上蓋」。
    expect(screen.getByRole('button', { name: '上蓋' })).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByLabelText('下盒長度') as HTMLInputElement).value).toBe('250'); // 盒型參數（values）保留
    expect(document.querySelector(`path[stroke="${OVERLAY_STROKE}"]`)).toBeInTheDocument(); // overlay（layersState）往返後仍存在

    // ── 往返 2／2：切回拼版模式——逐欄斷言全部保留，且 pieceId 仍是 'liner'
    //    （沒有被 design 端剛剛驗證過的 'lid' 選擇污染，F6「state 分離」）。 ──
    switchToImposition();

    expect((screen.getByLabelText('件') as HTMLSelectElement).value).toBe('liner');
    expect((screen.getByLabelText('紙規') as HTMLSelectElement).value).toBe('custom');
    expect((screen.getByLabelText('W (mm)') as HTMLInputElement).value).toBe('900');
    expect((screen.getByLabelText('H (mm)') as HTMLInputElement).value).toBe('1200');
    expect((screen.getByLabelText('方向') as HTMLSelectElement).value).toBe('landscape');
    expect((screen.getByLabelText('作業模式') as HTMLSelectElement).value).toBe('halfV');
    expect((screen.getByLabelText(/咬口/) as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText(/刀線間距/) as HTMLInputElement).value).toBe('6');
  });
});

describe('App：impositionState.pieceId 生命週期（spec F6「state 分離」／「預設值」／「失效 fallback」／「RTE」）', () => {
  it('切到 telescope 並進拼版模式：件下拉初值為 pieces[0]（下盒 base），非 null／非其他片', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    switchToImposition();

    await waitFor(() => {
      expect((screen.getByLabelText('件') as HTMLSelectElement).value).toBe('base');
    });
  });

  it('天地盒選內襯(liner)後關閉「內襯墊片」(linerEnabled=false)：件下拉即時 fallback 回下盒(base)——不需切模式，ParamPanel 在拼版模式仍可調', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    switchToImposition();

    const pieceSelect = screen.getByLabelText('件') as HTMLSelectElement;
    await waitFor(() => expect(pieceSelect.value).toBe('base'));

    fireEvent.change(pieceSelect, { target: { value: 'liner' } });
    expect(pieceSelect.value).toBe('liner');

    fireEvent.click(screen.getByLabelText(/內襯墊片/)); // 關閉 linerEnabled → 'liner' 片消失

    await waitFor(() => {
      expect((screen.getByLabelText('件') as HTMLSelectElement).value).toBe('base');
    });
  });

  it('RTE（result.pieces undefined）恆顯示「整件」、無下拉；換盒型 fallback：telescope 選內襯→切到 RTE→切回 telescope，不殘留舊 liner 選擇、fallback 回下盒(base)', async () => {
    render(<App />);
    const boxSelect = screen.getByLabelText(/盒型/);

    fireEvent.change(boxSelect, { target: { value: 'telescope' } });
    switchToImposition();

    const pieceSelect = screen.getByLabelText('件') as HTMLSelectElement;
    await waitFor(() => expect(pieceSelect.value).toBe('base'));
    fireEvent.change(pieceSelect, { target: { value: 'liner' } });
    expect(pieceSelect.value).toBe('liner');

    fireEvent.change(boxSelect, { target: { value: 'rte' } });
    // RTE 恆無可失效的 piece id：不是「找不到就 fallback」的下拉，而是直接顯示固定文字。
    expect(screen.queryByLabelText('件')).not.toBeInTheDocument();
    expect(screen.getByText('整件')).toBeInTheDocument();

    fireEvent.change(boxSelect, { target: { value: 'telescope' } });
    await waitFor(() => {
      expect((screen.getByLabelText('件') as HTMLSelectElement).value).toBe('base'); // 不殘留 'liner'
    });
  });

  it('換盒型即歸位 pieces[0]，即使新盒型的非首片沿用舊 id（review Medium 1 回歸 fixture）：telescope 選「上蓋」(lid) 後切到 test-shared-lid-box（pieces=[new-first, lid]，"lid" 落在第二位），不得停留在同名的 lid，須歸位新盒的 pieces[0]="new-first"', async () => {
    render(<App />);
    const boxSelect = screen.getByLabelText(/盒型/);

    fireEvent.change(boxSelect, { target: { value: 'telescope' } });
    switchToImposition();

    const pieceSelect = screen.getByLabelText('件') as HTMLSelectElement;
    await waitFor(() => expect(pieceSelect.value).toBe('base'));

    fireEvent.change(pieceSelect, { target: { value: 'lid' } });
    expect(pieceSelect.value).toBe('lid');

    // 只靠「舊 id 是否仍存在於新盒型」的 stillValid 檢查會誤判：test-shared-lid-box 也有一片
    // id='lid'（落在第二位），若沒有 App.tsx 的「切盒同步清除」修復，這裡會誤判 lid 仍合法
    // 而錯留在同名新片，而非 F6「切盒即第一片」規則要求的 pieces[0]。
    fireEvent.change(boxSelect, { target: { value: 'test-shared-lid-box' } });

    await waitFor(() => {
      expect((screen.getByLabelText('件') as HTMLSelectElement).value).toBe('new-first');
    });
  });
});

describe('App：拼版模式與 calibrating 互斥（spec F6「校準互斥」）', () => {
  it('calibrating=true 時進拼版模式：Canvas／LayersPanel 卸載、calibrating 被強制關閉；退出拼版後返回設計模式不復活（鈕字回「校準」而非「取消校準」，提示條不自動重現）', async () => {
    render(<App />);
    await importOverlay(); // 匯入即自動選中（既有 gate 反饋①），校準鈕隨即可點

    fireEvent.click(screen.getByRole('button', { name: '校準' }));
    await screen.findByText(/點選 overlay 上一段已知長度的線/);
    expect(screen.getByRole('button', { name: '取消校準' })).toBeInTheDocument();

    switchToImposition();
    expect(screen.getByText('拼版設定')).toBeInTheDocument(); // 確認真的進了拼版模式（LayersPanel 已卸載）

    switchToDesign();
    expect(screen.queryByText(/點選 overlay 上一段已知長度的線/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '校準' })).toBeInTheDocument(); // 非「取消校準」→ calibrating 沒有復活
  });
});

describe('App：LayersState 跨模式／跨盒型組合旅程（final 迴歸 review Low 3——設計圖層狀態、overlay、雙 piece state 在完整往返後全保留的永久保護）', () => {
  it('匯 overlay → 關切割線與尺寸標註 → 進拼版（製造輪廓照畫、overlay 不出現）→ 切盒型＋改拼版選片 → 回設計：兩圖層仍關、overlay 仍在、cut 仍不畫', async () => {
    render(<App />);
    await importOverlay();

    // 設計模式：關兩個生成圖層（generatedVisible）
    fireEvent.click(screen.getByLabelText('切割線'));
    fireEvent.click(screen.getByLabelText('尺寸標註'));
    const cutSelector = 'svg path[stroke="#000000"]';
    expect(document.querySelectorAll(cutSelector).length).toBe(0);

    // 進拼版：預覽照畫製造輪廓（spec F7——忽略設計圖層可見性，cut 在拼版預覽必須存在）、
    // overlay 洋紅 path 不出現（Canvas 卸載、拼版預覽不讀 overlay）
    switchToImposition();
    expect(screen.getAllByTestId('preview-instance').length).toBeGreaterThan(0);
    expect(document.querySelectorAll(`svg path[stroke="${OVERLAY_STROKE}"]`).length).toBe(0);
    expect(document.querySelectorAll(cutSelector).length).toBeGreaterThan(0); // 預覽的 cut 輪廓

    // 切盒型（telescope）＋改拼版選片：切盒歸位 pieces[0]（base）後改選 lid
    fireEvent.change(screen.getByLabelText(/盒型/), { target: { value: 'telescope' } });
    const pieceSelect = screen.getByLabelText('件') as HTMLSelectElement;
    fireEvent.change(pieceSelect, { target: { value: 'lid' } });
    expect(pieceSelect.value).toBe('lid');

    // 回設計模式：兩個圖層 checkbox 仍未勾選、overlay 仍在、cut 仍因圖層關閉不畫
    switchToDesign();
    expect((screen.getByLabelText('切割線') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('尺寸標註') as HTMLInputElement).checked).toBe(false);
    await waitFor(() => {
      expect(document.querySelectorAll(`svg path[stroke="${OVERLAY_STROKE}"]`).length).toBeGreaterThan(0);
    });
    expect(document.querySelectorAll(cutSelector).length).toBe(0);
  });
});
