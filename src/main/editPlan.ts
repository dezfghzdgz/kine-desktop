/**
 * Čistá část úprav (bez ffmpeg, bez electronu - testuje se): skládání
 * argumentů pro sestřih několika klipů do jednoho a pro export GIFu.
 */

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

  const gameFilters = [RESAMPLE, volumeFilter(input.systemGain), shiftFilter(audioOffset), STEREO].filter((f): f is string => !!f);
  const micFilters = [RESAMPLE, volumeFilter(input.micGain), shiftFilter((input.micOffsetMs ?? 0) + audioOffset), STEREO].filter((f): f is string => !!f);

  // WebM (VP8/VP9) se zvukem hry beze změn: zvuk se jen zkopíruje (Opus zůstane Opusem).
  const copyGame = !mp4 && tracks.length === 1 && tracks[0] === 'game' && Math.abs((input.systemGain ?? 1) - 1) < 0.005 && Math.round(audioOffset) === 0;

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
    titles.forEach((title, i) => args.push(`-metadata:s:a:${i}`, `title=${title}`));
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
