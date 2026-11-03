import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Leží soubor opravdu ve složce, kam patří? Pro cesty, kterým appka nevěří -
 * index.json ve složce s klipy (tu může sdílet síť nebo jiný účet na PC) a
 * cesty z okna. Ne podle začátku textu ("C:\Videa\Kine-cizí" začíná stejně
 * jako "C:\Videa\Kine"), ale přes path.relative. Čistá logika kromě čtení
 * skutečné cesty (tests/safePath.test.mjs).
 */

/** Cesta zařízení ve Windows (\\?\…, \\.\…) obchází běžná pravidla cest - appka ji nebere. */
const DEVICE_PATH = /^[\\/]{2}[?.][\\/]/;

/** Je `file` podle textu cesty uvnitř složky `root` (bez sahání na disk)? Relativní cesty a cesty zařízení nikdy. */
export function isInsideLexically(file: unknown, root: string): boolean {
  if (typeof file !== 'string' || !file || !root || !isAbsolute(file) || DEVICE_PATH.test(file) || DEVICE_PATH.test(root)) return false;
  const rel = relative(resolve(root), resolve(file));
  return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Leží soubor v některé ze složek `roots`? Nejdřív podle textu cesty - na cestu
 * mimo složky (jiný disk, síťová cesta, relativní) se na disk vůbec nesahá. Pak
 * podle skutečné cesty, ať odkaz nebo junction uvnitř složky nevede ven. Soubor,
 * který neexistuje, se posoudí jen podle textu (není co otevřít ani smazat).
 */
export function isPathInside(file: unknown, roots: readonly string[]): boolean {
  if (!roots.some((root) => isInsideLexically(file, root))) return false;
  let real: string;
  try {
    real = realpathSync.native(file as string);
  } catch {
    return true;
  }
  return roots.some((root) => isInsideLexically(real, realOr(root)));
}
