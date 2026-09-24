import type { Clip } from '../shared/types';
import type { Key } from '../shared/i18n';
import { clear, errorText, fileUrl, formatBytes, h } from './ui';

/**
 * Přehrávač klipu jako vrstva přes celé okno (lightbox): mřížka klipů pod
 * ním zůstává, jak je - nic se neroztahuje ani nepřeskládává. Escape nebo
 * klik mimo zavře. Když Chromium soubor nepřehraje (kodek, rozbité časy),
 * ukáže se důvod a tlačítko na přehrávač systému.
 *
 * Úpravy (jako v Medalu): tlačítko "Upravit" rozbalí časovou osu se dvěma
 * úchyty (začátek/konec), klávesy I a O je nastaví v místě přehrávání,
 * mezerník přehrává, přehrávání se v úpravách točí uvnitř výběru.
 * Zvuk jde odstranit. Uložit lze jako nový klip vedle, nebo přepsat
 * původní - řez dělá hlavní proces (ffmpeg), sem chodí jen průběh.
 *
 * Vrstva je vždy nejvýš jedna; otevření dalšího klipu tu první zavře.
 */
type T = (key: Key, vars?: Record<string, string | number>) => string;

export type TrimRequest = { start: number; end: number; mute: boolean; mode: 'new' | 'replace'; vertical?: 'left' | 'center' | 'right' | 'blur'; audio?: AudioChoice };
/** Zvuk ukládaného klipu (klip se samostatnými stopami hra / mikrofon). */
type AudioChoice = 'mix' | 'game' | 'mic' | 'none';
type CropAnchor = 'left' | 'center' | 'right' | 'blur';
/** Formát výstupu v úpravách: původní video, výřez na výšku, nebo GIF (soubor vedle klipu). */
type ExportFormat = 'original' | 'vertical' | 'gif';

/** Nejdelší GIF (s) - stejná hranice jako v hlavním procesu (editPlan.GIF_MAX_SECONDS). */
export const GIF_MAX_SECONDS = 15;
const GIF_WIDTH = 480;

/** Sousedé otevřeného klipu v seznamu (pro šipky po stranách). */
export type Neighbors = { prev: Clip | null; next: Clip | null; index: number; total: number };

export type PlayerOptions = {
  clip: Clip;
  t: T;
  onOpenExternal: (clip: Clip) => void;
  onLog?: (message: string) => void;
  onClose?: () => void;
  /** Kdo je před a za tímhle klipem v seznamu - bez toho žádné šipky. */
  neighbors?: (clipId: string) => Neighbors;
  /** Odkaz na nahraný klip do schránky (tlačítko v hlavičce). */
  onCopyLink?: (clip: Clip) => void;
  /** Rovnou otevřít úpravy (tlačítko Upravit na kartě). */
  startEditing?: boolean;
  /** Bez tohohle se klip jen přehrává (žádné tlačítko Upravit). */
  edit?: {
    run: (clip: Clip, request: TrimRequest) => Promise<Clip>;
    onProgress: (cb: (p: { id: string; percent: number }) => void) => () => void;
    /** GIF z úseku; bez tohohle formát GIF v nabídce není. */
    gif?: (clip: Clip, range: { start: number; end: number }) => Promise<{ file: string; sizeBytes: number; lengthSeconds: number }>;
    /** Ukázat hotový soubor ve složce. */
    reveal?: (file: string) => void;
    /** Poslat hotový soubor (GIF) na Discord; bez tohohle tlačítko není. */
    discord?: (file: string, title: string) => Promise<void>;
    /** Náhled klipu ze snímku v daném čase; bez tohohle tlačítko není. */
    thumbnail?: (clip: Clip, atSeconds: number) => Promise<unknown>;
  };
};

export type PlayerHandle = {
  close: () => void;
  /** Klip zvenku změněn (název, hra) - jen se překreslí titulek; když zmizel, vrstva se zavře. */
  sync: (clips: Clip[]) => void;
  clipId: () => string;
  /** Přepnout na jiný klip ve stejné vrstvě (šipky po stranách). */
  show: (clip: Clip) => void;
};

