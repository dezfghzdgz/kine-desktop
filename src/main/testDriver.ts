import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { BrowserWindow, app, clipboard, nativeImage } from 'electron';
import { log } from './log';
import { trayIcon } from './icon';
import { probe, runFfmpeg, spawnFfmpeg } from './ffmpeg';
import { simulateUpdateProgress } from './updater';

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
  library: { list: () => any[]; get: (id: string) => any };
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
    // KINE_TEST_FAKE_AUDIO=mix: hlasitost mikrofonu 50 % -> při uložení klipu jde mikrofon přes filtr hlasitosti v ffmpeg.
    if (process.env.KINE_TEST_FAKE_AUDIO === 'mix') kine.settings.update({ micGain: 0.5 });

    await sleep(500);
    await kine.capture.start();
    result.captureState = kine.capture.state;
    log(`[test] zásobník běží, čekám ${waitMs} ms`);
    await sleep(waitMs);
    result.bufferedSeconds = kine.capture.bufferedSeconds();

    // Falešný mikrofon (KINE_TEST_FAKE_AUDIO): hladina mikrofonu ze snímací stránky musí být > 0
    // a klip musí mít zvukovou stopu (míchání přes Web Audio doopravdy něco nahrává).
    if (process.env.KINE_TEST_FAKE_AUDIO) {
      let levels: any = null;
      for (let i = 0; i < 20 && !(levels && levels.mic !== null && levels.mic > 0.01); i++) {
        await sleep(300);
        levels = (kine as any).capture.levels;
      }
      result.fakeAudioLevels = levels;
      result.fakeAudioMeter = !!levels && levels.mic !== null && levels.mic > 0.01 && levels.system === null;
    }
    // KINE_TEST_FAKE_LOOPBACK: zvuk hry "přímo z Windows" přes pomocníka (falešný pomocník: tón 440 Hz
    // ze zařízení 7.1, stejný protokol jako KineLoopback.cs) - hladina, značka v nastavení a zpoždění pro klip.
    if (process.env.KINE_TEST_FAKE_LOOPBACK) {
      let levels: any = null;
      for (let i = 0; i < 40 && !(levels && levels.systemNative && levels.system > 0.01); i++) {
        await sleep(300);
        levels = (kine as any).capture.levels;
      }
      result.nativeLoopbackLevels = levels;
      result.nativeLoopbackStarted = (kine as any).capture.lastStarted;
      result.nativeLoopbackMeter = !!levels && levels.systemNative === true && levels.system > 0.01 && (kine as any).capture.lastStarted?.systemLatencyMs > 0;
    }
    // KINE_TEST_FAKE_AUDIO=full: "zvuk hry" z falešného vstupního zařízení (jako Stereo Mix) + mikrofon ->
    // klip má tři stopy (hra + mikrofon, hra, mikrofon) a v úpravách jde uložit "jen hra".
    let multiClipId: string | null = null;
    if (process.env.KINE_TEST_FAKE_AUDIO === 'full') {
      const capWin = (kine as any).capture.window as BrowserWindow | null;
      const inputs: { id: string; label: string }[] = capWin
        ? await capWin.webContents.executeJavaScript(`navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x) => ({ id: x.deviceId, label: x.label })))`)
        : [];
      result.fakeInputs = inputs.map((x) => x.label);
      if (inputs[0]) {
        kine.settings.update({ systemAudio: true, systemAudioDevice: inputs[0].id });
        let both = false;
        for (let i = 0; i < 40 && !both; i++) {
          await sleep(300);
          const l = (kine as any).capture.levels;
          both = kine.capture.state === 'on' && !!l && l.system !== null && l.mic !== null;
        }
        await sleep(6000);
        const multi = await kine.onClipHotkey();
        multiClipId = multi?.id ?? null;
        const probeText = multi ? await runFfmpeg(['-i', multi.file, '-f', 'null', '-t', '0.1', '-']).catch((e: Error) => e.message) : '';
        // Jen vstupní část výpisu (za "Output #0" ffmpeg vypisuje i výstupní proudy).
        const inputAudio = (text: string) => (String(text).split(/Output #0|Stream mapping/)[0].match(/Stream #0:\d+.*?Audio:/g) || []).length;
        const audioStreams = inputAudio(probeText);
        let gameOnly: any = null;
        if (multi) gameOnly = await (kine as any).trimClip(multi.id, { start: 0, end: 2, mute: false, mode: 'new', audio: 'game' });
        const gameProbe = gameOnly ? await runFfmpeg(['-i', gameOnly.file, '-f', 'null', '-t', '0.1', '-']).catch((e: Error) => e.message) : '';
        result.multiTrack = { both, tracks: multi?.audioTracks, audioStreams, gameOnlyTracks: gameOnly?.audioTracks, gameOnlyStreams: inputAudio(gameProbe) };
        // Na Kine jde kopie jen se smíchanou stopou (Kine hraje jednu); podruhé se vezme hotová, po nahrání zmizí.
        let uploadCopy: any = null;
        if (multi) {
          const first = await (kine as any).uploadFileFor(kine.library.get(multi.id));
          const second = await (kine as any).uploadFileFor(kine.library.get(multi.id));
          const copyProbe = await runFfmpeg(['-i', first.file, '-f', 'null', '-t', '0.1', '-']).catch((e: Error) => e.message);
          const hasVideo = /Stream #0:\d+.*?Video:/.test(String(copyProbe).split(/Output #0|Stream mapping/)[0]);
          (kine as any).releaseUploadFile(multi.id);
          uploadCopy = { fresh1: first.fresh, fresh2: second.fresh, same: first.file === second.file, other: first.file !== multi.file, audio: inputAudio(copyProbe), hasVideo, released: !existsSync(first.file) };
        }
        result.uploadCopy = uploadCopy;
        const uploadCopyOk = !!uploadCopy && uploadCopy.fresh1 && !uploadCopy.fresh2 && uploadCopy.same && uploadCopy.other && uploadCopy.audio === 1 && uploadCopy.hasVideo && uploadCopy.released;
        result.multiTrackOk = both && JSON.stringify(multi?.audioTracks) === '["mix","game","mic"]' && audioStreams === 3 && JSON.stringify(gameOnly?.audioTracks) === '["game"]' && inputAudio(gameProbe) === 1 && uploadCopyOk;
        kine.settings.update({ systemAudioDevice: '', systemAudio: true });
        for (let i = 0; i < 40; i++) {
          await sleep(300);
          if (kine.capture.state === 'on' && (kine as any).capture.levels) break;
        }
        await sleep(waitMs);
      }
    }
    await kine.toast.show('Test toastu', 'ok');
    // Okénko "Ukládám klip…" musí vyskočit HNED při stisku (dřív až s hotovým souborem, i za 10 s).
    const toastAny = kine.toast as any;
    const pendingOrig = toastAny.pending.bind(toastAny);
    let pendingAt = 0;
    let doneAt = 0;
    toastAny.pending = (message: string) => {
      pendingAt = Date.now();
      const handle = pendingOrig(message);
      return {
        done: (...args: any[]) => {
          doneAt = Date.now();
          return handle.done(...args);
        },
      };
    };
    const pressedAt = Date.now();
    const clip1 = await kine.onClipHotkey();
    toastAny.pending = pendingOrig;
    result.clip1 = clip1;
    result.clipToast = { pendingMs: pendingAt ? pendingAt - pressedAt : null, doneMs: doneAt ? doneAt - pressedAt : null };
    result.clipToastInstant = !!clip1 && pendingAt > 0 && pendingAt - pressedAt < 50 && doneAt >= pendingAt;
    if (process.env.KINE_TEST_FAKE_AUDIO && clip1) {
      const info = await probe(clip1.file);
      // Stopa nestačí - musí v ní být slyšet tón (ne ticho z uspaného Web Audio): střední hlasitost nad -50 dB.
      let mean = -100;
      try {
        const out = await runFfmpeg(['-i', clip1.file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], 30000);
        const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(out);
        if (m) mean = Number(m[1]);
      } catch (e) {
        log(`[test] volumedetect: ${(e as Error).message}`);
      }
      result.fakeAudioMeanDb = mean;
      result.fakeAudioClip = info.hasAudio && mean > -50;
    }
    if (process.env.KINE_TEST_FAKE_LOOPBACK && clip1) {
      // V klipu je tón z pomocníka (ne ticho) - a zvuk je posunutý o zpoždění pomocníka (atrim na začátku).
      const info = await probe(clip1.file);
      let mean = -100;
      try {
        const out = await runFfmpeg(['-i', clip1.file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], 30000);
        const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(out);
        if (m) mean = Number(m[1]);
      } catch (e) {
        log(`[test] volumedetect: ${(e as Error).message}`);
      }
      result.nativeLoopbackMeanDb = mean;
      result.nativeLoopbackClip = info.hasAudio && mean > -30;
    }
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
        // Sestřih z celého hraní: tlačítko spojí vybrané (oba klipy) do jednoho, ten zůstane vybraný k nahrání sám.
        const knownIds = new Set(kine.library.list().map((c) => c.id));
        const clicked = await rw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.review-merge'); if (!b || b.disabled) return false; b.click(); return true; })()`);
        let montage: any = null;
        for (let i = 0; i < 120 && clicked && !montage; i++) {
          await sleep(500);
          montage = kine.library.list().find((c) => !knownIds.has(c.id) && /montage/i.test(c.title));
        }
        await sleep(800);
        // Vybraný zůstane jen sestřih; karty drží výšku (3 klipy = 2 řádky, mřížka roluje, nemačká se).
        const onlyMontageSelected = await rw.webContents.executeJavaScript(
          `(() => { const sel = [...document.querySelectorAll('.clip.selected')]; const cards = [...document.querySelectorAll('.clip')]; return sel.length === 1 && !!document.querySelector('.state.done') && cards.length >= 3 && cards.every((c) => c.getBoundingClientRect().height > 250 && c.querySelector('.body .title-edit')); })()`
        );
        result.reviewMerge = clicked && !!montage && montage.sessionId === clip1.sessionId && onlyMontageSelected;
        await shot(rw, 'review-merged');

        // Nastavení nahrání (⚙): pro víc klipů společné (názvy po jednom), pro jeden předvyplněné
        // podle klipu; Nahrát z dialogu předá nastavení hlavnímu procesu a uloží se ke klipu.
        await rw.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.spread button')].find((x) => x.textContent && !x.classList.contains('review-merge') && x.textContent.trim().length > 0); if (b) b.click(); return !!b; })()`);
        await sleep(300);
        const manyOpened = await rw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.review-upload-options'); if (!b || b.disabled) return false; b.click(); return true; })()`);
        await sleep(400);
        const manyDialog = await rw.webContents.executeJavaScript(
          `(() => { const d = document.querySelector('.upload-dialog'); if (!d) return null; const uc = d.querySelector(".upload-clips"); const body = d.querySelector(".upload-body"); return { clips: d.querySelectorAll('.upload-clips:not(.single) .upload-clip').length, vis: d.querySelectorAll('.seg-row button').length, cats: d.querySelector('.upload-body select').options.length, note: !!d.querySelector('.upload-tags .faint'), clipsHeight: uc ? uc.getBoundingClientRect().height : -1, clipsTop: uc ? uc.getBoundingClientRect().top : -1, scrollTop: body ? body.scrollTop : -1, bodyTop: body ? body.getBoundingClientRect().top : -1, thumbH: (d.querySelector('.upload-clip .thumb') || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height }; })()`
        );
        await shot(rw, 'review-upload-many');
        await rw.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
        const closedByEsc = await rw.webContents.executeJavaScript(`!document.querySelector('.upload-dialog')`);
        // Jen sestřih: jeden klip - popis a hashtagy předvyplněné, přepnout na odběratele, přidat hashtag, nahrát.
        // "Zrušit výběr" je druhé tlačítko v hlavičce (každý klik překreslí okno, proto ne po jednom přes zaškrtávátka).
        await rw.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.spread .row > button')][1]; if (b) b.click(); return !!b; })()`);
        await sleep(300);
        await rw.webContents.executeJavaScript(`(() => { const cards = [...document.querySelectorAll('.clip')]; const card = cards.find((c) => /montage/i.test(c.querySelector('.title-edit').value)); const p = card && card.querySelector('.pick'); if (p && !p.checked) p.click(); return !!p; })()`);
        await sleep(300);
        await rw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.review-upload-options'); if (b && !b.disabled) b.click(); return true; })()`);
        await sleep(400);
        const singleDialog = await rw.webContents.executeJavaScript(
          `(() => { const d = document.querySelector('.upload-dialog'); if (!d) return null; const tags = [...d.querySelectorAll('.upload-tags .tag')].map((x) => x.textContent); const desc = d.querySelector('textarea').value; d.querySelector('.seg-row button[data-visibility="subscribers"]').click(); const inp = d.querySelector('.upload-hashtags'); inp.value = inp.value + ' #Test_Tag'; inp.dispatchEvent(new Event('input')); inp.dispatchEvent(new Event('blur')); return { single: !!d.querySelector('.upload-clips.single'), tags, desc, tagsAfter: [...d.querySelectorAll('.upload-tags .tag')].map((x) => x.textContent), submit: !!d.querySelector('.upload-submit') }; })()`
        );
        await shot(rw, 'review-upload-single');
        await rw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.upload-submit'); if (b) b.click(); return !!b; })()`);
        let saved: any = null;
        for (let i = 0; i < 30 && !saved; i++) {
          await sleep(200);
          saved = montage ? kine.library.get(montage.id)?.uploadOptions ?? null : null;
        }
        // Klipů z hraní je normálně 3 (dva + sestřih); s KINE_TEST_FAKE_AUDIO=full přibudou vícestopý a jeho ořez.
        const sessionClips = kine.library.list().filter((c) => c.sessionId === clip1.sessionId && !c.deletedAt).length;
        result.uploadDialogDebug = { manyOpened, manyDialog, closedByEsc, singleDialog, saved, sessionClips };
        result.uploadDialog =
          manyOpened &&
          !!manyDialog && manyDialog.clips === sessionClips && sessionClips >= 3 && manyDialog.vis === 3 && manyDialog.cats === 15 && manyDialog.note && manyDialog.clipsHeight > 100 &&
          closedByEsc &&
          !!singleDialog && singleDialog.single && singleDialog.tags.includes('#klip') && /Kine/.test(singleDialog.desc) && singleDialog.tagsAfter.includes('#test_tag') &&
          !!saved && saved.visibility === 'subscribers' && Array.isArray(saved.hashtags) && saved.hashtags.includes('test_tag') && saved.category === 'catGaming' && saved.hashtags.includes('klip');
      }
    }
    for (const tab of ['clips', 'settings', 'games', 'upload', 'account', 'about']) {
      kine.openSettings(tab === 'settings' ? 'settings:hotkeys' : tab);
      await sleep(900);
      await shot(kine.settingsWindow, `settings-${tab}`);
    }
    // Nastavení po oddílech: sedm ikon nahoře, každá ukáže jen svůj oddíl; vysvětlení až pod otazníčkem.
    kine.openSettings('settings:hotkeys');
    await sleep(700);
    if (kine.settingsWindow && !kine.settingsWindow.isDestroyed()) {
      const sw = kine.settingsWindow;
      const nav = await sw.webContents.executeJavaScript(
        `(() => { const chips = [...document.querySelectorAll('.section-nav .section-chip')]; return { count: chips.length, icons: chips.every((c) => c.querySelector('svg.icon')), active: (document.querySelector('.section-chip.active') || {}).dataset?.section, panels: document.querySelectorAll('.settings-page > .panel').length, hints: document.querySelectorAll('.settings-page .help-text').length, helpBtns: document.querySelectorAll('.settings-page .help-btn').length }; })()`
      );
      await sw.webContents.executeJavaScript(`(() => { const c = document.querySelector('.section-chip[data-section="general"]'); if (c) c.click(); return !!c; })()`);
      await sleep(400);
      const general = await sw.webContents.executeJavaScript(`(() => ({ active: (document.querySelector('.section-chip.active') || {}).dataset?.section, lang: !!document.querySelector('.general-panel select'), hotkeys: document.querySelectorAll('.hotkey').length }))()`);
      await sw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.general-panel .help-btn'); if (b) b.click(); return !!b; })()`);
      await sleep(300);
      const helpOpen = await sw.webContents.executeJavaScript(`document.querySelectorAll('.general-panel .help-text').length === 1 && !!document.querySelector('.general-panel .help-btn.open')`);
      await shot(sw, 'settings-general');
      // Emoji v okně nikde (ikony jsou SVG) - text bez znaků z rozsahu emoji / dingbatů.
      const emoji = await sw.webContents.executeJavaScript(`(() => { const t = document.body.innerText; return (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) || []).join(''); })()`);
      result.settingsSections = { nav, general, helpOpen, emoji };
      result.settingsSectionsOk = nav.count === 7 && nav.icons && nav.active === 'hotkeys' && nav.panels === 1 && nav.hints === 0 && nav.helpBtns >= 3 && general.active === 'general' && general.lang && general.hotkeys === 0 && helpOpen && emoji === '';
    }

    // Nahrání a sdílení: viditelnost má tři volby (i "jen odběratelé"), k tomu hashtagy ke všemu a kategorie.
    kine.openSettings('upload');
    await sleep(700);
    if (kine.settingsWindow && !kine.settingsWindow.isDestroyed()) {
      result.uploadSettings = await kine.settingsWindow.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('.visibility-select'); const c = document.querySelector('.upload-category-setting'); return !!v && v.options.length === 3 && !!c && c.options.length === 15 && !!document.querySelector('.upload-hashtags-setting'); })()`
      );
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
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head .player-edit')].find((x) => !x.disabled); if (b) b.click(); return !!b; })()`);
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
        // Rozmazané pozadí: taky 9:16, stejná výška jako původní (celý obraz zmenšený doprostřed).
        const blur = await (kine as any).trimClip(clip1.id, { start: 0, end: 2, mute: false, mode: 'new', vertical: 'blur' });
        result.verticalBlurSize = `${blur.width}x${blur.height}`;
        result.verticalBlur = !!blur.width && !!blur.height && Math.abs(blur.width - Math.round((blur.height * 9) / 16)) <= 2 && blur.height === vertical.height && blur.durationSeconds > 1.5;
      }

      // Rychlost a text: přehrávač, Upravit, 2×, text ve žlutém pruhu dole -> nový klip poloviční
      // délky a v obraze žlutý pruh (horní okraj pruhu bez písmen musí být žlutý).
      {
        const before = new Set(kine.library.list().map((c) => c.id));
        await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); if (t) t.click(); return !!t; })()`);
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
          await sleep(300);
          ready = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.overlay .player-box video'); return !!v && v.readyState >= 1 && v.videoWidth > 0; })()`);
        }
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head .player-edit')].find((x) => !x.disabled); if (b) b.click(); return !!b; })()`);
        await sleep(400);
        const speedSet: boolean = await win.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('.trim-speed button.seg')].find((x) => x.textContent.trim() === '2×'); if (b) b.click(); return !!b && b.classList.contains('active'); })()`
        );
        const rate: number = await win.webContents.executeJavaScript(`document.querySelector('.overlay video').playbackRate`);
        await win.webContents.executeJavaScript(
          `(() => { const i = document.querySelector('input.trim-text'); i.value = 'E2E TEXT'; i.dispatchEvent(new Event('input', { bubbles: true })); const s = document.querySelector('select.trim-text-style'); s.value = 'yellow'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
        );
        let preview = false;
        for (let i = 0; i < 20 && !preview; i++) {
          await sleep(200);
          preview = await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.text-preview:not(.hidden) canvas'); return !!c && c.getBoundingClientRect().width > 20; })()`);
        }
        const lens: string = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.trim-vals b')][2]?.textContent ?? ''`);
        await shot(win, 'settings-clips-text');
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.trim-actions button')][0]; if (b && !b.disabled) b.click(); return !!b && !b.disabled; })()`);
        let made: any = null;
        for (let i = 0; i < 80 && !made; i++) {
          await sleep(500);
          made = kine.library.list().find((c) => !before.has(c.id));
        }
        const expected = Number(/→\s*([\d.]+)/.exec(lens)?.[1] ?? NaN);
        let pixel: number[] | null = null;
        if (made) {
          const framePath = join(outDir, 'text-frame.png');
          await runFfmpeg(['-loglevel', 'error', '-ss', '0.3', '-i', made.file, '-frames:v', '1', framePath], 30000).catch(() => undefined);
          const img = nativeImage.createFromPath(framePath);
          const { width: W, height: H } = img.getSize();
          if (W > 0 && H > 0) {
            const font = Math.round(H * 0.065);
            const py = Math.round(font * 0.3);
            const boxH = Math.round(font * 1.2) + 2 * py;
            const y = Math.round(H - boxH - H * 0.08 + py / 2);
            const bmp = img.toBitmap();
            const i = (y * W + Math.round(W / 2)) * 4;
            pixel = [bmp[i + 2], bmp[i + 1], bmp[i]];
          }
        }
        result.textSpeed = { speedSet, rate, preview, lens, expected, duration: made?.durationSeconds, pixel };
        result.textSpeedOk =
          speedSet && rate === 2 && preview && !!made && Math.abs(made.durationSeconds - expected) < 0.4 && !!pixel && pixel[0] > 190 && pixel[1] > 150 && pixel[2] < 120;
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
      }

      // Automatické klipy: falešné zprávy CS2 (Game State Integration) na lokální
      // port → série dvou zabití → po uklidnění jeden klip "Double kill".
      const ge = (kine as any).gameEvents;
      const port: number = ge?.port ?? 0;
      if (port) {
        const token = kine.settings.get().gsiToken;
        const postJson = (payload: unknown) =>
          new Promise<void>((resolve) => {
            const body = JSON.stringify(payload);
            const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
              res.resume();
              res.on('end', () => resolve());
            });
            req.on('error', () => resolve());
            req.end(body);
          });
        // CS2 posílá i skóre - do názvu klipu jde mapa a skóre z pohledu hráče ("Test 3:1").
        const post = (roundKills: number, matchKills: number) =>
          postJson({
            auth: { token },
            provider: { steamid: '1', appid: 730 },
            map: { name: 'de_test', team_ct: { score: 3 }, team_t: { score: 1 } },
            player: { steamid: '1', team: 'CT', state: { round_kills: roundKills }, match_stats: { kills: matchKills } },
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
        result.autoClipTitle = auto?.title ?? null;
        result.autoClipContext = !!auto && /Double kill · Test 3:1$/.test(auto.title);

        // Dota 2 na stejném serveru (appid 570): dvě zabití v player.kills → "Double kill · Crystal Maiden".
        const dota = (kills: number) =>
          postJson({
            auth: { token },
            provider: { name: 'Dota 2', appid: 570, steamid: '1' },
            map: { matchid: '77', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
            player: { steamid: '1', kills, deaths: 0 },
            hero: { name: 'npc_dota_hero_crystal_maiden' },
          });
        const known2 = new Set(kine.library.list().map((c) => c.id));
        await dota(0);
        await dota(2);
        let dotaClip: any = null;
        for (let i = 0; i < 30 && !dotaClip; i++) {
          await sleep(500);
          dotaClip = kine.library.list().find((c) => !known2.has(c.id) && /Crystal Maiden/.test(c.title));
        }
        result.dota2Clip = !!dotaClip && /Double kill · Crystal Maiden$/.test(dotaClip.title) && ge.live() === 'dota2';

        // Minecraft: appka sleduje logs/latest.log ve složce ze --gameDir; řádek [CHAT] o smrti hráče = klip "Death".
        const mcDir = join(outDir, 'mc');
        mkdirSync(join(mcDir, 'logs'), { recursive: true });
        const mcLog = join(mcDir, 'logs', 'latest.log');
        writeFileSync(mcLog, '[10:00:00] [main/INFO]: Setting user: Tester\n[10:00:01] [Render thread/INFO]: [System] [CHAT] Tester joined the game\n');
        (kine as any).games.minecraftCmdline = `javaw -Xmx2G --gameDir "${mcDir}" --version 1.21`;
        ge.onGame('javaw.exe', 'Minecraft');
        await sleep(300);
        const mcLive = ge.live() === 'minecraft';
        const known3 = new Set(kine.library.list().map((c) => c.id));
        appendFileSync(mcLog, '[10:00:05] [Render thread/INFO]: [System] [CHAT] Tester was slain by Zombie\n[10:00:06] [Render thread/INFO]: [System] [CHAT] Tester has made the advancement [Stone Age]\n');
        let mcClips: any[] = [];
        for (let i = 0; i < 40 && mcClips.length < 2; i++) {
          await sleep(500);
          mcClips = kine.library.list().filter((c) => !known3.has(c.id));
        }
        ge.onGame(null, null);
        result.minecraftTitles = mcClips.map((c) => c.title);
        result.minecraftClip = mcLive && mcClips.length === 2 && mcClips.some((c) => /Death$/.test(c.title)) && mcClips.some((c) => /Advancement$/.test(c.title)) && ge.live() !== 'minecraft';

        // Rocket League: Stats API po TCP (objekty JSON za sebou bez oddělovače, rozsekané kdekoli,
        // Data jako zakódovaný text). Hráč = koho kamera sleduje; cizí gól nic, můj gól = "Goal · 1:0".
        {
          const rlMsg = (event: string, data: unknown) => JSON.stringify({ Event: event, Data: JSON.stringify(data) });
          const me = { Name: 'Tester', Shortcut: 1, TeamNum: 0 };
          const tick = (blue: number, orange: number) =>
            rlMsg('UpdateState', { Players: [], Game: { bHasTarget: true, Target: me, bReplay: false, Teams: [{ TeamNum: 0, Score: blue }, { TeamNum: 1, Score: orange }] } });
          const stream = [
            rlMsg('MatchCreated', {}),
            ...Array.from({ length: 12 }, () => tick(0, 0)),
            rlMsg('GoalScored', { GoalSpeed: 80, Scorer: { Name: 'Bot', Shortcut: 2, TeamNum: 1 } }),
            tick(0, 1),
            rlMsg('GoalScored', { GoalSpeed: 112.5, Scorer: me }),
            tick(1, 1),
          ].join('\r\n');
          const rlServer = createNetServer((sock) => {
            let at = 0;
            const timer = setInterval(() => {
              if (at >= stream.length) return clearInterval(timer);
              sock.write(stream.slice(at, at + 37));
              at += 37;
            }, 4);
            sock.on('error', () => clearInterval(timer));
            sock.on('close', () => clearInterval(timer));
          });
          await new Promise<void>((resolve) => rlServer.listen(0, '127.0.0.1', () => resolve()));
          const rlTestPort = (rlServer.address() as { port: number }).port;
          (ge as any).rlPort = rlTestPort;
          // Konfigurace hry: falešná instalace z Epicu (manifest launcheru s BOM), soubor
          // v UTF-16 s BOM a vypnutým Stats API. Appka ho při startu hry zapne a kódování nechá.
          const rlDir = join(outDir, 'rl');
          const rlManifests = join(rlDir, 'Manifests');
          const rlIni = join(rlDir, 'TAGame', 'Config', 'DefaultStatsAPI.ini');
          mkdirSync(dirname(rlIni), { recursive: true });
          mkdirSync(rlManifests, { recursive: true });
          const shippedIni = `[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\nPort=${rlTestPort}\r\n`;
          const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
          writeFileSync(rlIni, utf16(shippedIni));
          writeFileSync(join(rlManifests, 'RocketLeague.item'), '﻿' + JSON.stringify({ DisplayName: 'Rocket League®', LaunchExecutable: 'Binaries/Win64/RocketLeague.exe', InstallLocation: rlDir }));
          (ge as any).deps.epicManifestsDir = () => rlManifests;
          (ge as any).rlConfigFiles = [];
          const known4 = new Set(kine.library.list().map((c) => c.id));
          ge.onGame('rocketleague.exe', 'Rocket League');
          let rlClips: any[] = [];
          for (let i = 0; i < 40 && rlClips.length === 0; i++) {
            await sleep(500);
            rlClips = kine.library.list().filter((c) => !known4.has(c.id));
          }
          await sleep(1500);
          rlClips = kine.library.list().filter((c) => !known4.has(c.id));
          const rlLive = ge.live() === 'rocketleague';
          ge.onGame(null, null);
          await new Promise<void>((resolve) => rlServer.close(() => resolve()));
          result.rocketLeagueTitles = rlClips.map((c) => c.title);
          // Jediný klip (cizí gól ne) se skóre z pohledu hráče po gólu.
          result.rocketLeagueClip = rlClips.length === 1 && /Goal · 1:1$/.test(rlClips[0].title) && rlLive && ge.live() !== 'rocketleague';
          // Konfigurace: zapnutá v UTF-16 (BOM zůstal, port hry převzatý); vypnutí klipů ze hry ji vrátí přesně.
          const iniOn = readFileSync(rlIni);
          const iniOnText = iniOn.subarray(2).toString('utf16le');
          const cfgOn = iniOn[0] === 0xff && iniOn[1] === 0xfe && /^PacketSendRate=5\r$/m.test(iniOnText) && iniOnText.includes(`Port=${rlTestPort}`) && (ge as any).rlPort === rlTestPort;
          (ge as any).removeRlConfigs();
          const cfgBack = readFileSync(rlIni).equals(utf16(shippedIni));
          result.rocketLeagueConfig = cfgOn && cfgBack;
          if (!result.rocketLeagueConfig) log(`test: RL konfigurace ${JSON.stringify({ cfgOn, cfgBack, iniOnText })}`);
        }
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
        `(() => { const tabs = [...document.querySelectorAll('.side .tab')]; return tabs.length === ${clipperApp ? 7 : 8} && tabs.every((b) => b.querySelector('svg.tab-icon') && b.querySelector('.tab-label').textContent.trim()) && !!document.querySelector('.side .side-section') && !!document.querySelector('.side-status .side-clip:not(:disabled)') && !!document.querySelector('.side-status .side-pause') && !!document.querySelector('.side-status .side-account') && document.querySelector('.side .tab.active [data-tab], .side .tab.active') !== null; })()`
      );
      await shot(win, 'settings-sidebar');

      // Šipky v přehrávači: další / předchozí klip podle mřížky, "1 / N" v hlavičce, klávesy ↑ ↓.
      {
        const shown = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.clips .clip')].map((c) => c.dataset.id)`);
        await win.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); if (t) t.click(); return !!t; })()`);
        await sleep(600);
        const first = await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.player-nav.next'); const p = document.querySelector('.player-nav.prev'); return { next: !!n && !n.classList.contains('hidden') && !n.disabled, prevDisabled: !!p && p.disabled, pos: document.querySelector('.player-pos')?.textContent, title: document.querySelector('.player-head .title')?.textContent }; })()`);
        await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.player-nav.next'); if (n) n.click(); return !!n; })()`);
        await sleep(600);
        const second = await win.webContents.executeJavaScript(`(() => ({ pos: document.querySelector('.player-pos')?.textContent, title: document.querySelector('.player-head .title')?.textContent, overlay: document.querySelectorAll('.overlay').length }))()`);
        await shot(win, 'settings-clips-next');
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
        await sleep(500);
        const back = await win.webContents.executeJavaScript(`document.querySelector('.player-pos')?.textContent`);
        const secondClip = kine.library.list().find((c) => c.id === shown[1]);
        result.playerNav = first.next && first.prevDisabled && first.pos === `1 / ${shown.length}` && second.pos === `2 / ${shown.length}` && second.overlay === 1 && !!secondClip && second.title === secondClip.title && back === `1 / ${shown.length}`;
        result.playerNavDebug = { first, second, back };
        // Celá obrazovka: jedna ikona vpravo dole v ovládání videa (jako u videí na Kine) - dovnitř
        // i ven. Kliknutí opravdovou myší: video si ho vezme, scénu se šipkami zapne hlavní proces.
        const realClick = async (x: number, y: number, count = 1) => {
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
          await sleep(120);
          for (let c = 1; c <= count; c++) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: c });
            win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: c });
            await sleep(60);
          }
        };
        const videoRect = () =>
          win.webContents.executeJavaScript(`(() => { const r = document.querySelector('.player-stage video').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
        const waitStageFull = async (want: boolean) => {
          let ok = false;
          for (let i = 0; i < 25 && !ok; i++) {
            await sleep(150);
            ok = await win.webContents.executeJavaScript(
              want
                ? `!!document.fullscreenElement && document.fullscreenElement.classList.contains('player-stage') && document.fullscreenElement.classList.contains('fullscreen') && !document.querySelector('video:fullscreen')`
                : `!document.fullscreenElement && !document.querySelector('.player-stage.fullscreen')`
            );
          }
          return ok;
        };
        const headFull = await win.webContents.executeJavaScript(
          `(() => { const s = document.querySelector('.player-stage .stage-fullscreen'); const v = document.querySelector('.player-stage video'); return !document.querySelector('.player-head .player-full') && !!s && getComputedStyle(s).display === 'none' && !!v && v.controls && !(v.getAttribute('controlslist') || '').includes('nofullscreen'); })()`
        );
        let vr = await videoRect();
        await realClick(Math.round(vr.x + vr.w / 2), Math.round(vr.y + vr.h / 3));
        await sleep(300);
        await shot(win, 'settings-clips-player-controls');
        await realClick(Math.round(vr.x + vr.w - 24), Math.round(vr.y + vr.h - 48));
        const fsOn = await waitStageFull(true);
        const fsFirst = await win.webContents.executeJavaScript(
          `(() => { const st = document.querySelector('.player-stage.fullscreen'); const n = st && st.querySelector('.stage-nav.next'); const r = n ? n.getBoundingClientRect() : null; const v = st && st.querySelector('video'); return { next: !!n && !n.disabled && getComputedStyle(n).display !== 'none' && !!r && r.right > window.innerWidth - 120, exit: !!v && v.controls, pos: st ? st.querySelector('.stage-pos')?.textContent : null, title: st ? st.querySelector('.stage-title')?.textContent : null }; })()`
        );
        vr = await videoRect();
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(vr.x + vr.w - 30), y: Math.round(vr.y + vr.h - 44) });
        await sleep(400);
        await shot(win, 'settings-clips-player-fullscreen');
        await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.player-stage.fullscreen .stage-nav.next'); if (n) n.click(); return !!n; })()`, true);
        await sleep(600);
        const fsSecond = await win.webContents.executeJavaScript(
          `({ still: !!document.fullscreenElement, pos: document.querySelector('.player-stage.fullscreen .stage-pos')?.textContent, video: !!document.querySelector('.player-stage.fullscreen video') })`
        );
        // Šipka ← na klávesnici v celé obrazovce = předchozí klip - i když má fokus samotné video.
        await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage.fullscreen video'); if (v) { v.setAttribute('tabindex', '-1'); v.focus(); } (v || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); return true; })()`, true);
        await sleep(600);
        const fsKey = await win.webContents.executeJavaScript(`({ still: !!document.fullscreenElement, pos: document.querySelector('.player-stage.fullscreen .stage-pos')?.textContent })`);
        // Ven tou samou ikonou vpravo dole.
        vr = await videoRect();
        await realClick(Math.round(vr.x + vr.w / 2), Math.round(vr.y + vr.h / 3));
        await sleep(200);
        await realClick(Math.round(vr.x + vr.w - 24), Math.round(vr.y + vr.h - 48));
        const fsOff = await waitStageFull(false);
        // Dvojklik do videa: taky scéna se šipkami (ne holé video), F ji zavře.
        // (Okno se po celé obrazovce chvíli vrací do původní velikosti - až pak měřit.)
        await sleep(900);
        vr = await videoRect();
        await realClick(Math.round(vr.x + vr.w / 2), Math.round(vr.y + vr.h / 3), 2);
        const fsDbl = await waitStageFull(true);
        const dblDebug = { rect: vr, fe: await win.webContents.executeJavaScript(`(() => { const f = document.fullscreenElement; return f ? f.className || f.tagName : null; })()`) };
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))`, true);
        const fsDblOff = await waitStageFull(false);
        const playing = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage video'); return !!v && v.isConnected && v.readyState >= 1; })()`);
        result.playerFullscreen = { headFull, fsOn, fsFirst, fsSecond, fsKey, fsOff, fsDbl, fsDblOff, playing, dblDebug };
        result.playerFullscreenOk =
          headFull && fsOn && fsFirst.next && fsFirst.exit && fsFirst.pos === `1 / ${shown.length}` && fsSecond.still && fsSecond.pos === `2 / ${shown.length}` && fsSecond.video && fsKey.still && fsKey.pos === `1 / ${shown.length}` && fsOff && fsDbl && fsDblOff && playing;
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
      }

      // Zvuk hry / mikrofon a rychlost přehrávání v přehrávači (0.10.7): klip se třemi stopami
      // (smíchaná, hra 440 Hz, mikrofon 1000 Hz) - tlačítka vpravo dole přepnou, co je slyšet
      // (měří se to, co video opravdu hraje), stejně se pak uloží v úpravách; rychlost 1× a menu.
      {
        const tracksFile = join((kine as any).settings.clipsDir(), 'E2E tracks.mp4');
        let tracksOk = false;
        try {
          await runFfmpeg(
            [
              '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8',
              '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
              '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=8:sample_rate=48000',
              '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[mix]',
              '-map', '0:v', '-map', '[mix]', '-map', '1:a', '-map', '2:a',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tracksFile,
            ],
            120000
          );
          (kine as any).library.add({ id: 'e2e-tracks', file: tracksFile, thumb: null, title: 'E2E tracks', game: null, createdAt: new Date().toISOString(), durationSeconds: 8, sizeBytes: statSync(tracksFile).size, width: 640, height: 360, sessionId: 'e2e-tracks', upload: null, audioTracks: ['mix', 'game', 'mic'] });
          tracksOk = true;
        } catch (e) {
          result.playerTracksError = (e as Error).message;
        }
        await sleep(700);
        if (tracksOk) {
          await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.clips .clip[data-id="e2e-tracks"] .thumb'); if (c) { c.scrollIntoView({ block: 'center' }); c.click(); } return !!c; })()`);
          let ready = false;
          for (let i = 0; i < 40 && !ready; i++) {
            await sleep(150);
            ready = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage video'); return !!v && v.readyState >= 2 && !!v.audioTracks && v.audioTracks.length === 3; })()`);
          }
          // Co video hraje: úroveň 440 Hz (hra) a 1000 Hz (mikrofon) v jeho výstupu.
          await win.webContents.executeJavaScript(`(() => {
            const v = document.querySelector('.player-stage video');
            v.muted = false; v.volume = 1;
            if (v.paused) v.play().catch(() => {});
            window.__kineTone = async () => {
              const stream = v.captureStream();
              const at = stream.getAudioTracks();
              if (at.length === 0) return { game: -200, mic: -200, tracks: 0 };
              const ctx = new AudioContext();
              const src = ctx.createMediaStreamSource(new MediaStream([at[0]]));
              const an = ctx.createAnalyser(); an.fftSize = 4096; src.connect(an);
              await new Promise((r) => setTimeout(r, 700));
              const data = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(data);
              const bin = (f) => Math.round(f / (ctx.sampleRate / an.fftSize));
              const lvl = (f) => Math.round(Math.max(...data.slice(bin(f) - 2, bin(f) + 3)));
              const out = { game: lvl(440), mic: lvl(1000), tracks: at.length };
              ctx.close();
              return out;
            };
            return true;
          })()`);
          const state = async () =>
            win.webContents.executeJavaScript(`(async () => {
              const v = document.querySelector('.player-stage video');
              const g = document.querySelector('.player-tools .tool-game'); const m = document.querySelector('.player-tools .tool-mic');
              await new Promise((r) => setTimeout(r, 350));
              return { enabled: [...v.audioTracks].map((t) => t.enabled), gameOn: !!g && !g.classList.contains('off'), micOn: !!m && !m.classList.contains('off'), chips: !!g && !g.classList.contains('hidden') && !!m && !m.classList.contains('hidden'), tone: await window.__kineTone() };
            })()`);
          const click = (sel: string) => win.webContents.executeJavaScript(`(() => { const b = document.querySelector('${sel}'); if (b) b.click(); return !!b; })()`);
          await sleep(500);
          const heard = (x: number) => x > -80;
          const silentAt = (x: number) => x < -100;
          const s0 = await state();
          await click('.player-tools .tool-game');
          const s1 = await state();
          await click('.player-tools .tool-mic');
          const s2 = await state();
          await click('.player-tools .tool-game');
          const s3 = await state();
          // Úpravy převezmou, co je slyšet (uloží se jen hra).
          await click('.player-head .player-edit');
          await sleep(400);
          const editChoice = await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.player-box.editing select.trim-audio'); return s ? s.value : null; })()`);
          await click('.player-head .player-edit');
          await sleep(300);
          result.playerTracks = { s0, s1, s2, s3, editChoice };
          const en = (s: any, want: boolean[]) => JSON.stringify(s.enabled) === JSON.stringify(want);
          result.playerTracksOk =
            ready && s0.chips && s0.gameOn && s0.micOn && en(s0, [true, false, false]) && heard(s0.tone.game) && heard(s0.tone.mic) &&
            !s1.gameOn && s1.micOn && en(s1, [false, false, true]) && silentAt(s1.tone.game) && heard(s1.tone.mic) &&
            !s2.gameOn && !s2.micOn && en(s2, [false, false, false]) && silentAt(s2.tone.game) && silentAt(s2.tone.mic) &&
            s3.gameOn && !s3.micOn && en(s3, [false, true, false]) && heard(s3.tone.game) && silentAt(s3.tone.mic) &&
            editChoice === 'game';

          // Rychlost: výchozí 1×, menu u tlačítka vpravo dole, klávesa > o stupeň rychleji; i přes celou obrazovku.
          const rate = () => win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage video'); const l = document.querySelector('.player-tools .tool-rate-value'); return { rate: v ? v.playbackRate : null, label: l ? l.textContent : null }; })()`);
          const r0 = await rate();
          const vr2 = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('.player-stage video').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(vr2.x + vr2.w / 2), y: Math.round(vr2.y + vr2.h / 2) });
          await click('.player-tools .tool-rate');
          await sleep(300);
          const menu = await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.player-tools .tool-rate-menu'); return !!m && !m.classList.contains('hidden') ? m.querySelectorAll('.tool-rate-item').length : 0; })()`);
          await shot(win, 'settings-clips-player-tools');
          await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-tools .tool-rate-item')].find((x) => x.textContent.startsWith('0.5') || x.textContent.startsWith('0,5')); if (b) b.click(); return !!b; })()`);
          await sleep(300);
          const r1 = await rate();
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '>', bubbles: true, cancelable: true }))`, true);
          await sleep(300);
          const r2 = await rate();
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))`, true);
          await sleep(900);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 });
          await sleep(200);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 320 });
          await sleep(300);
          const full = await win.webContents.executeJavaScript(`(() => { const st = document.querySelector('.player-stage.fullscreen'); const tl = st && st.querySelector('.player-tools'); return { full: !!st, tools: !!tl && getComputedStyle(tl).opacity !== '0', label: tl ? tl.querySelector('.tool-rate-value')?.textContent : null }; })()`);
          await shot(win, 'settings-clips-player-tools-fullscreen');
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))`, true);
          await sleep(900);
          result.playerSpeed = { r0, menu, r1, r2, full };
          result.playerSpeedOk = r0.rate === 1 && r0.label === '1×' && menu === 7 && r1.rate === 0.5 && r2.rate === 0.75 && full.full && full.tools && (full.label === '0.75×' || full.label === '0,75×');
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await sleep(300);
        }
        try {
          (kine as any).library.purge('e2e-tracks');
        } catch {
          // nic
        }
        await sleep(400);
      }

      // Klip s jednou stopou: "bez zvuku" v úpravách ztlumí i náhled (dřív hrál dál) a po zavření
      // úprav hraje zase se zvukem (mimo úpravy "bez zvuku" nic neukazuje).
      {
        const singleFile = join((kine as any).settings.clipsDir(), 'E2E single.mp4');
        let singleOk = false;
        try {
          await runFfmpeg(
            [
              '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8',
              '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
              '-map', '0:v', '-map', '1:a',
              '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', singleFile,
            ],
            120000
          );
          (kine as any).library.add({ id: 'e2e-single', file: singleFile, thumb: null, title: 'E2E single', game: null, createdAt: new Date().toISOString(), durationSeconds: 8, sizeBytes: statSync(singleFile).size, width: 640, height: 360, sessionId: 'e2e-single', upload: null });
          singleOk = true;
        } catch (e) {
          result.playerMuteError = (e as Error).message;
        }
        await sleep(700);
        if (singleOk) {
          await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.clips .clip[data-id="e2e-single"] .thumb'); if (c) { c.scrollIntoView({ block: 'center' }); c.click(); } return !!c; })()`);
          let ready = false;
          for (let i = 0; i < 40 && !ready; i++) {
            await sleep(150);
            ready = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage video'); return !!v && v.readyState >= 2 && decodeURIComponent(v.currentSrc).includes('E2E single') && !!v.audioTracks && v.audioTracks.length === 1; })()`);
          }
          const probe = async () =>
            win.webContents.executeJavaScript(`(async () => {
              const v = document.querySelector('.player-stage video');
              v.volume = 1;
              if (v.paused) v.play().catch(() => {});
              await new Promise((r) => setTimeout(r, 350));
              const g = document.querySelector('.player-tools .tool-game');
              const box = document.querySelector('.trim-mute input');
              const at = v.captureStream().getAudioTracks();
              let level = -200;
              if (at.length > 0) {
                const ctx = new AudioContext();
                const src = ctx.createMediaStreamSource(new MediaStream([at[0]]));
                const an = ctx.createAnalyser(); an.fftSize = 4096; src.connect(an);
                await new Promise((r) => setTimeout(r, 700));
                const data = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(data);
                const bin = Math.round(440 / (ctx.sampleRate / an.fftSize));
                level = Math.round(Math.max(...data.slice(bin - 2, bin + 3)));
                ctx.close();
              }
              return { level: Number.isFinite(level) ? level : -999, enabled: [...v.audioTracks].map((t) => t.enabled), muted: v.muted, chips: !!g && !g.classList.contains('hidden'), box: box ? box.checked : null };
            })()`);
          const click = (sel: string) => win.webContents.executeJavaScript(`(() => { const b = document.querySelector('${sel}'); if (b) b.click(); return !!b; })()`);
          await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.player-stage video'); if (v) v.muted = false; return true; })()`);
          await sleep(400);
          const m0 = await probe();
          await click('.player-head .player-edit');
          await sleep(400);
          await click('.player-box.editing .trim-mute input');
          const m1 = await probe();
          await click('.player-head .player-edit');
          await sleep(300);
          const m2 = await probe();
          result.playerMute = { ready, m0, m1, m2 };
          result.playerMuteOk = ready && !m0.chips && m0.level > -80 && m1.box === true && m1.level < -100 && m2.box === false && m2.level > -80 && !m2.muted;
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
          await sleep(300);
        }
        try {
          (kine as any).library.purge('e2e-single');
        } catch {
          // nic
        }
        await sleep(400);
      }

      // Řazení knihovny: "nejdelší první" dá nahoru nejdelší klip.
      {
        await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.clips-sort'); s.value = 'longest'; s.dispatchEvent(new Event('change')); return true; })()`);
        await sleep(500);
        const firstId = await win.webContents.executeJavaScript(`document.querySelector('.clips .clip')?.dataset.id`);
        const visible = kine.library.list().filter((c) => !c.game);
        const longest = [...visible].sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
        result.clipsSort = !!longest && firstId === longest.id && kine.settings.get().clipsSort === 'longest';
        await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.clips-sort'); s.value = 'newest'; s.dispatchEvent(new Event('change')); return true; })()`);
        await sleep(400);
      }

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
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head .player-edit')].find((x) => !x.disabled); if (b) b.click(); return !!b; })()`);
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
      const pausedUi = await win.webContents.executeJavaScript(`!!document.querySelector('.side-status .side-clip:disabled') && !!document.querySelector('.side-status .side-pause[data-paused="1"] svg.icon')`);
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
      // Web v okně je vidět a nehraje se → není uspaný (zvuk není ztlumený).
      result.kineViewAwake = !!(kine as any).kineView && (kine as any).kineView.webContents.isAudioMuted() === false;
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
      // Schovaný web spí: ztlumený a s omezeným během na pozadí.
      result.kineViewAsleep = !!(kine as any).kineView && (kine as any).kineView.webContents.isAudioMuted() === true;
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
        kine.openSettings('settings:general');
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

    // Výkon appky: tři volby v Záznamu; "Úsporný" vypne náhledy při najetí, uloží se do nastavení.
    kine.openSettings('settings:performance');
    await sleep(700);
    const perfWin = kine.settingsWindow;
    if (perfWin && !perfWin.isDestroyed()) {
      // Technické údaje (jak často se hlídá hra…) až po kliknutí na otazníček.
      const hiddenFirst = await perfWin.webContents.executeJavaScript(`!document.querySelector('.panel.performance .perf-now')`);
      await perfWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.panel.performance .panel-title .help-btn'); if (b) b.click(); return !!b; })()`);
      await sleep(300);
      const panel = hiddenFirst && (await perfWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.panel.performance'); return !!p && p.querySelectorAll('input[type=radio][name=performance]').length === 3 && !!p.querySelector('.perf-now') && !!p.querySelector('.help-text'); })()`));
      await perfWin.webContents.executeJavaScript(`(() => { const r = document.querySelector('.panel.performance input[value=low]'); r.click(); return true; })()`);
      let low = false;
      for (let i = 0; i < 10 && !low; i++) {
        await sleep(200);
        low = kine.settings.get().performance === 'low';
      }
      await perfWin.webContents.executeJavaScript(`(() => { document.querySelector('.panel.performance').scrollIntoView({ block: 'start' }); return true; })()`);
      await shot(perfWin, 'settings-performance');
      kine.openSettings('clips');
      await sleep(600);
      await perfWin.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); t.dispatchEvent(new Event('mouseenter')); return true; })()`);
      await sleep(800);
      const noPreview = !(await perfWin.webContents.executeJavaScript(`!!document.querySelector('video.preview')`));
      kine.settings.update({ performance: 'balanced' });
      await sleep(300);
      result.performance = panel && low && noPreview && kine.settings.get().performance === 'balanced';
    }

    // Nahrávání celého zápasu: tlačítko v postranním panelu spustí nahrávku
    // (tiká v něm čas), druhý klik ji uloží jako dlouhý klip s odznakem REC.
    // Zkratka pro nahrávání je v Záznamu třetí pole zkratky.
    kine.openSettings('clips');
    await sleep(700);
    const recWin = kine.settingsWindow;
    if (recWin && !recWin.isDestroyed()) {
      const started = await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record'); if (!b || b.disabled) return false; b.click(); return true; })()`);
      let running = false;
      for (let i = 0; i < 40 && !running; i++) {
        await sleep(250);
        running = !!(kine as any).capture.recordingInfo();
      }
      await sleep(1200);
      const timer = await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record.recording'); const t = b && b.querySelector('.rec-time'); return !!t && /^0:0[1-9]$/.test(t.textContent.trim()); })()`);
      await shot(recWin, 'settings-recording');
      // Klip během nahrávání = moment v nahrávce (značka, na Kine kapitola).
      const markedAt = Date.now();
      await (kine as any).onClipHotkey();
      await sleep(Math.max(0, 4500 - (Date.now() - markedAt)));
      // Pád uprostřed zápasu (appka nebo Windows): kopie rozjeté složky zásobníku jako po jiném, mrtvém
      // procesu (<název>-99999) - při dalším startu se z ní má slepit nahrávka "obnoveno po pádu".
      const bufDir: string = (kine as any).capture.bufferDir;
      const leftover = `${bufDir}-99999`;
      rmSync(leftover, { recursive: true, force: true });
      cpSync(bufDir, leftover, { recursive: true });
      const beforeStop = new Set(kine.library.list().map((c) => c.id));
      await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record.recording'); if (b) b.click(); return !!b; })()`);
      // Hned po kliku: tlačítko "Ukládám…" (nejde zmáčknout), stav ukládání, žádné "nahrávám". Druhý klik / zkratka
      // během ukládání nesmí uložit nahrávku podruhé (dřív se uložila tolikrát, kolikrát hráč klikl).
      const savingUi = await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record'); return !!b && b.classList.contains('saving') && b.disabled && !document.querySelector('.side-record.recording'); })()`);
      await sleep(150);
      // Stav "ukládám" bez "nahrávám" - nebo už uloženo: krátkou nahrávku rychlý disk uloží i do 150 ms.
      // Napřed stav, pak knihovna (nahrávka je v knihovně dřív, než stav "ukládám" zmizí).
      const savingNow = !!(kine as any).status().recordingSaving;
      const savedAlready = kine.library.list().some((c) => !beforeStop.has(c.id) && c.kind === 'recording');
      const savingStatus = (savingNow || savedAlready) && !(kine as any).capture.recordingInfo();
      // Jen dokud se ukládá (kdyby uložení stihlo doběhnout, další stisk by správně začal novou nahrávku).
      if ((kine as any).status().recordingSaving) await (kine as any).toggleRecording();
      await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record.saving'); if (b) b.click(); return true; })()`);
      let rec: any = null;
      for (let i = 0; i < 120 && !rec; i++) {
        await sleep(500);
        rec = kine.library.list().find((c) => !beforeStop.has(c.id) && c.kind === 'recording');
      }
      await sleep(2500);
      const recordingsAfterStop = kine.library.list().filter((c) => !beforeStop.has(c.id) && c.kind === 'recording').length;
      result.recordingStopOnce = { savingUi, savingStatus, savedAlready, recordingsAfterStop, savingAfter: !!(kine as any).status().recordingSaving };
      result.recordingStopOnceOk = savingUi && savingStatus && recordingsAfterStop === 1 && !(kine as any).status().recordingSaving;
      const badge = await recWin.webContents.executeJavaScript(`!!document.querySelector('.clip .thumb .kind-badge') && !document.querySelector('.side-record.recording')`);
      result.recordingClip = rec ? { durationSeconds: rec.durationSeconds, title: rec.title, file: rec.file } : null;
      // Ikona u hodin s červenou tečkou (pravý dolní roh) - zvětšená do souboru, ať se dá prohlédnout.
      const dotIcon = trayIcon((kine as any).appIcon(), true);
      const { width: dw, height: dh } = dotIcon.getSize();
      const bmp: Buffer = dotIcon.toBitmap();
      const px = (x: number, y: number) => {
        const i = (y * dw + x) * 4;
        return [bmp[i], bmp[i + 1], bmp[i + 2]];
      };
      const corner = px(dw - 3, dh - 3);
      const opposite = px(2, 2);
      writeFileSync(join(outDir, 'tray-recording.png'), dotIcon.resize({ width: 128, height: 128 }).toPNG());
      writeFileSync(join(outDir, 'tray-normal.png'), trayIcon((kine as any).appIcon(), false).resize({ width: 128, height: 128 }).toPNG());
      result.trayDotPixels = { corner, opposite };
      // Červená v BGRA (Linux/Windows): B ~70, G ~70, R ~255; protější roh tečku nemá.
      const red = (p: number[]) => p[2] >= 240 && p[1] <= 90 && p[0] <= 90;
      result.trayDot = red(corner) && !red(opposite);
      result.recording = started && running && timer && !!rec && rec.durationSeconds >= 4 && /recording/i.test(rec.title) && badge && !(kine as any).capture.recordingInfo() && kine.capture.state === 'on';
      // Moment z klipu během nahrávání: v knihovně, na kartě (🚩 1) a v přehrávači jako tlačítko.
      if (rec) {
        const recCard = await recWin.webContents.executeJavaScript(
          `(() => { const c = document.querySelector('.clip[data-id="${rec.id}"]'); const b = c && c.querySelector('.kind-badge'); const m = b && b.querySelector('.kind-moments'); const t = c && c.querySelector('.thumb'); if (t) t.click(); return !!m && !!m.querySelector('svg.icon') && m.textContent.includes('1'); })()`
        );
        let chips = 0;
        for (let i = 0; i < 20 && chips === 0; i++) {
          await sleep(250);
          chips = await recWin.webContents.executeJavaScript(`document.querySelectorAll('.player-markers:not(.hidden) .marker-chip').length`);
        }
        await shot(recWin, 'settings-recording-moments');
        await recWin.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
        const m = rec.markers ?? [];
        result.recordingMarkers = { markers: m, recCard, chips };
        result.recordingMarkersOk = m.length === 1 && m[0].time > 0.5 && m[0].time < rec.durationSeconds && recCard && chips === 1;
      }

      // Obnova po pádu: složka mrtvého procesu se odloží a slepí; nic nezůstane v dočasné složce.
      const { moved, waiting } = (kine as any).capture.salvageLeftovers();
      const recovered: any[] = await (kine as any).recoverRecordings();
      const rc = recovered[0];
      const recoverDirs = readdirSync(dirname(bufDir)).filter((n) => n.startsWith(`${basename(bufDir)}.recover-`));
      result.recoveryDebug = { moved, waiting, count: recovered.length, duration: rc?.durationSeconds, title: rc?.title, tracks: rc?.audioTracks, leftoverGone: !existsSync(leftover), recoverDirs };
      result.recovery = moved === 1 && waiting === 1 && recovered.length === 1 && rc.durationSeconds >= 3 && rc.kind === 'recording' && /recovered/i.test(rc.title) && existsSync(rc.file) && !existsSync(leftover) && recoverDirs.length === 0;

      // Spadne snímací stránka uprostřed nahrávání zápasu: kousky se odloží a slepí hned,
      // zásobník se za pár sekund sám rozjede znovu.
      await (kine as any).toggleRecording();
      await sleep(5000);
      const beforeCrash = new Set(kine.library.list().map((c) => c.id));
      const capWin = (kine as any).capture.window as BrowserWindow | null;
      if (capWin && !capWin.isDestroyed()) capWin.webContents.forcefullyCrashRenderer();
      // Hra spadla s ním (konec hry hned po pádu snímání): uložení nahrávky nesmí kousky zahodit.
      await sleep(400);
      const finishedDuringCrash = await (kine as any).finishRecording('game-ended');
      let crashRec: any = null;
      let backOn = false;
      for (let i = 0; i < 120 && !(crashRec && backOn); i++) {
        await sleep(250);
        crashRec = kine.library.list().find((c) => !beforeCrash.has(c.id) && c.kind === 'recording');
        backOn = kine.capture.state === 'on';
      }
      result.crashRecovery = { recovered: !!crashRec, duration: crashRec?.durationSeconds, title: crashRec?.title, backOn, stillRecording: !!(kine as any).capture.recordingInfo(), finishedDuringCrash: !!finishedDuringCrash };
      result.crashRecoveryOk = !!crashRec && crashRec.durationSeconds >= 3 && /recovered/i.test(crashRec.title) && backOn && !(kine as any).capture.recordingInfo() && !finishedDuringCrash;
      await sleep(waitMs);

      // Snímací stránka nahlásí chybu (nespadne) a nahrávka se pak zastaví: ani tak se kousky nezahodí.
      await (kine as any).toggleRecording();
      await sleep(4500);
      const beforeError = new Set(kine.library.list().map((c) => c.id));
      const gens = (kine as any).capture.generations as { id: number }[];
      (kine as any).capture.handleEvent({ type: 'error', generation: gens[gens.length - 1]?.id ?? 0, message: 'test: MediaRecorder error' });
      const finishedAfterError = await (kine as any).finishRecording('user');
      // Nahrávka se slepí z kousků a zásobník se za pár sekund rozjede sám (chyba za běhu, ne při startu).
      let errorRec: any = null;
      let errorBackOn = false;
      for (let i = 0; i < 120 && !(errorRec && errorBackOn); i++) {
        await sleep(250);
        errorRec = kine.library.list().find((c) => !beforeError.has(c.id) && c.kind === 'recording');
        errorBackOn = kine.capture.state === 'on';
      }
      result.errorStopRecovery = { finished: !!finishedAfterError, recovered: !!errorRec, duration: errorRec?.durationSeconds, backOn: errorBackOn };
      result.errorStopRecoveryOk = !finishedAfterError && !!errorRec && errorRec.durationSeconds >= 2 && errorBackOn && !(kine as any).capture.recordingInfo();
      await sleep(waitMs);
      kine.openSettings('settings:hotkeys');
      await sleep(700);
      // Zkratky v nastavení: klip, zapnout/vypnout, nahrávka zápasu (snímek obrazovky už v appce není).
      result.recordHotkeyField = await recWin.webContents.executeJavaScript(`document.querySelectorAll('.panel .field .hotkey').length === 3 && !document.querySelector('.side-shot')`);

      // Živé vysílání: tlačítko Vysílat -> dialog -> vysílá se na místní RTMP server (místo Cloudflare),
      // ten proud uloží; musí mít obraz v kvalitě vysílání (720p) i zvuk. Klip během vysílání jde dál.
      const liveUrl = process.env.KINE_TEST_LIVE_URL;
      if (liveUrl) {
        kine.openSettings('clips');
        await sleep(700);
        const liveWin = kine.settingsWindow;
        const liveOut = join(outDir, 'live.flv');
        rmSync(liveOut, { force: true });
        const listener = spawnFfmpeg(['-loglevel', 'error', '-y', '-listen', '1', '-timeout', '60', '-i', liveUrl, '-c', 'copy', '-f', 'flv', liveOut]);
        let listenerLog = '';
        listener.stderr.on('data', (d) => (listenerLog += d.toString()));
        const listenerClosed = new Promise<void>((resolve) => listener.on('close', () => resolve()));
        await sleep(800);
        let opened = false;
        let liveState = '';
        let sideLive: string | null = null;
        let clipDuringLive = false;
        let titleKept = false;
        let brbOn = false;
        let brbOff = false;
        let micMuted = false;
        let stoppingUi = false;
        let endedCard = false;
        let endedPublished = false;
        let endedClosed = false;
        let onKineLine = false;
        // Kamera (falešná kamera Chromia při KINE_TEST_FAKE_AUDIO) vpravo dole, velká, obdélník.
        const withCamera = !!process.env.KINE_TEST_FAKE_AUDIO;
        kine.settings.update({ liveCamera: withCamera, liveCameraPosition: 'bottom-right', liveCameraSize: 'large', liveCameraShape: 'rect', liveCameraMirror: false, liveBrbText: 'E2E BRB' });
        await sleep(300);
        if (liveWin && !liveWin.isDestroyed()) {
          // Tlačítko Vysílat v panelu otevře záložku Živě (žádný dialog).
          opened = await liveWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-live'); if (b) b.click(); return true; })()`);
          await sleep(500);
          opened = opened && (await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-start') && !!document.querySelector('.live-scene-panel') && !!document.querySelector('.live-preview') && ${withCamera ? "!!document.querySelector('.corner-picker')" : 'true'}`));
          await shot(liveWin, 'settings-live-tab');
          // Psaní do názvu: stav z hlavního procesu (překreslení) nesmí sebrat kurzor ani rozepsaný text.
          await liveWin.webContents.executeJavaScript(`(() => { const i = document.querySelector('input.live-title'); i.focus(); i.value = 'E2E li'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
          (kine as any).pushStatus();
          await sleep(400);
          titleKept = await liveWin.webContents.executeJavaScript(`(() => { const i = document.querySelector('input.live-title'); return !!i && document.activeElement === i && i.value === 'E2E li'; })()`);
          await liveWin.webContents.executeJavaScript(`(() => { const i = document.querySelector('input.live-title'); i.value = 'E2E live'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); const b = document.querySelector('.live-start'); if (b) b.click(); return !!b; })()`);
          for (let i = 0; i < 60 && liveState !== 'live'; i++) {
            await sleep(500);
            liveState = (kine as any).live.current().state;
          }
          await sleep(4000);
          sideLive = await liveWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-live.on .live-time'); return b ? b.textContent : null; })()`);
          await shot(liveWin, 'settings-live');
          // Řádek "na Kine jsi živě / Kine tě neukazuje" vedle "diváci tě vidí" (0.10.6) - dřív appka
          // hlásila jen to druhé a na Kine přitom "nikdo nevysílá". Test vysílá na místní RTMP bez
          // playlistu HLS, takže hlídání "diváci tě vidí" by stav hned přepsalo na "nejde ověřit" -
          // na dobu kontroly se vypne (metoda na instanci zakryje tu ze třídy, delete ji vrátí).
          const liveCtl = (kine as any).live;
          liveCtl.startHealth = () => {};
          try {
            liveCtl.set({ health: 'ok', onKine: false, confirmed: false });
            await sleep(400);
            const onKineNo = await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-health.ok') && !!document.querySelector('.live-on-kine.warn')`);
            await shot(liveWin, 'settings-live-onkine-no');
            liveCtl.set({ onKine: true, confirmed: true });
            await sleep(400);
            const onKineOk = await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-health.ok') && !!document.querySelector('.live-on-kine.ok') && !document.querySelector('.live-on-kine.warn')`);
            await shot(liveWin, 'settings-live-onkine-ok');
            onKineLine = onKineNo && onKineOk;
          } finally {
            delete liveCtl.startHealth;
            liveCtl.set({ onKine: null, confirmed: null });
          }
          clipDuringLive = !!(await (kine as any).onClipHotkey());
          await sleep(1500);
          // "Hned jsem zpět": hra i kamera pryč, jen tmavá obrazovka s textem; pak zpět. Mikrofon ve vysílání ztlumit.
          brbOn = (kine as any).toggleLiveBrb(true) === true && (kine as any).live.current().scene?.brb === true;
          await sleep(4000);
          await shot(liveWin, 'settings-live-brb');
          brbOff = (kine as any).toggleLiveBrb(false) === false && (kine as any).live.current().scene?.brb === false;
          micMuted = (kine as any).setLiveMicMuted(true) === true && (kine as any).live.current().scene?.micMuted === true;
          await sleep(3000);
          // Ukončit: tlačítko hned "Ukončuji…" a nejde zmáčknout znovu.
          await liveWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-live.on'); if (b) b.click(); return !!b; })()`);
          await sleep(100);
          stoppingUi = await liveWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-live'); return !!b && b.disabled; })()`);
          await (kine as any).stopLive();
          // Po konci: karta záznamu v záložce Živě (zveřejnit na Kine); bez přihlášení tlačítko nejde.
          kine.openSettings('live');
          await sleep(700);
          const card = (kine as any).live.current().ended;
          endedCard = !!card && card.title === 'E2E live' && /^\d+:\d\d$/.test(card.duration) &&
            (await liveWin.webContents.executeJavaScript(`(() => { const c = document.querySelector('.live-ended'); const b = c && c.querySelector('.live-ended-publish'); const t = c && c.querySelector('input.live-ended-title'); return !!c && !!b && b.disabled === true && !!t && t.value === 'E2E live' && !!document.querySelector('.live-chat-panel .live-after-stream'); })()`));
          await shot(liveWin, 'settings-live-ended');
          // Zveřejněný záznam: odkaz "Otevřít záznam" místo tlačítka.
          (kine as any).live.set({ ended: { ...card, video: { id: 'e2e', url: 'https://kine.test/watch/e2e', status: 'processing', auto: true } } });
          await sleep(500);
          endedPublished = await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-ended.published .live-ended-open') && !document.querySelector('.live-ended-publish')`);
          await shot(liveWin, 'settings-live-ended-published');
          (kine as any).live.dismissEnded();
          await sleep(400);
          endedClosed = (kine as any).live.current().ended === null && (await liveWin.webContents.executeJavaScript(`!document.querySelector('.live-ended')`));
        } else {
          await (kine as any).stopLive();
        }
        await Promise.race([listenerClosed, sleep(8000)]);
        if (listener.exitCode === null) listener.kill();
        const info = existsSync(liveOut) ? await probe(liveOut).catch(() => null) : null;
        // Snímky z vysílání (2 za sekundu, zmenšené na 64x36): najít "Hned jsem zpět" (tmavé, uprostřed světlý text)
        // a s kamerou snímek, kde je pravý dolní roh jiný než zbytek obrazu (kamera je tam vidět).
        const frames = existsSync(liveOut) ? await rawFrames(liveOut, 64, 36, 2) : [];
        const lum = (f: Buffer, x0: number, y0: number, x1: number, y1: number) => {
          let sum = 0;
          let n = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = (y * 64 + x) * 3;
            sum += 0.2126 * f[i] + 0.7152 * f[i + 1] + 0.0722 * f[i + 2];
            n += 1;
          }
          return n ? sum / n : 0;
        };
        const brbFrames = frames.filter((f) => lum(f, 0, 0, 64, 10) < 30 && lum(f, 0, 26, 18, 36) < 30 && lum(f, 16, 13, 48, 19) > lum(f, 0, 0, 64, 10) + 12);
        // Kamera "large" vpravo dole = asi 21x12 px v rohu 64x36; falešná kamera Chromia je pestrá (ne černá).
        const camFrames = frames.filter((f) => !brbFrames.includes(f) && Math.abs(lum(f, 44, 23, 62, 34) - lum(f, 2, 2, 20, 13)) > 20);
        // Záznam do PC (0.10.3): karta má Stáhnout / Zahodit a ukazuje stav stahování; skutečné stažení
        // (místní HTTP server místo Cloudflare) skončí v knihovně jako nahrávka s náhledem.
        let endedExtras = false;
        let recordingSaved: Record<string, unknown> | null = null;
        if (liveWin && !liveWin.isDestroyed() && existsSync(liveOut)) {
          const base = { at: Date.now(), duration: '0:12', title: 'E2E live', autoPending: false, video: null, publishing: false, error: null, recordingUid: null, download: null, discarded: false, discarding: false };
          kine.openSettings('live');
          (kine as any).live.set({ ended: base });
          await sleep(500);
          const buttons = await liveWin.webContents.executeJavaScript(`(() => { const c = document.querySelector('.live-ended'); return !!c && !!c.querySelector('.live-ended-download') && !!c.querySelector('.live-ended-discard'); })()`);
          (kine as any).live.set({ ended: { ...base, download: { state: 'preparing', percent: 42, file: null, error: null } } });
          await sleep(400);
          const preparing = await liveWin.webContents.executeJavaScript(`/42 %/.test(document.querySelector('.live-ended-progress')?.textContent ?? '')`);
          await shot(liveWin, 'settings-live-ended-preparing');
          const data = readFileSync(liveOut);
          const server = createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
            res.end(data);
          });
          await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
          const port = (server.address() as { port: number }).port;
          const before = kine.library.list().length;
          const progress: (number | null)[] = [];
          let file: string | null = null;
          try {
            file = await (kine as any).saveStreamRecording({ url: `http://127.0.0.1:${port}/rec.mp4`, title: 'E2E live', endedAt: Date.now(), onProgress: (p: number | null) => progress.push(p) });
          } catch (e) {
            log(`e2e: stažení záznamu vysílání: ${(e as Error).message}`);
          }
          server.close();
          const added = kine.library.list().find((c) => c.file === file);
          recordingSaved = {
            inClips: !!file && file.startsWith((kine as any).settings.clipsDir()),
            exists: !!file && existsSync(file),
            noPart: !!file && !existsSync(`${file}.part`),
            kind: added?.kind ?? null,
            thumb: !!added?.thumb && existsSync(added.thumb),
            duration: added?.durationSeconds ?? null,
            added: kine.library.list().length - before,
            title: added?.title ?? null,
          };
          (kine as any).live.set({ ended: { ...base, download: { state: 'done', percent: 100, file, error: null } } });
          await sleep(400);
          const done = await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-ended-saved')`);
          (kine as any).live.set({ ended: { ...base, discarded: true } });
          await sleep(400);
          const discarded = await liveWin.webContents.executeJavaScript(`!!document.querySelector('.live-ended-discarded') && !document.querySelector('.live-ended-publish')`);
          await shot(liveWin, 'settings-live-ended-discarded');
          (kine as any).live.dismissEnded();
          endedExtras =
            buttons && preparing && done && discarded &&
            recordingSaved.inClips === true && recordingSaved.exists === true && recordingSaved.noPart === true && recordingSaved.kind === 'recording' &&
            recordingSaved.thumb === true && Number(recordingSaved.duration) >= 5 && recordingSaved.added === 1;
          // Stažený záznam z knihovny pryč, ať neplete další kroky.
          if (added) (kine as any).library.purge(added.id);
        }
        result.live = {
          opened, liveState, sideLive, clipDuringLive, titleKept, brbOn, brbOff, micMuted, stoppingUi, withCamera, endedCard, endedPublished, endedClosed, endedExtras, recordingSaved, onKineLine,
          frames: frames.length, brbFrames: brbFrames.length, camFrames: camFrames.length, cameraError: (kine as any).live.current().cameraError,
          after: (kine as any).live.current().state, info, listenerLog: listenerLog.slice(-300),
        };
        result.liveOk =
          opened && liveState === 'live' && !!sideLive && clipDuringLive && titleKept && brbOn && brbOff && micMuted && stoppingUi && (kine as any).live.current().state === 'idle' &&
          endedCard && endedPublished && endedClosed && endedExtras && onKineLine &&
          !!info && (info.durationSeconds ?? 0) >= 8 && (info.height ?? 0) > 0 && (info.height ?? 0) <= 720 && info.hasAudio &&
          brbFrames.length >= 2 && (!withCamera || camFrames.length >= 2);
        kine.settings.update({ liveCamera: false });

        // Kompatibilní režim (0.10.5): ffmpeg obraz zakóduje znovu (x264) - klíčový snímek přesně
        // každé 2 s a pevných 30 snímků za sekundu, i když recorder dává snímky nepravidelně.
        {
          const compatOut = join(outDir, 'live-compat.flv');
          rmSync(compatOut, { force: true });
          const listener2 = spawnFfmpeg(['-loglevel', 'error', '-y', '-listen', '1', '-timeout', '60', '-i', liveUrl, '-c', 'copy', '-f', 'flv', compatOut]);
          const closed2 = new Promise<void>((resolve) => listener2.on('close', () => resolve()));
          await sleep(800);
          const openPageBefore = kine.settings.get().liveOpenPage;
          kine.settings.update({ liveCompat: true, liveOpenPage: false });
          let compatState = '';
          let compatOn = false;
          try {
            await (kine as any).startLive({ title: 'E2E compat', quality: '720p30' });
            for (let i = 0; i < 60 && compatState !== 'live'; i++) {
              await sleep(500);
              compatState = (kine as any).live.current().state;
            }
            compatOn = (kine as any).live.current().compat === true;
            await sleep(7000);
          } catch (e) {
            log(`e2e: kompatibilní režim: ${(e as Error).message}`);
          }
          await (kine as any).stopLive();
          (kine as any).live.dismissEnded();
          kine.settings.update({ liveCompat: false, liveOpenPage: openPageBefore });
          await Promise.race([closed2, sleep(8000)]);
          if (listener2.exitCode === null) listener2.kill();
          const keyframes = existsSync(compatOut) ? await keyframeTimes(compatOut) : [];
          const cinfo = existsSync(compatOut) ? await probe(compatOut).catch(() => null) : null;
          const gaps = keyframes.slice(1).map((at, i) => at - keyframes[i]);
          result.liveCompat = { state: compatState, compatOn, keyframes: keyframes.slice(0, 6), gaps: gaps.slice(0, 5), fps: cinfo?.fps ?? null, duration: cinfo?.durationSeconds ?? null, audio: cinfo?.hasAudio ?? null };
          result.liveCompatOk =
            compatState === 'live' && compatOn && keyframes.length >= 3 && gaps.every((g) => Math.abs(g - 2) < 0.15) && Math.abs((cinfo?.fps ?? 0) - 30) < 0.6 && cinfo?.hasAudio === true;
        }
      }
    }

    // Kvalita: předvolba "Doporučené (1080p60)", řádek o tom, kdo kóduje (grafika / procesor), a posun zvuku ±300 ms.
    kine.openSettings('settings:quality');
    await sleep(700);
    const qWin = kine.settingsWindow;
    if (qWin && !qWin.isDestroyed()) {
      const quality = await qWin.webContents.executeJavaScript(
        `(() => { const r = document.querySelector('.quality-recommended'); const e = document.querySelector('.encoder-status'); return !!r && !!e && e.textContent.trim().length > 10 && !!e.querySelector('svg.icon'); })()`
      );
      await sleep(200);
      await shot(qWin, 'settings-quality');
      kine.openSettings('settings:audio');
      await sleep(600);
      const offset = await qWin.webContents.executeJavaScript(`(() => { const o = document.querySelector('input.audio-offset'); return !!o && o.min === '-300' && o.max === '300'; })()`);
      result.qualityPanel = quality && offset;
    }

    // Diagnostika pro podporu: verze, snímání, zvuk, konec protokolu - bez domovské složky; tlačítko v O aplikaci ji dá do schránky.
    const diag: string = await (kine as any).diagnostics();
    kine.openSettings('about');
    await sleep(700);
    const diagWin = kine.settingsWindow;
    if (diagWin && !diagWin.isDestroyed()) {
      await clipboard.writeText('');
      await diagWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.copy-diagnostics'); if (b) b.click(); return !!b; })()`);
      await sleep(900);
      const copied = await diagWin.webContents.executeJavaScript(`!!document.querySelector('.diagnostics-copied')`);
      const board = await clipboard.readText();
      await diagWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.diagnostics'); if (p) p.scrollIntoView({ block: 'center' }); return true; })()`);
      await shot(diagWin, 'settings-about-diagnostics');
      result.diagnosticsHead = diag.split('\n').slice(0, 8);
      result.diagnostics = /Capture: /.test(diag) && /Audio: /.test(diag) && /--- log ---/.test(diag) && !diag.includes(homedir() + '/') && copied && board.includes('Capture: ');
    }

    // Klip na výšku (9:16) má v knihovně stejně vysokou kartu jako ostatní: náhled 16:9, obraz uprostřed
    // na rozmazaném pozadí a štítek 9:16 (dřív se karta natáhla přes dvě řady).
    kine.openSettings('clips');
    await sleep(800);
    const gridWin = kine.settingsWindow;
    if (gridWin && !gridWin.isDestroyed()) {
      result.portraitCard = await gridWin.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.clips .clip')];
        const portrait = cards.find((c) => c.querySelector('.thumb.portrait'));
        const landscape = cards.find((c) => !c.querySelector('.thumb.portrait'));
        if (!portrait || !landscape) return { found: false };
        const ph = portrait.querySelector('.thumb').getBoundingClientRect().height;
        const lh = landscape.querySelector('.thumb').getBoundingClientRect().height;
        return { found: true, ph, lh, badge: !!portrait.querySelector('.ratio-badge'), fg: !!portrait.querySelector('.thumb-fg'), bg: !!portrait.querySelector('.thumb-bg') };
      })()`);
      const pc = result.portraitCard as any;
      result.portraitCardOk = !!pc.found && Math.abs(pc.ph - pc.lh) < 1 && pc.badge && pc.fg && pc.bg;
      await gridWin.webContents.executeJavaScript(`(() => { const c = document.querySelector('.clips .clip .thumb.portrait'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()`);
      await shot(gridWin, 'settings-clips-portrait');

      // Klip se samostatnými stopami: v úpravách je místo "bez zvuku" výběr zvuku (hra + mikrofon / jen hra / ...).
      if (multiClipId) {
        const opened = await gridWin.webContents.executeJavaScript(`(() => { const c = document.querySelector('.clips .clip[data-id="${multiClipId}"] .thumb'); if (c) { c.scrollIntoView({ block: 'center' }); c.click(); } return !!c; })()`);
        await sleep(1200);
        await gridWin.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head .player-edit')].find((x) => !x.disabled); if (b) b.click(); return !!b; })()`);
        await sleep(600);
        const trimAudio = await gridWin.webContents.executeJavaScript(`(() => { const r = document.querySelector('.player-box.editing .trim-audio-row'); const m = document.querySelector('.player-box.editing .trim input[type=checkbox]'); return { row: !!r && !r.classList.contains('hidden'), options: r ? r.querySelector('select').options.length : 0 }; })()`);
        await shot(gridWin, 'settings-clips-trim-audio');
        result.trimAudioSelect = opened && trimAudio.row && trimAudio.options === 4;
        await gridWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.player-close'); if (b) b.click(); return !!b; })()`);
        await sleep(400);
      }
    }

    // Koš: smazání z karty dá klip hned do koše (bez potvrzování v kartě) a dole lišta "Vrátit";
    // tlačítko Koš ho ukáže, "Vrátit" na kartě ho vrátí. Soubor se mezitím stěhuje do .trash a zpátky.
    kine.openSettings('clips');
    await sleep(700);
    const trashWin = kine.settingsWindow;
    if (trashWin && !trashWin.isDestroyed() && clip2) {
      const before = kine.library.list().length;
      const clickDelete = () =>
        trashWin.webContents.executeJavaScript(`(() => { const card = document.querySelector('.clip[data-id="${clip2.id}"]'); if (!card) return false; const b = card.querySelector('.card-tools button.delete'); if (!b) return false; b.click(); return true; })()`);
      // 1) smazat -> lišta dole -> Vrátit z lišty
      const undoClicked = await clickDelete();
      let undoBar: any = null;
      for (let i = 0; i < 20 && !undoBar?.shown; i++) {
        await sleep(150);
        undoBar = await trashWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.undo-bar'); const r = b ? b.getBoundingClientRect() : null; return { shown: !!b, text: b ? b.querySelector('.undo-text')?.textContent : null, inView: !!r && r.bottom <= window.innerHeight && r.top >= 0, card: !!document.querySelector('.clip[data-id="${clip2.id}"]') }; })()`);
      }
      const trashedByUndoTest = !!(kine as any).library.trash().find((c: any) => c.id === clip2.id);
      await shot(trashWin, 'settings-clips-undo');
      await trashWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.undo-bar .undo-restore'); if (b) b.click(); return !!b; })()`);
      let undone = false;
      for (let i = 0; i < 20 && !undone; i++) {
        await sleep(150);
        const c = kine.library.list().find((x) => x.id === clip2.id);
        undone = !!c && !c.deletedAt && (await trashWin.webContents.executeJavaScript(`!document.querySelector('.undo-bar') && !!document.querySelector('.clip[data-id="${clip2.id}"]')`));
      }
      result.trashUndo = { undoClicked, undoBar, trashedByUndoTest, undone };
      result.trashUndoOk = undoClicked && !!undoBar?.shown && !!undoBar?.inView && !undoBar?.card && /„|"|“/.test(String(undoBar?.text)) && trashedByUndoTest && undone;
      await sleep(300);
      // 1b) Dvojklik na koš: druhé kliknutí (na stejném místě už je jiný klip) se nepočítá a klip se
      //     nesmaže nadobro, ani když appce přijde druhý požadavek "do koše". Ctrl+Z podle písmene
      //     (česká klávesnice: Z má kód KeyY), Ctrl+Y (kód KeyZ) nic nevrací.
      const trashBefore = (kine as any).library.trash().length;
      const dbl = await trashWin.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.clip[data-id="${clip2.id}"]');
        const b = card && card.querySelector('.card-tools button.delete');
        if (!b) return { clicked: false };
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y }));
        const under = document.elementFromPoint(x, y);
        const second = under && under.closest('.card-tools button.delete') ? under.closest('.card-tools button.delete') : b;
        second.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2, clientX: x, clientY: y }));
        void window.kine.trashClip(${JSON.stringify(clip2.id)});
        return { clicked: true, secondOnOther: second !== b };
      })()`);
      await sleep(700);
      const afterDbl = kine.library.get(clip2.id);
      const dblState = {
        ...dbl,
        inTrash: !!afterDbl?.deletedAt,
        fileKept: !!afterDbl && existsSync(afterDbl.file),
        trashAdded: (kine as any).library.trash().length - trashBefore,
        bar: await trashWin.webContents.executeJavaScript(`document.querySelector('.undo-bar .undo-text')?.textContent ?? null`),
      };
      await trashWin.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true })), true`);
      await sleep(400);
      const ctrlYIgnored = !!kine.library.get(clip2.id)?.deletedAt;
      await trashWin.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyY', ctrlKey: true, bubbles: true, cancelable: true })), true`);
      let qwertzUndo = false;
      for (let i = 0; i < 20 && !qwertzUndo; i++) {
        await sleep(150);
        const c = kine.library.get(clip2.id);
        qwertzUndo = !!c && !c.deletedAt && (await trashWin.webContents.executeJavaScript(`!document.querySelector('.undo-bar') && !!document.querySelector('.clip[data-id="${clip2.id}"]')`));
      }
      result.trashDouble = { ...dblState, ctrlYIgnored, qwertzUndo };
      result.trashDoubleOk = !!dbl?.clicked && dblState.inTrash && dblState.fileKept && dblState.trashAdded === 1 && /„|"|“/.test(String(dblState.bar)) && ctrlYIgnored && qwertzUndo;
      await sleep(300);
      // 2) smazat znovu a nechat v koši
      const clicked = await clickDelete();
      let inTrash: any = null;
      for (let i = 0; i < 20 && !inTrash; i++) {
        await sleep(200);
        const live = (kine as any).library.trash().find((c: any) => c.id === clip2.id) ?? null;
        // Kopie - knihovna vrací živé objekty a vrácení z koše by cestu přepsalo.
        inTrash = live ? { ...live } : null;
      }
      await sleep(500);
      const trashBtn = await trashWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.filters .trash-filter'); if (!b) return false; b.click(); return b.querySelector('.count').textContent === '1'; })()`);
      await sleep(500);
      const trashView = await trashWin.webContents.executeJavaScript(`!!document.querySelector('.trash-bar') && document.querySelectorAll('.clips.in-trash .clip').length === 1 && !!document.querySelector('.clip .trash-restore') && !document.querySelector('.clip .thumb .pick')`);
      await shot(trashWin, 'settings-clips-trash');
      await trashWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.clip .trash-restore'); if (b) b.click(); return !!b; })()`);
      let restored: any = null;
      for (let i = 0; i < 20 && !restored; i++) {
        await sleep(200);
        const live = kine.library.list().find((c) => c.id === clip2.id) ?? null;
        restored = live ? { ...live } : null;
      }
      let backInLibrary = false;
      for (let i = 0; i < 15 && !backInLibrary; i++) {
        await sleep(200);
        backInLibrary = await trashWin.webContents.executeJavaScript(`!document.querySelector('.filters .trash-filter') && !document.querySelector('.trash-bar') && !!document.querySelector('.clip[data-id="${clip2.id}"]')`);
      }
      const filtersHtml = backInLibrary ? '' : await trashWin.webContents.executeJavaScript(`((document.querySelector('.filters') || {}).outerHTML || '').slice(0, 400) + ' | cards=' + document.querySelectorAll('.clip').length + ' trashbar=' + !!document.querySelector('.trash-bar')`);
      result.trashDebug = { clicked, inTrashFile: inTrash?.file, restoredFile: restored?.file, trashBtn, trashView, backInLibrary, filtersHtml };
      result.trash =
        clicked && !!inTrash && /[\\/]\.trash[\\/]/.test(inTrash.file) && !!inTrash.deletedAt && trashBtn && trashView && !!restored && !restored.deletedAt && !/\.trash/.test(restored.file) && backInLibrary && kine.library.list().length === before;
    }

    // Náhled ze snímku: v úpravách tlačítko vezme snímek, na kterém přehrávač stojí - klip má nový soubor náhledu.
    kine.openSettings('clips');
    await sleep(600);
    if (trashWin && !trashWin.isDestroyed() && clip1) {
      const beforeThumb = kine.library.list().find((c) => c.id === clip1.id)?.thumb ?? null;
      await trashWin.webContents.executeJavaScript(`(() => { const card = document.querySelector('.clip[data-id="${clip1.id}"]'); const b = card && card.querySelector('.actions .card-edit'); if (b) b.click(); return !!b; })()`);
      await sleep(900);
      await trashWin.webContents.executeJavaScript(`(() => { const v = document.querySelector('.overlay video'); if (v) { v.pause(); v.currentTime = 2; } return !!v; })()`);
      await sleep(500);
      const thumbBtn = await trashWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.overlay .thumb-frame'); if (!b) return false; b.click(); return true; })()`);
      let newThumb: string | null = null;
      for (let i = 0; i < 30 && (!newThumb || newThumb === beforeThumb); i++) {
        await sleep(300);
        newThumb = kine.library.list().find((c) => c.id === clip1.id)?.thumb ?? null;
      }
      await sleep(300);
      const noteOk = await trashWin.webContents.executeJavaScript(`(() => { const n = document.querySelector('.overlay .player-note'); return !!n && !n.classList.contains('hidden') && n.classList.contains('ok'); })()`);
      result.thumbFrameDebug = { thumbBtn, beforeThumb, newThumb, noteOk, overlay: await trashWin.webContents.executeJavaScript(`!!document.querySelector('.overlay')`) };
      await trashWin.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      result.thumbFrame = thumbBtn && !!newThumb && newThumb !== beforeThumb && existsSync(newThumb) && noteOk;
    }

    // Úložiště: v Záznamu je přehled místa (klipy, koš, zásobník, volno).
    kine.openSettings('settings:storage');
    await sleep(900);
    const storageWin = kine.settingsWindow;
    if (storageWin && !storageWin.isDestroyed()) {
      let ok = false;
      for (let i = 0; i < 20 && !ok; i++) {
        await sleep(250);
        // (v šabloně nejde psát \d - byl by z toho jen "d")
        ok = await storageWin.webContents.executeJavaScript(`(() => { const g = document.querySelector('.storage-grid'); return !!g && g.querySelectorAll('b').length === 4 && /[0-9]/.test(g.querySelectorAll('b')[0].textContent); })()`);
      }
      result.storage = ok;
      if (!ok) result.storageDebug = await storageWin.webContents.executeJavaScript(`(document.querySelector('.storage') || {}).outerHTML || 'no .storage'`);
      await storageWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.storage'); if (p) p.closest('.panel').scrollIntoView({ block: 'start' }); return true; })()`);
      await shot(storageWin, 'settings-storage');
    }

    // Zvuk: měřáky hry a mikrofonu v Záznamu; hladiny ze snímací stránky se propíšou do proužků a do věty "odkud jde zvuk".
    kine.openSettings('settings:audio');
    await sleep(800);
    const audioWin = kine.settingsWindow;
    if (audioWin && !audioWin.isDestroyed()) {
      const panel = await audioWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.audio-panel'); return !!p && p.querySelectorAll('.meter').length === 2 && !!p.querySelector('.audio-live-note') && !!p.querySelector('.microphone-device') && p.querySelectorAll('.gain input[type=range]').length >= 1; })()`);
      if (process.env.KINE_TEST_FAKE_AUDIO) {
        // Skutečné hladiny z falešného mikrofonu: proužek mikrofonu se hýbe, hra žádná (Linux).
        await sleep(1500);
        const real = await audioWin.webContents.executeJavaScript(`(() => { const m = document.querySelector('.meter.mic > span'); const s = document.querySelector('.meter.system'); return { mic: m ? parseFloat(m.style.width) : -1, systemOff: !!s && s.classList.contains('off') }; })()`);
        await audioWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.audio-panel'); if (p) p.scrollIntoView({ block: 'start' }); return true; })()`);
        await sleep(200);
        await shot(audioWin, 'settings-audio');
        result.audioDebug = { panel, real };
        result.audioPanel = panel && real.mic > 5 && real.systemOff;
      } else if (process.env.KINE_TEST_FAKE_LOOPBACK) {
        // Zvuk hry přes pomocníka: skutečné hladiny tónu a věta, že jde přímo z Windows.
        await sleep(1500);
        const native = await audioWin.webContents.executeJavaScript(`(() => { const s = document.querySelector('.meter.system > span'); const n = document.querySelector('.audio-live-note'); return { width: s ? parseFloat(s.style.width) : -1, note: n ? n.textContent : null }; })()`);
        await audioWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.audio-panel'); if (p) p.scrollIntoView({ block: 'start' }); return true; })()`);
        await sleep(200);
        await shot(audioWin, 'settings-audio-native');
        result.audioDebug = { panel, native };
        result.audioPanel = panel && native.width > 10 && /OBS/.test(native.note ?? '');
      } else {
      // Hladiny jako by přišly ze snímací stránky (v Xvfb žádný zvuk není).
      (kine as any).capture.handleEvent({ type: 'levels', generation: 0, levels: { system: 0.25, mic: 0.05, systemDevice: 'Test Speakers', systemSilentSeconds: 0 } });
      await sleep(600);
      const live = await audioWin.webContents.executeJavaScript(`(() => { const s = document.querySelector('.meter.system > span'); const n = document.querySelector('.audio-live-note'); return { width: s ? s.style.width : null, note: n ? n.textContent : null }; })()`);
      (kine as any).capture.handleEvent({ type: 'levels', generation: 0, levels: { system: 0, mic: 0.05, systemDevice: 'Test Speakers', systemSilentSeconds: 25 } });
      await sleep(600);
      const silent = await audioWin.webContents.executeJavaScript(`(() => { const n = document.querySelector('.audio-live-note'); return { note: n ? n.textContent : null, error: !!n && n.classList.contains('error'), help: !!document.querySelector('.audio-silent-help') }; })()`);
      await audioWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.audio-panel'); if (p) p.scrollIntoView({ block: 'start' }); return true; })()`);
      await shot(audioWin, 'settings-audio');
      result.audioDebug = { panel, live, silent };
      result.audioPanel = panel && !!live.width && parseFloat(live.width) > 50 && /Test Speakers/.test(live.note ?? '') && /Test Speakers/.test(silent.note ?? '') && /25/.test(silent.note ?? '') && silent.error && silent.help;
      }
    }

    // O appce: "Zkontrolovat aktualizace" ukáže stav (při vývoji "dev"), ne jen chybu.
    kine.openSettings('about');
    await sleep(700);
    const aboutWin = kine.settingsWindow;
    if (aboutWin && !aboutWin.isDestroyed()) {
      await aboutWin.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.panel button')].find((x) => /update/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      let shown = false;
      for (let i = 0; i < 20 && !shown; i++) {
        await sleep(250);
        shown = await aboutWin.webContents.executeJavaScript(`!!document.querySelector('.update-status')`);
      }
      result.updateUi = shown;
      // Stahování aktualizace: průběh (procenta, MB, rychlost), pak "Aktualizovat teď"; v postranním panelu odkaz.
      simulateUpdateProgress({ phase: 'downloading', version: '9.9.9', percent: 42, transferred: 35 * 1048576, total: 84 * 1048576, bytesPerSecond: 4.2 * 1048576, error: null });
      await sleep(700);
      const downloading = await aboutWin.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.update-progress.downloading'); const bar = b && b.querySelector('.update-bar > span'); return !!b && !!bar && bar.style.width === '42%' && /42/.test(b.textContent) && /84/.test(b.textContent) && !!document.querySelector('.side-update'); })()`
      );
      await shot(aboutWin, 'settings-about-update-downloading');
      simulateUpdateProgress({ phase: 'ready', version: '9.9.9', percent: 100 });
      await sleep(700);
      const ready = await aboutWin.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.update-progress.ready .update-now'); return !!b && !b.disabled && !!document.querySelector('.side-update.ready') && /9\\.9\\.9/.test(document.querySelector('.update-progress').textContent); })()`
      );
      const title = await aboutWin.webContents.executeJavaScript(`(document.querySelector('h1') || {}).textContent || ''`);
      await shot(aboutWin, 'settings-about-update-ready');
      simulateUpdateProgress({ phase: 'idle', version: null, percent: null, transferred: null, total: null, bytesPerSecond: null });
      await sleep(400);
      const gone = await aboutWin.webContents.executeJavaScript(`!document.querySelector('.update-progress') && !document.querySelector('.side-update')`);
      result.updateProgress = { downloading, ready, gone, title };
      result.updateProgressOk = downloading && ready && gone && (clipperApp ? title === 'Kine Clipper' : title !== 'Kine Clipper' && title.length > 0);

      // Aktualizace neprošla (Smart App Control zablokoval část instalátoru): nahoře v O appce
      // vysvětlení s verzí a tlačítky do Zabezpečení Windows, upozornění v panelu; "Rozumím" obojí zavře.
      // U připravené aktualizace s Smart App Control varování u tlačítka.
      // (Připravená aktualizace nejdřív - při ní si appka stav Smart App Control zjistí znovu, tady null.)
      const k = kine as any;
      simulateUpdateProgress({ phase: 'ready', version: '9.9.9', percent: 100 });
      await sleep(300);
      k.simulateUpdateIssue({ version: '9.9.9', reason: 'blocked' }, 'on');
      await sleep(700);
      const issueShown = await aboutWin.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.update-issue'); return { box: !!b, version: !!b && /9\.9\.9/.test(b.textContent), sac: !!(b && b.querySelector('.open-sac')), history: !!(b && b.querySelector('.open-history')), notice: [...document.querySelectorAll('.side-notice')].some((n) => /9\.9\.9/.test(n.textContent)), hint: !!document.querySelector('.update-sac-hint') }; })()`
      );
      await shot(aboutWin, 'settings-about-update-blocked');
      k.simulateUpdateIssue({ version: '9.9.9', reason: 'in-use' }, 'off');
      await sleep(600);
      const inUse = await aboutWin.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.update-issue'); return !!b && !b.querySelector('.open-sac') && !b.querySelector('.open-history') && !document.querySelector('.update-sac-hint'); })()`
      );
      await aboutWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.update-issue .dismiss-issue'); if (b) b.click(); return !!b; })()`);
      await sleep(700);
      const issueGone = await aboutWin.webContents.executeJavaScript(`!document.querySelector('.update-issue') && ![...document.querySelectorAll('.side-notice')].some((n) => /9\.9\.9/.test(n.textContent))`);
      simulateUpdateProgress({ phase: 'idle', version: null, percent: null, transferred: null, total: null, bytesPerSecond: null });
      k.simulateUpdateIssue(null, null);
      await sleep(300);
      result.updateIssue = { ...issueShown, inUse, issueGone };
      result.updateIssueOk = issueShown.box && issueShown.version && issueShown.sac && issueShown.history && issueShown.notice && issueShown.hint && inUse && issueGone;
    }

    // Vzhled: sklo (barvy Západ slunce, silné) -> <html> dostane atributy a pozadí; pak zpět klasický.
    kine.openSettings('settings:look');
    await sleep(700);
    const lookWin = kine.settingsWindow;
    if (lookWin && !lookWin.isDestroyed()) {
      await lookWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.appearance-panel'); if (p) p.scrollIntoView({ block: 'center' }); const b = [...document.querySelectorAll('.look-option')][1]; if (b) b.click(); return !!b; })()`);
      await sleep(500);
      await lookWin.webContents.executeJavaScript(`(() => { const c = [...document.querySelectorAll('.look-chip')].find((x) => x.querySelector('.look-swatch.sunset')); if (c) c.click(); return !!c; })()`);
      await sleep(500);
      kine.settings.update({ glassStrength: 80 });
      await sleep(500);
      const look = await lookWin.webContents.executeJavaScript(
        `(() => { const r = document.documentElement; const bd = document.querySelector('.app-backdrop'); const side = document.querySelector('.side'); return { look: r.getAttribute('data-look'), backdrop: r.getAttribute('data-backdrop'), k: r.style.getPropertyValue('--glass-k'), backdropShown: !!bd && getComputedStyle(bd).display === 'block', sideBg: side ? getComputedStyle(side).backgroundColor : null, chips: document.querySelectorAll('.look-chip').length, panel: !!document.querySelector('.appearance-panel') }; })()`
      );
      await shot(lookWin, 'settings-look-glass');
      kine.openSettings('clips');
      await sleep(700);
      await shot(kine.settingsWindow, 'settings-clips-glass');
      // Barvy podle obrazu + pohyblivé barvy: pozadí podle nejnovějšího klipu, pak podle karty
      // pod myší; kolem přehrávače světlo z videa; po vypnutí atributy pryč.
      kine.settings.update({ lookFollow: true, lookMotion: true });
      await sleep(1200);
      const fw = kine.settingsWindow!;
      const followBase = await fw.webContents.executeJavaScript(
        `(() => { const r = document.documentElement; const bd = document.querySelector('.app-backdrop'); return { follow: r.getAttribute('data-follow'), motion: r.getAttribute('data-motion'), anim: bd ? getComputedStyle(bd, '::before').animationName : null, first: !!document.querySelector('.app-backdrop-image.in'), src: bd ? bd.dataset.src || null : null }; })()`
      );
      const hovered = await fw.webContents.executeJavaScript(
        `(() => { const cur = document.querySelector('.app-backdrop')?.dataset.src || ''; const t = [...document.querySelectorAll('.clip .thumb')].find((x) => { const i = x.querySelector('img'); return i && i.getAttribute('src') !== cur; }); if (!t) return null; t.dispatchEvent(new MouseEvent('mouseenter')); return t.querySelector('img').getAttribute('src'); })()`
      );
      await sleep(1400);
      const followHover = await fw.webContents.executeJavaScript(
        `(() => { const bd = document.querySelector('.app-backdrop'); return { src: bd ? bd.dataset.src || null : null, layers: document.querySelectorAll('.app-backdrop-image').length, shown: !!document.querySelector('.app-backdrop-image.in') }; })()`
      );
      await shot(fw, 'settings-clips-glass-follow');
      await fw.webContents.executeJavaScript(`(() => { const t = document.querySelector('.clip .thumb'); if (t) t.click(); return !!t; })()`);
      let frames = 0;
      for (let i = 0; i < 24 && frames < 1; i++) {
        await sleep(250);
        frames = await fw.webContents.executeJavaScript(`Number(document.querySelector('.player-ambient')?.dataset.frames || 0)`);
      }
      await sleep(500);
      const ambientBox = await fw.webContents.executeJavaScript(
        `(() => { const a = document.querySelector('.player-ambient'); const s = document.querySelector('.player-stage'); if (!a || !s) return null; const ar = a.getBoundingClientRect(); const sr = s.getBoundingClientRect(); return { wider: ar.width > sr.width * 1.4, around: ar.left < sr.left && ar.right > sr.right && ar.top < sr.top, z: getComputedStyle(a).zIndex, shown: a.classList.contains('in') }; })()`
      );
      await shot(fw, 'settings-clips-player-ambient');
      await fw.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(500);
      const ambientGone = await fw.webContents.executeJavaScript(`!document.querySelector('.player-ambient') && !document.querySelector('.overlay')`);
      kine.settings.update({ lookFollow: false, lookMotion: false });
      await sleep(500);
      const followOff = await fw.webContents.executeJavaScript(
        `!document.documentElement.hasAttribute('data-follow') && !document.documentElement.hasAttribute('data-motion') && getComputedStyle(document.querySelector('.app-backdrop'), '::before').animationName === 'none'`
      );
      result.lookFollow = { followBase, hovered, followHover, frames, ambientBox, ambientGone, followOff };
      result.lookFollowOk =
        followBase.follow === '1' && followBase.motion === '1' && followBase.anim === 'app-backdrop-drift' && followBase.first && !!followBase.src &&
        !!hovered && followHover.src === hovered && followHover.shown &&
        frames >= 1 && !!ambientBox && ambientBox.wider && ambientBox.around && ambientBox.shown && ambientGone && followOff;
      kine.settings.update({ look: 'classic' });
      await sleep(500);
      const back = await kine.settingsWindow!.webContents.executeJavaScript(`!document.documentElement.hasAttribute('data-look') && getComputedStyle(document.querySelector('.app-backdrop')).display === 'none'`);
      result.look = { ...look, back };
      // Průsvitný postranní panel = alfa < 1 v barvě pozadí.
      const alpha = /rgba\([^)]*,\s*([0-9.]+)\)/.exec(look.sideBg ?? '');
      result.lookOk = look.look === 'glass' && look.backdrop === 'sunset' && look.k === '0.8' && look.backdropShown && look.chips === 6 && look.panel && !!alpha && Number(alpha[1]) < 0.7 && back;

      // Velikost písma, rohy, karty klipů, klidný režim (Vzhled): atributy na <html> a opravdu větší písmo / kulatější rohy.
      kine.openSettings('settings:look');
      await sleep(700);
      const sw = kine.settingsWindow!;
      const fontBefore = await sw.webContents.executeJavaScript(`parseFloat(getComputedStyle(document.body).fontSize)`);
      const segments = await sw.webContents.executeJavaScript(`[...document.querySelectorAll('.look-segmented')].map((g) => g.querySelectorAll('button').length)`);
      kine.settings.update({ lookText: 'l', lookCorners: 'round', lookCards: 's', lookCalm: true });
      await sleep(600);
      const sizes = await sw.webContents.executeJavaScript(
        `(() => { const r = document.documentElement; const p = document.querySelector('.panel'); const btn = document.querySelector('.look-segmented.look-text button.active'); return { text: r.getAttribute('data-text'), corners: r.getAttribute('data-corners'), cards: r.getAttribute('data-cards'), calm: r.getAttribute('data-calm'), font: parseFloat(getComputedStyle(document.body).fontSize), radius: p ? parseFloat(getComputedStyle(p).borderTopLeftRadius) : 0, active: btn ? btn.getAttribute('aria-checked') : null, anim: p ? getComputedStyle(p).transitionDuration : '' }; })()`
      );
      await shot(sw, 'settings-look-sizes');
      kine.settings.update({ lookText: 'm', lookCorners: 'normal', lookCards: 'm', lookCalm: false });
      await sleep(500);
      const sizesBack = await sw.webContents.executeJavaScript(`['data-text', 'data-corners', 'data-cards', 'data-calm'].every((a) => !document.documentElement.hasAttribute(a))`);
      result.lookSizes = { fontBefore, segments, sizes, sizesBack };
      result.lookSizesOk =
        Array.isArray(segments) && segments.length === 3 && segments.every((n: number) => n === 3) &&
        sizes.text === 'l' && sizes.corners === 'round' && sizes.cards === 's' && sizes.calm === '1' && sizes.font > fontBefore && sizes.radius >= 20 && sizes.active === 'true' && sizesBack;
    }

    // Zmenšování klipů: velký klip (1080p30, 20 Mb/s) v knihovně -> Klipy -> úložiště nahoře ->
    // úrovně s odhadem -> Zmenšit; soubor se nahradí menším (stejná délka), knihovna to ví.
    kine.openSettings('clips');
    await sleep(700);
    const cw = kine.settingsWindow;
    if (cw && !cw.isDestroyed()) {
      const bigFile = join((kine as any).settings.clipsDir(), 'E2E big clip.mp4');
      try {
        await runFfmpeg(
          ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=5,noise=alls=6:allf=t', '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '20M', '-minrate', '20M', '-maxrate', '20M', '-bufsize', '40M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', bigFile],
          180000
        );
        const info = await probe(bigFile);
        const before = statSync(bigFile).size;
        (kine as any).library.add({ id: 'e2e-big', file: bigFile, thumb: null, title: 'E2E big clip', game: null, createdAt: new Date().toISOString(), durationSeconds: info.durationSeconds ?? 5, sizeBytes: before, width: 1920, height: 1080, sessionId: 'e2e-compress', upload: null });
        // Hra by zmenšování pozdržela - tady se s žádnou nepočítá.
        const games = (kine as any).games;
        const realCurrent = games?.current;
        if (games) games.current = () => null;
        await sleep(800);
        const pill = await cw.webContents.executeJavaScript(`(() => { const p = document.querySelector('.storage-pill'); const worth = !!p && p.classList.contains('worth'); if (p) p.click(); return { found: !!p, worth }; })()`);
        await sleep(500);
        const panelInfo = await cw.webContents.executeJavaScript(`(() => ({ levels: document.querySelectorAll('.compress-panel .compress-level').length, savings: [...document.querySelectorAll('.compress-panel .compress-level-saving')].map((x) => x.textContent), start: !!document.querySelector('.compress-panel .compress-start') }))()`);
        await shot(cw, 'settings-clips-compress');
        await cw.webContents.executeJavaScript(`(() => { const b = document.querySelector('.compress-panel .compress-start'); if (b) b.click(); return !!b; })()`);
        let finished: any = null;
        let sawRunning = false;
        for (let i = 0; i < 360 && !finished; i++) {
          await sleep(500);
          const c = (kine as any).compressor.current();
          if (c?.running) sawRunning = true;
          if (c && !c.running && c.finishedAt) finished = c;
          if (i === 2) await shot(cw, 'settings-clips-compressing');
        }
        if (games) games.current = realCurrent;
        await sleep(700);
        const after = kine.library.get('e2e-big');
        const afterInfo = existsSync(bigFile) ? await probe(bigFile) : null;
        const doneUi = await cw.webContents.executeJavaScript(`!!document.querySelector('.storage-pill.done')`);
        await shot(cw, 'settings-clips-compressed');
        const leftovers = readdirSync((kine as any).settings.clipsDir()).filter((n) => /kine-small|kine-orig/.test(n));
        result.compress = { pill, panelInfo, sawRunning, finished, before, after: after?.sizeBytes, level: after?.compressed?.level, original: after?.compressed?.originalBytes, duration: afterInfo?.durationSeconds, doneUi, leftovers };
        result.compressOk =
          pill.found && pill.worth === false && panelInfo.levels === 3 && panelInfo.start && sawRunning && !!finished && finished.done === 1 && finished.skipped === 0 &&
          !!after && after.compressed?.level === 'medium' && after.compressed.originalBytes === before && after.sizeBytes < before * 0.7 && statSync(bigFile).size === after.sizeBytes &&
          !!afterInfo && Math.abs((afterInfo.durationSeconds ?? 0) - 5) < 0.3 && doneUi && leftovers.length === 0;
        await cw.webContents.executeJavaScript(`(() => { const p = document.querySelector('.storage-pill.done'); if (p) p.click(); return true; })()`);
        await sleep(300);
      } catch (e) {
        result.compress = { error: (e as Error).message };
      } finally {
        (kine as any).library.purge('e2e-big');
        rmSync(bigFile, { force: true });
      }
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
      'sidebar', 'favorite', 'hoverPreview', 'merge', 'mergeNote', 'gif', 'gifLimit', 'gifUi', 'sidePause', 'reviewPicks', 'reviewMerge', 'updateUi',
      'playerNav', 'playerTracksOk', 'playerSpeedOk', 'playerMuteOk', 'clipsSort', 'performance', 'recording', 'recordHotkeyField', 'trayDot',
      'autoClipContext', 'dota2Clip', 'minecraftClip', 'rocketLeagueClip', 'rocketLeagueConfig', 'verticalBlur', 'trash', 'trashUndoOk', 'trashDoubleOk', 'thumbFrame', 'storage', 'uploadDialog', 'uploadSettings', 'audioPanel', 'portraitCardOk', 'recovery', 'crashRecoveryOk', 'errorStopRecoveryOk', 'diagnostics', 'qualityPanel',
      'colorPicker', 'brandIcon', 'brandMarkSvg', 'textSpeedOk', 'recordingMarkersOk', 'clipToastInstant', 'recordingStopOnceOk', 'updateProgressOk', 'playerFullscreenOk', 'lookOk', 'lookSizesOk', 'lookFollowOk',
      'updateIssueOk', 'settingsSectionsOk', 'compressOk',
    ];
    if (process.env.KINE_TEST_LIVE_URL) common.push('liveOk', 'liveCompatOk');
    const checks = clipperApp ? [...common, 'clipperSide', 'clipperPanel', 'kineViewNever'] : [...common, 'kineViewShown', 'kineViewAwake', 'kineBar', 'kineBarBack', 'kineViewHidden', 'kineViewAsleep'];
    if (process.env.KINE_TEST_FAKE_AUDIO) checks.push('fakeAudioMeter', 'fakeAudioClip');
    if (process.env.KINE_TEST_FAKE_LOOPBACK) checks.push('nativeLoopbackMeter', 'nativeLoopbackClip');
    if (process.env.KINE_TEST_FAKE_AUDIO === 'full') checks.push('multiTrackOk', 'trimAudioSelect');
    result.failed = checks.filter((k) => result[k] !== true);
    result.ok = !!clip1 && !!clip2 && kine.capture.state === 'on' && (result.failed as string[]).length === 0 && result.brandColor === '#a34ff7';
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  }
  process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
}

/** Časy klíčových snímků videa (s) - ffmpeg dekóduje jen klíčové snímky a showinfo vypíše jejich čas. */
async function keyframeTimes(file: string): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawnFfmpeg(['-hide_banner', '-skip_frame', 'nokey', '-i', file, '-map', '0:v:0', '-vf', 'showinfo', '-f', 'null', '-']);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', () => {
      const times = [...stderr.matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
      resolve(times);
    });
    child.on('error', () => resolve([]));
  });
}

/** Snímky videa jako surové RGB (zmenšené), `fps` za sekundu - pro kontrolu obsahu vysílání v testu. */
async function rawFrames(file: string, width: number, height: number, fps: number): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const child = spawnFfmpeg(['-loglevel', 'error', '-i', file, '-vf', `fps=${fps},scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('close', () => {
      const all = Buffer.concat(chunks);
      const size = width * height * 3;
      const frames: Buffer[] = [];
      for (let i = 0; i + size <= all.length; i += size) frames.push(all.subarray(i, i + size));
      resolve(frames);
    });
    child.on('error', () => resolve([]));
  });
}
