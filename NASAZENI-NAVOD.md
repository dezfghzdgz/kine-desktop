# Jak appku pustit "naostro" (aby se mohl přihlásit kdokoliv)

Appka běží v mém sandboxu bez přístupu na internet, takže samotné kliknutí na
"Deploy" musíš udělat ty - ale appka je na to připravená a tenhle soubor tě
provede krok za krokem.

## 1. Appka na GitHub (jednou, pak se to updatuje samo)

1. Založ si účet na github.com (zdarma), pokud ho ještě nemáš
2. Vytvoř nový repozitář (např. "kine")
3. Nahraj do něj celou složku appky (buď přes web rozhraní GitHubu - "Upload files",
   nebo přes GitHub Desktop appku, což je jednodušší na víc souborů najednou)

## 2. Appka na Vercel (appka, co appku "spustí" pro celý internet)

1. Jdi na vercel.com, založ si účet zdarma (nejjednodušší je přihlásit se rovnou
   přes GitHub účet z kroku 1)
2. Klikni "Add New Project" a vyber repozitář "kine"
3. Vercel appku pozná (je to Next.js appka, pozná to samo) - **NEKLIKEJ ještě Deploy**
4. Rozklikni "Environment Variables" a vlož TAM PŘESNĚ TY SAMÉ hodnoty, co máš
   teď v souboru `.env.local` na svém počítači:
   - NEXT_PUBLIC_SUPABASE_URL
   - NEXT_PUBLIC_SUPABASE_ANON_KEY
   - SUPABASE_SERVICE_ROLE_KEY
   - CLOUDFLARE_ACCOUNT_ID
   - CLOUDFLARE_STREAM_API_TOKEN
   - NEXT_PUBLIC_GIPHY_API_KEY (pokud už máš vlastní klíč)
5. Teprve teď klikni "Deploy"
6. Za pár minut appka dostane veřejnou adresu, něco jako `kine-xyz.vercel.app`

## 3. Důležitý krok v Supabase (jinak se nepůjde přihlásit/registrovat!)

Appka teď zná appku jen jako `localhost:3000`. Musíš appce říct její novou,
skutečnou adresu:

1. Supabase dashboard → **Authentication → URL Configuration**
2. **Site URL**: změň na svoji novou Vercel adresu (`https://kine-xyz.vercel.app`)
3. **Redirect URLs**: přidej `https://kine-xyz.vercel.app/reset-password`
   (nech tam klidně i tu s localhost, ať appka jde testovat dál i u tebe doma)

## 4. Vlastní doména (nepovinné, ale hezčí než "kine-xyz.vercel.app")

1. Kup si doménu (Namecheap, Forpsi, Wedos...) - řádově pár stovek Kč/rok
2. Ve Vercelu: Project → Settings → Domains → přidej svou doménu
3. Vercel ti řekne přesně, jaký záznam si máš nastavit u toho, kde jsi doménu koupil
4. Zopakuj krok 3 (Supabase Site URL/Redirect URLs) s novou doménou místo Vercel adresy

## 5. Otestuj to pořádně, než to ukážeš lidem

- Zaregistruj se jako nový uživatel na skutečné veřejné adrese
- Nahraj video, projdi appku napříč (appka jsme spolu ladili hodně dlouho, ale
  "naostro" prostředí je pořád trochu jiné než tvůj počítač)

## 6. Aby appku šlo najít v Googlu (ne jen přes odkaz)

Appka teď umí appce automaticky vytvořit `/robots.txt` a `/sitemap.xml` (seznam
všech stránek appky pro vyhledávače) - stačí appce dát vědět svou skutečnou
adresu:

1. Do Environment Variables ve Vercelu (viz krok 2) přidej ještě
   `NEXT_PUBLIC_SITE_URL` s hodnotou tvé skutečné adresy (`https://kine.cz`
   nebo `https://kine-xyz.vercel.app`)
