import type { KineBridge } from '../preload/preload';
import type { AppNotice, AudioDevice, AudioLevels, Clip, DisplayInfo, GameSource, GlassBackdrop, Lang, LiveAfterStream, LiveEnded, LiveQuality, ProcessInfo, ResourceUsage, Settings, Status, UploadRequest, Visibility } from '../shared/types';
import { CATEGORY_KEYS, GLASS_BACKDROPS, LANGS, STORAGE_LIMITS_GB, TRASH_DAYS, VISIBILITIES } from '../shared/types';
import { LANG_NAMES, makeT, type Key } from '../shared/i18n';
import { HotkeyRecorder, formatHotkey, hotkeyLabel } from '../shared/hotkeys';
import { DISCORD_FILE_MAX_BYTES, isDiscordWebhook, suggestedMbps } from '../shared/settingsSchema';
import { applyBrandColor, clipOptionsFor, maxClipSecondsFor } from '../shared/plan';
import { performanceProfile } from '../shared/performance';
import { clear, clipMeta, errorText, fileUrl, formatBytes, formatDate, formatDuration, h, isPortrait, thumbImages } from './ui';
import { closePlayer, openPlayer, openPlayerId, type Neighbors, type PlayerHandle } from './player';
import { attachBackdrop, followImage, hasFollowImage } from './ambient';
import { VIDEO_LANGS, openUploadDialog } from './uploadDialog';
import { LIVE_BITRATES_KBPS, LIVE_QUALITIES, cleanLiveError, liveElapsed, liveErrorTextKey, livePresetFor, livePresetLabel, liveUploadMbps } from '../shared/live';
import { cameraRect } from '../shared/liveLayout';

/**
 * Hlavní okno: v režimu "Kine + klipy" první záložka Kine - web Kine přes
 * celé okno (hlavní proces ho položí přes plochu, kterou mu tahle stránka
 * nahlásí), bez postranního panelu, jen s úzkou lištou dole (stav
 * nahrávání, tlačítka Klipy a Nastavení). Ostatní záložky (klipy,
 * nastavení, hry, nahrávání, účet, o appce) mají postranní panel s Kine
 * jako první položkou. Při prvním spuštění průvodce.
 *
 * Bez knihovny pro UI: stránka se po každé změně vykreslí znovu z dat
 * (settings, status, clips). Změny se ukládají hned, žádné "Uložit".
 * Přehrávač klipu je vrstva přes okno (player.ts) - mřížka pod ním se
 * nehýbe; tam se klip i zkracuje. Pětkrát klik na logo Kine = výběr
 * barvy appky (jako na webu).
 */
declare const window: Window & { kine: KineBridge };
const kine = window.kine;
const app = document.getElementById('app') as HTMLDivElement;

type Tab = 'kine' | 'clips' | 'live' | 'settings' | 'games' | 'upload' | 'account' | 'about';
const TABS: Tab[] = ['kine', 'clips', 'live', 'settings', 'games', 'upload', 'account', 'about'];
const TAB_KEYS: Record<Tab, Key> = { kine: 'tabKine', clips: 'tabClips', live: 'tabLive', settings: 'tabSettings', games: 'tabGames', upload: 'tabUpload', account: 'tabAccount', about: 'tabAbout' };
/** Barvy jako na webu (components/BrandLogo.tsx). */
const PRESET_COLORS = ['#00c9a7', '#4f8ef7', '#f7484f', '#f7b84f', '#a34ff7', '#f74fd6', '#4ff77c', '#ffffff'];

type DateFilter = 'all' | 'today' | 'week' | 'month';

let settings: Settings;
let status: Status;
let clips: Clip[] = [];
/** Klipy v koši (soubor v .trash, po týdnu zmizí samy) - zvlášť, ať se nikde neplete mezi ostatní. */
let trashClips: Clip[] = [];
let confirmEmptyTrash = false;
let displays: DisplayInfo[] = [];
let processes: ProcessInfo[] | null = null;
let currentGame: { name: string; exe: string; source: GameSource } | null = null;
let gameNames: string[] = [];
let tab: Tab = 'clips';
let wizardStep: number | null = null;
let authWaiting = false;
let authError: string | null = null;
type HotkeyField = 'clipHotkey' | 'toggleHotkey' | 'recordHotkey' | 'screenshotHotkey' | 'liveBrbHotkey';
let hotkeyRecording: HotkeyField | null = null;
let hotkeyError: string | null = null;
const recorder = new HotkeyRecorder();
let updateResult: { status: string; version?: string; url?: string; message?: string; source?: string; waitingForGame?: boolean } | null = null;
/** "Aktualizovat teď" zmáčknuto - appka se zavírá a instaluje novou verzi. */
let updateInstalling = false;
/** Aktualizovat teď nejde - běží vysílání / nahrávání zápasu. */
let updateBusy = false;
let confirmDelete: string | null = null;
let renaming: string | null = null;
let editingGame: string | null = null;
let addGameOpen = false;
let namingGame = false;
let player: PlayerHandle | null = null;
let discordInvalid = false;
/** Krátká zpětná vazba u tlačítek karty: "Odkaz zkopírován", "Posláno na Discord". */
let shareNote: { id: string; text: string; kind: 'ok' | 'error' } | null = null;
let shareNoteTimer: ReturnType<typeof setTimeout> | null = null;
const filters: { game: string; date: DateFilter; query: string; favorites: boolean; trash: boolean } = { game: 'all', date: 'all', query: '', favorites: false, trash: false };
let focusSearch = false;
/** Výběr více klipů (zaškrtávátka na kartách) - sestřih, nahrání, smazání naráz. */
const selected = new Set<string>();
let merging: { percent: number } | null = null;
let mergeNote: { text: string; kind: 'ok' | 'error' } | null = null;
let mergeNoteTimer: ReturnType<typeof setTimeout> | null = null;
let confirmBulkDelete = false;
let bulkDeleteTimer: ReturnType<typeof setTimeout> | null = null;
/** Náhled klipu při najetí myší na kartu - vždy nejvýš jeden. */
let preview: { host: HTMLElement; video: HTMLVideoElement } | null = null;
/** Čtení ovladače (Gamepad API) během záznamu zkratky. */
let padTimer: ReturnType<typeof setInterval> | null = null;
let colorPickerOpen = false;
let brandClicks = 0;
let brandClickTimer: ReturnType<typeof setTimeout> | null = null;
let kineShown = false;
let kineFailed: string | null = null;
let renderQueued = false;
/** Záložka Live: chyba posledního pokusu o vysílání (text pro hráče). */
let liveError: string | null = null;

const t = (key: Key, vars?: Record<string, string | number>) => makeT(settings.lang)(key, vars);

