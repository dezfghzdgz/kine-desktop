import type { KineCaptureBridge } from '../preload/preload';
import type { CaptureCommand, LiveAudio, LivePreset, LiveScene, Settings } from '../shared/types';
import { LiveCompositor } from './liveCompositor';

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
 *
 * Živé vysílání (tlačítko Vysílat): třetí recorder na stejném snímání -
 * kopie obrazové stopy zmenšená na kvalitu vysílání, zvuk hry a mikrofon
 * smíchané přes Web Audio (s hlasitostmi z nastavení), vždy H.264 kvůli
 * RTMP. Klipy mezi tím běží dál; restart zásobníku při klipu vysílání
 * nepřeruší (má vlastní stopy).
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
/** Proč se zvuk hry nepodařilo otevřít (krátce, pro nastavení a diagnostiku); prázdné = jde. */
let systemAudioError = '';
/** Zvuk hry se bere náhradně ze vstupu "Stereo Mix" a spol. (název), protože loopback výstupu nešel. */
let systemAudioFallback = '';
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

/** Krátký důvod chyby pro hráče a diagnostiku ("NotReadableError: Could not start audio source"). */
function errorText(e: unknown): string {
  if (!e) return '';
  const err = e as { name?: string; message?: string };
  const text = `${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message ?? String(e)}`;
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Zvuk hry (loopback výchozího výstupu Windows) se nepodařilo otevřít.
 * Stává se to u výchozího výstupu, který Windows "drží" jinak než běžná
 * sluchátka: virtuální zařízení (Oculus / Meta Quest, Steam Streaming),
 * 7.1 prostorový zvuk ovladače headsetu, zařízení ve výhradním režimu
 * jiné aplikace, nebo jen chvilka po probuzení zařízení. Postup:
 *   1. za chvíli to zkusit znovu (přechodná chyba),
 *   2. vzít zvuk ze vstupu, který nahrává zvuk počítače (Stereo Mix,
 *      VB-Cable, Voicemeeter...), když v počítači je,
 *   3. jinak nahrávat bez zvuku hry - a v nastavení říct proč a co s tím.
 */
async function recoverSystemAudio(firstError: unknown): Promise<MediaStreamTrack | null> {
  // 1) znovu, po krátké pauze (jen zvuk - obraz z druhého pokusu se hned zahodí)
  await new Promise((r) => setTimeout(r, 1200));
  try {
    const again = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const v of again.getVideoTracks()) v.stop();
    const track = again.getAudioTracks()[0] ?? null;
    if (track) {
      sourceTracks.push(track);
      report({ type: 'warning', generation, kind: 'systemAudioRetry', message: errorText(firstError) });
      return track;
    }
  } catch (e) {
    firstError = firstError ?? e;
  }
  // 2) vstup, který nahrává zvuk počítače
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications' && isLoopbackInput(d.label));
    for (const input of inputs) {
      try {
        const source = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const track = source.getAudioTracks()[0] ?? null;
        if (!track) continue;
        sourceTracks.push(...source.getTracks());
        systemAudioFallback = input.label;
        systemDeviceLabel = input.label;
        report({ type: 'warning', generation, kind: 'systemAudioFallback', message: input.label });
        return track;
      } catch {
        // další
      }
    }
  } catch {
    // seznam zařízení nejde - nic
  }
  // 3) bez zvuku hry
  systemAudioError = errorText(firstError) || 'unknown';
  report({ type: 'warning', generation, kind: 'systemLoopback', message: `${systemAudioError} | ${defaultOutputAtStart}` });
  return null;
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
  let legacyAudioError: unknown = null;
  systemAudioError = '';
  systemAudioFallback = '';
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
      legacyAudioError = e;
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
  } else if (wantAudio) {
    // Výchozí výstup se hlídá i když zvuk nejde - přepnutí zařízení ve Windows snímání rozjede znovu.
    defaultOutputAtStart = await defaultOutputLabel();
    if (!systemTrack) systemTrack = await recoverSystemAudio(lastError ?? legacyAudioError);
    if (systemTrack && !systemAudioFallback) systemDeviceLabel = defaultOutputAtStart;
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

/**
 * Analyzátory jen na měření - do záznamu z Web Audia nic nejde. Když se
 * nikdo nedívá na měřáky (skoro pořád), čte se 4x za sekundu delší úsek
 * (stačí na hlídání ticha) a zvukové vlákno běží s většími buffery
 * ('playback') - méně probouzení procesoru během hry.
 */
function startMeters(systemTrack: MediaStreamTrack | null, micTrack: MediaStreamTrack | null) {
  stopMeters();
  if (!systemTrack && !micTrack) return;
  let system: AnalyserNode | null = null;
  let mic: AnalyserNode | null = null;
  try {
    audioContext = new AudioContext({ latencyHint: 'playback' });
    if (audioContext.state !== 'running') void audioContext.resume().catch(() => undefined);
    const analyser = (track: MediaStreamTrack): AnalyserNode => {
      const node = audioContext!.createAnalyser();
      node.fftSize = 8192;
      audioContext!.createMediaStreamSource(new MediaStream([track])).connect(node);
      return node;
    };
    system = systemTrack ? analyser(systemTrack) : null;
    mic = micTrack ? analyser(micTrack) : null;
  } catch {
    // Bez měřáků se nahrává dál.
    return;
  }
  const buffer = new Float32Array(8192);
  let peakSystem = 0;
  let peakMic = 0;
  let ticks = 0;
  let fastBefore = metersFast;
  const tickMs = () => (metersFast ? 100 : 250);
  const tick = () => {
    if (!meters) return;
    // Rychle (někdo se dívá do nastavení): každé čtení hned ven - plynulé proužky.
    // Jinak jednou za sekundu maximum ze 4 čtení - na hlídání ticha to stačí.
    if (system) peakSystem = Math.max(peakSystem, level(system, buffer));
    if (mic) peakMic = Math.max(peakMic, level(mic, buffer));
    ticks += 1;
    if (metersFast !== fastBefore) {
      // Přepnutí rychlosti: nový rytmus čtení.
      fastBefore = metersFast;
      clearInterval(meters.timer);
      meters.timer = setInterval(tick, tickMs());
    }
    if (!metersFast && ticks < 4) return;
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
        systemError: systemAudioError || undefined,
        systemFallback: systemAudioFallback || undefined,
        defaultOutput: defaultOutputAtStart || undefined,
      },
    });
    peakSystem = 0;
    peakMic = 0;
  };
  meters = { system, mic, timer: setInterval(tick, tickMs()), silentSince: null };
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
  const size = videoSize();
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
    ...(size ? { width: size.width, height: size.height } : {}),
  });
}

