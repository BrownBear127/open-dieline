/**
 * ParamPanel：由 BoxParamDef[] 自動生成的參數面板——換一個 BoxModule 不必改這支檔案。
 *
 * 以穩定的 `param.group.id` 分組渲染（同 id 合併成一個區塊，不要求宣告順序
 * 內連續）；群組名、參數名與說明都透過單一語言 accessor 讀取。每列 hover 時回呼
 * `onHighlight` 供 Canvas 高亮對應幾何。
 */
import type { ChangeEvent, ReactNode } from 'react';
import type { BoxParamDef, ResolvedParams } from '@/core/types';
import { getLang, t } from '@/i18n/t';

export interface ParamPanelProps {
  params: BoxParamDef[];
  values: ResolvedParams;
  overriddenKeys: ReadonlySet<string>;
  onChange: (key: string, value: number | boolean | string) => void;
  onResetOne: (key: string) => void;
  onHighlight: (tags: string[] | null) => void;
}

/**
 * 單一參數列：定義在模組層級，不在 ParamPanel render 內宣告——前身 `index.tsx` 的
 * `InputGroup` 是每次父層 render 都重新宣告的行內元件（component identity 每次都變，
 * React 會把舊 DOM 卸載重掛，輸入框失焦、效能浪費），這裡把它拉到模組層級，
 * 只用 props 傳資料，identity 穩定（brief Step 3 明文的反模式修正）。
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
  const lang = getLang();
  const label = param.label[lang];
  const controlClass = `param-control${isOverridden ? ' is-overridden' : ''}`;

  const handleNumberChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') return; // 空字串：不寫入 overrides，保持前值（不炸，見 brief 裁決）
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
        className="tick"
      />
    );
  } else if (param.unit === 'enum') {
    control = (
      <div className="boxsel param-select">
        <select
          id={inputId}
          value={value as string}
          onChange={(e) => onChange(param.key, e.target.value)}
          className={controlClass}
        >
          {param.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label[lang]}
            </option>
          ))}
        </select>
      </div>
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
        className={controlClass}
      />
    );
  }

  return (
    <div
      className="param"
      onMouseEnter={() => onHighlight(param.highlightTags ?? null)}
      onMouseLeave={() => onHighlight(null)}
    >
      <div className="param-head">
        <label htmlFor={inputId} title={param.description[lang]} className="mono">
          {label}
        </label>
        {isOverridden && (
          <button
            type="button"
            onClick={() => onResetOne(param.key)}
            title={t('param.reset.title')}
            aria-label={t('param.reset.aria', { label })}
            className="param-reset"
          >
            {t('param.reset.glyph')}
          </button>
        )}
      </div>
      {control}
    </div>
  );
}

/** 依 group.id 分組，保留每組內原宣告順序；組的出現順序＝該組第一個成員在 params 中的位置。 */
function groupParams(params: BoxParamDef[]): { id: string; label: string; items: BoxParamDef[] }[] {
  const order: string[] = [];
  const buckets = new Map<string, BoxParamDef[]>();
  for (const param of params) {
    const groupId = param.group.id;
    let bucket = buckets.get(groupId);
    if (!bucket) {
      bucket = [];
      buckets.set(groupId, bucket);
      order.push(groupId);
    }
    bucket.push(param);
  }
  const lang = getLang();
  return order.map((id) => {
    const items = buckets.get(id)!;
    return { id, label: items[0]!.group[lang], items };
  });
}

export function ParamPanel({ params, values, overriddenKeys, onChange, onResetOne, onHighlight }: ParamPanelProps) {
  const groups = groupParams(params);
  return (
    <>
      {groups.map((group, index) => (
        <section key={group.id} className="sect" data-group-id={group.id}>
          <div className="sect-head">
            <h3 className="label">{group.label}</h3>
            <span className="mono">{t('console.group.no', { nn: String(index + 1).padStart(2, '0') })}</span>
          </div>
          <div>
            {group.items.map((param) => (
              <ParamRow
                key={param.key}
                param={param}
                // values 由 resolveParams 依 params 逐一填入（registry.ts），每個宣告 key 保證有值——
                // 非空斷言在此安全（與 registry.ts 內 `overrides![...]!` 同一慣例）。
                value={values[param.key]!}
                isOverridden={overriddenKeys.has(param.key)}
                onChange={onChange}
                onResetOne={onResetOne}
                onHighlight={onHighlight}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
