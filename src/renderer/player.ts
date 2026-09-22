import type { Clip } from '../shared/types';
import type { Key } from '../shared/i18n';
import { clear, errorText, fileUrl, h } from './ui';

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

export type TrimRequest = { start: number; end: number; mute: boolean; mode: 'new' | 'replace' };

export type PlayerOptions = {
  clip: Clip;
  t: T;
  onOpenExternal: (clip: Clip) => void;
  onLog?: (message: string) => void;
  onClose?: () => void;
  /** Rovnou otevřít úpravy (tlačítko Upravit na kartě). */
  startEditing?: boolean;
  /** Bez tohohle se klip jen přehrává (žádné tlačítko Upravit). */
  edit?: {
    run: (clip: Clip, request: TrimRequest) => Promise<Clip>;
    onProgress: (cb: (p: { id: string; percent: number }) => void) => () => void;
  };
};

export type PlayerHandle = {
  close: () => void;
  /** Klip zvenku změněn (název, hra) - jen se překreslí titulek; když zmizel, vrstva se zavře. */
  sync: (clips: Clip[]) => void;
  clipId: () => string;
};

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
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.floor((rest - whole) * 10);
  return `${m}:${String(whole).padStart(2, '0')}.${tenth}`;
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
  let editing = false;
  let saving: { mode: 'new' | 'replace'; percent: number } | null = null;
  let confirmReplace = false;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let broken = false;
  let raf = 0;
  let closed = false;

  // ---- prvky ----------------------------------------------------------------------
  const video = h('video', { class: 'player-video', controls: true, autoplay: true, preload: 'auto' }) as HTMLVideoElement;
  const stage = h('div', { class: 'player-stage' }, video);
  const titleEl = h('div', { class: 'title' });
  const editBtn = h('button', { class: 'small quiet', onclick: () => toggleEdit() }, t('libraryEdit'));
  const note = h('div', { class: 'player-note hidden' });
  const trim = h('div', { class: 'trim hidden' });
  const box = h(
    'div',
    { class: 'player-box', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'player-head' },
      titleEl,
      h(
        'div',
        { class: 'row', style: 'flex-wrap:nowrap' },
        edit ? editBtn : null,
        h('button', { class: 'small quiet', onclick: () => options.onOpenExternal(clip) }, t('playerOpenExternal')),
        h('button', { class: 'small quiet player-close', title: t('playerClose'), onclick: () => close() }, '✕')
      )
    ),
    stage,
    trim,
    note
  );
  const overlay = h('div', { class: 'overlay' }, box);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

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
  const saveNewBtn = h('button', { class: 'small primary', onclick: () => void save('new') }, t('trimSaveNew'));
  const replaceBtn = h('button', { class: 'small quiet', onclick: () => onReplaceClick() }, t('trimReplace'));
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
      h('label', { class: 'check', style: 'align-items:center' }, muteBox, t('trimMute'))
    ),
    h('p', { class: 'hint' }, t('trimHint')),
    uploadedNote,
    h('div', { class: 'row trim-actions' }, saveNewBtn, replaceBtn, progress, progressText)
  );

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
    stage.append(video);
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
  function layout() {
    range.style.left = pct(start);
    range.style.width = duration > 0 ? `${((end - start) / duration) * 100}%` : '0%';
    handleStart.style.left = pct(start);
    handleEnd.style.left = pct(end);
    startVal.textContent = formatTime(start);
    endVal.textContent = formatTime(end);
    lenVal.textContent = `${(end - start).toFixed(1)} s`;
    layoutPlayhead();
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
      mute = false;
      muteBox.checked = false;
      confirmReplace = false;
    }
    layout();
  }
  function nothingToDo(): boolean {
    return start <= 0.05 && end >= duration - 0.05 && !mute;
  }
  function refreshButtons() {
    const idle = !saving && !broken && duration > 0;
    saveNewBtn.disabled = !idle || nothingToDo();
    replaceBtn.disabled = !idle || nothingToDo();
    saveNewBtn.title = nothingToDo() ? t('trimNothingToDo') : '';
    replaceBtn.title = nothingToDo() ? t('trimNothingToDo') : '';
    replaceBtn.textContent = confirmReplace ? t('trimReplaceConfirm') : t('trimReplace');
    replaceBtn.classList.toggle('danger', confirmReplace);
    replaceBtn.classList.toggle('quiet', !confirmReplace);
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
  function showNote(message: string, kind: 'ok' | 'error') {
    note.textContent = message;
    note.className = `player-note ${kind}`;
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.classList.add('hidden'), kind === 'error' ? 8000 : 4000);
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
      const result = await edit.run(original, { start, end, mute, mode });
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
    },
  };
  current = handle;

  titleEl.textContent = clip.title;
  titleEl.title = clip.title;
  document.body.append(overlay);
  loadVideo(false);
  if (options.startEditing && edit) toggleEdit(true);
  layout();
  return handle;
}
