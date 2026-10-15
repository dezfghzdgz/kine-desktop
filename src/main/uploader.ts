import { statSync, openAsBlob } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import type { Clip, Settings, UploadRequest } from '../shared/types';
import { gameHashtag } from '../shared/clipNaming';
import { parseHashtags } from '../shared/upload';
import type { ClipLibrary } from './clips';
import { KineApiError, type KineApi } from './kineApi';
import { TusAborted, tusUpload } from './tus';

/** Chyba nahrání "nejsi přihlášený" (server 401) - okno ji ukáže přeloženou. */
export const UPLOAD_ERROR_LOGIN = 'login-required';

/**
 * Fronta nahrávání klipů na Kine.
 *
 * Pravidlo číslo jedna: samo od sebe NIKDY nenahrávat, když se hraje. Online
 * hra na slabší wifi by kvůli uploadu lagovala. Fronta proto běží jen když
 * `blocked()` vrací null; jakmile se pustí hra, rozjeté nahrávání se
 * přeruší (AbortSignal) a po hře pokračuje od místa, kam došlo (tus umí
 * navázat). Podobně při výpadku připojení.
 *
 * Výjimka: klip, který hráč nahrát CHCE hned (tlačítko Nahrát / Nahrát hned,
 * `enqueue(..., { now: true })`), jede i během hraní - je to jeho volba.
 *
 * Dva pruhy: klipy (do 5 minut) a dlouhá videa (nahrávky zápasů). V každém
 * jede jedno nahrávání po druhém, ale klip nikdy nečeká, až se dohraje
 * hodinová nahrávka - dřív se klipy "nenahrávaly", protože stály ve frontě
 * za ní.
 *
 * Hráč může nahrávání zrušit (`cancel`) nebo zkusit znovu od začátku
 * (`restart`). Zrušené i nepovedené nahrávání appka řekne Kine
 * (cancelUpload) - jinak by tam dál drželo místo mezi rozpracovanými.
 */
export type { UploadRequest };

/** Klip do tolika sekund jede pruhem klipů (stejná hranice jako "klip" na Kine - lib/uploadLimits.ts). */
export const CLIP_LANE_MAX_SECONDS = 300;

export type UploadLane = 'clip' | 'long';

/** Pruh nahrávání: nahrávka zápasu a cokoli delšího než 5 minut jede zvlášť. */
export function uploadLane(clip: Pick<Clip, 'kind' | 'durationSeconds'>): UploadLane {
  if (clip.kind === 'recording') return 'long';
  const d = clip.durationSeconds;
  return typeof d === 'number' && Number.isFinite(d) && d > CLIP_LANE_MAX_SECONDS ? 'long' : 'clip';
}

const LANES: UploadLane[] = ['clip', 'long'];

type Running = {
  request: UploadRequest;
  abort: AbortController;
  /** Nahrávání u Cloudflare (lístek na Kine) - po zrušení / chybě se uvolní. */
  videoId?: string;
  /** Hráč chce zrušit / začít znovu (abort pak není pauza). */
  stop?: 'cancel' | 'restart';
  /** Soubor je nahraný, Kine ho ukládá - teď už se nic neruší. */
  confirming?: boolean;
};

export type UploaderEvent =
  | { type: 'done'; clip: Clip; url: string }
  /** Kine video zpracovala - teď je vidět v seznamech i pro ostatní. */
  | { type: 'ready'; clip: Clip; url: string }
  | { type: 'error'; clip: Clip; message: string }
  | { type: 'changed' };

/**
 * Jak často se po nahrání ptát, jestli Kine video už zpracovala: první
 * minutu každé 3 s, do čtvrté minuty každých 10 s, pak každou půlminutu
 * až do ~45 minut (dlouhá nahrávka zápasu). Potom se to nechá být - Kine
 * si zaseklá videa dodělá sama (sweepProcessing na webu).
 */
export function readySchedule(): number[] {
  const steps: number[] = [];
  for (let i = 0; i < 20; i++) steps.push(3000);
  for (let i = 0; i < 18; i++) steps.push(10000);
  for (let i = 0; i < 80; i++) steps.push(30000);
  return steps;
}

