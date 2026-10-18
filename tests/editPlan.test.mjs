import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlan, gifArgs, parseProbe, progressPercent, verticalCropFilter, GIF_MAX_SECONDS, trimArgs, normalizeSpeed, atempoChain, shiftMarkers, textOverlayPosition, SPEEDS, normalizeOverlays, overlayFilter, overlayInputArgs, overlayPixelWidth, OVERLAY_MAX } from '../dist/esm/editPlan.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // Stopy mají jména (title i handler_name - podle něj je jmenuje přehrávač v appce).
  const named = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, micList: 'm.txt', separateTracks: true, container: 'mp4', output: 'o.mp4', durationSeconds: 10 });
  for (const [i, name] of ['Game + mic', 'Game', 'Mic'].entries()) {
    assert.ok(named.join('\u0001').includes(`-metadata:s:a:${i}\u0001handler_name=${name}`), name);
  }
  assert.deepEqual(clipAudioTracks(true, true, false), ['mix']);
  assert.deepEqual(clipAudioTracks(false, false, true), []);
});

test('slepení klipu: zvuk hry přímo z Windows (pomocník) je pozadu - posune se dopředu, mikrofon ne', () => {
  // Zpoždění pomocníka 70 ms, kalibrace hráče +40 ms -> hra o 30 ms dopředu (uříznout), mikrofon jen +40.
  const args = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, micList: 'm.txt', micOffsetMs: 0, audioOffsetMs: 40, systemLatencyMs: 70, separateTracks: true, container: 'mp4', output: 'o.mp4', durationSeconds: 10 });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:a\]aresample=[^,]*,atrim=start=0\.030,asetpts=PTS-STARTPTS,aformat=[^,]*,asplit=2/);
  assert.match(fc, /\[1:a\]aresample=[^,]*,adelay=delays=40:all=1,aformat=/);
  // WebM jen se zvukem hry: s posunem se zvuk nekopíruje (jinak by posun nešel udělat).
  const webm = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, systemLatencyMs: 70, container: 'webm', output: 'o.webm', durationSeconds: 10 });
  assert.ok(!webm.includes('copy') || webm.indexOf('-c:a') < 0 || webm[webm.indexOf('-c:a') + 1] !== 'copy');
  assert.match(webm[webm.indexOf('-filter_complex') + 1], /atrim=start=0\.070/);
  // Bez pomocníka beze změny (WebM se zvukem hry se kopíruje).
  const plain = clipMuxArgs({ videoList: 'v.txt', hasSystemAudio: true, container: 'webm', output: 'o.webm', durationSeconds: 10 });
  assert.equal(plain[plain.indexOf('-c:a') + 1], 'copy');
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

test('rychlost: jen povolené hodnoty, atempo pro zvuk', () => {
  assert.deepEqual([...SPEEDS], [0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.equal(normalizeSpeed(2), 2);
  assert.equal(normalizeSpeed('0.5'), 0.5);
  assert.equal(normalizeSpeed(1.9), 2);
  assert.equal(normalizeSpeed(10), 2);
  assert.equal(normalizeSpeed(0.1), 0.5);
  assert.equal(normalizeSpeed(-1), 1);
  assert.equal(normalizeSpeed('abc'), 1);
  assert.equal(atempoChain(1), null);
  assert.equal(atempoChain(2), 'atempo=2');
  assert.equal(atempoChain(0.75), 'atempo=0.75');
  assert.equal(atempoChain(0.25), 'atempo=0.5,atempo=0.5');
});

test('zkrácení: délka se omezuje už při čtení (-t před -i), obraz jen první stopa, zvuk všechny', () => {
  const plan = trimArgs('in.mp4', 'out.mp4', { start: 1, end: 4, mute: false, videoMbps: 20, webm: false, audioTracks: ['mix', 'game', 'mic'] });
  const a = plan.args;
  assert.equal(plan.outputSeconds, 3);
  assert.ok(a.indexOf('-t') < a.indexOf('-i'));
  assert.deepEqual(a.slice(0, 7), ['-y', '-ss', '1.000', '-t', '3.000', '-i', 'in.mp4']);
  assert.ok(!a.includes('-vf') && !a.includes('-filter_complex') && !a.includes('-af'));
  assert.ok(a.join(' ').includes('-map 0:v:0 -c:v libx264'));
  assert.ok(a.join(' ').includes('-map 0:a?'));
  assert.deepEqual(plan.tracks, ['mix', 'game', 'mic']);
  assert.equal(a[a.length - 1], 'out.mp4');
});

test('zkrácení s rychlostí: setpts + fps zdroje, atempo, výsledek kratší/delší', () => {
  const fast = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 6, mute: false, videoMbps: 20, webm: false, speed: 2, sourceFps: 59.94 });
  assert.equal(fast.outputSeconds, 3);
  const vf = fast.args[fast.args.indexOf('-vf') + 1];
  assert.equal(vf, 'setpts=(PTS-STARTPTS)/2,fps=60');
  assert.equal(fast.args[fast.args.indexOf('-af') + 1], 'atempo=2');
  const slow = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: false, videoMbps: 20, webm: false, speed: 0.5 });
  assert.equal(slow.outputSeconds, 4);
  assert.equal(slow.args[slow.args.indexOf('-vf') + 1], 'setpts=(PTS-STARTPTS)/0.5,fps=60');
  // Bez zvuku žádné atempo.
  const muted = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: true, videoMbps: 20, webm: false, speed: 2 });
  assert.ok(muted.args.includes('-an') && !muted.args.includes('-af'));
  // Výřez na výšku a rychlost jedním filtrem.
  const vert = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: false, videoMbps: 20, webm: false, speed: 1.5, sourceFps: 30, vertical: 'left' });
  assert.equal(vert.args[vert.args.indexOf('-vf') + 1], `${verticalCropFilter('left')},setpts=(PTS-STARTPTS)/1.5,fps=30`);
});

