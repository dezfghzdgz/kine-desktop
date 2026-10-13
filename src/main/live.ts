import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CaptureCommand, CaptureEvent, CaptureState, LiveAudio, LiveEnded, LiveQuality, LiveScene, LiveStatus, Settings, Visibility } from '../shared/types';
import { LIVE_PRESETS, liveElapsed, liveErrorKind, livePresetFor } from '../shared/live';
import { LIVE_MAX_BACKLOG_BYTES, createProgressReader, liveFfmpegArgs, liveProgressSeconds, liveRetryDelay, maskLiveUrl, rtmpUrl, type LiveCompat } from './livePlan';
import { HlsWatch, parsePlaylist, pickVariant, type MediaPlaylist } from './liveHealth';
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
type LiveEvent = Extract<CaptureEvent, { type: 'live-started' | 'live-stopped' | 'live-error' | 'live-warning' }>;

export type LiveDeps = {
  capture: {
    readonly state: CaptureState;
    start: () => Promise<void>;
    sendLive: (command: Extract<CaptureCommand, { type: 'live-start' | 'live-stop' | 'live-scene' }>) => boolean;
  };
  api: () => KineApi;
  settings: () => Settings;
  siteUrl: () => string;
  spawn: (args: string[]) => ChildProcessWithoutNullStreams;
  log: (message: string) => void;
  onChange: (status: LiveStatus) => void;
  /** Hlášky hráči: jsi živě / výpadek / konec / spadlo / upload nestíhá / záznam je na Kine / kompatibilní režim. */
  notify: (kind: 'live' | 'reconnecting' | 'ended' | 'failed' | 'slow' | 'recording' | 'compat', info: { error?: string; duration?: string; url?: string }) => void;
  /**
   * Přečte text z adresy (HLS playlist vysílání u Cloudflare) - appka podle něj hlídá,
   * že diváci obraz opravdu vidí (liveHealth.ts). Bez toho se nehlídá.
   */
  fetchText?: (url: string, timeoutMs: number) => Promise<{ status: number; text: string }>;
  /** Kompatibilní režim spravil zamrzlý obraz - zapamatovat (nastavení liveCompat). */
  rememberCompat?: () => void;
  /** Jen pro test: kratší čekání (opakované Zahodit, hlídání obrazu). */
  timing?: { discardRetryGapMs?: number; healthPollMs?: number; healthFirstMs?: number; healthStallMs?: number; healthNothingMs?: number };
  /** Vysílání skončilo (hráč ho ukončil, nebo se vzdalo) - hlavní proces srovná zásobník. */
  onEnded?: () => void;
  /** Jen pro test (KINE_TEST_LIVE_URL): místo Kine místní RTMP server. */
  testUrl?: string | null;
  /**
   * Stáhne MP4 záznamu do složky s klipy a přidá ho do knihovny jako nahrávku
   * (hlavní proces); vrací cestu k souboru.
   */
  saveRecording?: (info: { url: string; title: string; endedAt: number; onProgress: (percent: number | null) => void }) => Promise<string>;
};

/** Jak dlouho čekat, než Cloudflare MP4 vyrobí (hodiny vysílání = minuty). */
const DOWNLOAD_PREPARE_MS = 25 * 60 * 1000;
/** Zahodit záznam, který Cloudflare ještě nemá / uzavírá: zkouší se tak dlouho, po tolika. */
const DISCARD_RETRY_MS = 3 * 60 * 1000;
const DISCARD_RETRY_GAP_MS = 10 * 1000;
/** Jak často se čte playlist vysílání (hlídání, že diváci obraz vidí). */
const HEALTH_POLL_MS = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDLE: LiveStatus = { state: 'idle', since: null, title: '', watchUrl: null, error: null, confirmed: null, scene: null, stats: null, viewers: null, cameraError: null, ended: null, health: null, compat: false };

