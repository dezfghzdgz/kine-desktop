import type { KineBridge } from '../preload/preload';
import type { Clip, Settings, Visibility } from '../shared/types';
import { makeT } from '../shared/i18n';
import { clear, clipMeta, fileUrl, formatDuration, h } from './ui';
import { applyBrandColor } from '../shared/plan';
import { openPlayer, type PlayerHandle } from './player';

/**
 * Okýnko po hře: klipy z posledního hraní, každý s náhledem a
 * zaškrtávátkem (výchozí: všechny vybrané), názvy jdou přepsat. Jedno
 * tlačítko nahraje vybrané - nahrávání běží až teď, když se nehraje.
 * Kliknutí na náhled klip přehraje ve vrstvě přes okno (player.ts), kde
 * ho jde před nahráním i zkrátit - mřížka pod tím zůstává, jak je.
 */
declare const window: Window & { kine: KineBridge };
const kine = window.kine;

const app = document.getElementById('app') as HTMLDivElement;
let settings: Settings;
let clips: Clip[] = [];
let sessionId = '';
let selected = new Set<string>();
const titles = new Map<string, string>();
let visibility: Visibility = 'private';
let player: PlayerHandle | null = null;

async function load(id: string) {
  sessionId = id;
  settings = await kine.getSettings();
  visibility = settings.visibility;
  clips = (await kine.reviewClips(sessionId)).filter((c) => !c.upload || c.upload.state === 'error');
  selected = new Set(clips.map((c) => c.id));
  titles.clear();
  player?.close();
  render();
}

/** Klipy se změnily (zkrácení, nový klip vedle, smazání) - seznam se srovná, výběr zůstane. */
async function refresh() {
  if (!sessionId && clips.length === 0) return;
  const fresh = (await kine.reviewClips(sessionId)).filter((c) => !c.upload || c.upload.state === 'error');
  const known = new Set(clips.map((c) => c.id));
  for (const c of fresh) if (!known.has(c.id)) selected.add(c.id);
  for (const id of [...selected]) if (!fresh.some((c) => c.id === id)) selected.delete(id);
  clips = fresh;
  player?.sync(clips);
  render();
}

function showClip(clip: Clip, edit = false) {
  const t = makeT(settings.lang);
  player = openPlayer({
    clip,
    t,
    startEditing: edit,
    onOpenExternal: (c) => void kine.openClip(c.id),
    onLog: (m) => void kine.log(m),
    onClose: () => {
      player = null;
    },
    edit: {
      run: (c, request) => kine.trimClip(c.id, request),
      onProgress: (cb) => kine.onTrimProgress(cb),
    },
  });
}

function render() {
  const t = makeT(settings.lang);
  applyBrandColor(document.documentElement, settings.brandColor || null);
  clear(app);
  // Titulek podle hry, když je u všech stejná; jinak jen počet.
  const games = new Set(clips.map((c) => c.game).filter(Boolean));
  const game = games.size === 1 ? [...games][0] : null;
  const count = clips.length;

  const grid = h('div', { class: 'clips' });
  for (const clip of clips) {
    const isSelected = selected.has(clip.id);
    const check = h('input', {
      type: 'checkbox',
      class: 'pick',
      checked: isSelected,
      onclick: (e: Event) => e.stopPropagation(),
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) selected.add(clip.id);
        else selected.delete(clip.id);
        render();
      },
    });
    const title = h('input', {
      type: 'text',
      class: 'title-edit',
      value: titles.get(clip.id) ?? clip.title,
      placeholder: t('reviewTitlePlaceholder'),
      maxlength: '150',
      oninput: (e: Event) => titles.set(clip.id, (e.target as HTMLInputElement).value),
    });
    const body = h(
      'div',
      { class: 'body' },
      title,
      h('div', { class: 'meta' }, [clip.game, clipMeta(clip, settings.lang)].filter(Boolean).join(' · ')),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'small quiet', onclick: () => showClip(clip) }, '▶ ' + t('libraryOpen')),
        h('button', { class: 'small quiet', onclick: () => showClip(clip, true) }, '✂ ' + t('libraryEdit'))
      )
    );
    const thumb = h(
      'div',
      { class: 'thumb', onclick: () => showClip(clip) },
      clip.thumb ? h('img', { src: fileUrl(clip.thumb), alt: '' }) : null,
      check,
      h('span', { class: 'play-badge' }, '▶'),
      h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
    );
    grid.append(h('div', { class: `clip ${isSelected ? 'selected' : ''}` }, thumb, body));
  }

  const selectedCount = selected.size;
  const visSelect = h(
    'select',
    { style: 'width:auto;min-width:220px', onchange: (e: Event) => (visibility = (e.target as HTMLSelectElement).value as Visibility) },
    h('option', { value: 'private', selected: visibility === 'private' }, t('visibilityPrivate')),
    h('option', { value: 'public', selected: visibility === 'public' }, t('visibilityPublic'))
  );

  app.append(
    h(
      'div',
      { class: 'spread' },
      h('div', {}, h('h1', {}, game ? t('reviewTitle', { count, game }) : t('reviewTitleNoGame', { count })), h('p', { class: 'dim', style: 'margin:0' }, t('reviewIntro'))),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'small quiet', onclick: () => { selected = new Set(clips.map((c) => c.id)); render(); } }, t('reviewSelectAll')),
        h('button', { class: 'small quiet', onclick: () => { selected = new Set(); render(); } }, t('reviewSelectNone'))
      )
    ),
    count === 0 ? h('div', { class: 'empty' }, t('reviewNone')) : grid,
    h(
      'div',
      { class: 'foot' },
      h('label', { class: 'row', style: 'gap:8px' }, t('reviewVisibility'), visSelect),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'quiet', onclick: () => void kine.reviewDone([]) }, t('reviewSkip')),
        h(
          'button',
          {
            class: 'primary',
            disabled: selectedCount === 0,
            onclick: () =>
              void kine.reviewDone(
                clips.filter((c) => selected.has(c.id)).map((c) => ({ clipId: c.id, visibility, title: titles.get(c.id) ?? c.title }))
              ),
          },
          t('reviewUpload', { count: selectedCount })
        )
      )
    )
  );
}

const params = new URLSearchParams(location.search);
void load(params.get('session') ?? '');
kine.onNavigate((id) => void load(id));
kine.onClips(() => void refresh());
kine.onSettings((s) => {
  settings = s;
  render();
});
