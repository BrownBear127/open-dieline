import { LINE_STYLES } from '@/core/styles';
import type { ArtworkLayout, FlatDielineUvFrame } from '../artwork-layout';
import {
  paperColorCss,
  type PaperRecipeBaseColor,
} from '../fold-paper-colors';
import { dedupCutEdges } from '../fold-template';
import type { AssetRegistry } from './editor-assets';
import type { AABB } from './editor-snap';
import {
  effectiveObjects,
  type EditorState,
  type ImageObject,
  type InkPaletteColor,
  type TextObject,
} from './editor-state';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface TextLineMetrics {
  text: string;
  x: number;
  baselineY: number;
}

export interface Block {
  width: number;
  height: number;
  font: string;
  lines: TextLineMetrics[];
  unrotatedBounds: AABB;
  bounds: AABB;
}

type LineStyle = { stroke: string; strokeWidth: number; dasharray?: string };

export type ComposeArtworkOptions =
  | { guides: boolean; mode?: never }
  | { mode: 'download'; paperColor: PaperRecipeBaseColor; guides?: never };

const FONT_STACKS: Readonly<Record<TextObject['fontFamily'], string>> = {
  sans: 'system-ui, sans-serif',
  serif: 'serif',
  mono: 'monospace',
};

export const INK_COLORS: Readonly<Record<InkPaletteColor, string>> = {
  ink: '#191712',
  inkSoft: '#57534A',
  cut: '#C93A2B',
  crease: '#2C4EC4',
  brass: '#96742F',
};

/** Converts flattened millimetres to canvas backing-store pixels. */
export function toCanvas(
  point: CanvasPoint,
  frame: FlatDielineUvFrame,
  sizePx: number,
): CanvasPoint {
  const scale = sizePx / frame.span;
  return {
    x: (point.x - frame.minX + frame.offsetX) * scale,
    y: (point.y - frame.minY + frame.offsetY) * scale,
  };
}

/** Converts CSS pixels (not multiplied by DPR) to millimetres using the canvas backing size. */
export function fromCanvas(
  point: CanvasPoint,
  frame: FlatDielineUvFrame,
  sizePx: number,
  dpr: number,
): CanvasPoint {
  const scale = sizePx / frame.span;
  return {
    x: point.x * dpr / scale + frame.minX - frame.offsetX,
    y: point.y * dpr / scale + frame.minY - frame.offsetY,
  };
}

function rotatedBounds(bounds: AABB, center: CanvasPoint, rotation: number): AABB {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ].map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos,
    };
  });

  return {
    minX: Math.min(...corners.map(({ x }) => x)),
    minY: Math.min(...corners.map(({ y }) => y)),
    maxX: Math.max(...corners.map(({ x }) => x)),
    maxY: Math.max(...corners.map(({ y }) => y)),
  };
}

function lineAnchorX(text: TextObject, left: number, right: number): number {
  if (text.align === 'left') return left;
  if (text.align === 'right') return right;
  return text.x;
}

export function textBlockMetrics(
  text: TextObject,
  measure: (value: string, font: string) => number,
): Block {
  const font = `${text.fontSizeMm}px ${FONT_STACKS[text.fontFamily]}`;
  const sourceLines = text.text.split('\n');
  const widths = sourceLines.map((line) => measure(line, font));
  const width = Math.max(0, ...widths);
  const height = sourceLines.length * 1.3 * text.fontSizeMm;
  const left = text.x - width / 2;
  const right = text.x + width / 2;
  const top = text.y - height / 2;
  const bottom = text.y + height / 2;
  const anchorX = lineAnchorX(text, left, right);
  const lines = sourceLines.map((line, index) => ({
    text: line,
    x: anchorX,
    baselineY: top + (0.8 + index * 1.3) * text.fontSizeMm,
  }));
  const unrotatedBounds = { minX: left, minY: top, maxX: right, maxY: bottom };

  return {
    width,
    height,
    font,
    lines,
    unrotatedBounds,
    bounds: rotatedBounds(unrotatedBounds, text, text.rotation),
  };
}

function setLineStyle(
  context: CanvasRenderingContext2D,
  style: LineStyle,
  scale: number,
): void {
  context.strokeStyle = style.stroke;
  context.lineWidth = style.strokeWidth * scale;
  const dash = style.dasharray === undefined
    ? []
    : style.dasharray.split(/\s+/).map(Number).map((length) => length * scale);
  context.setLineDash(dash);
}

