// Pomocník Kine (src/helper/KineHelper.cs): přeloží se a otestuje - na Windows
// csc.exe z .NET Frameworku (je v každých Windows), jinde mono (mcs). Když
// překladač chybí, testy se přeskočí.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = 'src/helper/KineHelper.cs';
const TESTS = 'tests/helper/KineHelperTests.cs';
const WIN = process.platform === 'win32';

function compiler() {
  if (WIN) {
    const root = process.env.WINDIR || 'C:\\Windows';
    for (const fw of ['Framework64', 'Framework']) {
      const csc = join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
      if (existsSync(csc)) return { kind: 'csc', path: csc };
    }
    return null;
  }
  const mcs = spawnSync('mcs', ['--version'], { encoding: 'utf8' });
  const mono = spawnSync('mono', ['--version'], { encoding: 'utf8' });
  return mcs.status === 0 && mono.status === 0 ? { kind: 'mcs', path: 'mcs' } : null;
}

function compile(cc, files, out, { target, main } = {}) {
  const args =
    cc.kind === 'csc'
      ? ['/nologo', '/codepage:65001', `/target:${target}`, '/r:System.Core.dll', ...(main ? [`/main:${main}`] : []), `/out:${out}`, ...files]
      : [`-target:${target}`, '-r:System.Core.dll', ...(main ? [`-main:${main}`] : []), `-out:${out}`, ...files];
  const r = spawnSync(cc.path, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `překlad selhal:\n${r.stdout}\n${r.stderr}`);
}

const run = (exe, args = [], opts = {}) => (WIN ? spawn(exe, args, opts) : spawn('mono', [exe, ...args], opts));

const cc = compiler();

// Na GitHubu (Vydání) se pomocník nezkouší tady, ale nanečisto v `node scripts/podpis.mjs priprav`
// - nepodepsané vydání tak kvůli němu nikdy nespadne.
const onGitHub = Boolean(process.env.GITHUB_ACTIONS);

test('pomocník: logika (zkratky, časy, celá obrazovka, JSON)', { skip: !cc ? 'chybí csc / mono' : onGitHub ? 'na GitHubu ho zkouší scripts/podpis.mjs priprav' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-helper-'));
  const exe = join(dir, 'tests.exe');
  compile(cc, [SRC, TESTS], exe, { target: 'exe', main: 'KineHelperTests.Program' });
  const r = WIN ? spawnSync(exe, [], { encoding: 'utf8' }) : spawnSync('mono', [exe], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, / 0 spadlo/);
});

// Ve Vydání (GitHub, Windows) ho naostro zkouší `node scripts/podpis.mjs priprav` - když tam
// nejede, jen se nepřibalí (appka pojede s PowerShellem) a vydání kvůli tomu nespadne.
const runtimeSkip = !cc ? 'chybí csc / mono' : onGitHub ? 'na GitHubu ho zkouší scripts/podpis.mjs priprav' : false;

test('pomocník: běží, mluví JSON a skončí, když appka zavře stdin', { skip: runtimeSkip, timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-helper-'));
  const exe = join(dir, 'kine-helper.exe');
  compile(cc, [SRC], exe, { target: 'winexe' });
  const child = run(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KINE_FG_MS: '200', KINE_PROC_S: '1', KINE_HOTKEYS: '119;17,120' } });
  const lines = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) lines.push(JSON.parse(line));
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const deadline = Date.now() + 15000;
  // Na Windows přijde okno v popředí i seznam procesů; jinde (mono bez user32) aspoň chyba ve formátu JSON.
  const enough = () => lines.some((l) => l.t === 'ready') && (WIN ? lines.some((l) => l.t === 'procs') && lines.some((l) => l.t === 'fg') : lines.some((l) => l.t === 'err'));
  while (!enough() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines[0]?.t, 'ready', JSON.stringify(lines.slice(0, 3)));
  assert.ok(enough(), JSON.stringify(lines.slice(0, 6)));
  if (WIN) {
    const procs = lines.find((l) => l.t === 'procs');
    assert.ok(Array.isArray(procs.exes) && procs.exes.length > 5, 'seznam procesů');
    assert.ok(procs.exes.every((x) => x === x.toLowerCase()), 'malými písmeny');
    assert.equal(typeof procs.steam, 'number');
  }
  // Appka skončila = zavřený stdin -> pomocník končí sám.
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('visí'), 5000))]);
  if (code === 'visí') child.kill();
  assert.notEqual(code, 'visí', 'pomocník po zavření stdin neskončil');
});
