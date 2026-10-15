# Kine do PC

Program do Windows, který běží v liště u hodin: když hraješ, drží
posledních N sekund obrazu (a zvuku, včetně mikrofonu). Zmáčkneš klávesu
a uloží se klip. Po dohrání se klipy nabídnou k nahrání na Kine – **nikdy
během hry**, aby online hra na slabší wifi nelagovala.

Z jednoho kódu se staví **dvě appky** (`src/main/variant.ts`,
`scripts/publish-config.mjs`): **Kine** („Kine do PC“) – první záložka
hlavního okna je samotné Kine (web vložený do okna, `WebContentsView`,
s přihlášením společným s appkou) a klipy s nastavením hned vedle; a
**Kine Clipper** („Kine Klipovač“) – jen klipovač, Kine se otvírá
v prohlížeči. Klipovač je součástí Kine do PC a funguje stejně; režim se
v appce nepřepíná, je dán tím, kterou appku si člověk stáhl. Anglicky
v základu, osm jazyků (stejné jako web). Pětkrát klik na logo = barva
appky (jako na webu, ukládá se i na účet).

Samostatný projekt vedle webu Kine (repo `Kine`). Web potřebuje
`/api/desktop/config`, `/api/desktop/link`, `/api/desktop/me` a stránky
`/connect`, `/download`, `/plus` (balíčky „kine-do-pc“ a „kine-do-pc-plus“).

## Jak to funguje

```
hra běží  ──►  GameWatcher (procesy z pomocníka / tasklist + okno v popředí + Steam + seznam her)
                    │
                    ▼
   skrytá stránka (Chromium getDisplayMedia + MediaRecorder, H.264)
                    │  souvislý WebM proud po sekundě
                    ▼
   ffmpeg -c copy -f segment  ──►  %TEMP%\kine-buffer\gen-N\00042.mkv (2 s kousky)
                    │                staré kousky se mažou
   zkratka (F8) ────┤  nahrávání se zastaví (přesný konec) a hned rozjede znovu
   zabití ve hře ───┤  (CS2 / Dota 2 Game State Integration, LoL Live Client API,
                    │   Minecraft logs/latest.log - GameEvents)
   Ctrl+F8 ─────────┤  nahrávání celého zápasu: od stisku se kousky nemažou,
                    │   druhý stisk je slepí do jednoho dlouhého videa
                    ▼
   ffmpeg -f concat -c copy  ──►  Videos\Kine\Kine 2026-09-21 20-14-05 CS2.mp4 + .jpg
                    │
   hra skončila ────┤  okýnko „4 klipy z CS2 – nahrát?“ (nebo automaticky)
                    ▼
   Uploader: tus po 8 MiB kusech do Cloudflare → /api/videos/confirm na Kine
             pauza, jakmile se rozjede hra; po hře pokračuje od místa, kam došel
             → /api/videos/status dokola, dokud Kine video nezpracuje („Je na Kine“)
```

- **Bez překódování.** Obraz kóduje Chromium (H.264 přes hardware
  grafiky, kde to jde), ffmpeg jen krájí a lepí. Zátěž ve hře je proto
  malá.
- **Nic se do hry nevkládá**, jen se snímá obrazovka – anticheaty nemají
  důvod protestovat.
- **Rozpoznání hry** (`src/main/gamesParse.ts`, `chooseGame`): vyhrává
  hra, jejíž **okno je v popředí** – to hlídá pomocník
  (`src/main/winHelper.ts`, jeden dlouho běžící PowerShell s
  `GetForegroundWindow`), takže CS2 před sebou vyhraje nad Robloxem
  zapomenutým na pozadí. Dál Steam (registr `RunningAppID` + název z
  `appmanifest_<id>.acf`), ~300 známých her podle názvu .exe, hry přidané
  hráčem, a **neznámý program přes celou obrazovku bez rámečku** (tak běží
  skoro každá hra; pojmenuje se podle programu, hráč ji může přejmenovat).
  Alt-tab do Discordu hru neukončí – drží se, dokud její proces běží.
  Hra, která jen běží někde na pozadí a hráč ji nemá před sebou
  (zapomenutý Roblox), se nehraje – po zavření CS2 appka čeká na další
  hru, místo aby „hrála Roblox“. Minecraft Java (`javaw.exe`) se
  potvrzuje podle příkazové řádky.
- **Zkratky** (`src/shared/hotkeys.ts`, `src/main/hotkeys.ts`): jedna
  klávesa s Ctrl/Alt/Shift jde přes systémovou zkratku Electronu; víc
  kláves najednou („F8+F9“), tlačítka myši (Mouse4/5) a klávesy jako
  Pause hlídá pomocník na Windows přes `GetAsyncKeyState`. **Ovladač**
  (Xbox / XInput, PlayStation přes Steam): tlačítka `PadA`, `PadRB`,
  `PadBack`… se do zkratky nahrají tak, že je hráč podrží, když je pole
  aktivní (Gamepad API v okně); pomocník je pak čte přes
  `XInputGetState` (`xinput1_4.dll`, záložně `xinput9_1_0.dll`) jako
  pseudo-klávesy `0x100000 + maska`, takže platí stejná pravidla jako
  pro kombinace kláves (držet všechno najednou, delší kombinace vyhrává).
  Odpojené sloty ovladače se zkouší jen každé 2 s, ať to nežere výkon.
- **Přihlášení:** přes prohlížeč (Kine `/connect` → jednorázový token →
  `http://127.0.0.1:<port>/link` nebo `kine://link?…`), nebo e-mail +
  heslo. Relace se ukládá zašifrovaná (`safeStorage`, na Windows DPAPI).
  Klíče k Supabase si appka bere z `/api/desktop/config` – nic není
  zadrátované. V režimu „Kine + klipy“ je přihlášení **společné s webem
  v okně**: přihlásíš se v appce → web v okně dostane vlastní relaci
  (`/connect/app?th=…`, stejný jednorázový token jako u `/connect`, jen
  obráceně); přihlásíš se ve webu → appka si z jeho tokenu udělá svou
  relaci. Odhlášení na jedné straně odhlásí i druhou. Obnovovací tokeny
  se nesdílí (jsou jednorázové, sdílení by jednu stranu odhlásilo).
- **Přehrávač a úpravy** (`src/renderer/player.ts`): klip se přehrává ve
  vrstvě přes okno (mřížka pod ním se nehýbe). „Upravit“ rozbalí časovou
  osu se dvěma úchyty, klávesy I/O nastaví začátek a konec, jde odstranit
  zvuk; „Uložit jako nový klip“ nebo „Nahradit původní“ – řez dělá
  `src/main/edit.ts` (ffmpeg, libx264 veryfast / libvpx u WebM), průběh
  chodí do okna. **Formát na výšku 9:16** (TikTok, Shorts, Reels): ve
  vrstvě se zastíní, co se odřízne, hráč vybere levou/střední/pravou část
  obrazu a uloží se nový klip `… (9:16)` (výška zůstane, šířka =
  výška·9/16; `crop` filtr, `editPlan.verticalCropFilter`), nebo čtvrtou
  volbu **Rozmazané pozadí**: celý obraz zmenšený doprostřed a nad ním
  i pod ním rozmazaná kopie (`split` → `crop`+`boxblur` / `scale` →
  `overlay`, jeden filtergraph do `-vf`). Původní se nikdy nepřepisuje.
  V úpravách je i **Náhled z tohohle snímku**: snímek, na kterém
  přehrávač stojí, se stane náhledem klipu (`clips:thumbFrame`, ffmpeg
  `-ss`; nový soubor náhledu, starý se smaže).
  **Rychlost** 0,5× – 2× (zpomalení i zrychlení): obraz `setpts` + `fps`
  zdroje (bez toho by zpomalení ztrácelo snímky a zrychlení mělo 120 fps),
  zvuk `atempo` (hlas nezmění výšku), délka se omezuje už při čtení (`-t`
  před `-i`); náhled v úpravách hraje zvolenou rychlostí.
  **Text ve videu** (nahoře / uprostřed / dole; obrys, tmavý pruh, žlutý
  pruh; tři velikosti): přibalený ffmpeg nemá `drawtext`, proto text
  kreslí okno na canvas písmem Inter (nejvýš tři řádky, dlouhý se zmenší)
  a hlavní proces ho jako PNG jen položí na obraz (`overlay`, po výřezu
  9:16 i po změně rychlosti – vše jedním `-filter_complex`,
  `editPlan.trimArgs`). Náhled textu ve vrstvě je přesně ten obrázek,
  který se uloží.
  **GIF** (třetí formát): úsek do 15 s, 480 px, 15 fps, paleta +
  dithering (`editPlan.gifArgs`), bez zvuku, soubor `.gif` vedle klipu
  (do knihovny nepatří - tam jsou jen videa), tlačítko „Ukázat ve složce“.
  **Šipky po stranách** přepnou na předchozí / další klip podle mřížky,
  jak ji hráč vidí (filtry, řazení), stejně klávesy ↑ ↓; v hlavičce je
  „3 / 24“, u nahraného klipu „Kopírovat odkaz“. Klávesy: mezerník,
  ← → (±1 s, se Shiftem 5 s), M ztlumí, F celá obrazovka, I/O v úpravách.
  Hlasitost si přehrávač pamatuje.
