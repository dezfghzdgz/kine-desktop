import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSegmentCsv, toSegment, selectForClip, totalSeconds, expired, concatList , sameResolutionTailStart } from '../dist/esm/segments.js';

const join = (a, b) => `${a}/${b}`;

test('CSV od ffmpeg se přečte i s neúplným posledním řádkem', () => {
  const rows = parseSegmentCsv('00000.mkv,0.000000,2.000000\n00001.mkv,2.000000,4.033000\n00002.mkv,4.033');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { file: '00001.mkv', start: 2, end: 4.033 });
});

test('kousky pro klip: okno sahá zpět, první kousek může začínat dřív', () => {
  const genStart = 1_000_000;
  const rows = [0, 2, 4, 6, 8].map((s) => ({ file: `${s}.mkv`, start: s, end: s + 2 }));
  const segments = rows.map((r) => toSegment(r, 1, genStart, '/buf', join));
  // Konec v 9,5 s, chceme 5 s zpět => okno 4,5-9,5 => kousky 4-6, 6-8, 8-10
  const chosen = selectForClip(segments, genStart + 9500, 5);
  assert.deepEqual(chosen.map((s) => s.file), ['/buf/4.mkv', '/buf/6.mkv', '/buf/8.mkv']);
  assert.equal(totalSeconds(chosen), 6);
});

test('kousky ze dvou generací se řadí podle hodin počítače', () => {
  const a = toSegment({ file: 'a.mkv', start: 0, end: 2 }, 1, 5000, '/g1', join);
  const b = toSegment({ file: 'b.mkv', start: 0, end: 2 }, 2, 7100, '/g2', join);
  const chosen = selectForClip([b, a], 9000, 10);
  assert.deepEqual(chosen.map((s) => s.file), ['/g1/a.mkv', '/g2/b.mkv']);
});

test('okno mimo data nevybere nic', () => {
  const a = toSegment({ file: 'a.mkv', start: 0, end: 2 }, 1, 0, '/g', join);
  assert.deepEqual(selectForClip([a], 10000, 3), []);
});

test('staré kousky se poznají podle konce', () => {
  const segs = [0, 2, 4].map((s) => toSegment({ file: `${s}.mkv`, start: s, end: s + 2 }, 1, 0, '/g', join));
  // teď = 20 s, držet 15 s => hranice 5 s => kousky končící před 5 s (0-2, 2-4)
  assert.deepEqual(expired(segs, 20000, 15).map((s) => s.file), ['/g/0.mkv', '/g/2.mkv']);
});

test('seznam pro concat escapuje apostrof', () => {
  assert.equal(concatList(["/a/b'c.mkv"]), "file '/a/b'\\''c.mkv'\n");
});

test('klip jen ze souvislého konce se stejnými rozměry', () => {
  assert.equal(sameResolutionTailStart(['1920x1080', '1920x1080', '1920x1080']), 0);
  assert.equal(sameResolutionTailStart(['1920x1080', '1280x960', '1280x960']), 1, 'hra přepnula na 4:3 - starší kousky pryč');
  assert.equal(sameResolutionTailStart(['1280x960', null, '1280x960']), 0, 'neznámé rozměry sedí');
  assert.equal(sameResolutionTailStart(['1920x1080', '1280x960', null]), 0, 'poslední neznámý - nic se nezahazuje');
  assert.equal(sameResolutionTailStart([]), 0);
});

// ---- 0.9.3: obraz + zvlášť nahraný mikrofon -------------------------------------------

import { planClip, concatScript } from '../dist/esm/segments.js';

const seg = (file, generation, startWall, endWall) => ({ file, generation, startWall, endWall });

test('plán klipu: mikrofon se umístí vůči obrazu stejné generace, mezera mezi generacemi se vypustí u obou', () => {
  // Generace 1: obraz 1000-3000, 3000-5000; generace 2 (po klipu, o 80 ms později): 5080-7080.
  const video = [seg('v1', 1, 1000, 3000), seg('v2', 1, 3000, 5000), seg('v3', 2, 5080, 7080)];
  // Mikrofon: jeho kousky jsou posunuté o 15 ms proti obrazu, generace 2 začíná v 5090.
  const mic = [seg('m0', 1, -985, 1015), seg('m1', 1, 1015, 3015), seg('m2', 1, 3015, 5000), seg('m3', 2, 5090, 7090), seg('x', 3, 9000, 11000)];
  const plan = planClip(video, mic, 0);
  assert.equal(plan.videoSeconds, 6);
  assert.deepEqual(plan.video.map((e) => e.duration), [2, 2, 2]);
  // První kousek mikrofonu začíná 1985 ms před obrazem -> uřízne se začátek.
  assert.equal(plan.micOffsetMs, -1985);
  assert.deepEqual(plan.mic.map((e) => e.file), ['m0', 'm1', 'm2', 'm3']);
  // m2 končí v 5000 (1985 ms), ale m3 patří až do klipu na 4000 + (5090-5080) = 4010 ms: místo pro m2 = 4010 - 2015 = 1995 ms -> mezera 10 ms.
  assert.equal(plan.mic[2].duration, 1.995);
  assert.equal(plan.mic[2].outpoint, undefined);
  // Kousek z generace, která v klipu není, se nebere.
  assert.ok(!plan.mic.some((e) => e.file === 'x'));
});

