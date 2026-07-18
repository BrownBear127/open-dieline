import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINE_STYLES } from '@/core/styles';
import { readFileSync } from 'node:fs';
import type { ArtworkLayout, FlatDielineUvFrame } from '@/ui/artwork-layout';
import type { AssetRegistry } from '@/ui/editor/editor-assets';
import {
  paperColorCss,
  PAPER_RECIPE_BASE_COLORS,
} from '@/ui/fold-paper-colors';
import {
  composeArtwork,
  fromCanvas,
  INK_COLORS,
  textBlockMetrics,
  toCanvas,
} from '@/ui/editor/editor-compose';
import type { EditorState, TextObject } from '@/ui/editor/editor-state';

type RecordedCall = { name: string; args: unknown[] };
type Segment = [number, number, number, number];

class RecordingContext {
  readonly calls: RecordedCall[] = [];
  readonly fillStyles: string[] = [];
  readonly strokeStyles: string[] = [];
  readonly lineWidths: number[] = [];
  readonly lineDashes: number[][] = [];
  private currentFont = '';
  private currentStrokeStyle = '';
  private currentLineWidth = 1;

  private currentFillStyle = '';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';

  get font(): string { return this.currentFont; }
  set font(value: string) { this.currentFont = value; }

  get fillStyle(): string { return this.currentFillStyle; }
  set fillStyle(value: string) {
    this.currentFillStyle = value;
    this.fillStyles.push(value);
  }

  get strokeStyle(): string { return this.currentStrokeStyle; }
  set strokeStyle(value: string) {
    this.currentStrokeStyle = value;
    this.strokeStyles.push(value);
  }

  get lineWidth(): number { return this.currentLineWidth; }
  set lineWidth(value: number) {
    this.currentLineWidth = value;
    this.lineWidths.push(value);
  }

  save(): void { this.record('save'); }
  restore(): void { this.record('restore'); }
  translate(x: number, y: number): void { this.record('translate', x, y); }
  rotate(angle: number): void { this.record('rotate', angle); }
  beginPath(): void { this.record('beginPath'); }
  closePath(): void { this.record('closePath'); }
  moveTo(x: number, y: number): void { this.record('moveTo', x, y); }
  lineTo(x: number, y: number): void { this.record('lineTo', x, y); }
  fill(): void { this.record('fill'); }
  clip(): void { this.record('clip'); }
  stroke(): void { this.record('stroke'); }
  setLineDash(segments: number[]): void {
    this.lineDashes.push([...segments]);
    this.record('setLineDash', ...segments);
  }

  drawImage(...args: unknown[]): void { this.record('drawImage', ...args); }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', text, x, y);
  }

  measureText(text: string): TextMetrics {
    const fontSize = Number.parseFloat(this.currentFont);
    return { width: text.length * fontSize / 2 } as TextMetrics;
  }

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }
}

const frame: FlatDielineUvFrame = {
  minX: 10,
  minY: 20,
  span: 100,
  offsetX: 0,
  offsetY: 25,
};

const layout: ArtworkLayout = {
  frame,
  panels: [{
    id: 'P1',
    polygon: [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 70 },
      { x: 10, y: 70 },
    ],
    hinge: { a: { x: 10, y: 45 }, b: { x: 110, y: 45 } },
  }],
};

const source = { width: 400, height: 200, close: vi.fn() } as unknown as ImageBitmap;
const registry = {
  get: vi.fn(() => ({ bitmap: source, width: 400, height: 200 })),
} as unknown as AssetRegistry;

const state: EditorState = {
  selectedId: null,
  objects: [
    {
      id: 'image-1',
      kind: 'image',
      assetId: 'asset-1',
      x: 60,
      y: 45,
      rotation: 30,
      widthMm: 20,
    },
    {
      id: 'text-1',
      kind: 'text',
      text: 'LONG\nS',
      fontFamily: 'sans',
      fontSizeMm: 10,
      align: 'right',
      color: 'ink',
      x: 35,
      y: 40,
      rotation: -90,
    },
  ],
};

function composeAt(sizePx: number, guides = false, artworkLayout = layout): {
  canvas: HTMLCanvasElement;
  context: RecordingContext;
} {
  const context = new RecordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValueOnce(context as unknown as CanvasRenderingContext2D);
  const canvas = composeArtwork(state, artworkLayout, sizePx, { guides }, registry);
  return { canvas, context };
}