export class LiveController {
  private status: LiveStatus = { ...IDLE };
  private wanted = false;
  private url: string | null = null;
  private quality: LiveQuality = '720p30';
  private bitrateKbps = 0;
  private audio: LiveAudio = { game: true, mic: true };
  /** Kamera, "Hned jsem zpět", ztlumený mikrofon - jde do recorderu při každém (znovu)připojení. */
  private scene: LiveScene | null = null;
  /** Běžící ukončování (druhé "Ukončit" počká na totéž). */
  private stopping: Promise<void> | null = null;
  /** Kdy naposledy šly ven údaje o přenosu (ať se okno nepřekresluje při každém řádku ffmpeg). */
  private statsAt = 0;
  /** Jednou za pár sekund appka Kine řekne, že vysílá (a zjistí, jestli Kine proud vidí). */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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
  /** Kine záznam po skončení zveřejní sama (nastavení "Po skončení vysílání" - zjistí se při startu). */
  private autoPublish = false;
  /** Záznam běžícího vysílání u Cloudflare (Kine ho řekne v odpovědi na "pořád vysílám") - Zahodit míří na něj. */
  private recordingUid: string | null = null;
  /** HLS vysílání u Cloudflare (z Kine) - podle něj appka hlídá, že diváci obraz vidí. */
  private hlsUrl: string | null = null;
  /** Mediální playlist (varianta z hlavního) - čte se opakovaně. */
  private hlsMediaUrl: string | null = null;
  private health: HlsWatch;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthBusy = false;
  /** Kompatibilní režim (ffmpeg kóduje obraz znovu - livePlan.ts). */
  private compat = false;
  /** Kompatibilní režim zapnutý kvůli zamrzlému obrazu v tomhle vysílání - když pomůže, zapamatuje se. */
  private compatAuto = false;
  /** Jen pro test: HLS místo toho od Kine (místní server). */
  testHlsUrl: string | null = null;

  constructor(private deps: LiveDeps) {
    this.health = new HlsWatch({ firstMs: deps.timing?.healthFirstMs, stallMs: deps.timing?.healthStallMs, nothingMs: deps.timing?.healthNothingMs });
  }

  current(): LiveStatus {
    const ended = this.status.ended;
    return { ...this.status, ended: ended ? { ...ended, video: ended.video ? { ...ended.video } : null } : null };
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
  async start(opts: {
    title: string;
    quality: LiveQuality;
    /** Prázdný = zůstane popis ze studia na Kine. */
    description?: string;
    category?: string | null;
    /** kb/s; 0 / chybí = podle kvality. */
    bitrateKbps?: number;
    game?: boolean;
    mic?: boolean;
    /** Kamera a spol. (null = jen obrazovka). */
    scene?: LiveScene | null;
  }): Promise<LiveStatus> {
    if (this.wanted) return this.current();
    // Předchozí vysílání se ještě ukončuje - nové počká, ať si nepřebíjejí spojení.
    if (this.stopping) await this.stopping;
    this.wanted = true;
    this.attempts = 0;
    this.slowWarned = false;
    this.quality = LIVE_PRESETS[opts.quality] ? opts.quality : '720p30';
    this.bitrateKbps = opts.bitrateKbps ?? 0;
    this.audio = { game: opts.game ?? true, mic: opts.mic ?? true };
    this.scene = opts.scene ?? null;
    const title = opts.title.trim().slice(0, 100);
    this.autoPublish = false;
    this.recordingUid = null;
    this.hlsUrl = null;
    this.hlsMediaUrl = null;
    this.health.reset();
    // Kompatibilní režim, když ho appka už jednou potřebovala (zamrzlý obraz) - nastavení liveCompat.
    this.compat = this.deps.settings().liveCompat === true;
    this.compatAuto = false;
    // Nové vysílání: karta minulého záznamu zmizí (nezveřejněný záznam zůstává 30 dní ve studiu na Kine).
    this.set({ ...IDLE, state: 'starting', title, scene: this.scene, compat: this.compat });
    try {
      if (this.deps.testUrl) {
        this.url = this.deps.testUrl;
        this.hlsUrl = this.testHlsUrl;
      } else {
        const api = this.deps.api();
        let setup = await api.liveSetup();
        if (!setup.configured) throw new Error('live-not-configured');
        if (!setup.migrated) throw new Error('live-not-migrated');
        if (!setup.input) setup = await api.liveCreate();
        if (!setup.input) throw new Error('live-not-configured');
        this.url = rtmpUrl(setup.input.rtmpsUrl, setup.input.streamKey);
        this.hlsUrl = setup.stream?.hlsUrl ?? null;
        this.autoPublish = setup.recordingAutoSupported && setup.recordingVisibility !== null;
        if (setup.stream?.ownerId) this.set({ watchUrl: `${this.deps.siteUrl()}/live/${setup.stream.ownerId}` });
        // Název, popis a kategorii vidí diváci. Co hráč nevyplnil v appce (popis), zůstává ze studia na Kine.
        const description = opts.description?.trim() ? opts.description.trim() : setup.stream?.description ?? '';
        const category = opts.category ?? setup.stream?.category ?? this.deps.settings().uploadCategory ?? null;
        await api
          .liveDetails({ title, description, category })
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
      this.set({ ...IDLE, error: message });
      throw e;
    }
  }

  /**
   * Ukončí vysílání: recorder dopíše poslední kousky, ffmpeg dostane konec
   * proudu, Cloudflare uzavře záznam. Stav se HNED přepne na "ukončuje se"
   * (tlačítko nejde zmáčknout znovu); další volání počká na totéž ukončení.
   */
  stop(reason: 'user' | 'quit' = 'user'): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.wanted && this.status.state === 'idle') return Promise.resolve();
    const run = this.doStop(reason).finally(() => {
      if (this.stopping === run) this.stopping = null;
    });
    this.stopping = run;
    return run;
  }

