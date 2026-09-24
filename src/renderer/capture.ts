import type { KineCaptureBridge } from '../preload/preload';
import type { CaptureCommand, Settings } from '../shared/types';

/**
 * Skrytá snímací stránka.
 *
 * Vezme obraz obrazovky (a na Windows zvuk hry) přes Chromium a kóduje ho
 * MediaRecorderem do jednoho WebM proudu, po sekundě posílá kousky do
 * hlavního procesu (ten je rourou dává ffmpeg). Na povel "restart"
 * zastaví běžící recorder a hned rozjede nový na tom samém streamu -
 * obraz se nepřerušuje, jen proud dostane novou hlavičku.
 *
 * Zvuk: obraz a zvuk hry jdou do JEDNOHO recorderu tak, jak je Chromium
 * snímá (žádné míchání po cestě - to dřív zvuk zpožďovalo o desítky ms
 * proti obrazu). Mikrofon má VLASTNÍ recorder (jen zvuk) a vlastní proud
 * kousků; smíchá se až při stavbě klipu ve ffmpeg, kde jde nastavit
 * hlasitost, posun i druhá stopa jen s hlasem. Web Audio tu slouží jen
 * měřákům (hladiny do nastavení, hlídání ticha), do záznamu nic nedává.
 *
 * Kodek: H.264 první, protože ho grafiky kódují hardwarově a výsledek je
 * mp4, které přehraje všechno. Pak VP9 a VP8.
 */
declare const window: Window & { kineCapture: KineCaptureBridge };
const bridge = window.kineCapture;

/** Proud obrazu (+ zvuk hry) pro hlavní recorder. */
let stream: MediaStream | null = null;
/** Proud jen s mikrofonem pro druhý recorder (null = mikrofon není). */
let micStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let micRecorder: MediaRecorder | null = null;
let generation = 0;
let sendChain: Promise<void> = Promise.resolve();
let micSendChain: Promise<void> = Promise.resolve();
let mimeType = '';
let audioContext: AudioContext | null = null;
/** Měření hladin: analyzátory na stopě hry a mikrofonu. */
let meters: { system: AnalyserNode | null; mic: AnalyserNode | null; timer: ReturnType<typeof setInterval>; silentSince: number | null } | null = null;
/** Název výchozího výstupního zařízení Windows ve chvíli startu (loopback na něm visí). */
let defaultOutputAtStart = '';
let systemDeviceLabel = '';
/** Zpoždění mikrofonu podle Chromia (ms) - o tolik se při stavbě klipu mikrofon posune dopředu. */
let micLatencyMs = 0;
/** Je v počítači hardwarový kodér H.264? Zjišťuje se jednou (WebCodecs). */
let hwEncoder: boolean | null = null;
/** Snímky za sekundu, se kterými se opravdu nahrává (bez hardwarového kodéru 60 -> 30, ať hra neseká). */
let effectiveFps = 60;
/** Měřáky rychle (10x za sekundu, někdo se dívá do nastavení), jinak jednou za sekundu. */
let metersFast = false;
/** Mikrofon, který se nahrává (název), a jestli se appka vyhnula mikrofonu sluchátek Bluetooth. */
let micDeviceLabel = '';
let bluetoothMicAvoided = false;
/** Všechny stopy ze zdrojů (obrazovka, zvuk hry, mikrofon) - při konci se zastaví. */
const sourceTracks: MediaStreamTrack[] = [];

function report(event: Parameters<KineCaptureBridge['event']>[0]) {
  bridge.event(event);
}

/**
 * Formát proudu: H.264 High profile jako první (lepší obraz na stejný datový
 * tok - hardwarové kodéry ho umí), pak H.264 obecně, pak VP9 a VP8.
 */
function chooseMime(codec: Settings['codec'], hardware: boolean | null): string {
  // High profile jen s hardwarovým kodérem - softwarový (OpenH264) umí jen Baseline.
  const high = hardware === true ? ['video/webm;codecs=avc1.640028,opus', 'video/webm;codecs=avc1.64001f,opus'] : [];
  const candidates: Record<string, string[]> = {
    h264: [...high, 'video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus', 'video/webm;codecs=h264'],
    vp9: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9'],
    vp8: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'],
  };
  const order = codec === 'auto' ? [...candidates.h264, ...candidates.vp9, ...candidates.vp8] : candidates[codec] ?? candidates.h264;
  for (const m of order) if (MediaRecorder.isTypeSupported(m)) return m;
  return 'video/webm';
}

