import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  screen,
  session,
  shell,
} from 'electron';
import type { CaptureEvent, Clip, DisplayInfo, Settings, Status, Visibility } from '../shared/types';
import { hexToRgbTriplet } from '../shared/plan';
import { makeT, type Key } from '../shared/i18n';
import { hotkeyLabel } from '../shared/hotkeys';
import { defaultClipTitle } from '../shared/clipNaming';
import { maxClipSecondsFor } from '../shared/plan';
import { initLog, log, logDir } from './log';
import { SettingsStore } from './settings';
import { ClipLibrary } from './clips';
import { CaptureManager } from './capture';
import { GameWatcher, type DetectedGame } from './games';
import { KNOWN_GAMES } from './gamesParse';
import { Auth } from './auth';
import { createKineApi } from './kineApi';
import { Uploader } from './uploader';
import { Toast } from './toast';
import { checkForUpdates, initUpdater } from './updater';
import { runTestDriver } from './testDriver';
import { WinHelper } from './winHelper';
import { makeThumbnail, trimClip } from './edit';
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
 * Dva režimy: "jen klipovač" (okno s klipy a nastavením) a "Kine +
 * klipy" (v tom samém okně je první záložka "Kine" - web Kine vložený
 * jako WebContentsView, s trvalým přihlášením; klipy a nastavení jsou
 * hned vedle).
 */

