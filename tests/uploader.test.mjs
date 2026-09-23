import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Uploader } from '../dist/esm/uploader.js';
import { ClipLibrary } from '../dist/esm/clips.js';
import { createKineApi } from '../dist/esm/kineApi.js';

/**
 * Napodobenina Kine + Cloudflare tus na jednom lokálním serveru:
 *   POST /api/videos/create-upload-url -> { mode: 'tus', uploadURL, videoId }
 *   PATCH/HEAD /tus/<id>               -> ukládá bajty
 *   POST /api/videos/confirm           -> { video: { id } }
 */
function startMockServer() {
  const uploads = new Map();
  const confirmed = [];
  const statusCalls = [];
  let slowPatch = false;
  let processingLeft = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/videos/create-upload-url') {
      if (req.headers.authorization !== 'Bearer token-123') { res.writeHead(401); return res.end('{"error":"nope"}'); }
      const id = 'cf' + (uploads.size + 1);
      uploads.set(id, { size: JSON.parse(body.toString()).fileSize, data: Buffer.alloc(0) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ mode: 'tus', uploadURL: `http://127.0.0.1:${server.address().port}/tus/${id}`, videoId: id }));
    }
    if (url.pathname.startsWith('/tus/')) {
      const up = uploads.get(url.pathname.slice(5));
      if (!up) { res.writeHead(404); return res.end(); }
      if (req.method === 'HEAD') { res.writeHead(200, { 'Upload-Offset': String(up.data.length) }); return res.end(); }
      if (req.method === 'PATCH') {
        if (slowPatch) await new Promise((r) => setTimeout(r, 300));
        if (Number(req.headers['upload-offset']) !== up.data.length) { res.writeHead(409); return res.end(); }
        up.data = Buffer.concat([up.data, body]);
        res.writeHead(204, { 'Upload-Offset': String(up.data.length) });
        return res.end();
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/videos/confirm') {
      const meta = JSON.parse(body.toString());
      confirmed.push(meta);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ video: { id: 'video-' + confirmed.length } }));
    }
    // Stav zpracování: napodobenina Kine odpoví "processing" tolikrát, kolik je v processingLeft, pak "ready".
    if (req.method === 'POST' && url.pathname === '/api/videos/status') {
      statusCalls.push(JSON.parse(body.toString()).videoId);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (processingLeft > 0) {
        processingLeft -= 1;
        return res.end(JSON.stringify({ status: 'processing' }));
      }
      return res.end(JSON.stringify({ status: 'ready' }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, uploads, confirmed, statusCalls, setSlow: (v) => (slowPatch = v), setProcessing: (n) => (processingLeft = n), port: server.address().port })
    )
  );
}

function makeLibrary(withClip) {
  const dir = mkdtempSync(join(tmpdir(), 'kine-lib-'));
  const library = new ClipLibrary(dir);
  library.load();
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, Buffer.alloc(withClip, 7));
  const clip = {
    id: 'c1', file, thumb: null, title: 'Můj klip', game: 'Counter-Strike 2', createdAt: new Date().toISOString(),
    durationSeconds: 30, sizeBytes: withClip, width: 1920, height: 1080, sessionId: 's1', upload: null,
  };
  library.add(clip);
  return { library, clip };
}

const settings = { visibility: 'private', videoLanguage: 'cs', uploadCategory: 'catGaming', uploadHashtags: '', uploadThumbnail: false };
/** Čekání na zpracování v testech: hned a jen dvakrát (ostrý rozvrh by držel proces desítky minut). */
const fast = () => [20, 20, 20, 20];

