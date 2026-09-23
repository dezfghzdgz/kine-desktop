/**
 * Čistá logika automatických klipů z herních událostí (bez Electronu,
 * testovatelná): čtení zpráv z Counter-Strike 2 (Game State Integration)
 * a League of Legends (Live Client Data API) a skládání zabití do
 * "série", ze které vznikne jeden klip.
 */

export type EventGame = 'cs2' | 'lol' | 'dota2' | 'minecraft';

export type GameEvent = {
  game: EventGame;
  /** kill/multikill/ace se skládají do série; death a advancement jsou samostatné (Minecraft). */
  kind: 'kill' | 'multikill' | 'ace' | 'death' | 'advancement';
  /** Kolik zabití má série zatím (CS2: zabití v kole; LoL: KillStreak u Multikill, 1 u zabití). */
  count: number;
};

// ---- Counter-Strike 2: Game State Integration ---------------------------------------

export type Cs2State = {
  steamid: string;
  roundKills: number;
  matchKills: number;
  map: string;
  /** Skóre z pohledu hráče ("7:5" - moje : jejich), prázdné, když ho CS2 neposlal. */
  score: string;
};

/** "de_mirage" -> "Mirage", "cs_office" -> "Office", "ar_baggage" -> "Baggage". */
export function cs2MapName(map: string): string {
  const raw = map.replace(/^(de|cs|ar|dz|gd|lobby)_/, '').replace(/_/g, ' ').trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '';
}

/** Kontext do názvu automatického klipu: "Mirage 7:5" / "Mirage" / "". */
export function cs2Context(state: Cs2State | null): string {
  if (!state) return '';
  const map = cs2MapName(state.map);
  return [map, state.score].filter(Boolean).join(' ');
}

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
  const ct = Number(p.map?.team_ct?.score ?? NaN);
  const t = Number(p.map?.team_t?.score ?? NaN);
  let score = prev?.score ?? '';
  if (Number.isFinite(ct) && Number.isFinite(t)) {
    const mine = String(player.team ?? '').toUpperCase() === 'T' ? [t, ct] : [ct, t];
    score = `${mine[0]}:${mine[1]}`;
  }
  const state: Cs2State = {
    steamid: mySteamId,
    roundKills: Number.isFinite(roundKills) ? roundKills : prev?.roundKills ?? 0,
    matchKills: Number.isFinite(matchKills) ? matchKills : prev?.matchKills ?? 0,
    map,
    score,
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

// ---- Dota 2: Game State Integration --------------------------------------------------

export type Dota2State = {
  steamid: string;
  matchid: string;
  kills: number;
  hero: string;
};

/** Je to zpráva z Dota 2 (appid 570)? CS2 posílá 730. Bez appid se hádá podle bloku "hero". */
export function isDota2Payload(payload: unknown): boolean {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== 'object') return false;
  const appid = Number(p.provider?.appid ?? NaN);
  if (Number.isFinite(appid)) return appid === 570;
  return !!p.hero && !p.round;
}

/**
 * Dota 2 posílá celý stav taky (provider, map, player, hero). Zabití = nárůst
 * `player.kills`; každé se hlásí jako jedno (sérii poskládá KillStreak podle
 * času). Nový zápas (jiné matchid) nebo pokles = začít od nuly, nic nehlásit.
 * Před začátkem hry (výběr hrdinů) se `player.kills` nemění, tak nic nevadí.
 */
export function dota2Events(prev: Dota2State | null, payload: unknown): { state: Dota2State | null; events: GameEvent[] } {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== 'object') return { state: prev, events: [] };
  const player = p.player;
  if (!player || typeof player !== 'object') return { state: prev, events: [] };
  const mySteamId = String(p.provider?.steamid ?? player.steamid ?? '');
  // Divácký režim posílá hráče po týmech (team2/team3) - žádné vlastní zabití, nic.
  if (String(player.steamid ?? mySteamId) !== mySteamId) return { state: prev, events: [] };
  const kills = Number(player.kills ?? NaN);
  const matchid = String(p.map?.matchid ?? prev?.matchid ?? '');
  const hero = heroName(String(p.hero?.name ?? ''));
  const state: Dota2State = {
    steamid: mySteamId,
    matchid,
    kills: Number.isFinite(kills) ? kills : prev?.kills ?? 0,
    hero: hero || prev?.hero || '',
  };
  const events: GameEvent[] = [];
  const fresh = !prev || prev.steamid !== mySteamId || (matchid && prev.matchid && prev.matchid !== matchid) || state.kills < prev.kills;
  if (!fresh && prev && Number.isFinite(kills) && kills > prev.kills) {
    for (let i = prev.kills; i < kills; i++) events.push({ game: 'dota2', kind: 'kill', count: 1 });
  }
  return { state, events };
}

