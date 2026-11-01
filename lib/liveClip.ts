/**
 * Klip z živého vysílání (čistá logika - tests/liveClip.test.mjs).
 *
 * Divák u přenosu klikne na „Klip“ a uloží se posledních ~30 sekund -
 * jako na Twitchi. Cloudflare to umí sám ("Live Instant Clipping"): ze
 * záznamu, který se při vysílání nahrává, vyrobí MP4 od-do
 * (https://customer-<kód>.cloudflarestream.com/<video>/clip.mp4?time=…&duration=…).
 * Takový klip ale u Cloudflare nezůstává (zmizí se záznamem), proto ho Kine
 * hned zkopíruje jako nové video (API "copy") - pak je to obyčejný klip
 * jako z videa: vlastní ho streamer, u klipu je uvedené, kdo ho udělal.
 *
 * Kde je "posledních 30 s": náhledový manifest ?duration=30s vrací
 * v hlavičce preview-start-seconds, kde těch posledních 30 s začíná
 * (od začátku vysílání). Když hlavička nepřijde, dopočítá se to z délky
 * vysílání s rezervou na zpoždění (živý obraz je pár vteřin pozadu).
 */

/** Kolik sekund klip má. */
export const LIVE_CLIP_SECONDS = 30;
/** Rezerva za živým okrajem (sekundy), když se musí počítat z délky vysílání. */
export const LIVE_CLIP_EDGE_S = 10;
/** Kratší klip nedává smysl - vysílání teprve začalo. */
export const LIVE_CLIP_MIN_S = 5;

export type LiveClipWindow = { ok: true; time: number; duration: number } | { ok: false; reason: 'too-early' | 'invalid' };

const UID = /^[a-f0-9]{32}$/i;
const CODE = /^[a-z0-9]{4,64}$/i;

/**
 * Odkud a jak dlouhý klip (sekundy od začátku vysílání).
 *  - previewStart: hlavička preview-start-seconds (začátek posledních `length` sekund),
 *  - elapsed: jak dlouho vysílání běží (záloha a strop).
 */
export function liveClipWindow(input: { previewStart?: number | null; elapsed?: number | null }, length = LIVE_CLIP_SECONDS): LiveClipWindow {
  const span = Math.max(LIVE_CLIP_MIN_S, Math.min(60, Math.floor(length)));
  const elapsed = typeof input.elapsed === 'number' && Number.isFinite(input.elapsed) ? Math.max(0, input.elapsed) : null;
  const preview = typeof input.previewStart === 'number' && Number.isFinite(input.previewStart) && input.previewStart >= 0 ? input.previewStart : null;

  if (preview !== null) {
    const time = Math.floor(preview);
    // Vysílání kratší než klip: Cloudflare vrátí, co je - délka podle toho, kolik ho uběhlo.
    const available = elapsed !== null ? Math.floor(elapsed) - time : span;
    const duration = Math.min(span, Math.max(0, available));
    if (duration < LIVE_CLIP_MIN_S) return { ok: false, reason: 'too-early' };
    return { ok: true, time, duration };
  }
  if (elapsed === null) return { ok: false, reason: 'invalid' };
  const end = Math.floor(elapsed - LIVE_CLIP_EDGE_S);
  const time = Math.max(0, end - span);
  const duration = end - time;
  if (duration < LIVE_CLIP_MIN_S) return { ok: false, reason: 'too-early' };
  return { ok: true, time, duration };
}

/** Náhledový manifest posledních `length` sekund (kvůli hlavičce preview-start-seconds). */
export function livePreviewManifestUrl(code: string, videoUid: string, length = LIVE_CLIP_SECONDS): string | null {
  if (!CODE.test(code) || !UID.test(videoUid)) return null;
  return `https://customer-${code}.cloudflarestream.com/${videoUid}/manifest/video.m3u8?duration=${Math.floor(length)}s`;
}

/** MP4 klipu ze záznamu vysílání (Cloudflare ho vyrobí, když si ho někdo stáhne). */
export function liveClipMp4Url(code: string, videoUid: string, window: { time: number; duration: number }): string | null {
  if (!CODE.test(code) || !UID.test(videoUid)) return null;
  const time = Math.max(0, Math.floor(window.time));
  const duration = Math.max(1, Math.min(60, Math.floor(window.duration)));
  return `https://customer-${code}.cloudflarestream.com/${videoUid}/clip.mp4?time=${time}s&duration=${duration}s&filename=kine-clip.mp4`;
}

/** Hlavička preview-start-seconds -> číslo (nesmysl = null). */
export function readPreviewStart(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 && n < 7 * 24 * 3600 ? n : null;
}
