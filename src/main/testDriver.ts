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
    // Režim appky určuje varianta (Kine do PC / Kine Clipper), tady se nenastavuje.
    const clipperApp = (kine as any).variant === 'clipper';
    result.variant = clipperApp ? 'clipper' : 'full';
    kine.settings.update({ detection: 'always', clipSeconds, onboarded: true, toast: true, afterGame: 'review' });

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

    // Přehrávač jako vrstva přes okno: klik na náhled prvního klipu otevře
    // .overlay s <video> (mřížka pod ním zůstává - žádná karta se neroztahuje).
    kine.openSettings('clips');
    await sleep(700);
    const win = kine.settingsWindow;
    if (win && !win.isDestroyed()) {
      const gridBefore = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.clips .clip')].map((c) => c.getBoundingClientRect().top + ':' + c.getBoundingClientRect().left).join('|')`);
      await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); if (t) t.click(); return !!t; })()`);
      let videoOk = false;
      for (let i = 0; i < 20 && !videoOk; i++) {
        await sleep(300);
        videoOk = await win.webContents.executeJavaScript(
          `(() => { const v = document.querySelector('.overlay .player-box video'); return !!v && v.readyState >= 1 && v.videoWidth > 0; })()`
        );
      }
      result.inlinePlayer = videoOk;
      const gridAfter = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.clips .clip')].map((c) => c.getBoundingClientRect().top + ':' + c.getBoundingClientRect().left).join('|')`);
      result.gridUntouched = gridBefore === gridAfter && !(await win.webContents.executeJavaScript(`!!document.querySelector('.clip.playing')`));
      await shot(win, 'settings-clips-player');

      // Úpravy: tlačítko Upravit rozbalí osu, I/O nastaví začátek a konec
      // podle přehrávání, "Uložit jako nový klip" vyrobí další klip.
      const countBefore = kine.library.list().length;
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head button')].find((x) => !x.disabled && x.textContent && !x.classList.contains('player-close')); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      result.trimPanel = await win.webContents.executeJavaScript(`!!document.querySelector('.player-box.editing .trim:not(.hidden) .tl-handle.start')`);
      await win.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('.overlay video'); v.pause(); v.currentTime = 1; return true; })()`
      );
      await sleep(400);
      await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))`);
      await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.overlay video'); v.currentTime = Math.min(v.duration - 0.1, 3); return true; })()`);
      await sleep(400);
      await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }))`);
      await sleep(200);
      result.trimValues = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.trim-vals b')].map((b) => b.textContent).join(' ')`);
      await shot(win, 'settings-clips-trim');
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.trim-actions button')][0]; if (b && !b.disabled) b.click(); return !!b && !b.disabled; })()`);
      let trimmed = false;
      for (let i = 0; i < 60 && !trimmed; i++) {
        await sleep(500);
        trimmed = kine.library.list().length === countBefore + 1;
      }
      const trimmedClip = kine.library.list().find((c) => /\(edited\)/.test(c.title));
      result.trimNewClip = trimmed && !!trimmedClip && trimmedClip.durationSeconds > 1 && trimmedClip.durationSeconds < 3.5;
      result.trimDuration = trimmedClip?.durationSeconds;
      await sleep(600);
      await shot(win, 'settings-clips-trimmed');
      // Escape zavře vrstvu.
      await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      result.overlayClosed = !(await win.webContents.executeJavaScript(`!!document.querySelector('.overlay')`));

      // Přepsání původního klipu (bez zvuku): stejný soubor, kratší, nový náhled.
      if (clip2) {
        // Kopie - knihovna vrací živé objekty a update je mění na místě.
        const found = kine.library.list().find((c) => c.id === clip2.id);
        const before = found ? { ...found } : null;
        const replaced = await (kine as any).trimClip(clip2.id, { start: 0.5, end: 2.5, mute: true, mode: 'replace' });
        result.trimReplace =
          !!before && replaced.file === before.file && replaced.durationSeconds > 1.5 && replaced.durationSeconds < 2.6 && !!replaced.thumb && replaced.thumb !== before.thumb && replaced.upload === null;
        result.trimReplaceDuration = replaced.durationSeconds;
      }

      // Filtr podle hry a hledání nerozbijí stránku.
      const filterOk = await win.webContents.executeJavaScript(
        `(() => { const s = document.querySelector('.filters select'); if (!s) return false; s.value = 'none'; s.dispatchEvent(new Event('change')); return document.querySelectorAll('.clips .clip').length > 0; })()`
      );
      result.filters = filterOk;
    }
    if (!clipperApp) {
      // Záložka Kine (web vložený do okna): stránka nahlásí plochu, hlavní
      // proces položí WebContentsView; po přepnutí na klipy se schová.
      kine.openSettings('kine');
      await sleep(1500);
      await shot(kine.settingsWindow, 'settings-kine');
      result.kineViewShown = (kine as any).kineViewShown === true && !!(kine as any).kineView;
      // Záložka Kine je bez postranního panelu, jen s lištou dole (stav + Klipy + Nastavení).
      const kineWin = kine.settingsWindow;
      if (kineWin && !kineWin.isDestroyed()) {
        result.kineBar = await kineWin.webContents.executeJavaScript(
          `(() => { const bar = document.querySelector('.kine-bar'); return !!bar && !document.querySelector('.side') && bar.querySelectorAll('button').length === 2 && document.querySelector('.kine-host').getBoundingClientRect().left === 0; })()`
        );
        // Tlačítko Klipy v liště vede zpátky na klipy (a panel se vrátí).
        await kineWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.kine-bar button'); if (b) b.click(); return !!b; })()`);
        await sleep(500);
        result.kineBarBack = await kineWin.webContents.executeJavaScript(`!!document.querySelector('.side') && !!document.querySelector('.clips')`);
      }
      kine.openSettings('clips');
      await sleep(600);
      result.kineViewHidden = (kine as any).kineViewShown === false;
    } else {
      // Kine Clipper: žádná záložka Kine, štítek "Clipper" u loga, v nastavení
      // panel "Tahle appka" s ikonou klipovače a odkazem na Kine do PC.
      kine.openSettings('clips');
      await sleep(700);
      const w = kine.settingsWindow;
      if (w && !w.isDestroyed()) {
        result.clipperSide = await w.webContents.executeJavaScript(
          `(() => { const tabs = [...document.querySelectorAll('.side .tab')].map((b) => b.textContent.trim()); return !tabs.some((x) => x === 'Kine') && !!document.querySelector('.brand-tag') && !!document.querySelector('.brand .mark.clipper'); })()`
        );
        kine.openSettings('settings');
        await sleep(700);
        result.clipperPanel = await w.webContents.executeJavaScript(`!!document.querySelector('.app-icon.clipper') && !document.querySelector('.kine-host')`);
        await shot(w, 'settings-settings-clipper');
      }
      result.kineViewNever = !(kine as any).kineView && kine.settings.get().appMode === 'clipper';
    }

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
    const common = ['inlinePlayer', 'gridUntouched', 'trimPanel', 'trimNewClip', 'trimReplace', 'overlayClosed', 'filters', 'colorPicker'];
    const checks = clipperApp ? [...common, 'clipperSide', 'clipperPanel', 'kineViewNever'] : [...common, 'kineViewShown', 'kineBar', 'kineBarBack', 'kineViewHidden'];
    result.failed = checks.filter((k) => result[k] !== true);
    result.ok = !!clip1 && !!clip2 && kine.capture.state === 'on' && (result.failed as string[]).length === 0 && result.brandColor === '#a34ff7';
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  }
  process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
}
