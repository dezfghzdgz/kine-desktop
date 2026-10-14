import type { Clip } from '../shared/types';
import type { Key } from '../shared/i18n';
import { chapterTime, MARKER_LEAD_SECONDS } from '../shared/upload';
import { clear, errorText, fileUrl, formatBytes, h } from './ui';
import { followImage, playerAmbient, type PlayerAmbient } from './ambient';
import { icon } from './icons';

/**
 * Přehrávač klipu jako vrstva přes celé okno (lightbox): mřížka klipů pod
 * ním zůstává, jak je - nic se neroztahuje ani nepřeskládává. Escape nebo
 * klik mimo zavře. Když Chromium soubor nepřehraje (kodek, rozbité časy),
 * ukáže se důvod a tlačítko na přehrávač systému.
 *
 * Úpravy (jako v Medalu): tlačítko "Upravit" rozbalí časovou osu se dvěma
 * úchyty (začátek/konec), klávesy I a O je nastaví v místě přehrávání,
 * mezerník přehrává, přehrávání se v úpravách točí uvnitř výběru.
 * Zvuk jde odstranit, klip zpomalit / zrychlit a přidat do něj text (kreslí
 * se tady na canvas písmem appky a hlavní proces ho jen položí na obraz -
 * přibalený ffmpeg neumí psát text). Uložit lze jako nový klip vedle, nebo
 * přepsat původní - řez dělá hlavní proces (ffmpeg), sem chodí jen průběh.
 *
 * Nahrávka zápasu má "momenty" - místa, kde hráč během hraní uložil klip;
 * pod videem jsou jako tlačítka a na časové ose úprav jako značky.
 *
 * Vrstva je vždy nejvýš jedna; otevření dalšího klipu tu první zavře.
 */
type T = (key: Key, vars?: Record<string, string | number>) => string;

export type TrimRequest = {
  start: number;
  end: number;
  mute: boolean;
  mode: 'new' | 'replace';
  vertical?: 'left' | 'center' | 'right' | 'blur';
  audio?: AudioChoice;
  /** Rychlost (0,5 = zpomalení, 2 = dvakrát rychleji). */
  speed?: number;
  /** Text přes video: PNG v rozměru výsledku (jen oblast textu) a kde leží. */
  text?: { png: Uint8Array; position: TextPosition } | null;
};
type TextPosition = 'top' | 'center' | 'bottom';
type TextStyle = 'outline' | 'box' | 'yellow';
type TextSize = 's' | 'm' | 'l';
/** Rychlosti v úpravách - stejné jako v hlavním procesu (editPlan.SPEEDS). */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
/** Rychlosti přehrávání při prohlížení (tlačítko vpravo dole, klávesy < >); výchozí 1×. */
export const PLAYER_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
/** Výška písma vůči výšce výsledného videa. */
const TEXT_SIZES: Record<TextSize, number> = { s: 0.045, m: 0.065, l: 0.09 };
const TEXT_MAX = 80;
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
  /**
   * Celá obrazovka bez Fullscreen API (když ho okno odmítne): okno se přepne
   * přes celou obrazovku a scéna ho vyplní. Bez tohohle zůstane jen API.
   */
  setWindowFullscreen?: (on: boolean) => void;
  /**
   * Tlačítko celé obrazovky ve videu (vpravo dole) dá přes celou obrazovku
   * holé video a "spotřebuje" kliknutí - scénu se šipkami pak zapne hlavní
   * proces, jako by kliknul uživatel (window.__kinePlayerStageFullscreen).
   * Bez tohohle zůstane přes celou obrazovku jen video.
   */
  stageFullscreen?: () => void;
  /** Přepnuto na jiný klip (šipky) - okno ví, který soubor přehrávač drží. */
  onClipChange?: (clip: Clip) => void;
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

/** Rozměr výsledného videa - jako ffmpeg: výřez 9:16 má šířku trunc(min(iw, ih*9/16)/2)*2, výška zůstává. */
export function outputSize(width: number, height: number, vertical: boolean): { w: number; h: number } {
  if (!vertical) return { w: width, h: height };
  return { w: Math.max(2, Math.floor(Math.min(width, (height * 9) / 16) / 2) * 2), h: height };
}

/** Rozdělí text do řádků podle šířky (slovo delší než řádek zůstane samo - písmo se pak zmenší). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

let fontReady: Promise<unknown> | null = null;
/** Písmo Inter se načítá líně - před kreslením musí být připravené, jinak by canvas vzal náhradní. */
function ensureFont(): Promise<unknown> {
  fontReady ??= document.fonts.load("800 64px 'Inter'").catch(() => undefined);
  return fontReady;
}

/**
 * Text do videa jako obrázek s průhledností v pixelech výsledného videa:
 * nejvýš tři řádky na 90 % šířky (dlouhý text se zmenší), styl obrys /
 * tmavý pruh / žlutý pruh. null = žádný text.
 */
