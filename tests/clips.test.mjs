import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClipLibrary } from '../dist/esm/clips.js';
import { TRASH_DAYS } from '../dist/esm/types.js';
import { isCloudflareUploadUrl } from '../dist/esm/upload.js';

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

test('koš: soubor kamery zvlášť jde do koše s klipem, zpátky i nadobro', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-clips-'));
  const lib = new ClipLibrary(dir);
  lib.load();
  const camFile = join(dir, 'c.camera.webm');
  writeFileSync(camFile, 'cam');
  lib.add(clip(dir, 'c.mp4', { camera: { file: camFile, offsetMs: 120, x: 0.7, y: 0.6, w: 0.25, shape: 'circle', mirror: true, width: 1280, height: 720 } }));
  lib.remove('c.mp4');
  const trashed = lib.get('c.mp4');
  assert.equal(trashed.camera.file, join(dir, '.trash', 'c.camera.webm'));
  assert.ok(existsSync(trashed.camera.file));
  assert.ok(!existsSync(camFile));
  assert.equal(trashed.camera.offsetMs, 120, 'ostatní údaje kamery zůstávají');
  lib.restore('c.mp4');
  assert.equal(lib.get('c.mp4').camera.file, camFile);
  assert.ok(existsSync(camFile));
  lib.remove('c.mp4');
  lib.remove('c.mp4');
  assert.equal(lib.get('c.mp4') ?? null, null);
  assert.ok(!existsSync(join(dir, '.trash', 'c.camera.webm')), 'nadobro = i soubor kamery pryč');
});

test('index.json: cesty mimo složku s klipy se vynechají a nic se nesmaže (ani starý koš)', () => {
  const base = mkdtempSync(join(tmpdir(), 'kine-index-'));
  const dir = join(base, 'klipy');
  const thumbs = join(base, 'thumbs');
  const outside = join(base, 'dokumenty');
  for (const d of [dir, thumbs, outside]) mkdirSync(d);
  const victim = join(outside, 'prace.docx');
  writeFileSync(victim, 'důležité');
  const good = clip(dir, 'ok.mp4');
  writeFileSync(join(thumbs, 'ok.jpg'), 'jpg');
  const old = new Date(Date.now() - (TRASH_DAYS + 5) * 86400000).toISOString();
  const entries = [
    { ...good, thumb: join(thumbs, 'ok.jpg') },
    // Klip mimo složku (a dávno v koši - dřív by se při načtení smazal).
    { ...good, id: 'venku', file: victim, deletedAt: old },
    // Klip uvnitř, ale náhled a kamera ukazují ven: zůstane bez nich, cizí soubor se nesmaže.
    { ...clip(dir, 'stary.mp4'), id: 'stary', thumb: victim, camera: { file: victim, offsetMs: 0, x: 0, y: 0, w: 0.2, shape: 'circle', mirror: false, width: 1, height: 1 }, deletedAt: old },
    { ...good, id: 'relativni', file: 'ok.mp4' },
    { ...good, id: 'sit', file: '\\\\server\\share\\x.mp4' },
    { ...good, id: 'ven', file: join(dir, '..', 'dokumenty', 'prace.docx') },
    null,
    'nesmysl',
  ];
  writeFileSync(join(dir, 'index.json'), JSON.stringify(entries));
  const logs = [];
  const lib = new ClipLibrary(dir, (m) => logs.push(m), { thumbDirs: [thumbs] });
  lib.load();
  assert.deepEqual(lib.listAll().map((c) => c.id), ['ok.mp4'], 'zůstane jen klip uvnitř (starý z koše se smazal - je uvnitř)');
  assert.equal(lib.get('ok.mp4').thumb, join(thumbs, 'ok.jpg'), 'náhled ve složce s náhledy platí');
  assert.ok(existsSync(victim), 'soubor mimo složku zůstal');
  assert.ok(!existsSync(join(dir, 'stary.mp4')), 'klip uvnitř z dávného koše se smazal jako dřív');
  assert.ok(logs.some((m) => m.includes('vynechány')), 'v protokolu je, kolik se vynechalo');
  const saved = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  assert.deepEqual(saved.map((c) => c.id), ['ok.mp4']);
});

test('index.json: rozjeté nahrávání naváže jen u Cloudflare, jinak se adresa zahodí', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-index-'));
  const paused = (tusUrl) => ({ state: 'paused', percent: 40, reason: 'offline', tusUrl, videoId: 'v1' });
  const entries = [
    clip(dir, 'cf.mp4', { upload: paused('https://upload.videodelivery.net/tus/abc?tusv2=true') }),
    clip(dir, 'cizi.mp4', { upload: paused('https://evil.example/tus/abc') }),
    clip(dir, 'http.mp4', { upload: { state: 'uploading', percent: 10, tusUrl: 'http://upload.videodelivery.net/tus/x', videoId: 'v2' } }),
  ];
  writeFileSync(join(dir, 'index.json'), JSON.stringify(entries));
  const lib = new ClipLibrary(dir);
  lib.load();
  assert.equal(lib.get('cf.mp4').upload.tusUrl, 'https://upload.videodelivery.net/tus/abc?tusv2=true');
  assert.equal(lib.get('cizi.mp4').upload.tusUrl, undefined);
  assert.equal(lib.get('cizi.mp4').upload.state, 'paused', 'nahrávání zůstává ve frontě - začne znovu přes Kine');
  assert.equal(lib.get('http.mp4').upload.tusUrl, undefined);
  assert.equal(lib.get('http.mp4').upload.videoId, 'v2');

  assert.equal(isCloudflareUploadUrl('https://upload.videodelivery.net/f65014bc6ff5419ea86e7972a047ba22'), true);
  assert.equal(isCloudflareUploadUrl('https://upload.cloudflarestream.com/abc'), true);
  assert.equal(isCloudflareUploadUrl('https://videodelivery.net.evil.example/x'), false);
  assert.equal(isCloudflareUploadUrl('https://user:pw@upload.videodelivery.net/x'), false);
  assert.equal(isCloudflareUploadUrl('https://upload.videodelivery.net:8443/x'), false);
  assert.equal(isCloudflareUploadUrl(null), false);
});

test('purge: soubor mimo složku (podstrčený za běhu) se nesmaže', () => {
  const base = mkdtempSync(join(tmpdir(), 'kine-index-'));
  const dir = join(base, 'klipy');
  mkdirSync(dir);
  const victim = join(base, 'cizi.jpg');
  writeFileSync(victim, 'x');
  const lib = new ClipLibrary(dir);
  lib.load();
  lib.add(clip(dir, 'a.mp4', { thumb: victim }));
  lib.purge('a.mp4');
  assert.equal(lib.get('a.mp4'), null);
  assert.ok(!existsSync(join(dir, 'a.mp4')));
  assert.ok(existsSync(victim), 'náhled mimo složku zůstal');
});
