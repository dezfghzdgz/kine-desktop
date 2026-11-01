/**
 * Ankety v chatu živého vysílání (čistá logika - tests/livePolls.test.mjs).
 *
 * Streamer nebo moderátor chatu položí otázku se 2-4 možnostmi na 30 s až
 * 5 minut. Každý přihlášený divák má jeden hlas (změnit ho nejde - jako na
 * Twitchi). Výsledky vidí, kdo už hlasoval, a všichni po skončení; streamer
 * a moderátoři hned. Kdo jak hlasoval, se nikde neukazuje.
 *
 * Ukládá server (tabulky live_polls / live_poll_votes,
 * supabase-migration-zive-raid-plan-ankety.sql), do chatu přidá zprávu
 * druhu 'poll' - podle ní chat pozná, že je nová anketa.
 */

export const POLL_DURATIONS_S = [30, 60, 120, 180, 300] as const;
export const POLL_DEFAULT_S = 60;
export const POLL_QUESTION_MAX = 120;
export const POLL_OPTION_MAX = 40;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
/** Jak dlouho po skončení chat ještě ukazuje výsledky. */
export const POLL_RESULTS_SHOW_MS = 90 * 1000;

export type PollInput = { question?: unknown; options?: unknown; seconds?: unknown };
export type PollCheck =
  | { ok: true; question: string; options: string[]; seconds: number }
  | { ok: false; reason: 'question' | 'options' | 'duplicate' };

const clean = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Otázka a možnosti z formuláře: oříznuté, prázdné možnosti pryč, 2-4 různé; délka z povolených. */
export function sanitizePoll(input: PollInput): PollCheck {
  const question = clean(input.question, POLL_QUESTION_MAX);
  if (!question) return { ok: false, reason: 'question' };
  const raw = Array.isArray(input.options) ? input.options.slice(0, 8) : [];
  const options = raw.map((o) => clean(o, POLL_OPTION_MAX)).filter(Boolean);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return { ok: false, reason: 'options' };
  if (new Set(options.map((o) => o.toLocaleLowerCase())).size !== options.length) return { ok: false, reason: 'duplicate' };
  const asked = Number(input.seconds);
  const seconds = (POLL_DURATIONS_S as readonly number[]).includes(asked) ? asked : POLL_DEFAULT_S;
  return { ok: true, question, options, seconds };
}

export type PollRow = { id: string; question: string; options: unknown; created_at: string; ends_at: string; closed_at: string | null };
export type PollSummary = {
  id: string;
  question: string;
  options: string[];
  votes: number[];
  percents: number[];
  total: number;
  active: boolean;
  endsAt: string;
  /** Vítězná možnost po skončení (null = nikdo nehlasoval nebo remíza). */
  winner: number | null;
};

/** Možnosti z databáze (jsonb) - jen texty. */
export function pollOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((o): o is string => typeof o === 'string').slice(0, POLL_MAX_OPTIONS) : [];
}

/** Běží anketa? (neukončená a nevypršela) */
export function pollActive(row: Pick<PollRow, 'ends_at' | 'closed_at'>, now = Date.now()): boolean {
  if (row.closed_at) return false;
  const end = Date.parse(row.ends_at);
  return Number.isFinite(end) && end > now;
}

/** Kdy anketa skončila (ukončená ručně / vypršela); null = ještě běží. */
export function pollEndedAt(row: Pick<PollRow, 'ends_at' | 'closed_at'>, now = Date.now()): number | null {
  if (pollActive(row, now)) return null;
  const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
  const end = Date.parse(row.ends_at);
  const at = Number.isFinite(closed) ? Math.min(closed, Number.isFinite(end) ? end : closed) : end;
  return Number.isFinite(at) ? at : now;
}

/** Ukázat anketu v chatu? Běžící vždy, skončenou ještě chvíli s výsledky. */
export function pollVisible(row: Pick<PollRow, 'ends_at' | 'closed_at'>, now = Date.now()): boolean {
  const ended = pollEndedAt(row, now);
  return ended === null || now - ended < POLL_RESULTS_SHOW_MS;
}

/** Souhrn ankety: hlasy, procenta (zaokrouhlená tak, aby dala 100), vítěz. */
export function pollSummary(row: PollRow, counts: { choice: number; votes: number }[], now = Date.now()): PollSummary {
  const options = pollOptions(row.options);
  const votes = options.map((_, i) => counts.filter((c) => Number(c.choice) === i).reduce((s, c) => s + Math.max(0, Number(c.votes) || 0), 0));
  const total = votes.reduce((s, v) => s + v, 0);
  const active = pollActive(row, now);
  let winner: number | null = null;
  if (!active && total > 0) {
    const max = Math.max(...votes);
    const top = votes.flatMap((v, i) => (v === max ? [i] : []));
    winner = top.length === 1 ? top[0] : null;
  }
  return { id: row.id, question: row.question, options, votes, percents: roundedPercents(votes, total), total, active, endsAt: row.ends_at, winner };
}

/** Procenta, která dají dohromady přesně 100 (největší zbytky dostanou +1). */
export function roundedPercents(votes: number[], total: number): number[] {
  if (total <= 0) return votes.map(() => 0);
  const exact = votes.map((v) => (v / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    if (votes[i] > 0) {
      floors[i] += 1;
      left -= 1;
    }
  }
  return floors;
}
