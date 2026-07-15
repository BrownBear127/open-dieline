/**
 * ImpositionResults：拼版結果／預覽卡片＋兩元件共用的計算（`computeImpositionView`）＋
 * `ImpositionState` 型別本體。gate round 1 T4 從 `ImpositionView.tsx` 拆出（該檔的
 * `ImpositionControls` 橫排 toolbar 重寫後合併檔超過 800 行 cap，brief 預授權拆法，
 * 拆分理由與「為何型別／共用計算搬來這裡、不留在 `ImpositionView.tsx`」見該檔檔頭
 * docblock「檔案拆分」一節——簡言之：避免兩檔互相 import。本檔不 import
 * `./ImpositionView`，只單向被它 import；`ImpositionView.tsx` 會重新 export 本檔的
 * `ImpositionState`／`ImpositionResultsProps`／`ImpositionResults`，維持
 * `@/ui/ImpositionView` 這個既有公開路徑對呼叫端（App.tsx／測試）不變。
 *
 * 模尺寸來源（spec F1 硬規則，profile-spacing slice T4 更新呼叫路徑）：一律用
 * `manufacturingPaths(result, piece)`（`core/profile.ts` 共用過濾函式）取得幾何集合後
 * `segmentsBounds` 算寬高餵給 `computeImposition`，**不得**使用 `result.bounds`／
 * `piece.bounds`（那兩者依 pieces.ts 的三向等式含尺寸標註線外擴，會讓拼版拼得比實際寬鬆
 * ——見 core/bounds.ts 檔頭 docblock、`tests/imposition-anchor.test.ts` 的 12 模 vs 6 模
 * 實證）。改用 `manufacturingPaths` 而非直接呼叫 `manufacturingBounds`（後者定義本身不動，
 * 疊圖對齊／匯出檔名等其餘呼叫端照舊）是 spec F2b「呼叫鏈」要求的同源化：bounds 與下方
 * ProfileStrides 現在從同一份幾何集合派生，防兩個過濾規則各自維護而未來漂移（v1 兩者
 * 過濾結果恆相等，見 `core/profile.ts` `PROFILE_GEOMETRY_TYPES` docblock）。
 *
 * 件選擇與 `ImpositionState.pieceId` 的 fallback 生命週期（多片盒型換片／盒型切換／
 * `linerEnabled=false` 導致選中片消失時改選第一個有效片）是 App.tsx 的職責——
 * `computeImpositionView` 只負責「依目前 `state.pieceId` 解析對應的 piece」，不做防呆
 * fallback。但 `result.pieces` 存在且 `state.pieceId` 找不到對應片時（含 `pieceId===null`
 * 與 stale id 兩種情況，App.tsx 的 fallback effect 尚未來得及修正的過渡 render），
 * **不得**退成 `manufacturingPaths(result, undefined)` 的「全版」bounds——spec F6
 * 明定拼版沒有 `null＝全版` 語意（review Medium 1 fix round 1：舊實作曾經這樣退，是 spec
 * 違反，已改為 fail loud：兩卡「—」、不渲染排列、顯示整體錯誤「請選擇拼版的件」）。RTE
 * （`result.pieces===undefined`）不受影響，仍是「本來就沒有片可選」的合法穩態，`piece`
 * 恆為 `undefined`、`manufacturingPaths(result, undefined)` 取全版幾何是正確行為，不是
 * 這裡說的過渡態。見下方 `computeImpositionView` 的 `stalePiece`。
 *
 * 輸入 domain 錯誤顯示（spec 輸入 domain 表）：`paperW`／`paperH`（僅自訂紙規時有對應輸入
 * 框，輸入框在 `ImpositionControls`，見 `ImpositionView.tsx`）／`gripper`／`gap` 四欄
 * 逐一標到各自輸入框旁；`pieceW`／`pieceH`（由 manufacturingPaths 自動導出，沒有可編輯
 * 輸入框）與 `result`（`reason:'internal'`，計算內部錯誤）統一走整體錯誤訊息——沒有輸入
 * 框可以標，也不該假裝有。stalePiece 與這組 domain 錯誤是正交的兩件事：domain 錯誤仍照
 * 原本欄位標紅字，stalePiece 只多加一個整體錯誤訊息、並讓兩卡與預覽變成不可用（見
 * `computeImpositionView` 的 `impositionUsable`）。
 *
 * 元件拆分（review Medium 2 fix round 1；gate round 1 T4 進一步拆檔，見上）：控制面板
 * （`ImpositionControls`，定義在 `ImpositionView.tsx`）與結果／預覽（`ImpositionResults`，
 * 本檔）是兩個可獨立掛載的 export，供 App.tsx 依 spec「組裝」段一起掛進主區
 * （`ImpositionControls` 在上、`ImpositionResults` 在下，垂直堆疊）。兩者共用的計算
 * （`piece` 解析／`manufacturingPaths`／`computeImposition`／instance 排列）抽到本檔的
 * `computeImpositionView(result, state)`——即使兩者實際上是主區裡的相鄰兄弟節點，仍保留
 * 成兩個獨立 export、各自呼叫一次純函式而非共享 React context／額外 state：拆分維持
 * 「元件只依賴 props」的簡單心智模型，計算本身夠廉價（instance 上限 500，見 fix round 1
 * High 修復；profile 計算另有 memoize，見 `getMemoizedProfileStrides` docblock），重複
 * 呼叫不是效能問題。
 */
