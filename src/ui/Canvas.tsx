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
 * 生成側圖層可見性（Slice 3 gate round 1 T2，取代舊 `includeDimensions` prop）：每個 path
 * 渲染前先查 `layers.generatedVisible[layerKeyForLineType(p.type)]`，texts 則查
 * `generatedVisible.dimensions`（v1 texts 全部來自標註，見 `overlay/layers.ts` 該函式文件）。
 * 這個過濾只決定「畫不畫」，不影響 `activeBounds`/`computeFitScale`/`highlightSet`——
 * invariant 警告高亮、hover、fit/bounds 邏輯完全不讀圖層可見性，所以某個線型被隱藏時，
 * 即使它剛好是目前高亮的目標，也只是「畫布上看不到那個高亮」，不會連帶影響 fit 或 viewBox
 * 跟著重算（可接受的行為，plan 裁決：生成層可見性純顯示層級的開關，不是幾何層級的變更）。
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
import type { FormEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { Bounds } from '@/core/geometry';
import type { DielinePiece, GenerateResult, LocalizedText } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';
import { OVERLAY_STROKE, calibrateScale, findNearestOverlaySegment } from '@/overlay/state';
import { initialLayersState, layerKeyForLineType, updateOverlayLayer } from '@/overlay/layers';
import type { LayersState } from '@/overlay/layers';

export interface CanvasProps {
  result: GenerateResult;
  highlightTags: string[] | null;
  invariantWarnings: { message: LocalizedText; tags?: string[] }[];
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
  /**
   * 圖層狀態（Slice 3 gate round 1 T2，取代 Task 4/5 的單一 `OverlayState`）：
   * `generatedVisible` 驅動生成側 paths/texts 過濾（見上方檔頭 docblock）；`overlays`
   * 陣列逐層 `<g transform>` 疊繪，畫在生成層之後＝視覺最上層，且刻意獨立於本檔其餘幾何
   * 邏輯：不併入 `activeBounds`/`computeFitScale`（overlay 只是對照參考，不該讓匯入的檔案
   * 把畫布 fit/viewBox 拉走）、不併入 `highlightSet`/`isHighlighted`（overlay 沒有 tags）。
   * 只有 `visible && segments.length > 0` 的層才渲染；`selectedOverlayId` 指到的那一層
   * stroke 加粗（沿用既有校準高亮的加粗樣式，作為「這層目前被選中」的視覺）。選填＋預設
   * `initialLayersState()`（全部生成層可見、無 overlay）：既有只組 `result`/`highlightTags`/
   * `invariantWarnings` 的 Canvas 單元測試不需要跟著改。
   */
  layers?: LayersState;
  /**
   * 圖層狀態更新回呼：Canvas 承接使用者在畫布上的互動並把結果寫回 `layers`——校準點選＋
   * 行內輸入（更新選中層 scale／calibrated）、選中層拖曳（T3，更新選中層 offsetX／
   * offsetY）、Esc 取消選中（T3，非校準模式，清空 selectedOverlayId）。選填＋用 `?.()`
   * 呼叫：既有不傳這個 prop 的 Canvas 單元測試（不含校準/拖曳流程）不受影響。
   */
  onLayersChange?: (next: LayersState) => void;
  /**
   * 是否處於「點選校準」互動模式（T5，spec §5）。多層模型下這個開關不是任一層的欄位
   * （`OverlayLayer`/`LayersState` 的 T1 契約皆未收錄），改由 App.tsx 提升成獨立 state，
   * 與 LayersPanel 的「校準」鈕共用同一份，維持「平行兄弟元件需要共同父層 state 才能同步」
   * 的既有理由（舊版 `OverlayState.calibrating` 就是同一個道理）。`true` 且選中層
   * `visible` 皆為 true 時（FX2，Slice 3 final review 沿用：隱藏疊圖時仍可點擊命中看不見
   * 的線段改 scale 是修前 bug，見 `handleCalibrationClick` 內的完整說明）才對選中層的線段
   * 開放點選 hit-test。選填，預設 `false`。
   */
  calibrating?: boolean;
  /** 切換／退出校準模式的回呼（LayersPanel 的「校準」鈕、Canvas 自己的 Esc／確認皆呼叫）。
   *  選填＋用 `?.()` 呼叫：既有不傳這個 prop 的 Canvas 單元測試不受影響。 */
  onCalibratingChange?: (next: boolean) => void;
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
/**
 * 校準模式 hit-test 基準容差（mm，zoom=100% 時的視覺容差，T5）：除以目前 Canvas zoom（下面
 * 的 `scale` state，CSS transform 的縮放，不要跟 `selectedLayer.scale`〔overlay 原始座標→mm
 * 的比例〕搞混）、再除以 `selectedLayer.scale`，換算成 overlay 原始座標系下的容差，維持「畫面上
 * 固定像素感」——zoom 越大，同樣的螢幕像素對應的 mm/原始座標單位越小，容差跟著縮小（可以
 * 點得更精準），反之亦然。這也是為什麼校準模式刻意不停用縮放：使用者可以先放大畫面再點選，
 * 換取更精細的 hit-test 容差。
 */
const CALIBRATION_THRESHOLD_MM = 3;
/**
 * 校準模式「拖曳結束誤觸點選」guard 門檻（螢幕像素，review finding F1）：native browser 的
 * click 事件只要 mousedown／mouseup 落在同一元素，不論中間游標移動多遠都會 fire——這是 DOM
 * 規格既定行為，不是這裡的 bug。校準模式刻意不停用 pan/zoom（見上方 CALIBRATION_THRESHOLD_MM
 * 註解），使用者放開 pan 手勢的滑鼠位置若剛好落在某段 overlay 線的 hit-test 容差內，沒有這層
 * guard 就會被誤判成一次有意義的點選、靜默選中錯誤的線段（無任何錯誤提示）。這個門檻量的是
 * 「滑鼠移動了多少螢幕像素」，跟 CALIBRATION_THRESHOLD_MM（量「點多準」的 mm 容差、且隨畫布
 * zoom 換算）是完全不同的兩件事，故意各自獨立成常數：拖曳判定應與 zoom 無關（螢幕上移動 4px
 * 就是移動 4px，不因目前縮放多少而改變「這是不是一次拖曳」的判斷）。
 */
const DRAG_CLICK_THRESHOLD_PX = 4;

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
  activePiece,
  onSelectPiece,
  layers = initialLayersState(),
  onLayersChange,
  calibrating = false,
  onCalibratingChange,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // 校準模式（T5）互動狀態——刻意留在 Canvas 的 local state、不進共享的 `layers` prop：
  // 「目前選中哪一段待輸入」與「輸入框內容/錯誤訊息」只有本檔渲染提示條/高亮/表單需要，
  // 退出校準模式（見下方 useEffect）就整批歸零，沒有跨元件同步的必要（跟 `calibrating`
  // 這個「LayersPanel 與 Canvas 都要讀」的開關不同，那個才提升到 App.tsx 的獨立 state）。
  const [pickedSegmentIndex, setPickedSegmentIndex] = useState<number | null>(null);
  const [calibrationInput, setCalibrationInput] = useState('');
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  // 校準模式「拖曳結束誤觸點選」guard（review F1）：記錄最近一次 mousedown 的螢幕座標
  // （e.clientX/clientY），handleCalibrationClick 用它判斷這次 click 之前是否發生過有意義的
  // 位移。用 ref 不用 state——這個值只有 click handler 內部讀取比較一次，不需要觸發重新渲染。
  // null 代表「這次 click 之前沒有觀察到 mousedown」（例如測試直接 fireEvent.click 不經過
  // mousedown/mouseup），視為非拖曳、照舊放行，既有的點選路徑不受影響。
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // T3 選中 overlay 層拖曳（校準>選中拖曳>pan 分流，見下方 canDragOverlay／handleMouseMove）：
  // 需要獨立的「是否正在拖曳 overlay」旗標，不能複用上面的 `isDragging`——那個專屬 pan，兩者
  // 同時只會有一個為 true，但仍是不同語意，共用會讓 handleMouseMove 分不清這次是哪一種拖曳。
  // `overlayDragPosRef` 也不能複用 `dragStartPosRef`：後者要在整個拖曳手勢期間保持「起點」
  // 不變（handleCalibrationClick 拿它算總位移量），這裡則需要「上一次 mousemove 的座標」
  // 隨每次 mousemove 更新，才能算出連續多次 mousemove 的逐次 delta（spec：拖曳過程 offset
  // 即時反映，v1 接受 state 每 mousemove 更新一次）。
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const overlayDragPosRef = useRef<{ x: number; y: number } | null>(null);

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

  // 校準互動 local state 歸零時機（review finding F1，2026-07-09 雙軌審查——與本檔既有
  // `DRAG_CLICK_THRESHOLD_PX` 註解裡的另一個「F1」是不同審查回合的不同 finding，僅巧合同名）：
  // 不只「退出校準模式」（calibrating→false，不論走哪條路徑——Canvas 自己的確認/Esc，或
  // LayersPanel「取消校準」鈕）要歸零，**切換選中層**（`layers.selectedOverlayId` 改變）也要
  // 無條件歸零，且拿掉原本的 `if (!calibrating)` guard。修前只依賴 `[calibrating]`＋guard：
  // 使用者在校準中途（`calibrating` 全程未變）點另一層的列名切換選中，`pickedSegmentIndex`
  // 停留在舊層的 index，若接著點擊確認，會用「新選中層」的 `segments[舊 index]` 算 scale 並
  // 寫回新選中層——這是無意義的值（兩層線段長度通常不同），index 越界時甚至靜默 no-op，
  // 使用者得不到任何錯誤提示。切層＝重新開始點選，校準模式本身不因此退出（`calibrating`
  // 不變，只是使用者要重新點一次線段）。用單一 effect 涵蓋兩種觸發點，比在每個觸發點各自
  // 手動清一次更不容易漏（見本檔開頭對 T5 local state 的說明）；不會造成畫面閃爍——
  // `calibrating` 為 false 時 JSX 本來就不渲染提示條/表單，`calibrating` 仍為 true、只是
  // 選中層換了時，使用者看到的是「已選段的輸入框」→「請重新點選」提示，這正是預期行為。
  useEffect(() => {
    setPickedSegmentIndex(null);
    setCalibrationInput('');
    setCalibrationError(null);
  }, [calibrating, layers.selectedOverlayId]);

  // Esc 退出校準模式（不改 scale，見 spec 邊界規則）：全域 keydown，不綁在特定元素上，
  // 不論使用者當下焦點在畫布本身或行內輸入框都能生效。只在 calibrating 時掛監聽，離開
  // 模式立刻移除（cleanup），避免非校準狀態下也攔截全站的 Esc 鍵。
  useEffect(() => {
    if (!calibrating) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      onCalibratingChange?.(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [calibrating, onCalibratingChange]);

  // Esc 取消選中 overlay 層（T3，非校準模式）：與上一個 effect 是兩件獨立的事——校準模式中
  // 按 Esc 該退出校準模式、選取狀態原封不動（spec「校準模式優先」的同一順位道理，上一個
  // effect 已處理），這裡明確排除 `calibrating` 為 true 的情況，避免兩個 effect 對同一次
  // 按鍵搶著處理。只在「有選中層」時掛監聽，沒有選中層時 Esc 沒有事可做，維持跟上一個
  // effect 一致的「不需要時不掛全域監聽器」原則。依賴陣列納入整個 `layers`（不只
  // `selectedOverlayId`）：handler 內要用 `...layers` 保留其餘欄位、只清空
  // selectedOverlayId 這一個欄位，若依賴陣列漏掉 `layers` 本身，拖曳中 offsetX/Y 變動
  // （layers 參照跟著換但 selectedOverlayId 未變）不會觸發這個 effect 重新掛載，closure
  // 裡的 `layers` 就會是拖曳前的舊快照，Esc 一按會把剛拖曳的位移覆蓋回舊值。
  useEffect(() => {
    if (calibrating || !layers.selectedOverlayId) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      onLayersChange?.({ ...layers, selectedOverlayId: null });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [calibrating, layers, onLayersChange]);

  // 選中層（Slice 3 gate round 1 T2）：取代舊版單體 overlay，未選中時為 undefined——下面
  // handleCalibrationClick／handleCalibrationConfirm 的 early return 沿用舊有防禦寫法
  // （`!selectedLayer` 取代 `!overlay`），「未選中時校準鈕已 disabled 故不可達」是 UI 層的
  // 第一道防線，這裡是第二道。宣告位置提前到這裡（T3）：mousedown 要在「校準 vs 拖曳
  // overlay vs pan」三條路徑之間分流，需要在定義 handleMouseDown 之前就能讀到選中層，故
  // 整段連同這則註解一起往上搬遷，邏輯本身不變（原本宣告在 highlightSet 之後、viewW/viewH
  // 之前）。
  const selectedLayer = layers.overlays.find((o) => o.id === layers.selectedOverlayId);
  // T3 拖曳分流條件（spec：選中 overlay 層＝selectedOverlayId 非 null 且該層 visible；
  // 校準模式優先於拖曳分流，校準中不拖 overlay）。刻意不額外檢查
  // `selectedLayer.segments.length`——拖曳只是更新 offsetX/offsetY 兩個數字，不像
  // hit-test 需要真的走訪 segments，spec 規格也只講 selectedOverlayId／visible 兩個條件，
  // 不無中生有加這層 gate。
  const canDragOverlay = !calibrating && !!selectedLayer && selectedLayer.visible;

  // FF2（final review round 2，2026-07-09）：選中層被隱藏（visible: true→false）時立刻清空
  // 校準表單暫存 state——刻意獨立成另一個 effect，不併入上面 T2 F1 那個無條件全清的 effect：
  // F1 的兩個觸發點（`calibrating`／`layers.selectedOverlayId` 改變）語意都是「開始新的一輪
  // 點選」，無條件清空才對；但「隱藏」與「顯示」是同一層、同一輪校準內的可見性切換，不是
  // 新的一輪——只有「藏起來」這個方向需要清空（使用者看不到線段，表單留著沒有意義，還會讓
  // 看不到線段驗證的 scale 被送出，見下方 handleCalibrationConfirm 的對稱 guard），「顯示
  // 回來」不該連帶重新清一次。若只是把 `selectedLayer?.visible` 塞進上面 F1 的依賴陣列了事，
  // 兩個方向都會無條件觸發清空——false→true 那個方向在目前實作下剛好是 no-op（顯示前 state
  // 理應已經是空的），但那是巧合、不是設計，不該把正確性建立在「反正已經是空的」這個巧合上。
  // 改用條件判斷明確表達「只有 hidden 才清」，讓 false→true 這個方向根本不執行清空動作，
  // 不依賴任何巧合。宣告位置必須在 `selectedLayer` 之後（上面）：依賴陣列裡的
  // `selectedLayer?.visible` 是在呼叫 `useEffect` 當下就同步求值的一般運算式，不是 effect
  // callback 內部才讀取的延遲值——寫在 `selectedLayer` 宣告之前會是不折不扣的 TDZ
  // ReferenceError，不只是風格問題。
  useEffect(() => {
    if (calibrating && selectedLayer && !selectedLayer.visible) {
      setPickedSegmentIndex(null);
      setCalibrationInput('');
      setCalibrationError(null);
    }
  }, [calibrating, selectedLayer?.visible]);

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      setScale((prev) => Math.min(Math.max(MIN_SCALE, prev * factor), MAX_SCALE));
    } else {
      setPan((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  };

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
    // 分流（spec「校準>選中拖曳>pan」）：canDragOverlay 已經把「校準中」排除在外（定義見
    // 上方），這裡不必重複判斷 calibrating——校準模式下必然落到 else 分支，維持既有 pan
    // 行為（校準模式中 pan 仍可用，見 CALIBRATION_THRESHOLD_MM 註解）。
    if (canDragOverlay) {
      overlayDragPosRef.current = { x: e.clientX, y: e.clientY };
      setIsDraggingOverlay(true);
    } else {
      setIsDragging(true);
    }
  };
  const handleMouseUp = () => {
    setIsDragging(false);
    setIsDraggingOverlay(false);
    overlayDragPosRef.current = null;
  };
  const handleMouseLeave = () => {
    setIsDragging(false);
    setIsDraggingOverlay(false);
    overlayDragPosRef.current = null;
  };
  /**
   * mousemove 分流：isDraggingOverlay 為 true 時更新選中層 offset，否則沿用既有 pan。用
   * if/else if（不是兩個獨立 if）明確表達兩個旗標互斥的不變式——mousedown 當下只會設定
   * 其中一個（見上方 handleMouseDown）。
   *
   * mm delta 換算（spec 明文的易錯點，容易寫錯的地方）：只除以畫布 `scale`（zoom），
   * **不除以 `selectedLayer.scale`**。原因是座標系層次——overlay 的渲染變換是
   * `<g transform="translate(offsetX offsetY) scale(overlayScale)">`（見下方渲染區塊），
   * offsetX/offsetY 是這個變換鏈「外層」的平移，是已經換算成 mm 的量（跟 `result.bounds`／
   * viewBox 同一個域），不是 overlay 原始座標系裡的量——`overlayScale` 只管「原始座標→mm」
   * 這一段轉換，跟 offset 的單位無關。螢幕像素→mm 的唯一換算比例是畫布 zoom（`scale`
   * state，CSS transform 的縮放）。這跟 `handleCalibrationClick` 換算 hit-test 容差時「先除
   * `scale` 再除 `selectedLayer.scale`」是不同的計算——那裡的終點是 overlay 原始座標系
   * （拿來跟 `segments` 原始座標比較距離），這裡的終點是 mm 座標系（拿來更新
   * offsetX/offsetY），多除一次 `selectedLayer.scale` 反而是 bug：會讓拖曳手感隨校準比例
   * 忽快忽慢，且跟滑鼠實際位移的視覺不成比例。
   */
  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const lastOverlayPos = overlayDragPosRef.current;
    if (isDraggingOverlay && selectedLayer && lastOverlayPos) {
      const dxMm = (e.clientX - lastOverlayPos.x) / scale;
      const dyMm = (e.clientY - lastOverlayPos.y) / scale;
      overlayDragPosRef.current = { x: e.clientX, y: e.clientY };
      onLayersChange?.({
        ...layers,
        overlays: updateOverlayLayer(layers.overlays, selectedLayer.id, {
          offsetX: selectedLayer.offsetX + dxMm,
          offsetY: selectedLayer.offsetY + dyMm,
        }),
      });
    } else if (isDragging) {
      setPan((prev) => ({ x: prev.x + e.movementX, y: prev.y + e.movementY }));
    }
  };

  // 高亮 tag 集合＝hover 高亮 ∪ 全部不變式警告的 tags（spec 裁決：同一機制、聯集）。
  const highlightSet = new Set<string>([...(highlightTags ?? []), ...invariantWarnings.flatMap((w) => w.tags ?? [])]);
  const isHighlighted = (tags?: string[]): boolean => (tags ?? []).some((t) => highlightSet.has(t));

  const { minX, minY, maxX, maxY } = activeBounds;
  const viewW = maxX - minX || 100;
  const viewH = maxY - minY || 100;

  /**
   * 校準模式點選 hit-test（T5）：座標鏈——滑鼠事件座標（`e.clientX/clientY`，螢幕像素）→
   * SVG viewBox 座標（mm，生成層座標系）→ overlay 原始座標系（除 scale 減 offset，即渲染
   * 變換 `translate(offset) scale(selectedLayer.scale)` 的精確反向：先撤銷平移再撤銷縮放）。
   *
   * 第一段轉換用 `getBoundingClientRect()` 取得 svg 元素目前「實際渲染」的螢幕矩形（已經
   * 包含 pan/zoom 的 CSS transform 與 flex 置中造成的位移/縮放），再用 `rect.width`／
   * `viewW` 的比例換算回 viewBox 座標——不需要另外手動重算 pan/scale/置中的幾何，瀏覽器
   * 量測到的矩形已經是最終結果。這個函式在 jsdom 測試環境下依賴呼叫端 mock
   * `getBoundingClientRect`（原生 jsdom 回傳全 0 矩形），見 tests/ui/app.test.tsx 對應
   * describe 的說明；生產環境走真實瀏覽器量測。
   */
  const handleCalibrationClick = (e: ReactMouseEvent<SVGSVGElement>): void => {
    // FX2（Slice 3 final review，防禦性雙保險之二）：`selectedLayer.visible` 也要 gate——
    // 第一道防線是 LayersPanel.tsx 的「校準」鈕在 !visible 時 disabled（擋住「一開始」進
    // 校準模式），但 `calibrating` 一旦已經是 true，使用者仍可能在校準模式中途另外把
    // 「顯示疊圖」關掉（那顆 checkbox 不因 calibrating 而 disabled）；沒有這行，hit-test 依然
    // 會命中一段畫布上根本看不見的疊圖線段，改出一個無從視覺驗證的 scale。
    if (!calibrating || !selectedLayer || !selectedLayer.visible || selectedLayer.segments.length === 0) return;
    if (pickedSegmentIndex !== null) return; // 已選定待輸入中：先確認或 Esc，點擊畫布不重新選取
    // 拖曳結束誤觸點選 guard（review F1）：native click 在 mousedown/mouseup 落在同一元素時，
    // 不管中間移動多遠都會 fire——pan 手勢放開的瞬間若剛好落在線段 hit-test 容差內，沒有這層
    // 判斷就會被誤判成使用者「特意點了這一段」。dragStartPosRef 為 null（這次 click 之前沒有
    // 觀察到 mousedown）視為非拖曳，照舊放行。
    const dragStart = dragStartPosRef.current;
    if (dragStart) {
      const movedPx = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
      if (movedPx > DRAG_CLICK_THRESHOLD_PX) return; // 視為拖曳（pan），不是一次有意義的點選
    }
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return; // 量測不到真實尺寸（如未掛載完成）：放棄本次點擊
    const svgX = ((e.clientX - rect.left) / rect.width) * viewW;
    const svgY = ((e.clientY - rect.top) / rect.height) * viewH;
    const mmX = minX + svgX;
    const mmY = minY + svgY;
    const rawX = (mmX - selectedLayer.offsetX) / selectedLayer.scale;
    const rawY = (mmY - selectedLayer.offsetY) / selectedLayer.scale;
    // 見 CALIBRATION_THRESHOLD_MM 註解：先除以畫布 zoom（螢幕像素感恆定），再除以
    // selectedLayer.scale（換算進 overlay 原始座標系，跟 rawX/rawY 同一座標系才能比較距離）。
    const thresholdRaw = CALIBRATION_THRESHOLD_MM / scale / selectedLayer.scale;
    const hit = findNearestOverlaySegment(selectedLayer.segments, { x: rawX, y: rawY }, thresholdRaw);
    if (hit) setPickedSegmentIndex(hit.index);
  };

  /** 行內輸入表單送出：≤0 不套用＋提示（停在原地讓使用者修正）；>0 套用 calibrateScale 並退出校準模式。 */
  const handleCalibrationConfirm = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    // FF2（final review round 2，2026-07-09，與 handleCalibrationClick 的 FX2 guard 對稱）：
    // 選中層在「已選段、表單開著」之後才被隱藏——上面的清空 effect 通常已經把
    // pickedSegmentIndex 歸零、表單本身也因此消失，這裡理論上不可達；保留這道 guard 當最後
    // 防線，避免任何未來繞過清空 effect 的路徑（例如 effect 執行順序被改動）仍讓「看不到
    // 線段」驗證的 scale 被寫入。
    if (!selectedLayer || !selectedLayer.visible || pickedSegmentIndex === null) return;
    const value = Number(calibrationInput);
    if (!(value > 0)) {
      setCalibrationError('請輸入大於 0 的數字');
      return;
    }
    const seg = selectedLayer.segments[pickedSegmentIndex];
    if (!seg) return; // 理論不會發生：index 來自同一份（未變動過的）segments 陣列的 hit-test 結果
    onLayersChange?.({
      ...layers,
      overlays: updateOverlayLayer(layers.overlays, selectedLayer.id, { scale: calibrateScale(seg, value), calibrated: true }),
    });
    onCalibratingChange?.(false);
  };

  // 片範圍過濾（pathIds/textIds 集合匹配，不是猜 index）：activePiece 存在時先縮到該片的成員，
  // 再疊加生成圖層可見性過濾（Slice 3 gate round 1 T2，取代舊 includeDimensions）——兩層
  // 過濾各自獨立、互不影響對方的判斷依據，單片視圖的尺寸標註仍照 generatedVisible.dimensions
  // 決定要不要顯示（同一份 predicate，見本檔開頭 docblock）。
  const activePathIds = activePiece ? new Set(activePiece.pathIds) : null;
  const activeTextIds = activePiece ? new Set(activePiece.textIds) : null;
  const pieceScopedPaths = activePathIds ? result.paths.filter((p) => activePathIds.has(p.id)) : result.paths;
  const pieceScopedTexts = activeTextIds ? result.texts.filter((t) => activeTextIds.has(t.id)) : result.texts;

  // 只過濾「畫什麼」，不動 bounds/viewBox——bounds 是 generate() 保證涵蓋全部路徑的權威範圍
  // （見 core/types.ts 的 bounds-cover 不變式），隱藏某個生成圖層不應該連帶讓視窗跟著縮放/位移。
  const visiblePaths = pieceScopedPaths.filter((p) => layers.generatedVisible[layerKeyForLineType(p.type)]);
  const visibleTexts = layers.generatedVisible.dimensions ? pieceScopedTexts : [];

  return (
    <div className="relative flex-1 h-full bg-white overflow-hidden">
      {invariantWarnings.length > 0 && (
        <div className="absolute top-0 left-0 right-0 z-20 bg-red-50 text-red-700 text-sm px-4 py-2 space-y-0.5 border-b border-red-300">
          {invariantWarnings.map((w, i) => (
            <div key={i}>{w.message.zh}</div>
          ))}
        </div>
      )}

      {/* 校準模式提示條（T5）：z-30 高於上面的不變式警告條（z-20）——校準是使用者主動進入的
          互動模式，視覺優先權蓋過被動的背景幾何警告，兩者同時出現的機率低且 spec 未特別
          規範，此處採最簡單的固定 z-index 分層，不做動態疊放位移計算。 */}
      {calibrating && (
        <div className="absolute top-0 left-0 right-0 z-30 bg-blue-50 text-blue-800 text-sm px-4 py-2 border-b border-blue-300 flex items-center gap-3">
          {pickedSegmentIndex === null ? (
            <span>點選 overlay 上一段已知長度的線（Esc 取消校準）</span>
          ) : (
            <form onSubmit={handleCalibrationConfirm} className="flex items-center gap-2 flex-wrap">
              <label htmlFor="calibration-mm-input">該線段實際長度：</label>
              <input
                id="calibration-mm-input"
                type="number"
                step="any"
                autoFocus
                value={calibrationInput}
                onChange={(e) => {
                  setCalibrationInput(e.target.value);
                  setCalibrationError(null);
                }}
                className="w-24 border border-blue-300 rounded-sm px-1.5 py-0.5 text-right font-mono focus:outline-none focus:border-blue-600"
              />
              <span>mm</span>
              <button type="submit" className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded-sm hover:bg-blue-700 transition-colors">
                確認
              </button>
              {calibrationError && <span className="text-red-600">{calibrationError}</span>}
            </form>
          )}
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
        // 游標分流（T3 新增 cursor-move 分支）：校準模式十字準星（spec UI 規格；pan/zoom
        // 互動本身不停用，見 CALIBRATION_THRESHOLD_MM 註解）＞可拖曳選中層時 move（跟預設
        // pan 的 grab/grabbing 區分開，提示「這裡拖的是選中疊圖層，不是畫布本身」）＞其餘
        // 情況維持既有 pan 的 grab/grabbing。
        className={`w-full h-full flex items-center justify-center select-none ${
          calibrating ? 'cursor-crosshair' : canDragOverlay ? 'cursor-move' : 'cursor-grab active:cursor-grabbing'
        }`}
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
          onClick={handleCalibrationClick}
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
          {layers.overlays
            .filter((o) => o.visible && o.segments.length > 0)
            .map((o) => {
              const isSelected = o.id === layers.selectedOverlayId;
              return (
                // 疊圖獨立圖層：一個 <g transform> 套 scale+offset（不逐段換算，見 overlay/state.ts
                // docblock 的座標套用順序：先 scale 再平移）。全段固定 OVERLAY_STROKE，線寬沿用
                // LINE_STYLES.cut（生成層最常見的結構線寬，spec「線寬同生成層」的具體取值——
                // overlay 的原始 Segment[] 沒有 LineType 可對應，取單一代表值而非逐段猜測型別）。
                // 選中層 stroke 加粗（Slice 3 gate round 1 T2，spec「選中層 stroke 加粗」）：
                // 沿用既有校準高亮的寬度倍率常數（HIGHLIGHT_WIDTH_FACTOR），但顏色仍是
                // OVERLAY_STROKE 洋紅——這是「這層目前被選中」的視覺，跟下面「校準模式選中段」
                // 的橘色高亮是兩件不同的事（一個標記整層、一個標記層內某一段），因此不共用
                // HIGHLIGHT_STROKE 顏色，避免使用者混淆兩種不同語意的加粗。
                <g key={o.id} transform={`translate(${o.offsetX} ${o.offsetY}) scale(${o.scale})`}>
                  <path
                    d={segmentsToSvgD(o.segments)}
                    fill="none"
                    stroke={OVERLAY_STROKE}
                    strokeWidth={isSelected ? LINE_STYLES.cut.strokeWidth * HIGHLIGHT_WIDTH_FACTOR : LINE_STYLES.cut.strokeWidth}
                    strokeOpacity={o.opacity}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* 校準模式選中段高亮（T5，spec「選中段高亮＝加粗」）：沿用既有 hover 高亮的
                      橘色/寬度倍率常數，維持全站「這個東西目前被選定」的視覺語彙一致。校準對象
                      恆為選中層，故只在 `isSelected` 這一筆渲染這段高亮。 */}
                  {calibrating && isSelected && pickedSegmentIndex !== null && o.segments[pickedSegmentIndex] && (
                    <path
                      d={segmentsToSvgD([o.segments[pickedSegmentIndex]])}
                      fill="none"
                      stroke={HIGHLIGHT_STROKE}
                      strokeWidth={LINE_STYLES.cut.strokeWidth * HIGHLIGHT_WIDTH_FACTOR}
                      opacity={HIGHLIGHT_OPACITY}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              );
            })}
        </svg>
      </div>
    </div>
  );
}
