import type { KineBridge } from '../preload/preload';
import type { Clip, DisplayInfo, GameSource, Lang, ProcessInfo, Settings, Status } from '../shared/types';
import { LANGS } from '../shared/types';
import { LANG_NAMES, makeT, type Key } from '../shared/i18n';
import { HotkeyRecorder, formatHotkey, hotkeyLabel } from '../shared/hotkeys';
import { suggestedMbps } from '../shared/settingsSchema';
import { applyBrandColor, clipOptionsFor, maxClipSecondsFor } from '../shared/plan';
import { clear, clipMeta, errorText, fileUrl, formatDate, formatDuration, h, inlinePlayer } from './ui';

/**
 * Hlavní okno: klipy (první záložka), nastavení, hry, nahrávání, účet,
 * o appce + průvodce při prvním spuštění.
 *
 * Bez knihovny pro UI: stránka se po každé změně vykreslí znovu z dat
 * (settings, status, clips). Změny se ukládají hned, žádné "Uložit".
 * Přehrávač klipu žije ve stejném okně - karta se roztáhne a hraje.
 */
declare const window: Window & { kine: KineBridge };
const kine = window.kine;
const app = document.getElementById('app') as HTMLDivElement;

type Tab = 'clips' | 'settings' | 'games' | 'upload' | 'account' | 'about';
const TABS: Tab[] = ['clips', 'settings', 'games', 'upload', 'account', 'about'];
const TAB_KEYS: Record<Tab, Key> = { clips: 'tabClips', settings: 'tabSettings', games: 'tabGames', upload: 'tabUpload', account: 'tabAccount', about: 'tabAbout' };

type DateFilter = 'all' | 'today' | 'week' | 'month';

let settings: Settings;
let status: Status;
let clips: Clip[] = [];
let displays: DisplayInfo[] = [];
let processes: ProcessInfo[] | null = null;
let currentGame: { name: string; exe: string; source: GameSource } | null = null;
let gameNames: string[] = [];
let tab: Tab = 'clips';
let wizardStep: number | null = null;
let authWaiting = false;
let authError: string | null = null;
let hotkeyRecording: 'clipHotkey' | 'toggleHotkey' | null = null;
let hotkeyError: string | null = null;
const recorder = new HotkeyRecorder();
let updateResult: { status: string; version?: string } | null = null;
let confirmDelete: string | null = null;
let renaming: string | null = null;
let editingGame: string | null = null;
let addGameOpen = false;
let namingGame = false;
let playing: string | null = null;
const players = new Map<string, HTMLElement>();
const filters: { game: string; date: DateFilter; query: string } = { game: 'all', date: 'all', query: '' };
let focusSearch = false;

const t = (key: Key, vars?: Record<string, string | number>) => makeT(settings.lang)(key, vars);

