import type { KineBridge } from '../preload/preload';
import type { Clip, Settings, Visibility } from '../shared/types';
import { VISIBILITIES } from '../shared/types';
import { makeT } from '../shared/i18n';
import { clear, clipMeta, formatDuration, h, isPortrait, thumbImages } from './ui';
import { applyBrandColor } from '../shared/plan';
import { openPlayer, type PlayerHandle } from './player';
import { openUploadDialog } from './uploadDialog';

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
/** Sestřih všech vybraných klipů z tohohle hraní do jednoho (běží / hotovo / chyba). */
let merging: { percent: number } | null = null;
let mergeNote: { text: string; kind: 'ok' | 'error' } | null = null;

async function load(id: string) {
  sessionId = id;
  settings = await kine.getSettings();
  visibility = settings.visibility;
  clips = (await kine.reviewClips(sessionId)).filter((c) => !c.upload || c.upload.state === 'error');
  // Nahrávka celého zápasu (dlouhá, velká) se předem nezaškrtává - hráč ji přidá sám.
  selected = new Set(clips.filter((c) => c.kind !== 'recording').map((c) => c.id));
  titles.clear();
  player?.close();
  render();
}

/** Klipy se změnily (zkrácení, nový klip vedle, smazání) - seznam se srovná, výběr zůstane. */
async function refresh() {
  if (!sessionId && clips.length === 0) return;
  const fresh = (await kine.reviewClips(sessionId)).filter((c) => !c.upload || c.upload.state === 'error');
  const known = new Set(clips.map((c) => c.id));
  for (const c of fresh) if (!known.has(c.id) && c.kind !== 'recording') selected.add(c.id);
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
    neighbors: (id) => {
      const index = clips.findIndex((c) => c.id === id);
      return { prev: clips[index - 1] ?? null, next: clips[index + 1] ?? null, index: Math.max(0, index), total: clips.length };
    },
    edit: {
      run: (c, request) => kine.trimClip(c.id, request),
      onProgress: (cb) => kine.onTrimProgress(cb),
      gif: (c, range) => kine.makeGif(c.id, range),
      reveal: (file) => void kine.revealFile(file),
    },
  });
}

/**
 * Sestřih z celého hraní: vybrané klipy (od nejstaršího) do jednoho
 * klipu. Ten se objeví v seznamu vybraný k nahrání, původní klipy se
 * odškrtnou - na Kine tak jde jedním klikem celý večer v jednom videu.
 */
async function mergeSelected() {
  const t = makeT(settings.lang);
  const ids = clips.filter((c) => selected.has(c.id)).map((c) => c.id);
  if (merging || ids.length < 2) return;
  merging = { percent: 0 };
  mergeNote = null;
  render();
  const unsubscribe = kine.onTrimProgress((p) => {
    if (merging && p.id === 'merge') {
      merging.percent = p.percent;
      const bar = app.querySelector('.merge-progress > span') as HTMLElement | null;
      const text = app.querySelector('.merge-text');
      if (bar) bar.style.width = `${p.percent}%`;
      if (text) text.textContent = t('mergeWorking', { percent: p.percent });
    }
  });
  try {
    const clip = await kine.mergeClips(ids);
    for (const id of ids) selected.delete(id);
    selected.add(clip.id);
    merging = null;
    mergeNote = { text: t('mergeDone', { title: clip.title }), kind: 'ok' };
    await refresh();
  } catch (e) {
    merging = null;
    void kine.log(`sestřih po hře: ${(e as Error).message}`);
    mergeNote = { text: t('mergeFailed', { message: (e as Error).message }), kind: 'error' };
    render();
  } finally {
    unsubscribe();
  }
}

function render() {
  const t = makeT(settings.lang);
  applyBrandColor(document.documentElement, settings.brandColor || null);
  clear(app);
  // Titulek podle hry, když je u všech stejná; jinak jen počet.
  const games = new Set(clips.map((c) => c.game).filter(Boolean));
  const game = games.size === 1 ? [...games][0] : null;
  const count = clips.length;

  const selectedCount = selected.size;
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
      { class: `thumb ${isPortrait(clip) ? 'portrait' : ''}`, onclick: () => showClip(clip) },
      ...thumbImages(clip, false),
      check,
      h('span', { class: 'play-badge' }, '▶'),
      clip.kind === 'recording' ? h('span', { class: 'kind-badge' }, '⏺ ' + t('libraryRecordingBadge')) : null,
      h('span', { class: 'dur' }, formatDuration(clip.durationSeconds))
    );
    grid.append(h('div', { class: `clip ${isSelected ? 'selected' : ''}` }, thumb, body));
  }

  const visSelect = h(
    'select',
    { style: 'width:auto;min-width:220px', onchange: (e: Event) => (visibility = (e.target as HTMLSelectElement).value as Visibility) },
    ...VISIBILITIES.map((v) => h('option', { value: v, selected: visibility === v }, t(v === 'public' ? 'visibilityPublic' : v === 'subscribers' ? 'visibilitySubscribers' : 'visibilityPrivate')))
  );
  const picked = () => clips.filter((c) => selected.has(c.id));
  // Nastavení nahrání (popis, hashtagy, kategorie…) pro vybrané - nahrání pak jde rovnou z dialogu.
  const optionsBtn = h(
    'button',
    {
      class: 'quiet review-upload-options',
      disabled: selectedCount === 0,
      title: t('uploadOptionsButton'),
      onclick: () =>
        openUploadDialog({
          clips: picked(),
          settings: { ...settings, visibility },
          t,
          titles,
          onConfirm: (requests) => void kine.reviewDone(requests),
        }),
    },
    '⚙'
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
        h('button', { class: 'small quiet', onclick: () => { selected = new Set(); render(); } }, t('reviewSelectNone')),
        merging
          ? h('span', { class: 'row', style: 'gap:8px' }, h('span', { class: 'progress trim-progress merge-progress' }, h('span', { style: `width:${merging.percent}%` })), h('span', { class: 'faint merge-text' }, t('mergeWorking', { percent: merging.percent })))
          : h('button', { class: 'small review-merge', disabled: selectedCount < 2, title: t('reviewMergeHint'), onclick: () => void mergeSelected() }, '🎬 ' + t('reviewMerge'))
      )
    ),
    ...(mergeNote ? [h('p', { class: `state ${mergeNote.kind === 'ok' ? 'done' : 'error'}`, style: 'margin:-6px 0 0' }, mergeNote.text)] : []),
    count === 0 ? h('div', { class: 'empty' }, t('reviewNone')) : grid,
    h(
      'div',
      { class: 'foot' },
      h('label', { class: 'row', style: 'gap:8px' }, t('reviewVisibility'), visSelect),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'quiet', onclick: () => void kine.reviewDone([]) }, t('reviewSkip')),
        optionsBtn,
        h(
          'button',
          {
            class: 'primary',
            disabled: selectedCount === 0,
            onclick: () => void kine.reviewDone(picked().map((c) => ({ clipId: c.id, visibility, title: titles.get(c.id) ?? c.title }))),
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
