/**
 * 盒型 registry：插件註冊與參數解析。
 *
 * 模組層級的全域狀態（單例 Map）——盒型插件（boxes/*.ts）在模組載入時呼叫 registerBox()
 * 自我註冊，UI 層透過 listBoxes()/getBox() 消費，不直接 import 各盒型模組。
 * 純 TS 模組，不 import React 或任何 UI。
 */

import type { BoxModule, BoxParamDef, ResolvedParams } from '@/core/types';

const registry = new Map<string, BoxModule>();

/**
 * 驗證單一參數宣告的 unit/default/options/derivedDefault 組合是否合法。
 *
 * `BoxParamDef` 是非 discriminated union 的公開型別（型別重構留給 Slice 2），型別檢查
 * 本身放行「unit='enum' 卻沒宣告 options」「unit='bool' 卻配字串 default」這類無效組合——
 * 錯的插件過去要等 UI 消費時才會壞（ParamPanel 讀到 undefined 的 options、或顯示格式
 * 錯亂），這裡在 registerBox 當下就擋下，擲錯訊息含盒型 id 與參數 key 方便定位。
 */
function validateBoxParamDef(paramDef: BoxParamDef, boxId: string): void {
  const { key, unit, default: def } = paramDef;
  const where = `盒型「${boxId}」的參數「${key}」`;

  if (unit === 'enum') {
    if (!paramDef.options || paramDef.options.length === 0) {
      throw new Error(`registerBox: ${where} unit 為 enum，但未宣告 options（或 options 為空陣列）`);
    }
    const validValues = paramDef.options.map((o) => o.value);
    if (!validValues.includes(def as string)) {
      throw new Error(
        `registerBox: ${where} default「${String(def)}」不在 options 值域內（合法值：${validValues.join('、')}）`,
      );
    }
  } else if (unit === 'bool') {
    if (typeof def !== 'boolean') {
      throw new Error(`registerBox: ${where} unit 為 bool，但 default 不是 boolean（實際型別：${typeof def}）`);
    }
  } else {
    // unit === 'mm' | 'deg'
    if (typeof def !== 'number') {
      throw new Error(`registerBox: ${where} unit 為「${unit}」，但 default 不是 number（實際型別：${typeof def}）`);
    }
    if (paramDef.min !== undefined && def < paramDef.min) {
      throw new Error(`registerBox: ${where} default(${def}) 小於 min(${paramDef.min})`);
    }
    if (paramDef.max !== undefined && def > paramDef.max) {
      throw new Error(`registerBox: ${where} default(${def}) 大於 max(${paramDef.max})`);
    }
  }

  if (paramDef.derivedDefault && unit !== 'mm' && unit !== 'deg') {
    throw new Error(
      `registerBox: ${where} unit 為「${unit}」，但宣告了 derivedDefault（derivedDefault 只允許用在 mm/deg 這類 number 參數上）`,
    );
  }
}

/** 註冊一個盒型模組；id 重複視為程式錯誤（同一 id 兩個盒型會讓 UI/測試無法區分），直接擲錯。 */
export function registerBox(m: BoxModule): void {
  if (registry.has(m.meta.id)) {
    throw new Error(`registerBox: 盒型 id「${m.meta.id}」已經註冊過，不可重複註冊（id 需全域唯一）`);
  }
  for (const paramDef of m.params) {
    validateBoxParamDef(paramDef, m.meta.id);
  }
  registry.set(m.meta.id, m);
}

/** 依 id 取回盒型模組；找不到視為呼叫端寫錯 id，直接擲錯（不回傳 undefined 讓錯誤延後才爆炸）。 */
export function getBox(id: string): BoxModule {
  const mod = registry.get(id);
  if (!mod) {
    throw new Error(`getBox: 找不到 id 為「${id}」的盒型（尚未 registerBox()，或 id 拼寫錯誤）`);
  }
  return mod;
}

/** 列出所有已註冊的盒型（供 UI 盒型選單使用）。 */
export function listBoxes(): BoxModule[] {
  return Array.from(registry.values());
}

