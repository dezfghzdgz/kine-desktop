import { statSync } from 'node:fs';
import { spawnFfmpeg, probe, runFfmpeg } from './ffmpeg';
import { log } from './log';

/**
 * Lehké úpravy klipu: zkrácení (začátek/konec) a ztlumení zvuku.
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
   * Výřez na výšku 9:16 (TikTok, Shorts, Reels): z obrazu se vezme pruh
   * o šířce výška·9/16 - vlevo, uprostřed, nebo vpravo. Výška zůstává.
   */
  vertical?: 'left' | 'center' | 'right';
};

/** Filtr ffmpeg pro výřez na výšku; null = bez výřezu. */
export function verticalCropFilter(anchor: TrimOptions['vertical']): string | null {
  if (!anchor) return null;
  const k = anchor === 'left' ? '0' : anchor === 'right' ? '1' : '0.5';
  // ow = šířka výstupu; když je obraz už užší než 9:16, nechá se celý.
  return `crop=w='min(iw,ih*9/16)':h=ih:x='(iw-ow)*${k}':y=0`;
}

export type TrimResult = { file: string; durationSeconds: number; sizeBytes: number; width: number | null; height: number | null };

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

  await new Promise<void>((resolve, reject) => {
    const child = spawnFfmpeg(args);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      // Řádky "out_time_us=1234567" (starší ffmpeg "out_time_ms" - obojí jsou mikrosekundy).
      let idx: number;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && onProgress) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / length) * 100)));
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
        log(`zkrácení klipu skončilo s kódem ${code}: ${stderr.slice(-800)}`);
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg ${code}`));
      }
    });
  });

  const info = await probe(output);
  onProgress?.(100);
  return {
    file: output,
    durationSeconds: info.durationSeconds ?? length,
    sizeBytes: statSync(output).size,
    width: info.width,
    height: info.height,
  };
}

/** Náhled (první snímek) k upravenému klipu. */
export async function makeThumbnail(video: string, thumb: string): Promise<boolean> {
  try {
    await runFfmpeg(['-loglevel', 'error', '-i', video, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], 30000);
    return true;
  } catch {
    return false;
  }
}
