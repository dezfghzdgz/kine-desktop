import type { Clip, Lang } from '../shared/types';
import { LOCALES, type Key } from '../shared/i18n';
import { formatBytes, formatDuration } from '../shared/clipNaming';

/** Malý stavitel prvků - bez knihovny, stránky jsou jednoduché. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'string') el.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'value' || key === 'muted' || key === 'autoplay' || key === 'controls') (el as any)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Cesta k souboru jako adresa pro <img> / <video>. */
export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  // encodeURI nechává # a ? - v názvu hry být můžou a rozbily by adresu.
  return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

export function clipMeta(clip: Clip, lang: Lang): string {
  const date = new Date(clip.createdAt);
  const when = date.toLocaleString(LOCALES[lang] ?? 'en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const parts = [when, formatDuration(clip.durationSeconds), formatBytes(clip.sizeBytes)];
  if (clip.width && clip.height) parts.push(`${clip.width}×${clip.height}`);
  return parts.join(' · ');
}

export function formatDate(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(LOCALES[lang] ?? 'en-GB');
}

/**
 * Chyby z hlavního procesu chodí jako kódy ("bad-credentials"); tady se
 * z nich stane text v jazyce hráče. Neznámý kód se ukáže tak, jak přišel.
 */
export function errorText(err: unknown, t: (key: Key, vars?: Record<string, string | number>) => string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron obaluje chyby z hlavního procesu: "Error invoking remote method '...': Error: text"
  const message = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const codes: Record<string, Key> = {
    'bad-credentials': 'authErrBadCredentials',
    'email-not-confirmed': 'authErrEmailNotConfirmed',
    'rate-limit': 'authErrRateLimit',
    'link-expired': 'authErrLinkExpired',
    'browser-timeout': 'authErrBrowserTimeout',
    cancelled: 'authErrCancelled',
    'bad-state': 'authErrBadState',
  };
  if (codes[message]) return t(codes[message]);
  if (message.startsWith('no-config:')) return t('authErrNoConfig', { message: message.slice('no-config:'.length) });
  return message;
}

export { formatDuration, formatBytes };
