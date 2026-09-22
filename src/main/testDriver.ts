import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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
      // Zaškrtávátka v okýnku po hře jsou vidět pořád (v knihovně jen při najetí / výběru).
      const rw = kine.reviewWindow;
      if (rw && !rw.isDestroyed()) {
        result.reviewPicks = await rw.webContents.executeJavaScript(
          `(() => { const picks = [...document.querySelectorAll('.clip .thumb .pick')]; return picks.length > 0 && picks.every((p) => getComputedStyle(p).opacity === '1'); })()`
        );
      }
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
      // Formát na výšku: přepínač ukáže stínování mimo výřez 9:16 a zakáže "Nahradit původní".
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.trim button.seg')].find((x) => /9:16/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      await sleep(300);
      result.verticalUi = await win.webContents.executeJavaScript(
        `(() => { const shades = [...document.querySelectorAll('.crop-shade:not(.hidden)')]; const replace = [...document.querySelectorAll('.trim-actions button')][1]; return shades.length === 2 && shades.every((s) => s.getBoundingClientRect().width > 50) && !!replace && replace.disabled; })()`
      );
      await shot(win, 'settings-clips-vertical');
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.trim button.seg')][0]; if (b) b.click(); return true; })()`);
      await sleep(200);
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

      // Výřez na výšku 9:16: nový klip, šířka = výška · 9/16 (u 1280×800 tedy 450×800).
      if (clip1) {
        const vertical = await (kine as any).trimClip(clip1.id, { start: 0, end: 2, mute: false, mode: 'new', vertical: 'center' });
        result.verticalSize = `${vertical.width}x${vertical.height}`;
        result.vertical = !!vertical.width && !!vertical.height && Math.abs(vertical.width - Math.round((vertical.height * 9) / 16)) <= 2 && /vertical/.test(vertical.title);
      }

      // Automatické klipy: falešné zprávy CS2 (Game State Integration) na lokální
      // port → série dvou zabití → po uklidnění jeden klip "Double kill".
      const ge = (kine as any).gameEvents;
      const port: number = ge?.port ?? 0;
      if (port) {
        const token = kine.settings.get().gsiToken;
        const post = (roundKills: number, matchKills: number) =>
          new Promise<void>((resolve) => {
            const body = JSON.stringify({ auth: { token }, provider: { steamid: '1' }, map: { name: 'de_test' }, player: { steamid: '1', state: { round_kills: roundKills }, match_stats: { kills: matchKills } } });
            const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
              res.resume();
              res.on('end', () => resolve());
            });
            req.on('error', () => resolve());
            req.end(body);
          });
        // Knihovna přežívá mezi běhy zkoušky - hledá se jen klip, který teď přibyl.
        const knownIds = new Set(kine.library.list().map((c) => c.id));
        await post(0, 0);
        await post(1, 1);
        await post(2, 2);
        result.autoClipsLive = ge.live();
        let auto: any = null;
        for (let i = 0; i < 30 && !auto; i++) {
          await sleep(500);
          auto = kine.library.list().find((c) => !knownIds.has(c.id) && /Double kill/.test(c.title));
        }
        result.autoClip = !!auto;
      }

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

      // Postranní panel: položky s ikonami, hlavička "Nastavení", karta stavu
      // s tlačítky Uložit klip (aktivní, zásobník běží) a Pozastavit, účet.
      result.sidebar = await win.webContents.executeJavaScript(
        `(() => { const tabs = [...document.querySelectorAll('.side .tab')]; return tabs.length === ${clipperApp ? 6 : 7} && tabs.every((b) => b.querySelector('svg.tab-icon') && b.querySelector('.tab-label').textContent.trim()) && !!document.querySelector('.side .side-section') && !!document.querySelector('.side-status .side-clip:not(:disabled)') && !!document.querySelector('.side-status .side-pause') && !!document.querySelector('.side-status .side-account') && document.querySelector('.side .tab.active [data-tab], .side .tab.active') !== null; })()`
      );
      await shot(win, 'settings-sidebar');

      // Oblíbené: hvězdička na kartě, filtr "Oblíbené" ukáže jen ty.
      if (clip1) {
        await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.clip[data-id="${clip1.id}"] .star'); if (s) s.click(); return !!s; })()`);
        let fav = false;
        for (let i = 0; i < 10 && !fav; i++) {
          await sleep(200);
          fav = kine.library.list().find((c) => c.id === clip1.id)?.favorite === true;
        }
        await sleep(300);
        const cardFav = await win.webContents.executeJavaScript(`!!document.querySelector('.clip[data-id="${clip1.id}"].favorite .star.on')`);
        await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.fav-filter'); if (b) b.click(); return !!b; })()`);
        await sleep(300);
        const onlyFav = await win.webContents.executeJavaScript(
          `(() => { const cards = [...document.querySelectorAll('.clips .clip')]; return cards.length >= 1 && cards.every((c) => c.classList.contains('favorite')) && document.querySelector('.fav-filter').classList.contains('active'); })()`
        );
        await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.fav-filter'); if (b) b.click(); return !!b; })()`);
        await sleep(300);
        result.favorite = fav && cardFav && onlyFav;
      }

      // Náhled při najetí myší: na kartě se rozjede tiché video, po odjetí zmizí.
      if (clip1) {
        await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip[data-id="${clip1.id}"] .thumb'); t.dispatchEvent(new Event('mouseenter')); return true; })()`);
        let previewing = false;
        for (let i = 0; i < 20 && !previewing; i++) {
          await sleep(250);
          previewing = await win.webContents.executeJavaScript(
            `(() => { const v = document.querySelector('.clip[data-id="${clip1.id}"] .thumb.previewing video.preview'); return !!v && v.readyState >= 2 && !v.paused && v.muted; })()`
          );
        }
        await shot(win, 'settings-clips-preview');
        await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip[data-id="${clip1.id}"] .thumb'); t.dispatchEvent(new Event('mouseleave')); return true; })()`);
        await sleep(200);
        const gone = !(await win.webContents.executeJavaScript(`!!document.querySelector('video.preview')`));
        result.hoverPreview = previewing && gone;
      }

      // Výběr dvou klipů → lišta "2 vybráno" → sestřih do jednoho klipu (délka = součet).
      if (clip1 && clip2) {
        const a = kine.library.list().find((c) => c.id === clip1.id);
        const b = kine.library.list().find((c) => c.id === clip2.id);
        const knownIds = new Set(kine.library.list().map((c) => c.id));
        for (const id of [clip1.id, clip2.id]) {
          await win.webContents.executeJavaScript(`(() => { const p = document.querySelector('.clip[data-id="${id}"] .pick'); if (p) p.click(); return !!p; })()`);
          await sleep(250);
        }
        const barOk = await win.webContents.executeJavaScript(
          `(() => { const bar = document.querySelector('.selection-bar'); return !!bar && /^2\\b/.test(bar.querySelector('.sel-count').textContent) && document.querySelectorAll('.clip.selected').length === 2 && !!bar.querySelector('.sel-merge:not(:disabled)'); })()`
        );
        await shot(win, 'settings-clips-selection');
        await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.selection-bar .sel-merge'); if (m) m.click(); return !!m; })()`);
        let merged: any = null;
        for (let i = 0; i < 120 && !merged; i++) {
          await sleep(500);
          merged = kine.library.list().find((c) => !knownIds.has(c.id) && c.file.endsWith('.mp4') && /montage/i.test(c.title));
        }
        const expected = (a?.durationSeconds ?? 0) + (b?.durationSeconds ?? 0);
        result.mergeDuration = merged ? `${merged.durationSeconds} ~ ${expected.toFixed(2)}` : null;
        result.merge = barOk && !!merged && Math.abs(merged.durationSeconds - expected) < 1.0 && merged.width === 1280 && merged.height === 800 && !!merged.thumb;
        await sleep(400);
        result.mergeNote = await win.webContents.executeJavaScript(`!!document.querySelector('.selection-bar .state.done') && document.querySelectorAll('.clip.selected').length === 0`);
      }

      // GIF: úsek klipu do souboru vedle něj (bez knihovny); v úpravách třetí formát "GIF".
      if (clip1) {
        const gif = await (kine as any).gifFromClip(clip1.id, { start: 0, end: 2 });
        result.gifSize = gif.sizeBytes;
        result.gif = /\.gif$/.test(gif.file) && gif.sizeBytes > 1000 && gif.lengthSeconds === 2;
        // Hlídání úseku: moc krátký úsek se odmítne ještě před ffmpegem.
        let guarded = false;
        try {
          await (kine as any).gifFromClip(clip1.id, { start: 0, end: 0.1 });
        } catch (e) {
          guarded = /too-short/.test((e as Error).message);
        }
        result.gifLimit = guarded;
        await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip[data-id="${clip1.id}"] .thumb'); if (t) t.click(); return !!t; })()`);
        await sleep(600);
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head button')].find((x) => !x.disabled && x.textContent && !x.classList.contains('player-close')); if (b) b.click(); return !!b; })()`);
        await sleep(400);
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.trim button.seg')].find((x) => /GIF/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
        await sleep(300);
        result.gifUi = await win.webContents.executeJavaScript(
          `(() => { const hint = document.querySelector('.gif-hint'); const save = document.querySelectorAll('.trim-actions button')[0]; const replace = document.querySelectorAll('.trim-actions button')[1]; return !!hint && !hint.classList.contains('hidden') && /GIF/.test(save.textContent) && !save.disabled && replace.classList.contains('hidden'); })()`
        );
        await shot(win, 'settings-clips-gif');
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
      }

      // Pozastavit / pokračovat z karty stavu: zásobník se vypne a zase rozjede.
      await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-status .side-pause'); if (b) b.click(); return !!b; })()`);
      let pausedOk = false;
      for (let i = 0; i < 20 && !pausedOk; i++) {
        await sleep(250);
        pausedOk = (kine as any).paused === true && kine.capture.state === 'off';
      }
      await sleep(300);
      const pausedUi = await win.webContents.executeJavaScript(`!!document.querySelector('.side-status .side-clip:disabled') && /▶/.test(document.querySelector('.side-status .side-pause').textContent)`);
      await shot(win, 'settings-sidebar-paused');
      await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-status .side-pause'); if (b) b.click(); return !!b; })()`);
      let resumed = false;
      for (let i = 0; i < 60 && !resumed; i++) {
        await sleep(500);
        resumed = (kine as any).paused === false && kine.capture.state === 'on';
      }
      result.sidePause = pausedOk && pausedUi && resumed;
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
          `(() => { const tabs = [...document.querySelectorAll('.side .tab')].map((b) => b.textContent.trim()); return !tabs.some((x) => x === 'Kine') && !!document.querySelector('.brand-tag') && document.querySelectorAll('.brand .mark svg path').length === 3; })()`
        );
        kine.openSettings('settings');
        await sleep(700);
        result.clipperPanel = await w.webContents.executeJavaScript(`document.querySelectorAll('.app-icon svg path').length === 3 && !document.querySelector('.kine-host')`);
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
      // Ikona okna / u hodin v barvě hráče: střed ikony (trojúhelník) má být fialový (#a34ff7).
      const icon = (kine as any).appIcon();
      const { width } = icon.getSize();
      const bmp: Buffer = icon.toBitmap();
      const i = (Math.floor(width / 2) * width + Math.floor(width / 2)) * 4;
      const px = [bmp[i], bmp[i + 1], bmp[i + 2]];
      result.brandIconPixel = px;
      result.brandIcon = Math.abs(px[1] - 79) <= 3 && Math.abs(Math.max(px[0], px[2]) - 247) <= 3 && Math.abs(Math.min(px[0], px[2]) - 163) <= 3;
      // Značka v panelu je SVG v barvě Kine (žádný tyrkysový obrázek).
      result.brandMarkSvg = await colorWin.webContents.executeJavaScript(`!!document.querySelector('.brand .mark svg') && getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() === '#a34ff7'`);
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
    const common = [
      'inlinePlayer', 'gridUntouched', 'trimPanel', 'trimNewClip', 'trimReplace', 'vertical', 'verticalUi', 'autoClip', 'overlayClosed', 'filters',
      'sidebar', 'favorite', 'hoverPreview', 'merge', 'mergeNote', 'gif', 'gifLimit', 'gifUi', 'sidePause', 'reviewPicks',
      'colorPicker', 'brandIcon', 'brandMarkSvg',
    ];
    const checks = clipperApp ? [...common, 'clipperSide', 'clipperPanel', 'kineViewNever'] : [...common, 'kineViewShown', 'kineBar', 'kineBarBack', 'kineViewHidden'];
    result.failed = checks.filter((k) => result[k] !== true);
    result.ok = !!clip1 && !!clip2 && kine.capture.state === 'on' && (result.failed as string[]).length === 0 && result.brandColor === '#a34ff7';
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  }
  process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
}
