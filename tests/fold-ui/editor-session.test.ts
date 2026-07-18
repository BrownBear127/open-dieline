import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtworkLayout } from '@/ui/artwork-layout';
import type { EditableArtworkAsset } from '@/ui/artwork-source';
import {
  addEditableArtwork,
  createEditorSession,
  destroyEditorSession,
  updateEditorSessionState,
} from '@/ui/editor/editor-session';
import { composeArtwork } from '@/ui/editor/editor-compose';
import { reduce } from '@/ui/editor/editor-state';

const LAYOUT: ArtworkLayout = {
  panels: [],
  frame: { minX: -40, minY: 10, span: 200, offsetX: 20, offsetY: 0 },
};

function editable(width: number, height: number, revision = 1): EditableArtworkAsset {
  return {
    bitmap: { width, height, close: vi.fn() } as unknown as ImageBitmap,
    width,
    height,
    revision,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('EditorSession seed and ownership', () => {
  it('maps the square A-1 seed pixel-for-pixel onto the 2048 square composition', () => {
    const asset = editable(100, 100);
    const session = createEditorSession('layout-a', LAYOUT, asset);
    const context = {
      save: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      drawImage: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);

    const canvas = composeArtwork(
      session.state,
      LAYOUT,
      2048,
      { guides: false },
      session.assetRegistry,
    );

    expect(canvas).toMatchObject({ width: 2048, height: 2048 });
    expect(context.translate).toHaveBeenCalledExactlyOnceWith(1024, 1024);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(
      asset.bitmap,
      -1024,
      -1024,
      2048,
      2048,
    );
    destroyEditorSession(session);
  });

  it.each([
    ['square', 100, 100, 200],
    ['landscape 2:1', 200, 100, 200],
    ['portrait 1:2', 100, 200, 100],
  ] as const)('seeds a centred aspect-preserving %s baseline that cannot be undone', (
    _name,
    width,
    height,
    expectedWidthMm,
  ) => {
    const asset = editable(width, height);
    const session = createEditorSession('layout-a', LAYOUT, asset);

    expect(session.state.objects).toEqual([
      expect.objectContaining({
        kind: 'image',
        x: 40,
        y: 110,
        widthMm: expectedWidthMm,
      }),
    ]);
    expect(session.history.undo()).toBeNull();

    destroyEditorSession(session);
    expect(asset.bitmap.close).toHaveBeenCalledOnce();
  });

  it('counts current state and every history snapshot, including redo eviction, then closes once', () => {
    const asset = editable(200, 100);
    let session = createEditorSession('layout-a', LAYOUT, asset);
    const seeded = session.state;
    const imageId = seeded.objects[0]!.id;

    const moved = reduce(session.state, { type: 'move', id: imageId, x: 75, y: 90 });
    session = updateEditorSessionState(session, moved);
    session.history.commit(moved);

    const removed = reduce(session.state, { type: 'delete', id: imageId });
    session = updateEditorSessionState(session, removed);
    session.history.commit(removed);
    expect(asset.bitmap.close).not.toHaveBeenCalled();

    const restored = session.history.undo()!;
    session = updateEditorSessionState(session, restored);
    expect(session.history.undo()).not.toBeNull();
    session.history.commit(seeded);

    destroyEditorSession(session);
    destroyEditorSession(session);
    expect(asset.bitmap.close).toHaveBeenCalledOnce();
  });

  it('adds a new upload as the top layer with the same long-edge centring rule', () => {
    const seed = editable(100, 100, 1);
    const upload = editable(100, 200, 2);
    let session = createEditorSession('layout-a', LAYOUT, seed);

    session = addEditableArtwork(session, upload, LAYOUT);

    expect(session.state.objects).toHaveLength(2);
    expect(session.state.objects.at(-1)).toEqual(expect.objectContaining({
      kind: 'image',
      assetId: 'asset-2',
      x: 40,
      y: 110,
      widthMm: 100,
    }));
    expect(session.history.undo()?.objects).toHaveLength(1);

    destroyEditorSession(session);
    expect(seed.bitmap.close).toHaveBeenCalledOnce();
    expect(upload.bitmap.close).toHaveBeenCalledOnce();
  });

  it('increments contentRevision only when object content changes, not when selection changes', () => {
    let session = createEditorSession('layout-a', LAYOUT);
    expect(session.contentRevision).toBe(0);

    const withText = reduce(session.state, {
      type: 'addText',
      frameSpan: LAYOUT.frame.span,
      frameCenterX: 40,
      frameCenterY: 110,
      defaultText: 'TEXT',
    });
    session = updateEditorSessionState(session, withText);
    expect(session.contentRevision).toBe(1);

    const deselected = reduce(session.state, { type: 'select', id: null });
    session = updateEditorSessionState(session, deselected);
    expect(session.contentRevision).toBe(1);

    destroyEditorSession(session);
  });
});
