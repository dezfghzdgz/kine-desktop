import type { LiveScene, SceneCamera } from './types';

/**
 * Co se nahrává a scény vysílání - čistá logika (tests/scenes.test.mjs).
 *
 * Zdroj obrazu je buď monitor, nebo jedna aplikace (okno), jako při sdílení
 * obrazovky na Discordu. Klipy i vysílání jdou z jednoho snímání, takže
 * zdroj je jeden: hlavní (Nastavení -> Záznam), a během vysílání ho může
 * dočasně přepnout scéna, která má vlastní zdroj (po konci vysílání se
 * snímání vrátí k hlavnímu).
 *
 * Scéna = jak vypadá obraz vysílání: hra (zdroj) s kamerou nebo bez,
 * jen kamera přes celý obraz, nebo obrazovka s textem ("Začínáme za
 * chvíli"). "Hned jsem zpět" zůstává zvlášť - jde zapnout nad každou scénou.
 */

export type CaptureSourceRef =
  /** Monitor: id z Electronu ('' = hlavní). */
  | { kind: 'screen'; displayId: string }
  /** Okno aplikace: id zdroje z desktopCapturer ("window:123:0") a jeho název (podle něj se okno najde po restartu aplikace). */
  | { kind: 'window'; id: string; name: string };

export type LiveSceneKind = 'source' | 'camera' | 'text';
export const LIVE_SCENE_KINDS: LiveSceneKind[] = ['source', 'camera', 'text'];

export type LiveSceneDef = {
  id: string;
  /** Název scény ('' = výchozí název podle druhu, v jazyce appky). */
  name: string;
  kind: LiveSceneKind;
  /** Jen 'source': vlastní zdroj obrazu; null = stejný jako záznam. */
  source: CaptureSourceRef | null;
  /** Jen 'source': kamera v obraze (místo, velikost a tvar podle nastavení kamery ve vysílání). */
  camera: boolean;
  /** Jen 'text': text na obrazovce ('' = výchozí text). */
  text: string;
};

export const MAX_SCENES = 8;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const WINDOW_ID_RE = /^window:[0-9a-zA-Z:._-]{1,80}$/;

export function defaultScenes(): LiveSceneDef[] {
  return [
    { id: 'game', name: '', kind: 'source', source: null, camera: true, text: '' },
    { id: 'camera', name: '', kind: 'camera', source: null, camera: false, text: '' },
    { id: 'starting', name: '', kind: 'text', source: null, camera: false, text: '' },
  ];
}

/** Zdroj ze souboru nastavení / z okna appky - co nesedí, je null. */
export function sanitizeSourceRef(raw: unknown): CaptureSourceRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'screen') return { kind: 'screen', displayId: typeof r.displayId === 'string' ? r.displayId.trim().slice(0, 100) : '' };
  if (r.kind === 'window' && typeof r.id === 'string' && WINDOW_ID_RE.test(r.id.trim())) {
    const name = typeof r.name === 'string' ? r.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) : '';
    return { kind: 'window', id: r.id.trim(), name };
  }
  return null;
}

function cleanText(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '';
}

/** Seznam scén ze souboru nastavení: nejvýš 8, jedinečná id; prázdný / rozbitý = výchozí scény. */
export function sanitizeScenes(raw: unknown): LiveSceneDef[] {
  if (!Array.isArray(raw)) return defaultScenes();
  const out: LiveSceneDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_SCENES) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : '';
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const kind = LIVE_SCENE_KINDS.includes(r.kind as LiveSceneKind) ? (r.kind as LiveSceneKind) : 'source';
    seen.add(id);
    out.push({
      id,
      name: cleanText(r.name, 40),
      kind,
      source: kind === 'source' ? sanitizeSourceRef(r.source) : null,
      camera: kind === 'source' ? r.camera !== false : false,
      text: kind === 'text' ? cleanText(r.text, 80) : '',
    });
  }
  return out.length > 0 ? out : defaultScenes();
}

/** Platné id scény (jinak první scéna). */
export function sceneIdOrFirst(scenes: LiveSceneDef[], id: unknown): string {
  return typeof id === 'string' && scenes.some((s) => s.id === id) ? id : scenes[0]?.id ?? 'game';
}

export function findScene(scenes: LiveSceneDef[], id: string): LiveSceneDef {
  return scenes.find((s) => s.id === id) ?? scenes[0] ?? defaultScenes()[0];
}

/** Další scéna v pořadí (zkratka "Další scéna"), za poslední zase první. */
export function nextSceneId(scenes: LiveSceneDef[], currentId: string): string {
  if (scenes.length === 0) return currentId;
  const i = scenes.findIndex((s) => s.id === currentId);
  return scenes[(i + 1) % scenes.length].id;
}

