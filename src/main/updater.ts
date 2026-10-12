import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { SmartAppControlState, UpdateProgress, Variant } from '../shared/types';
import { isNewerVersion, parseUpdateYml, type FeedConfig } from './updaterParse';
import { judgeUpdateOutcome, parseInstallerResult, parseSmartAppControl, parseUpdateAttempt, type UpdateOutcome } from './updateOutcome';
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
 * Stahuje se jen když se nehraje (nikdy během hry - lagovalo by to).
 * Instaluje se jen tlačítkem "Aktualizovat" (O appce, lišta u hodin) a s
 * okénkem instalátoru - ne potichu po ukončení appky: tichá instalace při
 * vypínání Windows nebo hned po zavření appky (hráč klikne na zástupce,
 * zatímco se soubory vyměňují) mohla nechat hráče bez appky. Jak instalace
 * dopadla, appka zjistí po dalším startu (takeUpdateOutcome).
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
  /** Jak často kontrolovat (h) - podle nastavení výkonu; bez toho 6 h. */
  checkHours?: () => number;
};

let updater: typeof import('electron-updater').autoUpdater | null = null;
let deps: Deps | null = null;
/** Verze, která je venku a čeká na stažení, až hra skončí. */
let pendingVersion: string | null = null;
let downloading = false;
let lastCheck: UpdateCheck | null = null;
/** Kdy appka předala instalaci instalátoru (0 = nepředala). */
let installStartedAt = 0;
let relaunching = false;

let progress: UpdateProgress = { phase: 'idle', version: null, percent: null, bytesPerSecond: null, transferred: null, total: null, error: null };
const listeners = new Set<(p: UpdateProgress) => void>();

function setProgress(patch: Partial<UpdateProgress>): void {
  progress = { ...progress, ...patch };
  for (const fn of listeners) {
    try {
      fn(progress);
    } catch {
      // posluchač nesmí shodit aktualizace
    }
  }
}

export function updateProgress(): UpdateProgress {
  return progress;
}

/** Jen samočinná zkouška (KINE_TEST): průběh aktualizace pro kontrolu okna (při vývoji se nic nestahuje). */
export function simulateUpdateProgress(patch: Partial<UpdateProgress>): void {
  if (!process.env.KINE_TEST) return;
  setProgress(patch);
}

/** Při každé změně průběhu (okno se překreslí). */
export function onUpdateProgress(fn: (p: UpdateProgress) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

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
    // Stahování řídíme sami (ne během hry). Instalace jen na "Aktualizovat" -
    // ne potichu při ukončení appky (při vypínání Windows by ji systém mohl
    // useknout uprostřed, kdy stará verze už je pryč a nová ještě není).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('download-progress', (p) => {
      // Do okna jen po celých procentech (okno se nepřekresluje při každém kousku).
      const percent = Math.max(0, Math.min(100, Math.floor(p.percent ?? 0)));
      if (progress.phase === 'downloading' && progress.percent === percent) return;
      setProgress({ phase: 'downloading', percent, bytesPerSecond: p.bytesPerSecond ?? null, transferred: p.transferred ?? null, total: p.total ?? null, error: null });
    });
    autoUpdater.on('update-downloaded', (info) => {
      downloading = false;
      log(`aktualizace ${info.version} stažená - nainstaluje se tlačítkem Aktualizovat`);
      setProgress({ phase: 'ready', version: info.version, percent: 100, error: null });
    });
    autoUpdater.on('error', (e) => {
      downloading = false;
      log(`aktualizace: ${e.message}`);
      // Instalátor se nespustil (Windows ho zablokoval, chybí): electron-updater
      // to ohlásí až ve chvíli, kdy appka už končí - spustit znovu tuhle verzi
      // (po startu řekne, že aktualizace neprošla).
      if (installStartedAt && Date.now() - installStartedAt < 20000) {
        log('instalátor aktualizace se nespustil - appka se spustí znovu ve stávající verzi');
        relaunchCurrent();
        return;
      }
      // Chyby kontroly (jeden zdroj nejde, zkusí se další) hlásí výsledek kontroly; sem jen chyba stahování.
      if (progress.phase === 'downloading') setProgress({ phase: 'error', error: shortError(e) });
    });
    updater = autoUpdater;
    // Kontrola po startu a pak každých N hodin (N podle nastavení výkonu, základ 6).
    setTimeout(() => void checkForUpdates(), 30000);
    const schedule = () => {
      const hours = Math.max(1, deps?.checkHours?.() ?? 6);
      setTimeout(() => {
        void checkForUpdates();
        schedule();
      }, hours * 60 * 60 * 1000);
    };
    schedule();
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
  if (!updater || downloading || progress.phase === 'ready') return;
  downloading = true;
  setProgress({ phase: 'downloading', version: pendingVersion ?? progress.version, percent: 0, transferred: 0, error: null });
  try {
    await updater.downloadUpdate();
    pendingVersion = null;
  } catch (e) {
    downloading = false;
    log(`stažení aktualizace: ${(e as Error).message}`);
    setProgress({ phase: 'error', error: shortError(e) });
  }
}