function drawGuides(
  context: CanvasRenderingContext2D,
  layout: ArtworkLayout,
  sizePx: number,
): void {
  const scale = sizePx / layout.frame.span;
  setLineStyle(context, { ...LINE_STYLES.cut, stroke: INK_COLORS.cut }, scale);
  context.beginPath();
  for (const edge of dedupCutEdges(layout.panels)) {
    const start = toCanvas(edge.a, layout.frame, sizePx);
    const end = toCanvas(edge.b, layout.frame, sizePx);
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  }
  context.stroke();

  const hingedPanels = layout.panels.filter((panel) => panel.hinge !== undefined);
  if (hingedPanels.length === 0) return;

  setLineStyle(context, { ...LINE_STYLES.crease, stroke: INK_COLORS.crease }, scale);
  context.beginPath();
  for (const panel of hingedPanels) {
    const hinge = panel.hinge!;
    const start = toCanvas(hinge.a, layout.frame, sizePx);
    const end = toCanvas(hinge.b, layout.frame, sizePx);
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  }
  context.stroke();
}

function tracePanelUnion(
  context: CanvasRenderingContext2D,
  layout: ArtworkLayout,
  sizePx: number,
): void {
  context.beginPath();
  for (const panel of layout.panels) {
    const [first, ...rest] = panel.polygon;
    if (first === undefined) continue;
    const start = toCanvas(first, layout.frame, sizePx);
    context.moveTo(start.x, start.y);
    for (const point of rest) {
      const next = toCanvas(point, layout.frame, sizePx);
      context.lineTo(next.x, next.y);
    }
    context.closePath();
  }
}

function drawPanelPaper(
  context: CanvasRenderingContext2D,
  layout: ArtworkLayout,
  sizePx: number,
  paperColor: PaperRecipeBaseColor,
): void {
  context.fillStyle = paperColorCss(paperColor);
  tracePanelUnion(context, layout, sizePx);
  context.fill();
}

function drawImageObject(
  context: CanvasRenderingContext2D,
  object: ImageObject,
  layout: ArtworkLayout,
  sizePx: number,
  registry: AssetRegistry,
): void {
  const asset = registry.get(object.assetId);
  const scale = sizePx / layout.frame.span;
  const center = toCanvas(object, layout.frame, sizePx);
  const width = object.widthMm * scale;
  const height = width * asset.height / asset.width;

  context.save();
  context.translate(center.x, center.y);
  context.rotate(object.rotation * Math.PI / 180);
  context.drawImage(asset.bitmap, -width / 2, -height / 2, width, height);
  context.restore();
}

function drawTextObject(
  context: CanvasRenderingContext2D,
  object: TextObject,
  layout: ArtworkLayout,
  sizePx: number,
): void {
  const scale = sizePx / layout.frame.span;
  const center = toCanvas(object, layout.frame, sizePx);
  const localText: TextObject = {
    ...object,
    x: 0,
    y: 0,
    fontSizeMm: object.fontSizeMm * scale,
  };

  context.save();
  context.translate(center.x, center.y);
  context.rotate(object.rotation * Math.PI / 180);
  const metrics = textBlockMetrics(localText, (line, font) => {
    context.font = font;
    return context.measureText(line).width;
  });
  context.font = metrics.font;
  context.fillStyle = INK_COLORS[object.color];
  context.textAlign = object.align;
  context.textBaseline = 'alphabetic';
  for (const line of metrics.lines) context.fillText(line.text, line.x, line.baselineY);
  context.restore();
}

function drawObjects(
  context: CanvasRenderingContext2D,
  state: EditorState,
  layout: ArtworkLayout,
  sizePx: number,
  registry: AssetRegistry,
): void {
  for (const object of effectiveObjects(state)) {
    if (object.kind === 'image') {
      drawImageObject(context, object, layout, sizePx, registry);
    } else {
      drawTextObject(context, object, layout, sizePx);
    }
  }
}

export function composeArtwork(
  state: EditorState,
  layout: ArtworkLayout,
  sizePx: number,
  options: ComposeArtworkOptions,
  registry: AssetRegistry,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sizePx;
  canvas.height = sizePx;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');

  if (options.mode === 'download') {
    drawPanelPaper(context, layout, sizePx, options.paperColor);
    context.save();
    tracePanelUnion(context, layout, sizePx);
    context.clip();
    drawObjects(context, state, layout, sizePx, registry);
    drawGuides(context, layout, sizePx);
    context.restore();
  } else {
    if (options.guides) drawGuides(context, layout, sizePx);
    drawObjects(context, state, layout, sizePx, registry);
  }

  return canvas;
}
