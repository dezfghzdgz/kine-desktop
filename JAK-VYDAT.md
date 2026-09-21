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
   Za ~6 minut je v **Releases** verze podle `package.json`
   (teď `0.2.0`) se soubory `Kine-Setup.exe`, `Kine-Clipper-Setup.exe`
   a `latest.yml`.

Každá další verze: v `package.json` zvedni `"version"`, nahraj soubory,
Run workflow. Nainstalovaným appkám se nová verze stáhne na pozadí a
nainstaluje po ukončení.

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
   R2“ uvidíš `nahráno: …/Kine-Setup.exe`.

Od té chvíle `kine…/download/windows` posílá lidi na naše úložiště a
nainstalované appky si tam hledají aktualizace (`latest.yml`). GitHub
Releases zůstávají jako záloha – kdyby R2 nebylo nastavené, web míří tam.

## C) Antivirus / SmartScreen („Systém Windows chránil váš počítač“)

Není to virus – hlášky jsou proto, že instalátor **není podepsaný
certifikátem ověřeného vydavatele** a je nový (SmartScreen si buduje
pověst podle počtu stažení). Obejít se to dá („Další informace“ →
„Přesto spustit“; v prohlížeči „Zachovat“), ale správné řešení je podpis:

- **Azure Trusted Signing** (Microsoft, ~10 $/měsíc) – nejlevnější a
  SmartScreen mu věří hned. Potřebuje ověřenou firmu nebo (v podporovaných
  zemích) ověřenou osobu: portal.azure.com → **Trusted Signing** →
  vytvořit účet, ověřit identitu, vytvořit **Certificate profile**
  (Public trust). Pak založit App registration (Entra ID) s tajným klíčem
  a dát jí roli *Trusted Signing Certificate Profile Signer*.
- Do GitHubu pak: **Secrets** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`; **Variables** `AZURE_SIGN_ENDPOINT`
  (např. `https://weu.codesigning.azure.net`), `AZURE_SIGN_ACCOUNT`
  (název účtu Trusted Signing), `AZURE_SIGN_PROFILE` (název profilu),
  `AZURE_SIGN_PUBLISHER` (jméno vydavatele přesně podle certifikátu,
  např. `CN=Kine s.r.o.`).
- Workflow podpis přidá sám, jakmile ty hodnoty existují
  (`scripts/publish-config.mjs`). Nic dalšího se nemění.

Alternativa: klasický OV certifikát na podpis kódu (Certum, SSL.com,
~100–300 € ročně) – funguje taky, ale SmartScreen mu věří až po čase.

## Když něco nejde

- **Actions červené** – klikni na běh, otevři krok, který spadl, a pošli
  mi text chyby.
- **Tlačítko na webu vede na 404** – R2: špatná adresa v
  `NEXT_PUBLIC_DESKTOP_DOWNLOAD_BASE` nebo bucket bez veřejného přístupu;
  GitHub: repo soukromé nebo jinak pojmenované (`NEXT_PUBLIC_DESKTOP_REPO`).
- **Appka po instalaci hlásí problém se zkratkou** – zkratku drží jiný
  program (Discord, NVIDIA…), v nastavení appky vyber jinou.
