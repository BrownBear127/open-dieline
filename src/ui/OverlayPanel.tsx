/**
 * OverlayPanel：側欄新區塊（位於 ParamPanel 之後），管理生產刀模 SVG 疊圖的匯入/顯示/對齊
 * （Slice 3 Task 4，spec §5）。
 *
 * `overlayState` 是受控 prop、提升到 App.tsx（與 `includeDimensions`/`selectedPieceId` 同一個
 * 提升理由——Canvas 疊繪與這裡的控制項是平行兄弟元件，只有共同父層的 state 才能同步）；
 * `null`＝尚未匯入或已清除。`targetBounds` 是快速對齊三鈕的對齊目標（App.tsx 用
 * `activePiece?.bounds ?? result.bounds` 解出，跟 Canvas 目前實際顯示的視圖範圍一致）。
 *
 * `unit`／`sourceInfo` 刻意留在本元件的 local state，不提升、也不放進 `OverlayState`——
 * 它們是「匯入當下的 UI 選擇/來源資訊」，只有本元件自己的單位下拉切換邏輯需要，Canvas 完全
 * 不消費，混進 `OverlayState` 會違反 overlay/state.ts 文件化的精簡欄位契約（見該檔 docblock）。
 *
 * 單位下拉變更重算 scale：spec 原文「僅在未做過點選校準時」——T4 尚無校準機制（T5 才加
 * `calibrateScale` 與 Canvas 校準 hit-test），這條優先順序在本輪 恆真，因此實作上＝
 * 單位下拉一律直接重算 scale。T5 接手時，`handleUnitChange` 要先判斷 overlayState 是否已被
 * 校準覆寫過，已校準時跳過這段 recompute（下拉變更提示會覆蓋，而不是直接覆蓋）。
 */
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Bounds } from '@/core/geometry';
import { parseOverlaySvg } from '@/overlay/parse';
import type { OverlayParseResult } from '@/overlay/parse';
import { alignOffset, createOverlayState, initialScaleGuess } from '@/overlay/state';
import type { OverlayState } from '@/overlay/state';

export interface OverlayPanelProps {
  overlayState: OverlayState | null;
  onOverlayStateChange: (next: OverlayState | null) => void;
  targetBounds: Bounds;
}

type OverlayUnit = 'pt' | 'mm' | 'px';

const UNIT_OPTIONS: OverlayUnit[] = ['pt', 'mm', 'px'];
const LABEL_CLASS = 'text-[10px] uppercase tracking-wider text-zinc-400';
const NUMBER_INPUT_CLASS =
  'w-full bg-white border-b border-zinc-200 text-sm py-1.5 px-2 text-right font-mono focus:outline-none focus:border-black transition-colors';
const ALIGN_BUTTON_CLASS = 'flex-1 px-2 py-1 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100 text-xs shadow-sm transition-colors';

