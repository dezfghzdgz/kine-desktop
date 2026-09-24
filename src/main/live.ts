import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CaptureCommand, CaptureEvent, CaptureState, LiveQuality, LiveStatus, Settings } from '../shared/types';
import { LIVE_PRESETS, liveElapsed, liveErrorKind } from '../shared/live';
import { LIVE_MAX_BACKLOG_BYTES, liveFfmpegArgs, liveProgressSeconds, liveRetryDelay, maskLiveUrl, rtmpUrl } from './livePlan';
import type { KineApi } from './kineApi';

/**
 * Živé vysílání z appky na Kine (tlačítko "Vysílat").
 *
 * Klíč si appka vezme z Kine (/api/live/me - stejný, jaký studio na webu
 * dává do OBS), snímací stránka pustí třetí recorder (live-start) a jeho
 * kousky jdou rourou do ffmpeg -> RTMPS na Cloudflare. Každé (znovu)
 * připojení = nová "generace": nový recorder (nová hlavička proudu) a nový
 * ffmpeg; kousky starých generací se zahodí.
 *
 * Výpadek (síť, Cloudflare, snímání se rozjelo znovu) se řeší samo: znovu
 * za 2, 3, 5... s; Cloudflare drží přenos minutu, takže diváci pokračují ve
 * stejném videu. Po posledním pokusu se vysílání vzdá a řekne proč.
 */
type LiveEvent = Extract<CaptureEvent, { type: 'live-started' | 'live-stopped' | 'live-error' }>;

export type LiveDeps = {
  capture: {
    readonly state: CaptureState;
    start: () => Promise<void>;
    sendLive: (command: Extract<CaptureCommand, { type: 'live-start' | 'live-stop' }>) => boolean;
  };
  api: () => KineApi;
  settings: () => Settings;
  siteUrl: () => string;
  spawn: (args: string[]) => ChildProcessWithoutNullStreams;
  log: (message: string) => void;
  onChange: (status: LiveStatus) => void;
  /** Hlášky hráči: jsi živě / výpadek / konec / spadlo / upload nestíhá. */
  notify: (kind: 'live' | 'reconnecting' | 'ended' | 'failed' | 'slow', info: { error?: string; duration?: string }) => void;
  /** Vysílání skončilo (hráč ho ukončil, nebo se vzdalo) - hlavní proces srovná zásobník. */
  onEnded?: () => void;
  /** Jen pro test (KINE_TEST_LIVE_URL): místo Kine místní RTMP server. */
  testUrl?: string | null;
};

export class LiveController {
  private status: LiveStatus = { state: 'idle', since: null, title: '', watchUrl: null, error: null };
  private wanted = false;
  private url: string | null = null;
  private quality: LiveQuality = '720p30';
  private nextGen = 1;
  /** Generace, která právě vysílá (0 = žádná). */
  private gen = 0;
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private stderr = '';
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private launchedAt = 0;
  private lastProgressAt = 0;
  private lastChunkAt = 0;
  /** Kdy začalo téct aktuální spojení (po minutě bez výpadku se pokusy počítají znovu). */
  private connectedAt: number | null = null;
  private slowWarned = false;

  constructor(private deps: LiveDeps) {}

  current(): LiveStatus {
    return { ...this.status };
  }

  /** Má se vysílat (i během znovupřipojení)? */
  active(): boolean {
    return this.wanted;
  }

  private set(patch: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onChange(this.current());
  }

  /** Začne vysílat. Chyba (nepřihlášený, Kine vysílání nemá...) se vrátí a nic neběží. */
  async start(opts: { title: string; quality: LiveQuality }): Promise<LiveStatus> {
    if (this.wanted) return this.current();
    this.wanted = true;
    this.attempts = 0;
    this.slowWarned = false;
    this.quality = LIVE_PRESETS[opts.quality] ? opts.quality : '720p30';
    const title = opts.title.trim().slice(0, 100);
    this.set({ state: 'starting', since: null, title, watchUrl: null, error: null });
    try {
      if (this.deps.testUrl) {
        this.url = this.deps.testUrl;
      } else {
        const api = this.deps.api();
        let setup = await api.liveSetup();
        if (!setup.configured) throw new Error('live-not-configured');
        if (!setup.migrated) throw new Error('live-not-migrated');
        if (!setup.input) setup = await api.liveCreate();
        if (!setup.input) throw new Error('live-not-configured');
        this.url = rtmpUrl(setup.input.rtmpsUrl, setup.input.streamKey);
        if (setup.stream?.ownerId) this.set({ watchUrl: `${this.deps.siteUrl()}/live/${setup.stream.ownerId}` });
        // Název vidí diváci; popis a kategorie z webového studia zůstávají.
        await api
          .liveDetails({ title, description: setup.stream?.description ?? '', category: setup.stream?.category ?? this.deps.settings().uploadCategory ?? null })
          .catch((e) => this.deps.log(`vysílání: název se nepovedlo uložit: ${(e as Error).message}`));
      }
      if (!this.wanted) return this.current();
      if (this.deps.capture.state !== 'on') await this.deps.capture.start();
      if (!this.wanted) return this.current();
      this.launch();
      this.startWatchdog();
      return this.current();
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      this.deps.log(`vysílání nezačalo: ${message}`);
      this.wanted = false;
      this.killProcess();
      this.set({ state: 'idle', since: null, error: message });
      throw e;
    }
  }