/** "npc_dota_hero_crystal_maiden" -> "Crystal Maiden". */
export function heroName(name: string): string {
  const raw = name.replace(/^npc_dota_hero_/, '').replace(/_/g, ' ').trim();
  return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Kontext do názvu klipu z Dota 2: jméno hrdiny. */
export function dota2Context(state: Dota2State | null): string {
  return state?.hero ?? '';
}

/** Obsah gamestate_integration_kine.cfg pro Dota 2 (složka game/dota/cfg/gamestate_integration/). */
export function dota2GsiConfig(port: number, token: string): string {
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
    '    "player" "1"',
    '    "hero" "1"',
    '  }',
    '}',
    '',
  ].join('\r\n');
}

// ---- Minecraft: logs/latest.log ------------------------------------------------------

/**
 * Minecraft (Java) nic neposílá, ale všechno, co se objeví v chatu - i zprávy
 * o smrti a o splněném pokroku - zapisuje do logs/latest.log jako
 * "[CHAT] …". Appka soubor sleduje a hledá zprávy o hráči:
 *  - smrt: řádek začíná jménem hráče a obsahuje známé anglické znění
 *    ("was slain by", "fell from a high place", …),
 *  - zabití jiného hráče (PvP): anglická zpráva o smrti končící "by <hráč>",
 *  - pokrok: "has made the advancement" / "has completed the challenge" /
 *    "has reached the goal", a v kterémkoli jazyce řádek začínající jménem
 *    hráče s názvem pokroku v hranatých závorkách.
 * Zprávy hráčů v chatu vypadají "<Jméno> text" - ty se přeskočí.
 */
export const MINECRAFT_DEATH_PATTERNS: RegExp[] = [
  /was (slain|shot|killed|fireballed|pummeled|blown up|squashed|impaled|skewered|stung|poked|frozen|pricked|struck|roasted|burnt|doomed|squished|obliterated)/i,
  /(drowned|starved|suffocated|withered|froze|experienced kinetic energy|discovered the floor was lava|walked into|fell (from|off|out|too far|while)|hit the ground too hard|went up in flames|burned to death|tried to swim in lava|blew up|died|left the confines of this world|was killed|didn't want to live|went off with a bang|was roasted)/i,
];
const MINECRAFT_ADVANCEMENT = /has (made the advancement|completed the challenge|reached the goal)/i;
const MINECRAFT_JOIN_LEAVE = /(joined|left) the game/i;

export type MinecraftLogEvent = { kind: 'death' | 'kill' | 'advancement'; text: string };

/** Jméno hráče z řádku "Setting user: Steve" (píše se při startu hry). */
export function minecraftUserFromLog(line: string): string | null {
  const m = /Setting user: (\S+)/.exec(line);
  return m ? m[1] : null;
}

/** Události z jednoho řádku logu (nebo null). */
export function minecraftLogEvent(line: string, player: string): MinecraftLogEvent | null {
  const idx = line.indexOf('[CHAT] ');
  if (idx < 0 || !player) return null;
  const text = line.slice(idx + 7).replace(/§./g, '').trim();
  if (!text || text.startsWith('<')) return null;
  const mine = text === player || text.startsWith(player + ' ');
  if (mine) {
    if (MINECRAFT_JOIN_LEAVE.test(text)) return null;
    if (MINECRAFT_ADVANCEMENT.test(text)) return { kind: 'advancement', text };
    if (MINECRAFT_DEATH_PATTERNS.some((re) => re.test(text))) return { kind: 'death', text };
    // Jiný jazyk hry: "Steve získal pokrok [Doba kamenná]" - název pokroku je vždy v závorkách na konci.
    if (/\[[^\]]+\]\s*$/.test(text)) return { kind: 'advancement', text };
    return null;
  }
  // Někdo jiný zemřel a na konci je "by <já>" (případně "by <já> using [zbraň]").
  const byMe = new RegExp(`\\bby ${escapeRegExp(player)}(\\s+using\\s+\\[[^\\]]+\\])?$`, 'i');
  if (byMe.test(text) && MINECRAFT_DEATH_PATTERNS.some((re) => re.test(text))) return { kind: 'kill', text };
  return null;
}

/** "--gameDir C:\\Hry\\mc" (i v uvozovkách) z příkazové řádky javy; null = výchozí .minecraft. */
export function minecraftGameDir(cmdline: string): string | null {
  const m = /--gameDir\s+(?:"([^"]+)"|(\S+))/.exec(cmdline);
  return m ? (m[1] ?? m[2]) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
