import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomArtworkSource } from '@/ui/fold-scene';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import { ANNOUNCEMENT_DISMISS_KEY } from '@/ui/AnnouncementModal';
import { deriveArtworkLayout } from '@/ui/artwork-layout';
import type { EditableArtworkAsset } from '@/ui/artwork-source';
import type { EditorSession } from '@/ui/editor/editor-session';
import { createEditorSession } from '@/ui/editor/editor-session';
import { t } from '@/i18n/t';

let emittedSource: CustomArtworkSource | null = null;
let emittedSession: EditorSession | null = null;

vi.mock('@/ui/FoldView', () => ({
  FoldView: ({
    customSource,
    onCustomSourceChange,
    editorSession,
    onEditorSessionChange,
  }: {
    customSource: CustomArtworkSource | null;
    onCustomSourceChange: (source: CustomArtworkSource | null) => void;
    editorSession?: EditorSession | null;
    onEditorSessionChange?: (session: EditorSession) => void;
  }) => (
    <div data-testid="fold-owner-probe">
      <span>{customSource?.signature ?? 'none'}</span>
      <span data-testid="session-owner-probe">
        {editorSession === null || editorSession === undefined
          ? 'session:none'
          : `session:${editorSession.state.objects.length}`}
      </span>
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
      <button
        type="button"
        onClick={() => onEditorSessionChange?.(emittedSession!)}
      >
        install session
      </button>
    </div>
  ),
}));

import { App } from '@/ui/App';

beforeEach(() => {
  localStorage.setItem(ANNOUNCEMENT_DISMISS_KEY, 'true');
  emittedSource = null;
  emittedSession = null;
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

  it('keeps the editor session across FoldView unmount and box changes, then destroys it on App unmount', async () => {
    const values = resolveParams(reverseTuckEnd, {});
    const layout = deriveArtworkLayout(buildRteFoldModel(values));
    const editable: EditableArtworkAsset = {
      bitmap: { width: 200, height: 100, close: vi.fn() } as unknown as ImageBitmap,
      width: 200,
      height: 100,
      revision: 1,
    };
    emittedSession = createEditorSession('rte-session', layout, editable);
    const view = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));
    await screen.findByTestId('fold-owner-probe');

    fireEvent.click(screen.getByRole('button', { name: 'install session' }));
    expect(screen.getByTestId('session-owner-probe')).toHaveTextContent('session:1');

    fireEvent.click(screen.getByRole('button', { name: t('mode.design') }));
    fireEvent.change(screen.getByLabelText(t('console.boxStyle')), {
      target: { value: 'telescope' },
    });
    fireEvent.change(screen.getByLabelText(t('console.boxStyle')), {
      target: { value: 'rte' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));
    expect(await screen.findByTestId('session-owner-probe')).toHaveTextContent('session:1');

    view.unmount();
    expect(editable.bitmap.close).toHaveBeenCalledOnce();

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: t('mode.fold') }));
    expect(await screen.findByTestId('session-owner-probe')).toHaveTextContent('session:none');
  });
});
