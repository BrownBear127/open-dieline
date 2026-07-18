export type InkPaletteColor = 'ink' | 'inkSoft' | 'cut' | 'crease' | 'brass';

export interface ObjectBase {
  id: string;
  x: number;
  y: number;
  rotation: number;
}

export interface ImageObject extends ObjectBase {
  kind: 'image';
  assetId: string;
  widthMm: number;
}

export interface TextObject extends ObjectBase {
  kind: 'text';
  text: string;
  fontFamily: 'sans' | 'serif' | 'mono';
  fontSizeMm: number;
  align: 'left' | 'center' | 'right';
  color: InkPaletteColor;
}

export type EditorObject = ImageObject | TextObject;

export interface EditorState {
  objects: EditorObject[];
  selectedId: string | null;
}

export type EditorAction =
  | {
    type: 'addImage';
    assetId: string;
    aspect: number;
    frameSpan: number;
    frameCenterX: number;
    frameCenterY: number;
  }
  | {
    type: 'addText';
    frameSpan: number;
    frameCenterX: number;
    frameCenterY: number;
    defaultText: string;
  }
  | {
    type: 'seedFromUpload';
    assetId: string;
    aspect: number;
    frameSpan: number;
    frameCenterX: number;
    frameCenterY: number;
  }
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'resize'; id: string; widthMm: number; frameSpan: number }
  | { type: 'rotate'; id: string; rotation: number }
  | {
    type: 'setText';
    id: string;
    patch: Partial<Omit<TextObject, 'id' | 'kind'>>;
    frameSpan: number;
  }
  | { type: 'layerUp' | 'layerDown' | 'duplicate' | 'delete'; id: string }
  | { type: 'select'; id: string | null };

export interface History {
  commit(s: EditorState): void;
  undo(): EditorState | null;
  redo(): EditorState | null;
}

export const MAX_EDITOR_OBJECTS = 32;
const MAX_HISTORY_OPERATIONS = 50;
const MIN_SIZE_MM = 2;
const DUPLICATE_OFFSET_MM = 5;

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteFrameCenter(frameCenterX: number, frameCenterY: number): boolean {
  return Number.isFinite(frameCenterX) && Number.isFinite(frameCenterY);
}

function isValidSize(value: number, frameSpan: number): boolean {
  return isFinitePositive(frameSpan)
    && Number.isFinite(value)
    && value >= MIN_SIZE_MM
    && value <= frameSpan * 10;
}

function normalizeRotation(rotation: number): number {
  const positive = ((rotation % 360) + 360) % 360;
  return positive >= 180 ? positive - 360 : positive;
}

function nextObjectId(objects: EditorObject[], kind: EditorObject['kind']): string {
  const ids = new Set(objects.map((object) => object.id));
  let sequence = 1;
  while (ids.has(`${kind}-${sequence}`)) sequence += 1;
  return `${kind}-${sequence}`;
}

function appendObject(state: EditorState, object: EditorObject): EditorState {
  return {
    objects: [...state.objects, object],
    selectedId: object.id,
  };
}

function replaceObject(state: EditorState, index: number, object: EditorObject): EditorState {
  const objects = [...state.objects];
  objects[index] = object;
  return { ...state, objects };
}

function addImage(state: EditorState, action: Extract<EditorAction, { type: 'addImage' }>): EditorState {
  if (
    state.objects.length >= MAX_EDITOR_OBJECTS
    || !isFinitePositive(action.frameSpan)
    || !isFinitePositive(action.aspect)
    || !isFiniteFrameCenter(action.frameCenterX, action.frameCenterY)
  ) return state;

  const widthMm = action.frameSpan * 0.4;
  if (!isValidSize(widthMm, action.frameSpan)) return state;

  return appendObject(state, {
    id: nextObjectId(state.objects, 'image'),
    kind: 'image',
    assetId: action.assetId,
    x: action.frameCenterX,
    y: action.frameCenterY,
    rotation: 0,
    widthMm,
  });
}

