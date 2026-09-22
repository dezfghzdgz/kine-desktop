import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/types';
import { log } from './log';
import { KillStreak, cs2Events, cs2GsiConfig, lolEvents, streakLabelKey, type Cs2State, type GameEvent, type LolPlayer } from './gameEventsParse';

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
/** Výchozí interval dotazů na LoL, když ho nastavení výkonu neurčí. */
const LOL_POLL_MS = 2000;

export type AutoClipLabelKey = ReturnType<typeof streakLabelKey>;

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
  private streak: KillStreak;
  private cfgPaths: string[] = [];

  constructor(
    private deps: {
      settings: () => Settings;
      updateSettings: (patch: Partial<Settings>) => void;
      steamLibraries: () => Promise<string[]>;
      /** Udělat klip; count = délka série. */
      onClip: (count: number, labelKey: AutoClipLabelKey, game: 'cs2' | 'lol') => void;
      onStateChange?: () => void;
      /** Jak často se ptát LoL (ms) - podle nastavení výkonu. */
      lolPollMs?: () => number;
    }
  ) {
    let lastGame: 'cs2' | 'lol' = 'cs2';
    this.streak = new KillStreak({
      mode: () => this.deps.settings().autoClips,
      onClip: (count) => this.deps.onClip(count, streakLabelKey(count), lastGame),
    });
    this.handle = (e: GameEvent) => {
      lastGame = e.game;
      this.streak.add(e);
    };
  }

  private handle: (e: GameEvent) => void;

  /** Která hra právě posílá události (za posledních 30 s), nebo null. */
  live(): 'cs2' | 'lol' | null {
    const now = Date.now();
    if (now - this.lastLolAt < 30000) return 'lol';
    if (now - this.lastCs2At < 30000) return 'cs2';
    return null;
  }

  async start(): Promise<void> {
    if (this.deps.settings().autoClips === 'off') return;
    await this.startGsiServer();
    await this.installCs2Config();
  }

  async stop(): Promise<void> {
    this.stopLol();
    this.streak.reset();
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
      this.removeCs2Config();
    } else if (!this.server) {
      await this.start();
    }
  }

  /** Hlídání her říká, co běží - podle toho se zapíná dotazování LoL. */
  onGame(exe: string | null): void {
    const lol = exe === 'league of legends.exe';
    if (lol && !this.lolTimer && this.deps.settings().autoClips !== 'off') this.startLol();
    if (!lol && this.lolTimer) this.stopLol();
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

  /** Zapíše cfg do každé nalezené instalace CS2 (obvykle jedna); beze změny nic nepřepisuje. */
  private async installCs2Config(): Promise<void> {
    if (!this.port) return;
    const token = this.deps.settings().gsiToken;
    const wanted = cs2GsiConfig(this.port, token);
    let libraries: string[] = [];
    try {
      libraries = await this.deps.steamLibraries();
    } catch (e) {
      log(`herní události: Steam nenalezen (${(e as Error).message})`);
    }
    this.cfgPaths = [];
    for (const lib of libraries) {
      const dir = join(lib, ...CS2_CFG_DIR);
      if (!existsSync(dir)) continue;
      const file = join(dir, CS2_CFG_NAME);
      this.cfgPaths.push(file);
      try {
        const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
        if (current !== wanted) {
          writeFileSync(file, wanted);
          log(`herní události: zapsán ${file} (CS2 ho načte při příštím startu)`);
        }
      } catch (e) {
        log(`herní události: ${file} nejde zapsat: ${(e as Error).message}`);
      }
    }
  }

  private removeCs2Config(): void {
    for (const file of this.cfgPaths) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // nechat být
      }
    }
    this.cfgPaths = [];
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
