import type { LiveScene } from '../shared/types';
import { cameraRect } from '../shared/liveLayout';

/**
 * Obraz živého vysílání s kamerou a obrazovkou "Hned jsem zpět".
 *
 * Snímky obrazovky chodí z kopie stopy (MediaStreamTrackProcessor) a jdou
 * do nové stopy (MediaStreamTrackGenerator), kterou kóduje recorder
 * vysílání. Dokud není co přidat (kamera vypnutá, žádné "Hned jsem zpět"),
 * snímek se jen přepošle - nic se nekreslí, nic to nestojí. S kamerou se
 * obrazovka a kamera skládají na plátno (grafikou) a ven jde nový snímek;
 * "Hned jsem zpět" místo hry ukáže tmavou obrazovku s textem (soukromí:
 * heslo, zprávy, pauza). Rytmus dává obrazovka - vysílání nikdy nestojí.
 *
 * Plátno má rozměry snímku obrazovky, takže přepnutí kamery nemění
 * rozlišení proudu (RTMP by to nemusel přežít).
 */

/* Chromium API (insertable streams) - v typech TypeScriptu není. */
type TrackProcessor = { readable: ReadableStream<VideoFrame> };
type TrackGenerator = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type ProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => TrackProcessor;
type GeneratorCtor = new (init: { kind: 'video' }) => TrackGenerator;

const W = window as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };

export class LiveCompositor {
  /** Stopa pro recorder vysílání. */
  readonly track: MediaStreamTrack;
  private scene: LiveScene;
  private running = true;
  private reader: ReadableStreamDefaultReader<VideoFrame>;
  private writer: WritableStreamDefaultWriter<VideoFrame>;
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  /** "Hned jsem zpět" je na plátně nakreslené (stejný text a rozměry) - stačí ho posílat dál. */
  private brbDrawn = '';
  private camStream: MediaStream | null = null;
  private camReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private camFrame: VideoFrame | null = null;
  /** Kamera, která je otevřená / otevírá se ('' = výchozí); null = žádná. */
  private camDevice: string | null = null;
  /** Pořadí žádostí o kameru: platí jen ta poslední (rychlé přepínání A -> vyp -> A). */
  private camRequest = 0;

  static supported(): boolean {
    return typeof W.MediaStreamTrackProcessor === 'function' && typeof W.MediaStreamTrackGenerator === 'function' && typeof OffscreenCanvas === 'function';
  }

  constructor(
    source: MediaStreamTrack,
    scene: LiveScene,
    private deps: { brand: string; onWarning: (message: string) => void }
  ) {
    this.scene = scene;
    const processor = new W.MediaStreamTrackProcessor!({ track: source, maxBufferSize: 2 });
    const generator = new W.MediaStreamTrackGenerator!({ kind: 'video' });
    this.reader = processor.readable.getReader();
    this.writer = generator.writable.getWriter();
    this.track = generator;
    this.applyCamera();
    void this.loop();
  }

  /** Za běhu: kamera jinam / jiná / vypnout, "Hned jsem zpět", text. */
  setScene(scene: LiveScene): void {
    this.scene = scene;
    this.brbDrawn = '';
    this.applyCamera();
  }

  stop(): void {
    this.running = false;
    void this.reader.cancel().catch(() => undefined);
    void this.writer.close().catch(() => undefined);
    this.closeCamera();
    this.camFrame?.close();
    this.camFrame = null;
  }

