/**
 * Canvas：pan/zoom 畫布，渲染 GenerateResult 的線段與標註文字，並疊加 hover/不變式警告高亮。
 *
 * pan/zoom 手感邏輯（scale/pan state、滾輪縮放、拖曳平移、Fit 按鈕）移植自前身
 * `Packaging/index.tsx:100-122`（`handleFitToScreen` 手刻模式）與其下的 wheel/mouse
 * handlers（唯讀參照，見 task-8-brief.md）。Fit 的內容尺寸一律用 `result.bounds`
 * （資料層），不用 `getBBox()`/`getBoundingClientRect()` 量測畫出來的 SVG——
 * jsdom 不支援這些量測回傳真值，測試才可行；瀏覽器下語意也更正確（bounds 是
 * generate() 保證涵蓋全部路徑的權威範圍，見 core/types.ts 的 BoxInvariant「bounds-cover」）。
 *
 * 線段樣式一律查 `LINE_STYLES[p.type]`（唯一來源，見 core/styles.ts）；highlight 疊加色
 * #FF6B00 是 brief 明文的例外——UI 互動色，不是線型樣式，不放進 LINE_STYLES。T9 樣張 gate
 * 反饋後畫布底色由深轉淺（見 App.tsx 開頭註解），#FF6B00 維持原值不變：它不再是「深色調亮
 * 亮色」，而是白底畫布上與黑 cut／綠 crease／黃 halfcut／藍 dimension 四色仍保持清楚對比的
 * 高對比互動色，換底色後對比關係不受影響。
 *
 * pieces 全版／單片視圖切換（Slice 2 Task 6，spec §4.2）：`activePiece` 有值時只渲染該片的
 * paths/texts（依 `pathIds`/`textIds` 集合過濾，不是猜測 index），viewBox 改用該片 bounds
 * 外加 `PIECE_VIEW_PADDING` 邊距。這個邊距是必要的：T1 定案「多片盒型的片 bounds 不烘邊距，
 * 邊距歸 UI/匯出層」（見 progress.md Slice 2 Task 1 handoff）——對照 RTE 全版 bounds 是盒型
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
import { DIMENSION_LINE_TYPES } from '@/export/svg';
import { OVERLAY_STROKE, calibrateScale, findNearestOverlaySegment } from '@/overlay/state';
import type { OverlayState } from '@/overlay/state';

export interface CanvasProps {
  result: GenerateResult;
  highlightTags: string[] | null;
  invariantWarnings: { message: LocalizedText; tags?: string[] }[];
  /**
   * 是否顯示尺寸標註線與文字；預設 true。T9 樣張 gate 第二輪法蘭反饋修復 3：ExportBar 的
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
  /**
   * 匯入的生產刀模疊圖狀態（Slice 3 Task 4/5，spec §5）；undefined／null／`visible:false`／
   * 空 segments 皆不渲染。畫在生成層（paths/texts）之後＝視覺最上層，且刻意獨立於本檔其餘
   * 邏輯：不併入 `activeBounds`/`computeFitScale`（bounds/fit 只認生成層幾何，overlay 只是
   * 對照參考，不應該讓匯入的檔案把畫布 fit/viewBox 拉走）、不併入 `highlightSet`/`isHighlighted`
   * （overlay 沒有 tags，也不是 hover 高亮的對象）。`overlay.calibrating` 且 `overlay.visible`
   * 皆為 true 時（T5；FX2，Slice 3 final review 補上 `visible` 這個條件——修前只看
   * `calibrating`，隱藏疊圖時仍可點擊命中看不見的線段改 scale，見 `handleCalibrationClick`
   * 內的完整說明）才對 overlay 線段開放點選 hit-test，其餘時間畫布的既有 pan/zoom 互動不受
   * 影響。選填：既有只組 `result`/`highlightTags`/`invariantWarnings` 的 Canvas 單元測試不
   * 需要跟著改。
   */
  overlay?: OverlayState | null;
  /**
   * 校準完成／取消時的回呼（T5）：Canvas 承接使用者在畫布上的點選＋行內輸入互動，但
   * `OverlayState` 本身提升在 App.tsx（跟 OverlayPanel 共用同一份 state，見該檔 docblock
   * 「overlayState」段），Canvas 必須把最終結果（新 scale／退出校準模式／Esc 取消）回寫
   * 上去才會反映到畫面——與 OverlayPanel 收到的 `onOverlayStateChange` 是同一個函式（App.tsx
   * 傳同一個 `setOverlayState`），這裡只是多一個消費端。選填＋用 `?.()` 呼叫：既有不傳這個
   * prop 的 Canvas 單元測試（不含校準流程）不受影響。
   */
  onOverlayStateChange?: (next: OverlayState | null) => void;
}

