import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LIVE_PRESETS, LIVE_QUALITIES, cleanLiveError, liveElapsed, liveErrorKind, liveErrorTextKey, livePresetLabel } from '../dist/esm/live.js';
import { LIVE_MAX_ATTEMPTS, liveFfmpegArgs, liveProgressSeconds, liveRetryDelay, maskLiveUrl, rtmpUrl } from '../dist/esm/livePlan.js';
import { LiveController } from '../dist/esm/liveController.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../dist/esm/settingsSchema.js';

test('vysílání: adresa RTMPS z Cloudflare + klíč, klíč se do protokolu nepíše celý', () => {
  assert.equal(rtmpUrl('rtmps://live.cloudflare.com:443/live/', 'abc123'), 'rtmps://live.cloudflare.com:443/live/abc123');
  assert.equal(rtmpUrl('rtmps://live.cloudflare.com:443/live', ' abc123 '), 'rtmps://live.cloudflare.com:443/live/abc123');
  assert.throws(() => rtmpUrl('', 'x'));
  assert.equal(maskLiveUrl('rtmps://live.cloudflare.com:443/live/abcdef123456'), 'rtmps://live.cloudflare.com:443/live/abcd…');
});

test('vysílání: ffmpeg jen přebalí obraz, zvuk na AAC, FLV na adresu, průběh na stdout', () => {
  const args = liveFfmpegArgs('rtmp://127.0.0.1:1935/live/x');
  const s = args.join(' ');
  assert.ok(s.includes('-i pipe:0'));
  assert.ok(s.includes('-map 0:v:0 -map 0:a:0?'));
  assert.ok(s.includes('-c:v copy -c:a aac -b:a 160k'));
  assert.ok(s.includes('-f flv'));
  assert.ok(s.includes('-progress pipe:1'));
  assert.equal(args[args.length - 1], 'rtmp://127.0.0.1:1935/live/x');
  assert.equal(liveProgressSeconds('out_time_us=2500000'), 2.5);
  assert.equal(liveProgressSeconds('bitrate=100kbits/s'), null);
});

test('vysílání: znovupřipojení 2, 3, 5... s, pak konec', () => {
  assert.equal(liveRetryDelay(1), 2000);
  assert.equal(liveRetryDelay(2), 3000);
  assert.equal(liveRetryDelay(LIVE_MAX_ATTEMPTS + 1), null);
  assert.equal(liveRetryDelay(0), null);
});

test('vysílání: kvalita, popisek, čas, chyby pro hráče', () => {
  assert.deepEqual([...LIVE_QUALITIES], ['720p30', '1080p30', '1080p60']);
  assert.deepEqual(LIVE_PRESETS['720p30'], { width: 1280, height: 720, fps: 30, videoKbps: 3000 });
  assert.equal(livePresetLabel('1080p30'), '1080p · 30 fps · 4.5 Mb/s');
  assert.equal(liveElapsed(1000, 1000 + 65_000), '1:05');
  assert.equal(liveElapsed(0, 5), '0:00');
  assert.equal(liveElapsed(1, 1 + 3_723_000), '1:02:03');
  assert.equal(liveErrorKind('live-not-migrated'), 'not-migrated');
  assert.equal(liveErrorKind('Error opening output rtmps://...: Connection refused'), 'network');
  assert.equal(liveErrorKind('Server error: Unauthorized'), 'auth');
  assert.equal(liveErrorTextKey('not-logged-in'), 'liveNeedLogin');
  assert.equal(liveErrorTextKey('něco jiného'), 'liveErrOther');
  assert.equal(cleanLiveError("Error invoking remote method 'live:start': Error: live-not-configured"), 'live-not-configured');
  assert.equal(DEFAULT_SETTINGS.liveQuality, '720p30');
  assert.equal(sanitizeSettings({ liveQuality: '4k' }).liveQuality, '720p30');
  assert.equal(sanitizeSettings({ liveQuality: '1080p60', liveTitle: 'x'.repeat(300) }).liveTitle.length, 100);
});

