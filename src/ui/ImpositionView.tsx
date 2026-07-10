/**
 * ImpositionView：拼版估算 UI 入口——`ImpositionControls`（本檔，橫排 toolbar）與
 * `ImpositionResults`（`./ImpositionResults.tsx`，結果／預覽卡片）兩個可獨立掛載的元件，
 * 共用同一份提升到呼叫端的 `ImpositionState`（F6「模式往返保留」要求 App.tsx 持有它，
 * 切回設計模式再切回來時原值仍在，元件本身不可以有任何內部 state）。
 *
 * 檔案拆分（gate round 1 T4：`ImpositionControls` 橫排 toolbar 重寫讓合併檔超過 800 行
 * cap，brief 預授權拆法）：`ImpositionState` 型別／`computeImpositionView` 共用計算／
 * `ImpositionResults`／`DirectionCard`／`SectionGroup`／預覽 SVG 視覺常數全部搬到
 * `./ImpositionResults.tsx`，本檔只留 `ImpositionControls` 與組合 wrapper `ImpositionView`。
 * 搬移方向刻意讓 import 只單向（本檔 import `./ImpositionResults`，反過來不成立）避免
 * 循環依賴：`ImpositionControls` 需要呼叫 `computeImpositionView` 取得
 * `pieces`/`isCustomPaper`/`errorFor`，組合 wrapper 需要渲染 `ImpositionResults` 元件，
 * 兩者都是本檔「用到對面」——若 `computeImpositionView` 留在本檔、`ImpositionState` 卻
 * 搬過去（或反過來只搬一半），就會兩邊互相 import 而觸發 `npm run check:cycles`。公開
 * 介面不變：`ImpositionState`／`ImpositionResultsProps` 型別與 `ImpositionResults` 元件
 * 在本檔重新 export（見檔尾），既有從 `@/ui/ImpositionView` 這個路徑 import 的呼叫端
 * （App.tsx／測試）完全不必改路徑。F1 製造 bounds 硬規則／stalePiece fail loud／輸入
 * domain 錯誤顯示／preview cap 語意等完整契約說明見 `./ImpositionResults.tsx` 檔頭與
 * `computeImpositionView` docblock（現在的實際定義處）。
 *
 * 佈局（T4 定案，取代 T1 側欄直排暫時形態——gate 驗收反饋「放在右側預覽區域上方，把紙張
 * 規格、方向、作業模式改成按鈕形式」）：`ImpositionControls` 是掛在 App 主區、預覽正上方的
 * 橫排 toolbar（件選擇／紙規／方向／裁切／旋轉／咬口／刀線間距，分組＋icon+短 label 按鈕），
 * `ImpositionResults` 緊接在下方（工作尺寸文字＋0°/90° 兩張同等權重卡片，各自內嵌一份真實
 * 輪廓排列預覽＋界線聲明）。Tailwind 樣式沿用既有面板慣例（`LayersPanel.tsx`／
 * `ParamPanel.tsx` 的 zinc 色系、text-xs、uppercase tracking 標題、label+htmlFor 配對）；
 * toolbar 按鈕選中態沿用 `App.tsx` 模式切換鈕的 zinc 選中慣例（見 `toolbarButtonClass`）。
 */
import type { GenerateResult } from '@/core/types';
import { PAPER_PRESETS, MIN_GAP_MM } from '@/core/imposition';
import type { ImpositionFieldError, SheetOrientation } from '@/core/imposition';
import {
  IconCutH,
  IconCutV,
  IconLandscape,
  IconPaper2535,
  IconPaper2739,
  IconPaper3143,
  IconPaperCustom,
  IconPortrait,
  IconRotate,
} from './impositionIcons';
import { computeImpositionView, ImpositionResults } from './ImpositionResults';
import type { ImpositionState, ImpositionResultsProps } from './ImpositionResults';

// 重新 export：`ImpositionState`／`ImpositionResultsProps`／`ImpositionResults` 的實際
// 定義搬到 `./ImpositionResults.tsx`（見檔頭 docblock「檔案拆分」），這裡重新曝露維持
// `@/ui/ImpositionView` 對既有呼叫端（App.tsx／測試）的公開介面不變。
export type { ImpositionState, ImpositionResultsProps };
export { ImpositionResults };

export interface ImpositionViewProps {
  result: GenerateResult;
  state: ImpositionState;
  onChange: (next: ImpositionState) => void;
}

/** `ImpositionControls` 的 props 與 `ImpositionView` 完全相同（result/state/onChange）——
 *  T4 掛入 App 主區 toolbar 時直接傳同一組三個 props；具名別名純為消費端的可讀性。 */
export type ImpositionControlsProps = ImpositionViewProps;

