/**
 * LayersPanel：側欄區塊（位於 ParamPanel 之後），取代 Slice 3 Task 4 的 OverlayPanel
 * （Slice 3 gate round 1 T2，gate 驗收反饋②③——圖層顯示/隱藏＋線型分層＋匯入獨立多層）。
 *
 * 兩段式面板：
 * - 「生成圖層」：`GENERATED_LAYER_ORDER` 四列固定顯示（cut/crease/halfcut/dimensions），
 *   對應 Canvas 依 `layerKeyForLineType` 分桶後的顯示開關。列表恆定四列（不因盒型而增減）
 *   比動態列表更穩定；當前盒型完全沒有某個桶的內容時（如 RTE 沒有 halfcut 線），該列改
 *   disabled 樣式＋title 提示，而非整列消失——維持面板結構在切換盒型時不跳動。
 * - 「對照圖層」：取代舊 OverlayPanel 的單一疊圖，改成 `OverlayLayer[]`（`overlay/layers.ts`）
 *   多層：匯入即 append 一筆新層＋自動選中＋置中預設（`createOverlayLayer`，gate 反饋①）；
 *   每層一列，各自獨立 visible/opacity/校準/刪除。
 *
 * `includeDimensions` checkbox 已隨這次遷移退役——尺寸標註的顯示開關現在就是「生成圖層」
 * 的「尺寸標註」那一列（`generatedVisible.dimensions`），不再是 ExportBar 的獨立 state。
 * 對照的是「畫布可見性」，不影響匯出（plan 裁決「匯出恆全量」：SVG/DXF 匯出邏輯完全不讀
 * `LayersState`，見 ExportBar.tsx／App.tsx 對應註解）。
 *
 * 校準（T5，spec §5）：進校準模式的 hit-test／頂部提示條／行內輸入都在 Canvas.tsx（點選這個
 * 互動必須發生在畫布上），這裡的「校準」鈕只切換 `calibrating` 開關——與舊版 OverlayPanel
 * 同一個提升理由，只是 `calibrating` 不再是 `OverlayLayer` 的欄位（T1 契約未收錄，多層下
 * 「目前是否在校準模式」是跨層共用的單一開關，不是某一層的屬性），改由 App.tsx 提升成獨立
 * state、經由 `calibrating`/`onCalibratingChange` 這兩個 props 與 Canvas 同步。
 *
 * 校準鈕的 disabled 邏輯比舊版多一道「必須是選中層」的 gate（`!isSelected || !layer.visible`）：
 * 校準永遠作用於「選中層」（Canvas 的 hit-test 對象），非選中層的校準鈕即使可見也不該可點——
 * 讓使用者一定先點列名選取，再按校準，操作順序與 Canvas 的實際行為一致，不會讓人以為點了
 * 某一層的「校準」鈕卻改到另一層的 scale。
 *
 * 「重新置中」取代舊版「快速對齊」三鈕（左上/中心/bbox，gate 反饋①明確要求退役——驗收
 * 反饋「快速對齊不實用」）：只保留一個以 `alignOffset(..., 'center')` 重算選中層 offset 的
 * 動作，未選中任何層時 disabled。
 *
 * 單位下拉（`unit` local state）：只影響「下一次匯入」如何解讀 scale（`initialScaleGuess`），
 * 不是任一層的可編輯屬性。舊版 OverlayPanel 在單一疊圖模型下，多了一個「已校準後變更單位
 * 提示覆蓋」的子功能（`pendingUnitOverride`，回頭用新單位重算當下唯一那份 OverlayState 的
 * scale）——這個子功能在多層模型下沒有移植：`OverlayLayer`（T1 契約）沒有儲存 `sourceInfo`
 * 可供回頭重算，且「改變下拉要覆蓋哪一層」在多層情境下不是良定義的問題（下拉不對應任何
 * 特定層）。spec 的 T2 規格文字本身也完全沒提到這個子功能要延續，只講「單位下拉（既有）」
 * 指的是下拉本身要繼續存在，不是這個覆蓋確認的互動——見 開發紀錄 的裁量記錄。
 */
import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Bounds } from '@/core/geometry';
import type { GenerateResult } from '@/core/types';
import { parseOverlaySvg } from '@/overlay/parse';
import { alignOffset } from '@/overlay/state';
import {
  GENERATED_LAYER_LABEL,
  GENERATED_LAYER_ORDER,
  createOverlayLayer,
  layerKeyForLineType,
  removeOverlayLayer,
  updateOverlayLayer,
} from '@/overlay/layers';
import type { GeneratedLayerKey, LayersState } from '@/overlay/layers';

