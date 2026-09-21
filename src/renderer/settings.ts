import type { KineBridge } from '../preload/preload';
import type { Clip, DisplayInfo, ProcessInfo, Settings, Status } from '../shared/types';
import { makeT, type Key } from '../shared/i18n';
import { acceleratorFromKey, acceleratorLabel } from '../shared/accelerator';
import { suggestedMbps } from '../shared/settingsSchema';
import { applyBrandColor, clipOptionsFor, maxClipSecondsFor } from '../shared/plan';
import { clear, clipMeta, fileUrl, formatDuration, h } from './ui';

/**
 * Okno nastavení + průvodce při prvním spuštění + knihovna klipů.
 *
 * Bez knihovny pro UI: stránka se po každé změně vykreslí znovu z dat
 * (settings, status, clips). Změny se ukládají hned, žádné "Uložit".
 */
declare const window: Window & { kine: KineBridge };
const kine = window.kine;
const app = document.getElementById('app') as HTMLDivElement;

type Tab = 'account' | 'clips' | 'games' | 'upload' | 'library' | 'about';
const TABS: Tab[] = ['account', 'clips', 'games', 'upload', 'library', 'about'];

let settings: Settings;
let status: Status;
let clips: Clip[] = [];
let displays: DisplayInfo[] = [];
let processes: ProcessInfo[] | null = null;
let currentGame: { name: string; exe: string } | null = null;
let tab: Tab = 'clips';
let wizardStep: number | null = null;
let authWaiting = false;
let authError: string | null = null;
let hotkeyRecording: 'clipHotkey' | 'toggleHotkey' | null = null;
let hotkeyError: string | null = null;
let updateResult: { status: string; version?: string } | null = null;
let confirmDelete: string | null = null;
let renaming: string | null = null;
let addGameOpen = false;

const t = (key: Key, vars?: Record<string, string | number>) => makeT(settings.lang)(key, vars);

async function init() {
  const params = new URLSearchParams(location.search);
  [settings, status, clips, displays] = await Promise.all([kine.getSettings(), kine.getStatus(), kine.listClips(), kine.listDisplays()]);
  currentGame = await kine.currentGame();
  const wanted = params.get('tab');
  if (!settings.onboarded || wanted === 'wizard') wizardStep = 0;
  else if (wanted && TABS.includes(wanted as Tab)) tab = wanted as Tab;
  render();

  kine.onSettings((s) => {
    settings = s;
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
    render();
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
    }
  });
  document.addEventListener('keydown', onKeyDown, true);
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
    hotkeyRecording = null;
    render();
    return;
  }
  const acc = acceleratorFromKey(e);
  if (!acc) return;
  const field = hotkeyRecording;
  void kine.hotkeyAvailable(acc).then((ok) => {
    if (!ok) {
      hotkeyError = t('hotkeyInUse');
      render();
      return;
    }
    hotkeyError = null;
    hotkeyRecording = null;
    update({ [field]: acc } as Partial<Settings>);
  });
}

function hotkeyField(field: 'clipHotkey' | 'toggleHotkey', label: string, hint?: string) {
  const recording = hotkeyRecording === field;
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
            hotkeyRecording = field;
            hotkeyError = null;
            render();
          },
        },
        recording ? t('hotkeyPress') : acceleratorLabel(settings[field])
      ),
      hotkeyError && recording ? h('span', { class: 'error' }, hotkeyError) : null
    ),
    hint ? h('p', { class: 'hint' }, hint) : null
  );
}

// ---- vykreslení -------------------------------------------------------------------

function render() {
  applyBrandColor(document.documentElement, settings.brandColor || null);
  clear(app);
  if (wizardStep !== null) {
    app.append(h('div', { class: 'main' }, renderWizard()));
    return;
  }
  app.append(renderSide(), h('div', { class: 'main' }, h('div', { class: 'page' }, renderTab())));
}

function hasPlus(): boolean {
  return status.account?.plan === 'plus';
}

