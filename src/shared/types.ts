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

/** Viditelnost videa na Kine - stejné hodnoty jako web (public / subscribers = jen odběratelé / private). */
export type Visibility = 'public' | 'subscribers' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'subscribers', 'private'];

/**
 * Co jde nastavit u nahrání na Kine (stejná pole, jaká má web v nahrávání).
 * Co chybí, doplní appka z výchozích hodnot (nastavení Nahrání a sdílení,
 * popis a hashtagy podle hry).
 */
export type UploadOptions = {
  title?: string;
  /** Vlastní popis; když chybí, appka dá výchozí ("Klip z {hra} …" s odkazem na appku). */
  description?: string;
  /** Hashtagy bez #; když chybí, appka dá "klip" + hru + výchozí z nastavení. */
  hashtags?: string[];
  /** Klíč kategorie Kine ('catGaming', 'catMusic'…). */
  category?: string;
  /** Jazyk videa (cs, en…); když chybí, z nastavení. */
  language?: string;
  madeForKids?: boolean;
  hasPaidPromotion?: boolean;
  isAiGenerated?: boolean;
  /** Poslat náhled klipu z appky jako vlastní náhled na Kine (jinak si Kine vezme snímek sama). */
  thumbnail?: boolean;
};

/** Požadavek na nahrání jednoho klipu (knihovna, okýnko po hře, automaticky po hře). */
export type UploadRequest = { clipId: string; visibility: Visibility } & UploadOptions;

/** Kategorie Kine (klíče překladu, stejné jako web lib/categories.ts). */
export const CATEGORY_KEYS = [
  'catGaming', 'catEntertainment', 'catComedy', 'catMusic', 'catFilm', 'catSports', 'catPeople', 'catHowTo',
  'catEducation', 'catScience', 'catNews', 'catPets', 'catCars', 'catTravel', 'catNonprofit',
] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export type Settings = {
  /** 2 = od verze 0.3 (mikrofon zapnutý v základu, volba režimu zvlášť); 3 = od 0.9.3 (výchozí kvalita 1080p60 20 Mb/s). */
  version: 3;
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
  /** Zkratka start/stop nahrávání celého zápasu (prázdné = vypnuto). */
  recordHotkey: string;
  /** Zkratka na snímek obrazovky (PNG do složky Screenshots + do schránky; prázdné = vypnuto). */
  screenshotHotkey: string;
  /** Kolik sekund zpět klip sahá. */
  clipSeconds: number;
  /** Výška obrazu: 0 = jako obrazovka. */
  maxHeight: 0 | 720 | 1080 | 1440;
  fps: 30 | 60;
  codec: Codec;
  /** Datový tok obrazu v Mb/s. */
  videoMbps: number;
  systemAudio: boolean;
  /**
   * Odkud brát zvuk hry: '' = zvuk systému Windows (loopback výchozího
   * výstupního zařízení), jinak id vstupního zařízení (Stereo Mix, VB-Cable,
   * "What U Hear"…) - záloha, když hra hraje jinam než na výchozí výstup.
   */
  systemAudioDevice: string;
  microphone: boolean;
  /** Id mikrofonu ('' = výchozí mikrofon Windows). */
  microphoneDevice: string;
  /** Hlasitost zvuku hry v klipu (1 = beze změny, 0-2). */
  systemGain: number;
  /** Hlasitost mikrofonu v klipu (1 = beze změny, 0-2). */
  micGain: number;
  /** Mikrofon i jako druhá, samostatná zvuková stopa v klipu (první je hra + mikrofon). */
  separateMicTrack: boolean;
  /** Posun zvuku vůči obrazu v ms (kladné = zvuk později) - kalibrace, když zvuk „nesedí“. */
  audioOffsetMs: number;
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
  /**
   * Klipy samy z herních událostí (zabití, multikill, ace) - u her, které
   * je hlásí ven: Counter-Strike 2 (Game State Integration), League of
   * Legends (Live Client Data API). 'off' = jen zkratkou, 'multi' = od dvou
   * zabití v jednom kole / v řadě, 'every' = každé zabití.
   */
  autoClips: AutoClipMode;
  /** Tajný klíč, který CS2 posílá s každou zprávou (vygeneruje se jednou). */
  gsiToken: string;
  /** Adresa webhooku Discordu - tlačítko "Poslat na Discord" u nahraného klipu. Prázdné = tlačítko není. */
  discordWebhook: string;
  /** Kolik výkonu smí appka brát (jak často hlídá hry, pomocník, náhledy…) - viz shared/performance.ts. */
  performance: PerformanceMode;
  /** Verze, kterou hráč naposledy viděl běžet - po aktualizaci se jednou řekne "aktualizováno na X". */
  lastVersion: string;
  /** Řazení knihovny klipů. */
  clipsSort: ClipsSort;
  /** Před nahráním z knihovny ukázat nastavení nahrání (název, popis, hashtagy…); false = nahrát rovnou s výchozím. */
  uploadAsk: boolean;
  /** Hashtagy, které se přidají ke každému nahrání (bez #, oddělené mezerou/čárkou). */
  uploadHashtags: string;
  /** Výchozí kategorie na Kine. */
  uploadCategory: string;
  /** Posílat náhled klipu z appky jako náhled na Kine. */
  uploadThumbnail: boolean;
};

export type PerformanceMode = 'low' | 'balanced' | 'high';
export type ClipsSort = 'newest' | 'oldest' | 'longest' | 'largest';

export type AutoClipMode = 'off' | 'multi' | 'every';

