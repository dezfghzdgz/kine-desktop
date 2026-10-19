import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { constants as osConstants, setPriority } from 'node:os';
import { parseProbe, progressPercent, type ProbeResult } from './editPlan';
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
  // macOS: ffmpeg-static stáhne při instalaci jen binárku pro procesor stroje, na kterém se staví
  // (runner GitHubu = Apple Silicon), takže by Intel Mac dostal špatnou. Workflow proto přibalí
  // ffmpeg pro každou architekturu zvlášť do resources/ffmpeg (electron-builder extraResources).
  if (process.platform === 'darwin' && process.resourcesPath) {
    const bundled = join(process.resourcesPath, 'ffmpeg', 'ffmpeg');
    if (existsSync(bundled)) p = bundled;
  }
  if (process.env.KINE_FFMPEG && existsSync(process.env.KINE_FFMPEG)) p = process.env.KINE_FFMPEG;
  return p;
}

/**
 * Nižší priorita procesu (Windows: "pod normálem"): hra dostane procesor
 * první, ffmpeg dělá ve zbytku. Pro práci na pozadí, která nikoho nezdržuje
 * (krájení zásobníku, náhledy, slepení dlouhé nahrávky) - hra pak při
 * ukládání netrhá. Když to systém nedovolí, nic se neděje.
 */
export function lowerPriority(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // nevadí - poběží s normální prioritou
  }
}

/** `options.low` = nižší priorita (krájení zásobníku a jiná práce na pozadí). */
export function spawnFfmpeg(args: string[], options: { low?: boolean } = {}): ChildProcessWithoutNullStreams {
  const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
  if (options.low) lowerPriority(child);
  return child;
}

/**
 * Spustí ffmpeg a počká na konec. Při chybě hodí výjimku s koncem stderr.
 * `options.low` = nižší priorita (práce na pozadí), `options.progress` =
 * průběh v % podle očekávané délky výstupu (`totalSeconds`).
 */
export function runFfmpeg(
  args: string[],
  timeoutMs = 120000,
  options: { low?: boolean; totalSeconds?: number; progress?: (percent: number) => void } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const withProgress = !!options.progress && (options.totalSeconds ?? 0) > 0;
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...(withProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args], { windowsHide: true });
    if (options.low) lowerPriority(child);
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    if (withProgress) {
      let out = '';
      let last = -1;
      child.stdout.on('data', (d) => {
        out += d.toString();
        let idx: number;
        while ((idx = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, idx);
          out = out.slice(idx + 1);
          const percent = progressPercent(line, options.totalSeconds!);
          if (percent !== null && percent !== last) {
            last = percent;
            options.progress!(percent);
          }
        }
      });
    } else {
      // Výstup nikdo nečte - ať se roura nezahltí.
      child.stdout.resume();
    }
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

export type { ProbeResult };

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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(parseProbe(stderr));
    };
    child.on('close', finish);
    child.on('error', finish);
    const timer = setTimeout(() => child.kill(), 15000);
  });
}