function maxClip(): number {
  return status.account ? maxClipSecondsFor(status.account) : 60;
}

function plusLink(label?: string) {
  return h('button', { class: 'small quiet', onclick: () => void kine.openExternal(`${settings.siteUrl}/plus`) }, label ?? t('plusLearnMore'));
}

function statusText(): { text: string; cls: string } {
  if (status.paused) return { text: t('trayPaused'), cls: '' };
  if (status.capture === 'error') return { text: status.captureError ?? 'error', cls: 'err' };
  if (status.capture === 'on' || status.capture === 'starting') {
    return { text: status.game ? t('trayCapturing', { game: status.game }) : t('trayCapturingNoGame'), cls: 'on' };
  }
  if (settings.detection === 'manual') return { text: t('trayIdleManual', { hotkey: acceleratorLabel(settings.toggleHotkey) }), cls: '' };
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
        t(`tab${name[0].toUpperCase()}${name.slice(1)}` as Key)
      )
    ),
    h(
      'div',
      { class: 'status' },
      h('div', {}, h('span', { class: `dot ${st.cls}` }), h('b', {}, st.text)),
      status.uploadsPending > 0
        ? h('div', {}, status.uploadsPaused ? t('trayUploadsPaused', { count: status.uploadsPending }) : t('trayUploads', { count: status.uploadsPending }))
        : null,
      h('div', {}, status.account ? `@${status.account.username}` : t('trayNotLoggedIn'))
    )
  );
}

function renderTab() {
  switch (tab) {
    case 'account':
      return renderAccount();
    case 'clips':
      return renderClips();
    case 'games':
      return renderGames();
    case 'upload':
      return renderUpload();
    case 'library':
      return renderLibrary();
    case 'about':
      return renderAbout();
  }
}

// ---- účet ---------------------------------------------------------------------------

