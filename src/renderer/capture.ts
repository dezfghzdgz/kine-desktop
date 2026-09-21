import type { KineCaptureBridge } from '../preload/preload';
import type { CaptureCommand, Settings } from '../shared/types';

/**
 * Skrytá snímací stránka.
 *
 * Vezme obraz obrazovky (a na Windows zvuk systému) přes Chromium a
 * kóduje ho MediaRecorderem do jednoho WebM proudu, po sekundě posílá
 * kousky do hlavního procesu (ten je rourou dává ffmpeg). Na povel
 * "restart" zastaví běžící recorder a hned rozjede nový na tom samém
 * streamu - obraz se nepřerušuje, jen proud dostane novou hlavičku.
 *
 * Kodek: H.264 první, protože ho grafiky kódují hardwarově a výsledek je
 * mp4, které přehraje všechno. Pak VP9 a VP8.
 */
declare const window: Window & { kineCapture: KineCaptureBridge };
const bridge = window.kineCapture;

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let generation = 0;
let sendChain: Promise<void> = Promise.resolve();
let mimeType = '';
let audioContext: AudioContext | null = null;

function report(event: Parameters<KineCaptureBridge['event']>[0]) {
  bridge.event(event);
}

function chooseMime(codec: Settings['codec']): string {
  const candidates: Record<string, string[]> = {
    h264: ['video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus', 'video/webm;codecs=h264'],
    vp9: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9'],
    vp8: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'],
  };
  const order = codec === 'auto' ? [...candidates.h264, ...candidates.vp9, ...candidates.vp8] : candidates[codec] ?? candidates.h264;
  for (const m of order) if (MediaRecorder.isTypeSupported(m)) return m;
  return 'video/webm';
}

async function getStream(settings: Settings): Promise<MediaStream> {
  const wantAudio = settings.systemAudio && bridge.platform === 'win32';
  const video: MediaTrackConstraints = {
    frameRate: { ideal: settings.fps, max: settings.fps },
  };
  if (settings.maxHeight > 0) {
    video.height = { max: settings.maxHeight };
    video.width = { max: Math.round((settings.maxHeight * 16) / 9) };
  }

  let display: MediaStream | null = null;
  let lastError: unknown = null;
  // 1) moderní cesta: getDisplayMedia (obrazovku vybírá hlavní proces)
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video, audio: wantAudio });
  } catch (e) {
    lastError = e;
  }
  // 2) starší cesta: getUserMedia s chromeMediaSource (nepotřebuje gesto)
  if (!display) {
    const sources = await bridge.sources();
    const settingsNow = await bridge.getSettings();
    const source = sources.find((s) => s.display_id === settingsNow.displayId && settingsNow.displayId) ?? sources[0];
    if (!source) throw new Error(`žádná obrazovka (${String(lastError)})`);
    const mandatory: Record<string, unknown> = { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: settings.fps };
    if (settings.maxHeight > 0) {
      mandatory.maxHeight = settings.maxHeight;
      mandatory.maxWidth = Math.round((settings.maxHeight * 16) / 9);
    }
    const legacy = async (audio: boolean) =>
      navigator.mediaDevices.getUserMedia({
        audio: audio ? ({ mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints) : false,
        video: { mandatory } as unknown as MediaTrackConstraints,
      });
    try {
      display = await legacy(wantAudio);
    } catch (e) {
      if (!wantAudio) throw new Error(`${String(lastError)} / ${String(e)}`);
      display = await legacy(false);
    }
  }

  if (!settings.microphone) return display;

  // Mikrofon se smíchá se zvukem systému do jedné stopy.
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    if (display.getAudioTracks().length > 0) {
      audioContext.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(destination);
    }
    audioContext.createMediaStreamSource(mic).connect(destination);
    const mixed = new MediaStream([...display.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    return mixed;
  } catch (e) {
    // Bez mikrofonu se nahrává dál - hráč jen dostane upozornění, ne "chybu".
    report({ type: 'warning', generation, kind: 'microphone', message: String(e) });
    return display;
  }
}

function startRecorder(settings: Settings, gen: number) {
  if (!stream) throw new Error('není stream');
  mimeType = chooseMime(settings.codec);
  const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
    mimeType,
    videoBitsPerSecond: Math.round(settings.videoMbps * 1_000_000),
    audioBitsPerSecond: 160_000,
    // Klíčový snímek každé 2 s = segmenty po 2 s = klip nejvýš o 2 s delší.
    videoKeyFrameIntervalDuration: 2000,
  };
  const rec = new MediaRecorder(stream, options);
  const myGen = gen;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const blob = e.data;
    sendChain = sendChain.then(async () => {
      const buffer = await blob.arrayBuffer();
      bridge.chunk(myGen, buffer);
    });
  };
  rec.onerror = (e) => {
    report({ type: 'error', generation: myGen, message: String((e as ErrorEvent).error ?? e) });
  };
  rec.onstop = () => {
    // Poslední kousek se posílá až po předchozích - "stopped" musí přijít
    // až za ním, jinak by hlavní proces uzavřel rouru dřív.
    void sendChain.then(() => report({ type: 'stopped', generation: myGen, at: Date.now() }));
  };
  rec.start(1000);
  recorder = rec;
  generation = myGen;
  report({ type: 'started', generation: myGen, at: Date.now(), mimeType: rec.mimeType || mimeType, audio: stream.getAudioTracks().length > 0 });
}

function stopAll() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  void audioContext?.close();
  audioContext = null;
}

let currentSettings: Settings | null = null;

bridge.onCommand(async (command: CaptureCommand) => {
  try {
    if (command.type === 'start') {
      stopAll();
      currentSettings = command.settings;
      stream = await getStream(command.settings);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        report({ type: 'error', generation, message: 'obrazovka přestala posílat obraz' });
      });
      startRecorder(command.settings, command.generation);
    } else if (command.type === 'restart') {
      if (!stream || !currentSettings) throw new Error('snímání neběží');
      const old = recorder;
      if (old && old.state !== 'inactive') old.stop();
      startRecorder(currentSettings, command.generation);
    } else if (command.type === 'stop') {
      stopAll();
    }
  } catch (e) {
    report({ type: 'error', generation: command.type === 'stop' ? generation : command.generation, message: (e as Error).message ?? String(e) });
  }
});
