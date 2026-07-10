/**
 * App：整體佈局（左 320px 淺色參數欄＋右畫布）與資料流拼接。
 *
 * 資料流（spec §3.2）：ParamPanel（schema 生成）→ useParams 的 values →
 * mod.generate(values) → GenerateResult → Canvas 渲染 + ExportBar 匯出；
 * values 或 result 變動時重新跑全部 `mod.invariants`，not-ok 的收集成
 * `invariantWarnings` 往下傳給 Canvas（畫警告條＋高亮 tags）。
 *
 * `includeDimensions`（T9 樣張 gate 第二輪驗收反饋修復 3，已於 Slice 3 gate round 1 T2 退役）：
 * 曾經 state 提升到這裡（原本只活在 ExportBar 內部），同時傳給 Canvas（控制畫布是否畫尺寸
 * 標註）與 ExportBar（控制下載內容、也是 checkbox 顯示值的來源），兩處視覺才會同步——維護者
 * 實測發現取消勾選只影響下載的 SVG，畫布仍照樣顯示標註，就是因為這顆 state 原本沒有被畫布
 * 看到。這顆 state 本身已不存在：尺寸標註的畫布顯示開關現在是 `layersState.generatedVisible.
 * dimensions`（見下方「layersState」段），匯出則恆全量、不再讀任何可見性 state（plan 裁決）。
 *
 * `selectedPieceId`（Slice 2 Task 6，spec §4.2）：多片盒型（如天地盒）的全版／單片視圖切換，
 * 跟 `layersState`/`calibrating`（見下方）同一個提升理由——Canvas（渲染哪些 paths/texts＋
 * viewBox 用哪片 bounds）與 ExportBar（匯出哪些內容＋單片檔名）是平行的兄弟元件，兩者都需要
 * 知道「目前選定哪一片」，狀態只能放在共同的父層才能同步。這裡只存原始的 `string | null`（null＝全版），
 * 實際的 `DielinePiece` 物件由下面的 `activePiece`（含「找不到就視為全版」防呆）統一解出，
 * Canvas／ExportBar 兩邊都吃同一個已解好的值，不必各自重複查找邏輯。切換盒型（`boxId` 變動）
 * 時同步重置回全版（見 box-select 的 onChange），避免殘留 pieceId 指向新盒型不存在的片。
 *
 * 佈局與配色為淺色工程風（T9 樣張 gate 驗收後改判：spec D8／task-8-brief 當時
 * 明文寫「深色工程風」並刻意不採前身實際配色，但驗收發現深色畫布會讓刀模行業
 * 慣例色 cut=`#000000`〔`core/styles.ts` LINE_STYLES，不可改〕完全隱形——整個
 * 盒型輪廓在深色底上消失。改回前身 `Packaging/index.tsx` 實際使用的淺色
 * zinc-50/white 主題，讓黑色 cut 線在白底畫布上清楚可見；前身移植的流程/互動
 * 手感〔pan/zoom、分組、hover 高亮〕不受影響，僅呈現層色票改動）。
 *
 * `layersState`（Slice 3 gate round 1 T2，取代 Task 4/5 的 `overlayState`/`includeDimensions`）：
 * 生成 4 層可見性＋使用者匯入的多份疊圖圖層，跟 `selectedPieceId` 同一個提升理由——
 * LayersPanel（控制項）與 Canvas（分桶渲染／疊繪／校準 hit-test）是平行兄弟元件，只有
 * 共同父層的 state 才能同步。刻意不隨 `boxId` 切換而重置：overlay 的 segments 是使用者
 * 匯入檔案的自包含資料（不像 `selectedPieceId` 指向 `result.pieces` 的 id，換盒型後可能
 * 找不到對應片），沒有殘留失效參照的風險，讓使用者可以邊切換盒型邊比對同一份疊圖清單。
 * `overlayTargetBounds`（見下方 `activePiece` 之後定義）是「重新置中」鈕與新匯入層置中
 * 預設的對齊目標，用「目前畫布實際顯示的視圖範圍」（單片視圖用該片 bounds、全版用
 * `result.bounds`，皆排除尺寸標註外擴），跟 Canvas 看到的是同一份資料。
 *
 * `calibrating`（校準模式開關）獨立於 `layersState` 提升：多層模型下「目前是否在校準模式」
 * 不是任一層的欄位（`OverlayLayer`/`LayersState` 的 T1 契約未收錄），是 LayersPanel 與
 * Canvas 都要讀的跨層開關，只能放共同父層——跟舊版 `overlayState.calibrating` 同一個
 * 提升理由，只是欄位搬出複合物件變成獨立 state。`overlayIdCounterRef` 用 `useRef` 遞增
 * 產生 `overlay-${n}` 形式的圖層 id（不用 `Date.now()`——確定性，方便測試與重播疊圖清單，
 * 見 `overlay/layers.ts` `createOverlayLayer` 文件的既有理由）；用 ref 而非 state 是因為
 * 計數器遞增本身不需要觸發重渲染，只有呼叫端（LayersPanel 匯入 handler）讀取當下值。
 *
 * `appMode`／`impositionState`（Slice 4 Task 4，spec F6／「組裝」段；T4 toolbar 化改版面
 * 佈局，見下）：頂部「刀模設計｜拼版估算」切換鈕決定側欄下半部與主區渲染哪一組元件——
 * `'design'` 維持原本的 LayersPanel／ExportBar／Canvas；`'imposition'` 側欄不再渲染任何
 * 拼版專屬元件（只剩上方共用的 ParamPanel／盒型選擇），主區改渲染 `ImpositionControls`
 * （橫排 toolbar，`@/ui/ImpositionView`）＋`ImpositionResults`（`@/ui/ImpositionResults`，
 * 經 `@/ui/ImpositionView` facade re-export 取用，見該檔檔頭 docblock「檔案拆分」一節）
 * 垂直堆疊——gate 驗收反饋「放在右側預覽區域上方，把紙張規格、方向、作業模式改成按鈕
 * 形式」，取代 T3 的側欄掛法。兩者與 Canvas／ExportBar 一樣共用同一個 `result`（spec
 * 「組裝」：`App` 只生成一次 `result`，不因模式切換重新計算）。`ParamPanel`與盒型選擇不隨
 * 模式隱藏（F6「組裝」列），使用者可以留在拼版模式下直接調整盒參數，兩張方向卡透過
 * `computeImpositionView`（`@/ui/ImpositionResults`）隨新的 `result` 即時重算（F6「即時性」）。
 *
 * `impositionState.pieceId` 是與 `selectedPieceId`（上方，設計模式專用）完全分離的一顆
 * state（F6「state 分離」）——兩者語意不同：拼版沒有「null＝全版」，`null` 只在 RTE 這種
 * 恆無 `pieces` 的盒型下代表「整件」，共用會讓兩種模式的選片記憶互相污染。初值與失效
 * fallback 的細節見下方宣告處的行內註解。模式往返（F6「模式往返」）：切換鈕的 `onClick`
 * 只寫 `appMode`（進拼版模式額外呼叫 `setCalibrating(false)`，F6「校準互斥」——跟
 * box-select `onChange` 直接呼叫 `setSelectedPieceId(null)` 同一種「單一明確事件、同步
 * 處理」寫法慣例，不需要 `useEffect`），不碰 `impositionState`／`boxId`／`values` 任何一項，
 * 三者合起來就是 F6 表逐欄列舉的「全部保留」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { listBoxes } from '@/core/registry';
// side-effect import：觸發 RTE 於模組載入時自我註冊（registry.ts 的 registerBox）。
// 沒有這行 listBoxes() 恆為空、整個 App 沒有盒型可渲染——registry.ts 的設計是
// UI 透過 listBoxes()/getBox() 消費盒型資料，不直接 import 各盒型模組讀取其內容，
// 但「觸發註冊」仍需要某處的 side-effect import，App 作為組裝根是合理的落點
// （Slice 2 新增 boxes/telescope.ts 時，只需在這裡多加一行 import）。
import '@/boxes/reverse-tuck-end';
import '@/boxes/telescope';
import type { LocalizedText } from '@/core/types';
import { initialLayersState } from '@/overlay/layers';
import type { LayersState } from '@/overlay/layers';
import { manufacturingBounds } from '@/export/svg';
import { useParams } from '@/ui/useParams';
import { ParamPanel } from '@/ui/ParamPanel';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';
import { LayersPanel } from '@/ui/LayersPanel';
import { AnnouncementModal, isAnnouncementDismissed } from '@/ui/AnnouncementModal';
import { ImpositionControls, ImpositionResults } from '@/ui/ImpositionView';
import type { ImpositionState } from '@/ui/ImpositionView';
import { PAPER_PRESETS, MIN_GAP_MM } from '@/core/imposition';

/** 頂部模式切換鈕的兩個狀態（Slice 4 Task 4，spec F6／「組裝」）：`'design'`＝現行的
 *  刀模設計流程（ParamPanel＋LayersPanel＋ExportBar＋Canvas）；`'imposition'`＝拼版估算
 *  （ParamPanel／盒型選擇留用＋`ImpositionControls`／`ImpositionResults`，見上方檔頭
 *  docblock「appMode／impositionState」一節的完整說明）。 */