- **Živé vysílání na Kine bez OBS** (záložka „Živě“, tlačítko „Vysílat“
  v panelu, položka v liště): název, kvalita (720p30 3 Mb/s / 1080p30
  4,5 Mb/s / 1080p60 6 Mb/s), **kamera v rohu** (roh, velikost, kulatá /
  zaoblená, zrcadlení), **„Hned jsem zpět“** (vlastní text, zkratka, při
  ní se ztlumí mikrofon), ztlumení mikrofonu, živé údaje (kb/s, fps,
  fronta v rouře) a **počet diváků** z Kine. Kamera i scény se přepínají
  za běhu bez odpojení (příkaz `live-scene`); skládání obrazu dělá
  `src/renderer/liveCompositor.ts` (MediaStreamTrackProcessor/Generator
  + OffscreenCanvas) - bez kamery a „Hned jsem zpět“ jde obraz beze
  změny (žádná práce navíc). Klíč si appka vezme z Kine (`/api/live/me`,
  stejný jako pro OBS ve studiu) a každých 15 s hlásí, že vysílá - web
  ukáže „živě“ hned, ne až když přenos najde Cloudflare. Snímací stránka pustí třetí recorder na stejném
  snímání - kopie obrazové stopy zmenšená na kvalitu vysílání, zvuk hry
  a mikrofonu smíchaný přes Web Audio (hlasitosti z nastavení, omezovač),
  vždy H.264, klíčový snímek každé 2 s - a jeho kousky jdou rourou do
  ffmpeg: obraz beze změny, zvuk na AAC, FLV přes RTMPS na Cloudflare
  (`src/main/live.ts`, čistá část `livePlan.ts`). Výpadek se připojí znovu
  sám (2, 3, 5… s, nová „generace“ = nový recorder a ffmpeg), špatný klíč
  se neopakuje, visící spojení hlídá hlídač, nestíhající upload se ohlásí.
  Klipy se během vysílání ukládají dál; zásobník se během vysílání
  nevypne (konec hry, pauza, přepínač), a když ho rozjelo jen vysílání,
  po konci se zase vypne. V Kine do PC je nad webem čas vysílání
  a „Ukončit“, stránka vysílání s chatem se otevře v okně. Zkouška:
  `KINE_TEST_LIVE_URL` = místní RTMP server (ffmpeg `-listen 1`).
- **Momenty v nahrávce zápasu**: každý klip uložený během nahrávání
  (zkratkou i sám ze zabití) je značka v nahrávce. V přehrávači jsou pod
  videem jako tlačítka (skok 10 s před okamžik uložení), v úpravách
  žluté značky na časové ose, na kartě vlaječka s počtem. Na Kine jdou jako
  **kapitoly** videa (i do popisu: „0:00 Začátek / 4:55 Triple kill“),
  po zkrácení se posunou (`editPlan.shiftMarkers`).
- **Knihovna klipů** (`src/renderer/settings.ts`): řazení (nejnovější,
  nejstarší, nejdelší, největší), `/` skočí do hledání; najetí myší na kartu
  tiše přehrává klip (jeden náhled naráz, po odjetí se pustí z ruky);
  hvězdička = oblíbený (`Clip.favorite`) a filtr „Oblíbené“; zaškrtávátka
  na kartách vyberou víc klipů a lišta nad mřížkou je **spojí do jednoho
  klipu** (sestřih: `editPlan.mergePlan` - společný rozměr s černými
  pruhy místo roztažení, společné fps, zvuk 48 kHz stereo a ticho tam,
  kde klip zvuk nemá, `concat` filtr, libx264), nebo je naráz nahraje či
  smaže. Sestřih je nový klip `Kine … sestřih.mp4`, původní zůstávají.
  Kartu jde **přetáhnout ven z okna** (Discord, prohlížeč, Průzkumník) -
  `ondragstart` → `clips:dragStart` → `webContents.startDrag` se souborem
  a náhledem jako ikonou.
- **Koš** (`src/main/clips.ts`): smazání klip nemaže, přesune soubor do
  `<složka s klipy>/.trash` a klip dostane `deletedAt`; v knihovně je
  tlačítko **Koš (N)** s kartami „Vrátit“ / „Smazat nadobro“ a „Vysypat
  koš“. Po 7 dnech (`TRASH_DAYS`) zmizí samy (při startu a jednou za
  hodinu). Klip v koši se nenahrává ani neukazuje jinde. V Záznamu je
  přehled **Úložiště**: klipy, koš, zásobník a volné místo na disku
  (`storage:info`, `statfs`), s varováním pod 5 GB.
- **Nahrávání celého zápasu** (`capture.ts` → `startRecording` /
  `stopRecording`): zkratka (výchozí Ctrl+F8, jde vypnout), tlačítko
  **Nahrát zápas** v postranním panelu (za běhu tiká čas a je z něj
  Zastavit), položka v nabídce u hodin (ikona u hodin má červenou tečku).
  Zásobník musí běžet - nahrávka jsou jeho kousky, které se od startu
  nemažou (`prune` je nechá), stop je slepí stejně jako klip (`-c copy`,
  H.264 s AAC), takže se nic nepřekóduje a hra to nepocítí. Uloží se jako
  klip s `kind: 'recording'` (odznak **REC** v knihovně i po hře), název
  „Hra · nahrávka 23. 9. 20:14“, soubor `… recording.mp4`. Strop 3 h
  (`RECORDING_MAX_SECONDS`) a hlídání volného místa (pod 2 GB se
  nahrávka sama uloží a skončí, kontrola po 30 s). Konec hry, pauza,
  změna kvality, vypnutí zásobníku i ukončení appky rozjetou nahrávku
  nejdřív uloží. Po hře se nahrávka nabídne v okýnku, ale nepředzaškrtne
  se a v režimu „nahrát všechno“ se nenahrává sama (hodiny videa jen na
  přání hráče). Popis na Kine: „Celý zápas …“.
- **Postranní panel:** nahoře Kine a Klipy, pod hlavičkou Nastavení
  Záznam / Hry / Nahrání a sdílení / Účet / O appce (každá položka
  s ikonou), dole karta stavu: co appka dělá, jak dlouhý zásobník drží
  a jakou zkratkou se klip uloží, tlačítka **Uložit klip** a
  **Pozastavit / Pokračovat** (v ručním režimu Zapnout/Vypnout
  zásobník), a účet (avatar, @jméno, PLUS) nebo Přihlásit se.
- **Klipy samy z událostí ve hře** (`src/main/gameEvents.ts`, čistá část
  `gameEventsParse.ts` s testy): appka pozná zabití a uloží klip bez
  zkratky – v základu od dvojnásobného zabití výš („Dvojité zabití“,
  „Trojité“, „Čtyřnásobné“, „Ace“ v názvu klipu), volitelně každé zabití,
  nebo vypnuto. **CS2**: oficiální *Game State Integration* – appka
  poslouchá na `127.0.0.1:27381` (nebo dalším volném do 27385) a do
  `steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/` zapíše
  `gamestate_integration_kine.cfg` (s náhodným tokenem, aby jí nic
  cizího nepodstrkovalo události); hra ho načte při dalším spuštění a
  posílá stav po každé změně. Počítá se jen vlastní hráč (steamid
  pozorovaného = steamid hráče), ne spoluhráči při sledování. **League of
  Legends**: *Live Client Data API* hry (`https://127.0.0.1:2999/liveclientdata/…`),
  dotaz každé 2 s, jen když běží `League of Legends.exe`; události
  `ChampionKill`/`Multikill`/`Ace` s hráčem jako zabijákem. Série zabití se
  spojí do jednoho klipu (3,5 s klid, nejvýš 12 s), klip vzniká až po
  konci série, aby v něm bylo všechno. **Dota 2**: stejný GSI server
  (zprávy se poznají podle `provider.appid` 570 / 730), cfg se zapíše do
  `game/dota/cfg/gamestate_integration/` (podsložka se založí), zabití =
  nárůst `player.kills`. **Minecraft (Java)**: hra nic neposílá, ale
  všechno z chatu zapisuje do `logs/latest.log` - appka soubor sleduje
  (od konce, každých 1,5 s; složka z `--gameDir` příkazové řádky, jinak
  `%APPDATA%\.minecraft`), jméno hráče má z řádku `Setting user:`, a
  klipuje **smrt** (anglická znění zpráv o smrti), **PvP zabití** („… by
  <hráč>“) a **pokrok** („has made the advancement“ v kterémkoli jazyce
  podle názvu pokroku v závorkách). Smrt a pokrok jsou samostatné klipy
  („Smrt“, „Pokrok“ v názvu), zabití jdou do série jako jinde.
  **Název automatického klipu nese kontext**: u CS2 mapa a skóre
  z pohledu hráče („Trojité zabití · Mirage 7:5“), u Doty hrdina
  („Dvojité zabití · Crystal Maiden“). Ani jedno není zásah do hry – jsou
  to rozhraní, která hry samy nabízejí (stejně je používá Medal, Overwolf,
  Allstar).
- **Nahrání na Kine s nastavením** (`src/renderer/uploadDialog.ts`):
  tlačítko Nahrát v knihovně (a ⚙ u klipu, ⚙ v okýnku po hře) otevře
  vrstvu se stejnými poli, jaká má web při nahrávání - název, popis
  (předvyplněný podle hry), hashtagy (předvyplněné `#klip` + hra +
  hashtagy z nastavení; u víc klipů se píšou jen společné navíc),
  viditelnost **veřejné / jen odběratelé / soukromé**, kategorie (15,
  stejné klíče jako web), jazyk, „pro děti“ / placená propagace / AI,
  a **náhled z appky jako náhled videa na Kine** (nahraje se do úložiště
  `thumbnails` přes relaci hráče, jako to dělá web). V Nahrání a sdílení
  jde nastavit, jestli se appka před nahráním ptá (jinak Nahrát pošle
  klip rovnou s výchozím), hashtagy ke každému klipu, výchozí kategorie
  a posílání náhledu. Požadavek na nahrání (`UploadRequest`,
  `shared/types.ts`) se uloží ke klipu (`uploadOptions`), takže přežije
  restart appky; hlavní proces všechna pole očistí (`sanitizeUploadRequests`).
