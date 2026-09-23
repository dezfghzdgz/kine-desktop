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
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
    if (input.hasAudio) parts.push(`[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
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
