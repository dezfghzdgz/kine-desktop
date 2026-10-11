import { join } from 'node:path';
import { BrowserWindow, Notification, screen } from 'electron';
import { log } from './log';

/**
 * Okénko "Klip uložen" v rohu obrazovky.
 *
 * Průhledné okno bez rámu nad všemi ostatními, neklikatelné (myš jde
 * skrz), na 2,5 s. Ve hře v režimu celé obrazovky (exclusive fullscreen)
 * se nad hru nedostane - proto zvuk (slyšet je vždycky) a u důležitých
 * zpráv i systémové oznámení. Hry v okně bez rámu (většina dnešních)
 * okénko ukážou.
 *
 * Klip: okénko vyskočí HNED při stisku ("Ukládám klip…", se zvukem) a až
 * je soubor hotový, jen se přepíše na "Klip uložen" (pending -> done).
 * Okno se připraví dopředu, když začne snímání (warm) - první klip tak
 * nečeká na jeho vytvoření - a po konci snímání se zase zavře (releaseSoon).
 */
export type ToastKind = 'ok' | 'warn' | 'error' | 'pending';

export type ToastOptions = {
  /** I systémové oznámení (Windows ho ukáže i po hře). */
  notification?: boolean;
  title?: string;
  onClick?: () => void;
  /** Krátký zvuk (klip, snímek, chyba). Zbytek zpráv je tichý. */
  sound?: boolean;
};

export type ToastHandle = {
  /** Přepíše čekající okénko výsledkem (bez dalšího zvuku, pokud nejde o chybu). */
  done: (message: string, kind?: Exclude<ToastKind, 'pending'>, options?: ToastOptions) => void;
};

const SHOW_MS = 2600;
/** Jak dlouho smí "Ukládám…" viset, kdyby výsledek nepřišel. */
const PENDING_MS = 60000;

export class Toast {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Číslo poslední zprávy - "done" starší čekající zprávy nepřepíše novější. */
  private seq = 0;

  constructor(
    private deps: {
      preload: string;
      rendererDir: string;
      /** Okénko zapnuté v nastavení. */
      enabled: () => boolean;
      /** Zvuk zapnutý v nastavení. */
      sound: () => boolean;
      displayId: () => string;
    }
  ) {}

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
      webPreferences: { preload: this.deps.preload, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    this.window = win;
    this.ready = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve());
      void win.loadFile(join(this.deps.rendererDir, 'toast.html'));
    });
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.ready = null;
      }
    });
    return this.ready;
  }

  /** Připraví okno dopředu (začalo snímání) - první okénko pak vyskočí bez prodlevy. */
  warm(): void {
    this.keepWarm = true;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    if (!this.deps.enabled() && !this.deps.sound()) return;
    void this.ensure().catch(() => undefined);
  }

  /** Snímání skončilo - okno (paměť navíc) se po chvíli bez zpráv zavře. */
  releaseSoon(ms = 60000): void {
    this.keepWarm = false;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.keepWarm) return;
      // Právě něco ukazuje - zkusit to po dalším čekání.
      if (this.hideTimer) this.releaseSoon(ms);
      else this.destroy();
    }, ms);
    this.releaseTimer.unref?.();
  }

  /** Okno drží připravené snímání (warm); jinak se po zprávě zase zavře. */
  private keepWarm = false;

  private place(): void {
    if (!this.window) return;
    const wanted = this.deps.displayId();
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === wanted) ?? screen.getPrimaryDisplay();
    const { x, y, width, height } = display.workArea;
    const [w, h] = this.window.getSize();
    this.window.setPosition(Math.round(x + width - w - 16), Math.round(y + height - h - 16));
  }

  private notify(message: string, options: ToastOptions): void {
    if (!options.notification || !Notification.isSupported()) return;
    try {
      const n = new Notification({ title: options.title ?? 'Kine', body: message, silent: true });
      // Klik na oznámení (třeba "Nahráno na Kine") otevře klip.
      if (options.onClick) n.on('click', options.onClick);
      n.show();
    } catch (e) {
      log(`oznámení: ${(e as Error).message}`);
    }
  }

  private async display(seq: number, message: string, kind: ToastKind, sound: boolean): Promise<void> {
    const show = this.deps.enabled();
    const playSound = sound && this.deps.sound();
    if (!show && !playSound) return;
    try {
      await this.ensure();
      if (!this.window || this.window.isDestroyed() || seq !== this.seq) return;
      // Bez okénka (vypnuté v nastavení) jen zvuk - okno zůstane schované.
      this.window.webContents.send('toast:show', { message, kind, sound: playSound, show });
      // Mimo snímání okno nedrží paměť - po zprávě se zase zavře.
      if (!this.keepWarm) this.releaseSoon(30000);
      if (!show) return;
      this.place();
      this.window.showInactive();
      if (this.hideTimer) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(
        () => {
          this.hideTimer = null;
          this.window?.hide();
        },
        kind === 'pending' ? PENDING_MS : SHOW_MS
      );
    } catch (e) {
      log(`toast se nepovedl: ${(e as Error).message}`);
    }
  }

  /**
   * Ukáže zprávu. `kind` řídí barvu proužku: ok = barva Kine, warn = žlutá,
   * error = červená. Systémové oznámení jde jen u zpráv, kde na tom záleží.
   */
  async show(message: string, kind: Exclude<ToastKind, 'pending'> = 'ok', options: ToastOptions = {}): Promise<void> {
    log(`toast: ${message}`);
    this.notify(message, options);
    const seq = ++this.seq;
    await this.display(seq, message, kind, options.sound ?? kind === 'error');
  }

  /**
   * Okénko hned teď ("Ukládám klip…", se zvukem) a výsledek později přes
   * `done` do téhož okénka. Když mezitím přijde jiná zpráva, `done` starší
   * zprávy už okénko nepřepisuje (jen systémové oznámení, je-li chtěné).
   */
  pending(message: string): ToastHandle {
    log(`toast: ${message}`);
    const seq = ++this.seq;
    void this.display(seq, message, 'pending', true);
    return {
      done: (text, kind = 'ok', options = {}) => {
        log(`toast: ${text}`);
        this.notify(text, options);
        if (seq !== this.seq) {
          // Novější zpráva mezitím - ukázat výsledek jako novou (chyba se nesmí ztratit).
          if (kind !== 'ok') void this.show(text, kind, { ...options, notification: false });
          return;
        }
        void this.display(seq, text, kind, options.sound ?? kind === 'error');
      },
    };
  }

  destroy(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
  }
}