const PRELOAD = join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_DIR = join(__dirname, '..', 'renderer');
const ICON_PNG = join(app.getAppPath(), 'build', 'icon.png');

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
  capture!: CaptureManager;
  games!: GameWatcher;
  auth!: Auth;
  uploader!: Uploader;
  toast!: Toast;
  helper: WinHelper | null = null;
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

  /** Délka klipu podle nastavení, oříznutá stropem plánu (zdarma 60 s). */
  effectiveClipSeconds(): number {
    return Math.min(this.settings.get().clipSeconds, maxClipSecondsFor(this.auth.current()));
  }

  async start(): Promise<void> {
    // Windows: bez tohohle nejdou systémová oznámení a ikona v liště se
    // po aktualizaci "rozdvojí".
    if (process.platform === 'win32') app.setAppUserModelId('cz.kine.desktop');
    initLog(join(app.getPath('userData'), 'logs'));
    log(`start Kine ${app.getVersion()} (${process.platform}, electron ${process.versions.electron})`);

    this.settings = new SettingsStore();
    // Režim podle názvu instalátoru - při prvním spuštění i po aktualizaci
    // ze starší verze, kde se ještě nevybíral.
    if (!this.settings.get().onboarded || !this.settings.get().appModeChosen) await this.presetModeFromInstaller();
    this.library = new ClipLibrary(this.settings.clipsDir());
    this.library.load();

    this.auth = new Auth(() => this.settings.get().siteUrl);
    const api = createKineApi({ siteUrl: () => this.settings.get().siteUrl, getToken: () => this.auth.getToken() });

    this.toast = new Toast({
      preload: PRELOAD,
      rendererDir: RENDERER_DIR,
      enabled: () => this.settings.get().toast,
      displayId: () => this.settings.get().displayId,
    });

    this.capture = new CaptureManager({
      settings: () => this.settings.get(),
      preload: PRELOAD,
      rendererDir: RENDERER_DIR,
      onState: (state, error) => {
        if (state === 'error' && error) void this.toast.show(this.t('toastCaptureError', { message: error }), 'error', { notification: true });
        this.pushStatus();
      },
      onWarning: (kind, message) => {
        // Jednou za běh appky - ne při každém startu zásobníku.
        if (this.warnedOnce.has(kind)) return;
        this.warnedOnce.add(kind);
        void this.toast.show(this.t('toastMicUnavailable', { message: message.replace(/^\w*Error:\s*/, '') }), 'warn', { notification: true });
      },
    });

    if (WinHelper.supported() && !process.env.KINE_NO_HELPER) {
      this.helper = new WinHelper(app.getPath('userData'));
      this.helper.on({ state: () => this.pushStatus() });
    }

    this.games = new GameWatcher({
      settings: () => this.settings.get(),
      helper: this.helper,
      onChange: (game, prev) => void this.onGameChange(game, prev),
    });

    this.hotkeys = new HotkeyManager({
      helper: this.helper,
      onFire: (id) => this.onHotkey(id),
      onProblemsChanged: () => this.pushStatus(),
    });

    this.uploader = new Uploader({
      library: this.library,
      api,
      blocked: () => (this.games.current() ? 'game' : net.isOnline() ? null : 'offline'),
      settings: () => this.settings.get(),
      log,
    });
    this.uploader.on((e) => {
      if (e.type === 'done') void this.toast.show(this.t('toastUploaded', { title: e.clip.title }), 'ok', { notification: true });
      if (e.type === 'error') void this.toast.show(this.t('toastUploadFailed', { title: e.clip.title }) + ` (${e.message})`, 'error', { notification: true });
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
    this.helper?.start();
    this.createTray();
    this.applyLoginItem();
    initUpdater();

    this.settings.onChange((s, prev) => this.onSettingsChanged(s, prev));

    await this.auth.init();
    this.games.start();
    this.uploader.restoreFromLibrary();

    if (this.settings.get().detection === 'always') void this.capture.start().catch(() => undefined);

    // Nahrávání čeká i na připojení - když se vrátí, nikdo jiný to nepošťouchne.
    setInterval(() => {
      if (this.uploader.pending() > 0) this.uploader.kick();
    }, 30000);
    // Pojistka pro sdílené přihlášení: web v okně se občas zkontroluje, i když
    // žádný přechod stránky nepřišel (přihlášení přes okno třetí strany apod.).
    setInterval(() => {
      if (this.kineViewShown && this.kineView && !this.kineView.webContents.isDestroyed()) void this.syncLogin(this.kineView);
    }, 15000);
    // Plán (předplatné) a barva se občas srovnají podle Kine - když Klipy
    // Plus vyprší, automatické nahrávání se samo vrátí na ruční.
    setInterval(() => void this.auth.refresh(), 6 * 60 * 60 * 1000);

    const hidden = process.argv.includes('--hidden');
    const s = this.settings.get();
    if (!s.onboarded) this.openSettings('wizard');
    else if (!hidden) this.openSettings(s.appMode === 'full' ? 'kine' : 'clips');

    // Odkaz kine://…, kterým appku někdo spustil (Windows předává v argv).
    for (const arg of process.argv) if (arg.startsWith('kine://')) void this.handleDeepLink(arg);

    if (process.env.KINE_TEST) void runTestDriver(this as any);
    this.pushStatus();
  }

  /**
   * Instalátor si zapsal svůj název do registru (build/installer.nsh):
   * "Kine-Clipper-Setup.exe" = hráč si na webu vybral jen klipovač,
   * "Kine-Setup.exe" = Kine + klipy. Průvodce to jen předvyplní.
   */
  private async presetModeFromInstaller(): Promise<void> {
    if (process.platform !== 'win32') return;
    const out = await new Promise<string>((resolve) => {
      execFile('reg', ['query', 'HKCU\\Software\\Kine', '/v', 'installer'], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    const m = /installer\s+REG_SZ\s+(.+)$/im.exec(out);
    if (!m) return;
    const name = m[1].trim();
    const mode: Settings['appMode'] = /clip|klip/i.test(name) ? 'clipper' : 'full';
    log(`instalátor: ${name} -> režim ${mode}`);
    this.settings.update({ appMode: mode, appModeChosen: true });
  }

  // ---- hry ---------------------------------------------------------------------

  private async onGameChange(game: DetectedGame | null, prev: DetectedGame | null): Promise<void> {
    const s = this.settings.get();
    this.pushStatus();
    this.uploader.kick();
    const announce = (g: DetectedGame) => void this.toast.show(this.t('toastGameDetected', { game: g.name, hotkey: hotkeyLabel(s.clipHotkey) }), 'ok');

    if (game && !prev) {
      this.sessionId = randomUUID();
      if (s.detection === 'games' && !this.paused) {
        await this.capture.start().catch(() => undefined);
        announce(game);
      }
    } else if (game && prev && game.exe !== prev.exe) {
      // Přepnutí z jedné hry do druhé (obě běží): stejné "hraní", zásobník
      // jede dál, jen se přejmenuje, co se klipuje.
      if (s.detection === 'games' && !this.paused) announce(game);
    }

    if (!game && prev) {
      if (s.detection === 'games') await this.capture.stop().catch(() => undefined);
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
      this.uploader.enqueue(clips.map((c) => ({ clipId: c.id, visibility: s.visibility })));
    } else if (mode === 'review') {
      this.openReview(this.sessionId);
    }
  }

  // ---- klipy -------------------------------------------------------------------

  private onHotkey(id: HotkeyId): void {
    if (id === 'clip') void this.onClipHotkey();
    else void this.onToggleHotkey();
  }

  /** Stisk zkratky. Klipy se řadí za sebe - dva rychlé stisky = dva klipy. */
  onClipHotkey(): Promise<Clip | null> {
    const run = async (): Promise<Clip | null> => {
      const s = this.settings.get();
      const toggleLabel = hotkeyLabel(s.toggleHotkey);
      if (this.capture.state !== 'on') {
        const key: Key = s.detection === 'manual' ? 'toastNotCapturingManual' : 'toastNotCapturing';
        void this.toast.show(this.t(key, { hotkey: toggleLabel }), 'warn');
        return null;
      }
      const game = this.games.current();
      try {
        const result = await this.capture.makeClip(this.effectiveClipSeconds(), this.settings.clipsDir(), game?.name ?? null, join(app.getPath('userData'), 'thumbs'));
        const clip: Clip = {
          id: randomUUID(),
          file: result.file,
          thumb: result.thumb,
          title: defaultClipTitle(result.createdAt, game?.name ?? null, this.t('clipWord')),
          game: game?.name ?? null,
          createdAt: result.createdAt.toISOString(),
          durationSeconds: result.durationSeconds,
          sizeBytes: result.sizeBytes,
          width: result.width,
          height: result.height,
          sessionId: game ? this.sessionId : 'no-game-' + this.sessionId,
          upload: null,
        };
        this.library.add(clip);
        const seconds = Math.round(result.durationSeconds);
        void this.toast.show(
          game ? this.t('toastClipSavedGame', { seconds, game: game.name }) : this.t('toastClipSaved', { seconds }),
          'ok',
          { notification: !s.toast }
        );
        // Bez hry (režim "pořád"/"ručně") se po ničem nečeká - nabídnout hned podle nastavení.
        if (!game && this.effectiveAfterGame() === 'auto') this.uploader.enqueue([{ clipId: clip.id, visibility: s.visibility }]);
        return clip;
      } catch (e) {
        const message = (e as Error).message;
        if (message === 'too-early') void this.toast.show(this.t('toastTooEarly'), 'warn');
        else if (message === 'not-capturing') void this.toast.show(this.t('toastNotCapturing', { hotkey: toggleLabel }), 'warn');
        else void this.toast.show(this.t('toastClipFailed', { message }), 'error', { notification: true });
        return null;
      }
    };
    const next = this.clipChain.then(run, run);
    this.clipChain = next.catch(() => undefined);
    return next;
  }

  async onToggleHotkey(): Promise<void> {
    const s = this.settings.get();
    if (this.capture.state === 'on' || this.capture.state === 'starting') {
      await this.capture.stop();
      void this.toast.show(this.t('toastBufferOff'), 'warn');
    } else {
      await this.capture.start().catch(() => undefined);
      if ((this.capture.state as string) === 'on') {
        void this.toast.show(this.t('toastBufferOn', { hotkey: hotkeyLabel(s.clipHotkey), seconds: s.clipSeconds }), 'ok');
      }
    }
    this.rebuildTray();
    this.pushStatus();
  }

  // ---- nastavení ----------------------------------------------------------------

  private onSettingsChanged(s: Settings, prev: Settings): void {
    if (s.clipHotkey !== prev.clipHotkey || s.toggleHotkey !== prev.toggleHotkey) this.registerHotkeys();
    if (s.startWithSystem !== prev.startWithSystem) this.applyLoginItem();
    if (s.clipsDir !== prev.clipsDir) this.library.load(this.settings.clipsDir());
    const captureKeys: (keyof Settings)[] = ['maxHeight', 'fps', 'codec', 'videoMbps', 'systemAudio', 'microphone', 'displayId'];
    if (captureKeys.some((k) => s[k] !== prev[k])) void this.capture.restartIfOn();
    if (s.detection !== prev.detection) {
      if (s.detection === 'always') void this.capture.start().catch(() => undefined);
      else if (s.detection === 'games' && !this.games.current()) void this.capture.stop();
      else if (s.detection === 'manual') void this.capture.stop();
    }
    if (s.detectFullscreen !== prev.detectFullscreen) void this.games.refresh();
    if (s.appMode !== prev.appMode && s.appMode === 'clipper') this.destroyKineView();
    if (s.siteUrl !== prev.siteUrl) this.destroyKineView();
    this.rebuildTray();
    this.pushStatus();
    this.broadcast('settings', s);
  }

  private registerHotkeys(): void {
    const s = this.settings.get();
    const problems = this.hotkeys.apply({ clip: s.clipHotkey, toggle: s.toggleHotkey });
    for (const p of problems) {
      // Hráč musí vědět, že F8 nic neudělá - jinak by to vypadalo jako rozbitá appka.
      if (p.reason === 'helper-down') continue; // pomocník teprve nabíhá; kdyby nenaběhl, uvidí to v nastavení
      void this.toast.show(this.t('hotkeyProblem', { hotkey: hotkeyLabel(p.hotkey), reason: this.hotkeyReasonText(p.reason) }), 'warn', { notification: true });
    }
  }

  hotkeyReasonText(reason: HotkeyReason): string {
    switch (reason) {
      case 'in-use':
        return this.t('hotkeyInUse');
      case 'unsupported':
        return this.t('hotkeyChordUnsupported');
      case 'helper-down':
        return this.t('hotkeyHelperDown');
      default:
        return reason;
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
    let icon = nativeImage.createFromPath(ICON_PNG);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    else icon = icon.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    const open = () => this.openSettings(this.settings.get().appMode === 'full' && this.settings.get().onboarded ? 'kine' : undefined);
    this.tray.on('click', open);
    this.tray.on('double-click', open);
    this.rebuildTray();
  }

  statusLine(): string {
    const s = this.settings.get();
    const game = this.games.current();
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
      { label: `Kine · ${this.statusLine()}`, enabled: false },
    ];
    if (pending > 0) {
      items.push({ label: this.uploader.isPausedByGame() ? this.t('trayUploadsPaused', { count: pending }) : this.t('trayUploads', { count: pending }), enabled: false });
    }
    if (!this.auth.current()) items.push({ label: this.t('trayNotLoggedIn'), click: () => this.openSettings('account') });
    items.push(
      { type: 'separator' },
      { label: this.t('trayClipNow', { hotkey: hotkeyLabel(s.clipHotkey) }), click: () => void this.onClipHotkey(), enabled: this.capture.state === 'on' },
      { label: this.t('trayLibrary'), click: () => this.openSettings('clips') },
      { label: this.t('traySettings'), click: () => this.openSettings('settings') },
      { label: this.paused ? this.t('trayResume') : this.t('trayPause'), click: () => void this.togglePause() },
      { label: this.t('trayOpenKine'), click: () => this.openKine() },
      { type: 'separator' },
      { label: this.t('trayQuit'), click: () => this.quit() }
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(`Kine · ${this.statusLine()}`);
  }

  private async togglePause(): Promise<void> {
    this.paused = !this.paused;
    if (this.paused) await this.capture.stop();
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
      title: 'Kine',
      backgroundColor: '#050506',
      autoHideMenuBar: true,
      icon: ICON_PNG,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    this.settingsWindow = win;
    void win.loadFile(join(RENDERER_DIR, 'settings.html'), { query: tab ? { tab } : {} });
    win.on('closed', () => {
      this.settingsWindow = null;
      this.destroyKineView();
    });
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
      title: 'Kine',
      backgroundColor: '#050506',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      icon: ICON_PNG,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    this.reviewWindow = win;
    void win.loadFile(join(RENDERER_DIR, 'review.html'), { query: { session: sessionId } });
    win.once('ready-to-show', () => win.setAlwaysOnTop(false));
    win.on('closed', () => {
      this.reviewWindow = null;
    });
  }

  private isKineUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.settings.get().siteUrl).origin;
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
    const url = s.siteUrl + (path ? (path.startsWith('/') ? path : `/${path}`) : '');
    if (s.appMode !== 'full') {
      void shell.openExternal(url);
      return;
    }
    if (this.kineView && !this.kineView.webContents.isDestroyed()) {
      if (path) void this.kineView.webContents.loadURL(url);
    } else if (path) {
      this.pendingKinePath = path;
    }
    this.openSettings('kine');
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
    }
  }

  hideKineView(): void {
    this.kineViewWanted = false;
    if (this.kineView && !this.kineView.webContents.isDestroyed() && this.kineViewShown) this.kineView.setVisible(false);
    this.kineViewShown = false;
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
    };
  }

  pushStatus(): void {
    this.broadcast('status', this.status());
    this.rebuildTray();
  }

  pushClips(): void {
    this.broadcast('clips', this.library.list());
  }

  /**
   * Zkrácení / ztlumení klipu (edit.ts). Buď nový klip vedle původního,
   * nebo přepsání původního (ten se nejdřív zapíše bokem a pak přejmenuje,
   * ať při chybě nezůstane rozbitý soubor). Průběh chodí oknům jako
   * "clips:trimProgress".
   */
  async trimClip(id: string, opts: { start: number; end: number; mute: boolean; mode: 'new' | 'replace' }): Promise<Clip> {
    const clip = this.library.get(id);
    if (!clip) throw new Error('clip not found');
    const s = this.settings.get();
    const ext = extname(clip.file) || '.mp4';
    const dir = dirname(clip.file);
    const stem = basename(clip.file, ext);
    const progress = (percent: number) => this.broadcast('clips:trimProgress', { id, percent });
    // Konec nejdál na konci klipu (když délku neznáme, věří se stránce).
    const total = clip.durationSeconds > 0 ? clip.durationSeconds : Infinity;
    const options = {
      start: Math.max(0, Number(opts.start) || 0),
      end: Math.min(total, Number(opts.end) || total),
      mute: Boolean(opts.mute),
      videoMbps: s.videoMbps,
    };
    if (!Number.isFinite(options.end)) throw new Error('unknown length');
    if (options.end - options.start < 0.2) throw new Error('too-short');
    const thumbsDir = join(app.getPath('userData'), 'thumbs');

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
        // Obsah je jiný než ten na Kine - nahrání začíná znovu.
        upload: null,
      });
      log(`klip zkrácen (přepsán): ${clip.file} (${result.durationSeconds.toFixed(1)} s)`);
      return updated!;
    }

    const suffix = this.t('clipEditedSuffix');
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
      upload: null,
    };
    this.library.add(newClip);
    log(`klip zkrácen (nový): ${out} (${result.durationSeconds.toFixed(1)} s)`);
    return newClip;
  }

  // ---- IPC ---------------------------------------------------------------------

  private registerIpc(): void {
    const isCaptureSender = (e: Electron.IpcMainEvent) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      return !!win && win.webContents.getURL().endsWith('capture.html');
    };
    ipcMain.on('capture:chunk', (e, generation: number, data: ArrayBuffer) => {
      if (isCaptureSender(e)) this.capture.handleChunk(generation, data);
    });
    ipcMain.on('capture:event', (e, event: CaptureEvent) => {
      if (isCaptureSender(e)) this.capture.handleEvent(event);
    });
    ipcMain.handle('capture:sources', async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return sources.map((x) => ({ id: x.id, name: x.name, display_id: x.display_id }));
    });

    ipcMain.handle('settings:get', () => this.settings.get());
    ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => this.settings.update(patch));
    ipcMain.handle('status:get', () => this.status());
    ipcMain.handle('platform', () => process.platform);

    ipcMain.handle('clips:list', () => this.library.list());
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
    ipcMain.handle('clips:upload', (_e, requests: { clipId: string; visibility: Visibility; title?: string }[]) => {
      this.uploader.enqueue(requests);
      this.pushStatus();
    });
    ipcMain.handle('clips:openOnKine', (_e, id: string) => {
      const clip = this.library.get(id);
      if (clip?.upload?.state === 'done') this.openKine(clip.upload.url.replace(this.settings.get().siteUrl, '') || '/');
    });
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
    ipcMain.handle('clips:trim', (_e, id: string, opts: { start: number; end: number; mute: boolean; mode: 'new' | 'replace' }) => this.trimClip(id, opts));

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
    ipcMain.handle('review:done', (_e, requests: { clipId: string; visibility: Visibility; title?: string }[]) => {
      if (requests.length > 0) this.uploader.enqueue(requests);
      this.reviewWindow?.close();
      this.pushStatus();
    });

    ipcMain.handle('app:checkUpdate', () => checkForUpdates());
    ipcMain.handle('app:openLogs', () => shell.openPath(logDir()));
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
      if (['clips', 'settings', 'games', 'upload', 'account', 'about'].includes(tab)) this.openSettings(tab);
      else if (target === 'kine') this.openKine(parsed.searchParams.get('path') ?? '');
    } catch (e) {
      log(`kine:// odkaz: ${(e as Error).message}`);
      dialog.showErrorBox('Kine', (e as Error).message);
    }
  }

  quit(): void {
    log('konec');
    this.helper?.stop();
    void this.capture.stop().finally(() => {
      this.toast.destroy();
      app.exit(0);
    });
    setTimeout(() => app.exit(0), 4000);
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
});

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    await kine.start();
  } catch (e) {
    log(`start selhal: ${(e as Error).stack ?? (e as Error).message}`);
    dialog.showErrorBox('Kine', `The app could not start: ${(e as Error).message}`);
    app.exit(1);
  }
});

export type { KineApp };
