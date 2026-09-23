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
/** Měření hladin: analyzátory na stopě hry a mikrofonu (před smícháním). */
let meters: { system: AnalyserNode | null; mic: AnalyserNode | null; timer: ReturnType<typeof setInterval>; silentSince: number | null } | null = null;
/** Název výchozího výstupního zařízení Windows ve chvíli startu (loopback na něm visí). */
let defaultOutputAtStart = '';
let systemDeviceLabel = '';

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

/**
 * Název výchozího výstupního zařízení Windows ("Sluchátka (Realtek Audio)").
 * Chromium ho dává jako položku "default" s popiskem "Default - …"; bez
 * oprávnění k médiím jsou popisky prázdné - pak se vrátí prázdný řetězec.
 */
async function defaultOutputLabel(): Promise<string> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const def = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
    const label = (def?.label ?? '').replace(/^(Default|Výchozí|Standard)\s*-\s*/i, '').trim();
    if (label) return label;
    // Bez popisků aspoň podle skupiny: výchozí výstup má stejné groupId jako některý pojmenovaný.
    const named = devices.find((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label);
    return named?.label ?? '';
  } catch {
    return '';
  }
}

/** Popisek zařízení podle id (pro zvolený vstup místo loopbacku). */
async function deviceLabel(id: string): Promise<string> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.find((d) => d.deviceId === id)?.label ?? '';
  } catch {
    return '';
  }
}

async function getStream(settings: Settings): Promise<MediaStream> {
  // Zvuk hry z Windows (loopback výchozího výstupu), nebo ze zvoleného vstupního zařízení (Stereo Mix, VB-Cable…).
  const viaDevice = settings.systemAudio && !!settings.systemAudioDevice;
  const wantAudio = settings.systemAudio && bridge.platform === 'win32' && !viaDevice;
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

  acquired.length = 0;
  acquired.push(...display.getTracks());
  // Zvuk hry ze zvoleného vstupního zařízení (bez úprav - je to už hotový mix, ne řeč).
  let systemTrack: MediaStreamTrack | null = display.getAudioTracks()[0] ?? null;
  systemDeviceLabel = '';
  if (viaDevice) {
    try {
      const source = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: settings.systemAudioDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      systemTrack = source.getAudioTracks()[0] ?? null;
      acquired.push(...source.getTracks());
      systemDeviceLabel = (await deviceLabel(settings.systemAudioDevice)) || settings.systemAudioDevice;
    } catch (e) {
      // Zařízení není (odpojené, přejmenované) - klip bude bez zvuku hry, hráč dostane upozornění.
      report({ type: 'warning', generation, kind: 'systemAudio', message: String(e) });
      systemTrack = null;
    }
  } else if (systemTrack) {
    defaultOutputAtStart = await defaultOutputLabel();
    systemDeviceLabel = defaultOutputAtStart;
  }

  // Mikrofon (zvolený nebo výchozí) - bez něj se nahrává dál, hráč jen dostane upozornění.
  let micTrack: MediaStreamTrack | null = null;
  if (settings.microphone) {
    try {
      const constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
      if (settings.microphoneDevice) constraints.deviceId = { exact: settings.microphoneDevice };
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      } catch (e) {
        // Zvolený mikrofon není - vezme se výchozí, ať klip nezůstane bez hlasu.
        if (!settings.microphoneDevice) throw e;
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      }
      micTrack = mic.getAudioTracks()[0] ?? null;
      acquired.push(...mic.getTracks());
    } catch (e) {
      report({ type: 'warning', generation, kind: 'microphone', message: String(e) });
    }
  }

  // Jedna stopa zvuku pro MediaRecorder: hra a mikrofon smíchané, každý se svou hlasitostí; měřáky před smícháním.
  if (!systemTrack && !micTrack) {
    stopMeters();
    return new MediaStream(display.getVideoTracks());
  }
  const systemGain = clampGain(settings.systemGain);
  const micGain = clampGain(settings.micGain);
  // Jedna stopa beze změny hlasitosti jde do záznamu rovnou (bez Web Audio) -
  // nejméně věcí, co se může pokazit; Web Audio pak jen měří hladinu.
  const direct = systemTrack && !micTrack && systemGain === 1 ? systemTrack : !systemTrack && micTrack && micGain === 1 ? micTrack : null;
  let recorded: MediaStreamTrack[] = direct ? [direct] : [];
  try {
    audioContext = new AudioContext();
    if (audioContext.state !== 'running') await audioContext.resume().catch(() => undefined);
    const destination = audioContext.createMediaStreamDestination();
    const analyser = (track: MediaStreamTrack, gainValue: number): AnalyserNode => {
      const source = audioContext!.createMediaStreamSource(new MediaStream([track]));
      const node = audioContext!.createAnalyser();
      node.fftSize = 1024;
      source.connect(node);
      if (!direct) {
        const gain = audioContext!.createGain();
        gain.gain.value = gainValue;
        source.connect(gain);
        gain.connect(destination);
      }
      return node;
    };
    const systemMeter = systemTrack ? analyser(systemTrack, systemGain) : null;
    const micMeter = micTrack ? analyser(micTrack, micGain) : null;
    startMeters(systemMeter, micMeter);
    if (!direct) recorded = destination.stream.getAudioTracks();
  } catch (e) {
    // Web Audio nejde (nemělo by se stát): bez měřáků a bez míchání, do klipu jde zvuk hry, jinak mikrofon.
    report({ type: 'warning', generation, kind: 'systemAudio', message: `Web Audio: ${String(e)}` });
    stopMeters();
    recorded = [systemTrack ?? micTrack!];
  }
  return new MediaStream([...display.getVideoTracks(), ...recorded]);
}

