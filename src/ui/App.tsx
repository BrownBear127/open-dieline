/**
 * App：整體佈局（左 320px 淺色參數欄＋右畫布）與資料流拼接。
 *
 * 資料流（spec §3.2）：ParamPanel（schema 生成）→ useParams 的 values →
 * mod.generate(values) → GenerateResult → Canvas 渲染 + ExportBar 匯出；
 * values 或 result 變動時重新跑全部 `mod.invariants`，not-ok 的收集成
 * `invariantWarnings` 往下傳給 Canvas（畫警告條＋高亮 tags）。
 *
 * `includeDimensions`（T9 樣張 gate 第二輪法蘭反饋修復 3）：state 提升到這裡（原本只活在
 * ExportBar 內部），同時傳給 Canvas（控制畫布是否畫尺寸標註）與 ExportBar（控制下載內容、
 * 也是 checkbox 顯示值的來源），兩處視覺才會同步——法蘭實測發現取消勾選只影響下載的 SVG，
 * 畫布仍照樣顯示標註，就是因為這顆 state 原本沒有被畫布看到。
 *
 * `selectedPieceId`（Slice 2 Task 6，spec §4.2）：多片盒型（如天地盒）的全版／單片視圖切換，
 * 跟 `includeDimensions` 同一個提升理由——Canvas（渲染哪些 paths/texts＋viewBox 用哪片
 * bounds）與 ExportBar（匯出哪些內容＋單片檔名）是平行的兄弟元件，兩者都需要知道「目前選定
 * 哪一片」，狀態只能放在共同的父層才能同步。這裡只存原始的 `string | null`（null＝全版），
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
 */
import { useEffect, useMemo, useState } from 'react';
import { listBoxes } from '@/core/registry';
// side-effect import：觸發 RTE 於模組載入時自我註冊（registry.ts 的 registerBox）。
// 沒有這行 listBoxes() 恆為空、整個 App 沒有盒型可渲染——registry.ts 的設計是
// UI 透過 listBoxes()/getBox() 消費盒型資料，不直接 import 各盒型模組讀取其內容，
// 但「觸發註冊」仍需要某處的 side-effect import，App 作為組裝根是合理的落點
// （Slice 2 新增 boxes/telescope.ts 時，只需在這裡多加一行 import）。
import '@/boxes/reverse-tuck-end';
import '@/boxes/telescope';
import type { LocalizedText } from '@/core/types';
import { useParams } from '@/ui/useParams';
import { ParamPanel } from '@/ui/ParamPanel';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';
import { AnnouncementModal, isAnnouncementDismissed } from '@/ui/AnnouncementModal';

export function App() {
  const boxes = useMemo(() => listBoxes(), []);
  // boxes[0] 保證存在：上方 side-effect import 讓 RTE 恆註冊，v1 registry 不會是空的。
  const [boxId, setBoxId] = useState<string>(() => boxes[0]!.meta.id);
  const { mod, values, overriddenKeys, setValue, resetOne, reset } = useParams(boxId);
  const [highlightTags, setHighlightTags] = useState<string[] | null>(null);
  const [includeDimensions, setIncludeDimensions] = useState(true);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  // v0.2.0 宣告視窗：跟 includeDimensions/selectedPieceId 同一個提升理由——header 的
  // 「關於」鈕與 modal 本體是平行的兄弟位置（一個在 aside 頂部，一個要蓋在整個畫面上），
  // 只能靠共同父層的 state 同步開關。惰性初始值只在掛載當下讀一次 localStorage：
  // 首次訪問（未關過）預設開啟，關過的訪客重新整理後不會再自動彈出。
  const [announcementOpen, setAnnouncementOpen] = useState(() => !isAnnouncementDismissed());

  const result = useMemo(() => mod.generate(values), [mod, values]);

  // 從 selectedPieceId 解出實際的 piece 物件，含「找不到就視為全版」防呆——涵蓋兩種情況：
  // ①使用者從未選片（selectedPieceId===null）②選定的片因為參數變動而消失（如天地盒
  // linerEnabled 關閉導致 'liner' 片不再存在於新的 result.pieces）。只在這裡解一次，Canvas
  // 與 ExportBar 收到的都是同一個已經防呆過的值。
  const activePiece = useMemo(
    () => (selectedPieceId ? result.pieces?.find((p) => p.id === selectedPieceId) : undefined),
    [result, selectedPieceId],
  );

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

        <ExportBar
          boxId={boxId}
          values={values}
          result={result}
          includeDimensions={includeDimensions}
          onIncludeDimensionsChange={setIncludeDimensions}
          activePiece={activePiece}
        />
      </aside>

      <main className="flex-1 flex">
        <Canvas
          result={result}
          highlightTags={highlightTags}
          invariantWarnings={invariantWarnings}
          includeDimensions={includeDimensions}
          activePiece={activePiece}
          onSelectPiece={setSelectedPieceId}
        />
      </main>

      <AnnouncementModal open={announcementOpen} onClose={() => setAnnouncementOpen(false)} />
    </div>
  );
}
