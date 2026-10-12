import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COMPRESS_LEVELS,
  LEVEL_SETTINGS,
  compressArgs,
  compressSkipReason,
  compressSummary,
  compressTempPath,
  compressedOk,
  estimateCompressedBytes,
  targetSize,
} from '../dist/esm/compress.js';
import { ClipLibrary } from '../dist/esm/clips.js';

const MB = 1024 * 1024;
// Minuta 1080p60 nahraná kolem 20 Mb/s (výchozí kvalita) = ~150 MB.
const big = (extra = {}) => ({ id: 'a', file: 'C:\\Videa\\Kine\\a.mp4', sizeBytes: 150 * MB, durationSeconds: 60, width: 1920, height: 1080, upload: null, ...extra });

test('úrovně: jemně < doporučeno < nejmenší (CRF i výška)', () => {
  assert.deepEqual([...COMPRESS_LEVELS], ['light', 'medium', 'strong']);
  assert.ok(LEVEL_SETTINGS.light.crf < LEVEL_SETTINGS.medium.crf && LEVEL_SETTINGS.medium.crf < LEVEL_SETTINGS.strong.crf);
  assert.equal(LEVEL_SETTINGS.light.maxHeight, null);
  assert.equal(LEVEL_SETTINGS.medium.maxHeight, 1080);
  assert.equal(LEVEL_SETTINGS.strong.maxHeight, 720);
});

