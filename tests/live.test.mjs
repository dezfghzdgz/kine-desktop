import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LIVE_PRESETS, LIVE_QUALITIES, LIVE_THUMBNAIL_MAX_BYTES, cleanLiveError, coverRect, liveBitrate, liveElapsed, liveErrorKind, liveErrorTextKey, livePresetFor, livePresetLabel, liveUploadMbps, looksLikeLiveThumbnail } from '../dist/esm/live.js';
import { LIVE_MAX_ATTEMPTS, liveFfmpegArgs, liveProgressSeconds, liveRetryDelay, maskLiveUrl, rtmpUrl } from '../dist/esm/livePlan.js';
import { LiveController } from '../dist/esm/liveController.js';
import { HEALTH_FIRST_MS, HEALTH_STALL_MS, HlsWatch, parsePlaylist, pickVariant } from '../dist/esm/liveHealth.js';
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

function makeController(apiImpl = null, extra = {}) {
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
      if (apiImpl) return apiImpl;
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
    ...extra,
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

test('vysílání: vlastní datový tok přepíše kvalitu, nesmysl se zahodí', () => {
  assert.equal(liveBitrate(0), 0);
  assert.equal(liveBitrate('abc'), 0);
  assert.equal(liveBitrate(50), 1000);
  assert.equal(liveBitrate(99999), 12000);
  assert.equal(liveBitrate(4520), 4500);
  assert.deepEqual(livePresetFor('1080p60'), LIVE_PRESETS['1080p60']);
  assert.deepEqual(livePresetFor('1080p60', 8000), { ...LIVE_PRESETS['1080p60'], videoKbps: 8000 });
  assert.equal(liveUploadMbps(3000), 3.8);
});

test('vysílání: nová nastavení mají výchozí hodnoty a jsou očištěná', () => {
  assert.equal(DEFAULT_SETTINGS.liveGameAudio, true);
  assert.equal(DEFAULT_SETTINGS.liveMic, true);
  assert.equal(DEFAULT_SETTINGS.liveOpenPage, false);
  assert.equal(DEFAULT_SETTINGS.liveBitrateKbps, 0);
  const s = sanitizeSettings({ liveBitrateKbps: 99999, liveCategory: 'nesmysl', liveDescription: 'x'.repeat(5000), liveMic: 'ano' });
  assert.equal(s.liveBitrateKbps, 12000);
  assert.equal(s.liveCategory, DEFAULT_SETTINGS.liveCategory);
  assert.equal(s.liveDescription.length, 2000);
  assert.equal(s.liveMic, true);
});

test('vysílání: recorder dostane kvalitu s vlastním tokem a co jde do zvuku', async () => {
  const { live, commands } = makeController();
  await live.start({ title: 'x', quality: '1080p30', bitrateKbps: 6000, game: true, mic: false });
  assert.deepEqual(commands[0].preset, { ...LIVE_PRESETS['1080p30'], videoKbps: 6000 });
  assert.deepEqual(commands[0].audio, { game: true, mic: false });
  await live.stop('quit');
});

test('vysílání: kamera a "Hned jsem zpět" jdou do recorderu při startu i za běhu, bez nového spojení', async () => {
  const { live, commands, children } = makeController();
  const scene = { camera: { deviceId: '', position: 'bottom-right', size: 'medium', shape: 'rounded', mirror: true }, brb: false, brbText: 'BRB', micMuted: false };
  await live.start({ title: 'x', quality: '720p30', scene });
  assert.deepEqual(commands[0].scene, scene);
  assert.deepEqual(live.current().scene, scene);
  children[0].stdout.write('out_time_us=1500000\n');
  await new Promise((r) => setTimeout(r, 10));
  live.setScene({ ...scene, brb: true, micMuted: true });
  const sceneCmd = commands[commands.length - 1];
  assert.equal(sceneCmd.type, 'live-scene');
  assert.equal(sceneCmd.scene.brb, true);
  assert.equal(children.length, 1, 'žádné nové spojení');
  assert.equal(live.current().scene.brb, true);
  // Kamera nejde (obsazená) - vysílá se dál, hráč to uvidí.
  live.handleEvent({ type: 'live-warning', generation: commands[0].generation, kind: 'camera', message: 'camera-busy' });
  assert.equal(live.current().cameraError, 'camera-busy');
  assert.equal(live.current().state, 'live');
  await live.stop('quit');
  assert.equal(live.current().scene, null);
  assert.equal(live.current().cameraError, null);
});

test('vysílání: Ukončit je hned "ukončuje se" a druhé Ukončit nic nespustí znovu', async () => {
  const { live, children, notices, ended } = makeController();
  await live.start({ title: 'x', quality: '720p30' });
  children[0].stdout.write('out_time_us=1500000\n');
  await new Promise((r) => setTimeout(r, 10));
  const first = live.stop('user');
  assert.equal(live.current().state, 'stopping');
  const second = live.stop('user');
  await Promise.all([first, second]);
  assert.equal(live.current().state, 'idle');
  assert.equal(notices.filter((n) => n === 'ended').length, 1);
  assert.equal(ended(), 1);
});

test('vysílání: co odchází - z rozdílu proti minulému bloku průběhu ffmpeg', async () => {
  const { createProgressReader } = await import('../dist/esm/livePlan.js');
  let now = 0;
  const read = createProgressReader(() => now);
  const block = (frame, size, us) => {
    read(`frame=${frame}`);
    read(`total_size=${size}`);
    read(`out_time_us=${us}`);
    read('bitrate=1234.5kbits/s');
    return read('progress=continue');
  };
  now = 1000;
  assert.deepEqual(block(30, 375000, 1_000_000), { kbps: null, fps: null, speed: null }, 'první blok: není s čím srovnat');
  now = 3000;
  const s = block(90, 375000 + 750000, 3_000_000);
  assert.equal(s.kbps, 3000);
  assert.equal(s.fps, 30);
  assert.equal(s.speed, 1);
  now = 5000;
  const slow = block(120, 1125000 + 250000, 4_000_000);
  assert.equal(slow.speed, 0.5);
  assert.equal(slow.fps, 15);
  assert.equal(read('frame=1'), null, 'uprostřed bloku nic');
  assert.equal(read('nesmysl'), null);
});

/** Vysílá (průběh ffmpeg = živě) a ukončí - pak je karta záznamu. */
async function streamAndStop(ctx, title = 'Ranked') {
  await ctx.live.start({ title, quality: '720p30' });
  ctx.children[ctx.children.length - 1].stdout.write('out_time_us=1500000\n');
  await new Promise((r) => setTimeout(r, 10));
  await ctx.live.stop('user');
}

test('vysílání: po konci karta záznamu (délka, název), bez vysílání žádná', async () => {
  const ctx = makeController();
  await streamAndStop(ctx, 'Ranked s klukama');
  const ended = ctx.live.current().ended;
  assert.ok(ended, 'karta po skončení');
  assert.equal(ended.title, 'Ranked s klukama');
  assert.match(ended.duration, /^\d+:\d\d$/);
  assert.equal(ended.video, null);
  assert.equal(ended.publishing, false);
  assert.equal(ended.autoPending, false);
  // Ukončení ještě před začátkem vysílání (připojování) kartu nedělá.
  const other = makeController();
  await other.live.start({ title: 'x', quality: '720p30' });
  await other.live.stop('user');
  assert.equal(other.live.current().ended, null);
});

test('vysílání: zveřejnění záznamu z karty -> video na Kine, nový start kartu zavře', async () => {
  const calls = [];
  const api = {
    livePublishRecording: async (opts) => {
      calls.push(opts);
      return { videoId: 'vid-1', status: 'processing', alreadyPublished: false };
    },
  };
  const ctx = makeController(api);
  await streamAndStop(ctx, 'Večerní stream');
  const pending = ctx.live.publishRecording({ visibility: 'subscribers', language: 'cs' });
  assert.equal(ctx.live.current().ended.publishing, true);
  await pending;
  assert.deepEqual(calls, [{ title: 'Večerní stream', visibility: 'subscribers', language: 'cs' }]);
  const ended = ctx.live.current().ended;
  assert.equal(ended.publishing, false);
  assert.deepEqual(ended.video, { id: 'vid-1', url: 'https://kine.test/watch/vid-1', status: 'processing', auto: false });
  // Druhé kliknutí nic nedělá (záznam už je venku).
  await ctx.live.publishRecording({ visibility: 'public' });
  assert.equal(calls.length, 1);
  // Nové vysílání: karta minulého záznamu zmizí.
  await ctx.live.start({ title: 'další', quality: '720p30' });
  assert.equal(ctx.live.current().ended, null);
  await ctx.live.stop('quit');
});

test('vysílání: záznam ještě není (404) -> chyba v kartě a jde to zkusit znovu; zavření karty', async () => {
  let attempt = 0;
  const api = {
    livePublishRecording: async () => {
      attempt += 1;
      if (attempt === 1) {
        const e = new Error('Záznam vysílání zatím není');
        e.status = 404;
        throw e;
      }
      return { videoId: 'vid-2', status: 'ready', alreadyPublished: false };
    },
  };
  const ctx = makeController(api);
  await streamAndStop(ctx);
  await ctx.live.publishRecording({ title: '  Můj název  ', visibility: 'public' });
  let ended = ctx.live.current().ended;
  assert.equal(ended.error.status, 404);
  assert.equal(ended.publishing, false);
  assert.equal(ended.video, null);
  await ctx.live.publishRecording({ title: '  Můj název  ', visibility: 'public' });
  ended = ctx.live.current().ended;
  assert.equal(ended.error, null);
  assert.equal(ended.title, 'Můj název');
  assert.equal(ended.video.status, 'ready');
  ctx.live.dismissEnded();
  assert.equal(ctx.live.current().ended, null);
});

const waitFor = async (cond, ms = 3000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('nedočkal se');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('vysílání: kompatibilní režim - x264, pevné snímky, klíčový snímek každé 2 s, stálý tok', () => {
  const s = liveFfmpegArgs('rtmp://x/live/k', { fps: 30, kbps: 3000 }).join(' ');
  assert.ok(s.includes('-c:v libx264'));
  assert.ok(!s.includes('-c:v copy'));
  assert.ok(s.includes('-r 30 -g 60 -keyint_min 60 -sc_threshold 0 -bf 0'), s);
  assert.ok(s.includes('-b:v 3000k -maxrate 3000k -bufsize 6000k'), s);
  assert.ok(s.includes('-c:a aac -b:a 160k'));
  assert.ok(liveFfmpegArgs('rtmp://x/live/k', { fps: 60, kbps: 6000 }).join(' ').includes('-g 120'));
  // běžný režim beze změny (jen přebalení)
  assert.ok(liveFfmpegArgs('rtmp://x/live/k').join(' ').includes('-c:v copy'));
});

test('hlídání obrazu: playlisty HLS (hlavní -> varianta, mediální kousky)', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhi/video.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlo/video.m3u8?x=1\n';
  const m = parsePlaylist(master, 'https://customer-abc.cloudflarestream.com/in1/manifest/video.m3u8');
  assert.equal(m.kind, 'master');
  assert.equal(pickVariant(m), 'https://customer-abc.cloudflarestream.com/in1/manifest/lo/video.m3u8?x=1');
  const media = parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:41\n#EXTINF:2.0,\nseg41.ts\n#EXTINF:2.0,\nseg42.ts\n', 'https://x.test/a/b.m3u8');
  assert.deepEqual(media, { kind: 'media', sequence: 41, segments: ['seg41.ts', 'seg42.ts'], ended: false });
  assert.equal(parsePlaylist('<html>404</html>', 'https://x.test/'), null);
  assert.equal(parsePlaylist('', 'https://x.test/'), null);
});

test('hlídání obrazu: přibývají kousky = ok, stojí = zamrzlý obraz, nejde přečíst = neví se', () => {
  const T = 1_000_000;
  const pl = (seq, n) => ({ sequence: seq, segments: Array.from({ length: n }, (_, i) => `s${seq + i}.ts`) });
  const w = new HlsWatch();
  assert.equal(w.verdict(T, T + 5000, null), 'checking');
  w.observe(pl(1, 3), T + 10000);
  assert.equal(w.verdict(T, T + 10000, null), 'checking', 'první playlist ještě nic nedokazuje');
  w.observe(pl(2, 3), T + 15000);
  assert.equal(w.verdict(T, T + 15000, null), 'ok');
  w.observe(pl(2, 3), T + 20000);
  assert.equal(w.verdict(T, T + 15000 + HEALTH_STALL_MS - 1, null), 'ok');
  assert.equal(w.verdict(T, T + 15000 + HEALTH_STALL_MS, null), 'stalled');
  // playlist je, ale od začátku nepřibývá: po minutě zamrzlý obraz
  const frozen = new HlsWatch();
  frozen.observe(pl(5, 2), T + 5000);
  frozen.observe(pl(5, 2), T + 10000);
  assert.equal(frozen.verdict(T, T + HEALTH_FIRST_MS - 1, null), 'checking');
  assert.equal(frozen.verdict(T, T + HEALTH_FIRST_MS, null), 'stalled');
  // playlist nejde přečíst nikdy: Kine potvrzuje -> nejde ověřit (nic se nepřepíná); nepotvrzuje -> po 90 s zamrzlý
  const none = new HlsWatch();
  none.observe(null, T + 5000);
  assert.equal(none.verdict(T, T + HEALTH_FIRST_MS + 1000, true), 'unknown');
  assert.equal(none.verdict(T, T + HEALTH_FIRST_MS + 1000, false), 'checking');
  assert.equal(none.verdict(T, T + 90000, false), 'stalled');
  w.reset();
  assert.equal(w.verdict(T + 100000, T + 100000, null), 'checking');
});

test('vysílání: diváci vidí zamrzlý obraz -> kompatibilní režim (nové spojení s x264); když pomůže, zapamatuje se', async () => {
  let advancing = false;
  let seq = 1;
  let remembered = 0;
  const fetchText = async (url) => {
    if (url.endsWith('master.m3u8')) return { status: 200, text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n' };
    if (advancing) seq += 1;
    return { status: 200, text: `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXTINF:2,\na${seq}.ts\n` };
  };
  const ctx = makeController(null, { fetchText, rememberCompat: () => (remembered += 1), timing: { healthPollMs: 20, healthFirstMs: 150, healthStallMs: 100, healthNothingMs: 200 } });
  ctx.live.testHlsUrl = 'https://customer-abc.cloudflarestream.com/in/master.m3u8';
  await ctx.live.start({ title: 'x', quality: '720p30' });
  assert.ok(ctx.children[0].args.includes('copy'), 'začíná se bez překódování');
  ctx.children[0].stdout.write('out_time_us=1500000\n');
  await waitFor(() => ctx.children.length === 2, 4000);
  assert.ok(ctx.children[1].args.join(' ').includes('-c:v libx264'), 'nové spojení v kompatibilním režimu');
  assert.notEqual(ctx.children[0].exitCode, null, 'staré spojení ukončené');
  assert.ok(ctx.notices.includes('compat'));
  assert.equal(ctx.live.current().compat, true);
  assert.equal(ctx.live.current().state, 'live', 'diváci zůstávají - žádné "znovu se připojuji"');
  advancing = true;
  ctx.children[1].stdout.write('out_time_us=1500000\n');
  await waitFor(() => ctx.live.current().health === 'ok', 4000);
  assert.equal(remembered, 1);
  await ctx.live.stop('quit');
  assert.equal(ctx.live.current().health, null);
});

test('vysílání: kompatibilní režim z nastavení hned od startu; bez HLS se nic nehlídá', async () => {
  const ctx = makeController(null, { settings: () => ({ ...DEFAULT_SETTINGS, liveCompat: true }) });
  await ctx.live.start({ title: 'x', quality: '1080p60' });
  assert.ok(ctx.children[0].args.join(' ').includes('-c:v libx264 '));
  assert.ok(ctx.children[0].args.join(' ').includes('-r 60 -g 120'));
  ctx.children[0].stdout.write('out_time_us=1500000\n');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.live.current().health, 'unknown');
  assert.equal(ctx.live.current().compat, true);
  await ctx.live.stop('quit');
});

test('vysílání: Zahodit bez id záznamu -> okno vysílání; záznam ještě není -> zkouší znovu, pak smazáno', async () => {
  const calls = [];
  const api = {
    liveRecordingDiscard: async (target) => {
      calls.push(target);
      if (calls.length === 1) {
        const e = new Error('Záznam vysílání zatím není');
        e.status = 404;
        e.retry = true;
        throw e;
      }
      return { uid: 'rec1', uids: ['rec1'] };
    },
  };
  const ctx = makeController(api, { timing: { discardRetryGapMs: 20 } });
  await streamAndStop(ctx);
  const card = ctx.live.current().ended;
  assert.ok(card.since && card.since <= card.at, 'karta zná začátek vysílání');
  assert.equal(card.recordingUid, null);
  await ctx.live.discardRecording();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { since: card.since, until: card.at });
  const ended = ctx.live.current().ended;
  assert.equal(ended.discarded, true);
  assert.equal(ended.discarding, false);
  assert.equal(ended.recordingUid, 'rec1');
});