2. Jdi na **Google Search Console** (search.google.com/search-console),
   zdarma se přihlas přes Google účet
3. Přidej appku svou adresu jako "Property"
4. Google appce dá adresu na ověření vlastnictví appky (obvykle přes DNS
   záznam nebo HTML soubor - Search Console tě tím provede)
5. Po ověření appce v Search Console dej appce vědět o sitemapě: vlož adresu
   `https://tvoje-adresa.cz/sitemap.xml` do sekce "Sitemaps"

**Buď prosím trpělivý/á:** appka se v Googlu neobjeví hned - obvykle to
appce trvá pár dní až týdny, než appka appku poprvé zaindexuje, a mnohem
déle, než appka appku začne appce ukazovat na předních místech výsledků
(to už záleží hlavně na tom, kolik lidí appku skutečně používá a odkazuje
na ni odjinud, ne na technickém nastavení).

## 7. Platby (Stripe) - Kine Plus a Podpořit Kine

Klíče Stripe patří **jen do Vercelu**, nikdy do GitHubu (repo je veřejné).
Nejdřív všechno v testovacím režimu (klíč `sk_test_…`), pak to samé naostro
(`sk_live_…`) - ceny, webhook i portál má Stripe pro každý režim zvlášť.

1. **Stripe:** dokonči aktivaci účtu (podnikání, IČO, bankovní účet).
   Settings → Business (první dlaždice v Account settings) → Public details:
   web, podpora `kinesupport@gmail.com`, podmínky
   `https://tvoje-adresa/terms`, ochrana údajů `https://tvoje-adresa/privacy`,
   text na výpisu `KINE`. Settings → Billing → Customer portal → **Save**.
   Kine Plus se prodává v eurech (výplaty v eurech = bez převodu měny).
2. **Vercel → Environment Variables:**
   - `STRIPE_SECRET_KEY` - Stripe → Developers → API keys → Secret key
   - `NEXT_PUBLIC_OPERATOR_NAME`, `NEXT_PUBLIC_OPERATOR_ICO`,
     `NEXT_PUBLIC_OPERATOR_ADDRESS` - provozovatel (jméno, IČO, místo
     podnikání); zákon je chce na webu. U firmy navíc
     `NEXT_PUBLIC_OPERATOR_REGISTRY` (např. „zapsaná v obchodním rejstříku
     u Městského soudu v Praze, oddíl C, vložka …“).
   - → **Redeploy**
3. **Na webu `/admin/stripe`** (jen admin, v menu „Platby (Stripe)“):
   - „Vytvořit ceny ve Stripe“ (předvyplněné doporučené ceny v eurech: Kine Plus
     €2.49, Clips Plus €2.99, Kine Plus + Clips €3.99; pro USA v dolarech
     $2.99 / $3.49 / $4.49). Web si ceny najde ve Stripe sám (do pár minut) -
     do Vercelu se nic nekopíruje. Starší `STRIPE_PLUS_*_PRICE_ID`
     a `NEXT_PUBLIC_PLUS_…_PRICE_LABEL` můžou zůstat (jsou jen záloha), nebo je smaž.
     Na webu se ceny ukazují jen v eurech (v USA v dolarech), koruny nikdy.
   - „Vytvořit / opravit webhook“ → vypíše `STRIPE_WEBHOOK_SECRET` (ukáže se
     jen jednou) → do Vercelu → **Redeploy**. Bez něj webhook nic nepřijme
     (ochrana proti podvrženým platbám).
   - Kdyby na platební stránce Stripe Čech viděl ceny v Kč: to je přepočet Stripe
     („Adaptive Pricing“) - vypnout jde ve Stripe → Settings → Payments.
4. **Zapnutí:** `NEXT_PUBLIC_PAYMENTS=1` → **Redeploy**. Zkus koupi na `/plus`
   testovací kartou `4242 4242 4242 4242` (libovolné budoucí datum a CVC).
