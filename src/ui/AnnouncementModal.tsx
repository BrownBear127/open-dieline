/**
 * AnnouncementModal：公開發布宣告視窗（維護者定稿文案，內文逐字使用，不可改寫）。
 * v0.2.0 首版；v0.3.0 上線後補測試版定位聲明、本地處理與問題回報等備注（2026-07-09
 * 維護者定稿），dismiss key 同步 bump v1→v2 讓既有訪客再看一次新內容。
 *
 * 顯示邏輯：首次訪問（localStorage 沒有 dismiss key）自動開啟；使用者透過 × 鈕／backdrop
 * 點擊／卡片底部「開始使用」關閉時都會寫入 localStorage，之後重新載入不再自動彈出。Esc
 * 視為與這三者同效的關閉手勢（一般使用者對 dialog 按 Esc 預期跟按 × 一樣「關掉且不再自動
 * 彈出」，兩套不同效果的關閉路徑反而讓人意外），因此也走同一個 `handleDismiss`。header 的
 * 「關於」鈕可在任何時候重新開啟——重開只是把 App.tsx 那顆 `announcementOpen` state
 * 暫時打開，不影響 localStorage 那個「未來要不要自動彈」的旗標（本來就已經是 dismissed，
 * 再次關閉時重寫一次同樣的值是無害的 no-op）。
 *
 * open/onClose 受控、localStorage 讀寫封裝在本檔內部：跟 App.tsx 其餘 state 提升的理由
 * 一致（見 App.tsx docblock）——「關於」鈕在 App.tsx header，modal 本體在這裡，兩處都要
 * 知道目前開關狀態，只能放共同父層；但「記住使用者關過」是這個 modal 自己的持久化細節，
 * App.tsx 不需要知道 key 長怎樣，只需要初次掛載時知道「該不該預設開啟」
 * （`isAnnouncementDismissed()`，供 App.tsx 的 `useState` 惰性初始值使用）。
 */
import { useEffect } from 'react';

export const ANNOUNCEMENT_DISMISS_KEY = 'open-dieline-announcement-v2-dismissed';

/**
 * localStorage 存取包 try/catch：Safari 隱私瀏覽等環境下 `localStorage.getItem/setItem`
 * 會直接擲錯（非回傳 null），這顆 state 又掛在 App.tsx 的 `useState` 惰性初始值裡跑在
 * render 期間——沒有防呆的話一個瀏覽器隱私設定就能讓整個 app 白屏，不只是 modal 壞掉。
 * 讀取失敗時退化成「視為未關過」（每次都顯示，最多是使用者多看一次公告，不阻斷使用）。
 */
export function isAnnouncementDismissed(): boolean {
  try {
    return localStorage.getItem(ANNOUNCEMENT_DISMISS_KEY) === 'true';
  } catch {
    return false;
  }
}

function markAnnouncementDismissed(): void {
  try {
    localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
  } catch {
    // 寫入失敗不影響本次關閉：只是下次造訪可能又會顯示一次，非致命。
  }
}

export interface AnnouncementModalProps {
  open: boolean;
  onClose: () => void;
}

export function AnnouncementModal({ open, onClose }: AnnouncementModalProps) {
  function handleDismiss(): void {
    markAnnouncementDismissed();
    onClose();
  }

  // 依賴陣列只放 `open`：`handleDismiss` 每次 render 都是新的函式參考但行為恆定（永遠是
  // 「寫 localStorage＋呼叫 onClose」），放進依賴陣列只會讓 effect 在 onClose 參考變動時
  // 也重新掛一次監聽器，沒有實質差異、徒增雜訊（同一手法見 Canvas.tsx handleFit 的
  // exhaustive-deps 註解）。
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleDismiss();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4"
      onClick={handleDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="關於 open-dieline"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[560px] max-h-[85vh] overflow-y-auto rounded-lg bg-white/95 shadow-2xl border border-zinc-200 p-6"
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="關閉"
          className="absolute right-4 top-4 text-xl leading-none text-zinc-400 hover:text-zinc-900 transition-colors"
        >
          ×
        </button>

        <div className="flex flex-col gap-4 pr-6 text-sm leading-relaxed text-zinc-700">
          <h2 className="text-lg font-bold tracking-wide text-zinc-900">
            open-dieline{' '}
            <span className="align-middle text-xs font-normal tracking-normal text-zinc-400">
              v0.5.0 開發測試版
            </span>
          </h2>

          <p>
            一個開源的印刷刀模（dieline）產生器——把包裝盒的結構知識做成可以調參數、可以列印試摺的工具。
            幾何規則以真實生產刀模逆向量測校準。
          </p>

          <p>
            目前為開發測試版，僅提供兩種盒型——反向插舌盒（RTE）與天地盒三件套（上蓋／下盒／平台式內襯），
            更多盒型陸續開發中。
          </p>

          <p>
            本專案是{' '}
            <a
              href="https://konvolut.art"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Konvolut
            </a>{' '}
            的一部分——關於書、紙、印刷與收藏的實踐。原始碼在{' '}
            <a
              href="https://github.com/BrownBear127/open-dieline"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              GitHub
            </a>
            ，文字刊於{' '}
            <a
              href="https://konvolut.substack.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Substack
            </a>
            。
          </p>

          <div className="flex flex-col gap-1.5 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
            <p className="font-bold uppercase tracking-wider text-zinc-400">使用注意</p>
            <p>・產出的刀模僅供打樣與學習參考；量產前請務必實際打樣驗證（紙材、絲向、機台都會影響成品）</p>
            <p>・紙厚補償係數以特定紙材（黑卡 0.4mm 級）的生產經驗校準，其他紙材請自行試摺調整</p>
            <p>・所有計算與檔案處理皆在瀏覽器本地完成，匯入的刀模檔不會上傳到任何伺服器</p>
            <p>・畫布拖曳與校準以滑鼠操作設計，建議使用桌面瀏覽器</p>
            <p>・非商業使用授權（PolyForm Noncommercial 1.0.0）；商業使用及問題回報請聯繫：hello@konvolut.art</p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="mt-6 w-full rounded-sm bg-zinc-900 py-2.5 text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-zinc-700"
        >
          開始使用
        </button>
      </div>
    </div>
  );
}