test('klip se nahraje po kusech, potvrdí u Kine a dostane odkaz', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(3 * 1024 * 1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  const events = [];
  const uploader = new Uploader({ library, api, blocked: () => null, settings: () => settings, log: () => {}, readySchedule: fast });
  uploader.on((e) => events.push(e));
  const done = new Promise((resolve) => uploader.on((e) => e.type === 'done' && resolve(e)));

  uploader.enqueue([{ clipId: 'c1', visibility: 'public', title: 'Ace na Mirage' }]);
  const result = await done;

  assert.equal(result.url, `http://127.0.0.1:${mock.port}/watch/video-1`);
  assert.equal(mock.uploads.get('cf1').data.length, 3 * 1024 * 1024);
  assert.equal(mock.confirmed.length, 1);
  assert.equal(mock.confirmed[0].title, 'Ace na Mirage');
  assert.equal(mock.confirmed[0].visibility, 'public');
  assert.equal(mock.confirmed[0].category, 'catGaming');
  assert.deepEqual(mock.confirmed[0].hashtags, ['klip', 'counterstrike2']);
  assert.equal(library.get('c1').upload.state, 'done');
  // Hned po nahrání Kine video teprve zpracovává - klip to ví; jak se Kine ozve "ready", přijde událost.
  assert.equal(library.get('c1').upload.ready, false);
  const ready = await new Promise((resolve) => uploader.on((e) => e.type === 'ready' && resolve(e)));
  assert.equal(ready.clip.id, 'c1');
  assert.equal(library.get('c1').upload.ready, true);
  assert.ok(mock.statusCalls.includes('video-1'));
  uploader.stopWaiting();
  mock.server.close();
});

test('když se rozjede hra, nahrávání se pozastaví a po hře naváže od offsetu', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(6 * 1024 * 1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  let gameRunning = false;
  const uploader = new Uploader({ library, api, blocked: () => (gameRunning ? 'game' : null), settings: () => settings, log: () => {}, readySchedule: fast });
  const done = new Promise((resolve) => uploader.on((e) => e.type === 'done' && resolve(e)));

  mock.setSlow(true);
  uploader.enqueue([{ clipId: 'c1', visibility: 'private' }]);
  // Nechat odejít první kus (8 MiB kusy > soubor, takže se pošle celý najednou -
  // proto zmenšíme: přerušíme hned, jak nahrávání začne).
  await new Promise((r) => setTimeout(r, 100));
  gameRunning = true;
  uploader.kick();
  await new Promise((r) => setTimeout(r, 500));
  const paused = library.get('c1').upload;
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reason, 'game');
  assert.equal(mock.confirmed.length, 0);

  mock.setSlow(false);
  gameRunning = false;
  uploader.kick();
  const result = await done;
  assert.equal(mock.uploads.size >= 1, true);
  assert.equal(mock.confirmed.length, 1);
  assert.ok(result.url.includes('/watch/'));
  uploader.stopWaiting();
  mock.server.close();
});

test('bez přihlášení skončí klip s chybou, ne zaseknutý', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => null });
  const uploader = new Uploader({ library, api, blocked: () => null, settings: () => settings, log: () => {} });
  const failed = new Promise((resolve) => uploader.on((e) => e.type === 'error' && resolve(e)));
  uploader.enqueue([{ clipId: 'c1', visibility: 'private' }]);
  const e = await failed;
  assert.match(e.message, /přihlášen/);
  assert.equal(library.get('c1').upload.state, 'error');
  assert.equal(uploader.pending(), 0);
  mock.server.close();
});

