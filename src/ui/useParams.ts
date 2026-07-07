/**
 * useParams：單一盒型的參數狀態管理 hook。
 *
 * 內部只保存「使用者覆寫集」（overrides，一個 Partial map），不保存完整的已解析參數——
 * 每次渲染都用 `resolveParams(mod, overrides)` 重新算出 `values`，未覆寫欄位的
 * `derivedDefault` 會用當下已覆寫的上游值即時重算（spec §3.3、registry.ts 的
 * cascade 行為——見 tests/core/registry.test.ts「override 上游 key 後，下游
 * derivedDefault 讀到覆寫值」一案，本 hook 直接依賴該行為，不重新實作）。
 */
import { useCallback, useMemo, useState } from 'react';
import type { BoxModule, ResolvedParams } from '@/core/types';
import { getBox, resolveParams } from '@/core/registry';

type ParamValue = number | boolean | string;
type OverrideMap = Partial<Record<string, ParamValue>>;

export interface UseParamsResult {
  /** 目前使用中的盒型模組（由 boxId 查得）——App.tsx 靠這個取 params/invariants/generate，不必自己再查一次 registry。 */
  mod: BoxModule;
  /** 目前顯示值＝生成值：覆寫欄位是使用者輸入，未覆寫欄位是 derivedDefault 即時重算或宣告 default。 */
  values: ResolvedParams;
  /** 目前被使用者覆寫過的參數 key 集合——UI 用來決定「灰調（預設/推算）」vs「亮色（已覆寫）」樣式與是否顯示「↺」重設鈕。 */
  overriddenKeys: ReadonlySet<string>;
  /** 使用者手動修改某參數。 */
  setValue: (key: string, value: ParamValue) => void;
  /** 清除單一參數的覆寫，讓它回到 derivedDefault/宣告 default。 */
  resetOne: (key: string) => void;
  /** 清除全部覆寫（brief 介面契約明列的 reset()）。 */
  reset: () => void;
}

export function useParams(boxId: string): UseParamsResult {
  // getBox 找不到 id 會直接擲錯（registry.ts 既有行為）——呼叫端責任是只傳
  // listBoxes() 已知存在的 id（App.tsx 的盒型 select 只會產生這種 id），此處不重複防禦。
  const mod = getBox(boxId);

  // 切換 boxId 時同步清空 overrides：在渲染期間（而非 useEffect）呼叫 setOverrides，
  // 讓 React 在同一輪 commit 前用新 state 重新渲染，避免舊盒型的 overrides key
  // 在新 mod 身上因未宣告而讓 resolveParams 於這一輪渲染內就先擲錯
  // （若改用 useEffect 清空，會慢一拍：舊 overrides 先跟新 mod 一起送進
  // resolveParams，若剛好撞到同名但語意不同的 key 或根本沒宣告的 key 就會炸）。
  const [trackedBoxId, setTrackedBoxId] = useState(boxId);
  const [overrides, setOverrides] = useState<OverrideMap>({});
  if (boxId !== trackedBoxId) {
    setTrackedBoxId(boxId);
    setOverrides({});
  }

  const values = useMemo(() => resolveParams(mod, overrides), [mod, overrides]);

  const setValue = useCallback((key: string, value: ParamValue) => {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetOne = useCallback((key: string) => {
    setOverrides((prev) => {
      const { [key]: _removed, ...next } = prev;
      return next;
    });
  }, []);

  const reset = useCallback(() => setOverrides({}), []);

  const overriddenKeys = useMemo(() => new Set(Object.keys(overrides)), [overrides]);

  return { mod, values, overriddenKeys, setValue, resetOne, reset };
}
