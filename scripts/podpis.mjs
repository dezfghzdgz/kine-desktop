#!/usr/bin/env node
/**
 * Podepisování ve workflow Vydání (.github/workflows/release.yml, Windows).
 * Návod pro člověka: JAK-VYDAT.md, část C.
 *
 *   node scripts/podpis.mjs priprav  - před sestavením: přihlášení (Certum SimplySign nebo Azure),
 *                                      podepsané pluginy instalátoru (NSIS), pomocník kine-helper.exe
 *   node scripts/podpis.mjs over     - po sestavení: je podepsané všechno, co Windows spouští?
 *   node scripts/podpis.mjs odhlas   - na konci (vždycky): konec relace SimplySign
 *
 * Proč všechno a ne jen instalátor: Inteligentní řízení aplikací (Smart App
 * Control) ve Windows 11 pustí jen podepsaný kód - instalátor, odinstalátor,
 * Kine.exe, každou .dll (ffmpeg.dll, dxcompiler.dll…), ffmpeg.exe, pluginy NSIS,
 * které instalátor rozbalí do %TEMP%, i pomocníka. Nepodepsaná jediná
 * knihovna = "část této aplikace byla zablokována".
 *
 * Bez tajemství se nic nepodepisuje a vydání proběhne jako dřív (nepodepsané).
 * Certum (tajemství CERTUM_USERNAME + CERTUM_TOTP): nainstaluje se SimplySign
 * Desktop, přihlásí se jednorázovým kódem (TOTP z QR kódu při aktivaci) a
 * certifikát z cloudu se objeví v úložišti Windows; pak se podepisuje
 * signtoolem podle otisku (scripts/podpisHook.mjs, i pro electron-builder).
 * Přihlášení ovládá okno SimplySign klávesami (oficiální cesta pro CI není) -
 * postup jako github.com/jay0lee/certum-cloud-code-sign, který na runnerech
 * GitHubu funguje; navíc se kontroluje, že je okno opravdu v popředí, a za
 * úspěch se bere až certifikát v úložišti.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonName, isSignable, parseTotp, peHasSignature, pickCertificate, secondsLeft, sendKeysEscape, signingMode, summarizeSignatures, totpCode } from './podpisCore.mjs';
import { signFiles } from './podpisHook.mjs';
import * as PS from './podpisPs.mjs';

const WIN = process.platform === 'win32';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(process.env.RUNNER_TEMP || tmpdir(), 'kine-podpis');
const SIMPLYSIGN_PATHS = [
  'C:\\Program Files\\Certum\\SimplySign Desktop\\SimplySignDesktop.exe',
  'C:\\Program Files (x86)\\Certum\\SimplySign Desktop\\SimplySignDesktop.exe',
];

// ---- drobnosti ---------------------------------------------------------------

const log = (msg) => console.log(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (file) => relative(ROOT, file).replace(/\\/g, '/') || file;
const lastLines = (text, n = 3) =>
  String(text ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-n)
    .join(' ');

/** Hodnota se v logu GitHubu ukáže jako *** (tajemství, jednorázový kód). */
function mask(value) {
  if (value && process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value}`);
}

/** Proměnná pro tento i další kroky workflow. */
function exportEnv(name, value) {
  process.env[name] = value;
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

/** Řádky do Summary běhu (Actions -> běh -> Summary). */
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function fail(message) {
  console.log(`::error::${message}`);
  summary(`### Podpis selhal\n\n${message}\n`);
  process.exit(1);
}

/** PowerShell (Windows PowerShell 5.1) se skriptem v -EncodedCommand; tajné věci jen přes proměnné prostředí. */
function powershell(script, { env = {}, timeout = 120000 } = {}) {
  const full = `${PS.PRELUDE}\n${script}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function psJson(script, opts) {
  const r = powershell(script, opts);
  if (!r.ok) throw new Error(`PowerShell: ${lastLines(r.stderr || r.stdout || r.error?.message)}`);
  const text = r.stdout.trim();
  return text ? JSON.parse(text) : null;
}

async function download(url, file) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 * 1024) throw new Error(`soubor je podezřele malý (${buf.length} B)`);
      writeFileSync(file, buf);
      return;
    } catch (e) {
      last = e;
      log(`stažení ${url} nevyšlo (pokus ${attempt}): ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
  throw last;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const dllsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.dll$/i.test(f)).map((f) => join(dir, f)) : []);

