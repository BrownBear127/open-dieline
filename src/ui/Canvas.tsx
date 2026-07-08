/**
 * Canvas：pan/zoom 畫布，渲染 GenerateResult 的線段與標註文字，並疊加 hover/不變式警告高亮。
 *
 * pan/zoom 手感邏輯（scale/pan state、滾輪縮放、拖曳平移、Fit 按鈕）移植自前身
 * `Packaging/index.tsx:100-122`（`handleFitToScreen` 手刻模式）與其下的 wheel/mouse
 * handlers（唯讀參照，見 開發紀錄）。Fit 的內容尺寸一律用 `result.bounds`
 * （資料層），不用 `getBBox()`/`getBoundingClientRect()` 量測畫出來的 SVG——
 * jsdom 不支援這些量測回傳真值，測試才可行；瀏覽器下語意也更正確（bounds 是
 * generate() 保證涵蓋全部路徑的權威範圍，見 core/types.ts 的 BoxInvariant「bounds-cover」）。
 *
 * 線段樣式一律查 `LINE_STYLES[p.type]`（唯一來源，見 core/styles.ts）；highlight 疊加色
 * #FF6B00 是 spec 明文的例外——UI 互動色，不是線型樣式，不放進 LINE_STYLES。T9 樣張 gate
 * 反饋後畫布底色由深轉淺（見 App.tsx 開頭註解），#FF6B00 維持原值不變：它不再是「深色調亮
 * 亮色」，而是白底畫布上與黑 cut／綠 crease／黃 halfcut／藍 dimension 四色仍保持清楚對比的
 * 高對比互動色，換底色後對比關係不受影響。
 *
 * pieces 全版／單片視圖切換（Slice 2 Task 6，spec §4.2）：`activePiece` 有值時只渲染該片的
 * paths/texts（依 `pathIds`/`textIds` 集合過濾，不是猜測 index），viewBox 改用該片 bounds
 * 外加 `PIECE_VIEW_PADDING` 邊距。這個邊距是必要的：T1 定案「多片盒型的片 bounds 不烘邊距，
 * 邊距歸 UI/匯出層」（見開發紀錄）——對照 RTE 全版 bounds 是盒型
 * 自己烘了 ±20mm 畫布邊距進去（見 reverse-tuck-end.ts 的 bounds 算式），telescope 等多片
 * 盒型的片 bounds 是「成員實際包絡」，緊貼幾何，直接拿來當 viewBox 會讓內容貼死畫布邊緣。
 * 全版視圖（`activePiece` 為 undefined）完全不受影響，沿用既有 `result.bounds` 直接當
 * viewBox 的行為，不額外加這層邊距。
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { Bounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, LocalizedText } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';
import { DIMENSION_LINE_TYPES } from '@/export/svg';

export interface CanvasProps {
  result: GenerateResult;
  highlightTags: string[] | null;
  invariantWarnings: { message: LocalizedText; tags?: string[] }[];
  /**
   * 是否顯示尺寸標註線與文字；預設 true。T9 樣張 gate 第二輪維護者反饋修復 3：ExportBar 的
   * 「含尺寸標註」checkbox 原本只控制下載 SVG、畫布永遠顯示標註——這裡改成畫布也接受同一個
   * （已提升到 App.tsx 的）state，false 時比照 export/svg.ts 的 toSvgDocument 過濾規則
   * （剔除 DIMENSION_LINE_TYPES 線型路徑與全部 texts），讓畫布與下載內容視覺同步。
   * 選填＋預設 true：既有只關注幾何/高亮的 Canvas 單元測試不需要跟著改。
   */
  includeDimensions?: boolean;
  /**
   * 目前選定要單獨顯示的片；undefined＝全版視圖。呼叫端（App.tsx）負責用 selectedPieceId 對
   * `result.pieces` 做 `.find()` 解出這個值——包含「找不到時視為全版」的防呆（例如切換參數讓
   * linerEnabled=false，原本選定的 'liner' 片消失），Canvas 本身不重複這個查找/防呆邏輯，只
   * 依「有沒有收到一個具體的 piece 物件」決定渲染範圍。選填：`result.pieces` 為 undefined 的
   * 單片盒型（RTE）不會傳這個 prop，也不影響既有渲染路徑。
   */
  activePiece?: DielinePiece;
  /**
   * 使用者點選視圖切換按鈕；「全版」按鈕回呼 null，其餘按鈕回呼該片的 `id`。`result.pieces`
   * 為 undefined 時這排按鈕不會渲染，此 callback 不會被呼叫；選填＋用 `?.()` 呼叫，讓既有
   * 直接對 Canvas 傳入單片 result（不含 pieces）的單元測試不必跟著補這個 prop。
   */
  onSelectPiece?: (pieceId: string | null) => void;
}

