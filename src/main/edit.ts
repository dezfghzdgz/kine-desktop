import { statSync } from 'node:fs';
import { spawnFfmpeg, probe, runFfmpeg } from './ffmpeg';
import { GIF_FPS, GIF_WIDTH, gifArgs, mergePlan, progressPercent, verticalCropFilter, type MergeInput } from './editPlan';
import { log } from './log';

/**
 * Lehké úpravy klipu: zkrácení (začátek/konec), ztlumení zvuku, výřez na
 * výšku, sestřih několika klipů do jednoho a GIF z úseku.
 *
 * Řez je přesný na snímek, takže se obraz překóduje (libx264, rychlý
 * preset) - u minutového klipu to na běžném procesoru trvá pár sekund.
 * Průběh se hlásí z `-progress pipe:1` (out_time), ať okno může ukázat
 * procenta. WebM klipy (VP9/VP8) se překódují libvpx v rychlém režimu.
 */
export type TrimOptions = {
  /** Sekundy od začátku původního klipu. */
  start: number;
  end: number;
  /** Bez zvuku. */
  mute: boolean;
  /** Datový tok obrazu (Mb/s) - stejný jako při nahrávání. */
  videoMbps: number;
  /**
   * Na výšku 9:16 (TikTok, Shorts, Reels): z obrazu se vezme pruh o šířce
   * výška·9/16 - vlevo, uprostřed, nebo vpravo. Výška zůstává. 'blur' =
   * celý obraz zmenšený doprostřed a nad ním i pod ním rozmazané pozadí
   * z téhož snímku (nic se neořízne).
   */
  vertical?: 'left' | 'center' | 'right' | 'blur';
};

export type TrimResult = { file: string; durationSeconds: number; sizeBytes: number; width: number | null; height: number | null };

/**
 * Spustí ffmpeg s `-progress pipe:1` a hlásí procenta podle out_time
 * vůči očekávané délce výstupu. Při chybě hodí poslední řádek stderr.
 */
function runWithProgress(args: string[], totalSeconds: number, what: string, onProgress?: (percent: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFfmpeg(args);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      let idx: number;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx);
        stdout = stdout.slice(idx + 1);
        const percent = progressPercent(line, totalSeconds);
        if (percent !== null && onProgress) onProgress(percent);
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ffmpeg se zasekl'));
    }, 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        log(`${what} skončil s kódem ${code}: ${stderr.slice(-800)}`);
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg ${code}`));
      }
    });
  });
}

async function describe(output: string, fallbackSeconds: number): Promise<TrimResult> {
  const info = await probe(output);
  return {
    file: output,
    durationSeconds: info.durationSeconds ?? fallbackSeconds,
    sizeBytes: statSync(output).size,
    width: info.width,
    height: info.height,
  };
}

export async function trimClip(input: string, output: string, options: TrimOptions, onProgress?: (percent: number) => void): Promise<TrimResult> {
  const start = Math.max(0, options.start);
  const length = Math.max(0.2, options.end - start);
  const isWebm = /\.webm$/i.test(output);
  const args = ['-y', '-ss', start.toFixed(3), '-i', input, '-t', length.toFixed(3), '-progress', 'pipe:1', '-nostats', '-loglevel', 'error'];
  const crop = verticalCropFilter(options.vertical);
  if (crop) args.push('-vf', crop);
  if (isWebm) {
    args.push('-c:v', 'libvpx', '-b:v', `${Math.max(1, Math.round(options.videoMbps))}M`, '-deadline', 'realtime', '-cpu-used', '8');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  }
  if (options.mute) args.push('-an');
  else args.push('-c:a', isWebm ? 'libopus' : 'aac', '-b:a', '160k');
  args.push(output);

  await runWithProgress(args, length, 'zkrácení klipu', onProgress);
  const result = await describe(output, length);
  onProgress?.(100);
  return result;
}

/**
 * Sestřih: několik klipů za sebou do jednoho souboru (mp4). Rozměry
 * a zvuk se srovnají podle editPlan.mergePlan, takže jde spojit i klipy
 * z různých her a rozlišení nebo klip bez zvuku s klipem se zvukem.
 */
export async function mergeClips(inputs: { file: string; durationSeconds: number }[], output: string, onProgress?: (percent: number) => void): Promise<TrimResult> {
  const described: MergeInput[] = [];
  for (const input of inputs) {
    const info = await probe(input.file);
    described.push({
      file: input.file,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      fps: info.fps,
      durationSeconds: info.durationSeconds ?? input.durationSeconds,
    });
  }
  const plan = mergePlan(described, output);
  await runWithProgress(plan.args, plan.totalSeconds, 'sestřih klipů', onProgress);
  const result = await describe(output, plan.totalSeconds);
  onProgress?.(100);
  return result;
}

/** GIF z úseku klipu (bez zvuku, 480 px, 15 fps, smyčka). Vrací velikost souboru. */
export async function makeGif(input: string, output: string, range: { start: number; end: number }, onProgress?: (percent: number) => void): Promise<{ file: string; sizeBytes: number; lengthSeconds: number }> {
  const { args, lengthSeconds } = gifArgs(input, output, { start: range.start, end: range.end, width: GIF_WIDTH, fps: GIF_FPS });
  await runWithProgress(args, lengthSeconds, 'GIF', onProgress);
  onProgress?.(100);
  return { file: output, sizeBytes: statSync(output).size, lengthSeconds };
}

/** Náhled k upravenému klipu: první snímek, nebo snímek v čase `atSeconds` (hráč si ho vybral v přehrávači). */
export async function makeThumbnail(video: string, thumb: string, atSeconds = 0): Promise<boolean> {
  try {
    const seek = atSeconds > 0 ? ['-ss', atSeconds.toFixed(3)] : [];
    await runFfmpeg(['-loglevel', 'error', ...seek, '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], 30000);
    return true;
  } catch {
    return false;
  }
}
