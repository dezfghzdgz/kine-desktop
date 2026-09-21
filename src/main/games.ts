import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessInfo, Settings } from '../shared/types';
import {
  detectFromProcesses,
  isMinecraftCommandLine,
  needsConfirmation,
  parseAcfName,
  parseLibraryFolders,
  parsePsList,
  parseSteamPath,
  parseSteamRunningAppId,
  parseTasklistCsv,
  type DetectedGame,
} from './gamesParse';
import { log } from './log';

export type { DetectedGame } from './gamesParse';

const POLL_MS = 4000;

function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout));
    });
  });
}

/**
 * Hlídá, jestli běží hra. Ptá se každé 4 sekundy - seznam procesů je
 * levný (desítky ms) a rychlejší reakce není potřeba: zásobník se
 * rozjede pár sekund po startu hry, hra sama nabíhá delší dobu.
 *
 * Běží vždycky, i když je zásobník na "pořád" nebo "ručně": podle něj se
 * pozastavuje nahrávání na Kine a pojmenovávají klipy.
 */
export class GameWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentGame: DetectedGame | null = null;
  private steamPath: string | null | undefined;
  private steamNames = new Map<number, string>();
  private minecraftCheck: { at: number; result: boolean } | null = null;
  private busy = false;

  constructor(
    private deps: {
      settings: () => Settings;
      onChange: (game: DetectedGame | null, previous: DetectedGame | null) => void;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): DetectedGame | null {
    return this.currentGame;
  }

  /** Hned se podívat (po přidání hry v nastavení). */
  refresh(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const detected = await this.detect();
      const prev = this.currentGame;
      const changed = (prev?.exe ?? null) !== (detected?.exe ?? null);
      this.currentGame = detected;
      if (changed) {
        log(detected ? `hra: ${detected.name} (${detected.exe}, ${detected.source})` : `hra skončila: ${prev?.name ?? '?'}`);
        this.deps.onChange(detected, prev);
      }
    } catch (e) {
      log(`hlídání her selhalo: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async detect(): Promise<DetectedGame | null> {
    const processes = await this.processNames();
    const custom = this.deps.settings().customGames;

    const fromList = detectFromProcesses(processes, custom);
    if (fromList) return fromList;

    const steam = await this.steamGame();
    if (steam) return steam;

    // Minecraft Java: javaw.exe je Minecraft jen když to říká příkazová řádka.
    const weak = needsConfirmation(processes);
    if (weak.length > 0 && (await this.isMinecraftRunning())) {
      return { name: 'Minecraft', exe: weak[0], source: 'known' };
    }
    return null;
  }

  async processNames(): Promise<Set<string>> {
    if (process.platform === 'win32') {
      return parseTasklistCsv(await run('tasklist', ['/FO', 'CSV', '/NH']));
    }
    return parsePsList(await run('ps', ['-eo', 'comm=']));
  }

  /** Pro nastavení: běžící programy (bez systémových), abecedně. */
  async listProcesses(): Promise<ProcessInfo[]> {
    const names = [...(await this.processNames())].filter((n) => !SYSTEM_PROCESSES.has(n) && !n.startsWith('kine'));
    return names.sort().map((exe) => ({ exe, name: exe.replace(/\.exe$/i, '') }));
  }

  private async steamGame(): Promise<DetectedGame | null> {
    const appId = await this.steamRunningAppId();
    if (!appId) return null;
    const name = (await this.steamName(appId)) ?? `Steam ${appId}`;
    return { name, exe: `steam:${appId}`, source: 'steam' };
  }

  private async steamRunningAppId(): Promise<number> {
    if (process.platform === 'win32') {
      return parseSteamRunningAppId(await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID']));
    }
    // Linux/macOS: registry.vdf u uživatele.
    const candidates = [join(homedir(), '.steam', 'registry.vdf'), join(homedir(), 'Library', 'Application Support', 'Steam', 'registry.vdf')];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      try {
        const m = /"RunningAppID"\s+"(\d+)"/.exec(readFileSync(file, 'utf8'));
        if (m) return Number(m[1]);
      } catch {
        // Nejde přečíst - jako by Steam nebyl.
      }
    }
    return 0;
  }

  private async steamName(appId: number): Promise<string | null> {
    const cached = this.steamNames.get(appId);
    if (cached) return cached;

    if (this.steamPath === undefined) {
      if (process.platform === 'win32') {
        this.steamPath = parseSteamPath(await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']));
      } else {
        const linux = join(homedir(), '.steam', 'steam');
        const mac = join(homedir(), 'Library', 'Application Support', 'Steam');
        this.steamPath = existsSync(linux) ? linux : existsSync(mac) ? mac : null;
      }
    }
    if (!this.steamPath) return null;

    const libraries = [this.steamPath];
    try {
      libraries.push(...parseLibraryFolders(readFileSync(join(this.steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
    } catch {
      // Bez seznamu knihoven se zkusí aspoň hlavní složka Steamu.
    }
    for (const lib of libraries) {
      const acf = join(lib, 'steamapps', `appmanifest_${appId}.acf`);
      if (!existsSync(acf)) continue;
      try {
        const name = parseAcfName(readFileSync(acf, 'utf8'));
        if (name) {
          this.steamNames.set(appId, name);
          return name;
        }
      } catch {
        // Poškozený manifest - zkusí se další knihovna.
      }
    }
    return null;
  }

  private async isMinecraftRunning(): Promise<boolean> {
    if (this.minecraftCheck && Date.now() - this.minecraftCheck.at < 60000) return this.minecraftCheck.result;
    let result = false;
    if (process.platform === 'win32') {
      const out = await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='javaw.exe' or Name='java.exe'\" | Select-Object -ExpandProperty CommandLine",
      ], 15000);
      result = isMinecraftCommandLine(out);
    } else {
      result = isMinecraftCommandLine(await run('ps', ['-eo', 'args=']));
    }
    this.minecraftCheck = { at: Date.now(), result };
    return result;
  }
}

/** Co nemá smysl nabízet jako "hru" v nastavení. */
const SYSTEM_PROCESSES = new Set([
  'system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'winlogon.exe', 'fontdrvhost.exe', 'dwm.exe', 'explorer.exe', 'sihost.exe', 'taskhostw.exe',
  'runtimebroker.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'ctfmon.exe',
  'conhost.exe', 'dllhost.exe', 'spoolsv.exe', 'audiodg.exe', 'wudfhost.exe', 'memory compression', 'securityhealthservice.exe',
  'securityhealthsystray.exe', 'msmpeng.exe', 'nissrv.exe', 'textinputhost.exe', 'applicationframehost.exe',
  'systemsettings.exe', 'lockapp.exe', 'wmiprvse.exe', 'msedgewebview2.exe', 'widgets.exe', 'taskmgr.exe',
  'tasklist.exe', 'reg.exe', 'powershell.exe', 'cmd.exe', 'onedrive.exe', 'steam.exe', 'steamwebhelper.exe',
  'steamservice.exe', 'discord.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe',
  'spotify.exe', 'epicgameslauncher.exe', 'epicwebhelper.exe', 'riotclientservices.exe', 'riotclientux.exe',
  'leagueclient.exe', 'leagueclientux.exe', 'battle.net.exe', 'agent.exe', 'ubisoftconnect.exe', 'upc.exe',
  'eadesktop.exe', 'eabackgroundservice.exe', 'nvcontainer.exe', 'nvidia share.exe', 'nvdisplay.container.exe',
  'radeonsoftware.exe', 'obs64.exe', 'medal.exe', 'overwolf.exe', 'wallpaper64.exe', 'ps', 'bash', 'sh', 'zsh',
  'systemd', 'init', 'kthreadd', 'dbus-daemon', 'pulseaudio', 'pipewire', 'xorg', 'gnome-shell',
]);