/** Je hardwarový kodér H.264 k dispozici? (WebCodecs se umí zeptat; MediaRecorder ho pak zpravidla použije.) */
async function detectHwEncoder(width: number, height: number, fps: number): Promise<boolean | null> {
  try {
    const VE = (window as unknown as { VideoEncoder?: { isConfigSupported: (c: unknown) => Promise<{ supported?: boolean }> } }).VideoEncoder;
    if (!VE) return null;
    const result = await VE.isConfigSupported({
      codec: 'avc1.640028',
      width: Math.max(16, width || 1920),
      height: Math.max(16, height || 1080),
      framerate: fps || 60,
      bitrate: 20_000_000,
      hardwareAcceleration: 'prefer-hardware',
    });
    return result.supported === true;
  } catch {
    return null;
  }
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

/**
 * Je to zařízení Bluetooth? Chromium dává do názvu "(Bluetooth)", ovladače
 * sluchátek v režimu hovoru "Hands-Free".
 */
function isBluetoothLabel(label: string): boolean {
  return /\(Bluetooth\)|hands-?free|\bLE Audio\b/i.test(label);
}

/** Záznamová zařízení, která ve skutečnosti nahrávají zvuk počítače (ne hlas) - jako mikrofon je nebrat. */
function isLoopbackInput(label: string): boolean {
  return /stereo ?mix|mix st[ée]r[ée]o|what u hear|cable output|voicemeeter out|wave ?out/i.test(label);
}

/**
 * Který mikrofon otevřít. Mikrofon sluchátek Bluetooth přepne sluchátka do
 * režimu hovoru: všechen zvuk je pak mono a špatný a zvuk hry se do
 * nahrávky často nedostane (Windows ho pošle jiným "zařízením"). Když je
 * takový mikrofon jen výchozí (hráč ho sám nevybral), appka vezme jiný
 * mikrofon (notebook, webkamera, headset na kabel), a když žádný není,
 * nahrává bez mikrofonu - a řekne proč. Zvolený mikrofon se bere vždycky.
 */
async function pickMicrophone(settings: Settings): Promise<{ deviceId: string | null; label: string; avoided: boolean }> {
  let inputs: MediaDeviceInfo[] = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    // Bez seznamu zařízení prostě výchozí.
  }
  if (settings.microphoneDevice) {
    const chosen = inputs.find((d) => d.deviceId === settings.microphoneDevice);
    return { deviceId: settings.microphoneDevice, label: chosen?.label ?? '', avoided: false };
  }
  const def = inputs.find((d) => d.deviceId === 'default') ?? inputs[0];
  const defaultLabel = (def?.label ?? '').replace(/^(Default|Výchozí|Standard)\s*-\s*/i, '').trim();
  if (!isBluetoothLabel(def?.label ?? '')) return { deviceId: '', label: defaultLabel, avoided: false };
  const alternative = inputs.find((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label && !isBluetoothLabel(d.label) && !isLoopbackInput(d.label));
  if (alternative) return { deviceId: alternative.deviceId, label: alternative.label, avoided: true };
  return { deviceId: null, label: '', avoided: true };
}

/** Zpoždění stopy podle Chromia v ms (MediaTrackSettings.latency), když ho zná. */
function trackLatencyMs(track: MediaStreamTrack | null): number {
  if (!track) return 0;
  const latency = (track.getSettings() as MediaTrackSettings & { latency?: number }).latency;
  return typeof latency === 'number' && Number.isFinite(latency) && latency > 0 && latency < 1 ? Math.round(latency * 1000) : 0;
}

/**
 * Připraví proudy: `stream` = obraz + zvuk hry (tak, jak ho Chromium dává,
 * bez úprav), `micStream` = jen mikrofon. Měřáky se navěsí na obě stopy.
 */
async function getStreams(settings: Settings): Promise<void> {
  // Zvuk hry z Windows (loopback výchozího výstupu), nebo ze zvoleného vstupního zařízení (Stereo Mix, VB-Cable…).
  const viaDevice = settings.systemAudio && !!settings.systemAudioDevice;
  const wantAudio = settings.systemAudio && bridge.platform === 'win32' && !viaDevice;
  // Hardwarový kodér se zjistí dřív, než se začne snímat: bez něj kóduje procesor
  // a 60 fps by hru brzdilo - pak se nahrává 30 fps (a v nastavení je to vidět).
  if (hwEncoder === null) hwEncoder = await detectHwEncoder(Math.round(((settings.maxHeight || 1080) * 16) / 9), settings.maxHeight || 1080, settings.fps);
  effectiveFps = hwEncoder === false && settings.fps > 30 ? 30 : settings.fps;
  const video: MediaTrackConstraints = {
    frameRate: { ideal: effectiveFps, max: effectiveFps },
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
    const mandatory: Record<string, unknown> = { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: effectiveFps };
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
  sourceTracks.push(...display.getTracks());
  // Hra = pohyb: kodér a snímání mají držet plynulost, ne ostrost statického textu.
  const videoTrack = display.getVideoTracks()[0];
  if (videoTrack) videoTrack.contentHint = 'motion';

  // Zvuk hry: z proudu obrazovky (loopback), nebo ze zvoleného zařízení (bez úprav - je to už hotový mix, ne řeč).
  let systemTrack: MediaStreamTrack | null = display.getAudioTracks()[0] ?? null;
  systemDeviceLabel = '';
  if (viaDevice) {
    try {
      const source = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: settings.systemAudioDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      systemTrack = source.getAudioTracks()[0] ?? null;
      sourceTracks.push(...source.getTracks());
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

  // Mikrofon (zvolený nebo výchozí, ne sluchátka Bluetooth) - bez něj se nahrává dál, hráč jen dostane upozornění.
  let micTrack: MediaStreamTrack | null = null;
  micDeviceLabel = '';
  bluetoothMicAvoided = false;
  if (settings.microphone) {
    const pick = await pickMicrophone(settings);
    bluetoothMicAvoided = pick.avoided;
    if (pick.avoided) report({ type: 'warning', generation, kind: 'bluetoothMic', message: pick.label });
    if (pick.deviceId !== null) {
      try {
        const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
        let mic: MediaStream;
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: pick.deviceId ? { ...base, deviceId: { exact: pick.deviceId } } : base });
        } catch (e) {
          // Zvolený mikrofon není - vezme se výchozí, ať klip nezůstane bez hlasu (ale ne sluchátka Bluetooth).
          if (!pick.deviceId || pick.avoided) throw e;
          mic = await navigator.mediaDevices.getUserMedia({ audio: base });
        }
        micTrack = mic.getAudioTracks()[0] ?? null;
        sourceTracks.push(...mic.getTracks());
        micDeviceLabel = pick.label || micTrack?.label || '';
      } catch (e) {
        report({ type: 'warning', generation, kind: 'microphone', message: String(e) });
      }
    }
  }
  micLatencyMs = trackLatencyMs(micTrack);

  stream = new MediaStream([...display.getVideoTracks(), ...(systemTrack ? [systemTrack] : [])]);
  micStream = micTrack ? new MediaStream([micTrack]) : null;

  startMeters(systemTrack, micTrack);
}

// ---- měřáky a hlídání ticha ----------------------------------------------------------------

/** RMS hladina 0-1 z analyzátoru (0 = digitální ticho). */
function level(node: AnalyserNode, buffer: Float32Array): number {
  node.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

/** Analyzátory jen na měření - do záznamu z Web Audia nic nejde. */
function startMeters(systemTrack: MediaStreamTrack | null, micTrack: MediaStreamTrack | null) {
  stopMeters();
  if (!systemTrack && !micTrack) return;
  let system: AnalyserNode | null = null;
  let mic: AnalyserNode | null = null;
  try {
    audioContext = new AudioContext();
    if (audioContext.state !== 'running') void audioContext.resume().catch(() => undefined);
    const analyser = (track: MediaStreamTrack): AnalyserNode => {
      const node = audioContext!.createAnalyser();
      node.fftSize = 1024;
      audioContext!.createMediaStreamSource(new MediaStream([track])).connect(node);
      return node;
    };
    system = systemTrack ? analyser(systemTrack) : null;
    mic = micTrack ? analyser(micTrack) : null;
  } catch {
    // Bez měřáků se nahrává dál.
    return;
  }
  const buffer = new Float32Array(1024);
  let peakSystem = 0;
  let peakMic = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    if (!meters) return;
    // Čte se 10x za sekundu. Když se někdo dívá na měřáky, hlásí se každé čtení (plynulé
    // proužky), jinak jednou za sekundu maximum - na hlídání ticha to stačí.
    if (system) peakSystem = Math.max(peakSystem, level(system, buffer));
    if (mic) peakMic = Math.max(peakMic, level(mic, buffer));
    ticks += 1;
    if (!metersFast && ticks < 10) return;
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
        micDevice: micDeviceLabel,
        bluetoothMicAvoided,
      },
    });
    peakSystem = 0;
    peakMic = 0;
  }, 100);
  meters = { system, mic, timer, silentSince: null };
}

