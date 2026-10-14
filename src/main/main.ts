import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpus, homedir, release, totalmem } from 'node:os';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { basename, dirname, extname, join } from 'node:path';
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  Tray,
  WebContentsView,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  screen,
  session,
  shell,
} from 'electron';
import {
  CATEGORY_KEYS,
  TRASH_DAYS,
  VISIBILITIES,
  type AppNotice,
  type AudioLevels,
  type CaptureEvent,
  type Clip,
  type DisplayInfo,
  type LiveAfterStream,
  type LiveQuality,
  type LiveScene,
  type LiveStatus,
  type ResourceUsage,
  type Settings,
  type SmartAppControlState,
  type Status,
  type UpdateIssue,
  type UploadRequest,
  type Visibility,
} from '../shared/types';
import { GB, storageCleanupPlan } from '../shared/storage';
import { chaptersText, markerChapters, parseHashtags } from '../shared/upload';
import { hexToRgbTriplet } from '../shared/plan';
import { makeT, type Key } from '../shared/i18n';
import { hotkeyLabel } from '../shared/hotkeys';
import { clipFileBase, defaultClipTitle, safeFilePart } from '../shared/clipNaming';
import { DISCORD_FILE_MAX_BYTES } from '../shared/settingsSchema';
import { maxClipSecondsFor } from '../shared/plan';
import { performanceProfile } from '../shared/performance';
import { initLog, log, logDir, tailLog } from './log';
import { SettingsStore } from './settings';
import { ClipLibrary } from './clips';
import { CaptureManager } from './capture';
import { GameWatcher, type DetectedGame } from './games';
import { GameEvents } from './gameEvents';
import { KNOWN_GAMES } from './gamesParse';
import { Auth } from './auth';
import { checkSiteMove } from './siteMove';
import { createKineApi, type KineApi } from './kineApi';
import { UPLOAD_ERROR_LOGIN, Uploader } from './uploader';
import { Toast, type ToastHandle, type ToastOptions } from './toast';
import {
  checkForUpdates,
  downloadUpdateNow,
  initUpdater,
  installUpdateNow,
  onGameEnded as updaterGameEnded,
  onUpdateProgress,
  smartAppControlState,
  takeUpdateOutcome,
  updateProgress,
} from './updater';
import { runTestDriver } from './testDriver';
import { WinHelper } from './winHelper';
import { NativeLoopback } from './audioLoopback';
import { ClipCompressor } from './compress';
import { compressSummary, COMPRESS_LEVELS, type CompressLevel } from '../shared/compress';
import { makeGif, makeThumbnail, mergeClips, trimClip } from './edit';
import { probe, runFfmpeg, spawnFfmpeg } from './ffmpeg';
import { LiveController } from './live';
import { LIVE_QUALITIES, cleanLiveError, liveElapsed, liveErrorTextKey, looksLikeLiveThumbnail } from '../shared/live';
import { GIF_MAX_SECONDS, normalizeSpeed, shiftMarkers, type TextPosition } from './editPlan';
import { APP_USER_MODEL_IDS, PRODUCT_NAMES, detectVariant, modeForVariant, siblingExe } from './variant';
import { brandIcon, trayIcon } from './icon';
import { HotkeyManager, type HotkeyId, type HotkeyReason } from './hotkeys';

/**
 * Kine do PC - hlavní proces.
 *
 * Appka žije v liště u hodin. Hlídá, jestli běží hra (games.ts, na
 * Windows s pomocníkem winHelper.ts, který ví, které okno je v popředí);
 * když ano, drží posledních N sekund obrazu (capture.ts). Zkratka
 * (hotkeys.ts) uloží klip (clips.ts), po hře se klipy nabídnou k nahrání
 * nebo nahrají samy (uploader.ts) - ale nikdy během hraní.
 *
 * Dvě appky ze stejného kódu (variant.ts): "Kine" (Kine do PC - v okně
 * je první záložka "Kine", web Kine vložený jako WebContentsView, klipy
 * a nastavení hned vedle) a "Kine Clipper" (jen klipovač: okno s klipy
 * a nastavením, Kine se otvírá v prohlížeči).
 */

const PRELOAD = join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DIR = join(__dirname, '..', 'renderer');
/** Která ze dvou appek běží (Kine do PC / Kine Clipper) - viz variant.ts. */
const VARIANT = detectVariant();
const PRODUCT = PRODUCT_NAMES[VARIANT];

/** Úprava klipu z okna (přehrávač): výběr, zvuk, formát, rychlost, text. */
type TrimIpcRequest = {
  start: number;
  end: number;
  mute: boolean;
  mode: 'new' | 'replace';
  vertical?: 'left' | 'center' | 'right' | 'blur';
  audio?: 'mix' | 'game' | 'mic' | 'none';
  speed?: number;
  /** Text přes video jako PNG (nakreslené oknem) a kde leží. */
  text?: { png: Uint8Array | ArrayBuffer; position: TextPosition } | null;
};
const ICON_PNG = join(app.getAppPath(), 'build', VARIANT === 'clipper' ? 'icon-clipper.png' : 'icon.png');
/** Volné místo na disku, kde leží složka; když to nejde zjistit, -1. */
function freeDiskBytes(dir: string): number {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return -1;
  }
}

/**
 * Požadavky na nahrání z oken: nevěří se ničemu, každé pole se očistí
 * (viditelnost jen známá, hashtagy přes parseHashtags, texty ořezané).
 */
function sanitizeUploadRequests(raw: unknown, settings: Settings): UploadRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: UploadRequest[] = [];
  for (const item of raw) {
    const r = item as Record<string, unknown> | null;
    if (!r || typeof r.clipId !== 'string') continue;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const category = typeof r.category === 'string' && (CATEGORY_KEYS as readonly string[]).includes(r.category) ? r.category : undefined;
    const language = typeof r.language === 'string' && /^[a-z]{2}(-[a-z]{2})?$/i.test(r.language) ? r.language.toLowerCase() : undefined;
    out.push({
      clipId: r.clipId,
      visibility: (VISIBILITIES as readonly string[]).includes(r.visibility as string) ? (r.visibility as Visibility) : settings.visibility,
      title: str(r.title, 150),
      description: str(r.description, 5000),
      hashtags: Array.isArray(r.hashtags) ? parseHashtags(r.hashtags.filter((x) => typeof x === 'string').join(' ')) : undefined,
      category,
      language,
      madeForKids: flag(r.madeForKids),
      hasPaidPromotion: flag(r.hasPaidPromotion),
      isAiGenerated: flag(r.isAiGenerated),
      thumbnail: flag(r.thumbnail),
    });
  }
  return out;
}

function mimeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  return ext === '.gif' ? 'image/gif' : ext === '.webm' ? 'video/webm' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
}

// Pro zkoušky: vlastní složka s daty, ať se nesahá na skutečné nastavení.
if (process.env.KINE_USER_DATA) app.setPath('userData', process.env.KINE_USER_DATA);

// Jedna instance: druhé spuštění jen předá argumenty (kine:// odkaz) té první.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

if (!app.isDefaultProtocolClient('kine')) {
  app.setAsDefaultProtocolClient('kine');
}

class KineApp {
  settings!: SettingsStore;
  library!: ClipLibrary;
  /** Zmenšování klipů na pozadí (Klipy -> úložiště). */
  compressor!: ClipCompressor;
  /** Klip otevřený v přehrávači (okno drží soubor) - zmenšování ho přeskočí. */
  private playerClipId: string | null = null;
  capture!: CaptureManager;
  /** Živé vysílání z appky na Kine (tlačítko Vysílat). */
  live!: LiveController;
  private kineApi!: KineApi;
  /** Okno s chatem vlastního vysílání (Twitch "popout chat"). */
  private chatWindow: BrowserWindow | null = null;
  /** Zásobník rozjelo až vysílání (nebyla hra / ruční režim) - po konci vysílání se zase vypne. */
  private liveStartedCapture = false;
  games!: GameWatcher;
  gameEvents!: GameEvents;
  /** Má ikona u hodin právě červenou tečku (nahrávání)? Ať se obrázek nemění při každém rebuildTray. */
  private trayDotShown = false;
  /** Výchozí výstup zvuku se změnil během nahrávání zápasu - po uložení nahrávky se snímání rozjede znovu. */
  private restartAfterRecording = false;
  /** Kdy se naposledy hlásilo ticho zvuku hry (jednou za start zásobníku stačí). */
  private silenceWarnedFor: number | null = null;
  private lastAudioRestart = 0;
  auth!: Auth;
  uploader!: Uploader;
  toast!: Toast;
  helper: WinHelper | null = null;
  /** Zvuk hry přímo z Windows (WASAPI loopback přes pomocníka) - jen když ho Chromium otevřít nejde. */
  loopback: NativeLoopback | null = null;
  hotkeys!: HotkeyManager;
  tray: Tray | null = null;
  settingsWindow: BrowserWindow | null = null;
  reviewWindow: BrowserWindow | null = null;
  /** Web Kine vložený do hlavního okna (režim "Kine + klipy"). */
  kineView: WebContentsView | null = null;
  kineViewShown = false;
  /** Stránka chce web vidět (záložka Kine) - i když se zrovna nenačetl. */
  kineViewWanted = false;
  /** Web se nenačetl (bez internetu) - pod ním zůstane náš text s tlačítkem Obnovit. */
  kineViewFailed = false;
  pendingKinePath: string | null = null;
  /** Srovnávání přihlášení appka <-> web v okně (jen jedno naráz, s odstupem po neúspěchu). */
  loginSyncBusy = false;
  loginSyncNextAt = 0;
  /** Kdo byl naposledy přihlášený ve webu v okně (id uživatele) - podle toho se pozná odhlášení nebo změna účtu. */
  lastWebUser: string | null | undefined = undefined;
  /** Aktuální "hraní": všechny klipy z něj se po hře nabídnou naráz. */
  sessionId = randomUUID();
  paused = false;
  browserLoginWaiting = false;
  clipChain: Promise<unknown> = Promise.resolve();
  warnedOnce = new Set<string>();
  /** Kdy appka naběhla - prvních pár desítek sekund se nic nehlásí okénkem (jen v okně). */
  private readonly startedAt = Date.now();
  /** Tichá upozornění v okně (postranní panel) místo okének a systémových oznámení. */
  private notices: AppNotice[] = [];
  /** Poslední aktualizace neprošla (O appce řekne proč) - do zavření hráčem. */
  private updateIssue: UpdateIssue | null = null;
  /** Smart App Control ve Windows 11 (zjišťuje se po startu a před aktualizací). */
  private smartAppControl: SmartAppControlState | null = null;
  /** Nahrávka zápasu se ukládá - další stisk / konec hry počká na totéž uložení (žádné dvojí soubory). */
  private finishingRecording: Promise<Clip | null> | null = null;
  private storageLimitTimer: NodeJS.Timeout | null = null;
  private hotkeyCheckTimer: NodeJS.Timeout | null = null;
  /** Kolik klipů se právě ukládá (stisk -> soubor). */
  private clipsSaving = 0;
  /** Režim "pořád" s volbou "počkat na první hru": snímání se rozjede až s první hrou. */
  private waitingForFirstGame = false;
  /** Obrazovka "Hned jsem zpět" a ztlumený mikrofon ve vysílání (jen za běhu, neukládá se). */
  private liveBrb = false;
  private liveMicMuted = false;
  /** Na baterii se snímá úsporně - zjišťuje se při startu snímání. */
  private batterySaving = false;

  /** Kine do PC ('full') nebo Kine Clipper ('clipper'). */
  readonly variant = VARIANT;

  t(key: Key, vars?: Record<string, string | number>): string {
    return makeT(this.settings.get().lang)(key, vars);
  }

  /** Má hráč Klipy Plus (automatické nahrávání, dlouhé klipy)? Bez přihlášení ne. */
  hasClipsPlus(): boolean {
    return this.auth.current()?.clipsPlus === true;
  }

  /** Co se má stát po hře - "auto" je jen v Klipy Plus, jinak se chová jako "review". */
  effectiveAfterGame(): Settings['afterGame'] {
    const wanted = this.settings.get().afterGame;
    return wanted === 'auto' && !this.hasClipsPlus() ? 'review' : wanted;
  }

  /** Kolik výkonu smí appka brát - intervaly hlídání apod. (shared/performance.ts). */
  profile() {
    return performanceProfile(this.settings.get().performance);
  }

  /** Pomocník pro Windows dostane časování podle nastavení výkonu (změna = restart skriptu). */
  private applyHelperTiming(): void {
    const p = this.profile();
    this.helper?.setTiming({ fastMs: p.helperFastMs, foregroundMs: p.helperForegroundMs, processesS: p.helperProcessesS });
  }

  /** Délka klipu podle nastavení, oříznutá stropem plánu (zdarma 60 s). */
  effectiveClipSeconds(): number {
    return Math.min(this.settings.get().clipSeconds, maxClipSecondsFor(this.auth.current()));
  }

  async start(): Promise<void> {
    // Windows: bez tohohle nejdou systémová oznámení a ikona v liště se
    // po aktualizaci "rozdvojí".
    if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_IDS[VARIANT]);
    initLog(join(app.getPath('userData'), 'logs'));
    log(`start ${PRODUCT} ${app.getVersion()} (${process.platform}, electron ${process.versions.electron})`);

    this.settings = new SettingsStore();
    // Režim appky je dán tím, která appka to je - Kine do PC má Kine v okně,
    // Kine Clipper jen klipuje. Starší nastavení (kde se režim volil) se srovná.
    const mode = modeForVariant(VARIANT);
    if (this.settings.get().appMode !== mode || !this.settings.get().appModeChosen) this.settings.update({ appMode: mode, appModeChosen: true });
    this.library = new ClipLibrary(this.settings.clipsDir(), log);
    this.library.load();
    this.compressor = new ClipCompressor({
      list: () => this.library.list(),
      get: (id) => this.library.get(id),
      update: (id, patch) => void this.library.update(id, patch),
      // Při hře, nahrávání zápasu a vysílání se nezmenšuje (bralo by výkon).
      gameRunning: () => !!this.games?.current() || !!this.capture?.recordingInfo() || !!this.live?.active(),
      inUse: (id) => id === this.playerClipId,
      onChange: () => this.pushStatusSoon(),
    });

    this.auth = new Auth(() => this.settings.get().siteUrl);
    const api = createKineApi({ siteUrl: () => this.settings.get().siteUrl, getToken: () => this.auth.getToken() });
    this.kineApi = api;

    this.toast = new Toast({
      preload: PRELOAD,
      rendererDir: RENDERER_DIR,
      enabled: () => this.settings.get().toast,
      sound: () => this.settings.get().clipSound,
      displayId: () => this.settings.get().displayId,
    });

    this.capture = new CaptureManager({
      // Na baterii úsporně (720p30) - jen nastavení pro snímání, uložené nastavení se nemění.
      settings: () => this.captureSettings(),
      preload: PRELOAD,
      rendererDir: RENDERER_DIR,
      onState: (state, error, runtime) => {
        if (state === 'error' && error) {
          void this.toast.show(this.t('toastCaptureError', { message: error }), 'error', { notification: true });
          if (runtime) this.restartAfterCrash();
        }
        // Na baterii úsporně - rozhodne se při každém startu snímání (dřív, než si snímání vezme nastavení).
        if (state === 'starting') this.checkBattery();
        // Okénko "Klip uložen" připravené dopředu, dokud se snímá; potom zase pryč (paměť).
        if (state === 'on') this.toast.warm();
        else if (state === 'off') this.toast.releaseSoon();
        this.pushStatus();
      },
      onSavingProgress: () => this.pushStatusSoon(),
      // Nahrávka zápasu přerušená pádem (snímání, appka, Windows) je odložená - slepit ji hned.
      onRecoverable: () => {
        this.pushStatus();
        void this.recoverRecordings();
      },
      onLiveEvent: (event) => this.live?.handleEvent(event),
      onWarning: (kind, message) => {
        // Jednou za běh appky - ne při každém startu zásobníku. Okénkem jen
        // mimo start appky (po startu by "jen tak chodila oznámení"), vždycky v okně.
        if (this.warnedOnce.has(kind)) return;
        this.warnedOnce.add(kind);
        const clean = message.replace(/^\w*Error:\s*/, '');
        if (kind === 'bluetoothMic') {
          // Výchozí mikrofon jsou sluchátka Bluetooth: appka vzala jiný (message = jeho název), nebo žádný.
          const text = clean ? this.t('toastBluetoothMicSwitched', { mic: clean }) : this.t('toastBluetoothMicOff');
          this.quietNotice(`capture:${kind}`, text, 'warn', 'settings:audio');
          return;
        }
        if (kind === 'systemAudio') {
          this.quietNotice(`capture:${kind}`, this.t('toastSystemAudioDevice', { message: clean }), 'warn', 'settings:audio');
          return;
        }
        if (kind === 'systemLoopback') {
          // Zvuk hry (výchozí výstup Windows) nejde otevřít - rada je v Nastavení -> Záznam.
          const device = message.split(' | ')[1]?.trim() || this.t('audioDefaultDevice');
          this.quietNotice(`capture:${kind}`, this.t('toastAudioLoopbackFailed', { device }), 'warn', 'settings:audio');
          return;
        }
        if (kind === 'systemAudioFallback') {
          this.quietNotice(`capture:${kind}`, this.t('toastAudioFallback', { device: clean }), 'info', 'settings:audio');
          return;
        }
        if (kind === 'systemAudioRetry') return; // povedlo se na druhý pokus - jen do logu
        // Zvuk hry jde přímo z Windows (jako v OBS) - funguje, hráč nemusí nic dělat; jen do logu a do Nastavení -> Záznam.
        if (kind === 'systemAudioNative') return;
        this.quietNotice(`capture:${kind}`, this.t('toastMicUnavailable', { message: clean }), 'warn', 'settings:audio');
      },
      onLevels: (levels) => this.onAudioLevels(levels),
      onDefaultOutputChanged: (device) => {
        // Loopback zůstal na starém zařízení - rozjet znovu, ale ne pod rozjetou (nebo právě ukládanou) nahrávkou zápasu.
        if (this.capture.recordingInfo() || this.finishingRecording) {
          log(`výchozí výstup zvuku se změnil na "${device}" během nahrávání zápasu - snímání se rozjede znovu až po něm`);
          this.restartAfterRecording = true;
          return;
        }
        // Windows hlásí změnu zařízení i několikrát za sebou - jeden restart za 5 s stačí.
        if (Date.now() - this.lastAudioRestart < 5000) return;
        this.lastAudioRestart = Date.now();
        log(`výchozí výstup zvuku se změnil na "${device}" - snímání se rozjede znovu`);
        void this.capture.restartIfOn();
      },
      // Každá appka svou složku zásobníku - Kine a Kine Clipper si nesmí mazat kousky.
      bufferName: VARIANT === 'clipper' ? 'kine-clipper-buffer' : 'kine-buffer',
      nativeLoopbackKnown: () => !!this.loopback?.workedBefore(),
    });

