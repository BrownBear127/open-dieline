/**
 * ParamPanel：由 BoxParamDef[] 自動生成的參數面板——換一個 BoxModule 不必改這支檔案。
 *
 * 以 `param.group.zh` 分組渲染（同名分組合併成一個區塊，不要求宣告順序內連續——
 * 這是「以群組名分組」的自然語意，不是 bug）；每列 hover 時回呼 `onHighlight`
 * 供 Canvas 高亮對應幾何，並用 `title` 屬性顯示教育說明（`description.zh`，Slice 2
 * 才打磨成正式 tooltip，見 開發紀錄 裁決）。
 */
import type { ChangeEvent, ReactNode } from 'react';
import type { BoxParamDef, ResolvedParams } from '@/core/types';

export interface ParamPanelProps {
  params: BoxParamDef[];
  values: ResolvedParams;
  overriddenKeys: ReadonlySet<string>;
  onChange: (key: string, value: number | boolean | string) => void;
  onResetOne: (key: string) => void;
  onHighlight: (tags: string[] | null) => void;
}

const LABEL_CLASS = 'text-[10px] uppercase tracking-wider text-zinc-400';
const CONTROL_BASE_CLASS =
  'w-full bg-white border-b text-sm py-1 px-2 text-right font-mono focus:outline-none focus:border-black transition-colors';

/**
 * 單一參數列：定義在模組層級，不在 ParamPanel render 內宣告——前身 `index.tsx` 的
 * `InputGroup` 是每次父層 render 都重新宣告的行內元件（component identity 每次都變，
 * React 會把舊 DOM 卸載重掛，輸入框失焦、效能浪費），這裡把它拉到模組層級，
 * 只用 props 傳資料，identity 穩定（spec Step 3 明文的反模式修正）。
 */
function ParamRow({
  param,
  value,
  isOverridden,
  onChange,
  onResetOne,
  onHighlight,
}: {
  param: BoxParamDef;
  value: number | boolean | string;
  isOverridden: boolean;
  onChange: (key: string, value: number | boolean | string) => void;
  onResetOne: (key: string) => void;
  onHighlight: (tags: string[] | null) => void;
}): ReactNode {
  const inputId = `param-${param.key}`;
  const valueToneClass = isOverridden ? 'border-zinc-300 text-zinc-900' : 'border-zinc-200 text-zinc-400';

  const handleNumberChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') return; // 空字串：不寫入 overrides，保持前值（不炸，見 spec 裁決）
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return; // 非法數值：同上
    onChange(param.key, parsed);
  };

  let control: ReactNode;
  if (param.unit === 'bool') {
    control = (
      <input
        id={inputId}
        type="checkbox"
        checked={value as boolean}
        onChange={(e) => onChange(param.key, e.target.checked)}
        className="h-4 w-4 accent-blue-600"
      />
    );
  } else if (param.unit === 'enum') {
    control = (
      <select
        id={inputId}
        value={value as string}
        onChange={(e) => onChange(param.key, e.target.value)}
        className={`${CONTROL_BASE_CLASS} ${valueToneClass}`}
      >
        {param.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label.zh}
          </option>
        ))}
      </select>
    );
  } else {
    // unit === 'mm' | 'deg'
    control = (
      <input
        id={inputId}
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value as number}
        onChange={handleNumberChange}
        className={`${CONTROL_BASE_CLASS} ${valueToneClass}`}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-0.5"
      onMouseEnter={() => onHighlight(param.highlightTags ?? null)}
      onMouseLeave={() => onHighlight(null)}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={inputId} title={param.description.zh} className={LABEL_CLASS}>
          {param.label.zh}
        </label>
        {isOverridden && (
          <button
            type="button"
            onClick={() => onResetOne(param.key)}
            title="重設為預設值"
            aria-label={`重設「${param.label.zh}」為預設值`}
            className="text-zinc-500 hover:text-blue-600 text-xs leading-none shrink-0"
          >
            ↺
          </button>
        )}
      </div>
      {control}
    </div>
  );
}

/** 依 group.zh 分組，保留每組內原宣告順序；組的出現順序＝該組第一個成員在 params 中的位置。 */
function groupParams(params: BoxParamDef[]): { name: string; items: BoxParamDef[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, BoxParamDef[]>();
  for (const p of params) {
    const key = p.group.zh;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(p);
  }
  return order.map((name) => ({ name, items: buckets.get(name)! }));
}

export function ParamPanel({ params, values, overriddenKeys, onChange, onResetOne, onHighlight }: ParamPanelProps) {
  const groups = groupParams(params);
  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g) => (
        <div key={g.name} className="p-3 bg-zinc-50 border border-zinc-200 rounded-sm">
          <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">{g.name}</h3>
          <div className="grid grid-cols-2 gap-2">
            {g.items.map((p) => (
              <ParamRow
                key={p.key}
                param={p}
                // values 由 resolveParams 依 p.params 逐一填入（registry.ts），每個宣告 key 保證有值——
                // 非空斷言在此安全（與 registry.ts 內 `overrides![...]!` 同一慣例）。
                value={values[p.key]!}
                isOverridden={overriddenKeys.has(p.key)}
                onChange={onChange}
                onResetOne={onResetOne}
                onHighlight={onHighlight}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