export interface LayersPanelProps {
  layers: LayersState;
  /** 圖層狀態更新：可傳新值，或傳 `(prev) => next` 的 updater 函式（App.tsx 的 `setLayersState`
   *  來自 `useState`，原生支援兩種形式，見 React `SetStateAction` 語意）。面板內大部分 handler
   *  是同步事件（點擊/改值當下讀到的 `layers` prop 就是最新值，傳值即可）；`handleFileChange`
   *  的 `reader.onload` 是唯一例外——FileReader 非同步，callback 觸發時 closure 捕捉的
   *  `layers` 可能已經過期，必須用 updater 形式讀到呼叫當下真正最新的 state（review finding
   *  F2，2026-07-09，完整推理見該 handler 內的註解）。 */
  onLayersChange: (update: LayersState | ((prev: LayersState) => LayersState)) => void;
  targetBounds: Bounds;
  /** 用來判斷「生成圖層」四列裡哪些桶目前有內容（見上方 docblock 的 disabled 列邏輯）；
   *  不直接消費幾何/pieces，只讀 `paths`——跟 ExportBar 一樣直接吃 `GenerateResult`，不另外
   *  在 App.tsx 預先算好一份衍生資料，維持「component 自己決定要從 result 讀什麼」的既有慣例。 */
  result: GenerateResult;
  calibrating: boolean;
  onCalibratingChange: (next: boolean) => void;
  /** 產生下一個 overlay 層的 id（App.tsx 用 useRef 遞增計數，見該檔）；不用 `Date.now()`——
   *  確定性，方便測試與重播疊圖清單（沿用 T1 `createOverlayLayer` 文件的既有理由）。 */
  createOverlayId: () => string;
}

type OverlayUnit = 'pt' | 'mm' | 'px';

const UNIT_OPTIONS: OverlayUnit[] = ['pt', 'mm', 'px'];
const LABEL_CLASS = 'text-[10px] uppercase tracking-wider text-zinc-400';

/** 生成圖層停用提示文字用的完整名稱——GENERATED_LAYER_LABEL 是面板列表的精簡標籤（如
 *  halfcut 顯示「半刀」），三個線型標籤本身已是完整名詞可以直接接「此盒型無」，唯獨
 *  halfcut 的精簡標籤缺一個「線」字，讀起來會變成「此盒型無半刀」，故單獨覆寫這一項。 */
const DISABLED_TITLE_NAME: Record<GeneratedLayerKey, string> = {
  cut: GENERATED_LAYER_LABEL.cut,
  crease: GENERATED_LAYER_LABEL.crease,
  halfcut: '半刀線',
  dimensions: GENERATED_LAYER_LABEL.dimensions,
};

