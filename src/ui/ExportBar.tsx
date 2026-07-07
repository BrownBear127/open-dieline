/**
 * ExportBar：「下載 SVG」＋「含尺寸標註」checkbox。
 *
 * 下載流程（Blob → object URL → 隱藏 <a download> → click）移植自前身
 * `Packaging/index.tsx` 的 `handleDownload`。與前身不同：SVG 內容改由
 * `export/svg.ts` 的 `toSvgDocument()` 產生（與畫布共用 LINE_STYLES 同一來源，
 * 不再是第二條手刻序列化路徑——這正是 spec §3.2 要修正的前身「漂移」問題）。
 */
import { useState } from 'react';
import type { GenerateResult, ResolvedParams } from '@/core/types';
import { toSvgDocument } from '@/export/svg';

export interface ExportBarProps {
  boxId: string;
  values: ResolvedParams;
  result: GenerateResult;
}

/**
 * 檔名慣例沿用 spec §6.2 為 DXF 訂的 `{盒型id}-{L}x{W}x{D}` 模式（此處副檔名 .svg）——
 * spec 給的具體範例 `rte-{L}x{W}x{D}.svg` 是 v1 唯一盒型（boxId='rte'）代入這個
 * 通式後的結果，兩者逐字相符；泛化成 boxId 前綴讓 Slice 2 新盒型不必改這支檔案。
 * L/W/D 三個 key 若某盒型未宣告（v1 兩個盒型 RTE/天地盒皆有，见 spec §4），退化顯示
 * '?' 而非字面 "undefined"（防禦性 fallback，非預期路徑）。
 */
function buildFilename(boxId: string, values: ResolvedParams): string {
  const dim = (key: string): string => {
    const v = values[key];
    return v === undefined ? '?' : String(v);
  };
  return `${boxId}-${dim('L')}x${dim('W')}x${dim('D')}.svg`;
}

export function ExportBar({ boxId, values, result }: ExportBarProps) {
  const [includeDimensions, setIncludeDimensions] = useState(true);

  const handleDownload = () => {
    const svg = toSvgDocument(result, { includeDimensions });
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildFilename(boxId, values);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-zinc-800">
      <label htmlFor="include-dimensions" className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          id="include-dimensions"
          type="checkbox"
          checked={includeDimensions}
          onChange={(e) => setIncludeDimensions(e.target.checked)}
          className="h-4 w-4 accent-orange-500"
        />
        含尺寸標註
      </label>
      <button
        type="button"
        onClick={handleDownload}
        className="w-full bg-orange-600 hover:bg-orange-500 text-zinc-950 font-medium text-sm py-2.5 rounded-sm transition-colors"
      >
        下載 SVG
      </button>
    </div>
  );
}
