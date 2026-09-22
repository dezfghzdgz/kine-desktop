/**
 * Typy sdílené hlavním procesem a stránkami (renderer).
 *
 * Nic odsud nesmí sáhnout na electron ani na Node - importují to i
 * testy a stránky v okně.
 */

/** Jazyky appky - stejných osm jako web Kine. Výchozí je angličtina. */
export type Lang = 'en' | 'cs' | 'sk' | 'de' | 'pl' | 'es' | 'fr' | 'uk';
export const LANGS: readonly Lang[] = ['en', 'cs', 'sk', 'de', 'pl', 'es', 'fr', 'uk'];

/**
 * Dvě appky ze stejného kódu (src/main/variant.ts):
 *  - full: "Kine" (Kine do PC) - Kine jako aplikace na koukání videí
 *    + klipovač v jednom okně,
 *  - clipper: "Kine Clipper" (Kine Klipovač) - jen klipovač v liště
 *    u hodin, Kine se otvírá v prohlížeči.
 * Kterou hráč má, se rozhoduje při stahování na webu; v appce se to
 * nepřepíná (klipovač je součástí Kine do PC a funguje stejně).
 */
export type Variant = 'full' | 'clipper';

/** Režim appky = varianta (nastavuje se při každém startu podle varianty). */
export type AppMode = 'clipper' | 'full';

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
  /** 2 = od verze 0.3 (mikrofon zapnutý v základu, volba režimu zvlášť). */
  version: 2;
  lang: Lang;
  appMode: AppMode;
  /** Hráč (nebo instalátor) režim vybral; dokud ne, appka ho zkusí odvodit z názvu instalátoru. */
  appModeChosen: boolean;
  /**
   * Zkratka "ulož klip" - klávesy spojené plusem, např. "F8", "Ctrl+Shift+S",
   * "F8+F9" nebo "Mouse5" (viz shared/hotkeys.ts).
   */
  clipHotkey: string;
  /** Zkratka pro ruční zapnutí/vypnutí zásobníku. */
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
  /** Program přes celou obrazovku bez rámečku brát jako hru, i když ho appka nezná. */
  detectFullscreen: boolean;
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
  /** Hra, při které klip vznikl (název), nebo null. Hráč ji může opravit. */
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

/**
 * Plán účtu na Kine (stejné hodnoty jako lib/plus.ts na webu):
 *  free  - základ
 *  kine  - Kine Plus (web: odznak, vyšší denní limit nahrávání…)
 *  clips - Klipy Plus (appka: automatické nahrávání, klipy až 5 minut)
 *  all   - obojí
 *  plus  - starší hodnota, znamená "all"
 */
export type Plan = 'free' | 'kine' | 'clips' | 'all' | 'plus';

export type PlanPrices = { kine: string | null; clips: string | null; all: string | null };

export type Status = {
  capture: CaptureState;
  captureError: string | null;
  /** Právě běžící hra (název), nebo null. */
  game: string | null;
  /** Odkud appka hru zná (pro nastavení: "poznáno podle celé obrazovky" jde pojmenovat). */
  gameSource: GameSource | null;
  /** Program hry (např. cs2.exe) - pro tlačítko "pojmenovat". */
  gameExe: string | null;
  /** Kolik klipů čeká / nahrává se. */
  uploadsPending: number;
  /** Nahrávání stojí, protože se hraje. */
  uploadsPaused: boolean;
  account: {
    username: string;
    email: string | null;
    plan: Plan;
    planUntil: string | null;
    /** Má Klipy Plus (automatické nahrávání, dlouhé klipy)? */
    clipsPlus: boolean;
    /** Má Kine Plus (web)? */
    kinePlus: boolean;
    maxClipSeconds: number;
    plusAvailable: boolean;
    prices: PlanPrices;
  } | null;
  /** Ruční pauza zásobníku (tray "Pozastavit"). */
  paused: boolean;
  /** Zkratky, které nejde zaregistrovat (drží je jiný program / nejsou na tomhle systému možné). */
  hotkeyProblems: string[];
  /** Umí tenhle systém zkratky z více kláves a tlačítka myši? (pomocník na Windows) */
  chordsSupported: boolean;
  version: string;
  /** Která appka to je ("Kine" nebo "Kine Clipper"). */
  variant: Variant;
};

export type GameSource = 'steam' | 'custom' | 'known' | 'fullscreen';

export type DisplayInfo = { id: string; label: string; width: number; height: number; primary: boolean };

export type ProcessInfo = { exe: string; name: string; hasWindow: boolean };

/** Příkazy pro skrytou stránku, která snímá obrazovku. */
export type CaptureCommand =
  | { type: 'start'; settings: Settings; generation: number }
  | { type: 'restart'; generation: number }
  | { type: 'stop' };

export type CaptureEvent =
  | { type: 'started'; generation: number; at: number; mimeType: string; audio: boolean }
  | { type: 'stopped'; generation: number; at: number }
  | { type: 'error'; generation: number; message: string }
  /** Něco nejde, ale nahrává se dál (třeba mikrofon není). */
  | { type: 'warning'; generation: number; kind: 'microphone'; message: string };
