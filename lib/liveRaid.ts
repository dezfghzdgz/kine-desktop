/**
 * Raid (čistá logika - tests/liveRaid.test.mjs).
 *
 * Na konci vysílání streamer pošle své diváky k jinému, který právě
 * vysílá (jako na Twitchi). Server si u přenosu poznamená kam a kdy
 * (live_streams.raid_to / raid_at - app/api/live/raid); stránka přenosu
 * to vidí v odpovědi /api/live/status a divákům ukáže odpočet - po něm
 * je přesune. Kdo chce zůstat, klikne „Zůstat“.
 */

/** Jak dlouho po raidu stránka přenosu posílá diváky dál (i když vysílání mezitím skončilo). */
export const RAID_REDIRECT_MS = 3 * 60 * 1000;
/** Odpočet na stránce přenosu, než se divák přesune (sekundy). */
export const RAID_COUNTDOWN_S = 10;
/** Jeden kanál smí poslat raid nejvýš jednou za tolik. */
export const RAID_COOLDOWN_MS = 5 * 60 * 1000;
/** Ke stejnému kanálu nejvýš tolik raidů za 24 hodin (proti obtěžování). */
export const RAID_PAIR_PER_DAY = 3;

export type RaidRow = { raid_to?: string | null; raid_at?: string | null; started_at?: string | null };

/**
 * Platí raid u přenosu? Jen chvíli po odeslání - a ne, když od té doby
 * začalo nové vysílání (to by diváky nového vysílání poslalo pryč).
 */
export function raidActive(row: RaidRow | null | undefined, now = Date.now()): boolean {
  if (!row?.raid_to || !row.raid_at) return false;
  const at = Date.parse(row.raid_at);
  if (!Number.isFinite(at) || at > now + 60 * 1000 || now - at > RAID_REDIRECT_MS) return false;
  const started = row.started_at ? Date.parse(row.started_at) : NaN;
  return !(Number.isFinite(started) && started > at);
}

/**
 * Text zprávy v chatu cílového kanálu - pro starší stránky a záznam chatu
 * (nové stránky zprávu skládají samy v jazyce diváka podle meta.raid).
 */
export function raidChatBody(name: string, viewers: number | null): string {
  const who = (name || '').trim().slice(0, 60) || 'Někdo';
  return viewers && viewers > 0 ? `⚡ Raid! ${who} sem posílá ${viewers} diváků` : `⚡ Raid! ${who} sem posílá své diváky`;
}

/** Může kanál teď poslat raid? (poslední raid tohoto kanálu, raidy ke stejnému cíli za 24 h) */
export function raidAllowed(lastRaidAt: string | null | undefined, sameTargetToday: number, now = Date.now()): { ok: true } | { ok: false; reason: 'cooldown' | 'pair-limit'; retryS?: number } {
  const last = lastRaidAt ? Date.parse(lastRaidAt) : NaN;
  if (Number.isFinite(last) && now - last < RAID_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', retryS: Math.ceil((RAID_COOLDOWN_MS - (now - last)) / 1000) };
  }
  if (sameTargetToday >= RAID_PAIR_PER_DAY) return { ok: false, reason: 'pair-limit' };
  return { ok: true };
}