export type ClipUpload =
  | { state: 'queued' }
  | { state: 'uploading'; percent: number; tusUrl?: string; videoId?: string }
  | { state: 'paused'; percent: number; reason: 'game' | 'offline'; tusUrl?: string; videoId?: string }
  /** ready: Kine video zpracovala a je vidět (false = nahrané, Kine ho ještě zpracovává; chybí = starší záznam, hotovo). */
  | { state: 'done'; videoId: string; url: string; ready?: boolean }
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
  /** Oblíbený (hvězdička v knihovně) - starší index ho nemá, proto volitelný. */
  favorite?: boolean;
  /** 'recording' = nahrávka celého zápasu (start/stop), jinak klip ze zásobníku. */
  kind?: 'clip' | 'recording';
  /**
   * Značky v nahrávce zápasu (s od začátku): klip uložený během nahrávání,
   * zabití ze hry... Přehrávač je ukáže na ose a na Kine z nich budou kapitoly.
   */
  markers?: { time: number; label: string }[];
  /** V koši od (ISO) - soubor leží ve složce .trash, po TRASH_DAYS dnech se smaže nadobro. */
  deletedAt?: string;
  /** S čím se klip nahrává / nahrál (ať se po restartu appky neztratí hashtagy a spol.). */
  uploadOptions?: UploadRequest;
  /**
   * Zvukové stopy v souboru, v pořadí: 'mix' (hra + mikrofon), 'game', 'mic'.
   * Starší klipy to nemají (jedna stopa). Podle toho jde v úpravách vybrat,
   * jestli klip uložit jen se zvukem hry, jen s mikrofonem, nebo se vším.
   */
  audioTracks?: ('mix' | 'game' | 'mic')[];
};

/** Jak dlouho klip leží v koši, než zmizí sám. */
export const TRASH_DAYS = 7;

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
  /** Hra, která právě posílá události pro automatické klipy (CS2 / LoL / Dota 2 / Minecraft), nebo null. */
  autoClipsLive: 'cs2' | 'lol' | 'dota2' | 'minecraft' | null;
  /** Běží nahrávání celého zápasu? Od kdy (ms od epochy). */
  recordingSince: number | null;
  /** Hardwarový kodér H.264 dostupný (podle WebCodecs); null = zásobník ještě neběžel / nejde zjistit. */
  hwEncoder: boolean | null;
};

export type GameSource = 'steam' | 'custom' | 'known' | 'fullscreen';

export type DisplayInfo = { id: string; label: string; width: number; height: number; primary: boolean };

export type ProcessInfo = { exe: string; name: string; hasWindow: boolean };

/** Příkazy pro skrytou stránku, která snímá obrazovku. */
export type CaptureCommand =
  | { type: 'start'; settings: Settings; generation: number }
  | { type: 'restart'; generation: number }
  | { type: 'stop' }
  /** Měřáky zvuku rychle (někdo se dívá do nastavení), nebo jednou za sekundu. */
  | { type: 'meters'; fast: boolean };

export type CaptureEvent =
  | {
      type: 'started';
      generation: number;
      at: number;
      mimeType: string;
      /** Má proud obrazu zvuk hry? */
      audio: boolean;
      /** Běží vedle i proud mikrofonu (druhý MediaRecorder)? */
      mic?: boolean;
      /** Zpoždění mikrofonu podle Chromia (ms; o tolik je záznam mikrofonu za skutečností). */
      micLatencyMs?: number;
      /** Je v počítači hardwarový kodér H.264 (podle WebCodecs)? null = nejde zjistit. */
      hwEncoder?: boolean | null;
      /** Snímky za sekundu, se kterými se opravdu nahrává (bez hardwarového kodéru nejvýš 30). */
      fps?: number;
    }
  | { type: 'stopped'; generation: number; at: number }
  | { type: 'error'; generation: number; message: string }
  /** Něco nejde, ale nahrává se dál (třeba mikrofon není). */
  | { type: 'warning'; generation: number; kind: 'microphone' | 'systemAudio' | 'bluetoothMic'; message: string }
  /** Hladiny zvuku (0-1, RMS) zhruba každou sekundu - měřáky v nastavení a hlídání ticha. */
  | { type: 'levels'; generation: number; levels: AudioLevels }
  /** Změnilo se výchozí výstupní zařízení Windows (nový název) - loopback je přilepený na staré, snímání se má rozjet znovu. */
  | { type: 'defaultOutputChanged'; generation: number; device: string };

/** Co právě teče do zvuku klipu. */
export type AudioLevels = {
  /** Hladina zvuku hry / systému (0-1), null = stopa není (vypnuto, není Windows, nepovedlo se). */
  system: number | null;
  /** Hladina mikrofonu (0-1), null = mikrofon není. */
  mic: number | null;
  /** Název zařízení, ze kterého se bere zvuk hry (výchozí výstup Windows, nebo zvolené vstupní zařízení). */
  systemDevice: string;
  /** Jak dlouho (s) je zvuk hry úplně tichý (digitální nula) - když hra běží, něco je špatně. */
  systemSilentSeconds: number;
  /** Mikrofon, který se nahrává (název; prázdné = neznámý / žádný). */
  micDevice?: string;
  /** Výchozí mikrofon jsou sluchátka Bluetooth - appka ho nepoužila (vzala jiný, nebo žádný). */
  bluetoothMicAvoided?: boolean;
};

/** Zvukové zařízení pro výběr v nastavení (z enumerateDevices v okně). */
export type AudioDevice = { id: string; label: string; kind: 'input' | 'output' };
