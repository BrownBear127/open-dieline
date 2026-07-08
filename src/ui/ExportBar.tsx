/**
 * ExportBar：「下載 SVG」（或「匯出目前視圖」）＋「含尺寸標註」checkbox。
 *
 * 下載流程（Blob → object URL → 隱藏 <a download> → click）移植自前身
 * `Packaging/index.tsx` 的 `handleDownload`。與前身不同：SVG 內容改由
 * `export/svg.ts` 的 `toSvgDocument()` 產生（與畫布共用 LINE_STYLES 同一來源，
 * 不再是第二條手刻序列化路徑——這正是 spec §3.2 要修正的前身「漂移」問題）。
 *
 * `includeDimensions` 是受控 prop（T9 樣張 gate 第二輪法蘭反饋修復 3）：這裡原本自己
 * `useState` 管這顆 checkbox，只影響下載內容、跟畫布顯示脫鉤（法蘭實測發現：取消勾選只
 * 影響下載的 SVG，畫布還是照樣畫出尺寸標註）。state 提升到 App.tsx 後同時餵給 Canvas，
 * 兩處視覺才會同步；ExportBar 改成純受控元件，checkbox 的顯示值＝`includeDimensions`
 * prop，onChange 呼叫 `onIncludeDimensionsChange` 把新值交回父層。
 *
 * `activePiece`（Slice 2 Task 6，spec §4.2）：`result.pieces` 存在時，按鈕文字改為
 * 「匯出目前視圖」——語意跟著 Canvas 目前顯示的視圖走：`activePiece` 為 undefined（全版
 * 視圖）時輸出跟既有行為完全相同的整版 SVG；有值（單片視圖）時只輸出該片的 paths/texts
 * （依 pathIds/textIds 集合過濾，見 `scopeResultToPiece`），檔名也換成
 * `{boxId}-{pieceId}-{L}x{W}.svg`（L/W 取該片**非 dimension** paths 的 hull，不是
 * `piece.bounds` 也不是 values 裡的宣告參數——`piece.bounds` 依 spec §3.3 三向等式必須
 * 涵蓋含尺寸標註線在內的全部成員，直接拿來當檔名會比實際製造尺寸大一圈；viewBox 顯示仍用
 * `piece.bounds` 原值，含標註匯出時標註線才不會跑出可視框外，只有檔名這裡改用更貼近製造
 * 尺寸的窄口徑——見 `pieceManufacturingBounds`，FX3）。多片盒型未必每片都對應到單一個
 * 宣告 key，例如 liner 是帶狀攤平、沒有單一「L」意義的參數，因此不採 values 反查。
 * `result.pieces` 為 undefined 的單片盒型（RTE）完全不受影響：`hasPieces` 為 false，
 * 按鈕文字與匯出行為都維持原樣。
 *
 * **DXF 下載（Slice 3 Task 2）**：與 SVG 按鈕並列，消費 T1 的 `export/dxf.ts` `toDxfDocument()`。
 * 檔名沿用同一套 `buildFilename`/`buildPieceFilename`，副檔名改抽成參數（`ext`）共用同一份邏輯，
 * 不複製第二份檔名 builder。下載機制（Blob→object URL→`<a download>`→click→revoke）也抽成
 * `downloadBlob()` 共用，SVG／DXF 都走同一份清理邏輯。`includeDimensions` 這顆 checkbox 對 DXF
 * 下載無效：`toDxfDocument` 依 spec（生產檔裁決）恆排除 dimension/annotation 線型與全部
 * `texts`，因此 DXF 的下載呼叫不傳這個 flag；UI 不另外加提示（brief 明列不需要）。MIME 選
 * `application/dxf`——`application/dxf` 比 `text/plain` 更精確描述內容型別，即使非 IANA 正式
 * 登錄，這裡的 MIME 只影響〈使用者手動處理 blob URL〉這類邊角案例，不影響 `<a download>`
 * 這條下載路徑本身（download 屬性已強制指定副檔名／檔名）。
 */
import type { Bounds } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, ResolvedParams } from '@/core/types';
import { toDxfDocument } from '@/export/dxf';
import { toSvgDocument } from '@/export/svg';

export interface ExportBarProps {
  boxId: string;
  values: ResolvedParams;
  result: GenerateResult;
  includeDimensions: boolean;
  onIncludeDimensionsChange: (value: boolean) => void;
  /**
   * 目前選定要單獨匯出的片；undefined＝匯出全版（既有行為）。語意與傳給 Canvas 的同名 prop
   * 一致——App.tsx 用同一個 selectedPieceId 對 `result.pieces` 解出同一個值，下傳給 Canvas
   * 與 ExportBar 兩邊，確保「畫面看到的視圖」與「按下匯出拿到的檔案」永遠是同一片。選填：
   * `result.pieces` 為 undefined 的單片盒型（RTE）不會傳這個 prop。
   */
  activePiece?: DielinePiece;
}