async function init() {
  const params = new URLSearchParams(location.search);
  [settings, status, clips, displays] = await Promise.all([kine.getSettings(), kine.getStatus(), kine.listClips(), kine.listDisplays()]);
  currentGame = await kine.currentGame();
  const wanted = params.get('tab');
  if (!settings.onboarded || wanted === 'wizard') wizardStep = 0;
  else if (wanted && TABS.includes(wanted as Tab)) tab = wanted as Tab;
  render();
  void refreshGameNames();

  kine.onSettings((s) => {
    settings = s;
    document.documentElement.lang = s.lang;
    render();
  });
  kine.onStatus((s) => {
    status = s;
    void kine.currentGame().then((g) => {
      currentGame = g;
      render();
    });
  });
  kine.onClips((c) => {
    clips = c;
    if (playing && !clips.some((x) => x.id === playing)) playing = null;
    render();
    void refreshGameNames();
  });
  kine.onAuthWaiting((w) => {
    authWaiting = w;
    render();
  });
  kine.onNavigate((target) => {
    if (TABS.includes(target as Tab)) {
      tab = target as Tab;
      wizardStep = null;
      render();
    } else if (target === 'wizard') {
      wizardStep = 0;
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

// ---- zkratky ---------------------------------------------------------------------

function onKeyDown(e: KeyboardEvent) {
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
    update({ [field]: text } as Partial<Settings>);
  });
}

function hotkeyField(field: 'clipHotkey' | 'toggleHotkey', label: string, hint?: string) {
  const recording = hotkeyRecording === field;
  const held = recording ? recorder.current() : null;
  const heldText = held && held.mods.length + held.keys.length + held.mouse.length > 0 ? hotkeyLabel(formatHotkey(held)) : '';
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
          class: `hotkey ${recording ? 'recording' : ''}`,
          tabindex: '0',
          role: 'button',
          onclick: () => {
            if (hotkeyRecording === field) return;
            hotkeyRecording = field;
            hotkeyError = null;
            recorder.reset();
            render();
          },
        },
        recording ? (heldText ? t('hotkeyHold', { keys: heldText }) : t('hotkeyPress')) : hotkeyLabel(settings[field])
      ),
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
  clear(app);
  if (wizardStep !== null) {
    app.append(h('div', { class: 'main' }, renderWizard()));
    return;
  }
  const newMain = h('div', { class: 'main' }, h('div', { class: `page ${tab === 'clips' ? 'wide' : ''}` }, renderTab()));
  app.append(renderSide(), newMain);
  newMain.scrollTop = scrollTop;
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

function renderSide() {
  const st = statusText();
  return h(
    'nav',
    { class: 'side' },
    h('div', { class: 'brand' }, h('span', { class: 'mark' }), 'Kine'),
    ...TABS.map((name) =>
      h(
        'button',
        {
          class: `tab ${tab === name ? 'active' : ''}`,
          onclick: () => {
            tab = name;
            render();
          },
        },
        t(TAB_KEYS[name]),
        name === 'clips' && clips.length > 0 ? h('span', { class: 'count' }, String(clips.length)) : null
      )
    ),
    settings.appMode === 'full' ? h('button', { class: 'tab', onclick: () => void kine.openKine() }, t('trayOpenKine')) : null,
    h(
      'div',
      { class: 'status' },
      h('div', {}, h('span', { class: `dot ${st.cls}` }), h('b', {}, st.text)),
      status.uploadsPending > 0
        ? h('div', {}, status.uploadsPaused ? t('trayUploadsPaused', { count: status.uploadsPending }) : t('trayUploads', { count: status.uploadsPending }))
        : null,
      ...status.hotkeyProblems.map((p) => h('div', { class: 'warn' }, p)),
      h('div', {}, status.account ? `@${status.account.username}` : t('trayNotLoggedIn'))
    )
  );
}

function renderTab() {
  switch (tab) {
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

function modeRadios() {
  return h(
    'div',
    { class: 'radio-group' },
    radio('appMode', 'clipper', t('modeClipper'), t('modeClipperHint')),
    radio('appMode', 'full', t('modeFull'), t('modeFullHint'))
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
    h(
      'div',
      { class: 'panel stack' },
      h('h2', {}, t('qualityTitle')),
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
      checkbox('toast', t('toastSetting'), t('toastSettingHint'))
    ),
    h('div', { class: 'panel stack' }, h('h2', {}, t('modeTitle')), modeRadios()),
    h('div', { class: 'panel' }, h('label', {}, t('language'), languageSelect()))
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
    h('input', { type: 'radio', name: String(field), checked: settings[field] === value, onchange: () => update({ [field]: value } as Partial<Settings>) }),
    h('span', {}, label, hint ? h('span', { class: 'sub' }, hint) : null)
  );
}

// ---- hry ----------------------------------------------------------------------------

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

const VIDEO_LANGS: [string, string][] = [['en', 'English'], ['cs', 'Čeština'], ['sk', 'Slovenčina'], ['de', 'Deutsch'], ['pl', 'Polski'], ['es', 'Español'], ['fr', 'Français'], ['uk', 'Українська']];

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
            { onchange: (e: Event) => update({ visibility: (e.target as HTMLSelectElement).value as Settings['visibility'] }) },
            h('option', { value: 'private', selected: settings.visibility === 'private' }, t('visibilityPrivate')),
            h('option', { value: 'public', selected: settings.visibility === 'public' }, t('visibilityPublic'))
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
      )
    ),
    h('div', { class: 'panel' }, h('h2', {}, t('onlyWhenNotPlayingTitle')), h('p', { class: 'dim', style: 'margin:0' }, t('onlyWhenNotPlayingHint'))),
    h('div', { class: 'panel' }, checkbox('startWithSystem', t('startWithSystem')))
  );
}

