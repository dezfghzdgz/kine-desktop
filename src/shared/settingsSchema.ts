import { CATEGORY_KEYS, LANGS, VISIBILITIES, type Settings } from './types';
import { isHotkey } from './hotkeys';
import { LIVE_QUALITIES } from './live';

/**
 * Výchozí nastavení a jeho očištění po načtení ze souboru.
 *
 * Soubor nastavení edituje i člověk (a starší verze appky), takže se
 * nevěří ničemu: každá hodnota se zkontroluje a co nesedí, nahradí
 * výchozí. Díky tomu appka po chybě v souboru nespadne, jen se vrátí
 * k rozumným hodnotám.
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 3,
  lang: 'en',
  appMode: 'clipper',
  appModeChosen: false,
  clipHotkey: 'F8',
  toggleHotkey: 'Ctrl+F9',
  recordHotkey: 'Ctrl+F8',
  screenshotHotkey: 'Alt+F8',
  liveQuality: '720p30',
  liveTitle: '',
  clipSeconds: 30,
  maxHeight: 1080,
  fps: 60,
  codec: 'auto',
  videoMbps: 20,
  systemAudio: true,
  systemAudioDevice: '',
  microphoneDevice: '',
  systemGain: 1,
  micGain: 1,
  separateMicTrack: true,
  audioOffsetMs: 0,
  // Mikrofon od začátku - hráč nemá co nastavovat, klip má i jeho hlas.
  microphone: true,
  displayId: '',
  detection: 'games',
  detectFullscreen: true,
  customGames: {},
  afterGame: 'review',
  visibility: 'private',
  videoLanguage: 'en',
  startWithSystem: true,
  toast: true,
  clipsDir: '',
  siteUrl: 'https://kine-lac.vercel.app',
  onboarded: false,
  brandColor: '',
  autoClips: 'multi',
  gsiToken: '',
  discordWebhook: '',
  performance: 'balanced',
  lastVersion: '',
  clipsSort: 'newest',
  uploadAsk: true,
  uploadHashtags: '',
  uploadCategory: 'catGaming',
  uploadThumbnail: true,
};

export const CLIP_SECONDS_OPTIONS = [15, 30, 60, 90, 120] as const;
export const CLIP_SECONDS_MIN = 5;
export const CLIP_SECONDS_MAX = 300;

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** Posun zvuku -500..500 ms, celé ms. */
function offsetMs(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(-500, Math.min(500, n)));
}

/** Hlasitost 0-2 (1 = beze změny), zaokrouhlená na setiny. */
function gain(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.max(0, Math.min(2, n)) * 100) / 100;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, fallback: string, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

