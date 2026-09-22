# Kine do PC

Program do Windows, který běží v liště u hodin: když hraješ, drží
posledních N sekund obrazu (a zvuku, včetně mikrofonu). Zmáčkneš klávesu
a uloží se klip. Po dohrání se klipy nabídnou k nahrání na Kine – **nikdy
během hry**, aby online hra na slabší wifi nelagovala. Ve dvou režimech:
**jen klipovač**, nebo **Kine + klipy** – v tom je první záložka hlavního
okna samotné Kine (web vložený do okna, `WebContentsView`, s trvalým
přihlášením) a klipy s nastavením hned vedle. Anglicky v základu, osm
jazyků (stejné jako web). Pětkrát klik na logo = barva appky (jako na
webu, ukládá se i na účet).

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
  Pause hlídá pomocník na Windows přes `GetAsyncKeyState`.
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
  chodí do okna.
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
| `KINE_TEST=1` | samočinná zkouška: zásobník → dva klipy → přehrávač v okně → screenshoty → konec (`tests/e2e.sh`) |
| `KINE_NO_HELPER=1` | nespouštět pomocníka pro Windows (hry jen podle seznamu a Steamu, jen jednoduché zkratky) |

Adresu Kine jde v nastavení (Účet → Adresa Kine) přepnout třeba na
`http://localhost:3000`.

## Vydání nové verze

1. V `package.json` zvedni `version`.
2. Nahraj soubory do repa (git, nebo přes web GitHubu) a spusť workflow
   **Vydání** (nebo pushni tag `v0.2.0`).
3. GitHub Actions (`.github/workflows/release.yml`) na Windows sestaví
   `Kine-Setup.exe`, nahraje ho pod dvěma názvy (`Kine-Setup.exe` = Kine
   + klipy, `Kine-Clipper-Setup.exe` = jen klipovač; jeden a ten samý
   soubor, appka si podle názvu předvyplní režim – `build/installer.nsh`)
   do **Cloudflare R2** (odsud stahují lidi z `kine…/download` a odsud si
   nainstalované appky berou aktualizace podle `latest.yml`) a záložně do
   GitHub Releases. `scripts/publish-config.mjs` k tomu z proměnných
   prostředí sestaví `electron-builder.generated.yml` (adresa aktualizací,
   podpis). Krok za krokem včetně R2 a podpisu: **JAK-VYDAT.md**.

**Podpis:** bez certifikátu Windows ukáže „Neznámý vydavatel“ a SmartScreen
varuje. S Azure Trusted Signing (tajemství `AZURE_*` v GitHubu) workflow
podepisuje sám.

## Struktura

```
src/main/        hlavní proces (Electron, Node)
  main.ts        tray, okna (nastavení/klipy, okýnko po hře, okno Kine), IPC, režimy
  capture.ts     zásobník: skrytá stránka → ffmpeg segmenty → klip
  segments.ts    čistá logika výběru kousků (test)
  games.ts       hlídání her (procesy, Steam, popředí), gamesParse.ts čistá část (test)
  edit.ts        zkrácení / ztlumení klipu (ffmpeg), náhled k upravenému klipu
  winHelper.ts   pomocník pro Windows (PowerShell + C# přes Add-Type): okno v popředí, procesy, okna, Steam, stav kláves
  hotkeys.ts     zkratky: systémové (Electron) + složené přes pomocníka
  clips.ts       knihovna klipů (index.json ve složce s klipy)
  uploader.ts    fronta nahrávání, pauza při hře (test), tus.ts klient (test)
  auth.ts        přihlášení, lokální server pro /connect, kine:// odkazy
  kineApi.ts     volání Kine (create-upload-url, confirm)
  settings.ts    nastavení (userData/settings.json), shared/settingsSchema.ts (test)
  toast.ts       okénko „Klip uložen“ v rohu
src/renderer/    stránky oken: settings (záložka Kine s lištou, klipy s filtry, nastavení,
                 průvodce), player (přehrávač + úpravy klipu ve vrstvě), review
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
