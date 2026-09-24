/**
 * Čistá část živého vysílání (bez electronu a ffmpeg - testuje se).
 *
 * Proud ze snímací stránky (WebM: H.264 + Opus po sekundě) jde rourou do
 * ffmpeg, který obraz jen přebalí (žádné překódování - kóduje grafika
 * v recorderu) a zvuk převede na AAC, protože RTMP jiný nebere. Ven jde
 * FLV přes RTMPS na Cloudflare Stream Live (stejný vstup jako OBS).
 */

/** Adresa pro ffmpeg: server z Cloudflare ("rtmps://live.cloudflare.com:443/live/") + klíč. */
export function rtmpUrl(server: string, key: string): string {
  const base = server.trim();
  const k = key.trim();
  if (!base || !k) throw new Error('missing-live-url');
  return base.endsWith('/') ? `${base}${k}` : `${base}/${k}`;
}

/** Klíč v adrese se do protokolu nepíše celý (kdo má klíč, vysílá za kanál). */
export function maskLiveUrl(url: string): string {
  const i = url.lastIndexOf('/');
  if (i < 0) return url;
  const key = url.slice(i + 1);
  return `${url.slice(0, i + 1)}${key.slice(0, 4)}…`;
}

/** Argumenty ffmpeg: WebM z roury -> FLV na RTMP(S), obraz beze změny, zvuk AAC 160k. Průběh na stdout. */
export function liveFfmpegArgs(url: string): string[] {
  return [
    '-loglevel', 'error',
    // Hlavička proudu je hned v prvním kousku - ffmpeg nemusí čekat 5 s na rozbor.
    '-probesize', '5000000',
    '-analyzeduration', '2000000',
    '-fflags', '+genpts',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    '-progress', 'pipe:1',
    '-nostats',
    url,
  ];
}

/** Řádek průběhu "out_time_us=12345678" -> sekundy odvysílaného proudu (null = jiný řádek). */
export function liveProgressSeconds(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
  return m ? Number(m[1]) / 1e6 : null;
}

/**
 * Po výpadku (síť, Cloudflare) se vysílání připojí znovu: 2, 3, 5, 8, 13,
 * 20 s... Cloudflare drží živý přenos minutu (timeoutSeconds 60), takže
 * rychlé pokusy navážou na stejné video. Po `LIVE_MAX_ATTEMPTS` se vzdá.
 */
export const LIVE_RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 13000, 20000, 30000, 30000];
export const LIVE_MAX_ATTEMPTS = LIVE_RETRY_DELAYS_MS.length;

export function liveRetryDelay(attempt: number): number | null {
  if (attempt < 1 || attempt > LIVE_MAX_ATTEMPTS) return null;
  return LIVE_RETRY_DELAYS_MS[attempt - 1];
}

/** Kolik smí stát v rouře, než se usoudí, že upload nestíhá (~48 MB = desítky sekund videa). */
export const LIVE_MAX_BACKLOG_BYTES = 48 * 1024 * 1024;