  // ---- snímky -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    while (this.running) {
      let frame: VideoFrame | undefined;
      try {
        const result = await this.reader.read();
        if (result.done) break;
        frame = result.value;
      } catch {
        break;
      }
      if (!frame) continue;
      try {
        const composed = this.needsCompose() ? this.compose(frame) : null;
        if (composed) {
          frame.close();
          // Generátor si snímek převezme (a sám zavře).
          await this.writer.write(composed);
        } else {
          await this.writer.write(frame);
        }
      } catch {
        try {
          frame.close();
        } catch {
          // už zavřený
        }
        if (!this.running) break;
      }
    }
    this.track.stop();
  }

  private needsCompose(): boolean {
    return this.scene.brb || (!!this.scene.camera && !!this.camFrame);
  }

  private compose(frame: VideoFrame): VideoFrame | null {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (!width || !height) return null;
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D | null;
      this.brbDrawn = '';
    }
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this.scene.brb) {
      const key = `${width}x${height}:${this.scene.brbText}`;
      if (this.brbDrawn !== key) {
        this.drawBrb(ctx, width, height);
        this.brbDrawn = key;
      }
    } else {
      this.brbDrawn = '';
      ctx.drawImage(frame, 0, 0, width, height);
      if (this.scene.camera && this.camFrame) this.drawCamera(ctx, width, height, this.camFrame);
    }
    return new VideoFrame(this.canvas, { timestamp: frame.timestamp });
  }

  private drawCamera(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, cam: VideoFrame): void {
    const c = this.scene.camera!;
    const r = cameraRect(width, height, cam.displayWidth, cam.displayHeight, c);
    ctx.save();
    ctx.beginPath();
    if (r.radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, r.radius);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    if (c.mirror) {
      // Zrcadlo: jak se hráč vidí sám (text za ním je pak pozpátku - proto jde vypnout).
      ctx.translate(r.x + r.w, r.y);
      ctx.scale(-1, 1);
      ctx.drawImage(cam, r.sx, r.sy, r.sw, r.sh, 0, 0, r.w, r.h);
    } else {
      ctx.drawImage(cam, r.sx, r.sy, r.sw, r.sh, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
    // Tenký okraj - kamera se neztratí ve světlé hře.
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(width / 480));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    if (r.radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, r.radius);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.stroke();
    ctx.restore();
  }

  private drawBrb(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): void {
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#08080b');
    bg.addColorStop(1, '#16161d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    const text = this.scene.brbText || 'BRB';
    const size = Math.max(18, Math.round(height * 0.075));
    ctx.fillStyle = '#f2f2f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${size}px "Segoe UI", "Inter", system-ui, sans-serif`;
    ctx.fillText(text, width / 2, height * 0.47, width * 0.9);
    // Proužek v barvě Kine hráče pod textem.
    ctx.fillStyle = this.deps.brand || '#00c9a7';
    const barW = Math.round(width * 0.08);
    ctx.fillRect(Math.round(width / 2 - barW / 2), Math.round(height * 0.47 + size * 0.85), barW, Math.max(3, Math.round(height * 0.006)));
  }

  // ---- kamera -------------------------------------------------------------------------

  private applyCamera(): void {
    const wanted = this.scene.camera ? this.scene.camera.deviceId : null;
    if (wanted === this.camDevice) return;
    this.closeCamera();
    if (wanted === null) return;
    this.camDevice = wanted;
    void this.openCamera(wanted, ++this.camRequest);
  }

  private async openCamera(deviceId: string, request: number): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      });
    } catch (e) {
      if (this.camRequest === request) {
        this.camDevice = null;
        this.deps.onWarning(cameraErrorText(e));
      }
      return;
    }
    // Mezitím se kamera vypnula / změnila (i tam a zpátky), nebo vysílání skončilo.
    if (!this.running || this.camRequest !== request || this.camDevice !== deviceId) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    // Pojistka: předchozí proud kamery se nikdy jen nepřepíše - pak by svítila dál.
    for (const t of this.camStream?.getTracks() ?? []) t.stop();
    this.camStream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.addEventListener('ended', () => {
      if (this.camStream === stream) this.deps.onWarning('camera disconnected');
    });
    const reader = new W.MediaStreamTrackProcessor!({ track, maxBufferSize: 1 }).readable.getReader();
    this.camReader = reader;
    while (this.running && this.camReader === reader) {
      let frame: VideoFrame | undefined;
      try {
        const result = await reader.read();
        if (result.done) break;
        frame = result.value;
      } catch {
        break;
      }
      if (!frame) continue;
      if (this.camReader !== reader) {
        frame.close();
        break;
      }
      // Drží se jen poslední snímek kamery; obrazovka si ho vezme, až přijde její.
      this.camFrame?.close();
      this.camFrame = frame;
    }
  }

  private closeCamera(): void {
    this.camRequest += 1; // rozběhnutá žádost o kameru už neplatí
    const reader = this.camReader;
    this.camReader = null;
    void reader?.cancel().catch(() => undefined);
    for (const t of this.camStream?.getTracks() ?? []) t.stop();
    this.camStream = null;
    this.camDevice = null;
    this.camFrame?.close();
    this.camFrame = null;
  }
}

/** Proč kamera nejde - srozumitelně (obsazená jiným programem je nejčastější). */
export function cameraErrorText(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'camera-busy';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'camera-missing';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'camera-denied';
  return `camera: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
}