  private async doStop(reason: 'user' | 'quit'): Promise<void> {
    const wasLive = this.status.since !== null;
    const duration = liveElapsed(this.status.since);
    const title = this.status.title;
    const since = this.status.since;
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopWatchdog();
    this.stopPing();
    this.stopHealth();
    this.set({ state: 'stopping' });
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
    this.scene = null;
    this.stopPing(); // pro jistotu - kdyby ho mezitím něco znovu pustilo
    this.deps.log(`vysílání ukončeno${wasLive ? ` (${duration})` : ''}`);
    const ended = wasLive ? this.endedCard(title, duration, since) : null;
    this.set({ ...IDLE, ended });
    // Kine ať přestane ukazovat "živě" hned (při ukončení appky nejvýš 1,5 s čekání). Odpověď
    // (záznam zveřejněný automaticky) se do karty dopíše, i když přijde až po čekání.
    if (wasLive) {
      const stopped = this.signalStopped(reason === 'quit' ? 1 : 3);
      void stopped.then((result) => this.onStoppedSignal(ended, result));
      await Promise.race([stopped, new Promise((r) => setTimeout(r, reason === 'quit' ? 1500 : 4000))]);
    }
    if (wasLive && reason === 'user') this.deps.notify('ended', { duration });
    this.deps.onEnded?.();
  }

  /** Karta skončeného vysílání (záložka Živě). Id záznamu, když ho Kine během vysílání řekla. */
  private endedCard(title: string, duration: string, since: number | null): LiveEnded {
    return {
      at: Date.now(),
      since,
      duration,
      title,
      autoPending: this.autoPublish && !this.deps.testUrl,
      video: null,
      publishing: false,
      error: null,
      recordingUid: this.recordingUid,
      download: null,
      discarded: false,
      discarding: false,
      discardError: null,
    };
  }

  /**
   * "Skončil jsem" musí na Kine dojít - jinak tam vysílání visí jako živé. Při
   * chybě sítě se zkusí znovu (nejvýš `attempts`krát), ne když mezitím začalo nové vysílání.
   */
  private async signalStopped(attempts: number): Promise<Awaited<ReturnType<KineApi['liveSignal']>> | null> {
    if (this.deps.testUrl) return null;
    const waits = [0, 3000, 8000].slice(0, Math.max(1, attempts));
    for (const wait of waits) {
      if (wait) await sleep(wait);
      if (this.wanted) return null;
      const result = await this.signal('stopped');
      if (result) return result;
    }
    return null;
  }

  /** Kine odpověděla na "skončil jsem": záznam zveřejněný automaticky -> do karty a okénko s odkazem. */
  private onStoppedSignal(ended: LiveEnded | null, result: Awaited<ReturnType<KineApi['liveSignal']>> | null): void {
    let card = this.status.ended;
    if (!ended || !card || card.at !== ended.at) return; // mezitím nové vysílání / karta zavřená
    // Který záznam patří k tomuhle vysílání (Stáhnout / Zahodit míří na něj, ne na "nejnovější").
    if (result?.recordingUid && !card.recordingUid) {
      card = { ...card, recordingUid: result.recordingUid };
      this.set({ ended: card });
    }
    if (result?.recording) {
      const url = `${this.deps.siteUrl()}/watch/${result.recording.videoId}`;
      this.set({ ended: { ...card, autoPending: false, video: { id: result.recording.videoId, url, status: result.recording.status, auto: true } } });
      this.deps.log(`vysílání: záznam zveřejněný automaticky (${result.recording.videoId})`);
      this.deps.notify('recording', { url });
    } else if (card.autoPending) {
      // Automaticky to nevyšlo (záznam ještě není, starší Kine) - karta nabídne tlačítko.
      this.set({ ended: { ...card, autoPending: false } });
    }
  }