export class Uploader {
  private queue: UploadRequest[] = [];
  /** Co se právě nahrává - v každém pruhu nejvýš jedno. */
  private running = new Map<UploadLane, Running>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(e: UploaderEvent) => void>();
  /** Klipy, u kterých se čeká, až je Kine zpracuje (id klipu -> zastavení čekání). */
  private waiting = new Map<string, () => void>();
  /** Klipy, které hráč chce nahrát hned - jedou i během hraní (ne bez připojení). */
  private forced = new Set<string>();

  constructor(
    private deps: {
      library: ClipLibrary;
      api: KineApi;
      /** Proč teď nahrávat nejde: hra, offline - nebo null, když může. */
      blocked: () => 'game' | 'offline' | null;
      settings: () => Settings;
      fetchImpl?: typeof fetch;
      log: (message: string) => void;
      /** Popis videa na Kine (v jazyce appky, s odkazem na appku); bez něj krátký výchozí. */
      describe?: (clip: Clip) => string;
      /** Nahrát náhled klipu jako vlastní náhled videa na Kine (bez tohohle se náhled neposílá). */
      uploadThumbnail?: (videoId: string, file: string) => Promise<void>;
      /** Rozvrh čekání na zpracování (testy ho zkrátí). */
      readySchedule?: () => number[];
      /**
       * Soubor, který se opravdu nahraje. Klip s víc zvukovými stopami (hra +
       * mikrofon, hra, mikrofon) jde na Kine jako kopie jen s první, smíchanou
       * stopou - Kine hraje jednu. `fresh` = kopie je nová, rozjeté nahrávání
       * jiné kopie nejde navázat.
       */
      prepareFile?: (clip: Clip) => Promise<{ file: string; fresh: boolean }>;
      /** Nahrávání klipu skončilo (hotovo nebo chyba) - kopie z prepareFile může pryč. */
      releaseFile?: (clip: Clip) => void;
      /** Kapitoly videa na Kine (značky z nahrávky zápasu); prázdné = žádné. */
      chapters?: (clip: Clip) => { time: number; title: string }[];
    }
  ) {}

