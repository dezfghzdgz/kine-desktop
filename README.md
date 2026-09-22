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
   zabití ve hře ───┤  (CS2 Game State Integration / LoL Live Client API, GameEvents)
                    ▼
   ffmpeg -f concat -c copy  ──►  Videos\Kine\Kine 2026-09-21 20-14-05 CS2.mp4 + .jpg
                    │
   hra skončila ────┤  okýnko „4 klipy z CS2 – nahrát?“ (nebo automaticky)
                    ▼
   Uploader: tus po 8 MiB kusech do Cloudflare → /api/videos/confirm na Kine
             pauza, jakmile se rozjede hra; po hře pokračuje od místa, kam došel
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
  výška·9/16; `crop` filtr v `edit.ts`). Původní se nikdy nepřepisuje.
  **GIF** (třetí formát): úsek do 15 s, 480 px, 15 fps, paleta +
  dithering (`editPlan.gifArgs`), bez zvuku, soubor `.gif` vedle klipu
  (do knihovny nepatří - tam jsou jen videa), tlačítko „Ukázat ve složce“.
- **Knihovna klipů** (`src/renderer/settings.ts`): najetí myší na kartu
  tiše přehrává klip (jeden náhled naráz, po odjetí se pustí z ruky);
  hvězdička = oblíbený (`Clip.favorite`) a filtr „Oblíbené“; zaškrtávátka
  na kartách vyberou víc klipů a lišta nad mřížkou je **spojí do jednoho
  klipu** (sestřih: `editPlan.mergePlan` - společný rozměr s černými
  pruhy místo roztažení, společné fps, zvuk 48 kHz stereo a ticho tam,
  kde klip zvuk nemá, `concat` filtr, libx264), nebo je naráz nahraje či
  smaže. Sestřih je nový klip `Kine … sestřih.mp4`, původní zůstávají.
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
  konci série, aby v něm bylo všechno. Ani jedno není zásah do hry – jsou
  to rozhraní, která hry samy nabízejí (stejně je používá Medal, Overwolf,
  Allstar).
- **Sdílení:** u nahraného klipu je „Kopírovat odkaz“ (odkaz na Kine do
  schránky) a „Poslat na Discord“ – webhook kanálu se vyplní v záložce
  Nahrání a sdílení, appka pošle název + odkaz (`main.ts` → `shareToDiscord`).
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
- **Zátěž při hraní** je záměrně malá: pomocník pro Windows se bez
  složených zkratek ptá jen jednou za sekundu (s nimi každých 30 ms, aby
  neušel stisk), programy a okna čte přes Win32 API (`EnumProcesses`,
  `QueryFullProcessImageName`, `EnumWindows`) místo `Get-Process`, a
  appka díky tomu nespouští každých pár sekund `tasklist` ani `reg`.
  Hlídání her jede jednou za 5 s. V nastavení kvality je tlačítko **Nízká
  zátěž (720p)** – 720p / 30 fps / 5 Mb/s jedním klikem.

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
  segments.ts    čistá logika výběru kousků (test)
  games.ts       hlídání her (procesy, Steam, popředí), gamesParse.ts čistá část (test)
  gameEvents.ts  klipy samy z událostí: CS2 Game State Integration (lokální server + cfg), LoL Live Client API
  gameEventsParse.ts  čistá část: rozbor událostí CS2/LoL, série zabití, obsah cfg (test)
  edit.ts        zkrácení / ztlumení / výřez 9:16, sestřih víc klipů, GIF (ffmpeg), náhled k upravenému klipu
  editPlan.ts    čistá část úprav: argumenty pro sestřih a GIF, rozbor hlavičky ffmpeg, průběh (test)
  winHelper.ts   pomocník pro Windows (PowerShell + C# přes Add-Type): okno v popředí, procesy, okna, Steam, stav kláves
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
                 player (přehrávač + úpravy klipu ve vrstvě: řez, 9:16, GIF), review
                 (okýnko po hře), toast, capture (skrytá snímací)
src/preload/     most window.kine / window.kineCapture
src/shared/      typy, překlady (i18n/: en cs sk de pl es fr uk), názvy klipů, zkratky, plány
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
