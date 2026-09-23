import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { BrowserWindow, app } from 'electron';
import { log } from './log';
import { trayIcon } from './icon';

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
        result.uploadDialogDebug = { manyOpened, manyDialog, closedByEsc, singleDialog, saved };
        result.uploadDialog =
          manyOpened &&
          !!manyDialog && manyDialog.clips === 3 && manyDialog.vis === 3 && manyDialog.cats === 15 && manyDialog.note && manyDialog.clipsHeight > 100 &&
          closedByEsc &&
          !!singleDialog && singleDialog.single && singleDialog.tags.includes('#klip') && /Kine/.test(singleDialog.desc) && singleDialog.tagsAfter.includes('#test_tag') &&
          !!saved && saved.visibility === 'subscribers' && Array.isArray(saved.hashtags) && saved.hashtags.includes('test_tag') && saved.category === 'catGaming' && saved.hashtags.includes('klip');
      }
    }
    for (const tab of ['clips', 'settings', 'games', 'upload', 'account', 'about']) {
      kine.openSettings(tab);
      await sleep(900);
      await shot(kine.settingsWindow, `settings-${tab}`);
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
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head button')].find((x) => !x.disabled && x.textContent && !x.classList.contains('player-close') && !x.classList.contains('hidden')); if (b) b.click(); return !!b; })()`);
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
        await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await sleep(300);
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
        await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.player-head button')].find((x) => !x.disabled && x.textContent && !x.classList.contains('player-close') && !x.classList.contains('hidden')); if (b) b.click(); return !!b; })()`);
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

    // Výkon appky: tři volby v Záznamu; "Úsporný" vypne náhledy při najetí, uloží se do nastavení.
    kine.openSettings('settings');
    await sleep(700);
    const perfWin = kine.settingsWindow;
    if (perfWin && !perfWin.isDestroyed()) {
      const panel = await perfWin.webContents.executeJavaScript(`(() => { const p = document.querySelector('.panel.performance'); return !!p && p.querySelectorAll('input[type=radio][name=performance]').length === 3 && !!p.querySelector('.perf-now'); })()`);
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
      await sleep(4500);
      const beforeStop = new Set(kine.library.list().map((c) => c.id));
      await recWin.webContents.executeJavaScript(`(() => { const b = document.querySelector('.side-record.recording'); if (b) b.click(); return !!b; })()`);
      let rec: any = null;
      for (let i = 0; i < 120 && !rec; i++) {
        await sleep(500);
        rec = kine.library.list().find((c) => !beforeStop.has(c.id) && c.kind === 'recording');
      }
      await sleep(800);
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
      kine.openSettings('settings');
      await sleep(700);
      result.recordHotkeyField = await recWin.webContents.executeJavaScript(`document.querySelectorAll('.panel .field .hotkey').length === 3`);
    }

    // Koš: smazání z karty (dvojí klik = potvrzení) dá klip do koše, tlačítko Koš ho ukáže,
    // "Vrátit" ho vrátí. Soubor se mezitím stěhuje do .trash a zpátky.
    kine.openSettings('clips');
    await sleep(700);
    const trashWin = kine.settingsWindow;
    if (trashWin && !trashWin.isDestroyed() && clip2) {
      const before = kine.library.list().length;
      const clicked = await trashWin.webContents.executeJavaScript(`(() => { const card = document.querySelector('.clip[data-id="${clip2.id}"]'); if (!card) return false; const btns = [...card.querySelectorAll('.actions button.danger')]; const b = btns[btns.length - 1]; b.click(); return true; })()`);
      await sleep(300);
      await trashWin.webContents.executeJavaScript(`(() => { const card = document.querySelector('.clip[data-id="${clip2.id}"]'); const b = card && card.querySelector('.actions button.danger:not(.quiet)'); if (b) b.click(); return !!b; })()`);
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
      await trashWin.webContents.executeJavaScript(`(() => { const card = document.querySelector('.clip[data-id="${clip1.id}"]'); const b = card && [...card.querySelectorAll('.actions button')].find((x) => /✂/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
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
    kine.openSettings('settings');
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
      'playerNav', 'clipsSort', 'performance', 'recording', 'recordHotkeyField', 'trayDot',
      'autoClipContext', 'dota2Clip', 'minecraftClip', 'verticalBlur', 'trash', 'thumbFrame', 'storage', 'uploadDialog', 'uploadSettings',
      'colorPicker', 'brandIcon', 'brandMarkSvg',
    ];
    const checks = clipperApp ? [...common, 'clipperSide', 'clipperPanel', 'kineViewNever'] : [...common, 'kineViewShown', 'kineViewAwake', 'kineBar', 'kineBarBack', 'kineViewHidden', 'kineViewAsleep'];
    result.failed = checks.filter((k) => result[k] !== true);
    result.ok = !!clip1 && !!clip2 && kine.capture.state === 'on' && (result.failed as string[]).length === 0 && result.brandColor === '#a34ff7';
  } catch (e) {
    result.error = (e as Error).stack ?? String(e);
  }
  process.stdout.write(`KINE_TEST_RESULT ${JSON.stringify(result)}\n`);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 500);
}
