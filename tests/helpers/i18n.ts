import { dict } from '@/i18n/dict';
import type { DictKey } from '@/i18n/dict';
import { t } from '@/i18n/t';

export { t };

/** @deprecated Transitional test lookup; remove in M2. Prefer `t('key')` in new assertions. */
export function tByZh(zh: string): string {
  const key = (Object.keys(dict) as DictKey[]).find((candidate) => dict[candidate].zh === zh);
  if (key === undefined) {
    throw new Error(`Missing i18n dictionary entry for zh copy: ${zh}`);
  }
  return t(key);
}
