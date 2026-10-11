import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { BrowserWindow, app } from 'electron';
import type { AudioLevels, CaptureCommand, CaptureEvent, CaptureState, Settings } from '../shared/types';
import { clipFileBase } from '../shared/clipNaming';
import { log } from './log';
import { probe, runFfmpeg, spawnFfmpeg } from './ffmpeg';
import { concatScript, expired, parseSegmentCsv, planClip, recordingParts, recoverySegments, reportedSize, selectForClip, sizeRuns, toSegment, totalSeconds, type SavedGeneration, type Segment } from './segments';
import { clipAudioTracks, clipMuxArgs, type AudioTrackKind } from './editPlan';

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
  /** Samostatný proud mikrofonu (druhý recorder): vlastní segmenter, CSV a kousky. */
  micCsv: string;
  micFfmpeg: ChildProcessWithoutNullStreams | null;
  micFfmpegClosed: Promise<void> | null;
  micPending: Buffer[];
  micSegments: Segment[];
  micSeen: Set<string>;
  /** Má tahle generace mikrofonní proud? (podle 'started') */
  hasMic: boolean;
  /** Má proud obrazu i zvuk hry? (podle 'started') */
  hasAudio: boolean;
  /** Zpoždění mikrofonu podle Chromia (ms) - při stavbě klipu se o tolik posune dopředu. */
  micLatencyMs: number;
  /** Rozměry obrazu na začátku generace ("1920x1080"), podle snímací stránky; null = neví se. */
  size: string | null;
  /** Kdy (hodiny počítače) obrazovka během generace změnila rozměry (hra přepnula rozlišení). */
  resizes: { at: number; size: string }[];
};

/** Zvukové vlastnosti generace, podle kterých se lepí klip (zvuk hry ano/ne, zpoždění mikrofonu). */
type GenerationAudio = { id: number; hasAudio: boolean; micLatencyMs: number };

/** Nahrávka zápasu slepená po pádu z kousků, které zůstaly na disku. */
export type RecoveredRecording = ClipResult & { since: number; game: string | null };

