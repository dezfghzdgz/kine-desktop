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
  /** Okno s chatem vysílání drží nahoře (nad hrou v okně bez rámečku). */
  liveChatOnTop: boolean;
  /** Vzhled oken: klasický (plné plochy) nebo sklo (průhledné plochy nad barevným pozadím). */
  look: Look;
  /** Barvy pozadí skla: moje barva nebo předvolba. */
  glassBackdrop: GlassBackdrop;
  /** Síla skla 0-100 (jak moc je vidět pozadí). */
  glassStrength: number;
  /** Průhledné okno: na Windows 11 prosvítá rozmazaně plocha a okna za appkou (Acrylic). */
  glassWindow: boolean;
  /** Barvy podle obrazu: kolem přehrávače svítí barvy klipu, se sklem se podle klipu mění i pozadí. */
  lookFollow: boolean;
  /** Pohyblivé barvy: barvy pozadí skla se pomalu přelévají. */
  lookMotion: boolean;
  /** Velikost písma v okně appky. */
  lookText: LookSize;
  /** Zaoblení rohů ploch, tlačítek a karet. */
  lookCorners: LookCorners;
  /** Velikost karet klipů (kolik se jich vejde do řádku). */
  lookCards: LookSize;
  /** Klidný režim: bez animací a přechodů. */
  lookCalm: boolean;
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
   * Kompatibilní režim vysílání: ffmpeg obraz kóduje znovu (víc práce pro procesor). Zapne se
   * sám, když diváci viděli zamrzlý obraz a kompatibilní režim to spravil - pak platí napořád.
   */
  liveCompat: boolean;
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
  /**
   * Kamera v klipech: obraz z kamery se skládá do záznamu už při nahrávání -
   * do stejného snímku jako hra, takže v klipu sedí přesně se hrou (nic se
   * dodatečně nezarovnává). Vypnuto (výchozí) = kamera se vůbec nezapíná.
   */
  clipCamera: boolean;
  /** Kamera pro klipy ('' = výchozí kamera). */
  clipCameraDevice: string;
  clipCameraPosition: LiveCameraPosition;
  clipCameraSize: LiveCameraSize;
  clipCameraShape: LiveCameraShape;
  /** Zrcadlit kameru v klipech (jak se hráč vidí sám). */
  clipCameraMirror: boolean;
  /** Šířka kamery v klipu jako podíl šířky obrazu (0,08-0,6); null = podle clipCameraSize. */
  clipCameraScale: number | null;
  /** Vlastní poloha kamery (levý horní roh, podíl obrazu 0-1); null = roh podle clipCameraPosition. */
  clipCameraX: number | null;
  clipCameraY: number | null;
  /**
   * Kamera zvlášť: nekreslí se do záznamu, ale nahrává se jako samostatný soubor
   * vedle klipu. V přehrávači jde kdykoli posunout a zvětšit (i po uložení);
   * do videa se zapeče až při nahrání na Kine, exportu nebo úpravě klipu.
   */
  clipCameraSeparate: boolean;
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
  /**
   * Ikona (zástupce) na ploše: po instalaci a po každé aktualizaci se vytvoří
   * znovu, když chybí; vypnutí ji smaže. Zástupce v nabídce Start je vždycky.
   */
  desktopShortcut: boolean;
  /** Malé okénko v rohu po uložení klipu. Když nejde (fullscreen), aspoň systémové oznámení. */
  toast: boolean;
  /** Stažená aktualizace se po lhůtě nainstaluje sama (a hned, když Kine starou verzi odmítne). */
  autoUpdate: boolean;
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
export type Look = 'classic' | 'glass';
export const LOOKS: readonly Look[] = ['classic', 'glass'];
export type LookSize = 's' | 'm' | 'l';
export const LOOK_SIZES: readonly LookSize[] = ['s', 'm', 'l'];
export type LookCorners = 'sharp' | 'normal' | 'round';
export const LOOK_CORNERS: readonly LookCorners[] = ['sharp', 'normal', 'round'];
export type GlassBackdrop = 'brand' | 'night' | 'sunset' | 'forest' | 'ocean' | 'neon';
export const GLASS_BACKDROPS: readonly GlassBackdrop[] = ['brand', 'night', 'sunset', 'forest', 'ocean', 'neon'];
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
  /**
   * ready: Kine video zpracovala a je vidět (false = nahrané, Kine ho ještě zpracovává; chybí = starší záznam, hotovo).
   * processing: kolik procent má Cloudflare zpracováno (u dlouhých videí, když to ví).
   */
  | { state: 'done'; videoId: string; url: string; ready?: boolean; processing?: number }
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
  /** Klip zmenšený (Klipy -> úložiště): jakou úrovní, kdy a kolik měl předtím. */
  compressed?: { level: 'light' | 'medium' | 'strong'; at: string; originalBytes: number };
  /**
   * Kamera nahraná zvlášť (nastavení "kamera zvlášť"): soubor vedle klipu a kde
   * v obraze leží. Přehrávač ji skládá přes video a dá ji kdykoli posunout;
   * do videa se zapeče až při nahrání, exportu nebo úpravě (editPlan.cameraBake).
   */
  camera?: ClipCamera | null;
};

