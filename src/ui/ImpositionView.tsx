/**
 * ImpositionView：拼版估算主畫面——受控元件，state 全部提升至呼叫端（F6「模式往返保留」
 * 要求 App.tsx 持有 `ImpositionState`，切回設計模式再切回來時原值仍在，元件本身不可以有
 * 任何內部 state）。
 *
 * 佈局：左側控制面板（件選擇／紙規／方向／作業模式／咬口／刀線間距）＋右側結果區
 * （工作尺寸文字＋0°/90° 兩張同等權重卡片，各自內嵌一份真實輪廓排列預覽＋界線聲明）。
 * Tailwind 樣式沿用既有面板慣例（`LayersPanel.tsx`／`ParamPanel.tsx` 的 zinc 色系、
 * text-xs、uppercase tracking 標題、label+htmlFor 配對）。
 *
 * 模尺寸來源（spec F1 硬規則）：一律用 `manufacturingBounds(result, piece)` 取得寬高餵給
 * `computeImposition`，**不得**使用 `result.bounds`／`piece.bounds`（那兩者依 pieces.ts
 * 的三向等式含尺寸標註線外擴，會讓拼版拼得比實際寬鬆——見 core/bounds.ts 檔頭 docblock、
 * `tests/imposition-anchor.test.ts` 的 12 模 vs 6 模實證）。
 *
 * 件選擇與 `ImpositionState.pieceId` 的 fallback 生命週期（多片盒型換片／盒型切換／
 * `linerEnabled=false` 導致選中片消失時改選第一個有效片）是 T4（App 整合）的職責——
 * 本元件只負責「依目前 `state.pieceId` 渲染下拉／解析對應的 piece」，不做防呆 fallback。
 * 但 `result.pieces` 存在且 `state.pieceId` 找不到對應片時（含 `pieceId===null` 與
 * stale id 兩種情況，T4 的 fallback effect 尚未來得及修正的過渡 render），**不得**退成
 * `manufacturingBounds(result, undefined)` 的「全版」bounds——spec F6 明定拼版沒有
 * `null＝全版` 語意（review Medium 1 fix round 1：舊實作曾經這樣退，是 spec 違反，已改為
 * fail loud：兩卡「—」、不渲染排列、顯示整體錯誤「請選擇拼版的件」，等待 T4 的 fallback
 * 生效）。RTE（`result.pieces===undefined`）不受影響，仍是「本來就沒有片可選」的合法穩態，
 * `piece` 恆為 `undefined`、`manufacturingBounds(result, undefined)` 取全版幾何是正確
 * 行為，不是這裡說的過渡態。見下方 `computeImpositionView` 的 `stalePiece`。
 *
 * 輸入 domain 錯誤顯示（spec 輸入 domain 表）：`paperW`／`paperH`（僅自訂紙規時有對應輸入
 * 框）／`gripper`／`gap` 四欄逐一標到各自輸入框旁；`pieceW`／`pieceH`（由 manufacturingBounds
 * 自動導出，沒有可編輯輸入框）與 `result`（`reason:'internal'`，計算內部錯誤）統一走
 * 整體錯誤訊息——沒有輸入框可以標，也不該假裝有。stalePiece 與這組 domain 錯誤是正交的
 * 兩件事：domain 錯誤仍照原本欄位標紅字，stalePiece 只多加一個整體錯誤訊息、並讓兩卡與
 * 預覽變成不可用（見 `computeImpositionView` 的 `impositionUsable`）。
 *
 * 元件拆分（review Medium 2 fix round 1）：控制面板（`ImpositionControls`）與結果／預覽
 * （`ImpositionResults`）拆成兩個可獨立掛載的 export，供 T4 依 spec「組裝」段分別掛進
 * App 的側欄與主區（不再綁死同一個 flex 容器）。`ImpositionView` 保留為組合 wrapper，
 * 公開介面（`ImpositionViewProps`）與既有測試不變。兩者共用的計算（`piece` 解析／
 * `manufacturingBounds`／`computeImposition`／instance 排列）抽到本檔案內部的
 * `computeImpositionView(result, state)`——刻意讓兩邊「各自呼叫一次純函式」而非共享
 * React context／額外 state：T4 最終佈局裡兩個元件不保證是同一子樹的鄰居（側欄 vs
 * 主區），且計算本身夠廉價（instance 上限 500，見 fix round 1 High 修復），重複呼叫
 * 不是效能問題。
 */
