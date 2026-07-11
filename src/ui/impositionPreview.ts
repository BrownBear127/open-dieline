/**
 * 拼版預覽的 UI 幾何純函式：instance 排列變換＋供預覽消費的製造 paths 子集。
 *
 * 拆成零 React 依賴的純函式（T3 brief 明文理由）：jsdom 不支援 `getBBox()`／實際 SVG
 * transform 矩陣運算，若把這段變換數學埋在 `ImpositionView.tsx` 元件內部，測試就只能驗
 * DOM 結構、驗不到「變換本身對不對」。抽出來後 `tests/imposition-preview.test.ts` 才能
 * 直接對 transform 字串與衍生的 cell 矩形數值做代數驗證。純 TS 模組，座標單位一律 mm。
 *
 * `directionInstances`（單子紙完整排列＝主格點＋L 形補排條帶，budget cap）與
 * `sectionOffsets`（多子紙左上角偏移，讀 `WorkingSheet.cutV/cutH` 旗標）是 T3
 * `ImpositionView.tsx` 全紙預覽重寫的唯一消費入口。T2 曾另外提供 `instanceTransforms`
 * （只排主格點、origin 固定咬口內角，供 T1 interim 的單子紙視圖沿用）；T3 controller
 * 裁決刪除——它唯一的消費者（`DirectionCard`）已改吃 `directionInstances`，兩者原本共用
 * 同一顆私有 `buildGrid` 引擎，刪除後這顆引擎變成 `directionInstances` 專用，行為不變。
 */

import type { Bounds } from '@/core/geometry';
import type { DielinePath, DielinePiece, GenerateResult, LineType } from '@/core/types';
import { MAX_PREVIEW_INSTANCES } from '@/core/imposition';
import type { DirectionResult, WorkingSheet } from '@/core/imposition';

/**
 * 單一排列 instance：`transform` 供 SVG `<g transform>` 直接消費；`cellX`/`cellY`/`cellW`/
 * `cellH` 是同一份變換「在紙張座標系裡實際佔據的矩形」（左上角＋寬高，旋轉後的佔位）——
 * 暴露這四個數字讓呼叫端（`ImpositionView.tsx` 畫咬口／可用區參考線、測試驗證變換正確性）
 * 不需要重新解析 `transform` 字串或模擬 SVG matrix 運算。
 */
export interface PreviewInstance {
  transform: string;
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
}

/**
 * 單一格點 grid 的 instance 建構引擎——`directionInstances`（主格點＋補排條帶，origin 依
 * 條帶起點浮動，唯一呼叫端）用它處理 0°/90° 變換數學（這段代數是本模組測試的存在理由，
 * 見檔頭 docblock）。
 *
 * - 先 `translate(-mb.minX, -mb.minY)` 把製造 bounds 局部化到 (0,0) 原點，幾何恆落在
 *   `[0,w]×[0,h]`（w/h＝mb 寬高）。
 * - `stepX`/`stepY`（cell 中心距）由呼叫端算好傳入，本函式不內建 `cellW+gap` 假設
 *   （profile-spacing spec F4/F5）：`directionInstances` 的主格點呼叫傳
 *   `direction.strideX`/`strideY`（core 依收縮擇優算好，同源不重算）；補排條帶呼叫傳
 *   「旋轉後矩形」`cellW+gap`/`cellH+gap`（補排件與主件不同相位，輪廓對接無定義，矩形＝
 *   保守正確，spec F4）。
 * - `d=0`：局部化後直接套 `translate(originX+c*stepX, originY+r*stepY)`，佔位＝w×h。
 * - `d=90`：`rotate(90)` 對點的效果是 `(x,y)→(−y,x)`，`[0,w]×[0,h]` 旋轉後落在
 *   `[−h,0]×[0,w]`，需要 `translate(h,0)` 修回正象限（`h`＝mb 原始高，不是 cellH——旋轉
 *   修正量恆基於局部化前的原始寬高）。修正必須在局部化「之後」、cell 位移「之前」，SVG
 *   transform-list 對點的套用順序由右到左，故字串書寫順序是
 *   `translate(cell) translate(h,0) rotate(90) translate(-min)`。
 * - `limit` 是呼叫端已經算好的「這次要建立幾個」（budget／MAX_PREVIEW_INSTANCES 早在呼叫
 *   前就介入），這裡只再用 `cols×rows` 兜底；`Array.from({length: clampedLimit})` 保證只
 *   建立 clampedLimit 個物件——O(limit) 不是 O(cols×rows)（round 1 收斂的 High finding，
 *   回歸沿用：cols/rows 上界可達 332,226、乘積達 1,103 億級，先展開再 slice 會凍結頁面）。
 */
