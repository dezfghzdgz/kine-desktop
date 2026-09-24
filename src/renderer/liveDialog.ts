import type { LiveQuality, Settings } from '../shared/types';
import type { Key } from '../shared/i18n';
import { LIVE_QUALITIES, cleanLiveError, liveErrorTextKey, livePresetLabel } from '../shared/live';
import { h } from './ui';

/**
 * Dialog "Vysílat na Kine": název přenosu a kvalita, pak jedno tlačítko.
 * Klíč pro vysílání si appka vezme z Kine sama; popis, kategorie a záznamy
 * jsou ve studiu na webu (odkaz dole). Když vysílání nejde (nepřihlášený,
 * Kine ho ještě nemá zapnuté, špatný internet), řekne to tady a nic neběží.
 */
type T = (key: Key, vars?: Record<string, string | number>) => string;

export type LiveDialogOptions = {
  settings: Settings;
  t: T;
  /** Předvyplněný název (poslední vysílání, hra). */
  defaultTitle: string;
  loggedIn: boolean;
  onStart: (opts: { title: string; quality: LiveQuality }) => Promise<void>;
  onOpenStudio: () => void;
  onSignIn: () => void;
};

export type LiveDialogHandle = { close: () => void };

let current: LiveDialogHandle | null = null;

export function liveDialogOpen(): boolean {
  return !!current;
}

export function openLiveDialog(o: LiveDialogOptions): LiveDialogHandle {
  current?.close();
  const { t } = o;
  let busy = false;

  const titleInput = h('input', { type: 'text', class: 'live-title', maxlength: '100', placeholder: t('liveDefaultTitle') }) as HTMLInputElement;
  titleInput.value = o.defaultTitle;
  const quality = h('select', { class: 'live-quality' }, ...LIVE_QUALITIES.map((q) => h('option', { value: q }, livePresetLabel(q)))) as HTMLSelectElement;
  quality.value = o.settings.liveQuality;
  const error = h('p', { class: 'hint warn live-error hidden' });
  const start = h('button', { class: 'primary live-start', onclick: () => void go() }, '● ' + t('liveDialogStart')) as HTMLButtonElement;

  const overlay = h('div', { class: 'overlay live-overlay' });
  const box = h(
    'div',
    { class: 'player-box live-dialog', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'player-head' },
      h('div', { class: 'title' }, h('span', { class: 'live-dot' }), t('liveDialogTitle')),
      h('button', { class: 'small quiet player-close', title: t('close'), onclick: () => close() }, '✕')
    ),
    h(
      'div',
      { class: 'live-body stack' },
      h('p', { class: 'hint' }, t('liveDialogIntro')),
      o.loggedIn
        ? null
        : h(
            'p',
            { class: 'hint warn live-login' },
            t('liveNeedLogin'),
            ' ',
            h(
              'button',
              {
                class: 'small',
                onclick: () => {
                  close();
                  o.onSignIn();
                },
              },
              t('sideSignIn')
            )
          ),
      h('div', { class: 'field' }, h('label', {}, t('liveDialogName')), titleInput),
      h('div', { class: 'field' }, h('label', {}, t('liveDialogQuality')), quality, h('p', { class: 'hint' }, t('liveDialogQualityHint'))),
      h('button', { class: 'small quiet live-studio', onclick: () => o.onOpenStudio() }, t('liveDialogStudio') + ' →'),
      error,
      h('div', { class: 'row live-actions' }, start, h('button', { class: 'quiet', onclick: () => close() }, t('cancel')))
    )
  );
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && !busy) close();
  });

  async function go() {
    if (busy) return;
    busy = true;
    start.disabled = true;
    start.textContent = t('liveDialogStarting');
    error.classList.add('hidden');
    try {
      await o.onStart({ title: titleInput.value.trim(), quality: quality.value as LiveQuality });
      close();
    } catch (e) {
      const message = cleanLiveError((e as Error).message ?? String(e));
      const key = liveErrorTextKey(message);
      error.textContent = t(key, key === 'liveErrOther' ? { message: message.slice(0, 160) } : {});
      error.classList.remove('hidden');
      busy = false;
      start.disabled = false;
      start.textContent = '● ' + t('liveDialogStart');
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.target === titleInput || e.target === quality)) {
      e.preventDefault();
      void go();
    }
  }

  function close() {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current === handle) current = null;
  }

  const handle: LiveDialogHandle = { close };
  current = handle;
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  titleInput.focus();
  titleInput.select();
  return handle;
}
