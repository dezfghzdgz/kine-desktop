import { closeSync, openSync, readSync, statSync, openAsBlob } from 'node:fs';
import type { Clip, Settings, UploadRequest } from '../shared/types';
import { gameHashtag } from '../shared/clipNaming';
import { parseHashtags } from '../shared/upload';
import type { ClipLibrary } from './clips';
import { KineApiError, type KineApi } from './kineApi';
import { TusAborted, tusUpload } from './tus';

/**
 * Fronta nahrávání klipů na Kine.
 *
 * Pravidlo číslo jedna: NIKDY nenahrávat, když se hraje. Online hra na
 * slabší wifi by kvůli uploadu lagovala. Fronta proto běží jen když
 * `blocked()` vrací null; jakmile se pustí hra, rozjeté nahrávání se
 * přeruší (AbortSignal) a po hře pokračuje od místa, kam došlo (tus umí
 * navázat). Podobně při výpadku připojení.
 *
 * Jeden klip po druhém - souběžně by si jen braly pásmo.
 */
export type { UploadRequest };

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
  private current: { request: UploadRequest; abort: AbortController } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(e: UploaderEvent) => void>();
  /** Klipy, u kterých se čeká, až je Kine zpracuje (id klipu -> zastavení čekání). */
  private waiting = new Map<string, () => void>();

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
    return this.queue.length + (this.current ? 1 : 0);
  }

  isPausedByGame(): boolean {
    return this.pending() > 0 && this.deps.blocked() === 'game';
  }

  /** Zařadí klipy; už zařazené nebo hotové přeskočí. Nastavení nahrání se uloží ke klipu (přežije restart). */
  enqueue(requests: UploadRequest[]): void {
    for (const r of requests) {
      const clip = this.deps.library.get(r.clipId);
      if (!clip || clip.deletedAt) continue;
      if (clip.upload?.state === 'done') continue;
      if (this.queue.some((q) => q.clipId === r.clipId) || this.current?.request.clipId === r.clipId) continue;
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
        if (!clip || clip.deletedAt || clip.upload?.state !== 'done') return finish();
        try {
          const status = await this.deps.api.status(videoId);
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
    if (blocked && this.current) {
      this.deps.log(`nahrávání pozastaveno (${blocked})`);
      this.current.abort.abort();
      return;
    }
    if (blocked) {
      this.markQueuedAsPaused(blocked);
      return;
    }
    if (this.current) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.next();
    }, 50);
  }

  private markQueuedAsPaused(reason: 'game' | 'offline'): void {
    for (const r of this.queue) {
      const clip = this.deps.library.get(r.clipId);
      if (!clip?.upload) continue;
      if (clip.upload.state === 'queued') this.deps.library.setUpload(r.clipId, { state: 'paused', percent: 0, reason });
      else if (clip.upload.state === 'paused' && clip.upload.reason !== reason) this.deps.library.setUpload(r.clipId, { ...clip.upload, reason });
    }
    this.emit({ type: 'changed' });
  }

  private async next(): Promise<void> {
    if (this.current) return;
    const blocked = this.deps.blocked();
    if (blocked) {
      this.markQueuedAsPaused(blocked);
      return;
    }
    const request = this.queue.shift();
    if (!request) return;
    const clip = this.deps.library.get(request.clipId);
    if (!clip || clip.deletedAt) {
      // Klip mezitím skončil v koši - nahrávat ho nemá smysl.
      void this.next();
      return;
    }

    const abort = new AbortController();
    this.current = { request, abort };
    try {
      const url = await this.uploadOne(clip, request, abort.signal);
      this.release(clip);
      const fresh = this.deps.library.get(clip.id) ?? clip;
      this.emit({ type: 'done', clip: fresh, url });
    } catch (e) {
      if (e instanceof TusAborted || abort.signal.aborted) {
        // Pauza - klip jde zpátky do čela fronty a pokračuje, až bude možné.
        const fresh = this.deps.library.get(clip.id);
        const prev = fresh?.upload;
        const percent = prev && 'percent' in prev ? prev.percent : 0;
        const carry = prev && (prev.state === 'uploading' || prev.state === 'paused') ? { tusUrl: prev.tusUrl, videoId: prev.videoId } : {};
        this.deps.library.setUpload(clip.id, { state: 'paused', percent, reason: this.deps.blocked() ?? 'offline', ...carry });
        this.queue.unshift(request);
      } else {
        const message = e instanceof Error ? e.message : String(e);
        this.release(clip);
        this.deps.log(`nahrání selhalo: ${clip.file}: ${message}`);
        this.deps.library.setUpload(clip.id, { state: 'error', message });
        this.emit({ type: 'error', clip, message });
      }
    } finally {
      this.current = null;
      this.emit({ type: 'changed' });
      if (this.queue.length > 0) this.kick();
    }
  }

  private release(clip: Clip): void {
    try {
      this.deps.releaseFile?.(clip);
    } catch {
      // Úklid kopie nesmí shodit nahrávání.
    }
  }

  private async uploadOne(clip: Clip, request: UploadRequest, signal: AbortSignal): Promise<string> {
    const { library, api } = this.deps;
    const prepared = this.deps.prepareFile ? await this.deps.prepareFile(clip) : { file: clip.file, fresh: false };
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
      const target = await api.createUploadUrl(size);
      tusUrl = target.uploadURL;
      videoId = target.videoId;
      mode = target.mode;
    }

    const setProgress = (uploaded: number) => {
      library.setUpload(clip.id, { state: 'uploading', percent: Math.min(100, Math.round((uploaded / size) * 100)), tusUrl, videoId });
    };
    setProgress(Math.round((startPercent / 100) * size));

    if (mode === 'tus') {
      const fd = openSync(file, 'r');
      try {
        await tusUpload({
          url: tusUrl,
          size,
          offset: Math.floor((startPercent / 100) * size),
          read: async (offset, length) => {
            const buffer = Buffer.alloc(length);
            const got = readSync(fd, buffer, 0, length, offset);
            return got === length ? buffer : buffer.subarray(0, got);
          },
          onProgress: setProgress,
          signal,
          fetchImpl: this.deps.fetchImpl,
        });
      } finally {
        closeSync(fd);
      }
    } else {
      await basicUpload(tusUrl, file, signal, this.deps.fetchImpl ?? fetch);
      setProgress(size);
    }

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