// ---- rozměry obrazu (hra přepnula rozlišení) -------------------------------------------------

/** Rozměry obrazu, které teď ze snímání chodí (podle stopy). */
function videoSize(): { width: number; height: number } | null {
  const s = stream?.getVideoTracks()[0]?.getSettings();
  return s && s.width && s.height ? { width: s.width, height: s.height } : null;
}

let sizeTimer: ReturnType<typeof setInterval> | null = null;
let lastSize = '';

/**
 * Jednou za sekundu: změnila obrazovka rozměry (hra přešla na celou
 * obrazovku 4:3, alt-tab na plochu)? Hlavní proces pak klip přes tu chvíli
 * nelepí naslepo - jinak se rozměry musí měřit u každého klipu (pomalé).
 * Ptát se stopy na nastavení nic nestojí.
 */
function watchSize() {
  stopWatchSize();
  lastSize = (() => {
    const s = videoSize();
    return s ? `${s.width}x${s.height}` : '';
  })();
  sizeTimer = setInterval(() => {
    const s = videoSize();
    if (!s) return;
    const key = `${s.width}x${s.height}`;
    if (key === lastSize) return;
    lastSize = key;
    report({ type: 'resized', generation, at: Date.now(), width: s.width, height: s.height });
  }, 1000);
}

function stopWatchSize() {
  if (sizeTimer) clearInterval(sizeTimer);
  sizeTimer = null;
}

function stopRecorders() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (micRecorder && micRecorder.state !== 'inactive') micRecorder.stop();
  recorder = null;
  micRecorder = null;
}

// ---- živé vysílání ----------------------------------------------------------------------------

