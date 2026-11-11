import type { CaptureSourceOption, CaptureSourceRef, PreviewFrameInfo, PreviewKind } from '../shared/types';
import type { Key } from '../shared/i18n';
import type { KineBridge } from '../preload/preload';
import { clear, h } from './ui';
import { icon } from './icons';

/**
 * Co se nahrává: okno s výběrem monitoru nebo aplikace (jako sdílení
 * obrazovky na Discordu - záložky Obrazovky / Aplikace s náhledy) a živý
 * náhled toho, co se opravdu nahrává / co vidí diváci.
 *
 * Náhled posílá snímací stránka (malý JPEG dvakrát za sekundu) jen když
 * je v okně appky prvek s data-preview a okno je vidět - syncPreviewWant
 * to hlídá po každém překreslení.
 */
type T = (key: Key, vars?: Record<string, string | number>) => string;

export type SourcePickerOptions = {
  t: T;
  kine: KineBridge;
  title: string;
  /** Co je teď vybrané (null = "stejné jako záznam", jen se allowInherit). */
  current: CaptureSourceRef | null;
  /** Scéna: první volba "Stejné jako záznam". */
  allowInherit?: boolean;
  onPick: (ref: CaptureSourceRef | null) => void;
};

let openPicker: { close: () => void } | null = null;

