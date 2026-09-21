import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  Tray,
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
import { makeT, type Key } from '../shared/i18n';
import { acceleratorLabel } from '../shared/accelerator';
import { defaultClipTitle } from '../shared/clipNaming';
import { maxClipSecondsFor } from '../shared/plan';
import { initLog, log, logDir } from './log';
import { SettingsStore } from './settings';
import { ClipLibrary } from './clips';
import { CaptureManager } from './capture';
import { GameWatcher, type DetectedGame } from './games';
import { Auth } from './auth';
import { createKineApi } from './kineApi';
import { Uploader } from './uploader';
import { Toast } from './toast';
import { checkForUpdates, initUpdater } from './updater';
import { runTestDriver } from './testDriver';

/**
 * Kine do PC - hlavní proces.
 *
 * Appka žije v liště u hodin. Hlídá, jestli běží hra (games.ts); když
 * ano, drží posledních N sekund obrazu (capture.ts). Zkratka uloží klip
 * (clips.ts), po hře se klipy nabídnou k nahrání nebo nahrají samy
 * (uploader.ts) - ale nikdy během hraní.
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
  tray: Tray | null = null;
  settingsWindow: BrowserWindow | null = null;
  reviewWindow: BrowserWindow | null = null;
  /** Aktuální "hraní": všechny klipy z něj se po hře nabídnou naráz. */
  sessionId = randomUUID();
  paused = false;
  browserLoginWaiting = false;
  clipChain: Promise<unknown> = Promise.resolve();

  t(key: Key, vars?: Record<string, string | number>): string {
    return makeT(this.settings.get().lang)(key, vars);
  }

  /** Má hráč Kine Plus? Bez přihlášení ne. */
  hasPlus(): boolean {
    return this.auth.current()?.plan === 'plus';
  }

  /** Co se má stát po hře - "auto" je jen v Plus, jinak se chová jako "review". */
  effectiveAfterGame(): Settings['afterGame'] {
    const wanted = this.settings.get().afterGame;
    return wanted === 'auto' && !this.hasPlus() ? 'review' : wanted;
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
    });

    this.games = new GameWatcher({
      settings: () => this.settings.get(),
      onChange: (game, prev) => void this.onGameChange(game, prev),
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
      // Barva Kine z účtu -> appka se přebarví stejně jako web hráče.
      const color = account?.brandColor && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(account.brandColor) ? account.brandColor : '';
      if (color !== this.settings.get().brandColor) this.settings.update({ brandColor: color });
      this.pushStatus();
      this.rebuildTray();
    });

    this.installDisplayMediaHandler();
    this.registerIpc();
    this.registerHotkeys();
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
    // Plán (Kine Plus) a barva se občas srovnají podle Kine - když Plus
    // vyprší, automatické nahrávání se samo vrátí na ruční.
    setInterval(() => void this.auth.refresh(), 6 * 60 * 60 * 1000);

    const hidden = process.argv.includes('--hidden');
    if (!this.settings.get().onboarded || !hidden) this.openSettings(!this.settings.get().onboarded ? 'wizard' : undefined);

    // Odkaz kine://…, kterým appku někdo spustil (Windows předává v argv).
    for (const arg of process.argv) if (arg.startsWith('kine://')) void this.handleDeepLink(arg);

    if (process.env.KINE_TEST) void runTestDriver(this as any);
    this.pushStatus();
  }

  // ---- hry ---------------------------------------------------------------------

  private async onGameChange(game: DetectedGame | null, prev: DetectedGame | null): Promise<void> {
    const s = this.settings.get();
    this.pushStatus();
    this.uploader.kick();

    if (game && !prev) {
      this.sessionId = randomUUID();
      if (s.detection === 'games' && !this.paused) {
        await this.capture.start().catch(() => undefined);
        void this.toast.show(this.t('toastGameDetected', { game: game.name, hotkey: acceleratorLabel(s.clipHotkey) }), 'ok');
      }
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

  /** Stisk zkratky. Klipy se řadí za sebe - dva rychlé stisky = dva klipy. */
  onClipHotkey(): Promise<Clip | null> {
    const run = async (): Promise<Clip | null> => {
      const s = this.settings.get();
      const hotkeyLabel = acceleratorLabel(s.toggleHotkey);
      if (this.capture.state !== 'on') {
        const key: Key = s.detection === 'manual' ? 'toastNotCapturingManual' : 'toastNotCapturing';
        void this.toast.show(this.t(key, { hotkey: hotkeyLabel }), 'warn');
        return null;
      }
      const game = this.games.current();
      try {
        const result = await this.capture.makeClip(this.effectiveClipSeconds(), this.settings.clipsDir(), game?.name ?? null);
        const clip: Clip = {
          id: randomUUID(),
          file: result.file,
          thumb: result.thumb,
          title: defaultClipTitle(result.createdAt, game?.name ?? null, s.lang),
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
        else if (message === 'not-capturing') void this.toast.show(this.t('toastNotCapturing', { hotkey: hotkeyLabel }), 'warn');
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
        void this.toast.show(this.t('toastBufferOn', { hotkey: acceleratorLabel(s.clipHotkey), seconds: s.clipSeconds }), 'ok');
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
    this.rebuildTray();
    this.pushStatus();
    this.broadcast('settings', s);
  }

  private registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const s = this.settings.get();
    const ok1 = globalShortcut.register(s.clipHotkey, () => void this.onClipHotkey());
    const ok2 = globalShortcut.register(s.toggleHotkey, () => void this.onToggleHotkey());
    for (const [ok, key] of [[ok1, s.clipHotkey], [ok2, s.toggleHotkey]] as const) {
      if (ok) continue;
      log(`zkratku ${key} nejde zaregistrovat (drží ji jiný program)`);
      // Hráč musí vědět, že F8 nic neudělá - jinak by to vypadalo jako rozbitá appka.
      void this.toast.show(`${acceleratorLabel(key)}: ${this.t('hotkeyInUse')}`, 'warn', { notification: true });
    }
  }

  /** Je zkratka volná? Zkusí ji zaregistrovat a hned pustit. */
  hotkeyAvailable(accelerator: string): boolean {
    const s = this.settings.get();
    if (accelerator === s.clipHotkey || accelerator === s.toggleHotkey) return true;
    if (globalShortcut.isRegistered(accelerator)) return true;
    try {
      const ok = globalShortcut.register(accelerator, () => undefined);
      if (ok) globalShortcut.unregister(accelerator);
      return ok;
    } catch {
      return false;
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
          if (!source) throw new Error('žádná obrazovka');
          const audio = request.audioRequested && process.platform === 'win32' && s.systemAudio ? 'loopback' : undefined;
          callback(audio ? { video: source, audio } : { video: source });
        } catch (e) {
          log(`výběr obrazovky selhal: ${(e as Error).message}`);
          callback({});
        }
      },
      { useSystemPicker: false }
    );
    // Mikrofon pro skrytou snímací stránku (a nic jiného).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media' || permission === 'display-capture' || permission === 'notifications');
    });
  }

  // ---- tray -------------------------------------------------------------------

  private createTray(): void {
    let icon = nativeImage.createFromPath(ICON_PNG);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    else icon = icon.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.on('click', () => this.openSettings());
    this.tray.on('double-click', () => this.openSettings());
    this.rebuildTray();
  }

  statusLine(): string {
    const s = this.settings.get();
    const game = this.games.current();
    if (this.paused) return this.t('trayPaused');
    if (this.capture.state === 'on' || this.capture.state === 'starting') {
      return game ? this.t('trayCapturing', { game: game.name }) : this.t('trayCapturingNoGame');
    }
    if (s.detection === 'manual') return this.t('trayIdleManual', { hotkey: acceleratorLabel(s.toggleHotkey) });
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
      { label: this.t('trayClipNow', { hotkey: acceleratorLabel(s.clipHotkey) }), click: () => void this.onClipHotkey(), enabled: this.capture.state === 'on' },
      { label: this.t('trayLibrary'), click: () => this.openSettings('library') },
      { label: this.t('traySettings'), click: () => this.openSettings() },
      { label: this.paused ? this.t('trayResume') : this.t('trayPause'), click: () => void this.togglePause() },
      { label: this.t('trayOpenKine'), click: () => void shell.openExternal(s.siteUrl) },
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
    const win = new BrowserWindow({
      width: 900,
      height: 660,
      minWidth: 720,
      minHeight: 520,
      title: 'Kine',
      backgroundColor: '#0e0e12',
      autoHideMenuBar: true,
      icon: ICON_PNG,
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    this.settingsWindow = win;
    void win.loadFile(join(RENDERER_DIR, 'settings.html'), { query: tab ? { tab } : {} });
    win.on('closed', () => {
      this.settingsWindow = null;
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
      width: 680,
      height: 600,
      minWidth: 520,
      minHeight: 420,
      title: 'Kine',
      backgroundColor: '#0e0e12',
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

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  status(): Status {
    const account = this.auth.current();
    return {
      capture: this.capture.state,
      captureError: this.capture.error,
      game: this.games.current()?.name ?? null,
      uploadsPending: this.uploader.pending(),
      uploadsPaused: this.uploader.isPausedByGame(),
      account: account
        ? {
            username: account.username,
            email: account.email,
            plan: account.plan,
            planUntil: account.planUntil,
            maxClipSeconds: maxClipSecondsFor(account),
            plusAvailable: account.plusAvailable,
            plusPriceLabel: account.plusPriceLabel,
          }
        : null,
      paused: this.paused,
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
    ipcMain.handle('clips:rename', (_e, id: string, title: string) => this.library.update(id, { title: String(title).trim().slice(0, 150) || 'Klip' }));
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
      if (clip?.upload?.state === 'done') void shell.openExternal(clip.upload.url);
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
    ipcMain.handle('auth:logout', () => this.auth.logout());
    ipcMain.handle('auth:refresh', () => this.auth.refresh());

    ipcMain.handle('games:listProcesses', () => this.games.listProcesses());
    ipcMain.handle('games:current', () => this.games.current());
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
        label: `${d.label || `Obrazovka ${i + 1}`} (${d.size.width}×${d.size.height})`,
        width: d.size.width,
        height: d.size.height,
        primary: d.id === primary,
      }));
    });
    ipcMain.handle('hotkey:available', (_e, accelerator: string) => this.hotkeyAvailable(accelerator));

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
    ipcMain.handle('app:quit', () => this.quit());
    ipcMain.handle('capture:toggle', () => this.onToggleHotkey());
  }

  async handleDeepLink(url: string): Promise<void> {
    try {
      const handled = await this.auth.handleDeepLink(url);
      if (handled) this.openSettings('account');
    } catch (e) {
      log(`kine:// odkaz: ${(e as Error).message}`);
      dialog.showErrorBox('Kine', (e as Error).message);
    }
  }

  quit(): void {
    log('konec');
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
  else kine.openSettings();
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
});

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide();
  try {
    await kine.start();
  } catch (e) {
    log(`start selhal: ${(e as Error).stack ?? (e as Error).message}`);
    dialog.showErrorBox('Kine', `Appka se nespustila: ${(e as Error).message}`);
    app.exit(1);
  }
});

export type { KineApp };
