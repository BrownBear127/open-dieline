import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ArtworkLayout } from '@/ui/artwork-layout';
import type { AssetRegistry } from '@/ui/editor/editor-assets';
import EditorView, { type EditorViewProps } from '@/ui/editor/EditorView';
import { setLang } from '@/i18n/lang';
import {
  reduce,
  type EditorObject,
  type EditorState,
  type History,
  type ImageObject,
  type InkPaletteColor,
  type TextObject,
} from '@/ui/editor/editor-state';

const composeModule = vi.hoisted(() => ({
  composeArtwork: vi.fn(),
  fromCanvas: vi.fn(),
  textBlockMetrics: vi.fn(),
}));

const snapModule = vi.hoisted(() => ({
  snapDelta: vi.fn(),
}));

vi.mock('@/ui/editor/editor-compose', () => composeModule);
vi.mock('@/ui/editor/editor-snap', () => snapModule);

const layout: ArtworkLayout = {
  frame: { minX: 0, minY: 0, span: 100, offsetX: 0, offsetY: 0 },
  panels: [{
    id: 'panel',
    polygon: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    hinge: { a: { x: 50, y: 0 }, b: { x: 50, y: 100 } },
  }],
};

function image(id: string, overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id,
    kind: 'image',
    assetId: `asset-${id}`,
    x: 30,
    y: 30,
    rotation: 0,
    widthMm: 20,
    ...overrides,
  };
}

function text(id: string, overrides: Partial<TextObject> = {}): TextObject {
  return {
    id,
    kind: 'text',
    text: 'TEXT',
    fontFamily: 'sans',
    fontSizeMm: 10,
    align: 'center',
    color: 'ink',
    x: 30,
    y: 30,
    rotation: 0,
    ...overrides,
  };
}

function state(objects: EditorObject[] = [], selectedId: string | null = null): EditorState {
  return { objects, selectedId };
}

function history() {
  return {
    commit: vi.fn<(nextState: EditorState) => void>(),
    undo: vi.fn<() => EditorState | null>(() => null),
    redo: vi.fn<() => EditorState | null>(() => null),
  } satisfies History;
}

const registry = {
  get: vi.fn(() => ({
    bitmap: { width: 100, height: 100 } as ImageBitmap,
    width: 100,
    height: 100,
  })),
} as unknown as AssetRegistry;

interface RenderOptions {
  history?: ReturnType<typeof history>;
  layout?: ArtworkLayout;
  onAddImage?: Mock<() => void>;
  onDownload?: Mock<() => void>;
  onExit?: Mock<() => void>;
  dpr?: number;
  viewCssPx?: number;
}

function renderEditor(initialState: EditorState, options: RenderOptions = {}) {
  const dispatch = vi.fn<(nextState: EditorState) => void>();
  const editorHistory = options.history ?? history();
  const onAddImage = options.onAddImage ?? vi.fn();
  const onDownload = options.onDownload ?? vi.fn();
  const onExit = options.onExit ?? vi.fn();
  const props = {
    history: editorHistory,
    layout: options.layout ?? layout,
    registry,
    viewCssPx: options.viewCssPx ?? 100,
    dpr: options.dpr ?? 1,
    labels: { canvas: 'Artwork editor canvas' },
    onAddImage,
    onDownload,
    onExit,
  } satisfies Omit<EditorViewProps, 'state' | 'dispatch'>;

  function Harness() {
    const [currentState, setCurrentState] = useState(initialState);
    return (
      <EditorView
        {...props}
        state={currentState}
        dispatch={(nextState) => {
          dispatch(nextState);
          setCurrentState(nextState);
        }}
      />
    );
  }

  const view = render(<Harness />);
  const interaction = screen.getByTestId('editor-interaction-canvas');
  return {
    ...view,
    dispatch,
    history: editorHistory,
    interaction,
    onAddImage,
    onDownload,
    onExit,
  };
}

function selectedId(dispatch: Mock<(nextState: EditorState) => void>): string | null | undefined {
  const calls = dispatch.mock.calls;
  return (calls[calls.length - 1]?.[0] as EditorState | undefined)?.selectedId;
}

function lastState(dispatch: Mock<(nextState: EditorState) => void>): EditorState {
  const calls = dispatch.mock.calls;
  return calls[calls.length - 1]![0] as EditorState;
}

