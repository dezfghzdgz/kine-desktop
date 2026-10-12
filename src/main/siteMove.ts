/**
 * Kine se přestěhuje na vlastní doménu (třeba kine.cz místo
 * kine-lac.vercel.app) - appka si novou adresu vezme sama, nikdo nic
 * nepřepisuje v nastavení.
 *
 * Web v /api/desktop/config posílá svou hlavní adresu (siteUrl). Když se
 * liší od té, se kterou appka mluví, appka se na novou adresu zeptá taky
 * a přejde na ni jen tehdy, když tam běží stejné Kine (stejná databáze
 * Supabase) a nová adresa potvrdí sama sebe. Nikdy z vlastní domény zpátky
 * na *.vercel.app a nikdy z vývojové adresy (localhost). Přihlášení
 * zůstává - relace patří k databázi, ne k adrese.
 */

export type SiteConfig = { supabaseUrl?: unknown; siteUrl?: unknown };

/** Adresa webu bez lomítka na konci a s malými písmeny v doméně, nebo null. */
export function normalizeSite(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

const isLocal = (host: string) => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host);
const isVercelApp = (host: string) => /\.vercel\.app$/i.test(host);

/**
 * Nová adresa, kterou web hlásí jako svou hlavní - nebo null, když se nemá
 * nic měnit (stejná adresa, neplatná, http, localhost, nebo by to byl
 * krok zpátky z vlastní domény na *.vercel.app).
 */
export function announcedSite(current: string, served: SiteConfig | null | undefined): string | null {
  const from = normalizeSite(current);
  const to = normalizeSite(served?.siteUrl);
  if (!from || !to || from === to) return null;
  const fromHost = new URL(from).host;
  const toHost = new URL(to).host;
  if (!from.startsWith('https://') || !to.startsWith('https://')) return null;
  if (isLocal(fromHost) || isLocal(toHost)) return null;
  if (isVercelApp(toHost) && !isVercelApp(fromHost)) return null;
  return to;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

async function readConfig(site: string, fetchImpl: FetchLike): Promise<SiteConfig | null> {
  try {
    const res = await fetchImpl(`${site}/api/desktop/config`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? (body as SiteConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Zeptá se webu na hlavní adresu; vrátí novou adresu, na kterou má appka
 * přejít, nebo null. Nová adresa musí odpovědět stejnou databází a sama
 * sebe potvrdit (jinak by šlo appku poslat kamkoli).
 */
export async function checkSiteMove(current: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string | null> {
  const here = normalizeSite(current);
  if (!here) return null;
  const served = await readConfig(here, fetchImpl);
  const target = announcedSite(here, served);
  if (!target || typeof served?.supabaseUrl !== 'string' || !served.supabaseUrl) return null;
  const there = await readConfig(target, fetchImpl);
  if (!there || there.supabaseUrl !== served.supabaseUrl) return null;
  if (normalizeSite(there.siteUrl) !== target) return null;
  return target;
}