test('nastavení nahrání se pošle na Kine (popis, hashtagy, kategorie, viditelnost pro odběratele) a náhled jde do Kine', async () => {
  const mock = await startMockServer();
  const { library, clip } = makeLibrary(1024);
  const thumbFile = clip.file + '.jpg';
  writeFileSync(thumbFile, Buffer.alloc(10, 1));
  library.update('c1', { thumb: thumbFile });
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  const thumbs = [];
  const uploader = new Uploader({
    library,
    api,
    blocked: () => null,
    settings: () => ({ ...settings, uploadHashtags: 'kine cz', uploadCategory: 'catMusic', uploadThumbnail: true }),
    log: () => {},
    readySchedule: fast,
    uploadThumbnail: async (videoId, file) => void thumbs.push({ videoId, file }),
  });
  const done = new Promise((resolve) => uploader.on((e) => e.type === 'done' && resolve(e)));
  uploader.enqueue([
    {
      clipId: 'c1',
      visibility: 'subscribers',
      title: 'Clutch',
      description: 'Můj popis',
      hashtags: ['clutch', 'cs2'],
      category: 'catEntertainment',
      language: 'en',
      madeForKids: false,
      hasPaidPromotion: true,
      isAiGenerated: false,
    },
  ]);
  await done;
  const meta = mock.confirmed[0];
  assert.equal(meta.title, 'Clutch');
  assert.equal(meta.description, 'Můj popis');
  assert.deepEqual(meta.hashtags, ['clutch', 'cs2']);
  assert.equal(meta.category, 'catEntertainment');
  assert.equal(meta.language, 'en');
  assert.equal(meta.visibility, 'subscribers');
  assert.equal(meta.hasPaidPromotion, true);
  assert.equal(meta.madeForKids, false);
  // Náhled z appky šel na Kine k právě vytvořenému videu.
  assert.deepEqual(thumbs, [{ videoId: 'video-1', file: thumbFile }]);
  // Nastavení se uložilo ke klipu (přežije restart) a název se přepsal.
  assert.equal(library.get('c1').uploadOptions.category, 'catEntertainment');
  assert.equal(library.get('c1').title, 'Clutch');
  uploader.stopWaiting();
  mock.server.close();
});

test('bez vlastního nastavení jdou výchozí hodnoty: hashtagy z nastavení, kategorie z nastavení, popis z appky', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  const uploader = new Uploader({
    library,
    api,
    blocked: () => null,
    settings: () => ({ ...settings, uploadHashtags: '#Kine, cz klip', uploadCategory: 'catMusic' }),
    log: () => {},
    readySchedule: fast,
    describe: (c) => `Popis pro ${c.game}`,
  });
  const done = new Promise((resolve) => uploader.on((e) => e.type === 'done' && resolve(e)));
  uploader.enqueue([{ clipId: 'c1', visibility: 'public' }]);
  await done;
  const meta = mock.confirmed[0];
  assert.deepEqual(meta.hashtags, ['klip', 'counterstrike2', 'kine', 'cz']);
  assert.equal(meta.category, 'catMusic');
  assert.equal(meta.description, 'Popis pro Counter-Strike 2');
  assert.equal(meta.visibility, 'public');
  uploader.stopWaiting();
  mock.server.close();
});

test('čekání na zpracování: "processing" se zkouší dál, po restartu appky se naváže z knihovny', async () => {
  const mock = await startMockServer();
  mock.setProcessing(2);
  const { library } = makeLibrary(1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  const uploader = new Uploader({ library, api, blocked: () => null, settings: () => settings, log: () => {}, readySchedule: () => [20, 20, 20, 20, 20, 20] });
  const ready = new Promise((resolve) => uploader.on((e) => e.type === 'ready' && resolve(e)));
  uploader.enqueue([{ clipId: 'c1', visibility: 'public' }]);
  await ready;
  // Dvakrát "processing", potřetí "ready".
  assert.equal(mock.statusCalls.length, 3);
  assert.equal(library.get('c1').upload.ready, true);
  uploader.stopWaiting();

  // Restart: klip nahraný, ale Kine ho ještě nezpracovala - nový uploader se ptá dál.
  library.setUpload('c1', { state: 'done', videoId: 'video-1', url: 'http://x/watch/video-1', ready: false });
  const again = new Uploader({ library, api, blocked: () => null, settings: () => settings, log: () => {}, readySchedule: () => [20, 20] });
  const ready2 = new Promise((resolve) => again.on((e) => e.type === 'ready' && resolve(e)));
  again.restoreFromLibrary();
  await ready2;
  assert.equal(library.get('c1').upload.ready, true);
  again.stopWaiting();
  mock.server.close();
});
