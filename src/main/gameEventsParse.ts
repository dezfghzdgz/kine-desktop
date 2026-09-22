/**
 * Čistá logika automatických klipů z herních událostí (bez Electronu,
 * testovatelná): čtení zpráv z Counter-Strike 2 (Game State Integration)
 * a League of Legends (Live Client Data API) a skládání zabití do
 * "série", ze které vznikne jeden klip.
 */

export type GameEvent = {
  game: 'cs2' | 'lol';
  kind: 'kill' | 'multikill' | 'ace';
  /** Kolik zabití má série zatím (CS2: zabití v kole; LoL: KillStreak u Multikill, 1 u zabití). */
  count: number;
};

// ---- Counter-Strike 2: Game State Integration ---------------------------------------

export type Cs2State = {
  steamid: string;
  roundKills: number;
  matchKills: number;
  map: string;
};

/**
 * CS2 posílá po každé změně celý stav (hráč, kolo, mapa). Zabití se pozná
 * z nárůstu `player.state.round_kills` (zabití v tomhle kole - to je
 * rovnou i délka série) a `player.match_stats.kills`. Počítá se jen vlastní
 * hráč (`player.steamid` == `provider.steamid`) - při sledování spoluhráče
 * po smrti CS2 posílá jeho statistiky, a ty klip nejsou.
 */
export function cs2Events(prev: Cs2State | null, payload: unknown): { state: Cs2State | null; events: GameEvent[] } {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== 'object') return { state: prev, events: [] };
  const mySteamId = String(p.provider?.steamid ?? '');
  const player = p.player;
  if (!mySteamId || !player || String(player.steamid ?? '') !== mySteamId) return { state: prev, events: [] };

  const roundKills = Number(player.state?.round_kills ?? NaN);
  const matchKills = Number(player.match_stats?.kills ?? NaN);
  const map = String(p.map?.name ?? '');
  const state: Cs2State = {
    steamid: mySteamId,
    roundKills: Number.isFinite(roundKills) ? roundKills : prev?.roundKills ?? 0,
    matchKills: Number.isFinite(matchKills) ? matchKills : prev?.matchKills ?? 0,
    map,
  };
  const events: GameEvent[] = [];
  // Nový zápas / jiná mapa / statistiky klesly = začít od nuly, nic nehlásit.
  const fresh = !prev || prev.steamid !== mySteamId || (map && prev.map && prev.map !== map) || state.matchKills < prev.matchKills;
  if (!fresh && prev) {
    const byRound = Number.isFinite(roundKills) && roundKills > prev.roundKills;
    const byMatch = Number.isFinite(matchKills) && matchKills > prev.matchKills;
    if (byRound || byMatch) {
      const count = byRound ? roundKills : Math.max(1, prev.roundKills + (matchKills - prev.matchKills));
      events.push({ game: 'cs2', kind: count >= 5 ? 'ace' : count >= 2 ? 'multikill' : 'kill', count });
    }
  }
  return { state, events };
}

// ---- League of Legends: Live Client Data API ----------------------------------------

export type LolPlayer = { name: string; riotName?: string };