/**
 * 檔名慣例沿用 spec §6.2 為 DXF 訂的 `{盒型id}-{L}x{W}x{D}` 模式——
 * brief 給的具體範例 `rte-{L}x{W}x{D}.svg` 是 v1 唯一盒型（boxId='rte'）代入這個
 * 通式後的結果，兩者逐字相符；泛化成 boxId 前綴讓 Slice 2 新盒型不必改這支檔案。
 *
 * FX1（whole-branch review）：telescope 宣告的是 `baseLength`/`baseWidth`/`baseHeight`，
 * 沒有 L/W/D 這三個 key——舊版無條件用 `dim('L')/dim('W')/dim('D')`，telescope 全版匯出
 * 因此退化成 `telescope-?x?x?.svg`（三個都 fallback 成 '?'）。只有「L/W/D 三個 key 都
 * 宣告」的盒型（v1 只有 RTE）才走原本的 `{L}x{W}x{D}` 模式；其餘盒型改用 `result.bounds`
 * 的實際尺寸（比照 `buildPieceFilename` 的 maxX−minX/maxY−minY 模式，兩者共用同一套
 * 「用幾何包絡而非猜測宣告 key」的 fallback 邏輯），格式退化為 `{boxId}-{length}x{width}.{ext}`
 * （2 維，不是 3 維——bounds 天生只有兩個維度，沒有第三個「深度」可取）。
 *
 * `ext`（Slice 3 Task 2 新增）：SVG／DXF 下載共用這份檔名邏輯，只有副檔名不同，因此抽成參數
 * 而不是複製一份幾乎一樣的 builder——呼叫端傳 `'svg'` 或 `'dxf'`。
 */
function buildFilename(boxId: string, values: ResolvedParams, bounds: Bounds, ext: string): string {
  const hasDeclaredLWD = ['L', 'W', 'D'].every((key) => values[key] !== undefined);
  if (hasDeclaredLWD) {
    const dim = (key: string): string => String(values[key]);
    return `${boxId}-${dim('L')}x${dim('W')}x${dim('D')}.${ext}`;
  }
  const length = fmtDim(bounds.maxX - bounds.minX);
  const width = fmtDim(bounds.maxY - bounds.minY);
  return `${boxId}-${length}x${width}.${ext}`;
}

/**
 * 單片匯出檔名用的數字格式化：2 位小數、'-0.00' 收斂為 '0.00'——與 `export/svg.ts` 內部
 * 未匯出的 `fmt()` 同一慣例（該檔的 docblock 禁止本檔改動它，這裡也拿不到那個 private
 * function）。這是專案裡第三處出現同一份 3 行小函式（另兩處：`core/path.ts`、
 * `export/svg.ts`；Task 7 final review 早就記錄「第三處出現時抽 util」，見
 * progress.md）——但抽成共用 util 需要動 `src/core/` 或 `src/export/`，兩者都在本 task
 * 明列不可動的檔案清單內，因此按 brief 字面「檔名 fmt」的要求局部複製，把「該不該抽」的
 * 決定留給下一個真的有權限動那兩個目錄的 task（見 task-6-report.md concerns）。
 */