function renderAccount(inWizard = false) {
  const account = status.account;
  const container = h('div', { class: 'stack' });
  if (!inWizard) container.append(h('h1', {}, t('accountTitle')));

  if (account) {
    const plus = account.plan === 'plus';
    const until = account.planUntil ? new Date(account.planUntil).toLocaleDateString(settings.lang === 'cs' ? 'cs-CZ' : 'en-GB') : null;
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
          h('div', { class: 'row' }, plus ? h('span', { class: 'plan-pill' }, 'PLUS') : null, h('b', {}, plus ? (until ? t('planPlusUntil', { date: until }) : t('planPlus')) : t('planFree'))),
          plusLink(plus ? 'Kine Plus' : undefined)
        ),
        h('p', { class: 'hint', style: 'margin:0' }, plus ? t('planPlusHint', { max: account.maxClipSeconds }) : t('planFreeHint', { max: account.maxClipSeconds }))
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
              authError = t('accountLoginFailed', { message: cleanError(err) });
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
                      authError = t('accountLinkFailed', { message: cleanError(err) });
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

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Electron obaluje chyby z hlavního procesu: "Error invoking remote method '...': Error: text"
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ---- klipy (zkratka, kvalita) ------------------------------------------------------------

function renderClips() {
  const limit = maxClip();
  const seconds = Math.min(settings.clipSeconds, limit);
  const secondsOptions = [...clipOptionsFor(status.account?.plan)].filter((n) => n <= limit) as number[];
  if (!secondsOptions.includes(seconds)) secondsOptions.push(seconds);
  secondsOptions.sort((a, b) => a - b);
  const win = kine.platform === 'win32';

  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('clipsTitle')),
    h(
      'div',
      { class: 'panel stack' },
      hotkeyField('clipHotkey', t('clipHotkey'), t('clipHotkeyHint')),
      hotkeyField('toggleHotkey', t('toggleHotkey')),
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
        h('p', { class: 'hint' }, t('clipSecondsHint') + ' ' + (hasPlus() ? t('clipSecondsPlusHint', { max: limit }) : t('clipSecondsFreeHint', { max: limit }))),
        hasPlus() ? null : h('div', {}, plusLink())
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
      checkbox('systemAudio', t('systemAudio'), win ? undefined : 'Windows only', !win),
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
    )
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
  const exeInput = h('input', { type: 'text', placeholder: 'hra.exe' }) as HTMLInputElement;
  const nameInput = h('input', { type: 'text' }) as HTMLInputElement;

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
      )
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
              p.exe
            )
          )
        )
      : null
  );

  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('gamesTitle')),
    h(
      'div',
      { class: 'panel radio-group' },
      radio('detection', 'games', t('detectionGames'), t('detectionGamesHint')),
      radio('detection', 'always', t('detectionAlways'), t('detectionAlwaysHint')),
      radio('detection', 'manual', t('detectionManual'), t('detectionManualHint', { hotkey: acceleratorLabel(settings.toggleHotkey) }))
    ),
    h(
      'div',
      { class: 'panel stack' },
      h('div', { class: 'spread' }, h('h2', { style: 'margin:0' }, t('customGamesTitle')), h('span', { class: 'faint' }, currentGame ? t('gameNowRunning', { game: currentGame.name }) : t('gameNoneRunning'))),
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

const VIDEO_LANGS: [string, string][] = [['cs', 'Čeština'], ['sk', 'Slovenčina'], ['en', 'English'], ['de', 'Deutsch'], ['pl', 'Polski'], ['es', 'Español'], ['fr', 'Français'], ['uk', 'Українська']];

function renderUpload() {
  return h(
    'div',
    { class: 'stack' },
    h('h1', {}, t('uploadTitle')),
    h(
      'div',
      { class: 'panel radio-group' },
      radio('afterGame', 'review', t('afterGameReview')),
      hasPlus()
        ? radio('afterGame', 'auto', t('afterGameAuto'), t('afterGameAutoHint'))
        : h(
            'label',
            { class: 'check locked' },
            h('input', { type: 'radio', name: 'afterGame', disabled: true }),
            h(
              'span',
              {},
              t('afterGameAutoLocked'),
              h('span', { class: 'sub' }, status.account?.plusPriceLabel ? t('plusOnlyPrice', { price: status.account.plusPriceLabel }) : t('plusOnly'))
            )
          ),
      radio('afterGame', 'none', t('afterGameNone')),
      hasPlus() ? null : h('div', { class: 'row' }, h('span', { class: 'plan-pill' }, 'PLUS'), plusLink())
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

// ---- knihovna ---------------------------------------------------------------------------

function uploadState(clip: Clip) {
  const u = clip.upload;
  if (!u) return null;
  if (u.state === 'queued') return h('div', { class: 'state' }, t('uploadQueued'));
  if (u.state === 'uploading') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t('uploadUploading', { percent: u.percent })));
  if (u.state === 'paused') return h('div', {}, h('div', { class: 'progress' }, h('span', { style: `width:${u.percent}%` })), h('div', { class: 'state' }, t(u.reason === 'game' ? 'uploadPausedGame' : 'uploadPausedOffline', { percent: u.percent })));
  if (u.state === 'done') return h('div', { class: 'state done' }, '✓ ' + t('uploadDone'));
  return h('div', { class: 'state error' }, t('uploadError', { message: u.message }));
}

function renderLibrary() {
  const list = clips;
  const container = h('div', { class: 'stack' }, h('div', { class: 'spread' }, h('h1', {}, t('libraryTitle')), h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => void kine.openClipsDir() }, t('clipsDirOpen')))));
  if (list.length === 0) {
    container.append(h('div', { class: 'empty' }, t('libraryEmpty', { hotkey: acceleratorLabel(settings.clipHotkey) })));
    return container;
  }
  const grid = h('div', { class: 'clips' });
  for (const clip of list) {
    const canUpload = !clip.upload || clip.upload.state === 'error';
    const actions = h('div', { class: 'actions' });
    actions.append(h('button', { class: 'small', onclick: () => void kine.openClip(clip.id) }, t('libraryOpen')));
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
        ? h('button', { class: 'small danger', onclick: () => { confirmDelete = null; void kine.deleteClip(clip.id); } }, t('libraryDeleteConfirm'))
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

    grid.append(
      h(
        'div',
        { class: 'clip' },
        h('div', { class: 'thumb', ondblclick: () => void kine.openClip(clip.id) }, clip.thumb ? h('img', { src: fileUrl(clip.thumb), alt: '' }) : null, h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))),
        h('div', { class: 'body' }, titleEl, h('div', { class: 'meta' }, [clip.game, clipMeta(clip, settings.lang)].filter(Boolean).join(' · ')), uploadState(clip), actions)
      )
    );
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
        h('button', { class: 'small quiet', onclick: () => void kine.openExternal(settings.siteUrl) }, t('trayOpenKine'))
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
    h(
      'div',
      { class: 'panel' },
      h(
        'label',
        {},
        'Jazyk / Language',
        h(
          'select',
          { style: 'width:auto', onchange: (e: Event) => update({ lang: (e.target as HTMLSelectElement).value as Settings['lang'] }) },
          h('option', { value: 'cs', selected: settings.lang === 'cs' }, 'Čeština'),
          h('option', { value: 'en', selected: settings.lang === 'en' }, 'English')
        )
      )
    ),
    h('div', { class: 'row' }, h('button', { class: 'quiet danger', onclick: () => void kine.quit() }, t('trayQuit')))
  );
}

