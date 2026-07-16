import { useSyncExternalStore } from 'react';

export type Lang = 'en' | 'zh';

export const LANG_STORAGE_KEY = 'od.lang';

type Listener = () => void;

const listeners = new Set<Listener>();
const getServerSnapshot = (): Lang => 'en';

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh';
}

function readStoredLang(): Lang {
  if (typeof window === 'undefined') return 'en';

  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return isLang(stored) ? stored : 'en';
  } catch {
    return 'en';
  }
}

function persistLang(lang: Lang): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // storage 不可用時仍保留記憶體內狀態，避免語言切換失效。
  }
}

function syncDocumentLang(lang: Lang): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
  }
}

let currentLang = readStoredLang();
syncDocumentLang(currentLang);

export function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  if (!isLang(lang)) {
    throw new TypeError(`Unsupported language: ${String(lang)}`);
  }

  const changed = currentLang !== lang;
  currentLang = lang;
  persistLang(lang);
  syncDocumentLang(lang);

  if (changed) {
    listeners.forEach((listener) => listener());
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getServerSnapshot);
}