const LABEL_CLASS = 'text-[10px] uppercase tracking-wider text-zinc-400';
const CONTROL_CLASS =
  'w-full bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors';
/** toolbar 橫排後數字輸入縮窄用（T4，取代側欄直排時代的 `w-full`）：自訂紙規 W/H／咬口／
 *  gap 四個數字欄在橫排 toolbar 裡不需要、也不該撐滿一整行寬度。 */
const NUMBER_INPUT_CLASS =
  'w-20 bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors';
const ERROR_TEXT_CLASS = 'text-[11px] text-red-600';

const ORIENTATION_OPTIONS: { value: SheetOrientation; label: string }[] = [
  { value: 'portrait', label: '直放' },
  { value: 'landscape', label: '橫放' },
];

/** reason → 使用者看得懂的中文訊息。`below-min` 目前只有 `gap` 欄位會觸發（`MIN_GAP_MM`
 *  是唯一的 below-min 下限來源，見 core/imposition.ts `checkGap`），訊息直接引用該常數。 */
function fieldErrorMessage(reason: ImpositionFieldError['reason']): string {
  switch (reason) {
    case 'not-finite':
      return '請輸入有效數字';
    case 'not-positive':
      return '必須大於 0';
    case 'below-min':
      return `不得小於 ${MIN_GAP_MM}mm`;
    case 'out-of-range':
      return '數值超出安全範圍';
    case 'internal':
      return '內部計算錯誤';
  }
}

/** toolbar 按鈕選中/未選樣式：沿用 `App.tsx` `modeButtonClass` 的 zinc 選中慣例（選中
 *  `bg-zinc-900 text-white`、未選白底＋zinc 邊框／文字），這裡另外固定 icon+label 的橫向
 *  排列與間距。`App.tsx` 的 `modeButtonClass` 未 export，兩處各自定義同構的小函式而非
 *  互相 import——避免在「App 已單向 import ImpositionView」之上再長出反向依賴。 */
function toolbarButtonClass(isActive: boolean): string {
  const base = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border text-xs font-medium whitespace-nowrap transition-colors';
  return isActive
    ? `${base} bg-zinc-900 border-zinc-900 text-white`
    : `${base} bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50`;
}

/** 紙規 preset id → 對應圖示（見 `impositionIcons.tsx` 檔頭「矩形內小字」現場定案）。
 *  `PAPER_PRESETS` 的 id 是 core 端的 `string`（非字面量聯集，見 `core/imposition.ts`
 *  `PaperPreset` 介面），用 switch 而非 `Record` 查找可以避免 `noUncheckedIndexedAccess`
 *  逼出的 `| undefined` 分支——三個 case 窮舉、default 落回自訂圖示，理論上不會發生
 *  （PAPER_PRESETS 只有這三個 id）但不讓按鈕在假設之外的 id 下整顆圖示消失。 */
function PaperPresetIcon({ id }: { id: string }) {
  switch (id) {
    case '31x43':
      return <IconPaper3143 />;
    case '25x35':
      return <IconPaper2535 />;
    case '27x39':
      return <IconPaper2739 />;
    default:
      return <IconPaperCustom />;
  }
}

/** 拼版控制面板：件選擇／紙規／方向／裁切／旋轉／咬口／刀線間距，橫排 toolbar（T4，取代
 *  T1 暫時形態的左側欄直排下拉／checkbox——gate 驗收反饋「放在右側預覽區域上方，把紙張
 *  規格、方向、作業模式改成按鈕形式（繪製好看的SVG）」）。T4 掛入 App 主區、`ImpositionResults`
 *  正上方（spec「組裝」段）；可獨立於 `ImpositionResults` 掛載，唯一互動出口是 `onChange`。
 *  裁切（cutV/cutH）不再走「作業模式」四選一下拉——兩顆獨立 toggle 按鈕直接疊加（四開＝
 *  兩個都按下），`modeValueFromCuts`/`cutsFromModeValue`/`MODE_OPTIONS` 整層映射隨舊下拉
 *  一起退役（T1 docblock 已預告，見 gate round 1 T1 commit）。件選擇維持下拉（清單長度依
 *  盒型片數浮動，按鈕組不適合）；咬口／刀線間距維持數字輸入，僅縮窄寬度。 */