import type { Bounds, Segment } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult } from '@/core/types';
import { computeImposition, PAPER_PRESETS, MAX_PREVIEW_INSTANCES, MIN_GAP_MM, MIN_DIMENSION_MM, MAX_DIMENSION_MM } from '@/core/imposition';
import type { DirectionResult, ImpositionFieldError, ImpositionInput, SheetOrientation, WorkingSheet } from '@/core/imposition';
import { manufacturingPaths, computeProfileStrides } from '@/core/profile';
import type { ProfileStrides } from '@/core/profile';
import { DISPLAY_LINE_STYLES } from '@/core/displayStyles';
import { segmentsToSvgD } from '@/core/path';
import { directionInstances, previewPaths, sectionOffsets } from './impositionPreview';
import type { PreviewInstance } from './impositionPreview';

/** 拼版模式的完整可往返 state（F6：盒型／盒參數／紙規／方向／裁切／咬口／gap／
 *  拼版件選擇——逐欄列舉，切設計模式再切回來必須原值不改）。
 *  `cutV`/`cutH`/`allowRotate`（gate round 1 T1 取代舊 `mode: SheetMode` 單選）：
 *  逐字對應 `core/imposition.ts` 的 `ImpositionInput` 同名欄位，UI 端不需要任何映射層就能
 *  直接餵給 `computeImposition`。T1 曾在 UI 端暫留一層 mode→cutV/cutH 映射（「作業模式」
 *  四選一下拉，僅供沿用舊外觀過渡），T4 toolbar 化已整層退役——`cutV`／`cutH` 現在是
 *  `ImpositionControls` toolbar 上兩顆各自獨立的 toggle 按鈕，點擊直接改寫對應布林欄位，
 *  可疊加（四開＝兩顆都按下），不再有任何中介映射或四選一限制。 */
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

/** `ImpositionResults` 只讀不寫（結果區沒有任何互動元素），故不需要 `onChange`。 */
export interface ImpositionResultsProps {
  result: GenerateResult;
  state: ImpositionState;
}

