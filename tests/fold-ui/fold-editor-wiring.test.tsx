import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseTuckEnd } from '@/boxes/reverse-tuck-end';
import { resolveParams } from '@/core/registry';
import type { ResolvedParams } from '@/core/types';
import { buildRteFoldModel } from '@/fold/models/reverse-tuck-end';
import type { DictKey } from '@/i18n/dict';
import { setLang } from '@/i18n/lang';
import { t } from '@/i18n/t';
import { FoldView, type ArtworkFileLoader } from '@/ui/FoldView';
import {
  artworkLayoutSignature,
  deriveArtworkLayout,
} from '@/ui/artwork-layout';
import type { EditableArtworkAsset } from '@/ui/artwork-source';
import {
  createEditorSession,
  destroyEditorSession,
  updateEditorSessionState,
  type EditorSession,
} from '@/ui/editor/editor-session';
import { reduce, type EditorState } from '@/ui/editor/editor-state';
import type {
  CustomArtworkSource,
  FoldSceneHandle,
  createFoldScene,
} from '@/ui/fold-scene';

const composeArtworkMock = vi.hoisted(() => vi.fn());

vi.mock('@/ui/editor/editor-compose', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/ui/editor/editor-compose')>(),
  composeArtwork: composeArtworkMock,
}));

vi.mock('@/ui/editor/EditorView', async () => {
  const { createElement } = await import('react');
  const { effectiveObjects } = await import('@/ui/editor/editor-state');
  const { t: translate } = await import('@/i18n/t');
  return {
    default: ({ state, dispatch, history, onAddImage, onExit, statusKey }: {
      state: EditorState;
      dispatch: (state: EditorState) => void;
      history: EditorSession['history'];
      onAddImage?: () => void;
      onExit: () => void;
      statusKey?: DictKey;
    }) => createElement('div', { 'data-testid': 'editor-stub' },
      statusKey === undefined
        ? null
        : createElement('p', { role: 'status' }, translate(statusKey)),
      createElement('div', { 'data-testid': 'editor-state', role: 'presentation' }, JSON.stringify(state)),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const next = reduce(state, {
            type: 'addText',
            frameSpan: 200,
            frameCenterX: 40,
            frameCenterY: 110,
            defaultText: `TEXT-${state.objects.length + 1}`,
          });
          dispatch(next);
          history.commit(next);
        },
      }, 'STUB TEXT'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const next = reduce(state, {
            type: 'addText',
            frameSpan: 200,
            frameCenterX: 40,
            frameCenterY: 110,
            defaultText: ' ',
          });
          dispatch(next);
          history.commit(next);
        },
      }, 'STUB BLANK'),
      createElement('button', { type: 'button', onClick: onAddImage }, 'STUB IMAGE'),
      createElement('button', {
        type: 'button',
        onClick: () => {
          const objects = effectiveObjects(state);
          if (objects.length !== state.objects.length) {
            const next = {
              objects,
              selectedId: objects.some(({ id }) => id === state.selectedId)
                ? state.selectedId
                : null,
            };
            dispatch(next);
            history.commit(next);
          }
          onExit();
        },
      }, 'DONE'),
    ),
  };
});

const RTE_VALUES = resolveParams(reverseTuckEnd, {});
const RTE_LAYOUT = deriveArtworkLayout(buildRteFoldModel(RTE_VALUES));
const RTE_SIGNATURE = artworkLayoutSignature(buildRteFoldModel(RTE_VALUES));

function bitmap(width: number, height: number): ImageBitmap {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap;
}

function editable(width: number, height: number, revision = 1): EditableArtworkAsset {
  return { bitmap: bitmap(width, height), width, height, revision };
}

function source(signature = RTE_SIGNATURE): CustomArtworkSource {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2048;
  return { canvas, signature };
}

function createFakeScene() {
  const handles: FoldSceneHandle[] = [];
  const createScene = vi.fn<typeof createFoldScene>(() => {
    const handle: FoldSceneHandle = {
      updatePose: vi.fn(),
      replaceModel: vi.fn(),
      setAutoRotate: vi.fn(),
      applyRecipe: vi.fn(),
      applyArtwork: vi.fn(),
      installCustomSource: vi.fn(),
      removeCustomSource: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    };
    handles.push(handle);
    return handle;
  });
  return { createScene, handles };
}

