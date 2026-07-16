/**
 * ImpositionView：拼版估算 UI 入口——`ImpositionControls`（本檔，橫排 toolbar）與
 * `ImpositionResults`（`./ImpositionResults.tsx`，結果／預覽卡片）兩個可獨立掛載的元件，
 * 共用同一份提升到呼叫端的 `ImpositionState`（F6「模式往返保留」要求 App.tsx 持有它，
 * 切回設計模式再切回來時原值仍在，元件本身不可以有任何內部 state）。
 *
 * 檔案拆分（gate round 1 T4：`ImpositionControls` 橫排 toolbar 重寫讓合併檔超過 800 行
 * cap，spec 預授權拆法）：`ImpositionState` 型別／`computeImpositionView` 共用計算／
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
 * M2 T1 起，`ImpositionControls` 採用 `vocab.css` 的 `.imp-toolbar`／`.imp-group`／`.btn.tog`
 * 純文字儀器語彙；件選擇維持下拉，紙規、方向、裁切與旋轉的互動語義不變。
 */
import type { GenerateResult } from '@/core/types';
import { PAPER_PRESETS, MIN_GAP_MM } from '@/core/imposition';
import type { ImpositionFieldError } from '@/core/imposition';
import { getLang, t } from '@/i18n/t';
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

/** reason → 凍結的 imp.* 字典文案。 */
function fieldErrorMessage(reason: ImpositionFieldError['reason']): string {
  switch (reason) {
    case 'not-finite':
      return t('imp.err.field.notFinite');
    case 'not-positive':
      return t('imp.err.field.notPositive');
    case 'below-min':
      return t('imp.err.field.belowMin', { MIN_GAP_MM: String(MIN_GAP_MM) });
    case 'out-of-range':
      return t('imp.err.field.outOfRange');
    case 'internal':
      return t('imp.err.field.internal');
  }
}

function paperPresetLabel(id: string): string {
  switch (id) {
    case '31x43':
      return t('imp.sheet.preset.31x43');
    case '25x35':
      return t('imp.sheet.preset.25x35');
    case '27x39':
      return t('imp.sheet.preset.27x39');
    default:
      throw new Error(`Missing imposition preset label: ${id}`);
  }
}

/** 七群組拼版 toolbar；所有 state 都由呼叫端持有，唯一寫入出口仍是 `onChange`。 */
export function ImpositionControls({ result, state, onChange }: ImpositionControlsProps) {
  const { pieces, isCustomPaper, errorFor } = computeImpositionView(result, state);
  const paperWError = errorFor('paperW');
  const paperHError = errorFor('paperH');
  const gripperError = errorFor('gripper');
  const gapError = errorFor('gap');
  const update = <K extends keyof ImpositionState>(key: K, value: ImpositionState[K]): void => {
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="imp-toolbar" role="group" aria-label={t('imp.title')}>
      <div className="imp-group">
        <span className="k mono">{t('imp.piece')}</span>
        <div className="row">
          {pieces === undefined ? (
            <span className="label">{t('imp.piece.whole')}</span>
          ) : (
            <div className="boxsel">
              <select
                aria-label={t('imp.piece')}
                value={state.pieceId ?? ''}
                onChange={(event) => update('pieceId', event.target.value)}
              >
                {pieces.map((piece) => (
                  <option key={piece.id} value={piece.id}>
                    {piece.label[getLang()]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="imp-group">
        <span className="k mono">{t('imp.sheet')}</span>
        <div className="row">
          {PAPER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={state.paperPresetId === preset.id}
              onClick={() => update('paperPresetId', preset.id)}
              className={`btn label tog${state.paperPresetId === preset.id ? ' on' : ''}`}
            >
              {paperPresetLabel(preset.id)}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={isCustomPaper}
            onClick={() => update('paperPresetId', 'custom')}
            className={`btn label tog${isCustomPaper ? ' on' : ''}`}
          >
            {t('imp.sheet.custom')}
          </button>

          {isCustomPaper && (
            <>
              <div>
                <label htmlFor="imposition-custom-w" className="k mono">
                  {t('imp.sheet.w')}
                </label>
                <input
                  id="imposition-custom-w"
                  type="number"
                  step="any"
                  value={state.customW}
                  onChange={(event) => update('customW', Number(event.target.value))}
                  className="w-20"
                />
                {paperWError && <p className="mono err">{fieldErrorMessage(paperWError.reason)}</p>}
              </div>
              <div>
                <label htmlFor="imposition-custom-h" className="k mono">
                  {t('imp.sheet.h')}
                </label>
                <input
                  id="imposition-custom-h"
                  type="number"
                  step="any"
                  value={state.customH}
                  onChange={(event) => update('customH', Number(event.target.value))}
                  className="w-20"
                />
                {paperHError && <p className="mono err">{fieldErrorMessage(paperHError.reason)}</p>}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="imp-group">
        <span className="k mono">{t('imp.orient')}</span>
        <div className="row">
          <button
            type="button"
            aria-pressed={state.orientation === 'portrait'}
            onClick={() => update('orientation', 'portrait')}
            className={`btn label tog${state.orientation === 'portrait' ? ' on' : ''}`}
          >
            {t('imp.orient.portrait')}
          </button>
          <button
            type="button"
            aria-pressed={state.orientation === 'landscape'}
            onClick={() => update('orientation', 'landscape')}
            className={`btn label tog${state.orientation === 'landscape' ? ' on' : ''}`}
          >
            {t('imp.orient.landscape')}
          </button>
        </div>
      </div>

      <div className="imp-group">
        <span className="k mono">{t('imp.halving')}</span>
        <div className="row">
          <button
            type="button"
            aria-pressed={state.cutV}
            onClick={() => update('cutV', !state.cutV)}
            className={`btn label tog${state.cutV ? ' on' : ''}`}
          >
            {t('imp.halving.v')}
          </button>
          <button
            type="button"
            aria-pressed={state.cutH}
            onClick={() => update('cutH', !state.cutH)}
            className={`btn label tog${state.cutH ? ' on' : ''}`}
          >
            {t('imp.halving.h')}
          </button>
        </div>
      </div>

      <div className="imp-group">
        <span className="k mono">{t('imp.rotate')}</span>
        <div className="row">
          <button
            type="button"
            aria-pressed={state.allowRotate}
            onClick={() => update('allowRotate', !state.allowRotate)}
            className={`btn label tog${state.allowRotate ? ' on' : ''}`}
          >
            {t('imp.rotate.allow')}
          </button>
        </div>
      </div>

      <div className="imp-group">
        <label htmlFor="imposition-gripper" className="k mono">
          {t('imp.gripper')}
        </label>
        <div className="row">
          <input
            id="imposition-gripper"
            type="number"
            step="any"
            value={state.gripper}
            onChange={(event) => update('gripper', Number(event.target.value))}
            className="w-20"
          />
          {gripperError && <p className="mono err">{fieldErrorMessage(gripperError.reason)}</p>}
        </div>
      </div>

      <div className="imp-group">
        <label htmlFor="imposition-gap" className="k mono">
          {t('imp.gutter')}
        </label>
        <div className="row">
          <input
            id="imposition-gap"
            type="number"
            step="any"
            value={state.gap}
            onChange={(event) => update('gap', Number(event.target.value))}
            className="w-20"
          />
          {gapError && <p className="mono err">{fieldErrorMessage(gapError.reason)}</p>}
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
