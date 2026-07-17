import { fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAPER_PRESETS } from '@/ui/fold-scene';
import { createPaperDevPanel } from '@/ui/fold-paper-dev-panel';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setupPanel() {
  const host = document.createElement('section');
  document.body.append(host);
  const onLook = vi.fn();
  const onPaper = vi.fn();
  const panel = createPaperDevPanel({
    host,
    initialLook: 'plain',
    initialPaper: PAPER_PRESETS.standard,
    paperPresets: PAPER_PRESETS,
    onLook,
    onPaper,
  });
  return { host, onLook, onPaper, panel };
}

describe('paper DEV panel', () => {
  it('mounts a fixed inline-styled panel with all look, preset, and parameter controls', () => {
    const { host, panel } = setupPanel();

    expect(panel.element.parentElement).toBe(host);
    expect(panel.element.style.position).toBe('fixed');
    expect(panel.element.style.top).not.toBe('');
    expect(panel.element.style.right).not.toBe('');
    for (const label of ['plain', 'kraft', 'black', 'engineering', 'subtle', 'standard', 'coarse']) {
      expect(panel.element.querySelector(`button[data-value="${label}"]`)).not.toBeNull();
    }
    expect(panel.element.querySelectorAll('input[type="range"]')).toHaveLength(8);
    expect(panel.element.querySelector('input[type="number"][aria-label="seed"]')).not.toBeNull();
  });

  it('applies presets immediately and debounces slider regeneration by 150ms', () => {
    vi.useFakeTimers();
    const { onPaper, panel } = setupPanel();
    const subtle = panel.element.querySelector('button[data-value="subtle"]')!;
    const fiberStrength = panel.element.querySelector(
      'input[aria-label="fiberStrength"]',
    ) as HTMLInputElement;

    fireEvent.click(subtle);
    expect(onPaper).toHaveBeenCalledExactlyOnceWith(PAPER_PRESETS.subtle);
    expect(fiberStrength.value).toBe(String(PAPER_PRESETS.subtle.fiberStrength));

    onPaper.mockClear();
    fireEvent.input(fiberStrength, { target: { value: '0.4' } });
    vi.advanceTimersByTime(149);
    expect(onPaper).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPaper).toHaveBeenCalledExactlyOnceWith({
      ...PAPER_PRESETS.subtle,
      fiberStrength: 0.4,
    });
  });

  it('collapses without removing its toggle and accepts hook-driven state updates', () => {
    const { panel } = setupPanel();
    const toggle = panel.element.querySelector('button[aria-label="Toggle paper controls"]')!;
    const controls = panel.element.querySelector('[data-paper-controls]') as HTMLElement;

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(controls.hidden).toBe(true);

    panel.setLook('black');
    panel.setPaper(PAPER_PRESETS.coarse);
    expect(panel.element.querySelector('button[data-value="black"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="seed"]')!.value)
      .toBe(String(PAPER_PRESETS.coarse.seed));
  });

  it('prints and copies the current look and PaperParams JSON', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { panel } = setupPanel();

    fireEvent.click(panel.element.querySelector('button[data-value="kraft"]')!);
    fireEvent.click(panel.element.querySelector('button[data-value="coarse"]')!);
    fireEvent.click(panel.element.querySelector('button[data-action="copy"]')!);

    const json = JSON.stringify({ look: 'kraft', paper: PAPER_PRESETS.coarse }, null, 2);
    expect(consoleLog).toHaveBeenCalledExactlyOnceWith(json);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(json);
  });
});