// spec F6 終裁 b（profile-spacing slice T4）：舊文案「外接矩形估算」不再準確——收縮排列下
// 相鄰件是依輪廓間距靠齊，不是外接矩形；改用這段新措辭（spec 逐字）。
const DISCLAIMER_TEXT = '以單件輪廓間距估算（單向收縮）；未計交錯、塞角、共刀、絲向及加工限制，不可直接作生產拼版。';

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
 * viewBox／紙張 mm 尺度縮放。gate 驗收反饋「線條粗細統一和單紙盒刀模一致」：刀模
 * paths 沿用 `DISPLAY_LINE_STYLES[type].strokeWidth` 原始值（逐欄位繼承 core/styles.ts
 * LINE_STYLES，Spec §5 拆層不改數值）＋non-scaling-stroke（與 Canvas.tsx
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
 * 有裁切時補上全紙尺寸——gate 驗收反饋「一律顯示全紙尺寸」後，使用者需要同時看到「這張
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

/**
 * `spacingAxis` → 中文標示（spec F6「標示收縮向」，措辭實作定案，profile-spacing slice T4）：
 * `'rows'`＝收縮發生在行距（`direction.rows` 那個維度的相鄰兩行變近，卡片文字裡對應
 * 「N 行」那個數字的方向）；`'cols'`＝收縮發生在列距（對稱，對應「N 列」）。呼叫端只在
 * `direction.spacingAxis !== null` 時才渲染這行（見 `DirectionCard`）——`null`（缺省或
 * telescope 式零收益退化）沿用既有卡片「沒有就不顯示」慣例，與 `fillSuffix` 同一模式。
 */
