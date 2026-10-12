/**
 * Čistá část podepisování (bez Windows, testuje se v tests/podpis.test.mjs).
 * Používá ji scripts/podpis.mjs ve workflow Vydání:
 *
 *  - jednorázové kódy pro přihlášení do Certum SimplySign (TOTP - Certum
 *    používá SHA-256, 6 číslic, 30 s; tajemství je buď holý base32 klíč,
 *    nebo celý odkaz otpauth://… z QR kódu při aktivaci),
 *  - který podpis se použije (Certum / Azure / žádný) podle tajemství,
 *  - výběr certifikátu z úložiště Windows,
 *  - je v souboru .exe/.dll podpis (Authenticode) - rychlá kontrola hlavičky PE,
 *  - escapování textu pro SendKeys a PowerShell.
 */
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) -> bajty. Mezery, pomlčky, malá písmena a "=" na konci nevadí. */
export function base32Decode(text) {
  const clean = String(text ?? '')
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!clean) throw new Error('TOTP klíč je prázdný');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('TOTP klíč má neplatný znak (čeká se base32: písmena A-Z a číslice 2-7)');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const ALGORITHMS = new Set(['sha1', 'sha256', 'sha512']);

/**
 * Tajemství pro jednorázové kódy: odkaz otpauth://totp/…?secret=…&algorithm=…
 * (z QR kódu) nebo holý base32 klíč (pak výchozí hodnoty Certumu).
 */
export function parseTotp(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('chybí TOTP (tajemství CERTUM_TOTP)');
  let cfg;
  if (/^otpauth:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('odkaz otpauth:// nejde přečíst');
    }
    if (url.host.toLowerCase() !== 'totp') throw new Error('odkaz otpauth:// není TOTP (čeká se otpauth://totp/…)');
    const p = url.searchParams;
    const secret = p.get('secret');
    if (!secret) throw new Error('v odkazu otpauth:// chybí secret=');
    cfg = {
      key: base32Decode(secret),
      // Certum v odkazu algoritmus uvádí; kdyby chyběl, platí jeho SHA-256.
      algorithm: (p.get('algorithm') || 'SHA256').toLowerCase().replace(/[^a-z0-9]/g, ''),
      digits: p.get('digits') ? Number(p.get('digits')) : 6,
      period: p.get('period') ? Number(p.get('period')) : 30,
    };
  } else {
    cfg = { key: base32Decode(raw), algorithm: 'sha256', digits: 6, period: 30 };
  }
  if (!ALGORITHMS.has(cfg.algorithm)) throw new Error(`nepodporovaný algoritmus TOTP: ${cfg.algorithm}`);
  if (!Number.isInteger(cfg.digits) || cfg.digits < 6 || cfg.digits > 10) throw new Error(`neplatný počet číslic TOTP: ${cfg.digits}`);
  if (!Number.isInteger(cfg.period) || cfg.period <= 0) throw new Error(`neplatná perioda TOTP: ${cfg.period}`);
  if (cfg.key.length < 10) throw new Error('TOTP klíč je podezřele krátký - zkopíruj celý (nebo celý odkaz otpauth://)');
  return cfg;
}

