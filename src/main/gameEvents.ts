import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../shared/types';
import { log } from './log';
import {
  JsonStreamFramer,
  KillStreak,
  RL_DEFAULT_PORT,
  RlMoments,
  cs2Context,
  cs2Events,
  cs2GsiConfig,
  decodeIni,
  dota2Context,
  dota2Events,
  dota2GsiConfig,
  encodeIni,
  isDota2Payload,
  lolEvents,
  minecraftGameDir,
  minecraftLogEvent,
  minecraftUserFromLog,
  rlConfigEnable,
  rlConfigRestore,
  rlContext,
  rlDecode,
  rlEvents,
  rlInitialState,
  rlLabelKey,
  streakLabelKey,
  type Cs2State,
  type Dota2State,
  type EventGame,
  type GameEvent,
  type LolPlayer,
  type RlState,
} from './gameEventsParse';

/**
 * Automatické klipy z herních událostí - to, čím je Medal známý, jenže
 * bez zásahu do hry: obě hry hlásí události samy, oficiální cestou.
 *
 *  - Counter-Strike 2: Game State Integration. Appka položí do
 *    game/csgo/cfg/ soubor gamestate_integration_kine.cfg (adresa +
 *    tajný token) a CS2 pak po každé změně stavu POSTuje JSON na
 *    http://127.0.0.1:<port>. Soubor CS2 načte při startu - když už běží,
 *    projeví se to po jeho restartu.
 *  - League of Legends: Live Client Data API - běžící hra odpovídá na
 *    https://127.0.0.1:2999/liveclientdata/… (vlastní certifikát, proto
 *    se u ní neověřuje). Appka se ptá každé 2 s, jen dokud hra běží.
 *
 * Zabití se skládají do série (gameEventsParse.ts, KillStreak) a z ní je
 * jeden klip s názvem podle délky série. Když zásobník neběží (hra
 * nerozpoznaná, nahrávání vypnuté), klip se tiše vynechá.
 */
const GSI_PORTS = [27381, 27382, 27383, 27384, 27385];
const CS2_CFG_NAME = 'gamestate_integration_kine.cfg';
const CS2_CFG_DIR = ['steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg'];
/** Dota 2 chce cfg v podsložce gamestate_integration (CS2 ho bere přímo v cfg). */
const DOTA2_CFG_DIR = ['steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg', 'gamestate_integration'];
/** Výchozí interval dotazů na LoL, když ho nastavení výkonu neurčí. */
const LOL_POLL_MS = 2000;
/** Jak často se čte logs/latest.log Minecraftu. */
const MINECRAFT_POLL_MS = 1500;
/** Rocket League: složka s konfigurací Stats API v instalaci hry. */
const RL_CONFIG_DIR = ['TAGame', 'Config'];
const RL_CONFIG_FILES = ['TAStatsAPI.ini', 'DefaultStatsAPI.ini'];
/** Znovu se připojit ke hře (Stats API běží jen během zápasu). */
const RL_RETRY_MS = 3000;

export type AutoClipLabelKey = ReturnType<typeof streakLabelKey> | ReturnType<typeof rlLabelKey> | 'autoClipDeath' | 'autoClipAdvancement';

export class GameEvents {
  private server: Server | null = null;
  private port = 0;
  private cs2State: Cs2State | null = null;
  private lastCs2At = 0;
  private lolTimer: ReturnType<typeof setInterval> | null = null;
  private lolLastId = -1;
  private lolPlayer: LolPlayer | null = null;
  private lolBusy = false;
  private lastLolAt = 0;
  private dota2State: Dota2State | null = null;
  private lastDota2At = 0;
  private minecraft: { timer: ReturnType<typeof setInterval>; file: string; offset: number; player: string; tail: string } | null = null;
  private lastMinecraftAt = 0;
  private streak: KillStreak;
  private cfgPaths: string[] = [];
  /** Rocket League: spojení se Stats API hry (jen dokud hra běží). */
  private rl: { socket: Socket | null; retry: ReturnType<typeof setTimeout> | null; framer: JsonStreamFramer; state: RlState } | null = null;
  private rlMoments: RlMoments;
  /** Port Stats API podle konfigurace hry (zjistí installRlConfigs). */
  private rlPort = RL_DEFAULT_PORT;
  private rlConfigFiles: string[] = [];
  private lastRlAt = 0;