test('plán klipu: zpoždění mikrofonu ho posune dopředu, překryv se uřízne, bez mikrofonu null', () => {
  const video = [seg('v1', 1, 0, 2000)];
  const mic = [seg('m1', 1, 0, 1200), seg('m2', 1, 1100, 2100)];
  const plan = planClip(video, mic, 40);
  assert.equal(plan.micOffsetMs, -40);
  // m2 má začít o 1100 ms později než m1, ale m1 je 1200 ms dlouhý -> uříznout na 1.1 s.
  assert.deepEqual(plan.mic[0], { file: 'm1', duration: 1.1, outpoint: 1.1 });
  assert.equal(planClip(video, [], 0).mic, null);
  const script = concatScript(plan.mic);
  assert.match(script, /^ffconcat version 1\.0\nfile 'm1'\nduration 1\.100\noutpoint 1\.100\nfile 'm2'\nduration 1\.000\n$/);
  assert.equal(concatScript([{ file: "C:\\it's\\a.mkv", duration: 2 }]), "ffconcat version 1.0\nfile 'C:\\it'\\''s\\a.mkv'\nduration 2.000\n");
});

test('obnova po pádu: kousky od startu nahrávání, jen formát poslední generace, i s mikrofonem', async () => {
  const { recoverySegments } = await import('../dist/esm/segments.js');
  const seg = (gen, dir, start, end) => toSegment({ file: `${start}.mkv`, start, end }, gen, 100_000, dir, join);
  const gens = [
    // Zásobník před nahráváním (končí před startem nahrávky) - nepatří tam.
    { id: 1, startWall: 100_000, mimeType: 'video/webm;codecs=h264,opus', hasAudio: true, hasMic: true, micLatencyMs: 10, video: [seg(1, '/g1', 0, 2), seg(1, '/g1', 2, 4)], mic: [seg(1, '/g1', 0, 2)] },
    // Nahrávka: start v 104 000 ms, dvě generace (mezitím uložený klip).
    { id: 3, startWall: 110_000, mimeType: 'video/webm;codecs=h264,opus', hasAudio: true, hasMic: true, micLatencyMs: 10, video: [toSegment({ file: 'c.mkv', start: 0, end: 2 }, 3, 110_000, '/g3', join)], mic: [toSegment({ file: 'mc.mka', start: 0, end: 2 }, 3, 110_000, '/g3', join)] },
    { id: 2, startWall: 104_000, mimeType: 'video/webm;codecs=h264,opus', hasAudio: true, hasMic: false, micLatencyMs: 0, video: [toSegment({ file: 'a.mkv', start: 0, end: 2 }, 2, 104_000, '/g2', join), toSegment({ file: 'b.mkv', start: 2, end: 4.1 }, 2, 104_000, '/g2', join)], mic: [toSegment({ file: 'ignored.mka', start: 0, end: 2 }, 2, 104_000, '/g2', join)] },
  ];
  const r = recoverySegments(gens, 104_000);
  assert.deepEqual(r.video.map((s) => s.file), ['/g2/a.mkv', '/g2/b.mkv', '/g3/c.mkv']);
  // Mikrofon jen z generací, které ho měly (g2 hasMic=false -> jeho soubor se nebere).
  assert.deepEqual(r.mic.map((s) => s.file), ['/g3/mc.mka']);
  assert.deepEqual(r.gens.map((g) => g.id), [2, 3]);

  // Jiný formát v dřívější generaci (VP9 po H.264) se vynechá - slepit jde jen stejný.
  const mixed = recoverySegments([{ ...gens[2], mimeType: 'video/webm;codecs=vp9,opus' }, gens[1]], 104_000);
  assert.deepEqual(mixed.video.map((s) => s.file), ['/g3/c.mkv']);

  // Nic po startu nahrávání = nic k obnově.
  assert.deepEqual(recoverySegments([gens[0]], 104_000), { video: [], mic: [], gens: [] });
});
