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

/**
 * Přehrávač klipu přímo ve stránce (místo otvírání externího programu):
 * video přes celou šířku, pod ním název a tlačítko zavřít. Escape zavře.
 * Když Chromium soubor nepřehraje (rozbité časy, kodek), místo černa se
 * ukáže důvod a tlačítko na přehrávač systému; chyba jde do protokolu.
 */
export function inlinePlayer(
  clip: Clip,
  labels: { close: string; error: (message: string) => string; openExternal: string },
  onClose: () => void,
  onOpenExternal: () => void,
  onLog?: (message: string) => void
): HTMLElement {
  const video = h('video', { class: 'player-video', src: fileUrl(clip.file), controls: true, autoplay: true, preload: 'auto' }) as HTMLVideoElement;
  const stage = h('div', { class: 'player-stage' }, video);
  const box = h(
    'div',
    { class: 'player' },
    stage,
    h(
      'div',
      { class: 'player-bar' },
      h('div', { class: 'title', title: clip.title }, clip.title),
      h('button', { class: 'small quiet', onclick: onClose }, labels.close)
    )
  );
  const MEDIA_ERRORS: Record<number, string> = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported' };
  const fail = (why: string) => {
    onLog?.(`přehrávač: ${why} - ${clip.file}`);
    clear(stage);
    stage.append(
      h(
        'div',
        { class: 'player-error' },
        h('p', {}, labels.error(why)),
        h('button', { class: 'small', onclick: onOpenExternal }, labels.openExternal)
      )
    );
  };
  video.addEventListener('error', () => {
    const err = video.error;
    fail(err ? `${MEDIA_ERRORS[err.code] ?? err.code}${err.message ? ': ' + err.message : ''}` : 'error');
  });
  // Soubor se otevřel, ale nic se nerozjelo (žádná metadata do 8 s) - taky chyba.
  const guard = setTimeout(() => {
    if (video.readyState === 0 && video.isConnected) fail('no-metadata');
  }, 8000);
  video.addEventListener('loadedmetadata', () => clearTimeout(guard));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !document.fullscreenElement) {
      e.stopPropagation();
      onClose();
    }
  };
  document.addEventListener('keydown', onKey, true);
  // Když karta zmizí (překreslení), posluchač se uklidí sám.
  const observer = new MutationObserver(() => {
    if (!box.isConnected) {
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(guard);
      observer.disconnect();
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // video už je pryč
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return box;
}

export { formatDuration, formatBytes };