test('odhad: velký klip se zmenší zhruba na třetinu až polovinu, nikdy nevyroste', () => {
  const light = estimateCompressedBytes(big(), 'light');
  const medium = estimateCompressedBytes(big(), 'medium');
  const strong = estimateCompressedBytes(big(), 'strong');
  assert.ok(light > medium && medium > strong, `${light} ${medium} ${strong}`);
  assert.ok(medium > 30 * MB && medium < 75 * MB, `medium ${medium / MB} MB`);
  assert.ok(strong > 10 * MB && strong < 40 * MB, `strong ${strong / MB} MB`);
  // Klip s malým datovým tokem: odhad nikdy větší než soubor.
  const small = big({ sizeBytes: 10 * MB });
  assert.equal(estimateCompressedBytes(small, 'light'), 10 * MB);
  // Neznámá délka = žádný odhad úspory.
  assert.equal(estimateCompressedBytes(big({ durationSeconds: 0 }), 'medium'), 150 * MB);
  // 1440p -> nejvýš 1080p (šířka sudá, poměr zůstane).
  assert.deepEqual(targetSize(2560, 1440, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize(1920, 1080, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(targetSize(3440, 1440, 720), { width: 1720, height: 720 });
  assert.deepEqual(targetSize(null, null, null), { width: 1920, height: 1080 });
});

test('výběr klipů: koš, webm, nahrávání, už zmenšené a malé se přeskočí', () => {
  assert.equal(compressSkipReason(big(), 'medium'), null);
  assert.equal(compressSkipReason(big({ deletedAt: new Date().toISOString() }), 'medium'), 'trash');
  assert.equal(compressSkipReason(big({ file: 'C:\\Videa\\a.webm' }), 'medium'), 'webm');
  assert.equal(compressSkipReason(big({ upload: { state: 'uploading' } }), 'medium'), 'uploading');
  assert.equal(compressSkipReason(big({ upload: { state: 'queued' } }), 'medium'), 'uploading');
  assert.equal(compressSkipReason(big({ upload: { state: 'done' } }), 'medium'), null);
  assert.equal(compressSkipReason(big({ upload: { state: 'error' } }), 'medium'), null);
  const done = (level) => ({ level, at: '2026-10-12T00:00:00Z', originalBytes: 300 * MB });
  // Zmenšený na stejné nebo silnější úrovni = hotovo; slabší úroveň se dá ještě přitlačit.
  assert.equal(compressSkipReason(big({ compressed: done('medium') }), 'medium'), 'done');
  assert.equal(compressSkipReason(big({ compressed: done('strong') }), 'light'), 'done');
  assert.equal(compressSkipReason(big({ compressed: done('light') }), 'strong'), null);
  // Úspora pod 2 MB nebo pod 15 % se nevyplatí.
  assert.equal(compressSkipReason(big({ sizeBytes: 3 * MB, durationSeconds: 3 }), 'light'), 'small');
  assert.equal(compressSkipReason(big({ sizeBytes: 50 * MB }), 'medium'), 'small');
});

test('souhrn: počet, úspora a id jen klipů, které má smysl zmenšit', () => {
  const clips = [big({ id: 'a' }), big({ id: 'b', sizeBytes: 300 * MB, durationSeconds: 120 }), big({ id: 'c', deletedAt: 'x' }), big({ id: 'd', sizeBytes: 5 * MB })];
  const sum = compressSummary(clips, 'medium');
  assert.equal(sum.count, 2);
  assert.deepEqual(sum.ids, ['a', 'b']);
  assert.equal(sum.bytes, 450 * MB);
  assert.equal(sum.savingBytes, sum.bytes - sum.estimatedBytes);
  assert.ok(sum.savingBytes > 200 * MB, `${sum.savingBytes / MB} MB`);
  // 80 klipů po 50 MB (4 GB) -> ušetří aspoň 1,5 GB.
  const many = Array.from({ length: 80 }, (_, i) => big({ id: `k${i}`, sizeBytes: 50 * MB, durationSeconds: 20 }));
  const s80 = compressSummary(many, 'medium');
  assert.equal(s80.count, 80);
  assert.ok(s80.savingBytes > 1.5 * 1024 * MB, `${s80.savingBytes / MB} MB`);
  assert.deepEqual(compressSummary([], 'strong'), { count: 0, bytes: 0, estimatedBytes: 0, savingBytes: 0, ids: [] });
});

test('argumenty ffmpegu: x264 s CRF, zvuk beze změny, zmenšení jen nad výšku úrovně', () => {
  const a = compressArgs('in.mp4', 'out.mp4', 'medium', { height: 1440, threads: 4 });
  assert.equal(a[a.indexOf('-i') + 1], 'in.mp4');
  assert.equal(a[a.length - 1], 'out.mp4');
  assert.equal(a[a.indexOf('-c:v') + 1], 'libx264');
  assert.equal(a[a.indexOf('-crf') + 1], '26');
  assert.equal(a[a.indexOf('-c:a') + 1], 'copy');
  assert.equal(a[a.indexOf('-vf') + 1], 'scale=-2:1080');
  assert.equal(a[a.indexOf('-threads') + 1], '4');
  assert.ok(a.includes('0:a?'), 'všechny zvukové stopy (hra + mikrofon)');
  assert.ok(a.includes('+faststart'));
  assert.ok(a.includes('-progress'));
  // 1080p na "doporučeno" se nezmenšuje, na "nejmenší" ano.
  assert.equal(compressArgs('in.mp4', 'out.mp4', 'medium', { height: 1080, threads: 4 }).includes('-vf'), false);
  const strong = compressArgs('in.mp4', 'out.mp4', 'strong', { height: 1080, threads: 0 });
  assert.equal(strong[strong.indexOf('-vf') + 1], 'scale=-2:720');
  assert.equal(strong[strong.indexOf('-threads') + 1], '1');
  assert.equal(compressArgs('in.mp4', 'out.mp4', 'light', { height: 2160, threads: 8 }).includes('-vf'), false);
});

test('dočasný soubor vedle klipu (Windows i jiné cesty)', () => {
  assert.equal(compressTempPath('C:\\Videa\\Kine\\Valorant 2026-10-12.mp4'), 'C:\\Videa\\Kine\\.Valorant 2026-10-12.kine-small.mp4');
  assert.equal(compressTempPath('/home/u/Kine/a.MP4'), '/home/u/Kine/.a.kine-small.mp4');
});

test('kontrola výsledku: délka, obraz, opravdu menší', () => {
  const orig = { bytes: 100 * MB, durationSeconds: 60 };
  assert.equal(compressedOk(orig, { bytes: 40 * MB, durationSeconds: 60.04, hasVideo: true }), 'ok');
  assert.equal(compressedOk(orig, { bytes: 40 * MB, durationSeconds: 58.9, hasVideo: true }), 'ok');
  assert.equal(compressedOk(orig, { bytes: 40 * MB, durationSeconds: 55, hasVideo: true }), 'broken');
  assert.equal(compressedOk(orig, { bytes: 40 * MB, durationSeconds: 60, hasVideo: false }), 'broken');
  assert.equal(compressedOk(orig, { bytes: 0, durationSeconds: 60, hasVideo: true }), 'broken');
  assert.equal(compressedOk(orig, { bytes: 40 * MB, durationSeconds: null, hasVideo: true }), 'broken');
  assert.equal(compressedOk(orig, { bytes: 95 * MB, durationSeconds: 60, hasVideo: true }), 'not-smaller');
  // Dlouhá nahrávka: tolerance 2 % délky.
  assert.equal(compressedOk({ bytes: 3000 * MB, durationSeconds: 3600 }, { bytes: 1000 * MB, durationSeconds: 3540, hasVideo: true }), 'ok');
});

test('knihovna po pádu uprostřed výměny: původní soubor zpátky, zbytky pryč', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-compress-'));
  const entry = (name) => ({ id: name, file: join(dir, name), thumb: null, title: name, game: null, createdAt: new Date().toISOString(), durationSeconds: 5, sizeBytes: 5, width: 1, height: 1, sessionId: 's', upload: null });
  // a.mp4: původní stranou, zmenšený se ještě nepřesunul -> vrátit původní.
  writeFileSync(join(dir, 'a.mp4.kine-orig'), 'original');
  writeFileSync(compressTempPath(join(dir, 'a.mp4')), 'half');
  // b.mp4: zmenšený už na místě, záloha zůstala -> záloha pryč.
  writeFileSync(join(dir, 'b.mp4'), 'small');
  writeFileSync(join(dir, 'b.mp4.kine-orig'), 'original');
  // c.mp4: nic se nedělo.
  writeFileSync(join(dir, 'c.mp4'), 'clip');
  writeFileSync(join(dir, 'index.json'), JSON.stringify([entry('a.mp4'), entry('b.mp4'), entry('c.mp4')]));
  const lib = new ClipLibrary(dir);
  lib.load();
  assert.deepEqual(lib.list().map((c) => c.id).sort(), ['a.mp4', 'b.mp4', 'c.mp4']);
  assert.equal(readFileSync(join(dir, 'a.mp4'), 'utf8'), 'original');
  assert.equal(existsSync(join(dir, 'a.mp4.kine-orig')), false);
  assert.equal(existsSync(compressTempPath(join(dir, 'a.mp4'))), false);
  assert.equal(readFileSync(join(dir, 'b.mp4'), 'utf8'), 'small');
  assert.equal(existsSync(join(dir, 'b.mp4.kine-orig')), false);
  assert.equal(readFileSync(join(dir, 'c.mp4'), 'utf8'), 'clip');
});