beforeEach(() => {
  setLang('en');
  registry.get = vi.fn(() => ({
    bitmap: { width: 100, height: 100 } as ImageBitmap,
    width: 100,
    height: 100,
  }));
  const composed = document.createElement('canvas');
  composeModule.composeArtwork.mockReturnValue(composed);
  composeModule.fromCanvas.mockImplementation((point: { x: number; y: number }) => point);
  composeModule.textBlockMetrics.mockImplementation((object: TextObject) => {
    const unrotatedBounds = {
      minX: object.x - 20,
      minY: object.y - 10,
      maxX: object.x + 20,
      maxY: object.y + 10,
    };
    return {
      width: 40,
      height: 20,
      font: `${object.fontSizeMm}px sans-serif`,
      lines: [],
      unrotatedBounds,
      bounds: unrotatedBounds,
    };
  });
  snapModule.snapDelta.mockReturnValue(null);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    setLineDash: vi.fn(),
    measureText: vi.fn((value: string) => ({ width: value.length * 5 })),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('EditorView canvas wiring', () => {
  it('centers two square canvases and composes the backing store with guides', () => {
    const initial = state([image('a')]);
    const { container } = renderEditor(initial, { viewCssPx: 120, dpr: 2 });
    const canvases = container.querySelectorAll('canvas');

    expect(canvases).toHaveLength(2);
    expect(canvases[0]).toHaveAttribute('width', '240');
    expect(canvases[0]).toHaveAttribute('height', '240');
    expect(canvases[1]).toHaveAttribute('width', '240');
    expect(canvases[1]).toHaveAttribute('height', '240');
    expect(canvases[0]).toHaveStyle({ width: '120px', height: '120px' });
    expect(composeModule.composeArtwork).toHaveBeenCalledWith(
      initial,
      layout,
      240,
      { guides: true },
      registry,
    );
  });

  it('falls back to a one-pixel backing store and accepts layouts without a hinge', () => {
    const layoutWithoutHinge: ArtworkLayout = {
      ...layout,
      panels: [{ id: 'panel', polygon: layout.panels[0]!.polygon }],
    };
    const { container } = renderEditor(state(), {
      dpr: 0,
      viewCssPx: 0,
      layout: layoutWithoutHinge,
    });

    expect(container.querySelectorAll('canvas')[0]).toHaveAttribute('width', '1');
  });

  it('keeps the previous frame, reports a compose failure, and clears it after recovery', async () => {
    renderEditor(state([image('artwork')]));
    const context = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results[0]!
      .value as CanvasRenderingContext2D;
    const drawImage = vi.mocked(context.drawImage);
    expect(drawImage).toHaveBeenCalledOnce();

    composeModule.composeArtwork.mockImplementationOnce(() => {
      throw new Error('compose failed');
    });
    fireEvent.click(screen.getByRole('button', { name: 'TEXT' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Rendering failed. Try again or remove the last object.',
    );
    expect(drawImage).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'TEXT' }));

    await waitFor(() => expect(screen.queryByText(
      'Rendering failed. Try again or remove the last object.',
    )).not.toBeInTheDocument());
    expect(drawImage).toHaveBeenCalledTimes(2);
  });
});

describe('EditorView pointer interactions', () => {
  it('previews a drag during move and commits exactly once on pointer up', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([image('a')]), {
      history: editorHistory,
    });

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 44, clientY: 34, pointerId: 1 });

    expect(editorHistory.commit).not.toHaveBeenCalled();
    expect(lastState(dispatch).objects[0]).toMatchObject({ x: 44, y: 34 });

    fireEvent.pointerUp(interaction, { clientX: 44, clientY: 34, pointerId: 1 });

    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
    expect(editorHistory.commit).toHaveBeenCalledWith(lastState(dispatch));
  });

  it('selects the last overlapping object in array order', () => {
    const { dispatch, interaction } = renderEditor(state([image('back'), image('front')]));

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });

    expect(selectedId(dispatch)).toBe('front');
  });

  it('follows changed layer order on the next hit test', () => {
    const dispatch = vi.fn<(nextState: EditorState) => void>();
    const editorHistory = history();
    const onExit = vi.fn();
    const first = state([image('back'), image('front')]);
    const second = state([image('front'), image('back')]);
    const { rerender } = render(
      <EditorView
        state={first}
        dispatch={dispatch}
        history={editorHistory}
        layout={layout}
        registry={registry}
        viewCssPx={100}
        dpr={1}
        onExit={onExit}
      />,
    );
    const interaction = screen.getByTestId('editor-interaction-canvas');

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    expect(selectedId(dispatch)).toBe('front');

    dispatch.mockClear();
    rerender(
      <EditorView
        state={second}
        dispatch={dispatch}
        history={editorHistory}
        layout={layout}
        registry={registry}
        viewCssPx={100}
        dpr={1}
        onExit={onExit}
      />,
    );

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });

    expect(selectedId(dispatch)).toBe('back');
  });

  it('inverse-rotates the pointer before testing a rotated object', () => {
    const rotated = image('rotated', { x: 50, y: 50, widthMm: 40, rotation: 90 });
    registry.get = vi.fn(() => ({
      bitmap: { width: 400, height: 100 } as ImageBitmap,
      width: 400,
      height: 100,
    }));
    const { dispatch, interaction } = renderEditor(state([rotated]));

    fireEvent.pointerDown(interaction, { clientX: 50, clientY: 68, pointerId: 1 });

    expect(selectedId(dispatch)).toBe('rotated');
  });

  it('uses text block metrics for text hit testing', () => {
    const { dispatch, interaction } = renderEditor(state([text('copy', { x: 70, y: 30 })]));

    fireEvent.pointerDown(interaction, { clientX: 88, clientY: 30, pointerId: 1 });

    expect(composeModule.textBlockMetrics).toHaveBeenCalled();
    expect(selectedId(dispatch)).toBe('copy');
  });

  it.each([
    { start: { x: 40, y: 40 }, end: { x: 30, y: 30 } },
    { start: { x: 60, y: 40 }, end: { x: 70, y: 30 } },
    { start: { x: 60, y: 60 }, end: { x: 70, y: 70 } },
    { start: { x: 40, y: 60 }, end: { x: 30, y: 70 } },
  ])('resizes proportionally from corner $start.x,$start.y and commits on release', ({ start, end }) => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([
      image('a', { x: 50, y: 50 }),
    ], 'a'), { history: editorHistory });

    fireEvent.pointerDown(interaction, { clientX: start.x, clientY: start.y, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: end.x, clientY: end.y, pointerId: 1 });

    expect(editorHistory.commit).not.toHaveBeenCalled();

    fireEvent.pointerUp(interaction, { clientX: end.x, clientY: end.y, pointerId: 1 });

    expect(lastState(dispatch).objects[0]).toMatchObject({ widthMm: 40 });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('resizes text proportionally by changing its font size', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([
      text('copy', { x: 50, y: 50 }),
    ], 'copy'), { history: editorHistory });

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 10, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(interaction, { clientX: 10, clientY: 30, pointerId: 1 });

    expect(lastState(dispatch).objects[0]).toMatchObject({ fontSizeMm: 20 });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('rotates from the rotation handle and commits on release', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([
      image('a', { x: 50, y: 50 }),
    ], 'a'), { history: editorHistory });

    fireEvent.pointerDown(interaction, { clientX: 50, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 80, clientY: 50, pointerId: 1 });

    expect(editorHistory.commit).not.toHaveBeenCalled();

    fireEvent.pointerUp(interaction, { clientX: 80, clientY: 50, pointerId: 1 });

    expect(lastState(dispatch).objects[0]).toMatchObject({ rotation: 90 });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('applies the displacement returned by snapDelta to the drag preview', () => {
    snapModule.snapDelta.mockReturnValueOnce({ dx: 5, dy: 0 });
    const { dispatch, interaction } = renderEditor(state([image('a')]));

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 40, clientY: 35, pointerId: 1 });

    expect(lastState(dispatch).objects[0]).toMatchObject({ x: 45, y: 35 });
    expect(snapModule.snapDelta).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ disabled: false }),
      2,
    );
  });

  it('passes Alt as disabled to snapping during a drag', () => {
    const { interaction } = renderEditor(state([image('a')]));

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(interaction, {
      clientX: 45,
      clientY: 40,
      pointerId: 1,
      altKey: true,
    });

    expect(snapModule.snapDelta).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ disabled: true }),
      2,
    );
  });

  it('clears a selection when the pointer misses every object', () => {
    const { dispatch, interaction } = renderEditor(state([image('a')], 'a'));

    fireEvent.pointerDown(interaction, { clientX: 95, clientY: 95, pointerId: 1 });

    expect(lastState(dispatch).selectedId).toBeNull();
  });

  it('restores only the gestured object when a pointer gesture is cancelled', () => {
    const editorHistory = history();
    const original = state([image('other', { x: 70 }), image('a')], 'a');
    const { dispatch, interaction } = renderEditor(original, { history: editorHistory });

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 45, clientY: 40, pointerId: 1 });
    fireEvent.pointerCancel(interaction, { clientX: 45, clientY: 40, pointerId: 1 });

    expect(lastState(dispatch)).toEqual(original);
    expect(editorHistory.commit).not.toHaveBeenCalled();
  });

  it('ignores pointer movement from a different pointer id', () => {
    const { dispatch, interaction } = renderEditor(state([image('a')], 'a'));

    fireEvent.pointerDown(interaction, { clientX: 30, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(interaction, { clientX: 45, clientY: 40, pointerId: 2 });

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('EditorView keyboard interactions', () => {
  it.each(['Delete', 'Backspace'])('%s deletes the selection and commits immediately', (key) => {
    const editorHistory = history();
    const { dispatch } = renderEditor(state([image('a')], 'a'), { history: editorHistory });

    fireEvent.keyDown(window, { key });

    expect(lastState(dispatch).objects).toEqual([]);
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('uses Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z for undo and redo', () => {
    const editorHistory = history();
    editorHistory.undo.mockReturnValueOnce(state([image('undo')]));
    editorHistory.redo.mockReturnValueOnce(state([image('redo')]));
    const { dispatch } = renderEditor(state([image('current')]), { history: editorHistory });

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(editorHistory.undo).toHaveBeenCalledTimes(1);
    expect(lastState(dispatch).objects[0]?.id).toBe('undo');

    fireEvent.keyDown(window, { key: 'Z', metaKey: true, shiftKey: true });
    expect(editorHistory.redo).toHaveBeenCalledTimes(1);
    expect(lastState(dispatch).objects[0]?.id).toBe('redo');
  });

  it('duplicates the selection by five millimetres and commits immediately', () => {
    const editorHistory = history();
    const { dispatch } = renderEditor(state([image('a')], 'a'), { history: editorHistory });

    fireEvent.keyDown(window, { key: 'd', metaKey: true });

    expect(lastState(dispatch).objects).toHaveLength(2);
    expect(lastState(dispatch).objects[1]).toMatchObject({ x: 35, y: 35 });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: 'Delete' },
    { key: 'Backspace' },
    { key: 'z', ctrlKey: true },
    { key: 'Z', metaKey: true, shiftKey: true },
    { key: 'd', ctrlKey: true },
    { key: 'Escape' },
  ])('stops every canvas shortcut while a form element is focused: $key', (shortcut) => {
    const editorHistory = history();
    const onExit = vi.fn();
    const { dispatch } = renderEditor(state([image('a')], 'a'), {
      history: editorHistory,
      onExit,
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    fireEvent.keyDown(window, shortcut);

    expect(dispatch).not.toHaveBeenCalled();
    expect(editorHistory.commit).not.toHaveBeenCalled();
    expect(editorHistory.undo).not.toHaveBeenCalled();
    expect(editorHistory.redo).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    input.remove();
  });

  it('clears selection on the first Escape and exits on the second', () => {
    const onExit = vi.fn();
    const { dispatch } = renderEditor(state([image('a')], 'a'), { onExit });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(selectedId(dispatch)).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('EditorView text editor', () => {
  it('commits exactly one history entry when an edited text panel closes outside', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([text('copy')]), {
      history: editorHistory,
    });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    const input = screen.getByRole('textbox', { name: 'TEXT' });

    fireEvent.change(input, { target: { value: 'FIRST\nSECOND' } });

    expect(lastState(dispatch).objects[0]).toMatchObject({ text: 'FIRST\nSECOND' });
    expect(editorHistory.commit).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('textbox', { name: 'TEXT' })).not.toBeInTheDocument();
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
    expect(editorHistory.commit).toHaveBeenCalledWith(lastState(dispatch));
  });

  it('does not add history when an unchanged text panel closes', () => {
    const editorHistory = history();
    const { interaction } = renderEditor(state([text('copy')]), { history: editorHistory });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    fireEvent.pointerDown(document.body);

    expect(editorHistory.commit).not.toHaveBeenCalled();
  });

  it.each([
    ['empty canvas', state()],
    ['image object', state([image('artwork')])],
  ])('does not open a text panel after double-clicking an %s', (_case, initialState) => {
    const { interaction } = renderEditor(initialState);

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });

    expect(screen.queryByTestId('editor-text-panel')).not.toBeInTheDocument();
  });

  it.each([
    ['INK', 'ink'],
    ['SOFT', 'inkSoft'],
    ['CUT', 'cut'],
    ['CREASE', 'crease'],
    ['BRASS', 'brass'],
  ] as const)('maps the %s palette option to InkPaletteColor %s', (label, color) => {
    const { dispatch, interaction } = renderEditor(state([text('copy')]));

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole('button', { name: label }));

    expect((lastState(dispatch).objects[0] as TextObject).color)
      .toBe(color satisfies InkPaletteColor);
  });

  it('edits font family, millimetre size, and alignment in the same history session', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([text('copy')]), {
      history: editorHistory,
    });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'SERIF' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'mm' }), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'RIGHT' }));

    expect(lastState(dispatch).objects[0]).toMatchObject({
      fontFamily: 'serif',
      fontSizeMm: 12.5,
      align: 'right',
    });
    expect(editorHistory.commit).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);

    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('closes and commits the text panel before Escape can affect the canvas', () => {
    const editorHistory = history();
    const onExit = vi.fn();
    const { dispatch, interaction } = renderEditor(state([text('copy')], 'copy'), {
      history: editorHistory,
      onExit,
    });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    const input = screen.getByRole('textbox', { name: 'TEXT' });
    fireEvent.change(input, { target: { value: 'EDITED' } });
    input.focus();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('editor-text-panel')).not.toBeInTheDocument();
    expect(lastState(dispatch).selectedId).toBe('copy');
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('commits once when focus leaves the whole text panel', () => {
    const editorHistory = history();
    const { interaction } = renderEditor(state([text('copy')]), { history: editorHistory });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    const input = screen.getByRole('textbox', { name: 'TEXT' });
    fireEvent.change(input, { target: { value: 'BLURRED' } });
    fireEvent.blur(input, { relatedTarget: document.body });

    expect(screen.queryByTestId('editor-text-panel')).not.toBeInTheDocument();
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open for internal focus moves and ignores a blank font size', () => {
    const editorHistory = history();
    const { dispatch, interaction } = renderEditor(state([text('copy')], 'copy'), {
      history: editorHistory,
    });

    fireEvent.doubleClick(interaction, { clientX: 30, clientY: 30 });
    const size = screen.getByRole('spinbutton', { name: 'mm' });
    const serif = screen.getByRole('button', { name: 'SERIF' });
    fireEvent.change(size, { target: { value: '' } });
    fireEvent.blur(size, { relatedTarget: serif });

    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('editor-text-panel')).toBeInTheDocument();
    expect(editorHistory.commit).not.toHaveBeenCalled();
  });
});

