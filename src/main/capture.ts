import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BrowserWindow, app } from 'electron';
import type { CaptureCommand, CaptureEvent, CaptureState, Settings } from '../shared/types';
import { clipFileBase } from '../shared/clipNaming';
import { log } from './log';
import { probe, runFfmpeg, spawnFfmpeg } from './ffmpeg';
import { concatList, expired, parseSegmentCsv, sameResolutionTailStart, selectForClip, toSegment, totalSeconds, type Segment } from './segments';

/**
 * Zásobník posledních sekund obrazu.
 *
 * JAK TO FUNGUJE
 *
 * Skrytá stránka (renderer/capture.ts) snímá obrazovku přes Chromium
 * (getDisplayMedia - na Windows včetně zvuku systému) a kóduje ji
 * MediaRecorderem do jednoho souvislého WebM proudu. Kousky proudu chodí
 * sem a odsud rourou do ffmpeg, který ho BEZ překódování krájí na
 * dvousekundové soubory (segmenty) do dočasné složky a staré maže. Na
 * disku tak leží vždycky jen posledních ~clipSeconds+10 sekund.
 *
 * Stisk zkratky = nahrávání se v ten okamžik zastaví (poslední segment
 * končí přesně tam) a hned se rozjede znovu do nové "generace". Segmenty
 * pokrývající posledních N sekund se slepí (opět bez překódování) do
 * jednoho souboru: mp4 u H.264, webm u VP8/VP9.
 *
 * Proč přes ffmpeg a ne rovnou z MediaRecorderu: jeho kousky nejsou samy
 * o sobě přehratelné (hlavička je jen v prvním, klíčové snímky kdekoli).
 * ffmpeg to řeší a umí to spolehlivě.
 */

const SEGMENT_SECONDS = 2;
/** Rezerva nad délku klipu, ať se nikdy nemaže to, co stisk ještě chce. */
const KEEP_MARGIN_SECONDS = 10;

type Generation = {
  id: number;
  dir: string;
  csv: string;
  startWall: number | null;
  ffmpeg: ChildProcessWithoutNullStreams | null;
  ffmpegClosed: Promise<void> | null;
  pendingChunks: Buffer[];
  segments: Segment[];
  seen: Set<string>;
  ended: boolean;
  mimeType: string;
};

export type ClipResult = {
  file: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  thumb: string | null;
  createdAt: Date;
};

export class CaptureManager {
  private window: BrowserWindow | null = null;
  private windowReady: Promise<void> | null = null;
  private generations: Generation[] = [];
  private nextGeneration = 1;
  private _state: CaptureState = 'off';
  private _error: string | null = null;
  private building = 0;
  private csvTimer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly bufferDir: string;

  constructor(
    private deps: {
      settings: () => Settings;
      preload: string;
      rendererDir: string;
      onState: (state: CaptureState, error: string | null) => void;
      onWarning?: (kind: 'microphone', message: string) => void;
    }
  ) {
    this.bufferDir = join(app.getPath('temp'), 'kine-buffer');
  }

  get state(): CaptureState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  private setState(state: CaptureState, error: string | null = null): void {
    this._state = state;
    this._error = error;
    this.deps.onState(state, error);
  }

  /** Aktuální generace (běžící nahrávání). */
  private get live(): Generation | null {
    const g = this.generations[this.generations.length - 1];
    return g && !g.ended ? g : null;
  }

  // ---- start / stop ----------------------------------------------------------

  async start(): Promise<void> {
    if (this._state === 'on' || this._state === 'starting') return;
    this.setState('starting');
    try {
      rmSync(this.bufferDir, { recursive: true, force: true });
      mkdirSync(this.bufferDir, { recursive: true });
      await this.ensureWindow();
      const gen = this.newGeneration('');
      const started = this.waitFor(`started:${gen.id}`, 20000);
      this.send({ type: 'start', settings: this.deps.settings(), generation: gen.id });
      await started;
      this.startCsvPolling();
      this.setState('on');
    } catch (e) {
      const message = (e as Error).message;
      log(`snímání se nerozjelo: ${message}`);
      this.setState('error', message);
      await this.teardown();
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'off') return;
    const live = this.live;
    if (live && this.window && !this.window.isDestroyed()) {
      this.send({ type: 'stop' });
      await this.waitFor(`stopped:${live.id}`, 5000).catch(() => undefined);
    }
    await this.teardown();
    this.setState('off');
  }

