import { join } from 'node:path';
import { BrowserWindow, Notification, screen } from 'electron';
import { log } from './log';

/**
 * Okénko "Klip uložen" v rohu obrazovky.
 *
 * Průhledné okno bez rámu nad všemi ostatními, neklikatelné (myš jde
 * skrz), na 2,5 s. Ve hře v režimu celé obrazovky (exclusive fullscreen)
 * se nad hru nedostane - proto se souběžně pošle i systémové oznámení,
 * které Windows ukáže, jakmile hráč vyskočí ze hry. Hry v okně bez rámu
 * (většina dnešních) okénko ukážou.
 */
export class Toast {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: { preload: string; rendererDir: string; enabled: () => boolean; displayId: () => string }) {}

  private ensure(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready;
    const win = new BrowserWindow({
      width: 360,
      height: 72,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: { preload: this.deps.preload, contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    this.window = win;
    this.ready = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve());
      void win.loadFile(join(this.deps.rendererDir, 'toast.html'));
    });
    return this.ready;
  }

  private place(): void {
    if (!this.window) return;
    const wanted = this.deps.displayId();
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === wanted) ?? screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const [w, h] = this.window.getSize();
    this.window.setPosition(Math.round(x + width - w - 16), Math.round(y + height - h - 16));
  }

  /**
   * Ukáže zprávu. `kind` řídí barvu proužku: ok = barva Kine, warn = žlutá,
   * error = červená. Systémové oznámení jde jen u zpráv, kde na tom záleží.
   */
  async show(
    message: string,
    kind: 'ok' | 'warn' | 'error' = 'ok',
    options: { notification?: boolean; title?: string; onClick?: () => void } = {}
  ): Promise<void> {
    log(`toast: ${message}`);
    if (options.notification && Notification.isSupported()) {
      try {
        const n = new Notification({ title: options.title ?? 'Kine', body: message, silent: true });
        // Klik na oznámení (třeba "Nahráno na Kine") otevře klip.
        if (options.onClick) n.on('click', options.onClick);
        n.show();
      } catch (e) {
        log(`oznámení: ${(e as Error).message}`);
      }
    }
    if (!this.deps.enabled()) return;
    try {
      await this.ensure();
      if (!this.window || this.window.isDestroyed()) return;
      this.place();
      this.window.webContents.send('toast:show', { message, kind });
      this.window.showInactive();
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        this.window?.hide();
      }, 2600);
    } catch (e) {
      log(`toast se nepovedl: ${(e as Error).message}`);
    }
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
  }
}