async function init() {
  const params = new URLSearchParams(location.search);
  let allClips: Clip[];
  [settings, status, allClips, displays] = await Promise.all([kine.getSettings(), kine.getStatus(), kine.listClips(), kine.listDisplays()]);
  clips = allClips.filter((c) => !c.deletedAt);
  trashClips = allClips.filter((c) => !!c.deletedAt);
  currentGame = await kine.currentGame();
  const wanted = params.get('tab');
  if (!settings.onboarded || wanted === 'wizard') wizardStep = 0;
  else if (wanted && visibleTabs().includes(wanted as Tab)) tab = wanted as Tab;
  else if (settings.appMode === 'full') tab = 'kine';
  document.documentElement.lang = settings.lang;
  document.title = status.variant === 'clipper' ? 'Kine Clipper' : 'Kine';
  render();
  void refreshGameNames();

  kine.onSettings((s) => {
    settings = s;
    document.documentElement.lang = s.lang;
    if (!visibleTabs().includes(tab)) tab = 'clips';
    scheduleRender();
  });
  kine.onStatus((s) => {
    status = s;
    void kine.currentGame().then((g) => {
      currentGame = g;
      scheduleRender();
    });
  });
  kine.onClips((c) => {
    clips = c.filter((x) => !x.deletedAt);
    trashClips = c.filter((x) => !!x.deletedAt).sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
    // Přehrávač je mimo mřížku - jen mu říct, co se s klipem stalo (název, smazání).
    player?.sync(filters.trash ? trashClips : clips);
    // Výběr jen z klipů, které ještě jsou.
    const ids = new Set(clips.map((x) => x.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    scheduleRender();
    void refreshGameNames();
  });
  kine.onAuthWaiting((w) => {
    authWaiting = w;
    scheduleRender();
  });
  // Měřáky zvuku: jen proužky, celá stránka se překreslí až když se změní, co je k vidění (ticho / zvuk).
  void kine.getAudioLevels().then((l) => {
    audioLevels = l;
    smoothLevels(l);
    updateMeters();
  });
  kine.onAudioLevels((l) => {
    const before = audioLevels;
    audioLevels = l;
    smoothLevels(l);
    const silentBefore = !!before && before.system !== null && before.systemSilentSeconds >= 10;
    const silentNow = l.system !== null && l.systemSilentSeconds >= 10;
    const trackChanged = !before || (before.system === null) !== (l.system === null) || (before.mic === null) !== (l.mic === null) || before.systemDevice !== l.systemDevice;
    if (silentBefore !== silentNow || trackChanged) scheduleRender();
    else updateMeters();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    audioDevicesAt = 0;
    void refreshAudioDevices();
  });
  kine.onNavigate((target) => {
    if (visibleTabs().includes(target as Tab)) {
      tab = target as Tab;
      wizardStep = null;
      render();
    } else if (target === 'wizard') {
      wizardStep = 0;
      render();
    } else if (TABS.includes(target as Tab)) {
      // "kine" v režimu jen klipovač - aspoň klipy.
      tab = 'clips';
      wizardStep = null;
      render();
    }
  });
  window.addEventListener('resize', () => syncKineView());
  kine.onKineViewFailed((description) => {
    kineFailed = description;
    kineShown = false;
    scheduleRender();
  });
  kine.onKineViewRetry(() => {
    kineFailed = null;
    kineShown = false;
    syncKineView();
  });
  document.addEventListener('mousedown', (e) => {
    if (colorPickerOpen && !(e.target as HTMLElement).closest('.brand-wrap')) {
      colorPickerOpen = false;
      render();
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('contextmenu', (e) => {
    if (hotkeyRecording) e.preventDefault();
  });
  document.addEventListener('auxclick', (e) => {
    if (hotkeyRecording) e.preventDefault();
  });
}

async function refreshGameNames() {
  try {
    gameNames = await kine.gameNames();
  } catch {
    gameNames = [];
  }
}

function update(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  render();
  void kine.updateSettings(patch);
}

/** Štítek "Clipper" u loga - ať je hned vidět, která z obou appek to je. */
function brandTag() {
  return status.variant === 'clipper' ? h('span', { class: 'brand-tag' }, 'Clipper') : null;
}

/**
 * Značka appky vykreslená v barvě Kine hráče (--brand), ne z obrázku -
 * obrázek by zůstal tyrkysový, i když má hráč vybranou jinou barvu.
 * Kine: trojúhelník; Kine Clipper: trojúhelník mezi svorkami ořezu.
 */
function appIconSvg(clipper: boolean, size: number): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const el = (tag: string, attrs: Record<string, string>) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  };
  el('rect', { width: '64', height: '64', rx: '14', fill: '#0a0a0b' });
  el('rect', { width: '64', height: '64', rx: '14', fill: 'var(--brand)', 'fill-opacity': '0.15' });
  if (clipper) {
    const stroke = { fill: 'none', stroke: 'var(--brand)', 'stroke-width': '3.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    el('path', { d: 'M19.5 17 H13 V47 H19.5', ...stroke });
    el('path', { d: 'M44.5 17 H51 V47 H44.5', ...stroke });
    el('path', { d: 'M26.5 23 L42.5 32 L26.5 41 Z', fill: 'var(--brand)' });
  } else {
    el('path', { d: 'M24 18 L46 32 L24 46 Z', fill: 'var(--brand)' });
  }
  return svg;
}

function brandMark() {
  return h('span', { class: 'mark' }, appIconSvg(status.variant === 'clipper', 28));
}

/** Záložky podle appky: web Kine jen v Kine do PC (režim 'full'). */
function visibleTabs(): Tab[] {
  return settings.appMode === 'full' ? TABS : TABS.filter((x) => x !== 'kine');
}

/**
 * Změny zvenku (stav, klipy, nahrávání) se kreslí nejdřív v dalším snímku
 * a najednou - při nahrávání chodí po kusech a překreslovat celé okno
 * s běžícím přehrávačem při každém by trhalo.
 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/**
 * Web Kine v okně: hlavní proces ho položí přesně přes plochu obsahu.
 * Volá se po každém vykreslení a při změně velikosti okna; mimo záložku
 * Kine (nebo v průvodci) se schová.
 */
function syncKineView() {
  const host = app.querySelector('.kine-host') as HTMLElement | null;
  if (host && tab === 'kine' && wizardStep === null && settings.appMode === 'full') {
    const r = host.getBoundingClientRect();
    kineShown = true;
    void kine.kineViewShow({ x: r.left, y: r.top, width: r.width, height: r.height });
  } else if (kineShown) {
    kineShown = false;
    void kine.kineViewHide();
  }
}

// ---- barva Kine (5x klik na logo) ------------------------------------------------

function onBrandClick() {
  brandClicks += 1;
  if (brandClickTimer) clearTimeout(brandClickTimer);
  brandClickTimer = setTimeout(() => {
    brandClicks = 0;
  }, 1500);
  if (brandClicks >= 5) {
    brandClicks = 0;
    colorPickerOpen = true;
    render();
  }
}

function pickColor(color: string | null) {
  colorPickerOpen = false;
  settings = { ...settings, brandColor: color ?? '' };
  render();
  void kine.setBrandColor(color);
}

function colorPicker() {
  const custom = h('input', {
    type: 'color',
    class: 'color-input',
    value: settings.brandColor || '#00c9a7',
    title: t('brandColorCustom'),
    onchange: (e: Event) => pickColor((e.target as HTMLInputElement).value),
  });
  return h(
    'div',
    { class: 'color-picker' },
    h('p', { class: 'faint', style: 'margin:0 0 8px' }, t('brandColorTitle')),
    h(
      'div',
      { class: 'swatches' },
      ...PRESET_COLORS.map((c) =>
        h('button', { class: `swatch ${settings.brandColor.toLowerCase() === c ? 'active' : ''}`, style: `background:${c}`, title: c, onclick: () => pickColor(c) })
      ),
      h('label', { class: 'swatch custom', title: t('brandColorCustom') }, '+', custom)
    ),
    h('button', { class: 'small quiet', style: 'margin-top:10px', onclick: () => pickColor(null) }, t('brandColorReset'))
  );
}

// ---- zkratky ---------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent) {
  // "/" v knihovně skočí do hledání (jako na webu), když se právě nepíše jinam.
  if (!hotkeyRecording && e.key === '/' && tab === 'clips' && wizardStep === null && !openPlayerId()) {
    const target = e.target as HTMLElement | null;
    if (!target || !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
      const input = app.querySelector('.clips-search') as HTMLInputElement | null;
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
    return;
  }
  if (!hotkeyRecording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    stopRecording();
    return;
  }
  if (e.repeat) return;
  recorder.keyDown(e.code);
  render();
}

function onKeyUp(e: KeyboardEvent) {
  if (!hotkeyRecording) return;
  e.preventDefault();
  e.stopPropagation();
  finishIfDone(recorder.keyUp(e.code));
}

function onMouseDown(e: MouseEvent) {
  if (!hotkeyRecording) return;
  if (e.button === 0 || e.button === 2) return; // levé/pravé tlačítko ovládá okno, ne zkratku
  e.preventDefault();
  e.stopPropagation();
  recorder.mouseDown(e.button);
  render();
}

function onMouseUp(e: MouseEvent) {
  if (!hotkeyRecording) return;
  if (e.button === 0 || e.button === 2) return;
  e.preventDefault();
  e.stopPropagation();
  finishIfDone(recorder.mouseUp(e.button));
}

function stopRecording() {
  hotkeyRecording = null;
  hotkeyError = null;
  recorder.reset();
  stopPadPoll();
  render();
}

function finishIfDone(done: ReturnType<HotkeyRecorder['keyUp']>) {
  if (!done || !hotkeyRecording) {
    render();
    return;
  }
  const field = hotkeyRecording;
  const text = formatHotkey(done);
  // Stejná zkratka na dvě věci by jedna z nich nikdy nedostala.
  const HOTKEY_LABELS: Record<HotkeyField, Key> = { clipHotkey: 'clipHotkey', toggleHotkey: 'toggleHotkey', recordHotkey: 'recordHotkey', screenshotHotkey: 'screenshotHotkey', liveBrbHotkey: 'liveBrbHotkey' };
  const duplicate = (Object.keys(HOTKEY_LABELS) as HotkeyField[]).find((f) => f !== field && !!settings[f] && settings[f].toLowerCase() === text.toLowerCase());
  if (duplicate) {
    hotkeyError = t('hotkeyDuplicate', { name: t(HOTKEY_LABELS[duplicate]) });
    recorder.reset();
    render();
    return;
  }
  void kine.hotkeyAvailable(text).then((result) => {
    if (result !== 'ok') {
      hotkeyError =
        result === 'in-use' ? t('hotkeyInUse') : result === 'unsupported' ? t('hotkeyChordUnsupported') : result === 'helper-down' ? t('hotkeyHelperDown') : result;
      recorder.reset();
      render();
      return;
    }
    hotkeyError = null;
    hotkeyRecording = null;
    stopPadPoll();
    update({ [field]: text } as Partial<Settings>);
  });
}

/**
 * Ovladač při záznamu zkratky: Gamepad API (standardní rozložení) se čte
 * dokola; stisknutá tlačítka jdou do záznamu jako "PadA", "PadRB"…, hotovo
 * je po puštění všeho. Stránka musí mít fokus - ten má, hráč do pole klikl.
 */
function startPadPoll() {
  if (padTimer || typeof navigator.getGamepads !== 'function') return;
  padTimer = setInterval(() => {
    if (!hotkeyRecording) {
      stopPadPoll();
      return;
    }
    let pads: (Gamepad | null)[] = [];
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }
    const pressed: number[] = [];
    for (const pad of pads) {
      if (!pad) continue;
      pad.buttons.forEach((b, i) => {
        if (b.pressed || b.value > 0.5) pressed.push(i);
      });
    }
    if (pressed.length === 0 && !recorder.current().pad.length) return;
    const before = formatHotkey(recorder.current());
    const done = recorder.padState(pressed);
    if (done) finishIfDone(done);
    else if (formatHotkey(recorder.current()) !== before) render();
  }, 50);
}

function stopPadPoll() {
  if (padTimer) clearInterval(padTimer);
  padTimer = null;
}

function hotkeyField(field: HotkeyField, label: string, hint?: string, options: { clearable?: boolean } = {}) {
  const recording = hotkeyRecording === field;
  const held = recording ? recorder.current() : null;
  const heldText = held && held.mods.length + held.keys.length + held.mouse.length + held.pad.length > 0 ? hotkeyLabel(formatHotkey(held)) : '';
  const value = settings[field];
  return h(
    'div',
    { class: 'field' },
    h('label', {}, label),
    h(
      'div',
      { class: 'row' },
      h(
        'div',
        {
          class: `hotkey ${recording ? 'recording' : ''} ${!value && !recording ? 'empty' : ''}`,
          tabindex: '0',
          role: 'button',
          onclick: () => {
            if (hotkeyRecording === field) return;
            hotkeyRecording = field;
            hotkeyError = null;
            recorder.reset();
            startPadPoll();
            render();
          },
        },
        recording ? (heldText ? t('hotkeyHold', { keys: heldText }) : t('hotkeyPress')) : value ? hotkeyLabel(value) : t('hotkeyNone')
      ),
      // Nepovinná zkratka jde vypnout (prázdná = jen tlačítkem).
      options.clearable && value && !recording ? h('button', { class: 'small quiet', onclick: () => update({ [field]: '' } as Partial<Settings>) }, t('hotkeyClear')) : null,
      recording ? h('span', { class: 'faint' }, t('hotkeyEsc')) : null,
      hotkeyError && recording ? h('span', { class: 'error' }, hotkeyError) : null
    ),
    hint ? h('p', { class: 'hint' }, hint) : null
  );
}

// ---- vykreslení -------------------------------------------------------------------

/**
 * Skleněný vzhled (Nastavení -> Vzhled): atributy na <html> a barevné pozadí
 * za oknem. Pozadí je jedna vrstva mimo #app (překreslování ji nemaže);
 * plochy nad ní jsou jen průsvitné (style.css, oddíl VZHLED).
 */
let backdropEl: HTMLElement | null = null;
function applyLook() {
  const root = document.documentElement;
  const glass = settings.look === 'glass';
  if (glass) root.setAttribute('data-look', 'glass');
  else root.removeAttribute('data-look');
  root.setAttribute('data-backdrop', settings.glassBackdrop);
  root.style.setProperty('--glass-k', String(Math.max(0, Math.min(100, settings.glassStrength)) / 100));
  // Průhledné okno: hlavní proces ho zapne jen na Windows 11 (Acrylic) - jinak zůstane barevné pozadí.
  if (glass && status?.windowGlass) root.setAttribute('data-window-glass', '1');
  else root.removeAttribute('data-window-glass');
  // Barvy podle obrazu (světlo kolem přehrávače, pozadí skla podle klipu) a pohyblivé barvy.
  if (settings.lookFollow) root.setAttribute('data-follow', '1');
  else root.removeAttribute('data-follow');
  if (glass && settings.lookMotion) root.setAttribute('data-motion', '1');
  else root.removeAttribute('data-motion');
  if (!backdropEl) {
    backdropEl = h('div', { class: 'app-backdrop', 'aria-hidden': 'true' });
    document.body.prepend(backdropEl);
    attachBackdrop(backdropEl);
  }
  // Než najedeš myší na nějaký klip, pozadí má barvy nejnovějšího.
  if (glass && settings.lookFollow && !hasFollowImage()) {
    const newest = clips.find((c) => c.thumb && !c.deletedAt);
    if (newest?.thumb) followImage(fileUrl(newest.thumb));
  }
}

function render() {
  applyBrandColor(document.documentElement, settings.brandColor || null);
  applyLook();
  const main = app.querySelector('.main');
  const scrollTop = main ? main.scrollTop : 0;
  const active = document.activeElement as HTMLElement | null;
  const searchHadFocus = focusSearch || (active?.classList.contains('clips-search') ?? false);
  // Pole, do kterého se zrovna píše (název vysílání, popis…): po překreslení
  // (stav chodí z hlavního procesu kdykoli) zůstane s kurzorem i rozepsaným textem.
  const keep = keptField(active);
  // Karta s náhledem se právě zahodí - video pustit z ruky, ať nehraje v odpojeném prvku.
  stopPreview();
  clear(app);
  if (wizardStep !== null) {
    app.append(h('div', { class: 'main' }, renderWizard()));
    syncKineView();
    return;
  }
  // Záložka Kine: web přes celé okno + úzká lišta dole, žádný postranní panel
  // (web má svůj vlastní - dva vedle sebe byly matoucí).
  const newMain =
    tab === 'kine'
      ? h('div', { class: 'main kine' }, renderKineTab(), renderKineBar())
      : h('div', { class: 'main' }, h('div', { class: `page ${tab === 'clips' ? 'wide' : ''}` }, renderTab()));
  if (tab !== 'kine') app.append(renderSide());
  syncRecTimer();
  syncAudioWatch();
  syncUsageWatch();
  app.append(newMain);
  newMain.scrollTop = scrollTop;
  syncKineView();
  if (searchHadFocus && tab === 'clips') {
    const input = newMain.querySelector('.clips-search') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  focusSearch = false;
  if (keep) restoreField(keep);
  syncCamPreview();
}

type KeptField = { key: string; value: string; start: number | null; end: number | null };

/** Pole s data-keep, ve kterém je kurzor - jeho hodnota a výběr pro obnovení po překreslení. */
function keptField(el: HTMLElement | null): KeptField | null {
  if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.dataset.keep) return null;
  let start: number | null = null;
  let end: number | null = null;
  try {
    start = el.selectionStart;
    end = el.selectionEnd;
  } catch {
    // typ pole bez výběru (number…)
  }
  return { key: el.dataset.keep, value: el.value, start, end };
}

function restoreField(k: KeptField) {
  const el = app.querySelector(`[data-keep="${k.key}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el || el.disabled) return;
  if (el.value !== k.value) el.value = k.value;
  el.focus();
  try {
    if (k.start !== null && k.end !== null) el.setSelectionRange(k.start, k.end);
  } catch {
    // nevadí
  }
}

/**
 * Text z pole do nastavení: hned v okně (překreslení ho nezahodí), do
 * hlavního procesu s malým zpožděním (ne každý stisk klávesy) a hned při
 * opuštění pole.
 */
const textSaveTimers = new Map<keyof Settings, ReturnType<typeof setTimeout>>();
function saveText<K extends keyof Settings>(field: K, value: Settings[K], now = false) {
  settings = { ...settings, [field]: value };
  const timer = textSaveTimers.get(field);
  if (timer) clearTimeout(timer);
  const send = () => {
    textSaveTimers.delete(field);
    void kine.updateSettings({ [field]: value } as Partial<Settings>);
  };
  if (now) send();
  else textSaveTimers.set(field, setTimeout(send, 700));
}

function clipsPlus(): boolean {
  return status.account?.clipsPlus === true;
}

/** Je zapnuté úsporné nastavení (720p / 30 fps / 5 Mb/s)? */
function recommendedActive(): boolean {
  return settings.maxHeight === 1080 && settings.fps === 60 && settings.videoMbps === 20;
}

function lowLoadActive(): boolean {
  return settings.maxHeight === 720 && settings.fps === 30 && settings.videoMbps <= 5;
}

function maxClip(): number {
  return status.account ? maxClipSecondsFor(status.account) : 60;
}

function plusLink(label?: string) {
  return h('button', { class: 'small quiet', onclick: () => void kine.openKine('/plus') }, label ?? t('plusLearnMore'));
}

function statusText(): { text: string; cls: string } {
  if (status.paused) return { text: t('trayPaused'), cls: '' };
  if (status.capture === 'error') return { text: status.captureError ?? 'error', cls: 'err' };
  if (status.capture === 'on' || status.capture === 'starting') {
    return { text: status.game ? t('trayCapturing', { game: status.game }) : t('trayCapturingNoGame'), cls: 'on' };
  }
  if (settings.detection === 'manual') return { text: t('trayIdleManual', { hotkey: hotkeyLabel(settings.toggleHotkey) }), cls: '' };
  if (settings.detection === 'always') return { text: t('trayIdleAlways'), cls: '' };
  return { text: t('trayIdle'), cls: '' };
}

/** Měřáky zvuku jsou vidět (Záznam, okno v popředí) -> ať chodí plynule; jinak jednou za sekundu. */
let audioWatched = false;
function syncAudioWatch() {
  const want = tab === 'settings' && wizardStep === null && document.visibilityState === 'visible';
  if (want === audioWatched) return;
  audioWatched = want;
  void kine.watchAudio(want);
}
document.addEventListener('visibilitychange', () => syncAudioWatch());

/** Kolik nahrávka zápasu zatím trvá ("12:34"); tiká každou sekundu bez překreslování celé stránky. */
function recordingTime(): string {
  if (!status.recordingSince) return '0:00';
  const s = Math.max(0, Math.floor((Date.now() - status.recordingSince) / 1000));
  const m = Math.floor(s / 60);
  const hrs = Math.floor(m / 60);
  return hrs > 0 ? `${hrs}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
let recTimer: ReturnType<typeof setInterval> | null = null;
function syncRecTimer() {
  const ticking = !!status.recordingSince || status.live.state === 'live';
  if (ticking && !recTimer) {
    recTimer = setInterval(() => {
      if (status.live.state === 'live') for (const el of app.querySelectorAll('.live-time')) el.textContent = liveElapsed(status.live.since);
      const el = app.querySelector('.rec-time');
      if (el) el.textContent = recordingTime();
    }, 1000);
  } else if (!ticking && recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
}

/** Ikony položek postranního panelu (čáry, currentColor) - ať se v seznamu dá rychle zorientovat. */
const TAB_ICONS: Record<Tab, string> = {
  kine: '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M10 8.3v5.4l4.8-2.7z" fill="currentColor" stroke="none"/>',
  clips: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  live: '<circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
  settings: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  games: '<path d="M7 8h10a4.5 4.5 0 0 1 4.5 4.5V15a2.6 2.6 0 0 1-4.7 1.5L15.4 14.5H8.6L7.2 16.5A2.6 2.6 0 0 1 2.5 15v-2.5A4.5 4.5 0 0 1 7 8z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11.2" r=".9" fill="currentColor" stroke="none"/><circle cx="17.5" cy="13" r=".9" fill="currentColor" stroke="none"/>',
  upload: '<path d="M12 15V5M8 9l4-4 4 4"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
};

function tabIcon(name: Tab): Element {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[name]}</svg>`;
  return tpl.content.firstElementChild!;
}

function tabButton(name: Tab) {
  return h(
    'button',
    {
      class: `tab ${tab === name ? 'active' : ''}`,
      'data-tab': name,
      onclick: () => {
        tab = name;
        render();
      },
    },
    tabIcon(name),
    h('span', { class: 'tab-label' }, t(TAB_KEYS[name])),
    name === 'clips' && clips.length > 0 ? h('span', { class: 'count' }, String(clips.length)) : null
  );
}

/**
 * Postranní panel: nahoře, co hráč používá (Kine, Klipy), pod hlavičkou
 * Nastavení zbytek; dole karta se stavem nahrávání, tlačítky "Uložit klip"
 * a "Pozastavit" a účtem.
 */
/** Tlačítko živého vysílání v panelu podle stavu. */
function liveButton(): HTMLElement {
  const live = status.live;
  if (live.state === 'idle') {
    return h('button', { class: 'small quiet side-live', title: t('liveDialogTitle'), onclick: () => { tab = 'live'; render(); } }, h('span', { class: 'live-dot' }), t('sideLive'));
  }
  if (live.state === 'starting') {
    return h('button', { class: 'small side-live pending', disabled: true }, h('span', { class: 'live-dot' }), t('sideLiveConnecting'));
  }
  if (live.state === 'stopping') {
    return h('button', { class: 'small side-live pending', disabled: true }, h('span', { class: 'spin' }), t('sideLiveStopping'));
  }
  const reconnecting = live.state === 'reconnecting';
  return h(
    'button',
    { class: `small side-live on ${reconnecting ? 'reconnecting' : ''} ${status.live.scene?.brb ? 'brb' : ''}`, title: live.title, onclick: (e: Event) => stopLiveClick(e) },
    h('span', { class: 'rec-dot' }),
    h('span', { class: 'live-time' }, reconnecting ? t('sideLiveReconnecting') : liveElapsed(live.since)),
    ' · ' + t('sideLiveStop')
  );
}

/** Ukončit vysílání: tlačítko hned zešedne ("Ukončuji…") - druhý klik nic nespustí. */
function stopLiveClick(e: Event) {
  const btn = e.currentTarget as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.remove('on');
  btn.classList.add('pending');
  clear(btn);
  btn.append(h('span', { class: 'spin' }), t('sideLiveStopping'));
  void kine.stopLive();
}

/** Řádek upozornění v panelu: text (klik = kde se to řeší) a křížek (schovat). */
function noticeRow(n: AppNotice) {
  const target = n.tab && visibleTabs().includes(n.tab as Tab) ? (n.tab as Tab) : null;
  return h(
    'div',
    { class: `side-sub side-notice ${n.kind}` },
    h(
      'button',
      {
        class: 'notice-text',
        title: n.text,
        onclick: () => {
          if (!target) return;
          tab = target;
          render();
        },
      },
      (n.kind === 'info' ? 'ℹ ' : '⚠ ') + n.text
    ),
    h('button', { class: 'notice-x', title: t('close'), 'aria-label': t('close'), onclick: () => void kine.dismissNotice(n.id) }, '✕')
  );
}

/** Stop nahrávání: tlačítko se hned přepne na "Ukládám…" a nejde zmáčknout znovu (dřív se nahrávka uložila víckrát). */
function stopRecordingClick(e: Event) {
  const btn = e.currentTarget as HTMLButtonElement;
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.remove('recording');
  btn.classList.add('saving');
  clear(btn);
  btn.append(h('span', { class: 'spin' }), t('sideRecordSaving'));
  void kine.toggleRecording();
}

/** Uloží nastavení bez překreslení - text psaný v poli se nesmí ztratit ani "sebrat" kliknutí na Vysílat. */
function saveQuiet(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  void kine.updateSettings(patch);
}

async function goLive() {
  if (liveStarting) return;
  liveStarting = true;
  liveError = null;
  // Rozepsaný název / popis se uloží hned, ať jde do vysílání.
  for (const [field, timer] of textSaveTimers) {
    clearTimeout(timer);
    textSaveTimers.delete(field);
    void kine.updateSettings({ [field]: settings[field] } as Partial<Settings>);
  }
  render();
  try {
    await kine.startLive({ title: settings.liveTitle || status.game || t('liveDefaultTitle'), quality: settings.liveQuality });
  } catch (e) {
    const message = cleanLiveError((e as Error).message ?? String(e));
    const key = liveErrorTextKey(message);
    liveError = t(key, key === 'liveErrOther' ? { message: message.slice(0, 160) } : {});
  } finally {
    liveStarting = false;
  }
  render();
}

/** Klik na Vysílat už běží (připojování) - druhý klik nic nespustí. */
let liveStarting = false;

// ---- kamera v záložce Živě: náhled a seznam kamer ----------------------------------------

/** Náhled kamery v okně (jen když je záložka Živě vidět a kamera zapnutá). */
let camPreview: { deviceId: string; stream: MediaStream | null; error: string | null } | null = null;
let videoInputs: { id: string; label: string }[] = [];
let videoInputsAt = 0;

async function refreshVideoInputs(force = false): Promise<void> {
  if (!force && Date.now() - videoInputsAt < 5000) return;
  videoInputsAt = Date.now();
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default');
    const next = list.map((d, i) => ({ id: d.deviceId, label: d.label || t('liveCameraN', { n: i + 1 }) }));
    if (JSON.stringify(next) !== JSON.stringify(videoInputs)) {
      videoInputs = next;
      scheduleRender();
    }
  } catch {
    // bez seznamu jen "výchozí kamera"
  }
}

/** Proč kamera nejde (stejné klíče jako snímací stránka - viz liveCompositor.cameraErrorText). */
function cameraErrorMessage(code: string): string {
  if (code.startsWith('camera-busy')) return t('liveCameraBusy');
  if (code.startsWith('camera-missing')) return t('liveCameraMissing');
  if (code.startsWith('camera-denied')) return t('liveCameraDenied');
  if (code.startsWith('camera-unsupported')) return t('liveCameraUnsupported');
  if (code.startsWith('camera disconnected')) return t('liveCameraDisconnected');
  return t('liveCameraFailed', { message: code.replace(/^camera:\s*/, '').slice(0, 120) });
}

function syncCamPreview() {
  const want = tab === 'live' && wizardStep === null && settings.liveCamera && document.visibilityState === 'visible';
  if (!want) {
    stopCamPreview();
    return;
  }
  const id = settings.liveCameraDevice;
  if (camPreview && camPreview.deviceId === id) return;
  stopCamPreview();
  const preview: { deviceId: string; stream: MediaStream | null; error: string | null } = { deviceId: id, stream: null, error: null };
  camPreview = preview;
  navigator.mediaDevices
    .getUserMedia({ audio: false, video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } } })
    .then(
      (stream) => {
        if (camPreview !== preview) {
          for (const tr of stream.getTracks()) tr.stop();
          return;
        }
        preview.stream = stream;
        void refreshVideoInputs(true);
        scheduleRender();
      },
      (e) => {
        if (camPreview !== preview) return;
        const name = (e as { name?: string })?.name ?? '';
        preview.error =
          name === 'NotReadableError' || name === 'TrackStartError'
            ? 'camera-busy'
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? 'camera-missing'
              : name === 'NotAllowedError'
                ? 'camera-denied'
                : `camera: ${String((e as Error)?.message ?? e)}`;
        scheduleRender();
      }
    );
}

function stopCamPreview() {
  for (const tr of camPreview?.stream?.getTracks() ?? []) tr.stop();
  camPreview = null;
}
document.addEventListener('visibilitychange', () => syncCamPreview());

/**
 * Náhled toho, co uvidí diváci: plocha 16:9 (hra) a kamera přesně tam a tak
 * velká, jak ji nakreslí vysílání (shared/liveLayout - stejná čísla), nebo
 * obrazovka "Hned jsem zpět".
 */
function livePreview() {
  const W = 1280;
  const H = 720;
  const brb = !!status.live.scene?.brb && status.live.state !== 'idle';
  const box = h('div', { class: `live-preview ${brb ? 'brb' : ''}` });
  if (brb) {
    box.append(h('div', { class: 'live-preview-brb' }, h('b', {}, settings.liveBrbText.trim() || t('liveBrbDefault')), h('span', { class: 'bar' })));
    return box;
  }
  box.append(h('div', { class: 'live-preview-game' }, h('span', {}, status.game ?? t('liveWhatPictureShort'))));
  if (!settings.liveCamera) return box;
  const track = camPreview?.stream?.getVideoTracks()[0] ?? null;
  const cs = track?.getSettings();
  const r = cameraRect(W, H, cs?.width ?? 1280, cs?.height ?? 720, { position: settings.liveCameraPosition, size: settings.liveCameraSize, shape: settings.liveCameraShape });
  const style = `left:${(r.x / W) * 100}%;top:${(r.y / H) * 100}%;width:${(r.w / W) * 100}%;height:${(r.h / H) * 100}%;border-radius:${settings.liveCameraShape === 'circle' ? '50%' : `${(r.radius / r.w) * 100}% / ${(r.radius / r.h) * 100}%`}`;
  const cam = h('div', { class: 'live-preview-cam', style });
  if (camPreview?.stream) {
    const video = h('video', { autoplay: '', muted: '', playsinline: '', class: settings.liveCameraMirror ? 'mirror' : '' }) as HTMLVideoElement;
    video.muted = true;
    video.srcObject = camPreview.stream;
    void video.play().catch(() => undefined);
    cam.append(video);
  } else {
    cam.append(h('span', { class: 'faint' }, camPreview?.error ? '⚠' : '…'));
  }
  box.append(cam);
  return box;
}

/** Rohy pro kameru jako čtyři tlačítka v obdélníku (kde bude kamera, je hned vidět). */
function cornerPicker(disabled: boolean) {
  const corners: { value: Settings['liveCameraPosition']; label: Key }[] = [
    { value: 'top-left', label: 'liveCameraTopLeft' },
    { value: 'top-right', label: 'liveCameraTopRight' },
    { value: 'bottom-left', label: 'liveCameraBottomLeft' },
    { value: 'bottom-right', label: 'liveCameraBottomRight' },
  ];
  return h(
    'div',
    { class: 'corner-picker', role: 'radiogroup', 'aria-label': t('liveCameraPosition') },
    ...corners.map((c) =>
      h('button', {
        class: `corner ${c.value} ${settings.liveCameraPosition === c.value ? 'active' : ''}`,
        role: 'radio',
        'aria-checked': settings.liveCameraPosition === c.value ? 'true' : 'false',
        title: t(c.label),
        'aria-label': t(c.label),
        disabled,
        onclick: () => update({ liveCameraPosition: c.value }),
      })
    )
  );
}

/** Záložka Živě: co a jak se vysílá na Kine + tlačítko Vysílat / stav vysílání, kamera, "Hned jsem zpět". */
/** Co se záznamem po skončení (nastavení na Kine): undefined = ještě se načítá, null = nepřihlášený / nejde načíst. */
let afterStream: LiveAfterStream | null | undefined;
let afterStreamLoadedAt = 0;
let afterStreamSaving = false;
let afterStreamFailed = false;
/** Karta skončeného vysílání: název a viditelnost záznamu (předvyplněné, hráč je může změnit). */
let endedForm: { at: number; title: string; visibility: Visibility } | null = null;

/** Nastavení "Po skončení vysílání" z Kine - při otevření záložky, nejvýš jednou za minutu. */
function loadAfterStream() {
  if (!status.account) {
    afterStream = null;
    afterStreamLoadedAt = 0;
    return;
  }
  if (Date.now() - afterStreamLoadedAt < 60_000) return;
  afterStreamLoadedAt = Date.now();
  void kine.liveAfterStream().then((r) => {
    afterStream = r;
    if (tab === 'live') render();
  });
}

function saveAfterStream(value: Visibility | null) {
  afterStreamSaving = true;
  afterStreamFailed = false;
  render();
  void kine
    .setLiveAfterStream(value)
    .then((r) => {
      if (r) afterStream = r;
      afterStreamLoadedAt = Date.now();
    })
    .catch(() => {
      afterStreamFailed = true;
    })
    .finally(() => {
      afterStreamSaving = false;
      render();
    });
}

/** Proč záznam nejde zveřejnit (podle odpovědi Kine). */
function endedErrorText(e: { status: number; message: string }): string {
  if (e.status === 404) return t('liveEndedNotYet');
  if (e.status === 409) return t('liveEndedStillLive');
  if (e.status === 401) return t('liveEndedLoginNeeded');
  return t('liveEndedFailed', { message: e.message || String(e.status) });
}

/**
 * Karta skončeného vysílání: záznam (Cloudflare ho nahrálo samo) jedním
 * klikem jako video na Kine - nebo odkaz, když se zveřejnil sám.
 */
function liveEndedCard(ended: LiveEnded) {
  // Vysílání viděli všichni - záznam je proto předvyplněný jako veřejný (jako na Twitchi), jde to změnit.
  if (!endedForm || endedForm.at !== ended.at) endedForm = { at: ended.at, title: ended.title, visibility: 'public' };
  const form = endedForm;
  const head = h(
    'div',
    { class: 'row', style: 'align-items:center' },
    h('h2', { class: 'grow', style: 'margin:0' }, '🎬 ' + t('liveEndedTitle', { duration: ended.duration })),
    h('button', { class: 'small quiet live-ended-close', title: t('close'), 'aria-label': t('close'), onclick: () => void kine.dismissLiveEnded() }, '✕')
  );
  const studio = h('button', { class: 'small quiet', onclick: () => void kine.openKine('/live') }, t('liveEndedStudio') + ' →');

  if (ended.video) {
    return h(
      'div',
      { class: 'panel stack live-ended published' },
      head,
      h('p', { class: 'ok', style: 'margin:0' }, '✓ ' + t(ended.video.auto ? 'liveEndedPublishedAuto' : 'liveEndedPublished')),
      ended.video.status === 'processing' ? h('p', { class: 'hint', style: 'margin:0' }, t('liveEndedProcessing')) : null,
      h('div', { class: 'row' }, h('button', { class: 'small primary live-ended-open', onclick: () => void kine.openLiveRecording() }, '▶ ' + t('liveEndedOpen')), studio)
    );
  }
  if (ended.autoPending) {
    return h('div', { class: 'panel stack live-ended' }, head, h('p', { class: 'hint', style: 'margin:0' }, h('span', { class: 'spin' }), t('liveEndedAutoPending')));
  }
  const canPublish = !!status.account && !ended.publishing;
  return h(
    'div',
    { class: 'panel stack live-ended' },
    head,
    h('p', { class: 'hint', style: 'margin:0' }, t('liveEndedRecordingHint')),
    h(
      'label',
      {},
      t('liveEndedVideoTitle'),
      h('input', {
        type: 'text',
        class: 'live-ended-title',
        'data-keep': 'live-ended-title',
        maxlength: '150',
        value: form.title,
        placeholder: t('liveDefaultTitle'),
        disabled: ended.publishing,
        oninput: (e: Event) => (form.title = (e.target as HTMLInputElement).value),
      })
    ),
    h(
      'div',
      { class: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' },
      h(
        'label',
        { style: 'min-width:200px' },
        t('liveEndedVisibility'),
        h(
          'select',
          { class: 'live-ended-visibility', disabled: ended.publishing, onchange: (e: Event) => (form.visibility = (e.target as HTMLSelectElement).value as Visibility) },
          ...VISIBILITIES.map((v) => h('option', { value: v, selected: form.visibility === v }, t(v === 'public' ? 'visibilityPublic' : v === 'subscribers' ? 'visibilitySubscribers' : 'visibilityPrivate')))
        )
      ),
      h(
        'button',
        {
          class: 'primary live-ended-publish',
          disabled: !canPublish,
          onclick: () => void kine.publishLiveRecording({ title: form.title.trim() || ended.title, visibility: form.visibility }),
        },
        ended.publishing ? h('span', { class: 'spin' }) : '⬆ ',
        ended.publishing ? t('liveEndedPublishing') : t('liveEndedPublish')
      )
    ),
    !status.account ? h('p', { class: 'hint warn-text', style: 'margin:0' }, t('liveEndedLoginNeeded')) : null,
    ended.error ? h('p', { class: 'hint warn-text live-ended-error', style: 'margin:0' }, endedErrorText(ended.error)) : null,
    h('div', {}, studio)
  );
}

/** Chat v okně a co se záznamem po skončení. */
function liveChatRecordingPanel() {
  loadAfterStream();
  const value = afterStream?.value ?? null;
  const unsupported = afterStream?.supported === false;
  return h(
    'div',
    { class: 'panel stack live-chat-panel' },
    h('h2', { style: 'margin:0' }, '💬 ' + t('liveSecChatRec')),
    h('p', { class: 'hint', style: 'margin:0' }, t('liveChatWindowHint')),
    h(
      'div',
      { class: 'row', style: 'align-items:center;gap:14px;flex-wrap:wrap' },
      h('button', { class: 'small live-chat-window', disabled: !status.account, onclick: () => void kine.openLiveChat() }, '🗨 ' + t('liveChatWindow')),
      checkbox('liveChatOnTop', t('liveChatOnTop'))
    ),
    // Podpory od diváků (💛) a jejich čtení nahlas - ikonka 🔊 přímo v okně chatu (web Kine).
    h('p', { class: 'hint live-chat-tts-hint', style: 'margin:0' }, t('liveChatTtsHint')),
    h(
      'label',
      { style: 'max-width:460px' },
      t('liveAfterStreamLabel'),
      h(
        'select',
        {
          class: 'live-after-stream',
          disabled: !status.account || afterStream === undefined || afterStreamSaving || unsupported,
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            saveAfterStream(v === 'ask' ? null : (v as Visibility));
          },
        },
        h('option', { value: 'ask', selected: value === null }, t('liveAfterStreamAsk')),
        h('option', { value: 'public', selected: value === 'public' }, t('liveAfterStreamPublic')),
        h('option', { value: 'subscribers', selected: value === 'subscribers' }, t('liveAfterStreamSubscribers')),
        h('option', { value: 'private', selected: value === 'private' }, t('liveAfterStreamPrivate'))
      ),
      h(
        'span',
        { class: `hint ${unsupported || afterStreamFailed ? 'warn-text' : ''}` },
        unsupported ? t('liveAfterStreamUnsupported') : afterStreamFailed ? t('liveAfterStreamSaveFailed') : t('liveAfterStreamHint')
      )
    )
  );
}

function renderLive() {
  const live = status.live;
  const idle = live.state === 'idle';
  const onAir = live.state === 'live' || live.state === 'reconnecting';
  const kbps = livePresetFor(settings.liveQuality, settings.liveBitrateKbps).videoKbps;
  const err = liveError ?? (idle ? live.error : null);
  if (settings.liveCamera) void refreshVideoInputs();

  // Nahoře: stav vysílání, nebo velké tlačítko Vysílat.
  let statusPanel: HTMLElement;
  if (idle) {
    statusPanel = h(
      'div',
      { class: 'panel stack live-panel' },
      h('p', { class: 'hint', style: 'margin:0' }, t('liveDialogIntro')),
      status.account
        ? null
        : h('p', { class: 'hint warn live-login' }, t('liveNeedLogin'), ' ', h('button', { class: 'small', onclick: () => { tab = 'account'; render(); } }, t('sideSignIn'))),
      err ? h('p', { class: 'hint warn live-error' }, err) : null,
      h(
        'div',
        { class: 'row live-actions' },
        h('button', { class: 'primary live-start', disabled: liveStarting, onclick: () => void goLive() }, liveStarting ? t('liveDialogStarting') : '● ' + t('liveDialogStart'))
      )
    );
  } else {
    const stats = live.stats;
    const slow = !!stats && ((stats.speed !== null && stats.speed < 0.92) || stats.backlogMb > 4);
    const brb = !!live.scene?.brb;
    const micMuted = !!live.scene?.micMuted;
    statusPanel = h(
      'div',
      { class: 'panel stack live-panel on-air' },
      h(
        'div',
        { class: 'row live-state' },
        live.state === 'stopping' ? h('span', { class: 'spin' }) : h('span', { class: 'rec-dot' }),
        h(
          'b',
          {},
          live.state === 'starting'
            ? t('sideLiveConnecting')
            : live.state === 'reconnecting'
              ? t('sideLiveReconnecting')
              : live.state === 'stopping'
                ? t('sideLiveStopping')
                : t('liveNow')
        ),
        onAir && live.since ? h('span', { class: 'live-time' }, liveElapsed(live.since)) : null,
        live.viewers !== null && onAir ? h('span', { class: 'live-viewers', title: t('liveViewersHint') }, '👁 ' + t('liveViewers', { count: live.viewers })) : null,
        h('span', { class: 'grow' }),
        live.watchUrl ? h('button', { class: 'small quiet', onclick: () => void kine.openLivePage() }, '💬 ' + t('sideLiveOpen')) : null,
        onAir ? h('button', { class: 'small quiet live-chat-window', onclick: () => void kine.openLiveChat() }, '🗨 ' + t('liveChatWindowShort')) : null,
        h('button', { class: 'small', disabled: live.state === 'starting' || live.state === 'stopping', onclick: (e: Event) => stopLiveClick(e) }, t('sideLiveStop'))
      ),
      onAir
        ? h(
            'div',
            { class: 'row live-controls' },
            h(
              'button',
              { class: `small live-brb-toggle ${brb ? 'active' : ''}`, 'aria-pressed': brb ? 'true' : 'false', title: settings.liveBrbHotkey ? hotkeyLabel(settings.liveBrbHotkey) : t('liveBrbHint'), onclick: () => void kine.liveBrb() },
              brb ? '▶ ' + t('liveBrbBack') : '⏸ ' + t('liveBrbOn')
            ),
            live.scene && (settings.liveMic && settings.microphone)
              ? h(
                  'button',
                  { class: `small live-mute ${micMuted ? 'active' : ''}`, 'aria-pressed': micMuted ? 'true' : 'false', onclick: () => void kine.liveMuteMic(!micMuted) },
                  micMuted ? '🔇 ' + t('liveMicUnmute') : '🎤 ' + t('liveMicMute')
                )
              : null
          )
        : null,
      stats && onAir
        ? h(
            'p',
            { class: `hint live-stats ${slow ? 'warn' : ''}`, style: 'margin:0' },
            [
              stats.kbps !== null ? t('liveStatsRate', { mbps: (Math.round(stats.kbps / 100) / 10).toLocaleString(settings.lang) }) : null,
              stats.fps !== null ? `${Math.round(stats.fps)} fps` : null,
              slow ? '⚠ ' + t('liveStatsSlow') : null,
            ]
              .filter(Boolean)
              .join(' · ')
          )
        : null,
      live.state === 'live' && live.confirmed !== null
        ? h(
            'p',
            { class: live.confirmed ? 'ok' : 'hint warn', style: 'margin:0' },
            live.confirmed
              ? '✓ ' + t('liveConfirmedOk')
              : // Kine nepotvrzený přenos po 3 minutách z "Živě" stáhne - po 90 s je čas to říct naplno.
                live.since !== null && Date.now() - live.since > 90_000
                ? t('liveConfirmedLong')
                : t('liveConfirmedWait')
          )
        : null,
      live.cameraError ? h('p', { class: 'hint warn', style: 'margin:0' }, '📷 ' + cameraErrorMessage(live.cameraError)) : null
    );
  }

  const locked = !idle; // název, kvalita a zvuk platí od dalšího vysílání; kamera a "Hned jsem zpět" jdou měnit i za běhu
  const micOff = !settings.microphone;
  const gameOff = !settings.systemAudio;

  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('tabLive')),
    statusPanel,
    // Po skončení vysílání: záznam na Kine (zveřejnit / otevřít).
    idle && live.ended ? liveEndedCard(live.ended) : null,

    h(
      'div',
      { class: 'panel stack' },
      h('h2', { style: 'margin:0' }, t('liveSecInfo')),
      h(
        'label',
        {},
        t('liveDialogName'),
        h('input', {
          type: 'text',
          class: 'live-title',
          'data-keep': 'live-title',
          maxlength: '100',
          value: settings.liveTitle,
          placeholder: status.game || t('liveDefaultTitle'),
          disabled: locked,
          oninput: (e: Event) => saveText('liveTitle', (e.target as HTMLInputElement).value),
          onchange: (e: Event) => saveText('liveTitle', (e.target as HTMLInputElement).value.trim(), true),
        })
      ),
      h(
        'label',
        {},
        t('liveDescriptionLabel'),
        h(
          'textarea',
          {
            class: 'live-description',
            'data-keep': 'live-description',
            rows: '3',
            maxlength: '2000',
            disabled: locked,
            oninput: (e: Event) => saveText('liveDescription', (e.target as HTMLTextAreaElement).value),
            onchange: (e: Event) => saveText('liveDescription', (e.target as HTMLTextAreaElement).value.trim(), true),
          },
          settings.liveDescription
        ),
        h('span', { class: 'hint' }, t('liveDescriptionHint'))
      ),
      h(
        'label',
        { style: 'max-width:280px' },
        t('liveCategoryLabel'),
        h(
          'select',
          { class: 'live-category', disabled: locked, onchange: (e: Event) => saveQuiet({ liveCategory: (e.target as HTMLSelectElement).value }) },
          ...CATEGORY_KEYS.map((key) => h('option', { value: key, selected: settings.liveCategory === key }, t(key)))
        )
      )
    ),

    liveChatRecordingPanel(),

    // Co diváci vidí: náhled (hra + kamera), kamera a její místo, tvar, velikost.
    h(
      'div',
      { class: 'panel stack live-scene-panel' },
      h('h2', { style: 'margin:0' }, t('liveSecWhat')),
      h(
        'div',
        { class: 'row' },
        h('p', { class: 'hint grow', style: 'margin:0' }, t('liveWhatPicture')),
        h('button', { class: 'small quiet', onclick: () => { tab = 'settings'; render(); } }, t('liveChangeCapture'))
      ),
      checkbox('liveGameAudio', t('liveGameAudio'), gameOff ? t('liveAudioOffInCapture') : undefined, locked),
      checkbox('liveMic', t('liveMicOn'), micOff ? t('liveAudioOffInCapture') : undefined, locked),
      h('div', { class: 'live-scene-grid' },
        livePreview(),
        h(
          'div',
          { class: 'stack live-camera-settings' },
          checkbox('liveCamera', '📷 ' + t('liveCamera'), t('liveCameraHint')),
          settings.liveCamera
            ? h(
                'div',
                { class: 'stack', style: 'gap:10px' },
                h(
                  'label',
                  {},
                  t('liveCameraDevice'),
                  h(
                    'select',
                    { class: 'live-camera-device', onchange: (e: Event) => update({ liveCameraDevice: (e.target as HTMLSelectElement).value }) },
                    h('option', { value: '', selected: settings.liveCameraDevice === '' }, t('liveCameraDefault')),
                    ...videoInputs.map((d) => h('option', { value: d.id, selected: settings.liveCameraDevice === d.id }, d.label)),
                    settings.liveCameraDevice && !videoInputs.some((d) => d.id === settings.liveCameraDevice)
                      ? h('option', { value: settings.liveCameraDevice, selected: true }, t('audioMissingDevice'))
                      : null
                  )
                ),
                h('div', { class: 'row', style: 'gap:14px;align-items:flex-start' },
                  h('div', { class: 'field' }, h('label', {}, t('liveCameraPosition')), cornerPicker(false)),
                  h(
                    'div',
                    { class: 'stack grow', style: 'gap:8px' },
                    h(
                      'label',
                      {},
                      t('liveCameraSize'),
                      h(
                        'select',
                        { class: 'live-camera-size', onchange: (e: Event) => update({ liveCameraSize: (e.target as HTMLSelectElement).value as Settings['liveCameraSize'] }) },
                        h('option', { value: 'small', selected: settings.liveCameraSize === 'small' }, t('liveCameraSmall')),
                        h('option', { value: 'medium', selected: settings.liveCameraSize === 'medium' }, t('liveCameraMedium')),
                        h('option', { value: 'large', selected: settings.liveCameraSize === 'large' }, t('liveCameraLarge'))
                      )
                    ),
                    h(
                      'label',
                      {},
                      t('liveCameraShape'),
                      h(
                        'select',
                        { class: 'live-camera-shape', onchange: (e: Event) => update({ liveCameraShape: (e.target as HTMLSelectElement).value as Settings['liveCameraShape'] }) },
                        h('option', { value: 'rounded', selected: settings.liveCameraShape === 'rounded' }, t('liveCameraRounded')),
                        h('option', { value: 'rect', selected: settings.liveCameraShape === 'rect' }, t('liveCameraRect')),
                        h('option', { value: 'circle', selected: settings.liveCameraShape === 'circle' }, t('liveCameraCircle'))
                      )
                    )
                  )
                ),
                checkbox('liveCameraMirror', t('liveCameraMirror'), t('liveCameraMirrorHint')),
                camPreview?.error ? h('p', { class: 'hint warn', style: 'margin:0' }, '⚠ ' + cameraErrorMessage(camPreview.error)) : null
              )
            : null
        )
      )
    ),

    // "Hned jsem zpět": soukromí a pauza během vysílání (hra i kamera se schovají).
    h(
      'div',
      { class: 'panel stack' },
      h('h2', { style: 'margin:0' }, '⏸ ' + t('liveBrbTitle')),
      h('p', { class: 'hint', style: 'margin:0' }, t('liveBrbIntro')),
      h(
        'label',
        {},
        t('liveBrbTextLabel'),
        h('input', {
          type: 'text',
          class: 'live-brb-text',
          'data-keep': 'live-brb-text',
          maxlength: '80',
          value: settings.liveBrbText,
          placeholder: t('liveBrbDefault'),
          oninput: (e: Event) => saveText('liveBrbText', (e.target as HTMLInputElement).value),
          onchange: (e: Event) => saveText('liveBrbText', (e.target as HTMLInputElement).value.trim(), true),
        })
      ),
      checkbox('liveBrbMuteMic', t('liveBrbMuteMic')),
      hotkeyField('liveBrbHotkey', t('liveBrbHotkey'), t('liveBrbHotkeyHint'), { clearable: true })
    ),

    h(
      'div',
      { class: 'panel stack' },
      h('h2', { style: 'margin:0' }, t('liveSecHow')),
      h(
        'div',
        { class: 'row', style: 'gap:12px;align-items:flex-end' },
        h(
          'label',
          { class: 'grow' },
          t('liveDialogQuality'),
          h(
            'select',
            { class: 'live-quality', disabled: locked, onchange: (e: Event) => update({ liveQuality: (e.target as HTMLSelectElement).value as LiveQuality }) },
            ...LIVE_QUALITIES.map((q) => h('option', { value: q, selected: settings.liveQuality === q }, livePresetLabel(q)))
          )
        ),
        h(
          'label',
          { class: 'grow' },
          t('liveBitrateLabel'),
          h(
            'select',
            { class: 'live-bitrate', disabled: locked, onchange: (e: Event) => update({ liveBitrateKbps: Number((e.target as HTMLSelectElement).value) }) },
            h('option', { value: '0', selected: settings.liveBitrateKbps === 0 }, t('liveBitrateAuto')),
            ...LIVE_BITRATES_KBPS.map((k) => h('option', { value: String(k), selected: settings.liveBitrateKbps === k }, `${k / 1000} Mb/s`))
          )
        )
      ),
      h('p', { class: 'hint', style: 'margin:0' }, t('liveDialogQualityHint') + ' ' + t('liveUploadNeed', { mbps: liveUploadMbps(kbps) })),
      checkbox('liveOpenPage', t('liveOpenPage'))
    ),

    h('div', {}, h('button', { class: 'small quiet live-studio', onclick: () => void kine.openKine('/live') }, t('liveDialogStudio') + ' →'))
  );
}

function renderSide() {
  const st = statusText();
  const tabs = visibleTabs();
  const top = tabs.filter((x) => x === 'kine' || x === 'clips' || x === 'live');
  const rest = tabs.filter((x) => x !== 'kine' && x !== 'clips' && x !== 'live');
  const capturing = status.capture === 'on';
  const manual = settings.detection === 'manual';
  const account = status.account;
  const goAccount = () => {
    tab = 'account';
    render();
  };

  const pauseBtn = manual
    ? h('button', { class: 'small quiet side-pause', onclick: () => void kine.toggleCapture() }, capturing || status.capture === 'starting' ? t('sideBufferOff') : t('sideBufferOn'))
    : h('button', { class: 'small quiet side-pause', onclick: () => void kine.togglePause() }, status.paused ? '▶ ' + t('sideResume') : '❚❚ ' + t('sidePause'));

  return h(
    'nav',
    { class: 'side' },
    h(
      'div',
      { class: 'brand-wrap' },
      h('div', { class: 'brand', role: 'button', tabindex: '0', title: t('brandColorHint'), onclick: onBrandClick }, brandMark(), 'Kine', brandTag()),
      colorPickerOpen ? colorPicker() : null
    ),
    h(
      'div',
      { class: 'side-nav' },
      ...top.map(tabButton),
      h('div', { class: 'side-section' }, t('sideSettings')),
      ...rest.map(tabButton)
    ),
    h(
      'div',
      { class: 'side-status' },
      h('div', { class: 'side-state' }, h('span', { class: `dot ${st.cls}` }), h('b', {}, st.text)),
      !status.paused && status.capture !== 'error'
        ? h('div', { class: 'side-sub' }, t('sideBufferInfo', { seconds: Math.min(settings.clipSeconds, maxClip()), hotkey: hotkeyLabel(settings.clipHotkey) }))
        : null,
      status.uploadsPending > 0
        ? h('div', { class: 'side-sub' }, status.uploadsPaused ? t('trayUploadsPaused', { count: status.uploadsPending }) : t('trayUploads', { count: status.uploadsPending }))
        : null,
      // Na baterii se nahrává úsporně (720p30) - ať hráč ví, proč je klip menší.
      status.batterySaverActive ? h('div', { class: 'side-sub', title: t('batterySaverHint') }, '🔋 ' + t('sideBatterySaver')) : null,
      // Aktualizace: stahuje se (procenta) / stažená - klik vede do O appce (tam je "Aktualizovat teď").
      status.update?.phase === 'downloading'
        ? h('button', { class: 'side-sub side-update', onclick: () => { tab = 'about'; render(); } }, '⬇ ' + t('sideUpdateDownloading', { percent: status.update.percent ?? 0 }))
        : status.update?.phase === 'ready'
          ? h('button', { class: 'side-sub side-update ready', onclick: () => { tab = 'about'; render(); } }, '⬆ ' + t('sideUpdateReady', { version: status.update.version ?? '' }))
          : null,
      // Upozornění, která appka neukázala okénkem (zkratka nejde, mikrofon…) - klik vede tam, kde se to řeší.
      ...status.notices.map((n) => noticeRow(n)),
      // Hra běží, ale zvuk hry je ticho - nejčastěji hraje do jiného zařízení, než Windows nahrává.
      capturing && status.game && audioLevels && audioLevels.system !== null && audioLevels.systemSilentSeconds >= 10 && !status.notices.some((n) => n.id === 'audio-silent')
        ? h('button', { class: 'side-sub warn side-audio-warn', onclick: () => { tab = 'settings'; render(); } }, '⚠ ' + t('sideAudioSilent'))
        : null,
      h(
        'div',
        { class: 'side-actions' },
        h(
          'button',
          { class: `small primary side-clip ${status.clipsSaving > 0 ? 'saving' : ''}`, disabled: !capturing, title: hotkeyLabel(settings.clipHotkey), onclick: () => void kine.clipNow() },
          status.clipsSaving > 0 ? h('span', { class: 'spin' }) : '● ',
          status.clipsSaving > 0 ? t('sideClipSaving') : t('sideSaveClip')
        ),
        pauseBtn
      ),
      // Nahrávání celého zápasu: start, nebo běžící čas + stop; po stopu hned "Ukládám…" (a nejde zmáčknout znovu).
      h(
        'div',
        { class: 'side-actions' },
        status.recordingSaving
          ? h(
              'button',
              { class: 'small side-record saving', disabled: true, title: t('sideRecordSavingHint') },
              h('span', { class: 'spin' }),
              status.recordingSaving.percent !== null && status.recordingSaving.percent > 0
                ? t('sideRecordSavingPercent', { percent: status.recordingSaving.percent })
                : t('sideRecordSaving')
            )
          : status.recordingSince
            ? h(
                'button',
                { class: 'small side-record recording', title: settings.recordHotkey ? hotkeyLabel(settings.recordHotkey) : '', onclick: (e: Event) => stopRecordingClick(e) },
                h('span', { class: 'rec-dot' }),
                h('span', { class: 'rec-time' }, recordingTime()),
                ' · ' + t('sideRecordStop')
              )
            : h(
                'button',
                { class: 'small quiet side-record', disabled: !capturing, title: settings.recordHotkey ? hotkeyLabel(settings.recordHotkey) : '', onclick: () => void kine.toggleRecording() },
                '⏺ ' + t('sideRecord')
              ),
        // Snímek obrazovky jde vždycky (i bez hry a zásobníku).
        h(
          'button',
          { class: 'small quiet side-shot', title: settings.screenshotHotkey ? `${t('screenshotHotkey')} (${hotkeyLabel(settings.screenshotHotkey)})` : t('screenshotHotkey'), onclick: () => void kine.takeScreenshot() },
          '📷'
        )
      ),
      // Živé vysílání na Kine: dialog, pak čas vysílání + Ukončit; pod tím stránka vysílání s chatem.
      h('div', { class: 'side-actions' }, liveButton()),
      status.live.state !== 'idle' && status.live.watchUrl
        ? h('button', { class: 'side-sub side-live-open', onclick: () => void kine.openLivePage() }, '💬 ' + t('sideLiveOpen'))
        : null,
      account
        ? h(
            'button',
            { class: 'side-account', onclick: goAccount, title: t('tabAccount') },
            h('span', { class: 'avatar' }, account.username.slice(0, 1).toUpperCase()),
            h('span', { class: 'who' }, `@${account.username}`),
            account.plan !== 'free' ? h('span', { class: 'plan-pill' }, 'PLUS') : null
          )
        : h('button', { class: 'side-account', onclick: goAccount }, h('span', { class: 'avatar guest' }, '?'), h('span', { class: 'who dim' }, t('sideSignIn')))
    )
  );
}

/**
 * Lišta pod webem Kine: stav nahrávání (tečka + text), nahrávání na Kine,
 * potíže se zkratkami a dvě tlačítka zpátky do appky - Klipy (s počtem)
 * a Nastavení. Nic víc; zbytek okna patří webu.
 */
function renderKineBar() {
  const st = statusText();
  const go = (target: Tab) => () => {
    tab = target;
    render();
  };
  return h(
    'div',
    { class: 'kine-bar' },
    h('span', { class: 'bar-status' }, h('span', { class: `dot ${st.cls}` }), h('b', {}, st.text)),
    status.uploadsPending > 0
      ? h('span', { class: 'bar-item' }, status.uploadsPaused ? t('trayUploadsPaused', { count: status.uploadsPending }) : t('trayUploads', { count: status.uploadsPending }))
      : null,
    ...status.notices.filter((n) => n.kind !== 'info').map((n) => h('span', { class: 'bar-item warn', title: n.text }, '⚠ ', n.text)),
    status.recordingSaving ? h('span', { class: 'bar-item' }, h('span', { class: 'spin' }), t('sideRecordSaving')) : null,
    h('span', { class: 'grow' }),
    // Během vysílání: čas a Ukončit i nad webem (chat je na stránce vysílání v okně).
    status.live.state === 'live' || status.live.state === 'reconnecting'
      ? h('span', { class: 'side-actions bar-live' }, liveButton())
      : null,
    h('button', { class: 'small quiet', onclick: go('clips') }, clips.length > 0 ? t('barClipsCount', { count: clips.length }) : t('tabClips')),
    h('button', { class: 'small quiet', onclick: go('settings') }, t('tabSettings'))
  );
}

/** Záložka Kine: prázdná plocha, přes kterou hlavní proces položí web (syncKineView). */
function renderKineTab() {
  return h(
    'div',
    { class: 'kine-host' },
    h(
      'div',
      { class: 'kine-fallback' },
      h('p', { class: 'dim' }, t('kineViewHint')),
      kineFailed ? h('p', { class: 'error' }, kineFailed) : null,
      h('button', { class: 'small quiet', onclick: () => { kineFailed = null; void kine.kineViewReload(); } }, t('kineReload'))
    )
  );
}

function renderTab() {
  switch (tab) {
    case 'kine':
      return renderKineTab();
    case 'clips':
      return renderClips();
    case 'live':
      return renderLive();
    case 'settings':
      return renderSettings();
    case 'games':
      return renderGames();
    case 'upload':
      return renderUpload();
    case 'account':
      return renderAccount();
    case 'about':
      return renderAbout();
  }
}

// ---- účet ---------------------------------------------------------------------------

function planName(): string {
  const a = status.account;
  if (!a) return t('planFree');
  const base = a.plan === 'kine' ? t('planKine') : a.plan === 'clips' ? t('planClips') : a.plan === 'all' || a.plan === 'plus' ? t('planAll') : t('planFree');
  if (a.plan !== 'free' && a.planUntil) return t('planUntil', { plan: base, date: formatDate(a.planUntil, settings.lang) });
  return base;
}

function renderAccount(inWizard = false) {
  const account = status.account;
  const container = h('div', { class: 'stack' });
  if (!inWizard) container.append(h('h1', {}, t('accountTitle')));

  if (account) {
    const paid = account.plan !== 'free';
    const hint = account.clipsPlus ? t('planClipsHint', { max: account.maxClipSeconds }) : account.kinePlus ? t('planKineHint') : t('planFreeHint', { max: account.maxClipSeconds });
    container.append(
      h(
        'div',
        { class: 'panel spread' },
        h('div', {}, h('div', {}, t('accountLoggedIn', { username: '@' + account.username })), account.email ? h('div', { class: 'faint' }, account.email) : null),
        h('button', { onclick: () => void kine.logout() }, t('accountLogout'))
      ),
      h(
        'div',
        { class: 'panel stack' },
        h(
          'div',
          { class: 'spread' },
          h('div', { class: 'row' }, paid ? h('span', { class: 'plan-pill' }, 'PLUS') : null, h('b', {}, planName())),
          plusLink()
        ),
        h('p', { class: 'hint', style: 'margin:0' }, hint)
      )
    );
  } else {
    const email = h('input', { type: 'email', autocomplete: 'username' }) as HTMLInputElement;
    const password = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
    const loginBtn = h('button', { class: 'primary' }, t('accountLogin')) as HTMLButtonElement;
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: Event) => {
          e.preventDefault();
          loginBtn.disabled = true;
          loginBtn.textContent = t('accountLoggingIn');
          authError = null;
          void kine
            .loginPassword(email.value, password.value)
            .catch((err: Error) => {
              authError = t('accountLoginFailed', { message: errorText(err, t) });
            })
            .finally(() => render());
        },
      },
      h('label', {}, t('accountEmail'), email),
      h('label', {}, t('accountPassword'), password),
      h('div', { class: 'row' }, loginBtn)
    );
    container.append(
      h('p', { class: 'dim' }, t('accountNotLoggedIn')),
      h(
        'div',
        { class: 'panel stack' },
        authWaiting
          ? h(
              'div',
              { class: 'row' },
              h('span', { class: 'ok' }, t('accountWaitingBrowser')),
              h('button', { class: 'small quiet', onclick: () => void kine.cancelBrowserLogin() }, t('cancel'))
            )
          : h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'primary',
                  onclick: () => {
                    authError = null;
                    void kine.loginBrowser().catch((err: Error) => {
                      authError = t('accountLinkFailed', { message: errorText(err, t) });
                      render();
                    });
                  },
                },
                t('accountConnectBrowser')
              ),
              h('span', { class: 'faint' }, t('accountConnectBrowserHint'))
            ),
        h('h2', {}, t('accountOrPassword')),
        form,
        authError ? h('p', { class: 'error' }, authError) : null
      )
    );
  }

  if (!inWizard) {
    const url = h('input', { type: 'url', value: settings.siteUrl }) as HTMLInputElement;
    url.addEventListener('blur', () => {
      if (url.value.trim() && url.value.trim() !== settings.siteUrl) update({ siteUrl: url.value.trim() });
    });
    container.append(
      h('details', {}, h('summary', { class: 'faint', style: 'cursor:pointer' }, t('accountSiteUrl')), h('div', { class: 'panel', style: 'margin-top:10px' }, h('label', {}, t('accountSiteUrl'), url), h('p', { class: 'hint' }, t('accountSiteUrlHint'))))
    );
  }
  return container;
}

// ---- nastavení (zkratky, kvalita, režim) ------------------------------------------------

function languageSelect(big = false) {
  return h(
    'select',
    { style: big ? '' : 'width:auto', onchange: (e: Event) => update({ lang: (e.target as HTMLSelectElement).value as Lang }) },
    ...LANGS.map((code) => h('option', { value: code, selected: settings.lang === code }, LANG_NAMES[code]))
  );
}

/**
 * Která appka to je: Kine do PC (Kine + klipovač) nebo Kine Clipper (jen
 * klipovač). Nepřepíná se - jsou to dvě různé appky; tady je jen odkaz na
 * tu druhou.
 */
function variantPanel() {
  const clipper = status.variant === 'clipper';
  return h(
    'div',
    { class: 'panel stack' },
    h('h2', {}, t('variantTitle')),
    h(
      'div',
      { class: 'row', style: 'gap:12px;align-items:flex-start' },
      h('span', { class: 'app-icon' }, appIconSvg(clipper, 44)),
      h(
        'div',
        { class: 'grow' },
        h('div', { style: 'font-weight:600' }, clipper ? t('variantClipperName') : t('variantFullName')),
        h('p', { class: 'hint' }, clipper ? t('variantClipperText') : t('variantFullText'))
      )
    ),
    h('div', {}, h('button', { class: 'small quiet', onclick: () => void kine.openKine('/download') }, clipper ? t('variantGetFull') : t('variantGetClipper')))
  );
}

function renderSettings() {
  const limit = maxClip();
  const seconds = Math.min(settings.clipSeconds, limit);
  const secondsOptions = [...clipOptionsFor(status.account?.plan)].filter((n) => n <= limit) as number[];
  if (!secondsOptions.includes(seconds)) secondsOptions.push(seconds);
  secondsOptions.sort((a, b) => a - b);
  const win = kine.platform === 'win32';

  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('settingsTitle')),
    h(
      'div',
      { class: 'panel stack' },
      h('h2', {}, t('hotkeysTitle')),
      hotkeyField('clipHotkey', t('clipHotkey'), t('clipHotkeyHint')),
      hotkeyField('toggleHotkey', t('toggleHotkey')),
      hotkeyField('recordHotkey', '⏺ ' + t('recordHotkey'), t('recordHotkeyHint'), { clearable: true }),
      hotkeyField('screenshotHotkey', '📷 ' + t('screenshotHotkey'), t('screenshotHotkeyHint'), { clearable: true }),
      win ? h('p', { class: 'hint' }, '🎮 ' + t('hotkeyPadHint')) : null,
      win && !status.chordsSupported ? h('p', { class: 'hint warn' }, t('hotkeyHelperDown')) : null,
      !win ? h('p', { class: 'hint' }, t('hotkeyChordUnsupported')) : null,
      h(
        'div',
        { class: 'field' },
        h('label', {}, t('clipSeconds')),
        h(
          'div',
          { class: 'row' },
          h(
            'select',
            { style: 'width:auto', onchange: (e: Event) => update({ clipSeconds: Number((e.target as HTMLSelectElement).value) }) },
            ...secondsOptions.map((n) => h('option', { value: String(n), selected: n === seconds }, `${n} s`))
          ),
          h('input', {
            type: 'number',
            min: '5',
            max: String(limit),
            value: String(seconds),
            style: 'width:90px',
            onchange: (e: Event) => update({ clipSeconds: Math.min(limit, Number((e.target as HTMLInputElement).value)) }),
          })
        ),
        h('p', { class: 'hint' }, t('clipSecondsHint') + ' ' + (clipsPlus() ? t('clipSecondsPlusHint', { max: limit }) : t('clipSecondsFreeHint', { max: limit }))),
        clipsPlus() ? null : h('div', {}, plusLink())
      )
    ),
    performancePanel(),
    h(
      'div',
      { class: 'panel stack' },
      h(
        'div',
        { class: 'spread' },
        h('h2', { style: 'margin:0' }, t('qualityTitle')),
        h(
          'div',
          { class: 'row', style: 'gap:6px' },
          // Doporučená kvalita pro hry (plynulý obraz, žádné kostičky) - s kódováním na grafice skoro nic nestojí.
          h(
            'button',
            {
              class: `small quality-recommended ${recommendedActive() ? 'quiet' : ''}`,
              disabled: recommendedActive(),
              onclick: () => update({ maxHeight: 1080, fps: 60, videoMbps: 20 }),
            },
            '⚡ ' + t('recommendedPreset')
          ),
          // Jedním klikem nejúspornější nastavení - pro slabší PC nebo když hra při nahrávání trhá.
          h(
            'button',
            {
              class: `small ${lowLoadActive() ? 'quiet' : ''}`,
              disabled: lowLoadActive(),
              onclick: () => update({ maxHeight: 720, fps: 30, videoMbps: 5 }),
            },
            '🍃 ' + t('lowLoadPreset')
          )
        )
      ),
      h('p', { class: 'hint', style: 'margin-top:-4px' }, t('lowLoadHint')),
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          { class: 'grow' },
          t('maxHeight'),
          h(
            'select',
            { onchange: (e: Event) => update({ maxHeight: Number((e.target as HTMLSelectElement).value) as Settings['maxHeight'] }) },
            h('option', { value: '720', selected: settings.maxHeight === 720 }, '720p'),
            h('option', { value: '1080', selected: settings.maxHeight === 1080 }, '1080p'),
            h('option', { value: '1440', selected: settings.maxHeight === 1440 }, '1440p'),
            h('option', { value: '0', selected: settings.maxHeight === 0 }, t('maxHeightSource'))
          )
        ),
        h(
          'label',
          { class: 'grow' },
          t('fps'),
          h(
            'select',
            { onchange: (e: Event) => update({ fps: Number((e.target as HTMLSelectElement).value) as Settings['fps'] }) },
            h('option', { value: '30', selected: settings.fps === 30 }, '30'),
            h('option', { value: '60', selected: settings.fps === 60 }, '60')
          )
        ),
        h(
          'label',
          { class: 'grow' },
          t('videoMbps'),
          h('input', {
            type: 'number',
            min: '1',
            max: '50',
            step: '1',
            value: String(settings.videoMbps),
            onchange: (e: Event) => update({ videoMbps: Number((e.target as HTMLInputElement).value) }),
          })
        )
      ),
      h('p', { class: 'hint' }, t('videoMbpsHint', { mbps: suggestedMbps(settings.maxHeight, settings.fps) })),
      // Kdo kóduje: grafika (skoro zadarmo) / procesor (náročné - appka pak nahrává nejvýš 30 fps).
      h(
        'p',
        { class: `hint encoder-status ${status.hwEncoder === false ? 'warn-text' : status.hwEncoder ? 'ok' : ''}`, style: 'margin:0' },
        status.hwEncoder === true ? '✓ ' + t('encoderHardware') : status.hwEncoder === false ? '⚠ ' + t('encoderSoftware') : t('encoderUnknown')
      ),
      checkbox('batterySaver', '🔋 ' + t('batterySaver'), t('batterySaverHint')),
      h(
        'label',
        {},
        t('codec'),
        h(
          'select',
          { onchange: (e: Event) => update({ codec: (e.target as HTMLSelectElement).value as Settings['codec'] }) },
          h('option', { value: 'auto', selected: settings.codec === 'auto' }, t('codecAuto')),
          h('option', { value: 'h264', selected: settings.codec === 'h264' }, 'H.264 (mp4)'),
          h('option', { value: 'vp9', selected: settings.codec === 'vp9' }, 'VP9 (webm)'),
          h('option', { value: 'vp8', selected: settings.codec === 'vp8' }, 'VP8 (webm)')
        )
      ),
      h('p', { class: 'hint' }, t('codecHint')),
      h(
        'label',
        {},
        t('display'),
        h(
          'select',
          { onchange: (e: Event) => update({ displayId: (e.target as HTMLSelectElement).value }) },
          h('option', { value: '', selected: settings.displayId === '' }, t('displayPrimary')),
          ...displays.map((d) => h('option', { value: d.id, selected: settings.displayId === d.id }, d.label))
        )
      )
    ),
    audioPanel(win),
    h(
      'div',
      { class: 'panel stack' },
      h('label', {}, t('clipsDir')),
      h(
        'div',
        { class: 'row' },
        h('code', { class: 'grow faint', style: 'word-break:break-all' }, settings.clipsDir || '…/Videos/Kine'),
        h('button', { class: 'small', onclick: () => void kine.pickClipsDir() }, t('clipsDirChange')),
        h('button', { class: 'small', onclick: () => void kine.openClipsDir() }, t('clipsDirOpen'))
      ),
      storageRows(),
      // Strop místa: nejstarší klipy (kromě oblíbených a čerstvých) se smažou samy.
      h(
        'label',
        { style: 'max-width:360px' },
        t('storageLimit'),
        h(
          'select',
          { class: 'storage-limit', onchange: (e: Event) => update({ storageLimitGb: Number((e.target as HTMLSelectElement).value) }) },
          ...STORAGE_LIMITS_GB.map((gb) => h('option', { value: String(gb), selected: settings.storageLimitGb === gb }, gb === 0 ? t('storageLimitOff') : `${gb} GB`))
        ),
        h('span', { class: 'sub hint', style: 'margin-top:4px;display:block' }, t('storageLimitHint'))
      ),
      checkbox('toast', t('toastSetting'), t('toastSettingHint')),
      checkbox('clipSound', t('clipSoundSetting'), t('clipSoundHint'))
    ),
    variantPanel(),
    h(
      'div',
      { class: 'panel stack' },
      h('h2', {}, t('generalTitle')),
      h('label', {}, t('language'), languageSelect()),
      checkbox('startWithSystem', t('startWithSystem'), t('startWithSystemHint')),
      // Po spuštění appky: nahrávat hned / počkat na hru / nic, dokud to hráč nezapne.
      h(
        'label',
        { style: 'max-width:460px' },
        t('launchCapture'),
        h(
          'select',
          { class: 'launch-capture', onchange: (e: Event) => update({ launchCapture: (e.target as HTMLSelectElement).value as Settings['launchCapture'] }) },
          h('option', { value: 'auto', selected: settings.launchCapture === 'auto' }, t('launchCaptureAuto')),
          h('option', { value: 'game', selected: settings.launchCapture === 'game' }, t('launchCaptureGame')),
          h('option', { value: 'paused', selected: settings.launchCapture === 'paused' }, t('launchCapturePaused'))
        ),
        h('span', { class: 'sub hint', style: 'margin-top:4px;display:block' }, t('launchCaptureHint'))
      ),
      h('p', { class: 'hint', style: 'margin:0' }, t('brandColorHint'))
    ),
    appearancePanel()
  );
}

// ---- vzhled ---------------------------------------------------------------------------

const GLASS_BACKDROP_LABELS: Record<GlassBackdrop, Key> = {
  brand: 'lookBackdropBrand',
  night: 'lookBackdropNight',
  sunset: 'lookBackdropSunset',
  forest: 'lookBackdropForest',
  ocean: 'lookBackdropOcean',
  neon: 'lookBackdropNeon',
};

/**
 * Vzhled: klasický nebo sklo (průhledné plochy nad barevným pozadím jako
 * upravený Spotify), barvy pozadí, síla skla, na Windows 11 průhledné
 * okno (prosvítá plocha za appkou) a barva appky.
 */
function appearancePanel() {
  const glass = settings.look === 'glass';
  const lookCard = (look: Settings['look'], title: string, hint: string) =>
    h(
      'button',
      { class: `look-option ${settings.look === look ? 'active' : ''}`, role: 'radio', 'aria-checked': settings.look === look ? 'true' : 'false', onclick: () => update({ look }) },
      h('span', { class: `look-preview ${look === 'glass' ? 'glass' : ''}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
      h('b', {}, title),
      h('span', { class: 'hint', style: 'margin:0' }, hint)
    );
  const custom = h('input', {
    type: 'color',
    class: 'color-input',
    value: settings.brandColor || '#00c9a7',
    title: t('brandColorCustom'),
    onchange: (e: Event) => pickColor((e.target as HTMLInputElement).value),
  });
  return h(
    'div',
    { class: 'panel stack appearance-panel' },
    h('h2', {}, t('lookTitle')),
    h('div', { class: 'look-options', role: 'radiogroup', 'aria-label': t('lookTitle') }, lookCard('classic', t('lookClassic'), t('lookClassicHint')), lookCard('glass', t('lookGlass'), t('lookGlassHint'))),
    glass
      ? h(
          'div',
          { class: 'stack', style: 'gap:12px' },
          h(
            'div',
            {},
            h('div', { class: 'faint', style: 'margin-bottom:8px' }, t('lookBackdrop')),
            h(
              'div',
              { class: 'look-backdrops', role: 'radiogroup', 'aria-label': t('lookBackdrop') },
              ...GLASS_BACKDROPS.map((b) =>
                h(
                  'button',
                  { class: `look-chip ${settings.glassBackdrop === b ? 'active' : ''}`, role: 'radio', 'aria-checked': settings.glassBackdrop === b ? 'true' : 'false', onclick: () => update({ glassBackdrop: b }) },
                  h('span', { class: `look-swatch ${b}`, 'aria-hidden': 'true' }),
                  t(GLASS_BACKDROP_LABELS[b])
                )
              )
            )
          ),
          h(
            'label',
            { class: 'look-range' },
            h('span', { class: 'faint' }, t('lookStrength')),
            h(
              'div',
              { class: 'row', style: 'flex-wrap:nowrap' },
              h('span', { class: 'faint' }, t('lookStrengthLow')),
              h('input', {
                type: 'range',
                min: '0',
                max: '100',
                step: '5',
                value: String(settings.glassStrength),
                class: 'grow look-strength',
                // Posuvník mění vzhled hned (bez čekání na hlavní proces), uloží se po puštění.
                oninput: (e: Event) => document.documentElement.style.setProperty('--glass-k', String(Number((e.target as HTMLInputElement).value) / 100)),
                onchange: (e: Event) => update({ glassStrength: Number((e.target as HTMLInputElement).value) }),
              }),
              h('span', { class: 'faint' }, t('lookStrengthHigh'))
            )
          ),
          checkbox('lookMotion', t('lookMotion'), t('lookMotionHint')),
          status.windowGlassSupported
            ? checkbox('glassWindow', t('lookWindowGlass'), t('lookWindowGlassHint'))
            : h('p', { class: 'hint', style: 'margin:0' }, t('lookWindowGlassUnsupported'))
        )
      : null,
    // Světlo kolem přehrávače funguje i v klasickém vzhledu; se sklem se podle klipu mění i pozadí.
    checkbox('lookFollow', t('lookFollow'), t('lookFollowHint')),
    h(
      'div',
      {},
      h('div', { class: 'faint', style: 'margin-bottom:8px' }, t('brandColorTitle')),
      h(
        'div',
        { class: 'color-row' },
        ...PRESET_COLORS.map((c) =>
          h('button', { class: `swatch ${settings.brandColor.toLowerCase() === c ? 'active' : ''}`, style: `background:${c}`, title: c, 'aria-label': c, onclick: () => pickColor(c) })
        ),
        h('label', { class: 'swatch custom', title: t('brandColorCustom') }, '+', custom),
        h('button', { class: 'small quiet', onclick: () => pickColor(null) }, t('brandColorReset'))
      )
    )
  );
}

// ---- úložiště -------------------------------------------------------------------------

type StorageInfo = Awaited<ReturnType<KineBridge['storageInfo']>>;
let storage: StorageInfo | null = null;
let storageAt = 0;

/** Místo na disku: klipy, koš, zásobník, volno. Čte se při otevření Záznamu a pak nejvýš po 5 s. */
function storageRows() {
  if (Date.now() - storageAt > 5000) {
    storageAt = Date.now();
    void kine.storageInfo().then((info) => {
      storage = info;
      scheduleRender();
    });
  }
  const info = storage;
  if (!info) return h('p', { class: 'hint storage', style: 'margin:0' }, t('loading'));
  const low = info.freeBytes >= 0 && info.freeBytes < 5 * 1024 * 1024 * 1024;
  return h(
    'div',
    { class: 'storage stack', style: 'gap:6px' },
    h(
      'div',
      { class: 'storage-grid' },
      h('span', { class: 'faint' }, t('storageClips')),
      h('b', {}, `${formatBytes(info.clipsBytes)} · ${t('clipsCount', { count: info.clipsCount })}`),
      h('span', { class: 'faint' }, t('storageTrash')),
      h(
        'b',
        {},
        info.trashCount > 0 ? `${formatBytes(info.trashBytes)} · ${t('clipsCount', { count: info.trashCount })}` : '—',
        info.trashCount > 0
          ? h('button', { class: 'small quiet danger', style: 'margin-left:10px', onclick: () => void kine.emptyTrash().then(() => { storageAt = 0; render(); }) }, t('trashEmpty'))
          : null
      ),
      h('span', { class: 'faint' }, t('storageBuffer')),
      h('b', {}, info.bufferBytes > 0 ? formatBytes(info.bufferBytes) : '—'),
      h('span', { class: 'faint' }, t('storageFree')),
      h('b', { class: low ? 'error' : '' }, info.freeBytes >= 0 ? formatBytes(info.freeBytes) : '?')
    ),
    h('p', { class: 'hint', style: 'margin:0' }, low ? t('storageLowHint') : t('storageHint', { days: TRASH_DAYS }))
  );
}

// ---- zvuk -----------------------------------------------------------------------------

let audioLevels: AudioLevels | null = null;
let audioDevices: AudioDevice[] = [];
let audioDevicesAt = 0;

/**
 * Zvuková zařízení pro výběr (vstupy: mikrofony i "Stereo Mix" a spol.).
 * Popisky dává Chromium jen s oprávněním k médiím - to má okno od
 * hlavního procesu; bez popisků se ukáže aspoň druh zařízení.
 */
async function refreshAudioDevices(): Promise<void> {
  if (Date.now() - audioDevicesAt < 5000) return;
  audioDevicesAt = Date.now();
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const next: AudioDevice[] = [];
    for (const d of list) {
      if (d.kind !== 'audioinput' && d.kind !== 'audiooutput') continue;
      if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) continue;
      next.push({ id: d.deviceId, label: d.label || (d.kind === 'audioinput' ? t('audioUnnamedInput') : t('audioUnnamedOutput')), kind: d.kind === 'audioinput' ? 'input' : 'output' });
    }
    const changed = JSON.stringify(next) !== JSON.stringify(audioDevices);
    audioDevices = next;
    if (changed) scheduleRender();
  } catch {
    // Bez zařízení (nebo bez oprávnění) zůstane jen výchozí volba.
  }
}

/**
 * Co ukazují proužky: nahoru hned, dolů pomalu (jako měřák na mixpultu) -
 * jinak proužek mezi slabikami a údery skáče a působí to sekaně.
 * Za každé čtení (10x za sekundu) klesne nejvýš o 2,5 dB.
 */
const shownLevels: { system: number | null; mic: number | null } = { system: null, mic: null };
function smoothLevels(l: AudioLevels | null) {
  const next = (prev: number | null, value: number | null | undefined) => (value === null || value === undefined ? null : Math.max(value, (prev ?? 0) * 0.75));
  shownLevels.system = next(shownLevels.system, l?.system);
  shownLevels.mic = next(shownLevels.mic, l?.mic);
}

/** Hladina 0-1 -> šířka proužku v % (logaritmicky, -60 až 0 dB), ať je slyšitelný zvuk vidět. */
function meterPercent(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const db = value > 0 ? 20 * Math.log10(value) : -100;
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

/**
 * Barvy proužku patří celé dráze, ne proužku: tichý zvuk je jen barva appky,
 * oranžová a červená až u opravdu hlasitého (dřív měl i krátký proužek
 * na konci červenou, jako by zvuk přebuzoval).
 */
function meterStyle(percent: number): string {
  return `width:${percent}%;background-size:${percent > 0.5 ? (100 / percent) * 100 : 100}% 100%`;
}

/** Měřák hladiny 0-1: proužek v logaritmickém měřítku, ať je slyšitelný zvuk vidět. */
function meter(value: number | null, cls: string) {
  return h('div', { class: `progress meter ${cls} ${value === null ? 'off' : ''}` }, h('span', { style: meterStyle(meterPercent(value)) }));
}

/** Živě překreslované měřáky (jen proužky, ne celá stránka). */
function updateMeters() {
  const l = audioLevels;
  const sys = app.querySelector('.meter.system > span') as HTMLElement | null;
  const mic = app.querySelector('.meter.mic > span') as HTMLElement | null;
  const set = (el: HTMLElement | null, value: number | null | undefined) => {
    if (el) el.setAttribute('style', meterStyle(meterPercent(value)));
  };
  set(sys, l ? shownLevels.system : null);
  set(mic, l ? shownLevels.mic : null);
  const note = app.querySelector('.audio-live-note') as HTMLElement | null;
  if (note) note.textContent = audioLiveNote();
}

/** Věta pod měřáky: odkud jde zvuk hry a jestli je ticho. */
function audioLiveNote(): string {
  const l = audioLevels;
  if (status.capture !== 'on' || !l) return t('audioMetersIdle');
  if (l.system === null) {
    if (!settings.systemAudio) return t('audioSystemOff');
    // Proč: zařízení a důvod od Windows (bez něj se nedá poradit).
    return l.systemError
      ? t('audioLoopbackFailedNote', { device: l.defaultOutput || t('audioDefaultDevice'), reason: l.systemError })
      : t('audioNoSystemTrack');
  }
  if (l.systemFallback) return t('audioFallbackNote', { device: l.systemFallback });
  const device = l.systemDevice || t('audioDefaultDevice');
  if (l.systemSilentSeconds >= 10) return t('audioSilentNote', { device, seconds: l.systemSilentSeconds });
  return t('audioSourceNote', { device });
}

/** Zařízení Bluetooth (Chromium dává do názvu "(Bluetooth)", sluchátka v režimu hovoru "Hands-Free"). */
function isBluetooth(label: string): boolean {
  return /\(Bluetooth\)|hands-?free|\bLE Audio\b/i.test(label);
}

/** Hláška po "Zkusit znovu" u zvuku hry. */
let audioRetryNote = '';

/** Vstup, který nahrává zvuk počítače (ne hlas): Stereo Mix, VB-Cable, Voicemeeter... (stejné jako capture.ts). */
function isLoopbackLabel(label: string): boolean {
  return /stereo ?mix|mix st[ée]r[ée]o|what u hear|cable output|voicemeeter out|wave ?out|loopback/i.test(label);
}

/** Posun zvuku vůči obrazu (-300..+300 ms): když zvuk v klipech sedí jinak, než by měl. */
function offsetSlider() {
  const value = settings.audioOffsetMs;
  const label = (ms: number) => (ms === 0 ? t('audioOffsetNone') : ms > 0 ? t('audioOffsetLater', { ms }) : t('audioOffsetEarlier', { ms: -ms }));
  const out = h('b', { style: 'min-width:120px;text-align:right' }, label(value));
  return h(
    'div',
    { class: 'stack', style: 'gap:4px' },
    h(
      'label',
      { class: 'gain' },
      h('span', {}, t('audioOffset')),
      h('input', {
        type: 'range',
        class: 'audio-offset',
        min: '-300',
        max: '300',
        step: '10',
        value: String(value),
        oninput: (e: Event) => (out.textContent = label(Number((e.target as HTMLInputElement).value))),
        onchange: (e: Event) => update({ audioOffsetMs: Number((e.target as HTMLInputElement).value) }),
      }),
      out
    ),
    h('p', { class: 'hint', style: 'margin:0' }, t('audioOffsetHint'))
  );
}

function audioPanel(win: boolean) {
  void refreshAudioDevices();
  const inputs = audioDevices.filter((d) => d.kind === 'input');
  const gainSlider = (field: 'systemGain' | 'micGain', label: string) => {
    const value = settings[field];
    const out = h('b', { style: 'min-width:44px;text-align:right' }, `${Math.round(value * 100)} %`);
    return h(
      'label',
      { class: 'gain' },
      h('span', {}, label),
      h('input', {
        type: 'range',
        min: '0',
        max: '200',
        step: '5',
        value: String(Math.round(value * 100)),
        oninput: (e: Event) => (out.textContent = `${(e.target as HTMLInputElement).value} %`),
        onchange: (e: Event) => update({ [field]: Number((e.target as HTMLInputElement).value) / 100 } as Partial<Settings>),
      }),
      out
    );
  };
  const loopbackInputs = inputs.filter((d) => isLoopbackLabel(d.label));
  const micInputs = inputs.filter((d) => !isLoopbackLabel(d.label));
  // Ticho se ukáže i bez rozpoznané hry - hráč se sem dívá právě proto, že něco nehraje.
  const silent = status.capture === 'on' && !!audioLevels && audioLevels.system !== null && audioLevels.systemSilentSeconds >= 10;
  return h(
    'div',
    { class: 'panel stack audio-panel' },
    h('h2', {}, t('audioTitle')),
    // Měřáky: hned je vidět, jestli do klipu jde zvuk hry a mikrofon.
    h(
      'div',
      { class: 'meters' },
      h('span', { class: 'faint' }, '🔊 ' + t('audioMeterSystem')),
      meter(audioLevels ? shownLevels.system : null, 'system'),
      h('span', { class: 'faint' }, '🎤 ' + t('audioMeterMic')),
      meter(audioLevels ? shownLevels.mic : null, 'mic')
    ),
    h('p', { class: `hint audio-live-note ${silent ? 'error' : ''}`, style: 'margin:0' }, audioLiveNote()),
    // Sluchátka Bluetooth: nejčastější důvod ticha i špatného zvuku (režim hovoru) - vlastní rada.
    silent ? h('p', { class: 'hint audio-silent-help', style: 'margin:0' }, isBluetooth(audioLevels?.systemDevice ?? '') ? t('audioSilentHelpBluetooth') : t('audioSilentHelp')) : null,
    // Zvuk hry nejde otevřít: proč, co s tím a zkusit znovu (snímání se rozjede znovu).
    status.capture === 'on' && settings.systemAudio && audioLevels && audioLevels.system === null && !settings.systemAudioDevice
      ? h(
          'div',
          { class: 'audio-fix stack', style: 'gap:6px' },
          h('p', { class: 'hint', style: 'margin:0' }, t('audioLoopbackSteps')),
          h(
            'ol',
            { class: 'audio-fix-steps' },
            h('li', {}, t('audioLoopbackStep1', { device: audioLevels.defaultOutput || t('audioDefaultDevice') })),
            h('li', {}, t('audioLoopbackStep2')),
            h('li', {}, t('audioLoopbackStep3')),
            h('li', {}, t('audioLoopbackStep4'))
          ),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'small',
                onclick: () =>
                  void kine.restartCapture().then((r) => {
                    audioRetryNote = r === 'busy' ? t('audioRetryBusy') : t('audioRetrying');
                    render();
                  }),
              },
              '↻ ' + t('audioRetry')
            ),
            h('button', { class: 'small quiet', onclick: () => void kine.openSoundSettings() }, t('audioOpenWindowsSound'))
          ),
          audioRetryNote ? h('p', { class: 'hint', style: 'margin:0' }, audioRetryNote) : null
        )
      : null,
    status.capture === 'on' && audioLevels?.bluetoothMicAvoided
      ? h('p', { class: 'hint audio-bt-note', style: 'margin:0' }, '🎧 ' + (audioLevels.micDevice ? t('audioBluetoothMicSwitched', { mic: audioLevels.micDevice }) : t('audioBluetoothMicOff')))
      : null,
    checkbox('systemAudio', t('systemAudio'), win ? undefined : t('windowsOnly'), !win),
    settings.systemAudio && win
      ? h(
          'label',
          {},
          t('systemAudioDevice'),
          h(
            'select',
            { class: 'system-audio-device', onchange: (e: Event) => update({ systemAudioDevice: (e.target as HTMLSelectElement).value }) },
            h('option', { value: '', selected: settings.systemAudioDevice === '' }, t('systemAudioLoopback')),
            // Vstupy, které nahrávají zvuk počítače (Stereo Mix, VB-Cable...), zvlášť od mikrofonů -
            // mikrofon jako "zvuk hry" by nahrál hlas, ne hru.
            loopbackInputs.length > 0
              ? h('optgroup', { label: t('audioSourceLoopbackGroup') }, ...loopbackInputs.map((d) => h('option', { value: d.id, selected: settings.systemAudioDevice === d.id }, d.label)))
              : null,
            micInputs.length > 0
              ? h('optgroup', { label: t('audioSourceMicGroup') }, ...micInputs.map((d) => h('option', { value: d.id, selected: settings.systemAudioDevice === d.id }, d.label)))
              : null,
            settings.systemAudioDevice && !inputs.some((d) => d.id === settings.systemAudioDevice)
              ? h('option', { value: settings.systemAudioDevice, selected: true }, t('audioMissingDevice'))
              : null
          ),
          h('span', { class: 'sub hint', style: 'margin-top:4px;display:block' }, t('systemAudioDeviceHint'))
        )
      : null,
    checkbox('microphone', t('microphone'), t('microphoneHint')),
    settings.microphone
      ? h(
          'label',
          {},
          t('microphoneDevice'),
          h(
            'select',
            { class: 'microphone-device', onchange: (e: Event) => update({ microphoneDevice: (e.target as HTMLSelectElement).value }) },
            h('option', { value: '', selected: settings.microphoneDevice === '' }, t('microphoneDefault')),
            ...inputs.map((d) => h('option', { value: d.id, selected: settings.microphoneDevice === d.id }, isBluetooth(d.label) ? `${d.label} · ${t('audioBluetoothTag')}` : d.label)),
            settings.microphoneDevice && !inputs.some((d) => d.id === settings.microphoneDevice)
              ? h('option', { value: settings.microphoneDevice, selected: true }, t('audioMissingDevice'))
              : null
          ),
          isBluetooth(inputs.find((d) => d.id === settings.microphoneDevice)?.label ?? '')
            ? h('span', { class: 'sub hint warn-text', style: 'margin-top:4px;display:block' }, '⚠ ' + t('audioBluetoothMicChosen'))
            : h('span', { class: 'sub hint', style: 'margin-top:4px;display:block' }, t('microphoneDeviceHint'))
        )
      : null,
    h('div', { class: 'stack', style: 'gap:6px' }, settings.systemAudio ? gainSlider('systemGain', t('systemGain')) : null, settings.microphone ? gainSlider('micGain', t('micGain')) : null),
    h('p', { class: 'hint', style: 'margin:0' }, t('audioGainHint')),
    settings.microphone && settings.systemAudio ? checkbox('separateMicTrack', t('separateMicTrack'), t('separateMicTrackHint')) : null,
    offsetSlider()
  );
}

