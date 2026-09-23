import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClipLibrary } from '../dist/esm/clips.js';
import { TRASH_DAYS } from '../dist/esm/types.js';

const clip = (dir, name, extra = {}) => {
  const file = join(dir, name);
  writeFileSync(file, 'video');
  return { id: name, file, thumb: null, title: name, game: null, createdAt: new Date().toISOString(), durationSeconds: 5, sizeBytes: 5, width: 1, height: 1, sessionId: 's', upload: null, ...extra };
};

test('koš: smazání přesune soubor do .trash, klip zmizí ze seznamu a jde vrátit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-clips-'));
  const lib = new ClipLibrary(dir);
  lib.load();
  lib.add(clip(dir, 'a.mp4'));
  lib.add(clip(dir, 'b.mp4'));
  lib.remove('a.mp4');
  assert.deepEqual(lib.list().map((c) => c.id), ['b.mp4']);
  assert.deepEqual(lib.trash().map((c) => c.id), ['a.mp4']);
  const trashed = lib.get('a.mp4');
  assert.ok(trashed.deletedAt);
  assert.equal(trashed.file, join(dir, '.trash', 'a.mp4'));
  assert.ok(existsSync(trashed.file));
  assert.ok(!existsSync(join(dir, 'a.mp4')));
  // Posluchač dostává i koš (okno si roztřídí).
  let seen = null;
  lib.onChange((all) => (seen = all));
  lib.restore('a.mp4');
  assert.equal(seen.length, 2);
  assert.equal(lib.get('a.mp4').deletedAt, undefined);
  assert.equal(lib.get('a.mp4').file, join(dir, 'a.mp4'));
  assert.ok(existsSync(join(dir, 'a.mp4')));
  assert.equal(lib.trash().length, 0);
  // Index na disku drží stav koše.
  const saved = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.equal(saved.length, 2);
});

test('koš: vrácení nepřepíše soubor se stejným názvem; druhé smazání = nadobro; vysypání a expirace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-clips-'));
  const lib = new ClipLibrary(dir);
  lib.load();
  lib.add(clip(dir, 'a.mp4'));
  lib.remove('a.mp4');
  // Mezitím vznikl nový soubor a.mp4 - vrácený klip dostane " (2)".
  writeFileSync(join(dir, 'a.mp4'), 'other');
  lib.restore('a.mp4');
  assert.equal(lib.get('a.mp4').file, join(dir, 'a (2).mp4'));
  assert.equal(readFileSync(join(dir, 'a.mp4'), 'utf8'), 'other');

  lib.remove('a.mp4');
  lib.remove('a.mp4');
  assert.equal(lib.get('a.mp4'), null);
  assert.ok(!existsSync(join(dir, '.trash', 'a (2).mp4')));

  lib.add(clip(dir, 'b.mp4'));
  lib.add(clip(dir, 'c.mp4'));
  lib.remove('b.mp4');
  lib.remove('c.mp4');
  assert.deepEqual(lib.usage(), { clipsBytes: 0, clipsCount: 0, trashBytes: 10, trashCount: 2 });
  // Starší než TRASH_DAYS zmizí samo, mladší zůstane.
  lib.update('b.mp4', { deletedAt: new Date(Date.now() - (TRASH_DAYS + 1) * 86400000).toISOString() });
  assert.equal(lib.purgeExpired(), 1);
  assert.deepEqual(lib.trash().map((c) => c.id), ['c.mp4']);
  lib.emptyTrash();
  assert.equal(lib.trash().length, 0);
  assert.equal(lib.listAll().length, 0);
});