import type { Bounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult } from '@/core/types';
import {
  computeImposition,
  PAPER_PRESETS,
  MIN_GAP_MM,
  MAX_PREVIEW_INSTANCES,
} from '@/core/imposition';
import type { DirectionResult, ImpositionFieldError, ImpositionInput, SheetOrientation, WorkingSheet } from '@/core/imposition';
import { manufacturingBounds } from '@/core/bounds';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';
import { directionInstances, previewPaths, sectionOffsets } from './impositionPreview';
import type { PreviewInstance } from './impositionPreview';

/** 拼版模式的完整可往返 state（F6：盒型／盒參數／紙規／方向／裁切／咬口／gap／
 *  拼版件選擇——逐欄列舉，切設計模式再切回來必須原值不改）。
 *  `cutV`/`cutH`/`allowRotate`（gate round 1 T1 取代舊 `mode: SheetMode` 單選）：
 *  逐字對應 `core/imposition.ts` 的 `ImpositionInput` 同名欄位，UI 端不再需要一層
 *  mode→cutV/cutH 的映射就能直接餵給 `computeImposition`——映射只發生在「作業模式」
 *  下拉這個暫時保留原外觀的元件內部（見 `MODE_OPTIONS`／`modeValueFromCuts`）。 */
export interface ImpositionState {
  /** RTE（`result.pieces` 為 undefined）恆為 `null`＝整件；多片盒型對應 `pieces[].id`。 */
  pieceId: string | null;
  /** `PAPER_PRESETS` 其中一個 id，或找不到對應 preset 時視為「自訂」（改用 customW/H）。 */
  paperPresetId: string;
  customW: number;
  customH: number;
  orientation: SheetOrientation;
  cutV: boolean;
  cutH: boolean;
  allowRotate: boolean;
  gripper: number;
  gap: number;
}

export interface ImpositionViewProps {
  result: GenerateResult;
  state: ImpositionState;
  onChange: (next: ImpositionState) => void;
}

/** `ImpositionControls` 的 props 與 `ImpositionView` 完全相同（result/state/onChange）——
 *  T4 掛入側欄時直接傳同一組三個 props；具名別名純為 T4 消費時的可讀性。 */
export type ImpositionControlsProps = ImpositionViewProps;

/** `ImpositionResults` 只讀不寫（結果區沒有任何互動元素），故不需要 `onChange`。 */
export interface ImpositionResultsProps {
  result: GenerateResult;
  state: ImpositionState;
}

const DISCLAIMER_TEXT =
  '以單件外接矩形估算，僅計單層 L 形 90° 補排；未計遞迴塞角、異形咬合、共刀、絲向及加工限制，不可直接作生產拼版。';

const LABEL_CLASS = 'text-[10px] uppercase tracking-wider text-zinc-400';
const CONTROL_CLASS =
  'w-full bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors';
const ERROR_TEXT_CLASS = 'text-[11px] text-red-600';

/** 「作業模式」下拉的暫時形態（T1 範圍聲明）：UI 沿用四選一外觀，`value` 字串不進 core
 *  型別（core 只認 `cutV`/`cutH` 布林）——T4 會把這顆下拉換成 toolbar 按鈕，屆時這個
 *  select-value 映射層直接整層退役，不會遺留半成品。 */
type ModeOptionValue = 'full' | 'halfV' | 'halfH' | 'quarter';

const MODE_OPTIONS: { value: ModeOptionValue; label: string }[] = [
  { value: 'full', label: '整紙' },
  { value: 'halfV', label: '對開 V（左右對切）' },
  { value: 'halfH', label: '對開 H（上下對切）' },
  { value: 'quarter', label: '四開（V+H）' },
];

/** `state.cutV`/`state.cutH` → 下拉目前應顯示的 option value（衍生值，不是獨立 state）。 */
function modeValueFromCuts(cutV: boolean, cutH: boolean): ModeOptionValue {
  if (cutV && cutH) return 'quarter';
  if (cutV) return 'halfV';
  if (cutH) return 'halfH';
  return 'full';
}

/** 下拉選取的 option value → `{cutV,cutH}`（onChange 時一次寫回兩個欄位）。 */
function cutsFromModeValue(value: ModeOptionValue): { cutV: boolean; cutH: boolean } {
  switch (value) {
    case 'halfV':
      return { cutV: true, cutH: false };
    case 'halfH':
      return { cutV: false, cutH: true };
    case 'quarter':
      return { cutV: true, cutH: true };
    case 'full':
      return { cutV: false, cutH: false };
  }
}

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

