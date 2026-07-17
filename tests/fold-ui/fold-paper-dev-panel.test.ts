import { fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLD_LOOK_PRESETS, PAPER_PRESETS } from '@/ui/fold-scene';
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
  const onLookParams = vi.fn();
  const onPaper = vi.fn();
  const panel = createPaperDevPanel({
    host,
    initialLook: 'plain',
    lookPresets: FOLD_LOOK_PRESETS,
    initialPaper: PAPER_PRESETS.standard,
    paperPresets: PAPER_PRESETS,
    onLook,
    onLookParams,
    onPaper,
  });
  return { host, onLook, onLookParams, onPaper, panel };
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
    expect(panel.element.querySelectorAll('input[type="range"]')).toHaveLength(14);
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="foldCount"]')?.step)
      .toBe('1');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="keyIntensity"]'))
      .toMatchObject({ min: '0', max: '30' });
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="fillIntensity"]'))
      .toMatchObject({ min: '0', max: '30' });
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="ambientIntensity"]'))
      .toMatchObject({ min: '0', max: '3', step: '0.05' });
    expect(panel.element.querySelector('input[type="number"][aria-label="seed"]')).not.toBeNull();
    expect(panel.element.querySelector<HTMLInputElement>('input[type="color"][aria-label="cardColor"]')?.value)
      .toBe('#f4f1ea');
    expect(panel.element.querySelector<HTMLInputElement>('input[type="color"][aria-label="keyColor"]')?.value)
      .toBe('#ffffff');
    expect(panel.element.querySelector<HTMLInputElement>('input[type="color"][aria-label="fillColor"]')?.value)
      .toBe('#dde8ff');
  });

  it('applies presets immediately and debounces slider regeneration by 150ms', () => {
    vi.useFakeTimers();
    const { onPaper, panel } = setupPanel();
    const subtle = panel.element.querySelector('button[data-value="subtle"]')!;
    const fiber = panel.element.querySelector(
      'input[aria-label="fiber"]',
    ) as HTMLInputElement;

    fireEvent.click(subtle);
    expect(onPaper).toHaveBeenCalledExactlyOnceWith(PAPER_PRESETS.subtle);
    expect(fiber.value).toBe(String(PAPER_PRESETS.subtle.fiber));

    onPaper.mockClear();
    fireEvent.input(fiber, { target: { value: '0.4' } });
    vi.advanceTimersByTime(149);
    expect(onPaper).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPaper).toHaveBeenCalledExactlyOnceWith({
      ...PAPER_PRESETS.subtle,
      fiber: 0.4,
    });
  });

  it('syncs the full look recipe when the active look changes', () => {
    const { panel } = setupPanel();

    fireEvent.click(panel.element.querySelector('button[data-value="kraft"]')!);

    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="cardColor"]')!.value)
      .toBe('#c9a06c');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="keyIntensity"]')!.value)
      .toBe('6');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="keyColor"]')!.value)
      .toBe('#fff1dd');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="fillIntensity"]')!.value)
      .toBe('3');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="fillColor"]')!.value)
      .toBe('#dde8ff');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="ambientIntensity"]')!.value)
      .toBe('1.2');
  });

  it('applies light rig edits immediately and debounces cardColor regeneration by 150ms', () => {
    vi.useFakeTimers();
    const { onLookParams, panel } = setupPanel();
    const keyIntensity = panel.element.querySelector(
      'input[aria-label="keyIntensity"]',
    ) as HTMLInputElement;
    const keyColor = panel.element.querySelector(
      'input[type="color"][aria-label="keyColor"]',
    ) as HTMLInputElement;
    const cardColor = panel.element.querySelector(
      'input[type="color"][aria-label="cardColor"]',
    ) as HTMLInputElement;

    fireEvent.input(keyIntensity, { target: { value: '10' } });
    expect(onLookParams).toHaveBeenCalledExactlyOnceWith({
      ...FOLD_LOOK_PRESETS.plain,
      keyIntensity: 10,
    });

    fireEvent.input(keyColor, { target: { value: '#123456' } });
    expect(onLookParams).toHaveBeenLastCalledWith({
      ...FOLD_LOOK_PRESETS.plain,
      keyIntensity: 10,
      keyColor: 0x123456,
    });

    onLookParams.mockClear();
    fireEvent.input(cardColor, { target: { value: '#654321' } });
    vi.advanceTimersByTime(149);
    expect(onLookParams).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLookParams).toHaveBeenCalledExactlyOnceWith({
      ...FOLD_LOOK_PRESETS.plain,
      cardColor: 0x654321,
      keyIntensity: 10,
      keyColor: 0x123456,
    });
  });

  it('collapses without removing its toggle and accepts hook-driven state updates', () => {
    const { panel } = setupPanel();
    const toggle = panel.element.querySelector('button[aria-label="Toggle paper controls"]')!;
    const controls = panel.element.querySelector('[data-paper-controls]') as HTMLElement;

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(controls.hidden).toBe(true);

    panel.setLook('black', FOLD_LOOK_PRESETS.black);
    panel.setPaper(PAPER_PRESETS.coarse);
    expect(panel.element.querySelector('button[data-value="black"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="seed"]')!.value)
      .toBe(String(PAPER_PRESETS.coarse.seed));
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="cardColor"]')!.value)
      .toBe('#1c1a17');
    expect(panel.element.querySelector<HTMLInputElement>('input[aria-label="ambientIntensity"]')!.value)
      .toBe('0.35');
  });

  it('prints and copies the current look and PaperParams JSON', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { panel } = setupPanel();

    fireEvent.click(panel.element.querySelector('button[data-value="kraft"]')!);
    fireEvent.click(panel.element.querySelector('button[data-value="coarse"]')!);
    fireEvent.click(panel.element.querySelector('button[data-action="copy"]')!);

    const json = JSON.stringify({
      look: {
        cardColor: '#c9a06c',
        keyIntensity: 6,
        keyColor: '#fff1dd',
        fillIntensity: 3,
        fillColor: '#dde8ff',
        ambientIntensity: 1.2,
        printOverlay: 'none',
      },
      paper: PAPER_PRESETS.coarse,
    }, null, 2);
    expect(consoleLog).toHaveBeenCalledExactlyOnceWith(json);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(json);
  });
});