function buildGrid(
  originX: number,
  originY: number,
  d: 0 | 90,
  cols: number,
  rows: number,
  mb: Bounds,
  stepX: number,
  stepY: number,
  limit: number,
): PreviewInstance[] {
  const w = mb.maxX - mb.minX;
  const h = mb.maxY - mb.minY;
  const cellW = d === 0 ? w : h;
  const cellH = d === 0 ? h : w;
  const localize = `translate(${-mb.minX} ${-mb.minY})`;

  const safeCols = Math.max(0, cols);
  const safeRows = Math.max(0, rows);
  const clampedLimit = Math.max(0, Math.min(safeCols * safeRows, limit));

  return Array.from({ length: clampedLimit }, (_, i): PreviewInstance => {
    const r = Math.floor(i / safeCols);
    const c = i % safeCols;
    const cellX = originX + c * stepX;
    const cellY = originY + r * stepY;
    const transform =
      d === 0
        ? `translate(${cellX} ${cellY}) ${localize}`
        : `translate(${cellX} ${cellY}) translate(${h} 0) rotate(90) ${localize}`;
    return { transform, cellX, cellY, cellW, cellH };
  });
}

/** budget 正規化：`NaN`→0；`+Infinity`→`MAX_PREVIEW_INSTANCES`；其餘 `≤0`（含 `-Infinity`）
 *  →0；有限正值 floor 後硬限在 `MAX_PREVIEW_INSTANCES`（SOL review High 2，見
 *  `directionInstances` docblock）。 */
function normalizeBudget(budget: number): number {
  if (Number.isNaN(budget)) return 0;
  if (budget === Infinity) return MAX_PREVIEW_INSTANCES;
  if (budget <= 0) return 0;
  return Math.min(Math.floor(budget), MAX_PREVIEW_INSTANCES);
}

/**
 * 單一子紙內的完整排列：主格點（row-major）＋勝出分割（`fillSplit`）的底／右兩條補排帶，
 * 依「主格點→底條帶→右條帶」順序疊加、budget 用完即停（T3：跨子紙的 remainingBudget 鏈
 * 由呼叫端逐子紙傳入，本函式只管單子紙內部怎麼分配，見 Global Constraints「preview cap
 * 語意」）。補排件方向與主方向相反（`fillSplit` 非 null 時補排件是主格點件轉 90° 後塞進
 * L 形剩餘空間，見 core `pickFillSplit` docblock）——旋轉修正沿用 `buildGrid` 同一條
 * `translate(h,0) rotate(90)` 鏈，這裡只是把 origin 從 `(gripper,gripper)` 換成條帶起點。
 *
 * **cell 位移分工（profile-spacing spec F4/F5）**：主格點 `buildGrid` 呼叫傳
 * `direction.strideX`/`strideY`——本卡實際採用的 stride（含收縮，core `computeDirection`
 * 擇優算好，同源不重算）。補排條帶呼叫傳「旋轉後矩形」`fillCellW+gap`/`fillCellH+gap`
 * （`fillCellW`/`fillCellH`＝mb 寬高依 `fillDir` 對調後的值——補排件相對主件轉 90°，輪廓
 * 不同相位，輪廓對接無定義，矩形界＝保守正確，spec F4「維持矩形」）——與主格點的 stride
 * 無關，即使主格點方向收縮，條帶內部排列仍固定矩形。
 *
 * 條帶起點只有兩個、與 `fillSplit` 是 bottom-full 或 right-full 無關（兩種分割下底／右
 * 條帶的左上角公式相同，差別只在哪條拿到「全長延伸」，但那已經反映在 core 算好的
 * `bottomFill.cols/rows`／`rightFill.cols/rows` 裡，這裡不需要另外分支）：
 *   - 底條帶原點 `(gripper, gripper+usedH+gap)`
 *   - 右條帶原點 `(gripper+usedW+gap, gripper)`
 * `usedW`/`usedH` 直接讀 `DirectionResult` 輸出欄位（core 已依主格點實際採用的 stride 算好、
 * `n=0→0`，與主格點 footprint 同源——T3 前這裡曾用 `cols/rows×mb 寬高×gap` 本地重算，矩形
 * 假設在收縮排列下算出偏大的值、條帶起點跟著偏移，吃掉收縮省下的空間，已刪，見 spec 驗收 7
 * 「同源、不重算」）。
 *
 * budget 正規化並硬限在 `0…MAX_PREVIEW_INSTANCES`——`NaN`／`≤0`（含 `-Infinity`）→ 0；
 * `+Infinity`／超過上限的有限值（如 `1e9`）→ 硬限 500（SOL review High 2：公開函式不信任
 * 呼叫端，這是獨立於 `computeImposition` domain 驗證之外的第二道防線）。截斷發生在建立
 * 物件之前——`buildGrid` 的 `limit` 參數即「這一段還剩多少 budget」，不是先建滿三段再
 * slice；budget 依序扣：主格點吃完或見底就停，底條帶再吃剩下的，右條帶吃最後剩下的，
 * 恰好卡在某段交界時之後的段落為空陣列（非例外／非負數長度）。
 */
