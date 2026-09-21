import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tusUpload, tusOffset, TusAborted } from '../dist/esm/tus.js';

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
