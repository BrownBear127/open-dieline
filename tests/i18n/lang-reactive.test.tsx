import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dict } from '@/i18n/dict';
import { getLang, LANG_STORAGE_KEY, setLang } from '@/i18n/lang';
import { App } from '@/ui/App';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
  setLang('en');
});

afterEach(() => {
  cleanup();
  setLang('en');
  localStorage.clear();
});

describe('reactive language store', () => {
  it('persists Chinese, synchronizes html lang, and rerenders the App tree', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: dict['mode.design'].en })).toBeInTheDocument();

    act(() => setLang('zh'));

    expect(getLang()).toBe('zh');
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
    expect(screen.getByRole('button', { name: dict['mode.design'].zh })).toBeInTheDocument();
  });
});