/** Vložený podpis v hlavičce PE - čte se jen začátek souboru (Kine.exe má přes 150 MB). */
function fileHasSignature(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const n = readSync(fd, head, 0, head.length, 0);
    return peHasSignature(head.subarray(0, n), fstatSync(fd).size) === true;
  } finally {
    closeSync(fd);
  }
}

/** Smazat složku, i když ji Windows chvíli drží (antivir, právě ukončený program). */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    return true;
  } catch (e) {
    log(`  ${rel(dir)} nejde smazat: ${e.message}`);
    return false;
  }
}

// ---- podepisování --------------------------------------------------------------

/** Windows SDK signtool (x64 - virtuální karta SimplySign je 64bitová). */
function findSigntool() {
  if (process.env.SIGNTOOL_PATH && existsSync(process.env.SIGNTOOL_PATH)) return process.env.SIGNTOOL_PATH;
  const versionKey = (v) => v.split('.').map((n) => n.padStart(6, '0')).join('.');
  for (const base of ['C:\\Program Files (x86)\\Windows Kits\\10\\bin', 'C:\\Program Files\\Windows Kits\\10\\bin']) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
    for (const v of versions) {
      const p = join(base, v, 'x64', 'signtool.exe');
      if (existsSync(p)) return p;
    }
    const flat = join(base, 'x64', 'signtool.exe');
    if (existsSync(flat)) return flat;
  }
  fail('signtool.exe (Windows SDK, x64) na runneru není.');
}

/** Zkouška bez GitHubu: soubor PFX (signtool na Windows, osslsigncode jinde). */
function pfxSigner() {
  if (!existsSync(process.env.KINE_SIGN_PFX)) fail(`KINE_SIGN_PFX: soubor ${process.env.KINE_SIGN_PFX} neexistuje`);
  if (WIN) exportEnv('SIGNTOOL_PATH', findSigntool());
  return { name: 'soubor PFX (zkouška)', thumbprint: '', sign: (files) => signFiles(files) };
}

function azureSigner() {
  log('Azure Artifact Signing: instaluji modul TrustedSigning…');
  const setup = powershell(PS.AZURE_SETUP, { timeout: 10 * 60 * 1000 });
  if (!setup.ok) fail(`Modul TrustedSigning (Azure) se nenainstaloval: ${lastLines(setup.stderr || setup.stdout, 2)}`);
  return {
    name: 'Azure Artifact Signing',
    thumbprint: '',
    sign(files) {
      for (let i = 0; i < files.length; i += 16) {
        const part = files.slice(i, i + 16);
        const r = powershell(PS.AZURE_SIGN, { env: { KINE_SIGN_FILES: part.join(',') }, timeout: 10 * 60 * 1000 });
        if (!r.ok) throw new Error(`Azure nepodepsal ${part.map((f) => basename(f)).join(', ')}: ${lastLines(r.stderr || r.stdout, 2)}`);
      }
    },
  };
}

// ---- Certum SimplySign ------------------------------------------------------------

