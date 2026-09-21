import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Protokol do souboru (userData/logs/kine.log), ať má hráč co poslat,
 * když něco nejde. Jeden soubor, po 2 MB se otočí na kine.old.log.
 */
let dir = '';

export function initLog(logDir: string): void {
  dir = logDir;
  mkdirSync(dir, { recursive: true });
}

export function logDir(): string {
  return dir;
}

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (process.env.KINE_DEBUG) process.stdout.write(line);
  if (!dir) return;
  try {
    const file = join(dir, 'kine.log');
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(dir, 'kine.old.log'));
    } catch {
      // Soubor ještě není.
    }
    appendFileSync(file, line);
  } catch {
    // Když nejde ani zapsat protokol, nemá smysl to hlásit.
  }
}
