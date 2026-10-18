// Sestavení: esbuild slepí hlavní proces, preload a každou stránku
// renderer do jednoho souboru. Typy hlídá zvlášť tsc (npm run build).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { uklid } from './uklid.mjs';

// Nejdřív pryč se soubory ze starších verzí (viz uklid.mjs), pak sestavení.
uklid();
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

// KINE_RELEASE=1 (Vydání na GitHubu): to, co se zabalí do appky, se zmenší a
// zamotá (minify, bez zdrojových map). Kód z nainstalované appky jde pořád
// vytáhnout - ochrana to není; o placených věcech rozhoduje server Kine, ne
// appka. Jen se v tom hůř hrabe a instalátor je menší. Při vývoji a testech
// zůstává čitelný kód se zdrojovými mapami.
const release = process.env.KINE_RELEASE === '1';
// keepNames: názvy tříd a funkcí zůstanou (hlášky v deníku, instanceof podle jména) - zamotá se zbytek.
const common = { bundle: true, sourcemap: release ? false : 'inline', minify: release, keepNames: release, logLevel: 'warning', target: 'es2022' };
if (release) console.log('sestavení pro vydání: minify, bez zdrojových map');

// Zdrojáky pomocníků v C# (src/helper/*.cs) jdou do hlavního procesu jako text - zapíše je a přeloží PowerShell.
const loader = { '.cs': 'text' };

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.js',
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  loader,
});

await build({
  ...common,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload/preload.js',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: {
    settings: 'src/renderer/settings.ts',
    review: 'src/renderer/review.ts',
    toast: 'src/renderer/toast.ts',
    capture: 'src/renderer/capture.ts',
  },
  outdir: 'dist/renderer',
  platform: 'browser',
  format: 'iife',
});

for (const f of ['settings.html', 'review.html', 'toast.html', 'capture.html', 'style.css']) {
  cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
}
cpSync('src/renderer/fonts', 'dist/renderer/fonts', { recursive: true });

// Čisté moduly (bez electronu) zvlášť jako ESM pro testy (do appky se nebalí - vždy čitelné).
await build({
  ...common,
  minify: false,
  sourcemap: false,
  entryPoints: {
    segments: 'src/main/segments.ts',
    gamesParse: 'src/main/gamesParse.ts',
    gameEventsParse: 'src/main/gameEventsParse.ts',
    editPlan: 'src/main/editPlan.ts',
    updaterParse: 'src/main/updaterParse.ts',
    tus: 'src/main/tus.ts',
    uploader: 'src/main/uploader.ts',
    clips: 'src/main/clips.ts',
    kineApi: 'src/main/kineApi.ts',
    hotkeys: 'src/shared/hotkeys.ts',
    settingsSchema: 'src/shared/settingsSchema.ts',
    clipNaming: 'src/shared/clipNaming.ts',
    i18n: 'src/shared/i18n/index.ts',
    plan: 'src/shared/plan.ts',
    kineClient: 'src/shared/kineClient.ts',
    performance: 'src/shared/performance.ts',
    types: 'src/shared/types.ts',
    upload: 'src/shared/upload.ts',
    live: 'src/shared/live.ts',
    livePlan: 'src/main/livePlan.ts',
    liveHealth: 'src/main/liveHealth.ts',
    liveController: 'src/main/live.ts',
    liveLayout: 'src/shared/liveLayout.ts',
    storage: 'src/shared/storage.ts',
    siteMove: 'src/main/siteMove.ts',
    updateOutcome: 'src/main/updateOutcome.ts',
    compress: 'src/shared/compress.ts',
    audioLoopback: 'src/main/audioLoopback.ts',
  },
  outdir: 'dist/esm',
  platform: 'node',
  format: 'esm',
  packages: 'external',
  loader,
});

console.log('build ok');