/** Kamera ke klipu nahraná zvlášť. Poloha a šířka jako podíl obrazu (0-1). */
export type ClipCamera = {
  file: string;
  /** Kde v klipu začíná kamera (ms; záporné = kamera začala dřív než obraz). */
  offsetMs: number;
  /** Levý horní roh (podíl šířky / výšky obrazu). */
  x: number;
  y: number;
  /** Šířka (podíl šířky obrazu); výška podle poměru stran kamery (kruh = čtverec). */
  w: number;
  shape: LiveCameraShape;
  mirror: boolean;
  /** Rozměry záznamu kamery (px), když jsou známé. */
  width: number | null;
  height: number | null;
};

/**
 * Zmenšování klipů na pozadí: kolik je hotovo, kolik se ušetřilo, jestli
 * čeká na konec hry. finishedAt = doběhlo (okno ukáže "Ušetřeno X").
 */
export type CompressStatus = {
  running: boolean;
  level: 'light' | 'medium' | 'strong';
  total: number;
  done: number;
  skipped: number;
  savedBytes: number;
  /** Průběh právě zmenšovaného klipu (0-100). */
  percent: number;
  /** Čeká, až hra skončí. */
  paused: boolean;
  finishedAt: number | null;
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
  autoClipsLive: 'cs2' | 'lol' | 'dota2' | 'minecraft' | 'rocketleague' | null;
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
  /** Kamera v klipech: jak je na tom za běhu snímání; null = vypnutá v nastavení nebo snímání neběží. */
  clipCamera: ClipCameraStatus | null;
  /** Živé vysílání z appky. */
  live: LiveStatus;
  /** Aktualizace appky: stahuje se (průběh) / připravená k instalaci. */
  update: UpdateProgress;
  /** Poslední aktualizace neprošla - O appce řekne proč a co s tím (dokud to hráč nezavře). */
  updateIssue: UpdateIssue | null;
  /** Smart App Control ve Windows 11; null = Windows 10 / jiný systém / nejde zjistit. */
  smartAppControl: SmartAppControlState | null;
  /** Windows (Smart App Control / App Control) nepustí pomocníka - zkratky z více kláves a přesné poznání hry nejdou. */
  helperBlocked: boolean;
  /** Zmenšování klipů (Klipy -> úložiště); null = neběží ani nedoběhlo. */
  compress: CompressStatus | null;
  /** Průhledné okno je zapnuté (Windows 11, Acrylic) - pozadí okna prosvítá. */
  windowGlass: boolean;
  /** Umí tenhle systém průhledné okno (Windows 11 22H2+)? */
  windowGlassSupported: boolean;
};

/**
 * Průběh aktualizace pro okno (O appce, postranní panel, lišta): kontroluje
 * se / stahuje se (s procenty) / stažená a připravená ("Aktualizovat" =
 * restart a instalace) / čeká na konec hry / chyba.
 */
export type UpdateProgress = {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'waiting-game' | 'error';
  version: string | null;
  /** 0-100 při stahování. */
  percent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  error: string | null;
  /** Kdy nejpozději se stažená verze nainstaluje sama (ms od epochy; <= teď = hned, jak bude klid); null = nečeká se. */
  autoInstallAt?: number | null;
};

/**
 * Smart App Control ve Windows 11 blokuje programy a jejich části (DLL, kus
 * instalátoru), které nejsou digitálně podepsané: zapnuto / vypnuto /
 * zkušební režim (jen sleduje, nic neblokuje).
 */
export type SmartAppControlState = 'on' | 'off' | 'evaluation';

/**
 * Aktualizace, která neprošla (stará verze zůstala): Windows zablokoval část
 * instalátoru / soubory držel jiný program / po instalaci appka chyběla /
 * instalátor se vůbec nespustil.
 */
