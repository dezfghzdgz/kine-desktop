/**
 * Čistá logika automatických klipů z herních událostí (bez Electronu,
 * testovatelná): čtení zpráv z Counter-Strike 2 (Game State Integration)
 * a League of Legends (Live Client Data API) a skládání zabití do
 * "série", ze které vznikne jeden klip. Rocket League (Stats API): góly,
 * zákroky a demolice hráče (rlEvents, RlMoments).
 */

export type EventGame = 'cs2' | 'lol' | 'dota2' | 'minecraft' | 'rocketleague';

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

// ---- Rocket League: Stats API ------------------------------------------------------------
//
// Oficiální rozhraní Psyonixu (rocketleague.com/developer/stats-api): běžící hra
// posílá během zápasu na 127.0.0.1:<Port> (TCP, v základu 49123) objekty JSON
// za sebou BEZ oddělovače - {"Event": "...", "Data": "..."}; Data bývá znovu
// zakódovaný text JSON. Zapíná se v <instalace>/TAGame/Config (TAStatsAPI.ini,
// jinak DefaultStatsAPI.ini), oddíl [TAGame.MatchStatsExporter_TA]:
// PacketSendRate (0 = vypnuto) a Port. Hra soubor čte při startu.

/** Rozdělí souvislý proud na jednotlivé objekty JSON (počítá závorky, hlídá texty v uvozovkách). */
export class JsonStreamFramer {
  private buf = '';
  /** Strop nedokončeného objektu - rozbitý proud nesmí růst donekonečna. */
  constructor(private maxChars = 2_000_000) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let consumed = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (start < 0) {
        // Smetí mezi objekty (mezery, nové řádky, cokoli jiného) se přeskočí.
        if (ch === '{') {
          start = i;
          depth = 1;
          inString = false;
          escaped = false;
        } else consumed = i + 1;
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(this.buf.slice(start, i + 1));
          start = -1;
          consumed = i + 1;
        }
      }
    }
    this.buf = this.buf.slice(consumed);
    if (this.buf.length > this.maxChars) this.buf = '';
    return out;
  }
}

/** Jedna zpráva ze Stats API: název události a data (Data jako text se rozkóduje). null = nesmysl. */
export function rlDecode(raw: string): { event: string; data: Record<string, any> } | null {
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const event = typeof o.Event === 'string' ? o.Event : typeof o.event === 'string' ? o.event : '';
  if (!event) return null;
  let data: any = o.Data ?? o.data ?? {};
  if (typeof data === 'string') {
    try {
      data = data ? JSON.parse(data) : {};
    } catch {
      data = {};
    }
  }
  return { event, data: data && typeof data === 'object' ? data : {} };
}

export type RlPlayer = { name: string; shortcut: number | null; team: number | null };
export type RlState = {
  /** Kolikrát byl který hráč "Target" (koho kamera sleduje) mimo opakované záběry. */
  votes: Record<string, number>;
  /** Hráči podle klíče hlasu (jméno, zkratka, tým). */
  players: Record<string, RlPlayer>;
  me: RlPlayer | null;
  /** Skóre týmů [modří, oranžoví] z posledního UpdateState. */
  score: [number, number] | null;
  /** Moje góly v tomhle zápase (hattrick). */
  myGoals: number;
};

export type RlMoment = 'goal' | 'hatTrick' | 'epicSave' | 'save' | 'demo';

export function rlInitialState(): RlState {
  return { votes: {}, players: {}, me: null, score: null, myGoals: 0 };
}

function rlPlayer(raw: any): RlPlayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.Name === 'string' ? raw.Name : typeof raw.PlayerName === 'string' ? raw.PlayerName : '';
  if (!name) return null;
  const shortcut = Number.isFinite(Number(raw.Shortcut)) && raw.Shortcut !== null && raw.Shortcut !== '' ? Number(raw.Shortcut) : null;
  const team = Number.isFinite(Number(raw.TeamNum)) && raw.TeamNum !== null && raw.TeamNum !== '' ? Number(raw.TeamNum) : null;
  return { name, shortcut, team };
}