// ─────────────────────────────────────────────────────────────────────────
// 預覽 SVG 視覺常數（T3 全紙預覽重寫：紙張外框＋裁切中線＋每子紙咬口/可用區＋instances）
// ─────────────────────────────────────────────────────────────────────────

const SHEET_FRAME_STROKE = '#a1a1aa'; // zinc-400 附近，全紙外框
const CUT_LINE_STROKE = '#71717a'; // zinc-500 附近，裁切中線示意
const CUT_LINE_DASHARRAY = '10 6';
const GRIPPER_ZONE_FILL = '#f4f4f5'; // zinc-100，咬口淡色區（每子紙全範圍）
const USABLE_ZONE_FILL = '#ffffff'; // 可用區（扣咬口，instances 實際落點）
const USABLE_ZONE_STROKE = '#e4e4e7'; // zinc-200

/**
 * 紙張結構線（外框／裁切中線／可用區框）的 px 語意線寬——T3 取代舊版
 * `PREVIEW_STROKE_SCALE`（乘大 mm 級線寬撐視覺）的做法，改搭配下方所有結構線元素的
 * `vectorEffect="non-scaling-stroke"`：這幾個數字是畫面上恆定的 CSS 像素寬度，不隨
 * viewBox／紙張 mm 尺度縮放。法蘭 gate 反饋「線條粗細統一和單紙盒刀模一致」：刀模
 * paths 沿用 `LINE_STYLES[type].strokeWidth` 原始值＋non-scaling-stroke（與 Canvas.tsx
 * 逐字同構，見該檔 docblock），使得全紙縮到卡片大小時的刀模線觀感與單片畫布視圖同一個
 * CSS 像素粗細；紙張結構線（不是刀模幾何本身）用獨立一組較粗的常數，純視覺分層，不影響
 * 任何數值計算（cols/rows/count/utilization 皆與這組常數無關）。
 */
const SHEET_FRAME_STROKE_WIDTH = 2;
const CUT_LINE_STROKE_WIDTH = 1.5;
const USABLE_ZONE_STROKE_WIDTH = 1;

/** 單一子紙在全紙座標系裡的渲染資料：偏移（`sectionOffsets` 給的左上角 dx/dy）＋這個子紙
 *  實際分配到的 instances（含補排件，budget 已在建立前生效，見 `sectionRenders`）。 */
interface SectionRender {
  dx: number;
  dy: number;
  instances: PreviewInstance[];
}

/**
 * 跨子紙 remainingBudget 鏈（Global Constraints「preview cap 語意」，T3 收掉 T1 interim
 * `isTruncated` 用 gridCount 比對 instances.length 的假陽性／四開漏報兩個方向的問題）：
 * cap 是「這張方向卡合計最多 `MAX_PREVIEW_INSTANCES`」，不是每子紙各自 500——依
 * `sectionOffsets` 固定順序（左上→右上→左下→右下）逐子紙呼叫 `directionInstances`，扣除
 * 實際回傳數量再傳給下一子紙，不做均分；budget 見底的子紙拿到空陣列。每子紙用同一份
 * `direction`/`mb`/`gripper`/`gap`（同版複製——補排件已含在 instances 裡，旋轉已反映在
 * transform 字串，不需要在這裡另外處理）。
 */
function sectionRenders(
  dir: 0 | 90,
  direction: DirectionResult,
  sheet: WorkingSheet,
  mb: Bounds,
  gripper: number,
  gap: number,
): SectionRender[] {
  let remaining = MAX_PREVIEW_INSTANCES;
  return sectionOffsets(sheet).map(({ dx, dy }) => {
    const instances = directionInstances(dir, direction, mb, gripper, gap, remaining);
    remaining -= instances.length;
    return { dx, dy, instances };
  });
}

/**
 * 工作尺寸文字（T3）：整紙（`!cutV && !cutH`）維持舊格式逐字不變（spec 附錄「回歸保證」）；
 * 有裁切時補上全紙尺寸——法蘭 gate 反饋「一律顯示全紙尺寸」後，使用者需要同時看到「這張
 * 紙原本多大」與「可落版的子紙多大」兩個尺度，缺一都會誤讀（只看子紙會誤以為紙變小了、
 * 只看全紙不知道實際可用區縮水多少）。四開／對開用不同名詞（「四開子紙」／「半張子紙」）
 * 呼應 `directionCardText` 卡片文字的「每四開」／「每半張」措辭，維持全元件詞彙一致。
 */
