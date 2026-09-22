import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureCommand, CaptureEvent, Clip, DisplayInfo, GameSource, ProcessInfo, Settings, Status, Visibility } from '../shared/types';

/**
 * Most mezi stránkami a hlavním procesem. Stránky nemají Node ani
 * electron - jen tohle úzké rozhraní (window.kine, window.kineCapture).
 */

type UploadRequest = { clipId: string; visibility: Visibility; title?: string };

const on = <T>(channel: string, cb: (payload: T) => void) => {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const kine = {
  platform: process.platform,
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),
  onSettings: (cb: (s: Settings) => void) => on<Settings>('settings', cb),
  getStatus: (): Promise<Status> => ipcRenderer.invoke('status:get'),
  onStatus: (cb: (s: Status) => void) => on<Status>('status', cb),
  onNavigate: (cb: (target: string) => void) => on<string>('navigate', cb),

  listClips: (): Promise<Clip[]> => ipcRenderer.invoke('clips:list'),
  onClips: (cb: (clips: Clip[]) => void) => on<Clip[]>('clips', cb),
  deleteClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:delete', id),
  renameClip: (id: string, title: string): Promise<Clip | null> => ipcRenderer.invoke('clips:rename', id, title),
  setClipGame: (id: string, game: string | null): Promise<Clip | null> => ipcRenderer.invoke('clips:setGame', id, game),
  openClip: (id: string): Promise<string> => ipcRenderer.invoke('clips:open', id),
  revealClip: (id: string): Promise<void> => ipcRenderer.invoke('clips:reveal', id),
  uploadClips: (requests: UploadRequest[]): Promise<void> => ipcRenderer.invoke('clips:upload', requests),
  openOnKine: (id: string): Promise<void> => ipcRenderer.invoke('clips:openOnKine', id),
  openClipsDir: (): Promise<string> => ipcRenderer.invoke('clips:openDir'),
  pickClipsDir: (): Promise<string | null> => ipcRenderer.invoke('clips:pickDir'),
  clipNow: (): Promise<Clip | null> => ipcRenderer.invoke('clips:clipNow'),
  /** Zkrácení / ztlumení klipu; 'new' = nový klip vedle, 'replace' = přepsat původní. */
  trimClip: (id: string, opts: { start: number; end: number; mute: boolean; mode: 'new' | 'replace'; vertical?: 'left' | 'center' | 'right' }): Promise<Clip> => ipcRenderer.invoke('clips:trim', id, opts),
  /** Text do schránky (odkaz na klip). */
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('app:copy', text),
  /** Nahraný klip na Discord (webhook z nastavení). */
  shareToDiscord: (id: string): Promise<void> => ipcRenderer.invoke('clips:discord', id),
  /** Hvězdička u klipu. */
  setFavorite: (id: string, favorite: boolean): Promise<Clip | null> => ipcRenderer.invoke('clips:favorite', id, favorite),
  /** Sestřih vybraných klipů do jednoho nového (průběh chodí jako onTrimProgress s id "merge"). */
  mergeClips: (ids: string[]): Promise<Clip> => ipcRenderer.invoke('clips:merge', ids),
  /** GIF z úseku klipu - soubor vedle klipu (průběh jako onTrimProgress s id klipu). */
  makeGif: (id: string, range: { start: number; end: number }): Promise<{ file: string; sizeBytes: number; lengthSeconds: number }> => ipcRenderer.invoke('clips:gif', id, range),
  /** Ukázat soubor ze složky s klipy (třeba GIF) ve složce. */
  revealFile: (file: string): Promise<void> => ipcRenderer.invoke('clips:revealFile', file),
  onTrimProgress: (cb: (p: { id: string; percent: number }) => void) => on<{ id: string; percent: number }>('clips:trimProgress', cb),
  toggleCapture: (): Promise<void> => ipcRenderer.invoke('capture:toggle'),
  /** Pozastavit / obnovit nahrávání do zásobníku (jako v nabídce u hodin). */
  togglePause: (): Promise<void> => ipcRenderer.invoke('capture:pause'),

  loginBrowser: (): Promise<void> => ipcRenderer.invoke('auth:loginBrowser'),
  cancelBrowserLogin: (): Promise<void> => ipcRenderer.invoke('auth:cancelBrowser'),
  loginPassword: (email: string, password: string): Promise<void> => ipcRenderer.invoke('auth:loginPassword', email, password),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  refreshAccount: (): Promise<void> => ipcRenderer.invoke('auth:refresh'),
  onAuthWaiting: (cb: (waiting: boolean) => void) => on<boolean>('auth:waiting', cb),

  listProcesses: (): Promise<ProcessInfo[]> => ipcRenderer.invoke('games:listProcesses'),
  currentGame: (): Promise<{ name: string; exe: string; source: GameSource } | null> => ipcRenderer.invoke('games:current'),
  /** Názvy her pro výběr u klipu: z klipů, z "mých her", ze seznamu známých. */
  gameNames: (): Promise<string[]> => ipcRenderer.invoke('games:names'),
  addGame: (exe: string, name: string): Promise<void> => ipcRenderer.invoke('games:add', exe, name),
  removeGame: (exe: string): Promise<void> => ipcRenderer.invoke('games:remove', exe),

  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('displays:list'),
  /** 'ok', nebo důvod, proč zkratka nepůjde ('in-use' | 'unsupported' | 'helper-down' | 'invalid'). */
  hotkeyAvailable: (hotkey: string): Promise<string> => ipcRenderer.invoke('hotkey:available', hotkey),

  reviewClips: (sessionId: string): Promise<Clip[]> => ipcRenderer.invoke('review:clips', sessionId),
  reviewDone: (requests: UploadRequest[]): Promise<void> => ipcRenderer.invoke('review:done', requests),

  checkUpdate: (): Promise<{ status: string; version?: string }> => ipcRenderer.invoke('app:checkUpdate'),
  openLogs: (): Promise<string> => ipcRenderer.invoke('app:openLogs'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  /** Otevře Kine: v režimu "Kine + klipy" jako záložku hlavního okna, jinak v prohlížeči. */
  openKine: (path?: string): Promise<void> => ipcRenderer.invoke('app:openKine', path ?? ''),
  /** Web Kine v okně: kde má ležet (obdélník obsahu), schovat, obnovit. */
  kineViewShow: (bounds: { x: number; y: number; width: number; height: number }): Promise<void> => ipcRenderer.invoke('kineView:show', bounds),
  kineViewHide: (): Promise<void> => ipcRenderer.invoke('kineView:hide'),
  kineViewReload: (): Promise<void> => ipcRenderer.invoke('kineView:reload'),
  onKineViewFailed: (cb: (description: string) => void) => on<string>('kineView:failed', cb),
  onKineViewRetry: (cb: () => void) => on<null>('kineView:retry', cb),
  /** Barva Kine (5x klik na logo); null = výchozí. Uloží se i na účet, když je hráč přihlášený. */
  setBrandColor: (color: string | null): Promise<void> => ipcRenderer.invoke('brand:set', color),
  /** Zápis do protokolu appky (chyby přehrávače apod.). */
  log: (message: string): Promise<void> => ipcRenderer.invoke('app:log', message),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),

  onToast: (cb: (t: { message: string; kind: string }) => void) => on<{ message: string; kind: string }>('toast:show', cb),
};

const kineCapture = {
  platform: process.platform,
  onCommand: (cb: (c: CaptureCommand) => void) => on<CaptureCommand>('capture:command', cb),
  chunk: (generation: number, data: ArrayBuffer) => ipcRenderer.send('capture:chunk', generation, data),
  event: (event: CaptureEvent) => ipcRenderer.send('capture:event', event),
  sources: (): Promise<{ id: string; name: string; display_id: string }[]> => ipcRenderer.invoke('capture:sources'),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
};

contextBridge.exposeInMainWorld('kine', kine);
contextBridge.exposeInMainWorld('kineCapture', kineCapture);

export type KineBridge = typeof kine;
export type KineCaptureBridge = typeof kineCapture;