export function OverlayPanel({ overlayState, onOverlayStateChange, targetBounds }: OverlayPanelProps) {
  const [unit, setUnit] = useState<OverlayUnit>('pt'); // 維護者生產檔慣例，見 spec UI 規格
  const [sourceInfo, setSourceInfo] = useState<OverlayParseResult['sourceInfo'] | null>(null);
  // file input 是 uncontrolled 元件，瀏覽器選過檔後「再選同一個檔案」不會觸發 onChange
  // （value 沒變）——「清除」後若使用者想重新匯入同一份檔案會靜默沒反應。用遞增 key 讓
  // 「清除」時強制重掛載 input（原生的已選檔案記憶隨舊節點一起卸載），下次選檔一定是全新的
  // change 事件。只在 handleClear 遞增，其餘互動不受影響。
  const [fileInputKey, setFileInputKey] = useState(0);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseOverlaySvg(text);
      setSourceInfo(parsed.sourceInfo);
      onOverlayStateChange(createOverlayState(parsed, unit));
    };
    reader.readAsText(file);
  };

  const handleUnitChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    const nextUnit = e.target.value as OverlayUnit;
    setUnit(nextUnit);
    if (overlayState && sourceInfo) {
      onOverlayStateChange({ ...overlayState, scale: initialScaleGuess(sourceInfo, nextUnit) });
    }
  };

  const handleVisibleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (!overlayState) return;
    onOverlayStateChange({ ...overlayState, visible: e.target.checked });
  };

  const handleOpacityChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (!overlayState) return;
    onOverlayStateChange({ ...overlayState, opacity: Number(e.target.value) / 100 });
  };

  const handleAlign = (mode: 'top-left' | 'center' | 'bbox'): void => {
    if (!overlayState) return;
    const offset = alignOffset(overlayState.rawBounds, overlayState.scale, targetBounds, mode);
    onOverlayStateChange({ ...overlayState, ...offset });
  };

  // 空字串／非法數值：不寫入（同 ParamPanel.tsx 的 handleNumberChange 慣例，不炸、保持前值）。
  const handleOffsetXChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (!overlayState) return;
    const raw = e.target.value;
    if (raw === '') return;
    const value = Number(raw);
    if (Number.isNaN(value)) return;
    onOverlayStateChange({ ...overlayState, offsetX: value });
  };

  const handleOffsetYChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (!overlayState) return;
    const raw = e.target.value;
    if (raw === '') return;
    const value = Number(raw);
    if (Number.isNaN(value)) return;
    onOverlayStateChange({ ...overlayState, offsetY: value });
  };

  const handleClear = (): void => {
    setSourceInfo(null);
    onOverlayStateChange(null);
    setFileInputKey((k) => k + 1); // 見上方宣告處註解：強制重掛載 file input，清掉原生已選檔案記憶
  };

  return (
    <div className="flex flex-col gap-3 p-5 bg-zinc-50 border border-zinc-200 rounded-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">疊圖對照</h3>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          對照調參用——匯入生產刀模、校準比例後與生成層疊圖比對（特別是 R 角與細部結構）。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="overlay-file" className={LABEL_CLASS}>
          匯入生產 SVG
        </label>
        <input
          key={fileInputKey}
          id="overlay-file"
          type="file"
          accept=".svg"
          onChange={handleFileChange}
          className="text-xs text-zinc-600"
        />
      </div>

      {overlayState && overlayState.warnings.length > 0 && (
        <ul className="flex flex-col gap-0.5 bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] rounded-sm p-2">
          {overlayState.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="overlay-unit" className={LABEL_CLASS}>
          單位
        </label>
        <select
          id="overlay-unit"
          value={unit}
          onChange={handleUnitChange}
          className="w-full bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors"
        >
          {UNIT_OPTIONS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>

      {overlayState && (
        <>
          <label htmlFor="overlay-visible" className="flex items-center gap-2 text-xs text-zinc-600">
            <input
              id="overlay-visible"
              type="checkbox"
              checked={overlayState.visible}
              onChange={handleVisibleChange}
              className="h-4 w-4 accent-blue-600"
            />
            顯示疊圖
          </label>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="overlay-opacity" className={LABEL_CLASS}>
                透明度
              </label>
              <span className="text-[10px] font-mono text-zinc-500">{Math.round(overlayState.opacity * 100)}%</span>
            </div>
            <input
              id="overlay-opacity"
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(overlayState.opacity * 100)}
              onChange={handleOpacityChange}
              className="w-full accent-blue-600"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL_CLASS}>快速對齊</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => handleAlign('top-left')} className={ALIGN_BUTTON_CLASS}>
                左上
              </button>
              <button type="button" onClick={() => handleAlign('center')} className={ALIGN_BUTTON_CLASS}>
                中心
              </button>
              <button type="button" onClick={() => handleAlign('bbox')} className={ALIGN_BUTTON_CLASS}>
                邊界框
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="overlay-offset-x" className={LABEL_CLASS}>
                X 偏移 (mm)
              </label>
              <input
                id="overlay-offset-x"
                type="number"
                step={0.5}
                value={overlayState.offsetX}
                onChange={handleOffsetXChange}
                className={NUMBER_INPUT_CLASS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="overlay-offset-y" className={LABEL_CLASS}>
                Y 偏移 (mm)
              </label>
              <input
                id="overlay-offset-y"
                type="number"
                step={0.5}
                value={overlayState.offsetY}
                onChange={handleOffsetYChange}
                className={NUMBER_INPUT_CLASS}
              />
            </div>
          </div>

          <button type="button" onClick={handleClear} className="self-start text-[10px] uppercase tracking-wider text-zinc-500 hover:text-red-600">
            清除
          </button>
        </>
      )}
    </div>
  );
}
