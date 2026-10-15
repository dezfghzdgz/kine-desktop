/**
 * Jak appka mluví s Kine.
 *
 *  - Každý požadavek na Kine nese hlavičku "X-Kine-App: clipper/0.11.0"
 *    (varianta/verze). Server podle ní pozná zastaralou appku a nepustí ji
 *    nahrávat ani vysílat (na webu lib/desktopClient.ts) - appka pak ukáže
 *    "aktualizuj". Starší verze hlavičku neposílají a server je pozná taky.
 *  - Zabalená appka mluví jen s oficiálním Kine. Adresu webu jde v nastavení
 *    změnit (vývoj na localhostu) - kdyby šla libovolná, stačil by vlastní
 *    "web", který appce řekne, že má předplatné.
 *
 * Čistá logika (tests/kineClient.test.mjs).
 */

export const OFFICIAL_SITE = 'https://www.playkine.com';
export const KINE_APP_HEADER = 'X-Kine-App';

const OFFICIAL_HOSTS = new Set(['www.playkine.com', 'playkine.com', 'kine-lac.vercel.app']);

export function kineAppHeader(variant: 'full' | 'clipper', version: string): string {
  return `${variant === 'clipper' ? 'clipper' : 'full'}/${String(version).trim().replace(/^v/, '')}`;
}

/** Je to oficiální adresa Kine (https a naše doména)? */
export function isOfficialSite(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.host.toLowerCase();
    return OFFICIAL_HOSTS.has(host) || host.endsWith('.playkine.com');
  } catch {
    return false;
  }
}

/** Adresa webu, se kterou smí appka mluvit: zabalená (ne testy) jen s oficiálním Kine. */
export function guardSiteUrl(url: string, opts: { packaged: boolean; test: boolean }): string {
  if (!opts.packaged || opts.test) return url;
  return isOfficialSite(url) ? url : OFFICIAL_SITE;
}

/** Je appka starší, než Kine vyžaduje (/api/desktop/config - minDesktopVersion)? */
export function appOutdated(version: string, minVersion: unknown): boolean {
  if (typeof minVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(minVersion.trim())) return false;
  const a = String(version).trim().replace(/^v/, '').split('.').map((x) => parseInt(x, 10));
  const b = minVersion.trim().split('.').map((x) => parseInt(x, 10));
  if (a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** fetch, který ke každému požadavku přidá hlavičku appky. */
export function withKineHeader(fetchImpl: typeof fetch, header: string): typeof fetch {
  return ((input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? undefined);
    headers.set(KINE_APP_HEADER, header);
    return fetchImpl(input, { ...(init ?? {}), headers });
  }) as typeof fetch;
}