  on(listener: (e: UploaderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: UploaderEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Kolik klipů čeká nebo se nahrává. */
  pending(): number {
    return this.queue.length + this.running.size;
  }

  /** Čeká něco kvůli hře? (Klipy "nahrát hned" jedou i během hraní - ty se nepočítají.) */
  isPausedByGame(): boolean {
    if (this.deps.blocked() !== 'game') return false;
    const pending = [...this.queue, ...[...this.running.values()].map((r) => r.request)];
    return pending.some((r) => !this.forced.has(r.clipId));
  }

  private runningFor(clipId: string): Running | undefined {
    for (const r of this.running.values()) if (r.request.clipId === clipId) return r;
    return undefined;
  }

  private laneOf(request: UploadRequest): UploadLane {
    const clip = this.deps.library.get(request.clipId);
    return clip ? uploadLane(clip) : 'clip';
  }

  /** Uvolní nahrávání na Kine (lístek + rezerva u Cloudflare). Na pozadí, chyba nevadí - lístek jinak vyprší sám. */
  private releaseOnKine(videoId: string | undefined): void {
    if (!videoId || !this.deps.api.cancelUpload) return;
    void this.deps.api.cancelUpload(videoId).catch((e: unknown) => {
      this.deps.log(`uvolnění nahrávání ${videoId} na Kine: ${(e as Error)?.message ?? e}`);
    });
  }

  /**
   * Zrušit nahrávání klipu (tlačítko Zrušit): rozjeté se přeruší, čekající
   * vypadne z fronty, klip zůstane v appce jako nenahraný (jde nahrát znovu).
   * Vrací false, když není co rušit (nebo se právě ukládá na Kine).
   */
  cancel(clipId: string): boolean {
    const run = this.runningFor(clipId);
    if (run) {
      if (run.confirming) return false;
      run.stop = 'cancel';
      run.abort.abort();
      return true;
    }
    const idx = this.queue.findIndex((q) => q.clipId === clipId);
    if (idx >= 0) this.queue.splice(idx, 1);
    const clip = this.deps.library.get(clipId);
    const u = clip?.upload;
    if (clip && u && u.state !== 'done') {
      this.forced.delete(clipId);
      this.release(clip);
      this.deps.library.setUpload(clipId, null);
      this.releaseOnKine(u.state === 'uploading' || u.state === 'paused' ? u.videoId : undefined);
      this.deps.log(`nahrávání zrušeno: ${clip.title}`);
      this.emit({ type: 'changed' });
      return true;
    }
    if (idx >= 0) {
      this.emit({ type: 'changed' });
      return true;
    }
    return false;
  }

  /**
   * Zkusit nahrát znovu od začátku (tlačítko Znovu / Zkusit znovu): staré
   * nahrávání se zahodí (i na Kine) a klip jde hned znovu - i během hraní,
   * jako "Nahrát hned".
   */
  restart(clipId: string): boolean {
    const clip = this.deps.library.get(clipId);
    if (!clip || clip.deletedAt || clip.upload?.state === 'done') return false;
    const run = this.runningFor(clipId);
    if (run) {
      if (run.confirming) return false;
      run.stop = 'restart';
      run.abort.abort();
      return true;
    }
    const request = this.queue.find((q) => q.clipId === clipId) ?? clip.uploadOptions ?? { clipId, visibility: this.deps.settings().visibility };
    this.queue = this.queue.filter((q) => q.clipId !== clipId);
    const u = clip.upload;
    this.release(clip);
    this.releaseOnKine(u && (u.state === 'uploading' || u.state === 'paused') ? u.videoId : undefined);
    this.deps.library.setUpload(clipId, null);
    this.enqueue([{ ...request, clipId }], { now: true });
    return true;
  }

  /** Jede tenhle klip i během hraní (hráč ho chtěl nahrát hned)? */
  isForced(clipId: string): boolean {
    return this.forced.has(clipId);
  }

  /**
   * Zařadí klipy; už zařazené nebo hotové přeskočí. Nastavení nahrání se uloží ke klipu (přežije restart).
   * `now`: hráč klikl Nahrát - klipy jedou hned, i když se zrovna hraje (už zařazený klip se tím rozjede).
   */
  enqueue(requests: UploadRequest[], opts: { now?: boolean } = {}): void {
    for (const r of requests) {
      const clip = this.deps.library.get(r.clipId);
      if (!clip || clip.deletedAt) continue;
      if (clip.upload?.state === 'done') continue;
      if (opts.now) this.forced.add(r.clipId);
      if (this.queue.some((q) => q.clipId === r.clipId) || this.runningFor(r.clipId)) continue;
      const request: UploadRequest = { ...r, title: r.title?.trim().slice(0, 150) || undefined };
      this.queue.push(request);
      const patch: Partial<Clip> = { uploadOptions: request };
      if (request.title) patch.title = request.title;
      this.deps.library.update(r.clipId, patch);
      // Stav se zachová, když už klip kus nahraný má (tus naváže).
      const prev = clip.upload;
      if (!prev || prev.state === 'error' || prev.state === 'queued') {
        this.deps.library.setUpload(r.clipId, { state: 'queued' });
      }
    }
    this.emit({ type: 'changed' });
    this.kick();
  }

  /** Po startu appky: co zůstalo rozjeté nebo ve frontě z minula; a u nahraných, co Kine ještě nezpracovala, se čeká dál. */
  restoreFromLibrary(): void {
    const visibility = this.deps.settings().visibility;
    const clips = this.deps.library.list();
    const pending = clips
      .filter((c) => c.upload && (c.upload.state === 'queued' || c.upload.state === 'paused' || c.upload.state === 'uploading'))
      .map((c) => c.uploadOptions ?? { clipId: c.id, visibility });
    if (pending.length > 0) this.enqueue(pending);
    for (const c of clips) {
      if (c.upload?.state === 'done' && c.upload.ready === false) this.watchReady(c.id, c.upload.videoId, c.upload.url);
    }
  }

  /**
   * Po nahrání: Kine video teprve zpracovává a do té doby ho nikde
   * neukazuje. Appka se ptá dokola (readySchedule), a až je hotovo, klip
   * dostane ready: true a ohlásí se 'ready' (toast "Klip je na Kine").
   */
  watchReady(clipId: string, videoId: string, url: string): void {
    if (this.waiting.has(clipId)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    this.waiting.set(clipId, () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    });
    const finish = () => {
      this.waiting.delete(clipId);
    };
    const run = async () => {
      for (const pause of (this.deps.readySchedule ?? readySchedule)()) {
        if (stopped) return finish();
        await new Promise<void>((r) => {
          timer = setTimeout(r, pause);
        });
        if (stopped) return finish();
        const clip = this.deps.library.get(clipId);
        if (!clip || clip.upload?.state !== 'done') return finish();
        // V koši se neptá, ale čeká se dál - Vrátit (i z lišty po smazání) ho vrátí i s čekáním.
        if (clip.deletedAt) continue;
        try {
          const status = await this.deps.api.status(videoId, (percent) => {
            // Průběh zpracování na kartě klipu ("Kine ho zpracovává… 45 %").
            const now = this.deps.library.get(clipId)?.upload;
            if (now?.state === 'done' && now.ready === false && now.processing !== percent) {
              this.deps.library.setUpload(clipId, { state: 'done', videoId, url, ready: false, processing: percent });
            }
          });
          if (status === 'ready') {
            this.deps.library.setUpload(clipId, { state: 'done', videoId, url, ready: true });
            this.deps.log(`Kine video zpracovala: ${clip.title}`);
            finish();
            this.emit({ type: 'ready', clip: this.deps.library.get(clipId) ?? clip, url });
            return;
          }
          if (status === 'not-found') {
            // Video na Kine není (smazané?) - nemá cenu se ptát dál.
            this.deps.log(`video ${videoId} na Kine není - čekání na zpracování končí`);
            return finish();
          }
        } catch (e) {
          // Výpadek při dotazu nevadí, zkusí se dál - video se zpracovává i bez nás.
          this.deps.log(`dotaz na stav videa ${videoId}: ${(e as Error).message}`);
        }
      }
      finish();
    };
    void run();
  }

  /** Přestat čekat na zpracování (konec appky). */
  stopWaiting(): void {
    for (const stop of this.waiting.values()) stop();
    this.waiting.clear();
  }

  /** Zavolat, když se změní stav hry / připojení: přeruší nebo rozjede. */
  kick(): void {
    const blocked = this.deps.blocked();
    if (blocked) {
      for (const run of this.running.values()) {
        // Klip "nahrát hned" se kvůli hře nepřeruší (bez připojení ano).
        if (!run.stop && (blocked === 'offline' || !this.forced.has(run.request.clipId))) {
          this.deps.log(`nahrávání pozastaveno (${blocked})`);
          run.abort.abort();
        }
      }
      this.markQueuedAsPaused(blocked);
      // Během hraní se rozjede klip, který hráč chce nahrát hned (když je jeho pruh volný).
      if (blocked === 'game' && this.queue.some((q) => this.forced.has(q.clipId) && !this.running.has(this.laneOf(q)))) this.schedule();
      return;
    }
    if (this.queue.some((q) => !this.running.has(this.laneOf(q)))) this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fill();
    }, 50);
  }

