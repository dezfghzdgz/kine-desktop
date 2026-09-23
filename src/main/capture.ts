import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BrowserWindow, app } from 'electron';
import type { AudioLevels, CaptureCommand, CaptureEvent, CaptureState, Settings } from '../shared/types';
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
/** Nejdelší souvislé nahrávání (celý zápas); pak se samo uloží a skončí. */
export const RECORDING_MAX_SECONDS = 3 * 60 * 60;
/** Pod tolik volného místa na disku se nahrávání samo uloží, ať nedojde místo. */
const RECORDING_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

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
  /**
   * Nahrávání celého zápasu: od `since` se kousky nemažou (zásobník jinak
   * drží jen posledních N sekund) a po zastavení se slepí do jednoho
   * dlouhého souboru. Zkratka na klip mezitím funguje normálně.
   */
  private recording: { since: number; game: string | null } | null = null;
  private recordingStopHandler: ((reason: 'max' | 'disk') => void) | null = null;
  /** Kdy se naposledy měřilo volné místo při nahrávání (statfs jednou za 30 s stačí). */
  private lastDiskCheck = 0;
  /** Poslední hladiny zvuku ze snímací stránky (null = zásobník neběží / ještě nic nepřišlo). */
  levels: AudioLevels | null = null;
  private csvTimer: ReturnType<typeof setInterval> | null = null;
  private waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  /** Složka se zásobníkem (kousky videa). Každá appka svou; když je zamčená, vezme se jiná. */
  private bufferDir: string;
  private readonly bufferName: string;

  constructor(
    private deps: {
      settings: () => Settings;
      preload: string;
      rendererDir: string;
      onState: (state: CaptureState, error: string | null) => void;
      onWarning?: (kind: 'microphone' | 'systemAudio', message: string) => void;
      /** Hladiny zvuku ze snímací stránky (zhruba každou sekundu). */
      onLevels?: (levels: AudioLevels) => void;
      /** Výchozí výstup Windows se změnil - snímání se má rozjet znovu (loopback visí na starém). */
      onDefaultOutputChanged?: (device: string) => void;
      /** Název složky v %TEMP% - Kine a Kine Clipper mají každá svou, ať si nesahají na kousky. */
      bufferName?: string;
    }
  ) {
    this.bufferName = deps.bufferName ?? 'kine-buffer';
    this.bufferDir = join(app.getPath('temp'), this.bufferName);
  }

  /**
   * Prázdná složka pro zásobník. Obvykle %TEMP%\<název>; když ji nejde
   * vyčistit (drží ji jiný běžící Kine, spadlý ffmpeg z minula - EPERM /
   * EBUSY), vezme se %TEMP%\<název>-<pid> místo toho, aby nahrávání
   * spadlo. Staré složky s pid se při té příležitosti zkusí uklidit.
   */
  private prepareBufferDir(): void {
    const temp = app.getPath('temp');
    const main = join(temp, this.bufferName);
    try {
      for (const name of readdirSync(temp)) {
        if (name.startsWith(`${this.bufferName}-`) && name !== basename(this.bufferDir)) {
          try {
            rmSync(join(temp, name), { recursive: true, force: true });
          } catch {
            // ještě běží jiná appka - nechat
          }
        }
      }
    } catch {
      // %TEMP% nejde přečíst - nevadí
    }
    try {
      rmSync(main, { recursive: true, force: true });
      mkdirSync(main, { recursive: true });
      this.bufferDir = main;
    } catch (e) {
      const alt = join(temp, `${this.bufferName}-${process.pid}`);
      log(`složku zásobníku ${main} nejde vyčistit (${(e as Error).message.split('\n')[0]}) - beru ${alt}`);
      rmSync(alt, { recursive: true, force: true });
      mkdirSync(alt, { recursive: true });
      this.bufferDir = alt;
    }
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
    if (state !== 'on') this.levels = null;
    this.deps.onState(state, error);
  }

  /** Kolik místa zabírají kousky v zásobníku (všechny generace). */
  bufferBytes(): number {
    let total = 0;
    for (const g of this.generations) {
      for (const seg of g.segments) {
        try {
          total += statSync(seg.file).size;
        } catch {
          // kousek už zmizel
        }
      }
    }
    return total;
  }

  recordingInfo(): { since: number; game: string | null } | null {
    return this.recording ? { ...this.recording } : null;
  }

  /** Kdo dostane vědět, že se nahrávání zastavilo samo (délka, místo na disku). */
  onRecordingAutoStop(handler: (reason: 'max' | 'disk') => void): void {
    this.recordingStopHandler = handler;
  }

  /** Aktuální generace (běžící nahrávání). */
  private get live(): Generation | null {
    const g = this.generations[this.generations.length - 1];
    return g && !g.ended ? g : null;
  }

  // ---- start / stop ----------------------------------------------------------

  /** Pořadové číslo startu zásobníku (upozornění "jednou za start"). */
  private sessionCounter = 0;
  captureSession(): number {
    return this.sessionCounter;
  }

  async start(): Promise<void> {
    if (this._state === 'on' || this._state === 'starting') return;
    this.sessionCounter += 1;
    this.setState('starting');
    try {
      this.prepareBufferDir();
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
    try {
      rmSync(this.bufferDir, { recursive: true, force: true });
    } catch (e) {
      log(`úklid zásobníku: ${(e as Error).message.split('\n')[0]}`);
    }
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
    if (event.type === 'levels') {
      this.levels = event.levels;
      this.deps.onLevels?.(event.levels);
      return;
    }
    if (event.type === 'defaultOutputChanged') {
      log(`výchozí výstup zvuku se změnil: ${event.device}`);
      this.deps.onDefaultOutputChanged?.(event.device);
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
    let old = expired(this.allSegments(), Date.now(), keep);
    if (this.recording) {
      // Co patří do nahrávaného zápasu, zůstává (s rezervou jednoho kousku před startem).
      const since = this.recording.since - SEGMENT_SECONDS * 1000;
      old = old.filter((s) => s.endWall < since);
      this.watchRecordingLimits();
    }
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

  // ---- nahrávání celého zápasu ----------------------------------------------------

  /**
   * Začne nahrávat celý zápas: od teď se kousky nemažou. Zásobník musí
   * běžet. Generace se přepne, ať nahrávka začíná přesně teď.
   */
  async startRecording(game: string | null): Promise<void> {
    if (this._state !== 'on' || !this.live) throw new Error('not-capturing');
    if (this.recording) return;
    const live = this.live;
    const next = this.newGeneration(live.mimeType);
    const stopped = this.waitFor(`stopped:${live.id}`, 8000);
    this.waitFor(`started:${next.id}`, 15000).catch((e) => {
      log(`nová generace při startu nahrávání nenaběhla: ${e.message}`);
      this.setState('error', e.message);
    });
    this.send({ type: 'restart', generation: next.id });
    await stopped;
    this.recording = { since: Date.now(), game };
    this.lastDiskCheck = Date.now();
    log(`nahrávání zápasu začalo${game ? ` (${game})` : ''}`);
  }

  /** Když nahrávání trvá moc dlouho nebo dochází místo, samo se uloží (přes handler v hlavním procesu). */
  private watchRecordingLimits(): void {
    if (!this.recording || this.building > 0) return;
    const now = Date.now();
    const seconds = (now - this.recording.since) / 1000;
    let reason: 'max' | 'disk' | null = null;
    if (seconds >= RECORDING_MAX_SECONDS) reason = 'max';
    else if (now - this.lastDiskCheck >= 30000) {
      this.lastDiskCheck = now;
      if (freeBytes(this.bufferDir) < RECORDING_MIN_FREE_BYTES) reason = 'disk';
    }
    if (reason && this.recordingStopHandler) {
      log(`nahrávání zápasu se zastaví samo (${reason})`);
      const handler = this.recordingStopHandler;
      this.recordingStopHandler = null;
      handler(reason);
    }
  }

  /**
   * Zastaví nahrávání a slepí všechno od startu do jednoho souboru (jako
   * klip, jen dlouhý). Vrací výsledek, nebo hodí 'too-early', když ještě
   * nic není. Zásobník jede dál.
   */
  async stopRecording(outDir: string, thumbDir = outDir): Promise<ClipResult & { since: number }> {
    const rec = this.recording;
    if (!rec) throw new Error('not-recording');
    if (this._state !== 'on' || !this.live) {
      this.recording = null;
      throw new Error('not-capturing');
    }
    const seconds = (Date.now() - rec.since) / 1000;
    try {
      const result = await this.makeClip(seconds, outDir, rec.game, thumbDir, { kind: 'recording' });
      return { ...result, since: rec.since };
    } finally {
      // Ať se kousky zase mažou, i kdyby slepení selhalo.
      this.recording = null;
    }
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
  async makeClip(seconds: number, outDir: string, game: string | null, thumbDir = outDir, options: { kind?: 'clip' | 'recording' } = {}): Promise<ClipResult> {
    if (this._state !== 'on') throw new Error('not-capturing');
    const live = this.live;
    if (!live) throw new Error('not-capturing');
    const endWall = Date.now();
    const recording = options.kind === 'recording';
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
      // U dlouhé nahrávky (stovky kousků) se kontrolují jen kraje - probe
      // každého kousku by trvalo minuty.
      chosen = await sameResolutionTail(chosen, recording ? 24 : Infinity);
      const have = totalSeconds(chosen);
      if (chosen.length === 0 || have < 1) throw new Error('too-early');

      mkdirSync(outDir, { recursive: true });
      const createdAt = new Date(endWall);
      const isH264 = /h264|avc1/i.test(live.mimeType);
      const base = recording ? `${clipFileBase(createdAt, game)} recording` : clipFileBase(createdAt, game);
      const file = uniquePath(outDir, base, isH264 ? '.mp4' : '.webm');
      const listFile = join(live.dir, 'concat.txt');
      writeFileSync(listFile, concatList(chosen.map((s) => s.file)));

      // -avoid_negative_ts: slepené kousky mohou začínat záporným časem -
      // prohlížeč (přehrávač v appce) pak video nepustí a ukáže černo s 0:00.
      const args = ['-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-avoid_negative_ts', 'make_zero'];
      if (isH264) args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
      else args.push('-c', 'copy');
      args.push(file);
      // Dlouhá nahrávka = víc času na slepení (výchozí 2 min by u hodinového zápasu nestačily).
      await runFfmpeg(args, recording ? 30 * 60 * 1000 : 120000);

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
      log(`${recording ? 'nahrávka' : 'klip'}: ${file} (${result.durationSeconds.toFixed(1)} s, ${chosen.length} segmentů)`);
      return result;
    } finally {
      this.building -= 1;
    }
  }
}

/** Volné místo na disku, kde leží složka (Node statfs); když to nejde zjistit, "dost". */
function freeBytes(dir: string): number {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Souvislý konec seznamu kousků se stejnými rozměry obrazu jako ten
 * poslední. Rozměry se čtou z hlavičky (probe), po několika naráz; když
 * se u některého nepovede zjistit, bere se, že sedí.
 */
async function sameResolutionTail(segments: Segment[], maxProbes = Infinity): Promise<Segment[]> {
  if (segments.length < 2) return segments;
  const sizes: (string | null)[] = new Array(segments.length).fill(null);
  // Když je kousků moc, ptá se jen na rovnoměrný vzorek (neznámé = "sedí").
  const step = Number.isFinite(maxProbes) && segments.length > maxProbes ? Math.ceil(segments.length / maxProbes) : 1;
  const indexes: number[] = [];
  for (let i = 0; i < segments.length; i += step) indexes.push(i);
  if (indexes[indexes.length - 1] !== segments.length - 1) indexes.push(segments.length - 1);
  const limit = 6;
  for (let i = 0; i < indexes.length; i += limit) {
    const batch = indexes.slice(i, i + limit);
    const results = await Promise.all(batch.map((idx) => probe(segments[idx].file).catch(() => ({ width: null, height: null, durationSeconds: null }))));
    results.forEach((r, j) => {
      sizes[batch[j]] = r.width && r.height ? `${r.width}x${r.height}` : null;
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
