import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgbTriplet, maxClipSecondsFor, clipOptionsFor, applyBrandColor, hasClipsPlus, hasKinePlus, normalizePlan, FREE_CLIP_MAX_SECONDS, PLUS_CLIP_MAX_SECONDS } from '../dist/esm/plan.js';

test('barva Kine -> rgb složky', () => {
  assert.equal(hexToRgbTriplet('#a34ff7'), '163, 79, 247');
  assert.equal(hexToRgbTriplet('#af7'), '170, 255, 119');
  assert.equal(hexToRgbTriplet('00c9a7'), '0, 201, 167');
  assert.equal(hexToRgbTriplet('modrá'), null);
  assert.equal(hexToRgbTriplet(null), null);
});

test('strop délky klipu podle plánu', () => {
  assert.equal(maxClipSecondsFor(null), FREE_CLIP_MAX_SECONDS);
  assert.equal(maxClipSecondsFor({ plan: 'free' }), 60);
  assert.equal(maxClipSecondsFor({ plan: 'kine' }), 60, 'Kine Plus samo dlouhé klipy nedává');
  assert.equal(maxClipSecondsFor({ plan: 'clips' }), PLUS_CLIP_MAX_SECONDS);
  assert.equal(maxClipSecondsFor({ plan: 'all' }), PLUS_CLIP_MAX_SECONDS);
  assert.equal(maxClipSecondsFor({ plan: 'plus' }), PLUS_CLIP_MAX_SECONDS, 'starší hodnota plus = all');
  assert.equal(maxClipSecondsFor({ plan: 'all', maxClipSeconds: 240 }), 240);
  assert.deepEqual([...clipOptionsFor('free')], [15, 30, 45, 60]);
  assert.deepEqual([...clipOptionsFor('kine')], [15, 30, 45, 60]);
  assert.ok(clipOptionsFor('clips').includes(300));
});

test('tři druhy předplatného', () => {
  assert.ok(hasClipsPlus('clips') && hasClipsPlus('all') && hasClipsPlus('plus'));
  assert.ok(!hasClipsPlus('kine') && !hasClipsPlus('free') && !hasClipsPlus(null));
  assert.ok(hasKinePlus('kine') && hasKinePlus('all') && hasKinePlus('plus'));
  assert.ok(!hasKinePlus('clips') && !hasKinePlus('free'));
  assert.equal(normalizePlan('all'), 'all');
  assert.equal(normalizePlan('premium'), 'free');
  assert.equal(normalizePlan(undefined), 'free');
});

test('nastavení CSS proměnných barvy (i odebrání)', () => {
  const set = new Map();
  const root = { style: { setProperty: (k, v) => set.set(k, v), removeProperty: (k) => set.delete(k) } };
  applyBrandColor(root, '#a34ff7');
  assert.equal(set.get('--brand'), '#a34ff7');
  assert.equal(set.get('--brand-rgb'), '163, 79, 247');
  applyBrandColor(root, '');
  assert.equal(set.size, 0);
});
