import type { Plan, PlanPrices } from './types';

/**
 * Předplatné v appce (stejná pravidla jako lib/plus.ts na webu).
 *
 * Tři placené varianty:
 *  - Kine Plus  ('kine')  - web: odznak PLUS, vyšší denní limit nahrávání…
 *  - Klipy Plus ('clips') - appka: automatické nahrávání po hře, klipy až 5 minut
 *  - Kine Plus + Klipy ('all') - obojí; starší hodnota 'plus' znamená totéž
 *
 * Zdarma: klipování bez omezení, klipy do 60 s, nahrání na Kine ručně
 * (okýnko po hře, záložka Klipy) se stejnými pravidly jako každé video.
 *
 * Co appka smí, jí říká Kine (/api/desktop/me) - tady je jen výchozí
 * stav pro nepřihlášené a pojistka, kdyby server neodpověděl.
 */
export type { Plan, PlanPrices };

export const FREE_CLIP_MAX_SECONDS = 60;
export const PLUS_CLIP_MAX_SECONDS = 300;

export const FREE_CLIP_OPTIONS = [15, 30, 45, 60] as const;
export const PLUS_CLIP_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 300] as const;

export const NO_PRICES: PlanPrices = { kine: null, clips: null, all: null };

export type AccountInfo = {
  userId: string;
  username: string;
  email: string | null;
  plan: Plan;
  planUntil: string | null;
  clipsPlus: boolean;
  kinePlus: boolean;
  maxClipSeconds: number;
  plusAvailable: boolean;
  prices: PlanPrices;
  brandColor: string | null;
};

/** Očistí hodnotu plánu ze serveru; neznámé = free. */
export function normalizePlan(value: unknown): Plan {
  return value === 'kine' || value === 'clips' || value === 'all' || value === 'plus' ? value : 'free';
}

/** Klipy Plus: automatické nahrávání a dlouhé klipy. */
export function hasClipsPlus(plan: Plan | null | undefined): boolean {
  return plan === 'clips' || plan === 'all' || plan === 'plus';
}

/** Kine Plus (web). */
export function hasKinePlus(plan: Plan | null | undefined): boolean {
  return plan === 'kine' || plan === 'all' || plan === 'plus';
}

export function clipOptionsFor(plan: Plan | null | undefined): readonly number[] {
  return hasClipsPlus(plan) ? PLUS_CLIP_OPTIONS : FREE_CLIP_OPTIONS;
}

export function maxClipSecondsFor(account: { plan: Plan; maxClipSeconds?: number } | null | undefined): number {
  if (!account) return FREE_CLIP_MAX_SECONDS;
  if (account.maxClipSeconds && account.maxClipSeconds > 0) return account.maxClipSeconds;
  return hasClipsPlus(account.plan) ? PLUS_CLIP_MAX_SECONDS : FREE_CLIP_MAX_SECONDS;
}

/** "#a34ff7" nebo "#af7" -> "163, 79, 247"; neplatná barva -> null. */
export function hexToRgbTriplet(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** Nastaví barvu Kine do CSS proměnných stránky (i pro toast). */
export function applyBrandColor(root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } }, hex: string | null | undefined): void {
  const rgb = hexToRgbTriplet(hex);
  if (!rgb) {
    root.style.removeProperty('--brand');
    root.style.removeProperty('--brand-rgb');
    return;
  }
  root.style.setProperty('--brand', `#${hex!.trim().replace(/^#/, '')}`);
  root.style.setProperty('--brand-rgb', rgb);
}
