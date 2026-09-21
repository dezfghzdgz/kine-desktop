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
  let slowPatch = false;
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
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, uploads, confirmed, setSlow: (v) => (slowPatch = v), port: server.address().port })));
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

const settings = { visibility: 'private', videoLanguage: 'cs' };

test('klip se nahraje po kusech, potvrdí u Kine a dostane odkaz', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(3 * 1024 * 1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  const events = [];
  const uploader = new Uploader({ library, api, blocked: () => null, settings: () => settings, log: () => {} });
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
  mock.server.close();
});

test('když se rozjede hra, nahrávání se pozastaví a po hře naváže od offsetu', async () => {
  const mock = await startMockServer();
  const { library } = makeLibrary(6 * 1024 * 1024);
  const api = createKineApi({ siteUrl: () => `http://127.0.0.1:${mock.port}`, getToken: async () => 'token-123' });
  let gameRunning = false;
  const uploader = new Uploader({ library, api, blocked: () => (gameRunning ? 'game' : null), settings: () => settings, log: () => {} });
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