// ---- průvodce ------------------------------------------------------------------------------

function renderWizard() {
  const step = wizardStep ?? 0;
  const steps = h('div', { class: 'steps' }, ...[0, 1, 2, 3].map((i) => h('span', { class: i <= step ? 'done' : '' })));
  const box = h('div', { class: 'wizard stack' }, steps);

  if (step === 0) {
    box.append(
      h('div', { class: 'brand', style: 'padding:0 0 6px' }, h('span', { class: 'mark' }), 'Kine'),
      h('h1', {}, t('wizardWelcome')),
      h('p', { class: 'dim' }, t('wizardIntro', { seconds: settings.clipSeconds })),
      h(
        'div',
        { class: 'row' },
        h(
          'select',
          { style: 'width:auto', onchange: (e: Event) => update({ lang: (e.target as HTMLSelectElement).value as Settings['lang'] }) },
          h('option', { value: 'cs', selected: settings.lang === 'cs' }, 'Čeština'),
          h('option', { value: 'en', selected: settings.lang === 'en' }, 'English')
        ),
        h('span', { class: 'grow' }),
        h('button', { class: 'primary', onclick: () => { wizardStep = 1; render(); } }, t('next'))
      )
    );
  } else if (step === 1) {
    box.append(
      h('h1', {}, t('wizardStepAccount')),
      renderAccount(true),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: () => { wizardStep = 0; render(); } }, t('back')),
        h('button', { class: status.account ? 'primary' : '', onclick: () => { wizardStep = 2; render(); } }, status.account ? t('next') : t('wizardSkipLogin'))
      )
    );
    if (status.account && step === 1) {
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
        h('button', { class: 'quiet', onclick: () => { wizardStep = 1; render(); } }, t('back')),
        h('button', { class: 'primary', onclick: () => { wizardStep = 3; update({ onboarded: true }); } }, t('next'))
      )
    );
  } else {
    box.append(
      h('h1', {}, t('wizardDoneTitle')),
      h('p', { class: 'dim' }, t('wizardDoneText', { hotkey: acceleratorLabel(settings.clipHotkey) })),
      h(
        'div',
        { class: 'spread' },
        h('button', { class: 'quiet', onclick: () => { wizardStep = null; tab = 'clips'; render(); } }, t('traySettings')),
        h('button', { class: 'primary', onclick: () => window.close() }, t('wizardFinish'))
      )
    );
  }
  return box;
}

void init();
