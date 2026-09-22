import { LANGS, type Settings } from './types';
import { isHotkey } from './hotkeys';

/**
 * Výchozí nastavení a jeho očištění po načtení ze souboru.
 *
 * Soubor nastavení edituje i člověk (a starší verze appky), takže se
 * nevěří ničemu: každá hodnota se zkontroluje a co nesedí, nahradí
 * výchozí. Díky tomu appka po chybě v souboru nespadne, jen se vrátí
 * k rozumným hodnotám.
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 2,
  lang: 'en',
  appMode: 'clipper',
  appModeChosen: false,
  clipHotkey: 'F8',
  toggleHotkey: 'Ctrl+F9',
  clipSeconds: 30,
  maxHeight: 1080,
  fps: 30,
  codec: 'auto',
  videoMbps: 8,
  systemAudio: true,
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
};

export const CLIP_SECONDS_OPTIONS = [15, 30, 60, 90, 120] as const;
export const CLIP_SECONDS_MIN = 5;
export const CLIP_SECONDS_MAX = 300;

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
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
  const upgrade = raw.version !== 2;

  return {
    version: 2,
    lang: oneOf(raw.lang, LANGS, d.lang),
    appMode: oneOf(raw.appMode, ['clipper', 'full'] as const, d.appMode),
    appModeChosen: upgrade ? false : bool(raw.appModeChosen, d.appModeChosen),
    clipHotkey: isHotkey(raw.clipHotkey) ? (raw.clipHotkey as string) : d.clipHotkey,
    toggleHotkey: isHotkey(raw.toggleHotkey) ? (raw.toggleHotkey as string) : d.toggleHotkey,
    clipSeconds: Number.isFinite(clipSeconds)
      ? Math.min(CLIP_SECONDS_MAX, Math.max(CLIP_SECONDS_MIN, Math.round(clipSeconds)))
      : d.clipSeconds,
    maxHeight: oneOf(raw.maxHeight, [0, 720, 1080, 1440] as const, d.maxHeight),
    fps: oneOf(raw.fps, [30, 60] as const, d.fps),
    codec: oneOf(raw.codec, ['auto', 'h264', 'vp9', 'vp8'] as const, d.codec),
    videoMbps: Number.isFinite(videoMbps) ? Math.min(50, Math.max(1, videoMbps)) : d.videoMbps,
    systemAudio: bool(raw.systemAudio, d.systemAudio),
    microphone: upgrade ? true : bool(raw.microphone, d.microphone),
    displayId: text(raw.displayId, d.displayId, 100),
    detection: oneOf(raw.detection, ['games', 'always', 'manual'] as const, d.detection),
    detectFullscreen: bool(raw.detectFullscreen, d.detectFullscreen),
    customGames,
    afterGame: oneOf(raw.afterGame, ['review', 'auto', 'none'] as const, d.afterGame),
    visibility: oneOf(raw.visibility, ['public', 'private'] as const, d.visibility),
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
  };
}

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
  const h = maxHeight === 0 ? 1080 : maxHeight;
  const base = h >= 1440 ? 16 : h >= 1080 ? 8 : 5;
  return fps === 60 ? Math.round(base * 1.5) : base;
}