5. **Peníze pro tvůrce** (předplatné kanálu, podpory ve vysílání, Super díky
   pod videi): krok 8 níž.
6. Placení je komerční použití → Vercel plán **Pro** (Hobby je jen nekomerční).
7. Doporučeně ve Vercelu `UPLOAD_STORAGE_HOURS=5` (úložiště účtu 5 h, Kine Plus
   3× víc = 15 h; výchozí je 30 h / 90 h). Cloudflare účtuje každou uloženou
   minutu (plný účet s Plus by stál až ~570 Kč měsíčně), takže než přejdeme na
   levnější úložiště videí, ať předplatné pokryje i nejnáročnější tvůrce.

## 8. Peníze pro tvůrce - předplatné kanálu, podpory ve vysílání, Super díky

Diváci platí tvůrcům: měsíční předplatné kanálu (od €3), podpory se vzkazem
v chatu přenosu (jako Super Chat) a Super díky pod videi (jako Super Thanks).
Peníze jdou přes Stripe rovnou na Stripe účet tvůrce, Kine si nechá 15 %
(z toho platí poplatek Stripe za platbu). Výplaty tvůrcům jednou měsíčně.

1. **Stripe → Connect** (v menu More → Connect, nebo Settings → Connect) →
   „Get started“: platforma / marketplace, účty tvůrců **Express**, platby
   zakládá platforma. Settings → Connect → Branding: název Kine, ikona, barva
   (tvůrci to uvidí při propojení).
2. **Supabase → SQL Editor** - spusť (jdou pouštět opakovaně):
   `supabase-migration-creator-subscriptions.sql`,
   `supabase-migration-podpory-kontrola.sql`, `supabase-migration-super-diky.sql`
   a pak ještě jednou `supabase-migration-statistiky-prispevky-zamky.sql`
   (část „příspěvky jen pro členy“ potřebuje tabulku členství).
3. **Vercel:** `NEXT_PUBLIC_CREATOR_PAYMENTS=1` (volitelně `LIVE_TIP_FEE_PERCENT`,
   výchozí 15) → **Redeploy**. Na `/admin/stripe` pak klikni na „Vytvořit /
   opravit webhook“ - doplní událost `charge.refunded` (vrácené podpory se
   tvůrci vezmou zpět); podpisový klíč zůstává stejný.
4. **Tvůrce:** Settings → výdělky tvůrce → propojit Stripe (ověření totožnosti a
   bankovní účet přímo u Stripe) → nastavit cenu předplatného kanálu.
5. **Vyzkoušej** z druhého účtu: Super díky pod videem, podpora v přenosu,
   předplatné kanálu a příspěvek „Jen pro členy“ (nečlen vidí jen zamčenou
   dlaždici s počtem, člen celý příspěvek).

Počítej s tím, že Stripe Connect stojí Kine asi €2 za každého tvůrce v měsíci,
kdy dostane výplatu (+ 0,25 % a pár centů za výplatu) - 15 % se vyplatí u tvůrců,
kteří dostanou aspoň ~€15-20 měsíčně. Kine tu přijímá peníze pro tvůrce, tak
to prober s účetní.

## 9. Databáze: zámky, statistiky vysílání, příspěvky (migrace) a šifrovaná záloha

1. **Supabase → SQL Editor** → spusť `supabase-migration-statistiky-prispevky-zamky.sql`
   (celý soubor; jde pouštět opakovaně). Na konci vypíše tři sloupce - `true` znamená
   hotovo:
   - `zamky` - souběžná nahrávání jednoho účtu jdou za sebou (limity nejde obejít
     20 požadavky naráz),
   - `statistiky_vysilani` - Statistiky kanálu → Živé vysílání (sbírá se od teď),
   - `prispevky_pro_cleny` - až 10 fotek v příspěvku, příspěvky jen pro členy, brzda
     3 příspěvky za minutu. Když je tu `false`, chybí tabulka členství - viz krok 8.