const voteKey = (p: RlPlayer) => `${p.name}\u0000${p.shortcut ?? ''}\u0000${p.team ?? ''}`;

function samePlayer(a: RlPlayer | null, me: RlPlayer | null): boolean {
  if (!a || !me) return false;
  if (a.name !== me.name) return false;
  if (a.shortcut !== null && me.shortcut !== null && a.shortcut !== me.shortcut) return false;
  return true;
}

/**
 * Kdo jsem já: Stats API hráče nijak neoznačuje - "Target" je ten, koho kamera
 * sleduje, a při hraní je to vlastní auto. Hlasuje se přes celý zápas mimo
 * opakované záběry (gól); hráč platí až po 10 hlasech a s většinou aspoň 60 %
 * (divák, který přepíná mezi hráči, žádné "já" nemá - a žádné klipy).
 */
export const RL_MIN_VOTES = 10;
function rlWhoAmI(votes: Record<string, number>, players: Record<string, RlPlayer>): RlPlayer | null {
  const entries = Object.entries(votes);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total < RL_MIN_VOTES) return null;
  const [key, n] = entries.sort((a, b) => b[1] - a[1])[0];
  if (n / total < 0.6) return null;
  return players[key] ?? null;
}

/** Jaké momenty se klipují: 'multi' = góly, hattrick, skvělé zákroky; 'every' i zákroky a demolice. */
export function rlMomentAllowed(kind: RlMoment, mode: AutoClipMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'every') return true;
  return kind === 'goal' || kind === 'hatTrick' || kind === 'epicSave';
}

/** StatfeedEvent.EventName -> moment (jen ty, které dávají smysl jako klip; ostatní null). */
export function rlStatfeedMoment(eventName: unknown): RlMoment | null {
  const n = String(eventName ?? '').replace(/[\s_-]+/g, '').toLowerCase();
  if (n === 'epicsave') return 'epicSave';
  if (n === 'save') return 'save';
  if (n === 'demolish' || n === 'demolition' || n === 'demo') return 'demo';
  if (n === 'hattrick') return 'hatTrick';
  return null;
}

/**
 * Jedna zpráva -> nový stav a momenty, které patří HRÁČI (gól, zákrok, demolice).
 * Nový zápas (MatchCreated / MatchInitialized / MatchDestroyed) hlasování vynuluje.
 */
export function rlEvents(prev: RlState, msg: { event: string; data: Record<string, any> }): { state: RlState; moments: RlMoment[] } {
  const ev = msg.event;
  const d = msg.data ?? {};
  if (ev === 'MatchCreated' || ev === 'MatchInitialized' || ev === 'MatchDestroyed') {
    return { state: rlInitialState(), moments: [] };
  }
  if (ev === 'UpdateState') {
    const game = d.Game ?? {};
    const state: RlState = { ...prev, votes: { ...prev.votes }, players: { ...prev.players } };
    const teams = Array.isArray(game.Teams) ? game.Teams : [];
    const scoreOf = (num: number) => {
      const t = teams.find((x: any) => Number(x?.TeamNum) === num);
      const v = Number(t?.Score);
      return Number.isFinite(v) ? v : null;
    };
    const blue = scoreOf(0);
    const orange = scoreOf(1);
    if (blue !== null && orange !== null) state.score = [blue, orange];
    const target = game.bHasTarget === false ? null : rlPlayer(game.Target);
    if (target && game.bReplay !== true) {
      const key = voteKey(target);
      state.players[key] = target;
      state.votes[key] = (state.votes[key] ?? 0) + 1;
      state.me = rlWhoAmI(state.votes, state.players);
    }
    return { state, moments: [] };
  }
  if (ev === 'GoalScored') {
    const scorer = rlPlayer(d.Scorer);
    if (!samePlayer(scorer, prev.me)) return { state: prev, moments: [] };
    const myGoals = prev.myGoals + 1;
    return { state: { ...prev, myGoals }, moments: myGoals === 3 ? ['goal', 'hatTrick'] : ['goal'] };
  }
  if (ev === 'StatfeedEvent') {
    const kind = rlStatfeedMoment(d.EventName ?? d.Type);
    if (!kind) return { state: prev, moments: [] };
    if (!samePlayer(rlPlayer(d.MainTarget), prev.me)) return { state: prev, moments: [] };
    return { state: prev, moments: [kind] };
  }
  return { state: prev, moments: [] };
}

