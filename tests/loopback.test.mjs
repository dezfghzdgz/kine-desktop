// Zvuk hry přímo z Windows (src/main/audioLoopback.ts + src/helper/KineLoopback.cs):
// čtení protokolu pomocníka, převod formátů v C# (mono, mcs -langversion:5 = stejný
// jazyk jako Add-Type ve Windows PowerShell 5.1) a celý skript v PowerShellu, když
// je po ruce (pwsh nebo KINE_PWSH; mimo Windows skončí chybou COM - i to je zpráva
// v protokolu). Na GitHubu (Vydání) se C# a PowerShell přeskočí, ať kvůli nim
// vydání nespadne - stejně jako u pomocníka v tests/helper.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopbackParser, LOOPBACK_SCRIPT } from '../dist/esm/audioLoopback.js';

const frame = (type, payload) => {
  const head = Buffer.alloc(5);
  head[0] = type.charCodeAt(0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

function collect() {
  const got = { formats: [], audio: [], errors: [] };
  const parser = new LoopbackParser({
    format: (f) => got.formats.push(f),
    audio: (a) => got.audio.push(a),
    error: (e) => got.errors.push(e),
  });
  return { got, parser };
}

test('protokol pomocníka: šum před značkou, formát, zvuk, rozdělené kousky', () => {
  const { got, parser } = collect();
  const fmt = Buffer.alloc(12 + 4);
  fmt.writeUInt32LE(48000, 0);
  fmt.writeUInt16LE(8, 4);
  fmt.writeUInt32LE(0x63f, 8);
  fmt.write('dev1', 12);
  const pcm = Buffer.alloc(16);
  pcm.writeFloatLE(0.5, 0);
  pcm.writeFloatLE(-0.25, 4);
  pcm.writeFloatLE(0.125, 8);
  pcm.writeFloatLE(1, 12);
  const all = Buffer.concat([Buffer.from('hlaska PowerShellu\r\nKL'), Buffer.from('B1'), frame('F', fmt), frame('A', pcm), frame('E', Buffer.from('konec'))]);
  // Po jednom bajtu - nic se nesmí ztratit ani zdvojit.
  for (let i = 0; i < all.length; i++) parser.push(all.subarray(i, i + 1));
  assert.equal(got.formats.length, 1);
  assert.deepEqual(got.formats[0], { sampleRate: 48000, channels: 8, channelMask: 0x63f, device: 'dev1' });
  assert.equal(got.audio.length, 1);
  const a = got.audio[0];
  assert.equal(a.byteOffset, 0, 'vlastní kopie, zarovnaná na začátek');
  const f = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  assert.deepEqual([...f], [0.5, -0.25, 0.125, 1]);
  assert.deepEqual(got.errors, ['konec']);
});

test('protokol pomocníka: nesmysl = chyba a čeká se na novou značku', () => {
  const { got, parser } = collect();
  parser.push(Buffer.concat([Buffer.from('KLB1'), Buffer.from([0x5a, 1, 0, 0, 0, 9])]));
  assert.deepEqual(got.errors, ['protocol']);
  const pcm = Buffer.alloc(8);
  parser.push(frame('A', pcm)); // bez značky se nebere
  assert.equal(got.audio.length, 0);
  parser.push(Buffer.concat([Buffer.from('KLB1'), frame('A', pcm)]));
  assert.equal(got.audio.length, 1);
});

const WIN = process.platform === 'win32';
const onGitHub = Boolean(process.env.GITHUB_ACTIONS);
const SRC = 'src/helper/KineLoopback.cs';

function mono() {
  if (WIN) return null;
  const mcs = spawnSync('mcs', ['--version'], { encoding: 'utf8' });
  const run = spawnSync('mono', ['--version'], { encoding: 'utf8' });
  return mcs.status === 0 && run.status === 0;
}

test('C# pomocníka: jazyk C# 5 a převod formátů (7.1, 5.1, 16/24/32 bit, mono)', { skip: onGitHub ? 'na GitHubu ne' : !mono() ? 'chybí mono (mcs)' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-loopback-'));
  const exe = join(dir, 'tests.exe');
  const r = spawnSync('mcs', ['-langversion:5', '-target:exe', '-main:KineLoopbackTests.Program', `-out:${exe}`, SRC, 'tests/helper/KineLoopbackTests.cs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `překlad selhal:\n${r.stdout}\n${r.stderr}`);
  const run = spawnSync('mono', [exe], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, / 0 spadlo/);
});

function powershell() {
  if (process.env.KINE_PWSH) return process.env.KINE_PWSH;
  if (WIN) return 'powershell.exe';
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
  return r.status === 0 ? 'pwsh' : null;
}

const ps = onGitHub ? null : powershell();

test('skript v PowerShellu: přeloží C#, pošle značku a formát (nebo chybu zařízení) a skončí se zavřeným stdin', { skip: onGitHub ? 'na GitHubu ne' : !ps ? 'chybí PowerShell' : false, timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-loopback-ps-'));
  const script = join(dir, 'kine-loopback.ps1');
  const source = join(dir, 'KineLoopback.cs');
  writeFileSync(script, LOOPBACK_SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8');
  writeFileSync(source, readFileSync(SRC, 'utf8'), 'utf8');
  const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, KINE_LOOPBACK_CS: source },
  });
  const { got, parser } = collect();
  let stderr = '';
  child.stdout.on('data', (d) => parser.push(d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 80000;
  while (got.formats.length === 0 && got.errors.length === 0 && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (got.formats.length > 0) {
    // Windows se zvukovkou: formát je tu, zvuk teče - konec appky = zavřený stdin.
    assert.ok(got.formats[0].sampleRate >= 8000 && got.formats[0].channels >= 1);
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('visí'), 10000))]);
    assert.equal(code, 0, stderr);
  } else {
    // Bez zvukovky / mimo Windows: chyba je zpráva v protokolu (ne pád skriptu) a kód 2.
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('visí'), 10000))]);
    assert.ok(got.errors.length > 0, `žádná zpráva o chybě; stderr: ${stderr}`);
    assert.equal(code, 2, stderr);
  }
  child.kill();
});