    if (WinHelper.supported() && !process.env.KINE_NO_HELPER) {
      this.helper = new WinHelper(app.getPath('userData'));
      this.helper.on({ state: () => this.pushStatus(), blocked: () => this.onHelperBlocked() });
    }

    this.games = new GameWatcher({
      settings: () => this.settings.get(),
      helper: this.helper,
      onChange: (game, prev) => void this.onGameChange(game, prev),
      onProcesses: (names) => this.onProcesses(names),
      pollMs: () => this.profile().gamePollMs,
    });

    // Klipy samy z herních událostí (CS2 GSI, LoL Live Client API).
    this.gameEvents = new GameEvents({
      settings: () => this.settings.get(),
      updateSettings: (patch) => this.settings.update(patch),
      steamLibraries: () => this.games.steamLibraries(),
      // Název klipu: "Triple kill · Mirage 7:5" (CS2), "Double kill · Crystal Maiden" (Dota 2).
      onClip: (_count, labelKey, _game, context) => void this.onClipHotkey({ auto: true, label: context ? `${this.t(labelKey)} · ${context}` : this.t(labelKey) }),
      onStateChange: () => this.pushStatus(),
      lolPollMs: () => this.profile().lolPollMs,
      minecraftCommandLine: () => this.games.minecraftCommandLine(),
      onRlConfigBlocked: (file) => {
        if (file) this.addNotice({ id: 'rl-config', text: this.t('autoClipsRlNoAccess', { file }), kind: 'warn', tab: 'games' });
        else this.dismissNotice('rl-config');
      },
    });

    this.hotkeys = new HotkeyManager({
      helper: this.helper,
      onFire: (id) => this.onHotkey(id),
      onProblemsChanged: () => {
        this.syncHotkeyNotices();
        this.pushStatus();
      },
    });

    this.live = new LiveController({
      capture: this.capture,
      api: () => api,
      settings: () => this.settings.get(),
      siteUrl: () => this.settings.get().siteUrl,
      spawn: (args) => spawnFfmpeg(args),
      log,
      onChange: () => this.pushStatus(),
      notify: (kind, info) => this.onLiveNotice(kind, info),
      onEnded: () => this.afterLive(),
      // Samočinná zkouška vysílá na místní RTMP server místo Kine.
      testUrl: process.env.KINE_TEST ? process.env.KINE_TEST_LIVE_URL ?? null : null,
      saveRecording: (info) => this.saveStreamRecording(info),
      // Playlist vysílání u Cloudflare (jako divák) - vidí diváci obraz? (live.ts, liveHealth.ts)
      fetchText: async (url, timeoutMs) => {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        const text = res.ok ? await res.text() : '';
        return { status: res.status, text: text.slice(0, 200_000) };
      },
      rememberCompat: () => {
        if (!this.settings.get().liveCompat) this.settings.update({ liveCompat: true });
      },
    });

    this.uploader = new Uploader({
      library: this.library,
      api,
      blocked: () => (this.games.current() ? 'game' : net.isOnline() ? null : 'offline'),
      settings: () => this.settings.get(),
      log,
      // Popis pod videem: odkud klip je a kde se appka bere - diváci klipu se tak dostanou k appce.
      describe: (clip) => {
        const download = `${this.settings.get().siteUrl}/download`;
        if (clip.kind === 'recording') {
          const base = clip.game ? this.t('uploadDescriptionRecordingGame', { game: clip.game, url: download }) : this.t('uploadDescriptionRecording', { url: download });
          // Značky z nahrávky jako kapitoly (Kine je ukáže na časové ose videa).
          const chapters = markerChapters(clip.markers, this.t('markerStart'), clip.durationSeconds);
          return chapters.length > 0 ? `${base}\n\n${chaptersText(chapters)}` : base;
        }
        return clip.game ? this.t('uploadDescriptionGame', { game: clip.game, url: download }) : this.t('uploadDescription', { url: download });
      },
      uploadThumbnail: (videoId, file) => this.auth.uploadThumbnail(videoId, file),
      chapters: (clip) => markerChapters(clip.markers, this.t('markerStart'), clip.durationSeconds),
      prepareFile: (clip) => this.uploadFileFor(clip),
      releaseFile: (clip) => this.releaseUploadFile(clip.id),
    });
    this.uploader.on((e) => {
      if (e.type === 'done') {
        // Nahrané, ale Kine ho ještě zpracovává - jen okénko v rohu; systémové oznámení až když je vidět.
        const id = e.clip.id;
        void this.toast.show(this.t('toastUploadedProcessing', { title: e.clip.title }), 'ok', { onClick: () => this.openClipOnKine(id) });
      }
      if (e.type === 'ready') {
        const id = e.clip.id;
        void this.toast.show(this.t('toastOnKine', { title: e.clip.title }), 'ok', { notification: true, onClick: () => this.openClipOnKine(id) });
      }
      if (e.type === 'error') {
        const reason = e.message === UPLOAD_ERROR_LOGIN ? this.t('uploadErrorLogin') : e.message;
        void this.toast.show(this.t('toastUploadFailed', { title: e.clip.title }) + ` (${reason})`, 'error', { notification: true, onClick: e.message === UPLOAD_ERROR_LOGIN ? () => this.openSettings('account') : undefined });
      }
      this.pushStatus();
      this.pushClips();
    });
    this.library.onChange(() => this.pushClips());
    this.auth.onChange((account) => {
      // Barva Kine z účtu -> appka se přebarví stejně jako web hráče. Bez
      // účtu (nebo bez barvy na účtu) zůstává barva zvolená v appce.
      const color = account?.brandColor && hexToRgbTriplet(account.brandColor) ? account.brandColor : null;
      if (color && color !== this.settings.get().brandColor) this.settings.update({ brandColor: color });
      this.pushStatus();
      this.rebuildTray();
      // Přihlásil se v appce -> ať je přihlášený i web v okně.
      if (account && this.kineView && !this.kineView.webContents.isDestroyed()) void this.syncLogin(this.kineView);
    });

    this.installDisplayMediaHandler();
    this.registerIpc();
    // Nejdřív zkratky (pomocník si je vezme při startu), pak pomocník - ať se nespouští dvakrát.
    this.registerHotkeys();
    this.applyHelperTiming();
    this.helper?.start();
    this.createTray();
    this.applyLoginItem();
    initUpdater({ variant: VARIANT, siteUrl: () => this.settings.get().siteUrl, gameRunning: () => !!this.games.current(), checkHours: () => this.profile().updateCheckHours });
    // Průběh stahování aktualizace do okna (O appce, postranní panel) a "Aktualizovat" do lišty.
    onUpdateProgress(() => {
      // Stažená aktualizace: zjistit Smart App Control (O appce u tlačítka upozorní, že ji může zablokovat).
      if (updateProgress().phase === 'ready') void this.refreshSmartAppControl();
      this.pushStatusSoon();
    });
    // Jak dopadla poslední aktualizace (neprošla -> O appce řekne proč; okno se otevře tam).
    this.checkUpdateOutcome();

    this.settings.onChange((s, prev) => this.onSettingsChanged(s, prev));
    this.announceVersion();
    // Kine na nové adrese (vlastní doména)? Appka přejde sama - po startu a pak jednou denně.
    setTimeout(() => void this.followSiteMove(), 15_000);
    setInterval(() => void this.followSiteMove(), 24 * 60 * 60 * 1000);

    await this.auth.init();
    this.games.start();
    void this.gameEvents.start();
    this.uploader.restoreFromLibrary();
    this.purgeUploadCache();

    // Nahrávka zápasu, kterou minule přerušil pád appky nebo Windows: kousky
    // zůstaly v dočasné složce - odložit je (dřív, než je start zásobníku smaže) a slepit.
    if (this.capture.salvageLeftovers().waiting > 0) setTimeout(() => void this.recoverRecordings(), 4000);

    // Po spuštění: nahrávat hned (podle režimu), počkat na první hru, nebo nic, dokud to hráč nezapne.
    const launch = this.settings.get().launchCapture;
    if (launch === 'paused' && this.settings.get().detection !== 'manual') {
      this.paused = true;
      log('po spuštění se nenahrává, dokud to hráč nezapne');
    } else if (this.settings.get().detection === 'always') {
      if (launch === 'game') this.waitingForFirstGame = true;
      else void this.capture.start().catch(() => undefined);
    }
    // Na baterii / ze sítě: projeví se při dalším startu snímání (rozjeté snímání se nepřerušuje - zásobník by se ztratil).
    powerMonitor.on('on-battery', () => this.pushStatus());
    powerMonitor.on('on-ac', () => this.pushStatus());

    // Nahrávání čeká i na připojení - když se vrátí, nikdo jiný to nepošťouchne.
    setInterval(() => {
      if (this.uploader.pending() > 0) this.uploader.kick();
    }, 30000);
    // Zkratku držel jiný program (třeba druhá appka Kine, než se vypnula) - zkoušet znovu.
    setInterval(() => {
      if (this.hotkeys.currentProblems().some((p) => p.reason === 'in-use')) this.hotkeys.retry();
    }, 15000);
    // Pojistka pro sdílené přihlášení: web v okně se občas zkontroluje, i když
    // žádný přechod stránky nepřišel (přihlášení přes okno třetí strany apod.).
    setInterval(() => {
      if (this.kineViewShown && this.kineView && !this.kineView.webContents.isDestroyed()) void this.syncLogin(this.kineView);
    }, 15000);
    // Plán (předplatné) a barva se občas srovnají podle Kine - když Klipy
    // Plus vyprší, automatické nahrávání se samo vrátí na ruční.
    setInterval(() => void this.auth.refresh(), 6 * 60 * 60 * 1000);
    // Koš: co v něm leží déle než týden, zmizí samo. Strop místa na klipy se hlídá taky.
    setInterval(() => {
      const n = this.library.purgeExpired();
      if (n > 0) log(`koš: ${n} klipů smazáno po ${TRASH_DAYS} dnech`);
      this.enforceStorageLimit();
    }, 60 * 60 * 1000);
    setTimeout(() => this.enforceStorageLimit(), 60 * 1000).unref?.();

    const hidden = process.argv.includes('--hidden');
    const s = this.settings.get();
    if (!s.onboarded) this.openSettings('wizard');
    else if (!hidden) this.openSettings(this.updateIssue ? 'about' : s.appMode === 'full' ? 'kine' : 'clips');

    // Odkaz kine://…, kterým appku někdo spustil (Windows předává v argv).
    for (const arg of process.argv) if (arg.startsWith('kine://')) void this.handleDeepLink(arg);

