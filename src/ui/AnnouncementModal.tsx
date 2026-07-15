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
import { Fragment, useEffect } from 'react';
import type { ReactNode } from 'react';
import pkg from '../../package.json';
import { t } from '@/i18n/t';

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

const ATTRIBUTION_LINKS = {
  Konvolut: 'https://konvolut.art',
  GitHub: 'https://github.com/BrownBear127/open-dieline',
  Substack: 'https://konvolut.substack.com',
} as const;

const MODAL_NOTE_KEYS = [
  'modal.note.1',
  'modal.note.2',
  'modal.note.3',
  'modal.note.4',
  'modal.note.5',
] as const;

type AttributionLabel = keyof typeof ATTRIBUTION_LINKS;

function isAttributionLabel(value: string): value is AttributionLabel {
  return value in ATTRIBUTION_LINKS;
}

function renderLineBreaks(copy: string): ReactNode {
  return copy.split('<br>').map((line, index) => (
    <Fragment key={`${index}-${line}`}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}

function renderAttribution(copy: string): ReactNode {
  return copy.split(/(Konvolut|GitHub|Substack)/).map((part, index) => {
    if (!isAttributionLabel(part)) return part;
    return (
      <a
        key={`${index}-${part}`}
        href={ATTRIBUTION_LINKS[part]}
        target="_blank"
        rel="noopener noreferrer"
      >
        {part}
      </a>
    );
  });
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
        aria-label={t('modal.aria')}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[560px] max-h-[85vh] overflow-y-auto rounded-lg bg-white/95 shadow-2xl border border-zinc-200 p-6"
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('modal.close')}
          className="btn label absolute right-4 top-4"
        >
          ×
        </button>

        <div className="pr-6">
          <h2 className="text-lg font-bold tracking-wide text-zinc-900">
            {t('modal.title')} <span className="mono">{t('modal.version', { version: pkg.version })}</span>
          </h2>
        </div>

        <div className="modal-body mt-4 flex flex-col gap-4 pr-6">
          <p>{renderLineBreaks(t('modal.body.p1'))}</p>

          <p>{t('modal.body.p2')}</p>

          <p>{renderAttribution(t('modal.body.p3'))}</p>

          <div className="flex flex-col gap-1.5 border-t pt-4">
            <p className="label">{t('modal.notes.title')}</p>
            {MODAL_NOTE_KEYS.map((key) => (
              <p key={key}>{t(key)}</p>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          className="btn label mt-6 w-full"
        >
          {t('modal.begin')}
        </button>
      </div>
    </div>
  );
}
