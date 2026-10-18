/**
 * Čistá část úprav (bez ffmpeg, bez electronu - testuje se): skládání
 * argumentů pro sestřih několika klipů do jednoho a pro export GIFu.
 */

import { cameraRect, type CameraRect } from '../shared/liveLayout';
import type { LiveCameraShape } from '../shared/types';

/** Co o vstupním klipu víme (z knihovny a z hlavičky souboru). */
export type MergeInput = {
  file: string;
  width: number | null;
  height: number | null;
  /** Má klip zvukovou stopu? Bez ní se doplní ticho, ať jde vše spojit. */
  hasAudio: boolean;
  fps: number | null;
  durationSeconds: number;
};

export type MergePlan = {
  args: string[];
  width: number;
  height: number;
  fps: number;
  totalSeconds: number;
};

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Sestřih: všechny klipy se převedou na společný rozměr (největší z nich;
 * menší dostanou černé pruhy, ne roztažení), společné fps a zvuk 48 kHz
 * stereo, a spojí filtrem concat. Překóduje se libx264 (veryfast) - klipy
 * z různých hraní mívají různé rozlišení, přímé spojení bez překódování by
 * u nich nešlo.
 */
export function mergePlan(inputs: MergeInput[], output: string): MergePlan {
  if (inputs.length < 2) throw new Error('too-few');
  const width = even(Math.max(...inputs.map((i) => i.width ?? 0), 320));
  const height = even(Math.max(...inputs.map((i) => i.height ?? 0), 180));
  const fps = Math.max(...inputs.map((i) => i.fps ?? 0)) >= 50 ? 60 : 30;
  const totalSeconds = inputs.reduce((sum, i) => sum + Math.max(0, i.durationSeconds), 0);

  const args: string[] = ['-y'];
  for (const input of inputs) args.push('-i', input.file);
  const parts: string[] = [];
  const chain: string[] = [];
  inputs.forEach((input, i) => {
    parts.push(
      `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    if (input.hasAudio) parts.push(`[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    else parts.push(`aevalsrc=0:s=48000:c=stereo:d=${Math.max(0.1, input.durationSeconds).toFixed(3)}[a${i}]`);
    chain.push(`[v${i}][a${i}]`);
  });
  parts.push(`${chain.join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  args.push(
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-progress',
    'pipe:1',
    '-nostats',
    '-loglevel',
    'error',
    output
  );
  return { args, width, height, fps, totalSeconds };
}

export type GifOptions = {
  start: number;
  end: number;
  /** Šířka výsledku v px (výška podle poměru). */
  width: number;
  fps: number;
};

/** Nejdelší GIF - delší by měl desítky MB a Discord ho nevezme. */
export const GIF_MAX_SECONDS = 15;
export const GIF_WIDTH = 480;
export const GIF_FPS = 15;

/**
 * GIF ze zvoleného úseku: dvě fáze v jednom filtru (paleta z celého úseku,
 * pak dithering), bez zvuku, smyčka. Šířka pevná, výška podle poměru.
 */
export function gifArgs(input: string, output: string, options: GifOptions): { args: string[]; lengthSeconds: number } {
  const start = Math.max(0, options.start);
  const lengthSeconds = Math.min(GIF_MAX_SECONDS, Math.max(0.2, options.end - start));
  const width = Math.max(64, Math.round(options.width));
  const fps = Math.min(30, Math.max(5, Math.round(options.fps)));
  const filter = `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const args = ['-y', '-ss', start.toFixed(3), '-t', lengthSeconds.toFixed(3), '-i', input, '-an', '-vf', filter, '-loop', '0', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output];
  return { args, lengthSeconds };
}

export type ProbeResult = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  /** Má soubor zvukovou stopu? (sestřih klipů bez zvuku doplní ticho) */
  hasAudio: boolean;
  fps: number | null;
};

/** Rozbor hlavičky, kterou ffmpeg vypíše při `-i soubor` (ffmpeg-static nemá ffprobe). */
export function parseProbe(stderr: string): ProbeResult {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const durationSeconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
  const videoLine = /Stream #\d+:\d+.*?Video:.*/.exec(stderr)?.[0] ?? '';
  const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(videoLine);
  const fps = /\b(\d+(?:\.\d+)?) fps\b/.exec(videoLine);
  return {
    durationSeconds: durationSeconds !== null && Number.isFinite(durationSeconds) ? durationSeconds : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    hasAudio: /Stream #\d+:\d+.*?Audio:/.test(stderr),
    fps: fps ? Number(fps[1]) : null,
  };
}

/** Řádek "out_time_us=1234567" (starší ffmpeg "out_time_ms" - obojí mikrosekundy) -> procenta hotovo. */
export function progressPercent(line: string, totalSeconds: number): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
  if (!m || totalSeconds <= 0) return null;
  return Math.min(99, Math.round((Number(m[1]) / 1e6 / totalSeconds) * 100));
}

// ---- na výšku 9:16 --------------------------------------------------------------------

export type VerticalMode = 'left' | 'center' | 'right' | 'blur';

/** Filtr ffmpeg pro výřez na výšku; null = bez výřezu. */
export function verticalCropFilter(anchor: VerticalMode | undefined | null): string | null {
  if (!anchor) return null;
  // Šířka 9:16 sudá (yuv420p chce sudé rozměry); když je obraz už užší, nechá se celý.
  const w = "'trunc(min(iw,ih*9/16)/2)*2'";
  if (anchor === 'blur') {
    return [
      'split[bg][fg]',
      `[bg]crop=w=${w}:h=ih:x='(iw-ow)/2':y=0,boxblur=luma_radius=24:luma_power=2:chroma_radius=12:chroma_power=1[bgb]`,
      `[fg]scale=w=${w}:h=-2[fgs]`,
      "[bgb][fgs]overlay=x='(W-w)/2':y='(H-h)/2'",
    ].join(';');
  }
  const k = anchor === 'left' ? '0' : anchor === 'right' ? '1' : '0.5';
  // ow = šířka výstupu.
  return `crop=w=${w}:h=ih:x='(iw-ow)*${k}':y=0`;
}

// ---- slepení klipu: obraz + zvuk hry + mikrofon ---------------------------------------

export type ClipMuxInput = {
  /** Seznam kousků obrazu (a zvuku hry) pro concat demuxer (ffconcat s délkami). */
  videoList: string;
  /** Má proud obrazu i zvukovou stopu (zvuk hry)? */
  hasSystemAudio: boolean;
  /** Seznam kousků mikrofonu (zvlášť nahrávaný), nebo null. */
  micList?: string | null;
  /** Kde v klipu začíná mikrofon (ms; záporné = začátek se uřízne) - z planClip. */
  micOffsetMs?: number;
  /** Hlasitost hry a mikrofonu v klipu (1 = beze změny). */
  systemGain?: number;
  micGain?: number;
  /** Posun celého zvuku vůči obrazu v ms (kladné = zvuk později) - kalibrace hráčem. */
  audioOffsetMs?: number;
  /**
   * O kolik je zvuk hry v proudu obrazu pozadu (ms) - když jde přímo z
   * Windows přes pomocníka (Web Audio s náskokem). V klipu se o tolik
   * posune dopředu; mikrofon má vlastní proud a tohle se ho netýká.
   */
  systemLatencyMs?: number;
  /** Kromě smíchané stopy i samostatné stopy: jen hra, jen mikrofon (pro střih). */
  separateTracks?: boolean;
  container: 'mp4' | 'webm';
  output: string;
  /** Délka obrazu v sekundách - zvuk se na ni ořízne. */
  durationSeconds: number;
};

/** Stopy zvuku v hotovém klipu, v pořadí (první hraje přehrávač i Kine). */
export type AudioTrackKind = 'mix' | 'game' | 'mic';

/** Posun zvukové stopy: kladný = zpozdit (ticho na začátek), záporný = uříznout začátek. */
function shiftFilter(ms: number): string | null {
  const rounded = Math.round(ms);
  if (rounded === 0) return null;
  if (rounded > 0) return `adelay=delays=${rounded}:all=1`;
  return `atrim=start=${(-rounded / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
}

function volumeFilter(gain: number | undefined): string | null {
  const g = Number.isFinite(gain) ? Math.max(0, Math.min(2, Number(gain))) : 1;
  return Math.abs(g - 1) < 0.005 ? null : `volume=${g.toFixed(2)}`;
}

/**
 * Srovnání zvuku podle časových značek: mezery (mezi generacemi, výpadky)
 * se doplní tichem a překryvy uříznou, jakmile přesáhnou 10 ms - jinak by
 * se zvuk po každém kousku posunul o pár milisekund a na konci dlouhého
 * záznamu by "ujížděl".
 */
const RESAMPLE = 'aresample=async=1:min_hard_comp=0.010:first_pts=0';
const STEREO = 'aformat=sample_fmts=fltp:channel_layouts=stereo';

/** Které stopy klip bude mít (podle toho, co se nahrálo a jak je nastaveno). */
export function clipAudioTracks(hasSystemAudio: boolean, hasMic: boolean, separate: boolean): AudioTrackKind[] {
  if (hasSystemAudio && hasMic) return separate ? ['mix', 'game', 'mic'] : ['mix'];
  if (hasSystemAudio) return ['game'];
  if (hasMic) return ['mic'];
  return [];
}

/**
 * Argumenty ffmpeg pro klip: obraz se jen kopíruje (žádné překódování), zvuk
 * se smíchá až tady - hra z proudu obrazu, mikrofon ze svého proudu, každý
 * se svou hlasitostí, mikrofon na místě podle planClip. Součet hlídá
 * limiter, ať hlasitá hra s hlasem nepřebudí. Se `separateTracks` má soubor
 * tři stopy: 1) hra + mikrofon (hraje každý přehrávač i Kine), 2) jen hra,
 * 3) jen mikrofon - v úpravách pak jde klip uložit třeba bez hlasu.
 */
export function clipMuxArgs(input: ClipMuxInput): string[] {
  const mp4 = input.container === 'mp4';
  const args = ['-loglevel', 'error', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', input.videoList];
  const mic = !!input.micList;
  if (mic) args.push('-f', 'concat', '-safe', '0', '-i', input.micList!);

  const audioOffset = input.audioOffsetMs ?? 0;
  const tracks = clipAudioTracks(input.hasSystemAudio, mic, !!input.separateTracks);
  const chains: string[] = [];
  const maps: string[] = ['-map', '0:v:0'];
  const titles: string[] = [];

  const gameShift = audioOffset - Math.max(0, input.systemLatencyMs ?? 0);
  const gameFilters = [RESAMPLE, volumeFilter(input.systemGain), shiftFilter(gameShift), STEREO].filter((f): f is string => !!f);
  const micFilters = [RESAMPLE, volumeFilter(input.micGain), shiftFilter((input.micOffsetMs ?? 0) + audioOffset), STEREO].filter((f): f is string => !!f);

  // WebM (VP8/VP9) se zvukem hry beze změn: zvuk se jen zkopíruje (Opus zůstane Opusem).
  const copyGame = !mp4 && tracks.length === 1 && tracks[0] === 'game' && Math.abs((input.systemGain ?? 1) - 1) < 0.005 && Math.round(gameShift) === 0;

  if (tracks.length === 3) {
    chains.push(`[0:a]${gameFilters.join(',')},asplit=2[g1][g2]`);
    chains.push(`[1:a]${micFilters.join(',')},asplit=2[m1][m2]`);
    chains.push('[g1][m1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:attack=5:release=50:level=false:latency=1[mix]');
    maps.push('-map', '[mix]', '-map', '[g2]', '-map', '[m2]');
    titles.push('Game + mic', 'Game', 'Mic');
  } else if (tracks[0] === 'mix') {
    chains.push(`[0:a]${gameFilters.join(',')}[g1]`);
    chains.push(`[1:a]${micFilters.join(',')}[m1]`);
    chains.push('[g1][m1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:attack=5:release=50:level=false:latency=1[mix]');
    maps.push('-map', '[mix]');
    titles.push('Game + mic');
  } else if (tracks[0] === 'game') {
    if (copyGame) maps.push('-map', '0:a:0');
    else {
      chains.push(`[0:a]${gameFilters.join(',')}[g1]`);
      maps.push('-map', '[g1]');
    }
    titles.push('Game');
  } else if (tracks[0] === 'mic') {
    chains.push(`[1:a]${micFilters.join(',')}[m1]`);
    maps.push('-map', '[m1]');
    titles.push('Mic');
  }

  if (chains.length > 0) args.push('-filter_complex', chains.join(';'));
  args.push(...maps, '-c:v', 'copy');
  if (tracks.length > 0) {
    if (copyGame) args.push('-c:a', 'copy');
    // AAC 192k: zvuk už jednou prošel Opusem v nahrávání - vyšší datový tok, ať druhé kódování není slyšet.
    else args.push('-c:a', mp4 ? 'aac' : 'libopus', '-b:a', mp4 ? '192k' : '128k');
    // Název stopy: title (VLC a spol.) i handler_name - podle něj ji jmenuje Chromium (přehrávač v appce, nabídka ⋮ Audio Tracks).
    titles.forEach((title, i) => args.push(`-metadata:s:a:${i}`, `title=${title}`, `-metadata:s:a:${i}`, `handler_name=${title}`));
    // Jen první stopa je výchozí - přehrávače bez výběru stop hrají ji.
    if (titles.length > 1) titles.forEach((_, i) => args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0'));
  }
  // Zvuk může být delší než obraz - uříznout na délku obrazu.
  args.push('-t', (input.durationSeconds + 0.05).toFixed(3));
  if (mp4) args.push('-movflags', '+faststart');
  args.push(input.output);
  return args;
}

/** Zvuk při úpravě klipu: všechno jako v originále, jen hra, jen mikrofon, nebo nic. */
export type AudioChoice = 'mix' | 'game' | 'mic' | 'none';

/**
 * Které zvukové stopy vzít při úpravě klipu a jaké stopy bude mít výsledek.
 * `layout` = stopy zdroje (u starších klipů neznámé -> jedna stopa).
 * 'mix' nechá všechny stopy (i samostatné hra / mikrofon), 'game' / 'mic'
 * vezme jen tu jednu - když ve zdroji není, použije se první stopa.
 */
export function trimAudioPlan(layout: AudioTrackKind[] | undefined, choice: AudioChoice | undefined): { maps: string[]; tracks: AudioTrackKind[] | null } {
  if (choice === 'none') return { maps: [], tracks: [] };
  const known = layout && layout.length > 0 ? layout : null;
  if (!choice || choice === 'mix' || !known) return { maps: ['-map', '0:a?'], tracks: known };
  const idx = known.indexOf(choice);
  if (idx < 0) return { maps: ['-map', '0:a:0?'], tracks: known.slice(0, 1) };
  return { maps: ['-map', `0:a:${idx}`], tracks: [choice] };
}

// ---- zkrácení klipu: rychlost, text, výřez, zvuk -----------------------------------------

/** Rychlosti v úpravách (zpomalení i zrychlení); 1 = beze změny. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Rychlost z okna na jednu z povolených (nesmysl = 1). */
export function normalizeSpeed(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  let best: number = 1;
  for (const s of SPEEDS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

/** atempo zvládne 0,5-100; pomalejší by se muselo řetězit - tady stačí jeden článek. */
export function atempoChain(speed: number): string | null {
  if (Math.abs(speed - 1) < 0.001) return null;
  const parts: string[] = [];
  let rest = speed;
  while (rest < 0.5) {
    parts.push('atempo=0.5');
    rest /= 0.5;
  }
  parts.push(`atempo=${Number(rest.toFixed(4))}`);
  return parts.join(',');
}

export type TextPosition = 'top' | 'center' | 'bottom';

/** Kde leží obrázek s textem (PNG ze stránky) ve výsledném snímku: vodorovně uprostřed, svisle podle volby. */
export function textOverlayPosition(position: TextPosition): string {
  const y = position === 'top' ? 'H*0.07' : position === 'center' ? '(H-h)/2' : 'H-h-H*0.08';
  return `x='(W-w)/2':y='${y}'`;
}

// ---- překryvy: text, obrázek, GIF kdekoli v obraze ---------------------------------------

/**
 * Jeden překryv přes video. Poloha a velikost jsou zlomky výsledného obrazu
 * (0-1), ať sedí stejně v náhledu v okně i ve výsledku: `cx`, `cy` = střed,
 * `w` = šířka (výška podle poměru stran souboru). `from` / `to` = od kdy do
 * kdy je vidět (sekundy výsledku; chybí = celou dobu). Text přijde z okna už
 * nakreslený jako PNG (soubor), takže pro ffmpeg je to obrázek.
 */
export type OverlayItem = {
  kind: 'image' | 'gif';
  file: string;
  cx: number;
  cy: number;
  w: number;
  from?: number | null;
  to?: number | null;
};

/** Nejvíc překryvů na jeden klip - každý je další vstup ffmpeg a filtr navíc. */
export const OVERLAY_MAX = 8;

const clamp01 = (n: unknown, fallback: number) => (Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : fallback);

/** Očistí překryvy z okna: zlomky do 0-1, šířka aspoň 2 %, časy jen rozumné, nejvýš OVERLAY_MAX. */
export function normalizeOverlays(items: unknown): OverlayItem[] {
  if (!Array.isArray(items)) return [];
  const out: OverlayItem[] = [];
  for (const raw of items) {
    const o = raw as Partial<OverlayItem> | null;
    if (!o || typeof o.file !== 'string' || !o.file) continue;
    const kind = o.kind === 'gif' ? 'gif' : 'image';
    const from = Number.isFinite(Number(o.from)) && Number(o.from) > 0 ? Number(o.from) : null;
    const to = Number.isFinite(Number(o.to)) && Number(o.to) > 0 ? Number(o.to) : null;
    out.push({ kind, file: o.file, cx: clamp01(o.cx, 0.5), cy: clamp01(o.cy, 0.5), w: Math.max(0.02, clamp01(o.w, 0.3)), from, to: to !== null && from !== null && to <= from ? null : to });
    if (out.length >= OVERLAY_MAX) break;
  }
  return out;
}

/** Vstupní volby ffmpeg pro soubor překryvu: obrázek se opakuje donekonečna, GIF ve smyčce. */
export function overlayInputArgs(item: OverlayItem): string[] {
  return item.kind === 'gif' ? ['-stream_loop', '-1', '-i', item.file] : ['-loop', '1', '-i', item.file];
}

/** Šířka překryvu v pixelech výsledku (sudá kvůli yuv420p, aspoň 2). */
export function overlayPixelWidth(item: OverlayItem, frameWidth: number): number {
  return Math.max(2, Math.round((frameWidth * item.w) / 2) * 2);
}

/**
 * Filtr pro jeden překryv: zmenšit na šířku `w` výsledku (výška podle poměru,
 * sudá kvůli yuv420p) a položit středem na (cx, cy); `enable` ho ukáže jen
 * v daném čase. `shortest=1`: překryvy jsou nekonečné (smyčka), výsledek
 * končí s videem. `frameWidth` = šířka výsledného obrazu (po výřezu na výšku).
 */
export function overlayFilter(item: OverlayItem, inputIndex: number, inLabel: string, outLabel: string, tag: string, frameWidth: number): string {
  const px = overlayPixelWidth(item, frameWidth);
  const parts = [`[${inputIndex}:v]format=rgba,scale=w=${px}:h=-2[${tag}s]`];
  const from = item.from ?? null;
  const to = item.to ?? null;
  const enable = from !== null ? (to !== null ? `:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'` : `:enable='gte(t,${from.toFixed(3)})'`) : to !== null ? `:enable='lte(t,${to.toFixed(3)})'` : '';
  parts.push(`${inLabel}[${tag}s]overlay=x='W*${item.cx.toFixed(4)}-w/2':y='H*${item.cy.toFixed(4)}-h/2':shortest=1:format=auto${enable}${outLabel}`);
  return parts.join(';');
}

export type TrimPlanOptions = {
  /** Sekundy od začátku původního klipu. */
  start: number;
  end: number;
  mute: boolean;
  /** Datový tok obrazu (Mb/s) pro WebM - stejný jako při nahrávání. */
  videoMbps: number;
  vertical?: VerticalMode;
  audio?: AudioChoice;
  audioTracks?: AudioTrackKind[];
  /** Rychlost (0,5 = zpomalení na polovinu, 2 = dvakrát rychleji). */
  speed?: number;
  /** Snímková frekvence zdroje - po změně rychlosti se na ni výsledek srovná (neznámá = 60). */
  sourceFps?: number | null;
  /** Text přes video (starší okno): PNG s průhledností (nakreslený ve stránce) a kde má ležet. */
  overlay?: { file: string; position: TextPosition } | null;
  /** Překryvy kdekoli v obraze: text jako PNG, obrázky, GIFy (normalizeOverlays). */
  overlays?: OverlayItem[] | null;
  /** Šířka zdrojového obrazu (px) - pro velikost překryvů; bez ní se bere 1920. */
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  /** Kamera nahraná zvlášť (Clip.camera) - zapeče se do obrazu podle polohy a velikosti. */
  camera?: CameraBake | null;
  /** Jen první (smíchaná) zvuková stopa - kopie k nahrání na Kine z klipu se samostatnými stopami. */
  firstAudioOnly?: boolean;
  webm: boolean;
};

/**
 * Kamera zvlášť ke klipu (Clip.camera): soubor s obrazem kamery, kde v klipu
 * začíná (offsetMs, jako u mikrofonu) a jak leží v obraze - levý horní roh
 * (x, y) a šířka (w) jako podíly výsledného obrazu, tvar a zrcadlení.
 */
export type CameraBake = {
  file: string;
  offsetMs: number;
  x: number;
  y: number;
  w: number;
  shape: LiveCameraShape;
  mirror: boolean;
  /** Rozměr obrazu kamery (px), když je známý - jinak se počítá 16:9. */
  width?: number | null;
  height?: number | null;
};

/** Kde a jak velká je kamera ve výsledném obrazu (px) - stejná funkce jako pro živé vysílání a pro přehrávač. */
export function cameraBakeRect(cam: CameraBake, frameW: number, frameH: number): CameraRect {
  return cameraRect(frameW, frameH, cam.width ?? 1280, cam.height ?? 720, { position: 'bottom-right', size: 'medium', shape: cam.shape, width: cam.w, x: cam.x, y: cam.y });
}

/**
 * Průhlednost pro kruh / zaoblené rohy: vzdálenost od "vnitřního obdélníku"
 * (obdélník zmenšený o poloměr) - uvnitř 255, za poloměrem 0, na hraně
 * měkký přechod 1 px. Kruh je zaoblení s poloměrem = polovina šířky.
 */
export function roundedAlphaExpr(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  const cx = ((width - 1) / 2).toFixed(2);
  const cy = ((height - 1) / 2).toFixed(2);
  const ix = (width / 2 - r).toFixed(2);
  const iy = (height / 2 - r).toFixed(2);
  // Čárky jsou uvnitř uvozovek (geq=lum='...'), takže je parser filtrů nebere jako oddělovač.
  return `255*clip(${(r + 0.5).toFixed(2)}-hypot(max(abs(X-${cx})-${ix},0),max(abs(Y-${cy})-${iy},0)),0,1)`;
}

/**
 * Filtry kamery: čas (kde v klipu začíná, posun o začátek výběru, rychlost),
 * zrcadlo, výřez (kruh bere čtverec ze středu), velikost a tvar. Vrací řetězec
 * do filter_complex, který z `[N:v]` udělá `[outLabel]` připravený pro overlay.
 * Tvar se dělá maskou z jednoho snímku (color + geq) opakovanou do nekonečna
 * (loop), ať se výraz počítá jen jednou a ne pro každý snímek kamery.
 */
export function cameraChain(cam: CameraBake, inputIndex: number, outLabel: string, frameW: number, frameH: number, startSeconds = 0, speed = 1): { filter: string; rect: CameraRect } {
  const rect = cameraBakeRect(cam, frameW, frameH);
  const k = normalizeSpeed(speed);
  const shift = (Number.isFinite(cam.offsetMs) ? cam.offsetMs : 0) / 1000 - Math.max(0, startSeconds);
  const time: string[] = [];
  if (shift < 0) time.push(`trim=start=${(-shift).toFixed(3)}`, `setpts=(PTS-STARTPTS)/${k}`);
  else time.push(`setpts=(PTS-STARTPTS+${shift.toFixed(3)}/TB)/${k}`);
  const steps = [...time];
  if (cam.mirror) steps.push('hflip');
  if (rect.sx > 0 || rect.sy > 0) steps.push(`crop=${Math.round(rect.sw)}:${Math.round(rect.sh)}:${Math.round(rect.sx)}:${Math.round(rect.sy)}`);
  const w = Math.max(2, Math.round(rect.w));
  const hgt = Math.max(2, Math.round(rect.h));
  steps.push(`scale=${w}:${hgt}`, 'format=rgba');
  const tag = outLabel.replace(/[\[\]]/g, '');
  if (rect.radius > 0) {
    const alpha = roundedAlphaExpr(w, hgt, rect.radius);
    const filter = [
      `[${inputIndex}:v]${steps.join(',')}[${tag}raw]`,
      `color=c=black:s=${w}x${hgt}:r=1:d=1,format=gray,geq=lum='${alpha}',loop=loop=-1:size=1:start=0[${tag}mask]`,
      `[${tag}raw][${tag}mask]alphamerge${outLabel}`,
    ].join(';');
    return { filter, rect };
  }
  return { filter: `[${inputIndex}:v]${steps.join(',')}${outLabel}`, rect };
}

/** Položení kamery na obraz: před jejím začátkem a po konci jde obraz dál beze změny. */
export function cameraOverlayFilter(inLabel: string, camLabel: string, outLabel: string, rect: CameraRect): string {
  return `${inLabel}${camLabel}overlay=x=${Math.round(rect.x)}:y=${Math.round(rect.y)}:eof_action=pass:format=auto${outLabel}`;
}

export type TrimPlan = {
  args: string[];
  /** Délka výsledku (s) - po změně rychlosti jiná než výběr. */
  outputSeconds: number;
  tracks: AudioTrackKind[] | null;
};

/**
 * Argumenty ffmpeg pro zkrácení klipu. Řez je přesný na snímek (obraz se
 * překóduje). Výřez na výšku, text a rychlost jdou jedním filtrem; délka
 * se omezuje už při čtení (-t před -i), takže sedí i po zpomalení.
 */
export function trimArgs(input: string, output: string, o: TrimPlanOptions): TrimPlan {
  const start = Math.max(0, o.start);
  const length = Math.max(0.2, o.end - start);
  const speed = normalizeSpeed(o.speed ?? 1);
  const outputSeconds = length / speed;
  const args = ['-y', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', input];
  const overlays = o.overlays ?? [];
  const camera = o.camera ?? null;
  if (o.overlay) args.push('-i', o.overlay.file);
  for (const item of overlays) args.push(...overlayInputArgs(item));
  if (camera) args.push('-i', camera.file);
  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error');

  // Obraz: [výřez] -> [rychlost] -> [text] -> [překryvy]. Bez nich stačí jednoduchý filtr.
  const crop = verticalCropFilter(o.vertical);
  const speedFilters: string[] = [];
  if (speed !== 1) {
    // Po setpts neví kodér snímkovou frekvenci (a vzal by 25 fps, zpomalení by ztrácelo snímky) - srovná se na frekvenci zdroje.
    speedFilters.push(`setpts=(PTS-STARTPTS)/${speed}`, `fps=${Math.min(120, Math.max(1, Math.round(o.sourceFps ?? 60)))}`);
  }
  if (o.overlay || overlays.length > 0 || camera) {
    const chains: string[] = [];
    let label = '[0:v:0]';
    if (crop) {
      chains.push(`${label}${crop}[vc]`);
      label = '[vc]';
    }
    if (speedFilters.length) {
      chains.push(`${label}${speedFilters.join(',')}[vs]`);
      label = '[vs]';
    }
    let inputIndex = 1;
    if (o.overlay) {
      const next = overlays.length > 0 || camera ? '[vt]' : '[vout]';
      chains.push(`${label}[${inputIndex}:v]overlay=${textOverlayPosition(o.overlay.position)}${next}`);
      label = next;
      inputIndex += 1;
    }
    // Šířka výsledného obrazu (po výřezu na výšku) - podle ní se překryvy zmenší.
    const srcW = o.sourceWidth && o.sourceWidth > 0 ? o.sourceWidth : 1920;
    const srcH = o.sourceHeight && o.sourceHeight > 0 ? o.sourceHeight : 1080;
    const frameWidth = o.vertical ? Math.max(2, Math.floor(Math.min(srcW, (srcH * 9) / 16) / 2) * 2) : srcW;
    overlays.forEach((item, i) => {
      const next = i === overlays.length - 1 && !camera ? '[vout]' : `[vo${i}]`;
      chains.push(overlayFilter(item, inputIndex + i, label, next, `o${i}`, frameWidth));
      label = next;
    });
    if (camera) {
      // Kamera zvlášť až navrch (nad překryvy), podle polohy v hotovém obraze; čas se posune o začátek výběru a rychlost.
      const cam = cameraChain(camera, inputIndex + overlays.length, '[cam]', frameWidth, srcH, start, speed);
      chains.push(cam.filter, cameraOverlayFilter(label, '[cam]', '[vout]', cam.rect));
      label = '[vout]';
    }
    args.push('-filter_complex', chains.join(';'), '-map', '[vout]');
  } else {
    const vf = [crop, ...speedFilters].filter((f): f is string => !!f);
    if (vf.length) args.push('-vf', vf.join(','));
    args.push('-map', '0:v:0');
  }
  if (o.webm) {
    args.push('-c:v', 'libvpx', '-b:v', `${Math.max(1, Math.round(o.videoMbps))}M`, '-deadline', 'realtime', '-cpu-used', '8');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  }
  // Zvuk podle volby (všechny stopy / jen hra / jen mikrofon / nic); rychlost přes atempo (výška hlasu zůstane).
  const audio = o.firstAudioOnly && !o.mute ? { maps: ['-map', '0:a:0?'], tracks: (o.audioTracks ?? []).slice(0, 1) } : trimAudioPlan(o.audioTracks, o.mute ? 'none' : o.audio);
  args.push(...audio.maps);
  if (audio.maps.length === 0) args.push('-an');
  else {
    const tempo = atempoChain(speed);
    if (tempo) args.push('-af', tempo);
    args.push('-c:a', o.webm ? 'libopus' : 'aac', '-b:a', o.webm ? '128k' : '192k');
  }
  // Překryvy (a maska kamery) jsou nekonečné vstupy (smyčka) - výsledek se pro jistotu usekne na délku videa.
  if (overlays.length > 0 || camera) args.push('-t', (outputSeconds + 0.05).toFixed(3));
  args.push(output);
  return { args, outputSeconds, tracks: audio.tracks };
}

/** Značky nahrávky po zkrácení: jen ty uvnitř výběru, posunuté na nový začátek (a přepočtené rychlostí). */
export function shiftMarkers(markers: { time: number; label: string }[] | undefined, start: number, end: number, speed = 1): { time: number; label: string }[] | undefined {
  if (!markers || markers.length === 0) return undefined;
  const s = normalizeSpeed(speed);
  const out = markers
    .filter((m) => m.time >= start && m.time <= end)
    .map((m) => ({ time: Math.round(((m.time - start) / s) * 10) / 10, label: m.label }));
  return out.length > 0 ? out : undefined;
}
