/**
 * Canvas：pan/zoom 畫布，渲染 GenerateResult 的線段與標註文字，並疊加 hover/不變式警告高亮。
 *
 * pan/zoom 手感邏輯（scale/pan state、滾輪縮放、拖曳平移、Fit 按鈕）移植自前身
 * `Packaging/index.tsx:100-122`（`handleFitToScreen` 手刻模式）與其下的 wheel/mouse
 * handlers（唯讀參照，見 開發紀錄）。Fit 的內容尺寸一律用 `result.bounds`
 * （資料層），不用 `getBBox()`/`getBoundingClientRect()` 量測畫出來的 SVG——
 * jsdom 不支援這些量測回傳真值，測試才可行；瀏覽器下語意也更正確（bounds 是
 * generate() 保證涵蓋全部路徑的權威範圍，見 core/types.ts 的 BoxInvariant「bounds-cover」）。
 *
 * 線段樣式一律查 `LINE_STYLES[p.type]`（唯一來源，見 core/styles.ts）；highlight 疊加色
 * #FF6B00 是 spec 明文的例外——UI 互動色，不是線型樣式，不放進 LINE_STYLES。
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { GenerateResult, LocalizedText } from '@/core/types';
import { LINE_STYLES } from '@/core/styles';
import { segmentsToSvgD } from '@/core/path';

export interface CanvasProps {
  result: GenerateResult;
  highlightTags: string[] | null;
  invariantWarnings: { message: LocalizedText; tags?: string[] }[];
}

const HIGHLIGHT_STROKE = '#FF6B00';
const HIGHLIGHT_OPACITY = 0.9;
const HIGHLIGHT_WIDTH_FACTOR = 3;
const MIN_SCALE = 0.05;
const MAX_SCALE = 10;
const FIT_PADDING = 120;
const DIMENSION_TEXT_FILL = LINE_STYLES.dimension.stroke;

/** 依容器可視尺寸與內容 bounds 算出「剛好塞滿」的 scale——邏輯照前身 handleFitToScreen 移植。 */
function computeFitScale(containerW: number, containerH: number, bounds: GenerateResult['bounds']): number {
  const availableW = Math.max(containerW - FIT_PADDING, 1);
  const availableH = Math.max(containerH - FIT_PADDING, 1);
  // 內容尺寸為 0（極端退化案例）時退回 100，避免除以 0（前身同一防護）。
  const contentW = bounds.maxX - bounds.minX || 100;
  const contentH = bounds.maxY - bounds.minY || 100;
  const newScale = Math.min(availableW / contentW, availableH / contentH);
  return Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
}

export function Canvas({ result, highlightTags, invariantWarnings }: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const handleFit = () => {
    const el = containerRef.current;
    setScale(computeFitScale(el?.clientWidth ?? 0, el?.clientHeight ?? 0, result.bounds));
    setPan({ x: 0, y: 0 });
  };

  useEffect(() => {
    // 掛載後延遲一拍再 Fit：容器初次量測時瀏覽器可能還沒完成佈局（前身同一手法，
    // 100ms timeout 換取 clientWidth/clientHeight 有意義的值）。只在掛載時跑一次；
    // 之後換盒型/調參數刻意不重新 Fit，維持使用者當下自訂的 scale/pan。
    const timer = setTimeout(handleFit, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.001);
      setScale((prev) => Math.min(Math.max(MIN_SCALE, prev * factor), MAX_SCALE));
    } else {
      setPan((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    }
  };

  const handleMouseDown = () => setIsDragging(true);
  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);
  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (isDragging) {
      setPan((prev) => ({ x: prev.x + e.movementX, y: prev.y + e.movementY }));
    }
  };

  // 高亮 tag 集合＝hover 高亮 ∪ 全部不變式警告的 tags（spec 裁決：同一機制、聯集）。
  const highlightSet = new Set<string>([...(highlightTags ?? []), ...invariantWarnings.flatMap((w) => w.tags ?? [])]);
  const isHighlighted = (tags?: string[]): boolean => (tags ?? []).some((t) => highlightSet.has(t));

  const { minX, minY, maxX, maxY } = result.bounds;
  const viewW = maxX - minX || 100;
  const viewH = maxY - minY || 100;

  return (
    <div className="relative flex-1 h-full bg-zinc-950 overflow-hidden">
      {invariantWarnings.length > 0 && (
        <div className="absolute top-0 left-0 right-0 z-20 bg-red-900/95 text-red-100 text-sm px-4 py-2 space-y-0.5 border-b border-red-700">
          {invariantWarnings.map((w, i) => (
            <div key={i}>{w.message.zh}</div>
          ))}
        </div>
      )}

      <div className="absolute top-4 right-4 z-10 flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s * 0.9))}
          className="px-2 py-1 bg-zinc-900 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs"
        >
          －
        </button>
        <div className="px-2 py-1 bg-zinc-900 border-y border-zinc-700 text-xs font-mono text-zinc-400 min-w-[48px] text-center">
          {Math.round(scale * 100)}%
        </div>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.1))}
          className="px-2 py-1 bg-zinc-900 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={handleFit}
          className="ml-1 px-2 py-1 bg-zinc-900 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs"
        >
          Fit
        </button>
      </div>

      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
      >
        <svg
          width={viewW}
          height={viewH}
          viewBox={`${minX} ${minY} ${viewW} ${viewH}`}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
          className="overflow-visible"
        >
          {result.paths.map((p) => {
            const style = LINE_STYLES[p.type];
            const highlighted = isHighlighted(p.tags);
            return (
              <g key={p.id}>
                {highlighted && (
                  <path
                    d={segmentsToSvgD(p.segments)}
                    fill="none"
                    stroke={HIGHLIGHT_STROKE}
                    strokeWidth={style.strokeWidth * HIGHLIGHT_WIDTH_FACTOR}
                    opacity={HIGHLIGHT_OPACITY}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <path
                  d={segmentsToSvgD(p.segments)}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.dasharray}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
          {result.texts.map((t) => (
            <text
              key={t.id}
              x={t.x}
              y={t.y}
              fontSize={t.fontSize ?? 3}
              textAnchor={t.anchor ?? 'start'}
              transform={t.rotation ? `rotate(${t.rotation} ${t.x} ${t.y})` : undefined}
              fill={DIMENSION_TEXT_FILL}
            >
              {t.text}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