/** Hlasitost a ztlumení přehrávače si okno pamatuje (jen pro tohle PC). */
const VOLUME_KEY = 'kine.player.volume';
function loadVolume(): { volume: number; muted: boolean } | null {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
    const volume = typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : 1;
    return { volume, muted: v.muted === true };
  } catch {
    return null;
  }
}
function saveVolume(volume: number, muted: boolean): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    // bez úložiště se hlasitost jen nepamatuje
  }
}

/** Nejmenší délka výřezu (s) - stejná hranice jako v hlavním procesu. */
const MIN_LENGTH = 0.2;
const MEDIA_ERRORS: Record<number, string> = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported' };

let current: PlayerHandle | null = null;

export function closePlayer(): void {
  current?.close();
}

export function openPlayerId(): string | null {
  return current?.clipId() ?? null;
}

/** m:ss.d - desetiny, ať jde řez umístit přesně. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.floor((rest - whole) * 10);
  const mm = h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
  return `${mm}:${String(whole).padStart(2, '0')}.${tenth}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function openPlayer(options: PlayerOptions): PlayerHandle {
  current?.close();
  const { t, edit } = options;
  let clip = options.clip;
  let duration = clip.durationSeconds > 0 ? clip.durationSeconds : 0;
  let start = 0;
  let end = duration;
  let mute = false;
  /** Zvuk při ukládání: u klipů se stopami hra / mikrofon jde vybrat jen jedna z nich. */
  let audioChoice: AudioChoice = 'mix';
  /** Výřez na výšku 9:16 (TikTok, Shorts); null = původní formát. */
  let vertical: CropAnchor | null = null;
  /** Formát GIF (bez zvuku, soubor vedle klipu, ne do knihovny). */
  let gif = false;
  let editing = false;
  let saving: { mode: 'new' | 'replace' | 'gif'; percent: number } | null = null;
  let confirmReplace = false;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let broken = false;
  let raf = 0;
  let closed = false;

  // ---- prvky ----------------------------------------------------------------------
  const video = h('video', { class: 'player-video', controls: true, autoplay: true, preload: 'auto' }) as HTMLVideoElement;
  // Stínování mimo výřez 9:16 (jen v úpravách s formátem na výšku).
  const shadeLeft = h('div', { class: 'crop-shade hidden' });
  const shadeRight = h('div', { class: 'crop-shade hidden' });
  const stage = h('div', { class: 'player-stage' }, video, shadeLeft, shadeRight);
  const titleEl = h('div', { class: 'title' });
  /** "3 / 24" - kde v seznamu klip je (jen se sousedy). */
  const positionEl = h('span', { class: 'player-pos faint hidden' });
  const editBtn = h('button', { class: 'small quiet', onclick: () => toggleEdit() }, t('libraryEdit'));
  const copyBtn = h('button', { class: 'small quiet player-copy hidden', onclick: () => { if (options.onCopyLink) { options.onCopyLink(clip); showNote(t('linkCopied'), 'ok'); } } }, '🔗 ' + t('libraryCopyLink'));
  const note = h('div', { class: 'player-note hidden' });
  const trim = h('div', { class: 'trim hidden' });
  const box = h(
    'div',
    { class: 'player-box', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'player-head' },
      h('div', { class: 'row', style: 'flex-wrap:nowrap;min-width:0;gap:10px' }, titleEl, positionEl),
      h(
        'div',
        { class: 'row', style: 'flex-wrap:nowrap' },
        options.onCopyLink ? copyBtn : null,
        edit ? editBtn : null,
        h('button', { class: 'small quiet', onclick: () => options.onOpenExternal(clip) }, t('playerOpenExternal')),
        h('button', { class: 'small quiet player-close', title: t('playerClose'), onclick: () => close() }, '✕')
      )
    ),
    stage,
    trim,
    note
  );
  // Šipky po stranách: předchozí / další klip v seznamu (i klávesy ↑ ↓).
  const prevBtn = h('button', { class: 'player-nav prev hidden', title: `${t('playerPrev')} (↑)`, onclick: () => go(-1) }, '‹');
  const nextBtn = h('button', { class: 'player-nav next hidden', title: `${t('playerNext')} (↓)`, onclick: () => go(1) }, '›');
  const overlay = h('div', { class: 'overlay' }, prevBtn, box, nextBtn);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  function refreshNav() {
    const n = options.neighbors?.(clip.id);
    const show = !!n && n.total > 1;
    prevBtn.classList.toggle('hidden', !show);
    nextBtn.classList.toggle('hidden', !show);
    positionEl.classList.toggle('hidden', !show);
    if (!n || !show) return;
    prevBtn.disabled = !n.prev;
    nextBtn.disabled = !n.next;
    positionEl.textContent = `${n.index + 1} / ${n.total}`;
  }
  function go(direction: -1 | 1) {
    const n = options.neighbors?.(clip.id);
    const target = direction < 0 ? n?.prev : n?.next;
    if (target && !saving) show(target);
  }
  /** Jiný klip ve stejné vrstvě: úpravy se zavřou, video se vymění, titulek a šipky se srovnají. */
  function show(next: Clip) {
    if (closed) return;
    clip = { ...next };
    duration = clip.durationSeconds > 0 ? clip.durationSeconds : 0;
    start = 0;
    end = duration;
    confirmReplace = false;
    if (editing) toggleEdit(false);
    titleEl.textContent = clip.title;
    titleEl.title = clip.title;
    copyBtn.classList.toggle('hidden', clip.upload?.state !== 'done');
    note.classList.add('hidden');
    syncAudioChoice();
    loadVideo(false);
    layout();
    refreshNav();
  }
  // Hlasitost jako minule; každá změna se uloží.
  const remembered = loadVolume();
  if (remembered) {
    video.volume = remembered.volume;
    video.muted = remembered.muted;
  }
  video.addEventListener('volumechange', () => saveVolume(video.volume, video.muted));

  // Časová osa se staví jednou - při tažení se jen posouvají styly.
  const track = h('div', { class: 'tl-track' });
  const range = h('div', { class: 'tl-range' });
  const handleStart = h('div', { class: 'tl-handle start', title: t('trimStart') });
  const handleEnd = h('div', { class: 'tl-handle end', title: t('trimEnd') });
  const playhead = h('div', { class: 'tl-playhead' });
  const timeline = h('div', { class: 'tl' }, track, range, handleStart, handleEnd, playhead);
  const startVal = h('b', {});
  const endVal = h('b', {});
  const lenVal = h('b', {});
  const muteBox = h('input', { type: 'checkbox', onchange: (e: Event) => { mute = (e.target as HTMLInputElement).checked; refreshButtons(); } }) as HTMLInputElement;
  const muteLabel = h('label', { class: 'check', style: 'align-items:center' }, muteBox, t('trimMute'));
  // Klip se samostatnými stopami: místo "bez zvuku" výběr, co v uloženém klipu bude (třeba bez vlastního hlasu).
  const audioSelect = h(
    'select',
    {
      class: 'trim-audio',
      style: 'width:auto;min-height:32px;padding:4px 10px',
      title: t('trimAudioHint'),
      onchange: (e: Event) => {
        audioChoice = (e.target as HTMLSelectElement).value as AudioChoice;
        mute = audioChoice === 'none';
        refreshButtons();
      },
    },
    h('option', { value: 'mix' }, t('trimAudioMix')),
    h('option', { value: 'game' }, t('trimAudioGame')),
    h('option', { value: 'mic' }, t('trimAudioMic')),
    h('option', { value: 'none' }, t('trimAudioNone'))
  ) as HTMLSelectElement;
  const audioLabel = h('label', { class: 'row trim-audio-row', style: 'gap:6px;align-items:center' }, h('span', { class: 'faint' }, t('trimAudio')), audioSelect);
  /** Má klip samostatné stopy hra / mikrofon? Podle toho výběr zvuku, nebo jen "bez zvuku". */
  function syncAudioChoice() {
    const tracks = clip.audioTracks ?? [];
    const separate = tracks.includes('game') && tracks.includes('mic');
    audioLabel.classList.toggle('hidden', !separate);
    muteLabel.classList.toggle('hidden', separate);
    audioChoice = 'mix';
    audioSelect.value = 'mix';
    mute = false;
    muteBox.checked = false;
  }
  const saveNewBtn = h('button', { class: 'small primary', onclick: () => void (gif ? saveGif() : save('new')) }, t('trimSaveNew'));
  const replaceBtn = h('button', { class: 'small quiet', onclick: () => onReplaceClick() }, t('trimReplace'));
  // Formát: původní / na výšku (a kde výřez leží) / GIF.
  const formatBtns: Record<ExportFormat, HTMLButtonElement> = {
    original: h('button', { class: 'small quiet seg active', onclick: () => setFormat('original') }, t('exportOriginal')),
    vertical: h('button', { class: 'small quiet seg', onclick: () => setFormat('vertical') }, '📱 ' + t('exportVertical')),
    gif: h('button', { class: 'small quiet seg', onclick: () => setFormat('gif') }, t('exportGif', { max: GIF_MAX_SECONDS })),
  };
  const anchorBtns: Record<CropAnchor, HTMLButtonElement> = {
    left: h('button', { class: 'small quiet seg', onclick: () => setVertical('left') }, t('exportCropLeft')),
    center: h('button', { class: 'small quiet seg active', onclick: () => setVertical('center') }, t('exportCropCenter')),
    right: h('button', { class: 'small quiet seg', onclick: () => setVertical('right') }, t('exportCropRight')),
    blur: h('button', { class: 'small quiet seg', onclick: () => setVertical('blur') }, t('exportCropBlur')),
  };
  const anchorHint = h('span', { class: 'faint' }, t('exportVerticalHint'));
  const anchorRow = h('div', { class: 'row hidden', style: 'gap:6px' }, anchorBtns.left, anchorBtns.center, anchorBtns.right, anchorBtns.blur, anchorHint);
  const gifHint = h('p', { class: 'hint gif-hint hidden' }, t('exportGifHint', { width: GIF_WIDTH, max: GIF_MAX_SECONDS }));
  const progressBar = h('span', {});
  const progress = h('div', { class: 'progress trim-progress hidden' }, progressBar);
  const progressText = h('span', { class: 'faint hidden' });
  const uploadedNote = h('p', { class: 'hint hidden' }, t('trimUploadedNote'));
  trim.append(
    timeline,
    h(
      'div',
      { class: 'trim-vals' },
      h('span', {}, t('trimStart'), ' ', startVal),
      h('span', {}, t('trimEnd'), ' ', endVal),
      h('span', {}, t('trimLength'), ' ', lenVal),
      h('span', { class: 'grow' }),
      h('button', { class: 'small quiet', onclick: () => setStart(video.currentTime) }, t('trimSetStart')),
      h('button', { class: 'small quiet', onclick: () => setEnd(video.currentTime) }, t('trimSetEnd')),
      h('button', { class: 'small quiet', onclick: () => playSelection() }, '▶ ' + t('trimPlaySelection')),
      muteLabel,
      audioLabel,
      edit?.thumbnail ? h('button', { class: 'small quiet thumb-frame', title: t('thumbFrameHint'), onclick: () => void useFrameAsThumb() }, '📷 ' + t('thumbFrame')) : null
    ),
    h('p', { class: 'hint' }, t('trimHint')),
    h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'faint', style: 'margin-right:4px' }, t('exportFormat')), formatBtns.original, formatBtns.vertical, edit?.gif ? formatBtns.gif : null),
    anchorRow,
    gifHint,
    uploadedNote,
    h('div', { class: 'row trim-actions' }, saveNewBtn, replaceBtn, progress, progressText)
  );
  syncAudioChoice();

  // ---- video ----------------------------------------------------------------------
  const fail = (why: string) => {
    broken = true;
    options.onLog?.(`přehrávač: ${why} - ${clip.file}`);
    clear(stage);
    stage.append(
      h(
        'div',
        { class: 'player-error' },
        h('p', {}, t('playerError', { message: why })),
        h('button', { class: 'small', onclick: () => options.onOpenExternal(clip) }, t('playerOpenExternal'))
      )
    );
    if (editing) toggleEdit(false);
    editBtn.disabled = true;
  };
  let guard: ReturnType<typeof setTimeout> | null = null;
  const loadVideo = (bust: boolean) => {
    broken = false;
    editBtn.disabled = false;
    clear(stage);
    stage.append(video, shadeLeft, shadeRight);
    if (guard) clearTimeout(guard);
    video.src = fileUrl(clip.file) + (bust ? `?v=${Date.now()}` : '');
    video.load();
    // Soubor se otevřel, ale nic se nerozjelo (žádná metadata do 8 s) - taky chyba.
    guard = setTimeout(() => {
      if (video.readyState === 0 && video.isConnected && !saving) fail('no-metadata');
    }, 8000);
  };
  video.addEventListener('error', () => {
    if (saving || !video.getAttribute('src')) return;
    const err = video.error;
    fail(err ? `${MEDIA_ERRORS[err.code] ?? err.code}${err.message ? ': ' + err.message : ''}` : 'error');
  });
  video.addEventListener('loadedmetadata', () => {
    if (guard) clearTimeout(guard);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const fresh = end >= duration - 0.01 || end === 0;
      duration = video.duration;
      if (fresh) end = duration;
      end = clamp(end, Math.min(duration, start + MIN_LENGTH), duration);
    }
    layout();
  });
  const tick = () => {
    raf = 0;
    if (video.paused || closed) return;
    if (editing && video.currentTime >= end && video.currentTime - end < 0.35) video.currentTime = start;
    layoutPlayhead();
    raf = requestAnimationFrame(tick);
  };
  video.addEventListener('play', () => {
    if (!raf) raf = requestAnimationFrame(tick);
  });
  video.addEventListener('pause', layoutPlayhead);
  video.addEventListener('seeked', layoutPlayhead);
  video.addEventListener('timeupdate', () => {
    if (video.paused) layoutPlayhead();
  });

  // ---- časová osa ------------------------------------------------------------------
  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    if (r.width <= 0 || duration <= 0) return 0;
    return clamp(((clientX - r.left) / r.width) * duration, 0, duration);
  };
  const pct = (time: number) => (duration > 0 ? `${(clamp(time, 0, duration) / duration) * 100}%` : '0%');
  function layoutPlayhead() {
    playhead.style.left = pct(video.currentTime || 0);
  }
  /** Stínování mimo výřez 9:16 - podle toho, kde ve stránce video opravdu leží (může být s pruhy). */
  function layoutCrop() {
    const on = editing && !!vertical && video.videoWidth > 0 && video.videoHeight > 0;
    shadeLeft.classList.toggle('hidden', !on);
    shadeRight.classList.toggle('hidden', !on);
    if (!on) return;
    const box = video.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    const offX = box.left - stageBox.left + (box.width - dw) / 2;
    const offY = box.top - stageBox.top + (box.height - dh) / 2;
    const cropW = Math.min(video.videoWidth, (video.videoHeight * 9) / 16) * scale;
    const k = vertical === 'left' ? 0 : vertical === 'right' ? 1 : 0.5;
    const cropX = (dw - cropW) * k;
    for (const el of [shadeLeft, shadeRight]) {
      el.style.top = `${offY}px`;
      el.style.height = `${dh}px`;
      // Rozmazané pozadí: kraje se neoříznou, jen zmenší a rozmažou - stín to naznačí rozmazáním místo ztmavení.
      el.classList.toggle('blur', vertical === 'blur');
    }
    shadeLeft.style.left = `${offX}px`;
    shadeLeft.style.width = `${Math.max(0, cropX)}px`;
    shadeRight.style.left = `${offX + cropX + cropW}px`;
    shadeRight.style.width = `${Math.max(0, dw - cropX - cropW)}px`;
  }
  function setVertical(anchor: CropAnchor | null) {
    vertical = anchor;
    if (anchor) gif = false;
    formatBtns.original.classList.toggle('active', !anchor && !gif);
    formatBtns.vertical.classList.toggle('active', !!anchor);
    formatBtns.gif.classList.toggle('active', gif);
    anchorRow.classList.toggle('hidden', !anchor);
    gifHint.classList.toggle('hidden', !gif);
    for (const [key, btn] of Object.entries(anchorBtns)) btn.classList.toggle('active', key === anchor);
    anchorHint.textContent = anchor === 'blur' ? t('exportBlurHint') : t('exportVerticalHint');
    layoutCrop();
    refreshButtons();
  }
  function setFormat(format: ExportFormat) {
    if (format === 'vertical') {
      setVertical(vertical ?? 'center');
      return;
    }
    gif = format === 'gif';
    setVertical(null);
  }
  window.addEventListener('resize', layoutCrop);

  function layout() {
    range.style.left = pct(start);
    range.style.width = duration > 0 ? `${((end - start) / duration) * 100}%` : '0%';
    handleStart.style.left = pct(start);
    handleEnd.style.left = pct(end);
    startVal.textContent = formatTime(start);
    endVal.textContent = formatTime(end);
    lenVal.textContent = `${(end - start).toFixed(1)} s`;
    layoutPlayhead();
    layoutCrop();
    refreshButtons();
  }
  function setStart(time: number) {
    if (!editing) return;
    start = clamp(time, 0, Math.max(0, end - MIN_LENGTH));
    layout();
  }
  function setEnd(time: number) {
    if (!editing) return;
    end = clamp(time, Math.min(duration, start + MIN_LENGTH), duration);
    layout();
  }
  function bindHandle(el: HTMLElement, which: 'start' | 'end') {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      video.pause();
      const move = (ev: PointerEvent) => {
        const tm = timeAt(ev.clientX);
        if (which === 'start') setStart(tm);
        else setEnd(tm);
        // Ukázat snímek, na kterém úchyt stojí.
        video.currentTime = which === 'start' ? start : Math.max(0, end - 0.05);
      };
      const up = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch {
          // už puštěno
        }
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      move(e);
    });
  }
  bindHandle(handleStart, 'start');
  bindHandle(handleEnd, 'end');
  // Klik / tažení po ose mimo úchyty = posun přehrávání.
  timeline.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).classList.contains('tl-handle')) return;
    e.preventDefault();
    timeline.setPointerCapture(e.pointerId);
    const seek = (ev: PointerEvent) => {
      video.currentTime = timeAt(ev.clientX);
      layoutPlayhead();
    };
    const up = (ev: PointerEvent) => {
      try {
        timeline.releasePointerCapture(ev.pointerId);
      } catch {
        // už puštěno
      }
      timeline.removeEventListener('pointermove', seek);
      timeline.removeEventListener('pointerup', up);
      timeline.removeEventListener('pointercancel', up);
    };
    timeline.addEventListener('pointermove', seek);
    timeline.addEventListener('pointerup', up);
    timeline.addEventListener('pointercancel', up);
    seek(e);
  });

  function playSelection() {
    video.currentTime = start;
    void video.play().catch(() => undefined);
  }

  // ---- úpravy -----------------------------------------------------------------------
  function toggleEdit(on = !editing) {
    if (!edit || broken) return;
    editing = on;
    box.classList.toggle('editing', editing);
    trim.classList.toggle('hidden', !editing);
    editBtn.classList.toggle('active', editing);
    uploadedNote.classList.toggle('hidden', clip.upload?.state !== 'done');
    if (editing) {
      start = 0;
      end = duration;
      syncAudioChoice();
      confirmReplace = false;
      gif = false;
      setVertical(null);
    }
    layout();
  }
  function nothingToDo(): boolean {
    return start <= 0.05 && end >= duration - 0.05 && !mute && audioChoice === 'mix' && !vertical && !gif;
  }
  /** GIF: úsek musí být nejvýš GIF_MAX_SECONDS. */
  function gifTooLong(): boolean {
    return gif && end - start > GIF_MAX_SECONDS + 0.05;
  }
  function refreshButtons() {
    const idle = !saving && !broken && duration > 0;
    saveNewBtn.disabled = !idle || nothingToDo() || gifTooLong();
    saveNewBtn.textContent = gif ? t('gifSave') : t('trimSaveNew');
    // Jiný formát nejde "nahradit" - vždy nový klip (nebo soubor) vedle.
    replaceBtn.disabled = !idle || nothingToDo() || !!vertical || gif;
    replaceBtn.classList.toggle('hidden', gif);
    muteBox.disabled = gif;
    audioSelect.disabled = gif;
    saveNewBtn.title = nothingToDo() ? t('trimNothingToDo') : gifTooLong() ? t('gifTooLong', { max: GIF_MAX_SECONDS }) : '';
    replaceBtn.title = nothingToDo() ? t('trimNothingToDo') : '';
    replaceBtn.textContent = confirmReplace ? t('trimReplaceConfirm') : t('trimReplace');
    replaceBtn.classList.toggle('danger', confirmReplace);
    replaceBtn.classList.toggle('quiet', !confirmReplace);
    gifHint.classList.toggle('warn', gifTooLong());
    progress.classList.toggle('hidden', !saving);
    progressText.classList.toggle('hidden', !saving);
    if (saving) {
      progressBar.style.width = `${saving.percent}%`;
      progressText.textContent = t('trimWorking', { percent: saving.percent });
    }
  }
  function onReplaceClick() {
    if (!confirmReplace) {
      confirmReplace = true;
      refreshButtons();
      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        confirmReplace = false;
        refreshButtons();
      }, 5000);
      return;
    }
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmReplace = false;
    void save('replace');
  }
  function showNote(message: string, kind: 'ok' | 'error', ...actions: ({ label: string; onClick: () => void } | undefined)[]) {
    clear(note);
    note.append(h('span', {}, message));
    const shown = actions.filter((a): a is { label: string; onClick: () => void } => !!a);
    for (const action of shown) note.append(h('button', { class: 'small quiet', style: 'margin-left:10px', onclick: action.onClick }, action.label));
    note.className = `player-note ${kind}`;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.classList.add('hidden'), kind === 'error' ? 8000 : shown.length ? 12000 : 4000);
  }
  /** Snímek, na kterém přehrávač stojí, jako náhled klipu (karta v knihovně i na Kine). */
  async function useFrameAsThumb() {
    if (!edit?.thumbnail) return;
    const at = video.currentTime || 0;
    try {
      await edit.thumbnail(clip, at);
      showNote(t('thumbFrameDone', { time: formatTime(at) }), 'ok');
    } catch (e) {
      options.onLog?.(`náhled ze snímku: ${(e as Error).message}`);
      showNote(t('thumbFrameFailed', { message: errorText(e, t) }), 'error');
    }
  }
  /** GIF z výběru: soubor vedle klipu, klip sám se nemění; okno zůstane v úpravách. */
  async function saveGif() {
    if (!edit?.gif || saving || nothingToDo() || gifTooLong()) return;
    saving = { mode: 'gif', percent: 0 };
    refreshButtons();
    const unsubscribe = edit.onProgress((p) => {
      if (saving && p.id === clip.id) {
        saving.percent = p.percent;
        refreshButtons();
      }
    });
    try {
      const result = await edit.gif(clip, { start, end });
      saving = null;
      const name = result.file.split(/[\\/]/).pop() ?? result.file;
      const reveal = edit.reveal;
      const discord = edit.discord;
      showNote(
        t('gifDone', { name, size: formatBytes(result.sizeBytes) }),
        'ok',
        reveal ? { label: t('gifReveal'), onClick: () => reveal(result.file) } : undefined,
        discord
          ? {
              label: t('libraryDiscord'),
              onClick: () => {
                showNote(t('discordSending'), 'ok');
                discord(result.file, clip.title)
                  .then(() => showNote(t('discordSent'), 'ok'))
                  .catch((e: unknown) => showNote(t('discordFailed', { message: errorText(e, t) }), 'error'));
              },
            }
          : undefined
      );
    } catch (e) {
      saving = null;
      options.onLog?.(`GIF: ${(e as Error).message}`);
      const message = (e as Error).message ?? String(e);
      showNote(/gif-too-long/.test(message) ? t('gifTooLong', { max: GIF_MAX_SECONDS }) : t('gifFailed', { message: errorText(e, t) }), 'error');
    } finally {
      unsubscribe();
      refreshButtons();
    }
  }
  async function save(mode: 'new' | 'replace') {
    if (!edit || saving || nothingToDo()) return;
    saving = { mode, percent: 0 };
    refreshButtons();
    const unsubscribe = edit.onProgress((p) => {
      if (saving && p.id === clip.id) {
        saving.percent = p.percent;
        refreshButtons();
      }
    });
    const original = clip;
    // Přepsání: soubor pustit z ruky, ať ho na Windows jde přejmenovat.
    if (mode === 'replace') {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    try {
      const result = await edit.run(original, { start, end, mute, mode, vertical: vertical ?? undefined, audio: audioChoice });
      clip = result;
      titleEl.textContent = clip.title;
      titleEl.title = clip.title;
      showNote(t('trimDone', { title: clip.title }), 'ok');
      saving = null;
      // Výsledek se rovnou ukáže: přepsaný soubor znovu (bez mezipaměti), nový klip místo původního.
      duration = clip.durationSeconds > 0 ? clip.durationSeconds : 0;
      start = 0;
      end = duration;
      toggleEdit(false);
      loadVideo(mode === 'replace');
    } catch (e) {
      saving = null;
      options.onLog?.(`úprava klipu: ${(e as Error).message}`);
      showNote(t('trimFailed', { message: errorText(e, t) }), 'error');
      if (mode === 'replace') loadVideo(true);
    } finally {
      unsubscribe();
      refreshButtons();
    }
  }

  // ---- klávesy ----------------------------------------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (document.fullscreenElement) return;
      e.stopPropagation();
      e.preventDefault();
      close();
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target && (target === video || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return;
    if (broken) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
      video.currentTime = clamp(video.currentTime + step, 0, duration || video.duration || 0);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      video.muted = !video.muted;
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void video.requestFullscreen().catch(() => undefined);
    } else if (editing && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      setStart(video.currentTime);
    } else if (editing && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      setEnd(video.currentTime);
    }
  };
  document.addEventListener('keydown', onKey, true);

  // ---- otevření / zavření --------------------------------------------------------------
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', layoutCrop);
    if (raf) cancelAnimationFrame(raf);
    if (guard) clearTimeout(guard);
    if (confirmTimer) clearTimeout(confirmTimer);
    if (noteTimer) clearTimeout(noteTimer);
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // video už je pryč
    }
    overlay.remove();
    if (current === handle) current = null;
    options.onClose?.();
  }

  const handle: PlayerHandle = {
    close,
    clipId: () => clip.id,
    show,
    sync: (clips) => {
      const fresh = clips.find((c) => c.id === clip.id);
      if (!fresh) {
        // Klip smazaný nebo přejmenovaný soubor - vrstva nemá co ukazovat.
        if (!saving) close();
        return;
      }
      clip = { ...fresh };
      titleEl.textContent = clip.title;
      titleEl.title = clip.title;
      uploadedNote.classList.toggle('hidden', clip.upload?.state !== 'done');
      copyBtn.classList.toggle('hidden', clip.upload?.state !== 'done');
      refreshNav();
    },
  };
  current = handle;

  titleEl.textContent = clip.title;
  titleEl.title = clip.title;
  copyBtn.classList.toggle('hidden', clip.upload?.state !== 'done');
  document.body.append(overlay);
  loadVideo(false);
  if (options.startEditing && edit) toggleEdit(true);
  layout();
  refreshNav();
  return handle;
}