  private markQueuedAsPaused(reason: 'game' | 'offline'): void {
    for (const r of this.queue) {
      if (reason === 'game' && this.forced.has(r.clipId)) continue;
      const clip = this.deps.library.get(r.clipId);
      if (!clip?.upload) continue;
      if (clip.upload.state === 'queued') this.deps.library.setUpload(r.clipId, { state: 'paused', percent: 0, reason });
      else if (clip.upload.state === 'paused' && clip.upload.reason !== reason) this.deps.library.setUpload(r.clipId, { ...clip.upload, reason });
    }
    this.emit({ type: 'changed' });
  }

  /** Rozjede nahrávání v každém volném pruhu (během hraní jen klipy "nahrát hned"). */
  private fill(): void {
    const blocked = this.deps.blocked();
    if (blocked && blocked !== 'game') {
      this.markQueuedAsPaused(blocked);
      return;
    }
    if (blocked === 'game') this.markQueuedAsPaused('game');
    for (const lane of LANES) {
      if (this.running.has(lane)) continue;
      for (;;) {
        const idx = this.queue.findIndex((q) => this.laneOf(q) === lane && (blocked !== 'game' || this.forced.has(q.clipId)));
        if (idx < 0) break;
        const request = this.queue.splice(idx, 1)[0];
        const clip = this.deps.library.get(request.clipId);
        // Klip mezitím skončil v koši - nahrávat ho nemá smysl.
        if (!clip || clip.deletedAt) continue;
        void this.run(lane, request, clip);
        break;
      }
    }
  }

