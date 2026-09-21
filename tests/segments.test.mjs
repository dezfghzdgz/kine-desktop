import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSegmentCsv, toSegment, selectForClip, totalSeconds, expired, concatList , sameResolutionTailStart } from '../dist/esm/segments.js';

const join = (a, b) => `${a}/${b}`;

test('CSV od ffmpeg se přečte i s neúplným posledním řádkem', () => {
  const rows = parseSegmentCsv('00000.mkv,0.000000,2.000000\n00001.mkv,2.000000,4.033000\n00002.mkv,4.033');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { file: '00001.mkv', start: 2, end: 4.033 });
});

test('kousky pro klip: okno sahá zpět, první kousek může začínat dřív', () => {
  const genStart = 1_000_000;
  const rows = [0, 2, 4, 6, 8].map((s) => ({ file: `${s}.mkv`, start: s, end: s + 2 }));
  const segments = rows.map((r) => toSegment(r, 1, genStart, '/buf', join));
  // Konec v 9,5 s, chceme 5 s zpět => okno 4,5-9,5 => kousky 4-6, 6-8, 8-10
  const chosen = selectForClip(segments, genStart + 9500, 5);
  assert.deepEqual(chosen.map((s) => s.file), ['/buf/4.mkv', '/buf/6.mkv', '/buf/8.mkv']);
  assert.equal(totalSeconds(chosen), 6);
});

test('kousky ze dvou generací se řadí podle hodin počítače', () => {
  const a = toSegment({ file: 'a.mkv', start: 0, end: 2 }, 1, 5000, '/g1', join);
  const b = toSegment({ file: 'b.mkv', start: 0, end: 2 }, 2, 7100, '/g2', join);
  const chosen = selectForClip([b, a], 9000, 10);
  assert.deepEqual(chosen.map((s) => s.file), ['/g1/a.mkv', '/g2/b.mkv']);
});

test('okno mimo data nevybere nic', () => {
  const a = toSegment({ file: 'a.mkv', start: 0, end: 2 }, 1, 0, '/g', join);
  assert.deepEqual(selectForClip([a], 10000, 3), []);
});

test('staré kousky se poznají podle konce', () => {
  const segs = [0, 2, 4].map((s) => toSegment({ file: `${s}.mkv`, start: s, end: s + 2 }, 1, 0, '/g', join));
  // teď = 20 s, držet 15 s => hranice 5 s => kousky končící před 5 s (0-2, 2-4)
  assert.deepEqual(expired(segs, 20000, 15).map((s) => s.file), ['/g/0.mkv', '/g/2.mkv']);
});

test('seznam pro concat escapuje apostrof', () => {
  assert.equal(concatList(["/a/b'c.mkv"]), "file '/a/b'\\''c.mkv'\n");
});

test('klip jen ze souvislého konce se stejnými rozměry', () => {
  assert.equal(sameResolutionTailStart(['1920x1080', '1920x1080', '1920x1080']), 0);
  assert.equal(sameResolutionTailStart(['1920x1080', '1280x960', '1280x960']), 1, 'hra přepnula na 4:3 - starší kousky pryč');
  assert.equal(sameResolutionTailStart(['1280x960', null, '1280x960']), 0, 'neznámé rozměry sedí');
  assert.equal(sameResolutionTailStart(['1920x1080', '1280x960', null]), 0, 'poslední neznámý - nic se nezahazuje');
  assert.equal(sameResolutionTailStart([]), 0);
});