export function openSourcePicker(o: SourcePickerOptions): { close: () => void } {
  openPicker?.close();
  const t = o.t;
  let tab: 'screens' | 'windows' = o.current?.kind === 'window' ? 'windows' : 'screens';
  let data: { screens: CaptureSourceOption[]; windows: CaptureSourceOption[] } | null = null;
  let failed = false;
  let loadSeq = 0;

  const overlay = h('div', { class: 'overlay source-overlay', onclick: (e: Event) => e.target === overlay && close() });
  const box = h('div', { class: 'player-box source-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title });
  overlay.append(box);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  function close() {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (openPicker === handle) openPicker = null;
  }
  const handle = { close };
  openPicker = handle;
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  const pick = (ref: CaptureSourceRef | null) => {
    close();
    o.onPick(ref);
  };

  const isActive = (opt: CaptureSourceOption): boolean => {
    const cur = o.current;
    if (!cur) return false;
    if (opt.kind === 'screen') return cur.kind === 'screen' && (cur.displayId === opt.displayId || (cur.displayId === '' && opt.primary));
    return cur.kind === 'window' && (cur.id === opt.id || (!!cur.name && cur.name === opt.name));
  };

  const card = (opt: CaptureSourceOption) => {
    const active = isActive(opt);
    const label = opt.kind === 'screen' ? opt.label : opt.name;
    const thumb = opt.thumb ? h('img', { src: opt.thumb, alt: '', draggable: 'false' }) : h('span', { class: 'source-thumb-empty' }, icon(opt.kind === 'screen' ? 'monitor' : 'desktop', 22));
    return h(
      'button',
      {
        class: `source-card ${active ? 'active' : ''}`,
        'aria-pressed': active ? 'true' : 'false',
        title: label,
        onclick: () => pick(opt.kind === 'screen' ? { kind: 'screen', displayId: opt.primary ? '' : opt.displayId } : { kind: 'window', id: opt.id, name: opt.name }),
      },
      h('span', { class: 'source-thumb' }, thumb, active ? h('span', { class: 'source-check' }, icon('check', 14)) : null),
      h(
        'span',
        { class: 'source-label' },
        opt.kind === 'window' && opt.icon ? h('img', { class: 'source-icon', src: opt.icon, alt: '' }) : icon(opt.kind === 'screen' ? 'monitor' : 'desktop', 14),
        h('span', { class: 'source-name' }, label),
        opt.kind === 'screen' && opt.primary ? h('span', { class: 'plan-pill' }, t('sourcePickerPrimary')) : null
      )
    );
  };

  function draw() {
    clear(box);
    const tabs = h(
      'div',
      { class: 'row source-tabs', role: 'tablist' },
      ...(['screens', 'windows'] as const).map((id) =>
        h(
          'button',
          {
            class: `small ${tab === id ? 'active' : 'quiet'}`,
            role: 'tab',
            'aria-selected': tab === id ? 'true' : 'false',
            onclick: () => {
              tab = id;
              draw();
            },
          },
          icon(id === 'screens' ? 'monitor' : 'desktop', 14),
          id === 'screens' ? t('sourcePickerScreens') : t('sourcePickerApps'),
          data ? h('span', { class: 'faint' }, ` ${id === 'screens' ? data.screens.length : data.windows.length}`) : null
        )
      ),
      h('span', { class: 'grow' }),
      h('button', { class: 'small quiet source-refresh', title: t('sourcePickerRefresh'), onclick: () => void load() }, icon('refresh', 14), t('sourcePickerRefresh'))
    );
    let body: HTMLElement;
    if (failed) body = h('p', { class: 'hint warn' }, icon('warning', 14), ' ', t('sourcePickerFailed'));
    else if (!data) body = h('p', { class: 'hint source-loading' }, h('span', { class: 'spin' }), ' ', t('sourcePickerLoading'));
    else {
      const list = tab === 'screens' ? data.screens : data.windows;
      const inherit = o.allowInherit
        ? h(
            'button',
            { class: `source-card inherit ${o.current === null ? 'active' : ''}`, 'aria-pressed': o.current === null ? 'true' : 'false', onclick: () => pick(null) },
            h('span', { class: 'source-thumb' }, h('span', { class: 'source-thumb-empty' }, icon('film', 22)), o.current === null ? h('span', { class: 'source-check' }, icon('check', 14)) : null),
            h('span', { class: 'source-label' }, icon('quality', 14), h('span', { class: 'source-name' }, t('sourceSameAsRecording')))
          )
        : null;
      body =
        list.length === 0 && !inherit
          ? h('p', { class: 'hint' }, tab === 'windows' ? t('sourcePickerNoApps') : t('sourcePickerFailed'))
          : h('div', { class: 'source-grid' }, inherit, ...list.map(card), list.length === 0 ? h('p', { class: 'hint' }, tab === 'windows' ? t('sourcePickerNoApps') : '') : null);
    }
    box.append(
      h(
        'div',
        { class: 'player-head' },
        h('div', { class: 'title icon-title' }, icon('monitor', 16), h('span', {}, o.title)),
        h('button', { class: 'small quiet player-close', title: t('close'), 'aria-label': t('close'), onclick: () => close() }, icon('close', 14))
      ),
      h(
        'div',
        { class: 'stack source-body' },
        tabs,
        body,
        tab === 'windows' ? h('p', { class: 'hint', style: 'margin:0' }, icon('gamepad', 14), ' ', t('sourcePickerAppsHint')) : null,
        h('p', { class: 'hint', style: 'margin:0' }, icon('volume', 14), ' ', t('sourcePickerHint'))
      )
    );
  }

  async function load() {
    const seq = ++loadSeq;
    failed = false;
    data = null;
    draw();
    try {
      const result = await o.kine.listCaptureSources();
      if (seq !== loadSeq || !overlay.isConnected) return;
      data = result;
    } catch {
      if (seq !== loadSeq) return;
      failed = true;
    }
    draw();
  }

  void load();
  return handle;
}

// ---- živý náhled ---------------------------------------------------------------------------

let frameUrl: string | null = null;
let frameInfo: PreviewFrameInfo | null = null;
let wanted: PreviewKind | null = null;
let lastFrameAt = 0;

/** Obrázek s živým náhledem (data-preview = co se chce vidět); snímky do něj dosazuje handlePreviewFrame. */
export function previewImage(kind: PreviewKind, cls = ''): HTMLImageElement {
  const img = h('img', { class: `preview-feed ${cls}`, 'data-preview': kind, alt: '', draggable: 'false' }) as HTMLImageElement;
  if (frameUrl && Date.now() - lastFrameAt < 5000) img.src = frameUrl;
  else img.classList.add('empty');
  return img;
}

/** Přišel snímek náhledu: do všech obrázků náhledu (starý obrázek se uvolní, až ho nic neukazuje). */
export function handlePreviewFrame(frame: { data: Uint8Array; info: PreviewFrameInfo }): void {
  if (!wanted) return;
  const url = URL.createObjectURL(new Blob([frame.data as BlobPart], { type: 'image/jpeg' }));
  const old = frameUrl;
  frameUrl = url;
  frameInfo = frame.info;
  lastFrameAt = Date.now();
  for (const img of document.querySelectorAll<HTMLImageElement>('img.preview-feed')) {
    img.src = url;
    img.classList.remove('empty');
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
}

/** Rozměry posledního snímku (co se opravdu nahrává / vysílá). */
export function lastPreviewInfo(): PreviewFrameInfo | null {
  return frameInfo && Date.now() - lastFrameAt < 5000 ? frameInfo : null;
}

/** Po překreslení / změně viditelnosti: chce okno náhled (a jaký)? Řekne to hlavnímu procesu jen při změně. */
export function syncPreviewWant(kine: KineBridge): void {
  const el = document.querySelector<HTMLElement>('[data-preview]');
  const kind = !document.hidden && el ? ((el.dataset.preview as PreviewKind) ?? null) : null;
  if (kind === wanted) return;
  wanted = kind;
  void kine.setPreview(kind);
}