/** Ořeže neplatné hodnoty na výchozí; neznámé klíče zahodí. */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;

  const clipSeconds = Number(raw.clipSeconds);
  const videoMbps = Number(raw.videoMbps);

  const customGames: Record<string, string> = {};
  if (raw.customGames && typeof raw.customGames === 'object') {
    for (const [exe, name] of Object.entries(raw.customGames as Record<string, unknown>)) {
      const key = exe.trim().toLowerCase();
      if (key && typeof name === 'string' && name.trim()) customGames[key] = name.trim().slice(0, 80);
    }
  }

  let siteUrl = text(raw.siteUrl, d.siteUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/i.test(siteUrl)) siteUrl = d.siteUrl;

  // Nastavení ze starší verze (před 0.3): mikrofon se jednou zapne (dřív
  // byl vypnutý a hráč to musel hledat) a režim se znovu odvodí z instalátoru.
  const upgrade = raw.version !== 2 && raw.version !== 3;
  // Před 0.9.3 byl základ 1080p / 30 fps / 8 Mb/s - na hry málo (trhaný a
  // kostičkovaný obraz). Kdo si kvalitu nikdy nesáhl, dostane nový základ
  // 1080p60 20 Mb/s; kdo si ji nastavil, tomu zůstane.
  const oldDefaults = raw.version !== 3 && (raw.fps === 30 || raw.fps === undefined) && (raw.videoMbps === 8 || raw.videoMbps === undefined) && (raw.maxHeight === 1080 || raw.maxHeight === undefined);

  return {
    version: 3,
    lang: oneOf(raw.lang, LANGS, d.lang),
    appMode: oneOf(raw.appMode, ['clipper', 'full'] as const, d.appMode),
    appModeChosen: upgrade ? false : bool(raw.appModeChosen, d.appModeChosen),
    clipHotkey: isHotkey(raw.clipHotkey) ? (raw.clipHotkey as string) : d.clipHotkey,
    toggleHotkey: isHotkey(raw.toggleHotkey) ? (raw.toggleHotkey as string) : d.toggleHotkey,
    // Prázdné = nahrávání zápasu bez zkratky (jen tlačítkem); chybějící klíč ze starší verze = výchozí.
    recordHotkey: raw.recordHotkey === '' ? '' : isHotkey(raw.recordHotkey) ? (raw.recordHotkey as string) : d.recordHotkey,
    screenshotHotkey: raw.screenshotHotkey === '' ? '' : isHotkey(raw.screenshotHotkey) ? (raw.screenshotHotkey as string) : d.screenshotHotkey,
    liveQuality: oneOf(raw.liveQuality, LIVE_QUALITIES, d.liveQuality),
    liveTitle: text(raw.liveTitle, d.liveTitle, 100),
    clipSeconds: Number.isFinite(clipSeconds)
      ? Math.min(CLIP_SECONDS_MAX, Math.max(CLIP_SECONDS_MIN, Math.round(clipSeconds)))
      : d.clipSeconds,
    maxHeight: oneOf(raw.maxHeight, [0, 720, 1080, 1440] as const, d.maxHeight),
    fps: oldDefaults ? d.fps : oneOf(raw.fps, [30, 60] as const, d.fps),
    codec: oneOf(raw.codec, ['auto', 'h264', 'vp9', 'vp8'] as const, d.codec),
    videoMbps: oldDefaults ? d.videoMbps : Number.isFinite(videoMbps) ? Math.min(50, Math.max(1, videoMbps)) : d.videoMbps,
    systemAudio: bool(raw.systemAudio, d.systemAudio),
    systemAudioDevice: text(raw.systemAudioDevice, d.systemAudioDevice, 200),
    microphoneDevice: text(raw.microphoneDevice, d.microphoneDevice, 200),
    systemGain: gain(raw.systemGain, d.systemGain),
    micGain: gain(raw.micGain, d.micGain),
    separateMicTrack: bool(raw.separateMicTrack, d.separateMicTrack),
    audioOffsetMs: offsetMs(raw.audioOffsetMs, d.audioOffsetMs),
    microphone: upgrade ? true : bool(raw.microphone, d.microphone),
    displayId: text(raw.displayId, d.displayId, 100),
    detection: oneOf(raw.detection, ['games', 'always', 'manual'] as const, d.detection),
    detectFullscreen: bool(raw.detectFullscreen, d.detectFullscreen),
    customGames,
    afterGame: oneOf(raw.afterGame, ['review', 'auto', 'none'] as const, d.afterGame),
    visibility: oneOf(raw.visibility, VISIBILITIES, d.visibility),
    videoLanguage: text(raw.videoLanguage, d.videoLanguage, 10) || d.videoLanguage,
    startWithSystem: bool(raw.startWithSystem, d.startWithSystem),
    toast: bool(raw.toast, d.toast),
    clipsDir: text(raw.clipsDir, d.clipsDir, 1000),
    siteUrl,
    onboarded: bool(raw.onboarded, d.onboarded),
    brandColor: typeof raw.brandColor === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.brandColor.trim()) ? raw.brandColor.trim() : '',
    autoClips: oneOf(raw.autoClips, ['off', 'multi', 'every'] as const, d.autoClips),
    gsiToken: /^[a-z0-9]{16,64}$/i.test(String(raw.gsiToken ?? '')) ? String(raw.gsiToken) : '',
    discordWebhook: isDiscordWebhook(raw.discordWebhook) ? (raw.discordWebhook as string).trim() : '',
    performance: oneOf(raw.performance, ['low', 'balanced', 'high'] as const, d.performance),
    lastVersion: /^\d+\.\d+\.\d+$/.test(String(raw.lastVersion ?? '')) ? String(raw.lastVersion) : '',
    clipsSort: oneOf(raw.clipsSort, ['newest', 'oldest', 'longest', 'largest'] as const, d.clipsSort),
    uploadAsk: bool(raw.uploadAsk, d.uploadAsk),
    uploadHashtags: typeof raw.uploadHashtags === 'string' ? raw.uploadHashtags.slice(0, 300) : d.uploadHashtags,
    uploadCategory: oneOf(raw.uploadCategory, CATEGORY_KEYS, d.uploadCategory),
    uploadThumbnail: bool(raw.uploadThumbnail, d.uploadThumbnail),
  };
}

/** Největší soubor, který Discord vezme přes webhook bez vylepšeného serveru (10 MB). */
export const DISCORD_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Webhook Discordu: jen adresy discord.com/discordapp.com /api/webhooks/<id>/<token>. */
export function isDiscordWebhook(value: unknown): boolean {
  return typeof value === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(value.trim());
}

/** Kvůli starším částem kódu a testům: platná zkratka (viz hotkeys.ts). */
export const isAccelerator = isHotkey;

/**
 * Doporučený datový tok podle rozlišení a snímků. Řídí se tím, co dnes
 * dává Twitch/YouTube za "dobrou kvalitu"; víc nemá u klipu smysl.
 */
export function suggestedMbps(maxHeight: Settings['maxHeight'], fps: Settings['fps']): number {
  // Hry mají rychlý pohyb - na kostičky je potřeba víc než u filmu: 1080p60 ~20 Mb/s (ShadowPlay dává 50).
  const h = maxHeight === 0 ? 1080 : maxHeight;
  const base = h >= 1440 ? 20 : h >= 1080 ? 12 : 6;
  return fps === 60 ? Math.round(base * 1.65) : base;
}
