/**
 * Čistá část aktualizací (bez electronu - testuje se): rozbor
 * app-update.yml a porovnání verzí.
 */

export type FeedConfig =
  | { provider: 'generic'; url: string; channel?: string }
  | { provider: 'github'; owner: string; repo: string; channel?: string };

/** Malý rozbor app-update.yml (jen klíče, které potřebujeme - není potřeba knihovna na YAML). */
export function parseUpdateYml(text: string): FeedConfig | null {
  const get = (key: string) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  const provider = get('provider');
  if (provider === 'generic' && get('url')) return { provider: 'generic', url: get('url').replace(/\/+$/, ''), channel: get('channel') || undefined };
  if (provider === 'github' && get('owner') && get('repo')) return { provider: 'github', owner: get('owner'), repo: get('repo'), channel: get('channel') || undefined };
  return null;
}

/** "0.7.0" > "0.6.2"? Porovnání po číslech; neplatná verze = nikdy novější. */
export function isNewerVersion(candidate: string | null | undefined, current: string): boolean {
  if (!candidate) return false;
  const a = String(candidate).trim().replace(/^v/, '').split('.').map((x) => parseInt(x, 10));
  const b = current.trim().replace(/^v/, '').split('.').map((x) => parseInt(x, 10));
  if (a.length === 0 || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