function fmtDim(v: number): string {
  const s = v.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/**
 * 單片匯出檔名：`{boxId}-{pieceId}-{L}x{W}.{ext}`——L/W 取該片**非 dimension** paths 的
 * hull，不是 `piece.bounds` 也不是 `values` 裡的宣告參數（多片盒型裡也未必每片都對應到
 * 單一個宣告 key，例如 liner 是帶狀攤平、沒有單一「L」意義的參數）。
 *
 * FX3（whole-branch review）：`piece.bounds` 依 `core/pieces.ts` 的 spec §3.3 三向等式，
 * 必須完整涵蓋該片全部成員（含尺寸標註線與文字），直接拿 `piece.bounds` 當檔名尺寸會比
 * 實際製造尺寸大一圈（含標註延伸與引出線）——使用者拿檔名對照實物量測時會困惑。改用
 * `pieceManufacturingBounds()` 只量該片 cut/crease/halfcut 幾何（過濾掉
 * `type==='dimension'` 的 paths 後 `segmentsBounds`），viewBox 顯示不受影響、仍用
 * `piece.bounds` 原值（含標註匯出時標註線才不會跑出可視框外，見 Canvas.tsx 與本檔開頭
 * docblock）。
 *
 * `ext`（Slice 3 Task 2 新增）：同上方 `buildFilename`，SVG／DXF 共用這份邏輯、只有副檔名不同。
 */
function buildPieceFilename(boxId: string, pieceId: string, bounds: Bounds, ext: string): string {
  const length = fmtDim(bounds.maxX - bounds.minX);
  const width = fmtDim(bounds.maxY - bounds.minY);
  return `${boxId}-${pieceId}-${length}x${width}.${ext}`;
}

/**
 * 單片「製造尺寸」hull——排除 dimension 型別的 paths 後對剩餘 segments 取 segmentsBounds
 * （FX3）。只用來算檔名，不影響 viewBox：viewBox 仍用 `piece.bounds` 原值（見上方
 * `buildPieceFilename` docblock）。
 */
function pieceManufacturingBounds(result: GenerateResult, piece: DielinePiece): Bounds {
  const pathIdSet = new Set(piece.pathIds);
  const nonDimensionSegments = result.paths
    .filter((p) => pathIdSet.has(p.id) && p.type !== 'dimension')
    .flatMap((p) => p.segments);
  return segmentsBounds(nonDimensionSegments);
}

/**
 * 把 result 縮到只含 `piece` 的 paths/texts＋該片 bounds（pathIds/textIds 集合匹配，不是猜
 * index）。`toSvgDocument` 不消費 `GenerateResult.pieces` 欄位（只讀 paths/texts/bounds，
 * 見 export/svg.ts），縮完的物件省略 pieces 完全合法，餵給既有的 `toSvgDocument` 就能重用
 * 它內部的 includeDimensions 過濾與序列化邏輯，不需要另外複製一份匯出邏輯。
 */
function scopeResultToPiece(result: GenerateResult, piece: DielinePiece): GenerateResult {
  const pathIds = new Set(piece.pathIds);
  const textIds = new Set(piece.textIds);
  return {
    paths: result.paths.filter((p) => pathIds.has(p.id)),
    texts: result.texts.filter((t) => textIds.has(t.id)),
    bounds: piece.bounds,
  };
}

/**
 * Blob → object URL → 隱藏 `<a download>` → click → revoke，SVG／DXF 兩種下載共用同一套
 * 流程（格式無關的部分只有這裡；下方兩個 handler 只負責備妥「內容字串／MIME／檔名」三個
 * 參數，不各自重複一份 anchor 操作）。
 */
function downloadBlob(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(url); // 每次下載都會 createObjectURL 一個新 blob URL，不 revoke 會持續洩漏
  document.body.removeChild(link);
}

/** 單片／全版檔名的分流本身也是 SVG／DXF 共用邏輯，只有 ext 不同——收斂成一個函式，兩個下載 handler 各呼叫一次。 */
function exportFilename(boxId: string, values: ResolvedParams, result: GenerateResult, activePiece: DielinePiece | undefined, ext: string): string {
  return activePiece
    ? buildPieceFilename(boxId, activePiece.id, pieceManufacturingBounds(result, activePiece), ext)
    : buildFilename(boxId, values, result.bounds, ext);
}

export function ExportBar({ boxId, values, result, includeDimensions, onIncludeDimensionsChange, activePiece }: ExportBarProps) {
  const hasPieces = result.pieces !== undefined;
  const exportResult = activePiece ? scopeResultToPiece(result, activePiece) : result;

  const handleSvgDownload = () => {
    const svg = toSvgDocument(exportResult, { includeDimensions });
    downloadBlob(svg, 'image/svg+xml;charset=utf-8', exportFilename(boxId, values, result, activePiece, 'svg'));
  };

  // includeDimensions 對 DXF 無效：toDxfDocument 恆排除 dimension/annotation 線型與全部
  // texts（生產檔裁決，見 export/dxf.ts 檔頭），這裡故意不把這個 flag 傳進去。
  const handleDxfDownload = () => {
    const dxf = toDxfDocument(exportResult);
    downloadBlob(dxf, 'application/dxf', exportFilename(boxId, values, result, activePiece, 'dxf'));
  };

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-zinc-200">
      <label htmlFor="include-dimensions" className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          id="include-dimensions"
          type="checkbox"
          checked={includeDimensions}
          onChange={(e) => onIncludeDimensionsChange(e.target.checked)}
          className="h-4 w-4 accent-blue-600"
        />
        含尺寸標註
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSvgDownload}
          className="flex-1 bg-black hover:bg-zinc-800 text-white font-medium text-sm py-2.5 rounded-sm transition-colors"
        >
          {hasPieces ? '匯出目前視圖' : '下載 SVG'}
        </button>
        <button
          type="button"
          onClick={handleDxfDownload}
          className="flex-1 bg-black hover:bg-zinc-800 text-white font-medium text-sm py-2.5 rounded-sm transition-colors"
        >
          {hasPieces ? '匯出目前視圖（DXF）' : '下載 DXF'}
        </button>
      </div>
    </div>
  );
}