/** Nové id scény, které v seznamu ještě není. */
export function newSceneId(scenes: LiveSceneDef[], random: () => number = Math.random): string {
  for (let i = 0; i < 50; i++) {
    const id = `s-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
    if (!scenes.some((s) => s.id === id)) return id;
  }
  return `s-${Date.now().toString(36)}`;
}

/** Hlavní zdroj záznamu z nastavení: okno, když je vybrané, jinak monitor. */
export function mainSource(settings: { displayId: string; captureWindow: CaptureSourceRef | null }): CaptureSourceRef {
  return settings.captureWindow && settings.captureWindow.kind === 'window' ? settings.captureWindow : { kind: 'screen', displayId: settings.displayId };
}

/**
 * Co má snímání právě nahrávat: během vysílání zdroj aktivní scény (má-li
 * vlastní), jinak hlavní zdroj. Scéna jen s kamerou nebo s textem zdroj
 * nemění - snímání běží dál na tom, co bylo (klipy se nepřeruší).
 */
export function effectiveSource(main: CaptureSourceRef, scene: LiveSceneDef | null, liveActive: boolean, previous: CaptureSourceRef | null = null): CaptureSourceRef {
  if (!liveActive || !scene) return main;
  if (scene.kind === 'source') return scene.source ?? main;
  return previous ?? main;
}

/** Klíč zdroje pro porovnání ("screen:" = hlavní monitor). */
export function sourceKey(ref: CaptureSourceRef | null): string {
  if (!ref) return '';
  return ref.kind === 'screen' ? `screen:${ref.displayId}` : `window:${ref.id}`;
}

export function sameSource(a: CaptureSourceRef | null, b: CaptureSourceRef | null): boolean {
  return sourceKey(a) === sourceKey(b);
}

export type WindowSourceLike = { id: string; name: string };

/**
 * Okno ze seznamu zdrojů: podle id (dokud aplikace běží), jinak podle
 * názvu (aplikace se mezitím spustila znovu a okno má nové id). Název se
 * porovná přesně, potom bez části za poslední pomlčkou ("Kine - Opera" ->
 * "Opera" - prohlížeč mění název podle stránky). null = okno není otevřené.
 */
export function pickWindowSource<T extends WindowSourceLike>(sources: T[], ref: { id: string; name: string }): T | null {
  const byId = sources.find((s) => s.id === ref.id);
  if (byId) return byId;
  const name = ref.name.trim();
  if (!name) return null;
  const exact = sources.filter((s) => s.name.trim() === name);
  if (exact.length === 1) return exact[0];
  const app = appPart(name);
  if (!app) return null;
  const sameApp = sources.filter((s) => appPart(s.name) === app);
  return sameApp.length === 1 ? sameApp[0] : null;
}

/** Název aplikace z názvu okna: část za poslední pomlčkou ("Stránka - Opera" -> "opera"); bez pomlčky nic. */
export function appPart(title: string): string {
  const parts = title.split(/\s[-–—|]\s/);
  if (parts.length < 2) return '';
  return parts[parts.length - 1].trim().toLowerCase();
}

/** Nastavení kamery ve vysílání (podmnožina Settings). */
export type LiveCameraSettings = {
  liveCamera: boolean;
  liveCameraDevice: string;
  liveCameraPosition: SceneCamera['position'];
  liveCameraSize: SceneCamera['size'];
  liveCameraShape: SceneCamera['shape'];
  liveCameraMirror: boolean;
};

/**
 * Scéna pro snímací stránku: co kreslí skládání vysílání. Kamera v rohu
 * jen když je kamera ve vysílání zapnutá; "Hned jsem zpět" přebije každou scénu.
 */
export function composeScene(
  scene: LiveSceneDef,
  cam: LiveCameraSettings,
  extra: { brb: boolean; brbText: string; micMuted: boolean; defaultText: string }
): LiveScene {
  const camera: SceneCamera = { deviceId: cam.liveCameraDevice, position: cam.liveCameraPosition, size: cam.liveCameraSize, shape: cam.liveCameraShape, mirror: cam.liveCameraMirror };
  const base: LiveScene = { camera: null, brb: extra.brb, brbText: extra.brbText, micMuted: extra.micMuted, sceneId: scene.id };
  if (extra.brb) return base;
  if (scene.kind === 'text') return { ...base, screenText: scene.text || extra.defaultText };
  // Scéna "Jen kamera" kameru otevře vždycky (zapnutí kamery ve vysílání řídí kameru v rohu obrazu).
  if (scene.kind === 'camera') return { ...base, camera, cameraFull: true };
  return { ...base, camera: scene.camera && cam.liveCamera ? camera : null };
}