// ---- kolik appka bere -----------------------------------------------------------------

let usage: ResourceUsage | null = null;
let usageTimer: ReturnType<typeof setInterval> | null = null;

/** Údaje o výkonu chodí jen když je vidět záložka Nastavení (každé 2 s), jinak se nic neměří. */
function syncUsageWatch() {
  const want = tab === 'settings' && wizardStep === null && document.visibilityState === 'visible';
  if (want && !usageTimer) {
    const tick = () =>
      void kine.resourceUsage().then((u) => {
        usage = u;
        const el = app.querySelector('.usage-now');
        if (el) el.replaceWith(usageRow());
      });
    tick();
    usageTimer = setInterval(tick, 2000);
  } else if (!want && usageTimer) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}
document.addEventListener('visibilitychange', () => syncUsageWatch());

function usageRow() {
  if (!usage) return h('p', { class: 'faint usage-now', style: 'margin:0' }, t('loading'));
  const num = (n: number) => n.toLocaleString(settings.lang, { maximumFractionDigits: 1 });
  return h(
    'div',
    { class: 'usage-now stack', style: 'gap:2px' },
    h('p', { style: 'margin:0' }, h('b', {}, t('usageNow', { cpu: num(usage.cpuPercentOfTotal), mb: usage.memoryMb }))),
    h('p', { class: 'faint', style: 'margin:0;font-size:12px' }, usage.parts.map((part) => `${part.label}: ${part.memoryMb} MB${part.cpuPercent >= 0.1 ? `, ${num(part.cpuPercent)} %` : ''}`).join(' · ')),
    h('p', { class: 'faint', style: 'margin:0;font-size:12px' }, status.capture === 'on' ? t('usageCapturing') : t('usageIdle'))
  );
}