  constructor(
    private deps: {
      settings: () => Settings;
      updateSettings: (patch: Partial<Settings>) => void;
      steamLibraries: () => Promise<string[]>;
      /** Udělat klip; count = délka série, context = mapa a skóre / hrdina do názvu (může být prázdné). */
      onClip: (count: number, labelKey: AutoClipLabelKey, game: EventGame, context: string) => void;
      onStateChange?: () => void;
      /** Jak často se ptát LoL (ms) - podle nastavení výkonu. */
      lolPollMs?: () => number;
      /** Příkazová řádka Minecraftu (kvůli --gameDir), prázdné = výchozí složka. */
      minecraftCommandLine?: () => string;
      /** Složky, kde můžou být hry z Epic Games (manifesty launcheru); v základu ProgramData. */
      epicManifestsDir?: () => string;
      /** Konfiguraci Rocket League nejde zapsat (chráněná složka) - soubor; null = v pořádku. */
      onRlConfigBlocked?: (file: string | null) => void;
    }
  ) {
    this.rlMoments = new RlMoments({
      mode: () => this.deps.settings().autoClips,
      onClip: (kind) => {
        this.streak.flush();
        this.deps.onClip(1, rlLabelKey(kind), 'rocketleague', rlContext(this.rl?.state ?? null));
      },
    });
    let lastGame: EventGame = 'cs2';
    this.streak = new KillStreak({
      mode: () => this.deps.settings().autoClips,
      onClip: (count) => this.deps.onClip(count, streakLabelKey(count), lastGame, this.context(lastGame)),
    });
    this.handle = (e: GameEvent) => {
      lastGame = e.game;
      if (e.kind === 'death' || e.kind === 'advancement') {
        // Samostatné události (Minecraft): klip hned, bez skládání do série.
        if (this.deps.settings().autoClips === 'off') return;
        this.streak.flush();
        this.deps.onClip(1, e.kind === 'death' ? 'autoClipDeath' : 'autoClipAdvancement', e.game, '');
        return;
      }
      this.streak.add(e);
    };
  }

  private handle: (e: GameEvent) => void;

  /** Text do názvu klipu podle hry: CS2 mapa + skóre, Dota 2 hrdina. */
  private context(game: EventGame): string {
    if (game === 'cs2') return cs2Context(this.cs2State);
    if (game === 'dota2') return dota2Context(this.dota2State);
    return '';
  }

  /** Která hra právě posílá události (za posledních 30 s; když víc, ta poslední), nebo null. */
  live(): EventGame | null {
    const now = Date.now();
    const seen: [EventGame, number][] = [
      ['lol', this.lastLolAt],
      ['cs2', this.lastCs2At],
      ['dota2', this.lastDota2At],
      ['minecraft', this.minecraft ? this.lastMinecraftAt : 0],
      ['rocketleague', this.rl ? this.lastRlAt : 0],
    ];
    const latest = seen.filter(([, at]) => at > 0 && now - at < 30000).sort((a, b) => b[1] - a[1])[0];
    return latest ? latest[0] : null;
  }

  async start(): Promise<void> {
    if (this.deps.settings().autoClips === 'off') return;
    await this.startGsiServer();
    await this.installGsiConfigs();
    await this.installRlConfigs();
  }