function workingSheetText(sheet: WorkingSheet): string {
  if (!sheet.cutV && !sheet.cutH) {
    return `工作尺寸：${sheet.w.toFixed(1)} × ${sheet.h.toFixed(1)} mm（可用區 ${sheet.usableW.toFixed(1)} × ${sheet.usableH.toFixed(1)} mm）`;
  }
  const subLabel = sheet.cutV && sheet.cutH ? '四開子紙' : '半張子紙';
  const sub = `${sheet.w.toFixed(1)} × ${sheet.h.toFixed(1)} mm（可用 ${sheet.usableW.toFixed(1)} × ${sheet.usableH.toFixed(1)} mm）`;
  return `全紙 ${sheet.fullW.toFixed(1)} × ${sheet.fullH.toFixed(1)} mm，${subLabel} ${sub}`;
}

/**
 * 卡片主要數字行文字（T3「卡片文字格式」，見 brief＋附錄回歸保證）：裁切時完全換一套
 * 措辭（每半張／每四開 × 子紙數＝總模數），不是在整紙格式後面加註記——cols/rows/補X 是
 * 「單一子紙怎麼排」的資訊，裁切後使用者更關心「一張全紙總共出幾模」，兩種措辭服務不同
 * 問題，混在同一行反而混淆。`sectionsCount` 直接來自 `workingSheet.sections`（不是硬編碼
 * 2／4），避免與 core 的裁切旗標→子紙數換算式重複維護而漂移。
 */
function directionCardText(direction: DirectionResult, sectionsCount: number, isCut: boolean, isQuarter: boolean): string {
  if (isCut) {
    return `${isQuarter ? '每四開' : '每半張'} ${direction.count} 模 × ${sectionsCount} ＝ ${direction.totalCount} 模`;
  }
  const fillCount = (direction.bottomFill?.count ?? 0) + (direction.rightFill?.count ?? 0);
  const fillSuffix = fillCount > 0 ? ` ＋ 補 ${fillCount}` : '';
  return `${direction.cols} 列 × ${direction.rows} 行${fillSuffix} ＝ ${direction.count} 模`;
}

/** 單一子紙的 SVG 內容：咬口淡色區＋可用區＋同一份 instances（同版複製，補排件已含在
 *  陣列裡、旋轉已反映在 transform，見 `sectionRenders` docblock）。從 `DirectionCard` 抽出
 *  是因為每張卡最多重複渲染 4 次（四開），不是單次用途的內聯標記。 */
