import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlan, gifArgs, parseProbe, progressPercent, verticalCropFilter, GIF_MAX_SECONDS } from '../dist/esm/editPlan.js';

const HEADER = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:07.33, start: 0.000000, bitrate: 36 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x800 [SAR 1:1 DAR 8:5], 30 kb/s, 60 fps, 60 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6D6961), 48000 Hz, stereo, fltp, 2 kb/s (default)
At least one output file must be specified`;

test('hlavička ffmpeg: délka, rozměry, fps, zvuk', () => {
  const info = parseProbe(HEADER);
  assert.equal(info.durationSeconds, 7.33);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 800);
  assert.equal(info.fps, 60);
  assert.equal(info.hasAudio, true);
  const silent = parseProbe(HEADER.split('\n').filter((l) => !l.includes('Audio:')).join('\n'));
  assert.equal(silent.hasAudio, false);
  assert.equal(parseProbe('nic').durationSeconds, null);
});

test('sestřih: společný rozměr, ticho místo chybějícího zvuku, concat', () => {
  const plan = mergePlan(
    [
      { file: 'a.mp4', width: 1280, height: 800, hasAudio: true, fps: 60, durationSeconds: 7.3 },
      { file: 'b.mp4', width: 450, height: 800, hasAudio: false, fps: 30, durationSeconds: 2 },
    ],
    'out.mp4'
  );
  assert.equal(plan.width, 1280);
  assert.equal(plan.height, 800);
  assert.equal(plan.fps, 60, 'nejvyšší fps ze vstupů');
  assert.equal(plan.totalSeconds, 9.3);
  const filter = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(filter, /\[0:v:0\]scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800/);
  assert.match(filter, /\[1:v:0\]scale=1280:800/);
  assert.match(filter, /\[0:a:0\]aresample=48000/);
  assert.match(filter, /aevalsrc=0:s=48000:c=stereo:d=2\.000\[a1\]/, 'klip bez zvuku dostane ticho stejné délky');
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[v\]\[a\]$/);
  assert.equal(plan.args.filter((a) => a === '-i').length, 2);
  assert.equal(plan.args[plan.args.length - 1], 'out.mp4');
  assert.ok(plan.args.includes('libx264'));
  assert.throws(() => mergePlan([{ file: 'a.mp4', width: 1, height: 1, hasAudio: true, fps: 30, durationSeconds: 1 }], 'x'), /too-few/);
  // Liché rozměry se zarovnají na sudé (yuv420p je potřebuje).
  const odd = mergePlan(
    [
      { file: 'a', width: 1279, height: 799, hasAudio: true, fps: null, durationSeconds: 1 },
      { file: 'b', width: null, height: null, hasAudio: true, fps: null, durationSeconds: 1 },
    ],
    'o'
  );
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.equal(odd.fps, 30);
});

test('GIF: úsek se ořeže na nejvyšší délku, paleta + dithering, bez zvuku', () => {
  const { args, lengthSeconds } = gifArgs('in.mp4', 'out.gif', { start: 1, end: 40, width: 480, fps: 15 });
  assert.equal(lengthSeconds, GIF_MAX_SECONDS);
  assert.equal(args[args.indexOf('-ss') + 1], '1.000');
  assert.equal(args[args.indexOf('-t') + 1], GIF_MAX_SECONDS.toFixed(3));
  assert.ok(args.includes('-an'));
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /^fps=15,scale=480:-2/);
  assert.match(vf, /palettegen/);
  assert.match(vf, /paletteuse/);
  assert.equal(args[args.length - 1], 'out.gif');
  assert.equal(gifArgs('i', 'o', { start: 0, end: 3.5, width: 480, fps: 15 }).lengthSeconds, 3.5);
});

test('průběh z -progress pipe:1', () => {
  assert.equal(progressPercent('out_time_us=4650000', 9.3), 50);
  assert.equal(progressPercent('out_time_ms=9300000', 9.3), 99, 'nikdy 100 před koncem');
  assert.equal(progressPercent('frame=12', 9.3), null);
  assert.equal(progressPercent('out_time_us=1', 0), null);
});

test('na výšku 9:16: výřez vlevo/střed/vpravo, rozmazané pozadí jako jeden filtergraph', () => {
  assert.equal(verticalCropFilter(null), null);
  assert.equal(verticalCropFilter(undefined), null);
  assert.match(verticalCropFilter('left'), /^crop=w='trunc\(min\(iw,ih\*9\/16\)\/2\)\*2':h=ih:x='\(iw-ow\)\*0':y=0$/);
  assert.match(verticalCropFilter('center'), /\*0\.5':y=0$/);
  assert.match(verticalCropFilter('right'), /\*1':y=0$/);
  const blur = verticalCropFilter('blur');
  // Jeden vstup (split), dvě větve, jeden výstup (overlay) - jde do -vf.
  assert.ok(blur.startsWith('split[bg][fg];'));
  assert.match(blur, /\[bg\]crop=.*boxblur.*\[bgb\]/);
  assert.match(blur, /\[fg\]scale=.*:h=-2\[fgs\]/);
  assert.match(blur, /\[bgb\]\[fgs\]overlay=x='\(W-w\)\/2':y='\(H-h\)\/2'$/);
  assert.equal((blur.match(/;/g) || []).length, 3);
});

import { clipMuxArgs, clipAudioTracks } from '../dist/esm/editPlan.js';

const mapsOf = (args) => {
  const maps = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-map') maps.push(args[i + 1]);
  return maps;
};

test('slepení klipu: jen obraz + zvuk hry', () => {
  const args = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, container: 'mp4', output: 'out.mp4', durationSeconds: 30 });
  assert.deepEqual(args.slice(0, 10), ['-loglevel', 'error', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', 'v.txt']);
  // mp4: zvuk hry přes srovnání podle časů (mezery/překryvy mezi kousky) a do AAC.
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.equal(fc, '[0:a]aresample=async=1:min_hard_comp=0.010:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[g1]');
  assert.deepEqual(mapsOf(args), ['0:v:0', '[g1]']);
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 6), ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']);
  assert.equal(args[args.length - 1], 'out.mp4');
  assert.ok(args.includes('+faststart'));
  assert.equal(args[args.indexOf('-t') + 1], '30.050');
  // WebM bez úprav: zvuk se jen kopíruje, žádný filtr.
  const webm = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, container: 'webm', output: 'out.webm', durationSeconds: 30 });
  assert.ok(!webm.includes('-filter_complex'));
  assert.deepEqual(mapsOf(webm), ['0:v:0', '0:a:0']);
  assert.deepEqual(webm.slice(webm.indexOf('-c:a'), webm.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  // Bez zvuku vůbec: žádné -c:a.
  const silent = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: false, container: 'mp4', output: 'o.mp4', durationSeconds: 5 });
  assert.ok(!silent.includes('-c:a'));
  assert.deepEqual(mapsOf(silent), ['0:v:0']);
});

test('slepení klipu: hra + mikrofon = tři stopy (mix, hra, mikrofon) s hlasitostmi, posunem a limiterem', () => {
  const args = clipMuxArgs({
    videoList: 'v.txt',
    hasSystemAudio: true,
    micList: 'm.txt',
    micOffsetMs: -1250,
    systemGain: 0.8,
    micGain: 1.5,
    audioOffsetMs: 40,
    separateTracks: true,
    container: 'mp4',
    output: 'out.mp4',
    durationSeconds: 30,
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args.filter((a) => a === '-i').length, 2);
  assert.match(fc, /\[0:a\]aresample=async=1:min_hard_comp=0\.010:first_pts=0,volume=0\.80,adelay=delays=40:all=1,aformat=[^,]*,asplit=2\[g1\]\[g2\]/);
  // Mikrofon: -1250 + 40 = -1210 ms -> uříznout 1.210 s.
  assert.match(fc, /\[1:a\]aresample=[^,]*,volume=1\.50,atrim=start=1\.210,asetpts=PTS-STARTPTS,aformat=[^,]*,asplit=2\[m1\]\[m2\]/);
  assert.match(fc, /\[g1\]\[m1\]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0\.97[^\[]*\[mix\]/);
  assert.deepEqual(mapsOf(args), ['0:v:0', '[mix]', '[g2]', '[m2]']);
  assert.ok(args.includes('title=Game + mic') && args.includes('title=Game') && args.includes('title=Mic'));
  assert.deepEqual(args.slice(args.indexOf('-disposition:a:0'), args.indexOf('-disposition:a:0') + 2), ['-disposition:a:0', 'default']);
  // Bez samostatných stop: jen mix; WebM zvuk v Opusu.
  const one = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, micList: 'm.txt', separateTracks: false, container: 'webm', output: 'o.webm', durationSeconds: 10 });
  assert.deepEqual(mapsOf(one), ['0:v:0', '[mix]']);
  assert.ok(one.includes('libopus'));
  assert.ok(!one.some((a) => /asplit/.test(a)));
  // Jen mikrofon (zvuk hry vypnutý).
  const micOnly = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: false, micList: 'm.txt', micOffsetMs: 300, container: 'mp4', output: 'o.mp4', durationSeconds: 10 });
  assert.match(micOnly[micOnly.indexOf('-filter_complex') + 1], /^\[1:a\]aresample=[^,]*,adelay=delays=300:all=1,aformat=[^,]*\[m1\]$/);
  assert.deepEqual(mapsOf(micOnly), ['0:v:0', '[m1]']);
  assert.deepEqual(clipAudioTracks(true, true, true), ['mix', 'game', 'mic']);
  assert.deepEqual(clipAudioTracks(true, true, false), ['mix']);
  assert.deepEqual(clipAudioTracks(false, false, true), []);
});

import { trimAudioPlan } from '../dist/esm/editPlan.js';

test('úprava klipu: zvuk všechno / jen hra / jen mikrofon / nic podle stop zdroje', () => {
  const layout = ['mix', 'game', 'mic'];
  assert.deepEqual(trimAudioPlan(layout, 'mix'), { maps: ['-map', '0:a?'], tracks: layout });
  assert.deepEqual(trimAudioPlan(layout, 'game'), { maps: ['-map', '0:a:1'], tracks: ['game'] });
  assert.deepEqual(trimAudioPlan(layout, 'mic'), { maps: ['-map', '0:a:2'], tracks: ['mic'] });
  assert.deepEqual(trimAudioPlan(layout, 'none'), { maps: [], tracks: [] });
  // Starší klip (stopy neznámé): všechno jako dřív; "jen mikrofon" u klipu bez mikrofonu = první stopa.
  assert.deepEqual(trimAudioPlan(undefined, 'mic'), { maps: ['-map', '0:a?'], tracks: null });
  assert.deepEqual(trimAudioPlan(['game'], 'mic'), { maps: ['-map', '0:a:0?'], tracks: ['game'] });
});
