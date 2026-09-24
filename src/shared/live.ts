import type { LivePreset, LiveQuality } from './types';
import type { Key } from './i18n';

/**
 * Živé vysílání z appky na Kine - společné pro hlavní proces i okna.
 *
 * Kvalita: rozlišení, snímky a datový tok druhého recorderu (zásobník
 * s klipy běží dál ve své kvalitě). Základ je 720p30 za 3 Mb/s - projde
 * i slabším uploadem, ať vysílání neláme online hru. Cloudflare doporučuje
 * klíčový snímek každé 2 s - recorder ho tak dává.
 */
export const LIVE_QUALITIES = ['720p30', '1080p30', '1080p60'] as const satisfies readonly LiveQuality[];

export const LIVE_PRESETS: Record<LiveQuality, LivePreset> = {
  '720p30': { width: 1280, height: 720, fps: 30, videoKbps: 3000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, videoKbps: 4500 },
  '1080p60': { width: 1920, height: 1080, fps: 60, videoKbps: 6000 },
};

/** "720p · 30 fps · 3 Mb/s" - popisek do výběru kvality. */
export function livePresetLabel(quality: LiveQuality): string {
  const p = LIVE_PRESETS[quality];
  const mbps = p.videoKbps / 1000;
  return `${p.height}p · ${p.fps} fps · ${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mb/s`;
}

/** Jak dlouho se vysílá: "0:05", "12:34", "1:02:03". */
export function liveElapsed(since: number | null, now = Date.now()): string {
  if (!since) return '0:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Druh chyby vysílání (hláška z ffmpeg / Kine) -> který text hráči ukázat. */
export type LiveErrorKind = 'auth' | 'network' | 'not-configured' | 'not-migrated' | 'login' | 'h264' | 'capture' | 'other';

export function liveErrorKind(message: string): LiveErrorKind {
  const m = message.toLowerCase();
  if (/live-not-configured|cloudflare stream není|not configured/.test(m)) return 'not-configured';
  if (/live-not-migrated|migrace|migrated/.test(m)) return 'not-migrated';
  if (/not-logged-in|nejsi přihlášen|musíš být přihlášen/.test(m)) return 'login';
  if (/h264-unsupported/.test(m)) return 'h264';
  if (/capture-off|snímání neběží|zásobník/.test(m)) return 'capture';
  if (/unauthori[sz]ed|forbidden|403|invalid stream key|stream key/.test(m)) return 'auth';
  if (/connection|network|timed out|timeout|refused|resolve|unreachable|broken pipe|reset|i\/o error|input\/output/.test(m)) return 'network';
  return 'other';
}

/** Text chyby vysílání pro hráče (klíč překladu; 'liveErrOther' má {message}). */
export function liveErrorTextKey(message: string): Key {
  switch (liveErrorKind(message)) {
    case 'not-configured':
      return 'liveErrNotConfigured';
    case 'not-migrated':
      return 'liveErrNotMigrated';
    case 'login':
      return 'liveNeedLogin';
    case 'h264':
      return 'liveErrH264';
    case 'capture':
      return 'liveErrCapture';
    case 'auth':
      return 'liveErrAuth';
    case 'network':
      return 'liveErrNetwork';
    default:
      return 'liveErrOther';
  }
}

/** Hláška z IPC ("Error invoking remote method 'live:start': Error: live-not-migrated") bez obalu. */
export function cleanLiveError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim();
}