function spacingAxisLabel(axis: NonNullable<DirectionResult['spacingAxis']>): string {
  return axis === 'rows' ? '行距輪廓收縮' : '列距輪廓收縮';
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
            const style = DISPLAY_LINE_STYLES[p.type];
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
 * T3 全紙預覽重寫（gate 驗收反饋「一律顯示全紙尺寸,選擇不同的裁切方式用線條加上去
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
          {/* spec F6 終裁 b：移除利用率百分比（收縮排列下矩形互疊可逾 100%，指標失效，見
              core `DirectionResult.utilization` docblock）——改顯主格點 footprint 尺寸；
              spacingAxis 非 null 時另標收縮向（見 `spacingAxisLabel`）。 */}
          <p className="text-xs text-zinc-500">{`主格點 footprint ${direction.usedW.toFixed(1)} × ${direction.usedH.toFixed(1)} mm`}</p>
          {direction.spacingAxis && <p className="text-xs text-zinc-500">{spacingAxisLabel(direction.spacingAxis)}</p>}
        </>
      )}

      {showPreview && workingSheet && (
        <svg
          viewBox={`0 0 ${fullSheet.w} ${fullSheet.h}`}
          role="img"
          aria-label={`${label} 排列預覽`}
          className="w-full border border-zinc-100 bg-white"
        >
          {/* 全紙外框：恆顯示整張紙尺寸，不因裁切而縮小（gate 驗收反饋「一律顯示全紙尺寸」）。 */}
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

// ─────────────────────────────────────────────────────────────────────────
// profile 計算：前置驗證＋memoize（spec F2b 呼叫鏈／plan-review H2/M，profile-spacing
// slice T4）
// ─────────────────────────────────────────────────────────────────────────

/**
 * profile 前置驗證（plan-review H2）：gap 與 pieceW/H 必須先通過跟 `core/imposition.ts`
 * `checkGap`/`checkDimension`「合法」分支等價的範圍檢查，才建立 `ProfileStrides`——鏡射
 * 那兩個函式用的界常數（`MIN_GAP_MM`/`MIN_DIMENSION_MM`/`MAX_DIMENSION_MM`，三者皆已
 * export），不是重新定義一套獨立標準；本檔不 import 那兩個函式本身（它們是
 * `core/imposition.ts` 的模組內部函式，未 export——core 才是 domain 合法性的唯一權威，
 * 這裡只是「值不值得先算 profile」的前哨判斷，真正的合法性判定仍在 `computeImposition`
 * 內部完整跑一次）。
 *
 * 動機：`computeProfileStrides` 內部會用 gap/pieceW/H 做槽數（`Math.ceil`）／`Math.sqrt`／
 * 鄰域迴圈次數計算——NaN／Infinity／超界輸入餵進去不會拋例外，但可能算出無意義的巨大槽數
 * 或 NaN 結果（防禦不是本模組職責）。跳過建立 `ProfileStrides`、讓 `shrunk` 維持
 * `undefined`，非法輸入照走 `computeImposition` 自己既有的 domain error 路徑——該路徑
 * 本來就會擋下同一批不合法的 gap/pieceW/pieceH（`ImpositionInput.shrunk` 缺省語意本就是
 * `undefined`＝該向用矩形 stride，跳過不改變任何既有 domain 錯誤的欄位/reason）。
 *
 * `checkGap`「below-min」分支的下界就是 `MIN_GAP_MM`（非正值必然 < MIN_GAP_MM，故單一
 * 範圍檢查已涵蓋，不需要另外判斷 `>0`）；`checkDimension`「not-positive」同理已被
 * `>= MIN_DIMENSION_MM`（0.01）涵蓋。`Number.isFinite` 必須先於範圍比較——`NaN` 參與
 * `<`/`>` 恆為 `false`，範圍檢查會誤判為「通過」（與 core 兩個 check 函式的既有寫法同一
 * 順序理由）。
 */
function isValidGapForProfile(gap: number): boolean {
  return Number.isFinite(gap) && gap >= MIN_GAP_MM && gap <= MAX_DIMENSION_MM;
}
function isValidPieceDimForProfile(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_DIMENSION_MM && value <= MAX_DIMENSION_MM;
}

interface ProfileMemoEntry {
  result: GenerateResult;
  pieceId: string | null;
  gap: number;
  strides: ProfileStrides;
}

/** module-level 單槽快取——見 `getMemoizedProfileStrides` docblock。刻意不用 `useMemo`/
 *  `useRef`：`computeImpositionView` 是普通函式，被 `ImpositionControls`／`ImpositionResults`
 *  兩個獨立元件各自呼叫（不是同一元件內的兩次 render），沒有共享的 React hook 存放格可用；
 *  單槽（不是以 pieceId 為 key 的 Map）足夠，因為同一次狀態更新內兩個呼叫端的
 *  `(result,pieceId,gap)` 三元組恆相同，不需要記住「上一個 pieceId」以外的歷史。 */
let profileMemo: ProfileMemoEntry | null = null;

/**
 * profile 計算 memoize（plan-review M「效能」）：`ImpositionControls`／`ImpositionResults`
 * 各自呼叫一次 `computeImpositionView`（見下方 docblock「元件拆分」），同一次狀態更新內
 * 兩者的 `(result,pieceId,gap)` 三元組恆相同——命中快取即回傳，不重跑
 * `computeProfileStrides` 這個 O(K) 幾何計算（K 至多 4096 slots × 鄰域搜尋半徑）。
 *
 * key 刻意不含 `segments` 本身：`segments` 由 `(result,pieceId)` 唯一決定（見呼叫處
 * `manufacturingPaths(result, piece)`），拿 `result`／`pieceId` 當 key 已足夠捕捉依賴，
 * 不需要另外比較陣列內容（比較陣列相等本身就比重算貴）。`result` 用參照相等（`===`）——
 * 專案慣例「ALWAYS create new objects, NEVER mutate」保證幾何變動必然伴隨新的 `result`
 * 物件參照，同一個參照代表幾何沒變。
 */
function getMemoizedProfileStrides(result: GenerateResult, pieceId: string | null, gap: number, segments: Segment[]): ProfileStrides {
  if (profileMemo && profileMemo.result === result && profileMemo.pieceId === pieceId && profileMemo.gap === gap) {
    return profileMemo.strides;
  }
  const strides = computeProfileStrides(segments, gap);
  profileMemo = { result, pieceId, gap, strides };
  return strides;
}

/**
 * `ImpositionControls`／`ImpositionResults` 共用的純計算——把 `result`＋`state` 解析成兩邊
 * 渲染各自需要的衍生值。純函式、零 React 依賴以外的副作用，兩個元件各自呼叫一次（見檔頭
 * docblock「元件拆分」一節的理由）。T4 起 export（原為模組內部函式）：`ImpositionControls`
 * 搬到 `ImpositionView.tsx` 後仍需要呼叫它取得 `pieces`/`isCustomPaper`/`errorFor`。
 *
 * `stalePiece`（review Medium 1 fix round 1）：`result.pieces` 存在（多片盒型）但
 * `state.pieceId` 找不到對應成員時為 `true`——涵蓋 `pieceId===null`（尚未選定／App.tsx
 * fallback 前）與 stale id（如剛被刪除的片）兩種情況。此時 `impositionUsable` 恆為
 * `false`，兩卡／預覽/working sheet 一律視為不可用，並在 `showGeneralError` 多加一個理由。
 * RTE（`pieces===undefined`）恆不觸發（`pieces !== undefined` 短路），維持原本「全版」行為。
 */
export function computeImpositionView(result: GenerateResult, state: ImpositionState) {
  const pieces = result.pieces;
  const piece: DielinePiece | undefined = pieces?.find((p) => p.id === state.pieceId);
  const stalePiece = pieces !== undefined && piece === undefined;

  const preset = PAPER_PRESETS.find((p) => p.id === state.paperPresetId);
  const isCustomPaper = preset === undefined;
  const paperW = preset ? preset.w : state.customW;
  const paperH = preset ? preset.h : state.customH;

  // spec F1 硬規則：一律製造幾何，禁用 result.bounds／piece.bounds（見檔頭 docblock）。
  // spec F2b 呼叫鏈：manufacturingPaths 是 bounds／profile／preview 三消費者的共用過濾
  // 函式（core/profile.ts）——這裡取同一份 segments 餵 segmentsBounds（算 pieceW/H）與
  // computeProfileStrides（算 shrunk），兩者同源，不是各自獨立呼叫兩套過濾規則。stalePiece
  // 時 piece 為 undefined，manufacturingPaths 會退回全版幾何——這個 segments／pieceW／
  // pieceH／shrunk／imposition 仍照算（不因 stalePiece 而短路，維持函式單一路徑好推理），
  // 但下面 impositionUsable 會擋掉所有消費這份「可能是錯 fallback 幾何」結果的渲染輸出。
  const manufacturingSegments: Segment[] = manufacturingPaths(result, piece).flatMap((p) => p.segments);
  const mb: Bounds = segmentsBounds(manufacturingSegments);
  const pieceW = mb.maxX - mb.minX;
  const pieceH = mb.maxY - mb.minY;

  // profile 前置驗證（plan-review H2，見 isValidGapForProfile/isValidPieceDimForProfile
  // docblock）：只有 gap 與 pieceW/H 都合法才建立 ProfileStrides 並嘗試 memoize；非法輸入
  // shrunk 維持 undefined，照走 computeImposition 自己的 domain error 路徑。
  const shrunk: ProfileStrides | undefined =
    isValidGapForProfile(state.gap) && isValidPieceDimForProfile(pieceW) && isValidPieceDimForProfile(pieceH)
      ? getMemoizedProfileStrides(result, state.pieceId, state.gap, manufacturingSegments)
      : undefined;

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
    shrunk,
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

/** 拼版結果／預覽：整體錯誤／工作尺寸文字／0°+90° 兩張方向卡片／界線聲明。掛入 App
 *  主區、緊接在 `ImpositionControls`（`ImpositionView.tsx`）toolbar 下方（spec「組裝」段）；
 *  純顯示，無互動，可獨立於 `ImpositionControls` 掛載。 */
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
