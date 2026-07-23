import { useEffect, useState } from 'react';

/**
 * dev-only 建置信標：右下角顯示「此分頁實際載入中的 commit hash＋載入時刻」。
 *
 * 語意（stale 偵測的關鍵）：hash 只在「分頁真的拿到新程式碼」的兩個時點更新——
 * 頁面載入、HMR 套用完成（vite:afterUpdate）。HMR 斷線的分頁不會再收到事件，
 * 信標會凍在舊值，與 repo HEAD 一比即知 stale；反之信標跟上 HEAD 就排除 stale。
 * 刻意不做定時輪詢：輪詢會在分頁跑舊碼時顯示新 hash，語意反轉。
 *
 * 僅 dev 生效（App 以 import.meta.env.DEV 條件掛載；production build 樹搖移除，
 * 不佔主 bundle 預算）。
 */
export function DevBuildBeacon() {
  const [label, setLabel] = useState('…');

  useEffect(() => {
    let alive = true;
    const stamp = async () => {
      try {
        const res = await fetch('/__build-id', { cache: 'no-store' });
        const { hash } = (await res.json()) as { hash: string };
        if (!alive) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        setLabel(`${hash} · ${hh}:${mm}`);
      } catch {
        if (alive) setLabel('×');
      }
    };
    void stamp();
    if (import.meta.hot) {
      import.meta.hot.on('vite:afterUpdate', stamp);
    }
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      data-testid="dev-build-beacon"
      style={{
        position: 'fixed',
        right: 6,
        bottom: 4,
        zIndex: 9999,
        pointerEvents: 'none',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10,
        lineHeight: 1,
        color: '#71717a',
        background: 'rgba(255,255,255,0.7)',
        padding: '2px 4px',
        borderRadius: 3,
      }}
    >
      {label}
    </div>
  );
}