- **„Je na Kine“ až doopravdy:** Kine video po nahrání teprve zpracovává
  (Cloudflare) a do té doby ho v žádném seznamu neukazuje. Dřív se appka
  po potvrzení už nezeptala, takže video mohlo na Kine viset jako
  „zpracovává se“ donekonečna (webhook od Cloudflare není nastavený a
  doptával se jen prohlížeč). Teď se appka ptá `/api/videos/status`
  podle rozvrhu (3 s / 10 s / 30 s, do ~45 min; `readySchedule`), karta
  ukazuje „Nahráno · Kine ho zpracovává…“ a teprve po `ready` „✓ Na Kine“
  s oznámením; po restartu se čekání naváže (`upload.ready === false`).
  Web má k tomu záchranu na své straně (`sweepProcessing`, viz repo Kine).
- **Zvuk hry** (`src/renderer/capture.ts`): na Windows se bere „zvuk systému“
  - Chromium loopback **výchozího výstupního zařízení Windows** (`audio:
  'loopback'` v `setDisplayMediaRequestHandler`). Když hra hraje jinam
  (jiné sluchátka zvolené ve hře nebo ve Windows > Zvuk > hlasitost
  aplikací), nahrává se ticho, i když hráč hru slyší. Proto: v Záznamu
  jsou **živé měřáky** zvuku hry a mikrofonu (AnalyserNode jen na měření,
  10x za sekundu, když je Záznam otevřený - `audio:watch`, jinak jednou za
  sekundu; proužek nahoru hned, dolů pomalu), pod nimi „Zvuk hry se bere
  z: <zařízení>“, a když je zvuk hry 10 s digitální nula, nápověda co s
  tím (u sluchátek Bluetooth vlastní); při běžící hře a 20 s ticha jednou
  upozornění (`toastSystemAudioSilent`). Hráč může zvuk hry brát i **z
  jiného záznamového zařízení** (`systemAudioDevice`: Stereo Mix, „What U
  Hear“, VB-Cable), vybrat **mikrofon** (`microphoneDevice`) a nastavit
  **hlasitost hry a mikrofonu v klipu** (`systemGain`, `micGain`, 0-200 %).
  Změna výchozího výstupu Windows za běhu (`devicechange`) snímání rozjede
  znovu, protože loopback zůstává na starém zařízení.
- **Zvuk sedí na obraz (0.9.3).** Zvuk hry jde do stejného MediaRecorderu
  jako obraz, **bez Web Audio** (to dřív při míchání přidávalo zpoždění a
  zvuk ujížděl). **Mikrofon má vlastní MediaRecorder** a vlastní segmenter
  (`m00042.mka`, `mic.csv`) a do klipu se přimíchá až při uložení:
  `planClip` (`src/main/segments.ts`) položí každý kousek mikrofonu podle
  hodin počítače na místo vůči obrazu STEJNÉ generace (i přes mezery po
  uloženém klipu), odečte zpoždění mikrofonu podle Chromia
  (`getSettings().latency`), ffconcat s `duration`/`outpoint`, `aresample
  async` proti ujetí; `clipMuxArgs` (`src/main/editPlan.ts`) smíchá
  (`amix normalize=0` + `alimiter latency=1`, ať limiter nezpožďuje).
  Ověřeno skutečným ffmpeg: klik v obraze, zvuku hry i mikrofonu do 2 ms.
  Ruční **posun zvuku** ±300 ms (`audioOffsetMs`) pro případ, že by přesto
  něco nesedělo. Výsledný zvuk AAC 192 kb/s.
- **Hra a mikrofon zvlášť.** Klip s oběma má tři stopy: *Hra + mikrofon*
  (výchozí, hraje všude), *Hra*, *Mikrofon* (`separateMicTrack`, zapnuté).
  V úpravách je místo „bez zvuku“ výběr **Hra + mikrofon / Jen hra / Jen
  mikrofon / Bez zvuku** (`trimAudioPlan`) - klip jde uložit bez vlastního
  hlasu. Kamarádi z hlasového chatu ve hře jsou ve zvuku hry. Na Kine jde
  takový klip **jen se smíchanou stopou** (Kine hraje jednu a nikde není
  psáno, kterou by vybral): kopie bez překódování v `userData/upload-cache`
  (`prepareFile` v uploaderu), přežije restart kvůli navázání, po nahrání
  zmizí.
- **Sluchátka Bluetooth.** Jakmile cokoli otevře mikrofon sluchátek
  Bluetooth, Windows je přepne do režimu hovoru (HFP): všechno zní hůř,
  mono, a zvuk hry jde na jiné „zařízení“, které loopback nenahrává -
  ticho. Appka proto výchozí mikrofon Bluetooth **sama vynechá** (vezme
  jiný vstup, nebo nahrává bez mikrofonu), řekne to (`bluetoothMic`) a v
  seznamu mikrofonů je u Bluetooth varování. Ručně vybraný se použije.
- **Kvalita a zátěž.** Výchozí 1080p / 60 fps / 20 Mb/s (nastavení v3:
  kdo měl staré výchozí 1080p30 8 Mb/s, dostane nové; vlastní hodnoty
  zůstávají). Snímací stránka před startem zjistí, jestli grafika umí
  kódovat H.264 (`VideoEncoder.isConfigSupported`, `prefer-hardware`):
  s hardwarem profil High, bez něj se nahrává nejvýš 30 fps (procesor by
  jinak hru brzdil). V Záznamu je vidět, čím se kóduje, předvolba
  „Doporučené (1080p60)“ a „Nízká zátěž“. `contentHint = 'motion'`.
- **Nahrávka zápasu přežije pád.** Při nahrávání celého zápasu leží ve
  složce zásobníku `recording.json` a v každé generaci `gen.json` (start,
  formát, zvuk). Spadne-li appka nebo Windows, při dalším startu se
  složka místo smazání odloží (`<název>.recover-*`, `salvageLeftovers`) a
  slepí jako nahrávka „obnoveno po pádu“ (`recoverLeftovers`,
  `recoverySegments`); když složku ještě drží spadlý ffmpeg, nechá se být
  a zásobník jde vedle. Spadne-li snímání za běhu (snímací stránka,
  ovladač grafiky, obrazovka přestane posílat obraz, chyba kodéru -
  `onState(..., runtime)`), kousky nahrávky se odloží a slepí hned a
  zásobník se za 3 s sám rozjede znovu (nejvýš 3x za 10 minut,
  `restartAfterCrash`) - dřív stál až do konce hry. I zastavení nahrávky
  ve chvíli pádu (hra spadla s ním) kousky nezahodí (`interrupted`).
- **Diagnostika.** O aplikaci > „Zkopírovat diagnostiku“: verze, systém,
  grafika, kodér, nastavení snímání a zvuku, hladiny a konec protokolu do
  schránky - bez jména uživatele ve cestách a bez e-mailů.
- **Klipy na výšku v knihovně** mají stejně velký náhled jako ostatní
  (16:9, obraz uprostřed na rozmazaném pozadí, štítek 9:16).
- **Zkoušky zvuku:** `KINE_TEST_FAKE_AUDIO=1` dá Chromiu falešný mikrofon
  s tónem a ověří měřáky i slyšitelný zvuk v klipu (`volumedetect`);
  `=full` k tomu vezme falešný vstup jako „zvuk hry“ a ověří klip se třemi
  stopami a ořez „jen hra“.
- **Kine v prohlížeči (Kine Clipper):** „Otevřít na Kine“ jde přes
  `/connect/app` s jednorázovým tokenem, takže se prohlížeč přihlásí
  stejným účtem jako appka - čerstvě nahraný (soukromý) klip je hned
  vidět, i když v prohlížeči nikdo přihlášený nebyl. Bez přihlášení v
  appce jde odkaz rovnou.
- **Sdílení:** u nahraného klipu je „Kopírovat odkaz“ (odkaz na Kine do
  schránky) a „Poslat na Discord“ – webhook kanálu se vyplní v záložce
  Nahrání a sdílení. Nahraný klip se pošle jako název + odkaz, **nenahraný
  rovnou jako soubor** (multipart, do 10 MB - `DISCORD_FILE_MAX_BYTES`;
  větší má tlačítko vypnuté s vysvětlením), a hotový **GIF má v přehrávači
  tlačítko Poslat na Discord** (`shareFileToDiscord`, jen soubory ze
  složky s klipy).
- **Dvě appky vedle sebe** se hlídají: hlídání her dává každé kolo (5 s)
  seznam procesů i hlavnímu procesu (`onProcesses`); Kine Clipper se při
  běžícím `Kine.exe` sám vypne (klipovač je v Kine do PC), Kine při
  běžícím `Kine Clipper.exe` upozorní. Zkratka, kterou držel druhý
  program, se každých 15 s zkouší zaregistrovat znovu (`HotkeyManager.retry`).
  Každá appka má vlastní složku zásobníku (`%TEMP%\kine-buffer`,
  `%TEMP%\kine-clipper-buffer`); když ji nejde vyčistit (EPERM - drží ji
  jiný proces), vezme se `<název>-<pid>` místo pádu nahrávání.
