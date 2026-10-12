# Jak vydat Kine do PC (a jak ho dostat k lidem bez GitHubu)

Repo `kine-desktop` už na GitHubu máš a první vydání (v0.1.0) proběhlo.
Tady je, co dělat dál: **A)** nahrát novou verzi kódu, **B)** zapnout
stahování z našeho úložiště místo GitHubu, **C)** podpis, aby Kine pustilo
Inteligentní řízení aplikací ve Windows 11 (a nevarovaly antiviry a SmartScreen).

## A) Nová verze (přes web GitHubu, bez gitu)

1. Rozbal `kine-desktop-zdroj.zip` do složky v počítači.
2. Na GitHubu otevři repo **kine-desktop** → **Add file** → **Upload files**.
3. Ve Windows otevři rozbalenou složku, označ **všechno** v ní (Ctrl+A)
   a přetáhni to do okna prohlížeče. Soubory se stejným názvem se přepíšou,
   nové se přidají.
4. Dole **Commit changes** (klidně s popisem „v0.2.0“).
5. Skryté složky (`.github`) se přetažením nahrají taky – ale kdyby ne,
   otevři v repu `.github/workflows/release.yml` → tužka (Edit) → vlož
   obsah stejného souboru z balíčku → Commit.
6. **Actions** → **Vydání** → **Run workflow** → **Run workflow**.
   Za ~10 minut je v **Releases** verze podle `package.json`
   (teď `0.5.0`) se soubory `Kine-Setup.exe` (appka **Kine** = Kine do PC),
   `Kine-Clipper-Setup.exe` (appka **Kine Clipper** = jen klipovač),
   `latest.yml` a `clipper.yml`.

Každá další verze: v `package.json` zvedni `"version"`, nahraj soubory,
Run workflow. Nainstalovaným appkám se nová verze stáhne na pozadí (až
když se nehraje) a nainstaluje po ukončení.

**Jak workflow vydává (od 0.7.0).** Instalátory se jen postaví
(`--publish never`) a na GitHub je nahraje `gh release upload --clobber`
(až třikrát, přepíše staré). Dřív to dělal electron-builder sám a při
opakovaném běhu stejné verze soubor smazal a nový už nenahrál – tak
zůstalo vydání 0.6.0 bez `Kine-Setup.exe` a `latest.yml` a appka hlásila
„Aktualizace se nepodařilo zkontrolovat“. Krok „Kontrola souborů“ navíc
hlídá, že všech pět souborů existuje, a v **Summary** běhu je seznam
toho, co ve vydání leží. Workflow se nespouští dvakrát naráz
(`concurrency`). Když je `DESKTOP_DOWNLOAD_BASE` nastavené, ale chybí
klíče k R2, krok R2 se přeskočí s varováním – vydání na GitHubu tím
nepadá.

**Kontrola aktualizací v appce** zkouší postupně: odkud byla appka
postavená (R2, nebo GitHub), pak GitHub Releases přímo, a nakonec se
zeptá webu Kine (`/api/desktop/latest`) – když ani automatické stažení
nejde, ukáže aspoň „Je venku verze X“ s tlačítkem ke stažení. Důvod
neúspěchu je vidět v záložce O appce i v protokolu (`kine.log`).

**Dvě appky z jednoho kódu.** Workflow staví instalátor dvakrát:
`scripts/publish-config.mjs` vyrobí `electron-builder.generated.yml`
(Kine: název „Kine“, ikona trojúhelník, `cz.kine.desktop`) a
`electron-builder.clipper.yml` (Kine Clipper: název „Kine Clipper“, ikona
se svorkami, `cz.kine.clipper`, vlastní složka s nastavením). Appka pozná,
která je, z `kineVariant` v zabaleném `package.json` (`src/main/variant.ts`);
Kine do PC má Kine v okně, Kine Clipper jen klipuje. Když běží obě naráz,
klipovač se sám vypne (je součástí Kine do PC). Instalátor je jen anglicky
(jednojazyčný NSIS) – jazyk si hráč vybírá v průvodci appky.

