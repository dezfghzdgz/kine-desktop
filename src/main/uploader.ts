import { closeSync, openSync, readSync, statSync, openAsBlob } from 'node:fs';
import type { Clip, Settings, Visibility } from '../shared/types';
import { gameHashtag } from '../shared/clipNaming';
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
export type UploadRequest = { clipId: string; visibility: Visibility; title?: string };

export type UploaderEvent =
  | { type: 'done'; clip: Clip; url: string }
  | { type: 'error'; clip: Clip; message: string }
  | { type: 'changed' };

export class Uploader {
  private queue: UploadRequest[] = [];
  private current: { request: UploadRequest; abort: AbortController } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(e: UploaderEvent) => void>();

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

  /** Zařadí klipy; už zařazené nebo hotové přeskočí. */
  enqueue(requests: UploadRequest[]): void {
    for (const r of requests) {
      const clip = this.deps.library.get(r.clipId);
      if (!clip) continue;
      if (clip.upload?.state === 'done') continue;
      if (this.queue.some((q) => q.clipId === r.clipId) || this.current?.request.clipId === r.clipId) continue;
      this.queue.push(r);
      if (r.title && r.title.trim()) this.deps.library.update(r.clipId, { title: r.title.trim().slice(0, 150) });
      // Stav se zachová, když už klip kus nahraný má (tus naváže).
      const prev = clip.upload;
      if (!prev || prev.state === 'error' || prev.state === 'queued') {
        this.deps.library.setUpload(r.clipId, { state: 'queued' });
      }
    }
    this.emit({ type: 'changed' });
    this.kick();
  }

  /** Po startu appky: co zůstalo rozjeté nebo ve frontě z minula. */
  restoreFromLibrary(): void {
    const visibility = this.deps.settings().visibility;
    const pending = this.deps.library
      .list()
      .filter((c) => c.upload && (c.upload.state === 'queued' || c.upload.state === 'paused' || c.upload.state === 'uploading'))
      .map((c) => ({ clipId: c.id, visibility }));
    if (pending.length > 0) this.enqueue(pending);
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
    if (!clip) {
      void this.next();
      return;
    }

    const abort = new AbortController();
    this.current = { request, abort };
    try {
      const url = await this.uploadOne(clip, request, abort.signal);
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

  private async uploadOne(clip: Clip, request: UploadRequest, signal: AbortSignal): Promise<string> {
    const { library, api } = this.deps;
    const size = statSync(clip.file).size;
    const prev = clip.upload;

    // Navázat na rozjeté nahrávání, když z něj něco zbylo.
    let tusUrl = prev && (prev.state === 'paused' || prev.state === 'uploading') ? prev.tusUrl : undefined;
    let videoId = prev && (prev.state === 'paused' || prev.state === 'uploading') ? prev.videoId : undefined;
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
    setProgress(prev && 'percent' in prev ? Math.round((prev.percent / 100) * size) : 0);

    if (mode === 'tus') {
      const fd = openSync(clip.file, 'r');
      try {
        await tusUpload({
          url: tusUrl,
          size,
          offset: prev && 'percent' in prev ? Math.floor((prev.percent / 100) * size) : 0,
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
      await basicUpload(tusUrl, clip.file, signal, this.deps.fetchImpl ?? fetch);
      setProgress(size);
    }

    const settings = this.deps.settings();
    const hashtags = ['klip'];
    if (clip.game) hashtags.push(gameHashtag(clip.game));
    const { id } = await api.confirm({
      title: (request.title ?? clip.title).trim().slice(0, 150) || clip.title,
      description: this.deps.describe ? this.deps.describe(clip) : clip.game ? `Clip from ${clip.game} · Kine` : 'Clip · Kine',
      cloudflareVideoId: videoId,
      language: settings.videoLanguage,
      visibility: request.visibility,
      width: clip.width,
      height: clip.height,
      hashtags,
    });

    const url = `${api.siteUrl()}/watch/${id}`;
    library.setUpload(clip.id, { state: 'done', videoId: id, url });
    return url;
  }
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