test('zkrácení s textem: PNG jako druhý vstup, overlay po výřezu a rychlosti, výstup [vout]', () => {
  const plan = trimArgs('in.mp4', 'out.webm', {
    start: 0,
    end: 2,
    mute: false,
    videoMbps: 8,
    webm: true,
    speed: 2,
    sourceFps: 60,
    vertical: 'blur',
    overlay: { file: 'text.png', position: 'top' },
  });
  const a = plan.args;
  assert.deepEqual(a.slice(5, 9), ['-i', 'in.mp4', '-i', 'text.png']);
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.startsWith('[0:v:0]split[bg][fg];'), fc);
  assert.ok(fc.includes("[bgb][fgs]overlay=x='(W-w)/2':y='(H-h)/2'[vc];[vc]setpts=(PTS-STARTPTS)/2,fps=60[vs];[vs][1:v]overlay=x='(W-w)/2':y='H*0.07'[vout]"), fc);
  assert.ok(a.join(' ').includes('-map [vout]'));
  assert.ok(!a.includes('-vf'));
  assert.ok(a.join(' ').includes('-c:v libvpx'));
  assert.ok(a.join(' ').includes('-af atempo=2 -c:a libopus'));
  // Jen text: přímo [0:v:0] -> overlay.
  const onlyText = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 2, mute: false, videoMbps: 8, webm: false, overlay: { file: 't.png', position: 'bottom' } });
  assert.equal(onlyText.args[onlyText.args.indexOf('-filter_complex') + 1], "[0:v:0][1:v]overlay=x='(W-w)/2':y='H-h-H*0.08'[vout]");
  assert.equal(textOverlayPosition('center'), "x='(W-w)/2':y='(H-h)/2'");
});

test('momenty po zkrácení: jen uvnitř výběru, posunuté a přepočtené rychlostí', () => {
  const markers = [
    { time: 5, label: 'a' },
    { time: 12, label: 'b' },
    { time: 30, label: 'c' },
  ];
  assert.deepEqual(shiftMarkers(markers, 10, 20), [{ time: 2, label: 'b' }]);
  assert.deepEqual(shiftMarkers(markers, 0, 40, 2), [
    { time: 2.5, label: 'a' },
    { time: 6, label: 'b' },
    { time: 15, label: 'c' },
  ]);
  assert.equal(shiftMarkers(markers, 13, 20), undefined);
  assert.equal(shiftMarkers(undefined, 0, 10), undefined);
});

// ---- překryvy: text / obrázek / GIF kdekoli v obraze (kolo 0116) ----------------------------