## B) Stahování z naší stránky (Cloudflare R2), ne z GitHubu

Instalátor má 130 MB – na Vercel se nevejde, ale Cloudflare R2 je na
takové soubory dělané a stahování z něj je zdarma (10 GB úložiště a
10 milionů stažení měsíčně zadarmo). Workflow ho tam nahraje sám, web
Kine pak lidi pošle na náš odkaz. Jednou nastavit:

1. **dash.cloudflare.com** → účet (stačí zdarma) → v levém menu **R2
   Object Storage** → **Create bucket** → název `kine-download`, umístění
   nech automatické → Create.
2. V bucketu **Settings** → **Public access** → **R2.dev subdomain** →
   **Allow Access** → potvrď. Objeví se adresa jako
   `https://pub-1a2b3c4d.r2.dev` – tu si zkopíruj (říkejme jí *adresa úložiště*).
   (Až budeš mít vlastní doménu, jde sem přidat třeba `stahnout.kine.cz` –
   **Custom Domains** – a adresa úložiště bude tahle.)
3. Zpátky na přehledu R2 vpravo **Manage R2 API Tokens** → **Create API
   token** → název `kine-github`, Permissions **Object Read & Write**,
   Specify bucket: `kine-download` → Create. Zkopíruj si **Access Key ID**,
   **Secret Access Key** a nahoře na stránce R2 **Account ID** (ukazuje se
   i v adrese `…r2.cloudflarestorage.com`).
4. GitHub → repo kine-desktop → **Settings** → **Secrets and variables** →
   **Actions**:
   - záložka **Secrets** → **New repository secret**, čtyřikrát:
     `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_BUCKET` (= `kine-download`)
   - záložka **Variables** → **New repository variable**:
     `DESKTOP_DOWNLOAD_BASE` = adresa úložiště (bez lomítka na konci)
5. Vercel → projekt Kine → **Settings** → **Environment Variables** →
   `NEXT_PUBLIC_DESKTOP_DOWNLOAD_BASE` = stejná adresa úložiště → Save →
   **Redeploy** (Deployments → ⋯ u posledního → Redeploy).
6. Spusť **Run workflow** (krok A6). V logu kroku „Nahrát do Cloudflare
   R2“ uvidíš `nahráno: …/full/Kine-Setup.exe a …/clipper/Kine-Clipper-Setup.exe`.

Od té chvíle `kine…/download/windows` posílá lidi na naše úložiště
(`full/Kine-Setup.exe`, `?variant=clipper` → `clipper/Kine-Clipper-Setup.exe`)
a nainstalované appky si tam hledají aktualizace (`full/latest.yml`,
`clipper/latest.yml`). Kopie Kine leží i v kořeni úložiště – odtud se
aktualizují appky do verze 0.4.0. GitHub Releases zůstávají jako záloha –
kdyby R2 nebylo nastavené, web míří tam.

## C) Podpis – aby Windows Kine pustil (Inteligentní řízení aplikací)

**Proč.** Windows 11 má **Inteligentní řízení aplikací** (anglicky Smart App
Control). Když je zapnuté, pustí jen programy podepsané certifikátem
ověřeného vydavatele – nepodepsaný instalátor zablokuje celý („…zablokovalo
aplikaci, která může být nebezpečná“) nebo jeho část („část této aplikace
byla zablokována“) a tlačítko „Přesto spustit“ tam **není**. Kódem se to
obejít nedá (a nemá). Jediné řešení je **podpis** a ten jde jen na tvoje
jméno – certifikát si musíš pořídit ty (ověřují totožnost). Všechno ostatní
je hotové: jakmile do GitHubu přidáš dvě tajemství, každé vydání se podepíše
celé – instalátor, odinstalátor, Kine.exe, všechny .dll, ffmpeg.exe, pluginy
instalátoru (NSIS, ty se rozbalují do %TEMP%) i pomocník `kine-helper.exe`.
Krok „Podpis – kontrola“ ověří, že je podepsaný opravdu každý soubor, jinak
se nevydá.

