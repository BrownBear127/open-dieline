import { dict } from '@/i18n/dict';
import type { DictKey } from '@/i18n/dict';
import { getLang as getStoredLang } from '@/i18n/lang';
import type { Lang } from '@/i18n/lang';

export type { Lang } from '@/i18n/lang';

export function getLang(): Lang {
  return getStoredLang();
}

export function t(key: DictKey, params: Record<string, string | number> = {}): string {
  const template = dict[key][getLang()];
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing i18n parameter: ${name}`);
    }
    return String(value);
  });
}