/**
 * Kolik výkonu smí appka brát (shared/performance.ts): jak často hlídá
 * hry, jak rychle čte ovladač a kombinace kláves, jak často se ptá LoL,
 * jestli karty při najetí přehrávají. Kvalita klipů je zvlášť výš.
 */
function performancePanel() {
  const p = performanceProfile(settings.performance);
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
  return h(
    'div',
    { class: 'panel stack performance' },
    h('h2', { style: 'margin:0' }, '⚙ ' + t('performanceTitle')),
    // Kolik appka právě bere - na rovinu, ať je vidět, že hru nebrzdí.
    usageRow(),
    h('p', { class: 'hint', style: 'margin:0' }, t('performanceHint')),
    h(
      'div',
      { class: 'radio-group' },
      radio('performance', 'low', '🍃 ' + t('performanceLow'), t('performanceLowHint')),
      radio('performance', 'balanced', t('performanceBalanced'), t('performanceBalancedHint')),
      radio('performance', 'high', '⚡ ' + t('performanceHigh'), t('performanceHighHint'))
    ),
    h(
      'p',
      { class: 'faint perf-now', style: 'margin:0' },
      t('performanceNow', { game: seconds(p.gamePollMs), pad: `${p.helperFastMs} ms`, lol: seconds(p.lolPollMs) })
    ),
    settings.performance === 'low' && !lowLoadActive()
      ? h('div', {}, h('button', { class: 'small', onclick: () => update({ maxHeight: 720, fps: 30, videoMbps: 5 }) }, '🍃 ' + t('lowLoadPreset')))
      : null
  );
}