type LiveSession = {
  recorder: MediaRecorder;
  generation: number;
  /** Kopie obrazové stopy a smíchaný zvuk - zastaví se s koncem vysílání. */
  tracks: MediaStreamTrack[];
  ctx: AudioContext;
  chain: Promise<void>;
  /** Kamera a "Hned jsem zpět" (null = prohlížeč to neumí - vysílá se čistá obrazovka). */
  compositor: LiveCompositor | null;
  /** Kopie obrazovky (bez skládání ji "Hned jsem zpět" aspoň zatemní). */
  video: MediaStreamTrack;
  /** Hlasitost mikrofonu ve vysílání (ztlumení = 0). */
  micGain: GainNode | null;
  micLevel: number;
  scene: LiveScene;
};
let live: LiveSession | null = null;

const EMPTY_SCENE: LiveScene = { camera: null, brb: false, brbText: '', micMuted: false };

/** Změna scény za běhu: kamera, "Hned jsem zpět", ztlumený mikrofon - bez nového recorderu. */
function applyLiveScene(session: LiveSession, scene: LiveScene) {
  session.scene = scene;
  if (session.compositor) session.compositor.setScene(scene);
  else {
    // Bez skládání: "Hned jsem zpět" = černý obraz (hra není vidět); kamera nejde.
    session.video.enabled = !scene.brb;
    if (scene.camera) report({ type: 'live-warning', generation: session.generation, kind: 'camera', message: 'camera-unsupported' });
  }
  if (session.micGain) {
    const target = scene.micMuted ? 0 : session.micLevel;
    session.micGain.gain.setTargetAtTime(target, session.ctx.currentTime, 0.03);
  }
}