  private async run(lane: UploadLane, request: UploadRequest, clip: Clip): Promise<void> {
    const abort = new AbortController();
    const run: Running = { request, abort };
    this.running.set(lane, run);
    let again: UploadRequest | null = null;
    try {
      const url = await this.uploadOne(clip, request, abort.signal, run);
      this.release(clip);
      this.forced.delete(clip.id);
      const fresh = this.deps.library.get(clip.id) ?? clip;
      this.emit({ type: 'done', clip: fresh, url });
    } catch (e) {
      if (run.stop) {
        // Hráč nahrávání zrušil (nebo ho chce znovu od začátku): nic se nenavazuje,
        // klip je zase nenahraný a Kine nahrávání uvolní.
        const prev = this.deps.library.get(clip.id)?.upload;
        const videoId = run.videoId ?? (prev && (prev.state === 'uploading' || prev.state === 'paused') ? prev.videoId : undefined);
        this.release(clip);
        this.forced.delete(clip.id);
        this.deps.library.setUpload(clip.id, null);
        this.releaseOnKine(videoId);
        this.deps.log(run.stop === 'restart' ? `nahrávání znovu od začátku: ${clip.title}` : `nahrávání zrušeno: ${clip.title}`);
        if (run.stop === 'restart') again = { ...request };
      } else if (e instanceof TusAborted || abort.signal.aborted) {
        // Pauza - klip jde zpátky do čela fronty a pokračuje, až bude možné.
        const fresh = this.deps.library.get(clip.id);
        const prev = fresh?.upload;
        const percent = prev && 'percent' in prev ? prev.percent : 0;
        const carry = prev && (prev.state === 'uploading' || prev.state === 'paused') ? { tusUrl: prev.tusUrl, videoId: prev.videoId } : {};
        this.deps.library.setUpload(clip.id, { state: 'paused', percent, reason: this.deps.blocked() ?? 'offline', ...carry });
        this.queue.unshift(request);
      } else {
        // Nepřihlášený / prošlé přihlášení: místo české hlášky serveru kód, okno a okénko ho přeloží.
        const status = (e as { status?: unknown })?.status;
        const message = status === 401 ? UPLOAD_ERROR_LOGIN : e instanceof Error ? e.message : String(e);
        this.release(clip);
        this.forced.delete(clip.id);
        // Nepovedený pokus nesmí na Kine dál držet místo mezi rozpracovanými (Zkusit znovu začne od začátku).
        if (!run.confirming) this.releaseOnKine(run.videoId);
        this.deps.log(`nahrání selhalo: ${clip.file}: ${message}`);
        this.deps.library.setUpload(clip.id, { state: 'error', message });
        this.emit({ type: 'error', clip, message });
      }
    } finally {
      this.running.delete(lane);
      this.emit({ type: 'changed' });
      if (again) this.enqueue([again], { now: true });
      else if (this.queue.length > 0) this.kick();
    }
  }

  private release(clip: Clip): void {
    try {
      this.deps.releaseFile?.(clip);
    } catch {
      // Úklid kopie nesmí shodit nahrávání.
    }
  }

