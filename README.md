# Kine do PC

Program do Windows, který běží v liště u hodin: když hraješ, drží
posledních N sekund obrazu (a zvuku). Zmáčkneš klávesu a uloží se klip.
Po dohrání se klipy nabídnou k nahrání na Kine – **nikdy během hry**,
aby online hra na slabší wifi nelagovala.

Samostatný projekt vedle webu Kine (repo `Kine`). Web potřebuje tři
věci, které přišly v balíčku „kine-do-pc“: `/api/desktop/config`,
`/api/desktop/link` a stránky `/connect` a `/download`.

## Jak to funguje

```
hra běží  ──►  GameWatcher (tasklist + Steam registr + seznam her)
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
- **Rozpoznání hry:** Steam (registr `RunningAppID` + název z
  `appmanifest_<id>.acf`), ~250 známých her mimo Steam podle názvu .exe
  (`src/main/gamesParse.ts`), a hry přidané hráčem v nastavení.
  Minecraft Java (`javaw.exe`) se potvrzuje podle příkazové řádky.
- **Přihlášení:** přes prohlížeč (Kine `/connect` → jednorázový token →
  `http://127.0.0.1:<port>/link` nebo `kine://link?…`), nebo e-mail +
  heslo. Relace se ukládá zašifrovaná (`safeStorage`, na Windows DPAPI).
  Klíče k Supabase si appka bere z `/api/desktop/config` – nic není
  zadrátované.

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
| `KINE_TEST=1` | samočinná zkouška: zásobník → dva klipy → screenshoty oken → konec (`tests/e2e.sh`) |

Adresu Kine jde v nastavení (Účet → Adresa Kine) přepnout třeba na
`http://localhost:3000`.

## Vydání nové verze

1. V `package.json` zvedni `version`.
2. `git commit -am "v0.1.1" && git tag v0.1.1 && git push && git push --tags`
3. GitHub Actions (`.github/workflows/release.yml`) na Windows sestaví
   `Kine-Setup.exe` a přidá ho do Releases spolu s `latest.yml`, podle
   kterého si nainstalované appky samy stáhnou aktualizaci.

Instalátor se jmenuje pořád stejně (`Kine-Setup.exe`), protože GitHub má
stálou adresu `releases/latest/download/Kine-Setup.exe` – na tu míří
`kine…/download/windows`, takže lidi stahují rovnou z Kine. Vlastník/repo
je v `electron-builder.yml` (`publish`) a na webu `NEXT_PUBLIC_DESKTOP_REPO`.
Krok za krokem: **JAK-VYDAT.md**.

**Podpis:** instalátor není podepsaný, Windows ukáže „Neznámý vydavatel“.
Až bude certifikát (nejlevněji Azure Trusted Signing, ~10 $/měsíc), do
`electron-builder.yml` → `win` přibude `azureSignOptions` a do workflow
tajemství s přihlášením.

## Struktura

```
src/main/        hlavní proces (Electron, Node)
  main.ts        tray, okna, zkratky, IPC, spojení všeho
  capture.ts     zásobník: skrytá stránka → ffmpeg segmenty → klip
  segments.ts    čistá logika výběru kousků (test)
  games.ts       hlídání her (tasklist, Steam), gamesParse.ts čistá část (test)
  clips.ts       knihovna klipů (index.json ve složce s klipy)
  uploader.ts    fronta nahrávání, pauza při hře (test), tus.ts klient (test)
  auth.ts        přihlášení, lokální server pro /connect, kine:// odkazy
  kineApi.ts     volání Kine (create-upload-url, confirm)
  settings.ts    nastavení (userData/settings.json), shared/settingsSchema.ts (test)
  toast.ts       okénko „Klip uložen“ v rohu
src/renderer/    stránky oken: settings (nastavení + průvodce + knihovna),
                 review (okýnko po hře), toast, capture (skrytá snímací)
src/preload/     most window.kine / window.kineCapture
src/shared/      typy, překlady (cs/en), názvy klipů, zkratky
```

## Kine Plus (placená verze)

Pravidla jsou v `src/shared/plan.ts` a na webu v `lib/plus.ts`; appka se
ptá `/api/desktop/me`, kdo je a co smí. Zdarma: klipování bez omezení,
klipy do 60 s, nahrání na Kine ručně (okýnko po hře, Knihovna) – se
stejnými pravidly jako každé video. Plus: „nahrát všechny klipy
automaticky“, klipy až 5 minut, odznak PLUS. Když Plus vyprší, appka se
sama vrátí na ruční nahrávání. Barvu Kine, kterou má hráč u loga na webu,
appka převezme z jeho účtu.

## Co ještě není

- macOS/Linux: appka se spustí a klipy dělá, ale bez zvuku systému
  (Chromium ho umí jen na Windows) a bez rozpoznání her mimo Steam.
- Klip je dlouhý N až N+2 s (kousky po 2 s, řez jen na klíčovém snímku).
- Hry v režimu *exclusive fullscreen* okénko „Klip uložen“ neukážou –
  přijde zvukové pípnutí a systémové oznámení.
