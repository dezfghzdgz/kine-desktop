import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactStreamKeys } from '../dist/esm/redact.js';

const KEY = '0123456789abcdef0123456789abcdef';

test('klíč vysílání: chyba ffmpeg s celou adresou rtmps', () => {
  assert.equal(
    redactStreamKeys(`[out#0/flv @ 0x1] Error opening output rtmps://live.cloudflare.com:443/live/${KEY}: I/O error`),
    `[out#0/flv @ 0x1] Error opening output rtmps://live.cloudflare.com:443/live/${REDACTED}: I/O error`
  );
  // Konec textu, víc řádků, rtmp bez s a velká písmena ve schématu.
  assert.equal(redactStreamKeys(`a\nRTMP://127.0.0.1:1935/live/${KEY}`), `a\nRTMP://127.0.0.1:1935/live/${REDACTED}`);
  // "Všechno za /live/" - i další úroveň cesty.
  assert.equal(redactStreamKeys(`rtmps://x.example/live/app/${KEY}.`), `rtmps://x.example/live/${REDACTED}.`);
  assert.ok(!redactStreamKeys(`"rtmps://live.cloudflare.com/live/${KEY}"`).includes(KEY));
});

test('klíč vysílání: parametry adresy, které vypadají jako klíč', () => {
  assert.equal(redactStreamKeys('srt://live.cloudflare.com:778?passphrase=tajne123&streamid=abcdef12'), `srt://live.cloudflare.com:778?passphrase=${REDACTED}&streamid=${REDACTED}`);
  assert.equal(redactStreamKeys('https://x.example/in?streamKey=abc&ok=1'), `https://x.example/in?streamKey=${REDACTED}&ok=1`);
  assert.equal(redactStreamKeys('https://x.example/in?stream_key=abc#x'), `https://x.example/in?stream_key=${REDACTED}#x`);
  assert.equal(redactStreamKeys('rtmps://x.example/live/?key=abc'), `rtmps://x.example/live/?key=${REDACTED}`);
});

test('klíč vysílání: známý klíč kdekoli v textu, krátké ne', () => {
  assert.equal(redactStreamKeys(`chyba: ${KEY} odmítnut`, [KEY]), `chyba: ${REDACTED} odmítnut`);
  assert.equal(redactStreamKeys('test abc test', ['abc']), 'test abc test', 'kratší než 6 znaků se neskrývá');
  assert.equal(redactStreamKeys('nic', [null, undefined, '']), 'nic');
});

test('klíč vysílání: ostatní text beze změny (stránka vysílání na Kine, cesty, prázdno)', () => {
  const plain = 'vysílání: diváci obraz vidí · https://www.playkine.com/live/user-123/chat · C:\\Videa\\Kine';
  assert.equal(redactStreamKeys(plain), plain);
  assert.equal(redactStreamKeys(undefined), '');
  assert.equal(redactStreamKeys(42), '42');
});
