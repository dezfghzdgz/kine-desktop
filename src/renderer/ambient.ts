/**
 * Barvy podle obrazu (Nastavení -> Vzhled -> "Barvy podle obrazu").
 *
 * Pozadí skla bere barvy z klipu, na který se zrovna díváš (karta pod
 * myší, otevřený klip), a kolem přehrávače svítí barvy videa - jako
 * ambientní režim na YouTube.
 *
 * Levně, ať appka nebrzdí hru, která běží vedle: obraz se nakreslí do
 * malinkého plátna (desítky pixelů) už rozmazaný a prohlížeč ho jen
 * roztáhne. Žádný CSS filtr přes celé okno a žádné čtení pixelů zpátky
 * (soubory z disku by plátno "zamkly" - kreslit do něj ale jde).
 */

/** Plátno pozadí: 16:9, roztažené přes celé okno (object-fit: cover). */
const BACK_W = 64;
const BACK_H = 36;
/** Plátno světla kolem přehrávače: scéna je uprostřed (32x18), okraj na záři. */
const AMB_W = 48;
const AMB_H = 30;
const AMB_X = 8;
const AMB_Y = 6;
const AMB_IW = 32;
const AMB_IH = 18;

let host: HTMLElement | null = null;
let shownUrl: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let requestSeq = 0;

/** Vrstva pozadí skla (.app-backdrop), do které se kreslí. */
export function attachBackdrop(el: HTMLElement): void {
  host = el;
}

/** Je "barvy podle obrazu" zapnuté? Atribut na <html> nastavuje settings.ts (applyLook). */
export function followOn(): boolean {
  return document.documentElement.getAttribute('data-follow') === '1';
}

function backdropVisible(): boolean {
  return followOn() && document.documentElement.getAttribute('data-look') === 'glass';
}

/** Ukazuje už pozadí nějaký obrázek? */
export function hasFollowImage(): boolean {
  return shownUrl !== null;
}

/**
 * Pozadí podle obrázku (náhled klipu). delayMs: při přejíždění myší přes
 * karty se pozadí změní, až se myš zastaví - ne u každé karty po cestě.
 */
export function followImage(url: string | null, delayMs = 0): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!url || url === shownUrl || !backdropVisible()) return;
  if (delayMs > 0) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void showImage(url);
    }, delayMs);
    return;
  }
  void showImage(url);
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function showImage(url: string): Promise<void> {
  if (!host) return;
  const seq = ++requestSeq;
  const img = await loadImage(url);
  // Mezitím přišel jiný obrázek (rychlé přejíždění) nebo se vzhled vypnul.
  if (!img || seq !== requestSeq || !host || !backdropVisible()) return;
  const canvas = document.createElement('canvas');
  canvas.width = BACK_W;
  canvas.height = BACK_H;
  canvas.className = 'app-backdrop-image';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Jako "cover" a o kousek větší, ať rozmazání nemá u krajů průhledný lem.
  const scale = Math.max(BACK_W / img.naturalWidth, BACK_H / img.naturalHeight) * 1.12;
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.filter = 'blur(2.5px) saturate(1.45)';
  ctx.drawImage(img, (BACK_W - dw) / 2, (BACK_H - dh) / 2, dw, dh);
  shownUrl = url;
  host.dataset.src = url;
  const old = [...host.querySelectorAll('.app-backdrop-image')];
  host.append(canvas);
  // Plynulý přechod: nový obrázek nabíhá, starý mizí (CSS transition na opacity).
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      canvas.classList.add('in');
      for (const el of old) el.classList.remove('in');
    })
  );
  setTimeout(() => {
    for (const el of old) el.remove();
  }, 1100);
}

export type PlayerAmbient = { stop: () => void; draw: () => void };

/**
 * Světlo kolem přehrávače: malé plátno za scénou (ve vrstvě přehrávače),
 * kreslí se z videa desetkrát za sekundu, jen když video hraje a okno je
 * vidět. Barvy se přelévají plynule: každý snímek se do zásobního plátna
 * přimíchá jen zčásti (exponenciální průměr), takže záře teče s obrazem,
 * neskáče. Přes celou obrazovku se nekreslí (není ho vidět).
 */