export function LayersPanel({
  layers,
  onLayersChange,
  targetBounds,
  result,
  calibrating,
  onCalibratingChange,
  createOverlayId,
}: LayersPanelProps) {
  const [unit, setUnit] = useState<OverlayUnit>('pt'); // 維護者生產檔慣例，見 spec UI 規格（沿用舊 OverlayPanel 預設）
  // file input 是 uncontrolled 元件，瀏覽器選過檔後「再選同一個檔案」不會觸發 onChange
  // （value 沒變）。舊版只在「清除」（整個疊圖歸零）時遞增這個 key 強制重掛載；多層模型
  // 沒有整體清除動作了（改成逐層刪除，不影響 file input 本身的已選檔案記憶），改成每次
  // 匯入成功都遞增——讓使用者可以連續匯入同名檔案（多層下的合理新用例：同一份生產檔想
  // 疊兩份比較不同校準/offset）。
  const [fileInputKey, setFileInputKey] = useState(0);

  const generatedHasContent = useMemo<Record<GeneratedLayerKey, boolean>>(() => {
    const has: Record<GeneratedLayerKey, boolean> = { cut: false, crease: false, halfcut: false, dimensions: false };
    for (const p of result.paths) has[layerKeyForLineType(p.type)] = true;
    // review finding F3（2026-07-09）：texts（DielineText，恆屬 dimensions 桶，見
    // `overlay/layers.ts` `layerKeyForLineType` 文件）原本沒被上面的迴圈涵蓋——那裡只遍歷
    // `result.paths`，texts 是獨立陣列。v1 現實中標註線與文字成對出現，這個分支目前不可達，
    // 但若某盒型只有 texts、沒有任何 dimension/annotation path，修前邏輯會讓這一列 disabled，
    // 但 Canvas 仍照 `generatedVisible.dimensions` 畫出文字——使用者關不掉画布上的標註文字。
    has.dimensions = has.dimensions || result.texts.length > 0;
    return has;
  }, [result]);

  const selectedLayer = layers.overlays.find((o) => o.id === layers.selectedOverlayId);

  const handleGeneratedVisibleChange = (key: GeneratedLayerKey, visible: boolean): void => {
    onLayersChange({ ...layers, generatedVisible: { ...layers.generatedVisible, [key]: visible } });
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const parsed = parseOverlaySvg(text);
      const id = createOverlayId();
      const newLayer = createOverlayLayer(parsed, file.name, unit, targetBounds, id);
      // review finding F2（2026-07-09）：`onload` 是 FileReader 非同步 callback，觸發時距離
      // 使用者選檔已經過了不定時間（讀檔 I/O）。原本這裡讀取的是 `handleFileChange`呼叫當下
      // 那一輪 render 閉包捕捉到的 `layers`——若等待期間使用者做了其他圖層操作（刪除／改
      // 可見性／校準確認寫回 scale 等），那些變更發生在較新的 render，`{ ...layers, ... }`
      // 一 spread 會用這份舊快照蓋掉它們。改用 functional update（`onLayersChange` 支援
      // updater 函式，見 props 型別）：React 保證 updater 收到的 `prev` 是呼叫當下最新的
      // state，不是選檔當下的舊閉包值，append 新層與其間發生的任何其他變更都不會互相覆蓋。
      onLayersChange((prev) => ({ ...prev, overlays: [...prev.overlays, newLayer], selectedOverlayId: newLayer.id }));
      setFileInputKey((k) => k + 1); // 見上方宣告處註解：每次匯入完成都重掛載
    };
    reader.readAsText(file);
  };

  const handleSelectToggle = (id: string): void => {
    const willDeselect = layers.selectedOverlayId === id;
    onLayersChange({ ...layers, selectedOverlayId: willDeselect ? null : id });
    // FF1（final review round 2，2026-07-09）：取消選中（選中→null）時若正在校準，一併關閉
    // 校準模式——不然會卡在殭屍狀態：Canvas 的校準提示條只看 `calibrating`（見 Canvas.tsx
    // JSX，不看有沒有選中層），選中層消失後提示條仍顯示；點畫布因 handleCalibrationClick 的
    // `!selectedLayer` early return 沒有任何反應；這裡的「校準」鈕又因未選中變成 disabled——
    // 三處疊加，使用者除了按 Esc 別無退路。切到「另一層」（`willDeselect` 為 false）則沿用
    // 既有行為：校準模式維持開啟、對象換成新選中層（Canvas.tsx 既有的 T2 F1 歸零 effect 會
    // 清空 pickedSegmentIndex 讓使用者重新點選，不是這裡要處理的事）。與 `handleDelete`
    // 「刪除選中層時一併關閉校準」是同一個殭屍狀態理由，寫法也對稱（見下方該函式）。
    if (willDeselect && calibrating) onCalibratingChange(false);
  };

  const handleVisibleChange = (id: string, visible: boolean): void => {
    onLayersChange({ ...layers, overlays: updateOverlayLayer(layers.overlays, id, { visible }) });
  };

  const handleOpacityChange = (id: string, rawValue: string): void => {
    onLayersChange({ ...layers, overlays: updateOverlayLayer(layers.overlays, id, { opacity: Number(rawValue) / 100 }) });
  };

  /** 校準鈕本身只切換 calibrating 開關——不帶 layer id 參數：disabled 邏輯已確保只有選中層
   *  的鈕可以被點到，所以「對哪一層校準」永遠等於 `layers.selectedOverlayId`，不需要另外傳。 */
  const handleCalibrateToggle = (): void => onCalibratingChange(!calibrating);

  const handleDelete = (id: string): void => {
    onLayersChange({
      ...layers,
      overlays: removeOverlayLayer(layers.overlays, id),
      selectedOverlayId: layers.selectedOverlayId === id ? null : layers.selectedOverlayId,
    });
    // 刪除的剛好是正在校準的那一層：Canvas 端雖有 Esc 可退出，但這裡兩個 prop 都已經在手上，
    // 順手關掉校準模式，避免留下一條「點選 overlay 上一段已知長度的線」提示條卻永遠選不到
    // 任何線段的死路（selectedOverlayId 已經是 null，Canvas 的 hit-test 會 early-return）。
    if (calibrating && layers.selectedOverlayId === id) onCalibratingChange(false);
  };

  const handleRecenter = (): void => {
    if (!selectedLayer) return;
    const offset = alignOffset(selectedLayer.rawBounds, selectedLayer.scale, targetBounds, 'center');
    onLayersChange({ ...layers, overlays: updateOverlayLayer(layers.overlays, selectedLayer.id, offset) });
  };

  return (
    <div className="flex flex-col gap-3 p-5 bg-zinc-50 border border-zinc-200 rounded-sm">
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">圖層</h3>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          對照調參用——匯入生產刀模、校準比例後與生成層疊圖比對（特別是 R 角與細部結構）。
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <h4 className={LABEL_CLASS}>生成圖層</h4>
        {GENERATED_LAYER_ORDER.map((key) => {
          const hasContent = generatedHasContent[key];
          return (
            <label
              key={key}
              htmlFor={`generated-visible-${key}`}
              title={hasContent ? undefined : `此盒型無${DISABLED_TITLE_NAME[key]}`}
              className={`flex items-center gap-2 text-xs ${hasContent ? 'text-zinc-600' : 'text-zinc-400 cursor-not-allowed'}`}
            >
              <input
                id={`generated-visible-${key}`}
                type="checkbox"
                checked={layers.generatedVisible[key]}
                disabled={!hasContent}
                onChange={(e) => handleGeneratedVisibleChange(key, e.target.checked)}
                className="h-4 w-4 accent-blue-600 disabled:opacity-40"
              />
              {GENERATED_LAYER_LABEL[key]}
            </label>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 pt-2 border-t border-zinc-200">
        <h4 className={LABEL_CLASS}>對照圖層</h4>

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

        <div className="flex flex-col gap-1.5">
          <label htmlFor="overlay-unit" className={LABEL_CLASS}>
            單位
          </label>
          <select
            id="overlay-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as OverlayUnit)}
            className="w-full bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors"
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        {layers.overlays.length > 0 && (
          <div className="flex flex-col gap-2">
            {layers.overlays.map((layer) => {
              const isSelected = layer.id === layers.selectedOverlayId;
              return (
                <div
                  key={layer.id}
                  data-testid={`overlay-layer-${layer.id}`}
                  className={`flex flex-col gap-1.5 p-2 rounded-sm border ${
                    isSelected ? 'border-blue-500 bg-blue-50/40' : 'border-zinc-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handleSelectToggle(layer.id)}
                      aria-pressed={isSelected}
                      title="點擊選中／取消選中此圖層（校準與重新置中的對象）"
                      className="flex-1 text-left text-xs text-zinc-700 truncate hover:text-blue-600"
                    >
                      {layer.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(layer.id)}
                      className="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-600"
                    >
                      刪除
                    </button>
                  </div>

                  <label htmlFor={`overlay-visible-${layer.id}`} className="flex items-center gap-2 text-xs text-zinc-600">
                    <input
                      id={`overlay-visible-${layer.id}`}
                      type="checkbox"
                      checked={layer.visible}
                      onChange={(e) => handleVisibleChange(layer.id, e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    顯示疊圖
                  </label>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <label htmlFor={`overlay-opacity-${layer.id}`} className={LABEL_CLASS}>
                        透明度
                      </label>
                      <span className="text-[10px] font-mono text-zinc-500">{Math.round(layer.opacity * 100)}%</span>
                    </div>
                    <input
                      id={`overlay-opacity-${layer.id}`}
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(layer.opacity * 100)}
                      onChange={(e) => handleOpacityChange(layer.id, e.target.value)}
                      className="w-full accent-blue-600"
                    />
                  </div>

                  {/* 校準鈕：disabled 邏輯比舊版多一道「必須是選中層」的 gate（見檔頭 docblock）；
                      沿用既有 visible gate（FX2，Slice 3 final review：隱藏疊圖時不可校準）。 */}
                  <button
                    type="button"
                    onClick={handleCalibrateToggle}
                    disabled={!isSelected || !layer.visible}
                    title={!isSelected ? '先選取此圖層' : !layer.visible ? '先開啟顯示疊圖' : undefined}
                    className="w-full px-2 py-1.5 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100 text-xs shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
                  >
                    {isSelected && calibrating ? '取消校準' : '校準'}
                  </button>

                  {layer.warnings.length > 0 && (
                    <ul className="flex flex-col gap-0.5 bg-yellow-50 border border-yellow-200 text-yellow-800 text-[11px] rounded-sm p-2">
                      {layer.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={handleRecenter}
          disabled={layers.selectedOverlayId === null}
          title={layers.selectedOverlayId === null ? '先選取一個圖層' : undefined}
          className="w-full px-2 py-1.5 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-100 text-xs shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
        >
          重新置中
        </button>
      </div>
    </div>
  );
}