function SectionGroup({
  section,
  workingSheet,
  gripper,
  paths,
}: {
  section: SectionRender;
  workingSheet: WorkingSheet;
  gripper: number;
  paths: DielinePath[];
}) {
  return (
    <g data-testid="section" transform={`translate(${section.dx} ${section.dy})`}>
      <rect data-testid="gripper-zone" x={0} y={0} width={workingSheet.w} height={workingSheet.h} fill={GRIPPER_ZONE_FILL} />
      <rect
        data-testid="usable-zone"
        x={gripper}
        y={gripper}
        width={Math.max(0, workingSheet.w - 2 * gripper)}
        height={Math.max(0, workingSheet.h - 2 * gripper)}
        fill={USABLE_ZONE_FILL}
        stroke={USABLE_ZONE_STROKE}
        strokeWidth={USABLE_ZONE_STROKE_WIDTH}
        vectorEffect="non-scaling-stroke"
      />
      {section.instances.map((inst, j) => (
        <g key={j} data-testid="preview-instance" transform={inst.transform}>
          {paths.map((p) => {
            const style = LINE_STYLES[p.type];
            return (
              <path
                key={p.id}
                d={segmentsToSvgD(p.segments)}
                fill="none"
                stroke={style.stroke}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dasharray}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
      ))}
    </g>
  );
}

/**
 * 單一方向（0°／90°）結果卡：兩卡同等權重、無「最佳／推薦」標記（spec review F9）——
 * 兩張卡呼叫時傳入完全對稱的 props，樣式（class）逐字相同，不因方向而有任何視覺差異。
 *
 * T3 全紙預覽重寫（法蘭 gate 反饋「一律顯示全紙尺寸,選擇不同的裁切方式用線條加上去
 * 示意,然後要動的只有可落版的區域」）：viewBox 恆為 `fullSheet.w×fullSheet.h`，不因
 * cutV/cutH 而改變；裁切中線畫在全紙正中央示意；每子紙一個 `<g data-testid="section">`
 * （`SectionGroup`，`sections` prop 是呼叫端 `sectionRenders` 算好的左上角偏移＋該子紙
 * 分到的 instances），同一份排列在每個子紙內同版複製。`renderedCount`／`isTruncated`
 * 語意見 `computeImpositionView` docblock「preview cap」段。
 */
function DirectionCard({
  dirDeg,
  label,
  direction,
  sections,
  renderedCount,
  paths,
  workingSheet,
  fullSheet,
  cutV,
  cutH,
  gripper,
}: {
  dirDeg: 0 | 90;
  label: string;
  direction: DirectionResult | null;
  sections: SectionRender[];
  renderedCount: number;
  paths: DielinePath[];
  workingSheet: WorkingSheet | null;
  fullSheet: { w: number; h: number };
  cutV: boolean;
  cutH: boolean;
  gripper: number;
}) {
  const isCut = cutV || cutH;
  const isQuarter = cutV && cutH;
  const sectionsCount = workingSheet?.sections ?? 1;
  const showPreview = direction !== null && direction.count > 0 && workingSheet !== null;
  // Global Constraints「preview cap 語意」：cap 是這張方向卡合計最多 500，不是任一子紙
  // 各自 500——用 totalCount（含所有子紙）比對 renderedCount（sectionRenders 實際建立的
  // 總數），不是用單子紙 count 比對，才不會在四開情境漏報（T1 interim 的 gridCount 比對
  // instances.length 寫法在此已收掉，見 brief 附錄回歸案例：每子紙 150、全紙 600、實畫 500）。
  const isTruncated = direction !== null && direction.totalCount > renderedCount;

  return (
    <div data-testid={`direction-card-${dirDeg}`} className="flex-1 flex flex-col gap-2 p-3 bg-white border border-zinc-200 rounded-sm">
      <h4 className="text-xs font-bold uppercase tracking-widest text-zinc-500">{label}</h4>

      {direction === null ? (
        <p className="text-lg font-mono text-zinc-400">—</p>
      ) : direction.count === 0 ? (
        <p className="text-sm text-zinc-500">放不下</p>
      ) : (
        <>
          <p className="text-base font-mono text-zinc-900">{directionCardText(direction, sectionsCount, isCut, isQuarter)}</p>
          <p className="text-xs text-zinc-500">{`外接矩形利用率 ${(direction.utilization * 100).toFixed(2)}%`}</p>
        </>
      )}

      {showPreview && workingSheet && (
        <svg
          viewBox={`0 0 ${fullSheet.w} ${fullSheet.h}`}
          role="img"
          aria-label={`${label} 排列預覽`}
          className="w-full border border-zinc-100 bg-white"
        >
          {/* 全紙外框：恆顯示整張紙尺寸，不因裁切而縮小（法蘭 gate 反饋「一律顯示全紙尺寸」）。 */}
          <rect
            data-testid="sheet-frame"
            x={0}
            y={0}
            width={fullSheet.w}
            height={fullSheet.h}
            fill="none"
            stroke={SHEET_FRAME_STROKE}
            strokeWidth={SHEET_FRAME_STROKE_WIDTH}
            vectorEffect="non-scaling-stroke"
          />

          {/* 裁切中線示意：cutV/cutH 可疊加、各自獨立判斷、四開時兩條同時畫出；中線畫在
              fullSheet 正中央，不是子紙邊界（brief「裁切線畫全紙中線」，取代舊版畫在
              workingSheet.w/h、只示意一個子紙邊界的寫法）。 */}
          {cutV && (
            <line
              data-testid="cut-line-v"
              x1={fullSheet.w / 2}
              y1={0}
              x2={fullSheet.w / 2}
              y2={fullSheet.h}
              stroke={CUT_LINE_STROKE}
              strokeWidth={CUT_LINE_STROKE_WIDTH}
              strokeDasharray={CUT_LINE_DASHARRAY}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {cutH && (
            <line
              data-testid="cut-line-h"
              x1={0}
              y1={fullSheet.h / 2}
              x2={fullSheet.w}
              y2={fullSheet.h / 2}
              stroke={CUT_LINE_STROKE}
              strokeWidth={CUT_LINE_STROKE_WIDTH}
              strokeDasharray={CUT_LINE_DASHARRAY}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {sections.map((section, i) => (
            <SectionGroup key={i} section={section} workingSheet={workingSheet} gripper={gripper} paths={paths} />
          ))}
        </svg>
      )}

      {isTruncated && <p className="text-[11px] text-amber-600">數量過大，預覽已簡化</p>}
    </div>
  );
}

/**
 * `ImpositionControls`／`ImpositionResults` 共用的純計算——把 `result`＋`state` 解析成兩邊
 * 渲染各自需要的衍生值。純函式、零 React 依賴以外的副作用，兩個元件各自呼叫一次（見檔頭
 * docblock「元件拆分」一節的理由）。
 *
 * `stalePiece`（review Medium 1 fix round 1）：`result.pieces` 存在（多片盒型）但
 * `state.pieceId` 找不到對應成員時為 `true`——涵蓋 `pieceId===null`（尚未選定／T4 fallback
 * 前）與 stale id（如剛被刪除的片）兩種情況。此時 `impositionUsable` 恆為 `false`，
 * 兩卡／預覽/working sheet 一律視為不可用，並在 `showGeneralError` 多加一個理由。
 * RTE（`pieces===undefined`）恆不觸發（`pieces !== undefined` 短路），維持原本「全版」行為。
 */
function computeImpositionView(result: GenerateResult, state: ImpositionState) {
  const pieces = result.pieces;
  const piece: DielinePiece | undefined = pieces?.find((p) => p.id === state.pieceId);
  const stalePiece = pieces !== undefined && piece === undefined;

  const preset = PAPER_PRESETS.find((p) => p.id === state.paperPresetId);
  const isCustomPaper = preset === undefined;
  const paperW = preset ? preset.w : state.customW;
  const paperH = preset ? preset.h : state.customH;

  // spec F1 硬規則：一律製造 bounds，禁用 result.bounds／piece.bounds（見檔頭 docblock）。
  // stalePiece 時 piece 為 undefined，manufacturingBounds 會退回全版幾何——這個 mb／
  // pieceW／pieceH／imposition 仍照算（不因 stalePiece 而短路，維持函式單一路徑好推理），
  // 但下面 impositionUsable 會擋掉所有消費這份「可能是錯 fallback 幾何」結果的渲染輸出。
  const mb: Bounds = manufacturingBounds(result, piece);
  const pieceW = mb.maxX - mb.minX;
  const pieceH = mb.maxY - mb.minY;

  const input: ImpositionInput = {
    pieceW,
    pieceH,
    paperW,
    paperH,
    orientation: state.orientation,
    cutV: state.cutV,
    cutH: state.cutH,
    allowRotate: state.allowRotate,
    gripper: state.gripper,
    gap: state.gap,
  };
  const imposition = computeImposition(input);
  const errors = imposition.ok ? [] : imposition.errors;
  const errorFor = (field: ImpositionFieldError['field']): ImpositionFieldError | undefined =>
    errors.find((e) => e.field === field);
  // pieceW/pieceH（自動導出，無輸入框）與 result（內部錯誤）一律走整體錯誤訊息；
  // paperW/paperH 只有在「自訂紙規」時才有輸入框可標，選 preset 時 preset 數值恆安全
  // （不會觸發 domain 錯誤），但防禦性地仍把這個理論上不可達的組合歸入整體錯誤，
  // 不讓任何欄位錯誤在 UI 上悄悄消失。這組 domain 錯誤與 stalePiece 正交：兩者可能同時
  // 成立，欄位級錯誤（gripper/gap/paperW/paperH）不因 stalePiece 而被壓下。
  const generalErrors = errors.filter((e) => {
    if (e.field === 'result' || e.field === 'pieceW' || e.field === 'pieceH') return true;
    if (!isCustomPaper && (e.field === 'paperW' || e.field === 'paperH')) return true;
    return false;
  });

  // review Medium 1：stalePiece 時整份拼版結果視為不可用——不只兩卡改「—」，workingSheet／
  // previewPathList／instance 排列都不得使用「piece=undefined 退全版」算出的幾何，避免
  // general error 之外的角落仍洩漏用錯誤 fallback 幾何算出的數字。
  const impositionUsable = imposition.ok && !stalePiece;

  // fullSheet（T1：取代舊版額外呼叫一次 resolveWorkingSheet(...,'full',...) 的雙呼叫寫法）——
  // computeImposition 內部已算出 fullW/fullH（方向處理後、裁切前），直接從同一次呼叫的
  // sheet 讀取即可，不必再獨立呼叫一次轉換鏈。!impositionUsable 時沒有 sheet 可讀，SVG
  // 預覽整塊被 showPreview（見 DirectionCard）擋掉不會渲染，{w:0,h:0} 只是型別要求的
  // 惰性佔位值，不影響任何畫面。
  const workingSheet = impositionUsable ? imposition.sheet : null;
  const fullSheet = workingSheet ? { w: workingSheet.fullW, h: workingSheet.fullH } : { w: 0, h: 0 };
  const previewPathList = stalePiece ? [] : previewPaths(result, piece ?? null);

  // 每子紙同一份排列＋跨子紙 remainingBudget 鏈（T3，見 `sectionRenders` docblock「preview
  // cap 語意」）：`impositionUsable` 同時保證 `imposition.ok` 與 `imposition.sheet` 可讀
  // （與上面 workingSheet 的窄化邏輯相同）。`renderedCount`＝該方向卡實際建立的 instance
  // 總數（跨全部子紙），數學上恆等於 `min(direction.totalCount, MAX_PREVIEW_INSTANCES)`
  // （budget 鏈逐子紙耗盡即停，不會多建也不會少建，見 `DirectionCard` 的 `isTruncated`）。
  const deg0Sections = impositionUsable ? sectionRenders(0, imposition.deg0, imposition.sheet, mb, state.gripper, state.gap) : [];
  const deg90Sections = impositionUsable ? sectionRenders(90, imposition.deg90, imposition.sheet, mb, state.gripper, state.gap) : [];
  const deg0RenderedCount = deg0Sections.reduce((sum, s) => sum + s.instances.length, 0);
  const deg90RenderedCount = deg90Sections.reduce((sum, s) => sum + s.instances.length, 0);

  const showGeneralError = stalePiece || generalErrors.length > 0;
  // stalePiece 訊息優先於通用 domain 錯誤訊息：stalePiece 是更具體、更可行動的原因
  // （告訴使用者「去選一片」，而不是籠統的「確認輸入數值」）；欄位級 domain 錯誤本身仍會
  // 各自標在對應輸入框旁，不會因為這裡改顯示 stalePiece 訊息而遺失資訊。
  // internal（深度防禦分支）與輸入無關，不誤導使用者去「確認輸入」（final review Minor）。
  const hasInternalError = generalErrors.some((e) => e.reason === 'internal');
  const generalErrorMessage = stalePiece
    ? '請選擇拼版的件'
    : hasInternalError
      ? '系統內部計算錯誤，請重新整理頁面；若持續發生請回報。'
      : '計算發生錯誤，請確認輸入數值。';

  return {
    pieces,
    piece,
    stalePiece,
    isCustomPaper,
    paperW,
    paperH,
    errorFor,
    fullSheet,
    workingSheet,
    previewPathList,
    deg0: impositionUsable ? imposition.deg0 : null,
    deg90: impositionUsable ? imposition.deg90 : null,
    deg0Sections,
    deg90Sections,
    deg0RenderedCount,
    deg90RenderedCount,
    showGeneralError,
    generalErrorMessage,
  };
}

/** 拼版控制面板：件選擇／紙規／方向／作業模式／咬口／刀線間距。T4 掛入 App 側欄
 *  （spec「組裝」段）；可獨立於 `ImpositionResults` 掛載，唯一互動出口是 `onChange`。 */
export function ImpositionControls({ result, state, onChange }: ImpositionControlsProps) {
  const { pieces, isCustomPaper, errorFor } = computeImpositionView(result, state);
  const update = <K extends keyof ImpositionState>(key: K, value: ImpositionState[K]): void => {
    onChange({ ...state, [key]: value });
  };

  return (
    <div className="w-64 shrink-0 flex flex-col gap-4 p-5 bg-zinc-50 border border-zinc-200 rounded-sm">
      <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">拼版設定</h3>

      <div className="flex flex-col gap-1.5">
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
        <label htmlFor="imposition-paper-preset" className={LABEL_CLASS}>
          紙規
        </label>
        <select
          id="imposition-paper-preset"
          value={state.paperPresetId}
          onChange={(e) => update('paperPresetId', e.target.value)}
          className={CONTROL_CLASS}
        >
          {PAPER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">自訂</option>
        </select>
      </div>

      {isCustomPaper && (
        <div className="flex gap-2">
          <div className="flex flex-col gap-1.5 flex-1">
            <label htmlFor="imposition-custom-w" className={LABEL_CLASS}>
              W (mm)
            </label>
            <input
              id="imposition-custom-w"
              type="number"
              step="any"
              value={state.customW}
              onChange={(e) => update('customW', Number(e.target.value))}
              className={CONTROL_CLASS}
            />
            {errorFor('paperW') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('paperW')!.reason)}</p>}
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <label htmlFor="imposition-custom-h" className={LABEL_CLASS}>
              H (mm)
            </label>
            <input
              id="imposition-custom-h"
              type="number"
              step="any"
              value={state.customH}
              onChange={(e) => update('customH', Number(e.target.value))}
              className={CONTROL_CLASS}
            />
            {errorFor('paperH') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('paperH')!.reason)}</p>}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="imposition-orientation" className={LABEL_CLASS}>
          方向
        </label>
        <select
          id="imposition-orientation"
          value={state.orientation}
          onChange={(e) => update('orientation', e.target.value as SheetOrientation)}
          className={CONTROL_CLASS}
        >
          {ORIENTATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="imposition-mode" className={LABEL_CLASS}>
          作業模式
        </label>
        <select
          id="imposition-mode"
          value={modeValueFromCuts(state.cutV, state.cutH)}
          onChange={(e) => {
            const { cutV, cutH } = cutsFromModeValue(e.target.value as ModeOptionValue);
            onChange({ ...state, cutV, cutH });
          }}
          className={CONTROL_CLASS}
        >
          {MODE_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {/* 「可轉 90°」開關（T1 範圍聲明：先以 checkbox 掛在下拉旁，樣式從簡；T4 換成
          toolbar 按鈕）。包住 input 的 <label> 提供隱式 accessible name，不另開 htmlFor/id。 */}
      <label className="flex items-center gap-1.5 text-xs text-zinc-600">
        <input type="checkbox" checked={state.allowRotate} onChange={(e) => update('allowRotate', e.target.checked)} />
        可轉 90°（L 形補排）
      </label>

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
          className={CONTROL_CLASS}
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
          className={CONTROL_CLASS}
        />
        {errorFor('gap') && <p className={ERROR_TEXT_CLASS}>{fieldErrorMessage(errorFor('gap')!.reason)}</p>}
      </div>
    </div>
  );
}

/** 拼版結果／預覽：整體錯誤／工作尺寸文字／0°+90° 兩張方向卡片／界線聲明。T4 掛入 App
 *  主區（spec「組裝」段）；純顯示，無互動，可獨立於 `ImpositionControls` 掛載。 */
export function ImpositionResults({ result, state }: ImpositionResultsProps) {
  const {
    showGeneralError,
    generalErrorMessage,
    workingSheet,
    previewPathList,
    deg0,
    deg90,
    deg0Sections,
    deg90Sections,
    deg0RenderedCount,
    deg90RenderedCount,
    fullSheet,
  } = computeImpositionView(result, state);

  return (
    <div className="flex-1 flex flex-col gap-3">
      {showGeneralError && (
        <div data-testid="imposition-general-error" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-sm p-2">
          {generalErrorMessage}
        </div>
      )}

      {workingSheet && <p className="text-xs text-zinc-500">{workingSheetText(workingSheet)}</p>}

      <div className="flex gap-3">
        <DirectionCard
          dirDeg={0}
          label="0°"
          direction={deg0}
          sections={deg0Sections}
          renderedCount={deg0RenderedCount}
          paths={previewPathList}
          workingSheet={workingSheet}
          fullSheet={fullSheet}
          cutV={state.cutV}
          cutH={state.cutH}
          gripper={state.gripper}
        />
        <DirectionCard
          dirDeg={90}
          label="90°"
          direction={deg90}
          sections={deg90Sections}
          renderedCount={deg90RenderedCount}
          paths={previewPathList}
          workingSheet={workingSheet}
          fullSheet={fullSheet}
          cutV={state.cutV}
          cutH={state.cutH}
          gripper={state.gripper}
        />
      </div>

      <p className="text-[11px] text-zinc-400 leading-relaxed">{DISCLAIMER_TEXT}</p>
    </div>
  );
}

/** 組合 wrapper（review Medium 2 fix round 1）：公開介面與既有測試不變，內部渲染
 *  `ImpositionControls` + `ImpositionResults`。T4 若決定不透過 App 側欄/主區分開掛載
 *  （例如先求快、暫不動 App 版面），可以先繼續用這個 wrapper 整包塞進去。 */
export function ImpositionView({ result, state, onChange }: ImpositionViewProps) {
  return (
    <div className="flex gap-6">
      <ImpositionControls result={result} state={state} onChange={onChange} />
      <ImpositionResults result={result} state={state} />
    </div>
  );
}