  /** Ukončí vysílání: recorder dopíše poslední kousky, ffmpeg dostane konec proudu, Cloudflare uzavře záznam. */
  async stop(reason: 'user' | 'quit' = 'user'): Promise<void> {
    if (!this.wanted && this.status.state === 'idle') return;
    const wasLive = this.status.since !== null;
    const duration = liveElapsed(this.status.since);
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopWatchdog();
    this.deps.capture.sendLive({ type: 'live-stop' });
    const child = this.ffmpeg;
    if (child) {
      // Poslední kousek z recorderu dorazí do sekundy - až pak konec proudu.
      await new Promise((r) => setTimeout(r, reason === 'quit' ? 300 : 1200));
      this.gen = 0;
      this.ffmpeg = null;
      try {
        child.stdin.end();
      } catch {
        // už zavřené
      }
      await Promise.race([new Promise((r) => child.once('close', r)), new Promise((r) => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill();
    }
    this.gen = 0;
    this.deps.log(`vysílání ukončeno${wasLive ? ` (${duration})` : ''}`);
    this.set({ state: 'idle', since: null, error: null });
    if (wasLive && reason === 'user') this.deps.notify('ended', { duration });
    this.deps.onEnded?.();
  }

  /** Kousek proudu ze snímací stránky. */
  handleChunk(generation: number, data: ArrayBuffer | Uint8Array): void {
    const child = this.ffmpeg;
    if (generation !== this.gen || !child || child.stdin.destroyed) return;
    this.lastChunkAt = Date.now();
    child.stdin.write(Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)));
    // Upload nestíhá: fronta v rouře roste - radši znovu (zahodí se, co nestihlo odejít) a říct to.
    if (this.wanted && child.stdin.writableLength > LIVE_MAX_BACKLOG_BYTES) {
      this.deps.log(`vysílání: upload nestíhá (${Math.round(child.stdin.writableLength / 1e6)} MB ve frontě)`);
      if (!this.slowWarned) {
        this.slowWarned = true;
        this.deps.notify('slow', {});
      }
      this.onFailure(generation, 'network: upload is too slow');
    }
  }

  handleEvent(event: LiveEvent): void {
    if (event.type === 'live-started') {
      if (event.generation === this.gen) this.deps.log(`vysílání gen ${event.generation}: ${event.mimeType}, ${event.width}x${event.height} @ ${event.fps} fps`);
      return;
    }
    if (!this.wanted || event.generation !== this.gen) return;
    if (event.type === 'live-error') {
      this.deps.log(`vysílání: recorder hlásí chybu: ${event.message}`);
      this.onFailure(event.generation, event.message);
      return;
    }
    // Recorder skončil, aniž by to někdo chtěl (snímání se rozjelo znovu) - navázat.
    this.onFailure(event.generation, 'capture-restart');
  }

  // ---- spojení ----------------------------------------------------------------

  /** Nová generace: ffmpeg (spojení s Cloudflare) + nový recorder ve snímací stránce. */
  private launch(): void {
    if (!this.wanted || !this.url) return;
    this.killProcess();
    const gen = this.nextGen++;
    this.gen = gen;
    this.stderr = '';
    this.launchedAt = Date.now();
    this.lastProgressAt = 0;
    this.lastChunkAt = Date.now();
    this.connectedAt = null;
    this.deps.log(`vysílání: připojuji ${maskLiveUrl(this.url)} (pokus ${this.attempts + 1}, gen ${gen})`);
    const child = this.deps.spawn(liveFfmpegArgs(this.url));
    this.ffmpeg = child;
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      let i: number;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        const seconds = liveProgressSeconds(line);
        if (seconds !== null && gen === this.gen) this.onProgress(seconds);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000);
    });
    child.stdin.on('error', (e) => {
      if (gen === this.gen) this.deps.log(`vysílání: ffmpeg stdin: ${e.message}`);
    });
    let exited = false;
    const exit = (code: number | null) => {
      if (exited) return;
      exited = true;
      if (gen !== this.gen || !this.wanted) return;
      const last = this.stderr.trim().split('\n').pop() || `ffmpeg ${code}`;
      this.deps.log(`vysílání: ffmpeg skončil (${code}): ${this.stderr.slice(-500)}`);
      this.onFailure(gen, last);
    };
    child.on('close', (code) => exit(code));
    child.on('error', (e) => {
      this.stderr += `\n${e.message}`;
      exit(-1);
    });
    if (!this.deps.capture.sendLive({ type: 'live-start', generation: gen, preset: LIVE_PRESETS[this.quality] })) {
      this.onFailure(gen, 'capture-off');
    }
  }

  private onProgress(seconds: number): void {
    this.lastProgressAt = Date.now();
    if (seconds < 0.5) return;
    if (this.connectedAt === null) this.connectedAt = Date.now();
    if (this.status.state !== 'live') {
      const first = this.status.since === null;
      this.set({ state: 'live', since: this.status.since ?? Date.now(), error: null });
      if (first) this.deps.notify('live', {});
      else this.deps.log('vysílání: znovu připojeno');
    }
    // Minuta bez výpadku = další výpadek začíná počítat pokusy od nuly.
    if (this.connectedAt && Date.now() - this.connectedAt > 60_000) this.attempts = 0;
  }

  /** Výpadek generace: zkusit znovu, nebo se vzdát. `generation` null = mimo generaci (start snímání se nepovedl). */
  private onFailure(generation: number | null, reason: string): void {
    if (!this.wanted) return;
    if (generation !== null && generation !== this.gen) return;
    this.gen = 0;
    this.killProcess();
    this.deps.capture.sendLive({ type: 'live-stop' });
    this.attempts += 1;
    // Špatný klíč se opakováním nespraví.
    const delay = liveErrorKind(reason) === 'auth' ? null : liveRetryDelay(this.attempts);
    if (delay === null) {
      this.deps.log(`vysílání se vzdává (${this.attempts} pokusů): ${reason}`);
      const duration = liveElapsed(this.status.since);
      this.wanted = false;
      this.stopWatchdog();
      this.set({ state: 'idle', since: null, error: reason });
      this.deps.notify('failed', { error: reason, duration });
      this.deps.onEnded?.();
      return;
    }
    this.deps.log(`vysílání vypadlo (${reason}) - znovu za ${delay / 1000} s`);
    if (this.status.state !== 'reconnecting') this.deps.notify('reconnecting', {});
    this.set({ state: 'reconnecting', error: reason });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.relaunch(), delay);
    this.retryTimer.unref?.();
  }

  private async relaunch(): Promise<void> {
    this.retryTimer = null;
    if (!this.wanted) return;
    if (this.deps.capture.state !== 'on') {
      try {
        await this.deps.capture.start();
      } catch (e) {
        this.onFailure(null, `capture-off: ${(e as Error).message}`);
        return;
      }
    }
    if (this.wanted) this.launch();
  }

  /** Hlídač: kousky tečou, ale Cloudflare nic nebere (visící spojení) / recorder nic neposílá. */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.wanted || this.gen === 0) return;
      const now = Date.now();
      const sinceProgress = now - (this.lastProgressAt || this.launchedAt);
      // Připojení + rozbor proudu smí trvat 30 s, pak 20 s bez posunu = visí.
      const limit = this.lastProgressAt ? 20_000 : 30_000;
      if (sinceProgress > limit) {
        this.onFailure(this.gen, 'network: connection timed out');
        return;
      }
      if (now - this.lastChunkAt > 15_000) this.onFailure(this.gen, 'capture-off: no data from recorder');
    }, 5000);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private killProcess(): void {
    const child = this.ffmpeg;
    this.ffmpeg = null;
    if (!child) return;
    try {
      child.stdin.destroy();
    } catch {
      // nic
    }
    if (child.exitCode === null) child.kill();
  }
}