export function drawTextImage(text: string, style: TextStyle, size: TextSize, outW: number, outH: number): HTMLCanvasElement | null {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  if (!clean || outW <= 0 || outH <= 0) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const fontOf = (px: number) => `800 ${px}px 'Inter', 'Segoe UI', sans-serif`;
  const padFor = (px: number) => Math.round(px * (style === 'outline' ? 0.25 : 0.5));
  const maxWidth = outW * 0.9;
  let font = Math.max(10, Math.round(outH * TEXT_SIZES[size]));
  let lines: string[] = [clean];
  let widest = 0;
  for (let i = 0; i < 16; i++) {
    ctx.font = fontOf(font);
    lines = wrapLines(ctx, clean, maxWidth - padFor(font) * 2);
    widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length <= 3 && widest + padFor(font) * 2 <= maxWidth) || font <= 10) break;
    font = Math.max(10, Math.floor(font * 0.88));
  }
  const px = padFor(font);
  const py = Math.round(font * (style === 'outline' ? 0.2 : 0.3));
  const lineHeight = Math.round(font * 1.2);
  canvas.width = Math.max(1, Math.ceil(Math.min(outW, widest + px * 2)));
  canvas.height = Math.max(1, Math.ceil(lines.length * lineHeight + py * 2));
  ctx.font = fontOf(font);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (style !== 'outline') {
    ctx.fillStyle = style === 'yellow' ? '#ffd23f' : 'rgba(10, 10, 14, 0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, Math.round(font * 0.3));
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const x = canvas.width / 2;
    const y = py + lineHeight * (i + 0.5);
    if (style === 'outline') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, font * 0.16);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = style === 'yellow' ? '#111' : '#fff';
    ctx.fillText(line, x, y);
  });
  return canvas;
}

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
  /** Rychlost výsledku - náhled v úpravách hraje stejnou rychlostí. */
  let speed = 1;
  /** Rychlost přehrávání při prohlížení (tlačítko vpravo dole u celé obrazovky); platí i pro další klipy. */
  let viewRate = 1;
  /** Text přes video (prázdný = žádný) a jak vypadá. */
  let overlayText = '';
  let textPosition: TextPosition = 'bottom';
  let textStyle: TextStyle = 'outline';
  let textSize: TextSize = 'm';
  /** Nakreslený text v pixelech výsledku - stejný obrázek pro náhled i uložení. */
  let textImage: HTMLCanvasElement | null = null;
  let editing = false;
  let saving: { mode: 'new' | 'replace' | 'gif'; percent: number } | null = null;
  let confirmReplace = false;
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let broken = false;
  let raf = 0;
  let closed = false;
  /** Světlo kolem přehrávače (Vzhled -> Barvy podle obrazu); null = vypnuté. */
  let ambient: PlayerAmbient | null = null;

  // ---- prvky ----------------------------------------------------------------------
  // Celou obrazovku nedělá samotné video (to by ukázalo jen obraz), ale celá scéna - se šipkami na další klip.
  // Ovládání videa je vlastní (lišta dole: posuvník a pod ním tlačítka) - vestavěné Chromia mělo u klipů
  // s víc stopami nabídku ⋮ se "zvukovou stopou" a vlastní tlačítka (zvuk hry, mikrofon, rychlost)
  // do něj dát nešla, takže visela zvlášť nad ním na obraze.
  const video = h('video', {
    class: 'player-video',
    autoplay: true,
    preload: 'auto',
    disablepictureinpicture: true,
    disableremoteplayback: true,
  }) as HTMLVideoElement;
  // Stínování mimo výřez 9:16 (jen v úpravách s formátem na výšku).
  const shadeLeft = h('div', { class: 'crop-shade hidden' });
  const shadeRight = h('div', { class: 'crop-shade hidden' });
  // Náhled textu (v úpravách) - přesně ten obrázek, který se pak položí do videa.
  const textLayer = h('div', { class: 'text-preview hidden' });
  // Přes celou obrazovku: šipky po stranách (předchozí / další klip), nahoře název, pozice a zavření.
  const stagePrev = h('button', { class: 'stage-nav prev', title: `${t('playerPrev')} (←)`, 'aria-label': t('playerPrev'), onclick: () => go(-1) }, icon('chevronLeft', 34));
  const stageNext = h('button', { class: 'stage-nav next', title: `${t('playerNext')} (→)`, 'aria-label': t('playerNext'), onclick: () => go(1) }, icon('chevronRight', 34));
  const stageTitle = h('span', { class: 'stage-title' });
  const stagePos = h('span', { class: 'stage-pos' });
  // Jak z celé obrazovky ven, když se klip nedá přehrát (není video s vlastní ikonou vpravo dole).
  const fullscreenBtn = h('button', { class: 'stage-fullscreen', title: `${t('playerExitFullscreen')} (F)`, 'aria-label': t('playerExitFullscreen'), onclick: () => toggleFullscreen() }, icon('shrink', 18));
  const stageTop = h('div', { class: 'stage-top' }, stageTitle, stagePos);
  // Ovládání videa: dole přes obraz posuvník a pod ním jedna řada - přehrát, hlasitost, čas, vpravo
  // zvuk hry a mikrofon zvlášť (klipy se samostatnými stopami), rychlost a celá obrazovka. Stejné
  // i přes celou obrazovku; při přehrávání se po chvíli bez pohybu myši schová.
  const playBtn = h('button', { class: 'pc-btn pc-play', onclick: () => togglePlay() }) as HTMLButtonElement;
  const muteBtn = h('button', { class: 'pc-btn pc-mute', onclick: () => toggleMute() }) as HTMLButtonElement;
  const volumeRange = h('input', {
    type: 'range',
    class: 'pc-volume',
    min: '0',
    max: '1',
    step: '0.02',
    'aria-label': t('playerVolume'),
    title: t('playerVolume'),
    oninput: (e: Event) => setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const timeNow = h('span', { class: 'pc-time-now' }, '0:00');
  const timeAll = h('span', { class: 'pc-time-all' }, '0:00');
  const seekBuffered = h('div', { class: 'pc-seek-buffered' });
  const seekPlayed = h('div', { class: 'pc-seek-played' });
  /** Momenty nahrávky (uložené klipy během hraní) jako značky na posuvníku. */
  const seekTicks = h('div', { class: 'pc-seek-ticks' });
  const seekThumb = h('div', { class: 'pc-seek-thumb' });
  const seekTip = h('div', { class: 'pc-seek-tip hidden' });
  const seekBar = h(
    'div',
    { class: 'pc-seek', role: 'slider', 'aria-label': t('playerSeek'), 'aria-valuemin': '0' },
    h('div', { class: 'pc-seek-track' }, seekBuffered, seekPlayed, seekTicks, seekThumb),
    seekTip
  );
  const fullBtn = h('button', { class: 'pc-btn pc-full', onclick: () => toggleFullscreen() }) as HTMLButtonElement;
  const gameChip = h(
    'button',
    { class: 'tool-chip tool-game', 'aria-pressed': 'true', title: t('playerGameAudioHint'), onclick: () => toggleTrack('game') },
    icon('gamepad', 15),
    h('span', {}, t('playerGameAudio'))
  ) as HTMLButtonElement;
  const micChip = h(
    'button',
    { class: 'tool-chip tool-mic', 'aria-pressed': 'true', title: t('playerMicAudioHint'), onclick: () => toggleTrack('mic') },
    icon('mic', 15),
    h('span', {}, t('playerMicAudio'))
  ) as HTMLButtonElement;
  const rateFormat = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 2 });
  const rateValue = h('span', { class: 'tool-rate-value' }, '1×');
  const rateChip = h(
    'button',
    { class: 'tool-chip tool-rate', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: `${t('playerSpeed')} (< >)`, onclick: () => toggleRateMenu() },
    icon('gauge', 15),
    rateValue
  ) as HTMLButtonElement;
  const rateItems = PLAYER_RATES.map(
    (value) =>
      h('button', { class: `tool-rate-item ${value === 1 ? 'active' : ''}`, role: 'menuitemradio', 'aria-checked': value === 1 ? 'true' : 'false', onclick: () => setViewRate(value, true) }, `${rateFormat.format(value)}×`) as HTMLButtonElement
  );
  const rateMenu = h('div', { class: 'tool-rate-menu hidden', role: 'menu', 'aria-label': t('playerSpeed') }, ...rateItems);
  const tools = h('div', { class: 'player-tools' }, gameChip, micChip, h('div', { class: 'tool-rate-wrap' }, rateMenu, rateChip));
  const controls = h(
    'div',
    { class: 'player-controls' },
    seekBar,
    h('div', { class: 'pc-row' }, playBtn, h('div', { class: 'pc-vol' }, muteBtn, volumeRange), h('span', { class: 'pc-time' }, timeNow, ' / ', timeAll), h('span', { class: 'pc-spacer' }), tools, fullBtn)
  );
  const stageChrome = [stagePrev, stageNext, stageTop, fullscreenBtn, controls];
  const stage = h('div', { class: 'player-stage' }, video, shadeLeft, shadeRight, textLayer, ...stageChrome);
  /** Momenty nahrávky (uložené klipy během hraní) - skok kousek před ně. */
  const markersRow = h('div', { class: 'player-markers hidden' });
  const titleEl = h('div', { class: 'title' });
  /** "3 / 24" - kde v seznamu klip je (jen se sousedy). */
  const positionEl = h('span', { class: 'player-pos faint hidden' });
  const editBtn = h('button', { class: 'small quiet player-edit', onclick: () => toggleEdit() }, icon('scissors', 15), t('libraryEdit'));
  const copyBtn = h('button', { class: 'small quiet player-copy hidden', onclick: () => { if (options.onCopyLink) { options.onCopyLink(clip); showNote(t('linkCopied'), 'ok'); } } }, icon('link', 15), t('libraryCopyLink'));
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
        h('button', { class: 'small quiet', title: t('playerOpenExternal'), onclick: () => options.onOpenExternal(clip) }, icon('external', 15), t('playerOpenExternal')),
        h('button', { class: 'small quiet player-close', title: t('playerClose'), 'aria-label': t('playerClose'), onclick: () => close() }, icon('close', 16))
      )
    ),
    stage,
    markersRow,
    trim,
    note
  );
  // Šipky po stranách: předchozí / další klip v seznamu (i klávesy ↑ ↓).
  const prevBtn = h('button', { class: 'player-nav prev hidden', title: `${t('playerPrev')} (←)`, 'aria-label': t('playerPrev'), onclick: () => go(-1) }, icon('chevronLeft', 28));
  const nextBtn = h('button', { class: 'player-nav next hidden', title: `${t('playerNext')} (→)`, 'aria-label': t('playerNext'), onclick: () => go(1) }, icon('chevronRight', 28));
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
    stagePrev.classList.toggle('hidden', !show);
    stageNext.classList.toggle('hidden', !show);
    stageTitle.textContent = clip.title;
    stagePos.textContent = show && n ? `${n.index + 1} / ${n.total}` : '';
    if (!n || !show) return;
    prevBtn.disabled = !n.prev;
    nextBtn.disabled = !n.next;
    stagePrev.disabled = !n.prev;
    stageNext.disabled = !n.next;
    positionEl.textContent = `${n.index + 1} / ${n.total}`;
  }

  // ---- celá obrazovka -------------------------------------------------------------------
  /**
   * Celá obrazovka = scéna (video + šipky), ne holé video - ať jde i tam
   * přeskakovat mezi klipy. Když okno Fullscreen API odmítne, přepne se
   * přes celou obrazovku samo okno a scéna ho vyplní ("náhradní" režim).
   */
  function isFull(): boolean {
    return document.fullscreenElement === stage || stage.classList.contains('pseudo-full');
  }
  function toggleFullscreen() {
    // I holé video přes celou obrazovku (když scéna nešla) se tímhle zavře.
    if (isFull() || document.fullscreenElement) {
      exitFullscreen();
      return;
    }
    stage.requestFullscreen().catch(() => enterPseudoFullscreen());
  }
  /**
   * Video vyjmuté z celé obrazovky: vyndá se a hned vrátí na stejné místo
   * (prohlížeč ho tím pustí z vrstvy celé obrazovky). Hraje dál, nic se
   * znovu nenačítá - scéna kolem něj zůstane přes celou obrazovku.
   */
  function releaseVideo() {
    if (!video.matches(':fullscreen')) return;
    const parent = video.parentNode;
    if (!parent) return;
    const next = video.nextSibling;
    parent.removeChild(video);
    parent.insertBefore(video, next);
  }
  /** Scéna přes celou obrazovku "jako kliknutím" - volá ji hlavní proces (options.stageFullscreen). */
  const stageFullscreenHook = (): Promise<boolean> =>
    stage
      .requestFullscreen()
      .then(() => {
        releaseVideo();
        return true;
      })
      .catch(() => false);
  (window as any).__kinePlayerStageFullscreen = stageFullscreenHook;
  function enterPseudoFullscreen() {
    if (closed || !options.setWindowFullscreen) return;
    stage.classList.add('pseudo-full');
    document.body.classList.add('player-pseudo-full');
    options.setWindowFullscreen(true);
    onFullscreenChange();
  }
  function exitFullscreen() {
    releaseVideo();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (stage.classList.contains('pseudo-full')) {
      stage.classList.remove('pseudo-full');
      document.body.classList.remove('player-pseudo-full');
      options.setWindowFullscreen?.(false);
      onFullscreenChange();
    }
  }
  // Ovládání se při přehrávání po chvíli bez pohybu myši schová (jako v přehrávačích); přes celou
  // obrazovku i šipky, název a kurzor. Při pauze, s myší na liště a s otevřenou nabídkou zůstává.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let overControls = false;
  let seekDragging = false;
  const hideSoon = (ms = 2500) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (closed || video.paused || overControls || seekDragging || !rateMenu.classList.contains('hidden')) return;
      stage.classList.add('controls-idle');
      if (isFull()) stage.classList.add('idle');
    }, ms);
  };
  const wake = () => {
    stage.classList.remove('idle', 'controls-idle');
    hideSoon();
  };
  stage.addEventListener('mousemove', wake);
  // Myš pryč z videa (mimo celou obrazovku): při přehrávání se lišta schová hned.
  stage.addEventListener('mouseleave', () => {
    if (!video.paused && !isFull()) hideSoon(400);
  });
  controls.addEventListener('mouseenter', () => {
    overControls = true;
  });
  controls.addEventListener('mouseleave', () => {
    overControls = false;
  });
  // Po kliknutí myší tlačítko (nebo hlasitost) lišty fokus nedrží - mezerník a šipky pak dál
  // ovládají video, ne naposledy zmáčknuté tlačítko.
  controls.addEventListener('mouseup', () => {
    setTimeout(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el && el !== document.body && controls.contains(el)) el.blur();
    }, 0);
  });
  const onFullscreenChange = () => {
    if (closed) return;
    // Ikona celé obrazovky ve videu (vpravo dole) dá přes celou obrazovku holé video.
    if (document.fullscreenElement === video) {
      if (stage.classList.contains('fullscreen')) {
        // ...zmáčknutá v celé obrazovce scény = ven (ikona tam ukazuje "zmenšit").
        exitFullscreen();
        return;
      }
      // ...mimo ni = celá obrazovka, ale scéna se šipkami na další klip, ne holé video.
      // Kliknutí už prohlížeč "spotřeboval", takže scénu zapne hlavní proces.
      stage
        .requestFullscreen()
        .then(releaseVideo)
        .catch(() => options.stageFullscreen?.());
      return;
    }
    const full = isFull();
    stage.classList.toggle('fullscreen', full);
    refreshFullButton();
    wake();
    onResize();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  video.addEventListener('dblclick', (e) => {
    e.preventDefault();
    // Chromium dvojklikem sám dá přes celou obrazovku holé video a "kliknutí" si tím vezme -
    // to pak převezme onFullscreenChange (scéna, nebo ven). Tady jen když to neudělal.
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (activation && !activation.isActive) return;
    toggleFullscreen();
  });
  function go(direction: -1 | 1) {
    const n = options.neighbors?.(clip.id);
    const target = direction < 0 ? n?.prev : n?.next;
    if (target && !saving) show(target);
  }
  /** Jiný klip ve stejné vrstvě: úpravy se zavřou, video se vymění, titulek a šipky se srovnají. */
  function show(next: Clip) {
    if (closed) return;
    clip = { ...next };
    options.onClipChange?.(clip);
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
    renderMarkers();
    layout();
    refreshNav();
    // Pozadí skla podle klipu (Vzhled -> Barvy podle obrazu).
    if (clip.thumb) followImage(fileUrl(clip.thumb));
  }
  // Hlasitost jako minule; každá změna se uloží (ne ztlumení náhledu "bez zvuku" v úpravách).
  const remembered = loadVolume();
  if (remembered) {
    video.volume = remembered.volume;
    video.muted = remembered.muted;
  }
  /** Náhled ztlumený jen kvůli "bez zvuku" (prohlížeč bez přepínání stop) - a jak to měl hráč předtím. */
  let previewSilenced = false;
  let userMuted = video.muted;
  video.addEventListener('volumechange', () => {
    refreshVolume();
    if (previewSilenced) return;
    userMuted = video.muted;
    saveVolume(video.volume, video.muted);
  });

  // ---- ovládání videa (lišta dole) ------------------------------------------------------
  /** Čas na liště: m:ss (h:mm:ss u dlouhé nahrávky). */
  function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }
  function togglePlay() {
    if (broken) return;
    if (video.paused || video.ended) void video.play().catch(() => undefined);
    else video.pause();
  }
  function refreshPlay() {
    const paused = video.paused || video.ended;
    clear(playBtn);
    playBtn.append(icon(paused ? 'play' : 'pauseFilled', 20));
    const label = `${paused ? t('playerPlay') : t('playerPause')} (K)`;
    playBtn.title = label;
    playBtn.setAttribute('aria-label', label);
  }
  function setVolume(value: number) {
    const v = clamp(value, 0, 1);
    video.volume = v;
    video.muted = v === 0;
  }
  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.5;
    } else video.muted = true;
  }
  function refreshVolume() {
    const silent = video.muted || video.volume === 0;
    clear(muteBtn);
    muteBtn.append(icon(silent ? 'volumeOff' : 'volume', 20));
    const label = `${silent ? t('playerUnmute') : t('playerMute')} (M)`;
    muteBtn.title = label;
    muteBtn.setAttribute('aria-label', label);
    const level = silent ? 0 : video.volume;
    volumeRange.value = String(level);
    volumeRange.style.setProperty('--level', `${Math.round(level * 100)}%`);
  }
  function refreshFullButton() {
    const full = isFull();
    clear(fullBtn);
    fullBtn.append(icon(full ? 'shrink' : 'expand', 19));
    const label = `${full ? t('playerExitFullscreen') : t('playerFullscreen')} (F)`;
    fullBtn.title = label;
    fullBtn.setAttribute('aria-label', label);
  }
  /** Délka videa pro lištu (dokud nejsou metadata, z knihovny). */
  const totalTime = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration);
  /** Posuvník a čas podle místa přehrávání (a kolik je načteno). */
  function refreshSeek() {
    const total = totalTime();
    const now = clamp(video.currentTime || 0, 0, total || 0);
    const share = total > 0 ? now / total : 0;
    seekPlayed.style.width = `${share * 100}%`;
    seekThumb.style.left = `${share * 100}%`;
    let loaded = 0;
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= now + 0.5) loaded = Math.max(loaded, video.buffered.end(i));
      }
    } catch {
      loaded = 0;
    }
    seekBuffered.style.width = total > 0 ? `${clamp(loaded / total, 0, 1) * 100}%` : '0%';
    timeNow.textContent = clock(now);
    timeAll.textContent = clock(total);
    seekBar.setAttribute('aria-valuemax', String(Math.round(total)));
    seekBar.setAttribute('aria-valuenow', String(Math.round(now)));
    seekBar.setAttribute('aria-valuetext', `${clock(now)} / ${clock(total)}`);
  }
  /** Momenty nahrávky jako značky na posuvníku. */
  function layoutSeekTicks() {
    clear(seekTicks);
    const total = totalTime();
    if (total <= 0) return;
    for (const m of markerList()) seekTicks.append(h('span', { style: `left:${(clamp(m.time, 0, total) / total) * 100}%`, title: String(m.label ?? '') }));
  }
  const seekTime = (clientX: number) => {
    const r = seekBar.getBoundingClientRect();
    const total = totalTime();
    if (r.width <= 0 || total <= 0) return 0;
    return clamp(((clientX - r.left) / r.width) * total, 0, total);
  };
  // Tažení po posuvníku: přehrávání skáče, kam ukazuje myš; najetí ukáže čas.
  seekBar.addEventListener('pointerdown', (e) => {
    if (broken || e.button !== 0) return;
    e.preventDefault();
    seekBar.setPointerCapture(e.pointerId);
    seekDragging = true;
    seekBar.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      video.currentTime = seekTime(ev.clientX);
      refreshSeek();
      layoutPlayhead();
    };
    const up = (ev: PointerEvent) => {
      try {
        seekBar.releasePointerCapture(ev.pointerId);
      } catch {
        // už puštěno
      }
      seekDragging = false;
      seekBar.classList.remove('dragging');
      seekBar.removeEventListener('pointermove', move);
      seekBar.removeEventListener('pointerup', up);
      seekBar.removeEventListener('pointercancel', up);
      wake();
    };
    seekBar.addEventListener('pointermove', move);
    seekBar.addEventListener('pointerup', up);
    seekBar.addEventListener('pointercancel', up);
    move(e);
  });
  seekBar.addEventListener('pointermove', (e) => {
    const total = totalTime();
    if (total <= 0) return;
    const r = seekBar.getBoundingClientRect();
    const x = clamp(e.clientX - r.left, 0, r.width);
    seekTip.textContent = clock(seekTime(e.clientX));
    seekTip.style.left = `${clamp(x, 22, Math.max(22, r.width - 22))}px`;
    seekTip.classList.remove('hidden');
  });
  seekBar.addEventListener('pointerleave', () => seekTip.classList.add('hidden'));
  // Klik do obrazu = přehrát / pozastavit (dvojklik = celá obrazovka - přehrávání se tím přepne dvakrát, zůstane).
  video.addEventListener('click', () => togglePlay());
  video.addEventListener('play', () => {
    refreshPlay();
    hideSoon();
  });
  video.addEventListener('pause', () => {
    refreshPlay();
    wake();
  });
  video.addEventListener('ended', refreshPlay);
  video.addEventListener('timeupdate', refreshSeek);
  video.addEventListener('progress', refreshSeek);
  video.addEventListener('durationchange', () => {
    refreshSeek();
    layoutSeekTicks();
  });
  refreshPlay();
  refreshVolume();
  refreshFullButton();

  // ---- rychlost přehrávání ----------------------------------------------------------------
  /** Rychlost, kterou video hraje: v úpravách ta, se kterou se klip uloží (náhled), jinak ta z tlačítka. */
  function applyRate() {
    const rate = editing ? speed : viewRate;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    rateValue.textContent = `${rateFormat.format(rate)}×`;
    rateChip.classList.toggle('changed', rate !== 1);
    rateItems.forEach((btn, i) => {
      const on = PLAYER_RATES[i] === rate;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function setViewRate(value: number, fromMenu = false) {
    viewRate = value;
    applyRate();
    if (fromMenu) toggleRateMenu(false);
  }
  function toggleRateMenu(open = rateMenu.classList.contains('hidden')) {
    rateMenu.classList.toggle('hidden', !open);
    rateChip.setAttribute('aria-expanded', open ? 'true' : 'false');
    tools.classList.toggle('menu-open', open);
  }
  /** O stupeň pomaleji / rychleji (klávesy < a >); v úpravách rychlost, se kterou se klip uloží. */
  function stepRate(dir: -1 | 1) {
    const list: readonly number[] = editing ? SPEEDS : PLAYER_RATES;
    const current = editing ? speed : viewRate;
    let idx = list.findIndex((r) => r === current);
    if (idx < 0) idx = list.indexOf(1);
    const next = list[clamp(idx + dir, 0, list.length - 1)];
    if (editing) setSpeed(next);
    else setViewRate(next);
    showNote(`${editing ? t('trimSpeed') : t('playerSpeed')}: ${rateFormat.format(next)}×`, 'ok');
  }
  stage.addEventListener('mousedown', (e) => {
    if (!rateMenu.classList.contains('hidden') && !(e.target as HTMLElement).closest('.tool-rate-wrap')) toggleRateMenu(false);
  });

  // Časová osa se staví jednou - při tažení se jen posouvají styly.
  const track = h('div', { class: 'tl-track' });
  const range = h('div', { class: 'tl-range' });
  const handleStart = h('div', { class: 'tl-handle start', title: t('trimStart') });
  const handleEnd = h('div', { class: 'tl-handle end', title: t('trimEnd') });
  const playhead = h('div', { class: 'tl-playhead' });
  /** Značky momentů nahrávky na časové ose (kde hráč zmáčkl klip). */
  const ticks = h('div', { class: 'tl-ticks' });
  const timeline = h('div', { class: 'tl' }, track, ticks, range, handleStart, handleEnd, playhead);
  const startVal = h('b', {});
  const endVal = h('b', {});
  const lenVal = h('b', {});
  const muteBox = h('input', { type: 'checkbox', onchange: (e: Event) => { mute = (e.target as HTMLInputElement).checked; refreshButtons(); applyPreviewAudio(); } }) as HTMLInputElement;
  const muteLabel = h('label', { class: 'check trim-mute', style: 'align-items:center' }, muteBox, t('trimMute'));
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
        applyPreviewAudio();
      },
    },
    h('option', { value: 'mix' }, t('trimAudioMix')),
    h('option', { value: 'game' }, t('trimAudioGame')),
    h('option', { value: 'mic' }, t('trimAudioMic')),
    h('option', { value: 'none' }, t('trimAudioNone'))
  ) as HTMLSelectElement;
  const audioLabel = h('label', { class: 'row trim-audio-row', style: 'gap:6px;align-items:center' }, h('span', { class: 'faint' }, t('trimAudio')), audioSelect);
  /** Má klip samostatné stopy hra / mikrofon? */
  function separateTracks(): boolean {
    const tracks = clip.audioTracks ?? [];
    return tracks.includes('game') && tracks.includes('mic');
  }
  /**
   * Podle stop klipu výběr zvuku, nebo jen "bez zvuku". `reset` (jiný klip) začne se vším;
   * otevření úprav nechá, co hráč vypnul tlačítky ve videu (uloží se, co slyší).
   */
  function syncAudioChoice(reset = true) {
    const separate = separateTracks();
    audioLabel.classList.toggle('hidden', !separate);
    muteLabel.classList.toggle('hidden', separate);
    if (reset || !separate) {
      audioChoice = 'mix';
      mute = false;
    }
    audioSelect.value = audioChoice;
    muteBox.checked = mute;
    gameChip.classList.toggle('hidden', !separate);
    micChip.classList.toggle('hidden', !separate);
    refreshTrackChips();
    applyPreviewAudio();
  }
  /** Tlačítka zvuku hry a mikrofonu podle toho, co se zrovna hraje. */
  function refreshTrackChips() {
    const gameOn = !mute && (audioChoice === 'mix' || audioChoice === 'game');
    const micOn = !mute && (audioChoice === 'mix' || audioChoice === 'mic');
    gameChip.classList.toggle('off', !gameOn);
    micChip.classList.toggle('off', !micOn);
    gameChip.setAttribute('aria-pressed', gameOn ? 'true' : 'false');
    micChip.setAttribute('aria-pressed', micOn ? 'true' : 'false');
  }
  /** Vypne / zapne zvuk hry nebo mikrofon - v náhledu hned a stejně se pak uloží v úpravách. */
  function toggleTrack(kind: 'game' | 'mic') {
    let gameOn = !mute && (audioChoice === 'mix' || audioChoice === 'game');
    let micOn = !mute && (audioChoice === 'mix' || audioChoice === 'mic');
    if (kind === 'game') gameOn = !gameOn;
    else micOn = !micOn;
    audioChoice = gameOn && micOn ? 'mix' : gameOn ? 'game' : micOn ? 'mic' : 'none';
    mute = audioChoice === 'none';
    audioSelect.value = audioChoice;
    refreshTrackChips();
    refreshButtons();
    applyPreviewAudio();
  }
  /**
   * Co se v náhledu hraje: stopa podle výběru (0 = smíchaná, pak hra, mikrofon - Clip.audioTracks).
   * Stopy přepíná prohlížeč (okno má zapnuté AudioVideoTracks - main.ts); bez toho aspoň "bez zvuku".
   */
  function applyPreviewAudio() {
    const choice = audioChoice;
    const silent = mute || choice === 'none';
    const layoutTracks: string[] = clip.audioTracks ?? [];
    const want = silent ? -1 : choice === 'mix' ? 0 : Math.max(0, layoutTracks.indexOf(choice));
    const list = (video as HTMLVideoElement & { audioTracks?: { length: number; [index: number]: { enabled: boolean } } }).audioTracks;
    if (list && list.length > 0) {
      let wasSilent = true;
      for (let i = 0; i < list.length; i++) if (list[i].enabled) wasSilent = false;
      for (let i = 0; i < list.length; i++) {
        const on = i === want;
        if (list[i].enabled !== on) list[i].enabled = on;
      }
      // Po vypnutí všech stop pustí Chromium tutéž stopu znovu až za 1-2 s (změřeno); skok na
      // stejné místo ji rozjede hned (do 0,1 s). Přepnutí mezi stopami je rychlé i bez toho.
      if (wasSilent && want >= 0 && video.readyState >= 1 && !video.seeking) video.currentTime = video.currentTime;
      if (previewSilenced) {
        previewSilenced = false;
        video.muted = userMuted;
      }
      return;
    }
    if (silent && !previewSilenced) {
      previewSilenced = true;
      userMuted = video.muted;
      video.muted = true;
    } else if (!silent && previewSilenced) {
      previewSilenced = false;
      video.muted = userMuted;
    }
  }
  const saveNewBtn = h('button', { class: 'small primary', onclick: () => void (gif ? saveGif() : save('new')) }, t('trimSaveNew'));
  const replaceBtn = h('button', { class: 'small quiet', onclick: () => onReplaceClick() }, t('trimReplace'));
  // Formát: původní / na výšku (a kde výřez leží) / GIF.
  const formatBtns: Record<ExportFormat, HTMLButtonElement> = {
    original: h('button', { class: 'small quiet seg active', onclick: () => setFormat('original') }, t('exportOriginal')),
    vertical: h('button', { class: 'small quiet seg', onclick: () => setFormat('vertical') }, icon('phone', 14), t('exportVertical')),
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

  // Rychlost: zpomalení / zrychlení (náhled hraje stejně rychle).
  const numberFormat = new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: 2 });
  const speedBtns = SPEEDS.map(
    (value) => h('button', { class: `small quiet seg ${value === 1 ? 'active' : ''}`, onclick: () => setSpeed(value) }, `${numberFormat.format(value)}×`) as HTMLButtonElement
  );
  const speedRow = h('div', { class: 'row trim-speed', style: 'gap:6px', title: t('trimSpeedHint') }, h('span', { class: 'faint', style: 'margin-right:4px' }, t('trimSpeed')), ...speedBtns);
  // Text přes video: pole, poloha, styl, velikost.
  const textInput = h('input', {
    type: 'text',
    class: 'trim-text',
    maxlength: String(TEXT_MAX),
    placeholder: t('trimTextPlaceholder'),
    oninput: (e: Event) => {
      overlayText = (e.target as HTMLInputElement).value;
      void refreshText();
    },
  }) as HTMLInputElement;
  const positionBtns: Record<TextPosition, HTMLButtonElement> = {
    top: h('button', { class: 'small quiet seg', onclick: () => setTextPosition('top') }, t('trimTextTop')),
    center: h('button', { class: 'small quiet seg', onclick: () => setTextPosition('center') }, t('trimTextCenter')),
    bottom: h('button', { class: 'small quiet seg active', onclick: () => setTextPosition('bottom') }, t('trimTextBottom')),
  };
  const selectStyle = 'width:auto;min-height:32px;padding:4px 10px';
  const styleSelect = h(
    'select',
    { class: 'trim-text-style', style: selectStyle, onchange: (e: Event) => { textStyle = (e.target as HTMLSelectElement).value as TextStyle; void refreshText(); } },
    h('option', { value: 'outline' }, t('trimTextStyleOutline')),
    h('option', { value: 'box' }, t('trimTextStyleBox')),
    h('option', { value: 'yellow' }, t('trimTextStyleYellow'))
  ) as HTMLSelectElement;
  const sizeSelect = h(
    'select',
    { class: 'trim-text-size', style: selectStyle, onchange: (e: Event) => { textSize = (e.target as HTMLSelectElement).value as TextSize; void refreshText(); } },
    h('option', { value: 's' }, t('trimTextSizeS')),
    h('option', { value: 'm' }, t('trimTextSizeM')),
    h('option', { value: 'l' }, t('trimTextSizeL'))
  ) as HTMLSelectElement;
  sizeSelect.value = 'm';
  const textRow = h(
    'div',
    { class: 'row trim-text-row', style: 'gap:6px' },
    h('span', { class: 'faint', style: 'margin-right:4px' }, t('trimText')),
    textInput,
    positionBtns.top,
    positionBtns.center,
    positionBtns.bottom,
    styleSelect,
    sizeSelect
  );
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
      h('button', { class: 'small quiet', onclick: () => playSelection() }, icon('play', 13), t('trimPlaySelection')),
      muteLabel,
      audioLabel,
      edit?.thumbnail ? h('button', { class: 'small quiet thumb-frame', title: t('thumbFrameHint'), onclick: () => void useFrameAsThumb() }, icon('image', 14), t('thumbFrame')) : null
    ),
    h('p', { class: 'hint' }, t('trimHint')),
    h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'faint', style: 'margin-right:4px' }, t('exportFormat')), formatBtns.original, formatBtns.vertical, edit?.gif ? formatBtns.gif : null),
    anchorRow,
    gifHint,
    speedRow,
    textRow,
    uploadedNote,
    h('div', { class: 'row trim-actions' }, saveNewBtn, replaceBtn, progress, progressText)
  );
  syncAudioChoice();

  // ---- video ----------------------------------------------------------------------
  const fail = (why: string) => {
    broken = true;
    options.onLog?.(`přehrávač: ${why} - ${clip.file}`);
    releaseVideo();
    stage.classList.add('broken');
    clear(stage);
    stage.append(
      h(
        'div',
        { class: 'player-error' },
        h('p', {}, t('playerError', { message: why })),
        h('button', { class: 'small', onclick: () => options.onOpenExternal(clip) }, t('playerOpenExternal'))
      ),
      // I u rozbitého klipu jde přejít na další (i přes celou obrazovku).
      ...stageChrome
    );
    if (editing) toggleEdit(false);
    editBtn.disabled = true;
    ambient?.draw();
  };
  let guard: ReturnType<typeof setTimeout> | null = null;
  const loadVideo = (bust: boolean) => {
    broken = false;
    editBtn.disabled = false;
    stage.classList.remove('broken');
    clear(stage);
    stage.append(video, shadeLeft, shadeRight, textLayer, ...stageChrome);
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
    layoutTicks();
    if (overlayText.trim()) void refreshText();
    // Nový zdroj začíná vším zvukem a rychlostí 1 - vrátit, co je vybrané.
    applyPreviewAudio();
    applyRate();
    refreshSeek();
    layoutSeekTicks();
  });
  const tick = () => {
    raf = 0;
    if (video.paused || closed) return;
    if (editing && video.currentTime >= end && video.currentTime - end < 0.35) video.currentTime = start;
    layoutPlayhead();
    if (!seekDragging) refreshSeek();
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
  /** Náhled textu: kde obrázek leží ve výsledku (vodorovně uprostřed, svisle podle volby), přepočtené na video v okně. */
  function layoutText() {
    const on = editing && !gif && !!textImage && video.videoWidth > 0 && video.videoHeight > 0;
    textLayer.classList.toggle('hidden', !on);
    if (!on || !textImage) return;
    const box = video.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    const offX = box.left - stageBox.left + (box.width - dw) / 2;
    const offY = box.top - stageBox.top + (box.height - dh) / 2;
    const out = outputSize(video.videoWidth, video.videoHeight, !!vertical);
    const k = vertical === 'left' ? 0 : vertical === 'right' ? 1 : 0.5;
    const regionX = offX + (dw - out.w * scale) * k;
    const x = (out.w - textImage.width) / 2;
    const y = textPosition === 'top' ? out.h * 0.07 : textPosition === 'center' ? (out.h - textImage.height) / 2 : out.h - textImage.height - out.h * 0.08;
    textLayer.style.left = `${regionX + x * scale}px`;
    textLayer.style.top = `${offY + y * scale}px`;
    textLayer.style.width = `${textImage.width * scale}px`;
    textLayer.style.height = `${textImage.height * scale}px`;
  }
  /** Text znovu nakreslit (změna textu, stylu, velikosti nebo formátu - na výšku je užší). */
  async function refreshText() {
    await ensureFont();
    if (closed) return;
    const vw = video.videoWidth || clip.width || 0;
    const vh = video.videoHeight || clip.height || 0;
    const out = outputSize(vw, vh, !!vertical);
    textImage = overlayText.trim() && vw > 0 && vh > 0 ? drawTextImage(overlayText, textStyle, textSize, out.w, out.h) : null;
    clear(textLayer);
    if (textImage) textLayer.append(textImage);
    layoutText();
    refreshButtons();
  }
  function setTextPosition(position: TextPosition) {
    textPosition = position;
    for (const [key, btn] of Object.entries(positionBtns)) btn.classList.toggle('active', key === position);
    layoutText();
  }
  function setSpeed(value: number) {
    speed = value;
    speedBtns.forEach((btn, i) => btn.classList.toggle('active', SPEEDS[i] === value));
    applyRate();
    layout();
  }
  function markerList() {
    return (clip.markers ?? []).filter((m) => m && Number.isFinite(m.time) && m.time >= 0).sort((a, b) => a.time - b.time);
  }
  function renderMarkers() {
    const list = markerList();
    clear(markersRow);
    markersRow.classList.toggle('hidden', list.length === 0);
    if (list.length > 0) markersRow.append(h('span', { class: 'faint', title: t('playerMarkersHint') }, icon('flag', 13), ' ', t('playerMarkers')));
    for (const m of list) {
      const at = Math.max(0, m.time - MARKER_LEAD_SECONDS);
      markersRow.append(
        h(
          'button',
          {
            class: 'small quiet marker-chip',
            title: t('playerMarkersHint'),
            onclick: () => {
              if (broken) return;
              video.currentTime = at;
              void video.play().catch(() => undefined);
            },
          },
          h('b', {}, chapterTime(at)),
          ' ' + String(m.label ?? '')
        )
      );
    }
    layoutTicks();
    layoutSeekTicks();
  }
  function layoutTicks() {
    clear(ticks);
    if (duration <= 0) return;
    for (const m of markerList()) ticks.append(h('span', { class: 'tl-tick', style: `left:${pct(m.time)}`, title: String(m.label ?? '') }));
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
    // Na výšku je výsledek užší - text se musí zalomit znovu.
    if (overlayText.trim()) void refreshText();
    else layoutText();
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
  const onResize = () => {
    layoutCrop();
    layoutText();
  };
  window.addEventListener('resize', onResize);

  function layout() {
    range.style.left = pct(start);
    range.style.width = duration > 0 ? `${((end - start) / duration) * 100}%` : '0%';
    handleStart.style.left = pct(start);
    handleEnd.style.left = pct(end);
    startVal.textContent = formatTime(start);
    endVal.textContent = formatTime(end);
    // Po změně rychlosti má výsledek jinou délku než výběr.
    lenVal.textContent = speed !== 1 ? `${(end - start).toFixed(1)} s → ${((end - start) / speed).toFixed(1)} s` : `${(end - start).toFixed(1)} s`;
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
      syncAudioChoice(false);
      confirmReplace = false;
      gif = false;
      overlayText = '';
      textInput.value = '';
      textImage = null;
      clear(textLayer);
      setSpeed(1);
      setVertical(null);
    } else {
      speed = 1;
      applyRate();
      // "Bez zvuku" z úprav platí pro ukládaný klip - mimo úpravy ho nic neukazuje, tak náhled
      // zase hraje se zvukem. Klipy se stopami hra / mikrofon mají svá tlačítka ve videu - ta zůstávají.
      if (mute && !separateTracks()) {
        mute = false;
        muteBox.checked = false;
        applyPreviewAudio();
      }
      layoutText();
    }
    layout();
  }
  function nothingToDo(): boolean {
    return start <= 0.05 && end >= duration - 0.05 && !mute && audioChoice === 'mix' && !vertical && !gif && speed === 1 && !textImage;
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
    // GIF je bez rychlosti a textu (krátká smyčka) - volby se schovají.
    speedRow.classList.toggle('hidden', gif);
    textRow.classList.toggle('hidden', gif);
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
      // Text jako PNG (stejný obrázek jako v náhledu); ffmpeg ho jen položí na obraz.
      let text: TrimRequest['text'] = null;
      if (textImage) {
        const image = textImage;
        const blob = await new Promise<Blob | null>((resolve) => image.toBlob(resolve, 'image/png'));
        if (blob) text = { png: new Uint8Array(await blob.arrayBuffer()), position: textPosition };
      }
      const result = await edit.run(original, { start, end, mute, mode, vertical: vertical ?? undefined, audio: audioChoice, speed, text });
      clip = result;
      renderMarkers();
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
      // Opravdovou celou obrazovku zavře Escape sám prohlížeč; náhradní (okno) tady.
      if (document.fullscreenElement) return;
      e.stopPropagation();
      e.preventDefault();
      if (stage.classList.contains('pseudo-full')) exitFullscreen();
      else close();
      return;
    }
    const target = e.target as HTMLElement | null;
    // Psaní do polí (název, text přes video) má své klávesy; tlačítko mezerníkem/Enterem zmáčkne samo sebe.
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target && target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (broken) return;
    // Klávesy obsluhuje přehrávač vždycky sám - i když má fokus video (to by šipkami měnilo hlasitost).
    const hasNeighbors = (options.neighbors?.(clip.id)?.total ?? 0) > 1;
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      // Při prohlížení (i přes celou obrazovku) šipky přepínají klipy - jako šipky po stranách.
      // S Shiftem, v úpravách a u jediného klipu se posouvá čas.
      if (!editing && !e.shiftKey && hasNeighbors) go(dir);
      else video.currentTime = clamp(video.currentTime + (e.shiftKey ? 5 : 1) * dir, 0, duration || video.duration || 0);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      video.muted = !video.muted;
    } else if (e.key === '<' || e.key === '>') {
      e.preventDefault();
      stepRate(e.key === '<' ? -1 : 1);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
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
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if ((window as any).__kinePlayerStageFullscreen === stageFullscreenHook) delete (window as any).__kinePlayerStageFullscreen;
    if (idleTimer) clearTimeout(idleTimer);
    releaseVideo();
    if (document.fullscreenElement === stage || document.fullscreenElement === video) void document.exitFullscreen().catch(() => undefined);
    if (stage.classList.contains('pseudo-full')) {
      stage.classList.remove('pseudo-full');
      document.body.classList.remove('player-pseudo-full');
      options.setWindowFullscreen?.(false);
    }
    window.removeEventListener('resize', onResize);
    if (raf) cancelAnimationFrame(raf);
    if (guard) clearTimeout(guard);
    if (confirmTimer) clearTimeout(confirmTimer);
    if (noteTimer) clearTimeout(noteTimer);
    ambient?.stop();
    ambient = null;
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
      renderMarkers();
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
  renderMarkers();
  if (options.startEditing && edit) toggleEdit(true);
  layout();
  refreshNav();
  ambient = playerAmbient(video, stage, overlay);
  if (clip.thumb) followImage(fileUrl(clip.thumb));
  return handle;
}
