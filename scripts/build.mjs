// Sestavení: esbuild slepí hlavní proces, preload a každou stránku
// renderer do jednoho souboru. Typy hlídá zvlášť tsc (npm run build).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning', target: 'es2022' };

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main/main.js',
  platform: 'node',
  format: 'cjs',
  packages: 'external',
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

// Čisté moduly (bez electronu) zvlášť jako ESM pro testy.
await build({
  ...common,
  sourcemap: false,
  entryPoints: {
    segments: 'src/main/segments.ts',
    gamesParse: 'src/main/gamesParse.ts',
    tus: 'src/main/tus.ts',
    uploader: 'src/main/uploader.ts',
    clips: 'src/main/clips.ts',
    kineApi: 'src/main/kineApi.ts',
    hotkeys: 'src/shared/hotkeys.ts',
    settingsSchema: 'src/shared/settingsSchema.ts',
    clipNaming: 'src/shared/clipNaming.ts',
    i18n: 'src/shared/i18n/index.ts',
    plan: 'src/shared/plan.ts',
  },
  outdir: 'dist/esm',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});

console.log('build ok');