/** Jméno hráče z API bývá i s "#TAG" - porovnává se bez něj a bez ohledu na velikost písmen. */
function sameName(a: unknown, b: string | undefined): boolean {
  if (typeof a !== 'string' || !b) return false;
  const norm = (s: string) => s.split('#')[0].trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * `/liveclientdata/eventdata` vrací všechny události od začátku hry
 * s rostoucím EventID. Zpracují se jen nové (EventID > lastId) a jen ty,
 * kde je hráč sám zabijákem: ChampionKill (1), Multikill (KillStreak),
 * Ace (pentakill-ish - bereme jako 5).
 */
export function lolEvents(payload: unknown, lastId: number, me: LolPlayer): { lastId: number; events: GameEvent[]; restarted: boolean } {
  const list = (payload as { Events?: unknown[] } | null)?.Events;
  if (!Array.isArray(list)) return { lastId, events: [], restarted: false };
  const ids = list.map((e) => Number((e as any)?.EventID)).filter((n) => Number.isFinite(n));
  const maxId = ids.length ? Math.max(...ids) : -1;
  // Nová hra: události začínají znovu od nuly.
  const restarted = lastId >= 0 && maxId < lastId;
  const since = restarted ? -1 : lastId;
  const events: GameEvent[] = [];
  for (const raw of list) {
    const e = raw as Record<string, any>;
    const id = Number(e?.EventID);
    if (!Number.isFinite(id) || id <= since) continue;
    const mine = (who: unknown) => sameName(who, me.name) || sameName(who, me.riotName);
    if (e.EventName === 'ChampionKill' && mine(e.KillerName)) events.push({ game: 'lol', kind: 'kill', count: 1 });
    else if (e.EventName === 'Multikill' && mine(e.KillerName)) {
      const streak = Math.max(2, Number(e.KillStreak) || 2);
      events.push({ game: 'lol', kind: streak >= 5 ? 'ace' : 'multikill', count: streak });
    } else if (e.EventName === 'Ace' && mine(e.Acer)) events.push({ game: 'lol', kind: 'ace', count: 5 });
  }
  return { lastId: Math.max(maxId, restarted ? -1 : lastId), events, restarted };
}

// ---- Série zabití -> jeden klip -------------------------------------------------------

export type AutoClipMode = 'off' | 'multi' | 'every';

/**
 * Zabití chodí po jednom; klip se dělá až když se série uklidní (3,5 s
 * od posledního zabití), nejpozději 12 s od prvního - ať je v klipu
 * i to, co následovalo, a z trojnásobného zabití je jeden klip, ne tři.
 * V režimu 'multi' se klip dělá až od dvou zabití v sérii.
 */
export class KillStreak {
  private count = 0;
  private firstAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: { mode: () => AutoClipMode; now?: () => number; onClip: (count: number) => void; quietMs?: number; maxMs?: number }
  ) {}

  /** Aktuální délka série (pro testy a stav). */
  current(): number {
    return this.count;
  }

  add(event: GameEvent): void {
    if (this.deps.mode() === 'off') return;
    const now = (this.deps.now ?? Date.now)();
    if (this.count === 0) this.firstAt = now;
    // Jednotlivé zabití přičítá, událost se známou délkou série (CS2 round_kills, LoL KillStreak) ji nastaví.
    if (event.kind === 'kill' && event.count <= 1) this.count += 1;
    else this.count = Math.max(this.count, event.count);
    if (this.timer) clearTimeout(this.timer);
    const quiet = this.deps.quietMs ?? 3500;
    const max = this.deps.maxMs ?? 12000;
    const wait = Math.max(0, Math.min(quiet, this.firstAt + max - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const n = this.count;
    this.count = 0;
    if (n <= 0) return;
    if (this.deps.mode() === 'multi' && n < 2) return;
    this.deps.onClip(n);
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.count = 0;
  }
}

/** Klíč překladu podle délky série. */
export function streakLabelKey(count: number): 'autoClipKill' | 'autoClipDouble' | 'autoClipTriple' | 'autoClipQuad' | 'autoClipAce' {
  if (count >= 5) return 'autoClipAce';
  if (count === 4) return 'autoClipQuad';
  if (count === 3) return 'autoClipTriple';
  if (count === 2) return 'autoClipDouble';
  return 'autoClipKill';
}

/** Obsah gamestate_integration_kine.cfg pro CS2 (Valve formát KeyValues). */
export function cs2GsiConfig(port: number, token: string): string {
  return [
    '"Kine"',
    '{',
    `  "uri" "http://127.0.0.1:${port}"`,
    '  "timeout" "5.0"',
    '  "buffer" "0.1"',
    '  "throttle" "0.1"',
    '  "heartbeat" "10.0"',
    '  "auth"',
    '  {',
    `    "token" "${token}"`,
    '  }',
    '  "data"',
    '  {',
    '    "provider" "1"',
    '    "map" "1"',
    '    "round" "1"',
    '    "player_id" "1"',
    '    "player_state" "1"',
    '    "player_match_stats" "1"',
    '  }',
    '}',
    '',
  ].join('\r\n');
}