Do té doby (pro tebe, na tvém PC): Start → napiš „Inteligentní řízení
aplikací“ → **Vypnuto** → spusť instalátor znovu. S aktuálními aktualizacemi
Windows (od dubna 2026) jde později zase zapnout bez přeinstalace Windows –
ale dokud Kine není podepsané, Windows by ho pak blokoval i při spuštění.

### Doporučeno: Certum „Open Source Code Signing in the Cloud“ (od 49 € / rok)

Nejlevnější cesta pro jednotlivce v ČR (Azure Artifact Signing bere
jednotlivce jen z USA a Kanady). Repo kine-desktop je veřejné s licencí MIT,
takže na „open source“ certifikát máš nárok. Certum je v programu důvěryhodných
certifikačních autorit Microsoftu – Inteligentní řízení aplikací podepsané
Kine pustí hned. V podpisu bude „Open Source Developer, <tvoje jméno>“.

1. **Koupit:** shop.certum.eu → Code Signing → **Open Source Code Signing in
   the Cloud** (1 rok) → zaplatit.
2. **Aktivovat a ověřit totožnost:** shop.certum.eu → *My account* → *Data
   security products* → u certifikátu *Activate*. Jméno piš přesně jako
   v občance, ověření buď automaticky (kamera + doklad), nebo nahraješ sken
   dokladu. U open source chtějí i adresu a odkaz na projekt:
   `https://github.com/dezfghzdgz/kine-desktop`. Úložiště klíče: **cloud
   (SimplySign)**, algoritmus nech výchozí. Zadáš e-mail – to je přihlašovací
   jméno do SimplySign. Ověření trvá obvykle pár dní.
3. **Po vydání certifikátu** přijdou tři e-maily. V e-mailu *Regaining access
   to the SimplySign service* otevři odkaz (na počítači) a zadej kód
   z e-mailu *Secret for regaining access* – stránka ukáže **QR kód**.
4. **Než QR kód naskenuješ aplikací SimplySign, vytáhni z něj text:** udělej
   snímek (Win+Shift+S) a přečti ho čtečkou QR, která ukáže text – třeba
   Google Lens (aplikace Google v mobilu) nebo foťák v Androidu. Text začíná
   `otpauth://totp/…` – zkopíruj ho **celý**. To je tajemství pro GitHub;
   kdo ho má spolu s tvým e-mailem, může podepisovat tvým jménem – nikam
   jinam ho nedávej.
   Pak v mobilu: aplikace **SimplySign** → *Activate application* → *Other
   activation methods* → *QR code* → naskenuj → *Generate token* → *Finish*.
   (Kdyby ses k textu nedostal: stejný postup z kroku 3 jde zopakovat – vznikne
   nový QR kód, ten pak znovu naskenuj i v aplikaci.)
5. **GitHub** → repo kine-desktop → *Settings* → *Secrets and variables* →
   *Actions* → *New repository secret*, dvakrát:
   - `CERTUM_USERNAME` = e-mail účtu SimplySign
   - `CERTUM_TOTP` = celý text `otpauth://totp/…` z QR kódu
6. **Workflow:** v repu musí být nový `.github/workflows/release.yml` (má kroky
   „Podpis – příprava“, „Podpis – kontrola“, „Podpis – odhlášení“). Přetažením
   se `.github` nenahraje: na GitHubu otevři `.github/workflows/release.yml` →
   tužka (*Edit*) → smaž obsah, vlož obsah stejného souboru z balíčku →
   *Commit changes*. Stačí jednou – celá logika je v `scripts/podpis.mjs`.
7. **Vydat:** *Actions* → *Vydání* → *Run workflow*. V *Summary* běhu uvidíš
   „Podpis ✅ Certum – Open Source Developer, …“ a „Kontrola podpisu ✅ všech
   N spustitelných souborů je podepsaných“. Kontrola u tebe: na stažený
   `Kine-Setup.exe` pravým tlačítkem → *Vlastnosti* → *Digitální podpisy*.
