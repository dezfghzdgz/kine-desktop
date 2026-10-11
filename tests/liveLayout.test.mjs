import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraRect, CAMERA_WIDTH } from '../dist/esm/liveLayout.js';

test('kamera ve vysílání: roh, velikost a poměr kamery', () => {
  const r = cameraRect(1280, 720, 1280, 720, { position: 'bottom-right', size: 'medium', shape: 'rect' });
  assert.equal(r.w, Math.round(1280 * CAMERA_WIDTH.medium));
  assert.equal(r.h, Math.round((r.w * 720) / 1280));
  const margin = Math.round(720 * 0.03);
  assert.equal(r.x, 1280 - r.w - margin);
  assert.equal(r.y, 720 - r.h - margin);
  assert.equal(r.radius, 0);
  const tl = cameraRect(1280, 720, 640, 480, { position: 'top-left', size: 'small', shape: 'rounded' });
  assert.equal(tl.x, margin);
  assert.equal(tl.y, margin);
  assert.equal(tl.h, Math.round((tl.w * 480) / 640), 'kamera 4:3 si poměr nechá');
  assert.ok(tl.radius > 0);
});

test('kamera ve vysílání: kruh = čtverec ze středu kamery', () => {
  const r = cameraRect(1920, 1080, 1280, 720, { position: 'top-right', size: 'large', shape: 'circle' });
  assert.equal(r.w, r.h);
  assert.equal(r.radius, r.w / 2);
  assert.equal(r.sw, 720);
  assert.equal(r.sh, 720);
  assert.equal(r.sx, (1280 - 720) / 2);
  assert.equal(r.sy, 0);
});

test('kamera ve vysílání: nikdy víc než polovina výšky (kamera na výšku, úzký obraz)', () => {
  const r = cameraRect(1280, 400, 720, 1280, { position: 'bottom-left', size: 'large', shape: 'rect' });
  assert.ok(r.h <= 200);
  assert.ok(r.y >= 0 && r.x >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 400);
});
