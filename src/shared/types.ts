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
  /** Kvalita živého vysílání na Kine (tlačítko Vysílat). */
  liveQuality: LiveQuality;
  /** Název posledního vysílání (předvyplní se příště). */
  liveTitle: string;
  /** Popis vysílání (prázdný = zůstane popis ze studia na Kine). */
  liveDescription: string;
  /** Kategorie vysílání na Kine. */
  liveCategory: string;
  /** Datový tok obrazu ve vysílání v kb/s; 0 = podle zvolené kvality. */
  liveBitrateKbps: number;
  /** Do vysílání jde zvuk hry. */
  liveGameAudio: boolean;
  /** Do vysílání jde mikrofon. */
  liveMic: boolean;
  /** Po začátku vysílání otevřít stránku vysílání s chatem. */
  liveOpenPage: boolean;
  /** Kamera ve vysílání (obraz z webkamery v rohu). Klipy kameru nemají. */
  liveCamera: boolean;
  /** Id kamery ('' = první / výchozí). */
  liveCameraDevice: string;
  /** Roh, kde kamera ve vysílání je. */
  liveCameraPosition: LiveCameraPosition;
  /** Velikost kamery (podíl šířky obrazu). */
  liveCameraSize: LiveCameraSize;
  /** Tvar kamery: obdélník, zaoblený, kruh. */
  liveCameraShape: LiveCameraShape;
  /** Zrcadlit kameru (jako v zrcadle - jak se hráč vidí sám). */
  liveCameraMirror: boolean;
  /** Text obrazovky "Hned jsem zpět" (prázdný = výchozí v jazyce appky). */
  liveBrbText: string;
  /** Zkratka pro obrazovku "Hned jsem zpět" během vysílání (prázdná = jen tlačítkem). */
  liveBrbHotkey: string;
  /** Na obrazovce "Hned jsem zpět" ztlumit mikrofon (diváci neslyší, co se děje u stolu). */
  liveBrbMuteMic: boolean;
  /**
   * Po spuštění appky: 'auto' = nahrávat podle režimu (pořád / s hrou),
   * 'game' = i v režimu "pořád" počkat na první hru, 'paused' = nenahrávat,
   * dokud to hráč sám nezapne (tlačítkem, zkratkou, v liště).
   */
  launchCapture: LaunchCapture;
  /** Krátký zvuk při stisku klipu / snímku (slyšet je i ve hře přes celou obrazovku). */
  clipSound: boolean;
  /**
   * Strop místa na klipy v GB (0 = bez stropu). Když ho klipy přerostou,
   * nejstarší (kromě oblíbených, nahrávaných a rozpracovaných) se smažou samy.
   */
  storageLimitGb: number;
  /** Na notebooku na baterii nahrávat úsporně (720p, 30 fps) - šetří baterii i výkon pro hru. */
  batterySaver: boolean;
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
export type LaunchCapture = 'auto' | 'game' | 'paused';
export const LAUNCH_CAPTURE: readonly LaunchCapture[] = ['auto', 'game', 'paused'];
export type LiveCameraPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export const LIVE_CAMERA_POSITIONS: readonly LiveCameraPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export type LiveCameraSize = 'small' | 'medium' | 'large';
export const LIVE_CAMERA_SIZES: readonly LiveCameraSize[] = ['small', 'medium', 'large'];
export type LiveCameraShape = 'rect' | 'rounded' | 'circle';
export const LIVE_CAMERA_SHAPES: readonly LiveCameraShape[] = ['rect', 'rounded', 'circle'];
/** Nabídka stropu místa na klipy (GB); 0 = bez stropu. */
export const STORAGE_LIMITS_GB = [0, 20, 50, 100, 200, 500] as const;
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
  /**
   * Kdy se klip dostal do knihovny (ISO). U nahrávky zápasu je createdAt
   * začátek nahrávání, tohle konec ukládání. Starší index ho nemá.
   */
  addedAt?: string;
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
  /**
   * Nahrávka zápasu se právě ukládá (po zastavení): od kdy nahrávala a kolik
   * procent slepení je hotovo (null = ještě se neví). Tlačítko ukazuje
   * "Ukládám…" a nejde zmáčknout znovu - dřív se nahrávka uložila víckrát.
   */
  recordingSaving: { since: number; percent: number | null } | null;
  /** Kolik klipů se právě ukládá (stisk zkratky -> hotový soubor). */
  clipsSaving: number;
  /** Na baterii se nahrává úsporně (720p30), i když je nastavená vyšší kvalita. */
  batterySaverActive: boolean;
  /**
   * Upozornění, která appka nehlásila okénkem (po startu, během hry) -
   * ukážou se v okně (postranní panel), dokud trvají.
   */
  notices: AppNotice[];
  /** Hardwarový kodér H.264 dostupný (podle WebCodecs); null = zásobník ještě neběžel / nejde zjistit. */
  hwEncoder: boolean | null;
  /** Živé vysílání z appky. */
  live: LiveStatus;
};

export type GameSource = 'steam' | 'custom' | 'known' | 'fullscreen';

/** Tiché upozornění v okně (místo okénka / systémového oznámení). */
export type AppNotice = { id: string; text: string; kind: 'warn' | 'error' | 'info'; at: number; tab?: string };

/** Kolik appka právě bere (všechny její procesy dohromady) - panel O aplikaci / Výkon. */
export type ResourceUsage = {
  /** Procesor v % jednoho jádra (součet procesů appky, jako Správce úloh / počet jader = cpuPercentOfTotal). */
  cpuPercent: number;
  /** Podíl celého procesoru (jako ve Správci úloh). */
  cpuPercentOfTotal: number;
  /** Paměť (pracovní sada) v MB. */
  memoryMb: number;
  /** Rozpis podle druhu procesu. */
  parts: { label: string; cpuPercent: number; memoryMb: number }[];
};