/** "Stáhnout teď" i během hry (hráč si o to řekl sám). */
export function downloadUpdateNow(): void {
  if (pendingVersion && updater && !downloading) void startDownload();
}

/**
 * "Aktualizovat": stažená verze se nainstaluje hned a appka se sama znovu
 * spustí. `prepare` = co appka musí dodělat před koncem (uložit nahrávku,
 * ukončit vysílání a snímání).
 */
export async function installUpdateNow(prepare: () => Promise<void>): Promise<'started' | 'failed' | 'not-ready'> {
  if (!updater || progress.phase !== 'ready') return 'not-ready';
  const version = progress.version;
  log(`aktualizace ${version}: instaluje se hned (restart, okénko instalátoru)`);
  await prepare().catch(() => undefined);
  // Pokus si zapsat: po startu appka pozná, jestli aktualizace prošla (a když ne, proč).
  recordAttempt(version);
  // Instalátor chybí / nejde spustit: electron-updater to ohlásí hned (událost error) a appku nezavře.
  let failed: string | null = null;
  const onError = (e: Error) => {
    failed = shortError(e);
  };
  updater.once('error', onError);
  try {
    // S okénkem instalátoru ("Installing, please wait…"): hráč vidí, že se něco
    // děje, a když Windows část instalátoru zablokuje, instalátor to řekne a
    // nechá starou verzi. Po instalaci se appka spustí sama (--force-run).
    updater.quitAndInstall(false, true);
  } catch (e) {
    failed = shortError(e);
  }
  updater.removeListener('error', onError);
  if (failed) {
    clearAttempt();
    log(`instalace aktualizace: ${failed}`);
    setProgress({ phase: 'error', error: failed });
    return 'failed';
  }
  installStartedAt = Date.now();
  return 'started';
}

/** Spustit znovu tuhle verzi (instalátor se nespustil). Jen jednou. */
function relaunchCurrent(): void {
  if (relaunching) return;
  relaunching = true;
  try {
    app.relaunch();
  } catch {
    // nejde - aspoň skončit, ať nezůstane viset napůl ukončená appka
  }
  app.exit(0);
}

// ---- jak dopadla poslední aktualizace -------------------------------------------

function attemptFile(): string {
  return join(app.getPath('userData'), 'update-attempt.json');
}

function recordAttempt(version: string | null): void {
  if (!version) return;
  try {
    writeFileSync(attemptFile(), JSON.stringify({ from: app.getVersion(), to: version, at: Date.now() }));
  } catch (e) {
    log(`pokus o aktualizaci se nezapsal: ${(e as Error).message}`);
  }
}