export type ClipResult = {
  file: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  thumb: string | null;
  createdAt: Date;
  /** Zvukové stopy v souboru, v pořadí (první hraje přehrávač). */
  audioTracks: AudioTrackKind[];
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
  /**
   * Zastavená nahrávka, která se právě slepuje do souboru (u dlouhé to
   * chvíli trvá). Kousky se pořád nemažou, ale nahrávání už neběží -
   * tlačítko ukazuje "Ukládám…" a další stisk nic nespustí (dřív se tak
   * nahrávka uložila víckrát).
   */
  private finishing: { since: number; game: string | null; percent: number | null; dir: string } | null = null;
  private recordingStopHandler: ((reason: 'max' | 'disk') => void) | null = null;
  /** Rozměry kousků, které už se zjišťovaly (kousek se po zapsání nemění) - další klip se na ně nemusí ptát znovu. */
  private probeCache = new Map<string, string | null>();
  /** Kdy se naposledy měřilo volné místo při nahrávání (statfs jednou za 30 s stačí). */
  private lastDiskCheck = 0;
  /** Poslední hladiny zvuku ze snímací stránky (null = zásobník neběží / ještě nic nepřišlo). */
  levels: AudioLevels | null = null;
  /** Hardwarový kodér H.264 (podle snímací stránky); null = neví se. */
  hwEncoder: boolean | null = null;
  /** Snímky za sekundu, se kterými se opravdu nahrává (bez hardwarového kodéru nejvýš 30). */
  effectiveFps: number | null = null;
  /** Chce někdo plynulé měřáky (nastavení je otevřené na Záznamu)? */
  private metersFast = false;
  /** Co se právě nahrává (pro diagnostiku). */
  lastStarted: { mimeType: string; audio: boolean; mic: boolean; micLatencyMs: number } | null = null;
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
      /** `runtime` = snímání spadlo za běhu (ne při startu) - hlavní proces ho zkusí rozjet znovu. */
      onState: (state: CaptureState, error: string | null, runtime: boolean) => void;
      onWarning?: (kind: 'microphone' | 'systemAudio' | 'bluetoothMic', message: string) => void;
      /** Hladiny zvuku ze snímací stránky (zhruba každou sekundu). */
      onLevels?: (levels: AudioLevels) => void;
      /** Výchozí výstup Windows se změnil - snímání se má rozjet znovu (loopback visí na starém). */
      onDefaultOutputChanged?: (device: string) => void;
      /** Název složky v %TEMP% - Kine a Kine Clipper mají každá svou, ať si nesahají na kousky. */
      bufferName?: string;
      /** Rozjetá nahrávka zápasu, kterou přerušil pád, je odložená k obnově - ať ji hlavní proces slepí (recoverLeftovers). */
      onRecoverable?: () => void;
      /** Události recorderu živého vysílání (live.ts). */
      onLiveEvent?: (event: Extract<CaptureEvent, { type: 'live-started' | 'live-stopped' | 'live-error' | 'live-warning' }>) => void;
      /** Průběh ukládání nahrávky zápasu (tlačítko "Ukládám… 40 %"). */
      onSavingProgress?: () => void;
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
    // Rozjetá nahrávka zápasu z minula (pád) se nemaže - odloží se k obnově.
    if (this.salvageLeftovers().moved > 0) this.deps.onRecoverable?.();
    const busyDir = this.finishing?.dir ?? null;
    try {
      for (const name of readdirSync(temp)) {
        const dir = join(temp, name);
        if (name.startsWith(`${this.bufferName}-`) && name !== basename(this.bufferDir) && dir !== busyDir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // ještě běží jiná appka - nechat
          }
        }
      }
    } catch {
      // %TEMP% nejde přečíst - nevadí
    }
    try {
      // Nahrávka se z téhle složky právě slepuje (snímání se mezitím rozjíždí znovu) - nesahat na ni.
      if (busyDir === main) throw new Error('slepuje se z ní nahrávka zápasu');
      // Nahrávku, kterou nešlo odložit (soubory ještě drží spadlý ffmpeg), nemazat - zásobník půjde vedle.
      if (existsSync(join(main, 'recording.json'))) throw new Error('čeká tu nahrávka zápasu k obnově');
      rmSync(main, { recursive: true, force: true });
      mkdirSync(main, { recursive: true });
      this.bufferDir = main;
    } catch (e) {
      let alt = join(temp, `${this.bufferName}-${process.pid}`);
      if (alt === busyDir) alt = join(temp, `${this.bufferName}-${process.pid}-${Date.now().toString(36)}`);
      log(`složku zásobníku ${main} nejde vyčistit (${(e as Error).message.split('\n')[0]}) - beru ${alt}`);
      rmSync(alt, { recursive: true, force: true });
      mkdirSync(alt, { recursive: true });
      this.bufferDir = alt;
    }
    this.csvOffsets.clear();
  }

  get state(): CaptureState {
    return this._state;
  }

  get error(): string | null {
    return this._error;
  }

  private setState(state: CaptureState, error: string | null = null, runtime = false): void {
    this._state = state;
    this._error = error;
    if (state !== 'on') this.levels = null;
    this.deps.onState(state, error, runtime);
  }

  /** Kolik místa zabírají kousky v zásobníku (všechny generace). */
  bufferBytes(): number {
    let total = 0;
    for (const g of this.generations) {
      for (const seg of [...g.segments, ...g.micSegments]) {
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

  /** Proces snímací stránky (pro přehled, kolik appka bere); null = snímání neběží. */
  capturePid(): number | null {
    try {
      return this.window && !this.window.isDestroyed() ? this.window.webContents.getOSProcessId() : null;
    } catch {
      return null;
    }
  }

  /** Nahrávka zápasu, která se po zastavení slepuje do souboru (null = žádná). */
  savingInfo(): { since: number; percent: number | null } | null {
    return this.finishing ? { since: this.finishing.since, percent: this.finishing.percent } : null;
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
      // Po pádu snímací stránky ještě může dobíhat úklid staré složky - nový start na ni nesmí sáhnout dřív.
      if (this.tearingDown) await this.tearingDown;
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

  /** Běžící úklid (po pádu snímací stránky se volá bez čekání - start na něj počká). */
  private tearingDown: Promise<void> | null = null;

  private teardown(): Promise<void> {
    if (!this.tearingDown) {
      this.tearingDown = this.doTeardown().finally(() => {
        this.tearingDown = null;
      });
    }
    return this.tearingDown;
  }

  private async doTeardown(): Promise<void> {
    if (this.csvTimer) clearInterval(this.csvTimer);
    this.csvTimer = null;
    for (const g of this.generations) {
      if (!g.ended) await this.endGeneration(g).catch(() => undefined);
    }
    this.generations = [];
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.windowReady = null;
    // Snímání skončilo pod rozjetou nahrávkou zápasu (spadla snímací stránka):
    // kousky se nemažou, odloží se a hlavní proces z nich slepí, co šlo.
    if (this.recording) {
      this.recording = null;
      this.recordingStopHandler = null;
      if (this.setAside(this.bufferDir)) this.deps.onRecoverable?.();
      // Když to nejde přejmenovat, kousky zůstanou, kde jsou - odloží se při dalším startu zásobníku.
      return;
    }
    // Z kousků se právě slepuje nahrávka zápasu - smazat je by ji zničilo.
    // Složku uklidí další start zásobníku (až slepení doběhne a značka zmizí).
    if (this.finishing) return;
    try {
      rmSync(this.bufferDir, { recursive: true, force: true });
    } catch (e) {
      log(`úklid zásobníku: ${(e as Error).message.split('\n')[0]}`);
    }
    this.probeCache.clear();
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
        spellcheck: false,
      },
    });
    this.window = win;
    win.webContents.on('render-process-gone', (_e, details) => {
      log(`snímací stránka spadla: ${details.reason}`);
      this.setState('error', `renderer: ${details.reason}`, true);
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

  /** Povel pro recorder živého vysílání; false = snímací stránka neběží. */
  sendLive(command: Extract<CaptureCommand, { type: 'live-start' | 'live-stop' | 'live-scene' }>): boolean {
    if (!this.window || this.window.isDestroyed()) return false;
    // Konec vysílání se doručí vždycky, i když snímání mezitím spadlo do chyby -
    // jinak by snímací stránka dál kódovala a držela kameru.
    if (this._state !== 'on' && command.type !== 'live-stop') return false;
    this.window.webContents.send('capture:command', command);
    return true;
  }

  /** Povel, který nevadí, když snímání neběží (měřáky). */
  private sendSafe(command: CaptureCommand): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('capture:command', command);
  }

  /** Plynulé měřáky zvuku (10x za sekundu) jen když se na ně někdo dívá - jinak jednou za sekundu. */
  setMetersFast(fast: boolean): void {
    if (this.metersFast === fast) return;
    this.metersFast = fast;
    this.sendSafe({ type: 'meters', fast });
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
      micCsv: join(dir, 'mic.csv'),
      micFfmpeg: null,
      micFfmpegClosed: null,
      micPending: [],
      micSegments: [],
      micSeen: new Set(),
      hasMic: false,
      hasAudio: false,
      micLatencyMs: 0,
      size: null,
      resizes: [],
    };
    this.generations.push(gen);
    return gen;
  }

  /** Segmenter: WebM proud z roury krájí bez překódování na 2 s kousky a píše CSV seznam. */
  private spawnSegmenter(gen: Generation, kind: 'av' | 'mic' = 'av'): void {
    const mic = kind === 'mic';
    // Jen kopíruje a krájí - nižší priorita: hra dostane procesor první (roura mezitím počká).
    const child = spawnFfmpeg([
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-i', 'pipe:0',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_format', 'matroska',
      '-reset_timestamps', '1',
      '-segment_list', mic ? gen.micCsv : gen.csv,
      '-segment_list_type', 'csv',
      '-segment_list_flags', 'live',
      join(gen.dir, mic ? 'm%05d.mka' : '%05d.mkv'),
    ], { low: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    const name = mic ? `mikrofon gen ${gen.id}` : `gen ${gen.id}`;
    child.stdin.on('error', (e) => log(`ffmpeg stdin (${name}): ${e.message}`));
    const closed = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        if (code !== 0 && code !== null) log(`segmenter ${name} skončil s kódem ${code}: ${stderr.slice(-600)}`);
        resolve();
      });
      child.on('error', (e) => {
        log(`segmenter ${name}: ${e.message}`);
        resolve();
      });
    });
    if (mic) {
      gen.micFfmpeg = child;
      gen.micFfmpegClosed = closed;
      for (const chunk of gen.micPending) child.stdin.write(chunk);
      gen.micPending = [];
    } else {
      gen.ffmpeg = child;
      gen.ffmpegClosed = closed;
      for (const chunk of gen.pendingChunks) child.stdin.write(chunk);
      gen.pendingChunks = [];
    }
  }

  /** Kousek proudu ze snímací stránky ('av' = obraz + zvuk hry, 'mic' = mikrofon). */
  handleChunk(generationId: number, data: ArrayBuffer | Uint8Array, kind: 'av' | 'mic' = 'av'): void {
    const gen = this.generations.find((g) => g.id === generationId);
    if (!gen || gen.ended) return;
    const buffer = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
    if (kind === 'mic') {
      if (gen.micFfmpeg && !gen.micFfmpeg.stdin.destroyed) gen.micFfmpeg.stdin.write(buffer);
      else gen.micPending.push(buffer);
      return;
    }
    if (gen.ffmpeg && !gen.ffmpeg.stdin.destroyed) gen.ffmpeg.stdin.write(buffer);
    else gen.pendingChunks.push(buffer);
  }

  handleEvent(event: CaptureEvent): void {
    // Vysílání má vlastní číslování generací - do zásobníku nepatří.
    if (event.type === 'live-started' || event.type === 'live-stopped' || event.type === 'live-error' || event.type === 'live-warning') {
      this.deps.onLiveEvent?.(event);
      return;
    }
    const gen = this.generations.find((g) => g.id === event.generation);
    if (event.type === 'resized') {
      // Hra přepnula rozlišení: klip přes tuhle chvíli se vezme jen od ní dál (viz consistentSegments).
      const size = `${event.width}x${event.height}`;
      if (gen && !gen.ended) {
        gen.resizes.push({ at: event.at, size });
        log(`snímání gen ${gen.id}: obrazovka změnila rozměry na ${size}`);
      }
      return;
    }
    if (event.type === 'started') {
      if (!gen) return;
      gen.startWall = event.at;
      gen.mimeType = event.mimeType;
      gen.hasMic = !!event.mic;
      gen.hasAudio = !!event.audio;
      gen.micLatencyMs = event.micLatencyMs ?? 0;
      gen.size = event.width && event.height ? `${event.width}x${event.height}` : null;
      if (typeof event.hwEncoder === 'boolean') this.hwEncoder = event.hwEncoder;
      if (typeof event.fps === 'number') this.effectiveFps = event.fps;
      // Nová snímací stránka / generace neví, jestli se někdo dívá na měřáky.
      if (this.metersFast) this.sendSafe({ type: 'meters', fast: true });
      this.lastStarted = { mimeType: event.mimeType, audio: !!event.audio, mic: !!event.mic, micLatencyMs: gen.micLatencyMs };
      log(`snímání gen ${gen.id}: ${event.mimeType}, zvuk hry ${event.audio ? 'ano' : 'ne'}, mikrofon ${event.mic ? `ano (zpoždění ${gen.micLatencyMs} ms)` : 'ne'}, HW kodér ${event.hwEncoder === null || event.hwEncoder === undefined ? '?' : event.hwEncoder ? 'ano' : 'ne'}`);
      this.writeGenerationInfo(gen);
      this.spawnSegmenter(gen);
      if (gen.hasMic) this.spawnSegmenter(gen, 'mic');
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
      else this.setState('error', event.message, true);
    }
  }

  /** Uzavře proudy do ffmpeg a počká, až dopíšou poslední segmenty. */
  private async endGeneration(gen: Generation): Promise<void> {
    if (gen.ended) return;
    gen.ended = true;
    const finish = async (child: ChildProcessWithoutNullStreams | null, closed: Promise<void> | null) => {
      if (!child) return;
      child.stdin.end();
      const timeout = new Promise<void>((r) => setTimeout(r, 4000));
      await Promise.race([closed ?? Promise.resolve(), timeout]);
      if (child.exitCode === null) child.kill();
    };
    await Promise.all([finish(gen.ffmpeg, gen.ffmpegClosed), finish(gen.micFfmpeg, gen.micFfmpegClosed)]);
    this.readCsv(gen);
  }

  private startCsvPolling(): void {
    if (this.csvTimer) return;
    // Jednou za sekundu stačí (kousek má 2 s); při klipu se seznam dočte hned (endGeneration).
    this.csvTimer = setInterval(() => {
      for (const g of this.generations) if (!g.ended) this.readCsv(g);
      if (this.building === 0) this.prune();
    }, 1000);
  }

  /** Čtení seznamů kousků po přírůstcích: u nahrávky zápasu má seznam tisíce řádků a číst ho celý pořád dokola je zbytečné. */
  private csvOffsets = new Map<string, { offset: number; partial: string }>();

  private readNewCsvText(file: string): string {
    const state = this.csvOffsets.get(file) ?? { offset: 0, partial: '' };
    let fd: number | null = null;
    try {
      fd = openSync(file, 'r');
      const size = fstatSync(fd).size;
      if (size < state.offset) {
        // Soubor je kratší (nový) - číst od začátku.
        state.offset = 0;
        state.partial = '';
      }
      if (size === state.offset) return '';
      const buffer = Buffer.alloc(size - state.offset);
      const read = readSync(fd, buffer, 0, buffer.length, state.offset);
      state.offset += read;
      const text = state.partial + buffer.subarray(0, read).toString('utf8');
      // Poslední řádek bez konce se dočte příště (ffmpeg ho ještě píše).
      const cut = text.lastIndexOf('\n');
      state.partial = cut >= 0 ? text.slice(cut + 1) : text;
      this.csvOffsets.set(file, state);
      return cut >= 0 ? text.slice(0, cut + 1) : '';
    } catch {
      return '';
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // nic
        }
      }
    }
  }

  private readCsv(gen: Generation): void {
    if (gen.startWall === null) return;
    const text = this.readNewCsvText(gen.csv);
    if (text) {
      for (const row of parseSegmentCsv(text)) {
        if (gen.seen.has(row.file)) continue;
        gen.seen.add(row.file);
        gen.segments.push(toSegment(row, gen.id, gen.startWall, gen.dir, join));
      }
    }
    if (!gen.hasMic) return;
    const micText = this.readNewCsvText(gen.micCsv);
    if (!micText) return;
    for (const row of parseSegmentCsv(micText)) {
      if (gen.micSeen.has(row.file)) continue;
      gen.micSeen.add(row.file);
      gen.micSegments.push(toSegment(row, gen.id, gen.startWall, gen.dir, join));
    }
  }

  private allSegments(): Segment[] {
    return this.generations.flatMap((g) => g.segments);
  }

  private allMicSegments(): Segment[] {
    return this.generations.flatMap((g) => g.micSegments);
  }

  /** Smaže segmenty, které už žádný klip nemůže chtít, a prázdné staré generace. */
  private prune(): void {
    const keep = this.deps.settings().clipSeconds + KEEP_MARGIN_SECONDS;
    const now = Date.now();
    let old = [...expired(this.allSegments(), now, keep), ...expired(this.allMicSegments(), now, keep)];
    const protectedSince = this.recording?.since ?? this.finishing?.since ?? null;
    if (protectedSince !== null) {
      // Co patří do nahrávaného (nebo právě ukládaného) zápasu, zůstává (s rezervou jednoho kousku před startem).
      const since = protectedSince - SEGMENT_SECONDS * 1000;
      old = old.filter((s) => s.endWall < since);
      if (this.recording) this.watchRecordingLimits();
    }
    if (old.length === 0) return;
    const dead = new Set(old.map((s) => s.file));
    for (const file of dead) this.probeCache.delete(file);
    for (const g of this.generations) {
      g.segments = g.segments.filter((s) => !dead.has(s.file));
      g.micSegments = g.micSegments.filter((s) => !dead.has(s.file));
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
      if (g === live || g.segments.length > 0 || g.micSegments.length > 0 || !g.ended) return true;
      rmSync(g.dir, { recursive: true, force: true });
      this.csvOffsets.delete(g.csv);
      this.csvOffsets.delete(g.micCsv);
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
    // Předchozí nahrávka se ještě slepuje - nová by jí mohla sebrat kousky.
    if (this.finishing) throw new Error('busy');
    const live = this.live;
    const next = this.newGeneration(live.mimeType);
    const stopped = this.waitFor(`stopped:${live.id}`, 8000);
    this.waitFor(`started:${next.id}`, 15000).catch((e) => {
      log(`nová generace při startu nahrávání nenaběhla: ${e.message}`);
      this.setState('error', e.message, true);
    });
    this.send({ type: 'restart', generation: next.id });
    await stopped;
    this.recording = { since: Date.now(), game };
    this.writeRecordingMarker();
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
  async stopRecording(outDir: string, thumbDir = outDir): Promise<(ClipResult & { since: number })[]> {
    const rec = this.recording;
    if (!rec) throw new Error(this.finishing ? 'busy' : 'not-recording');
    if (this._state !== 'on' || !this.live) {
      // Snímání spadlo pod nahrávkou (třeba s hrou, která spadla): nic se nezahazuje -
      // úklid kousky odloží a hlavní proces je slepí jako "obnoveno po pádu".
      if (this.tearingDown || (this._state === 'error' && this.generations.length > 0)) {
        if (!this.tearingDown) void this.teardown();
        throw new Error('interrupted');
      }
      this.recording = null;
      this.writeRecordingMarker();
      throw new Error('not-capturing');
    }
    const seconds = (Date.now() - rec.since) / 1000;
    // Nahrávání končí hned (tlačítko přestane ukazovat "nahrávám"); slepení
    // běží jako "ukládá se" - kousky se do konce nemažou (prune, teardown)
    // a značka pro obnovu po pádu zůstává, dokud soubor není hotový.
    this.recording = null;
    this.recordingStopHandler = null;
    const finishing = { since: rec.since, game: rec.game, percent: null as number | null, dir: this.bufferDir };
    this.finishing = finishing;
    this.writeRecordingMarker();
    this.deps.onSavingProgress?.();
    try {
      const results = await this.saveFromBuffer(seconds, outDir, rec.game, thumbDir, {
        kind: 'recording',
        onProgress: (percent) => {
          if (this.finishing !== finishing || finishing.percent === percent) return;
          finishing.percent = percent;
          this.deps.onSavingProgress?.();
        },
      });
      // Celá nahrávka v jednom = od startu nahrávání; po částech = každá od svého začátku.
      return results.map((r) => ({ ...r, since: results.length === 1 ? rec.since : r.createdAt.getTime() }));
    } finally {
      // Ať se kousky zase mažou, i kdyby slepení selhalo.
      if (this.finishing === finishing) this.finishing = null;
      // Značka patří složce, ze které se slepovalo (snímání mezitím mohlo jet jinde).
      if (finishing.dir === this.bufferDir) this.writeRecordingMarker();
      else {
        try {
          rmSync(join(finishing.dir, 'recording.json'), { force: true });
        } catch {
          // nevadí
        }
      }
      this.deps.onSavingProgress?.();
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
  async makeClip(seconds: number, outDir: string, game: string | null, thumbDir = outDir): Promise<ClipResult> {
    const results = await this.saveFromBuffer(seconds, outDir, game, thumbDir, { kind: 'clip' });
    return results[results.length - 1];
  }

  /** Rozměry kousku ("1920x1080") - z paměti, nebo změřit (a zapamatovat; kousek se po zapsání nemění). */
  private async sizeOf(file: string): Promise<string | null> {
    if (this.probeCache.has(file)) return this.probeCache.get(file) ?? null;
    const info = await probe(file).catch(() => null);
    const size = info && info.width && info.height ? `${info.width}x${info.height}` : null;
    this.probeCache.set(file, size);
    return size;
  }

  /**
   * Klip / nahrávka ze zásobníku. Vrací uložené soubory v pořadí - klip je
   * vždycky jeden; nahrávka zápasu, během které hra měnila rozlišení
   * (alt-tab z celé obrazovky 4:3), se uloží po částech se stejnými
   * rozměry (dřív z ní zbyl jen konec po poslední změně).
   *
   * Rychlost: rozměry se neměří, když je snímací stránka hlásí stejné
   * (skoro vždy) - kraje se pro jistotu změří souběžně se slepováním, a jen
   * kdyby nesouhlasily, slepí se znovu. Náhled vzniká taky souběžně
   * (z prvního kousku = první snímek klipu) a délka se bere z plánu, ne
   * dalším spuštěním ffmpeg. Klip je tak hotový skoro hned po stisku.
   */
  private async saveFromBuffer(
    seconds: number,
    outDir: string,
    game: string | null,
    thumbDir: string,
    options: { kind: 'clip' | 'recording'; onProgress?: (percent: number) => void }
  ): Promise<ClipResult[]> {
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
        this.setState('error', e.message, true);
      });
      this.send({ type: 'restart', generation: next.id });
      await stopped;

      // Stav zásobníku si ukládání vezme hned teď. Kdyby se během dlouhého
      // ukládání nahrávky snímání rozjelo znovu (změna nastavení, zvukového
      // zařízení), seznam generací se vynuluje - a další části nahrávky by
      // se slepily bez zvuku.
      const generations = [...this.generations];
      const micSegments = this.allMicSegments();
      const chosen = selectForClip(this.allSegments(), endWall, seconds);
      if (chosen.length === 0 || totalSeconds(chosen) < 1) throw new Error('too-early');

      mkdirSync(outDir, { recursive: true });
      const createdAt = new Date(endWall);
      const isH264 = /h264|avc1/i.test(live.mimeType);
      const base = recording ? `${clipFileBase(createdAt, game)} recording` : clipFileBase(createdAt, game);
      const settings = this.deps.settings();
      const genSizes = generations.map((g) => ({ id: g.id, size: g.size, resizes: g.resizes }));

      // Když hra přepnula rozlišení (celá obrazovka 4:3, načítání), kousky
      // mají různé rozměry a slepený soubor prohlížeč nepřehraje (černo,
      // 0:00). Klip = jen souvislý konec se stejnými rozměry, nahrávka = části.
      const measure = async (): Promise<{ part: Segment[]; size: string | null }[]> => {
        const reports = generations.flatMap((g) => [...(g.startWall !== null && g.size ? [{ at: g.startWall, size: g.size }] : []), ...g.resizes]);
        const { runs, sizes } = await sizeRuns(chosen, reports, (f) => this.sizeOf(f), { maxProbes: recording ? 240 : 48 });
        const sizeOfSeg = new Map(chosen.map((s, i) => [s.file, sizes[i]]));
        const parts = recording ? recordingParts(runs) : runs.slice(-1);
        if (runs.length > 1) log(`kousky s různými rozměry (${[...new Set(sizes.filter(Boolean))].join(' -> ')}): ${recording ? `${parts.length} částí` : 'bere se jen konec'}`);
        return parts.filter((p) => p.length > 0 && totalSeconds(p) >= 1).map((part) => ({ part, size: sizeOfSeg.get(part[part.length - 1].file) ?? null }));
      };
      const hinted = reportedSize(chosen, genSizes);
      let plan = hinted ? [{ part: chosen, size: hinted }] : await measure();
      if (plan.length === 0) throw new Error('too-early');
      // Pojistka, kdyby snímací stránka změnu rozměrů nepoznala: kraje se změří souběžně se slepováním.
      const edges = hinted && chosen.length > 1 ? Promise.all([this.sizeOf(chosen[0].file), this.sizeOf(chosen[chosen.length - 1].file)]) : null;

      const save = async (list: { part: Segment[]; size: string | null }[]): Promise<ClipResult[]> => {
        const out: ClipResult[] = [];
        const total = list.reduce((sum, p) => sum + totalSeconds(p.part), 0) || 1;
        let done = 0;
        for (let i = 0; i < list.length; i++) {
          const { part, size } = list[i];
          const partBase = list.length > 1 ? `${base} ${i + 1}` : base;
          const file = uniquePath(outDir, partBase, isH264 ? '.mp4' : '.webm');
          // Náhled = první snímek = první snímek prvního kousku - souběžně se slepováním.
          const thumbJob = makeThumb(part[0].file, thumbDir, partBase);
          const gens = new Set(part.map((s) => s.generation));
          const partSeconds = totalSeconds(part);
          const result = await this.muxClip(
            part,
            settings.microphone ? micSegments : [],
            generations.filter((g) => gens.has(g.id)),
            file,
            isH264,
            settings,
            recording ? 30 * 60 * 1000 : 120000,
            live.dir,
            {
              // Dlouhá nahrávka s nižší prioritou - hra při ukládání netrhá. Klip (vteřina práce) hned.
              low: recording,
              progress: options.onProgress ? (percent) => options.onProgress!(Math.min(99, Math.round(((done + (partSeconds * percent) / 100) / total) * 100))) : undefined,
            }
          );
          done += partSeconds;
          const thumb = await thumbJob;
          const [w, h] = (size ?? '').split('x').map(Number);
          out.push({
            file,
            durationSeconds: result.videoSeconds,
            width: w > 0 ? w : null,
            height: h > 0 ? h : null,
            sizeBytes: statSync(file).size,
            thumb,
            // Nahrávka (i každá její část): kdy začala; klip: chvíle stisku.
            createdAt: recording ? new Date(part[0].startWall) : createdAt,
            audioTracks: result.audioTracks,
          });
          log(`${recording ? 'nahrávka' : 'klip'}: ${file} (${result.videoSeconds.toFixed(1)} s, ${part.length} segmentů, ${size ?? '?'}, zvuk: ${result.audioTracks.join(' + ') || 'žádný'})`);
        }
        return out;
      };

      let results = await save(plan);
      const [first, last] = edges ? await edges : [null, null];
      if (first && last && first !== last) {
        // Snímací stránka změnu nenahlásila - změřit a slepit znovu jen to, co k sobě patří.
        log(`kraje mají různé rozměry (${first} -> ${last}), ačkoli snímání nic nehlásilo - slepuji znovu`);
        for (const r of results) {
          for (const f of [r.file, r.thumb]) {
            if (!f) continue;
            try {
              unlinkSync(f);
            } catch {
              // nevadí
            }
          }
        }
        plan = await measure();
        if (plan.length === 0) throw new Error('too-early');
        results = await save(plan);
      } else if (results.length === 1 && results[0].width === null && last) {
        const [w, h] = last.split('x').map(Number);
        results[0] = { ...results[0], width: w || null, height: h || null };
      }
      return results;
    } finally {
      this.building -= 1;
    }
  }

  /**
   * Slepí vybrané kousky obrazu (se zvukem hry) a k nim zvlášť nahraný
   * mikrofon do jednoho souboru - obraz se jen kopíruje, zvuk se smíchá
   * (planClip + clipMuxArgs v editPlan). Hlasitosti, posun a samostatné
   * stopy podle nastavení.
   */
  private async muxClip(
    video: Segment[],
    micAll: Segment[],
    genInfo: GenerationAudio[],
    file: string,
    isH264: boolean,
    settings: Settings,
    timeoutMs: number,
    workDir: string,
    run: { low?: boolean; progress?: (percent: number) => void } = {}
  ): Promise<{ videoSeconds: number; audioTracks: AudioTrackKind[] }> {
    const gens = new Set(video.map((s) => s.generation));
    // Zvuk hry jen když ho mají všechny generace (concat potřebuje ve všech souborech stejné stopy).
    const hasSystemAudio = genInfo.length > 0 && genInfo.every((g) => g.hasAudio);
    const latency = Math.max(0, ...genInfo.map((g) => g.micLatencyMs));
    const plan = planClip(video, micAll.filter((m) => gens.has(m.generation)), latency);
    const videoList = join(workDir, `concat-${Date.now().toString(36)}.ffconcat`);
    writeFileSync(videoList, concatScript(plan.video));
    let micList: string | null = null;
    if (plan.mic) {
      micList = join(workDir, `mic-${Date.now().toString(36)}.ffconcat`);
      writeFileSync(micList, concatScript(plan.mic));
    }
    const input = {
      videoList,
      hasSystemAudio,
      micList,
      micOffsetMs: plan.micOffsetMs,
      systemGain: settings.systemGain,
      micGain: settings.micGain,
      audioOffsetMs: settings.audioOffsetMs,
      separateTracks: settings.separateMicTrack,
      container: (isH264 ? 'mp4' : 'webm') as 'mp4' | 'webm',
      output: file,
      durationSeconds: plan.videoSeconds,
    };
    const ffOptions = { low: run.low, totalSeconds: plan.videoSeconds, progress: run.progress };
    try {
      await runFfmpeg(clipMuxArgs(input), timeoutMs, ffOptions);
    } catch (e) {
      // Mikrofon to pokazil (poškozený kousek apod.)? Klip se uloží aspoň bez něj - hlavně obraz a hra.
      if (!micList) throw e;
      log(`slepení s mikrofonem selhalo (${(e as Error).message}) - zkouším bez mikrofonu`);
      await runFfmpeg(clipMuxArgs({ ...input, micList: null }), timeoutMs, ffOptions);
      return { videoSeconds: plan.videoSeconds, audioTracks: clipAudioTracks(hasSystemAudio, false, false) };
    } finally {
      for (const f of [videoList, micList]) {
        if (!f) continue;
        try {
          unlinkSync(f);
        } catch {
          // nevadí
        }
      }
    }
    return { videoSeconds: plan.videoSeconds, audioTracks: clipAudioTracks(hasSystemAudio, !!micList, settings.separateMicTrack) };
  }

  // ---- obnova nahrávky zápasu po pádu ---------------------------------------------

  /**
   * Popis generace na disk (gen.json): kdy začala, formát, zvuk. Podle něj
   * jde po pádu appky nebo Windows slepit rozjetou nahrávku zápasu.
   */
  private writeGenerationInfo(gen: Generation): void {
    try {
      writeFileSync(
        join(gen.dir, 'gen.json'),
        JSON.stringify({ id: gen.id, startWall: gen.startWall, mimeType: gen.mimeType, hasAudio: gen.hasAudio, hasMic: gen.hasMic, micLatencyMs: gen.micLatencyMs })
      );
    } catch {
      // Nevadí - obnova po pádu by jen tuhle generaci vynechala.
    }
  }

  /** Značka "tady se nahrává zápas" (recording.json) ve složce zásobníku - po pádu podle ní appka ví, že má co zachraňovat. */
  private writeRecordingMarker(): void {
    const file = join(this.bufferDir, 'recording.json');
    // Rozjetá nahrávka, nebo ta, která se z téhle složky právě slepuje (po pádu uprostřed slepování se obnoví).
    const rec = this.recording ?? (this.finishing && this.finishing.dir === this.bufferDir ? this.finishing : null);
    try {
      if (rec) writeFileSync(file, JSON.stringify({ since: rec.since, game: rec.game }));
      else rmSync(file, { force: true });
    } catch {
      // Nevadí - jen by se po pádu nedalo obnovit.
    }
  }

  /** Přejmenuje složku zásobníku na <název>.recover-* (mimo úklid starých složek). */
  private setAside(dir: string): boolean {
    const target = join(app.getPath('temp'), `${this.bufferName}.recover-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    try {
      renameSync(dir, target);
      log(`rozjetá nahrávka zápasu (${dir}) odložena k obnově`);
      return true;
    } catch (e) {
      log(`rozjetou nahrávku zápasu (${dir}) nejde odložit: ${(e as Error).message.split('\n')[0]}`);
      return false;
    }
  }

  /**
   * Složky zásobníku, ve kterých zůstala rozjetá nahrávka zápasu (appka nebo
   * Windows spadly uprostřed), se místo smazání odloží. Volá se při startu
   * appky a před každým startem zásobníku. Vrací, kolik se jich teď odložilo
   * a kolik celkem čeká na obnovu.
   */
  salvageLeftovers(): { moved: number; waiting: number } {
    const temp = app.getPath('temp');
    let names: string[];
    try {
      names = readdirSync(temp);
    } catch {
      return { moved: 0, waiting: 0 };
    }
    let moved = 0;
    let waiting = 0;
    for (const name of names) {
      if (name.startsWith(`${this.bufferName}.recover-`)) {
        waiting += 1;
        continue;
      }
      if (name !== this.bufferName && !name.startsWith(`${this.bufferName}-`)) continue;
      const dir = join(temp, name);
      // Složka, do které se právě nahrává, patří běžícímu zásobníku; ze které se slepuje nahrávka, té taky.
      if (dir === this.bufferDir && this.generations.length > 0) continue;
      if (this.finishing && dir === this.finishing.dir) continue;
      if (!existsSync(join(dir, 'recording.json'))) continue;
      if (this.setAside(dir)) {
        moved += 1;
        waiting += 1;
      }
    }
    return { moved, waiting };
  }

  private recoveryRun: Promise<RecoveredRecording[]> = Promise.resolve([]);

  /**
   * Slepí odložené nahrávky zápasu (salvageLeftovers) do složky s klipy -
   * jako běžnou nahrávku, jen z toho, co stihlo zůstat na disku. Složky se
   * pak smažou (i když slepení nevyjde - jinak by se o to appka pokoušela
   * při každém startu). Běží po jednom.
   */
  recoverLeftovers(outDir: string, thumbDir: string): Promise<RecoveredRecording[]> {
    const run = this.recoveryRun.catch(() => []).then(() => this.recoverAll(outDir, thumbDir));
    this.recoveryRun = run;
    return run;
  }

  private async recoverAll(outDir: string, thumbDir: string): Promise<RecoveredRecording[]> {
    const temp = app.getPath('temp');
    let names: string[];
    try {
      names = readdirSync(temp).filter((n) => n.startsWith(`${this.bufferName}.recover-`)).sort();
    } catch {
      return [];
    }
    const out: RecoveredRecording[] = [];
    for (const name of names) {
      const dir = join(temp, name);
      try {
        out.push(...(await this.recoverDir(dir, outDir, thumbDir)));
      } catch (e) {
        log(`obnova nahrávky zápasu (${name}) selhala: ${(e as Error).message}`);
      }
      try {
        // Nejdřív značka - i kdyby složka nešla smazat celá, podruhé se už neslepí (žádné dvojí klipy).
        rmSync(join(dir, 'recording.json'), { force: true });
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        log(`úklid po obnově (${name}): ${(e as Error).message.split('\n')[0]}`);
      }
    }
    return out;
  }

  private async recoverDir(dir: string, outDir: string, thumbDir: string): Promise<RecoveredRecording[]> {
    const marker = readJson(join(dir, 'recording.json'));
    if (!marker || typeof marker.since !== 'number') return [];
    const since = marker.since;
    const game = typeof marker.game === 'string' ? marker.game : null;
    const saved: SavedGeneration[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    for (const name of entries) {
      const m = /^gen-(\d+)$/.exec(name);
      if (!m) continue;
      const gdir = join(dir, name);
      const info = readJson(join(gdir, 'gen.json'));
      if (!info || typeof info.startWall !== 'number' || typeof info.mimeType !== 'string' || !info.mimeType) continue;
      const id = Number(m[1]);
      const startWall = info.startWall;
      const rows = (csv: string): Segment[] => {
        let text = '';
        try {
          text = readFileSync(join(gdir, csv), 'utf8');
        } catch {
          return [];
        }
        return parseSegmentCsv(text)
          .map((row) => toSegment(row, id, startWall, gdir, join))
          .filter((seg) => existsSync(seg.file));
      };
      saved.push({
        id,
        startWall,
        mimeType: info.mimeType,
        hasAudio: !!info.hasAudio,
        hasMic: !!info.hasMic,
        micLatencyMs: Number(info.micLatencyMs) || 0,
        video: rows('list.csv'),
        mic: info.hasMic ? rows('mic.csv') : [],
      });
    }
    const pick = recoverySegments(saved, since);
    const chosen = pick.video;
    if (chosen.length === 0 || totalSeconds(chosen) < 1) {
      log(`obnova nahrávky zápasu: v ${basename(dir)} nic k slepení`);
      return [];
    }
    // Rozměry se měří (hlášení snímací stránky po pádu nejsou) - po částech jako běžná nahrávka.
    const { runs, sizes } = await sizeRuns(chosen, [], probeSize, { maxProbes: 240 });
    const sizeOfSeg = new Map(chosen.map((s, i) => [s.file, sizes[i]]));
    const parts = recordingParts(runs).filter((p) => totalSeconds(p) >= 1);
    if (parts.length === 0) return [];
    const isH264 = /h264|avc1/i.test(pick.gens[pick.gens.length - 1].mimeType);
    mkdirSync(outDir, { recursive: true });
    const base = `${clipFileBase(new Date(since), game)} recording`;
    const out: RecoveredRecording[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partBase = parts.length > 1 ? `${base} ${i + 1}` : base;
      const file = uniquePath(outDir, partBase, isH264 ? '.mp4' : '.webm');
      const gens = new Set(part.map((s) => s.generation));
      const thumbJob = makeThumb(part[0].file, thumbDir, partBase);
      const result = await this.muxClip(part, pick.mic, pick.gens.filter((g) => gens.has(g.id)), file, isH264, this.deps.settings(), 30 * 60 * 1000, dir, { low: true });
      const thumb = await thumbJob;
      const [w, h] = (sizeOfSeg.get(part[part.length - 1].file) ?? '').split('x').map(Number);
      const recovered: RecoveredRecording = {
        file,
        durationSeconds: result.videoSeconds,
        width: w > 0 ? w : null,
        height: h > 0 ? h : null,
        sizeBytes: statSync(file).size,
        thumb,
        createdAt: new Date(part[part.length - 1].endWall),
        audioTracks: result.audioTracks,
        since: parts.length === 1 ? since : part[0].startWall,
        game,
      };
      log(`nahrávka zápasu obnovena po pádu: ${file} (${recovered.durationSeconds.toFixed(1)} s, ${part.length} segmentů, zvuk: ${result.audioTracks.join(' + ') || 'žádný'})`);
      out.push(recovered);
    }
    return out;
  }
}

/**
 * Náhled = první snímek videa (to samé, co ukáže přehrávač), mimo složku
 * s klipy. Bere se z prvního kousku (souběžně se slepováním), s nižší prioritou.
 */
async function makeThumb(file: string, thumbDir: string, base: string): Promise<string | null> {
  try {
    mkdirSync(thumbDir, { recursive: true });
    const thumb = uniquePath(thumbDir, base, '.jpg');
    await runFfmpeg(['-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], 30000, { low: true });
    return thumb;
  } catch {
    return null;
  }
}

/** Rozměry souboru ("1920x1080") změřené ffmpeg; null = nejde zjistit. */
async function probeSize(file: string): Promise<string | null> {
  const info = await probe(file).catch(() => null);
  return info && info.width && info.height ? `${info.width}x${info.height}` : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(file: string): Record<string, any> | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
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