/** Skóre do názvu klipu z pohledu hráče: "2:1" (můj tým první); bez týmu / skóre prázdné. */
export function rlContext(state: RlState | null): string {
  if (!state?.score || state.me?.team === null || state.me?.team === undefined) return '';
  const [blue, orange] = state.score;
  return state.me.team === 1 ? `${orange}:${blue}` : `${blue}:${orange}`;
}

const RL_PRIORITY: RlMoment[] = ['hatTrick', 'goal', 'epicSave', 'save', 'demo'];

/** Klíč překladu názvu klipu. */
export function rlLabelKey(kind: RlMoment): 'autoClipGoal' | 'autoClipHatTrick' | 'autoClipEpicSave' | 'autoClipSave' | 'autoClipDemo' {
  return kind === 'goal' ? 'autoClipGoal' : kind === 'hatTrick' ? 'autoClipHatTrick' : kind === 'epicSave' ? 'autoClipEpicSave' : kind === 'save' ? 'autoClipSave' : 'autoClipDemo';
}

/**
 * Momenty těsně za sebou (zákrok a hned protiútok, gól a hattrick) = jeden
 * klip s nejdůležitějším názvem. Klip vzniká pár vteřin po posledním momentu
 * (gól: výbuch po gólu je v klipu), nejpozději `maxMs` po prvním.
 */
export class RlMoments {
  private best: RlMoment | null = null;
  private firstAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: { mode: () => AutoClipMode; onClip: (kind: RlMoment) => void; now?: () => number; quietMs?: number; maxMs?: number }) {}

  current(): RlMoment | null {
    return this.best;
  }

  add(kind: RlMoment): void {
    if (!rlMomentAllowed(kind, this.deps.mode())) return;
    const now = (this.deps.now ?? Date.now)();
    if (!this.best) this.firstAt = now;
    if (!this.best || RL_PRIORITY.indexOf(kind) < RL_PRIORITY.indexOf(this.best)) this.best = kind;
    if (this.timer) clearTimeout(this.timer);
    const quiet = this.deps.quietMs ?? 3000;
    const max = this.deps.maxMs ?? 10000;
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(quiet, this.firstAt + max - now)));
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const kind = this.best;
    this.best = null;
    if (kind) this.deps.onClip(kind);
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.best = null;
  }
}

/** Kolik aktualizací za sekundu si appka v Rocket League zapne (stačí na "kdo jsem" a skóre). */
export const RL_PACKET_RATE = 5;
export const RL_DEFAULT_PORT = 49123;
const RL_SECTION = '[TAGame.MatchStatsExporter_TA]';
const RL_MARK = '; Kine: PacketSendRate zapnut appkou Kine (klipy ze hry) - puvodne ';

/**
 * Úprava konfigurace Stats API (TAStatsAPI.ini / DefaultStatsAPI.ini): když je
 * vypnuté (PacketSendRate 0 nebo chybí), zapne ho a nad řádek dá značku
 * s původní hodnotou (rlConfigRestore ji vrátí). Port nechá, jen když je 0
 * (TCP vypnuté), dá výchozí 49123. Vrací i port, na kterém hra bude poslouchat.
 */