const AMB_INTERVAL_MS = 100;
/** Časová konstanta přelévání: za ~0,9 s je nová barva skoro celá. */
const AMB_TAU_MS = 300;
export function playerAmbient(video: HTMLVideoElement, stage: HTMLElement, layer: HTMLElement): PlayerAmbient | null {
  if (!followOn()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = AMB_W;
  canvas.height = AMB_H;
  canvas.className = 'player-ambient';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // Zásobní plátno s průměrem posledních snímků (rozmazané, bez okrajové masky).
  const acc = document.createElement('canvas');
  acc.width = AMB_W;
  acc.height = AMB_H;
  const actx = acc.getContext('2d');
  if (!actx) return null;
  layer.prepend(canvas);
  let frames = 0;
  let stopped = false;
  let lastDraw = 0;

  const place = (): DOMRect | null => {
    const r = stage.getBoundingClientRect();
    const p = layer.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    // Scéna odpovídá středu plátna (32x18 z 48x30) - plátno je o půlku širší a o 2/3 vyšší.
    canvas.style.left = `${r.left - p.left - (r.width * AMB_X) / AMB_IW}px`;
    canvas.style.top = `${r.top - p.top - (r.height * AMB_Y) / AMB_IH}px`;
    canvas.style.width = `${(r.width * AMB_W) / AMB_IW}px`;
    canvas.style.height = `${(r.height * AMB_H) / AMB_IH}px`;
    return r;
  };

  const draw = () => {
    if (stopped) return;
    // Rozbitý klip (ve scéně je chyba místo videa) - žádná záře po minulém klipu.
    if (!stage.contains(video)) {
      canvas.classList.remove('in');
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    if (document.fullscreenElement) return;
    const r = place();
    if (!r) return;
    // Video je ve scéně "contain" (u klipu na výšku pruhy po stranách) - stejně i tady.
    const aspect = video.videoWidth / video.videoHeight;
    let fw = r.width;
    let fh = r.width / aspect;
    if (fh > r.height) {
      fh = r.height;
      fw = r.height * aspect;
    }
    const sx = AMB_IW / r.width;
    const sy = AMB_IH / r.height;
    // Nový snímek do průměru: první celý, další jen zčásti (podle času od minulého) - barvy tečou.
    const now = performance.now();
    const alpha = frames === 0 || !lastDraw ? 1 : 1 - Math.exp(-Math.min(1000, now - lastDraw) / AMB_TAU_MS);
    lastDraw = now;
    actx.globalAlpha = alpha;
    actx.filter = 'blur(3px) saturate(1.6) brightness(1.15)';
    try {
      actx.drawImage(video, AMB_X + ((r.width - fw) / 2) * sx, AMB_Y + ((r.height - fh) / 2) * sy, fw * sx, fh * sy);
    } catch {
      return;
    }
    actx.globalAlpha = 1;
    actx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, AMB_W, AMB_H);
    ctx.drawImage(acc, 0, 0);
    // Záře do ztracena: elipsa podle tvaru plátna.
    ctx.filter = 'none';
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.translate(AMB_W / 2, AMB_H / 2);
    ctx.scale(1, AMB_H / AMB_W);
    const fade = ctx.createRadialGradient(0, 0, AMB_W * 0.3, 0, 0, AMB_W * 0.5);
    fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = fade;
    ctx.fillRect(-AMB_W / 2, -AMB_W / 2, AMB_W, AMB_W);
    ctx.restore();
    frames++;
    canvas.dataset.frames = String(frames);
    canvas.classList.add('in');
  };

  const timer = setInterval(() => {
    if (!video.paused && !document.hidden) draw();
  }, AMB_INTERVAL_MS);
  const onReady = () => draw();
  video.addEventListener('loadeddata', onReady);
  video.addEventListener('seeked', onReady);
  video.addEventListener('pause', onReady);
  window.addEventListener('resize', onReady);
  // Video už mohlo být načtené (přepnutí na další klip).
  draw();

  return {
    draw,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('seeked', onReady);
      video.removeEventListener('pause', onReady);
      window.removeEventListener('resize', onReady);
      canvas.remove();
    },
  };
}