function clearAttempt(): void {
  try {
    unlinkSync(attemptFile());
  } catch {
    // nebyl
  }
}

/**
 * Složka electron-updateru (%LOCALAPPDATA%\<appka>-updater) - sem zapisuje
 * instalátor installer-result.txt (build/installer.nsh).
 */
function updaterCacheDir(variant: Variant): string | null {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  let name = '';
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8');
    name = /^updaterCacheDirName:\s*(.+)$/m.exec(yml)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  } catch {
    // appka bez app-update.yml (vývoj) - podle varianty
  }
  if (!/^[\w.-]+$/.test(name)) name = variant === 'clipper' ? 'kine-clipper-updater' : 'kine-desktop-updater';
  return join(base, name);
}

/**
 * Po startu: jak dopadla poslední aktualizace? Přečte (a smaže - hlásí se
 * jednou) záznam o pokusu a výsledek od instalátoru.
 */
export function takeUpdateOutcome(variant: Variant): UpdateOutcome {
  let attemptText: string | null = null;
  try {
    attemptText = readFileSync(attemptFile(), 'utf8');
  } catch {
    // žádný pokus
  }
  const dir = process.platform === 'win32' ? updaterCacheDir(variant) : null;
  const resultFile = dir ? join(dir, 'installer-result.txt') : null;
  let resultText: string | null = null;
  try {
    if (resultFile) resultText = readFileSync(resultFile, 'utf8');
  } catch {
    // instalátor nic nezapsal
  }
  const installer = parseInstallerResult(resultText);
  const outcome = judgeUpdateOutcome({ current: app.getVersion(), attempt: parseUpdateAttempt(attemptText), installer, now: Date.now() });
  if (installer) log(`instalátor naposledy: ${installer.result}${installer.version ? ` (${installer.version})` : ''}`);
  if (attemptText !== null) clearAttempt();
  if (resultFile && resultText !== null) {
    try {
      unlinkSync(resultFile);
    } catch {
      // nevadí - příště se přečte znovu (a podle verze nic nehlásí)
    }
  }
  return outcome;
}

let sacCache: { at: number; value: SmartAppControlState | null } | null = null;

/**
 * Smart App Control ve Windows 11 (blokuje nepodepsané programy a jejich
 * části - i kus instalátoru): 'on' / 'off' / 'evaluation', null = Windows
 * 10, jiný systém nebo nejde zjistit. Výsledek se pamatuje 10 minut.
 */
export function smartAppControlState(): Promise<SmartAppControlState | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (sacCache && Date.now() - sacCache.at < 10 * 60 * 1000) return Promise.resolve(sacCache.value);
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', '/v', 'VerifiedAndReputablePolicyState'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        const value = err ? null : parseSmartAppControl(String(stdout));
        sacCache = { at: Date.now(), value };
        resolve(value);
      }
    );
  });
}

export function lastUpdateCheck(): UpdateCheck | null {
  return lastCheck;
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  if (!updater || !deps) return { status: 'disabled' };
  // Už stažená verze: nic znovu nehledat, jen ji nabídnout.
  if (progress.phase === 'ready') return finish({ status: 'available', version: progress.version ?? undefined });
  if (progress.phase !== 'downloading') setProgress({ phase: 'checking', error: null });
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
          setProgress({ phase: 'waiting-game', version });
          return finish({ status: 'available', version, source: label, waitingForGame: true });
        }
        setProgress({ version });
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
  // Kontrola doběhla (nejnovější verze / ruční stažení / chyba) - "hledám" pryč; stahování a připravenou verzi to nemění.
  if (progress.phase === 'checking') setProgress({ phase: 'idle' });
  return result;
}

/** Chyba electron-updateru bývá dlouhá (hlavičky, stack) - do okna jen první řádek. */
function shortError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const line = raw.split('\n').find((l) => l.trim()) ?? raw;
  return line.replace(/\s+/g, ' ').trim().slice(0, 160);
}