2. **Záloha databáze je šifrovaná.** GitHub → repo Kine → Settings → Secrets and
   variables → Actions → New repository secret `BACKUP_PASSPHRASE` = dlouhé náhodné
   heslo (aspoň 24 znaků). **Ulož si ho i jinde** (správce hesel) - bez něj zálohu
   neotevře nikdo, ani ty. Bez tohohle secretu se záloha schválně nenahraje.
   Obnova: `gpg --decrypt zaloha-….sql.gz.gpg | gunzip > zaloha.sql` (návod je
   i v `.github/workflows/zaloha-databaze.yml`).
3. **Doporučeně repo Kine soukromé** (Settings → General → Danger Zone → Change
   visibility → Private). Artefakty (zálohy) veřejného repa si stáhne kdokoli
   přihlášený na GitHubu a kód veřejně ukazuje, kde hledat slabá místa. Vercel
   funguje se soukromým repem dál.
4. Jestli záloha někdy proběhla nešifrovaně (Actions → Záloha databáze → zelené běhy):
   smaž u každého běhu artefakt (Artifacts → koš) a ve Studiu (Živě) si nech vygenerovat
   nový klíč pro vysílání - stará záloha ho obsahovala.


## 10. Push oznámení, ochrana proti botům, náklady a hry (migrace)

1. **Supabase → SQL Editor** → spusť `supabase-migration-push-hry-naklady.sql` (celý; jde
   pouštět opakovaně). Na konci tři sloupce `push`, `hry`, `naklady` - `true` = hotovo.
2. **Push oznámení:** `www.playkine.com/admin/push` → **Vygenerovat klíče** (vzniknou
   v tvém prohlížeči, soukromý klíč neprojde serverem). Do Vercelu (Settings →
   Environment Variables, Production) vlož `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
   a `VAPID_PRIVATE_KEY` → Deployments → **Redeploy**. Pak Nastavení → Oznámení →
   Zapnout → Poslat zkušební. Klíče už neměň - nové klíče = všichni si oznámení
   zapínají znovu. Na iPhonu/iPadu chodí oznámení jen z Kine přidaného na plochu.
3. **Ochrana proti botům (Cloudflare Turnstile)** - v tomhle pořadí, jinak se nikdo
   nepřihlásí:
   1. Cloudflare → **Turnstile** → **Add widget**: název Kine, hostname `playkine.com`
      a `www.playkine.com`, režim **Managed** → Create. Zkopíruj **Site Key**
      a **Secret Key**.
   2. Vercel: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = Site Key → **Redeploy**.
   3. Vyzkoušej registraci a přihlášení na webu.
   4. Supabase → Project Settings → Authentication → **Bot and Abuse Protection** →
      **Enable CAPTCHA protection** → Cloudflare Turnstile → Secret Key → Save.
   - Appka Kine do PC se od verze 0.13.3 přihlašuje jen přes prohlížeč (heslo na webu),
     takže jí bod 4 nevadí. Starší verze: přihlášení e-mailem a heslem po bodu 4 nejde,
     „Připojit přes prohlížeč“ ano. Telefon používá prohlížeč vždycky.
4. **Náklady:** `www.playkine.com/admin/costs`. Přehrané minuty ukáže, až má token
   `CLOUDFLARE_STREAM_API_TOKEN` v Cloudflare navíc oprávnění **Account Analytics: Read**
   (My Profile → API Tokens → token Kine → Edit). Kontrola běží jednou denně s úklidem
   videí (cron) a při potížích pošle správcům oznámení. Hranice a limity jdou změnit
   proměnnými `COST_ALERT_*`, `SUPABASE_*_LIMIT_*`, `CF_STREAM_*` (viz `.env.example`).
5. **Hry** fungují po migraci samy (stránka Hry v menu). Bez migrace jde všechno kromě
   tlačítka Sledovat hru a výběru hry ve studiu vysílání.