8. **Obnova:** certifikát platí nejvýš rok a čtvrt (pravidla od února 2026).
   Workflow 30 dní předem napíše varování; obnovíš ho u Certumu, tajemství
   v GitHubu zůstávají (stejný účet SimplySign). Kdyby měl účet víc
   certifikátů, ten správný vybere proměnná (*Variables*) `CERTUM_CERT_SHA1`
   = otisk certifikátu.

**Když krok „Podpis – příprava“ spadne** („Přihlášení do SimplySign se
nepovedlo“): zkontroluj obě tajemství a spusť Vydání znovu. Když to nejde ani
napodruhé, pošli mi log toho kroku – nespouštěj to pořád dokola, opakované
špatné kódy umí účet u Certumu zamknout. Bez tajemství (nebo když je smažeš)
se vydává jako dřív, jen nepodepsaně.

**SmartScreen** („Systém Windows chránil váš počítač“, modré okno) může
u nového certifikátu ještě chvíli varovat, než si podpis vybuduje pověst (pár
set stažení) – tam „Další informace“ → „Přesto spustit“ jde. Inteligentní
řízení aplikací už ale nic neblokuje.

**Aktualizace:** nainstalované nepodepsané verze si podepsanou aktualizaci
stáhnou normálně. Appka u aktualizací jméno v certifikátu nekontroluje
(stahuje přes HTTPS a hlídá kontrolní součet), takže pozdější přechod na jiný
certifikát (třeba firemní) aktualizace nerozbije.

### Další možnosti

- **Azure Artifact Signing** (Microsoft, 9,99 $/měsíc) – jednotlivci jen USA
  a Kanada, v EU jen ověřená **firma**. Workflow ho umí (podepíše i pluginy):
  *Secrets* `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`;
  *Variables* `AZURE_SIGN_ENDPOINT` (např. `https://weu.codesigning.azure.net`),
  `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER` (přesně
  jako v certifikátu, např. `CN=Kine s.r.o.`). Když jsou nastavené Certum
  i Azure, použije se Certum.
- **Microsoft Store** (zdarma, podepíše Microsoft) – Kine by se instalovalo ze
  Storu (balík MSIX); větší přestavba, jde udělat později.
- **SignPath Foundation** (zdarma pro open source) – schvalují projekt ručně,
  v podpisu je „SignPath Foundation“.
- Klasický **OV certifikát** (Certum Standard, SSL.com…) – funguje stejně
  jako Certum Open Source, jen dražší.

**Falešný poplach antiviru** (Defender označí `Kine-Setup.exe` jako
hrozbu) nahlas Microsoftu: microsoft.com/wdsi/filesubmission → *Software
developer* → nahrát soubor. Obvykle to opraví do pár dní a je to zdarma.
Podepsaný instalátor to skoro vždy vyřeší samo.

## Když něco nejde

- **Actions červené** – klikni na běh, otevři krok, který spadl, a pošli
  mi text chyby. Stejnou verzi jde pustit znovu (Run workflow) – soubory ve
  vydání se přepíšou.
- **„Aktualizace se nepodařilo zkontrolovat: …“** – v hlášce je důvod:
  `404` u `latest.yml` = ve vydání na GitHubu (nebo v R2 složce `full/`,
  `clipper/`) soubor chybí → spusť workflow znovu; `ENOTFOUND` /
  `ECONNREFUSED` = bez internetu nebo blokuje firewall.
- **Tlačítko na webu vede na 404** – R2: špatná adresa v
  `NEXT_PUBLIC_DESKTOP_DOWNLOAD_BASE` nebo bucket bez veřejného přístupu;
  GitHub: repo soukromé nebo jinak pojmenované (`NEXT_PUBLIC_DESKTOP_REPO`).
- **Appka po instalaci hlásí problém se zkratkou** – zkratku drží jiný
  program (Discord, NVIDIA…), v nastavení appky vyber jinou.
