import { LANGS, type Lang } from '../types';
import { en, type Key } from './en';
import { cs } from './cs';
import { sk } from './sk';
import { de } from './de';
import { pl } from './pl';
import { es } from './es';
import { fr } from './fr';
import { uk } from './uk';

/**
 * Texty appky v osmi jazycích (stejných jako web Kine). Angličtina je
 * výchozí a zdroj klíčů; jazyk si hráč vybere hned v průvodci nebo
 * v nastavení.
 */
export type { Key };

export const DICTS: Record<Lang, Record<Key, string>> = { en, cs, sk, de, pl, es, fr, uk };

/** Jak se jazyk jmenuje sám sobě (pro výběr jazyka). */
export const LANG_NAMES: Record<Lang, string> = {
  en: 'English',
  cs: 'Čeština',
  sk: 'Slovenčina',
  de: 'Deutsch',
  pl: 'Polski',
  es: 'Español',
  fr: 'Français',
  uk: 'Українська',
};

/** Kód pro toLocaleString / toLocaleDateString. */
export const LOCALES: Record<Lang, string> = {
  en: 'en-GB',
  cs: 'cs-CZ',
  sk: 'sk-SK',
  de: 'de-DE',
  pl: 'pl-PL',
  es: 'es-ES',
  fr: 'fr-FR',
  uk: 'uk-UA',
};

/** Překlad s dosazením {proměnných}. Chybějící klíč vrátí angličtinu, nebo klíč sám - ať je to vidět, ne prázdno. */
export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let text: string = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

export function makeT(lang: Lang) {
  return (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);
}

/** Jazyk systému, pokud ho appka umí - jinak null (a zůstane angličtina). */
export function langFromLocale(locale: string): Lang | null {
  const code = locale.toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(code) ? (code as Lang) : null;
}
