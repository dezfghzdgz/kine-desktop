import { app } from 'electron';
import { log } from './log';

/**
 * Aktualizace z GitHub Releases (electron-updater). Zapnuté jen
 * v zabalené appce; při vývoji (npm start) se nic nekontroluje.
 *
 * Stáhne se na pozadí a nainstaluje po ukončení appky - hráči se nic
 * neukazuje uprostřed hry.
 */
export type UpdateCheck = { status: 'up-to-date' | 'available' | 'error' | 'disabled'; version?: string };

let updater: typeof import('electron-updater').autoUpdater | null = null;

export function initUpdater(): void {
  if (!app.isPackaged) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => undefined } as any;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    updater = autoUpdater;
    // Kontrola po startu a pak každých 6 hodin.
    setTimeout(() => void checkForUpdates(), 30000);
    setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
  } catch (e) {
    log(`aktualizace nejdou zapnout: ${(e as Error).message}`);
  }
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  if (!updater) return { status: 'disabled' };
  try {
    const result = await updater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (version && version !== app.getVersion()) return { status: 'available', version };
    return { status: 'up-to-date' };
  } catch (e) {
    log(`kontrola aktualizací: ${(e as Error).message}`);
    return { status: 'error' };
  }
}
