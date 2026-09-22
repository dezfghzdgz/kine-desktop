# Jak vydat Kine do PC (a jak ho dostat k lidem bez GitHubu)

Repo `kine-desktop` už na GitHubu máš a první vydání (v0.1.0) proběhlo.
Tady je, co dělat dál: **A)** nahrát novou verzi kódu, **B)** zapnout
stahování z našeho úložiště místo GitHubu, **C)** podpis proti hlášce
antiviru/SmartScreenu.

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
Run workflow. Nainstalovaným appkám se nová verze stáhne na pozadí a
nainstaluje po ukončení.

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

## C) Antivirus / SmartScreen („Systém Windows chránil váš počítač“)

Není to virus a **není to nic v kódu** – hláška je proto, že instalátor
**není podepsaný certifikátem ověřeného vydavatele** a je nový
(SmartScreen si buduje pověst podle počtu stažení). Obejít se to dá
(„Další informace“ → „Přesto spustit“; v prohlížeči „Zachovat“) a web to
u tlačítka ke stažení říká, ale správné řešení je podpis. Jediný, kdo ho
může zařídit, jsi ty (jde o tvou identitu); workflow je připravený.

Možnosti (stav září 2026):

1. **Azure Artifact Signing** (dřív Trusted Signing; Microsoft,
   9,99 $/měsíc, podpis v CI umí workflow už teď). Háček: jako
   **jednotlivec** ho dostaneš jen v USA a Kanadě. V EU potřebuje
   **ověřenou firmu** (živnost s IČO / s.r.o.; podle Microsoftu bez
   podmínky stáří firmy). Až firmu budeš mít: portal.azure.com →
   **Artifact Signing** → účet → **Identity validation** (Organization,
   Public trust; trvá 1–20 pracovních dní) → **Certificate profile**.
   Pak App registration (Entra ID) s tajným klíčem a role *Trusted Signing
   Certificate Profile Signer*. Do GitHubu: **Secrets** `AZURE_TENANT_ID`,
   `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; **Variables**
   `AZURE_SIGN_ENDPOINT` (např. `https://weu.codesigning.azure.net`),
   `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER`
   (přesně jako v certifikátu, např. `CN=Kine s.r.o.`). Workflow podpis
   přidá sám (`scripts/publish-config.mjs`), podepíše obě appky.
2. **Certum „Open Source Code Signing“** – nejlevnější cesta pro
   jednotlivce (od 49 € s podpisem v cloudu SimplySign, od 69 € s kartou),
   repo kine-desktop je veřejné s licencí MIT, takže na něj máš nárok.
   Ověřují tvou totožnost (doklad). Podpis v GitHub Actions přes SimplySign
   jde, ale je to křehčí (přihlášení do jejich aplikace s TOTP) – když si ho
   vybereš, napiš mi a napojím ho do workflow.
3. Klasický **OV certifikát** pro jednotlivce (Certum Standard od 139 €,
   SSL.com apod.) – funguje jako 2, jen dražší.

U všech tří platí: „Neznámý vydavatel“ zmizí hned, ale SmartScreen může
ještě chvíli varovat, než si podpis vybuduje pověst (pár set stažení).

**Falešný poplach antiviru** (Defender označí `Kine-Setup.exe` jako
hrozbu) nahlas Microsoftu: microsoft.com/wdsi/filesubmission → *Software
developer* → nahrát soubor. Obvykle to opraví do pár dní a je to zdarma.
Podepsaný instalátor to skoro vždy vyřeší samo.

## Když něco nejde

- **Actions červené** – klikni na běh, otevři krok, který spadl, a pošli
  mi text chyby.
- **Tlačítko na webu vede na 404** – R2: špatná adresa v
  `NEXT_PUBLIC_DESKTOP_DOWNLOAD_BASE` nebo bucket bez veřejného přístupu;
  GitHub: repo soukromé nebo jinak pojmenované (`NEXT_PUBLIC_DESKTOP_REPO`).
- **Appka po instalaci hlásí problém se zkratkou** – zkratku drží jiný
  program (Discord, NVIDIA…), v nastavení appky vyber jinou.