function clampGain(value: number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n * 100) / 100)) : 1;
}

// ---- měřáky a hlídání ticha ----------------------------------------------------------------

/** RMS hladina 0-1 z analyzátoru (0 = digitální ticho). */
function level(node: AnalyserNode, buffer: Float32Array): number {
  node.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function startMeters(system: AnalyserNode | null, mic: AnalyserNode | null) {
  stopMeters();
  const buffer = new Float32Array(1024);
  let peakSystem = 0;
  let peakMic = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    if (!meters) return;
    // Čte se 5x za sekundu, hlásí se jednou za sekundu maximum - ať krátký výstřel nezapadne.
    if (system) peakSystem = Math.max(peakSystem, level(system, buffer));
    if (mic) peakMic = Math.max(peakMic, level(mic, buffer));
    ticks += 1;
    if (ticks < 5) return;
    ticks = 0;
    const now = Date.now();
    if (system) {
      if (peakSystem < 1e-5) meters.silentSince ??= now;
      else meters.silentSince = null;
    }
    report({
      type: 'levels',
      generation,
      levels: {
        system: system ? Math.min(1, peakSystem) : null,
        mic: mic ? Math.min(1, peakMic) : null,
        systemDevice: systemDeviceLabel,
        systemSilentSeconds: system && meters.silentSince ? Math.round((now - meters.silentSince) / 1000) : 0,
      },
    });
    peakSystem = 0;
    peakMic = 0;
  }, 200);
  meters = { system, mic, timer, silentSince: null };
}

function stopMeters() {
  if (meters) clearInterval(meters.timer);
  meters = null;
}

// Výchozí výstup Windows se změnil (sluchátka, jiný monitor): loopback zůstal
// na starém zařízení a nahrával by ticho - hlavní proces snímání rozjede znovu.
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (!stream || !defaultOutputAtStart || !currentSettings?.systemAudio || currentSettings.systemAudioDevice) return;
  void defaultOutputLabel().then((label) => {
    if (label && label !== defaultOutputAtStart) {
      report({ type: 'defaultOutputChanged', generation, device: label });
    }
  });
});

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

/** Původní stopy (obraz, hra, mikrofon) - ať se při konci zastaví i ty, co nejsou ve výsledném streamu. */
const sourceTracks: MediaStreamTrack[] = [];
/** Stopy získané při posledním getStream (plní getStream, bere collectSourceTracks). */
const acquired: MediaStreamTrack[] = [];
function collectSourceTracks(): MediaStreamTrack[] {
  const list = [...acquired];
  acquired.length = 0;
  return list;
}

function stopAll() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
  stopMeters();
  for (const track of stream?.getTracks() ?? []) track.stop();
  for (const track of sourceTracks) track.stop();
  sourceTracks.length = 0;
  stream = null;
  defaultOutputAtStart = '';
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
      // Stopy zdrojů (obrazovka, mikrofon) drží jen AudioContext - při konci se musí zastavit ručně.
      sourceTracks.push(...collectSourceTracks());
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