const HIGHLIGHT_STROKE = '#FF6B00';
const HIGHLIGHT_OPACITY = 0.9;
const HIGHLIGHT_WIDTH_FACTOR = 3;
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;
const FIT_PADDING = 120;
/**
 * 多片盒型（天地盒等）預設縮放倍率（T7 樣張 gate 第一輪法蘭反饋修 3·2026-07-09）：
 * 法蘭實際操作發現多片盒型（全版／各單片視圖皆算）auto-fit 後的預設顯示偏小，要求
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
 * 的 `scale` state，CSS transform 的縮放，不要跟 `overlay.scale`〔overlay 原始座標→mm 的
 * 比例〕搞混）、再除以 `overlay.scale`，換算成 overlay 原始座標系下的容差，維持「畫面上
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
  includeDimensions = true,
  activePiece,
  onSelectPiece,
  overlay,
  onOverlayStateChange,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  // 校準模式（T5）互動狀態——刻意留在 Canvas 的 local state、不進共享 OverlayState：
  // 「目前選中哪一段待輸入」與「輸入框內容/錯誤訊息」只有本檔渲染提示條/高亮/表單需要，
  // 退出校準模式（見下方 useEffect）就整批歸零，沒有跨元件同步的必要（跟 calibrating／
  // calibrated 這兩個「兩個兄弟元件都要讀」的欄位不同，那兩個才需要放進 OverlayState）。
  const [pickedSegmentIndex, setPickedSegmentIndex] = useState<number | null>(null);
  const [calibrationInput, setCalibrationInput] = useState('');
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  // 校準模式「拖曳結束誤觸點選」guard（review F1）：記錄最近一次 mousedown 的螢幕座標
  // （e.clientX/clientY），handleCalibrationClick 用它判斷這次 click 之前是否發生過有意義的
  // 位移。用 ref 不用 state——這個值只有 click handler 內部讀取比較一次，不需要觸發重新渲染。
  // null 代表「這次 click 之前沒有觀察到 mousedown」（例如測試直接 fireEvent.click 不經過
  // mousedown/mouseup），視為非拖曳、照舊放行，既有的點選路徑不受影響。
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);

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

  // 校準模式結束時（不論走哪條路徑——Canvas 自己的確認/Esc，或 OverlayPanel「取消校準」鈕
  // 直接把 overlay.calibrating 切回 false）統一歸零本檔的校準互動 local state。用單一 effect
  // 涵蓋所有退出路徑，比在每個退出路徑各自手動清一次更不容易漏（見本檔開頭對 T5 local state
  // 的說明）；這裡不會造成畫面閃爍，因為下方 JSX 對校準提示條/高亮的渲染同時也守著
  // `overlay?.calibrating`，該值變 false 的同一輪渲染就會先隱藏整塊 UI，這個 effect 只是
  // 事後把殘留的 local state 打掃乾淨。
  useEffect(() => {
    if (!overlay?.calibrating) {
      setPickedSegmentIndex(null);
      setCalibrationInput('');
      setCalibrationError(null);
    }
  }, [overlay?.calibrating]);

  // Esc 退出校準模式（不改 scale，見 brief 邊界規則）：全域 keydown，不綁在特定元素上，
  // 不論使用者當下焦點在畫布本身或行內輸入框都能生效。只在 calibrating 時掛監聽，離開
  // 模式立刻移除（cleanup），避免非校準狀態下也攔截全站的 Esc 鍵。
  useEffect(() => {
    const currentOverlay = overlay;
    if (!currentOverlay?.calibrating) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      onOverlayStateChange?.({ ...currentOverlay, calibrating: false });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [overlay, onOverlayStateChange]);

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
    setIsDragging(true);
    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
  };
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);
  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isDragging) {
      setPan((prev) => ({ x: prev.x + e.movementX, y: prev.y + e.movementY }));
    }
  };

  // 高亮 tag 集合＝hover 高亮 ∪ 全部不變式警告的 tags（brief 裁決：同一機制、聯集）。
  const highlightSet = new Set<string>([...(highlightTags ?? []), ...invariantWarnings.flatMap((w) => w.tags ?? [])]);
  const isHighlighted = (tags?: string[]): boolean => (tags ?? []).some((t) => highlightSet.has(t));

  const { minX, minY, maxX, maxY } = activeBounds;
  const viewW = maxX - minX || 100;
  const viewH = maxY - minY || 100;

  /**
   * 校準模式點選 hit-test（T5）：座標鏈——滑鼠事件座標（`e.clientX/clientY`，螢幕像素）→
   * SVG viewBox 座標（mm，生成層座標系）→ overlay 原始座標系（除 scale 減 offset，即渲染
   * 變換 `translate(offset) scale(overlay.scale)` 的精確反向：先撤銷平移再撤銷縮放）。
   *
   * 第一段轉換用 `getBoundingClientRect()` 取得 svg 元素目前「實際渲染」的螢幕矩形（已經
   * 包含 pan/zoom 的 CSS transform 與 flex 置中造成的位移/縮放），再用 `rect.width`／
   * `viewW` 的比例換算回 viewBox 座標——不需要另外手動重算 pan/scale/置中的幾何，瀏覽器
   * 量測到的矩形已經是最終結果。這個函式在 jsdom 測試環境下依賴呼叫端 mock
   * `getBoundingClientRect`（原生 jsdom 回傳全 0 矩形），見 tests/ui/app.test.tsx 對應
   * describe 的說明；生產環境走真實瀏覽器量測。
   */
  const handleCalibrationClick = (e: ReactMouseEvent<SVGSVGElement>): void => {
    // FX2（Slice 3 final review，防禦性雙保險之二）：`overlay.visible` 也要 gate——第一道
    // 防線是 OverlayPanel.tsx 的「校準」鈕在 !visible 時 disabled（擋住「一開始」進校準模式），
    // 但 `overlayState.calibrating` 一旦已經是 true，使用者仍可能在校準模式中途另外把
    // 「顯示疊圖」關掉（那顆 checkbox 不因 calibrating 而 disabled）；沒有這行，hit-test 依然
    // 會命中一段畫布上根本看不見的疊圖線段，改出一個無從視覺驗證的 scale。
    if (!overlay?.calibrating || !overlay.visible || overlay.segments.length === 0) return;
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
    const rawX = (mmX - overlay.offsetX) / overlay.scale;
    const rawY = (mmY - overlay.offsetY) / overlay.scale;
    // 見 CALIBRATION_THRESHOLD_MM 註解：先除以畫布 zoom（螢幕像素感恆定），再除以
    // overlay.scale（換算進 overlay 原始座標系，跟 rawX/rawY 同一座標系才能比較距離）。
    const thresholdRaw = CALIBRATION_THRESHOLD_MM / scale / overlay.scale;
    const hit = findNearestOverlaySegment(overlay.segments, { x: rawX, y: rawY }, thresholdRaw);
    if (hit) setPickedSegmentIndex(hit.index);
  };

  /** 行內輸入表單送出：≤0 不套用＋提示（停在原地讓使用者修正）；>0 套用 calibrateScale 並退出校準模式。 */
  const handleCalibrationConfirm = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!overlay || pickedSegmentIndex === null) return;
    const value = Number(calibrationInput);
    if (!(value > 0)) {
      setCalibrationError('請輸入大於 0 的數字');
      return;
    }
    const seg = overlay.segments[pickedSegmentIndex];
    if (!seg) return; // 理論不會發生：index 來自同一份（未變動過的）segments 陣列的 hit-test 結果
    onOverlayStateChange?.({ ...overlay, scale: calibrateScale(seg, value), calibrating: false, calibrated: true });
  };

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

      {/* 校準模式提示條（T5）：z-30 高於上面的不變式警告條（z-20）——校準是使用者主動進入的
          互動模式，視覺優先權蓋過被動的背景幾何警告，兩者同時出現的機率低且 brief 未特別
          規範，此處採最簡單的固定 z-index 分層，不做動態疊放位移計算。 */}
      {overlay && overlay.calibrating && (
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
        // 校準模式游標改十字準星（brief UI 規格）；pan/zoom 互動本身不停用（見
        // CALIBRATION_THRESHOLD_MM 註解：容差隨 zoom 換算，使用者可以放大畫面換取更精準的點選）。
        className={`w-full h-full flex items-center justify-center select-none ${
          overlay?.calibrating ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
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
          {overlay && overlay.visible && overlay.segments.length > 0 && (
            // 疊圖獨立圖層：一個 <g transform> 套 scale+offset（不逐段換算，見 overlay/state.ts
            // docblock 的座標套用順序：先 scale 再平移）。全段固定 OVERLAY_STROKE，線寬沿用
            // LINE_STYLES.cut（生成層最常見的結構線寬，brief「線寬同生成層」的具體取值——
            // overlay 的原始 Segment[] 沒有 LineType 可對應，取單一代表值而非逐段猜測型別）。
            <g transform={`translate(${overlay.offsetX} ${overlay.offsetY}) scale(${overlay.scale})`}>
              <path
                d={segmentsToSvgD(overlay.segments)}
                fill="none"
                stroke={OVERLAY_STROKE}
                strokeWidth={LINE_STYLES.cut.strokeWidth}
                strokeOpacity={overlay.opacity}
                vectorEffect="non-scaling-stroke"
              />
              {/* 校準模式選中段高亮（T5，brief「選中段高亮＝加粗」）：沿用既有 hover 高亮的
                  橘色/寬度倍率常數，維持全站「這個東西目前被選定」的視覺語彙一致。 */}
              {overlay.calibrating && pickedSegmentIndex !== null && overlay.segments[pickedSegmentIndex] && (
                <path
                  d={segmentsToSvgD([overlay.segments[pickedSegmentIndex]])}
                  fill="none"
                  stroke={HIGHLIGHT_STROKE}
                  strokeWidth={LINE_STYLES.cut.strokeWidth * HIGHLIGHT_WIDTH_FACTOR}
                  opacity={HIGHLIGHT_OPACITY}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
