import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ALL_SCRIPTS } from '../scripts/podpisPs.mjs';
import {
  base32Decode,
  commonName,
  isSignable,
  parseTotp,
  peHasSignature,
  pickCertificate,
  psQuote,
  secondsLeft,
  sendKeysEscape,
  signingMode,
  summarizeSignatures,
  totpCode,
} from '../scripts/podpisCore.mjs';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= 0xff;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

test('TOTP: testovací vektory RFC 6238 (SHA-1, SHA-256, SHA-512, 8 číslic)', () => {
  const seeds = {
    SHA1: Buffer.from('12345678901234567890'),
    SHA256: Buffer.from('12345678901234567890123456789012'),
    SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors = [
    [59, { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' }],
    [1111111109, { SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' }],
    [1111111111, { SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' }],
    [1234567890, { SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' }],
    [2000000000, { SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' }],
    [20000000000, { SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }],
  ];
  for (const [alg, seed] of Object.entries(seeds)) {
    const cfg = parseTotp(`otpauth://totp/Test:dev%40example.com?secret=${base32Encode(seed)}&algorithm=${alg}&digits=8&period=30&issuer=Test`);
    for (const [time, codes] of vectors) assert.equal(totpCode(cfg, time), codes[alg], `${alg} @ ${time}`);
  }
});

test('TOTP: holý klíč = výchozí Certum (SHA-256, 6 číslic, 30 s), mezery a malá písmena nevadí', () => {
  const seed = Buffer.from('12345678901234567890123456789012');
  const b32 = base32Encode(seed);
  const cfg = parseTotp(`  ${b32.toLowerCase().replace(/(.{4})/g, '$1 ')}  `);
  assert.equal(cfg.algorithm, 'sha256');
  assert.equal(cfg.digits, 6);
  assert.equal(cfg.period, 30);
  assert.deepEqual(cfg.key, seed);
  // 6 číslic = posledních 6 z 8místného vektoru SHA-256.
  assert.equal(totpCode(cfg, 59), '119246');
  assert.equal(totpCode(cfg, 1111111109), '084774');
  // Odkaz bez algorithm= je taky Certum (SHA-256).
  assert.equal(parseTotp(`otpauth://totp/Certum?secret=${b32}`).algorithm, 'sha256');
  assert.equal(secondsLeft(cfg, 59), 1);
  assert.equal(secondsLeft(cfg, 60), 30);
  assert.equal(secondsLeft(cfg, 75.9), 15);
});

test('TOTP: chyby mají srozumitelnou hlášku', () => {
  assert.throws(() => parseTotp(''), /chybí TOTP/);
  assert.throws(() => parseTotp('ABC1'), /neplatný znak/);
  assert.throws(() => parseTotp('ABCDEFGH'), /krátký/);
  assert.throws(() => parseTotp('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), /není TOTP/);
  assert.throws(() => parseTotp('otpauth://totp/x?digits=6'), /chybí secret/);
  assert.throws(() => parseTotp('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5'), /nepodporovaný/);
  assert.deepEqual(base32Decode('MZXW6==='), Buffer.from('foo'));
});

test('který podpis: Certum, Azure, napůl nastavené = chyba, nic = bez podpisu', () => {
  assert.deepEqual(signingMode({}), { mode: null, provider: null, missing: [] });
  assert.equal(signingMode({ CERTUM_USERNAME: 'dev@example.com', CERTUM_TOTP: 'X' }).mode, 'certum');
  const half = signingMode({ CERTUM_USERNAME: 'dev@example.com', CERTUM_TOTP: '  ' });
  assert.equal(half.mode, null);
  assert.deepEqual(half.missing, ['CERTUM_TOTP']);
  const azure = { AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net', AZURE_SIGN_ACCOUNT: 'a', AZURE_SIGN_PROFILE: 'p', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };
  assert.equal(signingMode(azure).mode, 'azure');
  assert.deepEqual(signingMode({ ...azure, AZURE_CLIENT_SECRET: '' }).missing, ['AZURE_CLIENT_SECRET']);
  // Certum má přednost (Azure proměnné můžou v repu zůstat).
  assert.equal(signingMode({ ...azure, CERTUM_USERNAME: 'u', CERTUM_TOTP: 't' }).mode, 'certum');
  assert.equal(signingMode({ KINE_SIGN_PFX: '/tmp/test.pfx' }).mode, 'pfx');
});

test('certifikát: Certum s podpisovým EKU a klíčem, nejdéle platný; nebo podle otisku', () => {
  const list = [
    { Thumbprint: 'AAA', Subject: 'CN=Web', Issuer: 'CN=Certum Domain Validation CA', HasPrivateKey: true, NotAfter: '2027-12-01T00:00:00', Eku: ['1.3.6.1.5.5.7.3.1'] },
    { Thumbprint: 'BBB', Subject: 'CN="Open Source Developer, Daniel Test"', Issuer: 'CN=Certum Code Signing 2021 CA, O=Asseco Data Systems S.A.', HasPrivateKey: true, NotAfter: '2026-11-01T00:00:00', Eku: ['1.3.6.1.5.5.7.3.3'] },
    { Thumbprint: 'CCC', Subject: 'CN="Open Source Developer, Daniel Test"', Issuer: 'CN=Certum Code Signing 2021 CA, O=Asseco Data Systems S.A.', HasPrivateKey: true, NotAfter: '2027-11-01T00:00:00', Eku: '1.3.6.1.5.5.7.3.3' },
    { Thumbprint: 'DDD', Subject: 'CN=Jiny', Issuer: 'CN=Other CA', HasPrivateKey: true, NotAfter: '2030-01-01T00:00:00', Eku: ['1.3.6.1.5.5.7.3.3'] },
  ];
  assert.equal(pickCertificate(list)?.Thumbprint, 'CCC');
  assert.equal(pickCertificate(list, 'bb b')?.Thumbprint, 'BBB');
  assert.equal(pickCertificate(list, 'EEE'), null);
  assert.equal(pickCertificate([list[3]])?.Thumbprint, 'DDD');
  assert.equal(pickCertificate([]), null);
  assert.equal(pickCertificate(null), null);
  assert.equal(commonName('CN="Open Source Developer, Daniel Test", O=Open Source Developer, C=CZ'), 'Open Source Developer, Daniel Test');
  assert.equal(commonName('CN=Kine s.r.o., O=Kine s.r.o., C=CZ'), 'Kine s.r.o.');
});

test('kontrola podpisu v hlavičce PE', () => {
  const pe = (magic, secOffset, secSize, length = 0x400) => {
    const b = Buffer.alloc(length);
    b.write('MZ', 0, 'latin1');
    b.writeUInt32LE(0x80, 0x3c);
    b.writeUInt32LE(0x00004550, 0x80);
    const optional = 0x80 + 24;
    b.writeUInt16LE(magic, optional);
    const dirs = optional + (magic === 0x20b ? 112 : 96);
    b.writeUInt32LE(secOffset, dirs + 32);
    b.writeUInt32LE(secSize, dirs + 36);
    return b;
  };
  assert.equal(peHasSignature(pe(0x20b, 0x300, 0x80)), true);
  assert.equal(peHasSignature(pe(0x10b, 0x300, 0x80)), true);
  assert.equal(peHasSignature(pe(0x20b, 0, 0)), false);
  assert.equal(peHasSignature(pe(0x20b, 0x3f0, 0x80)), false, 'podpis za koncem souboru');
  // Stačí začátek souboru + jeho délka (velké .exe se nečtou celé).
  assert.equal(peHasSignature(pe(0x20b, 0x100000, 0x2000).subarray(0, 0x400), 0x102000), true);
  assert.equal(peHasSignature(pe(0x20b, 0x100000, 0x2000).subarray(0, 0x400), 0x101000), false);
  assert.equal(peHasSignature(Buffer.from('not a pe file at all, just text')), null);
  assert.equal(peHasSignature(Buffer.alloc(0)), null);
  assert.ok(isSignable('C:\\x\\ffmpeg.dll') && isSignable('a.EXE') && isSignable('watcher.node'));
  assert.ok(!isSignable('app.asar') && !isSignable('latest.yml'));
});

test('SendKeys a PowerShell: zvláštní znaky', () => {
  assert.equal(sendKeysEscape('dev+kine@example.com'), 'dev{+}kine@example.com');
  assert.equal(sendKeysEscape('a^b%c~d(e)f{g}h[i]'), 'a{^}b{%}c{~}d{(}e{)}f{{}g{}}h{[}i{]}');
  assert.equal(sendKeysEscape('123456'), '123456');
  assert.equal(psQuote("C:\\Daniel's\\a.exe"), "'C:\\Daniel''s\\a.exe'");
});

test('souhrn kontroly podpisů', () => {
  const rows = [
    { Path: 'a.exe', Status: 'Valid', Thumbprint: 'ABC', TimeStamped: true },
    { Path: 'b.dll', Status: 'Valid', Thumbprint: 'MS', TimeStamped: true },
    { Path: 'c.dll', Status: 'NotSigned', Thumbprint: '', TimeStamped: false },
    { Path: 'd.dll', Status: 'Valid', Thumbprint: 'ABC', TimeStamped: false },
  ];
  const s = summarizeSignatures(rows, 'abc');
  assert.deepEqual(s.ok.map((r) => r.Path), ['a.exe', 'b.dll']);
  assert.deepEqual(s.bad.map((r) => r.Path), ['c.dll', 'd.dll']);
  assert.deepEqual(s.foreign.map((r) => r.Path), ['b.dll']);
});

// Syntaxe skriptů PowerShellu (podpis jinak běží jen na runneru Windows):
// když je po ruce pwsh (KINE_PWSH, pwsh v PATH, na Windows i powershell.exe).
function powershellBinary() {
  for (const bin of [process.env.KINE_PWSH, 'pwsh', process.platform === 'win32' ? 'powershell.exe' : null].filter(Boolean)) {
    const r = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}
const pwsh = powershellBinary();

test('skripty PowerShellu pro podpis: syntaxe', { skip: pwsh ? false : 'chybí PowerShell' }, () => {
  const parse = `$errors = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($env:KINE_PS_CODE, [ref]$tokens, [ref]$errors)
if ($errors) { $errors | ForEach-Object { "$($_.Message) (řádek $($_.Extent.StartLineNumber))" }; exit 1 }
'ok'`;
  for (const [name, code] of Object.entries(ALL_SCRIPTS)) {
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', parse], { encoding: 'utf8', env: { ...process.env, KINE_PS_CODE: code } });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ok/, name);
  }
});