export function ImpositionControls({ result, state, onChange }: ImpositionControlsProps) {
  const { pieces, isCustomPaper, errorFor } = computeImpositionView(result, state);
  const update = <K extends keyof ImpositionState>(key: K, value: ImpositionState[K]): void => {
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="flex flex-col gap-2 p-4 bg-zinc-50 border border-zinc-200 rounded-sm">
      <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">拼版設定</h3>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="w-40 shrink-0 flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>件</span>
          {pieces === undefined ? (
            <p className="text-sm text-zinc-600">整件</p>
          ) : (
            <select
              aria-label="件"
              value={state.pieceId ?? ''}
              onChange={(e) => update('pieceId', e.target.value)}
              className={CONTROL_CLASS}
            >
              {pieces.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label.zh}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>紙規</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="紙規">
            {PAPER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={state.paperPresetId === p.id}
                onClick={() => update('paperPresetId', p.id)}
                className={toolbarButtonClass(state.paperPresetId === p.id)}
              >
                <PaperPresetIcon id={p.id} />
                <span>{p.label}</span>
              </button>
            ))}
            <button
              type="button"
              aria-pressed={isCustomPaper}
              onClick={() => update('paperPresetId', 'custom')}
              className={toolbarButtonClass(isCustomPaper)}
            >
              <IconPaperCustom />
              <span>自訂</span>
            </button>
          </div>
        </div>

        {isCustomPaper && (
          <div className="flex gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="imposition-custom-w" className={LABEL_CLASS}>
                W (mm)
              </label>
              <input
                id="imposition-custom-w"
                type="number"
                step="any"
                value={state.customW}
                onChange={(e) => update('customW', Number(e.target.value))}
                className={NUMBER_INPUT_CLASS}
              />
              {errorFor('paperW') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('paperW')!.reason)}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="imposition-custom-h" className={LABEL_CLASS}>
                H (mm)
              </label>
              <input
                id="imposition-custom-h"
                type="number"
                step="any"
                value={state.customH}
                onChange={(e) => update('customH', Number(e.target.value))}
                className={NUMBER_INPUT_CLASS}
              />
              {errorFor('paperH') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('paperH')!.reason)}</p>}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>方向</span>
          <div className="flex gap-1.5" role="group" aria-label="方向">
            {ORIENTATION_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={state.orientation === o.value}
                onClick={() => update('orientation', o.value)}
                className={toolbarButtonClass(state.orientation === o.value)}
              >
                {o.value === 'portrait' ? <IconPortrait /> : <IconLandscape />}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 裁切：對開 V／對開 H 各自獨立 toggle，可疊加＝四開（取代舊「作業模式」四選一，
            見上方函式 docblock）。 */}
        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>裁切</span>
          <div className="flex gap-1.5" role="group" aria-label="裁切">
            <button
              type="button"
              aria-pressed={state.cutV}
              onClick={() => update('cutV', !state.cutV)}
              className={toolbarButtonClass(state.cutV)}
            >
              <IconCutV />
              <span>對開 V</span>
            </button>
            <button
              type="button"
              aria-pressed={state.cutH}
              onClick={() => update('cutH', !state.cutH)}
              className={toolbarButtonClass(state.cutH)}
            >
              <IconCutH />
              <span>對開 H</span>
            </button>
          </div>
        </div>

        {/* 可轉 90°（L 形補排）：單顆 toggle，取代 T1 的 checkbox。 */}
        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>旋轉</span>
          <button
            type="button"
            aria-pressed={state.allowRotate}
            onClick={() => update('allowRotate', !state.allowRotate)}
            className={toolbarButtonClass(state.allowRotate)}
          >
            <IconRotate />
            <span>可轉 90°</span>
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="imposition-gripper" className={LABEL_CLASS}>
            咬口 (mm)
          </label>
          <input
            id="imposition-gripper"
            type="number"
            step="any"
            value={state.gripper}
            onChange={(e) => update('gripper', Number(e.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
          {errorFor('gripper') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('gripper')!.reason)}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="imposition-gap" className={LABEL_CLASS}>
            刀線間距 (mm)
          </label>
          <input
            id="imposition-gap"
            type="number"
            step="any"
            value={state.gap}
            onChange={(e) => update('gap', Number(e.target.value))}
            className={NUMBER_INPUT_CLASS}
          />
          {errorFor('gap') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('gap')!.reason)}</p>}
        </div>
      </div>
    </div>
  );
}

/** 組合 wrapper（review Medium 2 fix round 1）：公開介面與既有測試不變，內部垂直堆疊
 *  `ImpositionControls`（toolbar）＋`ImpositionResults`，對齊 T4 定案後 App 主區的實際
 *  掛法。App.tsx 現在直接分別 import `ImpositionControls`／`ImpositionResults`、不使用
 *  這個組合 wrapper——它純粹作為測試與其他潛在呼叫端的便利入口保留。 */
export function ImpositionView({ result, state, onChange }: ImpositionViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <ImpositionControls result={result} state={state} onChange={onChange} />
      <ImpositionResults result={result} state={state} />
    </div>
  );
}