test('vysílání: Zahodit - id nesedí -> okno vysílání; záznam už je video (409) -> chyba bez opakování', async () => {
  const calls = [];
  const api = {
    liveRecordingDiscard: async (target) => {
      calls.push(target);
      if (typeof target === 'string') {
        const e = new Error('Záznam nenalezen.');
        e.status = 404;
        throw e;
      }
      const e = new Error('Záznam už je video na Kine - smaž ho v Tvoje videa.');
      e.status = 409;
      throw e;
    },
  };
  const ctx = makeController(api, { timing: { discardRetryGapMs: 20 } });
  await streamAndStop(ctx);
  ctx.live['status'] = { ...ctx.live['status'], ended: { ...ctx.live['status'].ended, recordingUid: 'spatne' } };
  await ctx.live.discardRecording();
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'spatne');
  assert.equal(typeof calls[1], 'object');
  const ended = ctx.live.current().ended;
  assert.equal(ended.discarded, false);
  assert.match(ended.discardError, /video na Kine/);
});

test('náhled přenosu: ořez na 16:9 jako object-fit: cover a jen rozumný JPEG', () => {
  // na výšku -> prostředek, širší než 16:9 -> boky pryč, přesně 16:9 -> celé
  assert.deepEqual(coverRect(1080, 1920, 1280, 720), { sx: 0, sy: (1920 - 607.5) / 2, sw: 1080, sh: 607.5 });
  const wide = coverRect(2560, 1080, 1280, 720);
  assert.equal(Math.round(wide.sw), 1920);
  assert.equal(Math.round(wide.sx), 320);
  assert.deepEqual(coverRect(1920, 1080, 1280, 720), { sx: 0, sy: 0, sw: 1920, sh: 1080 });
  assert.deepEqual(coverRect(0, 0, 1280, 720), { sx: 0, sy: 0, sw: 0, sh: 0 });
  assert.equal(looksLikeLiveThumbnail(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])), true);
  assert.equal(looksLikeLiveThumbnail(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), false);
  assert.equal(looksLikeLiveThumbnail(new Uint8Array()), false);
  const big = new Uint8Array(LIVE_THUMBNAIL_MAX_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  assert.equal(looksLikeLiveThumbnail(big), false);
});