describe('EditorView toolbar', () => {
  it('shows the approved empty-state copy when only whitespace text remains', () => {
    renderEditor(state([text('blank', { text: '   ' })]));

    expect(screen.getByRole('status')).toHaveTextContent('Add an image or text to begin.');
  });

  it('adds the localized default text at the frame centre and commits immediately', () => {
    const editorHistory = history();
    const { dispatch } = renderEditor(state(), { history: editorHistory });

    fireEvent.click(screen.getByRole('button', { name: 'TEXT' }));

    expect(lastState(dispatch)).toMatchObject({
      selectedId: 'text-1',
      objects: [{
        id: 'text-1',
        kind: 'text',
        text: 'TEXT',
        x: 50,
        y: 50,
        fontSizeMm: 5,
      }],
    });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
  });

  it('disables image and text entry at 32 objects and leaves the reducer state unchanged', () => {
    const atLimit = state(Array.from({ length: 32 }, (_, index) => text(`text-${index + 1}`)));
    const editorHistory = history();
    const onAddImage = vi.fn();
    const { dispatch } = renderEditor(atLimit, { history: editorHistory, onAddImage });

    const imageButton = screen.getByRole('button', { name: 'IMAGE' });
    const textButton = screen.getByRole('button', { name: 'TEXT' });
    expect(imageButton).toBeDisabled();
    expect(textButton).toBeDisabled();

    fireEvent.click(imageButton);
    fireEvent.click(textButton);

    expect(onAddImage).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(editorHistory.commit).not.toHaveBeenCalled();
    expect(reduce(atLimit, {
      type: 'addText',
      frameSpan: layout.frame.span,
      frameCenterX: 50,
      frameCenterY: 50,
      defaultText: 'TEXT',
    })).toBe(atLimit);
  });

  it('uses the approved Chinese add-text copy as the Chinese default object text', () => {
    setLang('zh');
    const { dispatch } = renderEditor(state());

    fireEvent.click(screen.getByRole('button', { name: '加字' }));

    expect((lastState(dispatch).objects[0] as TextObject).text).toBe('加字');
  });

  it('commits each selected-object layer, copy, and delete operation immediately', () => {
    const editorHistory = history();
    const { dispatch } = renderEditor(state([image('a'), image('b')], 'a'), {
      history: editorHistory,
    });

    fireEvent.click(screen.getByRole('button', { name: 'RAISE' }));
    expect(lastState(dispatch).objects.map(({ id }) => id)).toEqual(['b', 'a']);

    fireEvent.click(screen.getByRole('button', { name: 'LOWER' }));
    expect(lastState(dispatch).objects.map(({ id }) => id)).toEqual(['a', 'b']);

    fireEvent.click(screen.getByRole('button', { name: 'COPY' }));
    expect(lastState(dispatch)).toMatchObject({
      selectedId: 'image-1',
      objects: [{ id: 'a' }, { id: 'b' }, { id: 'image-1', x: 35, y: 35 }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }));
    expect(lastState(dispatch).objects.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(lastState(dispatch).selectedId).toBeNull();
    expect(editorHistory.commit).toHaveBeenCalledTimes(4);
  });

  it('routes image, download, and done buttons to their owning callbacks', () => {
    const onAddImage = vi.fn();
    const onDownload = vi.fn();
    const onExit = vi.fn();
    renderEditor(state([image('artwork')]), { onAddImage, onDownload, onExit });

    fireEvent.click(screen.getByRole('button', { name: 'IMAGE' }));
    fireEvent.click(screen.getByRole('button', { name: 'ARTWORK PNG' }));
    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(onAddImage).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('removes whitespace-only text through effectiveObjects before Done exits', () => {
    const editorHistory = history();
    const onExit = vi.fn();
    const artwork = image('artwork');
    const blank = text('blank', { text: ' \n\t ' });
    const { dispatch } = renderEditor(state([artwork, blank], 'blank'), {
      history: editorHistory,
      onExit,
    });

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(lastState(dispatch)).toEqual({ objects: [artwork], selectedId: null });
    expect(editorHistory.commit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('retains a valid selection while Done removes a different blank text object', () => {
    const artwork = image('artwork');
    const { dispatch } = renderEditor(state([
      artwork,
      text('blank', { text: ' ' }),
    ], artwork.id));

    fireEvent.click(screen.getByRole('button', { name: 'DONE' }));

    expect(lastState(dispatch)).toEqual({ objects: [artwork], selectedId: artwork.id });
  });

  it.each([
    ['an empty editor', state(), true],
    ['whitespace-only text', state([text('blank', { text: ' \n\t ' })]), true],
    ['an effective object', state([image('artwork')]), false],
  ] as const)('sets artwork download disabled correctly for %s', (_name, initialState, disabled) => {
    renderEditor(initialState);

    if (disabled) expect(screen.getByRole('button', { name: 'ARTWORK PNG' })).toBeDisabled();
    else expect(screen.getByRole('button', { name: 'ARTWORK PNG' })).toBeEnabled();
  });
});
