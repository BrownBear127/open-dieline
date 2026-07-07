/**
 * App：整體佈局（左 320px 深色參數欄＋右畫布）與資料流拼接。
 *
 * 資料流（spec §3.2）：ParamPanel（schema 生成）→ useParams 的 values →
 * mod.generate(values) → GenerateResult → Canvas 渲染 + ExportBar 匯出；
 * values 或 result 變動時重新跑全部 `mod.invariants`，not-ok 的收集成
 * `invariantWarnings` 往下傳給 Canvas（畫警告條＋高亮 tags）。
 *
 * 佈局與配色為深色工程風（見 spec D8／task-8-brief Context 段——這點與前身
 * `Packaging/index.tsx` 實際的淺色 zinc-50/white 主題不同：前身程式碼本身是淺色，
 * 但 spec 與本 task 的書面指示都明確寫「深色工程風」，此處遵照書面指示而非前身
 * 實際配色；前身移植的是流程/互動手感〔pan/zoom、分組、hover 高亮〕，不是色票）。
 */
import { useMemo, useState } from 'react';
import { listBoxes } from '@/core/registry';
// side-effect import：觸發 RTE 於模組載入時自我註冊（registry.ts 的 registerBox）。
// 沒有這行 listBoxes() 恆為空、整個 App 沒有盒型可渲染——registry.ts 的設計是
// UI 透過 listBoxes()/getBox() 消費盒型資料，不直接 import 各盒型模組讀取其內容，
// 但「觸發註冊」仍需要某處的 side-effect import，App 作為組裝根是合理的落點
// （Slice 2 新增 boxes/telescope.ts 時，只需在這裡多加一行 import）。
import '@/boxes/reverse-tuck-end';
import type { LocalizedText } from '@/core/types';
import { useParams } from '@/ui/useParams';
import { ParamPanel } from '@/ui/ParamPanel';
import { Canvas } from '@/ui/Canvas';
import { ExportBar } from '@/ui/ExportBar';

export function App() {
  const boxes = useMemo(() => listBoxes(), []);
  // boxes[0] 保證存在：上方 side-effect import 讓 RTE 恆註冊，v1 registry 不會是空的。
  const [boxId, setBoxId] = useState<string>(() => boxes[0]!.meta.id);
  const { mod, values, overriddenKeys, setValue, resetOne, reset } = useParams(boxId);
  const [highlightTags, setHighlightTags] = useState<string[] | null>(null);

  const result = useMemo(() => mod.generate(values), [mod, values]);

  const invariantWarnings = useMemo(
    () =>
      mod.invariants
        .map((inv) => inv.check(values, result))
        .filter((r): r is { ok: false; message: LocalizedText; tags?: string[] } => !r.ok),
    [mod, values, result],
  );

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <aside className="w-[320px] flex-shrink-0 flex flex-col gap-6 overflow-y-auto p-5 border-r border-zinc-800">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-bold uppercase tracking-widest text-zinc-100">open-dieline</h1>
          <button
            type="button"
            onClick={reset}
            title="清除全部參數覆寫，回到預設值"
            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-orange-400"
          >
            重設全部
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="box-select" className="text-[10px] uppercase tracking-wider text-zinc-400">
            盒型
          </label>
          <select
            id="box-select"
            value={boxId}
            onChange={(e) => setBoxId(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-sm text-sm py-1.5 px-2 text-zinc-100 focus:outline-none focus:border-orange-500"
          >
            {boxes.map((b) => (
              <option key={b.meta.id} value={b.meta.id}>
                {b.meta.name.zh}
              </option>
            ))}
          </select>
        </div>

        <ParamPanel
          params={mod.params}
          values={values}
          overriddenKeys={overriddenKeys}
          onChange={setValue}
          onResetOne={resetOne}
          onHighlight={setHighlightTags}
        />

        <ExportBar boxId={boxId} values={values} result={result} />
      </aside>

      <main className="flex-1 flex">
        <Canvas result={result} highlightTags={highlightTags} invariantWarnings={invariantWarnings} />
      </main>
    </div>
  );
}
