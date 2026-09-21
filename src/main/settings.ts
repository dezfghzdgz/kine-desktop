import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { Settings } from '../shared/types';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../shared/settingsSchema';
import { langFromLocale } from '../shared/i18n';
import { log } from './log';

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
      return sanitizeSettings(parsed);
    } catch {
      // První spuštění (nebo rozbitý soubor): výchozí + jazyk podle systému.
      return { ...DEFAULT_SETTINGS, lang: langFromLocale(app.getLocale()) };
    }
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.current;
    this.current = sanitizeSettings({ ...prev, ...patch });
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