function addText(state: EditorState, action: Extract<EditorAction, { type: 'addText' }>): EditorState {
  if (
    state.objects.length >= MAX_EDITOR_OBJECTS
    || !isFinitePositive(action.frameSpan)
    || !isFiniteFrameCenter(action.frameCenterX, action.frameCenterY)
  ) return state;

  const fontSizeMm = action.frameSpan * 0.05;
  if (!isValidSize(fontSizeMm, action.frameSpan)) return state;

  return appendObject(state, {
    id: nextObjectId(state.objects, 'text'),
    kind: 'text',
    text: action.defaultText,
    fontFamily: 'sans',
    fontSizeMm,
    align: 'center',
    color: 'ink',
    x: action.frameCenterX,
    y: action.frameCenterY,
    rotation: 0,
  });
}

function seedFromUpload(
  state: EditorState,
  action: Extract<EditorAction, { type: 'seedFromUpload' }>,
): EditorState {
  if (
    state.objects.length >= MAX_EDITOR_OBJECTS
    || !isFinitePositive(action.frameSpan)
    || !isFinitePositive(action.aspect)
    || !isFiniteFrameCenter(action.frameCenterX, action.frameCenterY)
  ) return state;

  const widthMm = action.aspect >= 1 ? action.frameSpan : action.frameSpan * action.aspect;
  if (!isValidSize(widthMm, action.frameSpan)) return state;

  return appendObject(state, {
    id: nextObjectId(state.objects, 'image'),
    kind: 'image',
    assetId: action.assetId,
    x: action.frameCenterX,
    y: action.frameCenterY,
    rotation: 0,
    widthMm,
  });
}

function move(state: EditorState, action: Extract<EditorAction, { type: 'move' }>): EditorState {
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) return state;
  const index = state.objects.findIndex((object) => object.id === action.id);
  if (index < 0) return state;
  return replaceObject(state, index, { ...state.objects[index]!, x: action.x, y: action.y });
}

function resize(state: EditorState, action: Extract<EditorAction, { type: 'resize' }>): EditorState {
  if (!isValidSize(action.widthMm, action.frameSpan)) return state;
  const index = state.objects.findIndex((object) => object.id === action.id && object.kind === 'image');
  if (index < 0) return state;
  const object = state.objects[index] as ImageObject;
  return replaceObject(state, index, { ...object, widthMm: action.widthMm });
}

function rotate(state: EditorState, action: Extract<EditorAction, { type: 'rotate' }>): EditorState {
  if (!Number.isFinite(action.rotation)) return state;
  const index = state.objects.findIndex((object) => object.id === action.id);
  if (index < 0) return state;
  return replaceObject(state, index, {
    ...state.objects[index]!,
    rotation: normalizeRotation(action.rotation),
  });
}

function setText(state: EditorState, action: Extract<EditorAction, { type: 'setText' }>): EditorState {
  if (!isFinitePositive(action.frameSpan)) return state;
  if (action.patch.fontSizeMm !== undefined && !isValidSize(action.patch.fontSizeMm, action.frameSpan)) return state;
  if (action.patch.x !== undefined && !Number.isFinite(action.patch.x)) return state;
  if (action.patch.y !== undefined && !Number.isFinite(action.patch.y)) return state;
  if (action.patch.rotation !== undefined && !Number.isFinite(action.patch.rotation)) return state;

  const index = state.objects.findIndex((object) => object.id === action.id && object.kind === 'text');
  if (index < 0) return state;

  const current = state.objects[index] as TextObject;
  const next: TextObject = { ...current };
  if (action.patch.text !== undefined) next.text = action.patch.text;
  if (action.patch.fontFamily !== undefined) next.fontFamily = action.patch.fontFamily;
  if (action.patch.fontSizeMm !== undefined) next.fontSizeMm = action.patch.fontSizeMm;
  if (action.patch.align !== undefined) next.align = action.patch.align;
  if (action.patch.color !== undefined) next.color = action.patch.color;
  if (action.patch.x !== undefined) next.x = action.patch.x;
  if (action.patch.y !== undefined) next.y = action.patch.y;
  if (action.patch.rotation !== undefined) next.rotation = normalizeRotation(action.patch.rotation);

  return replaceObject(state, index, next);
}

