/**
 * ExportBar：「下載 SVG」（或「匯出目前視圖」）＋「含尺寸標註」checkbox。
 *
 * 下載流程（Blob → object URL → 隱藏 <a download> → click）移植自前身
 * `Packaging/index.tsx` 的 `handleDownload`。與前身不同：SVG 內容改由
 * `export/svg.ts` 的 `toSvgDocument()` 產生（與畫布共用 LINE_STYLES 同一來源，
 * 不再是第二條手刻序列化路徑——這正是 spec §3.2 要修正的前身「漂移」問題）。
 *
 * `includeDimensions` 是受控 prop（T9 樣張 gate 第二輪維護者反饋修復 3）：這裡原本自己
 * `useState` 管這顆 checkbox，只影響下載內容、跟畫布顯示脫鉤（維護者實測發現：取消勾選只
 * 影響下載的 SVG，畫布還是照樣畫出尺寸標註）。state 提升到 App.tsx 後同時餵給 Canvas，
 * 兩處視覺才會同步；ExportBar 改成純受控元件，checkbox 的顯示值＝`includeDimensions`
 * prop，onChange 呼叫 `onIncludeDimensionsChange` 把新值交回父層。
 *
 * `activePiece`（Slice 2 Task 6，spec §4.2）：`result.pieces` 存在時，按鈕文字改為
 * 「匯出目前視圖」——語意跟著 Canvas 目前顯示的視圖走：`activePiece` 為 undefined（全版
 * 視圖）時輸出跟既有行為完全相同的整版 SVG；有值（單片視圖）時只輸出該片的 paths/texts
 * （依 pathIds/textIds 集合過濾，見 `scopeResultToPiece`），檔名也換成
 * `{boxId}-{pieceId}-{L}x{W}.svg`（L/W 取該片 bounds 尺寸，不是 values 裡的宣告參數——
 * 片 bounds 才是這片實際占用的製造尺寸，且多片盒型未必每片都對應到單一個宣告 key，例如
 * liner 是帶狀攤平、沒有單一「L」意義的參數）。`result.pieces` 為 undefined 的單片盒型
 * （RTE）完全不受影響：`hasPieces` 為 false，按鈕文字與匯出行為都維持原樣。
 */
import type { Bounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, ResolvedParams } from '@/core/types';
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
 * 檔名慣例沿用 spec §6.2 為 DXF 訂的 `{盒型id}-{L}x{W}x{D}` 模式（此處副檔名 .svg）——
 * spec 給的具體範例 `rte-{L}x{W}x{D}.svg` 是 v1 唯一盒型（boxId='rte'）代入這個
 * 通式後的結果，兩者逐字相符；泛化成 boxId 前綴讓 Slice 2 新盒型不必改這支檔案。
 * L/W/D 三個 key 若某盒型未宣告（v1 兩個盒型 RTE/天地盒皆有，见 spec §4），退化顯示
 * '?' 而非字面 "undefined"（防禦性 fallback，非預期路徑）。
 */
function buildFilename(boxId: string, values: ResolvedParams): string {
  const dim = (key: string): string => {
    const v = values[key];
    return v === undefined ? '?' : String(v);
  };
  return `${boxId}-${dim('L')}x${dim('W')}x${dim('D')}.svg`;
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
 * 單片匯出檔名：`{boxId}-{pieceId}-{L}x{W}.svg`——L/W 取該片 `bounds` 的實際尺寸，不是
 * `values` 裡的宣告參數（片 bounds 已經是「這片實際占用的製造尺寸」，多片盒型裡也未必每片
 * 都對應到單一個宣告 key，例如 liner 是帶狀攤平、沒有單一「L」意義的參數）。
 */
function buildPieceFilename(boxId: string, pieceId: string, bounds: Bounds): string {
  const length = fmtDim(bounds.maxX - bounds.minX);
  const width = fmtDim(bounds.maxY - bounds.minY);
  return `${boxId}-${pieceId}-${length}x${width}.svg`;
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

export function ExportBar({ boxId, values, result, includeDimensions, onIncludeDimensionsChange, activePiece }: ExportBarProps) {
  const hasPieces = result.pieces !== undefined;

  const handleDownload = () => {
    const exportResult = activePiece ? scopeResultToPiece(result, activePiece) : result;
    const svg = toSvgDocument(exportResult, { includeDimensions });
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = activePiece ? buildPieceFilename(boxId, activePiece.id, activePiece.bounds) : buildFilename(boxId, values);
    document.body.appendChild(link);
    link.click();
    URL.revokeObjectURL(url); // 每次下載都會 createObjectURL 一個新 blob URL，不 revoke 會持續洩漏
    document.body.removeChild(link);
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
      <button
        type="button"
        onClick={handleDownload}
        className="w-full bg-black hover:bg-zinc-800 text-white font-medium text-sm py-2.5 rounded-sm transition-colors"
      >
        {hasPieces ? '匯出目前視圖' : '下載 SVG'}
      </button>
    </div>
  );
}
