/**
 * ExportBar：「下載 SVG」（或「匯出目前視圖」）。
 *
 * 下載流程（Blob → object URL → 隱藏 <a download> → click）移植自前身
 * `Packaging/index.tsx` 的 `handleDownload`。與前身不同：SVG 內容改由
 * `export/svg.ts` 的 `toSvgDocument()` 產生（與畫布共用 LINE_STYLES 同一來源，
 * 不再是第二條手刻序列化路徑——這正是 spec §3.2 要修正的前身「漂移」問題）。
 *
 * 「含尺寸標註」checkbox 已於 Slice 3 gate round 1 T2 退役（原本 T9 樣張 gate 第二輪驗收
 * 反饋修復 3 把這顆 checkbox 的 state 提升到 App.tsx、同時餵給 Canvas，讓下載內容與畫布
 * 顯示同步）。gate round 1 驗收反饋把「顯示哪些線型」升級成 LayersPanel 的圖層可見性
 * （`layersState.generatedVisible`，純畫布顯示層級的開關），而匯出這邊改為 plan 明文
 * 裁決「匯出恆全量」：`toSvgDocument(exportResult)` 呼叫時不傳第二參數——`includeDimensions`
 * opts 已於 T4 退役，`toSvgDocument` 現在只接受一個參數、恆全量輸出，畫布圖層可見性完全不
 * 影響匯出內容——理由是匯出檔要完整，「忘了開層就匯出殘缺刀模」是生產事故；使用者若想要
 * 不含標註的檔案，在 Illustrator 裡對匯出後的分層 SVG 自行隱藏/刪除該圖層（T4 已把
 * `toSvgDocument` 輸出按線型分成 4 個命名 `<g>` 圖層，此操作在 Illustrator 裡可行，見
 * export/svg.ts docblock）。
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
 * `downloadBlob()` 共用，SVG／DXF 都走同一份清理邏輯。DXF 下載恆排除尺寸標註：`toDxfDocument`
 * 依 spec（生產檔裁決）恆排除 dimension/annotation 線型與全部 `texts`，不受任何可見性
 * 設定影響（跟 SVG「匯出恆全量」是同一個「匯出不讀畫布可見性」精神，只是 DXF 這邊連
 * `includeDimensions` 這種 opts 參數都沒有——`toDxfDocument` 從一開始就不接受這個選項）。
 * MIME 選
 * `application/dxf`——`application/dxf` 比 `text/plain` 更精確描述內容型別，即使非 IANA 正式
 * 登錄，這裡的 MIME 只影響〈使用者手動處理 blob URL〉這類邊角案例，不影響 `<a download>`
 * 這條下載路徑本身（download 屬性已強制指定副檔名／檔名）。
 */
import type { Bounds } from '@/core/geometry';
import { segmentsBounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, ResolvedParams } from '@/core/types';
import { toDxfDocument } from '@/export/dxf';
import { manufacturingBounds, toSvgDocument } from '@/export/svg';

