import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { dict } from '@/i18n/dict';
import { LANG_STORAGE_KEY, setLang } from '@/i18n/lang';
import { App } from '@/ui/App';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';

const [LANG_EN, LANG_ZH] = dict['chrome.lang'].en.split(' · ') as [string, string];
const ENUM_PARAM = reverseTuckEnd.params.find((param) => param.unit === 'enum')!;
const ENUM_OPTION = ENUM_PARAM.options![0]!;

function expectActiveLanguage(label: string): void {
  const button = screen.getByRole('button', { name: label });
  expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(within(button).getByText(label, { selector: 'b' })).toBeInTheDocument();
}

beforeEach(() => {
  setLang('en');
  localStorage.clear();
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
});

afterEach(() => {
  cleanup();
  setLang('en');
  localStorage.clear();
});

describe('A14 language switcher', () => {
  it('defaults to English when storage is empty', () => {
    const { container } = render(<App />);

    expect(document.documentElement.lang).toBe('en');
    expectActiveLanguage(LANG_EN);
    expect(container.querySelector('.app')).not.toHaveClass('zh');
  });

  it('switches all chrome and schema copy to Chinese and persists the selection', () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: LANG_ZH }));

    expect(screen.getByRole('button', { name: dict['mode.design'].zh })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: ENUM_OPTION.label.zh })).toBeInTheDocument();
    expectActiveLanguage(LANG_ZH);
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
    expect(container.querySelector('.app')).toHaveClass('zh');
  });

  it('switches all chrome and schema copy back to English', () => {
    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: LANG_ZH }));
    fireEvent.click(screen.getByRole('button', { name: LANG_EN }));

    expect(screen.getByRole('button', { name: dict['mode.design'].en })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: dict['mode.design'].zh })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: ENUM_OPTION.label.en })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: ENUM_OPTION.label.zh })).not.toBeInTheDocument();
    expectActiveLanguage(LANG_EN);
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(container.querySelector('.app')).not.toHaveClass('zh');
  });

  it('preserves a stored Chinese selection across App remounts', () => {
    setLang('zh');
    const firstMount = render(<App />);
    firstMount.unmount();

    const { container } = render(<App />);

    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('zh');
    expect(document.documentElement.lang).toBe('zh');
    expect(screen.getByRole('button', { name: dict['mode.design'].zh })).toBeInTheDocument();
    expectActiveLanguage(LANG_ZH);
    expect(container.querySelector('.app')).toHaveClass('zh');
  });

  it('falls back to English when storage contains an invalid language', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'fr');
    const { container } = render(<App />);

    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('button', { name: dict['mode.design'].en })).toBeInTheDocument();
    expectActiveLanguage(LANG_EN);
    expect(container.querySelector('.app')).not.toHaveClass('zh');
  });
});
