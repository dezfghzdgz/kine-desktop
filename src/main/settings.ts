import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { app } from 'electron';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../shared/settingsSchema';
import { guardSiteUrl } from '../shared/kineClient';
import { log } from './log';

/**
 * Zabalená appka mluví jen s oficiálním Kine (src/shared/kineClient.ts) - jiná
 * adresa v nastavení se vrátí. Vývoj (nezabalená appka) a testy (KINE_TEST, jen
 * nezabalená appka) můžou cokoli.
 */
function withOfficialSite(settings: Settings): Settings {
  const siteUrl = guardSiteUrl(settings.siteUrl, { packaged: app.isPackaged, test: !app.isPackaged && !!process.env.KINE_TEST });
  if (siteUrl === settings.siteUrl) return settings;
  log(`adresa Kine ${settings.siteUrl} není oficiální - appka mluví s ${siteUrl}`);
  return { ...settings, siteUrl };
}

/**
 * Složka s klipy: prázdné (= Videa/Kine), nebo celá cesta - ne relativní (záleželo
 * by na tom, odkud se appka spustila) a ne cesta zařízení (\\?\…, \\.\…). Síťová
 * složka (\\server\sdílení) jde. Mění ji jen dialog (clips:pickDir v main.ts).
 */
function withValidClipsDir(settings: Settings): Settings {
  const dir = settings.clipsDir;
  if (!dir || (isAbsolute(dir) && !/^[\\/]{2}[?.][\\/]/.test(dir))) return settings;
  log(`složka s klipy "${dir}" není platná cesta - appka bere výchozí`);
  return { ...settings, clipsDir: '' };
}

function guarded(settings: Settings): Settings {
  return withValidClipsDir(withOfficialSite(settings));
}

/**
 * Nastavení v userData/settings.json. Načte se jednou, změny se hned
 * ukládají a rozesílají posluchačům (okna, tray, snímání).
 */
export class SettingsStore {
  private current: Settings;
  private listeners = new Set<(s: Settings, prev: Settings) => void>();
  private readonly file: string;

  constructor() {
    this.file = join(app.getPath('userData'), 'settings.json');
    this.current = this.read();
  }

  private read(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return guarded(sanitizeSettings(parsed));
    } catch {
      // První spuštění (nebo rozbitý soubor): výchozí - anglicky, jazyk si
      // hráč vybere hned na první stránce průvodce.
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.current;
    this.current = guarded(sanitizeSettings({ ...prev, ...patch }));
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.current, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      log(`nastavení se nepodařilo uložit: ${(e as Error).message}`);
    }
    for (const l of this.listeners) l(this.current, prev);
    return this.current;
  }

  onChange(listener: (s: Settings, prev: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Složka s klipy: nastavená, nebo Videa/Kine. */
  clipsDir(): string {
    return this.current.clipsDir || join(app.getPath('videos'), 'Kine');
  }
}
