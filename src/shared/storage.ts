import type { Clip } from './types';

/**
 * Strop místa na klipy (Nastavení -> Záznam -> Místo na klipy).
 *
 * Když klipy a koš dohromady přerostou strop, uvolní se místo: nejdřív
 * koš (nejdéle smazané), pak nejstarší klipy. Nikdy se nesahá na
 * oblíbené (hvězdička), na klipy, které se právě nahrávají na Kine, ani na
 * klipy mladší než hodinu (co hráč právě natočil, mu nezmizí). Čistá logika
 * bez souborů - má test.
 */
export const GB = 1024 ** 3;
/** Klipy mladší než tohle se nemažou nikdy. */
export const STORAGE_KEEP_RECENT_MS = 60 * 60 * 1000;

export type StorageCleanup = {
  /** Id klipů k smazání nadobro, v pořadí (koš první, pak nejstarší). */
  ids: string[];
  freedBytes: number;
  /** Kolik z toho jsou klipy mimo koš. */
  clipCount: number;
  /** I po smazání všeho dovoleného zůstane nad stropem (oblíbené, čerstvé…). */
  stillOver: boolean;
};

export function storageCleanupPlan(clips: Clip[], limitBytes: number, now = Date.now()): StorageCleanup {
  const empty: StorageCleanup = { ids: [], freedBytes: 0, clipCount: 0, stillOver: false };
  if (!(limitBytes > 0)) return empty;
  const size = (c: Clip) => (Number.isFinite(c.sizeBytes) && c.sizeBytes > 0 ? c.sizeBytes : 0);
  let used = clips.reduce((sum, c) => sum + size(c), 0);
  if (used <= limitBytes) return empty;

  const busy = (c: Clip) => !!c.upload && (c.upload.state === 'queued' || c.upload.state === 'uploading' || c.upload.state === 'paused');
  const time = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  // Čerstvost: konec záznamu nebo přidání do knihovny, co je později. Nahrávka
  // zápasu má createdAt = začátek nahrávání - podle něj by dvouhodinová
  // nahrávka šla smazat hned po uložení.
  const freshAt = (c: Clip) => {
    const seconds = Number.isFinite(c.durationSeconds) && c.durationSeconds > 0 ? c.durationSeconds : 0;
    return Math.max(time(c.createdAt) + seconds * 1000, time(c.addedAt));
  };
  const trash = clips.filter((c) => !!c.deletedAt).sort((a, b) => time(a.deletedAt) - time(b.deletedAt));
  const candidates = clips
    .filter((c) => !c.deletedAt && !c.favorite && !busy(c) && now - freshAt(c) > STORAGE_KEEP_RECENT_MS)
    .sort((a, b) => freshAt(a) - freshAt(b));

  const out: StorageCleanup = { ids: [], freedBytes: 0, clipCount: 0, stillOver: false };
  for (const c of [...trash, ...candidates]) {
    if (used <= limitBytes) break;
    out.ids.push(c.id);
    out.freedBytes += size(c);
    used -= size(c);
    if (!c.deletedAt) out.clipCount += 1;
  }
  out.stillOver = used > limitBytes;
  return out;
}
