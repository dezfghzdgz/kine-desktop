import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tusUpload, tusOffset, TusAborted, nextChunkSize, smallerChunk, TUS_MIN_CHUNK, TUS_MAX_CHUNK } from '../dist/esm/tus.js';

/** Napodobenina serveru Cloudflare: drží offset a umí "spadnout" na zavolání. */
function fakeServer({ failPatches = 0 } = {}) {
  const state = { offset: 0, received: [], patches: 0, heads: 0, fails: failPatches };
  const fetchImpl = async (url, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (init.method === 'HEAD') {
      state.heads += 1;
      return new Response(null, { status: 200, headers: { 'Upload-Offset': String(state.offset) } });
    }
    if (init.method === 'PATCH') {
      state.patches += 1;
      if (state.fails > 0) {
        state.fails -= 1;
        return new Response('nope', { status: 503 });
      }
      const declared = Number(init.headers['Upload-Offset']);
      if (declared !== state.offset) return new Response('conflict', { status: 409 });
      const body = init.body;
      state.received.push(body.length);
      state.offset += body.length;
      return new Response(null, { status: 204, headers: { 'Upload-Offset': String(state.offset) } });
    }
    throw new Error('unexpected ' + init.method);
  };
  return { state, fetchImpl };
}

const data = new Uint8Array(25).map((_, i) => i);
const read = async (offset, length) => data.subarray(offset, offset + length);

test('nahrání po kusech s hlášením průběhu', async () => {
  const { state, fetchImpl } = fakeServer();
  const progress = [];
  await tusUpload({ url: 'http://x/u', size: 25, read, chunkSize: 10, fetchImpl, onProgress: (n) => progress.push(n), sleep: async () => {} });
  assert.deepEqual(state.received, [10, 10, 5]);
  assert.deepEqual(progress, [0, 10, 20, 25]);
});

test('výpadek serveru: zopakuje kus, zeptá se HEADem, dokončí', async () => {
  const { state, fetchImpl } = fakeServer({ failPatches: 2 });
  await tusUpload({ url: 'http://x/u', size: 25, read, chunkSize: 10, fetchImpl, sleep: async () => {} });
  assert.equal(state.offset, 25);
  assert.ok(state.heads >= 1);
});

test('přerušení hodí TusAborted a navázání pokračuje od offsetu serveru', async () => {
  const { state, fetchImpl } = fakeServer();
  const controller = new AbortController();
  let sent = 0;
  const readAbort = async (offset, length) => {
    sent += 1;
    if (sent === 2) controller.abort();
    return data.subarray(offset, offset + length);
  };
  await assert.rejects(
    tusUpload({ url: 'http://x/u', size: 25, read: readAbort, chunkSize: 10, fetchImpl, signal: controller.signal, sleep: async () => {} }),
    (e) => e instanceof TusAborted
  );
  assert.equal(state.offset, 10);
  // Navázání: klient si myslí 5, server má 10 - věří se serveru.
  await tusUpload({ url: 'http://x/u', size: 25, read, offset: 5, chunkSize: 10, fetchImpl, sleep: async () => {} });
  assert.equal(state.offset, 25);
  assert.deepEqual(state.received, [10, 10, 5]);
  assert.equal(await tusOffset('http://x/u', fetchImpl), 25);
});

test('velikost kusu podle rychlosti: rychlé připojení větší kusy, vždy podle pravidel Cloudflare', () => {
  const MiB = 1024 * 1024;
  // 8 MiB za 1 s (≈ 67 Mb/s) -> dvojnásobek, pak dál až na strop 64 MiB
  assert.equal(nextChunkSize(8 * MiB, 8 * MiB, 1000), 16 * MiB);
  assert.equal(nextChunkSize(48 * MiB, 48 * MiB, 1000), TUS_MAX_CHUNK);
  // pomalé připojení: ne pod 8 MiB
  assert.equal(nextChunkSize(16 * MiB, 16 * MiB, 60000), TUS_MIN_CHUNK);
  // krátké měření nic nemění (testy, malý kus)
  assert.equal(nextChunkSize(8 * MiB, 100, 2), 8 * MiB);
  // celý kus za míň než půl vteřiny (optika) -> roste i tak, až na strop
  assert.equal(nextChunkSize(8 * MiB, 8 * MiB, 300), 16 * MiB);
  assert.equal(nextChunkSize(TUS_MAX_CHUNK, TUS_MAX_CHUNK, 0), TUS_MAX_CHUNK);
  assert.equal(smallerChunk(32 * MiB), 16 * MiB);
  assert.equal(smallerChunk(8 * MiB), TUS_MIN_CHUNK);
  for (const [c, b, ms] of [[8 * MiB, 8 * MiB, 1234], [16 * MiB, 3 * MiB, 7777], [64 * MiB, 64 * MiB, 555]]) {
    const n = nextChunkSize(c, b, ms);
    assert.equal(n % (256 * 1024), 0);
    assert.ok(n >= 5 * MiB && n <= 200 * MiB);
  }
});