  async stop(): Promise<void> {
    this.stopLol();
    this.stopMinecraft();
    this.stopRl();
    this.streak.reset();
    this.rlMoments.reset();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }
  }

  /** Změna nastavení: zapnout/vypnout (u vypnutí se cfg z CS2 zase odebere). */
  async onSettingsChanged(prev: Settings, next: Settings): Promise<void> {
    // Jiný výkon = jiný interval dotazů na LoL (běží-li).
    if (prev.performance !== next.performance && this.lolTimer) {
      clearInterval(this.lolTimer);
      this.lolTimer = setInterval(() => void this.pollLol(), this.deps.lolPollMs?.() ?? LOL_POLL_MS);
    }
    if (prev.autoClips === next.autoClips) return;
    if (next.autoClips === 'off') {
      await this.stop();
      this.removeGsiConfigs();
      this.removeRlConfigs();
    } else if (!this.server) {
      await this.start();
    }
  }

  /** Hlídání her říká, co běží - podle toho se zapíná dotazování LoL a čtení logu Minecraftu. */
  onGame(exe: string | null, name: string | null = null): void {
    const on = this.deps.settings().autoClips !== 'off';
    const lol = exe === 'league of legends.exe';
    if (lol && !this.lolTimer && on) this.startLol();
    if (!lol && this.lolTimer) this.stopLol();
    const minecraft = name === 'Minecraft' && (exe === 'javaw.exe' || exe === 'java.exe');
    if (minecraft && !this.minecraft && on) this.startMinecraft();
    if (!minecraft && this.minecraft) this.stopMinecraft();
    const rocketLeague = exe === 'rocketleague.exe';
    if (rocketLeague && !this.rl && on) this.startRl();
    if (!rocketLeague && this.rl) this.stopRl();
  }

  // ---- CS2 ------------------------------------------------------------------------------

  private async startGsiServer(): Promise<void> {
    if (this.server) return;
    if (!this.deps.settings().gsiToken) this.deps.updateSettings({ gsiToken: randomBytes(16).toString('hex') });
    for (const port of GSI_PORTS) {
      const ok = await new Promise<boolean>((resolve) => {
        const server = createServer((req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
          }
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) req.destroy();
          });
          req.on('end', () => {
            res.writeHead(200).end();
            this.onGsiPayload(body);
          });
        });
        server.on('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
          this.server = server;
          this.port = port;
          resolve(true);
        });
      });
      if (ok) {
        log(`herní události: CS2 GSI poslouchá na 127.0.0.1:${this.port}`);
        return;
      }
    }
    log('herní události: žádný volný port pro CS2 GSI (27381-27385)');
  }

  private onGsiPayload(body: string): void {
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return;
    }
    const token = this.deps.settings().gsiToken;
    if (token && payload?.auth?.token !== token) return;
    if (isDota2Payload(payload)) {
      const first = this.lastDota2At === 0;
      this.lastDota2At = Date.now();
      if (first) {
        log('herní události: Dota 2 se připojila');
        this.deps.onStateChange?.();
      }
      const { state, events } = dota2Events(this.dota2State, payload);
      this.dota2State = state;
      for (const e of events) this.handle(e);
      return;
    }
    const first = this.lastCs2At === 0;
    this.lastCs2At = Date.now();
    if (first) {
      log('herní události: CS2 se připojil');
      this.deps.onStateChange?.();
    }
    const { state, events } = cs2Events(this.cs2State, payload);
    this.cs2State = state;
    for (const e of events) this.handle(e);
  }

  /**
   * Zapíše cfg do každé nalezené instalace CS2 a Dota 2 (obvykle jedna);
   * beze změny nic nepřepisuje. U Doty se podsložka gamestate_integration
   * založí, když chybí (hra ji sama nevytváří).
   */
  private async installGsiConfigs(): Promise<void> {
    if (!this.port) return;
    const token = this.deps.settings().gsiToken;
    let libraries: string[] = [];
    try {
      libraries = await this.deps.steamLibraries();
    } catch (e) {
      log(`herní události: Steam nenalezen (${(e as Error).message})`);
    }
    this.cfgPaths = [];
    const targets: { dir: string; wanted: string; game: string; create: boolean }[] = [];
    for (const lib of libraries) {
      targets.push({ dir: join(lib, ...CS2_CFG_DIR), wanted: cs2GsiConfig(this.port, token), game: 'CS2', create: false });
      targets.push({ dir: join(lib, ...DOTA2_CFG_DIR), wanted: dota2GsiConfig(this.port, token), game: 'Dota 2', create: true });
    }
    for (const t of targets) {
      if (!existsSync(t.dir)) {
        // Dota 2: složka cfg existuje, jen podsložka pro GSI ne.
        if (!t.create || !existsSync(join(t.dir, '..'))) continue;
        try {
          mkdirSync(t.dir, { recursive: true });
        } catch {
          continue;
        }
      }
      const file = join(t.dir, CS2_CFG_NAME);
      this.cfgPaths.push(file);
      try {
        const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
        if (current !== t.wanted) {
          writeFileSync(file, t.wanted);
          log(`herní události: zapsán ${file} (${t.game} ho načte při příštím startu)`);
        }
      } catch (e) {
        log(`herní události: ${file} nejde zapsat: ${(e as Error).message}`);
      }
    }
  }

  private removeGsiConfigs(): void {
    for (const file of this.cfgPaths) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // nechat být
      }
    }
    this.cfgPaths = [];
  }

  // ---- Minecraft ------------------------------------------------------------------------

  /** Začne sledovat logs/latest.log (od konce - staré zprávy nejsou klipy). */
  private startMinecraft(): void {
    const dir = minecraftGameDir(this.deps.minecraftCommandLine?.() ?? '') ?? defaultMinecraftDir();
    const file = join(dir, 'logs', 'latest.log');
    let offset = 0;
    let player = '';
    try {
      offset = statSync(file).size;
      // Jméno hráče je na začátku logu ("Setting user: …") - přečte se jednou z hlavy souboru.
      const head = readHead(file, 64 * 1024);
      for (const line of head.split(/\r?\n/)) {
        const user = minecraftUserFromLog(line);
        if (user) player = user;
      }
    } catch {
      // Log ještě není (hra se spouští) - dočte se při prvním kole.
    }
    const timer = setInterval(() => this.pollMinecraft(), MINECRAFT_POLL_MS);
    this.minecraft = { timer, file, offset, player, tail: '' };
    this.lastMinecraftAt = Date.now();
    log(`herní události: Minecraft běží - sleduju ${file}${player ? ` (hráč ${player})` : ''}`);
    this.deps.onStateChange?.();
  }

  private stopMinecraft(): void {
    if (!this.minecraft) return;
    clearInterval(this.minecraft.timer);
    this.minecraft = null;
    this.lastMinecraftAt = 0;
    this.deps.onStateChange?.();
  }

  /** Přečte, co v logu přibylo, a řádek po řádku hledá smrt / zabití / pokrok. */
  private pollMinecraft(): void {
    const mc = this.minecraft;
    if (!mc) return;
    let size: number;
    try {
      size = statSync(mc.file).size;
    } catch {
      return;
    }
    // Nová hra přepsala log (je menší) - číst od začátku.
    if (size < mc.offset) {
      mc.offset = 0;
      mc.tail = '';
    }
    if (size === mc.offset) return;
    this.lastMinecraftAt = Date.now();
    let chunk: Buffer;
    try {
      chunk = readRangeBytes(mc.file, mc.offset, Math.min(size - mc.offset, 512 * 1024));
    } catch {
      return;
    }
    mc.offset += chunk.length;
    const lines = (mc.tail + chunk.toString('utf8')).split(/\r?\n/);
    mc.tail = lines.pop() ?? '';
    for (const line of lines) {
      const user = minecraftUserFromLog(line);
      if (user) {
        mc.player = user;
        continue;
      }
      const e = minecraftLogEvent(line, mc.player);
      if (!e) continue;
      log(`herní události: Minecraft ${e.kind}: ${e.text}`);
      if (e.kind === 'kill') this.handle({ game: 'minecraft', kind: 'kill', count: 1 });
      else this.handle({ game: 'minecraft', kind: e.kind, count: 1 });
    }
  }

  // ---- Rocket League ------------------------------------------------------------------

  /**
   * Instalace Rocket League: Steam (steamapps/common/rocketleague) a Epic Games
   * (manifesty launcheru v ProgramData - InstallLocation u hry "Rocket League").
   */
  private async rocketLeagueDirs(): Promise<string[]> {
    const dirs: string[] = [];
    try {
      for (const lib of await this.deps.steamLibraries()) dirs.push(join(lib, 'steamapps', 'common', 'rocketleague'));
    } catch {
      // bez Steamu
    }
    const manifests = this.deps.epicManifestsDir?.() ?? join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    try {
      for (const name of readdirSync(manifests)) {
        if (!name.toLowerCase().endsWith('.item')) continue;
        try {
          const item = JSON.parse(readFileSync(join(manifests, name), 'utf8').replace(/^﻿/, ''));
          const title = `${item?.DisplayName ?? ''} ${item?.LaunchExecutable ?? ''}`;
          if (/rocket\s*league/i.test(title) && typeof item?.InstallLocation === 'string') dirs.push(item.InstallLocation);
        } catch {
          // rozbitý manifest
        }
      }
    } catch {
      // Epic není
    }
    return [...new Set(dirs)].filter((d) => existsSync(join(d, ...RL_CONFIG_DIR)));
  }

  /**
   * Zapne Stats API v nalezených instalacích (TAStatsAPI.ini, když je, jinak
   * DefaultStatsAPI.ini - ten hra čte, když TAStatsAPI.ini chybí). Mění jen
   * vypnutý PacketSendRate a nad řádek si dá značku s původní hodnotou -
   * vypnutí klipů ze hry ji vrátí. Hra konfiguraci čte při startu.
   */
  private async installRlConfigs(): Promise<void> {
    this.rlConfigFiles = [];
    let blocked: string | null = null;
    for (const dir of await this.rocketLeagueDirs()) {
      const configDir = join(dir, ...RL_CONFIG_DIR);
      const existing = RL_CONFIG_FILES.map((f) => join(configDir, f)).filter((f) => existsSync(f));
      // Žádný soubor (starší hra): založit DefaultStatsAPI.ini.
      const targets = existing.length > 0 ? existing : [join(configDir, RL_CONFIG_FILES[1])];
      for (const file of targets) {
        try {
          // Kódování (UTF-8 / UTF-16, BOM) zůstane, jaké bylo.
          const before = existsSync(file) ? decodeIni(readFileSync(file)) : null;
          const { text, changed, port } = rlConfigEnable(before ? before.text : null);
          // Port platí z TAStatsAPI.ini (má přednost), jinak z DefaultStatsAPI.ini.
          if (file === targets[0]) this.rlPort = port;
          if (changed) {
            writeFileSync(file, encodeIni(text, before?.encoding));
            log(`herní události: zapnuto Stats API v ${file} (Rocket League ho načte při příštím startu)`);
          }
          this.rlConfigFiles.push(file);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          log(`herní události: ${file} nejde zapsat: ${(e as Error).message}`);
          if (code === 'EACCES' || code === 'EPERM') blocked ??= file;
        }
      }
    }
    // Hráč se to dozví v okně (Hry) - jak to zapnout ručně; po úspěchu upozornění zmizí.
    this.deps.onRlConfigBlocked?.(blocked);
  }

  private removeRlConfigs(): void {
    for (const file of this.rlConfigFiles) {
      try {
        if (!existsSync(file)) continue;
        const current = decodeIni(readFileSync(file));
        const { text, changed } = rlConfigRestore(current.text);
        if (changed) writeFileSync(file, encodeIni(text, current.encoding));
      } catch {
        // nechat být
      }
    }
    this.rlConfigFiles = [];
  }

  private startRl(): void {
    this.rl = { socket: null, retry: null, framer: new JsonStreamFramer(), state: rlInitialState() };
    log(`herní události: Rocket League běží - připojuji se ke Stats API (127.0.0.1:${this.rlPort})`);
    // Hra nainstalovaná až po spuštění appky: konfigurace se zapne teď (projeví se po restartu hry).
    if (this.rlConfigFiles.length === 0) void this.installRlConfigs();
    this.connectRl();
  }

  private stopRl(): void {
    const rl = this.rl;
    if (!rl) return;
    this.rl = null;
    if (rl.retry) clearTimeout(rl.retry);
    rl.socket?.destroy();
    this.rlMoments.flush();
    if (this.lastRlAt) {
      this.lastRlAt = 0;
      this.deps.onStateChange?.();
    }
  }

  /** TCP ke hře; Stats API posílá jen během zápasu - spadlé spojení se zkouší znovu, dokud hra běží. */
  private connectRl(): void {
    const rl = this.rl;
    if (!rl || rl.socket) return;
    const socket = netConnect({ host: '127.0.0.1', port: this.rlPort });
    rl.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (this.rl !== rl) return;
      for (const raw of rl.framer.push(chunk)) {
        const msg = rlDecode(raw);
        if (!msg) continue;
        const first = this.lastRlAt === 0;
        this.lastRlAt = Date.now();
        if (first) {
          log('herní události: Rocket League posílá události');
          this.deps.onStateChange?.();
        }
        const { state, moments } = rlEvents(rl.state, msg);
        if (!rl.state.me && state.me) log(`herní události: Rocket League hráč ${state.me.name}`);
        rl.state = state;
        for (const m of moments) {
          log(`herní události: Rocket League ${m}`);
          this.rlMoments.add(m);
        }
      }
    });
    const retry = () => {
      if (this.rl !== rl) return;
      rl.socket?.destroy();
      rl.socket = null;
      rl.framer = new JsonStreamFramer();
      if (!rl.retry) {
        rl.retry = setTimeout(() => {
          rl.retry = null;
          this.connectRl();
        }, RL_RETRY_MS);
      }
    };
    socket.on('error', retry);
    socket.on('close', retry);
  }

  // ---- League of Legends --------------------------------------------------------------

  private startLol(): void {
    this.lolLastId = -1;
    this.lolPlayer = null;
    this.lolTimer = setInterval(() => void this.pollLol(), this.deps.lolPollMs?.() ?? LOL_POLL_MS);
    log('herní události: League of Legends běží - sleduju Live Client API');
  }

  private stopLol(): void {
    if (this.lolTimer) clearInterval(this.lolTimer);
    this.lolTimer = null;
    this.lolPlayer = null;
    this.lolLastId = -1;
  }

  private async pollLol(): Promise<void> {
    if (this.lolBusy) return;
    this.lolBusy = true;
    try {
      if (!this.lolPlayer) {
        const me = await lolGet('/liveclientdata/activeplayer');
        const name = typeof me?.summonerName === 'string' ? me.summonerName : '';
        const riot = typeof me?.riotIdGameName === 'string' ? me.riotIdGameName : undefined;
        if (!name && !riot) return;
        this.lolPlayer = { name: name || riot!, riotName: riot };
        log(`herní události: LoL hráč ${this.lolPlayer.name}`);
      }
      const data = await lolGet('/liveclientdata/eventdata');
      if (!data) return;
      const first = this.lastLolAt === 0;
      this.lastLolAt = Date.now();
      if (first) this.deps.onStateChange?.();
      const { lastId, events, restarted } = lolEvents(data, this.lolLastId, this.lolPlayer);
      if (restarted) this.lolPlayer = null;
      // Při prvním čtení ve hře se staré události jen přeskočí (jinak by z minulých zabití vznikly klipy).
      if (this.lolLastId >= 0 || restarted) for (const e of events) this.handle(e);
      this.lolLastId = lastId;
    } catch {
      // hra se načítá / API ještě neběží
    } finally {
      this.lolBusy = false;
    }
  }
}

/** Výchozí složka Minecraftu (Java): %APPDATA%\\.minecraft, na Linuxu ~/.minecraft. */
function defaultMinecraftDir(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '.minecraft');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'minecraft');
  return join(homedir(), '.minecraft');
}

function readHead(file: string, bytes: number): string {
  return readRange(file, 0, bytes);
}

/** Kus souboru od `offset` (nejvíc `bytes`), jako UTF-8 text. */
function readRange(file: string, offset: number, bytes: number): string {
  return readRangeBytes(file, offset, bytes).toString('utf8');
}

function readRangeBytes(file: string, offset: number, bytes: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, offset);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** GET na Live Client API hry (jen 127.0.0.1, vlastní certifikát se neověřuje). */
function lolGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: 2999, path, method: 'GET', rejectUnauthorized: false, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 2_000_000) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
