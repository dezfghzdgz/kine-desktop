// Úklid po starších verzích. Když se soubory nahrávají do repa přes web
// GitHubu (přetažením), staré soubory tam zůstávají - a třeba starý
// src/shared/i18n.ts se plete s novou složkou src/shared/i18n/ a rozbije
// sestavení. Tady je seznam všeho, co v repu už nemá být; build to smaže
// dřív, než se do něčeho pustí. Ručně: node scripts/uklid.mjs
import { existsSync, rmSync } from 'node:fs';

export const ZBYTKY = [
  'src/shared/i18n.ts', // nahradila složka src/shared/i18n/ (osm jazyků)
  'src/shared/accelerator.ts', // nahradil src/shared/hotkeys.ts (zkratky z více kláves)
];

export function uklid() {
  for (const cesta of ZBYTKY) {
    if (existsSync(cesta)) {
      rmSync(cesta, { force: true });
      console.log(`úklid: smazán starý soubor ${cesta}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('uklid.mjs')) uklid();
