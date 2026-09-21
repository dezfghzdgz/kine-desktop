/**
 * Typy sdílené hlavním procesem a stránkami (renderer).
 *
 * Nic odsud nesmí sáhnout na electron ani na Node - importují to i
 * testy a stránky v okně.
 */

export type Lang = 'cs' | 'en';

export type DetectionMode =
  /** Nahrávat do zásobníku jen když běží hra (výchozí). */
  | 'games'
  /** Zásobník běží pořád, dokud appka běží (jako ShadowPlay). */
  | 'always'
  /** Zásobník se zapíná a vypíná ručně klávesovou zkratkou. */
  | 'manual';

export type AfterGame =
  /** Po hře okýnko: vyber, co nahrát (výchozí). */
  | 'review'
  /** Po hře nahrát všechno automaticky, bez ptaní (Medal). */
  | 'auto'
  /** Jen uložit do počítače, na Kine nic. */
  | 'none';

export type Codec = 'auto' | 'h264' | 'vp9' | 'vp8';

export type Visibility = 'public' | 'private';

export type Settings = {
  version: 1;
  lang: Lang;
  /** Klávesa pro "ulož klip", jako Electron accelerator, např. "F8" nebo "Ctrl+Shift+S". */
  clipHotkey: string;
  /** Klávesa pro ruční zapnutí/vypnutí zásobníku. */
  toggleHotkey: string;
  /** Kolik sekund zpět klip sahá. */
  clipSeconds: number;
  /** Výška obrazu: 0 = jako obrazovka. */
  maxHeight: 0 | 720 | 1080 | 1440;
  fps: 30 | 60;
  codec: Codec;
  /** Datový tok obrazu v Mb/s. */
  videoMbps: number;
  systemAudio: boolean;
  microphone: boolean;
  /** Prázdné = hlavní obrazovka. Jinak id obrazovky z Electronu. */
  displayId: string;
  detection: DetectionMode;
  /** Hry přidané ručně: název spustitelného souboru (malými písmeny) -> název hry. */
  customGames: Record<string, string>;
  afterGame: AfterGame;
  visibility: Visibility;
  /** Jazyk videí na Kine (kód jako v appce: cs, en, ...). */
  videoLanguage: string;
  startWithSystem: boolean;
  /** Malé okénko v rohu po uložení klipu. Když nejde (fullscreen), aspoň systémové oznámení. */
  toast: boolean;
  /** Složka s klipy; prázdné = Videa/Kine. */
  clipsDir: string;
  /** Adresa Kine (pro vývoj se dá přepnout na localhost). */
  siteUrl: string;
  /** Po prvním průvodci true. */
  onboarded: boolean;
  /** Barva Kine hráče (z jeho účtu na webu), např. "#a34ff7"; prázdné = výchozí. */
  brandColor: string;
};

export type ClipUpload =
  | { state: 'queued' }
  | { state: 'uploading'; percent: number; tusUrl?: string; videoId?: string }
  | { state: 'paused'; percent: number; reason: 'game' | 'offline'; tusUrl?: string; videoId?: string }
  | { state: 'done'; videoId: string; url: string }
  | { state: 'error'; message: string };

export type Clip = {
  id: string;
  /** Cesta k souboru s videem. */
  file: string;
  /** Cesta k náhledu (jpg), když se povedl. */
  thumb: string | null;
  title: string;
  /** Hra, při které klip vznikl (název), nebo null. */
  game: string | null;
  createdAt: string;
  durationSeconds: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** Hraní, ke kterému klip patří - podle toho se po hře sesbírají do okýnka. */
  sessionId: string;
  upload: ClipUpload | null;
};

export type CaptureState = 'off' | 'starting' | 'on' | 'error';

export type Status = {
  capture: CaptureState;
  captureError: string | null;
  /** Právě běžící hra (název), nebo null. */
  game: string | null;
  /** Kolik klipů čeká / nahrává se. */
  uploadsPending: number;
  /** Nahrávání stojí, protože se hraje. */
  uploadsPaused: boolean;
  account: {
    username: string;
    email: string | null;
    plan: 'free' | 'plus';
    planUntil: string | null;
    maxClipSeconds: number;
    plusAvailable: boolean;
    plusPriceLabel: string | null;
  } | null;
  /** Ruční pauza zásobníku (tray "Pozastavit"). */
  paused: boolean;
  version: string;
};

export type DisplayInfo = { id: string; label: string; width: number; height: number; primary: boolean };

export type ProcessInfo = { exe: string; name: string };

/** Příkazy pro skrytou stránku, která snímá obrazovku. */
export type CaptureCommand =
  | { type: 'start'; settings: Settings; generation: number }
  | { type: 'restart'; generation: number }
  | { type: 'stop' };

export type CaptureEvent =
  | { type: 'started'; generation: number; at: number; mimeType: string; audio: boolean }
  | { type: 'stopped'; generation: number; at: number }
  | { type: 'error'; generation: number; message: string };