/** Formát pro vysílání: vždy H.264 (RTMP / FLV nic jiného nebere), s grafikou High profile. */
function liveMime(): string | null {
  const high = hwEncoder === true ? ['video/webm;codecs=avc1.640028,opus', 'video/webm;codecs=avc1.64001f,opus'] : [];
  for (const m of [...high, 'video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus']) if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

async function startLive(gen: number, preset: LivePreset, wanted: LiveAudio = { game: true, mic: true }, scene: LiveScene = EMPTY_SCENE): Promise<void> {
  stopLive();
  if (!stream) throw new Error('capture-off: snímání neběží');
  const source = stream.getVideoTracks()[0];
  if (!source) throw new Error('capture-off: není obraz');
  const mime = liveMime();
  if (!mime) throw new Error('h264-unsupported');
  // Vlastní kopie obrazu: zmenší se na kvalitu vysílání, zásobník s klipy zůstává ve své.
  const video = source.clone();
  video.contentHint = 'motion';
  try {
    await video.applyConstraints({ width: { max: preset.width }, height: { max: preset.height }, frameRate: { max: preset.fps } });
  } catch {
    // Zmenšit nejde - vysílá se v rozlišení snímání (recorder datový tok stejně drží).
  }
  // Kamera a "Hned jsem zpět": skládání snímků (bez kamery se snímky jen přeposílají - nic to nestojí).
  let compositor: LiveCompositor | null = null;
  if (LiveCompositor.supported()) {
    try {
      compositor = new LiveCompositor(video, scene, {
        brand: currentSettings?.brandColor || '#00c9a7',
        onWarning: (message) => report({ type: 'live-warning', generation: gen, kind: 'camera', message }),
      });
    } catch (e) {
      compositor = null;
      if (scene.camera) report({ type: 'live-warning', generation: gen, kind: 'camera', message: `camera-unsupported: ${String(e)}` });
    }
  }
  const outVideo = compositor ? compositor.track : video;
  // Zvuk: hra + mikrofon do jedné stopy (RTMP má jen jednu), hlasitosti jako u klipů.
  const ctx = new AudioContext({ sampleRate: 48000 });
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  const dest = ctx.createMediaStreamDestination();
  // Hlasitá hra + hlas by se v součtu přebudily - omezovač těsně pod nulou (jako alimiter u klipů).
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  limiter.connect(dest);
  const mix = (track: MediaStreamTrack, gain: number) => {
    const node = ctx.createGain();
    node.gain.value = Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(node);
    node.connect(limiter);
    return node;
  };
  // Hráč si ve vysílání může zvuk hry nebo mikrofon vypnout (klipy se tím nemění).
  const systemTrack = wanted.game ? stream.getAudioTracks()[0] ?? null : null;
  const micTrack = wanted.mic ? micStream?.getAudioTracks()[0] ?? null : null;
  if (systemTrack) mix(systemTrack, currentSettings?.systemGain ?? 1);
  const micLevel = Math.max(0, Math.min(2, currentSettings?.micGain ?? 1));
  const micGain = micTrack ? mix(micTrack, micLevel) : null;
  if (micGain && scene.micMuted) micGain.gain.value = 0;
  if (!systemTrack && !micTrack) {
    // Bez zvuku by některé přehrávače proud nebraly - tiché ticho.
    const silent = ctx.createConstantSource();
    const zero = ctx.createGain();
    zero.gain.value = 0;
    silent.connect(zero);
    zero.connect(dest);
    silent.start();
  }
  const audio = dest.stream.getAudioTracks()[0];
  const options: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
    mimeType: mime,
    videoBitsPerSecond: preset.videoKbps * 1000,
    audioBitsPerSecond: 160_000,
    // Cloudflare chce klíčový snímek aspoň každé 2 s.
    videoKeyFrameIntervalDuration: 2000,
  };
  const rec = new MediaRecorder(new MediaStream([outVideo, ...(audio ? [audio] : [])]), options);
  const session: LiveSession = {
    recorder: rec,
    generation: gen,
    tracks: [video, outVideo, ...(audio ? [audio] : [])],
    ctx,
    chain: Promise.resolve(),
    compositor,
    video,
    micGain,
    micLevel,
    scene,
  };
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const blob = e.data;
    session.chain = session.chain.then(async () => {
      bridge.liveChunk(gen, await blob.arrayBuffer());
    });
  };
  rec.onerror = (e) => report({ type: 'live-error', generation: gen, message: String((e as ErrorEvent).error ?? e) });
  rec.onstop = () => {
    releaseLive(session);
    void session.chain.then(() => report({ type: 'live-stopped', generation: gen }));
  };
  rec.start(1000);
  live = session;
  // Bez skládání se "Hned jsem zpět" a kamera řeší náhradou (viz applyLiveScene).
  if (!compositor) applyLiveScene(session, scene);
  const vs = video.getSettings();
  report({ type: 'live-started', generation: gen, mimeType: rec.mimeType || mime, width: vs.width ?? 0, height: vs.height ?? 0, fps: Math.round(vs.frameRate ?? preset.fps) });
}

/** Kamera, kopie obrazu, zvuk vysílání - pryč s koncem vysílání. */
function releaseLive(session: LiveSession) {
  session.compositor?.stop();
  for (const track of session.tracks) track.stop();
  void session.ctx.close().catch(() => undefined);
}

function stopLive() {
  const session = live;
  live = null;
  if (!session) return;
  if (session.recorder.state !== 'inactive') session.recorder.stop();
  else releaseLive(session);
}

function stopAll() {
  stopLive();
  stopRecorders();
  stopMeters();
  stopWatchSize();
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
  // Vysílání má vlastní hlášení chyb - chyba vysílání nesmí shodit zásobník s klipy.
  if (command.type === 'live-start' || command.type === 'live-stop' || command.type === 'live-scene') {
    try {
      if (command.type === 'live-start') await startLive(command.generation, command.preset, command.audio, command.scene ?? EMPTY_SCENE);
      else if (command.type === 'live-scene') {
        if (live) applyLiveScene(live, command.scene);
      } else stopLive();
    } catch (e) {
      report({ type: 'live-error', generation: command.type === 'live-start' ? command.generation : live?.generation ?? 0, message: (e as Error).message ?? String(e) });
    }
    return;
  }
  try {
    if (command.type === 'start') {
      stopAll();
      currentSettings = command.settings;
      await getStreams(command.settings);
      stream!.getVideoTracks()[0]?.addEventListener('ended', () => {
        report({ type: 'error', generation, message: 'obrazovka přestala posílat obraz' });
      });
      startRecorders(command.settings, command.generation);
      watchSize();
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