interface HarnessProps {
  values?: ResolvedParams;
  initialSession?: EditorSession | null;
  initialSource?: CustomArtworkSource | null;
  initialEditable?: EditableArtworkAsset | null;
  loadArtwork?: ArtworkFileLoader;
}

function Harness({
  values = RTE_VALUES,
  initialSession = null,
  initialSource = null,
  initialEditable = null,
  loadArtwork,
}: HarnessProps) {
  const fake = useState(createFakeScene)[0];
  const [session, setSession] = useState(initialSession);
  const [customSource, setCustomSource] = useState(initialSource);
  const [editableArtwork, setEditableArtwork] = useState(initialEditable);
  return (
    <>
      <FoldView
        boxId="rte"
        values={values}
        createScene={fake.createScene}
        customSource={customSource}
        onCustomSourceChange={setCustomSource}
        editableArtwork={editableArtwork}
        onEditableArtworkChange={setEditableArtwork}
        onEditableArtworkConsumed={(consumed) => {
          setEditableArtwork((current) => current === consumed ? null : current);
        }}
        editorSession={session}
        onEditorSessionChange={setSession}
        loadArtwork={loadArtwork}
      />
      <div data-testid="session-probe">
        {session === null
          ? 'none'
          : `${session.state.objects.length}:${session.contentRevision}:${session.alignedLayoutSignature}`}
      </div>
      <div data-testid="source-probe">{customSource?.signature ?? 'none'}</div>
      <div data-testid="editable-probe">{editableArtwork?.revision ?? 'none'}</div>
      <div data-testid="scene-probe">{fake.handles.length}</div>
    </>
  );
}

function sessionWithTexts(count: number, signature = RTE_SIGNATURE): EditorSession {
  let session = createEditorSession(signature, RTE_LAYOUT);
  for (let index = 0; index < count; index += 1) {
    const next = reduce(session.state, {
      type: 'addText',
      frameSpan: RTE_LAYOUT.frame.span,
      frameCenterX: 10,
      frameCenterY: 20,
      defaultText: index === 0 ? 'KEPT' : `KEPT-${index + 1}`,
    });
    session = updateEditorSessionState(session, next);
    session.history.commit(next);
  }
  return session;
}

function sessionWithText(signature = RTE_SIGNATURE): EditorSession {
  return sessionWithTexts(1, signature);
}

beforeEach(() => {
  setLang('en');
  composeArtworkMock.mockReset();
  composeArtworkMock.mockImplementation(() => document.createElement('canvas'));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLang('en');
});