async function installSimplySign() {
  let exe = SIMPLYSIGN_PATHS.find((p) => existsSync(p));
  if (exe) return exe;
  const version = process.env.CERTUM_SIMPLYSIGN_VERSION?.trim() || '9.4.4.92';
  const url =
    process.env.CERTUM_SIMPLYSIGN_URL?.trim() || `https://files.certum.eu/software/SimplySignDesktop/Windows/${version}/SimplySignDesktop-${version}-64-bit-en.msi`;
  const msi = join(STATE, `SimplySignDesktop-${version}.msi`);
  log(`SimplySign Desktop ${version}: stahuji ${url}`);
  try {
    await download(url, msi);
  } catch (e) {
    fail(`SimplySign Desktop se nepodařilo stáhnout (${e.message}). Novější verze: proměnná (Variables) CERTUM_SIMPLYSIGN_VERSION.`);
  }
  // Instalátor musí být platně podepsaný Certumem (Asseco) - jinak ho nespouštět.
  const sig = psJson(PS.FILE_SIGNATURE, { env: { KINE_FILE: msi } });
  if (sig?.Status !== 'Valid' || !/asseco|certum|unizeto/i.test(String(sig?.Subject ?? ''))) {
    fail(`Stažený instalátor SimplySign nemá platný podpis Certumu (${sig?.Status}, ${commonName(sig?.Subject) || 'bez podpisu'}) - neinstaluji.`);
  }
  log(`SimplySign Desktop: podpis instalátoru v pořádku (${commonName(sig.Subject)})`);
  const r = spawnSync('msiexec.exe', ['/i', msi, '/qn', '/norestart', '/l*v', join(STATE, 'simplysign-install.log')], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
  if (r.status !== 0 && r.status !== 3010) fail(`Instalace SimplySign Desktop skončila chybou ${r.status ?? r.error?.message}.`);
  exe = SIMPLYSIGN_PATHS.find((p) => existsSync(p));
  if (!exe) fail('SimplySign Desktop se nainstaloval, ale SimplySignDesktop.exe nikde není.');
  return exe;
}

function launch(exe) {
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log(`SimplySign Desktop se nespustil: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`SimplySign Desktop se nespustil: ${e.message}`);
  }
}

/** Přihlašovací okno SimplySign (nebo jeho hláška) je otevřené? */
function simplySignWindow() {
  try {
    return psJson(PS.SIMPLYSIGN_WINDOW);
  } catch {
    return null;
  }
}

/** Otevřená okna (jen názvy programů a titulky) - do logu, když přihlášení nejde. */
function describeWindows() {
  try {
    const list = psJson(PS.WINDOW_LIST);
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    return arr.map((w) => `${w.ProcessName}: "${w.MainWindowTitle}"`).join('; ') || 'žádná';
  } catch (e) {
    return `nejde zjistit (${e.message})`;
  }
}

/** SimplySign spustit tak, aby bylo vidět přihlašovací okno (poprvé se rozjede na pozadí, napodruhé ukáže okno). */
async function openLoginWindow(exe) {
  powershell(PS.MINIMIZE_ALL);
  await sleep(1000);
  launch(exe);
  await sleep(3000);
  launch(exe);
  await sleep(3000);
  let window = simplySignWindow();
  for (let i = 0; i < 5 && !window; i++) {
    log(`SimplySign: přihlašovací okno zatím není (pokus ${i + 1}/5), spouštím znovu…`);
    launch(exe);
    await sleep(3000);
    window = simplySignWindow();
  }
  return window;
}

function listCertificates() {
  try {
    return psJson(PS.LIST_CERTIFICATES);
  } catch (e) {
    log(`certifikáty nejde vypsat: ${e.message}`);
    return null;
  }
}

const findCertificate = (wanted) => pickCertificate(listCertificates(), wanted);

/**
 * Přihlášení: jméno + jednorázový kód do okna SimplySign. Úspěch = certifikát
 * v úložišti Windows (zavřené okno samo nic neznamená - mohla ho zavřít chyba).
 * Nejvýš dva pokusy (opakované špatné kódy umí účet u Certumu zamknout);
 * druhý pokus s úplně novým spuštěním SimplySign.
 */
async function loginSimplySign(exe, username, cfg, wanted) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      powershell(PS.KILL_SIMPLYSIGN);
      await sleep(2000);
    }
    const window = await openLoginWindow(exe);
    if (!window) {
      log(`SimplySign: přihlašovací okno se neukázalo (pokus ${attempt}). Okna: ${describeWindows()}`);
      continue;
    }
    log(`SimplySign: okno "${window.MainWindowTitle}"`);
    // Kód musí platit ještě aspoň 15 s (psaní + cesta k Certumu), jinak počkat na další.
    const left = secondsLeft(cfg);
    if (left < 15) {
      log(`SimplySign: kód platí už jen ${left} s, čekám na nový…`);
      await sleep((left + 1) * 1000);
    }
    const code = totpCode(cfg);
    mask(code);
    const typed = powershell(PS.typeKeys(PS.TYPE_CREDENTIALS), { env: { KINE_SK_USER: sendKeysEscape(username), KINE_SK_CODE: code }, timeout: 60000 });
    if (typed.status === 3) {
      log(`SimplySign: okno se nepodařilo dostat do popředí - nic se nenapsalo (pokus ${attempt}). Okna: ${describeWindows()}`);
      continue;
    }
    if (!typed.ok) log(`SimplySign: psaní do okna vrátilo chybu (${lastLines(typed.stderr || typed.stdout || typed.error?.message, 1)})`);
    log(`SimplySign: přihlašuji (pokus ${attempt})…`);
    // Certifikát se po přihlášení objeví v úložišti do pár sekund (virtuální karta).
    for (let i = 0; i < 22; i++) {
      await sleep(2000);
      const cert = findCertificate(wanted);
      if (cert) {
        log(`SimplySign: přihlášeno, certifikát je v systému (po ${(i + 1) * 2} s).`);
        return cert;
      }
    }
    log(`SimplySign: certifikát se po pokusu ${attempt} neobjevil. Okno SimplySign: ${simplySignWindow() ? 'pořád otevřené' : 'zavřené'}. Okna: ${describeWindows()}`);
  }
  return null;
}

async function certumSigner() {
  const username = process.env.CERTUM_USERNAME.trim();
  const secret = process.env.CERTUM_TOTP.trim();
  mask(secret);
  mask(username);
  // Tajemství dál nikam: ani do SimplySign (běží až do konce vydání), ani do npm skriptů.
  delete process.env.CERTUM_TOTP;
  delete process.env.CERTUM_USERNAME;
  let cfg;
  try {
    cfg = parseTotp(secret);
  } catch (e) {
    fail(`Tajemství CERTUM_TOTP: ${e.message}`);
  }
  const wanted = process.env.CERTUM_CERT_SHA1?.trim() || '';
  const exe = await installSimplySign();
  let cert = findCertificate(wanted);
  if (!cert) cert = await loginSimplySign(exe, username, cfg, wanted);
  if (!cert) {
    const all = listCertificates();
    const arr = Array.isArray(all) ? all : all ? [all] : [];
    fail(
      `Přihlášení do SimplySign se nepovedlo (certifikát se v systému neobjevil; v úložišti: ${arr.map((c) => commonName(c.Subject)).join(', ') || 'nic'}). ` +
        'Zkontroluj tajemství CERTUM_USERNAME (e-mail účtu SimplySign) a CERTUM_TOTP (celý odkaz otpauth:// z QR kódu) a jestli je certifikát u Certumu vydaný. ' +
        'Pak spusť Vydání znovu - nespouštěj ho ale pořád dokola (špatné kódy umí účet zamknout); když to nejde ani napodruhé, pošli Claudovi log tohohle kroku.'
    );
  }
  const signtool = findSigntool();
  exportEnv('KINE_SIGN_SHA1', cert.Thumbprint);
  exportEnv('SIGNTOOL_PATH', signtool);
  log(`Certifikát: ${commonName(cert.Subject)} (${cert.Thumbprint}), platí do ${String(cert.NotAfter).slice(0, 10)}`);
  const days = Math.floor((Date.parse(cert.NotAfter) - Date.now()) / 86400000);
  if (Number.isFinite(days) && days < 30) {
    console.log(`::warning::Certifikát Certum vyprší za ${days} dní - obnov ho (JAK-VYDAT.md, část C).`);
    summary(`> ⚠️ Certifikát vyprší za ${days} dní - obnov ho u Certumu.\n`);
  }
  return { name: `Certum - ${commonName(cert.Subject)}`, thumbprint: cert.Thumbprint, expires: String(cert.NotAfter).slice(0, 10), sign: (files) => signFiles(files) };
}

// ---- pluginy instalátoru (NSIS) ------------------------------------------------------

/**
 * Instalátor (NSIS) si při spuštění rozbalí pluginy (System.dll, nsis7z.dll,
 * StdUtils.dll…) do %TEMP% a načte je - musí být podepsané taky. electron-builder
 * je bere ze své mezipaměti nepodepsané; tady se zkopírují, podepíšou a
 * ELECTRON_BUILDER_NSIS_DIR / ELECTRON_BUILDER_NSIS_RESOURCES_DIR na ně ukážou.
 * (Platí pro výchozí "legacy" NSIS electron-builderu - toolsets.nsis není nastavené.)
 */
async function prepareNsis(signer) {
  const require = createRequire(join(ROOT, 'package.json'));
  const tools = require('app-builder-lib/out/toolsets/windows.js');
  const makensis = await tools.getMakeNsisPath(undefined, undefined);
  const bundle = makensis?.env?.NSISDIR;
  if (!bundle || !existsSync(bundle)) fail('NSIS electron-builderu se nenašel (NSISDIR) - pluginy instalátoru nejde podepsat.');
  const resources = dirname(await tools.getNsisPluginsPath(undefined, undefined));
  const dest = join(STATE, 'nsis');
  removeDir(dest);
  mkdirSync(dest, { recursive: true });
  cpSync(bundle, join(dest, 'nsis'), { recursive: true });
  cpSync(resources, join(dest, 'nsis-resources'), { recursive: true });
  const files = [
    ...dllsIn(join(dest, 'nsis', 'Plugins', 'x86-unicode')),
    ...dllsIn(join(dest, 'nsis-resources', 'plugins', 'x86-unicode')),
    join(dest, 'nsis', 'elevate.exe'),
  ].filter((f) => existsSync(f));
  if (files.length < 5) fail(`Pluginů NSIS je podezřele málo (${files.length}) - nepodepisuji.`);
  log(`Pluginy instalátoru: podepisuji ${files.length} souborů (${files.map((f) => basename(f)).join(', ')})…`);
  try {
    signer.sign(files);
  } catch (e) {
    fail(`Podpis nefunguje: ${e.message}`);
  }
  const unsigned = files.filter((f) => !fileHasSignature(f));
  if (unsigned.length) fail(`Pluginy zůstaly nepodepsané: ${unsigned.map((f) => basename(f)).join(', ')}`);
  exportEnv('ELECTRON_BUILDER_NSIS_DIR', join(dest, 'nsis'));
  exportEnv('ELECTRON_BUILDER_NSIS_RESOURCES_DIR', join(dest, 'nsis-resources'));
  return files;
}

// ---- pomocník kine-helper.exe ---------------------------------------------------------

function cscPath() {
  const root = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Pustí přeložený pomocník na pár sekund: musí říct "ready" a poslat okno
 * v popředí i seznam procesů. Výsledek až po jeho skončení (zavřený stdin,
 * případně zabití) - běžící program by Windows nedovolil smazat.
 */
function smokeTestHelper(exe) {
  return new Promise((resolveTest) => {
    const lines = [];
    let buffer = '';
    let verdict = null;
    let killer = null;
    let child;
    try {
      child = spawn(exe, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, KINE_FG_MS: '200', KINE_PROC_S: '1', KINE_HOTKEYS: '119;17,120' },
      });
    } catch (e) {
      resolveTest({ ok: false, note: `nespustil se: ${e.message}` });
      return;
    }
    const finish = (ok, note) => {
      if (verdict) return;
      verdict = { ok, note };
      clearTimeout(timer);
      clearInterval(poll);
      try {
        child.stdin.end();
      } catch {
        // už neběží
      }
      killer = setTimeout(() => child.kill(), 5000);
    };
    child.on('error', (e) => {
      finish(false, `nespustil se: ${e.message}`);
      clearTimeout(killer);
      resolveTest(verdict);
    });
    child.on('exit', (code) => {
      clearTimeout(killer);
      if (!verdict) finish(false, `skončil hned (${code}): ${JSON.stringify(lines.slice(0, 3)).slice(0, 200)}`);
      clearTimeout(killer);
      resolveTest(verdict);
    });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        try {
          if (line) lines.push(JSON.parse(line));
        } catch {
          lines.push({ t: 'bad', line });
        }
      }
    });
    const poll = setInterval(() => {
      const procs = lines.find((l) => l.t === 'procs');
      if (lines[0]?.t === 'ready' && procs && lines.some((l) => l.t === 'fg')) finish(true, `běží (${procs.exes?.length ?? 0} procesů, okno v popředí)`);
    }, 200);
    const timer = setTimeout(() => finish(false, `za 15 s neodpověděl jak má: ${JSON.stringify(lines.slice(0, 4)).slice(0, 300)}`), 15000);
  });
}

/**
 * Přeloží src/helper/KineHelper.cs (csc.exe z .NET Frameworku) a vyzkouší ho.
 * Do instalátoru (dist/helper -> resources/helper) jde jen s podpisem; bez
 * podpisu se jen ověří, že funguje (appka pak jede s PowerShellem).
 */
async function buildHelper(packaged) {
  const target = join(ROOT, 'dist', 'helper');
  removeDir(target);
  const outDir = packaged ? target : join(STATE, 'helper');
  removeDir(outDir);
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, 'kine-helper.exe');
  const src = join(ROOT, 'src', 'helper', 'KineHelper.cs');
  let r;
  if (WIN) {
    const csc = cscPath();
    if (!csc) return { ok: false, note: 'csc.exe (.NET Framework) na runneru není' };
    r = spawnSync(csc, ['/nologo', '/codepage:65001', '/target:winexe', '/platform:anycpu', '/optimize+', '/r:System.Core.dll', `/out:${exe}`, src], { encoding: 'utf8' });
  } else {
    // Mimo Windows jen pro zkoušku balení (mono).
    r = spawnSync('mcs', ['-target:winexe', '-optimize+', '-r:System.Core.dll', `-out:${exe}`, src], { encoding: 'utf8' });
    if (r.error) return { ok: false, note: 'mcs (mono) tu není' };
  }
  if (r.status !== 0 || !existsSync(exe)) {
    removeDir(target);
    return { ok: false, note: `překlad selhal: ${lastLines(`${r.stdout ?? ''}${r.stderr ?? ''}`)}` };
  }
  if (!WIN) return { ok: true, note: 'přeložený (mono, bez zkoušky)' };
  const test = await smokeTestHelper(exe);
  // Nevyzkoušený pomocník se nepřibalí, i kdyby tu zůstal: do instalátoru jde jen
  // s KINE_HELPER_EXE=1 (to se nastaví jen po úspěšné zkoušce) a app.asar ho vynechává.
  if (!test.ok && packaged) removeDir(target);
  return test;
}

// ---- příkazy -------------------------------------------------------------------------

async function priprav() {
  mkdirSync(STATE, { recursive: true });
  const { mode, provider, missing } = signingMode(process.env);
  if (missing.length) {
    fail(`${provider}: chybí ${missing.join(', ')} (GitHub -> Settings -> Secrets and variables -> Actions). Doplň je, nebo smaž i zbytek - pak se vydá bez podpisu.`);
  }
  if (mode && mode !== 'pfx' && !WIN) fail('Podpis Certum / Azure jde jen na Windows (runs-on: windows-latest).');

  // Pomocník nikdy neshodí vydání - bez něj appka jede s PowerShellem.
  let helper;
  try {
    helper = await buildHelper(Boolean(mode));
  } catch (e) {
    helper = { ok: false, note: `chyba: ${e.message}` };
  }
  log(`Pomocník kine-helper.exe: ${helper.ok ? 'OK' : 'nejde'} - ${helper.note}`);

  if (!mode) {
    exportEnv('KINE_SIGN', 'none');
    log('Podpis: žádný (chybí tajemství CERTUM_USERNAME a CERTUM_TOTP). Instalátory budou nepodepsané - Inteligentní řízení aplikací (Smart App Control) ve Windows 11 je zablokuje. Návod: JAK-VYDAT.md, část C.');
    summary(
      `### Podpis\n\n⚠️ **Nepodepsané** - chybí tajemství \`CERTUM_USERNAME\` a \`CERTUM_TOTP\`. Na počítačích se zapnutým Inteligentním řízením aplikací (Smart App Control) se Kine nenainstaluje. Návod: \`JAK-VYDAT.md\`, část C.\n\nPomocník kine-helper.exe (zkouška na Windows): ${helper.ok ? '✅' : '❌'} ${helper.note}\n`
    );
    return;
  }

  log(`Podpis: ${provider}`);
  exportEnv('KINE_SIGN', mode);
  const signer = mode === 'certum' ? await certumSigner() : mode === 'azure' ? azureSigner() : pfxSigner();
  const plugins = await prepareNsis(signer);
  if (helper.ok) exportEnv('KINE_HELPER_EXE', '1');
  summary(
    [
      '### Podpis',
      '',
      `✅ ${signer.name}${signer.thumbprint ? ` (otisk \`${signer.thumbprint}\`${signer.expires ? `, platí do ${signer.expires}` : ''})` : ''}`,
      '',
      `- pluginy instalátoru (NSIS): ${plugins.length} podepsaných`,
      `- pomocník kine-helper.exe: ${helper.ok ? `✅ ${helper.note} - přibalí se a podepíše` : `❌ ${helper.note} - appka pojede s PowerShellem`}`,
      '- Kine.exe, všechny .dll, ffmpeg.exe, odinstalátor a instalátor podepíše electron-builder; kontroluje krok „Podpis - kontrola“.',
      '',
    ].join('\n')
  );
}

/**
 * Spustitelné soubory, které se instalují (win-unpacked), instalátory a co
 * instalátor rozbalí do %TEMP% (pluginy) + odinstalátor - 7-Zip umí NSIS
 * otevřít. Archiv s appkou se nerozbaluje, to je obsah win-unpacked.
 */
function collectFiles() {
  const release = join(ROOT, 'release');
  const files = [];
  const notes = [];
  const extracted = join(STATE, 'rozbaleno');
  removeDir(extracted);
  for (const variant of existsSync(release) ? readdirSync(release) : []) {
    const dir = join(release, variant);
    if (!statSync(dir).isDirectory()) continue;
    files.push(...walk(join(dir, 'win-unpacked')).filter(isSignable));
    for (const installer of readdirSync(dir).filter((f) => /\.exe$/i.test(f))) {
      const full = join(dir, installer);
      files.push(full);
      const out = join(extracted, variant, basename(installer, '.exe'));
      let opened = false;
      for (const tool of WIN ? ['7z', 'C:\\Program Files\\7-Zip\\7z.exe'] : ['7z']) {
        const r = spawnSync(tool, ['x', '-y', `-o${out}`, full, '-x!$PLUGINSDIR\\app-*.7z', '-x!$PLUGINSDIR/app-*.7z'], { encoding: 'utf8', windowsHide: true });
        if (r.error) continue;
        opened = r.status === 0;
        break;
      }
      const inside = walk(out).filter(isSignable);
      if (!opened || !inside.length) notes.push(`${installer}: obsah instalátoru nejde otevřít (7-Zip) - pluginy zkontrolované jen při podpisu`);
      files.push(...inside);
    }
  }
  return { files, notes };
}

/** Platnost podpisů podle Windows (Get-AuthenticodeSignature) + vložený podpis v hlavičce. */
function authenticode(files) {
  const header = new Map(files.map((f) => [f, fileHasSignature(f)]));
  if (!WIN) {
    // Mimo Windows jen hlavička (zkouška balení); platnost ověřuje osslsigncode v testu.
    return files.map((f) => ({ Path: f, Status: header.get(f) ? 'Valid' : 'NotSigned', Signer: '', Thumbprint: '', TimeStamped: true }));
  }
  const list = join(STATE, 'kontrola.txt');
  writeFileSync(list, files.join('\n'), 'utf8');
  const rows = psJson(PS.AUTHENTICODE_LIST, { env: { KINE_LIST: list }, timeout: 10 * 60 * 1000 });
  const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
  // Podpis jen v katalogu Windows (bez vloženého) se nepočítá - na jiném PC nemusí platit.
  return arr.map((r) => (header.get(r.Path) ? r : { ...r, Status: r.Status === 'Valid' ? 'NotEmbedded' : r.Status }));
}

function over() {
  const mode = process.env.KINE_SIGN || 'none';
  if (mode === 'none') {
    log('Podpis: žádný - instalátory jsou nepodepsané (kontrola se přeskakuje).');
    return;
  }
  mkdirSync(STATE, { recursive: true });
  const { files, notes } = collectFiles();
  if (!files.length) fail('Ve složce release/ nejsou žádné instalátory - kontrolu podpisu nejde udělat.');
  for (const note of notes) log(`  pozor: ${note}`);
  const rows = authenticode(files);
  // Chybějící časové razítko je jen varování: signtool s /tr bez razítka nepodepíše,
  // takže to spíš znamená, že ho PowerShell neumí přečíst; platný podpis rozhoduje.
  const { ok, bad, foreign } = summarizeSignatures(
    rows.map((r) => ({ ...r, TimeStamped: true })),
    process.env.KINE_SIGN_SHA1 || ''
  );
  const noStamp = rows.filter((r) => r.Status === 'Valid' && r.TimeStamped === false);
  log(`Podpis: ${ok.length} z ${rows.length} souborů v pořádku${foreign.length ? ` (${foreign.length} s podpisem někoho jiného, např. Microsoftu)` : ''}.`);
  for (const r of bad) log(`  NEPODEPSANÉ: ${rel(r.Path)} (${r.Status})`);
  if (noStamp.length) log(`  pozor: ${noStamp.length} souborů bez (čitelného) časového razítka, např. ${noStamp.slice(0, 3).map((r) => basename(r.Path)).join(', ')}`);
  const installers = rows.filter((r) => /^release\/[^/]+\/[^/]+\.exe$/i.test(rel(r.Path)));
  summary(
    [
      '### Kontrola podpisu',
      '',
      bad.length ? `❌ **${bad.length} nepodepsaných** z ${rows.length}` : `✅ všech ${rows.length} spustitelných souborů je podepsaných`,
      '',
      ...installers.map((r) => `- \`${basename(r.Path)}\`: ${r.Status === 'Valid' ? '✅' : '❌'} ${commonName(r.Signer) || r.Status}`),
      ...notes.map((n) => `- ⚠️ ${n}`),
      ...(noStamp.length ? [`- ⚠️ ${noStamp.length} souborů bez čitelného časového razítka (podpis po vypršení certifikátu nemusí platit)`] : []),
      ...bad.slice(0, 30).map((r) => `- ❌ \`${rel(r.Path)}\` (${r.Status})`),
      '',
    ].join('\n')
  );
  if (bad.length) fail(`Nepodepsané nebo neplatné soubory (${bad.length}): ${bad.slice(0, 12).map((r) => basename(r.Path)).join(', ')}${bad.length > 12 ? '…' : ''}`);
}

function odhlas() {
  if (!WIN) return;
  const r = powershell(PS.LOGOUT);
  log(r.ok ? 'SimplySign: relace ukončená.' : 'SimplySign: ukončení relace vrátilo chybu (nevadí, runner se zahodí).');
}

const command = process.argv[2];
try {
  if (command === 'priprav') await priprav();
  else if (command === 'over') over();
  else if (command === 'odhlas') odhlas();
  else {
    console.log('Použití: node scripts/podpis.mjs priprav | over | odhlas');
    process.exit(2);
  }
} catch (e) {
  if (command === 'odhlas') {
    log(`SimplySign: ukončení relace - ${e.message} (nevadí)`);
  } else {
    fail(`${e.message}`);
  }
}