function changeLayer(
  state: EditorState,
  id: string,
  direction: 'up' | 'down',
): EditorState {
  const index = state.objects.findIndex((object) => object.id === id);
  const nextIndex = direction === 'up' ? index + 1 : index - 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.objects.length) return state;

  const objects = [...state.objects];
  [objects[index], objects[nextIndex]] = [objects[nextIndex]!, objects[index]!];
  return { ...state, objects };
}

function duplicate(state: EditorState, id: string): EditorState {
  if (state.objects.length >= MAX_EDITOR_OBJECTS) return state;
  const object = state.objects.find((candidate) => candidate.id === id);
  if (!object) return state;

  return appendObject(state, {
    ...object,
    id: nextObjectId(state.objects, object.kind),
    x: object.x + DUPLICATE_OFFSET_MM,
    y: object.y + DUPLICATE_OFFSET_MM,
  });
}

function deleteObject(state: EditorState, id: string): EditorState {
  const index = state.objects.findIndex((object) => object.id === id);
  if (index < 0) return state;
  return {
    objects: state.objects.filter((_, objectIndex) => objectIndex !== index),
    selectedId: state.selectedId === id ? null : state.selectedId,
  };
}

function select(state: EditorState, action: Extract<EditorAction, { type: 'select' }>): EditorState {
  if (action.id !== null && !state.objects.some((object) => object.id === action.id)) return state;
  if (action.id === state.selectedId) return state;
  return { ...state, selectedId: action.id };
}

export function reduce(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'addImage': return addImage(state, action);
    case 'addText': return addText(state, action);
    case 'seedFromUpload': return seedFromUpload(state, action);
    case 'move': return move(state, action);
    case 'resize': return resize(state, action);
    case 'rotate': return rotate(state, action);
    case 'setText': return setText(state, action);
    case 'layerUp': return changeLayer(state, action.id, 'up');
    case 'layerDown': return changeLayer(state, action.id, 'down');
    case 'duplicate': return duplicate(state, action.id);
    case 'delete': return deleteObject(state, action.id);
    case 'select': return select(state, action);
  }
}

function cloneObjects(objects: EditorObject[]): EditorObject[] {
  return objects.map((object) => ({ ...object }));
}

function stateFromSnapshot(objects: EditorObject[]): EditorState {
  return { objects: cloneObjects(objects), selectedId: null };
}

export function createHistory(
  baseline: EditorState,
  onEvict?: (snapshot: EditorObject[]) => void,
): History {
  let snapshots: EditorObject[][] = [cloneObjects(baseline.objects)];
  let cursor = 0;

  return {
    commit(nextState) {
      const discardedRedoSnapshots = snapshots.slice(cursor + 1);
      snapshots = snapshots.slice(0, cursor + 1);
      for (const snapshot of discardedRedoSnapshots) onEvict?.(snapshot);
      snapshots.push(cloneObjects(nextState.objects));
      if (snapshots.length > MAX_HISTORY_OPERATIONS + 1) {
        const oldestSnapshot = snapshots.shift();
        if (oldestSnapshot) onEvict?.(oldestSnapshot);
      }
      cursor = snapshots.length - 1;
    },
    undo() {
      if (cursor === 0) return null;
      cursor -= 1;
      return stateFromSnapshot(snapshots[cursor]!);
    },
    redo() {
      if (cursor >= snapshots.length - 1) return null;
      cursor += 1;
      return stateFromSnapshot(snapshots[cursor]!);
    },
  };
}

export function effectiveObjects(state: EditorState): EditorObject[] {
  return state.objects.filter((object) => object.kind !== 'text' || object.text.trim().length > 0);
}