function checkbox(field: keyof Settings, label: string, hint?: string, disabled = false) {
  return h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', checked: Boolean(settings[field]), disabled, onchange: (e: Event) => update({ [field]: (e.target as HTMLInputElement).checked } as Partial<Settings>) }),
    h('span', {}, label, hint ? h('span', { class: 'sub' }, hint) : null)
  );
}

function radio<K extends keyof Settings>(field: K, value: Settings[K], label: string, hint?: string) {
  return h(
    'label',
    { class: 'check' },
    h('input', { type: 'radio', name: String(field), value: String(value), checked: settings[field] === value, onchange: () => update({ [field]: value } as Partial<Settings>) }),
    h('span', {}, label, hint ? h('span', { class: 'sub' }, hint) : null)
  );
}

// ---- hry ----------------------------------------------------------------------------

/** Klipy samy z herních událostí (CS2 GSI, LoL Live Client API) - viz main/gameEvents.ts. */
function autoClipsPanel() {
  const live = status.autoClipsLive;
  return h(
    'div',
    { class: 'panel stack' },
    h('h2', { style: 'margin:0' }, '⚡ ' + t('autoClipsTitle')),
    h('p', { class: 'hint', style: 'margin:0' }, t('autoClipsHint')),
    h(
      'div',
      { class: 'radio-group' },
      radio('autoClips', 'multi', t('autoClipsMulti')),
      radio('autoClips', 'every', t('autoClipsEvery')),
      radio('autoClips', 'off', t('autoClipsOff'))
    ),
    settings.autoClips !== 'off' ? h('p', { class: 'hint' }, t('autoClipsCs2Note')) : null,
    live ? h('p', { class: 'ok', style: 'margin:0' }, '● ' + t('autoClipsLive', { game: { cs2: 'Counter-Strike 2', lol: 'League of Legends', dota2: 'Dota 2', minecraft: 'Minecraft' }[live] })) : null
  );
}

