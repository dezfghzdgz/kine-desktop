import type { Clip } from '../shared/types';
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
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'value') (el as any)[key] = value;
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

/** Cesta k souboru jako adresa pro <img>. */
export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`);
}

export function clipMeta(clip: Clip, lang: 'cs' | 'en'): string {
  const date = new Date(clip.createdAt);
  const when = date.toLocaleString(lang === 'cs' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const parts = [when, formatDuration(clip.durationSeconds), formatBytes(clip.sizeBytes)];
  if (clip.width && clip.height) parts.push(`${clip.width}×${clip.height}`);
  return parts.join(' · ');
}

export { formatDuration, formatBytes };