export type UpdateIssue = { version: string; reason: 'blocked' | 'in-use' | 'files-missing' | 'not-started' };

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
  /**
   * testNativeLoopback: zkouška bez Windows (KINE_TEST_FAKE_LOOPBACK) - zvuk hry jde rovnou přes pomocníka.
   * nativeLoopbackKnown: pomocník (zvuk hry přímo z Windows) už v tomhle běhu appky pomohl - druhý
   * pokus přes Chromium se přeskočí (snímací stránka je při každém startu nová, sama si to nepamatuje).
   */
  | { type: 'start'; settings: Settings; generation: number; testNativeLoopback?: boolean; nativeLoopbackKnown?: boolean }
  | { type: 'restart'; generation: number }
  | { type: 'stop' }
  /** Živé vysílání: druhý recorder (nižší datový tok, hra + mikrofon smíchané) na stejném snímání. */
  | { type: 'live-start'; generation: number; preset: LivePreset; audio?: LiveAudio; scene?: LiveScene }
  | { type: 'live-stop' }
  /** Změna za běhu vysílání bez nového spojení: obrazovka "Hned jsem zpět", ztlumený mikrofon, kamera. */
  | { type: 'live-scene'; scene: LiveScene }
  /** Měřáky zvuku rychle (někdo se dívá do nastavení), nebo jednou za sekundu. */
  | { type: 'meters'; fast: boolean }
  /** Kamera v klipech za běhu: jiná kamera, poloha, velikost, tvar, zrcadlo (null = bez kamery) - bez restartu zásobníku. */
  | { type: 'clip-camera'; camera: SceneCamera | null };

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
      /** Běží vedle i proud kamery (kamera zvlášť - třetí MediaRecorder, jen obraz)? */
      camera?: boolean;
      /** Zpoždění mikrofonu podle Chromia (ms; o tolik je záznam mikrofonu za skutečností). */
      micLatencyMs?: number;
      /** O kolik je zvuk hry v proudu obrazu pozadu (ms) - jen když jde přímo z Windows přes pomocníka. */
      systemLatencyMs?: number;
      /** Je v počítači hardwarový kodér H.264 (podle WebCodecs)? null = nejde zjistit. */
      hwEncoder?: boolean | null;
      /** Snímky za sekundu, se kterými se opravdu nahrává (bez hardwarového kodéru nejvýš 30). */
      fps?: number;
      /** Rozměry obrazu na začátku (podle stopy); změny pak chodí jako 'resized'. */
      width?: number;
      height?: number;
    }
  | { type: 'stopped'; generation: number; at: number }
  /** Recorder kamery zvlášť se rozjel (kamera může naběhnout až po startu obrazu) - od tohohle času se počítají její kousky. */
  | { type: 'camera-started'; generation: number; at: number }
  | { type: 'error'; generation: number; message: string }
  /** Něco nejde, ale nahrává se dál (třeba mikrofon není). */
  | {
      type: 'warning';
      generation: number;
      /**
       * systemLoopback = zvuk hry nejde otevřít; systemAudioFallback = bere se ze Stereo Mix a spol.;
       * systemAudioRetry = povedlo se na druhý pokus; systemAudioNative = bere se přímo z Windows (WASAPI, jako OBS).
       */
      kind: 'microphone' | 'camera' | 'systemAudio' | 'bluetoothMic' | 'systemLoopback' | 'systemAudioFallback' | 'systemAudioRetry' | 'systemAudioNative';
      message: string;
    }
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
   * Kamera v klipech: starting = otevírá se, on = je v záznamu (rozměry kamery), error = nejde
   * (message jako u vysílání: camera-busy / camera-missing / camera-denied / camera-unsupported /
   * camera disconnected / camera: …) - nahrává se dál bez ní a za chvíli se zkusí znovu.
   */
  | { type: 'clip-camera'; generation: number; state: 'starting' | 'on' | 'error'; message?: string; width?: number; height?: number }
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

/** Kamera v obraze (vysílání i kamera v klipech): která ('' = výchozí), kde, jak velká, jaký tvar, zrcadlo. */
export type SceneCamera = {
  deviceId: string;
  position: LiveCameraPosition;
  size: LiveCameraSize;
  shape: LiveCameraShape;
  mirror: boolean;
  /** Vlastní šířka (podíl šířky obrazu) - přebije `size`. */
  width?: number | null;
  /** Vlastní poloha levého horního rohu (podíl obrazu) - přebije `position`. */
  x?: number | null;
  y?: number | null;
};

/** Kamera v klipech za běhu snímání (stav pro nastavení); viz CaptureEvent 'clip-camera'. */
export type ClipCameraStatus = { state: 'starting' | 'on' | 'error'; message: string | null; width: number | null; height: number | null };

/**
 * Co je ve vysílání vidět a slyšet navíc k obrazovce: kamera (kde, jak
 * velká, jaký tvar), obrazovka "Hned jsem zpět" (místo hry, s textem) a
 * ztlumený mikrofon. Mění se i za běhu (live-scene) bez nového spojení.
 */