export function rlConfigEnable(text: string | null): { text: string; changed: boolean; port: number } {
  // Konfigurace Unrealu na Windows - konce řádků CRLF.
  const eol = '\r\n';
  const lines = (text ?? '').split(/\r?\n/);
  let section = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim().toLowerCase() === RL_SECTION.toLowerCase()) section = i;
  if (section < 0) {
    const base = (text ?? '').replace(/\s+$/, '');
    const block = [RL_SECTION, `${RL_MARK}-`, `PacketSendRate=${RL_PACKET_RATE}`, `Port=${RL_DEFAULT_PORT}`];
    return { text: (base ? base + eol + eol : '') + block.join(eol) + eol, changed: true, port: RL_DEFAULT_PORT };
  }
  let end = lines.length;
  for (let i = section + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  let rateLine = -1;
  let portLine = -1;
  for (let i = section + 1; i < end; i++) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].toLowerCase() === 'packetsendrate') rateLine = i;
    if (m[1].toLowerCase() === 'port') portLine = i;
  }
  const value = (i: number) => Number(/=\s*(.*?)\s*$/.exec(lines[i])?.[1] ?? NaN);
  let changed = false;
  let port = portLine >= 0 && value(portLine) > 0 ? value(portLine) : RL_DEFAULT_PORT;
  if (portLine >= 0 && !(value(portLine) > 0)) {
    lines[portLine] = `Port=${RL_DEFAULT_PORT}`;
    port = RL_DEFAULT_PORT;
    changed = true;
  }
  const rate = rateLine >= 0 ? value(rateLine) : NaN;
  if (!(rate > 0)) {
    const original = rateLine >= 0 ? String(/=\s*(.*?)\s*$/.exec(lines[rateLine])?.[1] ?? '0') : '-';
    if (rateLine >= 0) lines.splice(rateLine, 1, `${RL_MARK}${original}`, `PacketSendRate=${RL_PACKET_RATE}`);
    else lines.splice(section + 1, 0, `${RL_MARK}-`, `PacketSendRate=${RL_PACKET_RATE}`);
    if (portLine < 0) {
      const at = lines.findIndex((l, i) => i > section && /^PacketSendRate=/i.test(l.trim()));
      lines.splice(at + 1, 0, `Port=${RL_DEFAULT_PORT}`);
    }
    changed = true;
  }
  return { text: lines.join(eol), changed, port };
}

/** Vrátí, co appka v konfiguraci zapnula (podle značky); jinak nic nemění. */
export function rlConfigRestore(text: string): { text: string; changed: boolean } {
  const lines = text.split(/\r?\n/);
  const eol = '\r\n';
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(RL_MARK)) continue;
    const original = lines[i].slice(RL_MARK.length).trim();
    const next = i + 1 < lines.length && /^\s*PacketSendRate\s*=/i.test(lines[i + 1]) ? i + 1 : -1;
    if (original === '-') {
      // Řádek přidala appka - pryč s ním (port necháme, nevadí).
      lines.splice(i, next >= 0 ? 2 : 1);
    } else {
      lines.splice(i, next >= 0 ? 2 : 1, `PacketSendRate=${original}`);
    }
    changed = true;
    i--;
  }
  return { text: lines.join(eol), changed };
}

/** Kódování souboru konfigurace hry - při zápisu se zachová (Unreal čte UTF-8 i UTF-16). */
export type IniEncoding = { utf16: boolean; bom: boolean };

/** Bajty konfigurace -> text: UTF-16 (s BOM i bez) a UTF-8 (s BOM i bez). */
export function decodeIni(buf: Uint8Array): { text: string; encoding: IniEncoding } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: b.subarray(2).toString('utf16le'), encoding: { utf16: true, bom: true } };
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.subarray(3).toString('utf8'), encoding: { utf16: false, bom: true } };
  // UTF-16 bez BOM: u textu z ASCII je každý druhý bajt nula.
  if (b.length >= 4 && b[0] !== 0 && b[1] === 0 && b[3] === 0) return { text: b.toString('utf16le'), encoding: { utf16: true, bom: false } };
  return { text: b.toString('utf8'), encoding: { utf16: false, bom: false } };
}

/** Text -> bajty ve stejném kódování, v jakém soubor byl (nový soubor: UTF-8 bez BOM). */
export function encodeIni(text: string, encoding: IniEncoding = { utf16: false, bom: false }): Buffer {
  const body = Buffer.from(text, encoding.utf16 ? 'utf16le' : 'utf8');
  if (!encoding.bom) return body;
  return Buffer.concat([Buffer.from(encoding.utf16 ? [0xff, 0xfe] : [0xef, 0xbb, 0xbf]), body]);
}
