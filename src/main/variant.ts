import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AppMode, Variant } from '../shared/types';

/**
 * Která ze dvou appek tohle je.
 *
 *  - "Kine" (Kine do PC): Kine jako aplikace na koukání videí + klipovač
 *    v jednom okně.
 *  - "Kine Clipper" (Kine Klipovač): jen klipovač v liště u hodin; Kine
 *    se otvírá v prohlížeči.
 *
 * Obě se staví ze stejného kódu ve stejném workflow; liší se tím, co
 * scripts/publish-config.mjs zapíše do package.json zabalené appky
 * (extraMetadata: kineVariant, name, productName), ikonou a adresou
 * aktualizací. Klipovač je součástí Kine do PC a funguje stejně - proto
 * je režim appky dán variantou a nepřepíná se v nastavení.
 *
 * Při vývoji (nezabalená appka) rozhoduje KINE_VARIANT=clipper|full.
 */
export function detectVariant(): Variant {
  const env = process.env.KINE_VARIANT;
  if (env === 'clipper' || env === 'full') return env;
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { kineVariant?: unknown };
    if (pkg.kineVariant === 'clipper') return 'clipper';
  } catch {
    // bez package.json (nemělo by nastat) = Kine do PC
  }
  return 'full';
}

export function modeForVariant(variant: Variant): AppMode {
  return variant === 'clipper' ? 'clipper' : 'full';
}

/** Název, pod kterým je appka nainstalovaná (productName v electron-builderu). */
export const PRODUCT_NAMES: Record<Variant, string> = { full: 'Kine', clipper: 'Kine Clipper' };

/** Windows: AppUserModelID - podle něj se řadí oznámení a ikony v liště; každá appka svoje. */
export const APP_USER_MODEL_IDS: Record<Variant, string> = { full: 'cz.kine.desktop', clipper: 'cz.kine.clipper' };

/** Název programu druhé appky (malými písmeny, jako v seznamu procesů). */
export function siblingExe(variant: Variant): string {
  return variant === 'clipper' ? 'kine.exe' : 'kine clipper.exe';
}