function stopMeters() {
  if (meters) clearInterval(meters.timer);
  meters = null;
  void audioContext?.close().catch(() => undefined);
  audioContext = null;
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

// ---- recordery -------------------------------------------------------------------------------

function startRecorders(settings: Settings, gen: number) {
  if (!stream) throw new Error('není stream');
  mimeType = chooseMime(settings.codec, hwEncoder);
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

  // Mikrofon zvlášť: jen zvuk (Opus), stejná generace, vlastní proud kousků.
  let mic: MediaRecorder | null = null;
  if (micStream && micStream.getAudioTracks().length > 0) {
    const micMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    mic = new MediaRecorder(micStream, { mimeType: micMime, audioBitsPerSecond: 128_000 });
    mic.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const blob = e.data;
      micSendChain = micSendChain.then(async () => {
        const buffer = await blob.arrayBuffer();
        bridge.chunk(myGen, buffer, 'mic');
      });
    };
    mic.onerror = (e) => {
      // Mikrofon padl - obraz a zvuk hry jedou dál, klip bude bez hlasu.
      report({ type: 'warning', generation: myGen, kind: 'microphone', message: String((e as ErrorEvent).error ?? e) });
    };
  }

  // "stopped" až když dorazily poslední kousky OBOU proudů - jinak by hlavní proces zavřel roury dřív.
  const stoppedMain = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  const stoppedMic = mic ? new Promise<void>((resolve) => (mic!.onstop = () => resolve())) : Promise.resolve();
  void Promise.all([stoppedMain, stoppedMic])
    .then(() => Promise.all([sendChain, micSendChain]))
    .then(() => report({ type: 'stopped', generation: myGen, at: Date.now() }));

  // Oba naráz, ať mají společný začátek (rozdíl se při stavbě klipu dorovná z časů kousků).
  rec.start(1000);
  mic?.start(1000);
  recorder = rec;
  micRecorder = mic;
  generation = myGen;
  report({
    type: 'started',
    generation: myGen,
    at: Date.now(),
    mimeType: rec.mimeType || mimeType,
    audio: stream.getAudioTracks().length > 0,
    mic: !!mic,
    micLatencyMs,
    hwEncoder,
    fps: effectiveFps,
  });
}