function renderGames() {
  const custom = Object.entries(settings.customGames);
  const exeInput = h('input', { type: 'text', placeholder: 'game.exe' }) as HTMLInputElement;
  const nameInput = h('input', { type: 'text' }) as HTMLInputElement;
  const win = kine.platform === 'win32';

  const addForm = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row' }, h('label', { class: 'grow' }, t('addGameExe'), exeInput), h('label', { class: 'grow' }, t('addGameName'), nameInput)),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary small',
          onclick: () => {
            const exe = exeInput.value.trim();
            if (!exe) return;
            void kine.addGame(exe, nameInput.value.trim() || exe.replace(/\.exe$/i, ''));
            addGameOpen = false;
          },
        },
        t('addGame')
      ),
      h(
        'button',
        {
          class: 'small quiet',
          onclick: () => {
            processes = null;
            void kine.listProcesses().then((list) => {
              processes = list;
              render();
            });
            render();
          },
        },
        t('addGameFromRunning')
      ),
      h('button', { class: 'small quiet', onclick: () => { addGameOpen = false; render(); } }, t('cancel'))
    ),
    processes
      ? h(
          'div',
          { class: 'list' },
          ...processes.map((p) =>
            h(
              'button',
              {
                onclick: () => {
                  exeInput.value = p.exe;
                  nameInput.value = p.name;
                  nameInput.focus();
                },
              },
              p.exe,
              p.hasWindow ? h('span', { class: 'faint', style: 'margin-left:8px' }, t('hasWindow')) : null
            )
          )
        )
      : null
  );

  // Pojmenování právě běžící hry (poznané podle celé obrazovky nebo ze seznamu).
  const nameCurrentInput = h('input', { type: 'text', value: currentGame?.name ?? '', style: 'width:auto;min-width:220px' }) as HTMLInputElement;
  const nowRunning = currentGame
    ? h(
        'div',
        { class: 'stack' },
        h('span', { class: 'faint' }, currentGame.source === 'fullscreen' ? t('gameNowRunningFullscreen', { game: currentGame.name }) : t('gameNowRunning', { game: currentGame.name })),
        currentGame.source !== 'steam' && !currentGame.exe.startsWith('steam:')
          ? namingGame
            ? h(
                'div',
                { class: 'row' },
                nameCurrentInput,
                h(
                  'button',
                  {
                    class: 'small primary',
                    onclick: () => {
                      namingGame = false;
                      void kine.addGame(currentGame!.exe, nameCurrentInput.value.trim() || currentGame!.name);
                    },
                  },
                  t('save')
                ),
                h('button', { class: 'small quiet', onclick: () => { namingGame = false; render(); } }, t('cancel'))
              )
            : h('div', {}, h('button', { class: 'small', onclick: () => { namingGame = true; render(); } }, t('gameNameThis')))
          : null
      )
    : h('span', { class: 'faint' }, t('gameNoneRunning'));

  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('gamesTitle')),
    h(
      'div',
      { class: 'panel radio-group' },
      radio('detection', 'games', t('detectionGames'), t('detectionGamesHint')),
      radio('detection', 'always', t('detectionAlways'), t('detectionAlwaysHint')),
      radio('detection', 'manual', t('detectionManual'), t('detectionManualHint', { hotkey: hotkeyLabel(settings.toggleHotkey) }))
    ),
    h(
      'div',
      { class: 'panel stack' },
      checkbox('detectFullscreen', t('detectFullscreen'), t('detectFullscreenHint'), !win),
      win && !status.chordsSupported ? h('p', { class: 'hint warn' }, t('gamesHelperMissing')) : null
    ),
    autoClipsPanel(),
    h(
      'div',
      { class: 'panel stack' },
      h('h2', { style: 'margin:0' }, t('customGamesTitle')),
      nowRunning,
      h('p', { class: 'hint' }, t('customGamesHint')),
      custom.length === 0
        ? h('p', { class: 'faint' }, t('customGamesEmpty'))
        : h(
            'div',
            { class: 'row' },
            ...custom.map(([exe, name]) =>
              h('span', { class: 'pill' }, `${name} (${exe})`, h('button', { class: 'quiet', onclick: () => void kine.removeGame(exe) }, '✕'))
            )
          ),
      addGameOpen
        ? addForm
        : h('div', {}, h('button', { class: 'small', onclick: () => { addGameOpen = true; render(); } }, '+ ' + t('addGame')))
    )
  );
}

// ---- nahrávání ------------------------------------------------------------------------

/**
 * Nahrání klipů na Kine z knihovny: s nastavením (dialog - název, popis,
 * hashtagy, viditelnost, kategorie…), nebo rovnou s výchozím, když si to
 * hráč tak nastavil (uploadAsk = false). `force` = dialog vždycky (⚙).
 */
function startUpload(list: Clip[], force = false) {
  if (list.length === 0) return;
  if (!settings.uploadAsk && !force) {
    void kine.uploadClips(list.map((c): UploadRequest => ({ clipId: c.id, visibility: settings.visibility })));
    return;
  }
  openUploadDialog({
    clips: list,
    settings,
    t,
    askToggle: true,
    onConfirm: (requests, opts) => {
      if (opts.askNextTime !== settings.uploadAsk) update({ uploadAsk: opts.askNextTime });
      void kine.uploadClips(requests);
      clearSelection();
    },
  });
}

function renderUpload() {
  const price = status.account?.prices.clips ?? status.account?.prices.all ?? null;
  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('uploadTitle')),
    h(
      'div',
      { class: 'panel radio-group' },
      radio('afterGame', 'review', t('afterGameReview')),
      clipsPlus()
        ? radio('afterGame', 'auto', t('afterGameAuto'), t('afterGameAutoHint'))
        : h(
            'label',
            { class: 'check locked' },
            h('input', { type: 'radio', name: 'afterGame', disabled: true }),
            h('span', {}, t('afterGameAutoLocked'), h('span', { class: 'sub' }, price ? t('plusOnlyPrice', { price }) : t('plusOnly')))
          ),
      radio('afterGame', 'none', t('afterGameNone')),
      clipsPlus() ? null : h('div', { class: 'row' }, h('span', { class: 'plan-pill' }, 'PLUS'), plusLink())
    ),
    h(
      'div',
      { class: 'panel stack' },
      h(
        'div',
        { class: 'row' },
        h(
          'label',
          { class: 'grow' },
          t('visibility'),
          h(
            'select',
            { class: 'visibility-select', onchange: (e: Event) => update({ visibility: (e.target as HTMLSelectElement).value as Settings['visibility'] }) },
            ...VISIBILITIES.map((v) => h('option', { value: v, selected: settings.visibility === v }, t(v === 'public' ? 'visibilityPublic' : v === 'subscribers' ? 'visibilitySubscribers' : 'visibilityPrivate')))
          )
        ),
        h(
          'label',
          { style: 'min-width:180px' },
          t('videoLanguage'),
          h(
            'select',
            { onchange: (e: Event) => update({ videoLanguage: (e.target as HTMLSelectElement).value }) },
            ...VIDEO_LANGS.map(([code, name]) => h('option', { value: code, selected: settings.videoLanguage === code }, name))
          )
        )
      ),
      h('p', { class: 'hint', style: 'margin:0' }, t(settings.visibility === 'public' ? 'visibilityPublicHint' : settings.visibility === 'subscribers' ? 'visibilitySubscribersHint' : 'visibilityPrivateHint')),
      // Nastavení nahrání: ptát se / nahrát rovnou, hashtagy ke všemu, kategorie, náhled.
      checkbox('uploadAsk', t('uploadAskSetting'), t('uploadAskSettingHint')),
      h(
        'div',
        { class: 'row', style: 'gap:12px;align-items:flex-end' },
        h(
          'label',
          { class: 'grow' },
          t('uploadHashtagsSetting'),
          h('input', {
            type: 'text',
            class: 'upload-hashtags-setting',
            value: settings.uploadHashtags,
            placeholder: 'kine cz',
            maxlength: '300',
            onchange: (e: Event) => update({ uploadHashtags: (e.target as HTMLInputElement).value.trim() }),
          })
        ),
        h(
          'label',
          { style: 'min-width:220px' },
          t('uploadCategorySetting'),
          h(
            'select',
            { class: 'upload-category-setting', onchange: (e: Event) => update({ uploadCategory: (e.target as HTMLSelectElement).value }) },
            ...CATEGORY_KEYS.map((key) => h('option', { value: key, selected: settings.uploadCategory === key }, t(key)))
          )
        )
      ),
      h('p', { class: 'hint', style: 'margin:0' }, t('uploadHashtagsSettingHint')),
      checkbox('uploadThumbnail', t('uploadThumbnailSetting'), t('uploadThumbnailSettingHint'))
    ),
    h('div', { class: 'panel' }, h('h2', {}, t('onlyWhenNotPlayingTitle')), h('p', { class: 'dim', style: 'margin:0' }, t('onlyWhenNotPlayingHint'))),
    discordPanel()
  );
}