function pathSegments(calls: RecordedCall[]): Segment[] {
  const segments: Segment[] = [];
  let start: [number, number] | undefined;
  let current: [number, number] | undefined;

  for (const call of calls) {
    if (call.name === 'beginPath') {
      start = undefined;
      current = undefined;
    } else if (call.name === 'moveTo') {
      start = call.args as [number, number];
      current = start;
    } else if (call.name === 'lineTo' && current !== undefined) {
      const end = call.args as [number, number];
      segments.push([...current, ...end]);
      current = end;
    } else if (call.name === 'closePath' && start !== undefined && current !== undefined) {
      segments.push([...current, ...start]);
      current = start;
    }
  }

  return segments;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('INK_COLORS', () => {
  const tokensCss = readFileSync('src/styles/tokens.css', 'utf8');
  const tokenNames = {
    ink: '--ink',
    inkSoft: '--ink-soft',
    cut: '--cut',
    crease: '--crease',
    brass: '--brass',
  } as const;

  it.each(Object.entries(tokenNames))('%s matches the %s CSS token', (color, tokenName) => {
    const tokenPattern = new RegExp(`^\\s*${tokenName}:\\s*(#[0-9a-f]{6})\\s*;`, 'im');
    const tokenValue = tokensCss.match(tokenPattern)?.[1];

    expect(tokenValue, `${tokenName} must exist in tokens.css`).toBeDefined();
    expect(INK_COLORS[color as keyof typeof INK_COLORS].toLowerCase())
      .toBe(tokenValue!.toLowerCase());
  });
});

describe('editor canvas coordinates', () => {
  it('maps the offset square-frame center to the canvas center', () => {
    const frameCenter = {
      x: frame.minX - frame.offsetX + frame.span / 2,
      y: frame.minY - frame.offsetY + frame.span / 2,
    };

    expect(toCanvas(frameCenter, frame, 4096)).toEqual({ x: 2048, y: 2048 });
  });

  it.each([1, 2])('round-trips a CSS pointer at DPR %i', (dpr) => {
    const point = { x: 87.25, y: 61.5 };
    const backingSize = 1024 * dpr;
    const backingPoint = toCanvas(point, frame, backingSize);
    const cssPointer = { x: backingPoint.x / dpr, y: backingPoint.y / dpr };

    const roundTrip = fromCanvas(cssPointer, frame, backingSize, dpr);

    expect(roundTrip.x).toBeCloseTo(point.x, 12);
    expect(roundTrip.y).toBeCloseTo(point.y, 12);
  });
});

describe('textBlockMetrics', () => {
  const text: TextObject = {
    id: 'text-1',
    kind: 'text',
    text: 'LONG\nS',
    fontFamily: 'sans',
    fontSizeMm: 10,
    align: 'left',
    color: 'ink',
    x: 100,
    y: 50,
    rotation: 0,
  };

  it.each([
    ['left', 80],
    ['center', 100],
    ['right', 120],
  ] as const)('positions long and short lines for %s alignment', (align, lineX) => {
    const measure = vi.fn((line: string) => line.length * 10);

    const metrics = textBlockMetrics({ ...text, align }, measure);

    expect(metrics.width).toBe(40);
    expect(metrics.height).toBe(26);
    expect(metrics.lines).toEqual([
      { text: 'LONG', x: lineX, baselineY: 45 },
      { text: 'S', x: lineX, baselineY: 58 },
    ]);
    expect(metrics.bounds).toEqual({ minX: 80, minY: 37, maxX: 120, maxY: 63 });
    expect(measure).toHaveBeenCalledWith('LONG', '10px system-ui, sans-serif');
  });

  it('returns the rotated AABB around the text block center', () => {
    const metrics = textBlockMetrics(
      { ...text, align: 'center', rotation: 90 },
      (line) => line.length * 10,
    );

    expect(metrics.bounds.minX).toBeCloseTo(87, 12);
    expect(metrics.bounds.minY).toBeCloseTo(30, 12);
    expect(metrics.bounds.maxX).toBeCloseTo(113, 12);
    expect(metrics.bounds.maxY).toBeCloseTo(70, 12);
  });
});

describe('composeArtwork', () => {
  it('creates a square canvas and records object transforms and drawing in array order', () => {
    const createElement = vi.spyOn(document, 'createElement');
    const stateBefore = structuredClone(state);
    const { canvas, context } = composeAt(200);
    const drawingCalls = context.calls.filter(({ name }) => [
      'save', 'translate', 'rotate', 'drawImage', 'fillText', 'restore',
    ].includes(name));

    expect(createElement).toHaveBeenCalledWith('canvas');
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 200, height: 200 });
    expect(state).toEqual(stateBefore);
    expect(context.fillStyles).toEqual(['#191712']);
    expect(drawingCalls).toEqual([
      { name: 'save', args: [] },
      { name: 'translate', args: [100, 100] },
      { name: 'rotate', args: [Math.PI / 6] },
      { name: 'drawImage', args: [source, -20, -10, 40, 20] },
      { name: 'restore', args: [] },
      { name: 'save', args: [] },
      { name: 'translate', args: [50, 90] },
      { name: 'rotate', args: [-Math.PI / 2] },
      { name: 'fillText', args: ['LONG', 20, -10] },
      { name: 'fillText', args: ['S', 20, 16] },
      { name: 'restore', args: [] },
    ]);
  });

  it('keeps 2048 and 4096 output commands identical apart from a twofold scale', () => {
    const small = composeAt(2048).context.calls;
    const large = composeAt(4096).context.calls;
    const names = ['translate', 'drawImage', 'fillText'];
    const smallGeometry = small.filter(({ name }) => names.includes(name));
    const largeGeometry = large.filter(({ name }) => names.includes(name));

    expect(largeGeometry.map(({ name }) => name)).toEqual(smallGeometry.map(({ name }) => name));
    for (let index = 0; index < smallGeometry.length; index += 1) {
      const smallArgs = smallGeometry[index]!.args;
      const largeArgs = largeGeometry[index]!.args;
      const firstNumericArgument = smallGeometry[index]!.name === 'translate' ? 0 : 1;
      if (firstNumericArgument === 1) expect(largeArgs[0]).toBe(smallArgs[0]);
      for (let argument = firstNumericArgument; argument < smallArgs.length; argument += 1) {
        expect(largeArgs[argument]).toBeCloseTo((smallArgs[argument] as number) * 2, 10);
      }
    }
  });

  it('draws red cut and blue crease guides before artwork', () => {
    const { context } = composeAt(100, true);
    const firstObjectSave = context.calls.findIndex(({ name }) => name === 'save');
    const lastGuideStroke = context.calls.reduce(
      (last, call, index) => call.name === 'stroke' ? index : last,
      -1,
    );

    expect(context.strokeStyles).toEqual([
      '#C93A2B',
      '#2C4EC4',
    ]);
    expect(context.lineWidths).toEqual([
      LINE_STYLES.cut.strokeWidth,
      LINE_STYLES.crease.strokeWidth,
    ]);
    expect(context.lineDashes).toEqual([[], [4, 2]]);
    expect(lastGuideStroke).toBeLessThan(firstObjectSave);
  });

  it('downloads paper, panel-clipped artwork, then cut and crease guides in that order', () => {
    const context = new RecordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValueOnce(context as unknown as CanvasRenderingContext2D);

    composeArtwork(
      state,
      layout,
      100,
      { mode: 'download', paperColor: PAPER_RECIPE_BASE_COLORS.kraft },
      registry,
    );

    const layerCalls = context.calls.filter(({ name }) => [
      'fill',
      'clip',
      'drawImage',
      'fillText',
      'stroke',
    ].includes(name));
    expect(context.fillStyles[0]?.toLowerCase())
      .toBe(paperColorCss(PAPER_RECIPE_BASE_COLORS.kraft));
    expect(layerCalls.map(({ name }) => name)).toEqual([
      'fill',
      'clip',
      'drawImage',
      'fillText',
      'fillText',
      'stroke',
      'stroke',
    ]);
    const lastGuideStroke = context.calls.reduce(
      (last, call, index) => call.name === 'stroke' ? index : last,
      -1,
    );
    const clipRestore = context.calls.reduce(
      (last, call, index) => call.name === 'restore' ? index : last,
      -1,
    );
    expect(clipRestore).toBeGreaterThan(lastGuideStroke);
  });

  it('draws a shared panel edge only as a crease guide', () => {
    const adjacentLayout: ArtworkLayout = {
      frame: { minX: 0, minY: 0, span: 20, offsetX: 0, offsetY: 0 },
      panels: [
        {
          id: 'left',
          polygon: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
          ],
        },
        {
          id: 'right',
          polygon: [
            { x: 10, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 10 },
            { x: 10, y: 10 },
          ],
          hinge: { a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
        },
      ],
    };
    const { context } = composeAt(20, true, adjacentLayout);
    const strokeIndices = context.calls.flatMap((call, index) => (
      call.name === 'stroke' ? [index] : []
    ));
    const cutSegments = pathSegments(context.calls.slice(0, strokeIndices[0]));
    const creaseSegments = pathSegments(
      context.calls.slice(strokeIndices[0]! + 1, strokeIndices[1]),
    );

    expect(cutSegments).not.toContainEqual([10, 0, 10, 10]);
    expect(cutSegments).not.toContainEqual([10, 10, 10, 0]);
    expect(creaseSegments).toContainEqual([10, 0, 10, 10]);
  });
});