- **Ikona v barvě hráče** (`src/main/icon.ts`): ikona okna a ikona u hodin
  se přebarví podle zvolené barvy Kine (tyrkys v PNG se nahradí, tmavý
  podklad zůstane); značka v panelu je SVG v `--brand`. Ikona .exe a
  zástupce zůstává tyrkysová (za běhu se měnit nedá).
- **Aktualizace** (`src/main/updater.ts`, čistá část `updaterParse.ts`):
  kontrola po startu a každých 6 h. Zkouší postupně zdroj z
  `app-update.yml` (naše úložiště R2, nebo GitHub), pak GitHub Releases
  přímo a nakonec web Kine (`/api/desktop/latest`) - když automatické
  stažení nejde, řekne aspoň „je venku verze X“ s tlačítkem ke stažení,
  a v záložce O appce je vidět i důvod (např. `404 latest.yml`). Stahuje
  se **jen když se nehraje** (vyšla-li verze během hry, stáhne se po
  ní), instaluje po ukončení appky.
- **Web Kine v okně spí**, když ho nikdo nevidí: při přepnutí na jinou
  záložku, zmenšení okna a hlavně **po celou dobu, co běží hra** se
  zastaví přehrávání, ztlumí zvuk a omezí běh na pozadí
  (`sleepKineView`) - procesor, grafika i síť patří hře. Při návratu
  na záložku (a bez hry) se probere.
- **Po hře** umí okýnko s klipy **spojit vybrané do jednoho klipu**
  (sestřih z celého hraní) - spojený klip zůstane vybraný k nahrání,
  původní se odškrtnou. Popis nahraného videa je v jazyce appky a končí
  odkazem na stažení appky (`uploadDescription*`).
- **Výkon appky** (`src/shared/performance.ts`): jedna volba v Záznamu -
  Úsporný / Vyvážený / Výkon - řídí, jak často se appka na co ptá: hlídání
  her (10 / 5 / 2 s), smyčka pomocníka pro kombinace kláves a ovladač
  (50 / 30 / 15 ms), popředí a seznam procesů, dotazy na LoL (4 / 2 / 1 s),
  náhledy při najetí (v úsporném vypnuté) a kontrola aktualizací (1× denně
  / 6 h). Změna se projeví hned (restart smyčky pomocníka a hlídání her).
  Kvalitu klipů to nemění - ta je zvlášť; v úsporném režimu se nabídne
  tlačítko Nízká zátěž (720p).
- **Po aktualizaci** appka jednou řekne, že běží nová verze
  (`toastUpdated`, klik otevře O appce); pamatuje si `lastVersion`.
- **Zátěž při hraní** je záměrně malá: pomocník pro Windows se bez
  složených zkratek ptá jen jednou za sekundu (s nimi každých 30 ms, aby
  neušel stisk), programy a okna čte přes Win32 API (`EnumProcesses`,
  `QueryFullProcessImageName`, `EnumWindows`) místo `Get-Process`, a
  appka díky tomu nespouští každých pár sekund `tasklist` ani `reg`.
  Hlídání her jede jednou za 5 s. V nastavení kvality je tlačítko **Nízká
  zátěž (720p)** – 720p / 30 fps / 5 Mb/s jedním klikem.

## Novinky 0.9.6

- **Klip hned:** okénko „Ukládám klip…“ vyskočí v okamžiku stisku zkratky
  (ne až po uložení) a pak se změní na „Klip uložen“.
- **Konec nahrávky zápasu:** stav „Ukládám…“ s procenty hned po kliknutí;
  další kliknutí nahrávku neuloží znovu (jedno ukládání, `finishRecording`).
- **Žádná okénka po spuštění:** problémy (zkratka obsazená, mikrofon…) jsou
  tichá upozornění v okně; okénkem jen jednou, když začne hra a klipovací
  zkratka pořád nejde - nejdřív 45 s po spuštění appky.
- **Po spuštění:** volba Snímat hned / až se hrou / pozastavené
  (`launchCapture`).
- **Méně zátěže:** pomocník (PowerShell) posílá jen změny, ffmpeg zásobníku
  a ukládání nahrávek běží s nižší prioritou, na baterii 720p · 30 fps,
  přehled spotřeby appky v Nastavení.
- **Místo na klipy:** strop (20-500 GB); nejstarší klipy se smažou samy -
  nikdy oblíbené, nahrávané na Kine ani čerstvé (hodinu od uložení).
- **Vysílání:** záložka Živě (kamera, „Hned jsem zpět“, diváci, viz výš).

## Novinky 0.9.7

- **Aktualizace s průběhem:** O appce ukazuje stahování nové verze
  (procenta, MB, rychlost) a pak jedno tlačítko **Aktualizovat teď** -
  appka se zavře, tiše nainstaluje novou verzi a sama se znovu spustí
  (`installUpdateNow` -> `quitAndInstall(true, true)`). Během vysílání a
  nahrávání zápasu to nejde (o vysílání by hráč přišel). Stejné tlačítko
  je v liště u hodin a odkaz v postranním panelu. Kine Clipper má v O appce
  svůj název.
- **Zvuk hry nejde otevřít** (chyba „the audio source could not be
  opened“): snímání to samo zkusí znovu, pak vezme zařízení, které zvuk
  počítače umí nahrát (Stereo Mix, VB-Cable, Voicemeeter), a když nic,
  řekne proč, jaké je výchozí zařízení a co s tím (4 kroky, tlačítko Zkusit
  znovu a Zvuk ve Windows). V seznamu zdrojů jsou taková zařízení zvlášť od
  mikrofonů; v diagnostice je řádek „Game audio“.
- **Záznam vysílání na Kine:** po skončení vysílání je v záložce Živě karta
  se záznamem - název, kdo ho uvidí a **Zveřejnit záznam na Kine**
  (`/api/live/recordings`, `videoUid: 'latest'`). Nebo se zveřejní sám:
  volba **Po skončení vysílání** (stejné nastavení jako ve studiu na webu,
  ukládá se na Kine). Zveřejněný záznam na webu přehrává i záznam chatu.
- **Chat v okně:** chat vlastního vysílání v malém okně (dá se nechat
  nahoře nad hrou v okně bez rámečku), včetně moderování.
- **Vzhled (Nastavení -> Vzhled):** klasický nebo **sklo** - průhledné
  plochy nad barevným rozmazaným pozadím (moje barva, Noc, Západ slunce,
  Les, Oceán, Neon), posuvník průhlednosti, barva appky přímo v nastavení.
  Na Windows 11 jde zapnout **průhledné okno** (Acrylic - prosvítá plocha za
  appkou; `setBackgroundMaterial`). Pozadí je jedna vrstva `.app-backdrop`,
  nic se nerozmazává za běhu.
- **Přehrávač klipů přes celou obrazovku** (F, dvojklik, ⛶): celá scéna
  i se šipkami na předchozí / další klip, nahoře název a pozice „3 / 12“;
  ovládání se po chvíli bez pohybu myši schová.
- Nahrání bez přihlášení hlásí přeloženou chybu (dřív česká odpověď
  serveru i v angličtině); klik na okénko vede do Účtu.

## Vývoj

```
npm install
npm start          # sestaví (esbuild + tsc) a spustí Electron
npm test           # testy čisté logiky (segmenty, hry, tus, uploader…)
```

Užitečné proměnné prostředí:

| proměnná | k čemu |
| --- | --- |
| `KINE_DEBUG=1` | protokol i na stdout (jinak jen `%APPDATA%\kine-desktop\logs\kine.log`) |
| `KINE_USER_DATA=…` | jiná složka s nastavením (zkoušky) |
| `KINE_FFMPEG=…` | vlastní ffmpeg místo přibaleného |
| `KINE_TEST=1` | samočinná zkouška: zásobník → dva klipy → přehrávač, úpravy, 9:16, GIF, sestřih, oblíbené, panel → screenshoty → konec (`tests/e2e.sh`) |
| `KINE_TEST_LIVE_URL` | (se `KINE_TEST`) vysílání jde sem místo na Kine - `tests/e2e.sh` pouští místní RTMP server a kontroluje, co přišlo |
| `KINE_NO_HELPER=1` | nespouštět pomocníka pro Windows (hry jen podle seznamu a Steamu, jen jednoduché zkratky) |
| `KINE_VARIANT=clipper` | při vývoji se chovat jako appka Kine Clipper (zabalená appka to má v package.json) |

Adresu Kine jde v nastavení (Účet → Adresa Kine) přepnout třeba na
`http://localhost:3000`.

## Vydání nové verze

1. V `package.json` zvedni `version`.
2. Nahraj soubory do repa (git, nebo přes web GitHubu) a spusť workflow
   **Vydání** (nebo pushni tag `v0.2.0`).
3. GitHub Actions (`.github/workflows/release.yml`) na Windows sestaví
   obě appky – `Kine-Setup.exe` (Kine do PC) a `Kine-Clipper-Setup.exe`
   (Kine Clipper) – a nahraje je do **Cloudflare R2** do složek `full/`
   a `clipper/` (odsud stahují lidi z `kine…/download` a odsud si
   nainstalované appky berou aktualizace podle `latest.yml`) a záložně do
   GitHub Releases. `scripts/publish-config.mjs` k tomu z proměnných
   prostředí sestaví `electron-builder.generated.yml` (Kine) a
   `electron-builder.clipper.yml` (Kine Clipper): název, ikona, appId,
   složka s aktualizacemi, podpis. Instalátor je jen anglicky. Krok za
   krokem včetně R2 a podpisu: **JAK-VYDAT.md**.

