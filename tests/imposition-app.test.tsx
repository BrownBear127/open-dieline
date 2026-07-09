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
import { App } from '@/ui/App';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { OVERLAY_STROKE } from '@/overlay/state';

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
  it('RTE 預設參數進拼版模式：0°＝3列×4行＝12模、90°＝2列×4行＝8模（spec 驗收條件 1 硬編碼數值錨，31"×43"／直放／整紙／咬口20／gap3）', () => {
    render(<App />);
    switchToImposition();

    const card0 = screen.getByTestId('direction-card-0');
    const card90 = screen.getByTestId('direction-card-90');
    // 用 .* 跳過排版用的全形符號（＝/×），只鎖字面數字本身，避免測試對特殊字元的脆弱依賴。
    expect(within(card0).getByText(/3\s*列.*4\s*行.*12\s*模/)).toBeInTheDocument();
    expect(within(card90).getByText(/2\s*列.*4\s*行.*8\s*模/)).toBeInTheDocument();
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

describe('App：模式往返 state 保留（spec F6「模式往返」：逐欄列舉，不用「任何參數」概括）', () => {
  it('改咬口(gripper)→切設計→切回拼版→值仍在', () => {
    render(<App />);
    switchToImposition();

    const gripperInput = screen.getByLabelText(/咬口/) as HTMLInputElement;
    expect(gripperInput.value).toBe('20'); // App 初始化預設值（對齊 spec 驗收1 數值錨的咬口 20mm）

    fireEvent.change(gripperInput, { target: { value: '15' } });
    expect(gripperInput.value).toBe('15');

    switchToDesign();
    switchToImposition();

    expect((screen.getByLabelText(/咬口/) as HTMLInputElement).value).toBe('15');
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
});

describe('App：拼版模式與 calibrating 互斥（spec F6「校準互斥」）', () => {
  const overlaySvgText = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><line x1="0" y1="0" x2="40" y2="0" /></svg>';

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
