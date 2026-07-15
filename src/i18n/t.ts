import { dict } from '@/i18n/dict';
import type { DictKey } from '@/i18n/dict';

export type Lang = 'en' | 'zh';

export function getLang(): Lang {
  return 'en';
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
