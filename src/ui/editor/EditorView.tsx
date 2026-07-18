import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ArtworkLayout } from '../artwork-layout';
import type { AssetRegistry } from './editor-assets';
import { composeArtwork, fromCanvas, textBlockMetrics } from './editor-compose';
import { snapDelta, type AABB, type SnapTargets } from './editor-snap';
import {
  reduce,
  type EditorAction,
  type EditorObject,
  type EditorState,
  type History,
  type ImageObject,
  type TextObject,
} from './editor-state';

export interface EditorViewLabels {
  canvas?: string;
}

export interface EditorViewProps {
  state: EditorState;
  dispatch: (nextState: EditorState) => void;
  history: History;
  layout: ArtworkLayout;
  registry: AssetRegistry;
  viewCssPx: number;
  dpr: number;
  labels?: EditorViewLabels;
  onExit: () => void;
}

interface Point {
  x: number;
  y: number;
}

interface ObjectGeometry {
  center: Point;
  width: number;
  height: number;
  corners: [Point, Point, Point, Point];
  topCenter: Point;
  rotationHandle: Point;
  bounds: AABB;
}

type GestureKind = 'move' | 'resize' | 'rotate';

interface Gesture {
  pointerId: number;
  kind: GestureKind;
  objectId: string;
  startPoint: Point;
  startObject: EditorObject;
  startGeometry: ObjectGeometry;
  startPointerAngle: number;
  changed: boolean;
}

interface SnapLines {
  vertical?: number;
  horizontal?: number;
}

type MeasureText = (value: string, font: string) => number;

const SNAP_THRESHOLD_MM = 2;
const HANDLE_RADIUS_CSS_PX = 5;
const HANDLE_HIT_RADIUS_CSS_PX = 8;
const ROTATION_HANDLE_OFFSET_CSS_PX = 20;

function rotateOffset(offset: Point, degrees: number): Point {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: offset.x * cos - offset.y * sin,
    y: offset.x * sin + offset.y * cos,
  };
}

function rotateAround(center: Point, point: Point, degrees: number): Point {
  const rotated = rotateOffset({ x: point.x - center.x, y: point.y - center.y }, degrees);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

function inverseRotatePoint(point: Point, center: Point, degrees: number): Point {
  const local = rotateOffset({ x: point.x - center.x, y: point.y - center.y }, -degrees);
  return { x: center.x + local.x, y: center.y + local.y };
}

function boundsOf(points: readonly Point[]): AABB {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y)),
  };
}

function imageSize(object: ImageObject, registry: AssetRegistry): { width: number; height: number } {
  const asset = registry.get(object.assetId);
  return {
    width: object.widthMm,
    height: object.widthMm * asset.height / asset.width,
  };
}

function textSize(object: TextObject, measure: MeasureText): { width: number; height: number } {
  const metrics = textBlockMetrics(object, measure);
  return { width: metrics.width, height: metrics.height };
}

function objectGeometry(
  object: EditorObject,
  registry: AssetRegistry,
  measure: MeasureText,
  rotationHandleOffsetMm: number,
): ObjectGeometry {
  const { width, height } = object.kind === 'image'
    ? imageSize(object, registry)
    : textSize(object, measure);
  const center = { x: object.x, y: object.y };
  const localCorners: [Point, Point, Point, Point] = [
    { x: object.x - width / 2, y: object.y - height / 2 },
    { x: object.x + width / 2, y: object.y - height / 2 },
    { x: object.x + width / 2, y: object.y + height / 2 },
    { x: object.x - width / 2, y: object.y + height / 2 },
  ];
  const corners = localCorners.map((point) => (
    rotateAround(center, point, object.rotation)
  )) as ObjectGeometry['corners'];
  const topCenter = rotateAround(center, {
    x: object.x,
    y: object.y - height / 2,
  }, object.rotation);
  const rotationHandle = rotateAround(center, {
    x: object.x,
    y: object.y - height / 2 - rotationHandleOffsetMm,
  }, object.rotation);

  return {
    center,
    width,
    height,
    corners,
    topCenter,
    rotationHandle,
    bounds: boundsOf(corners),
  };
}

function pointInObject(
  point: Point,
  object: EditorObject,
  registry: AssetRegistry,
  measure: MeasureText,
): boolean {
  const { width, height } = object.kind === 'image'
    ? imageSize(object, registry)
    : textSize(object, measure);
  const local = inverseRotatePoint(point, object, object.rotation);
  return Math.abs(local.x - object.x) <= width / 2
    && Math.abs(local.y - object.y) <= height / 2;
}

function hitTest(
  point: Point,
  objects: readonly EditorObject[],
  registry: AssetRegistry,
  measure: MeasureText,
): EditorObject | null {
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index]!;
    if (pointInObject(point, object, registry, measure)) return object;
  }
  return null;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleFrom(center: Point, point: Point): number {
  return Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
}