  /**
   * Záznam posledního vysílání -> video na Kine (tlačítko na kartě). Záznam,
   * který Cloudflare ještě uzavírá (minuta po konci), jde zveřejnit taky -
   * Kine ho pak chvíli zpracovává.
   */
  async publishRecording(options: { title?: string; visibility: Visibility; language?: string }): Promise<void> {
    const card = this.status.ended;
    if (!card || card.publishing || card.video || card.discarded || card.discarding) return;
    this.set({ ended: { ...card, publishing: true, error: null } });
    const title = (options.title ?? '').trim().slice(0, 150) || card.title;
    try {
      const result = await this.deps.api().livePublishRecording({ title, visibility: options.visibility, language: options.language });
      const now = this.status.ended;
      if (!now || now.at !== card.at) return;
      const url = `${this.deps.siteUrl()}/watch/${result.videoId}`;
      this.deps.log(`vysílání: záznam zveřejněný (${result.videoId}${result.alreadyPublished ? ', už byl' : ''})`);
      this.set({ ended: { ...now, title, publishing: false, autoPending: false, video: { id: result.videoId, url, status: result.status, auto: false } } });
    } catch (e) {
      const now = this.status.ended;
      if (!now || now.at !== card.at) return;
      const status = typeof (e as { status?: unknown }).status === 'number' ? ((e as { status: number }).status) : 0;
      this.deps.log(`vysílání: záznam se nepovedlo zveřejnit (${status}): ${(e as Error).message}`);
      this.set({ ended: { ...now, publishing: false, error: { status, message: ((e as Error).message ?? '').slice(0, 200) } } });
    }
  }

  /** Nastavení "Po skončení vysílání" se změnilo (i během vysílání) - karta po konci podle něj čeká na automatické zveřejnění. */
  setAutoPublish(on: boolean): void {
    this.autoPublish = on;
  }

  /** Karta pořád ta samá (mezitím nezačalo nové vysílání a nikdo ji nezavřel)? */
  private sameCard(at: number): LiveEnded | null {
    const now = this.status.ended;
    return now && now.at === at ? now : null;
  }

  /**
   * Stáhnout záznam do PC: Kine nechá u Cloudflare vyrobit MP4 (u dlouhého
   * vysílání pár minut), appka ho stáhne do složky s klipy a přidá do knihovny
   * jako nahrávku - jde pak přehrát, zkrátit i nahrát jako každý klip.
   */
  async downloadRecording(): Promise<void> {
    const card = this.status.ended;
    const save = this.deps.saveRecording;
    if (!card || !save || card.discarded || card.discarding) return;
    if (card.download && (card.download.state === 'preparing' || card.download.state === 'downloading')) return;
    const at = card.at;
    const progress = (download: NonNullable<LiveEnded['download']>, uid?: string) => {
      const now = this.sameCard(at);
      if (now) this.set({ ended: { ...now, ...(uid ? { recordingUid: uid } : {}), download } });
      return !!now;
    };
    progress({ state: 'preparing', percent: null, file: null, error: null });
    try {
      let uid = card.recordingUid || 'latest';
      let url: string | null = null;
      const deadline = Date.now() + DOWNLOAD_PREPARE_MS;
      while (!url) {
        // Karta zavřená nebo nové vysílání - dál se neptat.
        if (!this.sameCard(at)) return;
        if (Date.now() > deadline) throw new Error('Cloudflare MP4 nestihl připravit - zkus to později ve studiu na Kine.');
        let result: Awaited<ReturnType<KineApi['liveRecordingDownload']>>;
        try {
          result = await this.deps.api().liveRecordingDownload(uid);
        } catch (e) {
          const status = (e as { status?: unknown }).status;
          // Záznam ještě není v seznamu u Cloudflare (minuta po konci vysílání) - zkusit znovu.
          if (status === 404 && uid === 'latest') {
            await sleep(5000);
            continue;
          }
          throw e;
        }
        uid = result.uid;
        if (result.status === 'ready' && result.url) url = result.url;
        else {
          if (!progress({ state: 'preparing', percent: result.percent, file: null, error: null }, uid)) return;
          await sleep(3000);
        }
      }
      if (!progress({ state: 'downloading', percent: 0, file: null, error: null }, uid)) return;
      this.deps.log(`vysílání: stahuji záznam ${uid}`);
      const file = await save({
        url,
        title: card.title,
        endedAt: at,
        onProgress: (percent) => void progress({ state: 'downloading', percent, file: null, error: null }),
      });
      this.deps.log(`vysílání: záznam stažený do knihovny (${file})`);
      progress({ state: 'done', percent: 100, file, error: null });
    } catch (e) {
      this.deps.log(`vysílání: záznam se nepovedlo stáhnout: ${(e as Error).message}`);
      progress({ state: 'error', percent: null, file: null, error: ((e as Error).message ?? '').slice(0, 200) });
    }
  }