  private async teardown(): Promise<void> {
    if (this.csvTimer) clearInterval(this.csvTimer);
    this.csvTimer = null;
    for (const g of this.generations) {
      if (!g.ended) await this.endGeneration(g).catch(() => undefined);
    }
    this.generations = [];
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.windowReady = null;
    rmSync(this.bufferDir, { recursive: true, force: true });
  }

  /** Změna nastavení, která vyžaduje nový start (rozlišení, kodek, zvuk...). */
  async restartIfOn(): Promise<void> {
    if (this._state !== 'on' && this._state !== 'starting') return;
    await this.stop();
    await this.start();
  }

  private ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.windowReady) return this.windowReady;
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        sandbox: true,
        // Skrytá stránka nesmí být brzděná jako okno na pozadí.
        backgroundThrottling: false,
      },
    });
    this.window = win;
    win.webContents.on('render-process-gone', (_e, details) => {
      log(`snímací stránka spadla: ${details.reason}`);
      this.setState('error', `renderer: ${details.reason}`);
      void this.teardown();
    });
    this.windowReady = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`capture.html: ${desc} (${code})`)));
      void win.loadFile(join(this.deps.rendererDir, 'capture.html'));
    });
    return this.windowReady;
  }

  private send(command: CaptureCommand): void {
    if (!this.window || this.window.isDestroyed()) throw new Error('snímací okno není');
    this.window.webContents.send('capture:command', command);
  }

  private waitFor(key: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`čekání na ${key} vypršelo`));
      }, timeoutMs);
      this.waiters.set(key, {
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(key);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          this.waiters.delete(key);
          reject(e);
        },
      });
    });
  }

  // ---- generace a ffmpeg -----------------------------------------------------

  private newGeneration(mimeType: string): Generation {
    const id = this.nextGeneration++;
    const dir = join(this.bufferDir, `gen-${id}`);
    mkdirSync(dir, { recursive: true });
    const gen: Generation = {
      id,
      dir,
      csv: join(dir, 'list.csv'),
      startWall: null,
      ffmpeg: null,
      ffmpegClosed: null,
      pendingChunks: [],
      segments: [],
      seen: new Set(),
      ended: false,
      mimeType,
    };
    this.generations.push(gen);
    return gen;
  }

  private spawnSegmenter(gen: Generation): void {
    const child = spawnFfmpeg([
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-i', 'pipe:0',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_format', 'matroska',
      '-reset_timestamps', '1',
      '-segment_list', gen.csv,
      '-segment_list_type', 'csv',
      '-segment_list_flags', 'live',
      join(gen.dir, '%05d.mkv'),
    ]);
    gen.ffmpeg = child;
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.stdin.on('error', (e) => log(`ffmpeg stdin (gen ${gen.id}): ${e.message}`));
    gen.ffmpegClosed = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        if (code !== 0 && code !== null) log(`segmenter gen ${gen.id} skončil s kódem ${code}: ${stderr.slice(-600)}`);
        resolve();
      });
      child.on('error', (e) => {
        log(`segmenter gen ${gen.id}: ${e.message}`);
        resolve();
      });
    });
    for (const chunk of gen.pendingChunks) child.stdin.write(chunk);
    gen.pendingChunks = [];
  }

  /** Kousek proudu ze snímací stránky. */
  handleChunk(generationId: number, data: ArrayBuffer | Uint8Array): void {
    const gen = this.generations.find((g) => g.id === generationId);
    if (!gen || gen.ended) return;
    const buffer = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (gen.ffmpeg && !gen.ffmpeg.stdin.destroyed) gen.ffmpeg.stdin.write(buffer);
    else gen.pendingChunks.push(buffer);
  }

  handleEvent(event: CaptureEvent): void {
    const gen = this.generations.find((g) => g.id === event.generation);
    if (event.type === 'started') {
      if (!gen) return;
      gen.startWall = event.at;
      gen.mimeType = event.mimeType;
      log(`snímání gen ${gen.id}: ${event.mimeType}, zvuk ${event.audio ? 'ano' : 'ne'}`);
      this.spawnSegmenter(gen);
      this.waiters.get(`started:${gen.id}`)?.resolve();
      return;
    }
    if (event.type === 'stopped') {
      if (gen) void this.endGeneration(gen).then(() => this.waiters.get(`stopped:${gen.id}`)?.resolve());
      return;
    }
    if (event.type === 'warning') {
      log(`snímací stránka upozorňuje (gen ${event.generation}): ${event.kind}: ${event.message}`);
      this.deps.onWarning?.(event.kind, event.message);
      return;
    }
    if (event.type === 'error') {
      log(`snímací stránka hlásí chybu (gen ${event.generation}): ${event.message}`);
      const w = gen ? this.waiters.get(`started:${gen.id}`) : null;
      if (w) w.reject(new Error(event.message));
      else this.setState('error', event.message);
    }
  }

  /** Uzavře proud do ffmpeg a počká, až dopíše poslední segment. */
  private async endGeneration(gen: Generation): Promise<void> {
    if (gen.ended) return;
    gen.ended = true;
    if (gen.ffmpeg) {
      gen.ffmpeg.stdin.end();
      const timeout = new Promise<void>((r) => setTimeout(r, 4000));
      await Promise.race([gen.ffmpegClosed ?? Promise.resolve(), timeout]);
      if (gen.ffmpeg.exitCode === null) gen.ffmpeg.kill();
    }
    this.readCsv(gen);
  }

  private startCsvPolling(): void {
    if (this.csvTimer) return;
    this.csvTimer = setInterval(() => {
      for (const g of this.generations) if (!g.ended) this.readCsv(g);
      if (this.building === 0) this.prune();
    }, 500);
  }

  private readCsv(gen: Generation): void {
    if (gen.startWall === null) return;
    let text: string;
    try {
      text = readFileSync(gen.csv, 'utf8');
    } catch {
      return;
    }
    for (const row of parseSegmentCsv(text)) {
      if (gen.seen.has(row.file)) continue;
      gen.seen.add(row.file);
      gen.segments.push(toSegment(row, gen.id, gen.startWall, gen.dir, join));
    }
  }

  private allSegments(): Segment[] {
    return this.generations.flatMap((g) => g.segments);
  }

  /** Smaže segmenty, které už žádný klip nemůže chtít, a prázdné staré generace. */
  private prune(): void {
    const keep = this.deps.settings().clipSeconds + KEEP_MARGIN_SECONDS;
    const old = expired(this.allSegments(), Date.now(), keep);
    if (old.length === 0) return;
    const dead = new Set(old.map((s) => s.file));
    for (const g of this.generations) {
      g.segments = g.segments.filter((s) => !dead.has(s.file));
    }
    for (const s of old) {
      try {
        unlinkSync(s.file);
      } catch {
        // Už není.
      }
    }
    // Ukončené generace bez segmentů můžou pryč i se složkou.
    const live = this.live;
    this.generations = this.generations.filter((g) => {
      if (g === live || g.segments.length > 0 || !g.ended) return true;
      rmSync(g.dir, { recursive: true, force: true });
      return false;
    });
  }

  // ---- klip -------------------------------------------------------------------

  /** Kolik sekund je právě v zásobníku (pro hlášku "teprve se plní"). */
  bufferedSeconds(): number {
    const live = this.live;
    const oldest = this.allSegments().reduce((min, s) => Math.min(min, s.startWall), Infinity);
    const start = Number.isFinite(oldest) ? oldest : live?.startWall ?? Date.now();
    return (Date.now() - start) / 1000;
  }

  /**
   * Uloží posledních `seconds` sekund do složky `outDir`. Zastaví běžící
   * generaci (přesný konec), rozjede novou a slepí segmenty. Náhled (první
   * snímek videa) jde do `thumbDir` - ve složce s klipy tak leží jen videa.
   */
  async makeClip(seconds: number, outDir: string, game: string | null, thumbDir = outDir): Promise<ClipResult> {
    if (this._state !== 'on') throw new Error('not-capturing');
    const live = this.live;
    if (!live) throw new Error('not-capturing');
    const endWall = Date.now();
    this.building += 1;
    try {
      // Přepnout na novou generaci: stará se uzavře přesně teď.
      const next = this.newGeneration(live.mimeType);
      // Čekání se přihlásí DŘÍV, než se pošle povel - "started" nové generace
      // může přijít dřív, než doběhne ffmpeg té staré.
      const stopped = this.waitFor(`stopped:${live.id}`, 8000);
      this.waitFor(`started:${next.id}`, 15000).catch((e) => {
        log(`nová generace po klipu nenaběhla: ${e.message}`);
        this.setState('error', e.message);
      });
      this.send({ type: 'restart', generation: next.id });
      await stopped;

      let chosen = selectForClip(this.allSegments(), endWall, seconds);
      if (chosen.length === 0 || totalSeconds(chosen) < 1) throw new Error('too-early');
      // Když hra mezitím přepnula rozlišení (celá obrazovka 4:3, načítání),
      // kousky mají různé rozměry a slepený soubor prohlížeč nepřehraje -
      // ukáže černo s 0:00. Vezme se jen souvislý konec se stejnými rozměry.
      chosen = await sameResolutionTail(chosen);
      const have = totalSeconds(chosen);
      if (chosen.length === 0 || have < 1) throw new Error('too-early');

      mkdirSync(outDir, { recursive: true });
      const createdAt = new Date(endWall);
      const isH264 = /h264|avc1/i.test(live.mimeType);
      const base = clipFileBase(createdAt, game);
      const file = uniquePath(outDir, base, isH264 ? '.mp4' : '.webm');
      const listFile = join(live.dir, 'concat.txt');
      writeFileSync(listFile, concatList(chosen.map((s) => s.file)));

      // -avoid_negative_ts: slepené kousky mohou začínat záporným časem -
      // prohlížeč (přehrávač v appce) pak video nepustí a ukáže černo s 0:00.
      const args = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-avoid_negative_ts', 'make_zero'];
      if (isH264) args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
      else args.push('-c', 'copy');
      args.push(file);
      await runFfmpeg(args);

      // Náhled = první snímek videa (to samé, co ukáže přehrávač), mimo složku s klipy.
      let thumb: string | null = null;
      try {
        mkdirSync(thumbDir, { recursive: true });
        thumb = uniquePath(thumbDir, base, '.jpg');
        await runFfmpeg(['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], 30000);
      } catch {
        thumb = null;
      }

      const info = await probe(file);
      const result: ClipResult = {
        file,
        durationSeconds: info.durationSeconds ?? have,
        width: info.width,
        height: info.height,
        sizeBytes: statSync(file).size,
        thumb,
        createdAt,
      };
      log(`klip: ${file} (${result.durationSeconds.toFixed(1)} s, ${chosen.length} segmentů)`);
      return result;
    } finally {
      this.building -= 1;
    }
  }
}

/**
 * Souvislý konec seznamu kousků se stejnými rozměry obrazu jako ten
 * poslední. Rozměry se čtou z hlavičky (probe), po několika naráz; když
 * se u některého nepovede zjistit, bere se, že sedí.
 */
async function sameResolutionTail(segments: Segment[]): Promise<Segment[]> {
  if (segments.length < 2) return segments;
  const sizes: (string | null)[] = new Array(segments.length).fill(null);
  const limit = 6;
  for (let i = 0; i < segments.length; i += limit) {
    const batch = segments.slice(i, i + limit);
    const results = await Promise.all(batch.map((seg) => probe(seg.file).catch(() => ({ width: null, height: null, durationSeconds: null }))));
    results.forEach((r, j) => {
      sizes[i + j] = r.width && r.height ? `${r.width}x${r.height}` : null;
    });
  }
  const start = sameResolutionTailStart(sizes);
  if (start > 0) log(`kousky s jinými rozměry (${[...new Set(sizes.slice(0, start).filter(Boolean))].join(', ')} -> ${sizes[sizes.length - 1]}): ${start} vynecháno`);
  return segments.slice(start);
}

function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = join(dir, base + ext);
  let n = 2;
  while (existsSyncSafe(candidate)) {
    candidate = join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