test('překryvy: očištění z okna (zlomky 0-1, šířka aspoň 2 %, časy, nejvýš 8, jen se souborem)', () => {
  const items = normalizeOverlays([
    { kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.3 },
    { kind: 'gif', file: 'b.gif', cx: 1.7, cy: -2, w: 0, from: 1.5, to: 4 },
    { kind: 'image', file: 'c.png', cx: 'x', cy: 0.2, w: 0.5, from: 5, to: 2 },
    { kind: 'image', file: '', cx: 0.5, cy: 0.5, w: 0.3 },
    { kind: 'image', cx: 0.5, cy: 0.5, w: 0.3 },
    null,
    'nesmysl',
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.3, from: null, to: null });
  assert.deepEqual(items[1], { kind: 'gif', file: 'b.gif', cx: 1, cy: 0, w: 0.02, from: 1.5, to: 4 });
  assert.equal(items[2].cx, 0.5, 'nesmyslný střed = doprostřed');
  assert.equal(items[2].to, null, '"do" před "od" se zahodí');
  assert.equal(normalizeOverlays(Array.from({ length: 12 }, (_, i) => ({ kind: 'image', file: `${i}.png`, cx: 0.5, cy: 0.5, w: 0.2 }))).length, OVERLAY_MAX);
  assert.deepEqual(normalizeOverlays('x'), []);
});

test('překryvy: vstup ffmpeg (obrázek ve smyčce, GIF ve smyčce), šířka v px sudá', () => {
  assert.deepEqual(overlayInputArgs({ kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.3 }), ['-loop', '1', '-i', 'a.png']);
  assert.deepEqual(overlayInputArgs({ kind: 'gif', file: 'b.gif', cx: 0.5, cy: 0.5, w: 0.3 }), ['-stream_loop', '-1', '-i', 'b.gif']);
  assert.equal(overlayPixelWidth({ kind: 'image', file: 'a', cx: 0.5, cy: 0.5, w: 0.25 }, 1920), 480);
  assert.equal(overlayPixelWidth({ kind: 'image', file: 'a', cx: 0.5, cy: 0.5, w: 0.3333 }, 1280), 426, 'sudé');
  assert.equal(overlayPixelWidth({ kind: 'image', file: 'a', cx: 0.5, cy: 0.5, w: 0.0001 }, 1280), 2, 'aspoň 2');
});

test('překryvy: filtr = zmenšit a položit středem, časové okno přes enable, shortest', () => {
  const f = overlayFilter({ kind: 'image', file: 'a.png', cx: 0.25, cy: 0.75, w: 0.5, from: 1, to: 3.5 }, 1, '[0:v:0]', '[vout]', 'o0', 1920);
  assert.equal(f, "[1:v]format=rgba,scale=w=960:h=-2[o0s];[0:v:0][o0s]overlay=x='W*0.2500-w/2':y='H*0.7500-h/2':shortest=1:format=auto:enable='between(t,1.000,3.500)'[vout]");
  assert.match(overlayFilter({ kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.5, from: 2 }, 1, '[a]', '[b]', 'o1', 1000), /enable='gte\(t,2\.000\)'/);
  assert.match(overlayFilter({ kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.5, to: 2 }, 1, '[a]', '[b]', 'o1', 1000), /enable='lte\(t,2\.000\)'/);
  assert.doesNotMatch(overlayFilter({ kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.5 }, 1, '[a]', '[b]', 'o1', 1000), /enable/);
});

test('zkrácení s překryvy: každý další vstup, řetěz výřez -> rychlost -> text -> překryvy -> [vout], výstup useknutý na délku', () => {
  const overlays = normalizeOverlays([
    { kind: 'image', file: 'logo.png', cx: 0.9, cy: 0.1, w: 0.2 },
    { kind: 'gif', file: 'wow.gif', cx: 0.5, cy: 0.5, w: 0.4, from: 1, to: 2 },
  ]);
  const plan = trimArgs('in.mp4', 'out.mp4', { start: 2, end: 6, mute: false, videoMbps: 20, speed: 2, sourceFps: 60, vertical: 'center', overlay: { file: 'text.png', position: 'top' }, overlays, sourceWidth: 1920, sourceHeight: 1080, webm: false });
  const a = plan.args;
  // Vstupy: video, text PNG, logo (loop), gif (stream_loop).
  assert.deepEqual(a.slice(a.indexOf('-i'), a.indexOf('-progress')), ['-i', 'in.mp4', '-i', 'text.png', '-loop', '1', '-i', 'logo.png', '-stream_loop', '-1', '-i', 'wow.gif']);
  const fc = a[a.indexOf('-filter_complex') + 1];
  const chains = fc.split(';');
  assert.match(chains[0], /^\[0:v:0\]crop=.*\[vc\]$/);
  assert.match(chains[1], /^\[vc\]setpts=.*fps=60\[vs\]$/);
  assert.match(chains[2], /^\[vs\]\[1:v\]overlay=.*\[vt\]$/, 'text po rychlosti');
  // Na výšku z 1920x1080 = 606 px široký výsledek (sudé); logo 20 % = 122 px, gif 40 % = 242 px.
  assert.match(chains[3], /^\[2:v\]format=rgba,scale=w=122:h=-2\[o0s\]$/);
  assert.match(chains[4], /^\[vt\]\[o0s\]overlay=.*\[vo0\]$/);
  assert.match(chains[5], /^\[3:v\]format=rgba,scale=w=242:h=-2\[o1s\]$/);
  assert.match(chains[6], /^\[vo0\]\[o1s\]overlay=.*enable='between\(t,1\.000,2\.000\)'\[vout\]$/);
  assert.equal(a[a.indexOf('-map') + 1], '[vout]');
  assert.equal(plan.outputSeconds, 2);
  // Nekonečné vstupy (smyčky): výstup se usekne na délku výsledku.
  assert.equal(a[a.lastIndexOf('-t') + 1], '2.050');
  assert.equal(a[a.length - 1], 'out.mp4');
  // Bez překryvů žádné useknutí navíc a jednoduchý filtr.
  const plain = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 4, mute: true, videoMbps: 20, webm: false });
  assert.equal(plain.args.filter((x) => x === '-t').length, 1);
  assert.ok(!plain.args.includes('-filter_complex'));
});