const HIGHLIGHT_STROKE = '#FF6B00';
const HIGHLIGHT_OPACITY = 0.9;
const HIGHLIGHT_WIDTH_FACTOR = 3;
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;
const FIT_PADDING = 120;
/**
 * 多片盒型（天地盒等）預設縮放倍率（T7 樣張 gate 第一輪維護者反饋修 3·2026-07-09）：
 * 維護者實際操作發現多片盒型（全版／各單片視圖皆算）auto-fit 後的預設顯示偏小，要求
 * 一律再放大 130%。判斷依據用 `result.pieces !== undefined`（是否為多片盒型）而非
 * boxId 字面比對——理由：pieces 是型別層已有的公開契約（spec §3.3「省略＝單片盒型」），
 * 未來新增其他多片盒型會自動套用同一預設，不需要在這裡逐一列舉盒型 id；RTE（單片，
 * pieces undefined）不受影響，維持 1.0×fit 現狀不變。
 */
const MULTI_PIECE_FIT_MULTIPLIER = 1.3;
const DIMENSION_TEXT_FILL = LINE_STYLES.dimension.stroke;
/**
 * 單片視圖的幾何邊距（mm，viewBox 座標系——不要跟上面 `FIT_PADDING` 的螢幕像素單位搞混，
 * 兩者是完全不同的量綱，只是剛好都叫 padding）。20mm 沿用專案裡兩個既有的同量級慣例：
 * telescope 版面片間距 `PIECE_GAP=20`、RTE 自己烘進全版 bounds 的畫布邊距同為 20mm——取一致
 * 的視覺呼吸感，不是任意數字。見本檔開頭 docblock 對「為什麼片視圖需要這層邊距」的完整說明。
 */
const PIECE_VIEW_PADDING = 20;

/** 依容器可視尺寸與內容 bounds 算出「剛好塞滿」的 scale——邏輯照前身 handleFitToScreen 移植。 */
function computeFitScale(containerW: number, containerH: number, bounds: Bounds): number {
  const availableW = Math.max(containerW - FIT_PADDING, 1);
  const availableH = Math.max(containerH - FIT_PADDING, 1);
  // 內容尺寸為 0（極端退化案例）時退回 100，避免除以 0（前身同一防護）。
  const contentW = bounds.maxX - bounds.minX || 100;
  const contentH = bounds.maxY - bounds.minY || 100;
  const newScale = Math.min(availableW / contentW, availableH / contentH);
  return Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
}

/** 把 bounds 四邊各外推 padding——單片視圖 viewBox 專用（全版視圖不套用，見本檔開頭 docblock）。 */
function expandBounds(b: Bounds, padding: number): Bounds {
  return { minX: b.minX - padding, maxX: b.maxX + padding, minY: b.minY - padding, maxY: b.maxY + padding };
}

/** 視圖切換按鈕樣式：選定＝黑底白字（比照「下載 SVG」等主行動按鈕的強調色），未選定＝白底 zinc 邊框（比照 Fit/縮放按鈕）。 */
function switcherButtonClass(isActive: boolean): string {
  const base = 'px-2 py-1 border text-xs shadow-sm transition-colors';
  return isActive ? `${base} bg-black border-black text-white` : `${base} bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50`;
}

