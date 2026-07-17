import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomArtworkSource } from '@/ui/fold-scene';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { t } from '@/i18n/t';

let emittedSource: CustomArtworkSource | null = null;

vi.mock('@/ui/FoldView', () => ({
  FoldView: ({
    customSource,
    onCustomSourceChange,
  }: {
    customSource: CustomArtworkSource | null;
    onCustomSourceChange: (source: CustomArtworkSource | null) => void;
  }) => (
    <div data-testid="fold-owner-probe">
      <span>{customSource?.signature ?? 'none'}</span>
      <button
        type="button"
        onClick={() => {
          const canvas = document.createElement('canvas');
          canvas.width = 2048;
          canvas.height = 2048;
          emittedSource = { canvas, signature: 'rte:owner-fixture' };
          onCustomSourceChange(emittedSource);
        }}
      >
        install fixture
      </button>
      <button type="button" onClick={() => onCustomSourceChange(null)}>discard fixture</button>
    </div>
  ),
}));

import { App } from '@/ui/App';

beforeEach(() => {
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
  emittedSource = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('App custom artwork source owner', () => {
  it('keeps the source across FOLD unmount/remount and releases it when discarded', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));
    await screen.findByTestId('fold-owner-probe');

    fireEvent.click(screen.getByRole('button', { name: 'install fixture' }));
    const installed = emittedSource!;
    expect(installed.signature).toBe('rte:owner-fixture');

    fireEvent.click(screen.getByRole('button', { name: t('mode.design') }));
    expect(screen.queryByTestId('fold-owner-probe')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));

    expect(await screen.findByText('rte:owner-fixture')).toBeInTheDocument();
    expect(installed.canvas).toMatchObject({ width: 2048, height: 2048 });
    fireEvent.click(screen.getByRole('button', { name: 'discard fixture' }));
    expect(installed.canvas).toMatchObject({ width: 0, height: 0 });
  });

  it('releases the retained canvas when the App owner unmounts', async () => {
    const view = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));
    await screen.findByTestId('fold-owner-probe');
    fireEvent.click(screen.getByRole('button', { name: 'install fixture' }));
    const installed = emittedSource!;
    expect(installed.signature).toBe('rte:owner-fixture');

    view.unmount();

    expect(installed.canvas).toMatchObject({ width: 0, height: 0 });
  });
});