function sameObject(a: EditorObject, b: EditorObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function replaceObject(state: EditorState, replacement: EditorObject): EditorState {
  return {
    ...state,
    objects: state.objects.map((object) => object.id === replacement.id ? replacement : object),
  };
}

function pushAxisAlignedSegment(
  a: Point,
  b: Point,
  vertical: number[],
  horizontal: number[],
): void {
  if (Math.abs(a.x - b.x) <= 1e-9) vertical.push((a.x + b.x) / 2);
  if (Math.abs(a.y - b.y) <= 1e-9) horizontal.push((a.y + b.y) / 2);
}

function snapTargets(layout: ArtworkLayout): Omit<SnapTargets, 'disabled'> {
  const vertical: number[] = [];
  const horizontal: number[] = [];

  for (const panel of layout.panels) {
    for (let index = 0; index < panel.polygon.length; index += 1) {
      const a = panel.polygon[index]!;
      const b = panel.polygon[(index + 1) % panel.polygon.length]!;
      pushAxisAlignedSegment(a, b, vertical, horizontal);
    }
    if (panel.hinge) {
      pushAxisAlignedSegment(panel.hinge.a, panel.hinge.b, vertical, horizontal);
    }
  }

  vertical.push(layout.frame.minX - layout.frame.offsetX + layout.frame.span / 2);
  horizontal.push(layout.frame.minY - layout.frame.offsetY + layout.frame.span / 2);

  return {
    vertical: [...new Set(vertical)],
    horizontal: [...new Set(horizontal)],
  };
}

function axisAnchors(bounds: AABB, axis: 'x' | 'y'): number[] {
  if (axis === 'x') {
    return [bounds.minX, (bounds.minX + bounds.maxX) / 2, bounds.maxX];
  }
  return [bounds.minY, (bounds.minY + bounds.maxY) / 2, bounds.maxY];
}

function matchedLine(
  bounds: AABB,
  targets: readonly number[],
  axis: 'x' | 'y',
): number | undefined {
  const anchors = axisAnchors(bounds, axis);
  return targets.find((target) => anchors.some((anchor) => Math.abs(target - anchor) < 1e-7));
}

function isFormElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(element.tagName);
}

