import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { AssetRegistry } from '@/ui/editor/editor-assets';
import {
  createHistory,
  effectiveObjects,
  reduce,
  type EditorAction,
  type EditorObject,
  type EditorState,
  type ImageObject,
  type TextObject,
} from '@/ui/editor/editor-state';

const FRAME_SPAN = 200;
const FRAME_CENTER = { frameCenterX: -30, frameCenterY: 12 } as const;

function image(id: string, overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id,
    kind: 'image',
    assetId: `asset-${id}`,
    x: 40,
    y: 50,
    rotation: 0,
    widthMm: 60,
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
    x: 40,
    y: 50,
    rotation: 0,
    ...overrides,
  };
}

function state(objects: EditorObject[] = [], selectedId: string | null = null): EditorState {
  return { objects, selectedId };
}

function bitmap(): ImageBitmap {
  return { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
}

function retainSnapshotAssets(registry: AssetRegistry, objects: EditorObject[]): void {
  for (const object of objects) {
    if (object.kind === 'image') registry.retain(object.assetId);
  }
}

function releaseSnapshotAssets(registry: AssetRegistry, objects: EditorObject[]): void {
  for (const object of objects) {
    if (object.kind === 'image') registry.release(object.assetId);
  }
}

describe('editor state defaults', () => {
  it('adds an image at the global frame center with 40% of frame.span width', () => {
    const next = reduce(state(), {
      type: 'addImage',
      assetId: 'asset-1',
      aspect: 2,
      frameSpan: FRAME_SPAN,
      ...FRAME_CENTER,
    });

    expect(next.objects).toHaveLength(1);
    expect(next.objects[0]).toEqual({
      id: expect.any(String),
      kind: 'image',
      assetId: 'asset-1',
      x: -30,
      y: 12,
      rotation: 0,
      widthMm: 80,
    });
    expect(next.selectedId).toBe(next.objects[0]!.id);
  });

  it.each(['TEXT', '文字'])(
    'adds text with the caller-provided localized default %s',
    (defaultText) => {
      const next = reduce(state(), {
        type: 'addText', frameSpan: FRAME_SPAN, defaultText, ...FRAME_CENTER,
      });

      expect(next.objects).toHaveLength(1);
      expect(next.objects[0]).toEqual({
        id: expect.any(String),
        kind: 'text',
        text: defaultText,
        fontFamily: 'sans',
        fontSizeMm: 10,
        align: 'center',
        color: 'ink',
        x: -30,
        y: 12,
        rotation: 0,
      });
      expect(next.selectedId).toBe(next.objects[0]!.id);
    },
  );

  it.each([
    { aspect: 1, expectedWidth: 200 },
    { aspect: 2, expectedWidth: 200 },
    { aspect: 0.5, expectedWidth: 100 },
  ])('seeds aspect $aspect centered with its long side equal to frame.span', ({ aspect, expectedWidth }) => {
    const next = reduce(state(), {
      type: 'seedFromUpload',
      assetId: `asset-${aspect}`,
      aspect,
      frameSpan: FRAME_SPAN,
      ...FRAME_CENTER,
    });

    expect(next.objects[0]).toMatchObject({
      kind: 'image',
      assetId: `asset-${aspect}`,
      x: -30,
      y: 12,
      rotation: 0,
      widthMm: expectedWidth,
    });
  });

  it('keeps addText as a silent no-op when span below 40mm makes its default size under 2mm', () => {
    const original = state();

    expect(reduce(original, {
      type: 'addText', frameSpan: 39, defaultText: 'TEXT', ...FRAME_CENTER,
    })).toBe(original);
  });

  it('keeps addImage as a silent no-op when span below 5mm makes its default size under 2mm', () => {
    const original = state();

    expect(reduce(original, {
      type: 'addImage', assetId: 'asset-small', aspect: 1, frameSpan: 4, ...FRAME_CENTER,
    })).toBe(original);
  });
});

describe('reduce action matrix', () => {
  it('moves an object without mutating the previous state', () => {
    const originalObject = image('a');
    const original = state([originalObject], 'a');
    const next = reduce(original, { type: 'move', id: 'a', x: -12, y: 260 });

    expect(next).toEqual(state([image('a', { x: -12, y: 260 })], 'a'));
    expect(next).not.toBe(original);
    expect(next.objects).not.toBe(original.objects);
    expect(next.objects[0]).not.toBe(originalObject);
    expect(original).toEqual(state([image('a')], 'a'));
  });

  it('resizes an image', () => {
    const next = reduce(state([image('a')]), {
      type: 'resize',
      id: 'a',
      widthMm: 125,
      frameSpan: FRAME_SPAN,
    });

    expect(next.objects[0]).toEqual(image('a', { widthMm: 125 }));
  });

  it('rotates an image and normalizes -540 degrees to -180', () => {
    const next = reduce(state([image('a')]), { type: 'rotate', id: 'a', rotation: -540 });
    expect(next.objects[0]).toEqual(image('a', { rotation: -180 }));
  });

  it('patches editable text fields', () => {
    const next = reduce(state([text('a')]), {
      type: 'setText',
      id: 'a',
      frameSpan: FRAME_SPAN,
      patch: {
        text: '盒子\nBOX',
        fontFamily: 'serif',
        fontSizeMm: 24,
        align: 'right',
        color: 'brass',
      },
    });

    expect(next.objects[0]).toEqual(text('a', {
      text: '盒子\nBOX',
      fontFamily: 'serif',
      fontSizeMm: 24,
      align: 'right',
      color: 'brass',
    }));
  });

  it('excludes identity fields from setText patches', () => {
    type SetTextPatch = Extract<EditorAction, { type: 'setText' }>['patch'];

    expectTypeOf<SetTextPatch>().not.toHaveProperty('id');
    expectTypeOf<SetTextPatch>().not.toHaveProperty('kind');
  });

  it('raises an object by one layer', () => {
    const next = reduce(state([image('a'), text('b'), image('c')]), { type: 'layerUp', id: 'b' });
    expect(next.objects.map((object) => object.id)).toEqual(['a', 'c', 'b']);
  });

  it('lowers an object by one layer', () => {
    const next = reduce(state([image('a'), text('b'), image('c')]), { type: 'layerDown', id: 'b' });
    expect(next.objects.map((object) => object.id)).toEqual(['b', 'a', 'c']);
  });

  it('duplicates an object five millimeters down and right with a unique id', () => {
    const original = image('a');
    const next = reduce(state([original]), { type: 'duplicate', id: 'a' });
    const copy = next.objects[1];

    expect(copy).toEqual({ ...original, id: expect.any(String), x: 45, y: 55 });
    expect(copy!.id).not.toBe(original.id);
    expect(next.selectedId).toBe(copy!.id);
  });

  it('deletes an object and clears its selection', () => {
    const next = reduce(state([image('a'), text('b')], 'a'), { type: 'delete', id: 'a' });
    expect(next).toEqual(state([text('b')], null));
  });

  it('selects an existing object and clears selection', () => {
    const original = state([image('a')]);
    const selected = reduce(original, { type: 'select', id: 'a' });
    const cleared = reduce(selected, { type: 'select', id: null });

    expect(selected.selectedId).toBe('a');
    expect(cleared.selectedId).toBeNull();
    expect(selected.objects).toBe(original.objects);
    expect(cleared.objects).toBe(original.objects);
  });

  it('returns the original state for missing targets or layer boundary no-ops', () => {
    const original = state([image('a'), text('b')]);

    expect(reduce(original, { type: 'move', id: 'missing', x: 1, y: 2 })).toBe(original);
    expect(reduce(original, { type: 'resize', id: 'b', widthMm: 10, frameSpan: FRAME_SPAN })).toBe(original);
    expect(reduce(original, { type: 'setText', id: 'a', patch: { text: 'x' }, frameSpan: FRAME_SPAN })).toBe(original);
    expect(reduce(original, { type: 'layerDown', id: 'a' })).toBe(original);
    expect(reduce(original, { type: 'layerUp', id: 'b' })).toBe(original);
    expect(reduce(original, { type: 'select', id: 'missing' })).toBe(original);
  });
});

describe('reducer value guards', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid frameSpan %s for actions that require it',
    (frameSpan) => {
      const original = state([image('a'), text('b')]);

      expect(reduce(original, {
        type: 'addImage', assetId: 'new', aspect: 1, frameSpan, ...FRAME_CENTER,
      })).toBe(original);
      expect(reduce(original, {
        type: 'addText', frameSpan, defaultText: 'TEXT', ...FRAME_CENTER,
      })).toBe(original);
      expect(reduce(original, {
        type: 'seedFromUpload', assetId: 'new', aspect: 1, frameSpan, ...FRAME_CENTER,
      })).toBe(original);
      expect(reduce(original, { type: 'resize', id: 'a', widthMm: 20, frameSpan })).toBe(original);
      expect(reduce(original, { type: 'setText', id: 'b', patch: { fontSizeMm: 20 }, frameSpan })).toBe(original);
    },
  );

  it.each([
    { frameCenterX: Number.NaN, frameCenterY: 12 },
    { frameCenterX: -30, frameCenterY: Number.NaN },
    { frameCenterX: Number.POSITIVE_INFINITY, frameCenterY: 12 },
    { frameCenterX: -30, frameCenterY: Number.POSITIVE_INFINITY },
    { frameCenterX: Number.NEGATIVE_INFINITY, frameCenterY: 12 },
    { frameCenterX: -30, frameCenterY: Number.NEGATIVE_INFINITY },
  ])(
    'rejects non-finite frame center $frameCenterX, $frameCenterY',
    ({ frameCenterX, frameCenterY }) => {
      const original = state();
      const frameCenter = { frameCenterX, frameCenterY };

      expect(reduce(original, {
        type: 'addImage', assetId: 'new', aspect: 1, frameSpan: FRAME_SPAN, ...frameCenter,
      })).toBe(original);
      expect(reduce(original, {
        type: 'addText', frameSpan: FRAME_SPAN, defaultText: 'TEXT', ...frameCenter,
      })).toBe(original);
      expect(reduce(original, {
        type: 'seedFromUpload', assetId: 'new', aspect: 1, frameSpan: FRAME_SPAN, ...frameCenter,
      })).toBe(original);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid image aspect %s',
    (aspect) => {
      const original = state();
      expect(reduce(original, {
        type: 'addImage', assetId: 'new', aspect, frameSpan: FRAME_SPAN, ...FRAME_CENTER,
      })).toBe(original);
      expect(reduce(original, {
        type: 'seedFromUpload', assetId: 'new', aspect, frameSpan: FRAME_SPAN, ...FRAME_CENTER,
      })).toBe(original);
    },
  );

  it.each([
    { x: Number.NaN, y: 10 },
    { x: 10, y: Number.POSITIVE_INFINITY },
    { x: Number.NEGATIVE_INFINITY, y: 10 },
  ])('rejects non-finite move coordinates $x, $y', ({ x, y }) => {
    const original = state([image('a')]);
    expect(reduce(original, { type: 'move', id: 'a', x, y })).toBe(original);
  });

  it.each([0, -1, 1.99, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2000.01])(
    'rejects out-of-domain image width %s',
    (widthMm) => {
      const original = state([image('a')]);
      expect(reduce(original, { type: 'resize', id: 'a', widthMm, frameSpan: FRAME_SPAN })).toBe(original);
    },
  );

  it.each([0, -1, 1.99, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2000.01])(
    'rejects out-of-domain font size %s',
    (fontSizeMm) => {
      const original = state([text('a')]);
      expect(reduce(original, {
        type: 'setText',
        id: 'a',
        patch: { fontSizeMm },
        frameSpan: FRAME_SPAN,
      })).toBe(original);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite rotation %s',
    (rotation) => {
      const original = state([image('a')]);
      expect(reduce(original, { type: 'rotate', id: 'a', rotation })).toBe(original);
    },
  );

  it.each([
    { rotation: 0, normalized: 0 },
    { rotation: -180, normalized: -180 },
    { rotation: 180, normalized: -180 },
    { rotation: 181, normalized: -179 },
    { rotation: 540, normalized: -180 },
    { rotation: -181, normalized: 179 },
    { rotation: -540, normalized: -180 },
  ])('normalizes $rotation degrees to $normalized', ({ rotation, normalized }) => {
    const next = reduce(state([image('a')]), { type: 'rotate', id: 'a', rotation });
    expect(next.objects[0]).toEqual(image('a', { rotation: normalized }));
  });

  it.each(['addImage', 'addText', 'seedFromUpload', 'duplicate'] as const)(
    'rejects the 33rd object for %s',
    (type) => {
      const objects = Array.from({ length: 32 }, (_, index) => text(`text-${index + 1}`));
      const original = state(objects);
      let action: EditorAction;

      if (type === 'addImage') {
        action = { type, assetId: 'new', aspect: 1, frameSpan: FRAME_SPAN, ...FRAME_CENTER };
      } else if (type === 'addText') {
        action = { type, frameSpan: FRAME_SPAN, defaultText: 'TEXT', ...FRAME_CENTER };
      } else if (type === 'seedFromUpload') {
        action = { type, assetId: 'new', aspect: 1, frameSpan: FRAME_SPAN, ...FRAME_CENTER };
      } else {
        action = { type, id: objects[0]!.id };
      }

      expect(reduce(original, action)).toBe(original);
    },
  );
});

describe('history', () => {
  const reversibleCases: Array<{ name: string; baseline: EditorState; action: EditorAction }> = [
    {
      name: 'addImage',
      baseline: state(),
      action: { type: 'addImage', assetId: 'asset', aspect: 1, frameSpan: FRAME_SPAN, ...FRAME_CENTER },
    },
    {
      name: 'addText',
      baseline: state(),
      action: { type: 'addText', frameSpan: FRAME_SPAN, defaultText: 'TEXT', ...FRAME_CENTER },
    },
    {
      name: 'seedFromUpload',
      baseline: state(),
      action: {
        type: 'seedFromUpload', assetId: 'asset', aspect: 2, frameSpan: FRAME_SPAN, ...FRAME_CENTER,
      },
    },
    { name: 'move', baseline: state([image('a')]), action: { type: 'move', id: 'a', x: 10, y: 20 } },
    { name: 'resize', baseline: state([image('a')]), action: { type: 'resize', id: 'a', widthMm: 100, frameSpan: FRAME_SPAN } },
    { name: 'rotate', baseline: state([image('a')]), action: { type: 'rotate', id: 'a', rotation: 45 } },
    { name: 'setText', baseline: state([text('a')]), action: { type: 'setText', id: 'a', patch: { text: 'changed' }, frameSpan: FRAME_SPAN } },
    { name: 'layerUp', baseline: state([image('a'), text('b')]), action: { type: 'layerUp', id: 'a' } },
    { name: 'layerDown', baseline: state([image('a'), text('b')]), action: { type: 'layerDown', id: 'b' } },
    { name: 'duplicate', baseline: state([image('a')]), action: { type: 'duplicate', id: 'a' } },
    { name: 'delete', baseline: state([image('a')]), action: { type: 'delete', id: 'a' } },
  ];

  it.each(reversibleCases)('undoes and redoes $name', ({ baseline, action }) => {
    const history = createHistory(baseline);
    const changed = reduce(baseline, action);
    history.commit(changed);

    expect(history.undo()?.objects).toEqual(baseline.objects);
    expect(history.redo()?.objects).toEqual(changed.objects);
  });

  it('treats a seeded state as the baseline and cannot undo it', () => {
    const seeded = reduce(state(), {
      type: 'seedFromUpload',
      assetId: 'seed',
      aspect: 2,
      frameSpan: FRAME_SPAN,
      ...FRAME_CENTER,
    });
    const history = createHistory(seeded);

    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it('allows exactly 50 undos and drops the oldest snapshot on commit 51', () => {
    const baseline = state([image('a', { x: 0 })]);
    const history = createHistory(baseline);

    for (let x = 1; x <= 51; x += 1) {
      history.commit(state([image('a', { x })]));
    }

    const undoneX: number[] = [];
    for (let count = 0; count < 50; count += 1) {
      const undone = history.undo();
      expect(undone).not.toBeNull();
      undoneX.push(undone!.objects[0]!.x);
    }

    expect(undoneX).toEqual(Array.from({ length: 50 }, (_, index) => 50 - index));
    expect(history.undo()).toBeNull();

    const redoneX: number[] = [];
    for (let count = 0; count < 50; count += 1) {
      const redone = history.redo();
      expect(redone).not.toBeNull();
      redoneX.push(redone!.objects[0]!.x);
    }
    expect(redoneX).toEqual(Array.from({ length: 50 }, (_, index) => index + 2));
    expect(history.redo()).toBeNull();
  });

  it('drops the redo branch when a new state is committed', () => {
    const baseline = state([image('a', { x: 0 })]);
    const history = createHistory(baseline);
    history.commit(state([image('a', { x: 1 })]));
    history.commit(state([image('a', { x: 2 })]));

    expect(history.undo()?.objects[0]!.x).toBe(1);
    history.commit(state([image('a', { x: 10 })]));

    expect(history.redo()).toBeNull();
    expect(history.undo()?.objects[0]!.x).toBe(1);
  });

  it('releases every discarded redo snapshot and closes only its final asset reference', () => {
    const registry = new AssetRegistry();
    const sharedBitmap = bitmap();
    const tailBitmap = bitmap();
    const sharedAssetId = registry.add(sharedBitmap);
    const baseline = state([image('shared', { assetId: sharedAssetId })]);
    const retain = vi.spyOn(registry, 'retain');
    const release = vi.spyOn(registry, 'release');
    retainSnapshotAssets(registry, baseline.objects);
    const onEvict = vi.fn((snapshot: EditorObject[]) => {
      releaseSnapshotAssets(registry, snapshot);
    });
    const history = createHistory(baseline, onEvict);

    const first = state([image('shared', { assetId: sharedAssetId, x: 1 })]);
    retainSnapshotAssets(registry, first.objects);
    history.commit(first);

    const tailAssetId = registry.add(tailBitmap);
    const second = state([
      image('shared', { assetId: sharedAssetId, x: 2 }),
      image('tail', { assetId: tailAssetId }),
    ]);
    retainSnapshotAssets(registry, second.objects);
    history.commit(second);

    expect(history.undo()?.objects).toEqual(first.objects);
    expect(history.undo()?.objects).toEqual(baseline.objects);
    registry.release(tailAssetId);
    expect(onEvict).not.toHaveBeenCalled();
    release.mockClear();

    const branch = state([image('shared', { assetId: sharedAssetId, x: 10 })]);
    retainSnapshotAssets(registry, branch.objects);
    history.commit(branch);

    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(onEvict.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      first.objects,
      second.objects,
    ]);
    expect(retain.mock.calls).toEqual([
      [sharedAssetId],
      [sharedAssetId],
      [sharedAssetId],
      [tailAssetId],
      [sharedAssetId],
    ]);
    expect(release.mock.calls).toEqual([
      [sharedAssetId],
      [sharedAssetId],
      [tailAssetId],
    ]);
    expect(tailBitmap.close).toHaveBeenCalledOnce();
    expect(sharedBitmap.close).not.toHaveBeenCalled();
    expect(history.redo()).toBeNull();
    expect(onEvict).toHaveBeenCalledTimes(2);
  });

  it('releases the oldest snapshot at the history limit without closing a shared asset', () => {
    const registry = new AssetRegistry();
    const oldestBitmap = bitmap();
    const sharedBitmap = bitmap();
    const oldestAssetId = registry.add(oldestBitmap);
    const sharedAssetId = registry.add(sharedBitmap);
    const baseline = state([
      image('oldest', { assetId: oldestAssetId }),
      image('shared', { assetId: sharedAssetId }),
    ]);
    const retain = vi.spyOn(registry, 'retain');
    const release = vi.spyOn(registry, 'release');
    retainSnapshotAssets(registry, baseline.objects);
    const onEvict = vi.fn((snapshot: EditorObject[]) => {
      releaseSnapshotAssets(registry, snapshot);
    });
    const history = createHistory(baseline, onEvict);

    registry.release(oldestAssetId);
    release.mockClear();
    for (let x = 1; x <= 51; x += 1) {
      const next = state([image('shared', { assetId: sharedAssetId, x })]);
      retainSnapshotAssets(registry, next.objects);
      history.commit(next);
    }

    expect(onEvict).toHaveBeenCalledOnce();
    expect(onEvict).toHaveBeenCalledWith(baseline.objects);
    expect(retain).toHaveBeenCalledTimes(53);
    expect(retain).toHaveBeenNthCalledWith(1, oldestAssetId);
    expect(retain).toHaveBeenNthCalledWith(2, sharedAssetId);
    expect(retain).toHaveBeenNthCalledWith(53, sharedAssetId);
    expect(release.mock.calls).toEqual([
      [oldestAssetId],
      [sharedAssetId],
    ]);
    expect(oldestBitmap.close).toHaveBeenCalledOnce();
    expect(sharedBitmap.close).not.toHaveBeenCalled();

    history.undo();
    history.redo();
    expect(onEvict).toHaveBeenCalledOnce();
  });

  it('stores immutable object snapshots without restoring selectedId', () => {
    const baseline = state([image('a')], 'a');
    const committedObject = image('a', { x: 80 });
    const committed = state([committedObject], 'a');
    const history = createHistory(baseline);
    history.commit(committed);

    committedObject.x = 999;
    const undone = history.undo();
    const redone = history.redo();

    expect(undone).toEqual(state([image('a')], null));
    expect(redone).toEqual(state([image('a', { x: 80 })], null));
  });
});

describe('effectiveObjects', () => {
  it('removes empty and whitespace-only text while preserving order and non-text objects', () => {
    const keptImage = image('image');
    const keptText = text('kept', { text: '  BOX  ' });
    const original = state([
      text('empty', { text: '' }),
      keptImage,
      text('spaces', { text: ' \n\t ' }),
      keptText,
    ]);

    expect(effectiveObjects(original)).toEqual([keptImage, keptText]);
    expect(original.objects).toHaveLength(4);
  });
});