describe('FoldView editor transition matrix', () => {
  it.each(['none', 'sample'] as const)(
    'opens an empty session from %s when no session exists',
    async (artwork) => {
      render(<Harness />);
      await screen.findByRole('button', { name: t('fold.art.edit') });
      if (artwork === 'sample') {
        fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));
      }

      fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));

      expect(await screen.findByTestId('editor-stub')).toBeInTheDocument();
      expect(screen.getByTestId('editor-state')).toHaveTextContent('"objects":[]');
      expect(screen.getByTestId('session-probe')).toHaveTextContent('0:0:');
    },
  );

  it.each([
    ['square', 100, 100, 1],
    ['landscape', 200, 100, 1],
    ['portrait', 100, 200, 0.5],
  ] as const)('seeds custom %s artwork once with long-edge scale', async (
    _name,
    width,
    height,
    widthFactor,
  ) => {
    render(
      <Harness initialSource={source()} initialEditable={editable(width, height, 7)} />,
    );
    await screen.findByRole('button', { name: t('fold.art.edit') });

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));

    const state = JSON.parse(screen.getByTestId('editor-state').textContent!) as EditorState;
    expect(state.objects).toEqual([
      expect.objectContaining({
        kind: 'image',
        widthMm: RTE_LAYOUT.frame.span * widthFactor,
      }),
    ]);
    expect(screen.getByTestId('editable-probe')).toHaveTextContent('none');
  });

  it.each(['none', 'sample', 'custom'] as const)(
    'continues an existing session from %s without reseeding',
    async (artwork) => {
      const session = sessionWithText();
      const custom = artwork === 'custom' ? source() : null;
      render(
        <Harness
          initialSession={session}
          initialSource={custom}
          initialEditable={editable(400, 200, 9)}
        />,
      );
      await screen.findByRole('button', { name: t('fold.art.edit') });
      if (artwork === 'sample') {
        fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));
      }

      fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));

      const state = JSON.parse(screen.getByTestId('editor-state').textContent!) as EditorState;
      expect(state.objects).toHaveLength(1);
      expect(state.objects[0]).toEqual(expect.objectContaining({ kind: 'text', text: 'KEPT' }));
      destroyEditorSession(session);
    },
  );

  it('DONE preserves objects, cancels debounce, aligns, and immediately composes the latest state', async () => {
    vi.useFakeTimers();
    render(<Harness initialSession={sessionWithText()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    fireEvent.click(screen.getByRole('button', { name: 'STUB TEXT' }));
    expect(composeArtworkMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(screen.queryByTestId('editor-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-probe')).toHaveTextContent(`2:2:${RTE_SIGNATURE}`);
    expect(composeArtworkMock).toHaveBeenCalledOnce();
    expect(composeArtworkMock).toHaveBeenCalledWith(
      expect.objectContaining({ objects: expect.arrayContaining([
        expect.objectContaining({ text: 'KEPT' }),
        expect.objectContaining({ text: 'TEXT-2' }),
      ]) }),
      expect.objectContaining({ frame: RTE_LAYOUT.frame }),
      2048,
      { guides: false },
      expect.anything(),
    );
    act(() => vi.advanceTimersByTime(300));
    expect(composeArtworkMock).toHaveBeenCalledOnce();
  });

  it('composes a DONE cleanup revision only once after the debounce window', async () => {
    vi.useFakeTimers();
    render(<Harness initialSession={sessionWithText()} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    fireEvent.click(screen.getByRole('button', { name: 'STUB BLANK' }));

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(composeArtworkMock).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(300));
    expect(composeArtworkMock).toHaveBeenCalledOnce();
  });

  it('keeps the M3 single-image route when uploading without a session', async () => {
    const uploadedSource = source('uploaded');
    const uploadedEditable = editable(400, 200, 11);
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      options.onCommit(uploadedSource, uploadedEditable);
      return 'committed';
    });
    const view = render(<Harness loadArtwork={loadArtwork} />);
    await screen.findByRole('button', { name: t('fold.art.upload') });

    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['png'], 'art.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(screen.getByTestId('source-probe')).toHaveTextContent('uploaded'));
    expect(screen.getByTestId('session-probe')).toHaveTextContent('none');
    expect(screen.getByTestId('editable-probe')).toHaveTextContent('11');
  });

  it('adds UPLOAD to the top of an existing session and composes that revision only once', async () => {
    const uploadedSource = source('temporary-upload');
    const uploadedEditable = editable(100, 200, 12);
    const loadArtwork = vi.fn<ArtworkFileLoader>(async (_file, options) => {
      options.onCommit(uploadedSource, uploadedEditable);
      return 'committed';
    });
    const session = sessionWithText();
    const view = render(<Harness initialSession={session} loadArtwork={loadArtwork} />);
    await screen.findByRole('button', { name: t('fold.art.upload') });
    vi.useFakeTimers();

    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['png'], 'second.png', { type: 'image/png' })] },
    });

    await act(async () => undefined);
    expect(screen.getByTestId('session-probe')).toHaveTextContent('2:2:');
    expect(composeArtworkMock).toHaveBeenCalledOnce();
    expect(uploadedSource.canvas).toMatchObject({ width: 0, height: 0 });
    expect(screen.getByTestId('editable-probe')).toHaveTextContent('none');
    act(() => vi.advanceTimersByTime(300));
    expect(composeArtworkMock).toHaveBeenCalledOnce();
  });

  it('rejects an in-session upload at 32 objects before decoding and reports the limit', async () => {
    const session = sessionWithTexts(32);
    const originalState = session.state;
    const loadArtwork = vi.fn<ArtworkFileLoader>();
    const view = render(<Harness initialSession={session} loadArtwork={loadArtwork} />);
    await screen.findByRole('button', { name: t('fold.art.upload') });

    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['png'], 'over-limit.png', { type: 'image/png' })] },
    });

    expect(loadArtwork).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(t('editor.limit.objects'));
    expect(screen.getByTestId('session-probe')).toHaveTextContent('32:32:');
    expect(session.state).toBe(originalState);
  });

  it('keeps a session when switching to SAMPLE and NONE, then resumes it with EDIT', async () => {
    const session = sessionWithText();
    render(<Harness initialSession={session} initialSource={source()} />);
    await screen.findByRole('button', { name: t('fold.art.sample') });

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));
    expect(screen.getByTestId('session-probe')).toHaveTextContent('1:1:');
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.sample') }));
    expect(screen.getByTestId('session-probe')).toHaveTextContent('1:1:');
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));

    expect(screen.getByTestId('editor-state')).toHaveTextContent('KEPT');
  });
});

