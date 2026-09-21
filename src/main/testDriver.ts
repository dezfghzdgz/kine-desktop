import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { log } from './log';

/**
 * Samočinná zkouška celé appky bez člověka (KINE_TEST=1).
 *
 * Rozjede zásobník, počká, udělá klip, ukáže okýnko po hře a nastavení,
 * vyfotí okna a skončí. Výsledek vypíše na stdout jako řádek
 * "KINE_TEST_RESULT {...}", ať se dá zkontrolovat skriptem. Slouží
 * k ověření na Linuxu bez obrazovky (Xvfb); na Windows se stejná cesta
 * spouští zkratkou.
 */
export async function runTestDriver(kine: {
  capture: { start: () => Promise<void>; state: string; error: string | null; bufferedSeconds: () => number };
  onClipHotkey: () => Promise<any>;
  openSettings: (tab?: string) => void;
  openReview: (sessionId: string) => void;
  settings: { update: (p: any) => any; get: () => any };
  toast: { show: (m: string, k?: any, o?: any) => Promise<void> };
  library: { list: () => any[] };
  settingsWindow: BrowserWindow | null;
  reviewWindow: BrowserWindow | null;
}): Promise<void> {
  const outDir = process.env.KINE_TEST_OUT ?? join(app.getPath('temp'), 'kine-test');
  mkdirSync(outDir, { recursive: true });
  const result: Record<string, unknown> = { ok: false };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win: BrowserWindow | null, name: string) => {
    if (!win || win.isDestroyed()) return;
    await sleep(700);
    const image = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), image.toPNG());
  };

  try {
    if (process.env.KINE_TEST_LINK) {
      // Zkouška lokálního serveru pro připojení přes prohlížeč: appka
      // poslouchá, skript zvenku pošle OPTIONS + POST, appka po 15 s skončí.
      (kine as any).auth.loginViaBrowser().catch((e: Error) => log(`[test] loginViaBrowser: ${e.message}`));
      await sleep(15000);
      result.ok = true;
      process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
      setTimeout(() => app.exit(0), 300);
      return;
    }
    const clipSeconds = Number(process.env.KINE_TEST_CLIP_SECONDS ?? 6);
    const waitMs = Number(process.env.KINE_TEST_WAIT_MS ?? 9000);
    kine.settings.update({ detection: 'always', clipSeconds, onboarded: true, toast: true, afterGame: 'review', appMode: 'full', appModeChosen: true });

    await sleep(500);
    await kine.capture.start();
    result.captureState = kine.capture.state;
    log(`[test] zásobník běží, čekám ${waitMs} ms`);
    await sleep(waitMs);
    result.bufferedSeconds = kine.capture.bufferedSeconds();

    await kine.toast.show('Test toastu', 'ok');
    const clip1 = await kine.onClipHotkey();
    result.clip1 = clip1;
    await sleep(3500);
    const clip2 = await kine.onClipHotkey();
    result.clip2 = clip2;
    result.captureStateAfter = kine.capture.state;
    result.libraryCount = kine.library.list().length;

    if (clip1) {
      kine.openReview(clip1.sessionId);
      await sleep(1500);
      await shot(kine.reviewWindow, 'review');
    }
    for (const tab of ['clips', 'settings', 'games', 'upload', 'account', 'about']) {
      kine.openSettings(tab);
      await sleep(900);
      await shot(kine.settingsWindow, `settings-${tab}`);
    }

    // Přehrávač přímo v okně: klik na náhled prvního klipu roztáhne kartu
    // a <video> se musí načíst (žádné nové okno).
    kine.openSettings('clips');
    await sleep(700);
    const win = kine.settingsWindow;
    if (win && !win.isDestroyed()) {
      await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); if (t) t.click(); return !!t; })()`);
      let videoOk = false;
      for (let i = 0; i < 20 && !videoOk; i++) {
        await sleep(300);
        videoOk = await win.webContents.executeJavaScript(
          `(() => { const v = document.querySelector('.clip.playing video'); return !!v && v.readyState >= 1 && v.videoWidth > 0; })()`
        );
      }
      result.inlinePlayer = videoOk;
      await shot(win, 'settings-clips-player');
      // Filtr podle hry a hledání nerozbijí stránku.
      const filterOk = await win.webContents.executeJavaScript(
        `(() => { const s = document.querySelector('.filters select'); if (!s) return false; s.value = 'none'; s.dispatchEvent(new Event('change')); return document.querySelectorAll('.clips .clip').length > 0; })()`
      );
      result.filters = filterOk;
    }
    // Záložka Kine (web vložený do okna): stránka nahlásí plochu, hlavní
    // proces položí WebContentsView; po přepnutí na klipy se schová.
    kine.openSettings('kine');
    await sleep(1500);
    await shot(kine.settingsWindow, 'settings-kine');
    result.kineViewShown = (kine as any).kineViewShown === true && !!(kine as any).kineView;
    kine.openSettings('clips');
    await sleep(600);
    result.kineViewHidden = (kine as any).kineViewShown === false;

    // Barva Kine: 5x klik na logo otevře výběr, barva ze vzorníku se propíše do CSS.
    const colorWin = kine.settingsWindow;
    if (colorWin && !colorWin.isDestroyed()) {
      await colorWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.brand'); for (let i = 0; i < 5; i++) b.click(); return true; })()`);
      await sleep(300);
      result.colorPicker = await colorWin.webContents.executeJavaScript(`!!document.querySelector('.color-picker')`);
      await shot(colorWin, 'settings-color');
      await colorWin.webContents.executeJavaScript(`(() => { const s = document.querySelectorAll('.color-picker .swatch')[4]; if (s) s.click(); return true; })()`);
      await sleep(400);
      result.brandColor = kine.settings.get().brandColor;
    }

    // Průvodce: výběr jazyka a režimu.
    kine.openSettings('wizard');
    await sleep(800);
    await shot(kine.settingsWindow, 'wizard-language');
    const wiz = kine.settingsWindow;
    if (wiz && !wiz.isDestroyed()) {
      await wiz.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.wizard button.primary')].pop(); if (b) b.click(); })()`);
      await sleep(500);
      await shot(wiz, 'wizard-mode');
    }
    result.ok = !!clip1 && !!clip2 && kine.capture.state === 'on' && result.inlinePlayer === true && result.filters === true && result.kineViewShown === true && result.kineViewHidden === true && result.colorPicker === true && result.brandColor === '#a34ff7';
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  }
  process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
}
