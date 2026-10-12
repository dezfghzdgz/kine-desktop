/**
 * Podepisování souborů - pro electron-builder (win.signtoolOptions.sign
 * v scripts/publish-config.mjs) i pro scripts/podpis.mjs (pluginy NSIS).
 *
 * Proč vlastní a ne vestavěný signtool electron-builderu: certifikát Certum
 * je v cloudu (SimplySign) a každý podpis jde přes internet - když cloud
 * nebo časové razítko zaváhá, tady se to zkusí znovu (electron-builder sám
 * opakuje jen pár konkrétních hlášek). Za jedno vydání je to kolem 30 podpisů.
 *
 * Podle KINE_SIGN (nastaví `node scripts/podpis.mjs priprav`):
 *   certum - signtool (SIGNTOOL_PATH) s certifikátem z úložiště Windows podle
 *            otisku KINE_SIGN_SHA1, SHA-256, časové razítko Certum
 *   pfx    - zkouška se souborem KINE_SIGN_PFX (+ KINE_SIGN_PFX_PASSWORD):
 *            signtool na Windows, osslsigncode jinde
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

const CERTUM_TIMESTAMP = 'http://time.certum.pl';
const ATTEMPTS = 4;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tail = (r) =>
  `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.error ? r.error.message : ''}`
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-3)
    .join(' ');

/** Nástroj s opakováním (10 s, 20 s, 30 s); chybějící nástroj se neopakuje. */
function run(tool, args, label) {
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const r = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    if (r.status === 0) return;
    last = tail(r);
    console.log(`  podpis ${label}: pokus ${attempt} nevyšel - ${last}`);
    if (r.error && r.error.code === 'ENOENT') break;
    if (attempt < ATTEMPTS) sleepSync(10000 * attempt);
  }
  throw new Error(`podpis ${label} se nepovedl: ${last}`);
}

/** Podepíše soubory (na místě). Popis (name) a adresa (site) se ukážou ve Vlastnostech souboru. */
export function signFiles(files, { name = 'Kine', site = '' } = {}) {
  const mode = process.env.KINE_SIGN;
  if (mode === 'certum') {
    const tool = process.env.SIGNTOOL_PATH;
    const thumbprint = process.env.KINE_SIGN_SHA1;
    if (!tool || !thumbprint) throw new Error('chybí SIGNTOOL_PATH / KINE_SIGN_SHA1 - nejdřív `node scripts/podpis.mjs priprav`');
    for (let i = 0; i < files.length; i += 16) {
      const part = files.slice(i, i + 16);
      run(
        tool,
        ['sign', '/sha1', thumbprint, '/fd', 'sha256', '/tr', CERTUM_TIMESTAMP, '/td', 'sha256', '/d', name, ...(site ? ['/du', site] : []), ...part],
        part.map((f) => basename(f)).join(', ')
      );
    }
    return;
  }
  if (mode === 'pfx') {
    const pfx = process.env.KINE_SIGN_PFX;
    const password = process.env.KINE_SIGN_PFX_PASSWORD ?? '';
    const timestamp = process.env.KINE_SIGN_TIMESTAMP ?? '';
    for (const file of files) {
      if (process.platform === 'win32') {
        run(process.env.SIGNTOOL_PATH || 'signtool', ['sign', '/f', pfx, '/p', password, '/fd', 'sha256', ...(timestamp ? ['/tr', timestamp, '/td', 'sha256'] : []), '/d', name, file], basename(file));
      } else {
        const out = `${file}.podpis`;
        rmSync(out, { force: true });
        run('osslsigncode', ['sign', '-pkcs12', pfx, '-pass', password, '-h', 'sha256', '-n', name, ...(timestamp ? ['-ts', timestamp] : []), '-in', file, '-out', out], basename(file));
        copyFileSync(out, file);
        rmSync(out, { force: true });
      }
    }
    return;
  }
  throw new Error(`podpis: neznámý způsob KINE_SIGN="${mode ?? ''}"`);
}

/** electron-builder: jeden soubor (volá se pro každý .exe/.dll/.node, odinstalátor i instalátor). */
export default async function sign(configuration) {
  signFiles([configuration.path], { name: configuration.name || 'Kine', site: configuration.site || '' });
}
