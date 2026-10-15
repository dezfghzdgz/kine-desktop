import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_SITE, appOutdated, guardSiteUrl, isOfficialSite, kineAppHeader, withKineHeader } from '../dist/esm/kineClient.js';
import { clipsPlusActive, maxClipSecondsFor } from '../dist/esm/plan.js';

test('hlavička appky: varianta/verze', () => {
  assert.equal(kineAppHeader('clipper', '0.11.0'), 'clipper/0.11.0');
  assert.equal(kineAppHeader('full', 'v1.2.3'), 'full/1.2.3');
});

test('oficiální adresy Kine', () => {
  assert.ok(isOfficialSite('https://www.playkine.com'));
  assert.ok(isOfficialSite('https://playkine.com'));
  assert.ok(isOfficialSite('https://kine-lac.vercel.app'));
  assert.ok(isOfficialSite('https://beta.playkine.com'));
  assert.ok(!isOfficialSite('http://www.playkine.com'), 'jen https');
  assert.ok(!isOfficialSite('https://playkine.com.evil.example'));
  assert.ok(!isOfficialSite('http://localhost:3000'));
  assert.ok(!isOfficialSite('nesmysl'));
});

test('zabalená appka mluví jen s oficiálním Kine (vývoj a testy cokoli)', () => {
  assert.equal(guardSiteUrl('http://localhost:3000', { packaged: true, test: false }), OFFICIAL_SITE);
  assert.equal(guardSiteUrl('https://fake-kine.example', { packaged: true, test: false }), OFFICIAL_SITE);
  assert.equal(guardSiteUrl('https://www.playkine.com', { packaged: true, test: false }), 'https://www.playkine.com');
  assert.equal(guardSiteUrl('http://localhost:3000', { packaged: false, test: false }), 'http://localhost:3000');
  assert.equal(guardSiteUrl('http://127.0.0.1:9', { packaged: true, test: true }), 'http://127.0.0.1:9');
});

test('nejstarší verze od Kine', () => {
  assert.equal(appOutdated('0.10.9', '0.11.0'), true);
  assert.equal(appOutdated('0.11.0', '0.11.0'), false);
  assert.equal(appOutdated('0.12.0', '0.11.5'), false);
  assert.equal(appOutdated('0.11.0', '0.1.0'), false);
  assert.equal(appOutdated('0.11.0', undefined), false, 'starší Kine nic neposílá');
  assert.equal(appOutdated('0.11.0', 'nesmysl'), false);
});

test('fetch s hlavičkou nepřepíše ostatní hlavičky', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = new Headers(init.headers);
    return new Response('{}');
  };
  const f = withKineHeader(fake, 'clipper/0.11.0');
  await f('https://www.playkine.com/api/desktop/me', { headers: { Authorization: 'Bearer x' } });
  assert.equal(seen.get('x-kine-app'), 'clipper/0.11.0');
  assert.equal(seen.get('authorization'), 'Bearer x');
  await f('https://www.playkine.com/api/desktop/config');
  assert.equal(seen.get('x-kine-app'), 'clipper/0.11.0');
});

test('Klipy Plus: konec předplatného hlídá i appka', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(clipsPlusActive({ clipsPlus: true, planUntil: '2026-11-01T00:00:00Z' }, now), true);
  assert.equal(clipsPlusActive({ clipsPlus: true, planUntil: '2026-10-15T11:00:00Z' }, now), false, 'prošlé předplatné');
  assert.equal(clipsPlusActive({ clipsPlus: true, planUntil: null }, now), true);
  assert.equal(clipsPlusActive({ clipsPlus: false, plan: 'all' }, now), false, 'Kine řekla ne');
  assert.equal(clipsPlusActive(null, now), false);
  assert.equal(maxClipSecondsFor({ plan: 'free', clipsPlus: false, maxClipSeconds: 300 }, now), 60, 'bez Plus 60 s, i když server pošle víc');
  assert.equal(maxClipSecondsFor({ plan: 'clips', clipsPlus: true, maxClipSeconds: 9999 }, now), 300, 'nejvýš 5 minut');
  assert.equal(maxClipSecondsFor({ plan: 'clips', clipsPlus: true, planUntil: '2026-10-01T00:00:00Z', maxClipSeconds: 300 }, now), 60, 'po konci předplatného 60 s');
});

test('Kine řekne 426 (zastaralá appka): hlášení "aktualizuj" a chyba s textem od Kine', async () => {
  const { createKineApi } = await import('../dist/esm/kineApi.js');
  let hlaseni = 0;
  const api = createKineApi({
    siteUrl: () => 'https://www.playkine.com',
    getToken: async () => 'tok',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'Tahle verze appky je zastaralá.', code: 'update-required' }), { status: 426 }),
    onUpdateRequired: () => {
      hlaseni += 1;
    },
  });
  await assert.rejects(() => api.createUploadUrl(1000, 30), (e) => e.status === 426 && /zastaralá/.test(e.message));
  assert.equal(hlaseni, 1);
});

test('nahrání pošle Kine délku klipu', async () => {
  const { createKineApi } = await import('../dist/esm/kineApi.js');
  let body = null;
  const api = createKineApi({
    siteUrl: () => 'https://www.playkine.com',
    getToken: async () => 'tok',
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ mode: 'tus', uploadURL: 'https://upload.example/x', videoId: 'a'.repeat(32) }), { status: 200 });
    },
  });
  await api.createUploadUrl(5000, 42.5);
  assert.deepEqual(body, { fileSize: 5000, preferResumable: true, durationSeconds: 42.5 });
  await api.createUploadUrl(5000, null);
  assert.deepEqual(body, { fileSize: 5000, preferResumable: true }, 'neznámá délka se neposílá');
});