**Podpis:** bez certifikátu Windows ukáže „Neznámý vydavatel“ a SmartScreen
varuje. S Azure Trusted Signing (tajemství `AZURE_*` v GitHubu) workflow
podepisuje sám.

## Struktura

```
src/main/        hlavní proces (Electron, Node)
  main.ts        tray, okna (nastavení/klipy, okýnko po hře, okno Kine), IPC
  variant.ts     která ze dvou appek běží (Kine / Kine Clipper) - název, ikona, režim
  icon.ts        ikona okna a lišty přebarvená podle barvy Kine hráče
  capture.ts     zásobník: skrytá stránka → ffmpeg segmenty → klip
  segments.ts    čistá logika výběru kousků, plán klipu s mikrofonem, obnova po pádu (test)
  games.ts       hlídání her (procesy, Steam, popředí), gamesParse.ts čistá část (test)
  gameEvents.ts  klipy samy z událostí: CS2 Game State Integration (lokální server + cfg), LoL Live Client API
  gameEventsParse.ts  čistá část: rozbor událostí CS2/LoL, série zabití, obsah cfg (test)
  edit.ts        zkrácení / ztlumení / výřez 9:16 / rychlost / text, sestřih víc klipů, GIF (ffmpeg), náhled k upravenému klipu
  live.ts        živé vysílání na Kine: klíč z Kine, ffmpeg -> RTMPS, znovupřipojení, hlídač
  livePlan.ts    čistá část vysílání: adresa, argumenty ffmpeg, průběh, pokusy (test)
  editPlan.ts    čistá část úprav: slepení klipu se stopami zvuku, zkrácení (trimArgs), sestřih, GIF, momenty, rozbor hlavičky ffmpeg (test)
  winHelper.ts   pomocník pro Windows: podepsaný kine-helper.exe (src/helper/KineHelper.cs), jinak PowerShell + C# přes Add-Type: okno v popředí, procesy, okna, Steam, stav kláves
  hotkeys.ts     zkratky: systémové (Electron) + složené přes pomocníka
  clips.ts       knihovna klipů (index.json ve složce s klipy)
  updater.ts     aktualizace: R2 / GitHub / web Kine jako záloha, stahování až po hře; updaterParse.ts čistá část (test)
  uploader.ts    fronta nahrávání, pauza při hře (test), tus.ts klient (test)
  auth.ts        přihlášení, lokální server pro /connect, kine:// odkazy
  kineApi.ts     volání Kine (create-upload-url, confirm)
  settings.ts    nastavení (userData/settings.json), shared/settingsSchema.ts (test)
  toast.ts       okénko „Klip uložen“ v rohu
src/renderer/    stránky oken: settings (postranní panel s kartou stavu, záložka Kine s lištou,
                 klipy s filtry / oblíbenými / výběrem a sestřihem, nastavení, průvodce),
                 player (přehrávač + úpravy klipu ve vrstvě: řez, 9:16, GIF, rychlost, text, momenty), review
                 (okýnko po hře), toast, capture (skrytá snímací)
src/preload/     most window.kine / window.kineCapture
src/shared/      typy, překlady (i18n/: en cs sk de pl es fr uk), názvy klipů, zkratky, plány, výkon (performance.ts)
```

## Předplatné

Pravidla jsou v `src/shared/plan.ts` a na webu v `lib/plus.ts`; appka se
ptá `/api/desktop/me`, kdo je a co smí. Tři varianty: **Kine Plus**
(web: odznak, vyšší limit nahrávání), **Klipy Plus** (appka: „nahrát
všechny klipy automaticky“, klipy až 5 minut) a **Kine Plus + Klipy**.
Zdarma: klipování bez omezení, klipy do 60 s, nahrání na Kine ručně
(okýnko po hře, záložka Klipy) – se stejnými pravidly jako každé video.
Když Klipy Plus vyprší, appka se sama vrátí na ruční nahrávání. Barvu
Kine, kterou má hráč u loga na webu, appka převezme z jeho účtu.

## Co ještě není

- macOS/Linux: appka se spustí a klipy dělá, ale bez zvuku systému
  (Chromium ho umí jen na Windows), bez pomocníka (hry jen podle seznamu
  a Steamu, jen jednoduché zkratky).
- Klip je dlouhý N až N+2 s (kousky po 2 s, řez jen na klíčovém snímku).
  Když hra mezitím přepnula rozlišení, klip začíná až od místa, kde má
  obraz stejné rozměry (jinak by ho prohlížeč nepřehrál).
- Náhledy klipů (první snímek videa) leží v `%APPDATA%\kine-desktop\thumbs`,
  ve složce s klipy jsou jen videa.
- Hry v režimu *exclusive fullscreen* okénko „Klip uložen“ neukážou –
  přijde zvukové pípnutí a systémové oznámení.
- Klipy samy z událostí umí zatím jen CS2 a League of Legends (jediné
  velké hry s oficiálním rozhraním pro stav hry). U CS2 se cfg zapíše, až
  když appka běží s CS2 nainstalovaným přes Steam; hra ho načte při
  dalším spuštění. Ostatní hry: jen zkratka.
- Zkratka na ovladači je podle dokumentace XInput a projde testy, ale na
  skutečném ovladači zatím vyzkoušená není (tady žádný není). Ovladač
  připojený přes Bluetooth bez XInputu (starší DualShock bez Steamu)
  appka nevidí.

## Novinky 0.9.8

- **Barvy podle obrazu (Nastavení -> Vzhled):** kolem přehrávače klipů
  svítí barvy videa (jako ambientní režim na YouTube) a se sklem se pozadí
  appky mění podle klipu, na který se díváš - i podle karty pod myší.
  Levně: obraz se kreslí do malinkého plátna (desítky pixelů) už rozmazaný
  a jen se roztáhne, žádný filtr přes celé okno ani čtení pixelů
  (`src/renderer/ambient.ts`). Funguje i v klasickém vzhledu (jen světlo
  kolem přehrávače).
- **Pohyblivé barvy:** se sklem se barvy pozadí pomalu přelévají (jen
  posun vrstev; s vypnutými animacemi ve Windows stojí).
- **Kine na vlastní doméně:** appka si novou adresu webu vezme sama
  (`src/main/siteMove.ts`) - po startu a jednou denně se zeptá webu na
  hlavní adresu (`/api/desktop/config`) a přejde na ni, jen když tam běží
  stejné Kine (stejná databáze) a nová adresa to potvrdí. Nikdy zpátky na
  `*.vercel.app` a nikdy z localhostu. Přihlášení zůstává.
- **Podpory ve vysílání:** v záložce Živě je nápověda - podpory od diváků
  (💛) se v okně chatu ukážou zvýrazněné a ikonkou 🔊 si je streamer nechá
  číst nahlas (nebo všechny nové zprávy).

## Novinky 0.9.9

