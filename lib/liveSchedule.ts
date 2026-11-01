/**
 * Plánované vysílání (čistá logika - tests/liveSchedule.test.mjs).
 *
 * Streamer ve studiu nastaví, kdy začne (a o čem). Na kanálu a na stránce
 * přenosu se ukáže odpočet s tlačítkem „Připomenout“ - kdo klikne, dostane
 * oznámení (i push), až vysílání začne. Připomenutí platí pro nejbližší
 * vysílání kanálu; po něm se smaže. Plán, jehož čas dávno prošel, se
 * neukazuje (a úklid ho smaže).
 */

/** Nejdřív za tolik od teď (aby to dávalo smysl připomínat). */
export const SCHEDULE_MIN_AHEAD_MS = 60 * 1000;
/** Nejpozději za tolik (60 dní). */
export const SCHEDULE_MAX_AHEAD_MS = 60 * 24 * 3600 * 1000;
/** Po plánovaném začátku se ještě ukazuje „začne každou chvíli“, pak plán propadne. */
export const SCHEDULE_GRACE_MS = 2 * 3600 * 1000;
export const SCHEDULE_TITLE_MAX = 100;
/** Kolik připomenutí smí mít jeden účet naráz (proti skriptům). */
export const REMINDERS_PER_USER = 200;

export type ScheduleInput = { startsAt?: unknown; title?: unknown; game?: unknown };
export type ScheduleResult =
  | { ok: true; startsAt: string; title: string; game: string | null }
  | { ok: false; reason: 'invalid' | 'time-past' | 'time-far' };

const GAME_SLUG = /^[a-z0-9-]{1,40}$/;

/** Zkontroluje plán ze studia: čas (ISO) v rozumném rozsahu, název do 100 znaků, hra jako slug. */
export function validateSchedule(input: ScheduleInput, now = Date.now()): ScheduleResult {
  if (typeof input.startsAt !== 'string' || input.startsAt.length > 40) return { ok: false, reason: 'invalid' };
  const at = Date.parse(input.startsAt);
  if (!Number.isFinite(at)) return { ok: false, reason: 'invalid' };
  if (at < now + SCHEDULE_MIN_AHEAD_MS) return { ok: false, reason: 'time-past' };
  if (at > now + SCHEDULE_MAX_AHEAD_MS) return { ok: false, reason: 'time-far' };
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, SCHEDULE_TITLE_MAX) : '';
  const game = typeof input.game === 'string' && GAME_SLUG.test(input.game) ? input.game : null;
  // Na celé minuty - odpočet "za 0:59" kvůli vteřinám z formuláře by působil divně.
  const rounded = Math.round(at / 60000) * 60000;
  return { ok: true, startsAt: new Date(rounded).toISOString(), title, game };
}

/** Platí plán ještě (nepropadl)? */
export function scheduleCurrent(startsAt: string | null | undefined, now = Date.now()): boolean {
  if (!startsAt) return false;
  const at = Date.parse(startsAt);
  return Number.isFinite(at) && at + SCHEDULE_GRACE_MS > now;
}

/**
 * Odpočet jako hodiny: "2:14:05" (pod den), "14:05" (pod hodinu).
 * Nad den null - tam se ukáže "za 3 dny" (Intl.RelativeTimeFormat).
 */
export function countdownClock(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  if (ms >= 24 * 3600 * 1000) return null;
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Kolik kalendářních dní (místní čas) do začátku: 1 = zítra, 2 = pozítří...
 * Podle data, ne podle 24hodinových úseků - vysílání v pondělí ve 20:00 je
 * v neděli v poledne "zítra", i když do něj zbývá přes 24 hodin.
 */
export function calendarDaysUntil(startMs: number, now = Date.now()): number {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(startMs);
  to.setHours(0, 0, 0, 0);
  // Zaokrouhlení kvůli změně času (den má 23 nebo 25 hodin).
  return Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000));
}