export type DisplayInfo = { id: string; label: string; width: number; height: number; primary: boolean };

export type ProcessInfo = { exe: string; name: string; hasWindow: boolean };

/** Příkazy pro skrytou stránku, která snímá obrazovku. */
export type CaptureCommand =
  | { type: 'start'; settings: Settings; generation: number }
  | { type: 'restart'; generation: number }
  | { type: 'stop' }
  /** Živé vysílání: druhý recorder (nižší datový tok, hra + mikrofon smíchané) na stejném snímání. */
  | { type: 'live-start'; generation: number; preset: LivePreset; audio?: LiveAudio; scene?: LiveScene }
  | { type: 'live-stop' }
  /** Změna za běhu vysílání bez nového spojení: obrazovka "Hned jsem zpět", ztlumený mikrofon, kamera. */
  | { type: 'live-scene'; scene: LiveScene }
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
      /** Rozměry obrazu na začátku (podle stopy); změny pak chodí jako 'resized'. */
      width?: number;
      height?: number;
    }
  | { type: 'stopped'; generation: number; at: number }
  | { type: 'error'; generation: number; message: string }
  /** Něco nejde, ale nahrává se dál (třeba mikrofon není). */
  | { type: 'warning'; generation: number; kind: 'microphone' | 'systemAudio' | 'bluetoothMic'; message: string }
  /** Hladiny zvuku (0-1, RMS) zhruba každou sekundu - měřáky v nastavení a hlídání ticha. */
  | { type: 'levels'; generation: number; levels: AudioLevels }
  /** Změnilo se výchozí výstupní zařízení Windows (nový název) - loopback je přilepený na staré, snímání se má rozjet znovu. */
  | { type: 'defaultOutputChanged'; generation: number; device: string }
  /** Recorder živého vysílání běží (generace vysílání, ne zásobníku). */
  | { type: 'live-started'; generation: number; mimeType: string; width: number; height: number; fps: number }
  /** Recorder živého vysílání skončil (povel, nebo nový start snímání) - poslední kousky už odešly. */
  | { type: 'live-stopped'; generation: number }
  | { type: 'live-error'; generation: number; message: string }
  /** Vysílá se, ale něco z přání nešlo (kamera není / je obsazená) - vysílání jede bez toho. */
  | { type: 'live-warning'; generation: number; kind: 'camera'; message: string }
  /**
   * Snímaná obrazovka změnila rozměry (hra přepnula rozlišení, celá
   * obrazovka 4:3…) v čase `at`. Kousky před a po se nesmí slepit do
   * jednoho klipu - podle toho se hledá, odkud klip vzít.
   */
  | { type: 'resized'; generation: number; at: number; width: number; height: number };

/** Kvalita živého vysílání: rozlišení, snímky, datový tok. */
export type LiveQuality = '720p30' | '1080p30' | '1080p60';
export type LivePreset = { width: number; height: number; fps: number; videoKbps: number };
/** Co jde do zvuku vysílání (hra a mikrofon se míchají do jedné stopy). */
export type LiveAudio = { game: boolean; mic: boolean };

/**
 * Co je ve vysílání vidět a slyšet navíc k obrazovce: kamera (kde, jak
 * velká, jaký tvar), obrazovka "Hned jsem zpět" (místo hry, s textem) a
 * ztlumený mikrofon. Mění se i za běhu (live-scene) bez nového spojení.
 */
export type LiveScene = {
  camera: { deviceId: string; position: LiveCameraPosition; size: LiveCameraSize; shape: LiveCameraShape; mirror: boolean } | null;
  /** Obrazovka "Hned jsem zpět": hra a kamera schované, jen text. */
  brb: boolean;
  brbText: string;
  /** Mikrofon ve vysílání ztlumený (klipy se tím nemění). */
  micMuted: boolean;
};

/** Průběžné údaje o vysílání (z ffmpeg): kolik opravdu odchází. */
export type LiveStats = {
  /** Odchozí datový tok v kb/s (obraz + zvuk). */
  kbps: number | null;
  /** Snímků za sekundu, které odcházejí. */
  fps: number | null;
  /** Rychlost proti reálnému času (1 = stíhá, méně = upload nestíhá). */
  speed: number | null;
  /** Kolik MB čeká v rouře na odeslání (rostoucí = upload nestíhá). */
  backlogMb: number;
};

/** Stav živého vysílání z appky (tlačítko Vysílat). */
export type LiveStatus = {
  /** 'stopping' = hráč vysílání ukončil a appka ho dokončuje (poslední kousky, Cloudflare) - tlačítko už nejde zmáčknout znovu. */
  state: 'idle' | 'starting' | 'live' | 'reconnecting' | 'stopping';
  /** Od kdy je živě (ms od epochy); null = ještě ne. */
  since: number | null;
  title: string;
  /** Stránka vysílání na Kine (diváci, chat). */
  watchUrl: string | null;
  /** Proč vysílání nešlo začít / spadlo (text pro hráče). */
  error: string | null;
  /** Vidí Kine proud u Cloudflare? null = ještě se nevědělo (nebo nevysílá se). */
  confirmed: boolean | null;
  /** Co je ve vysílání (kamera, "Hned jsem zpět", ztlumený mikrofon). */
  scene: LiveScene | null;
  /** Kolik odchází (ffmpeg); null = ještě nic. */
  stats: LiveStats | null;
  /** Kolik diváků se dívá (podle Kine); null = neví se. */
  viewers: number | null;
  /** Kamera chtěná, ale nejde (obsazená jiným programem, žádná) - vysílá se bez ní. */
  cameraError: string | null;
};

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
