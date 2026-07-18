import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ArtworkLayout } from '@/ui/artwork-layout';
import type { AssetRegistry } from '@/ui/editor/editor-assets';
import EditorView, { type EditorViewProps } from '@/ui/editor/EditorView';
import type {
  EditorObject,
  EditorState,
  History,
  ImageObject,
  TextObject,
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
  onExit?: Mock<() => void>;
  dpr?: number;
  viewCssPx?: number;
}

function renderEditor(initialState: EditorState, options: RenderOptions = {}) {
  const dispatch = vi.fn<(nextState: EditorState) => void>();
  const editorHistory = options.history ?? history();
  const onExit = options.onExit ?? vi.fn();
  const props = {
    history: editorHistory,
    layout,
    registry,
    viewCssPx: options.viewCssPx ?? 100,
    dpr: options.dpr ?? 1,
    labels: { canvas: 'Artwork editor canvas' },
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
  return { ...view, dispatch, history: editorHistory, interaction, onExit };
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
