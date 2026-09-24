import type { Clip, Settings, UploadRequest, Visibility } from '../shared/types';
import { CATEGORY_KEYS, VISIBILITIES } from '../shared/types';
import type { Key } from '../shared/i18n';
import { gameHashtag } from '../shared/clipNaming';
import { chaptersText, formatHashtags, markerChapters, parseHashtags } from '../shared/upload';
import { clear, h, isPortrait, thumbImages } from './ui';

/**
 * Nastavení nahrání na Kine - to samé, co má web ve formuláři nahrávání:
 * název, popis, hashtagy, viditelnost (veřejné / odběratelé / soukromé),
 * kategorie, jazyk, "pro děti" / placená propagace / AI, a k tomu náhled
 * z appky jako náhled videa. Vrstva přes okno, jako přehrávač.
 *
 * Jeden klip: všechno předvyplněné podle klipu (jde jen upravit a nahrát).
 * Víc klipů: názvy po jednom, ostatní společné; hashtagy podle hry si
 * každý klip doplní sám ("klip" + hra), tady se píšou jen ty navíc.
 */
type T = (key: Key, vars?: Record<string, string | number>) => string;

export type UploadDialogOptions = {
  clips: Clip[];
  settings: Settings;
  t: T;
  /** Názvy, které si hráč už přepsal (okýnko po hře). */
  titles?: Map<string, string>;
  /** Nabídnout "příště se neptat" (knihovna); okýnko po hře to nemá. */
  askToggle?: boolean;
  onConfirm: (requests: UploadRequest[], options: { askNextTime: boolean }) => void;
  onCancel?: () => void;
};

export type UploadDialogHandle = { close: () => void };