export interface ExportBarProps {
  boxId: string;
  values: ResolvedParams;
  result: GenerateResult;
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
 * spec 給的具體範例 `rte-{L}x{W}x{D}.svg` 是 v1 唯一盒型（boxId='rte'）代入這個
 * 通式後的結果，兩者逐字相符；泛化成 boxId 前綴讓 Slice 2 新盒型不必改這支檔案。
 *
 * FX1（whole-branch review，Slice 2）：telescope 宣告的是 `baseLength`/`baseWidth`/
 * `baseHeight`，沒有 L/W/D 這三個 key——舊版無條件用 `dim('L')/dim('W')/dim('D')`，
 * telescope 全版匯出因此退化成 `telescope-?x?x?.svg`（三個都 fallback 成 '?'）。只有
 * 「L/W/D 三個 key 都宣告」的盒型（v1 只有 RTE）才走原本的 `{L}x{W}x{D}` 模式；其餘盒型
 * 改用 `bounds` 參數的實際尺寸（比照 `buildPieceFilename` 的 maxX−minX/maxY−minY 模式，
 * 兩者共用同一套「用幾何包絡而非猜測宣告 key」的 fallback 邏輯），格式退化為
 * `{boxId}-{length}x{width}.{ext}`（2 維，不是 3 維——bounds 天生只有兩個維度，沒有第三個
 * 「深度」可取）。
 *
 * FX5（Slice 3 final review）：這裡的 `bounds` 參數，呼叫端（見下方 `exportFilename`）現在
 * 傳的是 `manufacturingBounds(result)`（`export/svg.ts`），不是 `result.bounds` 原值——後者
 * 依 spec §3.3 三向等式必須完整涵蓋含尺寸標註線在內的全部幾何，這個 fallback 分支（telescope
 * 等無 L/W/D 盒型的全版匯出）若直接拿 `result.bounds` 當檔名尺寸，會比實際製造尺寸大一圈
 * （DXF 是生產交付檔，檔名數字誤導交付）。這是 Slice 2 FX3 當時修了單片
 * （`pieceManufacturingBounds`）、漏修全版 fallback 這條路徑的既有 bug，本輪一併補上，
 * SVG／DXF 兩種副檔名都受影響。`hasDeclaredLWD` 分支（v1 目前只有 RTE）不受影響：那條
 * 路徑完全不讀 `bounds` 參數，直接用 `values` 裡宣告的 L/W/D。
 *
 * `ext`（Slice 3 Task 2 新增）：SVG／DXF 下載共用這份檔名邏輯，只有副檔名不同，因此抽成參數
 * 而不是複製一份幾乎一樣的 builder——呼叫端傳 `'svg'` 或 `'dxf'`。
 */
function buildFilename(boxId: string, values: ResolvedParams, bounds: Bounds, ext: 'svg' | 'dxf'): string {
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
 * 開發紀錄）——但抽成共用 util 需要動 `src/core/` 或 `src/export/`，兩者都在本輪
 * 明列不可動的檔案清單內，因此按 spec 字面「檔名 fmt」的要求局部複製，把「該不該抽」的
 * 決定留給下一個真的有權限動那兩個目錄的 task（見 開發紀錄 concerns）。
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
function buildPieceFilename(boxId: string, pieceId: string, bounds: Bounds, ext: 'svg' | 'dxf'): string {
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
 * 它內部按線型分 4 個命名 `<g>` 圖層的序列化邏輯，不需要另外複製一份匯出邏輯。
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

/**
 * 單片／全版檔名的分流本身也是 SVG／DXF 共用邏輯，只有 ext 不同——收斂成一個函式，兩個下載
 * handler 各呼叫一次。FX5（Slice 3 final review）：全版分支改傳 `manufacturingBounds(result)`
 * （`export/svg.ts`，排除 dimension/annotation 後的幾何包絡）取代原本的 `result.bounds`——
 * 見上方 `buildFilename` docblock 的完整根因說明。單片分支（`pieceManufacturingBounds`）
 * 不在本輪修復範圍內，維持原樣。
 */
function exportFilename(boxId: string, values: ResolvedParams, result: GenerateResult, activePiece: DielinePiece | undefined, ext: 'svg' | 'dxf'): string {
  return activePiece
    ? buildPieceFilename(boxId, activePiece.id, pieceManufacturingBounds(result, activePiece), ext)
    : buildFilename(boxId, values, manufacturingBounds(result), ext);
}

export function ExportBar({ boxId, values, result, activePiece }: ExportBarProps) {
  const hasPieces = result.pieces !== undefined;
  // exportResult 在 render 期計算（而非各自 handler 內才算）是 T2（Slice 2）的刻意變更：
  // SVG／DXF 兩個 handler 共用同一份已過濾結果，不必各自呼叫 scopeResultToPiece。
  // scopeResultToPiece 是純函式，行為與「handler 內即時算」功能等價；代價是未點擊匯出按鈕
  // 的 render 也會多跑一次過濾（result 的 paths/texts 量體小，可忽略）。
  const exportResult = activePiece ? scopeResultToPiece(result, activePiece) : result;

  // toSvgDocument 只接受一個參數：includeDimensions opts 已於 T4 退役，SVG 匯出恆全量
  // （Slice 3 gate round 1 T2 plan 裁決，見本檔開頭 docblock）且按線型分 4 個命名 <g> 圖層
  // （T4，見 export/svg.ts）。
  const handleSvgDownload = () => {
    const svg = toSvgDocument(exportResult);
    downloadBlob(svg, 'image/svg+xml;charset=utf-8', exportFilename(boxId, values, result, activePiece, 'svg'));
  };

  // toDxfDocument 恆排除 dimension/annotation 線型與全部 texts（生產檔裁決，見
  // export/dxf.ts 檔頭），這個函式從一開始就沒有 includeDimensions 這種 opts 參數。
  const handleDxfDownload = () => {
    const dxf = toDxfDocument(exportResult);
    downloadBlob(dxf, 'application/dxf', exportFilename(boxId, values, result, activePiece, 'dxf'));
  };

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-zinc-200">
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