function mmToCss(point: Point, layout: ArtworkLayout, viewCssPx: number): Point {
  const scale = viewCssPx / layout.frame.span;
  return {
    x: (point.x - layout.frame.minX + layout.frame.offsetX) * scale,
    y: (point.y - layout.frame.minY + layout.frame.offsetY) * scale,
  };
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  state: EditorState,
  layout: ArtworkLayout,
  registry: AssetRegistry,
  viewCssPx: number,
  dpr: number,
  measure: MeasureText,
  lines: SnapLines,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);

  context.strokeStyle = '#96742F';
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  if (lines.vertical !== undefined) {
    const x = mmToCss({ x: lines.vertical, y: 0 }, layout, viewCssPx).x;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, viewCssPx);
    context.stroke();
  }
  if (lines.horizontal !== undefined) {
    const y = mmToCss({ x: 0, y: lines.horizontal }, layout, viewCssPx).y;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(viewCssPx, y);
    context.stroke();
  }

  const selected = state.objects.find((object) => object.id === state.selectedId);
  if (!selected) return;

  const handleOffsetMm = ROTATION_HANDLE_OFFSET_CSS_PX * layout.frame.span / viewCssPx;
  const geometry = objectGeometry(selected, registry, measure, handleOffsetMm);
  const corners = geometry.corners.map((point) => mmToCss(point, layout, viewCssPx));
  const topCenter = mmToCss(geometry.topCenter, layout, viewCssPx);
  const rotationHandle = mmToCss(geometry.rotationHandle, layout, viewCssPx);

  context.strokeStyle = '#191712';
  context.fillStyle = '#FFFFFF';
  context.lineWidth = 1.5;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(corners[0]!.x, corners[0]!.y);
  for (let index = 1; index < corners.length; index += 1) {
    context.lineTo(corners[index]!.x, corners[index]!.y);
  }
  context.closePath();
  context.stroke();

  context.beginPath();
  context.moveTo(topCenter.x, topCenter.y);
  context.lineTo(rotationHandle.x, rotationHandle.y);
  context.stroke();

  for (const handle of [...corners, rotationHandle]) {
    context.beginPath();
    context.arc(handle.x, handle.y, HANDLE_RADIUS_CSS_PX, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
}

export default function EditorView({
  state,
  dispatch,
  history,
  layout,
  registry,
  viewCssPx,
  dpr,
  labels,
  onExit,
}: EditorViewProps) {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const safeViewCssPx = Number.isFinite(viewCssPx) && viewCssPx > 0 ? viewCssPx : 1;
  const backingSize = Math.max(1, Math.round(safeViewCssPx * safeDpr));
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const interactionCanvasRef = useRef<HTMLCanvasElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [renderState, setRenderState] = useState(state);
  const renderStateRef = useRef(renderState);
  const [snapLines, setSnapLines] = useState<SnapLines>({});
  const targets = useMemo(() => snapTargets(layout), [layout]);

  const measure = useCallback<MeasureText>((value, font) => {
    measureCanvasRef.current ??= document.createElement('canvas');
    const context = measureCanvasRef.current.getContext('2d');
    if (!context) return value.length * Number.parseFloat(font) * 0.5;
    context.font = font;
    return context.measureText(value).width;
  }, []);

  const publish = useCallback((nextState: EditorState): void => {
    renderStateRef.current = nextState;
    setRenderState(nextState);
    dispatch(nextState);
  }, [dispatch]);

  const applyAction = useCallback((action: EditorAction): EditorState => {
    const current = renderStateRef.current;
    const next = reduce(current, action);
    if (next !== current) publish(next);
    return next;
  }, [publish]);

  useEffect(() => {
    if (gestureRef.current !== null) return;
    renderStateRef.current = state;
    setRenderState(state);
  }, [state]);

  useEffect(() => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return;
    const composed = composeArtwork(
      renderState,
      layout,
      backingSize,
      { guides: true },
      registry,
    );
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, backingSize, backingSize);
    context.drawImage(composed, 0, 0, backingSize, backingSize);
  }, [backingSize, layout, registry, renderState.objects]);

  useEffect(() => {
    const canvas = interactionCanvasRef.current;
    if (!canvas) return;
    drawOverlay(
      canvas,
      renderState,
      layout,
      registry,
      safeViewCssPx,
      safeDpr,
      measure,
      snapLines,
    );
  }, [layout, measure, registry, renderState, safeDpr, safeViewCssPx, snapLines]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isFormElement(event.target instanceof Element ? event.target : document.activeElement)
        || isFormElement(document.activeElement)) return;

      const current = renderStateRef.current;
      const selectedId = current.selectedId;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape') {
        event.preventDefault();
        if (selectedId !== null) {
          applyAction({ type: 'select', id: null });
        } else {
          onExit();
        }
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
        event.preventDefault();
        const next = reduce(current, { type: 'delete', id: selectedId });
        if (next !== current) {
          publish(next);
          history.commit(next);
        }
        return;
      }

      if (command && key === 'd' && selectedId !== null) {
        event.preventDefault();
        const next = reduce(current, { type: 'duplicate', id: selectedId });
        if (next !== current) {
          publish(next);
          history.commit(next);
        }
        return;
      }

      if (command && key === 'z') {
        event.preventDefault();
        const snapshot = event.shiftKey ? history.redo() : history.undo();
        if (snapshot !== null) publish(snapshot);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyAction, history, onExit, publish]);

  const pointerPoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return fromCanvas(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      layout.frame,
      backingSize,
      safeDpr,
    );
  }, [backingSize, layout.frame, safeDpr]);

  const startGesture = useCallback((
    event: ReactPointerEvent<HTMLCanvasElement>,
    kind: GestureKind,
    object: EditorObject,
    point: Point,
    geometry: ObjectGeometry,
  ): void => {
    gestureRef.current = {
      pointerId: event.pointerId,
      kind,
      objectId: object.id,
      startPoint: point,
      startObject: { ...object },
      startGeometry: geometry,
      startPointerAngle: angleFrom(geometry.center, point),
      changed: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (gestureRef.current !== null) return;
    event.preventDefault();
    event.currentTarget.focus();
    const point = pointerPoint(event);
    const current = renderStateRef.current;
    const handleOffsetMm = ROTATION_HANDLE_OFFSET_CSS_PX * layout.frame.span / safeViewCssPx;
    const handleToleranceMm = HANDLE_HIT_RADIUS_CSS_PX * layout.frame.span / safeViewCssPx;
    const selected = current.objects.find((object) => object.id === current.selectedId);

    if (selected) {
      const geometry = objectGeometry(selected, registry, measure, handleOffsetMm);
      if (distance(point, geometry.rotationHandle) <= handleToleranceMm) {
        startGesture(event, 'rotate', selected, point, geometry);
        return;
      }
      if (geometry.corners.some((corner) => distance(point, corner) <= handleToleranceMm)) {
        startGesture(event, 'resize', selected, point, geometry);
        return;
      }
    }

    const hit = hitTest(point, current.objects, registry, measure);
    if (!hit) {
      applyAction({ type: 'select', id: null });
      return;
    }

    if (current.selectedId !== hit.id) applyAction({ type: 'select', id: hit.id });
    const geometry = objectGeometry(hit, registry, measure, handleOffsetMm);
    startGesture(event, 'move', hit, point, geometry);
  }, [applyAction, layout.frame.span, measure, pointerPoint, registry, safeViewCssPx, startGesture]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = pointerPoint(event);
    const current = renderStateRef.current;

    if (gesture.kind === 'move') {
      let x = gesture.startObject.x + point.x - gesture.startPoint.x;
      let y = gesture.startObject.y + point.y - gesture.startPoint.y;
      const candidate = { ...gesture.startObject, x, y } as EditorObject;
      const handleOffsetMm = ROTATION_HANDLE_OFFSET_CSS_PX * layout.frame.span / safeViewCssPx;
      let geometry = objectGeometry(candidate, registry, measure, handleOffsetMm);
      const snapped = snapDelta(geometry.bounds, { ...targets, disabled: event.altKey }, SNAP_THRESHOLD_MM);
      if (snapped) {
        const unsnappedBounds = geometry.bounds;
        x += snapped.dx;
        y += snapped.dy;
        geometry = objectGeometry({ ...candidate, x, y } as EditorObject, registry, measure, handleOffsetMm);
        const exactVertical = matchedLine(unsnappedBounds, targets.vertical, 'x');
        const exactHorizontal = matchedLine(unsnappedBounds, targets.horizontal, 'y');
        setSnapLines({
          vertical: snapped.dx !== 0 || (snapped.dy === 0 && exactVertical !== undefined)
            ? matchedLine(geometry.bounds, targets.vertical, 'x')
            : undefined,
          horizontal: snapped.dy !== 0 || (snapped.dx === 0 && exactVertical === undefined)
            ? matchedLine(geometry.bounds, targets.horizontal, 'y') ?? exactHorizontal
            : undefined,
        });
      } else {
        setSnapLines({});
      }
      const next = reduce(current, { type: 'move', id: gesture.objectId, x, y });
      if (next !== current) publish(next);
    } else if (gesture.kind === 'resize') {
      const startRadius = distance(gesture.startGeometry.center, gesture.startPoint);
      const currentRadius = distance(gesture.startGeometry.center, point);
      const ratio = startRadius === 0 ? 1 : currentRadius / startRadius;
      const action: EditorAction = gesture.startObject.kind === 'image'
        ? {
            type: 'resize',
            id: gesture.objectId,
            widthMm: gesture.startObject.widthMm * ratio,
            frameSpan: layout.frame.span,
          }
        : {
            type: 'setText',
            id: gesture.objectId,
            patch: { fontSizeMm: gesture.startObject.fontSizeMm * ratio },
            frameSpan: layout.frame.span,
          };
      const next = reduce(current, action);
      if (next !== current) publish(next);
    } else {
      const rotation = gesture.startObject.rotation
        + angleFrom(gesture.startGeometry.center, point)
        - gesture.startPointerAngle;
      const next = reduce(current, { type: 'rotate', id: gesture.objectId, rotation });
      if (next !== current) publish(next);
    }

    const updated = renderStateRef.current.objects.find(({ id }) => id === gesture.objectId);
    gesture.changed = updated !== undefined && !sameObject(updated, gesture.startObject);
  }, [layout.frame.span, measure, pointerPoint, publish, registry, safeViewCssPx, targets]);

  const finishGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.changed) history.commit(renderStateRef.current);
    gestureRef.current = null;
    setSnapLines({});
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [history]);

  const cancelGesture = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const restored = replaceObject(renderStateRef.current, gesture.startObject);
    publish(restored);
    gestureRef.current = null;
    setSnapLines({});
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, [publish]);

  const canvasStyle = {
    position: 'absolute',
    inset: 0,
    width: `${safeViewCssPx}px`,
    height: `${safeViewCssPx}px`,
  } as const;

  return (
    <div
      data-testid="editor-canvas-container"
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: `${safeViewCssPx}px`,
          height: `${safeViewCssPx}px`,
          maxWidth: '100%',
          maxHeight: '100%',
        }}
      >
        <canvas
          ref={displayCanvasRef}
          width={backingSize}
          height={backingSize}
          aria-hidden="true"
          style={canvasStyle}
        />
        <canvas
          ref={interactionCanvasRef}
          width={backingSize}
          height={backingSize}
          role="application"
          aria-label={labels?.canvas ?? 'Artwork editor canvas'}
          data-testid="editor-interaction-canvas"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={cancelGesture}
          style={{ ...canvasStyle, touchAction: 'none' }}
        />
      </div>
    </div>
  );
}