/** Falešný ffmpeg: stdin sbírá kousky, stdout/stderr jde psát z testu, close se dá vyvolat. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.received = [];
  child.stdin.on('data', (d) => child.received.push(d));
  child.kill = () => {
    if (child.exitCode === null) {
      child.exitCode = 1;
      child.emit('close', 1);
    }
  };
  child.stdin.on('finish', () => {
    setTimeout(() => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit('close', 0);
      }
    }, 10);
  });
  return child;
}

function makeController() {
  const commands = [];
  const children = [];
  const notices = [];
  const statuses = [];
  let ended = 0;
  const capture = {
    state: 'on',
    start: async () => {},
    sendLive: (c) => {
      commands.push(c);
      return true;
    },
  };
  const live = new LiveController({
    capture,
    api: () => {
      throw new Error('api se v testu nevolá');
    },
    settings: () => DEFAULT_SETTINGS,
    siteUrl: () => 'https://kine.test',
    spawn: (args) => {
      const c = fakeChild();
      c.args = args;
      children.push(c);
      return c;
    },
    log: () => {},
    onChange: (s) => statuses.push(s.state),
    notify: (kind) => notices.push(kind),
    onEnded: () => (ended += 1),
    testUrl: 'rtmp://127.0.0.1:1935/live/test',
  });
  return { live, capture, commands, children, notices, statuses, ended: () => ended };
}

test('vysílání: start -> recorder + ffmpeg, průběh = živě, kousky jen z aktuální generace', async () => {
  const { live, commands, children, notices } = makeController();
  const status = await live.start({ title: '  Ranked  ', quality: '1080p30' });
  assert.equal(status.state, 'starting');
  assert.equal(status.title, 'Ranked');
  assert.equal(children.length, 1);
  assert.equal(children[0].args[children[0].args.length - 1], 'rtmp://127.0.0.1:1935/live/test');
  assert.equal(commands[0].type, 'live-start');
  assert.deepEqual(commands[0].preset, LIVE_PRESETS['1080p30']);
  const gen = commands[0].generation;
  live.handleChunk(gen, new Uint8Array([1, 2, 3]));
  live.handleChunk(gen + 99, new Uint8Array([9]));
  children[0].stdout.write('out_time_us=1500000\n');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(live.current().state, 'live');
  assert.ok(live.current().since);
  assert.deepEqual(notices, ['live']);
  assert.deepEqual(Buffer.concat(children[0].received), Buffer.from([1, 2, 3]));
  await live.stop('user');
  assert.equal(live.current().state, 'idle');
  assert.equal(commands[commands.length - 1].type, 'live-stop');
  assert.ok(notices.includes('ended'));
});

test('vysílání: výpadek spojení -> znovu (nová generace)', async () => {
  const { live, commands, children, notices, ended } = makeController();
  await live.start({ title: 'x', quality: '720p30' });
  const firstGen = commands[0].generation;
  children[0].stdout.write('out_time_us=3000000\n');
  await new Promise((r) => setTimeout(r, 10));
  children[0].stderr.write('rtmps://...: Connection reset by peer\n');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.equal(live.current().state, 'reconnecting');
  assert.ok(notices.includes('reconnecting'));
  assert.equal(commands[commands.length - 1].type, 'live-stop');
  // Za 2 s nový pokus: nový ffmpeg, nový recorder s jinou generací.
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(children.length, 2);
  const again = commands.filter((c) => c.type === 'live-start');
  assert.equal(again.length, 2);
  assert.notEqual(again[1].generation, firstGen);
  children[1].stdout.write('out_time_us=1000000\n');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(live.current().state, 'live');
  // Kousek staré generace se už nikam nepíše.
  live.handleChunk(firstGen, new Uint8Array([7]));
  assert.equal(children[1].received.length, 0);
  await live.stop('user');
  assert.equal(ended(), 1);
});

test('vysílání: recorder skončil kvůli novému startu snímání -> naváže se', async () => {
  const { live, commands, children } = makeController();
  await live.start({ title: 'x', quality: '720p30' });
  const gen = commands[0].generation;
  live.handleEvent({ type: 'live-stopped', generation: gen });
  assert.equal(live.current().state, 'reconnecting');
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(children.length, 2);
  await live.stop('quit');
  assert.equal(live.current().state, 'idle');
});

test('vysílání: ukončení během čekání na nový pokus už nic nerozjede', async () => {
  const { live, commands, children } = makeController();
  await live.start({ title: 'x', quality: '720p30' });
  live.handleEvent({ type: 'live-error', generation: commands[0].generation, message: 'Connection refused' });
  assert.equal(live.current().state, 'reconnecting');
  await live.stop('user');
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(children.length, 1);
  assert.equal(live.current().state, 'idle');
});

test('vysílání: špatný klíč se neopakuje - rovnou konec s chybou', async () => {
  const { live, commands, notices, ended } = makeController();
  await live.start({ title: 'x', quality: '720p30' });
  live.handleEvent({ type: 'live-error', generation: commands[0].generation, message: 'Server returned 401 Unauthorized' });
  if (live.current().state !== 'idle') await live.stop('quit');
  assert.equal(live.current().state, 'idle');
  assert.match(live.current().error ?? '', /Unauthorized/);
  assert.ok(notices.includes('failed'));
  assert.equal(ended(), 1);
});