  /**
   * Zahodit záznam: smaže se u Cloudflare, nikde se neuloží (jinak by se smazal sám po 30 dnech).
   * Konkrétní záznam tohohle vysílání; když jeho id appka nezná (Cloudflare přenos za vysílání
   * nepotvrdil), záznamy z okna tohohle vysílání - "nejnovější" ne, mezitím mohlo začít jiné
   * vysílání třeba z OBS. Záznam, který Cloudflare po konci ještě zakládá nebo uzavírá, se
   * zkouší smazat znovu (DISCARD_RETRY_MS) - dřív stačilo "nevím, který záznam" a nesmazalo se nic.
   */
  async discardRecording(): Promise<void> {
    const card = this.status.ended;
    if (!card || card.video || card.discarded || card.discarding || card.publishing) return;
    if (card.download && (card.download.state === 'preparing' || card.download.state === 'downloading')) return;
    const window = card.since ? { since: card.since, until: card.at } : null;
    if (!card.recordingUid && !window) {
      this.set({ ended: { ...card, discardError: 'unknown' } });
      return;
    }
    this.set({ ended: { ...card, discarding: true, discardError: null } });
    const deadline = Date.now() + DISCARD_RETRY_MS;
    let target: string | { since: number; until: number } = card.recordingUid || window!;
    for (;;) {
      try {
        const result = await this.deps.api().liveRecordingDiscard(target);
        const now = this.sameCard(card.at);
        if (!now) return;
        this.deps.log(`vysílání: záznam zahozený (${result.uids.join(', ') || result.uid})`);
        this.set({ ended: { ...now, recordingUid: result.uid, discarding: false, discarded: true, discardError: null } });
        return;
      } catch (e) {
        const now = this.sameCard(card.at);
        if (!now) return;
        const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 0;
        const retry = (e as { retry?: unknown }).retry === true || status === 0;
        // Id nesedí (záznam u vstupu není): okno vysílání.
        if (status === 404 && !retry && typeof target === 'string' && window) {
          target = window;
          continue;
        }
        if (retry && Date.now() < deadline) {
          const gap = this.deps.timing?.discardRetryGapMs ?? DISCARD_RETRY_GAP_MS;
          this.deps.log(`vysílání: záznam zatím nejde zahodit (${status}: ${(e as Error).message}) - znovu za ${gap / 1000} s`);
          await sleep(gap);
          if (!this.sameCard(card.at)) return;
          continue;
        }
        this.deps.log(`vysílání: záznam se nepovedlo zahodit (${status}): ${(e as Error).message}`);
        this.set({ ended: { ...now, discarding: false, discardError: ((e as Error).message ?? '').slice(0, 200) || String(status) } });
        return;
      }
    }
  }

  /** Karta skončeného vysílání pryč (✕). */
  dismissEnded(): void {
    if (this.status.ended) this.set({ ended: null });
  }