- **Aktualizace už nesmaže appku.** Při aktualizaci z 0.9.7 na 0.9.8 se
  stalo, že Windows (Smart App Control - "Část této aplikace byla
  zablokována") zablokoval kus instalátoru, který rozbaluje novou verzi.
  Instalátor z electron-builderu ale v tu chvíli už měl starou verzi
  odinstalovanou - zůstala prázdná složka a zástupce do prázdna ("Problém se
  zástupcem"). Ověřeno pod wine: zablokovaný `nsis7z.dll` = appka pryč.
  Teď (`build/installer.nsh`):
  - nová verze se nejdřív celá rozbalí a zkontroluje a teprve potom se stará
    odinstaluje; když rozbalení nejde, stará verze zůstane, instalátor to
    řekne a appku znovu spustí,
  - když starou verzi nejde odinstalovat (soubory drží jiný program),
    zůstane a spustí se znovu (dřív instalátor jen potichu skončil),
  - po instalaci se zkontroluje, že appka na disku opravdu je,
  - zástupci, kteří před aktualizací byli a během ní zmizeli (klik na
    zástupce zrovna ve chvíli výměny souborů -> Windows nabídne smazat),
    se vytvoří znovu,
  - čerstvá instalace, kterou Windows zablokuje, už nevytvoří zástupce do
    prázdna - řekne, co se stalo a co s tím.
  Výsledek zapíše do `%LOCALAPPDATA%\<appka>-updater\installer-result.txt`.
- **Aktualizace jen tlačítkem a s okénkem:** "Aktualizovat teď" spustí
  instalátor viditelně ("Installing, please wait…"), ne potichu. Tichá
  instalace po ukončení appky je vypnutá (při vypínání Windows ji systém
  mohl useknout uprostřed). Stažená aktualizace počká na kliknutí.
- **Appka řekne, jak aktualizace dopadla** (`src/main/updateOutcome.ts`):
  když neprošla, otevře se O appce s vysvětlením (Smart App Control /
  antivir / soubory držené jiným programem / instalátor se nespustil) a
  tlačítky rovnou do Zabezpečení Windows (nastavení Smart App Control,
  Historie ochrany). U stažené aktualizace appka upozorní, když je Smart
  App Control zapnutý.
- **Pomocník při Smart App Control:** Windows pouští nepodepsané skripty
  jen v omezeném režimu, kde pomocník (PowerShell) nejde. Dřív se tvářil,
  že běží, a do logu psal chybu každých 30 ms; teď to pozná, skončí, appka
  jede bez něj (jednoduché zkratky jako F8 fungují) a řekne proč.
- **Podpis:** jediné opravdové řešení pro Smart App Control je podepsaná
  appka (instalátor, appka i pluginy instalátoru). Azure Artifact Signing
  (dřív Trusted Signing) je zatím pro jednotlivce jen v USA a Kanadě; od
  0.10.1 workflow podepisuje certifikátem Certum Open Source (SimplySign),
  viz Novinky 0.10.1 a JAK-VYDAT.md, část C.

## Novinky 0.10.0

- **Přehlednější nastavení:** záložka Záznam má nahoře sedm ikon (Zkratky,
  Kvalita, Zvuk, Výkon, Úložiště, Vzhled, Obecné) a ukazuje vždy jen jeden
  oddíl. U voleb jsou krátké popisky a ikony; vysvětlení se ukáže až po
  kliknutí na otazníček. Tečka na ikoně oddílu = tam je něco k vyřešení
  (zvuk je ticho, zkratka nejde…). Upozornění v panelu vedou rovnou na
  správný oddíl (`settings:audio` apod.).
- **Ikony místo emoji** v celém okně (postranní panel, karty klipů,
  přehrávač, Živě, okno po hře, nastavení nahrání) - jedna sada SVG ikon
  (`src/renderer/icons.ts`), na Windows vypadají stejně jako všude.
  Na kartě klipu jsou vedlejší akce (složka, přejmenovat, smazat, odkaz,
  Discord) jen ikonkami s popiskem v bublině.
- **Zmenšování klipů** (Klipy -> úložiště vpravo nahoře, nebo Úložiště ->
  Zmenšit klipy): klipy se na pozadí překódují menším datovým tokem
  (libx264; Jemně / Doporučeno do 1080p / Nejmenší 720p) s odhadem, kolik
  to ušetří. Když jde ušetřit hodně, údaj o místě se zbarví - nic
  nevyskakuje. Běží s nejnižší prioritou na polovině jader; když se zapne
  hra, nahrávání nebo vysílání, rozdělaný klip se odloží a pokračuje se po
  hře. Původní soubor se nahradí, až je zmenšený v pořádku (stejná délka,
  má obraz, je opravdu menší); klip otevřený v přehrávači nebo změněný
  mezitím se nechá. Výpadek uprostřed výměny opraví další start appky
  (`.kine-orig` zpátky). `src/shared/compress.ts`, `src/main/compress.ts`.
- **Snímek obrazovky odstraněn** (Windows to umí samo: Win+Shift+S).
- **Přehrávač přes celou obrazovku:** tlačítko v hlavičce přehrávače
  (i F a dvojklik), šipky ← → přepínají klipy i přes celou obrazovku; když
  okno celou obrazovku odmítne, přehrávač vyplní okno roztažené přes
  obrazovku.
- **Ikona na ploše:** appka ji po instalaci i po každé aktualizaci vytvoří
  znovu, když chybí (Nastavení -> Obecné -> Ikona na ploše; vypnutím se
  smaže). Instalátor ji vytváří vždycky (`createDesktopShortcut: always`).
- **Plynulejší světlo kolem přehrávače:** barvy z videa se přelévají
  (desetkrát za sekundu, s prolínáním), neskáčou.

## Novinky 0.10.1

- **Podpis celé appky (Inteligentní řízení aplikací / Smart App Control):**
  Windows 11 s ním pustí jen podepsaný kód, nepodepsaný instalátor zablokuje
  celý. Workflow Vydání teď umí podepisovat certifikátem **Certum Open Source
  (SimplySign v cloudu)** – stačí tajemství `CERTUM_USERNAME` a `CERTUM_TOTP`
  (celý odkaz `otpauth://…` z QR kódu při aktivaci). `scripts/podpis.mjs
  priprav` nainstaluje SimplySign Desktop (ověří podpis jeho instalátoru),
  přihlásí se jednorázovým kódem (TOTP, SHA-256 – `scripts/podpisCore.mjs`),
  najde certifikát v úložišti Windows a podepíše kopie pluginů NSIS
  (`ELECTRON_BUILDER_NSIS_DIR` / `ELECTRON_BUILDER_NSIS_RESOURCES_DIR` – instalátor
  je rozbaluje do %TEMP% a načítá); electron-builder pak podepíše Kine.exe,
  **všechny .dll a .node** (`signExts`), ffmpeg.exe, elevate.exe,
  odinstalátor i instalátor (`scripts/publish-config.mjs`). `podpis.mjs over`
  po sestavení zkontroluje každý spustitelný soubor včetně toho, co je
  uvnitř instalátoru (7-Zip), a nepodepsané vydání zastaví. Bez tajemství se
  vydává jako dřív. Azure Artifact Signing zůstává (podepíše i pluginy).
  Zkouška naostro na Linuxu (skutečné Electron pro Windows + NSIS, testovací
  certifikát, `osslsigncode verify`): 18 z 18 souborů podepsaných, instalátor
  pod wine instaluje.
- **Pomocník jako program:** `src/helper/KineHelper.cs` → `kine-helper.exe`
  (csc.exe z .NET Frameworku, který je v každých Windows) dělá totéž co
  PowerShell skript a mluví stejně (řádky JSON). Při Inteligentním řízení
  aplikací PowerShell jede v omezeném režimu a skript nejde – podepsaný
  program projde. Přibalí se jen v podepsaném sestavení (nepodepsaný by
  blokoval stejně); appka ho pak použije, a když se dvakrát nerozjede, vrátí
  se k PowerShellu. Sám skončí, když appka zavře stdin (nezůstane viset po
  pádu appky). Testy: `tests/helper.test.mjs` (logika přes mono / csc),
  ve Vydání ho `podpis.mjs priprav` vždycky přeloží a pustí naostro.
- Česky se Smart App Control v textech jmenuje jako ve Windows –
  **Inteligentní řízení aplikací**.
- **Smazání klipu bez potvrzování:** ikonka koše dá klip hned do koše
  a dole se ukáže lišta „Přesunuto do koše · Vrátit“ (8 s, i **Ctrl+Z** –
  podle písmene, takže funguje i na české klávesnici QWERTZ); dřív se
  v kartě rozbalovalo dlouhé „Přesunout do koše?…“, které z karty
  přetékalo. Stejně hromadné smazání vybraných klipů. Co se smaže, dokud
  lišta svítí, vrátí Vrátit všechno. Karta zmizí hned a druhé kliknutí
  dvojkliku se nepočítá (na stejném místě už je další klip); do koše jde
  zvláštní požadavek `clips:trash`, který klip už v koši nechá být – dřív by
  ho druhé „smazat“ smazalo nadobro. Smazat nadobro a Vysypat koš (z koše)
  se dál potvrzují (dvojklik nepotvrdí), jen kratším textem. Klip vrácený
  z koše, který Kine ještě zpracovává, se zase dočká „Klip je na Kine“.
- **Přehrávač: jedno tlačítko celé obrazovky.** Mimo celou obrazovku jen
  „Celá obrazovka“ v hlavičce; tlačítko ve videu je až v celé obrazovce
  (jak z ní ven). Šipky na předchozí / další klip beze změny.
- **Náhled přenosu** (Živě -> O přenosu): vlastní obrázek, který lidé uvidí
  na Kine v řadě Živě a v náhledu odkazu; appka ho ořízne na 16:9
  (1280×720 JPEG) a pošle na Kine (`/api/live/thumbnail`). Bez něj snímek
  z vysílání jako dřív. Jde měnit i během vysílání. Adresu náhledu od Kine
  appka bere jen https.
- **Vzhled:** velikost písma, rohy (hranaté / normální / kulaté), velikost
  karet klipů a klidný režim bez animací (Záznam -> Vzhled).
- **Rychlejší nahrávání dlouhých videí:** velikost kusu se přizpůsobuje
  rychlosti připojení (8–64 MiB, cíl ~8 s na kus - Cloudflare doporučuje
  kolem 50 MB); na rychlém připojení (i optice, kde kus trvá pod půl
  vteřiny) výrazně méně čekání na potvrzení kusů. Kusy se z disku čtou
  asynchronně, ať velký kus nezastaví okna appky. Po nahrání karta
  ukazuje, kolik procent má Cloudflare zpracováno.

## Novinky 0.10.2

- **Zvuk hry i u headsetů s vlastním programem (Logitech G HUB, Razer
  Synapse…), Oculus / Meta Quest, Steam Streaming - jako v OBS.** Chromium
  otevírá zvuk výchozího výstupu ve stereu a virtuální zařízení 7.1 to
  odmítnou („Could not start audio source"), takže klipy byly bez zvuku hry.
  Když se to stane, appka teď sama pustí pomocníka
  (`src/helper/KineLoopback.cs`, přeloží ho PowerShell přes Add-Type -
  C# 5), který zařízení otevře jako OBS: WASAPI loopback v jeho vlastním
  formátu (mix format), převede ho na stereo (střed a zadní kanály do stran,
  LFE pryč, jako Web Audio) a posílá binárně (`KLB1` + zprávy F / A / E).
  Hlavní proces ho čte (`src/main/audioLoopback.ts`) a předává snímací
  stránce, kde z něj Web Audio (bez výstupu do reproduktorů) udělá stopu
  místo té z Chromia - nahrávání, klipy, měřáky i vysílání jedou beze změny.
  Zpoždění proti obrazu je stálé (náskok 60 ms + čtení) a klip ho při stavbě
  srovná (`systemLatencyMs` → `clipMuxArgs`). Rozdíl hodin zvukovky a Web
  Audio vyrovná nepatrná změna rychlosti (±0,3 %). Pořadí záchrany: znovu
  přes Chromium → pomocník → Stereo Mix a spol. → bez zvuku hry (a proč).
  Hráč nic nenastavuje; v Nastavení → Záznam → Zvuk je vidět, že zvuk jde
  „přímo z Windows (jako v OBS)". Přepnutí výchozího výstupu (reproduktory
  ↔ sluchátka) pomocník pozná do vteřiny a jde za ním, odpojení zařízení
  přečká (čeká, až zase bude). Když pomocník spadne, rozjede se znovu
  (nejvýš 3× za minutu). Při Inteligentním řízení aplikací PowerShell
  nejde (omezený režim) - pak zbývá Stereo Mix.
  Testy: `tests/loopback.test.mjs` (protokol, převod formátů 7.1 / 5.1 /
  16 / 24 / 32 bit přes mono `mcs -langversion:5`, celý skript v PowerShellu),
  e2e `KINE_TEST_FAKE_LOOPBACK=1` (falešný pomocník s tónem 440 Hz ze
  „zařízení 7.1": hladina, poznámka v nastavení, tón v klipu).
- **Ikona celé obrazovky vpravo dole v přehrávači** (jako u videí na Kine)
  místo tlačítka v hlavičce - ve vestavěném ovládání videa, dovnitř i ven
  (v celé obrazovce ukazuje „zmenšit"). Tlačítko ve videu by dalo přes celou
  obrazovku jen holé video a kliknutí si „vezme" - scénu se šipkami na další
  klip pak zapne hlavní proces jako kliknutím (`player:stageFullscreen`,
  `executeJavaScript` s gestem) a video se z vrstvy celé obrazovky vyjme
  (vyndá a hned vrátí - hraje dál). Okno při tom z celé obrazovky nevyskočí.
  Dvojklik do videa a F fungují dál; skryté jsou stahování, rychlost, obraz
  v obraze a přenos do TV (jinak by v rohu byla nabídka ⋮ místo ikony).

## Novinky 0.10.3

- **Záznam vysílání jen na přání.** Karta skončeného vysílání (záložka
  Živě) má vedle „Nahrát na Kine" i **Stáhnout do PC** a **Zahodit**.
  Stáhnout: Kine nechá u Cloudflare vyrobit MP4 (`/api/live/recordings`,
  `/api/live/recordings/download` - u dlouhého vysílání pár minut, karta ukazuje
  procenta), appka ho stáhne do složky s klipy (napřed do `.part`, pak
  přejmenuje) a přidá do knihovny jako nahrávku s náhledem - jde přehrát,
  zkrátit i nahrát jako každý klip (`LiveController.downloadRecording`,
  `saveStreamRecording` v `main.ts` - stahuje přes `pipeline`, takže plný
  disk nebo zamčený soubor skončí chybou na kartě, ne zaseknutím; `.part`
  se smaže). Zahodit: po potvrzení se záznam u Cloudflare hned smaže
  (`/api/live/recordings/discard`) a nikde se neuloží. Karta míří vždy na
  záznam PRÁVĚ skončeného vysílání - Kine pošle jeho id v odpovědi na
  „skončil jsem" (`recordingUid`), ne „nejnovější" (mezitím mohlo začít
  vysílání z OBS). Stáhnout / Zahodit mají vlastní adresy: starší web na ně
  odpoví 404 a nic neudělá (na `/api/live/recordings` by záznam zveřejnil).
  Když hráč neudělá nic, nezveřejněný záznam se nikde neukazuje a Cloudflare
  ho po 30 dnech smaže sám (jako dřív).
- **Vlastní doména s přesměrováním.** Když Kine hlásí novou adresu
  (`/api/desktop/config`) a ta přesměruje (holá doména → www), appka
  přejde rovnou tam, kde web opravdu odpovídá (`checkSiteMove` čte
  konečnou adresu odpovědi) - jinak by okno Kine bralo každý odkaz jako
  cizí web a API by chodilo přes přesměrování, které zahodí přihlášení.
  Appka na www zůstane (zpátky na holou doménu nikdy) a appka na holé doméně
  (přesměrovává) přejde na www. `playkine.com` a `www.playkine.com` jsou
  pro okno Kine totéž (`isKineUrl`).

## Novinky 0.10.4

- **Klipy samy z Rocket League** (`gameEventsParse.ts` - `JsonStreamFramer`,
  `rlDecode`, `rlEvents`, `RlMoments`, `rlConfigEnable`; `gameEvents.ts`):
  oficiální **Stats API** Psyonixu (rocketleague.com/developer/stats-api),
  bez zásahu do hry. Appka v instalaci hry (Steam `steamapps/common/rocketleague`,
  Epic podle manifestů launcheru v `ProgramData\Epic\EpicGamesLauncher\Data\Manifests`)
  zapne v `TAGame/Config` (TAStatsAPI.ini, jinak DefaultStatsAPI.ini) oddíl
  `[TAGame.MatchStatsExporter_TA]`: `PacketSendRate=5` jen když je vypnutý
  (0) - nad řádek si dá značku s původní hodnotou a vypnutí klipů ze hry ji
  vrátí; zapnutý jiným programem (overlay) nechá být a převezme jeho `Port`.
  Hra konfiguraci čte při startu. Když `rocketleague.exe` běží, appka se
  připojí na `127.0.0.1:<Port>` (TCP, v základu 49123; Stats API posílá jen
  během zápasu - spojení se zkouší znovu po 3 s). Proud jsou objekty JSON za
  sebou bez oddělovače (rámování podle závorek s ohledem na texty v uvozovkách),
  `Data` je znovu zakódovaný JSON. **Kdo jsem já:** API hráče neoznačuje -
  `Game.Target` je ten, koho kamera sleduje (při hraní vlastní auto); hlasuje
  se přes zápas mimo opakované záběry, platí od 10 hlasů s většinou 60 %
  (divák přepínající hráče žádné „já" nemá → žádné klipy). Klipy: můj **gól**
  (`GoalScored.Scorer`), třetí gól = **hattrick**, **skvělý zákrok**
  (`StatfeedEvent` EpicSave), s volbou „Každé zabití" i **zákrok** (Save)
  a **demolice** (Demolish, MainTarget = já). Momenty těsně za sebou = jeden
  klip s nejdůležitějším názvem, 3 s po posledním (výbuch po gólu je v klipu).
  Název nese skóre z pohledu hráče: „Gól · 2:1". Konfigurace se čte i zapisuje
  ve svém kódování (`decodeIni` / `encodeIni`: UTF-8 i UTF-16, s BOM i bez).
  Když složku hry nejde zapsat (chráněná instalace), appka to ukáže
  v záložce Hry (`autoClipsRlNoAccess`). Testy: `tests/gameEvents.test.mjs`
  (rámování proudu rozsekaného kdekoli, „já", jen moje momenty, hattrick,
  skóre, režimy, spojování, zapnutí a vrácení konfigurace, kódování), e2e:
  falešný server Stats API (cizí gól nic, můj gól = jeden klip „Goal · 1:1")
  a falešná instalace z Epicu s konfigurací v UTF-16 (zapnutí a přesné vrácení).

## Novinky 0.10.5

- **Vidí diváci obraz?** (`liveHealth.ts`, `live.ts`): appka během vysílání čte
  HLS playlist vysílání u Cloudflare (adresu `stream.hlsUrl` dá Kine v
  `/api/live/me`) - jen playlist, žádné video, každých 5 s - a hlídá, že
  přibývají nové kousky. V záložce Živě: „Diváci tě vidí" / „Ověřuji…" /
  „Diváci vidí zamrzlý obraz". Playlist je, ale nepřibývá (minutu od startu,
  nebo 25 s po posledním kousku) = zamrzlý obraz -> **kompatibilní režim**:
  nové spojení (Cloudflare přenos minutu drží, diváci zůstávají), ve kterém
  ffmpeg obraz zakóduje znovu (`livePlan.ts`: x264 veryfast/zerolatency,
  `-r` pevné snímky, klíčový snímek přesně každé 2 s, CBR, bez B-snímků).
  Když pomůže, zapamatuje se (`liveCompat` v nastavení; jde i ručně: Živě ->
  Jak vysílat). Playlist nejde přečíst vůbec: s potvrzením od Kine „nejde
  ověřit" (nic se nepřepíná), bez potvrzení po 90 s zamrzlý obraz.
- **Zahodit záznam** vždycky smaže: id záznamu appka zná už z „pořád
  vysílám" (Kine ho posílá s potvrzením od Cloudflare); bez id pošle okno
  vysílání (`since`-`until` + `clientNow` = hodiny počítače, server si okno
  posune na svůj čas) a Kine smaže záznamy z něj. Záznam, který
  Cloudflare ještě zakládá / uzavírá (odpověď `retry`), zkouší znovu po 10 s
  až 3 minuty („Mažu záznam…"); id, které u vstupu není, -> okno vysílání.
- **„Skončil jsem"** se při chybě sítě pošle znovu (3 pokusy), ať Kine po
  konci neukazuje vysílání jako živé.
- **Placení na Kine zatím neběží**: místo odkazu na Kine Plus štítek
  „Připravujeme" (`plusAvailable` od Kine je false).
- Testy: `tests/live.test.mjs` (kompatibilní režim, playlisty HLS, verdikt
  hlídání, přepnutí při zamrzlém obrazu a zapamatování, Zahodit podle okna
  a opakování, id nesedí -> okno, zveřejněný záznam = chyba),
  `tests/uploader.test.mjs` (co appka posílá při Zahodit), e2e: vysílání
  v kompatibilním režimu na místní RTMP server (klíčové snímky přesně po 2 s,
  30 snímků za sekundu, zvuk).

## Novinky 0.10.6

- **Na Kine živě?** (`live.ts`, `kineApi.ts`, `settings.ts`): Kine teď v odpovědi
  na „začal jsem / pořád vysílám" posílá, jestli je přenos na Kine opravdu
  živě (`live`) a co o vstupu řekl Cloudflare (`cloudflare`: lifecycle, běžící
  záznam vstupu, HLS). Záložka Live ukazuje dva řádky: „Diváci tě vidí"
  (appka si sama čte HLS) a „Na Kine jsi živě" / „Kine tě teď neukazuje" -
  dřív bylo vidět jen to první a na webu přitom „nikdo nevysílá". Změny se
  zapisují do deníku (O appce -> Kopírovat diagnostiku).
- Server Kine (stejné kolo) přenos potvrzuje i podle seznamu videí vstupu
  a HLS vstupu, a „pořád vysílám" vrátí přenos, který Kine stáhla, jakmile
  ho Cloudflare vidí.
- Testy: `tests/live.test.mjs` (stav „na Kine", zápis do deníku jen při
  změně, starší Kine bez `live`), e2e: oba řádky v záložce Live.

## Novinky 0.10.7

- **Zvuk hry a mikrofon v přehrávači** (`renderer/player.ts`): vpravo dole
  nad ovládáním videa (i přes celou obrazovku) jsou u klipů se samostatnými
  stopami tlačítka „Hra" a „Mikrofon" - kliknutím se ztlumí / zapnou hned
  v tom, co hraje (dřív šel zvuk vybrat jen v úpravách a v náhledu se nic
  neztlumilo). Úpravy převezmou, co je slyšet, a stejně klip uloží. Stopy
  přepíná Chromium (`enableBlinkFeatures: 'AudioVideoTracks'` u oken
  s přehrávačem - `main.ts`); bez toho aspoň „bez zvuku". Po vypnutí všech
  stop pustí Chromium tutéž stopu znovu až za 1-2 s (změřeno) - přehrávač
  proto po zapnutí skočí na stejné místo a zvuk je hned zpátky.
- Klipy s jednou stopou: „Odstranit zvuk" v úpravách ztlumí i náhled; po zavření
  úprav hraje náhled zase se zvukem (mimo úpravy tu volbu nic neukazuje).
- **Rychlost přehrávání**: tlačítko „1×" vedle (0,25× až 2×), i přes celou
  obrazovku, klávesy `<` a `>`; výchozí 1×, zůstává i pro další klipy.
  V úpravách náhled hraje rychlostí, se kterou se klip uloží.
- **Živě**: když kontrola obsahu přenos skryje z Živě, záložka Live to řekne
  (dřív „Na Kine jsi živě", i když ho ostatní neviděli).
- Testy: e2e `playerTracksOk` (klip se třemi stopami 440 / 1000 Hz - měří se,
  co video opravdu hraje), `playerSpeedOk`, `playerMuteOk` (klip s jednou
  stopou: „Odstranit zvuk" ztlumí náhled, po zavření úprav zase hraje); `tests/live.test.mjs`
  a `tests/uploader.test.mjs` (skrytý přenos).

## Novinky 0.10.8

- **Vlastní ovládání přehrávače** (`renderer/player.ts`): místo vestavěného
  ovládání Chromia lišta dole přes obraz - posuvník (načtené světleji,
  momenty nahrávky žlutě, při najetí čas) a pod ním jedna řada: přehrát /
  pozastavit, hlasitost (posuvník se vysune u reproduktoru), čas, vpravo
  „Hra" a „Mikrofon" (jen klipy se samostatnými stopami), rychlost a celá
  obrazovka. Všechno u posuvníku, nic dalšího na ploše videa; stejné i přes
  celou obrazovku. Pryč je nabídka ⋮ se „zvukovou stopou" (Chromium ji
  přidávalo ke klipům s víc stopami). Klik do obrazu přehraje / pozastaví,
  dvojklik dá celou obrazovku. Při přehrávání se lišta po 2,5 s bez pohybu
  myši schová (i kurzor), při pauze zůstává. Klávesy beze změny (mezerník / K,
  šipky, M, F, < >).
- **Nastavení přeuspořádané**: záložka Záznam má jen to, co se týká
  nahrávání (zkratky, kvalita, zvuk, výkon, úložiště); vzhled, obecné
  (jazyk, start s Windows, oznámení, co po spuštění) a O appce jsou v nové
  záložce **Appka** (místo O appce v postranním panelu - počet položek
  zůstal). Staré cíle (`about`, `settings:look`, `settings:general` -
  upozornění, odkazy `kine://`) vedou na nové místo (`resolveTarget`).
- Testy: e2e `playerControlsOk` (žádné vestavěné ovládání, lišta s posuvníkem
  a jednou řadou tlačítek, přehrát / pozastavit, posun kliknutím, ztlumení),
  `playerFullscreenOk` přes tlačítko v liště, `settingsSectionsOk` (Záznam
  pět oddílů, Appka vzhled / obecné / o appce, staré cíle).

## Novinky 0.11.0

- **Verze appky v každém dotazu na Kine** (`X-Kine-App: clipper/0.11.0` -
  `shared/kineClient.ts`): Kine pozná zastaralou appku a nepustí ji nahrávat
  ani vysílat (odpoví 426). Appka pak ukáže upozornění „aktualizuj" (O appce)
  a hned hledá aktualizaci. Nejstarší povolenou verzi hlásí i
  `/api/desktop/config` (`minDesktopVersion`). Starší verze hlavičku neposílají
  a Kine je pozná podle toho, že volají z Node.js - po vydání 0.11.0 musí
  aktualizovat.
- **Jen oficiální Kine**: zabalená appka mluví jen s www.playkine.com (a
  starší kine-lac.vercel.app); jiná adresa v nastavení se vrátí. Vývoj
  (nezabalená appka) a testy můžou cokoli. Předplatné tak nejde „zapnout"
  vlastním falešným webem.
- **Klipy Plus hlídá i appka**: konec předplatného (`planUntil`) - po něm se
  hned vrátí 60s klipy a ruční nahrávání, i bez spojení s Kine; strop délky
  klipu od serveru nejvýš 5 minut, bez Plus vždy 60 s. Předplatné se ověřuje
  každou hodinu (dřív 6 h).
- **Přihlášení po výpadku**: když Kine / Supabase při startu neodpovídá, appka
  hráče neodhlásí (relace je na disku) a přihlášení obnoví, jakmile Kine
  odpoví - dřív se tvářil jako odhlášený až do restartu appky.
- **Délka klipu do nahrání**: Kine podle ní hlídá limity nahrávání a u
  Cloudflare rezervuje jen tolik místa, kolik klip opravdu má.
- Nezveřejněné záznamy vysílání Kine maže po pár dnech (texty v appce).
- Testy: `tests/kineClient.test.mjs` (hlavička, oficiální adresy, verze,
  426 -> upozornění, délka klipu, konec Klipy Plus).

## Novinky 0.10.9

- **Kamera v klipech** (Záznam -> Kamera, výchozí vypnuto): obraz z kamery se
  do záznamu skládá rovnou při nahrávání (`renderer/capture.ts` -
  `startClipCamera`, stejné skládání jako kamera ve vysílání -
  `renderer/liveCompositor.ts`). Kamera je ve STEJNÉM snímku jako hra, takže
  v klipu sedí přesně (nic se dodatečně nezarovnává a klip se při uložení
  znovu nekóduje). Výběr kamery, roh, velikost, tvar, zrcadlo a náhled; poloha
  / velikost / tvar / jiná kamera se mění za běhu povelem `clip-camera` (bez
  restartu zásobníku), zapnutí / vypnutí snímání rozjede znovu (jako změna
  kvality). Vypnutá = kamera se vůbec neotevře. Stav (zapíná se / nahrává se
  / nejde) je v nastavení; nejde-li (obsazená, odpojená), nahrává se dál bez ní,
  upozornění jednou a nový pokus každých 15 s. Vysílání bere obrazovku bez
  téhle kamery (má svou scénu). Když obraz hry stojí (snímání pak nové snímky
  neposílá), skládání kameru dokresluje samo - v záznamu ani ve vysílání
  nezamrzne (časy snímků jen rostou). Odpojená kamera zmizí z obrazu (dřív
  ve vysílání zůstal zamrzlý obličej).
- **Nahrát na Kine i během hraní**: „Nahrát hned" u klipu, který čeká na konec
  hry (karta v knihovně i lišta přehrávače), ho pošle hned (`uploader.enqueue`
  s `now` - vynucené nahrání hra nepozastaví, jen chybějící připojení).
  Automatické nahrávání během hry dál čeká.
- **Hlavička přehrávače u klipu**: hvězdička (Oblíbené) a Nahrát na Kine (stav
  nahrávání / „Nahrát hned") přímo v liště nad klipem.
- Testy: e2e `clipCameraOk` (falešná kamera Chromia: kamera vpravo dole v klipu,
  přesun doleva nahoru za běhu bez restartu, kamera se v klipu hýbe, vypnutí),
  `playerHeadOk` (hvězdička mění oblíbené, Nahrát, „Nahrát hned" v liště i na
  kartě), `settingsSectionsOk` (Záznam má šest oddílů), unit testy nastavení
  kamery a vynuceného nahrávání během hry.
