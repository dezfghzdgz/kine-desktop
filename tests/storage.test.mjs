import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GB, STORAGE_KEEP_RECENT_MS, storageCleanupPlan } from '../dist/esm/storage.js';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
const clip = (id, gb, hoursAgo, extra = {}) => ({ id, file: `${id}.mp4`, thumb: null, title: id, game: null, createdAt: ago(hoursAgo), durationSeconds: 30, sizeBytes: gb * GB, width: 1920, height: 1080, sessionId: 's', upload: null, ...extra });

test('místo na klipy: pod stropem / bez stropu se nic nemaže', () => {
  const clips = [clip('a', 5, 48), clip('b', 5, 24)];
  assert.deepEqual(storageCleanupPlan(clips, 0, NOW).ids, []);
  assert.deepEqual(storageCleanupPlan(clips, 20 * GB, NOW).ids, []);
});

test('místo na klipy: nejdřív koš, pak nejstarší klipy - dokud se nevejde', () => {
  const clips = [
    clip('newest', 4, 2),
    clip('oldest', 4, 100),
    clip('middle', 4, 50),
    clip('trashOld', 2, 200, { deletedAt: ago(30) }),
    clip('trashNew', 2, 200, { deletedAt: ago(5) }),
  ];
  // 16 GB, strop 9 GB: koš (4) -> 12, nejstarší (4) -> 8 <= 9.
  const plan = storageCleanupPlan(clips, 9 * GB, NOW);
  assert.deepEqual(plan.ids, ['trashOld', 'trashNew', 'oldest']);
  assert.equal(plan.clipCount, 1);
  assert.equal(plan.freedBytes, 8 * GB);
  assert.equal(plan.stillOver, false);
});

test('místo na klipy: oblíbené, nahrávané a čerstvé klipy zůstávají vždycky', () => {
  const clips = [
    clip('fav', 10, 500, { favorite: true }),
    clip('uploading', 10, 400, { upload: { state: 'uploading', percent: 40 } }),
    clip('queued', 10, 300, { upload: { state: 'queued' } }),
    clip('fresh', 10, (STORAGE_KEEP_RECENT_MS / 3600_000) * 0.5),
    clip('done', 10, 200, { upload: { state: 'done', videoId: 'v', url: 'u' } }),
  ];
  const plan = storageCleanupPlan(clips, 5 * GB, NOW);
  assert.deepEqual(plan.ids, ['done'], 'smaže se jen nahraný starý klip');
  assert.equal(plan.stillOver, true);
});

test('místo na klipy: právě uložená dlouhá nahrávka zápasu se nesmaže (čerstvost = konec, ne začátek)', () => {
  const clips = [
    clip('oldClip', 2, 300),
    // nahrávka 2,5 h: začala před 2,6 h, uložila se teď
    clip('match', 21, 2.6, { kind: 'recording', durationSeconds: 2.5 * 3600, addedAt: ago(0) }),
  ];
  const plan = storageCleanupPlan(clips, 20 * GB, NOW);
  assert.deepEqual(plan.ids, ['oldClip']);
  assert.equal(plan.stillOver, true);
});

test('místo na klipy: obnovená nebo upravená kopie starého klipu je hodinu chráněná (addedAt)', () => {
  const clips = [clip('old', 5, 100), clip('editedCopy', 5, 100, { addedAt: ago(0.2) })];
  assert.deepEqual(storageCleanupPlan(clips, 6 * GB, NOW).ids, ['old']);
});