export function directionInstances(
  dir: 0 | 90,
  direction: DirectionResult,
  mb: Bounds,
  gripper: number,
  gap: number,
  budget: number,
): PreviewInstance[] {
  const limit = normalizeBudget(budget);
  if (limit === 0) return [];

  const mainInstances = buildGrid(gripper, gripper, dir, direction.cols, direction.rows, mb, direction.strideX, direction.strideY, limit);
  const remainingAfterMain = limit - mainInstances.length;
  if (remainingAfterMain <= 0 || direction.fillSplit === null) return mainInstances;

  const w = mb.maxX - mb.minX;
  const h = mb.maxY - mb.minY;
  const fillDir: 0 | 90 = dir === 0 ? 90 : 0;
  const fillCellW = fillDir === 0 ? w : h;
  const fillCellH = fillDir === 0 ? h : w;

  const bottomFill = direction.bottomFill;
  const bottomInstances = bottomFill
    ? buildGrid(gripper, gripper + direction.usedH + gap, fillDir, bottomFill.cols, bottomFill.rows, mb, fillCellW + gap, fillCellH + gap, remainingAfterMain)
    : [];
  const remainingAfterBottom = remainingAfterMain - bottomInstances.length;
  if (remainingAfterBottom <= 0) return [...mainInstances, ...bottomInstances];

  const rightFill = direction.rightFill;
  const rightInstances = rightFill
    ? buildGrid(gripper + direction.usedW + gap, gripper, fillDir, rightFill.cols, rightFill.rows, mb, fillCellW + gap, fillCellH + gap, remainingAfterBottom)
    : [];
  return [...mainInstances, ...bottomInstances, ...rightInstances];
}

/**
 * 子紙左上角偏移（全紙座標系）——只讀 `sheet.cutV`/`sheet.cutH` 兩個旗標決定子紙數與排列，
 * 不靠 `sheet.w`/`sheet.fullW` 的尺寸差反推切向（SOL review High 2：兩者在特定輸入下可能
 * 相等或呈現歧義，直接讀旗標沒有這個問題，見 core `WorkingSheet` docblock）。半寬／半高
 * 一律用 `fullW`/`fullH`（裁切前的整張尺寸），不是已經取半的 `sheet.w`/`sheet.h`。
 *
 * 順序固定「左上→右上→左下→右下」（row-major：dy 當外層、dx 當內層）——單一裁切方向時
 * 自然退化成「左、右」（cutV only，dys 只有一個 0）或「上、下」（cutH only，dxs 只有一個
 * 0）；都不切時只回一個 `{0,0}`。
 */
export function sectionOffsets(sheet: WorkingSheet): { dx: number; dy: number }[] {
  const dxs = sheet.cutV ? [0, sheet.fullW / 2] : [0];
  const dys = sheet.cutH ? [0, sheet.fullH / 2] : [0];
  return dys.flatMap((dy) => dxs.map((dx) => ({ dx, dy })));
}

/** 預覽線段的線型集合——只取幾何結構線；UI 圖層可見性／標註／文字／overlay 一律不參與
 *  （spec「排列預覽」：忽略設計模式的圖層可見性，dimension/annotation/texts/overlays 不出現，
 *  這裡直接不讀取那三個來源，不是讀了再過濾掉）。 */
const PREVIEW_LINE_TYPES: ReadonlySet<LineType> = new Set(['cut', 'crease', 'halfcut']);

/**
 * 供預覽渲染的製造 paths 子集：只保留 `cut`／`crease`／`halfcut` 三線型；`piece` 有值時
 * 再依 `pathIds` 縮到該片（沿用 `core/bounds.ts` `manufacturingBounds` 同一套 pathIdSet
 * 過濾寫法），`piece` 為 `null` 時回全版（RTE／未選定片）。
 */
export function previewPaths(result: GenerateResult, piece: DielinePiece | null): DielinePath[] {
  const pathIdSet = piece ? new Set(piece.pathIds) : null;
  return result.paths.filter((p) => PREVIEW_LINE_TYPES.has(p.type) && (pathIdSet === null || pathIdSet.has(p.id)));
}
