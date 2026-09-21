import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { log } from './log';

/**
 * Přibalený ffmpeg (balíček ffmpeg-static). V zabalené appce leží mimo
 * archiv asar (electron-builder: asarUnpack), protože z archivu se
 * spustit nedá - proto to nahrazení cesty.
 */
export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let p: string = require('ffmpeg-static');
  if (p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  if (process.env.KINE_FFMPEG && existsSync(process.env.KINE_FFMPEG)) p = process.env.KINE_FFMPEG;
  return p;
}

export function spawnFfmpeg(args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
  return child;
}

/** Spustí ffmpeg a počká na konec. Při chybě hodí výjimku s koncem stderr. */
export function runFfmpeg(args: string[], timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ffmpeg se zasekl'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else {
        log(`ffmpeg ${args.join(' ')} skončil s kódem ${code}: ${stderr.slice(-800)}`);
        reject(new Error(`ffmpeg skončil s kódem ${code}`));
      }
    });
  });
}

export type ProbeResult = { durationSeconds: number | null; width: number | null; height: number | null };

/**
 * Délka a rozměry ze souboru. ffmpeg-static nemá ffprobe, tak se čte
 * hlavička, kterou ffmpeg vypíše při `-i soubor` (končí chybou "At least
 * one output file must be specified" - to je tu v pořádku).
 */
export function probe(file: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const finish = () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const durationSeconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null;
      const video = /Stream #\d+:\d+.*?Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
      resolve({
        durationSeconds: durationSeconds !== null && Number.isFinite(durationSeconds) ? durationSeconds : null,
        width: video ? Number(video[1]) : null,
        height: video ? Number(video[2]) : null,
      });
    };
    child.on('close', finish);
    child.on('error', finish);
    setTimeout(() => child.kill(), 15000);
  });
}