  /**
   * Za běhu vysílání: kamera (zapnout / posunout / zvětšit), "Hned jsem
   * zpět", ztlumený mikrofon. Recorder to změní hned, bez nového spojení.
   */
  setScene(scene: LiveScene | null): void {
    this.scene = scene;
    if (!this.wanted) return;
    this.set({ scene, cameraError: scene?.camera ? this.status.cameraError : null });
    if (this.gen !== 0 && scene) this.deps.capture.sendLive({ type: 'live-scene', scene });
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
    if (event.type === 'live-warning') {
      // Kamera nejde (obsazená, odpojená) - vysílá se dál bez ní, hráč to uvidí v záložce Živě.
      if (!this.wanted) return;
      this.deps.log(`vysílání: ${event.kind}: ${event.message}`);
      this.set({ cameraError: event.message.slice(0, 200) });
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
    this.health.reset();
    const preset = livePresetFor(this.quality, this.bitrateKbps);
    const compat: LiveCompat | null = this.compat ? { fps: preset.fps, kbps: preset.videoKbps } : null;
    this.deps.log(`vysílání: připojuji ${maskLiveUrl(this.url)} (pokus ${this.attempts + 1}, gen ${gen}${compat ? ', kompatibilní režim' : ''})`);
    const child = this.deps.spawn(liveFfmpegArgs(this.url, compat));
    this.ffmpeg = child;
    let out = '';
    const readStats = createProgressReader();
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      let i: number;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (gen !== this.gen) continue;
        const seconds = liveProgressSeconds(line);
        if (seconds !== null) this.onProgress(seconds);
        const stats = readStats(line);
        if (stats) this.onStats(stats, child);
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
    const command = { type: 'live-start' as const, generation: gen, preset, audio: { ...this.audio }, ...(this.scene ? { scene: this.scene } : {}) };
    if (!this.deps.capture.sendLive(command)) {
      this.onFailure(gen, 'capture-off');
    }
  }

  /** Co odchází (jednou za ~2 s do okna): datový tok, snímky, rychlost a fronta v rouře. */
  private onStats(stats: { kbps: number | null; fps: number | null; speed: number | null }, child: ChildProcessWithoutNullStreams): void {
    if (!this.wanted) return; // dobíhání po Ukončit - stav už je "stopping"/idle
    const now = Date.now();
    if (now - this.statsAt < 2000) return;
    this.statsAt = now;
    const backlogMb = Math.round((child.stdin.writableLength / 1024 / 1024) * 10) / 10;
    this.set({ stats: { ...stats, backlogMb } });
  }

  private onProgress(seconds: number): void {
    // Během ukončování (1,2 s dobíhání) ffmpeg dál hlásí průběh - stav se nesmí vrátit na "živě".
    if (!this.wanted) return;
    this.lastProgressAt = Date.now();
    if (seconds < 0.5) return;
    if (this.connectedAt === null) this.connectedAt = Date.now();
    if (this.status.state !== 'live') {
      const first = this.status.since === null;
      this.set({ state: 'live', since: this.status.since ?? Date.now(), error: null });
      if (first) {
        this.deps.notify('live', {});
        void this.signal('started');
      } else {
        this.deps.log('vysílání: znovu připojeno');
        void this.signal('ping');
      }
      this.startPing();
    }
    this.startHealth();
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
      const wasLive = this.status.since !== null;
      const ended = wasLive ? this.endedCard(this.status.title, duration, this.status.since) : null;
      this.wanted = false;
      this.stopWatchdog();
      this.stopPing();
      this.stopHealth();
      this.scene = null;
      this.set({ ...IDLE, error: reason, ended });
      // I spadlé vysílání má záznam (do pádu) - karta ho nabídne.
      if (wasLive) void this.signalStopped(3).then((result) => this.onStoppedSignal(ended, result));
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

  // ---- hlášení Kine ------------------------------------------------------------------

  /** Řekne Kine, že se vysílá (started / ping) nebo že už ne. Chyba se jen zapíše - vysílání to nesmí shodit. */
  private async signal(action: 'started' | 'ping' | 'stopped'): Promise<Awaited<ReturnType<KineApi['liveSignal']>> | null> {
    if (this.deps.testUrl) return null;
    try {
      const result = await this.deps.api().liveSignal(action);
      // Záznam tohohle vysílání (Kine ho zná, jakmile přenos potvrdí Cloudflare).
      if (action !== 'stopped' && this.wanted && result.recordingUid) this.recordingUid = result.recordingUid;
      if (action !== 'stopped' && this.wanted && this.status.state === 'live') {
        const viewers = typeof result.viewers === 'number' ? result.viewers : null;
        if (this.status.confirmed !== result.confirmed || this.status.viewers !== viewers) this.set({ confirmed: result.confirmed, viewers });
      }
      return result;
    } catch (e) {
      this.deps.log(`vysílání: Kine se nepodařilo říct stav (${action}): ${(e as Error).message}`);
      return null;
    }
  }

  private startPing(): void {
    if (this.pingTimer || this.deps.testUrl) return;
    this.pingTimer = setInterval(() => {
      if (this.wanted && this.status.state === 'live') void this.signal('ping');
    }, 15_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ---- vidí diváci obraz? ---------------------------------------------------------------

  private startHealth(): void {
    if (this.healthTimer) return;
    if (!this.hlsUrl || !this.deps.fetchText) {
      if (this.status.health !== 'unknown' && this.status.state === 'live') this.set({ health: 'unknown' });
      return;
    }
    if (!this.status.health) this.set({ health: 'checking' });
    this.healthTimer = setInterval(() => void this.checkHealth(), this.deps.timing?.healthPollMs ?? HEALTH_POLL_MS);
    this.healthTimer.unref?.();
    void this.checkHealth();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.health.reset();
    this.hlsMediaUrl = null;
  }

  /** Mediální playlist vysílání u Cloudflare (null = ještě není / nejde přečíst). */
  private async readMediaPlaylist(): Promise<MediaPlaylist | null> {
    const fetchText = this.deps.fetchText;
    const hls = this.hlsUrl;
    if (!fetchText || !hls) return null;
    try {
      if (!this.hlsMediaUrl) {
        const res = await fetchText(hls, 4000);
        if (res.status !== 200) return null;
        const parsed = parsePlaylist(res.text, hls);
        if (!parsed) return null;
        if (parsed.kind === 'media') {
          this.hlsMediaUrl = hls;
          return parsed;
        }
        this.hlsMediaUrl = pickVariant(parsed);
        if (!this.hlsMediaUrl) return null;
      }
      const res = await fetchText(this.hlsMediaUrl, 4000);
      if (res.status !== 200) {
        // Varianta zmizela (nové spojení u Cloudflare) - příště znovu z hlavního playlistu.
        this.hlsMediaUrl = null;
        return null;
      }
      const parsed = parsePlaylist(res.text, this.hlsMediaUrl);
      return parsed && parsed.kind === 'media' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Jedna kontrola: přibývají u Cloudflare nové kousky? Když ne, kompatibilní režim. */
  private async checkHealth(): Promise<void> {
    if (this.healthBusy || !this.wanted || this.status.state !== 'live') return;
    const gen = this.gen;
    const since = this.connectedAt;
    if (!gen || !since) return;
    this.healthBusy = true;
    let media: MediaPlaylist | null = null;
    try {
      media = await this.readMediaPlaylist();
    } finally {
      this.healthBusy = false;
    }
    if (gen !== this.gen || !this.wanted || this.status.state !== 'live') return;
    const now = Date.now();
    this.health.observe(media, now);
    const verdict = this.health.verdict(since, now, this.status.confirmed);
    if (verdict !== this.status.health) {
      this.deps.log(`vysílání: diváci ${verdict === 'ok' ? 'obraz vidí' : verdict === 'stalled' ? 'vidí zamrzlý obraz' : verdict === 'unknown' ? '- nejde ověřit (playlist u Cloudflare nejde přečíst)' : '- čeká se na první kousky u Cloudflare'}`);
      this.set({ health: verdict });
    }
    if (verdict === 'ok' && this.compatAuto) {
      // Kompatibilní režim zamrzlý obraz spravil - příští vysílání rovnou v něm.
      this.compatAuto = false;
      this.deps.log('vysílání: kompatibilní režim pomohl - zapamatováno pro další vysílání');
      this.deps.rememberCompat?.();
    }
    if (verdict === 'stalled') this.onStalled();
  }

  /**
   * Obraz u diváků stojí: nové spojení v kompatibilním režimu (Cloudflare přenos
   * minutu drží, diváci zůstávají). Když stojí i v něm, víc appka sama neudělá -
   * hráč to vidí v záložce Živě (síť / kvalita).
   */
  private onStalled(): void {
    if (this.compat || !this.wanted) return;
    this.deps.log('vysílání: u Cloudflare nepřibývají nové kousky (diváci vidí zamrzlý obraz) - přepínám na kompatibilní režim');
    this.compat = true;
    this.compatAuto = true;
    this.deps.notify('compat', {});
    this.set({ compat: true, health: 'checking' });
    this.gen = 0;
    this.killProcess();
    this.deps.capture.sendLive({ type: 'live-stop' });
    this.health.reset();
    this.hlsMediaUrl = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.launch();
    }, 1000);
    this.retryTimer.unref?.();
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
