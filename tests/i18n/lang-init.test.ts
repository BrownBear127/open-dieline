import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
  vi.resetModules();
});

describe('language store initialization', () => {
  it('defaults to English when storage is empty', async () => {
    const { getLang } = await import('@/i18n/lang');

    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('falls back to English when storage contains an invalid language', async () => {
    localStorage.setItem('od.lang', 'ja');

    const { getLang } = await import('@/i18n/lang');

    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('restores a persisted valid language before render', async () => {
    localStorage.setItem('od.lang', 'zh');

    const { getLang } = await import('@/i18n/lang');

    expect(getLang()).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
  });
});
