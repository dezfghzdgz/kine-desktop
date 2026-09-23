import type { KineBridge } from '../preload/preload';
import type { Clip, DisplayInfo, GameSource, Lang, ProcessInfo, Settings, Status, UploadRequest } from '../shared/types';
import { CATEGORY_KEYS, LANGS, TRASH_DAYS, VISIBILITIES } from '../shared/types';
import { LANG_NAMES, makeT, type Key } from '../shared/i18n';
import { HotkeyRecorder, formatHotkey, hotkeyLabel } from '../shared/hotkeys';
import { DISCORD_FILE_MAX_BYTES, isDiscordWebhook, suggestedMbps } from '../shared/settingsSchema';
import { applyBrandColor, clipOptionsFor, maxClipSecondsFor } from '../shared/plan';
import { performanceProfile } from '../shared/performance';
import { clear, clipMeta, errorText, fileUrl, formatBytes, formatDate, formatDuration, h } from './ui';
import { closePlayer, openPlayer, openPlayerId, type Neighbors, type PlayerHandle } from './player';
import { VIDEO_LANGS, openUploadDialog } from './uploadDialog';

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

type Tab = 'kine' | 'clips' | 'settings' | 'games' | 'upload' | 'account' | 'about';
const TABS: Tab[] = ['kine', 'clips', 'settings', 'games', 'upload', 'account', 'about'];
const TAB_KEYS: Record<Tab, Key> = { kine: 'tabKine', clips: 'tabClips', settings: 'tabSettings', games: 'tabGames', upload: 'tabUpload', account: 'tabAccount', about: 'tabAbout' };
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
let hotkeyRecording: 'clipHotkey' | 'toggleHotkey' | 'recordHotkey' | null = null;
let hotkeyError: string | null = null;
const recorder = new HotkeyRecorder();
let updateResult: { status: string; version?: string; url?: string; message?: string; source?: string; waitingForGame?: boolean } | null = null;
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

function hotkeyField(field: 'clipHotkey' | 'toggleHotkey' | 'recordHotkey', label: string, hint?: string, options: { clearable?: boolean } = {}) {
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

function render() {
  applyBrandColor(document.documentElement, settings.brandColor || null);
  const main = app.querySelector('.main');
  const scrollTop = main ? main.scrollTop : 0;
  const active = document.activeElement as HTMLElement | null;
  const searchHadFocus = focusSearch || (active?.classList.contains('clips-search') ?? false);
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
}

function clipsPlus(): boolean {
  return status.account?.clipsPlus === true;
}

/** Je zapnuté úsporné nastavení (720p / 30 fps / 5 Mb/s)? */
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
  if (status.recordingSince && !recTimer) {
    recTimer = setInterval(() => {
      const el = app.querySelector('.rec-time');
      if (el) el.textContent = recordingTime();
    }, 1000);
  } else if (!status.recordingSince && recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
}

/** Ikony položek postranního panelu (čáry, currentColor) - ať se v seznamu dá rychle zorientovat. */
const TAB_ICONS: Record<Tab, string> = {
  kine: '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M10 8.3v5.4l4.8-2.7z" fill="currentColor" stroke="none"/>',
  clips: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
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
function renderSide() {
  const st = statusText();
  const tabs = visibleTabs();
  const top = tabs.filter((x) => x === 'kine' || x === 'clips');
  const rest = tabs.filter((x) => x !== 'kine' && x !== 'clips');
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
      ...status.hotkeyProblems.map((p) => h('div', { class: 'side-sub warn' }, '⚠ ' + p)),
      h(
        'div',
        { class: 'side-actions' },
        h('button', { class: 'small primary side-clip', disabled: !capturing, title: hotkeyLabel(settings.clipHotkey), onclick: () => void kine.clipNow() }, '● ' + t('sideSaveClip')),
        pauseBtn
      ),
      // Nahrávání celého zápasu: start, nebo běžící čas + stop.
      h(
        'div',
        { class: 'side-actions' },
        status.recordingSince
          ? h(
              'button',
              { class: 'small side-record recording', title: settings.recordHotkey ? hotkeyLabel(settings.recordHotkey) : '', onclick: () => void kine.toggleRecording() },
              h('span', { class: 'rec-dot' }),
              h('span', { class: 'rec-time' }, recordingTime()),
              ' · ' + t('sideRecordStop')
            )
          : h(
              'button',
              { class: 'small quiet side-record', disabled: !capturing, title: settings.recordHotkey ? hotkeyLabel(settings.recordHotkey) : '', onclick: () => void kine.toggleRecording() },
              '⏺ ' + t('sideRecord')
            )
      ),
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
    ...status.hotkeyProblems.map((p) => h('span', { class: 'bar-item warn', title: p }, '⚠ ', p)),
    h('span', { class: 'grow' }),
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
    h(
      'div',
      { class: 'panel stack' },
      h('h2', {}, t('audioTitle')),
      checkbox('systemAudio', t('systemAudio'), win ? undefined : t('windowsOnly'), !win),
      checkbox('microphone', t('microphone'), t('microphoneHint'))
    ),
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
      checkbox('toast', t('toastSetting'), t('toastSettingHint'))
    ),
    variantPanel(),
    h(
      'div',
      { class: 'panel stack' },
      h('h2', {}, t('generalTitle')),
      h('label', {}, t('language'), languageSelect()),
      checkbox('startWithSystem', t('startWithSystem')),
      h('p', { class: 'hint', style: 'margin:0' }, t('brandColorHint'))
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
  return h('div', { class: 'state error' }, t('uploadError', { message: u.message }));
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
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => void kine.openClipsDir() }, t('clipsDirOpen')))
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
      { class: 'thumb', onclick: () => showClip(clip) },
      // Náhledy se načítají, až když se karta dostane na obrazovku - u stovek klipů to šetří paměť i disk.
      clip.thumb ? h('img', { src: fileUrl(clip.thumb), alt: '', loading: 'lazy', decoding: 'async' }) : null,
      h('span', { class: 'play-badge' }, '▶'),
      clip.kind === 'recording' ? h('span', { class: 'kind-badge' }, '⏺ ' + t('libraryRecordingBadge')) : null,
      h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
    );
    thumb.addEventListener('mouseenter', () => startPreview(thumb, clip));
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

function renderAbout() {
  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('aboutTitle')),
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
      updateResult ? updateStatus(updateResult) : null
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
