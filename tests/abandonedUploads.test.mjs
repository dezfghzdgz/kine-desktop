/**
 * Úklid opuštěných nahrání u Cloudflare (lib/cloudflareVideos.ts):
 * "Pending Upload" bez videa na Kine se po 25 hodinách smaže, nic jiného ne.
 * Spustit:  node tests/abandonedUploads.test.mjs
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prelozit } from './prelozit.mjs';

const kam = prelozit('lib/cloudflareVideos.ts');
// Falešná databáze: videa (na co ukazují řádky) a lístky.
writeFileSync(join(kam, 'supabaseServer.js'), 'export const supabaseServer = globalThis.__fakeDb;\n');
const db = { videos: [], ticketsExpired: [] };
globalThis.__fakeDb = {
  from(table) {
    const filters = {};
    const api = {
      select() { return api; },
      update() { api.isUpdate = true; return api; },
      eq(col, val) { filters[col] = val; return api; },
      neq() { return api; },
      limit() { return api; },
      then(resolve, reject) {
        try {
          if (table === 'videos') return Promise.resolve({ data: db.videos.filter((v) => v.cloudflare_video_id === filters.cloudflare_video_id), error: null }).then(resolve, reject);
          if (table === 'upload_tickets' && api.isUpdate) db.ticketsExpired.push(filters.cf_uid);
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return api;
  },
};
process.env.CLOUDFLARE_ACCOUNT_ID = 'acc1';
process.env.CLOUDFLARE_STREAM_API_TOKEN = 'tok1';
const cf = await import(join(kam, 'cloudflareVideos.js'));

let prosly = 0;
let padly = 0;
async function test(nazev, fn) {
  try {
    await fn();
    console.log('OK    ' + nazev);
    prosly++;
  } catch (e) {
    console.log('CHYBA ' + nazev + '\n      ' + e.message);
    padly++;
  }
}

const NOW = Date.parse('2026-11-01T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const uid = (n) => String(n).padStart(32, 'a').slice(-32);
const video = (o) => ({ uid: uid(1), status: { state: 'pendingupload' }, created: hoursAgo(100), ...o });

await test('opuštěné nahrání (Pending Upload, starší než 25 h) se pozná', () => {
  assert.equal(cf.abandonedUpload(video({}), NOW), uid(1));
  assert.equal(cf.abandonedUpload(video({ status: { state: 'error' } }), NOW), uid(1));
});

await test('čerstvé, hotové, živé záznamy a nesmysly se nemažou', () => {
  assert.equal(cf.abandonedUpload(video({ created: hoursAgo(5) }), NOW), null); // může se ještě nahrávat
  assert.equal(cf.abandonedUpload(video({ status: { state: 'ready' } }), NOW), null);
  assert.equal(cf.abandonedUpload(video({ status: { state: 'inprogress' } }), NOW), null);
  assert.equal(cf.abandonedUpload(video({ liveInput: 'abc' }), NOW), null); // záznam vysílání
  assert.equal(cf.abandonedUpload(video({ uid: '../../evil' }), NOW), null);
  assert.equal(cf.abandonedUpload(video({ created: 'nesmysl' }), NOW), null);
});

await test('úklid smaže jen opuštěná, na která neukazuje video na Kine', async () => {
  const listed = {
    pendingupload: [video({ uid: uid(1) }), video({ uid: uid(2) }), video({ uid: uid(3), created: hoursAgo(2) })],
    error: [video({ uid: uid(4), status: { state: 'error' } }), video({ uid: uid(5), status: { state: 'error' }, liveInput: 'x' })],
  };
  db.videos = [{ id: 'v2', cloudflare_video_id: uid(2) }]; // uid 2 má video na Kine
  const deleted = [];
  const urls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    urls.push(url);
    if (init.method === 'DELETE') {
      deleted.push(url.split('/').pop());
      return new Response(null, { status: 200 });
    }
    const state = new URL(url).searchParams.get('status');
    return new Response(JSON.stringify({ success: true, result: listed[state] ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const n = await cf.sweepAbandonedUploads(10, 60_000);
    assert.equal(n, 2);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(deleted.sort(), [uid(1), uid(4)].sort());
  assert.deepEqual(db.ticketsExpired.sort(), [uid(1), uid(4)].sort());
  // Dotaz jen na staré záznamy, od nejstarších.
  const list = new URL(urls.find((u) => u.includes('status=pendingupload')));
  assert.equal(list.searchParams.get('asc'), 'true');
  assert.equal(list.searchParams.get('end'), new Date(NOW - 25 * 3600e3).toISOString());
});

await test('Cloudflare neodpovídá -> nic se nesmaže, žádná chyba', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  assert.equal(await cf.sweepAbandonedUploads(10, 60_000), 0);
  globalThis.fetch = async () => {
    throw new Error('síť');
  };
  assert.equal(await cf.sweepAbandonedUploads(10, 60_000), 0);
});

console.log(`\n${prosly} prošlo, ${padly} spadlo`);
if (padly > 0) process.exit(1);