type AppMode = 'design' | 'imposition';

/** 模式切換鈕樣式：選定＝黑底白字，未選定＝透明底＋zinc 文字——比照 `Canvas.tsx` 的
 *  `switcherButtonClass`（視圖切換鈕）同一種「選定用實心黑」配色慣例，容器另外包一層
 *  zinc-100 底做成 segmented control 觀感，跟旁邊「關於」/「重設全部」的純文字小鈕區分開
 *  （這兩顆是唯一決定側欄下半部與主區渲染內容的鈕，需要比純文字鈕更高的視覺權重）。 */
function modeButtonClass(isActive: boolean): string {
  const base = 'flex-1 px-3 py-1.5 rounded-sm text-xs font-medium transition-colors';
  return isActive ? `${base} bg-black text-white shadow-sm` : `${base} text-zinc-500 hover:text-zinc-900`;
}

export function App() {
  const boxes = useMemo(() => listBoxes(), []);
  // boxes[0] 保證存在：上方 side-effect import 讓 RTE 恆註冊，v1 registry 不會是空的。
  const [boxId, setBoxId] = useState<string>(() => boxes[0]!.meta.id);
  const { mod, values, overriddenKeys, setValue, resetOne, reset } = useParams(boxId);
  const [highlightTags, setHighlightTags] = useState<string[] | null>(null);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [layersState, setLayersState] = useState<LayersState>(() => initialLayersState());
  const [calibrating, setCalibrating] = useState(false);
  // 見上方 docblock「calibrating」段：只有 useRef 本身遞增，讀取當下值才需要呼叫這個函式，
  // 遞增這個動作不需要觸發重渲染（跟 layersState/calibrating 兩個真正驅動畫面的 state 不同）。
  const overlayIdCounterRef = useRef(0);
  const createOverlayId = (): string => {
    overlayIdCounterRef.current += 1;
    return `overlay-${overlayIdCounterRef.current}`;
  };
  // v0.2.0 宣告視窗：跟 layersState/selectedPieceId 同一個提升理由——header 的
  // 「關於」鈕與 modal 本體是平行的兄弟位置（一個在 aside 頂部，一個要蓋在整個畫面上），
  // 只能靠共同父層的 state 同步開關。惰性初始值只在掛載當下讀一次 localStorage：
  // 首次訪問（未關過）預設開啟，關過的訪客重新整理後不會再自動彈出。
  const [announcementOpen, setAnnouncementOpen] = useState(() => !isAnnouncementDismissed());
  // appMode：見上方檔頭 docblock「appMode／impositionState」段。只有頂部切換鈕的 onClick
  // 會寫這顆 state；進拼版模式那顆鈕額外呼叫 `setCalibrating(false)`（F6「校準互斥」，
  // 見下方按鈕定義）。
  const [appMode, setAppMode] = useState<AppMode>('design');

  const result = useMemo(() => mod.generate(values), [mod, values]);

  // 從 selectedPieceId 解出實際的 piece 物件，含「找不到就視為全版」防呆——涵蓋兩種情況：
  // ①使用者從未選片（selectedPieceId===null）②選定的片因為參數變動而消失（如天地盒
  // linerEnabled 關閉導致 'liner' 片不再存在於新的 result.pieces）。只在這裡解一次，Canvas
  // 與 ExportBar 收到的都是同一個已經防呆過的值。
  const activePiece = useMemo(
    () => (selectedPieceId ? result.pieces?.find((p) => p.id === selectedPieceId) : undefined),
    [result, selectedPieceId],
  );

  // 疊圖「重新置中」鈕與新匯入層置中預設的目標 bounds（Slice 3 gate round 1 T2：取代退役
  // 的快速對齊三鈕，見 LayersPanel.tsx）：跟 Canvas 目前實際顯示的視圖範圍一致（單片視圖用
  // 該片幾何、全版用整版幾何），不是 Canvas 的 activeBounds（那個為單片視圖額外烘了
  // PIECE_VIEW_PADDING 顯示邊距，是「畫布留白多少」的呈現層決定，不是「刀模實際幾何範圍」——
  // 對齊疊圖要對齊到真實幾何，不該把留白邊距也算進對齊目標）。
  //
  // FX3（Slice 3 final review）：改用 `manufacturingBounds(result, activePiece)`（見
  // `export/svg.ts`）取代原本的 `activePiece?.bounds ?? result.bounds`——不論單片或全版，
  // 後者依 spec §3.3 三向等式／`checkResultBoundsMatchesGeometry` 必須完整涵蓋含尺寸標註線
  // 在內的全部幾何，直接拿來當快速對齊目標，會讓「邊界框」等對齊模式對到標註延伸出去的
  // 外擴框，而不是實際刀模幾何（跟 `ExportBar.tsx` 的 `pieceManufacturingBounds`／FX5 是
  // 同一種「標註外擴污染尺寸判斷」問題，只是這裡的消費者是對齊而非檔名）。`activePiece`
  // 為 undefined 時 `manufacturingBounds` 對 `result.paths` 全集過濾，等同全版製造 bounds。
  const overlayTargetBounds = manufacturingBounds(result, activePiece);

  // FX5（whole-branch review）：selectedPieceId 復活 snap-back——上面的 activePiece 只是
  // 「這一輪渲染要顯示什麼」的防呆，selectedPieceId 這顆 state 本身若不清掉，之後只要
  // result.pieces 剛好又重新包含同一個 id（例如選定內襯單片視圖後關閉 linerEnabled
  // fallback 回全版、再重新打開 linerEnabled），沒有任何點擊動作就會自動跳回原本選定的
  // 單片視圖——這是 state 沒有真正歸零，不是 activePiece 算錯。用 effect、不用 render-phase
  // setState（在 component function 本體內直接呼叫 setState，如 useParams.ts 切換 boxId
  // 那種寫法）：render 期間呼叫 setState 觸發的重渲問題在 Slice 1 final review 已有前科
  // 記錄，這裡讓 render 保持純粹，state 清除挪到 commit 後非同步處理（下一輪 re-render
  // 才反映）。這與下面 box-select 用的 event-handler 同步重置（onChange callback 裡直接
  // setSelectedPieceId(null)，不是 render-phase）是兩種情境：boxId 切換有明確的單一事件
  // （select onChange）可以在事件處理常式裡同步處理，這裡的 pieces 消失可能由「任何」
  // 參數改動觸發（不只 linerEnabled），沒有單一事件掛鉤，effect 是唯一乾淨的通用做法。
  useEffect(() => {
    if (selectedPieceId !== null && !result.pieces?.some((piece) => piece.id === selectedPieceId)) {
      setSelectedPieceId(null);
    }
  }, [result.pieces, selectedPieceId]);

  // impositionState（Slice 4 Task 4，spec F6／「組裝」段，完整說明見檔頭 docblock「appMode／
  // impositionState」一節）：拼版模式的完整可往返 state，型別定義見 `ui/ImpositionView.tsx`
  // 的 `ImpositionState`。lazy initializer 只在掛載當下跑一次，讀當時的 `result.pieces`
  // 決定 `pieceId` 初值（多片盒型＝`pieces[0].id`；RTE＝`null`，F6「預設值」／「RTE」兩列）；
  // 其餘欄位的預設值刻意對齊 spec 驗收條件 1 的數值錨（31"×43"、直放、整紙、咬口 20mm、
  // gap＝`MIN_GAP_MM`）——這樣使用者第一次點進拼版模式，兩張方向卡就已經是一組有意義的
  // 估算結果（RTE 預設參數下＝12 模／8 模），不是全部空白等使用者自己填完才看得到數字。
  const [impositionState, setImpositionState] = useState<ImpositionState>(() => ({
    pieceId: result.pieces?.[0]?.id ?? null,
    paperPresetId: PAPER_PRESETS[0]!.id,
    customW: PAPER_PRESETS[0]!.w,
    customH: PAPER_PRESETS[0]!.h,
    orientation: 'portrait',
    cutV: false,
    cutH: false,
    allowRotate: true,
    gripper: 20,
    gap: MIN_GAP_MM,
  }));

  // impositionState.pieceId 的失效 fallback（F6「失效 fallback」列）：跟上面 selectedPieceId
  // 的 snap-back effect 是同一種「result.pieces 變動後自我修正」機制，但目標相反——那顆
  // effect 的職責是「發現無效就歸零成 null（全版）」，這顆的職責是「發現無效就改選
  // `pieces[0]`」（拼版沒有 null＝全版語意，F6「state 分離」列）。常駐執行、不 gate 在
  // `appMode==='imposition'` 之後：使用者可能在設計模式下切換盒型或關閉 `linerEnabled`，
  // 這顆 effect 讓 `impositionState.pieceId` 隨時保持合法，切進拼版模式當下就看到正確選片，
  // 不必再等一輪過渡態。`ImpositionView.tsx` 檔頭 docblock「件選擇與 pieceId 的 fallback
  // 生命週期」一節已經記錄：這顆 effect 生效前，T3 的 `computeImpositionView` 對無效
  // `pieceId` 是 fail loud（兩卡「—」＋整體錯誤「請選擇拼版的件」），不會拿一個猜錯的
  // fallback 幾何算出誤導數字——這顆 effect 的正確性因此只影響體驗（多快修正回合法選片），
  // 不影響安全（絕不會有一輪畫面顯示「用錯的 piece 幾何算出的拼版結果」）。
  useEffect(() => {
    const pieces = result.pieces;
    const fallbackId = pieces?.[0]?.id ?? null;
    const stillValid = pieces !== undefined && pieces.some((p) => p.id === impositionState.pieceId);
    if (!stillValid && impositionState.pieceId !== fallbackId) {
      setImpositionState((prev) => ({ ...prev, pieceId: fallbackId }));
    }
  }, [result.pieces, impositionState.pieceId]);

  const invariantWarnings = useMemo(
    () =>
      mod.invariants
        .map((inv) => inv.check(values, result))
        .filter((r): r is { ok: false; message: LocalizedText; tags?: string[] } => !r.ok),
    [mod, values, result],
  );

  return (
    <div className="flex h-screen bg-white text-zinc-900 overflow-hidden">
      <aside className="w-[320px] flex-shrink-0 flex flex-col gap-6 overflow-y-auto p-5 border-r border-zinc-200">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-900">open-dieline</h1>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAnnouncementOpen(true)}
              title="重新開啟專案介紹"
              className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-blue-600"
            >
              關於
            </button>
            <button
              type="button"
              onClick={reset}
              title="清除全部參數覆寫，回到預設值"
              className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-blue-600"
            >
              重設全部
            </button>
          </div>
        </div>

        {/* 模式切換（Slice 4 Task 4，spec「組裝」段）：見檔頭 docblock「appMode／impositionState」
            一節。進拼版模式額外退出 calibrating（F6「校準互斥」）；離開/返回設計模式沒有任何
            程式碼路徑把 calibrating 設回 true，故不會「復活」。 */}
        <div className="flex gap-1 p-1 bg-zinc-100 rounded-sm" role="group" aria-label="模式切換">
          <button
            type="button"
            onClick={() => setAppMode('design')}
            aria-pressed={appMode === 'design'}
            className={modeButtonClass(appMode === 'design')}
          >
            刀模設計
          </button>
          <button
            type="button"
            onClick={() => {
              setAppMode('imposition');
              setCalibrating(false);
            }}
            aria-pressed={appMode === 'imposition'}
            className={modeButtonClass(appMode === 'imposition')}
          >
            拼版估算
          </button>
        </div>

        <div className="flex flex-col gap-1.5 p-5 bg-zinc-50 border border-zinc-200 rounded-sm">
          <label htmlFor="box-select" className="text-[10px] uppercase tracking-wider text-zinc-400">
            盒型
          </label>
          <select
            id="box-select"
            value={boxId}
            onChange={(e) => {
              setBoxId(e.target.value);
              // 切盒型時視圖重置回全版：不同盒型的 pieces id 集合互不相干，殘留舊 selectedPieceId
              // 可能剛好對不到任何片（activePiece 防呆會擋下 crash），也可能巧合撞到新盒型裡
              // 同名的 piece id 卻渲染錯的內容——兩種情況都不是使用者切盒型時預期的行為，直接
              // 重置最單純。
              setSelectedPieceId(null);
              // 拼版件選擇同步失效（review Medium 1 fix round 1）：不能只靠下面 fallback effect
              // 的 stillValid 檢查決定——若新盒型的非首片剛好沿用舊 id（如天地盒的 'lid'；registry
              // 是公開擴充介面，未來新增的多片盒型與現有盒型撞 id 不是抽象假設），stillValid 會
              // 誤判「仍合法」而讓選擇停留在同名新片，違反 F6「切盒即第一片」。「切盒」這個事件
              // 本身在這裡同步觸發歸位：先清為 null，交給下面的 fallback effect 依新
              // `result.pieces` 收斂（多片盒型→pieces[0]；RTE→null），不依賴舊 id 巧合失效。
              setImpositionState((prev) => ({ ...prev, pieceId: null }));
            }}
            className="w-full bg-white border border-zinc-200 rounded-sm text-sm py-1.5 px-2 text-zinc-900 focus:outline-none focus:border-black transition-colors"
          >
            {boxes.map((b) => (
              <option key={b.meta.id} value={b.meta.id}>
                {b.meta.name.zh}
              </option>
            ))}
          </select>
        </div>

        <ParamPanel
          params={mod.params}
          values={values}
          overriddenKeys={overriddenKeys}
          onChange={setValue}
          onResetOne={resetOne}
          onHighlight={setHighlightTags}
        />

        {/* 拼版模式下側欄不再渲染任何拼版專屬元件（T4：`ImpositionControls` 搬到主區
            toolbar，見下方 `<main>`）——側欄只剩上方共用的 ParamPanel／盒型選擇。 */}
        {appMode === 'design' && (
          <>
            <LayersPanel
              layers={layersState}
              onLayersChange={setLayersState}
              targetBounds={overlayTargetBounds}
              result={result}
              calibrating={calibrating}
              onCalibratingChange={setCalibrating}
              createOverlayId={createOverlayId}
            />

            <ExportBar boxId={boxId} values={values} result={result} activePiece={activePiece} />
          </>
        )}
      </aside>

      <main className={appMode === 'design' ? 'flex-1 flex' : 'flex-1 flex overflow-y-auto p-6 bg-white'}>
        {appMode === 'design' ? (
          <Canvas
            result={result}
            highlightTags={highlightTags}
            invariantWarnings={invariantWarnings}
            activePiece={activePiece}
            onSelectPiece={setSelectedPieceId}
            layers={layersState}
            onLayersChange={setLayersState}
            calibrating={calibrating}
            onCalibratingChange={setCalibrating}
          />
        ) : (
          // T4：拼版模式主區改「toolbar 在上、結果卡在下」垂直堆疊，取代 T3 的側欄＋主區
          // 左右分割（gate 驗收反饋「放在右側預覽區域上方」）。
          <div className="flex-1 flex flex-col gap-4">
            <ImpositionControls result={result} state={impositionState} onChange={setImpositionState} />
            <ImpositionResults result={result} state={impositionState} />
          </div>
        )}
      </main>

      <AnnouncementModal open={announcementOpen} onClose={() => setAnnouncementOpen(false)} />
    </div>
  );
}