function stopRecorders() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (micRecorder && micRecorder.state !== 'inactive') micRecorder.stop();
  recorder = null;
  micRecorder = null;
}

function stopAll() {
  stopRecorders();
  stopMeters();
  for (const track of stream?.getTracks() ?? []) track.stop();
  for (const track of micStream?.getTracks() ?? []) track.stop();
  for (const track of sourceTracks) track.stop();
  sourceTracks.length = 0;
  stream = null;
  micStream = null;
  defaultOutputAtStart = '';
}

let currentSettings: Settings | null = null;

bridge.onCommand(async (command: CaptureCommand) => {
  try {
    if (command.type === 'start') {
      stopAll();
      currentSettings = command.settings;
      await getStreams(command.settings);
      stream!.getVideoTracks()[0]?.addEventListener('ended', () => {
        report({ type: 'error', generation, message: 'obrazovka přestala posílat obraz' });
      });
      startRecorders(command.settings, command.generation);
    } else if (command.type === 'restart') {
      if (!stream || !currentSettings) throw new Error('snímání neběží');
      stopRecorders();
      startRecorders(currentSettings, command.generation);
    } else if (command.type === 'stop') {
      stopAll();
    } else if (command.type === 'meters') {
      metersFast = command.fast;
    }
  } catch (e) {
    report({ type: 'error', generation: 'generation' in command ? command.generation : generation, message: (e as Error).message ?? String(e) });
  }
});
