# Jak dostat Kine do PC na GitHub a k lidem

Čtyři kroky, pak už jen tag pro každou další verzi. Web Kine si instalátor
bere sám z GitHub Releases – lidi klikají na kine…/download a GitHub
nevidí.

## 1. Repo na GitHubu (jednou)

1. github.com → vpravo nahoře **+** → **New repository**
2. Repository name: **kine-desktop** (přesně takhle – web Kine ho tak čeká;
   kdyby jinak, nastav na Vercelu `NEXT_PUBLIC_DESKTOP_REPO=tvoje-jmeno/nazev`)
3. **Public** – musí být veřejné, jinak si lidi instalátor nestáhnou a
   appka se neumí sama aktualizovat
4. Nic nezaškrtávej (README, .gitignore, licence už v balíčku jsou) → **Create repository**

## 2. Nahrát kód (jednou)

Rozbal `kine-desktop-zdroj.zip` do složky, otevři v ní terminál
(PowerShell: pravé tlačítko ve složce → „Otevřít v terminálu“) a po řádcích:

```
git init
git add .
git commit -m "Kine do PC 0.1.0"
git branch -M main
git remote add origin https://github.com/dezfghzdgz/kine-desktop.git
git push -u origin main
```

(`dezfghzdgz` nahraď svým jménem na GitHubu, když je jiné.) Když se git
zeptá na přihlášení, použij GitHub Desktop nebo přihlášení v prohlížeči,
které nabídne.

## 3. Vydat verzi = udělat tag

```
git tag v0.1.0
git push origin v0.1.0
```

Na GitHubu v záložce **Actions** se rozjede „Vydání“ – asi 5 minut. Pak je
v **Releases** verze v0.1.0 se souborem **Kine-Setup.exe** (a `latest.yml`,
podle kterého si nainstalované appky samy najdou aktualizaci).

Od téhle chvíle funguje na webu Kine tlačítko **Stáhnout pro Windows**
(kine…/download/windows) – míří vždy na nejnovější vydání.

## 4. Každá další verze

1. V `package.json` zvedni `"version"` (třeba `0.1.1`).
2. ```
   git add .
   git commit -m "v0.1.1"
   git push
   git tag v0.1.1
   git push origin v0.1.1
   ```
3. Za pár minut je nová verze v Releases a všem nainstalovaným appkám se
   stáhne na pozadí a nainstaluje po ukončení.

## Když něco nejde

- **Actions červené** – klikni na běh, otevři krok, který spadl, a pošli
  mi text chyby.
- **Windows hlásí „Neznámý vydavatel“** – normální, instalátor není
  podepsaný certifikátem. „Další informace“ → „Přesto spustit“. Podpis se
  dá dokoupit později (Azure Trusted Signing, ~10 $/měsíc), appka se
  nemění.
- **Tlačítko na webu vede na 404** – zatím není žádné vydání (krok 3),
  nebo je repo soukromé, nebo se jinak jmenuje (`NEXT_PUBLIC_DESKTOP_REPO`).
