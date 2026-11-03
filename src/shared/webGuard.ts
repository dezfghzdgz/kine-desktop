import { isOfficialSite } from './kineClient';

/**
 * Web Kine v appce - záložka Kine (Kine do PC) a okno s chatem vysílání, obojí
 * v relaci persist:kine-web: kam smí přejít a jaká oprávnění dostane. Čistá
 * logika (tests/webGuard.test.mjs); main.ts ji napojí na relaci a na přechody.
 */

/** Adresa patří ke Kine z nastavení (stejný web; playkine.com a www.playkine.com jsou totéž). */
export function isKineUrl(url: string, siteUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(siteUrl);
    const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
    return a.protocol === b.protocol && a.port === b.port && host(a.hostname) === host(b.hostname);
  } catch {
    return false;
  }
}

/**
 * Kine pro přechody a oprávnění: web z nastavení, nebo oficiální adresa Kine
 * (https, naše doména) - třeba přesměrování ze staré adresy na vlastní doménu,
 * než si ji appka sama vezme (siteMove.ts).
 */
export function isKineSite(url: string, siteUrl: string): boolean {
  return isKineUrl(url, siteUrl) || isOfficialSite(url);
}

/**
 * Vložený rámec (přehrávač, ochrana proti botům) smí jen na web - ne na kine://
 * ani na jiné protokoly, které by otevřel systém.
 */
export function isWebFrameUrl(url: string): boolean {
  return /^(?:https?:|about:|blob:|data:)/i.test(url);
}

export type KineWebPermissionRequest = {
  /** Adresa rámce, který o oprávnění žádá (u kontroly bez stránky aspoň jeho původ). */
  requestingUrl?: string | null;
  /** Žádá hlavní stránka okna (ne vložený rámec)? */
  isMainFrame?: boolean;
  /** Adresa hlavní stránky okna - celá obrazovka z přehrávače vloženého do stránky Kine. */
  topUrl?: string | null;
};

/** Jen stránkám Kine: oznámení a zápis do schránky (tlačítko Kopírovat odkaz). */
const FROM_KINE = new Set(['notifications', 'clipboard-sanitized-write']);
/** Celá obrazovka a zámek myši: i přehrávači vloženému do stránky Kine (hlavní stránka je Kine). */
const IN_KINE_PAGE = new Set(['fullscreen', 'pointerLock']);

/**
 * Smí web v relaci persist:kine-web oprávnění dostat? Kamera a mikrofon jen hlavní
 * stránce Kine; všechno, co tu není (poloha, MIDI, zařízení, openExternal - otevírání
 * jiných protokolů systémem…), nikdo.
 */
export function kineWebPermission(permission: string, request: KineWebPermissionRequest, siteUrl: string): boolean {
  const fromKine = !!request.requestingUrl && isKineSite(request.requestingUrl, siteUrl);
  if (permission === 'media') return fromKine && request.isMainFrame === true;
  if (FROM_KINE.has(permission)) return fromKine;
  if (IN_KINE_PAGE.has(permission)) return fromKine || (!!request.topUrl && isKineSite(request.topUrl, siteUrl));
  return false;
}