/** 測試專用：清空 registry，供每個測試案例間隔離（避免前一個測試殘留的 id 讓後續 registerBox 誤判重複）。 */
export function _clearRegistry(): void {
  registry.clear();
}

type OverrideMap = Partial<Record<string, number | boolean | string>>;
type ParamValue = number | boolean | string;

/** overrides 中任何未在 m.params 宣告過的 key 都視為拼錯參數名，直接擲錯（防「假旋鈕」——覆寫了一個不存在的參數，靜默無效）。 */
function validateOverrideKeys(overrides: OverrideMap | undefined, declaredKeys: Set<string>, boxId: string): void {
  if (!overrides) return;
  for (const key of Object.keys(overrides)) {
    if (!declaredKeys.has(key)) {
      const declaredList = [...declaredKeys].join('、') || '（無宣告參數）';
      throw new Error(
        `resolveParams: overrides 含未宣告的參數 key「${key}」（盒型「${boxId}」宣告的參數為：${declaredList}）`,
      );
    }
  }
}

/**
 * 解析單一參數的值，優先序（高到低）：
 *   1. overrides 中對應的 key（含被 derivedDefault 支配的 key）
 *   2. derivedDefault(已解析參數) 的計算結果
 *   3. paramDef.default 的宣告值
 *
 * derivedDefault 只能讀取「宣告順序中先前」已解析完成的參數——用 Proxy 包一層 resolvedSoFar，
 * 對「已宣告、但尚未寫入」的參數 key 的讀取直接擲錯（前向引用防範）：讓錯誤在宣告錯誤的當下爆炸，
 * 而不是讀到 undefined 靜默算出 NaN、流到下游 generate() 才顯露成一個難查的 NaN。
 * 只有「確實是宣告參數」才受此 guard 限制——toString/toJSON/hasOwnProperty/valueOf 等
 * Object.prototype 方法（例如 JSON.stringify(params) 內部會探測 toJSON）從來不是宣告的
 * 參數 key，一律放行走預設 Reflect.get 行為，不可被誤判為前向引用。
 */
function resolveOneParam(
  paramDef: BoxParamDef,
  resolvedSoFar: Record<string, ParamValue>,
  overrides: OverrideMap | undefined,
  declaredKeys: Set<string>,
): ParamValue {
  const hasOverride = overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, paramDef.key);
  if (hasOverride) {
    // hasOverride 已確認該 key 存在於 overrides，non-null assertion 合理
    return overrides![paramDef.key]!;
  }

  if (paramDef.derivedDefault) {
    const guarded = new Proxy(resolvedSoFar, {
      get(target, prop, receiver) {
        if (
          typeof prop === 'string' &&
          declaredKeys.has(prop) &&
          !Object.prototype.hasOwnProperty.call(target, prop)
        ) {
          throw new Error(
            `resolveParams: 參數「${paramDef.key}」的 derivedDefault 讀取了尚未解析的參數「${String(prop)}」` +
              `（前向引用——derivedDefault 只能讀取 params 宣告順序中「先前」已解析的參數；` +
              `請調整宣告順序，或改讓「${String(prop)}」引用「${paramDef.key}」而非反過來）`,
          );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return paramDef.derivedDefault(guarded as ResolvedParams);
  }

  return paramDef.default;
}

/** 依 m.params 宣告順序解析所有參數；overrides 可覆蓋任一已宣告 key（含被 derivedDefault 支配者）。 */
export function resolveParams(m: BoxModule, overrides?: OverrideMap): ResolvedParams {
  const declaredKeys = new Set(m.params.map((p) => p.key));
  validateOverrideKeys(overrides, declaredKeys, m.meta.id);

  return m.params.reduce<Record<string, ParamValue>>(
    (resolvedSoFar, paramDef) => ({
      ...resolvedSoFar,
      [paramDef.key]: resolveOneParam(paramDef, resolvedSoFar, overrides, declaredKeys),
    }),
    {},
  );
}