export const VIDEO_LANGS: [string, string][] = [
  ['en', 'English'],
  ['cs', 'Čeština'],
  ['sk', 'Slovenčina'],
  ['de', 'Deutsch'],
  ['pl', 'Polski'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['uk', 'Українська'],
];

/** Výchozí popis videa - stejný text, jaký dává hlavní proces, když popis chybí. */
export function defaultDescription(clip: Clip, settings: Settings, t: T): string {
  const url = `${settings.siteUrl}/download`;
  if (clip.kind === 'recording') {
    const base = clip.game ? t('uploadDescriptionRecordingGame', { game: clip.game, url }) : t('uploadDescriptionRecording', { url });
    // Momenty z nahrávky (uložené klipy) jako kapitoly - stejně jako v hlavním procesu.
    const chapters = markerChapters(clip.markers, t('markerStart'), clip.durationSeconds);
    return chapters.length > 0 ? `${base}\n\n${chaptersText(chapters)}` : base;
  }
  return clip.game ? t('uploadDescriptionGame', { game: clip.game, url }) : t('uploadDescription', { url });
}

/** "klip" + hra + hashtagy z nastavení - to, co appka dá sama. */
export function autoHashtags(clip: Clip, settings: Settings): string[] {
  const tags = ['klip'];
  if (clip.game) tags.push(gameHashtag(clip.game));
  for (const tag of parseHashtags(settings.uploadHashtags ?? '')) if (!tags.includes(tag)) tags.push(tag);
  return tags.slice(0, 15);
}

let current: UploadDialogHandle | null = null;

export function openUploadDialog(options: UploadDialogOptions): UploadDialogHandle {
  current?.close();
  const { clips, settings, t } = options;
  const single = clips.length === 1 ? clips[0] : null;

  // ---- stav formuláře -------------------------------------------------------------
  const titles = new Map<string, string>();
  for (const c of clips) titles.set(c.id, options.titles?.get(c.id) ?? c.title);
  let description = single ? defaultDescription(single, settings, t) : '';
  let hashtagsText = single ? formatHashtags(autoHashtags(single, settings)) : formatHashtags(parseHashtags(settings.uploadHashtags ?? ''));
  let visibility: Visibility = settings.visibility;
  let category = (CATEGORY_KEYS as readonly string[]).includes(settings.uploadCategory) ? settings.uploadCategory : 'catGaming';
  let language = settings.videoLanguage;
  let madeForKids = false;
  let hasPaidPromotion = false;
  let isAiGenerated = false;
  let thumbnail = settings.uploadThumbnail;
  let askNextTime = settings.uploadAsk;

  const overlay = h('div', { class: 'overlay upload-overlay', onclick: (e: Event) => e.target === overlay && close() });
  const box = h('div', { class: 'player-box upload-dialog', role: 'dialog', 'aria-modal': 'true' });
  overlay.append(box);

  function close() {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current === handle) current = null;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      options.onCancel?.();
      close();
    }
  }
  const handle: UploadDialogHandle = { close };
  current = handle;

  // ---- klipy: náhled + název ---------------------------------------------------------
  const clipRows = h(
    'div',
    { class: `upload-clips ${single ? 'single' : ''}` },
    ...clips.map((clip) =>
      h(
        'div',
        { class: 'upload-clip' },
        h('div', { class: `thumb ${isPortrait(clip) ? 'portrait' : ''}` }, ...thumbImages(clip, false)),
        h(
          'div',
          { class: 'stack', style: 'gap:4px;min-width:0' },
          h('input', {
            type: 'text',
            class: 'upload-title',
            value: titles.get(clip.id) ?? clip.title,
            maxlength: '150',
            placeholder: t('reviewTitlePlaceholder'),
            oninput: (e: Event) => titles.set(clip.id, (e.target as HTMLInputElement).value),
          }),
          h('span', { class: 'faint' }, [clip.game, `${Math.round(clip.durationSeconds)} s`].filter(Boolean).join(' · '))
        )
      )
    )
  );

  // ---- popis a hashtagy ----------------------------------------------------------------
  const descField = h('textarea', {
    rows: '3',
    maxlength: '5000',
    placeholder: single ? '' : t('uploadDescriptionAuto'),
    oninput: (e: Event) => (description = (e.target as HTMLTextAreaElement).value),
  }) as HTMLTextAreaElement;
  descField.value = description;

  const tagsField = h('input', {
    type: 'text',
    class: 'upload-hashtags',
    value: hashtagsText,
    placeholder: '#klip #cs2',
    oninput: (e: Event) => {
      hashtagsText = (e.target as HTMLInputElement).value;
      refreshTags();
    },
    onblur: () => {
      // Po odejití z pole se hashtagy srovnají do čisté podoby (#malá, bez dvojic).
      hashtagsText = formatHashtags(parseHashtags(hashtagsText));
      tagsField.value = hashtagsText;
      refreshTags();
    },
  }) as HTMLInputElement;
  const tagsPreview = h('div', { class: 'upload-tags' });
  function refreshTags() {
    clear(tagsPreview);
    const tags = parseHashtags(hashtagsText);
    for (const tag of tags) tagsPreview.append(h('span', { class: 'tag' }, `#${tag}`));
    if (!single) tagsPreview.append(h('span', { class: 'faint' }, t('uploadHashtagsAutoNote')));
    else if (tags.length === 0) tagsPreview.append(h('span', { class: 'faint' }, t('uploadHashtagsEmpty')));
  }
  refreshTags();

  // ---- viditelnost ---------------------------------------------------------------------
  const visButtons = new Map<Visibility, HTMLButtonElement>();
  const visHint = h('p', { class: 'hint', style: 'margin:0' });
  const VIS_LABEL: Record<Visibility, Key> = { public: 'visibilityPublic', subscribers: 'visibilitySubscribers', private: 'visibilityPrivate' };
  const VIS_HINT: Record<Visibility, Key> = { public: 'visibilityPublicHint', subscribers: 'visibilitySubscribersHint', private: 'visibilityPrivateHint' };
  const VIS_ICON: Record<Visibility, string> = { public: '🌍', subscribers: '👥', private: '🔒' };
  function setVisibility(v: Visibility) {
    visibility = v;
    for (const [key, btn] of visButtons) btn.classList.toggle('active', key === v);
    visHint.textContent = t(VIS_HINT[v]);
  }
  const visRow = h(
    'div',
    { class: 'row seg-row', role: 'radiogroup' },
    ...VISIBILITIES.map((v) => {
      const btn = h('button', { type: 'button', class: 'small quiet seg', 'data-visibility': v, onclick: () => setVisibility(v) }, `${VIS_ICON[v]} ${t(VIS_LABEL[v])}`);
      visButtons.set(v, btn);
      return btn;
    })
  );
  setVisibility(visibility);

  // ---- kategorie, jazyk ---------------------------------------------------------------------
  const categorySelect = h(
    'select',
    { onchange: (e: Event) => (category = (e.target as HTMLSelectElement).value) },
    ...CATEGORY_KEYS.map((key) => h('option', { value: key, selected: key === category }, t(key)))
  );
  const languageSelect = h(
    'select',
    { onchange: (e: Event) => (language = (e.target as HTMLSelectElement).value) },
    ...VIDEO_LANGS.map(([code, name]) => h('option', { value: code, selected: code === language }, name))
  );

  const flag = (label: string, get: () => boolean, set: (v: boolean) => void, cls = '') =>
    h('label', { class: `check small ${cls}` }, h('input', { type: 'checkbox', checked: get(), onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), label);

  const hasThumb = clips.some((c) => !!c.thumb);

  // ---- tlačítka ----------------------------------------------------------------------------
  const submit = () => {
    const extra = parseHashtags(hashtagsText);
    const requests: UploadRequest[] = clips.map((clip) => {
      // Víc klipů: hashtagy podle hry si každý doplní sám, tady jsou jen společné navíc.
      const tags = single ? extra : [...autoHashtags(clip, settings), ...extra].filter((tag, i, all) => all.indexOf(tag) === i).slice(0, 15);
      return {
        clipId: clip.id,
        visibility,
        title: (titles.get(clip.id) ?? clip.title).trim().slice(0, 150) || clip.title,
        description: description.trim() || undefined,
        hashtags: tags,
        category,
        language,
        madeForKids,
        hasPaidPromotion,
        isAiGenerated,
        thumbnail,
      };
    });
    close();
    options.onConfirm(requests, { askNextTime });
  };

  box.append(
    h(
      'div',
      { class: 'player-head' },
      h('div', { class: 'title' }, '⬆ ' + (single ? t('uploadDialogTitle') : t('uploadDialogTitleMany', { count: clips.length }))),
      h('button', { class: 'small quiet player-close', title: t('close'), onclick: () => { options.onCancel?.(); close(); } }, '✕')
    ),
    h(
      'div',
      { class: 'upload-body stack' },
      clipRows,
      h('div', { class: 'field' }, h('label', {}, t('uploadDescriptionLabel')), descField),
      h('div', { class: 'field' }, h('label', {}, t('uploadHashtagsLabel')), tagsField, tagsPreview),
      h('div', { class: 'field' }, h('label', {}, t('uploadVisibilityLabel')), visRow, visHint),
      h(
        'div',
        { class: 'row', style: 'gap:12px;align-items:flex-end' },
        h('label', { class: 'grow' }, t('uploadCategoryLabel'), categorySelect),
        h('label', { style: 'min-width:180px' }, t('videoLanguage'), languageSelect)
      ),
      h(
        'div',
        { class: 'row', style: 'gap:14px' },
        flag(t('uploadMadeForKids'), () => madeForKids, (v) => (madeForKids = v)),
        flag(t('uploadPaidPromotion'), () => hasPaidPromotion, (v) => (hasPaidPromotion = v)),
        flag(t('uploadAiGenerated'), () => isAiGenerated, (v) => (isAiGenerated = v))
      ),
      hasThumb ? flag(t('uploadUseThumbnail'), () => thumbnail, (v) => (thumbnail = v), 'upload-thumb-flag') : null
    ),
    h(
      'div',
      { class: 'upload-foot' },
      options.askToggle
        ? h(
            'label',
            { class: 'check small' },
            h('input', { type: 'checkbox', checked: !askNextTime, onchange: (e: Event) => (askNextTime = !(e.target as HTMLInputElement).checked) }),
            t('uploadDontAsk')
          )
        : h('span', {}),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'quiet', onclick: () => { options.onCancel?.(); close(); } }, t('cancel')),
        h('button', { class: 'primary upload-submit', onclick: submit }, single ? t('uploadDialogSubmit') : t('uploadDialogSubmitMany', { count: clips.length }))
      )
    )
  );

  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  const first = box.querySelector('.upload-title') as HTMLInputElement | null;
  first?.focus();
  return handle;
}

/** Právě otevřené nastavení nahrání (ať se dá zavřít zvenku). */
export function openUploadDialogHandle(): UploadDialogHandle | null {
  return current;
}
