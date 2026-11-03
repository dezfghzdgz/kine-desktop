import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInsideLexically, isPathInside } from '../dist/esm/safePath.js';

test('cesty: uvnitř složky podle path.relative, ne podle začátku textu', () => {
  const root = join(tmpdir(), 'kine-root');
  assert.equal(isInsideLexically(join(root, 'a.mp4'), root), true);
  assert.equal(isInsideLexically(join(root, '.trash', 'a.mp4'), root), true);
  assert.equal(isInsideLexically(join(root, '..foo.mp4'), root), true, 'soubor začínající ".." je pořád uvnitř');
  assert.equal(isInsideLexically(`${root}-cizi${'/'}a.mp4`, root), false, 'sousední složka se stejným začátkem');
  assert.equal(isInsideLexically(join(root, '..', 'jinde', 'a.mp4'), root), false, '.. ven ze složky');
  assert.equal(isInsideLexically(root, root), false, 'složka sama není soubor v ní');
  assert.equal(isInsideLexically('relativni/a.mp4', root), false, 'relativní cesta');
  assert.equal(isInsideLexically('\\\\?\\C:\\Videa\\a.mp4', root), false, 'cesta zařízení');
  assert.equal(isInsideLexically(null, root), false);
});

test('cesty: odkaz uvnitř složky, který vede ven, neprojde; soubor, který není, podle textu', () => {
  const base = mkdtempSync(join(tmpdir(), 'kine-safe-'));
  const root = join(base, 'klipy');
  const outside = join(base, 'dokumenty');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'tajne.txt'), 'x');
  writeFileSync(join(root, 'a.mp4'), 'v');
  symlinkSync(outside, join(root, 'odkaz'), 'dir');
  assert.equal(isPathInside(join(root, 'a.mp4'), [root]), true);
  assert.equal(isPathInside(join(root, 'odkaz', 'tajne.txt'), [root]), false, 'odkaz ven');
  assert.equal(isPathInside(join(root, 'zatim-neni.mp4'), [root]), true);
  assert.equal(isPathInside(join(outside, 'tajne.txt'), [root]), false);
  assert.equal(isPathInside(join(outside, 'tajne.txt'), [root, outside]), true, 'druhá povolená složka');
});