// ---- klipy ---------------------------------------------------------------------------------

function uploadState(clip: Clip) {
  const u = clip.upload;
  if (!u) return null;
  if (u.state === 'queued') return h('div', { class: 'state' }, t('uploadQueued'));
  if (u.state === 'uploading') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t('uploadUploading', { percent: u.percent })));
  if (u.state === 'paused') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t(u.reason === 'game' ? 'uploadPausedGame' : 'uploadPausedOffline', { percent: u.percent })));
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
  return clips.filter((c) => {
    if (filters.game === 'none' && c.game) return false;
    if (filters.game !== 'all' && filters.game !== 'none' && c.game !== filters.game) return false;
    if (since && new Date(c.createdAt).getTime() < since) return false;
    if (q && !`${c.title} ${c.game ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function togglePlay(clip: Clip) {
  if (playing === clip.id) {
    playing = null;
  } else {
    playing = clip.id;
    players.clear();
  }
  render();
}

function playerFor(clip: Clip): HTMLElement {
  // Stejný prvek <video> přežije překreslení - jinak by se video po každé změně stavu rozjelo od začátku.
  let el = players.get(clip.id);
  if (!el) {
    el = inlinePlayer(clip, t('playerClose'), () => {
      playing = null;
      players.clear();
      render();
    });
    players.set(clip.id, el);
  }
  return el;
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
  const list = filteredClips();
  const filtersActive = filters.game !== 'all' || filters.date !== 'all' || filters.query.trim() !== '';

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

  if (clips.length === 0) {
    container.append(h('div', { class: 'empty' }, t('clipsEmpty', { hotkey: hotkeyLabel(settings.clipHotkey) })));
    return container;
  }

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
      filtersActive
        ? h('button', { class: 'small quiet', style: 'align-self:flex-end', onclick: () => { filters.game = 'all'; filters.date = 'all'; filters.query = ''; render(); } }, t('clipsClearFilters'))
        : null
    )
  );

  if (list.length === 0) {
    container.append(h('div', { class: 'empty' }, t('clipsNoMatch')));
    return container;
  }

  const grid = h('div', { class: 'clips' });
  for (const clip of list) {
    const canUpload = !clip.upload || clip.upload.state === 'error';
    const isPlaying = playing === clip.id;
    const actions = h('div', { class: 'actions' });
    actions.append(h('button', { class: `small ${isPlaying ? 'quiet' : ''}`, onclick: () => togglePlay(clip) }, isPlaying ? t('playerClose') : '▶ ' + t('libraryOpen')));
    if (canUpload) {
      actions.append(
        h(
          'button',
          {
            class: 'small primary',
            disabled: !status.account,
            title: status.account ? '' : t('uploadNeedsLogin'),
            onclick: () => void kine.uploadClips([{ clipId: clip.id, visibility: settings.visibility }]),
          },
          clip.upload?.state === 'error' ? t('libraryRetry') : t('libraryUpload')
        )
      );
    }
    if (clip.upload?.state === 'done') actions.append(h('button', { class: 'small', onclick: () => void kine.openOnKine(clip.id) }, t('libraryOpenOnKine')));
    actions.append(h('button', { class: 'small quiet', onclick: () => void kine.revealClip(clip.id) }, t('libraryReveal')));
    actions.append(
      h('button', { class: 'small quiet', onclick: () => { renaming = clip.id; render(); } }, t('libraryRename')),
      confirmDelete === clip.id
        ? h('button', { class: 'small danger', onclick: () => { confirmDelete = null; if (playing === clip.id) playing = null; void kine.deleteClip(clip.id); } }, t('libraryDeleteConfirm'))
        : h('button', { class: 'small quiet danger', onclick: () => { confirmDelete = clip.id; render(); setTimeout(() => { if (confirmDelete === clip.id) { confirmDelete = null; render(); } }, 4000); } }, t('libraryDelete'))
    );

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

    // Při přehrávání je název v liště přehrávače - v těle karty by byl dvakrát.
    const body = h(
      'div',
      { class: 'body' },
      isPlaying && renaming !== clip.id ? null : titleEl,
      h('div', { class: 'row', style: 'gap:8px' }, gameChip(clip), h('span', { class: 'meta' }, clipMeta(clip, settings.lang))),
      uploadState(clip),
      actions
    );

    if (isPlaying) {
      grid.append(h('div', { class: 'clip playing' }, playerFor(clip), body));
    } else {
      grid.append(
        h(
          'div',
          { class: 'clip' },
          h(
            'div',
            { class: 'thumb', onclick: () => togglePlay(clip) },
            clip.thumb ? h('img', { src: fileUrl(clip.thumb), alt: '' }) : null,
            h('span', { class: 'play-badge' }, '▶'),
            h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
          ),
          body
        )
      );
    }
    if (renaming === clip.id) setTimeout(() => (titleEl as HTMLInputElement).focus?.(), 0);
  }
  container.append(grid);
  return container;
}

// ---- o appce -------------------------------------------------------------------------------

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
      updateResult
        ? h(
            'p',
            { class: updateResult.status === 'error' ? 'error' : 'ok' },
            updateResult.status === 'checking'
              ? t('loading')
              : updateResult.status === 'available'
                ? t('aboutUpdateAvailable', { version: updateResult.version ?? '' })
                : updateResult.status === 'error'
                  ? t('aboutUpdateError')
                  : t('aboutUpToDate')
          )
        : null
    ),
    h('div', { class: 'row' }, h('button', { class: 'quiet danger', onclick: () => void kine.quit() }, t('trayQuit')))
  );
}

// ---- průvodce ------------------------------------------------------------------------------

const WIZARD_STEPS = 5;

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
      h('div', { class: 'brand', style: 'padding:0 0 6px' }, h('span', { class: 'mark' }), 'Kine'),
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
      h('h1', {}, t('wizardStepMode')),
      h('div', { class: 'panel' }, modeRadios()),
      h('div', { class: 'spread' }, h('button', { class: 'quiet', onclick: go(0) }, t('back')), h('button', { class: 'primary', onclick: go(2) }, t('next')))
    );
  } else if (step === 2) {
    box.append(
      h('h1', {}, t('wizardStepAccount')),
      renderAccount(true),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: go(1) }, t('back')),
        h('button', { class: status.account ? 'primary' : '', onclick: go(3) }, status.account ? t('next') : t('wizardSkipLogin'))
      )
    );
    if (status.account) {
      // Po přihlášení se jde samo dál.
      setTimeout(() => {
        if (wizardStep === 2 && status.account) {
          wizardStep = 3;
          render();
        }
      }, 900);
    }
  } else if (step === 3) {
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
        h('button', { class: 'quiet', onclick: go(2) }, t('back')),
        h('button', { class: 'primary', onclick: () => { wizardStep = 4; update({ onboarded: true }); } }, t('next'))
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
          full ? h('button', { class: 'primary', onclick: () => { void kine.openKine(); window.close(); } }, t('wizardOpenKine')) : null,
          h('button', { class: full ? '' : 'primary', onclick: () => window.close() }, t('wizardFinish'))
        )
      )
    );
  }
  return box;
}

void init();
