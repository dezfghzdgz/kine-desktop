import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { Variant } from '../shared/types';
import { isNewerVersion, parseUpdateYml, type FeedConfig } from './updaterParse';
import { log } from './log';

/**
 * Aktualizace appky (electron-updater). Zapnuté jen v zabalené appce;
 * při vývoji (npm start) se nic nekontroluje.
 *
 * Odkud: podle app-update.yml, které do appky zapíše electron-builder
 * (první poskytovatel z publish - naše úložiště R2, jinak GitHub
 * Releases). Když to nevyjde (chybí latest.yml, výpadek), zkusí se
 * GitHub Releases přímo a nakonec se appka zeptá webu Kine
 * (/api/desktop/latest), jaká verze je venku - ať "Zkontrolovat
 * aktualizace" vždycky řekne něco užitečného, ne jen "nejde to".
 *
 * Stahuje se jen když se nehraje (nikdy během hry - lagovalo by to),
 * instaluje se po ukončení appky. Hráči se nic neukazuje uprostřed hry.
 */
export type UpdateCheck = {
  status:
    /** Nejnovější verze. */
    | 'up-to-date'
    /** Novější verze je venku a stahuje se (nebo počká, až hra skončí). */
    | 'available'
    /** Novější verze je venku, ale automaticky se stáhnout nedá - ručně z webu. */
    | 'available-manual'
    | 'error'
    /** Při vývoji. */
    | 'disabled';
  version?: string;
  /** Odkaz na instalátor (u available-manual). */
  url?: string;
  /** Důvod, proč se to nepovedlo, nebo poznámka. */
  message?: string;
  /** Odkud se aktualizace berou (adresa nebo "GitHub"), pro záložku O appce. */
  source?: string;
  /** Stahování odloženo, protože běží hra. */
  waitingForGame?: boolean;
};

type Deps = {
  variant: Variant;
  siteUrl: () => string;
  /** Běží hra? Během hry se nestahuje. */
  gameRunning: () => boolean;
};

let updater: typeof import('electron-updater').autoUpdater | null = null;
let deps: Deps | null = null;
/** Verze, která je venku a čeká na stažení, až hra skončí. */
let pendingVersion: string | null = null;
let downloading = false;
let lastCheck: UpdateCheck | null = null;

/** Poskytovatel z app-update.yml (zapisuje electron-builder), nebo null. */
export function primaryFeed(): FeedConfig | null {
  try {
    const file = join(process.resourcesPath, 'app-update.yml');
    if (!existsSync(file)) return null;
    return parseUpdateYml(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Záložní zdroj: GitHub Releases repa appky (Kine Clipper má vlastní soubor clipper.yml). */
function githubFeed(variant: Variant): FeedConfig {
  return { provider: 'github', owner: 'dezfghzdgz', repo: 'kine-desktop', channel: variant === 'clipper' ? 'clipper' : undefined };
}

function describeFeed(feed: FeedConfig | null): string {
  if (!feed) return 'GitHub';
  return feed.provider === 'generic' ? feed.url : `GitHub (${feed.owner}/${feed.repo})`;
}

export function initUpdater(d: Deps): void {
  deps = d;
  if (!app.isPackaged) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined } as any;
    // Stahování řídíme sami (ne během hry), instalace až po ukončení appky.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      downloading = false;
      log(`aktualizace ${info.version} stažená - nainstaluje se po ukončení appky`);
    });
    autoUpdater.on('error', (e) => {
      downloading = false;
      log(`aktualizace: ${e.message}`);
    });
    updater = autoUpdater;
    // Kontrola po startu a pak každých 6 hodin.
    setTimeout(() => void checkForUpdates(), 30000);
    setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  } catch (e) {
    log(`aktualizace nejdou zapnout: ${(e as Error).message}`);
  }
}

/** Hra skončila - když mezitím vyšla nová verze, teď se stáhne. */
export function onGameEnded(): void {
  if (pendingVersion && updater && !downloading) {
    log(`hra skončila - stahuje se odložená aktualizace ${pendingVersion}`);
    void startDownload();
  }
}

async function startDownload(): Promise<void> {
  if (!updater || downloading) return;
  downloading = true;
  try {
    await updater.downloadUpdate();
    pendingVersion = null;
  } catch (e) {
    downloading = false;
    log(`stažení aktualizace: ${(e as Error).message}`);
  }
}

export function lastUpdateCheck(): UpdateCheck | null {
  return lastCheck;
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  if (!updater || !deps) return { status: 'disabled' };
  const current = app.getVersion();
  const primary = primaryFeed();
  const feeds: { label: string; feed: FeedConfig | null }[] = [{ label: describeFeed(primary), feed: null }];
  if (!primary || primary.provider !== 'github') feeds.push({ label: 'GitHub', feed: githubFeed(deps.variant) });
  const errors: string[] = [];

  for (const { label, feed } of feeds) {
    try {
      if (feed) updater.setFeedURL(feed as any);
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (version && isNewerVersion(version, current)) {
        pendingVersion = version;
        if (deps.gameRunning()) {
          log(`aktualizace ${version} je venku - stáhne se po hře`);
          return finish({ status: 'available', version, source: label, waitingForGame: true });
        }
        void startDownload();
        return finish({ status: 'available', version, source: label });
      }
      return finish({ status: 'up-to-date', version: current, source: label });
    } catch (e) {
      const message = shortError(e);
      errors.push(`${label}: ${message}`);
      log(`kontrola aktualizací (${label}): ${message}`);
    }
  }

  // Poslední záchrana: web Kine ví, jaká verze je venku a odkud se stahuje.
  try {
    const res = await fetch(`${deps.siteUrl()}/api/desktop/latest`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      release?: { version?: string } | null;
      clipper?: { version?: string } | null;
      directUrl?: string;
      clipperDirectUrl?: string;
    };
    const info = deps.variant === 'clipper' ? data.clipper : data.release;
    const url = deps.variant === 'clipper' ? data.clipperDirectUrl : data.directUrl;
    const version = info?.version ?? null;
    if (!version) throw new Error('web nezná verzi');
    if (isNewerVersion(version, current)) {
      return finish({ status: 'available-manual', version, url: url || `${deps.siteUrl()}/download`, source: 'Kine', message: errors.join(' · ') });
    }
    return finish({ status: 'up-to-date', version: current, source: 'Kine', message: errors.join(' · ') });
  } catch (e) {
    errors.push(`Kine: ${shortError(e)}`);
  }
  return finish({ status: 'error', message: errors.join(' · '), source: describeFeed(primary) });
}

function finish(result: UpdateCheck): UpdateCheck {
  lastCheck = result;
  return result;
}

/** Chyba electron-updateru bývá dlouhá (hlavičky, stack) - do okna jen první řádek. */
function shortError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.split('\n').find((l) => l.trim()) ?? raw;
  return line.replace(/\s+/g, ' ').trim().slice(0, 160);
}