/** Webhook Discordu: nahraný klip jedním klikem na server hráče. */
function discordPanel() {
  const input = h('input', {
    type: 'url',
    value: settings.discordWebhook,
    placeholder: 'https://discord.com/api/webhooks/…',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const commit = () => {
    const value = input.value.trim();
    if (value === settings.discordWebhook) return;
    if (value && !isDiscordWebhook(value)) {
      discordInvalid = true;
      render();
      return;
    }
    discordInvalid = false;
    update({ discordWebhook: value });
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
  });
  input.addEventListener('input', () => {
    if (discordInvalid && (!input.value.trim() || isDiscordWebhook(input.value))) {
      discordInvalid = false;
      render();
    }
  });
  return h(
    'div',
    { class: 'panel stack' },
    h('label', {}, t('discordWebhookLabel'), input),
    discordInvalid ? h('p', { class: 'error', style: 'margin:0' }, t('discordWebhookInvalid')) : null,
    h('p', { class: 'hint', style: 'margin:0' }, t('discordWebhookHint'))
  );
}

// ---- klipy ---------------------------------------------------------------------------------

function uploadState(clip: Clip) {
  const u = clip.upload;
  if (!u) return null;
  if (u.state === 'queued') return h('div', { class: 'state' }, t('uploadQueued'));
  if (u.state === 'uploading') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t('uploadUploading', { percent: u.percent })));
  if (u.state === 'paused') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t(u.reason === 'game' ? 'uploadPausedGame' : 'uploadPausedOffline', { percent: u.percent })));
  if (u.state === 'done' && u.ready === false) return h('div', { class: 'state processing', title: t('uploadProcessingHint') }, h('span', { class: 'spin' }), ' ' + t('uploadProcessing'));
  if (u.state === 'done') return h('div', { class: 'state done' }, '✓ ' + t('uploadDone'));
  // Nepřihlášený (kód z uploaderu): přeložená hláška místo české odpovědi serveru.
  return h('div', { class: 'state error' }, u.message === 'login-required' ? t('uploadErrorLogin') : t('uploadError', { message: u.message }));
}