    if (process.env.KINE_TEST) void runTestDriver(this as any);
    this.pushStatus();
  }

  /**
   * Obě appky naráz nedávají smysl (dvakrát by se nahrávalo, dvakrát
   * zkratky - ta druhá by je nedostala). Klipovač je součástí Kine do PC:
   * jakmile Kine běží (i když se spustí až později), klipovač to řekne a
   * vypne se; Kine do PC při běžícím klipovači jen upozorní (nejdřív za
   * 10 minut znovu). Volá se z hlídání her při každém kole (5 s).
   */
  private siblingQuitting = false;
  private siblingWarnedAt = 0;

  private onProcesses(names: Set<string>): void {
    if (process.platform !== 'win32' || process.env.KINE_TEST) return;
    if (!names.has(siblingExe(VARIANT))) return;
    if (VARIANT === 'clipper') {
      if (this.siblingQuitting) return;
      this.siblingQuitting = true;
      log('běží Kine do PC - klipovač je jeho součástí, vypíná se');
      // Spuštěný se systémem (obě appky naráz) = potichu pryč. Jen když ho hráč pustil sám, řekne proč.
      if (!process.argv.includes('--hidden')) void this.toast.show(this.t('siblingFullRunning'), 'warn');
      setTimeout(() => this.quit(), 4000);
    } else if (Date.now() - this.startedAt > 60 * 1000 && Date.now() - this.siblingWarnedAt > 10 * 60 * 1000) {
      // Klipovač se při běžícím Kine do PC sám vypne do pár sekund - hlásí se jen starší, který to neumí (po minutě).
      this.siblingWarnedAt = Date.now();
      log('běží i Kine Clipper - stačí jedna appka');
      this.quietNotice('sibling', this.t('siblingClipperRunning'), 'warn');
    }
  }

  /** Ikona appky v barvě Kine hráče (okna, lišta u hodin). */
  appIcon(): Electron.NativeImage {
    return brandIcon(ICON_PNG, this.settings.get().brandColor || null);
  }

  /** Po změně barvy: okna i ikona u hodin dostanou přebarvenou ikonu. */
  private applyBrandIcons(): void {
    const icon = this.appIcon();
    if (icon.isEmpty()) return;
    for (const win of [this.settingsWindow, this.reviewWindow]) {
      if (win && !win.isDestroyed()) win.setIcon(icon);
    }
    this.tray?.setImage(trayIcon(icon, this.trayDotShown));
  }

  /** Po aktualizaci jednou řekne, že běží nová verze (poprvé po instalaci nic). */
  private announceVersion(): void {
    const s = this.settings.get();
    const version = app.getVersion();
    if (s.lastVersion === version) return;
    // První start po instalaci nebo aktualizaci: zástupce na ploše a v Startu, když chybí
    // (po rozbité aktualizaci z 0.9.8 ikona na ploše chyběla). Instalátor ikonu na ploše
    // vytváří vždycky - kdo ji v nastavení vypnul, tomu ji appka hned zase uklidí.
    this.ensureShortcuts(false, true);
    if (s.lastVersion && s.onboarded) {
      log(`aktualizováno z ${s.lastVersion} na ${version}`);
      // Jen v okně (O aplikaci / panel) - žádné oznámení hned po startu.
      this.addNotice({ id: 'updated', text: this.t('toastUpdated', { version }), kind: 'info', tab: 'about' });
    }
    this.settings.update({ lastVersion: version });
  }

  /**
   * Aktualizace, která neprošla: instalátor nechal starou verzi a appka se
   * spustila znovu. Jednou upozornění a v O appce vysvětlení (Smart App
   * Control, antivir, soubory držené jiným programem) - dokud ho hráč nezavře.
   */
  private checkUpdateOutcome(): void {
    let outcome: ReturnType<typeof takeUpdateOutcome>;
    try {
      outcome = takeUpdateOutcome(VARIANT);
    } catch (e) {
      log(`výsledek aktualizace nejde přečíst: ${(e as Error).message}`);
      return;
    }
    if (outcome.kind === 'updated') log(`aktualizace ${outcome.from} -> ${outcome.to} prošla`);
    if (outcome.kind !== 'failed') {
      void this.refreshSmartAppControl();
      return;
    }
    log(`aktualizace na ${outcome.version} neprošla (${outcome.reason}) - běží dál ${app.getVersion()}`);
    this.updateIssue = { version: outcome.version, reason: outcome.reason };
    this.addNotice({ id: 'update-failed', text: this.updateIssueText(), kind: 'warn', tab: 'about' });
    // Stažená verze leží v mezipaměti - "Aktualizovat teď" ať je zpátky hned (ne až po půl minutě).
    setTimeout(() => void checkForUpdates(), 5000).unref?.();
    // Text závisí na Smart App Control - po zjištění se upřesní.
    void this.refreshSmartAppControl().then(() => {
      if (!this.updateIssue) return;
      const notice = this.notices.find((n) => n.id === 'update-failed');
      if (notice) notice.text = this.updateIssueText();
      log(`Smart App Control: ${this.smartAppControl ?? 'nezjištěno'}`);
      this.pushStatusSoon();
    });
  }

  private async refreshSmartAppControl(): Promise<void> {
    const state = await smartAppControlState().catch(() => null);
    if (state === this.smartAppControl) return;
    this.smartAppControl = state;
    this.pushStatusSoon();
  }

  /** Jen samočinná zkouška (KINE_TEST): aktualizace, která neprošla, a stav Smart App Control. */
  simulateUpdateIssue(issue: UpdateIssue | null, sac: SmartAppControlState | null): void {
    if (!process.env.KINE_TEST) return;
    this.smartAppControl = sac;
    this.updateIssue = issue;
    if (issue) this.addNotice({ id: 'update-failed', text: this.updateIssueText(), kind: 'warn', tab: 'about' });
    else this.dismissNotice('update-failed');
    this.pushStatus();
  }

  /** Krátké upozornění (postranní panel) k aktualizaci, která neprošla. */
  private updateIssueText(): string {
    const issue = this.updateIssue;
    if (!issue) return '';
    const version = issue.version;
    switch (issue.reason) {
      case 'in-use':
        return this.t('updateFailedInUse', { version });
      case 'not-started':
        return this.t('updateFailedNotStarted', { version });
      default:
        return this.smartAppControl === 'on' ? this.t('updateFailedSac', { version }) : this.t('updateFailedBlocked', { version });
    }
  }

  /**
   * Windows nepustí pomocníka (Smart App Control / App Control): zkratky z
   * více kláves, tlačítka myši a ovladače nejdou a hra se pozná hůř.
   * Řekne to jednou v okně (ne okénkem) - zkratky ukážou vlastní důvod.
   */
  private onHelperBlocked(): void {
    void this.refreshSmartAppControl().then(() => {
      this.addNotice({
        id: 'helper-blocked',
        text: this.smartAppControl === 'on' ? this.t('helperBlockedSac') : this.t('helperBlocked'),
        kind: 'warn',
        tab: 'settings:hotkeys',
      });
      this.syncHotkeyNotices();
      this.pushStatusSoon();
    });
  }

  // ---- hry ---------------------------------------------------------------------

  private async onGameChange(game: DetectedGame | null, prev: DetectedGame | null): Promise<void> {
    const s = this.settings.get();
    this.pushStatus();
    this.uploader.kick();
    this.gameEvents.onGame(game?.exe ?? null, game?.name ?? null);
    const announce = (g: DetectedGame) => void this.toast.show(this.t('toastGameDetected', { game: g.name, hotkey: hotkeyLabel(s.clipHotkey) }), 'ok');

    if (game && !prev) {
      this.sessionId = randomUUID();
      // Web Kine v okně během hry spí (nehraje video, nežere procesor ani síť).
      this.sleepKineView(true);
      if (s.detection === 'games' && !this.paused) {
        await this.capture.start().catch(() => undefined);
        announce(game);
        this.warnIfClipHotkeyBroken();
      } else if (s.detection === 'always' && this.waitingForFirstGame && !this.paused) {
        // "Pořád, ale až s první hrou": od teď se nahrává pořád.
        this.waitingForFirstGame = false;
        await this.capture.start().catch(() => undefined);
        announce(game);
        this.warnIfClipHotkeyBroken();
      }
    } else if (game && prev && game.exe !== prev.exe) {
      // Přepnutí z jedné hry do druhé (obě běží): stejné "hraní", zásobník
      // jede dál, jen se přejmenuje, co se klipuje.
      if (s.detection === 'games' && !this.paused) announce(game);
    }

    if (!game && prev) {
      // Nahrávaný zápas skončil s hrou - uložit, ať je v okýnku po hře (a počkat na ukládání, které už běží).
      if (this.capture.recordingInfo() || this.finishingRecording) await this.finishRecording('game-ended');
      // Během vysílání zásobník běží dál (vysílání ho potřebuje) - vypne se po konci vysílání.
      if (s.detection === 'games' && !this.live.active()) await this.capture.stop().catch(() => undefined);
      this.sleepKineView(false);
      // Aktualizace, která vyšla během hry, se stáhne teď.
      updaterGameEnded();
      await this.afterGame();
    }
    this.rebuildTray();
  }

  /** Po hře: klipy z tohohle hraní, které ještě nejsou na Kine. */
  private async afterGame(): Promise<void> {
    const s = this.settings.get();
    const clips = this.library.bySession(this.sessionId).filter((c) => !c.upload || c.upload.state === 'error');
    if (clips.length === 0) return;
    const mode = this.effectiveAfterGame();
    if (mode === 'auto') {
      // Samo se nahrávají jen klipy; nahrávka celého zápasu (hodiny, gigabajty) čeká na hráče v knihovně.
      this.uploader.enqueue(clips.filter((c) => c.kind !== 'recording').map((c) => ({ clipId: c.id, visibility: s.visibility })));
    } else if (mode === 'review') {
      this.openReview(this.sessionId);
    }
  }

  // ---- klipy -------------------------------------------------------------------

  private onHotkey(id: HotkeyId): void {
    if (id === 'clip') void this.onClipHotkey();
    else if (id === 'record') void this.toggleRecording();
    else if (id === 'brb') this.toggleLiveBrb();
    else void this.onToggleHotkey();
  }

  /** Značky do rozjeté nahrávky zápasu (klip, zabití) - čas podle hodin, na sekundy se přepočítá při uložení. */
  private recordingMarkers: { at: number; label: string }[] = [];

  // ---- nahrávání celého zápasu ----------------------------------------------------

  /**
   * Start / stop nahrávání celého zápasu (zkratka, karta stavu, lišta).
   * Zásobník musí běžet - nahrávka jsou jeho kousky, které se nemažou.
   */
  async toggleRecording(): Promise<void> {
    // Nahrávka se ještě ukládá: další stisk nic nespustí (dřív se tak uložila víckrát).
    if (this.finishingRecording && !this.capture.recordingInfo()) {
      void this.toast.show(this.t('toastRecordingStillSaving'), 'ok');
      return;
    }
    if (this.capture.recordingInfo()) {
      await this.finishRecording('user');
      return;
    }
    const s = this.settings.get();
    if (this.capture.state !== 'on') {
      const key: Key = s.detection === 'manual' ? 'toastNotCapturingManual' : 'toastNotCapturing';
      void this.toast.show(this.t(key, { hotkey: hotkeyLabel(s.toggleHotkey) }), 'warn');
      return;
    }
    try {
      await this.capture.startRecording(this.games.current()?.name ?? null);
      this.recordingMarkers = [];
      this.capture.onRecordingAutoStop((reason) => void this.finishRecording(reason));
      void this.toast.show(s.recordHotkey ? this.t('toastRecordingStarted', { hotkey: hotkeyLabel(s.recordHotkey) }) : this.t('toastRecordingStartedNoKey'), 'ok', { sound: true });
    } catch (e) {
      const message = (e as Error).message;
      if (message === 'busy') void this.toast.show(this.t('toastRecordingStillSaving'), 'ok');
      else void this.toast.show(this.t('toastClipFailed', { message }), 'error');
    }
    this.pushStatus();
  }

  /**
   * Uloží běžící nahrávku jako dlouhý klip. Volá se ze zkratky, při konci
   * hry, před zastavením zásobníku (změna nastavení, pauza, konec appky)
   * a když se nahrávání zastaví samo (délka, místo na disku).
   *
   * Nahrávání končí HNED (tlačítko i lišta hned ukážou "Ukládám…" a okénko
   * to řekne); slepení dlouhé nahrávky pak chvíli běží na pozadí. Další
   * volání během ukládání dostanou totéž ukládání - nikdy dva soubory.
   */
  finishRecording(reason: 'user' | 'game-ended' | 'buffer-off' | 'quit' | 'max' | 'disk'): Promise<Clip | null> {
    if (this.finishingRecording) return this.finishingRecording;
    const info = this.capture.recordingInfo();
    if (!info) return Promise.resolve(null);
    const run = this.doFinishRecording(reason, info).finally(() => {
      if (this.finishingRecording === run) this.finishingRecording = null;
      this.pushStatus();
    });
    this.finishingRecording = run;
    return run;
  }

  private async doFinishRecording(reason: 'user' | 'game-ended' | 'buffer-off' | 'quit' | 'max' | 'disk', info: { since: number; game: string | null }): Promise<Clip | null> {
    const s = this.settings.get();
    const game = info.game ?? this.games.current()?.name ?? null;
    // Okénko hned: nahrávání skončilo, ukládá se (s procenty v okně). Výsledek pak přepíše totéž okénko.
    const pending = reason === 'quit' ? null : this.toast.pending(this.t('toastRecordingSaving'));
    const saving = this.capture.stopRecording(this.settings.clipsDir(), join(app.getPath('userData'), 'thumbs'));
    this.pushStatus();
    try {
      const results = await saving;
      const clips: Clip[] = [];
      results.forEach((result, i) => {
        const partTitle = defaultClipTitle(new Date(result.since), game, this.t('recordingWord'));
        const title = results.length > 1 ? `${partTitle} · ${this.t('recordingPart', { n: i + 1, count: results.length })}` : partTitle;
        // Značky (klipy a zabití během zápasu) jako sekundy od začátku nahrávky (části).
        const markers = this.recordingMarkers
          .map((m) => ({ time: Math.round(((m.at - result.since) / 1000) * 10) / 10, label: m.label }))
          .filter((m) => m.time >= 0 && m.time <= result.durationSeconds);
        const clip: Clip = {
          id: randomUUID(),
          file: result.file,
          thumb: result.thumb,
          title: title.slice(0, 150),
          game,
          createdAt: new Date(result.since).toISOString(),
          durationSeconds: result.durationSeconds,
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          sessionId: game ? this.sessionId : 'no-game-' + this.sessionId,
          upload: null,
          audioTracks: result.audioTracks,
          kind: 'recording',
          markers: markers.length > 0 ? markers : undefined,
        };
        this.library.add(clip);
        clips.push(clip);
        log(`nahrávka zápasu uložena (${reason}): ${result.file}`);
      });
      this.recordingMarkers = [];
      const total = results.reduce((sum, r) => sum + r.durationSeconds, 0);
      const minutes = Math.max(1, Math.round(total / 60));
      const key: Key = reason === 'disk' ? 'toastRecordingSavedDisk' : reason === 'max' ? 'toastRecordingSavedMax' : results.length > 1 ? 'toastRecordingSavedParts' : 'toastRecordingSaved';
      const text = this.t(key, { minutes, count: results.length });
      const openIt = () => this.openSettings('clips');
      if (pending) pending.done(text, 'ok', { notification: !s.toast || reason !== 'user', onClick: openIt });
      else void this.toast.show(text, 'ok', { notification: true, onClick: openIt });
      this.enforceStorageLimit();
      if (this.restartAfterRecording && reason !== 'quit' && reason !== 'buffer-off') {
        this.restartAfterRecording = false;
        void this.capture.restartIfOn();
      }
      return clips[clips.length - 1] ?? null;
    } catch (e) {
      const message = (e as Error).message;
      if (message === 'interrupted') {
        // Snímání spadlo pod nahrávkou - kousky se odkládají a slepí se samy (toast "zachráněno").
        log(`nahrávka zápasu (${reason}): snímání spadlo, nahrávka se obnoví z kousků`);
        pending?.done(this.t('toastRecordingRecovering'), 'warn');
        return null;
      }
      if (message === 'busy') {
        pending?.done(this.t('toastRecordingStillSaving'), 'ok');
        return null;
      }
      if (message !== 'too-early' && message !== 'not-capturing') {
        if (pending) pending.done(this.t('toastClipFailed', { message }), 'error', { notification: true });
        else void this.toast.show(this.t('toastClipFailed', { message }), 'error', { notification: true });
      } else if (reason === 'user') {
        pending?.done(this.t('toastTooEarly'), 'warn');
      } else {
        pending?.done(this.t('toastRecordingNothing'), 'warn');
      }
      log(`nahrávka zápasu se nepovedla (${reason}): ${message}`);
      return null;
    }
  }

  /**
   * Nahrávky zápasu, které přerušil pád (appky, snímací stránky, Windows):
   * capture je odložil stranou, tady se slepí a přidají do knihovny jako
   * nahrávka s poznámkou "obnoveno po pádu".
   */
  async recoverRecordings(): Promise<Clip[]> {
    const results = await this.capture.recoverLeftovers(this.settings.clipsDir(), join(app.getPath('userData'), 'thumbs')).catch((e) => {
      log(`obnova nahrávek zápasu: ${(e as Error).message}`);
      return [];
    });
    const clips: Clip[] = [];
    for (const r of results) {
      const clip: Clip = {
        id: randomUUID(),
        file: r.file,
        thumb: r.thumb,
        title: `${defaultClipTitle(new Date(r.since), r.game, this.t('recordingWord'))} · ${this.t('recordingRecovered')}`,
        game: r.game,
        createdAt: new Date(r.since).toISOString(),
        durationSeconds: r.durationSeconds,
        sizeBytes: r.sizeBytes,
        width: r.width,
        height: r.height,
        sessionId: 'recovered-' + randomUUID(),
        upload: null,
        audioTracks: r.audioTracks,
        kind: 'recording',
      };
      this.library.add(clip);
      clips.push(clip);
      const minutes = Math.max(1, Math.round(r.durationSeconds / 60));
      void this.toast.show(this.t('toastRecordingRecovered', { minutes }), 'ok', { notification: true, onClick: () => this.openSettings('clips') });
    }
    if (clips.length > 0) this.pushStatus();
    return clips;
  }

  /**
   * Diagnostika pro podporu (O aplikaci -> Zkopírovat diagnostiku): verze,
   * systém, grafika, kodér, nastavení snímání a zvuku, hladiny a konec
   * protokolu. Domovská složka (jméno uživatele) a e-maily se vynechají.
   */
  async diagnostics(): Promise<string> {
    const s = this.settings.get();
    const c = this.capture;
    const yesNo = (v: boolean | null | undefined) => (v === null || v === undefined ? '?' : v ? 'yes' : 'no');
    const lines: string[] = [];
    lines.push(`${PRODUCT} ${app.getVersion()} (${VARIANT}) · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${release()} ${process.arch}`);
    const cpu = cpus();
    lines.push(`CPU: ${cpu[0]?.model?.trim() ?? '?'} x${cpu.length} · RAM ${Math.round(totalmem() / 1024 ** 3)} GB`);
    try {
      const gpu = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId?: number; deviceId?: number; active?: boolean; driverVersion?: string }[] };
      const vendor = (id?: number) => (id === 0x10de ? 'NVIDIA' : id === 0x1002 ? 'AMD' : id === 0x8086 ? 'Intel' : id ? `0x${id.toString(16)}` : '?');
      const devices = (gpu.gpuDevice ?? []).map((d) => `${vendor(d.vendorId)} 0x${(d.deviceId ?? 0).toString(16)}${d.active ? ' (active)' : ''}${d.driverVersion ? ` driver ${d.driverVersion}` : ''}`);
      lines.push(`GPU: ${devices.join(', ') || '?'} · video encode: ${app.getGPUFeatureStatus().video_encode ?? '?'}`);
    } catch {
      lines.push('GPU: ?');
    }
    lines.push(`Capture: ${c.state}${c.error ? ` (${c.error})` : ''} · ${s.maxHeight}p ${s.fps} fps (real ${c.effectiveFps ?? '?'}) · ${s.codec} · ${s.videoMbps} Mb/s · HW encoder ${yesNo(c.hwEncoder)} · ${c.lastStarted?.mimeType ?? '?'}`);
    lines.push(
      `Audio: game ${yesNo(s.systemAudio)} (${s.systemAudioDevice ? 'input device' : 'loopback'}) · mic ${yesNo(s.microphone)} (${s.microphoneDevice ? 'chosen' : 'default'}) · gain ${Math.round(s.systemGain * 100)}/${Math.round(s.micGain * 100)} % · separate tracks ${yesNo(s.separateMicTrack)} · offset ${s.audioOffsetMs} ms · latency ${c.lastStarted?.micLatencyMs ?? '?'} ms${c.lastStarted?.systemLatencyMs ? ` · game sound via helper (WASAPI, ${c.lastStarted.systemLatencyMs} ms)` : ''}`
    );
    const l = c.levels;
    const level = (v: number | null) => (v === null ? 'off' : v > 0 ? `${Math.round(20 * Math.log10(v))} dB` : 'silent');
    if (l) {
      lines.push(`Levels: game ${level(l.system)} from "${l.systemDevice || 'default'}" (silent ${l.systemSilentSeconds} s) · mic ${level(l.mic)}${l.micDevice ? ` "${l.micDevice}"` : ''}${l.bluetoothMicAvoided ? ' · Bluetooth mic avoided' : ''}`);
      // Zvuk hry nejde: důvod od Windows a výchozí výstup - podle toho se dá poradit.
      if (l.systemError || l.systemFallback || l.defaultOutput || l.systemNative) {
        lines.push(
          `Game audio: default output "${l.defaultOutput || '?'}"${l.systemError ? ` · FAILED: ${l.systemError}` : ''}${l.systemFallback ? ` · fallback input "${l.systemFallback}"` : ''}${l.systemNative ? ' · via helper (WASAPI loopback, Chromium failed)' : ''}`
        );
      }
    }
    lines.push(`Game: ${this.games.current()?.name ?? '-'} · detection ${s.detection} · performance ${s.performance} · clip ${s.clipSeconds} s · paused ${yesNo(this.paused)} · recording ${yesNo(!!c.recordingInfo())}`);
    lines.push(`Library: ${this.library.list().length} clips · free ${Math.round(freeDiskBytes(this.settings.clipsDir()) / 1024 ** 3)} GB`);
    lines.push('--- log ---');
    lines.push(...tailLog(80));
    let text = lines.join('\n');
    const home = homedir();
    if (home) {
      text = text.split(home).join('~');
      text = text.split(home.replace(/\\/g, '/')).join('~');
    }
    return text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<e-mail>');
  }

  // ---- soubor k nahrání -----------------------------------------------------------

  private uploadCacheDir(): string {
    return join(app.getPath('userData'), 'upload-cache');
  }

  /**
   * Klip se samostatnými stopami (hra + mikrofon, hra, mikrofon) jde na Kine
   * jen s první, smíchanou stopou: Kine (Cloudflare Stream) hraje jednu a
   * nikde není psáno, kterou by si z víc vybral. Kopie bez překódování
   * (vteřiny) leží v userData, ať jde přerušené nahrávání navázat i po
   * restartu; po nahrání zmizí.
   */
  private async uploadFileFor(clip: Clip): Promise<{ file: string; fresh: boolean }> {
    if ((clip.audioTracks?.length ?? 0) <= 1) return { file: clip.file, fresh: false };
    const webm = extname(clip.file).toLowerCase() === '.webm';
    const target = join(this.uploadCacheDir(), `${clip.id}${webm ? '.webm' : '.mp4'}`);
    try {
      const cached = statSync(target);
      if (cached.size > 0 && cached.mtimeMs >= statSync(clip.file).mtimeMs) return { file: target, fresh: false };
    } catch {
      // Kopie ještě není.
    }
    mkdirSync(this.uploadCacheDir(), { recursive: true });
    const part = `${target}.part`;
    await runFfmpeg(
      ['-loglevel', 'error', '-y', '-i', clip.file, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', ...(webm ? ['-f', 'webm'] : ['-movflags', '+faststart', '-f', 'mp4']), part],
      10 * 60 * 1000
    );
    renameSync(part, target);
    log(`nahrání: ${basename(clip.file)} jde na Kine jen se smíchaným zvukem (${clip.audioTracks?.join(' + ')} -> mix)`);
    return { file: target, fresh: true };
  }

  private releaseUploadFile(clipId: string): void {
    for (const ext of ['.mp4', '.webm']) rmSync(join(this.uploadCacheDir(), `${clipId}${ext}`), { force: true });
  }

  /** Po startu: kopie k nahrání, které už nic nenahrává (klip nahraný, smazaný, zrušený). */
  private purgeUploadCache(): void {
    let names: string[];
    try {
      names = readdirSync(this.uploadCacheDir());
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.replace(/\.(mp4|webm)(\.part)?$/, '');
      const clip = this.library.get(id);
      const pending = !!clip && !clip.deletedAt && !!clip.upload && ['queued', 'paused', 'uploading'].includes(clip.upload.state);
      if (!pending || name.endsWith('.part')) rmSync(join(this.uploadCacheDir(), name), { force: true });
    }
  }

  /** Kdy naposledy spadla snímací stránka (restart nejvýš 3x za 10 minut, ať se appka necyklí). */
  private captureCrashes: number[] = [];

  /**
   * Snímání spadlo za běhu (snímací stránka, ovladač grafiky, pád hry,
   * obrazovka přestala posílat obraz): zásobník se za pár sekund sám rozjede
   * znovu, pokud má běžet - jinak by hráč do konce hry přišel o všechny
   * klipy, aniž by to věděl. Rozjetá nahrávka zápasu se při tom odloží a slepí.
   */
  private restartAfterCrash(): void {
    const now = Date.now();
    this.captureCrashes = this.captureCrashes.filter((at) => now - at < 10 * 60 * 1000);
    if (this.captureCrashes.length >= 3) {
      log('snímací stránka padá opakovaně - sama se už znovu nerozjede');
      return;
    }
    this.captureCrashes.push(now);
    setTimeout(() => {
      const s = this.settings.get();
      const wanted = !this.paused && (s.detection !== 'games' || !!this.games.current());
      if (!wanted || this.capture.state !== 'error') return;
      log('snímání se po chybě rozjíždí znovu');
      void (async () => {
        // Nejdřív úklid (po chybě bez pádu stránky běží staré generace dál), pak čistý start.
        await this.capture.stop().catch(() => undefined);
        await this.capture.start();
      })().then(
        () => void this.toast.show(this.t('toastCaptureRecovered'), 'ok'),
        () => undefined
      );
    }, 3000);
  }

  /** Zastaví zásobník, ale nejdřív uloží rozjetou nahrávku - jinak by kousky zmizely s ním. */
  private async stopCapture(reason: 'game-ended' | 'buffer-off' | 'quit'): Promise<void> {
    // Vysílání běží na stejném snímání - vypnout zásobník by ukončilo i vysílání.
    if (reason !== 'quit' && this.live?.active()) {
      void this.toast.show(this.t('toastLiveKeepsCapture'), 'warn');
      return;
    }
    if (this.capture.recordingInfo() || this.finishingRecording) await this.finishRecording(reason);
    await this.capture.stop();
  }

  // ---- živé vysílání -------------------------------------------------------------

  /** Tlačítko Vysílat (okno) / lišta: začne vysílat na kanál přihlášeného hráče. */
  async startLive(opts: { title?: unknown; quality?: unknown }): Promise<LiveStatus> {
    const s = this.settings.get();
    const quality = (LIVE_QUALITIES as readonly string[]).includes(String(opts?.quality)) ? (opts.quality as LiveQuality) : s.liveQuality;
    const title = String(opts?.title ?? '').trim().slice(0, 100) || s.liveTitle || this.games.current()?.name || this.t('liveDefaultTitle');
    if (!this.auth.current() && !(process.env.KINE_TEST && process.env.KINE_TEST_LIVE_URL)) throw new Error('not-logged-in');
    this.settings.update({ liveTitle: title, liveQuality: quality });
    if (!this.live.active()) {
      this.liveStartedCapture = this.capture.state !== 'on';
      // Každé vysílání začíná se hrou na obrazovce a mikrofonem zapnutým.
      this.liveBrb = false;
      this.liveMicMuted = false;
    }
    // Pozastavené nahrávání (po spuštění / ručně) vysílání zapne - snímání potřebuje.
    if (this.paused) this.paused = false;
    const status = await this.live.start({
      title,
      quality,
      description: s.liveDescription,
      category: s.liveCategory,
      bitrateKbps: s.liveBitrateKbps,
      game: s.liveGameAudio,
      mic: s.liveMic,
      scene: this.liveScene(),
    });
    if (s.liveOpenPage) this.openLivePage();
    return status;
  }

  async stopLive(): Promise<void> {
    await this.live.stop('user');
    this.liveBrb = false;
    this.liveMicMuted = false;
  }

  /** Co je ve vysílání vidět a slyšet navíc k obrazovce (kamera, "Hned jsem zpět", ztlumený mikrofon). */
  private liveScene(): LiveScene {
    const s = this.settings.get();
    return {
      camera: s.liveCamera
        ? { deviceId: s.liveCameraDevice, position: s.liveCameraPosition, size: s.liveCameraSize, shape: s.liveCameraShape, mirror: s.liveCameraMirror }
        : null,
      brb: this.liveBrb,
      brbText: s.liveBrbText.trim() || this.t('liveBrbDefault'),
      micMuted: this.liveMicMuted || (this.liveBrb && s.liveBrbMuteMic),
    };
  }

  /** Obrazovka "Hned jsem zpět": schová hru i kameru (soukromí, pauza) - zkratka, lišta, záložka Živě. */
  toggleLiveBrb(force?: boolean): boolean {
    const state = this.live.current().state;
    if (state !== 'live' && state !== 'reconnecting' && state !== 'starting') {
      void this.toast.show(this.t('toastBrbNotLive'), 'warn');
      return false;
    }
    this.liveBrb = force ?? !this.liveBrb;
    this.live.setScene(this.liveScene());
    void this.toast.show(this.t(this.liveBrb ? 'toastBrbOn' : 'toastBrbOff'), 'ok', { sound: true });
    this.pushStatus();
    return this.liveBrb;
  }

  /** Ztlumí / zapne mikrofon jen ve vysílání (klipy se nemění). */
  setLiveMicMuted(muted: boolean): boolean {
    if (!this.live.active()) return false;
    this.liveMicMuted = !!muted;
    this.live.setScene(this.liveScene());
    void this.toast.show(this.t(this.liveMicMuted ? 'toastLiveMicMuted' : 'toastLiveMicOn'), 'ok', { sound: true });
    this.pushStatus();
    return this.liveMicMuted;
  }

  /**
   * Kine se přestěhovalo na vlastní doménu: web hlásí novou hlavní adresu
   * (/api/desktop/config) a appka na ni přejde, když tam běží stejné Kine
   * (src/main/siteMove.ts). Přihlášení zůstává; okno Kine se načte znovu.
   */
  private async followSiteMove(): Promise<void> {
    // Testy (e2e) mluví s napodobeným webem - adresa se jim nemění.
    if (process.env.KINE_TEST) return;
    const current = this.settings.get().siteUrl;
    const next = await checkSiteMove(current).catch(() => null);
    if (!next || next === this.settings.get().siteUrl) return;
    log(`Kine má novou adresu: ${current} -> ${next}`);
    this.settings.update({ siteUrl: next });
  }

  /** Stránka vysílání na Kine (diváci, chat) - v Kine do PC v okně, v Klipovači v prohlížeči. */
  openLivePage(): void {
    const url = this.live.current().watchUrl;
    const site = this.settings.get().siteUrl;
    this.openKine(url && url.startsWith(site) ? url.slice(site.length) : '/live');
  }

  /** Okno s dialogem Vysílat (z lišty u hodin). */
  openLiveDialog(): void {
    this.openSettings('live');
  }

  /** Záznam posledního vysílání na Kine (karta v záložce Živě, okénko). */
  openLiveRecording(): void {
    const video = this.live.current().ended?.video;
    this.openKine(video ? `/watch/${video.id}` : '/live');
  }

  /** Zveřejnit záznam posledního vysílání (karta v záložce Živě). */
  async publishLiveRecording(opts: { title?: unknown; visibility?: unknown }): Promise<void> {
    const s = this.settings.get();
    const visibility = (VISIBILITIES as readonly string[]).includes(String(opts?.visibility)) ? (opts.visibility as Visibility) : 'public';
    await this.live.publishRecording({ title: typeof opts?.title === 'string' ? opts.title : undefined, visibility, language: s.videoLanguage });
  }

  /**
   * Záznam vysílání do PC (karta skončeného vysílání -> Stáhnout do PC): MP4
   * od Cloudflare do složky s klipy, náhled a do knihovny jako nahrávka.
   * Stahuje se do ".part" a přejmenuje až celé - napůl stažený soubor se
   * v knihovně nikdy neobjeví.
   */
  async saveStreamRecording(info: { url: string; title: string; endedAt: number; onProgress: (percent: number | null) => void }): Promise<string> {
    const dir = this.settings.clipsDir();
    mkdirSync(dir, { recursive: true });
    const ended = new Date(info.endedAt);
    const base = `${clipFileBase(ended, null)} ${safeFilePart(info.title || 'Kine', 40)} (${safeFilePart(this.t('liveRecordingFileWord'), 20)})`;
    let file = join(dir, `${base}.mp4`);
    for (let n = 2; existsSync(file); n++) file = join(dir, `${base} ${n}.mp4`);
    const part = `${file}.part`;
    const res = await fetch(info.url, { signal: AbortSignal.timeout(6 * 3600 * 1000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let reportedAt = 0;
    // Počítadlo pro procenta; pipeline hlídá chyby na obou stranách (plný disk, zamčený soubor,
    // přerušené spojení) - bez ní by zápis po chybě čekal donekonečna a karta visela.
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        const now = Date.now();
        if (now - reportedAt > 400) {
          reportedAt = now;
          info.onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : null);
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), counter, createWriteStream(part));
      if (total > 0 && received < total) throw new Error('download incomplete');
      renameSync(part, file);
    } catch (e) {
      // Napůl stažený soubor pryč - v knihovně se nikdy neobjeví a nezabírá místo.
      try {
        rmSync(part, { force: true });
      } catch {
        // nic
      }
      throw e;
    }
    const probed = await probe(file);
    const duration = probed.durationSeconds ?? 0;
    const thumbsDir = join(app.getPath('userData'), 'thumbs');
    mkdirSync(thumbsDir, { recursive: true });
    const thumb = join(thumbsDir, `${basename(file, '.mp4')}-${Date.now().toString(36)}.jpg`);
    const thumbOk = await makeThumbnail(file, thumb, Math.min(5, duration / 2));
    const clip: Clip = {
      id: randomUUID(),
      file,
      thumb: thumbOk ? thumb : null,
      title: `${info.title || 'Kine'} · ${this.t('liveRecordingFileWord')}`.slice(0, 150),
      game: null,
      createdAt: new Date(Math.max(0, info.endedAt - duration * 1000)).toISOString(),
      addedAt: new Date().toISOString(),
      durationSeconds: duration,
      sizeBytes: statSync(file).size,
      width: probed.width,
      height: probed.height,
      sessionId: 'live-' + randomUUID(),
      upload: null,
      kind: 'recording',
    };
    this.library.add(clip);
    this.pushStatus();
    log(`záznam vysílání stažený: ${file} (${Math.round(duration)} s)`);
    return file;
  }

  async downloadLiveRecording(): Promise<void> {
    await this.live.downloadRecording();
  }

  async discardLiveRecording(): Promise<void> {
    await this.live.discardRecording();
  }

  /** Co se záznamem po skončení vysílání - nastavení žije na Kine (stejné jako ve studiu na webu). */
  async liveAfterStream(): Promise<LiveAfterStream | null> {
    if (!this.auth.current()) return null;
    try {
      const setup = await this.kineApi.liveSetup();
      return {
        value: setup.recordingVisibility,
        supported: setup.recordingAutoSupported,
        ...(setup.stream && setup.stream.thumbnailUrl !== undefined ? { thumbnailUrl: setup.stream.thumbnailUrl } : {}),
      };
    } catch (e) {
      log(`vysílání: nastavení záznamu nejde načíst: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Vlastní náhled přenosu (záložka Živě): obrázek už zmenšený na 1280×720
   * (JPEG, zmenšuje ho okno appky stejně jako studio na webu) -> Kine.
   */
  async setLiveThumbnail(bytes: unknown): Promise<{ thumbnailUrl: string | null }> {
    if (!this.auth.current()) throw new Error('login');
    const jpeg =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : ArrayBuffer.isView(bytes)
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : new Uint8Array(0);
    if (!looksLikeLiveThumbnail(jpeg)) throw new Error('not-jpeg');
    try {
      const result = await this.kineApi.liveSetThumbnail(jpeg);
      log(`vysílání: vlastní náhled uložený (${Math.round(jpeg.length / 1024)} kB)`);
      return result;
    } catch (e) {
      log(`vysílání: náhled nejde uložit: ${(e as Error).message}`);
      throw e;
    }
  }

  async removeLiveThumbnail(): Promise<void> {
    if (!this.auth.current()) throw new Error('login');
    try {
      await this.kineApi.liveRemoveThumbnail();
      log('vysílání: náhled zase snímek z vysílání');
    } catch (e) {
      log(`vysílání: náhled nejde odebrat: ${(e as Error).message}`);
      throw e;
    }
  }

  async setLiveAfterStream(value: unknown): Promise<LiveAfterStream | null> {
    if (!this.auth.current()) return null;
    const visibility = (VISIBILITIES as readonly string[]).includes(String(value)) ? (value as Visibility) : null;
    try {
      const result = await this.kineApi.liveSetRecordingVisibility(visibility);
      this.live.setAutoPublish(result.supported && result.value !== null);
      log(`vysílání: po skončení ${result.value ?? 'nechat ve studiu'}${result.supported ? '' : ' (Kine to zatím neumí)'}`);
      return result;
    } catch (e) {
      log(`vysílání: nastavení záznamu nejde uložit: ${(e as Error).message}`);
      throw e;
    }
  }

  /**
   * Chat vlastního vysílání v malém okně (jako "popout chat" na Twitchi):
   * jde dát na druhý monitor, nebo nechat nahoře nad hrou v okně bez
   * rámečku. Relace je stejná jako u Kine v okně; přihlášení appky se do
   * něj předá jednorázovým tokenem (/connect/app), ať jde i psát.
   */
  async openLiveChat(): Promise<void> {
    const account = this.auth.current();
    const watchUrl = this.live.current().watchUrl;
    const ownerId = watchUrl?.split('/live/')[1]?.split(/[/?#]/)[0] || account?.userId || null;
    if (!ownerId) {
      this.openSettings('account');
      return;
    }
    const onTop = this.settings.get().liveChatOnTop;
    if (this.chatWindow && !this.chatWindow.isDestroyed()) {
      this.chatWindow.setAlwaysOnTop(onTop, 'floating');
      this.chatWindow.show();
      this.chatWindow.focus();
      return;
    }
    const site = this.settings.get().siteUrl;
    const chatPath = `/live/${encodeURIComponent(ownerId)}/chat`;
    const win = new BrowserWindow({
      width: 380,
      height: 640,
      minWidth: 280,
      minHeight: 320,
      title: this.t('liveChatWindowTitle'),
      backgroundColor: '#0b0b0d',
      autoHideMenuBar: true,
      icon: this.appIcon(),
      webPreferences: { partition: 'persist:kine-web', contextIsolation: true, sandbox: true, spellcheck: true },
    });
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(onTop, 'floating');
    this.chatWindow = win;
    win.on('closed', () => {
      if (this.chatWindow === win) this.chatWindow = null;
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    win.webContents.setUserAgent(`${win.webContents.getUserAgent()} KineDesktop/${app.getVersion()}`);
    // Odkazy z chatu do prohlížeče; okno zůstává u chatu.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, target) => {
      if (!this.isKineUrl(target)) {
        e.preventDefault();
        if (/^https?:/.test(target)) void shell.openExternal(target);
      }
    });
    let url = site + chatPath;
    if (account) {
      try {
        const th = await this.auth.webLinkToken();
        if (th) url = `${site}/connect/app?th=${encodeURIComponent(th)}&next=${encodeURIComponent(chatPath)}`;
      } catch (e) {
        log(`chat v okně: přihlášení se nepředalo (${(e as Error).message}) - jen ke čtení`);
      }
    }
    if (!win.isDestroyed()) void win.loadURL(url);
  }

  /** Po konci vysílání: zásobník, který rozjelo jen vysílání, se zase vypne. */
  private afterLive(): void {
    const s = this.settings.get();
    const keep = !this.paused && (s.detection === 'always' || (s.detection === 'games' && !!this.games.current()));
    // I ze stavu "chyba": snímací stránka by jinak zůstala viset (vysílání ji rozjelo, nikdo jiný ji nechce).
    if (this.liveStartedCapture && !keep && (this.capture.state === 'on' || this.capture.state === 'error')) void this.stopCapture('buffer-off');
    this.liveStartedCapture = false;
    this.pushStatus();
  }

  private liveErrorText(message: string | undefined): string {
    const clean = cleanLiveError(message ?? '');
    const key = liveErrorTextKey(clean);
    return this.t(key, key === 'liveErrOther' ? { message: clean.slice(0, 160) } : {});
  }

  private onLiveNotice(kind: 'live' | 'reconnecting' | 'ended' | 'failed' | 'slow' | 'recording' | 'compat', info: { error?: string; duration?: string; url?: string }): void {
    if (kind === 'live') void this.toast.show(this.t('toastLiveStarted'), 'ok', { notification: true, onClick: () => this.openLivePage() });
    else if (kind === 'compat') void this.toast.show(this.t('toastLiveCompat'), 'warn', { onClick: () => this.openSettings('live') });
    else if (kind === 'reconnecting') void this.toast.show(this.t('toastLiveReconnecting'), 'warn');
    else if (kind === 'ended') {
      // Klik vede na kartu záznamu v záložce Živě (zveřejnit na Kine / otevřít).
      const auto = !!this.live.current().ended?.autoPending;
      void this.toast.show(this.t(auto ? 'toastLiveEndedAuto' : 'toastLiveEndedPublish', { duration: info.duration ?? '' }), 'ok', { onClick: () => this.openSettings('live') });
    } else if (kind === 'recording') void this.toast.show(this.t('toastLiveRecordingOnKine'), 'ok', { notification: true, onClick: () => this.openLiveRecording() });
    else if (kind === 'slow') void this.toast.show(this.t('toastLiveSlow'), 'warn', { notification: true });
    else void this.toast.show(this.t('toastLiveFailed', { message: this.liveErrorText(info.error) }), 'error', { notification: true });
  }

  /**
   * Stisk zkratky (nebo automatický klip z herní události - `auto` s popiskem
   * série, třeba "Triple kill"). Klipy se řadí za sebe - dva rychlé stisky
   * = dva klipy. Automatický klip bez běžícího zásobníku se tiše vynechá.
   */
  onClipHotkey(opts: { auto?: boolean; label?: string } = {}): Promise<Clip | null> {
    // Čas stisku (klipy se řadí za sebe - značka v nahrávce patří ke stisku, ne k chvíli, kdy na klip přijde řada).
    const pressedAt = Date.now();
    // Okénko a zvuk HNED při stisku ("Ukládám klip…") - dřív přišly až s hotovým souborem, i za 10 s.
    // Výsledek (uloženo / chyba) pak jen přepíše totéž okénko.
    let pending: ToastHandle | null = null;
    if (this.capture.state === 'on') {
      const saving = this.t('toastClipSaving', { seconds: this.effectiveClipSeconds() });
      pending = this.toast.pending(opts.label ? `${saving} · ${opts.label}` : saving);
      this.clipsSaving += 1;
      this.pushStatusSoon();
    }
    const run = async (): Promise<Clip | null> => {
      try {
        return await this.saveClip(opts, pressedAt, pending);
      } finally {
        if (pending) {
          this.clipsSaving = Math.max(0, this.clipsSaving - 1);
          this.pushStatusSoon();
        }
      }
    };
    const next = this.clipChain.then(run, run);
    this.clipChain = next.catch(() => undefined);
    return next;
  }

  /** Jeden klip ze zásobníku (fronta klipů - viz onClipHotkey). `pending` = okénko, které už visí od stisku. */
  private async saveClip(opts: { auto?: boolean; label?: string }, pressedAt: number, pending: ToastHandle | null): Promise<Clip | null> {
    {
      const s = this.settings.get();
      const toggleLabel = hotkeyLabel(s.toggleHotkey);
      // Výsledek do okénka od stisku, nebo (když žádné není) nové okénko.
      const finish = (text: string, kind: 'ok' | 'warn' | 'error', options: ToastOptions = {}) => {
        if (pending) pending.done(text, kind, options);
        else void this.toast.show(text, kind, { ...options, sound: options.sound ?? true });
      };
      if (this.capture.state !== 'on') {
        if (opts.auto && !pending) return null;
        const key: Key = s.detection === 'manual' ? 'toastNotCapturingManual' : 'toastNotCapturing';
        finish(this.t(key, { hotkey: toggleLabel }), 'warn', { sound: false });
        return null;
      }
      const game = this.games.current();
      // Během nahrávání zápasu je každý klip zároveň značka v nahrávce (kapitola na Kine).
      if (this.capture.recordingInfo()) {
        this.recordingMarkers.push({ at: pressedAt, label: opts.label ?? this.t('markerClip', { n: this.recordingMarkers.length + 1 }) });
      }
      try {
        const result = await this.capture.makeClip(this.effectiveClipSeconds(), this.settings.clipsDir(), game?.name ?? null, join(app.getPath('userData'), 'thumbs'));
        const baseTitle = defaultClipTitle(result.createdAt, game?.name ?? null, this.t('clipWord'));
        const clip: Clip = {
          id: randomUUID(),
          file: result.file,
          thumb: result.thumb,
          title: opts.label ? `${baseTitle} · ${opts.label}`.slice(0, 150) : baseTitle,
          game: game?.name ?? null,
          createdAt: result.createdAt.toISOString(),
          durationSeconds: result.durationSeconds,
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          sessionId: game ? this.sessionId : 'no-game-' + this.sessionId,
          upload: null,
          audioTracks: result.audioTracks,
        };
        this.library.add(clip);
        const seconds = Math.round(result.durationSeconds);
        const text = game ? this.t('toastClipSavedGame', { seconds, game: game.name }) : this.t('toastClipSaved', { seconds });
        finish(opts.label ? `${text} · ${opts.label}` : text, 'ok', { notification: !s.toast, onClick: () => this.openSettings('clips') });
        if (opts.label) log(`automatický klip: ${opts.label}`);
        // Bez hry (režim "pořád"/"ručně") se po ničem nečeká - nabídnout hned podle nastavení.
        if (!game && this.effectiveAfterGame() === 'auto') this.uploader.enqueue([{ clipId: clip.id, visibility: s.visibility }]);
        this.enforceStorageLimit();
        return clip;
      } catch (e) {
        const message = (e as Error).message;
        if (opts.auto && !pending && (message === 'too-early' || message === 'not-capturing')) return null;
        if (message === 'too-early') finish(this.t('toastTooEarly'), 'warn', { sound: false });
        else if (message === 'not-capturing') finish(this.t('toastNotCapturing', { hotkey: toggleLabel }), 'warn', { sound: false });
        else finish(this.t('toastClipFailed', { message }), 'error', { notification: true });
        return null;
      }
    }
  }

  async onToggleHotkey(): Promise<void> {
    const s = this.settings.get();
    if (this.live.active()) {
      void this.toast.show(this.t('toastLiveKeepsCapture'), 'warn');
      return;
    }
    if (this.capture.state === 'on' || this.capture.state === 'starting') {
      await this.stopCapture('buffer-off');
      void this.toast.show(this.t('toastBufferOff'), 'warn', { sound: true });
    } else {
      // Ručně zapnuto = žádná pauza ani čekání na první hru (po spuštění appky).
      this.paused = false;
      this.waitingForFirstGame = false;
      await this.capture.start().catch(() => undefined);
      if ((this.capture.state as string) === 'on') {
        void this.toast.show(this.t('toastBufferOn', { hotkey: hotkeyLabel(s.clipHotkey), seconds: Math.min(s.clipSeconds, this.effectiveClipSeconds()) }), 'ok', { sound: true });
      }
    }
    this.rebuildTray();
    this.pushStatus();
  }

  // ---- nastavení ----------------------------------------------------------------

  private onSettingsChanged(s: Settings, prev: Settings): void {
    // Vzhled: průhledné okno (Windows 11) zapnout / vypnout hned.
    if (s.look !== prev.look || s.glassWindow !== prev.glassWindow) this.applyWindowGlass(this.settingsWindow);
    // Okno s chatem: "drž nahoře" platí hned.
    if (s.liveChatOnTop !== prev.liveChatOnTop && this.chatWindow && !this.chatWindow.isDestroyed()) this.chatWindow.setAlwaysOnTop(s.liveChatOnTop, 'floating');
    if (
      s.clipHotkey !== prev.clipHotkey ||
      s.toggleHotkey !== prev.toggleHotkey ||
      s.recordHotkey !== prev.recordHotkey ||
      s.liveBrbHotkey !== prev.liveBrbHotkey
    )
      this.registerHotkeys();
    if (s.storageLimitGb !== prev.storageLimitGb) {
      // Ne hned: šipkami v seznamu se dá projet "Bez omezení -> 20 GB -> 50 GB" a každá
      // zastávka by mazala nadobro. Strop se uplatní, až se volba ustálí.
      if (this.storageLimitTimer) clearTimeout(this.storageLimitTimer);
      this.storageLimitTimer = setTimeout(() => {
        this.storageLimitTimer = null;
        this.enforceStorageLimit();
      }, 15_000);
      this.storageLimitTimer.unref?.();
    }
    // Kamera a text "Hned jsem zpět" se dají měnit i za běhu vysílání - projeví se hned.
    const sceneKeys: (keyof Settings)[] = ['liveCamera', 'liveCameraDevice', 'liveCameraPosition', 'liveCameraSize', 'liveCameraShape', 'liveCameraMirror', 'liveBrbText', 'liveBrbMuteMic', 'lang'];
    if (this.live.active() && sceneKeys.some((k) => s[k] !== prev[k])) this.live.setScene(this.liveScene());
    if (s.startWithSystem !== prev.startWithSystem) this.applyLoginItem();
    if (s.desktopShortcut !== prev.desktopShortcut) this.ensureShortcuts(true);
    if (s.clipsDir !== prev.clipsDir) {
      // Zmenšování patří ke staré složce - zastavit (rozdělaný klip zůstane, jak byl).
      this.compressor.cancel();
      this.library.load(this.settings.clipsDir());
    }
    const captureKeys: (keyof Settings)[] = ['maxHeight', 'fps', 'codec', 'videoMbps', 'systemAudio', 'systemAudioDevice', 'microphone', 'microphoneDevice', 'systemGain', 'micGain', 'displayId'];
    if (captureKeys.some((k) => s[k] !== prev[k])) {
      // Změna kvality = nový start zásobníku; rozjetá nahrávka se nejdřív uloží.
      void (async () => {
        // Rozjetá nahrávka se uloží; ta, co se právě ukládá, se nejdřív doukládá (jinak by přišla o zvuk).
        if (this.capture.recordingInfo() || this.finishingRecording) await this.finishRecording('buffer-off');
        await this.capture.restartIfOn();
      })();
    }
    if (s.detection !== prev.detection) {
      this.waitingForFirstGame = false;
      if (s.detection === 'always') {
        if (!this.paused) void this.capture.start().catch(() => undefined);
      } else if (s.detection === 'games' && !this.games.current()) void this.stopCapture('buffer-off');
      else if (s.detection === 'manual') void this.stopCapture('buffer-off');
    }
    if (s.detectFullscreen !== prev.detectFullscreen) void this.games.refresh();
    if (s.appMode !== prev.appMode && s.appMode === 'clipper') this.destroyKineView();
    if (s.siteUrl !== prev.siteUrl) this.destroyKineView();
    if (s.brandColor !== prev.brandColor) this.applyBrandIcons();
    if (s.performance !== prev.performance) {
      log(`výkon appky: ${s.performance}`);
      this.applyHelperTiming();
      this.games.restart();
    }
    void this.gameEvents.onSettingsChanged(prev, s);
    this.rebuildTray();
    this.pushStatus();
    this.broadcast('settings', s);
  }

  /**
   * Zaregistruje zkratky. Co nejde, se NEHLÁSÍ okénkem (po startu appky
   * chodila oznámení "F9 nebude fungovat" - většinou jen proto, že ji na
   * chvíli držela druhá appka Kine, která se hned vypnula). Zkratka se
   * zkouší znovu každých 15 s; trvalý problém je vidět v okně a v liště
   * u hodin, a okénkem se řekne jen jednou, když začne hra a klipovací
   * zkratka pořád nejde (warnIfClipHotkeyBroken).
   */
  private registerHotkeys(): void {
    const s = this.settings.get();
    this.hotkeys.apply({ clip: s.clipHotkey, toggle: s.toggleHotkey, record: s.recordHotkey, brb: s.liveBrbHotkey });
    this.syncHotkeyNotices();
  }

  /** Problémy se zkratkami jako tichá upozornění v okně (zmizí, jakmile zkratka jde). */
  private syncHotkeyNotices(): void {
    const problems = this.hotkeys.currentProblems().filter((p) => p.reason !== 'helper-down' || Date.now() - this.startedAt > 30000);
    const ids = new Set(problems.map((p) => `hotkey:${p.id}`));
    this.notices = this.notices.filter((n) => !n.id.startsWith('hotkey:') || ids.has(n.id));
    for (const p of problems) {
      const text = this.t('hotkeyProblem', { hotkey: hotkeyLabel(p.hotkey), reason: this.hotkeyReasonText(p.reason) });
      const existing = this.notices.find((n) => n.id === `hotkey:${p.id}`);
      if (existing) existing.text = text;
      else this.notices.push({ id: `hotkey:${p.id}`, text, kind: 'warn', at: Date.now(), tab: 'settings:hotkeys' });
    }
  }

  /**
   * Začala hra a klipovací zkratka pořád nejde (drží ji jiný program):
   * jedno okénko za běh appky - teď to hráče zajímá, chce klipovat.
   */
  private warnIfClipHotkeyBroken(): void {
    // Hned po spuštění appky (hra už běží) zkratku často ještě chvíli drží druhá
    // appka Kine, která se právě vypíná - zkontrolovat až po klidné chvíli.
    const sinceStart = Date.now() - this.startedAt;
    if (sinceStart < 45000) {
      if (!this.hotkeyCheckTimer) {
        this.hotkeyCheckTimer = setTimeout(() => {
          this.hotkeyCheckTimer = null;
          if (this.games.current()) this.warnIfClipHotkeyBroken();
        }, 45000 - sinceStart + 1000);
        this.hotkeyCheckTimer.unref?.();
      }
      return;
    }
    this.hotkeys.retry();
    const problem = this.hotkeys.currentProblems().find((p) => p.id === 'clip' && p.reason !== 'helper-down');
    if (!problem || this.warnedOnce.has('clip-hotkey')) return;
    this.warnedOnce.add('clip-hotkey');
    void this.toast.show(this.t('hotkeyProblem', { hotkey: hotkeyLabel(problem.hotkey), reason: this.hotkeyReasonText(problem.reason) }), 'warn', {
      sound: true,
      onClick: () => this.openSettings('settings:hotkeys'),
    });
  }

  // ---- tichá upozornění (v okně místo okének) ------------------------------------------

  private addNotice(notice: Omit<AppNotice, 'at'>): void {
    this.notices = [...this.notices.filter((n) => n.id !== notice.id), { ...notice, at: Date.now() }].slice(-8);
    this.pushStatusSoon();
  }

  dismissNotice(id: string): void {
    const before = this.notices.length;
    this.notices = this.notices.filter((n) => n.id !== id);
    // Zavřené upozornění na neprošlou aktualizaci zavře i vysvětlení v O appce (a naopak).
    if (id === 'update-failed' && this.updateIssue) {
      this.updateIssue = null;
      this.pushStatus();
      return;
    }
    if (this.notices.length !== before) this.pushStatus();
  }

  /**
   * Upozornění, které nemá rušit: vždycky v okně (postranní panel), okénkem
   * jen když appka neběží teprve chvilku (po startu se nic "jen tak"
   * neukazuje). Systémové oznámení nikdy.
   */
  private quietNotice(id: string, text: string, kind: 'warn' | 'info', tab?: string): void {
    log(`upozornění: ${text}`);
    this.addNotice({ id, text, kind, tab });
    if (Date.now() - this.startedAt < 45000) return;
    void this.toast.show(text, kind === 'info' ? 'ok' : 'warn', tab ? { onClick: () => this.openSettings(tab) } : {});
  }

  /** Stav do oken nejvýš ~4x za sekundu (průběh ukládání, počty) - celé překreslení stojí. */
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private pushStatusSoon(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.pushStatus();
    }, 250);
  }

  // ---- úsporné snímání na baterii ---------------------------------------------------------

  /**
   * Nastavení pro snímání: na notebooku na baterii (a se zapnutou volbou)
   * nejvýš 720p, 30 fps a 5 Mb/s - šetří baterii i výkon, který hra na
   * baterii stejně nemá. Platí od startu snímání (rozjeté se nepřerušuje).
   */
  private captureSettings(): Settings {
    const s = this.settings.get();
    if (!this.batterySaving) return s;
    return { ...s, maxHeight: s.maxHeight === 0 || s.maxHeight > 720 ? 720 : s.maxHeight, fps: 30, videoMbps: Math.min(s.videoMbps, 5) };
  }

  /** Při startu snímání: běží notebook na baterii (a hráč úsporu chce)? */
  private checkBattery(): void {
    let onBattery = false;
    try {
      onBattery = this.settings.get().batterySaver && powerMonitor.isOnBatteryPower();
    } catch {
      onBattery = false;
    }
    if (onBattery !== this.batterySaving) log(onBattery ? 'na baterii - snímá se úsporně (720p, 30 fps)' : 'ze sítě - snímá se v plné kvalitě');
    this.batterySaving = onBattery;
  }

  // ---- strop místa na klipy ---------------------------------------------------------------

  /** Když klipy přerostou strop z nastavení, uvolní se místo (koš, pak nejstarší - viz shared/storage.ts). */
  private enforceStorageLimit(): void {
    const limitGb = this.settings.get().storageLimitGb;
    if (!limitGb) return;
    const plan = storageCleanupPlan(this.library.listAll(), limitGb * GB);
    if (plan.ids.length === 0) {
      if (plan.stillOver) this.addNotice({ id: 'storage', text: this.t('storageLimitStillOver', { gb: limitGb }), kind: 'warn', tab: 'settings:storage' });
      return;
    }
    for (const id of plan.ids) this.library.purge(id);
    log(`místo na klipy: strop ${limitGb} GB - smazáno ${plan.ids.length} (z toho ${plan.clipCount} klipů), uvolněno ${Math.round(plan.freedBytes / 1024 ** 2)} MB`);
    if (plan.clipCount > 0) this.addNotice({ id: 'storage', text: this.t('storageLimitCleaned', { count: plan.clipCount, gb: limitGb }), kind: 'info', tab: 'clips' });
    this.pushClips();
  }

  hotkeyReasonText(reason: HotkeyReason): string {
    switch (reason) {
      case 'in-use':
        return this.t('hotkeyInUse');
      case 'unsupported':
        return this.t('hotkeyChordUnsupported');
      case 'helper-down':
        return this.helper?.isBlocked() ? this.t('hotkeyHelperBlocked') : this.t('hotkeyHelperDown');
      default:
        return reason;
    }
  }

  /**
   * Zástupci appky: na ploše (když ho hráč nevypnul - spouští se dvojklikem
   * jako hra) a v nabídce Start (hledání, oznámení Windows). Chybějící se
   * vytvoří (po instalaci a aktualizaci), vypnutý zástupce na ploše se smaže
   * - jen ten, který opravdu vede na tuhle appku.
   */
  private ensureShortcuts(settingChanged = false, afterInstall = false): void {
    if (process.platform !== 'win32' || !app.isPackaged || process.env.KINE_TEST) return;
    const target = process.execPath;
    const name = `${PRODUCT}.lnk`;
    const options = { target, cwd: dirname(target), icon: target, iconIndex: 0, appUserModelId: APP_USER_MODEL_IDS[VARIANT], description: PRODUCT };
    const desktop = join(app.getPath('desktop'), name);
    const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', name);
    const pointsHere = (file: string): boolean => {
      try {
        return shell.readShortcutLink(file).target.toLowerCase() === target.toLowerCase();
      } catch {
        return false;
      }
    };
    const wantDesktop = this.settings.get().desktopShortcut;
    try {
      if (wantDesktop && !existsSync(desktop)) {
        log(shell.writeShortcutLink(desktop, 'create', options) ? `zástupce na ploše vytvořen (${desktop})` : 'zástupce na ploše nejde vytvořit');
      } else if (!wantDesktop && (settingChanged || afterInstall) && existsSync(desktop) && pointsHere(desktop)) {
        rmSync(desktop, { force: true });
        log('zástupce na ploše smazán (vypnutý v nastavení)');
      }
      if (!settingChanged && !existsSync(startMenu)) {
        log(shell.writeShortcutLink(startMenu, 'create', options) ? 'zástupce v nabídce Start vytvořen' : 'zástupce v nabídce Start nejde vytvořit');
      }
    } catch (e) {
      log(`zástupci: ${(e as Error).message}`);
    }
  }

  private applyLoginItem(): void {
    if (!app.isPackaged) return;
    try {
      app.setLoginItemSettings({ openAtLogin: this.settings.get().startWithSystem, args: ['--hidden'] });
    } catch (e) {
      log(`spouštění se systémem: ${(e as Error).message}`);
    }
  }

  private installDisplayMediaHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const s = this.settings.get();
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
          const primaryId = String(screen.getPrimaryDisplay().id);
          const source =
            sources.find((x) => x.display_id === s.displayId && s.displayId) ??
            sources.find((x) => x.display_id === primaryId) ??
            sources[0];
          if (!source) throw new Error('no display');
          const audio = request.audioRequested && process.platform === 'win32' && s.systemAudio ? 'loopback' : undefined;
          callback(audio ? { video: source, audio } : { video: source });
        } catch (e) {
          log(`výběr obrazovky selhal: ${(e as Error).message}`);
          callback({});
        }
      },
      { useSystemPicker: false }
    );
    // Mikrofon pro skrytou snímací stránku, celá obrazovka pro přehrávač klipů
    // (tlačítko ⛶ v přehrávači jinak nic neudělá), oznámení.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'display-capture', 'notifications', 'fullscreen', 'pointerLock'].includes(permission));
    });
  }

  // ---- tray -------------------------------------------------------------------

  private createTray(): void {
    this.tray = new Tray(trayIcon(this.appIcon()));
    const open = () => this.openSettings(this.settings.get().appMode === 'full' && this.settings.get().onboarded ? 'kine' : undefined);
    this.tray.on('click', open);
    this.tray.on('double-click', open);
    this.rebuildTray();
  }

  /**
   * Hladiny zvuku ze snímací stránky: okna dostanou měřáky (kanál
   * "audio:levels", ne přes status - ten přestavuje i nabídku u hodin).
   * Když hra běží a zvuk hry je 20 s úplně tichý, hráč dostane jednou
   * upozornění, odkud appka zvuk bere (výchozí výstup Windows) - typicky
   * hra hraje do jiného zařízení, než je ve Windows výchozí.
   */
  private onAudioLevels(levels: AudioLevels): void {
    // Měřáky jen do okna nastavení (jinam nepatří a 10x za sekundu je zbytečné všem).
    const win = this.settingsWindow;
    if (win && !win.isDestroyed()) win.webContents.send('audio:levels', levels);
    const game = this.games.current();
    if (levels.system !== null && game && levels.systemSilentSeconds >= 20 && this.silenceWarnedFor !== this.capture.captureSession()) {
      this.silenceWarnedFor = this.capture.captureSession();
      const device = levels.systemDevice || this.t('audioDefaultDevice');
      const text = this.t('toastSystemAudioSilent', { game: game.name, device });
      // Okénko ve hře (klipy by byly bez zvuku hry - teď to hráče zajímá) + v okně; systémové oznámení ne.
      this.addNotice({ id: 'audio-silent', text, kind: 'warn', tab: 'settings:audio' });
      void this.toast.show(text, 'warn', { onClick: () => this.openSettings('settings:audio') });
    } else if (levels.system !== null && levels.systemSilentSeconds === 0 && this.notices.some((n) => n.id === 'audio-silent')) {
      this.dismissNotice('audio-silent');
    }
  }

  statusLine(): string {
    const s = this.settings.get();
    const game = this.games.current();
    const rec = this.capture.recordingInfo();
    if (rec) return this.t('trayRecording', { game: game?.name ?? rec.game ?? '' }).replace(/\s*·\s*$/, '');
    const saving = this.capture.savingInfo();
    if (saving) return this.t('trayRecordingSaving', { percent: saving.percent ?? 0 });
    if (this.paused) return this.t('trayPaused');
    if (this.capture.state === 'on' || this.capture.state === 'starting') {
      return game ? this.t('trayCapturing', { game: game.name }) : this.t('trayCapturingNoGame');
    }
    if (s.detection === 'manual') return this.t('trayIdleManual', { hotkey: hotkeyLabel(s.toggleHotkey) });
    if (s.detection === 'always') return this.t('trayIdleAlways');
    return this.t('trayIdle');
  }

  rebuildTray(): void {
    if (!this.tray) return;
    const s = this.settings.get();
    const pending = this.uploader.pending();
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: `${PRODUCT} · ${this.statusLine()}`, enabled: false },
    ];
    if (pending > 0) {
      items.push({ label: this.uploader.isPausedByGame() ? this.t('trayUploadsPaused', { count: pending }) : this.t('trayUploads', { count: pending }), enabled: false });
    }
    if (!this.auth.current()) items.push({ label: this.t('trayNotLoggedIn'), click: () => this.openSettings('account') });
    // Zkratka, která nejde (drží ji jiný program) - vidět i bez otevření okna, klik vede do nastavení.
    for (const p of this.hotkeys.currentProblems().filter((x) => x.reason !== 'helper-down')) {
      items.push({ label: `⚠ ${this.t('hotkeyProblem', { hotkey: hotkeyLabel(p.hotkey), reason: this.hotkeyReasonText(p.reason) })}`, click: () => this.openSettings('settings:hotkeys') });
    }
    const saving = this.capture.savingInfo();
    const liveState = this.live.current().state;
    const onAir = liveState === 'live' || liveState === 'reconnecting';
    items.push(
      { type: 'separator' },
      { label: this.t('trayClipNow', { hotkey: hotkeyLabel(s.clipHotkey) }), click: () => void this.onClipHotkey(), enabled: this.capture.state === 'on' },
      saving
        ? { label: this.t('trayRecordingSaving', { percent: saving.percent ?? 0 }), enabled: false }
        : {
            label: this.capture.recordingInfo() ? this.t('trayRecordStop') : this.t('trayRecordStart', { hotkey: s.recordHotkey ? hotkeyLabel(s.recordHotkey) : '' }).replace(/\s*\(\)$/, ''),
            click: () => void this.toggleRecording(),
            enabled: this.capture.state === 'on',
          },
      liveState === 'idle'
        ? { label: this.t('trayLiveStart'), click: () => this.openLiveDialog() }
        : liveState === 'stopping'
          ? { label: this.t('trayLiveStopping'), enabled: false }
          : { label: this.t('trayLiveStop', { time: liveElapsed(this.live.current().since) }), click: () => void this.stopLive() }
    );
    if (onAir) {
      // Během vysílání: "Hned jsem zpět" (schová hru i kameru) a ztlumení mikrofonu - bez přepínání do okna.
      items.push(
        { label: this.t('trayLiveBrb'), type: 'checkbox', checked: this.liveBrb, click: () => this.toggleLiveBrb() },
        { label: this.t('trayLiveMuteMic'), type: 'checkbox', checked: this.liveMicMuted, click: () => this.setLiveMicMuted(!this.liveMicMuted) }
      );
    }
    items.push(
      { label: this.t('trayLibrary'), click: () => this.openSettings('clips') },
      { label: this.t('traySettings'), click: () => this.openSettings('settings') },
      { label: this.paused ? this.t('trayResume') : this.t('trayPause'), click: () => void this.togglePause() },
      { label: this.t('trayOpenKine'), click: () => this.openKine() },
      { type: 'separator' }
    );
    // Stažená aktualizace: jedním klikem restart do nové verze (během vysílání / nahrávání vede do okna, kde se řekne proč ne).
    const update = updateProgress();
    if (update.phase === 'ready') {
      items.push({
        label: this.t('trayUpdateNow', { version: update.version ?? '' }),
        click: () =>
          void this.installUpdate().then((r) => {
            if (r !== 'ok') this.openSettings('about');
          }),
      });
    }
    items.push({ label: this.t('trayQuit'), click: () => this.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(`${PRODUCT} · ${this.statusLine()}`);
    // Červená tečka na ikoně, dokud běží nahrávání zápasu nebo vysílání.
    const recording = !!this.capture.recordingInfo() || onAir;
    if (recording !== this.trayDotShown) {
      this.trayDotShown = recording;
      this.tray.setImage(trayIcon(this.appIcon(), recording));
    }
  }

  private async togglePause(): Promise<void> {
    if (!this.paused && this.live.active()) {
      void this.toast.show(this.t('toastLiveKeepsCapture'), 'warn');
      return;
    }
    this.paused = !this.paused;
    if (this.paused) await this.stopCapture('buffer-off');
    else if (this.settings.get().detection === 'always' || (this.settings.get().detection === 'games' && this.games.current())) {
      await this.capture.start().catch(() => undefined);
    }
    this.rebuildTray();
    this.pushStatus();
  }

  // ---- okna -------------------------------------------------------------------

  openSettings(tab?: string): void {
    void this.auth.refresh();
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (tab) this.settingsWindow.webContents.send('navigate', tab);
      this.settingsWindow.show();
      this.settingsWindow.focus();
      return;
    }
    // V režimu "Kine + klipy" je v okně i web - potřebuje víc místa, ať se
    // nepřepne do rozložení pro telefon.
    const full = this.settings.get().appMode === 'full';
    const win = new BrowserWindow({
      width: full ? 1320 : 960,
      height: full ? 840 : 680,
      minWidth: full ? 1000 : 760,
      minHeight: full ? 620 : 540,
      title: PRODUCT,
      backgroundColor: '#050506',
      autoHideMenuBar: true,
      icon: this.appIcon(),
      // AudioVideoTracks: přehrávač klipů přepíná stopy zvuku (hra / mikrofon) - renderer/player.ts.
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false, enableBlinkFeatures: 'AudioVideoTracks' },
    });
    win.setMenuBarVisibility(false);
    this.settingsWindow = win;
    this.applyWindowGlass(win);
    void win.loadFile(join(RENDERER_DIR, 'settings.html'), { query: tab ? { tab } : {} });
    win.on('closed', () => {
      this.settingsWindow = null;
      this.destroyKineView();
    });
    // Zmenšené okno = web Kine v něm nikdo nevidí - uspat (video, zvuk, běh na pozadí); po obnovení probrat.
    win.on('minimize', () => this.sleepKineView(true));
    win.on('hide', () => this.sleepKineView(true));
    win.on('restore', () => this.sleepKineView(false));
    win.on('show', () => this.sleepKineView(false));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  }

  openReview(sessionId: string): void {
    if (this.reviewWindow && !this.reviewWindow.isDestroyed()) {
      this.reviewWindow.webContents.send('navigate', sessionId);
      this.reviewWindow.show();
      this.reviewWindow.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 720,
      height: 620,
      minWidth: 540,
      minHeight: 440,
      title: PRODUCT,
      backgroundColor: '#050506',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      icon: this.appIcon(),
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false, enableBlinkFeatures: 'AudioVideoTracks' },
    });
    win.setMenuBarVisibility(false);
    this.reviewWindow = win;
    void win.loadFile(join(RENDERER_DIR, 'review.html'), { query: { session: sessionId } });
    win.once('ready-to-show', () => win.setAlwaysOnTop(false));
    win.on('closed', () => {
      this.reviewWindow = null;
    });
  }

  /** Adresa patří ke Kine (stejný web; playkine.com a www.playkine.com jsou totéž). */
  private isKineUrl(url: string): boolean {
    try {
      const a = new URL(url);
      const b = new URL(this.settings.get().siteUrl);
      const host = (h: string) => h.toLowerCase().replace(/^www\./, '');
      return a.protocol === b.protocol && a.port === b.port && host(a.hostname) === host(b.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Otevře Kine. V režimu "Kine + klipy" jako záložku hlavního okna (web
   * Kine vložený do okna, s trvalým přihlášením), jinak v prohlížeči.
   */
  openKine(path = ''): void {
    const s = this.settings.get();
    const cleanPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    const url = s.siteUrl + cleanPath;
    if (s.appMode !== 'full') {
      void this.openKineInBrowser(url, cleanPath || '/');
      return;
    }
    if (this.kineView && !this.kineView.webContents.isDestroyed()) {
      if (path) void this.kineView.webContents.loadURL(url);
    } else if (path) {
      this.pendingKinePath = path;
    }
    this.openSettings('kine');
  }

  /**
   * Kine Clipper otvírá Kine v prohlížeči. Když je appka přihlášená, vezme
   * si jednorázový token a pošle prohlížeč přes /connect/app - ten se
   * přihlásí stejným účtem a teprve pak skočí na cíl. Bez toho by čerstvě
   * nahraný (soukromý) klip v prohlížeči s jiným nebo žádným účtem hlásil
   * „nemáš přístup“. Bez přihlášení (nebo když token nevyjde) jde odkaz rovnou.
   */
  private async openKineInBrowser(url: string, nextPath: string): Promise<void> {
    if (this.auth.current()) {
      try {
        const th = await this.auth.webLinkToken();
        if (th) {
          await shell.openExternal(`${this.settings.get().siteUrl}/connect/app?th=${encodeURIComponent(th)}&next=${encodeURIComponent(nextPath)}`);
          return;
        }
      } catch (e) {
        log(`otevření Kine s přihlášením: ${(e as Error).message}`);
      }
    }
    await shell.openExternal(url);
  }

  /** Web Kine vložený do hlavního okna; vznikne, až ho stránka poprvé ukáže. */
  private ensureKineView(win: BrowserWindow): WebContentsView {
    if (this.kineView && !this.kineView.webContents.isDestroyed()) return this.kineView;
    const partition = 'persist:kine-web';
    // Žádný preload (web mluví s appkou jen přes odkazy kine://) a jen
    // oprávnění, která web opravdu potřebuje.
    session.fromPartition(partition).setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['fullscreen', 'notifications', 'clipboard-sanitized-write', 'pointerLock', 'media'].includes(permission));
    });
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true } });
    // Web pozná, že běží v appce (Sidebar ukáže "Klipy v PC", /download řekne, že appku už máš).
    view.webContents.setUserAgent(`${view.webContents.getUserAgent()} KineDesktop/${app.getVersion()}`);
    const external = (target: string) => {
      if (target.startsWith('kine://')) {
        void this.handleDeepLink(target);
        return true;
      }
      if (/^https?:/.test(target) && !this.isKineUrl(target)) {
        void shell.openExternal(target);
        return true;
      }
      return false;
    };
    view.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!external(target) && this.isKineUrl(target)) void view.webContents.loadURL(target);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (e, target) => {
      if (external(target)) e.preventDefault();
    });
    view.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      log(`Kine v okně: ${description} (${code}) ${url}`);
      // Místo chybové stránky Chromia zůstane náš text s tlačítkem Obnovit.
      this.kineViewFailed = true;
      view.setVisible(false);
      this.kineViewShown = false;
      this.broadcast('kineView:failed', description);
    });
    view.webContents.on('did-finish-load', () => {
      this.kineViewFailed = false;
      if (this.kineViewWanted && !this.kineViewShown) {
        view.setVisible(true);
        this.kineViewShown = true;
      }
      void this.syncLogin(view);
    });
    // Přihlášení/odhlášení na webu je přechod uvnitř stránky (Next.js), ne nové načtení.
    view.webContents.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
      if (isMainFrame) void this.syncLogin(view);
    });
    win.contentView.addChildView(view);
    view.setVisible(false);
    const path = this.pendingKinePath ?? '';
    this.pendingKinePath = null;
    const s = this.settings.get();
    void view.webContents.loadURL(s.siteUrl + (path ? (path.startsWith('/') ? path : `/${path}`) : ''));
    this.kineView = view;
    return view;
  }

  /**
   * Jedno přihlášení pro appku i web v okně. Appka přihlášená, web ne ->
   * web dostane jednorázový token a přihlásí se (/connect/app). Web
   * přihlášený, appka ne -> appka si z jeho tokenu udělá vlastní relaci.
   * Každá strana má svou relaci; nic se nesdílí, nic se navzájem neodhlašuje.
   */
  private async syncLogin(view: WebContentsView): Promise<void> {
    if (this.loginSyncBusy || Date.now() < this.loginSyncNextAt) return;
    if (view.webContents.isDestroyed() || view.webContents.isLoading() || !this.isKineUrl(view.webContents.getURL())) return;
    // Stránka /connect/app se právě přihlašuje - nechat ji dokončit.
    if (new URL(view.webContents.getURL()).pathname.startsWith('/connect/app')) return;
    this.loginSyncBusy = true;
    try {
      const web = (await view.webContents.executeJavaScript(
        `(() => { try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v && v.access_token ? { token: v.access_token, user: (v.user && v.user.id) || null } : null; } } } catch (e) {} return null; })()`,
        true
      )) as { token: string; user: string | null } | null;
      const account = this.auth.current();
      const webUser = web?.user ?? null;
      const webBefore = this.lastWebUser;
      this.lastWebUser = webUser;

      if (account && !web) {
        if (webBefore) {
          // Web v okně se odhlásil (dřív tam relace byla) - odhlásí se i appka.
          log('přihlášení: web v okně se odhlásil -> odhlašuje se i appka');
          await this.auth.logout();
        } else {
          // Web relaci nikdy neměl - dostane ji od appky (jednorázový token, vlastní relace).
          const th = await this.auth.webLinkToken();
          if (!th) throw new Error('no web token');
          const current = new URL(view.webContents.getURL());
          const next = current.pathname.startsWith('/connect') || current.pathname.startsWith('/login') ? '/' : current.pathname + current.search;
          log('přihlášení: appka -> web v okně');
          // Kdyby se to z jakéhokoli důvodu nepovedlo, nezkoušet to dokola.
          this.loginSyncNextAt = Date.now() + 120000;
          await view.webContents.loadURL(`${this.settings.get().siteUrl}/connect/app?th=${encodeURIComponent(th)}&next=${encodeURIComponent(next)}`);
        }
      } else if (!account && web?.token) {
        log('přihlášení: web v okně -> appka');
        await this.auth.loginFromWebToken(web.token);
      } else if (account && web?.token && webUser && webUser !== account.userId && webBefore === account.userId) {
        // Hráč se ve webu přepnul na jiný účet - appka jde s ním.
        log('přihlášení: web v okně změnil účet -> appka ho následuje');
        await this.auth.logout();
        await this.auth.loginFromWebToken(web.token);
      }
    } catch (e) {
      log(`srovnání přihlášení: ${(e as Error).message}`);
      this.loginSyncNextAt = Date.now() + 60000;
    } finally {
      this.loginSyncBusy = false;
    }
  }

  /** Odhlášení v appce odhlásí i web v okně (jeho relace se smaže). */
  private async clearWebLogin(): Promise<void> {
    this.lastWebUser = null;
    try {
      await session.fromPartition('persist:kine-web').clearStorageData({ storages: ['localstorage', 'cookies', 'indexdb'] });
      if (this.kineView && !this.kineView.webContents.isDestroyed()) void this.kineView.webContents.loadURL(this.settings.get().siteUrl);
    } catch (e) {
      log(`odhlášení webu: ${(e as Error).message}`);
    }
  }

  /** Stránka řekne, kde má web ležet (obdélník obsahu v okně, v DIP). */
  showKineView(bounds: { x: number; y: number; width: number; height: number }): void {
    const win = this.settingsWindow;
    if (!win || win.isDestroyed()) return;
    if (this.settings.get().appMode !== 'full') return;
    const view = this.ensureKineView(win);
    const clean = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    view.setBounds(clean);
    this.kineViewWanted = true;
    if (!this.kineViewShown && !this.kineViewFailed) {
      view.setVisible(true);
      this.kineViewShown = true;
      this.sleepKineView(false);
    }
  }

  hideKineView(): void {
    this.kineViewWanted = false;
    if (this.kineView && !this.kineView.webContents.isDestroyed() && this.kineViewShown) this.kineView.setVisible(false);
    this.kineViewShown = false;
    this.sleepKineView(true);
  }

  /** Nahraný klip na Kine: v Kine do PC v záložce Kine, v Kine Clipperu v prohlížeči. */
  openClipOnKine(id: string): void {
    const clip = this.library.get(id);
    if (clip?.upload?.state === 'done') this.openKine(clip.upload.url.replace(this.settings.get().siteUrl, '') || '/');
  }

  /**
   * Web Kine v okně, když ho nikdo nevidí (jiná záložka) nebo když běží
   * hra: zastaví přehrávání a ztlumí se, ať nežere procesor, grafiku ani
   * síť, které patří hře. Při návratu na záložku (a bez hry) se zas
   * probere - video si hráč pustí sám.
   */
  private sleepKineView(sleep: boolean): void {
    const view = this.kineView;
    if (!view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    // Během hry spí i viditelný web; bez hry se řídí tím, jestli je záložka Kine vidět.
    const shouldSleep = sleep || !!this.games.current() || !this.kineViewShown;
    try {
      wc.setBackgroundThrottling(shouldSleep);
      wc.setAudioMuted(shouldSleep);
      if (shouldSleep && !wc.isLoading()) {
        void wc.executeJavaScript(`document.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); } catch (e) {} })`, true).catch(() => undefined);
      }
    } catch (e) {
      log(`uspání webu v okně: ${(e as Error).message}`);
    }
  }

  reloadKineView(): void {
    const view = this.kineView;
    if (!view || view.webContents.isDestroyed()) {
      // Ještě nevznikl (nebo padl) - vznikne, až se stránka znovu ohlásí.
      if (this.settingsWindow) this.settingsWindow.webContents.send('kineView:retry', null);
      return;
    }
    this.kineViewFailed = false;
    view.webContents.reload();
  }

  private destroyKineView(): void {
    const view = this.kineView;
    this.kineView = null;
    this.kineViewShown = false;
    this.kineViewFailed = false;
    if (!view) return;
    try {
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) this.settingsWindow.contentView.removeChildView(view);
    } catch {
      // okno už je pryč
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      // už zavřené
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  status(): Status {
    const account = this.auth.current();
    const game = this.games.current();
    return {
      capture: this.capture.state,
      captureError: this.capture.error,
      game: game?.name ?? null,
      gameSource: game?.source ?? null,
      gameExe: game?.exe ?? null,
      uploadsPending: this.uploader.pending(),
      uploadsPaused: this.uploader.isPausedByGame(),
      account: account
        ? {
            username: account.username,
            email: account.email,
            plan: account.plan,
            planUntil: account.planUntil,
            clipsPlus: account.clipsPlus,
            kinePlus: account.kinePlus,
            maxClipSeconds: maxClipSecondsFor(account),
            plusAvailable: account.plusAvailable,
            prices: account.prices,
          }
        : null,
      paused: this.paused,
      hotkeyProblems: this.hotkeys.currentProblems().map((p) => this.t('hotkeyProblem', { hotkey: hotkeyLabel(p.hotkey), reason: this.hotkeyReasonText(p.reason) })),
      chordsSupported: this.hotkeys.chordsSupported() && (this.helper?.isRunning() ?? false),
      version: app.getVersion(),
      variant: VARIANT,
      autoClipsLive: this.gameEvents.live(),
      recordingSince: this.capture.recordingInfo()?.since ?? null,
      recordingSaving: this.capture.savingInfo() ?? (this.finishingRecording ? { since: Date.now(), percent: null } : null),
      clipsSaving: this.clipsSaving,
      batterySaverActive: this.batterySaving && (this.capture.state === 'on' || this.capture.state === 'starting'),
      notices: [...this.notices],
      hwEncoder: this.capture.hwEncoder,
      live: this.live.current(),
      update: updateProgress(),
      updateIssue: this.updateIssue,
      smartAppControl: this.smartAppControl,
      helperBlocked: this.helper?.isBlocked() ?? false,
      compress: this.compressor.current(),
      windowGlass: this.windowGlassOn(),
      windowGlassSupported: this.windowGlassSupported(),
    };
  }

  // ---- vzhled: průhledné okno ------------------------------------------------------------

  /** Acrylic za oknem umí Windows 11 22H2+ (sestavení 22621); jinde zůstane barevné pozadí ve stránce. */
  private windowGlassSupported(): boolean {
    if (process.platform !== 'win32') return false;
    const build = Number(release().split('.')[2] ?? 0);
    return Number.isFinite(build) && build >= 22621;
  }

  private windowGlassOn(): boolean {
    const s = this.settings.get();
    return s.look === 'glass' && s.glassWindow && this.windowGlassSupported();
  }

  /** Průhledné okno: Acrylic (rozmazaná plocha za oknem) + průhledné pozadí okna; vypnuto = plná barva. */
  private applyWindowGlass(win: BrowserWindow | null | undefined): void {
    if (!win || win.isDestroyed() || process.platform !== 'win32') return;
    const on = this.windowGlassOn();
    try {
      win.setBackgroundMaterial(on ? 'acrylic' : 'none');
      win.setBackgroundColor(on ? '#00000000' : '#050506');
    } catch (e) {
      log(`průhledné okno: ${(e as Error).message}`);
    }
  }

  pushStatus(): void {
    this.broadcast('status', this.status());
    this.rebuildTray();
  }

  pushClips(): void {
    this.broadcast('clips', this.library.listAll());
  }

  /**
   * Kolik appka právě bere (jako Správce úloh): procesor a paměť všech
   * jejích procesů Electronu - hlavní, snímání (obrazovka + kódování přes
   * grafiku), okna, grafika. ffmpeg (jen kopíruje kousky) a pomocník pro
   * Windows se změřit nedají a v součtu nejsou. Procesor je za dobu od
   * minulého dotazu - první dotaz ukáže 0 (okno se ptá každé 2 s).
   */
  resourceUsage(): ResourceUsage {
    const cores = Math.max(1, cpus().length);
    const pidOf = (wc: Electron.WebContents | null | undefined) => {
      try {
        return wc && !wc.isDestroyed() ? wc.getOSProcessId() : -1;
      } catch {
        return -1;
      }
    };
    const capturePid = this.capture.capturePid() ?? -1;
    const kinePid = pidOf(this.kineView?.webContents);
    const windowPids = new Set([pidOf(this.settingsWindow?.webContents), pidOf(this.reviewWindow?.webContents)]);
    const groups = new Map<Key, { cpu: number; mem: number }>();
    let cpu = 0;
    let mem = 0;
    for (const m of app.getAppMetrics()) {
      const c = Math.max(0, m.cpu?.percentCPUUsage ?? 0);
      const mb = Math.max(0, (m.memory?.workingSetSize ?? 0) / 1024);
      cpu += c;
      mem += mb;
      const key: Key =
        m.type === 'Browser'
          ? 'usageMain'
          : m.pid === capturePid
            ? 'usageCapture'
            : m.type === 'GPU'
              ? 'usageGpu'
              : m.pid === kinePid
                ? 'usageKine'
                : windowPids.has(m.pid)
                  ? 'usageWindow'
                  : 'usageOther';
      const g = groups.get(key) ?? { cpu: 0, mem: 0 };
      g.cpu += c;
      g.mem += mb;
      groups.set(key, g);
    }
    const round1 = (n: number) => Math.round(n * 10) / 10;
    return {
      cpuPercent: round1(cpu),
      cpuPercentOfTotal: round1(cpu / cores),
      memoryMb: Math.round(mem),
      parts: [...groups.entries()]
        .sort((a, b) => b[1].mem - a[1].mem)
        .map(([key, g]) => ({ label: this.t(key), cpuPercent: round1(g.cpu / cores), memoryMb: Math.round(g.mem) })),
    };
  }

  /** Kolik místa berou klipy, koš a zásobník a kolik je na disku volno (panel Úložiště). */
  storageInfo(): { clipsBytes: number; clipsCount: number; trashBytes: number; trashCount: number; bufferBytes: number; freeBytes: number; clipsDir: string } {
    const usage = this.library.usage();
    return { ...usage, bufferBytes: this.capture.bufferBytes(), freeBytes: freeDiskBytes(this.settings.clipsDir()), clipsDir: this.settings.clipsDir() };
  }

  /**
   * Zkrácení / ztlumení klipu (edit.ts). Buď nový klip vedle původního,
   * nebo přepsání původního (ten se nejdřív zapíše bokem a pak přejmenuje,
   * ať při chybě nezůstane rozbitý soubor). Průběh chodí oknům jako
   * "clips:trimProgress".
   */
  async trimClip(id: string, opts: TrimIpcRequest): Promise<Clip> {
    const clip = this.library.get(id);
    if (!clip) throw new Error('clip not found');
    const s = this.settings.get();
    const ext = extname(clip.file) || '.mp4';
    const dir = dirname(clip.file);
    const stem = basename(clip.file, ext);
    const progress = (percent: number) => this.broadcast('clips:trimProgress', { id, percent });
    // Konec nejdál na konci klipu (když délku neznáme, věří se stránce).
    const total = clip.durationSeconds > 0 ? clip.durationSeconds : Infinity;
    const vertical = opts.vertical === 'left' || opts.vertical === 'center' || opts.vertical === 'right' || opts.vertical === 'blur' ? opts.vertical : undefined;
    const audio = opts.audio === 'game' || opts.audio === 'mic' || opts.audio === 'none' ? opts.audio : 'mix';
    const speed = normalizeSpeed(opts.speed ?? 1);
    const options = {
      start: Math.max(0, Number(opts.start) || 0),
      end: Math.min(total, Number(opts.end) || total),
      mute: Boolean(opts.mute),
      videoMbps: s.videoMbps,
      vertical,
      audio: audio as 'mix' | 'game' | 'mic' | 'none',
      audioTracks: clip.audioTracks,
      speed,
      overlay: null as { file: string; position: TextPosition } | null,
    };
    if (!Number.isFinite(options.end)) throw new Error('unknown length');
    // Výřez na výšku je jiný formát - vždycky jako nový klip vedle původního.
    if (vertical && opts.mode === 'replace') opts = { ...opts, mode: 'new' };
    if (options.end - options.start < 0.2) throw new Error('too-short');
    const thumbsDir = join(app.getPath('userData'), 'thumbs');
    // Momenty nahrávky se posunou na nový začátek (a přepočtou rychlostí); ty mimo výběr zmizí.
    const markers = shiftMarkers(clip.markers, options.start, options.end, speed);

    // Text přes video: PNG nakreslené oknem (písmo Inter, obrys...) - ffmpeg ho jen položí na obraz.
    const text = opts.text;
    if (text && text.png) {
      const png = text.png instanceof Uint8Array ? text.png : new Uint8Array(text.png as ArrayBuffer);
      const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
      if (!isPng || png.length > 10 * 1024 * 1024) throw new Error('bad text image');
      const position: TextPosition = text.position === 'top' || text.position === 'center' ? text.position : 'bottom';
      const file = join(app.getPath('temp'), `kine-text-${randomUUID()}.png`);
      writeFileSync(file, png);
      options.overlay = { file, position };
    }
    try {
      if (opts.mode === 'replace') {
        const tmp = join(dir, `${stem}.upravuje-se${ext}`);
        const result = await trimClip(clip.file, tmp, options, progress);
        // Původní soubor může chvíli držet přehrávač - zkusit víckrát.
        let lastError: Error | null = null;
        for (let i = 0; i < 10; i++) {
          try {
            renameSync(tmp, clip.file);
            lastError = null;
            break;
          } catch (e) {
            lastError = e as Error;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        if (lastError) {
          try {
            unlinkSync(tmp);
          } catch {
            // nechat být
          }
          throw new Error(`replace failed: ${lastError.message}`);
        }
        // Nový název náhledu - stejný by okno drželo v mezipaměti a ukazovalo starý snímek.
        mkdirSync(thumbsDir, { recursive: true });
        const thumb = join(thumbsDir, `${stem}-${Date.now().toString(36)}.jpg`);
        const thumbOk = await makeThumbnail(clip.file, thumb);
        if (thumbOk && clip.thumb && clip.thumb !== thumb) {
          try {
            unlinkSync(clip.thumb);
          } catch {
            // starý náhled už není
          }
        }
        const updated = this.library.update(id, {
          thumb: thumbOk ? thumb : clip.thumb,
          durationSeconds: result.durationSeconds,
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          audioTracks: result.audioTracks ?? undefined,
          markers,
          // Obsah je jiný než ten na Kine - nahrání začíná znovu.
          upload: null,
        });
        log(`klip zkrácen (přepsán): ${clip.file} (${result.durationSeconds.toFixed(1)} s)`);
        return updated!;
      }

      const suffix = vertical ? this.t('clipVerticalSuffix') : this.t('clipEditedSuffix');
      let out = join(dir, `${stem} (${suffix})${ext}`);
      for (let n = 2; existsSync(out); n++) out = join(dir, `${stem} (${suffix} ${n})${ext}`);
      const result = await trimClip(clip.file, out, options, progress);
      mkdirSync(thumbsDir, { recursive: true });
      const thumb = join(thumbsDir, `${basename(out, ext)}.jpg`);
      const thumbOk = await makeThumbnail(out, thumb);
      const created = new Date(new Date(clip.createdAt).getTime() + 1000);
      const newClip: Clip = {
        ...clip,
        id: randomUUID(),
        file: out,
        thumb: thumbOk ? thumb : null,
        title: `${clip.title} (${suffix})`.slice(0, 150),
        createdAt: created.toISOString(),
        durationSeconds: result.durationSeconds,
        sizeBytes: result.sizeBytes,
        width: result.width,
        height: result.height,
        audioTracks: result.audioTracks ?? undefined,
        markers,
        upload: null,
        uploadOptions: undefined,
      };
      this.library.add(newClip);
      log(`klip zkrácen (nový): ${out} (${result.durationSeconds.toFixed(1)} s)`);
      return newClip;
    } finally {
      if (options.overlay) {
        try {
          unlinkSync(options.overlay.file);
        } catch {
          // dočasný soubor už není
        }
      }
    }
  }

  /**
   * Nahraný klip na Discord přes webhook z nastavení: jedna zpráva s názvem
   * a odkazem (Discord si z odkazu na Kine udělá náhled sám).
   */
  /**
   * Klip na Discord (webhook z nastavení): nahraný klip jako odkaz na Kine,
   * nenahraný rovnou jako soubor - když se vejde do limitu Discordu
   * (DISCORD_FILE_MAX_BYTES). Větší se musí nejdřív nahrát na Kine.
   */
  async shareToDiscord(id: string): Promise<void> {
    const clip = this.library.get(id);
    const webhook = this.settings.get().discordWebhook;
    if (!clip) throw new Error('not found');
    if (!webhook) throw new Error('no webhook');
    if (clip.upload?.state === 'done') {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${clip.title}**\n${clip.upload.url}` }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      log(`klip poslán na Discord: ${clip.title}`);
      return;
    }
    await this.shareFileToDiscord(clip.file, clip.title);
  }

  /** Soubor (klip do limitu, GIF) přímo do kanálu na Discordu přes webhook. */
  async shareFileToDiscord(file: string, title: string): Promise<void> {
    const webhook = this.settings.get().discordWebhook;
    if (!webhook) throw new Error('no webhook');
    const dir = this.settings.clipsDir();
    // Jen soubory ze složky s klipy (okno nesmí poslat cokoli z disku).
    if (!file.startsWith(dir) || !existsSync(file)) throw new Error('not found');
    const size = statSync(file).size;
    if (size > DISCORD_FILE_MAX_BYTES) throw new Error('too-large');
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: title ? `**${title}**` : '' }));
    form.append('files[0]', new Blob([readFileSync(file)], { type: mimeFor(file) }), basename(file));
    const res = await fetch(webhook, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (res.status === 413) throw new Error('too-large');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(`soubor poslán na Discord: ${basename(file)} (${Math.round(size / 1024)} kB)`);
  }

  /**
   * Sestřih: vybrané klipy (od nejstaršího) za sebou do jednoho nového
   * klipu vedle nich (mp4). Průběh chodí oknům jako "clips:trimProgress"
   * s id "merge". Původní klipy zůstávají.
   */
  async mergeSelected(ids: string[]): Promise<Clip> {
    const clips = ids
      .map((id) => this.library.get(id))
      .filter((c): c is Clip => !!c)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (clips.length < 2) throw new Error('too-few');
    if (clips.length > 30) throw new Error('too-many');
    const dir = this.settings.clipsDir();
    mkdirSync(dir, { recursive: true });
    const games = [...new Set(clips.map((c) => c.game).filter((g): g is string => !!g))];
    const game = games.length === 1 ? games[0] : null;
    const now = new Date();
    const word = this.t('montageWord');
    const baseTitle = defaultClipTitle(now, game, word);
    const stem = `${clipFileBase(now, game)} ${safeFilePart(word)}`;
    let out = join(dir, `${stem}.mp4`);
    for (let n = 2; existsSync(out); n++) out = join(dir, `${stem} ${n}.mp4`);
    const progress = (percent: number) => this.broadcast('clips:trimProgress', { id: 'merge', percent });
    const result = await mergeClips(
      clips.map((c) => ({ file: c.file, durationSeconds: c.durationSeconds })),
      out,
      progress
    );
    const thumbsDir = join(app.getPath('userData'), 'thumbs');
    mkdirSync(thumbsDir, { recursive: true });
    const thumb = join(thumbsDir, `${basename(out, '.mp4')}.jpg`);
    const thumbOk = await makeThumbnail(out, thumb);
    const clip: Clip = {
      id: randomUUID(),
      file: out,
      thumb: thumbOk ? thumb : null,
      title: `${baseTitle} · ${this.t('montageCount', { count: clips.length })}`.slice(0, 150),
      game,
      createdAt: now.toISOString(),
      durationSeconds: result.durationSeconds,
      sizeBytes: result.sizeBytes,
      width: result.width,
      height: result.height,
      sessionId: clips[clips.length - 1].sessionId,
      upload: null,
    };
    this.library.add(clip);
    log(`sestřih ${clips.length} klipů: ${out} (${result.durationSeconds.toFixed(1)} s)`);
    return clip;
  }

  /**
   * GIF z úseku klipu (nejvýš GIF_MAX_SECONDS s) - soubor vedle klipu,
   * do knihovny nepatří (jsou v ní jen videa). Vrací cestu k souboru.
   */
  async gifFromClip(id: string, range: { start: number; end: number }): Promise<{ file: string; sizeBytes: number; lengthSeconds: number }> {
    const clip = this.library.get(id);
    if (!clip) throw new Error('clip not found');
    const start = Math.max(0, Number(range.start) || 0);
    const total = clip.durationSeconds > 0 ? clip.durationSeconds : Infinity;
    const end = Math.min(total, Number(range.end) || total);
    if (!Number.isFinite(end)) throw new Error('unknown length');
    if (end - start < 0.2) throw new Error('too-short');
    if (end - start > GIF_MAX_SECONDS + 0.05) throw new Error('gif-too-long');
    const dir = dirname(clip.file);
    const stem = basename(clip.file, extname(clip.file));
    let out = join(dir, `${stem}.gif`);
    for (let n = 2; existsSync(out); n++) out = join(dir, `${stem} ${n}.gif`);
    const progress = (percent: number) => this.broadcast('clips:trimProgress', { id, percent });
    const result = await makeGif(clip.file, out, { start, end }, progress);
    log(`GIF z klipu: ${out} (${result.lengthSeconds.toFixed(1)} s, ${Math.round(result.sizeBytes / 1024)} kB)`);
    return result;
  }

  /**
   * Náhled klipu ze snímku v čase `atSeconds` (tlačítko v přehrávači). Nový
   * soubor s jiným názvem, ať okno neukazuje starý z mezipaměti; starý se smaže.
   */
  async setThumbnailFrame(id: string, atSeconds: number): Promise<Clip | null> {
    const clip = this.library.get(id);
    if (!clip) throw new Error('clip not found');
    const at = Math.max(0, Math.min(Number(atSeconds) || 0, Math.max(0, clip.durationSeconds - 0.1)));
    const thumbsDir = join(app.getPath('userData'), 'thumbs');
    mkdirSync(thumbsDir, { recursive: true });
    const stem = basename(clip.file, extname(clip.file));
    const thumb = join(thumbsDir, `${safeFilePart(stem)}-${Date.now().toString(36)}.jpg`);
    const ok = await makeThumbnail(clip.file, thumb, at);
    if (!ok) throw new Error('thumbnail failed');
    if (clip.thumb && clip.thumb !== thumb) {
      try {
        unlinkSync(clip.thumb);
      } catch {
        // starý náhled už není
      }
    }
    log(`náhled klipu ze snímku ${at.toFixed(1)} s: ${thumb}`);
    return this.library.update(id, { thumb });
  }

  /** Ukázat soubor ve složce - jen soubory ve složce s klipy (nic jiného okno nesmí otvírat). */
  revealFile(file: string): void {
    const dir = this.settings.clipsDir();
    const target = String(file);
    if (!target.startsWith(dir) || !existsSync(target)) return;
    shell.showItemInFolder(target);
  }

  // ---- IPC ---------------------------------------------------------------------

  private registerIpc(): void {
    const isCaptureSender = (e: Electron.IpcMainEvent) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      return !!win && win.webContents.getURL().endsWith('capture.html');
    };
    ipcMain.on('capture:chunk', (e, generation: number, data: ArrayBuffer, kind: 'av' | 'mic' = 'av') => {
      if (isCaptureSender(e)) this.capture.handleChunk(generation, data, kind === 'mic' ? 'mic' : 'av');
    });
    ipcMain.on('capture:liveChunk', (e, generation: number, data: ArrayBuffer) => {
      if (isCaptureSender(e)) this.live.handleChunk(generation, data);
    });
    ipcMain.handle('live:start', (_e, opts: { title?: unknown; quality?: unknown }) => this.startLive(opts ?? {}));
    ipcMain.handle('live:stop', () => this.stopLive());
    ipcMain.handle('live:openPage', () => this.openLivePage());
    ipcMain.handle('live:openChat', () => this.openLiveChat());
    ipcMain.handle('live:publishRecording', (_e, opts: { title?: unknown; visibility?: unknown }) => this.publishLiveRecording(opts ?? {}));
    ipcMain.handle('live:dismissEnded', () => this.live.dismissEnded());
    ipcMain.handle('live:downloadRecording', () => this.downloadLiveRecording());
    ipcMain.handle('live:discardRecording', () => this.discardLiveRecording());
    ipcMain.handle('live:openRecording', () => this.openLiveRecording());
    ipcMain.handle('live:afterStream', () => this.liveAfterStream());
    ipcMain.handle('live:setAfterStream', (_e, value: unknown) => this.setLiveAfterStream(value));
    ipcMain.handle('live:setThumbnail', (_e, bytes: unknown) => this.setLiveThumbnail(bytes));
    ipcMain.handle('live:removeThumbnail', () => this.removeLiveThumbnail());
    ipcMain.handle('live:brb', (_e, on?: unknown) => this.toggleLiveBrb(typeof on === 'boolean' ? on : undefined));
    ipcMain.handle('live:muteMic', (_e, muted: unknown) => this.setLiveMicMuted(Boolean(muted)));
    ipcMain.handle('app:usage', () => this.resourceUsage());
    ipcMain.handle('notice:dismiss', (_e, id: unknown) => this.dismissNotice(String(id ?? '')));
    ipcMain.on('capture:event', (e, event: CaptureEvent) => {
      if (isCaptureSender(e)) this.capture.handleEvent(event);
    });
    // Zvuk hry přímo z Windows (pomocník s WASAPI loopbackem, jako OBS) - jen pro snímací stránku.
    const fromCapture = (sender: Electron.WebContents) => {
      const win = BrowserWindow.fromWebContents(sender);
      return !!win && win.webContents.getURL().endsWith('capture.html');
    };
    ipcMain.handle('loopback:start', (e) => {
      if (!fromCapture(e.sender)) return { ok: false, error: 'sender' };
      this.loopback ??= new NativeLoopback(app.getPath('userData'));
      return this.loopback.start(e.sender);
    });
    ipcMain.on('loopback:stop', (e) => {
      if (fromCapture(e.sender)) this.loopback?.stop();
    });
    ipcMain.handle('capture:sources', async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return sources.map((x) => ({ id: x.id, name: x.name, display_id: x.display_id }));
    });

    ipcMain.handle('settings:get', () => this.settings.get());
    ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => this.settings.update(patch));
    ipcMain.handle('status:get', () => this.status());
    ipcMain.handle('platform', () => process.platform);

    ipcMain.handle('clips:list', () => this.library.listAll());
    ipcMain.handle('clips:restore', (_e, id: string) => {
      const clip = this.library.restore(String(id));
      // Nahraný klip, který Kine ještě zpracovává: zase čekat na "hotovo" (jinak karta visí na procentech).
      if (clip?.upload?.state === 'done' && clip.upload.ready === false) this.uploader.watchReady(clip.id, clip.upload.videoId, clip.upload.url);
      return clip;
    });
    // Jen do koše. Klip, který už v koši je, tu zůstane - dvojklik na ikonku koše ho nesmí smazat nadobro.
    ipcMain.handle('clips:trash', (_e, id: string) => {
      const clip = this.library.get(String(id));
      if (clip && !clip.deletedAt) this.library.remove(clip.id);
    });
    ipcMain.handle('clips:emptyTrash', () => this.library.emptyTrash());
    ipcMain.handle('storage:info', () => this.storageInfo());
    ipcMain.handle('clips:delete', (_e, id: string) => this.library.remove(id));
    ipcMain.handle('clips:rename', (_e, id: string, title: string) => this.library.update(id, { title: String(title).trim().slice(0, 150) || this.t('clipDefaultName') }));
    ipcMain.handle('clips:setGame', (_e, id: string, game: string | null) => {
      const name = typeof game === 'string' ? game.trim().slice(0, 80) : '';
      return this.library.update(id, { game: name || null });
    });
    ipcMain.handle('clips:open', (_e, id: string) => {
      const clip = this.library.get(id);
      return clip ? shell.openPath(clip.file) : '';
    });
    ipcMain.handle('clips:reveal', (_e, id: string) => {
      const clip = this.library.get(id);
      if (clip) shell.showItemInFolder(clip.file);
    });
    ipcMain.handle('clips:upload', (_e, requests: unknown) => {
      this.uploader.enqueue(sanitizeUploadRequests(requests, this.settings.get()));
      this.pushStatus();
    });
    ipcMain.handle('clips:openOnKine', (_e, id: string) => this.openClipOnKine(id));
    ipcMain.handle('clips:openDir', () => shell.openPath(this.settings.clipsDir()));
    ipcMain.handle('clips:pickDir', async () => {
      const result = await dialog.showOpenDialog(this.settingsWindow ?? undefined!, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: this.settings.clipsDir(),
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      this.settings.update({ clipsDir: result.filePaths[0] });
      return result.filePaths[0];
    });
    ipcMain.handle('clips:clipNow', () => this.onClipHotkey());
    ipcMain.handle('clips:trim', (_e, id: string, opts: TrimIpcRequest) => this.trimClip(id, opts));
    ipcMain.handle('app:copy', (_e, text: string) => clipboard.writeText(String(text ?? '')));
    ipcMain.handle('clips:discord', (_e, id: string) => this.shareToDiscord(id));
    ipcMain.handle('clips:discordFile', (_e, file: string, title: string) => this.shareFileToDiscord(String(file ?? ''), String(title ?? '')));
    ipcMain.handle('clips:favorite', (_e, id: string, favorite: boolean) => this.library.update(id, { favorite: Boolean(favorite) }));
    ipcMain.handle('clips:merge', (_e, ids: string[]) => this.mergeSelected(Array.isArray(ids) ? ids.map(String) : []));
    ipcMain.handle('clips:gif', (_e, id: string, range: { start: number; end: number }) => this.gifFromClip(id, range ?? { start: 0, end: 0 }));
    ipcMain.handle('clips:revealFile', (_e, file: string) => this.revealFile(file));
    // Zmenšování klipů (Klipy -> úložiště): odhad, spuštění, zrušení, zavření hlášení.
    const level = (value: unknown): CompressLevel => (COMPRESS_LEVELS.includes(value as CompressLevel) ? (value as CompressLevel) : 'medium');
    ipcMain.handle('clips:compressSummary', (_e, value: unknown) => {
      const { count, bytes, estimatedBytes, savingBytes } = compressSummary(this.library.list(), level(value));
      return { count, bytes, estimatedBytes, savingBytes };
    });
    ipcMain.handle('clips:compress', (_e, value: unknown, ids: unknown) =>
      this.compressor.start(level(value), Array.isArray(ids) ? ids.map(String) : undefined)
    );
    ipcMain.handle('clips:compressCancel', () => this.compressor.cancel());
    ipcMain.handle('clips:compressDismiss', () => this.compressor.dismiss());
    ipcMain.handle('player:current', (_e, id: unknown) => {
      this.playerClipId = typeof id === 'string' && id ? id : null;
    });
    ipcMain.handle('clips:thumbFrame', (_e, id: string, atSeconds: number) => this.setThumbnailFrame(String(id), Number(atSeconds)));
    // Tažení karty klipu ven z okna: systémové drag & drop se souborem (Discord, prohlížeč, Průzkumník).
    ipcMain.on('clips:dragStart', (e, id: string) => {
      const clip = this.library.get(String(id));
      if (!clip || !existsSync(clip.file)) return;
      let icon = this.appIcon();
      try {
        if (clip.thumb && existsSync(clip.thumb)) {
          const img = nativeImage.createFromPath(clip.thumb);
          if (!img.isEmpty()) icon = img.resize({ width: 128 });
        }
      } catch {
        // zůstane ikona appky
      }
      try {
        e.sender.startDrag({ file: clip.file, icon });
      } catch (err) {
        log(`tažení klipu: ${(err as Error).message}`);
      }
    });
    ipcMain.handle('capture:pause', () => this.togglePause());
    ipcMain.handle('audio:levels', () => this.capture.levels);
    // Okno nastavení ukazuje měřáky - ať jsou plynulé (jinak se hladiny posílají jednou za sekundu).
    ipcMain.handle('audio:watch', (_e, fast: boolean) => this.capture.setMetersFast(Boolean(fast)));
    ipcMain.handle('capture:record', () => this.toggleRecording());

    ipcMain.handle('auth:loginBrowser', async () => {
      this.browserLoginWaiting = true;
      this.broadcast('auth:waiting', true);
      try {
        await this.auth.loginViaBrowser();
      } finally {
        this.browserLoginWaiting = false;
        this.broadcast('auth:waiting', false);
      }
    });
    ipcMain.handle('auth:cancelBrowser', () => this.auth.cancelBrowserLogin());
    ipcMain.handle('auth:loginPassword', (_e, email: string, password: string) => this.auth.loginWithPassword(email, password));
    ipcMain.handle('auth:logout', async () => {
      await this.auth.logout();
      await this.clearWebLogin();
    });
    ipcMain.handle('auth:refresh', () => this.auth.refresh());

    ipcMain.handle('games:listProcesses', () => this.games.listProcesses());
    ipcMain.handle('games:current', () => this.games.current());
    ipcMain.handle('games:names', () => {
      const names = new Set<string>();
      for (const c of this.library.list()) if (c.game) names.add(c.game);
      for (const name of Object.values(this.settings.get().customGames)) names.add(name);
      const current = this.games.current();
      if (current) names.add(current.name);
      for (const name of Object.values(KNOWN_GAMES)) names.add(name);
      return [...names].sort((a, b) => a.localeCompare(b));
    });
    ipcMain.handle('games:add', async (_e, exe: string, name: string) => {
      const key = String(exe).trim().toLowerCase();
      if (!key) return;
      this.settings.update({ customGames: { ...this.settings.get().customGames, [key]: String(name).trim() || key } });
      await this.games.refresh();
    });
    ipcMain.handle('games:remove', async (_e, exe: string) => {
      const games = { ...this.settings.get().customGames };
      delete games[String(exe).toLowerCase()];
      this.settings.update({ customGames: games });
      await this.games.refresh();
    });

    ipcMain.handle('displays:list', (): DisplayInfo[] => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({
        id: String(d.id),
        label: `${d.label || this.t('displayN', { n: i + 1 })} (${d.size.width}×${d.size.height})`,
        width: d.size.width,
        height: d.size.height,
        primary: d.id === primary,
      }));
    });
    ipcMain.handle('hotkey:available', (_e, hotkey: string) => this.hotkeys.available(String(hotkey)));

    ipcMain.handle('review:clips', (_e, sessionId: string) => this.library.bySession(sessionId));
    ipcMain.handle('review:done', (_e, requests: unknown) => {
      const list = sanitizeUploadRequests(requests, this.settings.get());
      if (list.length > 0) this.uploader.enqueue(list);
      this.reviewWindow?.close();
      this.pushStatus();
    });

    ipcMain.handle('app:checkUpdate', () => checkForUpdates());
    ipcMain.handle('app:installUpdate', () => this.installUpdate());
    ipcMain.handle('app:downloadUpdate', () => downloadUpdateNow());
    ipcMain.handle('app:openLogs', () => shell.openPath(logDir()));
    // Zvuk hry nejde: "Zkusit znovu" (snímání se rozjede znovu) a Zvuk ve Windows (zařízení, Stereo Mix, výhradní režim).
    ipcMain.handle('capture:restart', async () => {
      if (this.capture.recordingInfo() || this.finishingRecording || this.live.active()) return 'busy';
      await this.capture.restartIfOn();
      return 'ok';
    });
    ipcMain.handle('app:openSoundSettings', () => {
      if (process.platform !== 'win32') return;
      try {
        spawn('control', ['mmsys.cpl', 'sounds'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } catch {
        void shell.openExternal('ms-settings:sound');
      }
    });
    // Náhradní celá obrazovka přehrávače: okno, ze kterého přišla žádost, přes celou obrazovku.
    ipcMain.handle('window:fullscreen', (e, on: unknown) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (win && !win.isDestroyed()) win.setFullScreen(on === true);
    });
    // Ikona celé obrazovky ve videu (vpravo dole) dá přes celou obrazovku holé video a prohlížeč
    // si to kliknutí "spotřebuje" - scénu se šipkami (player.ts) proto zapne tohle, jako by
    // kliknul uživatel (executeJavaScript s gestem). Pevný kód, žádná data z okna.
    ipcMain.handle('player:stageFullscreen', async (e) => {
      if (e.sender.isDestroyed()) return;
      await e.sender
        .executeJavaScript('window.__kinePlayerStageFullscreen ? window.__kinePlayerStageFullscreen() : false', true)
        .catch(() => undefined);
    });
    // Zabezpečení Windows: Smart App Control / Historie ochrany (jen tyhle dvě stránky -
    // windowsdefender:// umí i věci jako restart počítače, nic jiného se odsud neotevře).
    ipcMain.handle('app:openWindowsSecurity', (_e, page: unknown) => {
      if (process.platform !== 'win32') return;
      const url = page === 'smartapp' ? 'windowsdefender://smartapp/' : page === 'history' ? 'windowsdefender://history' : null;
      if (url) void shell.openExternal(url).catch((e) => log(`Zabezpečení Windows nejde otevřít: ${(e as Error).message}`));
    });
    ipcMain.handle('app:copyDiagnostics', async () => {
      await clipboard.writeText(await this.diagnostics());
      return true;
    });
    ipcMain.handle('app:openExternal', (_e, url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    });
    ipcMain.handle('app:openKine', (_e, path: string) => this.openKine(typeof path === 'string' ? path : ''));
    ipcMain.handle('kineView:show', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
      if (bounds && typeof bounds.width === 'number') this.showKineView(bounds);
    });
    ipcMain.handle('kineView:hide', () => this.hideKineView());
    ipcMain.handle('kineView:reload', () => this.reloadKineView());
    // Barva Kine (5x klik na logo): uloží se v appce a - když je hráč
    // přihlášený - i na jeho účet, ať ji má stejnou na webu.
    ipcMain.handle('brand:set', async (_e, color: string | null) => {
      const clean = typeof color === 'string' && hexToRgbTriplet(color) ? color.trim() : '';
      this.settings.update({ brandColor: clean });
      await this.auth.setBrandColor(clean || null);
    });
    // Stránky nemají přístup k protokolu - chyby přehrávače a podobně sem.
    ipcMain.handle('app:log', (_e, message: string) => log(`[okno] ${String(message).slice(0, 500)}`));
    ipcMain.handle('app:quit', () => this.quit());
    ipcMain.handle('capture:toggle', () => this.onToggleHotkey());
  }

  /**
   * Odkazy kine://…: "link" dokončí přihlášení přes prohlížeč,
   * "open?tab=clips" / "clips" otevře klipy, "settings" nastavení -
   * i z webu Kine běžícího v okně appky.
   */
  async handleDeepLink(url: string): Promise<void> {
    try {
      const handled = await this.auth.handleDeepLink(url);
      if (handled) {
        this.openSettings('account');
        return;
      }
      const parsed = new URL(url);
      const target = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
      const tab = parsed.searchParams.get('tab') ?? (target === 'open' ? 'clips' : target);
      if (['clips', 'live', 'settings', 'games', 'upload', 'account', 'about'].includes(tab)) this.openSettings(tab);
      else if (target === 'kine') this.openKine(parsed.searchParams.get('path') ?? '');
    } catch (e) {
      log(`kine:// odkaz: ${(e as Error).message}`);
      dialog.showErrorBox(PRODUCT, (e as Error).message);
    }
  }

  private quitting = false;

  /**
   * "Aktualizovat" (O appce, lišta): stažená verze se nainstaluje hned a
   * appka se sama znovu spustí. Během vysílání a nahrávání zápasu ne (o
   * vysílání by hráč přišel) - okno řekne, ať je nejdřív ukončí.
   */
  async installUpdate(): Promise<'ok' | 'busy' | 'not-ready'> {
    if (this.live.active() || this.capture.recordingInfo() || this.finishingRecording) return 'busy';
    if (updateProgress().phase !== 'ready') return 'not-ready';
    if (this.quitting) return 'ok';
    this.quitting = true;
    log('konec kvůli aktualizaci');
    const started = await installUpdateNow(async () => {
      this.helper?.stop();
      this.loopback?.stop();
      this.compressor.cancel();
      this.uploader.stopWaiting();
      await Promise.race([this.gameEvents.stop(), new Promise((r) => setTimeout(r, 2000))]).catch(() => undefined);
      await Promise.race([this.stopCapture('quit'), new Promise((r) => setTimeout(r, 6000))]).catch(() => undefined);
      this.toast.destroy();
    });
    if (started === 'not-ready') {
      this.quitting = false;
      return 'not-ready';
    }
    if (started === 'failed') {
      // Snímání a pomocník už stojí - čistý restart do stávající verze (aktualizace se zkusí znovu příště).
      app.relaunch();
      app.exit(0);
      return 'ok';
    }
    // Pojistka: instalátor už běží - kdyby se appka sama nezavřela, zavřít ji (jinak by instalátor čekal).
    setTimeout(() => app.exit(0), 8000);
    return 'ok';
  }

  quit(): void {
    // Druhé "Ukončit" (lišta, okno) během ukončování nic nespouští znovu.
    if (this.quitting) return;
    this.quitting = true;
    log('konec');
    this.helper?.stop();
    this.loopback?.stop();
    this.compressor.cancel();
    this.uploader.stopWaiting();
    void this.gameEvents.stop();
    // Rozjetá (nebo právě ukládaná) nahrávka se před koncem uloží (dlouhá může chvíli trvat - proto delší strop).
    const recording = !!this.capture.recordingInfo() || !!this.finishingRecording;
    // Vysílání se ukončí pořádně (Cloudflare uzavře záznam hned, ne až po minutě ticha).
    void this.live
      .stop('quit')
      .catch(() => undefined)
      .then(() => this.stopCapture('quit'))
      .finally(() => {
        this.toast.destroy();
        app.exit(0);
      });
    setTimeout(() => app.exit(0), recording ? 5 * 60 * 1000 : 6000);
  }
}

const kine = new KineApp();

app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('kine://'));
  if (link) void kine.handleDeepLink(link);
  else kine.openSettings(kine.settings?.get().appMode === 'full' && kine.settings.get().onboarded ? 'kine' : undefined);
});

app.on('open-url', (e, url) => {
  e.preventDefault();
  void kine.handleDeepLink(url);
});

app.on('window-all-closed', () => {
  // Appka žije v liště - zavření okna ji neukončí.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  kine.helper?.stop();
  kine.loopback?.stop();
});

// Zkouška bez zvukové karty (Xvfb): Chromium podstrčí falešný mikrofon s tónem,
// ať se dá ověřit míchání zvuku, měřáky a že klip zvuk opravdu má.
if (process.env.KINE_TEST_FAKE_AUDIO) app.commandLine.appendSwitch('use-fake-device-for-media-stream');

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    await kine.start();
  } catch (e) {
    log(`start selhal: ${(e as Error).stack ?? (e as Error).message}`);
    dialog.showErrorBox(PRODUCT, `The app could not start: ${(e as Error).message}`);
    app.exit(1);
  }
});

export type { KineApp };