// Opravdový ffmpeg: překryvy musí projít filtergrafem (ne jen vypadat správně). Krátké video + PNG + GIF.
const FFMPEG = join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
test('překryvy doopravdy: ffmpeg položí text, obrázek i GIF na video (výsledek má správnou délku)', { skip: !existsSync(FFMPEG) && 'ffmpeg-static chybí' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-ov-'));
  const video = join(dir, 'in.mp4');
  const png = join(dir, 'logo.png');
  const gif = join(dir, 'anim.gif');
  const text = join(dir, 'text.png');
  const out = join(dir, 'out.mp4');
  const run = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', timeout: 120000 });
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  run(['-f', 'lavfi', '-i', 'color=c=red@0.8:size=120x60:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'rgba', png]);
  run(['-f', 'lavfi', '-i', 'color=c=0x4488ff:size=80x80:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'rgba', text]);
  run(['-f', 'lavfi', '-i', 'testsrc=size=100x50:rate=5:duration=1', '-loop', '0', gif]);
  const overlays = normalizeOverlays([
    { kind: 'image', file: png, cx: 0.85, cy: 0.12, w: 0.2 },
    { kind: 'gif', file: gif, cx: 0.5, cy: 0.5, w: 0.3, from: 0.5, to: 1.5 },
    { kind: 'image', file: text, cx: 0.5, cy: 0.9, w: 0.1 },
  ]);
  const plan = trimArgs(video, out, { start: 0.5, end: 2.5, mute: false, videoMbps: 20, speed: 1, overlays, sourceWidth: 640, sourceHeight: 360, webm: false });
  const args = plan.args.filter((x, i, arr) => !(x === '-progress' || arr[i - 1] === '-progress' || x === '-nostats'));
  run(args.filter((x) => x !== '-y'));
  assert.ok(existsSync(out) && statSync(out).size > 1000, 'výsledek existuje');
  const header = (() => {
    try {
      execFileSync(FFMPEG, ['-hide_banner', '-i', out], { stdio: 'pipe' });
    } catch (e) {
      return String(e.stderr ?? '');
    }
    return '';
  })();
  const info = parseProbe(header);
  assert.ok(info.durationSeconds !== null && Math.abs(info.durationSeconds - 2) < 0.3, `délka 2 s (je ${info.durationSeconds})`);
  assert.equal(info.width, 640);
  assert.equal(info.hasAudio, true, 'zvuk zůstal');
});

// ---- kamera zvlášť (Clip.camera) zapečená do obrazu -----------------------------------------
import { cameraChain, cameraOverlayFilter, cameraBakeRect, roundedAlphaExpr } from '../dist/esm/editPlan.js';

test('kamera zvlášť: čas (offset, začátek výběru, rychlost), zrcadlo, výřez pro kruh, maska jen u kruhu / zaoblení', () => {
  const cam = { file: 'cam.webm', offsetMs: 1000, x: 0.7, y: 0.6, w: 0.25, shape: 'circle', mirror: true, width: 1280, height: 720 };
  const c = cameraChain(cam, 2, '[cam]', 1920, 1080, 0, 1);
  assert.match(c.filter, /^\[2:v\]setpts=\(PTS-STARTPTS\+1\.000\/TB\)\/1,hflip,crop=720:720:280:0,scale=\d+:\d+,format=rgba\[camraw\];/);
  assert.match(c.filter, /color=c=black:s=\d+x\d+:r=1:d=1,format=gray,geq=lum='255\*clip\(.*\)',loop=loop=-1:size=1:start=0\[cammask\];\[camraw\]\[cammask\]alphamerge\[cam\]$/);
  assert.equal(c.rect.w, c.rect.h, 'kruh je čtverec');
  assert.equal(c.rect.w, Math.round(1920 * 0.25));
  // Záporný posun (kamera začala před obrazem) + výběr od 2 s + dvojnásobná rychlost: trim a dělení rychlostí.
  const later = cameraChain({ ...cam, offsetMs: -500, shape: 'rect', mirror: false }, 1, '[cam]', 1280, 720, 2, 2);
  assert.match(later.filter, /^\[1:v\]trim=start=2\.500,setpts=\(PTS-STARTPTS\)\/2,scale=\d+:\d+,format=rgba\[cam\]$/);
  assert.ok(!later.filter.includes('hflip') && !later.filter.includes('crop=') && !later.filter.includes('geq'), 'obdélník bez zrcadla: žádný výřez ani maska');
  // Položení: před začátkem a po konci kamery jde obraz dál (eof_action=pass).
  const ov = cameraOverlayFilter('[v]', '[cam]', '[vout]', later.rect);
  assert.equal(ov, `[v][cam]overlay=x=${later.rect.x}:y=${later.rect.y}:eof_action=pass:format=auto[vout]`);
  // Zaoblení: maska je, poloměr menší než polovina.
  const rounded = cameraChain({ ...cam, shape: 'rounded', mirror: false }, 1, '[cam]', 1920, 1080, 0, 1);
  assert.ok(rounded.filter.includes('alphamerge') && rounded.rect.radius > 0 && rounded.rect.radius < rounded.rect.w / 2);
  // Výraz průhlednosti: uvnitř 255, mimo roh 0 (hodnoty se nepočítají tady, jen tvar výrazu bez čárek navíc mimo závorky).
  const expr = roundedAlphaExpr(100, 60, 10);
  assert.ok(expr.startsWith('255*clip(10.50-hypot(') && expr.endsWith(',0,1)'));
  // Poloha podle shared/liveLayout: stejná jako v přehrávači.
  const r = cameraBakeRect({ ...cam, x: 0.02, y: 0.02, shape: 'rect', mirror: false }, 1280, 720);
  assert.equal(r.x, Math.round(1280 * 0.02));
  assert.equal(r.y, Math.round(720 * 0.02));
});

test('kamera zvlášť v trimArgs: vstup navíc, kamera navrch nad překryvy, výstup useknutý na délku', () => {
  const camera = { file: 'cam.webm', offsetMs: 0, x: 0.7, y: 0.6, w: 0.25, shape: 'rect', mirror: false, width: 1280, height: 720 };
  const plan = trimArgs('in.mp4', 'out.mp4', { start: 1, end: 5, mute: false, videoMbps: 8, speed: 1, sourceWidth: 1920, sourceHeight: 1080, overlays: [{ kind: 'image', file: 'a.png', cx: 0.5, cy: 0.5, w: 0.2 }], camera, webm: false });
  const a = plan.args;
  assert.equal(a[a.indexOf('-i') + 1], 'in.mp4');
  assert.ok(a.includes('cam.webm'), 'kamera je vstup');
  const fc = a[a.indexOf('-filter_complex') + 1];
  assert.ok(fc.lastIndexOf('overlay=x=') > fc.indexOf("overlay=x='W*") && fc.indexOf("overlay=x='W*") >= 0, 'kamera se pokládá až po překryvech (navrch)');
  assert.ok(fc.includes('[2:v]trim=start=1.000') || fc.includes('[2:v]setpts='), 'kamera je vstup č. 2 (po obrázku) posunutá o začátek výběru');
  assert.ok(fc.endsWith('[vout]'));
  assert.equal(a[a.lastIndexOf('-t') + 1], (4 + 0.05).toFixed(3), 'výstup useknutý na délku (maska kamery je nekonečná)');
  // Bez kamery a překryvů se nic nemění (žádný filter_complex).
  const plain = trimArgs('in.mp4', 'out.mp4', { start: 1, end: 5, mute: false, videoMbps: 8, webm: false });
  assert.ok(!plain.args.includes('-filter_complex'));
});

test('kamera zvlášť doopravdy: ffmpeg zapeče kameru (kruh, zrcadlo, posun) a výsledek má délku výběru', { skip: !existsSync(FFMPEG) && 'ffmpeg-static chybí' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kine-cam-'));
  const run = (args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe', timeout: 120000 });
  const main = join(dir, 'main.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', main]);
  const cam = join(dir, 'cam.webm');
  run(['-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=30:duration=3', '-c:v', 'libvpx', '-b:v', '500k', '-deadline', 'realtime', '-cpu-used', '8', cam]);
  const out = join(dir, 'out.mp4');
  const camera = { file: cam, offsetMs: 500, x: 0.6, y: 0.5, w: 0.3, shape: 'circle', mirror: true, width: 320, height: 240 };
  const plan = trimArgs(main, out, { start: 0.5, end: 2.5, mute: false, videoMbps: 8, audio: 'mix', audioTracks: ['mix'], speed: 1, sourceWidth: 640, sourceHeight: 360, camera, webm: false });
  execFileSync(FFMPEG, ['-hide_banner', ...plan.args.filter((x, i, arr) => !(x === '-progress' || arr[i - 1] === '-progress' || x === '-nostats'))], { stdio: 'pipe', timeout: 120000 });
  assert.ok(statSync(out).size > 1000);
  let info = '';
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', out], { stdio: 'pipe' });
  } catch (e) {
    info = e.stderr.toString();
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const seconds = m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
  assert.ok(Math.abs(seconds - 2) < 0.2, `délka ${seconds} s`);
  assert.ok(/, 640x360/.test(info), 'rozměr obrazu zůstal');
  assert.ok(/Audio:/.test(info), 'zvuk zůstal');
  // Snímek v čase 1,5 s: uprostřed kruhu (x 0,6+0,15 šířky; y 0,5 + …) jsou pruhy SMPTE (ne testsrc) - jas ve středu kruhu se liší od obrazu bez kamery.
  const frameWith = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '1.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: 'pipe' });
  const frameWithout = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', '2.0', '-i', main, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: 'pipe' });
  const r = cameraBakeRect(camera, 640, 360);
  const px = (buf, x, y) => [buf[(y * 640 + x) * 3], buf[(y * 640 + x) * 3 + 1], buf[(y * 640 + x) * 3 + 2]];
  const center = [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)];
  const d = px(frameWith, ...center).map((v, i) => Math.abs(v - px(frameWithout, ...center)[i])).reduce((a, b) => a + b, 0);
  assert.ok(d > 30, `střed kruhu se liší od obrazu bez kamery (rozdíl ${d})`);
  // Roh rámečku kamery (mimo kruh) je pořád původní obraz.
  const corner = [Math.round(r.x + 2), Math.round(r.y + 2)];
  const dc = px(frameWith, ...corner).map((v, i) => Math.abs(v - px(frameWithout, ...corner)[i])).reduce((a, b) => a + b, 0);
  assert.ok(dc < 60, `roh mimo kruh je původní obraz (rozdíl ${dc})`);
});

test('kopie k nahrání: jen první zvuková stopa (firstAudioOnly), bez zvuku má přednost', () => {
  const camera = { file: 'cam.webm', offsetMs: 0, x: 0.7, y: 0.6, w: 0.25, shape: 'rect', mirror: false, width: 1280, height: 720 };
  const plan = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 10, mute: false, videoMbps: 8, audio: 'mix', audioTracks: ['mix', 'game', 'mic'], camera, firstAudioOnly: true, webm: false });
  const a = plan.args;
  assert.equal(a[a.indexOf('-map', a.indexOf('-map') + 1) + 1], '0:a:0?', 'jen první stopa');
  assert.deepEqual(plan.tracks, ['mix']);
  const all = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 10, mute: false, videoMbps: 8, audio: 'mix', audioTracks: ['mix', 'game', 'mic'], webm: false });
  assert.ok(all.args.includes('0:a?'), 'v úpravách "všechny stopy" zůstává');
  const muted = trimArgs('in.mp4', 'out.mp4', { start: 0, end: 10, mute: true, videoMbps: 8, audioTracks: ['mix', 'game'], firstAudioOnly: true, webm: false });
  assert.ok(muted.args.includes('-an'));
});