function dateFrom(filter: DateFilter): number {
  const now = new Date();
  if (filter === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (filter === 'week') return now.getTime() - 7 * 24 * 3600 * 1000;
  if (filter === 'month') return now.getTime() - 30 * 24 * 3600 * 1000;
  return 0;
}

function filteredClips(): Clip[] {
  const since = dateFrom(filters.date);
  const q = filters.query.trim().toLowerCase();
  // Koš: jen hledání, řazení podle toho, kdy klip do koše přišel.
  if (filters.trash) return trashClips.filter((c) => !q || `${c.title} ${c.game ?? ''}`.toLowerCase().includes(q));
  const list = clips.filter((c) => {
    if (filters.favorites && !c.favorite) return false;
    if (filters.game === 'none' && c.game) return false;
    if (filters.game !== 'all' && filters.game !== 'none' && c.game !== filters.game) return false;
    if (since && new Date(c.createdAt).getTime() < since) return false;
    if (q && !`${c.title} ${c.game ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  // Knihovna chodí nejnovější první; ostatní řazení tady.
  switch (settings.clipsSort) {
    case 'oldest':
      return list.reverse();
    case 'longest':
      return list.sort((a, b) => b.durationSeconds - a.durationSeconds);
    case 'largest':
      return list.sort((a, b) => b.sizeBytes - a.sizeBytes);
    default:
      return list;
  }
}

/** Kolik dní klipu v koši zbývá, než zmizí sám. */
function daysLeftInTrash(deletedAt: string): number {
  const left = TRASH_DAYS - (Date.now() - Date.parse(deletedAt)) / (24 * 3600 * 1000);
  return Math.max(0, Math.ceil(left));
}

/** Sousedé klipu v právě zobrazeném seznamu (šipky v přehrávači jdou po mřížce, jak ji hráč vidí). */
function neighborsOf(id: string): Neighbors {
  const list = filteredClips();
  const index = list.findIndex((c) => c.id === id);
  if (index < 0) return { prev: null, next: null, index: 0, total: list.length };
  return { prev: list[index - 1] ?? null, next: list[index + 1] ?? null, index, total: list.length };
}

function showShareNote(id: string, text: string, kind: 'ok' | 'error') {
  shareNote = { id, text, kind };
  if (shareNoteTimer) clearTimeout(shareNoteTimer);
  shareNoteTimer = setTimeout(() => {
    shareNote = null;
    render();
  }, kind === 'ok' ? 2500 : 6000);
  render();
}

function showMergeNote(text: string, kind: 'ok' | 'error') {
  mergeNote = { text, kind };
  if (mergeNoteTimer) clearTimeout(mergeNoteTimer);
  mergeNoteTimer = setTimeout(() => {
    mergeNote = null;
    render();
  }, kind === 'ok' ? 6000 : 10000);
  render();
}

/** Přehrávač jako vrstva přes okno (player.ts); mřížka pod ním zůstává, jak je. */
function showClip(clip: Clip, edit = false) {
  stopPreview();
  player = openPlayer({
    clip,
    t,
    startEditing: edit,
    onOpenExternal: (c) => void kine.openClip(c.id),
    onLog: (m) => void kine.log(m),
    onClose: () => {
      player = null;
    },
    neighbors: neighborsOf,
    onCopyLink: (c) => {
      if (c.upload?.state === 'done') void kine.copyText(c.upload.url);
    },
    edit: {
      run: (c, request) => kine.trimClip(c.id, request),
      onProgress: (cb) => kine.onTrimProgress(cb),
      gif: (c, range) => kine.makeGif(c.id, range),
      reveal: (file) => void kine.revealFile(file),
      // GIF rovnou na Discord (jen když je webhook v nastavení).
      discord: settings.discordWebhook ? (file, title) => kine.shareFileToDiscord(file, title) : undefined,
      thumbnail: (c, at) => kine.setThumbnailFrame(c.id, at),
    },
  });
}

// ---- náhled při najetí myší ------------------------------------------------------------

/**
 * Najetí myší na kartu klip tiše přehrává (jako na webu) - hráč nemusí
 * každý klip otvírat, aby věděl, který to je. Vždy nejvýš jeden náhled;
 * po odjetí se video hned pustí z ruky.
 */
function startPreview(host: HTMLElement, clip: Clip) {
  // V úsporném režimu se karty při najetí nepřehrávají.
  if (!performanceProfile(settings.performance).hoverPreview) return;
  if (preview?.host === host) return;
  stopPreview();
  const video = h('video', { class: 'preview', muted: true, loop: true, playsinline: true, preload: 'auto' }) as HTMLVideoElement;
  video.muted = true;
  video.src = fileUrl(clip.file);
  video.addEventListener('error', () => {
    if (preview?.video === video) stopPreview();
  });
  video.addEventListener('playing', () => host.classList.add('previewing'));
  host.append(video);
  preview = { host, video };
  void video.play().catch(() => undefined);
}

function stopPreview() {
  if (!preview) return;
  const { host, video } = preview;
  preview = null;
  host.classList.remove('previewing');
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // už pryč
  }
  video.remove();
}

// ---- výběr více klipů -----------------------------------------------------------------------

function toggleSelected(id: string, on: boolean) {
  if (on) selected.add(id);
  else selected.delete(id);
  confirmBulkDelete = false;
  render();
}

function clearSelection() {
  selected.clear();
  confirmBulkDelete = false;
  render();
}

async function mergeSelectedClips() {
  if (merging || selected.size < 2) return;
  merging = { percent: 0 };
  render();
  const unsubscribe = kine.onTrimProgress((p) => {
    if (merging && p.id === 'merge') {
      merging.percent = p.percent;
      const bar = app.querySelector('.selection-bar .progress > span') as HTMLElement | null;
      const text = app.querySelector('.selection-bar .merge-text');
      if (bar) bar.style.width = `${p.percent}%`;
      if (text) text.textContent = t('mergeWorking', { percent: p.percent });
    }
  });
  try {
    const clip = await kine.mergeClips([...selected]);
    selected.clear();
    merging = null;
    showMergeNote(t('mergeDone', { title: clip.title }), 'ok');
  } catch (e) {
    merging = null;
    void kine.log(`sestřih: ${(e as Error).message}`);
    showMergeNote(t('mergeFailed', { message: errorText(e, t) }), 'error');
  } finally {
    unsubscribe();
  }
}

/** Lišta nad mřížkou, když je něco vybrané: počet a délka, sestřih, nahrání, smazání. */
function selectionBar(shown: Clip[]) {
  const picked = clips.filter((c) => selected.has(c.id));
  if (picked.length === 0 && !mergeNote) return null;
  const total = picked.reduce((sum, c) => sum + c.durationSeconds, 0);
  const uploadable = picked.filter((c) => !c.upload || c.upload.state === 'error');
  const allShownSelected = shown.every((c) => selected.has(c.id));
  const bar = h('div', { class: 'selection-bar' });
  if (picked.length > 0) {
    bar.append(
      h('b', { class: 'sel-count' }, t('selectionCount', { count: picked.length, duration: formatDuration(total) })),
      merging
        ? h('div', { class: 'row', style: 'gap:8px' }, h('div', { class: 'progress trim-progress' }, h('span', { style: `width:${merging.percent}%` })), h('span', { class: 'faint merge-text' }, t('mergeWorking', { percent: merging.percent })))
        : h(
            'div',
            { class: 'row', style: 'gap:6px' },
            h('button', { class: 'small primary sel-merge', disabled: picked.length < 2, onclick: () => void mergeSelectedClips() }, '🎬 ' + t('selectionMerge')),
            uploadable.length > 0
              ? h(
                  'button',
                  {
                    class: 'small',
                    disabled: !status.account,
                    title: status.account ? '' : t('uploadNeedsLogin'),
                    onclick: () => startUpload(uploadable),
                  },
                  t('selectionUpload')
                )
              : null,
            confirmBulkDelete
              ? h(
                  'button',
                  {
                    class: 'small danger',
                    onclick: () => {
                      confirmBulkDelete = false;
                      for (const c of picked) {
                        if (openPlayerId() === c.id) closePlayer();
                        void kine.deleteClip(c.id);
                      }
                      selected.clear();
                      render();
                    },
                  },
                  t('selectionDeleteConfirm', { count: picked.length })
                )
              : h(
                  'button',
                  {
                    class: 'small quiet danger',
                    onclick: () => {
                      confirmBulkDelete = true;
                      render();
                      if (bulkDeleteTimer) clearTimeout(bulkDeleteTimer);
                      bulkDeleteTimer = setTimeout(() => {
                        confirmBulkDelete = false;
                        render();
                      }, 4000);
                    },
                  },
                  t('selectionDelete')
                ),
            !allShownSelected
              ? h('button', { class: 'small quiet', onclick: () => { for (const c of shown) selected.add(c.id); render(); } }, t('selectionAll'))
              : null,
            h('button', { class: 'small quiet', onclick: clearSelection }, t('selectionClear'))
          )
    );
  }
  if (mergeNote) bar.append(h('div', { class: `state ${mergeNote.kind === 'ok' ? 'done' : 'error'}`, style: 'flex-basis:100%' }, mergeNote.text));
  return bar;
}

function gameChip(clip: Clip) {
  if (editingGame === clip.id) {
    const input = h('input', { type: 'text', class: 'title-edit', list: 'game-names', value: clip.game ?? '', placeholder: t('clipGamePrompt') }) as HTMLInputElement;
    const commit = () => {
      if (editingGame !== clip.id) return;
      editingGame = null;
      void kine.setClipGame(clip.id, input.value.trim() || null);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') {
        editingGame = null;
        render();
      }
    });
    input.addEventListener('blur', () => setTimeout(commit, 120));
    setTimeout(() => input.focus(), 0);
    return h(
      'div',
      { class: 'row', style: 'gap:6px' },
      input,
      h('button', { class: 'small quiet', onmousedown: (e: Event) => e.preventDefault(), onclick: () => { editingGame = null; void kine.setClipGame(clip.id, null); } }, t('clipGameNone'))
    );
  }
  return h(
    'button',
    { class: 'chip', title: t('clipGameChange'), onclick: () => { editingGame = clip.id; render(); } },
    '🎮 ',
    clip.game ?? t('clipsNoGame'),
    h('span', { class: 'faint' }, ' ▾')
  );
}

function renderClips() {
  const games = [...new Set(clips.map((c) => c.game).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b));
  const hasNoGame = clips.some((c) => !c.game);
  // Koš se vyprázdnil (vrácení, vysypání, týden uplynul) - zpátky do knihovny, ještě před výběrem karet.
  if (filters.trash && trashClips.length === 0) filters.trash = false;
  const list = filteredClips();
  const filtersActive = filters.game !== 'all' || filters.date !== 'all' || filters.query.trim() !== '' || filters.favorites || filters.trash;
  const favoritesCount = clips.filter((c) => c.favorite).length;

  const container = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'spread' },
      h('div', { class: 'row' }, h('h1', { style: 'margin:0' }, t('clipsTitle')), h('span', { class: 'faint' }, t('clipsCount', { count: list.length }))),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'small quiet', onclick: () => void kine.openScreenshotsDir() }, '📷 ' + t('screenshotsOpen')),
        h('button', { class: 'small', onclick: () => void kine.openClipsDir() }, t('clipsDirOpen'))
      )
    ),
    h('datalist', { id: 'game-names' }, ...gameNames.map((name) => h('option', { value: name })))
  );

  if (clips.length === 0 && trashClips.length === 0) {
    container.append(h('div', { class: 'empty' }, t('clipsEmpty', { hotkey: hotkeyLabel(settings.clipHotkey) })));
    return container;
  }
  // Koš: tlačítko s počtem; v koši se karty přepnou na "obnovit / smazat nadobro".
  const trashBtn =
    trashClips.length > 0
      ? h(
          'button',
          {
            class: `small quiet trash-filter ${filters.trash ? 'active' : ''}`,
            style: 'align-self:flex-end',
            title: t('trashHint', { days: TRASH_DAYS }),
            onclick: () => {
              filters.trash = !filters.trash;
              confirmEmptyTrash = false;
              selected.clear();
              render();
            },
          },
          '🗑 ' + t('clipsFilterTrash'),
          h('span', { class: 'count' }, String(trashClips.length))
        )
      : null;
  const favoritesBtn = h(
    'button',
    {
      class: `small quiet fav-filter ${filters.favorites ? 'active' : ''}`,
      style: 'align-self:flex-end',
      onclick: () => {
        filters.favorites = !filters.favorites;
        render();
      },
    },
    (filters.favorites ? '★ ' : '☆ ') + t('clipsFilterFavorites'),
    favoritesCount > 0 ? h('span', { class: 'count' }, String(favoritesCount)) : null
  );

  container.append(
    h(
      'div',
      { class: 'filters' },
      h(
        'label',
        {},
        t('clipsFilterGame'),
        h(
          'select',
          { onchange: (e: Event) => { filters.game = (e.target as HTMLSelectElement).value; render(); } },
          h('option', { value: 'all', selected: filters.game === 'all' }, t('clipsFilterAll')),
          ...games.map((g) => h('option', { value: g, selected: filters.game === g }, g)),
          hasNoGame ? h('option', { value: 'none', selected: filters.game === 'none' }, t('clipsNoGame')) : null
        )
      ),
      h(
        'label',
        {},
        t('clipsFilterDate'),
        h(
          'select',
          { onchange: (e: Event) => { filters.date = (e.target as HTMLSelectElement).value as DateFilter; render(); } },
          h('option', { value: 'all', selected: filters.date === 'all' }, t('dateAll')),
          h('option', { value: 'today', selected: filters.date === 'today' }, t('dateToday')),
          h('option', { value: 'week', selected: filters.date === 'week' }, t('dateWeek')),
          h('option', { value: 'month', selected: filters.date === 'month' }, t('dateMonth'))
        )
      ),
      h(
        'label',
        { class: 'grow' },
        ' ',
        h('input', {
          type: 'text',
          class: 'clips-search',
          placeholder: t('clipsSearch'),
          value: filters.query,
          oninput: (e: Event) => {
            filters.query = (e.target as HTMLInputElement).value;
            focusSearch = true;
            render();
          },
        })
      ),
      h(
        'label',
        {},
        t('clipsSort'),
        h(
          'select',
          { class: 'clips-sort', onchange: (e: Event) => update({ clipsSort: (e.target as HTMLSelectElement).value as Settings['clipsSort'] }) },
          h('option', { value: 'newest', selected: settings.clipsSort === 'newest' }, t('sortNewest')),
          h('option', { value: 'oldest', selected: settings.clipsSort === 'oldest' }, t('sortOldest')),
          h('option', { value: 'longest', selected: settings.clipsSort === 'longest' }, t('sortLongest')),
          h('option', { value: 'largest', selected: settings.clipsSort === 'largest' }, t('sortLargest'))
        )
      ),
      favoritesBtn,
      trashBtn,
      filtersActive
        ? h('button', { class: 'small quiet', style: 'align-self:flex-end', onclick: () => { filters.game = 'all'; filters.date = 'all'; filters.query = ''; filters.favorites = false; filters.trash = false; render(); } }, t('clipsClearFilters'))
        : null
    )
  );

  if (filters.trash) {
    const trashBytes = trashClips.reduce((sum, c) => sum + (c.sizeBytes || 0), 0);
    container.append(
      h(
        'div',
        { class: 'row trash-bar' },
        h('span', { class: 'faint' }, t('trashInfo', { count: trashClips.length, size: formatBytes(trashBytes), days: TRASH_DAYS })),
        h('span', { class: 'grow' }),
        confirmEmptyTrash
          ? h('button', { class: 'small danger', onclick: () => { confirmEmptyTrash = false; if (openPlayerId() && trashClips.some((c) => c.id === openPlayerId())) closePlayer(); void kine.emptyTrash(); } }, t('trashEmptyConfirm', { count: trashClips.length }))
          : h('button', { class: 'small quiet danger', onclick: () => { confirmEmptyTrash = true; render(); setTimeout(() => { if (confirmEmptyTrash) { confirmEmptyTrash = false; render(); } }, 4000); } }, t('trashEmpty'))
      )
    );
  } else {
    const bar = selectionBar(list);
    if (bar) container.append(bar);
    else container.append(h('p', { class: 'hint sel-hint', style: 'margin:0' }, t('selectionHint')));
  }

  if (list.length === 0) {
    container.append(h('div', { class: 'empty' }, t('clipsNoMatch')));
    return container;
  }

  const grid = h('div', { class: `clips ${selected.size > 0 ? 'selecting' : ''} ${filters.trash ? 'in-trash' : ''}` });
  for (const clip of list) {
    const canUpload = !clip.upload || clip.upload.state === 'error';
    const isSelected = selected.has(clip.id);
    const actions = h('div', { class: 'actions' });
    actions.append(h('button', { class: 'small', onclick: () => showClip(clip) }, '▶ ' + t('libraryOpen')));
    if (clip.deletedAt) {
      // V koši: vrátit, nebo smazat nadobro. Nic jiného (úpravy, nahrání) nedává smysl.
      actions.append(
        h('button', { class: 'small primary trash-restore', onclick: () => void kine.restoreClip(clip.id) }, '↩ ' + t('trashRestore')),
        confirmDelete === clip.id
          ? h('button', { class: 'small danger', onclick: () => { confirmDelete = null; if (openPlayerId() === clip.id) closePlayer(); void kine.deleteClip(clip.id); } }, t('trashDeleteForeverConfirm'))
          : h('button', { class: 'small quiet danger', onclick: () => { confirmDelete = clip.id; render(); setTimeout(() => { if (confirmDelete === clip.id) { confirmDelete = null; render(); } }, 4000); } }, t('trashDeleteForever'))
      );
    } else {
    actions.append(h('button', { class: 'small quiet', onclick: () => showClip(clip, true) }, '✂ ' + t('libraryEdit')));
    if (canUpload) {
      actions.append(
        h(
          'button',
          {
            class: 'small primary upload-btn',
            disabled: !status.account,
            title: status.account ? '' : t('uploadNeedsLogin'),
            onclick: () => startUpload([clip]),
          },
          clip.upload?.state === 'error' ? t('libraryRetry') : t('libraryUpload')
        ),
        // Nastavení nahrání (název, popis, hashtagy, viditelnost…) - vždycky, i když se appka jinak neptá.
        h('button', { class: 'small quiet upload-options', disabled: !status.account, title: t('uploadOptionsButton'), onclick: () => startUpload([clip], true) }, '⚙')
      );
    }
    if (clip.upload?.state === 'done') {
      const url = clip.upload.url;
      actions.append(
        h('button', { class: 'small', onclick: () => void kine.openOnKine(clip.id) }, t('libraryOpenOnKine')),
        h(
          'button',
          {
            class: 'small quiet',
            onclick: () => {
              void kine.copyText(url);
              showShareNote(clip.id, t('linkCopied'), 'ok');
            },
          },
          '🔗 ' + t('libraryCopyLink')
        )
      );
    }
    // Discord: nahraný klip jako odkaz, nenahraný rovnou jako soubor (do 10 MB); větší nejdřív na Kine.
    if (settings.discordWebhook) {
      const asLink = clip.upload?.state === 'done';
      const tooLarge = !asLink && clip.sizeBytes > DISCORD_FILE_MAX_BYTES;
      actions.append(
        h(
          'button',
          {
            class: 'small quiet',
            disabled: tooLarge,
            title: tooLarge ? t('discordTooLarge', { size: formatBytes(clip.sizeBytes), max: formatBytes(DISCORD_FILE_MAX_BYTES) }) : asLink ? t('discordAsLink') : t('discordAsFile'),
            onclick: () => {
              showShareNote(clip.id, t('discordSending'), 'ok');
              void kine
                .shareToDiscord(clip.id)
                .then(() => showShareNote(clip.id, t('discordSent'), 'ok'))
                .catch((e: unknown) => showShareNote(clip.id, /too-large/.test(String((e as Error)?.message ?? e)) ? t('discordTooLarge', { size: formatBytes(clip.sizeBytes), max: formatBytes(DISCORD_FILE_MAX_BYTES) }) : t('discordFailed', { message: errorText(e, t) }), 'error'));
            },
          },
          t('libraryDiscord')
        )
      );
    }
    actions.append(h('button', { class: 'small quiet', onclick: () => void kine.revealClip(clip.id) }, t('libraryReveal')));
    actions.append(
      h('button', { class: 'small quiet', onclick: () => { renaming = clip.id; render(); } }, t('libraryRename')),
      confirmDelete === clip.id
        ? h('button', { class: 'small danger', title: t('trashHint', { days: TRASH_DAYS }), onclick: () => { confirmDelete = null; if (openPlayerId() === clip.id) closePlayer(); void kine.deleteClip(clip.id); } }, t('libraryDeleteConfirm', { days: TRASH_DAYS }))
        : h('button', { class: 'small quiet danger', title: t('trashHint', { days: TRASH_DAYS }), onclick: () => { confirmDelete = clip.id; render(); setTimeout(() => { if (confirmDelete === clip.id) { confirmDelete = null; render(); } }, 4000); } }, t('libraryDelete'))
    );
    }

    const titleEl =
      renaming === clip.id
        ? h('input', {
            type: 'text',
            class: 'title-edit',
            value: clip.title,
            maxlength: '150',
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                renaming = null;
                void kine.renameClip(clip.id, (e.target as HTMLInputElement).value);
              }
              if (e.key === 'Escape') {
                renaming = null;
                render();
              }
            },
            onblur: (e: Event) => {
              if (renaming === clip.id) {
                renaming = null;
                void kine.renameClip(clip.id, (e.target as HTMLInputElement).value);
              }
            },
          })
        : h('div', { class: 'title', title: clip.title }, clip.title);

    const body = h(
      'div',
      { class: 'body' },
      titleEl,
      h('div', { class: 'row', style: 'gap:8px' }, gameChip(clip), h('span', { class: 'meta' }, clipMeta(clip, settings.lang))),
      clip.deletedAt ? h('div', { class: 'meta trash-meta' }, t('trashDeletedAt', { date: formatDate(clip.deletedAt, settings.lang), days: daysLeftInTrash(clip.deletedAt) })) : null,
      uploadState(clip),
      actions,
      shareNote?.id === clip.id ? h('div', { class: `state ${shareNote.kind === 'ok' ? 'done' : 'error'}` }, shareNote.text) : null
    );

    const thumb = h(
      'div',
      { class: `thumb ${isPortrait(clip) ? 'portrait' : ''}`, onclick: () => showClip(clip) },
      // Náhledy se načítají, až když se karta dostane na obrazovku - u stovek klipů to šetří paměť i disk.
      ...thumbImages(clip),
      h('span', { class: 'play-badge' }, '▶'),
      clip.kind === 'recording'
        ? h(
            'span',
            { class: 'kind-badge', title: clip.markers?.length ? t('libraryMoments', { count: clip.markers.length }) : '' },
            '⏺ ' + t('libraryRecordingBadge') + (clip.markers?.length ? ` · 🚩 ${clip.markers.length}` : '')
          )
        : null,
      h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
    );
    thumb.addEventListener('mouseenter', () => {
      startPreview(thumb, clip);
      // Vzhled -> Barvy podle obrazu: pozadí skla podle karty pod myší (až se myš zastaví).
      if (clip.thumb) followImage(fileUrl(clip.thumb), 260);
    });
    thumb.addEventListener('mouseleave', () => {
      if (preview?.host === thumb) stopPreview();
    });
    // Zaškrtávátko výběru a hvězdička leží nad náhledem - klik na ně klip neotvírá.
    const pick = h('input', {
      type: 'checkbox',
      class: 'pick',
      checked: isSelected,
      title: t('selectionHint'),
      onclick: (e: Event) => e.stopPropagation(),
      onchange: (e: Event) => toggleSelected(clip.id, (e.target as HTMLInputElement).checked),
    });
    const star = h(
      'button',
      {
        class: `star ${clip.favorite ? 'on' : ''}`,
        title: clip.favorite ? t('libraryUnfavorite') : t('libraryFavorite'),
        onclick: (e: Event) => {
          e.stopPropagation();
          void kine.setFavorite(clip.id, !clip.favorite);
        },
      },
      clip.favorite ? '★' : '☆'
    );
    if (!clip.deletedAt) thumb.append(pick, star);

    // Kartu jde přetáhnout ven z okna: soubor klipu přistane v Discordu, prohlížeči nebo složce.
    const card = h(
      'div',
      {
        class: `clip ${isSelected ? 'selected' : ''} ${clip.favorite ? 'favorite' : ''}`,
        'data-id': clip.id,
        draggable: 'true',
        title: t('libraryDragHint'),
        ondragstart: (e: DragEvent) => {
          e.preventDefault();
          stopPreview();
          kine.dragClip(clip.id);
        },
      },
      thumb,
      body
    );
    grid.append(card);
    if (renaming === clip.id) setTimeout(() => (titleEl as HTMLInputElement).focus?.(), 0);
  }
  container.append(grid);
  return container;
}

// ---- o appce -------------------------------------------------------------------------------

/** Velikost v MB s jedním desetinným místem podle jazyka. */
function mbText(bytes: number): string {
  return (bytes / 1048576).toLocaleString(settings.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Stáhnout teď / Aktualizovat teď (O appce, postranní panel). */
function installUpdateClick() {
  if (updateInstalling) return;
  updateInstalling = true;
  updateBusy = false;
  render();
  void kine.installUpdate().then((r) => {
    if (r === 'ok') return;
    updateInstalling = false;
    updateBusy = r === 'busy';
    render();
  });
}

/**
 * Aktualizace, která se stahuje / je stažená: průběh (procenta, MB,
 * rychlost) a pak jedno tlačítko "Aktualizovat teď" - appka se zavře,
 * nainstaluje novou verzi a sama se znovu spustí.
 */
function updateProgressBox() {
  const u = status.update;
  if (!u || (u.phase !== 'downloading' && u.phase !== 'ready' && u.phase !== 'waiting-game' && u.phase !== 'error' && u.phase !== 'checking')) return null;
  const version = u.version ?? '';
  const box = h('div', { class: `stack update-progress ${u.phase}`, style: 'gap:8px' });
  if (u.phase === 'checking') {
    box.append(h('p', { class: 'faint', style: 'margin:0' }, h('span', { class: 'spin' }), ' ', t('aboutUpdateChecking')));
  } else if (u.phase === 'downloading') {
    const percent = Math.max(0, Math.min(100, u.percent ?? 0));
    box.append(
      h('p', { style: 'margin:0' }, t('aboutUpdateDownloading', { version, percent })),
      h('div', { class: 'progress update-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) }, h('span', { style: `width:${percent}%` }))
    );
    if (u.total) {
      box.append(
        h(
          'p',
          { class: 'faint', style: 'margin:0' },
          t('aboutUpdateDownloadedOf', { done: mbText(u.transferred ?? 0), total: mbText(u.total) }) +
            (u.bytesPerSecond ? ' · ' + t('aboutUpdateSpeed', { speed: mbText(u.bytesPerSecond) }) : '')
        )
      );
    }
  } else if (u.phase === 'ready') {
    box.append(
      h('p', { class: 'ok', style: 'margin:0' }, '✓ ' + t('aboutUpdateReady', { version })),
      h(
        'div',
        { class: 'row', style: 'align-items:center' },
        h(
          'button',
          { class: 'primary update-now', disabled: updateInstalling, onclick: installUpdateClick },
          updateInstalling ? h('span', { class: 'spin' }) : '⬆ ',
          updateInstalling ? t('aboutUpdateInstalling') : t('aboutUpdateNow')
        )
      ),
      updateBusy ? h('p', { class: 'hint warn-text', style: 'margin:0' }, t('aboutUpdateBusy')) : h('p', { class: 'faint', style: 'margin:0' }, t('aboutUpdateRestartHint'))
    );
  } else if (u.phase === 'waiting-game') {
    box.append(
      h('p', { style: 'margin:0' }, t('aboutUpdateWaitsGame', { version })),
      h('div', {}, h('button', { class: 'small', onclick: () => void kine.downloadUpdate() }, '⬇ ' + t('aboutUpdateDownloadNow')))
    );
  } else if (u.phase === 'error') {
    box.append(h('p', { class: 'error', style: 'margin:0' }, t('aboutUpdateFailed', { message: u.error ?? '' })));
  }
  return box;
}

/** Výsledek kontroly aktualizací: stav, důvod chyby, odkud se berou, u ručního stažení tlačítko. */
function updateStatus(r: NonNullable<typeof updateResult>) {
  const version = r.version ?? '';
  if (r.status === 'checking') return h('p', { class: 'ok' }, t('loading'));
  const box = h('div', { class: 'stack update-status', style: 'gap:6px' });
  if (r.status === 'available') {
    box.append(h('p', { class: 'ok', style: 'margin:0' }, r.waitingForGame ? t('aboutUpdateWaitsGame', { version }) : t('aboutUpdateAvailable', { version })));
  } else if (r.status === 'available-manual') {
    box.append(
      h('p', { class: 'ok', style: 'margin:0' }, t('aboutUpdateManual', { version })),
      h('div', {}, h('button', { class: 'small primary', onclick: () => void kine.openExternal(r.url ?? settings.siteUrl + '/download') }, '⬇ ' + t('aboutDownloadUpdate', { version })))
    );
  } else if (r.status === 'error') {
    box.append(h('p', { class: 'error', style: 'margin:0' }, t('aboutUpdateErrorReason', { message: r.message ?? '' })));
  } else if (r.status === 'disabled') {
    box.append(h('p', { class: 'faint', style: 'margin:0' }, 'dev'));
  } else {
    box.append(h('p', { class: 'ok', style: 'margin:0' }, t('aboutUpToDate')));
  }
  if (r.source) box.append(h('p', { class: 'faint', style: 'margin:0' }, t('aboutUpdateSource', { source: r.source })));
  if (r.message && r.status !== 'error') box.append(h('p', { class: 'faint', style: 'margin:0' }, r.message));
  return box;
}

/** Kdy se naposledy zkopírovala diagnostika (hláška "Zkopírováno" na pár sekund). */
let diagnosticsCopiedAt = 0;

function renderAbout() {
  const copied = Date.now() - diagnosticsCopiedAt < 5000;
  const progressBox = updateProgressBox();
  // Průběh stahování nahrazuje hlášku "verze X je venku" z ručního zkontrolování (jinak by tam byly dvě).
  const showResult = updateResult && !(progressBox && (updateResult.status === 'available' || updateResult.status === 'checking' || updateResult.status === 'error'));
  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, status.variant === 'clipper' ? t('variantClipperName') : t('aboutTitle')),
    h(
      'div',
      { class: 'panel stack' },
      h('div', {}, t('aboutVersion', { version: status.version })),
      h('div', { class: 'faint' }, t('aboutFfmpeg')),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'small',
            onclick: () => {
              updateResult = { status: 'checking' };
              render();
              void kine.checkUpdate().then((r) => {
                updateResult = r;
                render();
              });
            },
          },
          t('aboutCheckUpdate')
        ),
        h('button', { class: 'small quiet', onclick: () => void kine.openLogs() }, t('aboutLogs')),
        h('button', { class: 'small quiet', onclick: () => void kine.openKine() }, t('trayOpenKine'))
      ),
      progressBox,
      showResult && updateResult ? updateStatus(updateResult) : null
    ),
    // Když něco nejde: technické údaje do schránky, hráč je vloží do zprávy.
    h(
      'div',
      { class: 'panel stack diagnostics' },
      h('h2', { style: 'margin:0' }, t('aboutDiagnosticsTitle')),
      h('p', { class: 'hint', style: 'margin:0' }, t('aboutDiagnosticsHint')),
      h(
        'div',
        { class: 'row', style: 'align-items:center' },
        h(
          'button',
          {
            class: 'small copy-diagnostics',
            onclick: () =>
              void kine.copyDiagnostics().then(() => {
                diagnosticsCopiedAt = Date.now();
                render();
                setTimeout(() => {
                  if (tab === 'about') render();
                }, 5200);
              }),
          },
          '📋 ' + t('aboutDiagnostics')
        ),
        copied ? h('span', { class: 'ok diagnostics-copied' }, t('aboutDiagnosticsCopied')) : null
      )
    ),
    h('div', { class: 'row' }, h('button', { class: 'quiet danger', onclick: () => void kine.quit() }, t('trayQuit')))
  );
}

// ---- průvodce ------------------------------------------------------------------------------

const WIZARD_STEPS = 4;

function renderWizard() {
  const step = wizardStep ?? 0;
  const steps = h('div', { class: 'steps' }, ...Array.from({ length: WIZARD_STEPS }, (_, i) => h('span', { class: i <= step ? 'done' : '' })));
  const box = h('div', { class: 'wizard stack' }, steps);
  const go = (n: number) => () => {
    wizardStep = n;
    render();
  };

  if (step === 0) {
    box.append(
      h('div', { class: 'brand', style: 'padding:0 0 6px' }, brandMark(), 'Kine', brandTag()),
      h('h1', {}, t('wizardWelcome')),
      h('p', { class: 'dim' }, t('wizardIntro', { seconds: settings.clipSeconds })),
      h('h2', {}, t('wizardChooseLanguage')),
      h(
        'div',
        { class: 'lang-grid' },
        ...LANGS.map((code) =>
          h('button', { class: `lang ${settings.lang === code ? 'active' : ''}`, onclick: () => update({ lang: code }) }, LANG_NAMES[code])
        )
      ),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'primary', onclick: go(1) }, t('next')))
    );
  } else if (step === 1) {
    box.append(
      h('h1', {}, t('wizardStepAccount')),
      renderAccount(true),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: go(0) }, t('back')),
        h('button', { class: status.account ? 'primary' : '', onclick: go(2) }, status.account ? t('next') : t('wizardSkipLogin'))
      )
    );
    if (status.account) {
      // Po přihlášení se jde samo dál.
      setTimeout(() => {
        if (wizardStep === 1 && status.account) {
          wizardStep = 2;
          render();
        }
      }, 900);
    }
  } else if (step === 2) {
    box.append(
      h('h1', {}, t('wizardStepHotkey')),
      h(
        'div',
        { class: 'panel stack' },
        hotkeyField('clipHotkey', t('clipHotkey'), t('clipHotkeyHint')),
        h(
          'label',
          {},
          t('clipSeconds'),
          h(
            'select',
            { style: 'width:auto', onchange: (e: Event) => update({ clipSeconds: Number((e.target as HTMLSelectElement).value) }) },
            ...clipOptionsFor(status.account?.plan).map((n) => h('option', { value: String(n), selected: n === settings.clipSeconds }, `${n} s`))
          )
        )
      ),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: go(1) }, t('back')),
        h('button', { class: 'primary', onclick: () => { wizardStep = 3; update({ onboarded: true }); } }, t('next'))
      )
    );
  } else {
    const full = settings.appMode === 'full';
    box.append(
      h('h1', {}, t('wizardDoneTitle')),
      h('p', { class: 'dim' }, t(full ? 'wizardDoneTextFull' : 'wizardDoneText', { hotkey: hotkeyLabel(settings.clipHotkey) })),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: () => { wizardStep = null; tab = 'clips'; render(); } }, t('tabClips')),
        h(
          'div',
          { class: 'row' },
          full ? h('button', { class: 'primary', onclick: () => { wizardStep = null; tab = 'kine'; render(); } }, t('wizardOpenKine')) : null,
          h('button', { class: full ? '' : 'primary', onclick: () => window.close() }, t('wizardFinish'))
        )
      )
    );
  }
  return box;
}

void init();
