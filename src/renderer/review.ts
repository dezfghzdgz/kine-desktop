import type { KineBridge } from '../preload/preload';
import type { Clip, Settings, Visibility } from '../shared/types';
import { makeT } from '../shared/i18n';
import { clear, clipMeta, fileUrl, formatDuration, h } from './ui';
import { applyBrandColor } from '../shared/plan';

/**
 * Okýnko po hře: klipy z posledního hraní, každý s náhledem a
 * zaškrtávátkem (výchozí: všechny vybrané), názvy jdou přepsat. Jedno
 * tlačítko nahraje vybrané - nahrávání běží až teď, když se nehraje.
 */
declare const window: Window & { kine: KineBridge };
const kine = window.kine;

const app = document.getElementById('app') as HTMLDivElement;
let settings: Settings;
let clips: Clip[] = [];
let selected = new Set<string>();
const titles = new Map<string, string>();
let visibility: Visibility = 'private';

async function load(sessionId: string) {
  settings = await kine.getSettings();
  visibility = settings.visibility;
  clips = (await kine.reviewClips(sessionId)).filter((c) => !c.upload || c.upload.state === 'error');
  selected = new Set(clips.map((c) => c.id));
  render();
}

function render() {
  const t = makeT(settings.lang);
  applyBrandColor(document.documentElement, settings.brandColor || null);
  clear(app);
  const game = clips.find((c) => c.game)?.game ?? null;
  const count = clips.length;

  const grid = h('div', { class: 'clips' });
  for (const clip of clips) {
    const isSelected = selected.has(clip.id);
    const check = h('input', {
      type: 'checkbox',
      class: 'pick',
      checked: isSelected,
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) selected.add(clip.id);
        else selected.delete(clip.id);
        render();
      },
    });
    const thumb = h(
      'div',
      { class: 'thumb', ondblclick: () => void kine.openClip(clip.id) },
      clip.thumb ? h('img', { src: fileUrl(clip.thumb), alt: '' }) : null,
      check,
      h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
    );
    const title = h('input', {
      type: 'text',
      class: 'title-edit',
      value: titles.get(clip.id) ?? clip.title,
      placeholder: t('reviewTitlePlaceholder'),
      maxlength: '150',
      oninput: (e: Event) => titles.set(clip.id, (e.target as HTMLInputElement).value),
    });
    grid.append(
      h(
        'div',
        { class: `clip ${isSelected ? 'selected' : ''}` },
        thumb,
        h('div', { class: 'body' }, title, h('div', { class: 'meta' }, clipMeta(clip, settings.lang)),
          h('div', { class: 'actions' }, h('button', { class: 'small quiet', onclick: () => void kine.openClip(clip.id) }, t('libraryOpen'))))
      )
    );
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
kine.onNavigate((sessionId) => void load(sessionId));