export type LiveScene = {
  camera: SceneCamera | null;
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
  /** Poslední skončené vysílání (karta v záložce Živě: záznam na Kine); null = žádné / zavřené. */
  ended: LiveEnded | null;
  /**
   * Vidí diváci obraz? Appka čte HLS vysílání u Cloudflare jako divák (main/liveHealth.ts):
   * checking = ještě se neví, ok = obraz běží, stalled = u diváků stojí, unknown / null = nejde ověřit.
   */
  health?: 'checking' | 'ok' | 'stalled' | 'unknown' | null;
  /** Kompatibilní režim: ffmpeg obraz kóduje znovu (zapne se sám, když diváci viděli zamrzlý obraz). */
  compat?: boolean;
  /**
   * Je přenos teď na Kine živě (řada Živě, stránka přenosu)? null = neví se (starší Kine,
   * ještě se neozvala). Dřív appka hlásila "diváci tě vidí" a na Kine přitom "nikdo nevysílá".
   */
  onKine?: boolean | null;
  /** Kine přenos skryla z Živě (automatická kontrola obsahu, čeká na moderátora) - ostatní ho nevidí. */
  onKineHidden?: boolean;
};

/** Co o vstupu naposledy řekl Cloudflare serveru Kine (do deníku appky - diagnostika). */
export type LiveCloudflareSeen = { lifecycle: boolean | null; listed: boolean; hls: boolean | null };

/**
 * Skončené vysílání a jeho záznam. Cloudflare každé vysílání nahrává samo;
 * z karty se záznam jedním klikem zveřejní jako video na Kine (nebo se
 * zveřejnil sám - nastavení "Po skončení vysílání").
 */
export type LiveEnded = {
  /** Kdy vysílání skončilo (ms od epochy) - zároveň id karty. */
  at: number;
  /** Kdy začalo (ms od epochy) - Zahodit bez id záznamu hledá záznamy z tohohle okna. */
  since?: number | null;
  /** Jak dlouho trvalo ("1:02:03"). */
  duration: string;
  title: string;
  /** Kine záznam zveřejňuje sama (nastavení) - čeká se, jak to dopadlo. */
  autoPending: boolean;
  /** Záznam už je video na Kine. `auto` = zveřejnil se sám. */
  video: { id: string; url: string; status: 'ready' | 'processing'; auto: boolean } | null;
  /** Zveřejňuje se (tlačítko). */
  publishing: boolean;
  /** Zveřejnit se nepovedlo: HTTP stav (404 = záznam ještě není, 409 = vysílání ještě běží, 0 = síť) a text. */
  error: { status: number; message: string } | null;
  /** Id záznamu u Cloudflare - zjistí se při prvním kroku (stáhnout / zahodit) a další míří na stejný. */
  recordingUid?: string | null;
  /**
   * Stáhnout do PC: Kine nechá u Cloudflare vyrobit MP4 (preparing), appka ho
   * stáhne (downloading) a přidá do knihovny jako nahrávku (done, file).
   */
  download?: { state: 'preparing' | 'downloading' | 'done' | 'error'; percent: number | null; file: string | null; error: string | null } | null;
  /** Záznam zahozený - smazaný u Cloudflare, nikde se neuloží. */
  discarded?: boolean;
  discarding?: boolean;
  /** Zahodit se nepovedlo - text od Kine (nebo že appka neví, který záznam to byl). */
  discardError?: string | null;
};

/** Co se záznamem po skončení vysílání (nastavení na Kine, sdílené se studiem): null = nechat ve studiu. */
export type LiveAfterStream = {
  value: Visibility | null;
  supported: boolean;
  /** Vlastní náhled přenosu na Kine (null = snímek z vysílání; undefined = starší Kine to neumí). */
  thumbnailUrl?: string | null;
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
  /** Proč zvuk hry nejde otevřít (zkráceně), když nejde. */
  systemError?: string;
  /** Zvuk hry se náhradně bere z tohohle vstupu (Stereo Mix, VB-Cable...). */
  systemFallback?: string;
  /** Zvuk hry jde přímo z Windows přes pomocníka (WASAPI loopback, jako OBS) - Chromium ho otevřít nešel. */
  systemNative?: boolean;
  /** Výchozí výstup Windows (název) - kvůli radě, když zvuk nejde. */
  defaultOutput?: string;
};

/** Zvukové zařízení pro výběr v nastavení (z enumerateDevices v okně). */
export type AudioDevice = { id: string; label: string; kind: 'input' | 'output' };