describe('FoldView editor stale and synchronization', () => {
  it('preserves FOLD after a compose failure and clears the message on the next success', async () => {
    const previousSource = source('previous-frame');
    render(<Harness initialSession={sessionWithText()} initialSource={previousSource} />);
    await screen.findByRole('button', { name: t('fold.art.edit') });
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    composeArtworkMock.mockImplementationOnce(() => {
      throw new Error('compose failed');
    });

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(await screen.findByRole('status')).toHaveTextContent(t('editor.error.compose'));
    expect(screen.queryByText(t('fold.loadFailed'))).not.toBeInTheDocument();
    expect(document.querySelector('[data-fold-error="true"]')).toBeNull();
    expect(screen.getByTestId('source-probe')).toHaveTextContent('previous-frame');

    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    await waitFor(() => expect(screen.queryByText(t('editor.error.compose'))).not.toBeInTheDocument());
    expect(screen.getByTestId('source-probe')).toHaveTextContent(RTE_SIGNATURE);
  });

  it('shows stale in editor and preview, keeps it through another change, and clears it on DONE', async () => {
    const session = sessionWithText();
    const view = render(<Harness initialSession={session} />);
    await screen.findByRole('button', { name: t('fold.art.edit') });
    const changed: ResolvedParams = {
      ...RTE_VALUES,
      L: (RTE_VALUES.L as number) + 5,
    };
    view.rerender(<Harness initialSession={session} values={changed} />);

    expect(await screen.findByRole('status')).toHaveTextContent(t('editor.stale'));
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    expect(screen.getByRole('status')).toHaveTextContent(t('editor.stale'));
    const before = screen.getByTestId('editor-state').textContent;

    view.rerender(
      <Harness
        initialSession={session}
        values={{ ...changed, W: (changed.W as number) + 5 }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(t('editor.stale'));
    expect(screen.getByTestId('editor-state')).toHaveTextContent(before!);

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('debounces content revisions for 300ms and never lets the old callback overwrite newer state', async () => {
    vi.useFakeTimers();
    render(<Harness initialSession={createEditorSession(RTE_SIGNATURE, RTE_LAYOUT)} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));

    fireEvent.click(screen.getByRole('button', { name: 'STUB TEXT' }));
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(screen.getByRole('button', { name: 'STUB TEXT' }));
    act(() => vi.advanceTimersByTime(100));
    expect(composeArtworkMock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(200));
    expect(composeArtworkMock).toHaveBeenCalledOnce();
    expect(composeArtworkMock.mock.calls[0]![0].objects).toHaveLength(2);
  });

  it('cancels the pending composition when FoldView unmounts', async () => {
    vi.useFakeTimers();
    const view = render(<Harness initialSession={createEditorSession(RTE_SIGNATURE, RTE_LAYOUT)} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: t('fold.art.edit') }));
    fireEvent.click(screen.getByRole('button', { name: 'STUB TEXT' }));

    view.unmount();
    act(() => vi.advanceTimersByTime(300));

    expect(composeArtworkMock).not.toHaveBeenCalled();
  });
});