export function Canvas({
  result,
  highlightTags,
  invariantWarnings,
  includeDimensions = true,
  activePiece,
  onSelectPiece,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  // 單片視圖：bounds 外加視覺邊距；全版視圖：沿用 result.bounds 原值（既有行為不變，見 docblock）。
  const activeBounds = activePiece ? expandBounds(activePiece.bounds, PIECE_VIEW_PADDING) : result.bounds;
  // 是否為多片盒型（見上方 MULTI_PIECE_FIT_MULTIPLIER 註解：判斷依據刻意用 pieces 存在
  // 與否，不用 boxId）。
  const isMultiPiece = result.pieces !== undefined;

  const handleFit = () => {
    const el = containerRef.current;
    const fitScale = computeFitScale(el?.clientWidth ?? 0, el?.clientHeight ?? 0, activeBounds);
    const targetScale = isMultiPiece ? fitScale * MULTI_PIECE_FIT_MULTIPLIER : fitScale;
    setScale(Math.min(Math.max(targetScale, MIN_SCALE), MAX_SCALE));
    setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    // 掛載後延遲一拍再 Fit：容器初次量測時瀏覽器可能還沒完成佈局（前身同一手法，
    // 100ms timeout 換取 clientWidth/clientHeight 有意義的值）。依賴陣列改用
    // `[isMultiPiece]`（T7 gate 修 3·2026-07-09，原本是 `[]`）：單片↔多片盒型切換時
    // （isMultiPiece 真假值改變）重新 Fit 一次，讓「進入天地盒畫面」也能拿到 130% 預設
    // 縮放，不只是首次掛載——React 對任何依賴陣列都保證掛載後至少跑一次，所以這裡沒有
    // 重複呼叫的風險。isMultiPiece 在「同一盒型內調參數」（含 linerEnabled 開關——pieces
    // 陣列長度會變，但「是否為 undefined」不變）時恆定不變，因此調參數/切單片視圖仍不會
    // 觸發重新 Fit，維持使用者當下自訂的 scale/pan（原設計意圖不變，只多了「盒型單↔多片
    // 切換」這一個額外觸發點）。
    const timer = setTimeout(handleFit, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiPiece]);

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      setScale((prev) => Math.min(Math.max(MIN_SCALE, prev * factor), MAX_SCALE));
    } else {
      setPan((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  };

  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);
  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isDragging) {
      setPan((prev) => ({ x: prev.x + e.movementX, y: prev.y + e.movementY }));
    }
  };

  // 高亮 tag 集合＝hover 高亮 ∪ 全部不變式警告的 tags（spec 裁決：同一機制、聯集）。
  const highlightSet = new Set<string>([...(highlightTags ?? []), ...invariantWarnings.flatMap((w) => w.tags ?? [])]);
  const isHighlighted = (tags?: string[]): boolean => (tags ?? []).some((t) => highlightSet.has(t));

  const { minX, minY, maxX, maxY } = activeBounds;
  const viewW = maxX - minX || 100;
  const viewH = maxY - minY || 100;

  // 片範圍過濾（pathIds/textIds 集合匹配，不是猜 index）：activePiece 存在時先縮到該片的成員，
  // 再疊加既有的 includeDimensions 可見性過濾——兩層過濾各自獨立、互不影響對方的判斷依據，
  // 單片視圖的尺寸標註仍照 includeDimensions 決定要不要顯示（同一份 predicate，見本檔 docblock）。
  const activePathIds = activePiece ? new Set(activePiece.pathIds) : null;
  const activeTextIds = activePiece ? new Set(activePiece.textIds) : null;
  const pieceScopedPaths = activePathIds ? result.paths.filter((p) => activePathIds.has(p.id)) : result.paths;
  const pieceScopedTexts = activeTextIds ? result.texts.filter((t) => activeTextIds.has(t.id)) : result.texts;

  // 只過濾「畫什麼」，不動 bounds/viewBox——bounds 是 generate() 保證涵蓋全部路徑的權威範圍
  // （見 core/types.ts 的 bounds-cover 不變式），隱藏標註不應該連帶讓視窗跟著縮放/位移。
  const visiblePaths = includeDimensions ? pieceScopedPaths : pieceScopedPaths.filter((p) => !DIMENSION_LINE_TYPES.has(p.type));
  const visibleTexts = includeDimensions ? pieceScopedTexts : [];

  return (
    <div className="relative flex-1 h-full bg-white overflow-hidden">
      {invariantWarnings.length > 0 && (
        <div className="absolute top-0 left-0 right-0 z-20 bg-red-50 text-red-700 text-sm px-4 py-2 space-y-0.5 border-b border-red-300">
          {invariantWarnings.map((w, i) => (
            <div key={i}>{w.message.zh}</div>
          ))}
        </div>
      )}

      {result.pieces !== undefined && (
        <div className="absolute top-4 left-4 z-10 flex items-center gap-1 opacity-90 hover:opacity-100 transition-opacity">
          <button
            type="button"
            aria-pressed={activePiece === undefined}
            onClick={() => onSelectPiece?.(null)}
            className={switcherButtonClass(activePiece === undefined)}
          >
            全版
          </button>
          {result.pieces.map((piece) => (
            <button
              key={piece.id}
              type="button"
              aria-pressed={activePiece?.id === piece.id}
              onClick={() => onSelectPiece?.(piece.id)}
              className={switcherButtonClass(activePiece?.id === piece.id)}
            >
              {piece.label.zh}
            </button>
          ))}
        </div>
      )}

      <div className="absolute top-4 right-4 z-10 flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s * 0.9))}
          className="px-2 py-1 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50 shadow-sm text-xs"
        >
          －
        </button>
        <div className="px-2 py-1 bg-white border-y border-zinc-200 text-xs font-mono text-zinc-600 min-w-[48px] text-center">
          {Math.round(scale * 100)}%
        </div>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.1))}
          className="px-2 py-1 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50 shadow-sm text-xs"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={handleFit}
          className="ml-1 px-2 py-1 bg-white border border-zinc-200 text-zinc-600 hover:bg-zinc-50 shadow-sm text-xs"
        >
          Fit
        </button>
      </div>

      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
      >
        <svg
          width={viewW}
          height={viewH}
          viewBox={`${minX} ${minY} ${viewW} ${viewH}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
          className="overflow-visible"
        >
          {visiblePaths.map((p) => {
            const style = LINE_STYLES[p.type];
            const highlighted = isHighlighted(p.tags);
            const d = segmentsToSvgD(p.segments);
            return (
              <g key={p.id}>
                {highlighted && (
                  <path
                    d={d}
                    fill="none"
                    stroke={HIGHLIGHT_STROKE}
                    strokeWidth={style.strokeWidth * HIGHLIGHT_WIDTH_FACTOR}
                    opacity={HIGHLIGHT_OPACITY}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <path
                  d={d}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.dasharray}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {visibleTexts.map((t) => (
            <text
              key={t.id}
              x={t.x}
              y={t.y}
              fontSize={t.fontSize ?? 3}
              textAnchor={t.anchor ?? 'start'}
              transform={t.rotation ? `rotate(${t.rotation} ${t.x} ${t.y})` : undefined}
              fill={DIMENSION_TEXT_FILL}
            >
              {t.text}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