/** Jednorázový kód (RFC 6238) pro daný čas v sekundách. */
export function totpCode(cfg, timeSec = Date.now() / 1000) {
  const counter = Math.floor(timeSec / cfg.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(cfg.algorithm, cfg.key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
}

/** Kolik sekund ještě platí aktuální kód. */
export function secondsLeft(cfg, timeSec = Date.now() / 1000) {
  return cfg.period - (Math.floor(timeSec) % cfg.period);
}

const CERTUM_KEYS = ['CERTUM_USERNAME', 'CERTUM_TOTP'];
const AZURE_KEYS = ['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

/**
 * Který podpis použít podle tajemství / proměnných ve workflow.
 * mode null + missing = něco je nastavené jen napůl (to je chyba, ne "bez podpisu").
 * Testovací podpis souborem PFX (KINE_SIGN_PFX) je jen pro zkoušky mimo GitHub.
 */
export function signingMode(env = process.env) {
  const has = (k) => Boolean(String(env[k] ?? '').trim());
  if (CERTUM_KEYS.some(has)) {
    const missing = CERTUM_KEYS.filter((k) => !has(k));
    return { mode: missing.length ? null : 'certum', provider: 'Certum SimplySign', missing };
  }
  if (['AZURE_SIGN_ENDPOINT', 'AZURE_SIGN_ACCOUNT', 'AZURE_SIGN_PROFILE'].some(has)) {
    const missing = AZURE_KEYS.filter((k) => !has(k));
    return { mode: missing.length ? null : 'azure', provider: 'Azure Artifact Signing', missing };
  }
  if (has('KINE_SIGN_PFX')) return { mode: 'pfx', provider: 'soubor PFX (zkouška)', missing: [] };
  return { mode: null, provider: null, missing: [] };
}

/**
 * Certifikát z úložiště Windows (výpis z PowerShellu): zadaný otisk, jinak
 * podpisový (EKU 1.3.6.1.5.5.7.3.3) od Certumu se soukromým klíčem, nejdéle platný.
 */
export function pickCertificate(list, wantedThumbprint = '') {
  const certs = (Array.isArray(list) ? list : list ? [list] : []).filter((c) => c && typeof c.Thumbprint === 'string');
  const wanted = String(wantedThumbprint ?? '').replace(/\s/g, '').toUpperCase();
  if (wanted) return certs.find((c) => c.Thumbprint.toUpperCase() === wanted) ?? null;
  const ekus = (c) => (Array.isArray(c.Eku) ? c.Eku : c.Eku ? [c.Eku] : []);
  const candidates = certs.filter((c) => ekus(c).includes('1.3.6.1.5.5.7.3.3') && c.HasPrivateKey !== false);
  const certum = candidates.filter((c) => /certum|asseco|unizeto/i.test(String(c.Issuer ?? '')));
  const pool = certum.length ? certum : candidates;
  pool.sort((a, b) => String(b.NotAfter ?? '').localeCompare(String(a.NotAfter ?? '')));
  return pool[0] ?? null;
}

/** "CN=Open Source Developer, Daniel X, O=…" -> "Open Source Developer, Daniel X" (pro hlášení). */
export function commonName(subject) {
  const text = String(subject ?? '');
  const quoted = /(?:^|,\s*)CN="((?:[^"]|"")*)"/.exec(text);
  if (quoted) return quoted[1].replace(/""/g, '"');
  const plain = /(?:^|,\s*)CN=([^,]*)/.exec(text);
  return plain ? plain[1].trim() : text;
}

/** Soubory, které Windows (Inteligentní řízení aplikací) kontroluje jako spustitelný kód. */
export function isSignable(file) {
  return /\.(exe|dll|node|sys|ocx)$/i.test(String(file));
}

/**
 * Má soubor PE vložený podpis Authenticode? Jen kontrola hlavičky (adresář
 * zabezpečení v optional header) - platnost ověřuje Windows (Get-AuthenticodeSignature).
 * Stačí začátek souboru (pár KB) a jeho celková délka. Vrací null, když to
 * vůbec není soubor PE.
 */
export function peHasSignature(buf, totalLength = buf?.length ?? 0) {
  if (!buf || buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // "MZ"
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // "PE\0\0"
  const optional = pe + 24;
  if (optional + 2 > buf.length) return null;
  const magic = buf.readUInt16LE(optional);
  const dirs = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : -1;
  if (dirs < 0) return null;
  const security = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY = 4
  if (security + 8 > buf.length) return null;
  const offset = buf.readUInt32LE(security);
  const size = buf.readUInt32LE(security + 4);
  return offset > 0 && size > 8 && offset + size <= totalLength;
}

/** Text pro WScript.Shell.SendKeys (znaky + ^ % ~ ( ) { } [ ] mají zvláštní význam). */
export function sendKeysEscape(text) {
  return String(text ?? '').replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

/** Řetězec jako literál PowerShellu v apostrofech. */
export function psQuote(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/**
 * Výsledek kontroly podpisů (řádky z Get-AuthenticodeSignature / z kontroly hlavičky):
 * ok = platný podpis s časovým razítkem, bad = chybí nebo neplatný.
 */
export function summarizeSignatures(rows, expectedThumbprint = '') {
  const want = String(expectedThumbprint ?? '').toUpperCase();
  const ok = [];
  const bad = [];
  const foreign = [];
  for (const r of rows) {
    const valid = r.Status === 'Valid' && r.TimeStamped !== false;
    if (!valid) {
      bad.push(r);
      continue;
    }
    ok.push(r);
    if (want && String(r.Thumbprint ?? '').toUpperCase() !== want) foreign.push(r);
  }
  return { ok, bad, foreign };
}