  private async uploadOne(clip: Clip, request: UploadRequest, signal: AbortSignal, run?: Running): Promise<string> {
    const { library, api } = this.deps;
    const prepared = this.deps.prepareFile ? await this.deps.prepareFile(clip) : { file: clip.file, fresh: false };
    if (signal.aborted) throw new TusAborted();
    const file = prepared.file;
    const size = statSync(file).size;
    const prev = clip.upload;

    // Navázat na rozjeté nahrávání, když z něj něco zbylo (a nahrává se pořád ten samý soubor).
    const resumable = !!prev && (prev.state === 'paused' || prev.state === 'uploading') && !(prepared.fresh && file !== clip.file);
    let tusUrl = resumable && prev && (prev.state === 'paused' || prev.state === 'uploading') ? prev.tusUrl : undefined;
    let videoId = resumable && prev && (prev.state === 'paused' || prev.state === 'uploading') ? prev.videoId : undefined;
    const startPercent = resumable && prev && 'percent' in prev ? prev.percent : 0;
    let mode: 'tus' | 'basic' = 'tus';

    if (!tusUrl || !videoId) {
      // Staré rozjeté nahrávání, na které se už nenaváže (nová kopie souboru): ať na Kine nedrží místo.
      if (prev && (prev.state === 'paused' || prev.state === 'uploading') && prev.videoId) this.releaseOnKine(prev.videoId);
      // Délka jde Kine (rezerva u Cloudflare a limity - na webu lib/uploadLimits.ts). Upravený
      // klip (zpomalení, střih) může mít jinou délku než originál - pak ji Kine odhadne sama.
      const duration = file === clip.file && Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0 ? clip.durationSeconds : null;
      const target = await api.createUploadUrl(size, duration, signal);
      tusUrl = target.uploadURL;
      videoId = target.videoId;
      mode = target.mode;
    }
    if (run) run.videoId = videoId;
    if (signal.aborted) throw new TusAborted();

    const setProgress = (uploaded: number) => {
      library.setUpload(clip.id, { state: 'uploading', percent: Math.min(100, Math.round((uploaded / size) * 100)), tusUrl, videoId });
    };
    setProgress(Math.round((startPercent / 100) * size));

    if (mode === 'tus') {
      const handle = await openFile(file, 'r');
      try {
        await tusUpload({
          url: tusUrl,
          size,
          offset: Math.floor((startPercent / 100) * size),
          // Čte se asynchronně: kus má až 64 MiB a synchronní čtení by na pomalém
          // disku na chvíli zastavilo hlavní proces (okna, zkratky, oznámení).
          read: async (offset, length) => {
            const buffer = Buffer.allocUnsafe(length);
            let got = 0;
            while (got < length) {
              const { bytesRead } = await handle.read(buffer, got, length - got, offset + got);
              if (bytesRead === 0) break;
              got += bytesRead;
            }
            return got === length ? buffer : buffer.subarray(0, got);
          },
          onProgress: setProgress,
          signal,
          fetchImpl: this.deps.fetchImpl,
        });
      } finally {
        await handle.close().catch(() => undefined);
      }
    } else {
      await basicUpload(tusUrl, file, signal, this.deps.fetchImpl ?? fetch);
      setProgress(size);
    }

    // Soubor je celý u Cloudflare: od teď se ukládá na Kine a nic se neruší.
    if (signal.aborted) throw new TusAborted();
    if (run) run.confirming = true;
    const settings = this.deps.settings();
    const { id } = await api.confirm({
      title: (request.title ?? clip.title).trim().slice(0, 150) || clip.title,
      description: request.description?.trim() || (this.deps.describe ? this.deps.describe(clip) : clip.game ? `Clip from ${clip.game} · Kine` : 'Clip · Kine'),
      cloudflareVideoId: videoId,
      language: request.language || settings.videoLanguage,
      visibility: request.visibility,
      width: clip.width,
      height: clip.height,
      hashtags: request.hashtags ?? defaultHashtags(clip, settings),
      category: request.category || settings.uploadCategory || 'catGaming',
      madeForKids: request.madeForKids ?? false,
      hasPaidPromotion: request.hasPaidPromotion ?? false,
      isAiGenerated: request.isAiGenerated ?? false,
      chapters: this.deps.chapters?.(clip) ?? [],
    });

    const url = `${api.siteUrl()}/watch/${id}`;
    // Nahrané - ale Kine ho ještě zpracovává; vidět bude až po 'ready' (watchReady).
    library.setUpload(clip.id, { state: 'done', videoId: id, url, ready: false });

    // Náhled z appky jako náhled na Kine (stejná karta tady i tam). Když to nejde, video zůstane s náhledem od Kine.
    const wantThumb = request.thumbnail ?? settings.uploadThumbnail;
    if (wantThumb && clip.thumb && this.deps.uploadThumbnail) {
      try {
        await this.deps.uploadThumbnail(id, clip.thumb);
      } catch (e) {
        this.deps.log(`náhled na Kine se nepovedl: ${(e as Error).message}`);
      }
    }
    this.watchReady(clip.id, id, url);
    return url;
  }
}

/** Hashtagy, když si hráč žádné nenapsal: "klip", hra a to, co má v nastavení. */
export function defaultHashtags(clip: Clip, settings: Settings): string[] {
  const tags = ['klip'];
  if (clip.game) tags.push(gameHashtag(clip.game));
  for (const tag of parseHashtags(settings.uploadHashtags ?? '')) if (!tags.includes(tag)) tags.push(tag);
  return tags.slice(0, 15);
}

/**
 * Nahrání jedním požadavkem (když server vrátí mode "basic"). Bez
 * průběhu a bez navázání - používá se jen, kdyby Kine neuměla tus.
 */
async function basicUpload(url: string, file: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<void> {
  const blob = await openAsBlob(file);
  const form = new FormData();
  form.append('file', blob, 'clip');
  const res = await fetchImpl(url, { method: 'POST', body: form, signal });
  if (!res.ok) throw new KineApiError(`Cloudflare odmítl soubor (kód ${res.status}).`, res.status);
}
