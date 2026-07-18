import type { ArtworkLayout } from '../artwork-layout';
import type { EditableArtworkAsset } from '../artwork-source';
import { AssetRegistry } from './editor-assets';
import {
  createHistory,
  reduce,
  type EditorObject,
  type EditorState,
  type History,
} from './editor-state';

const OWNERSHIP = Symbol('editor-session-ownership');

class AssetOwnership {
  private readonly references = new Map<string, number>();
  private destroyed = false;

  constructor(private readonly registry: AssetRegistry) {}

  adopt(id: string): void {
    this.assertActive();
    this.references.set(id, (this.references.get(id) ?? 0) + 1);
  }

  retain(id: string): void {
    this.assertActive();
    this.registry.retain(id);
    this.adopt(id);
  }

  release(id: string): void {
    this.assertActive();
    const count = this.references.get(id) ?? 0;
    if (count <= 0) return;
    if (count === 1) this.references.delete(id);
    else this.references.set(id, count - 1);
    this.registry.release(id);
  }

  retainObjects(objects: readonly EditorObject[]): void {
    for (const object of objects) {
      if (object.kind === 'image') this.retain(object.assetId);
    }
  }

  releaseObjects(objects: readonly EditorObject[]): void {
    for (const object of objects) {
      if (object.kind === 'image') this.release(object.assetId);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [id, count] of this.references) {
      for (let index = 0; index < count; index += 1) this.registry.release(id);
    }
    this.references.clear();
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error('Editor session has been destroyed');
  }
}

export interface EditorSession {
  state: EditorState;
  history: History;
  assetRegistry: AssetRegistry;
  alignedLayoutSignature: string;
  contentRevision: number;
  destroy: () => void;
  readonly [OWNERSHIP]: AssetOwnership;
}

function frameCenter(layout: ArtworkLayout): { frameCenterX: number; frameCenterY: number } {
  const { frame } = layout;
  return {
    frameCenterX: frame.minX - frame.offsetX + frame.span / 2,
    frameCenterY: frame.minY - frame.offsetY + frame.span / 2,
  };
}

function createTrackedHistory(
  baseline: EditorState,
  ownership: AssetOwnership,
): History {
  ownership.retainObjects(baseline.objects);
  const history = createHistory(baseline, (snapshot) => ownership.releaseObjects(snapshot));
  return {
    commit(nextState) {
      ownership.retainObjects(nextState.objects);
      history.commit(nextState);
    },
    undo: () => history.undo(),
    redo: () => history.redo(),
  };
}

function assetCounts(objects: readonly EditorObject[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const object of objects) {
    if (object.kind !== 'image') continue;
    counts.set(object.assetId, (counts.get(object.assetId) ?? 0) + 1);
  }
  return counts;
}

function sameObjects(left: readonly EditorObject[], right: readonly EditorObject[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateState(
  session: EditorSession,
  nextState: EditorState,
  prepaidReferences: ReadonlyMap<string, number> = new Map(),
): EditorSession {
  const ownership = session[OWNERSHIP];
  const previous = assetCounts(session.state.objects);
  const next = assetCounts(nextState.objects);
  const assetIds = new Set([...previous.keys(), ...next.keys()]);

  for (const assetId of assetIds) {
    const delta = (next.get(assetId) ?? 0) - (previous.get(assetId) ?? 0);
    const prepaid = prepaidReferences.get(assetId) ?? 0;
    for (let index = prepaid; index < delta; index += 1) ownership.retain(assetId);
    for (let index = 0; index < -delta; index += 1) ownership.release(assetId);
  }

  return {
    ...session,
    state: nextState,
    contentRevision: sameObjects(session.state.objects, nextState.objects)
      ? session.contentRevision
      : session.contentRevision + 1,
  };
}

export function createEditorSession(
  layoutSignature: string,
  layout: ArtworkLayout,
  seed?: EditableArtworkAsset,
): EditorSession {
  const assetRegistry = new AssetRegistry();
  const ownership = new AssetOwnership(assetRegistry);
  let state: EditorState = { objects: [], selectedId: null };

  if (seed !== undefined) {
    const assetId = assetRegistry.add(seed.bitmap);
    ownership.adopt(assetId);
    state = reduce(state, {
      type: 'seedFromUpload',
      assetId,
      aspect: seed.width / seed.height,
      frameSpan: layout.frame.span,
      ...frameCenter(layout),
    });
  }

  return {
    state,
    history: createTrackedHistory(state, ownership),
    assetRegistry,
    alignedLayoutSignature: layoutSignature,
    contentRevision: state.objects.length === 0 ? 0 : 1,
    destroy: () => ownership.destroy(),
    [OWNERSHIP]: ownership,
  };
}

export function updateEditorSessionState(
  session: EditorSession,
  nextState: EditorState,
): EditorSession {
  return updateState(session, nextState);
}

export function addEditableArtwork(
  session: EditorSession,
  asset: EditableArtworkAsset,
  layout: ArtworkLayout,
): EditorSession {
  const assetId = session.assetRegistry.add(asset.bitmap);
  session[OWNERSHIP].adopt(assetId);
  const nextState = reduce(session.state, {
    type: 'seedFromUpload',
    assetId,
    aspect: asset.width / asset.height,
    frameSpan: layout.frame.span,
    ...frameCenter(layout),
  });

  if (nextState === session.state) {
    session[OWNERSHIP].release(assetId);
    return session;
  }

  const updated = updateState(session, nextState, new Map([[assetId, 1]]));
  updated.history.commit(nextState);
  return updated;
}

export function alignEditorSession(
  session: EditorSession,
  layoutSignature: string,
): EditorSession {
  if (session.alignedLayoutSignature === layoutSignature) return session;
  return { ...session, alignedLayoutSignature: layoutSignature };
}

export function destroyEditorSession(session: EditorSession): void {
  session.destroy();
}
