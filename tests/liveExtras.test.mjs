/**
 * Živé vysílání 0137: klip z přenosu (lib/liveClip.ts), raid (lib/liveRaid.ts),
 * plánované vysílání (lib/liveSchedule.ts) a ankety v chatu (lib/livePolls.ts).
 *
 * Spustit:  node tests/liveExtras.test.mjs
 */

// Kalendářní dny se počítají v místním čase - test ať vyjde stejně v Praze i na serveru.
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prelozit } from './prelozit.mjs';

const kam = prelozit('lib/liveClip.ts', 'lib/liveRaid.ts', 'lib/liveSchedule.ts', 'lib/livePolls.ts');
const clip = await import(join(kam, 'liveClip.js'));
const raid = await import(join(kam, 'liveRaid.js'));
const plan = await import(join(kam, 'liveSchedule.js'));
const polls = await import(join(kam, 'livePolls.js'));

let prosly = 0;
let padly = 0;
function test(nazev, fn) {
  try {
    fn();
    console.log('OK    ' + nazev);
    prosly++;
  } catch (e) {
    console.log('CHYBA ' + nazev + '\n      ' + e.message);
    padly++;
  }
}

const UID = 'a'.repeat(32);
const NOW = Date.parse('2026-11-01T20:00:00Z');
const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();

// ---------------------------------------------------------------- klip
test('klip: s hlavičkou náhledu začíná tam, kde začíná posledních 30 s', () => {
  assert.deepEqual(clip.liveClipWindow({ previewStart: 1234.6, elapsed: 1270 }), { ok: true, time: 1234, duration: 30 });
  assert.deepEqual(clip.liveClipWindow({ previewStart: 600 }), { ok: true, time: 600, duration: 30 });
});

test('klip: krátké vysílání = kratší klip, úplný začátek = chyba', () => {
  assert.deepEqual(clip.liveClipWindow({ previewStart: 0, elapsed: 18 }), { ok: true, time: 0, duration: 18 });
  assert.deepEqual(clip.liveClipWindow({ previewStart: 0, elapsed: 3 }), { ok: false, reason: 'too-early' });
});

test('klip: bez hlavičky se počítá z délky vysílání s rezervou za živým okrajem', () => {
  assert.deepEqual(clip.liveClipWindow({ elapsed: 600 }), { ok: true, time: 600 - 10 - 30, duration: 30 });
  assert.deepEqual(clip.liveClipWindow({ elapsed: 25 }), { ok: true, time: 0, duration: 15 });
  assert.deepEqual(clip.liveClipWindow({ elapsed: 12 }), { ok: false, reason: 'too-early' });
  assert.deepEqual(clip.liveClipWindow({}), { ok: false, reason: 'invalid' });
  assert.deepEqual(clip.liveClipWindow({ elapsed: NaN, previewStart: -5 }), { ok: false, reason: 'invalid' });
});

test('klip: adresy jen s platným kódem a id videa', () => {
  assert.equal(clip.liveClipMp4Url('abc123', UID, { time: 12.7, duration: 30 }), `https://customer-abc123.cloudflarestream.com/${UID}/clip.mp4?time=12s&duration=30s&filename=kine-clip.mp4`);
  assert.equal(clip.liveClipMp4Url('abc123', UID, { time: -4, duration: 500 }), `https://customer-abc123.cloudflarestream.com/${UID}/clip.mp4?time=0s&duration=60s&filename=kine-clip.mp4`);
  assert.equal(clip.liveClipMp4Url('evil.com/x', UID, { time: 0, duration: 30 }), null);
  assert.equal(clip.liveClipMp4Url('abc123', '../../etc', { time: 0, duration: 30 }), null);
  assert.equal(clip.livePreviewManifestUrl('abc123', UID), `https://customer-abc123.cloudflarestream.com/${UID}/manifest/video.m3u8?duration=30s`);
  assert.equal(clip.readPreviewStart(' 42.5 '), 42.5);
  assert.equal(clip.readPreviewStart('nesmysl'), null);
  assert.equal(clip.readPreviewStart(null), null);
  assert.equal(clip.readPreviewStart('-1'), null);
});

// ---------------------------------------------------------------- raid
test('raid: platí chvíli po odeslání, i po konci vysílání', () => {
  assert.equal(raid.raidActive({ raid_to: 'x', raid_at: iso(-30_000), started_at: iso(-3600_000) }, NOW), true);
  assert.equal(raid.raidActive({ raid_to: 'x', raid_at: iso(-raid.RAID_REDIRECT_MS - 1000) }, NOW), false);
  assert.equal(raid.raidActive({ raid_to: null, raid_at: iso(-1000) }, NOW), false);
  assert.equal(raid.raidActive(null, NOW), false);
});

test('raid: nové vysílání po raidu diváky nikam neposílá', () => {
  assert.equal(raid.raidActive({ raid_to: 'x', raid_at: iso(-60_000), started_at: iso(-10_000) }, NOW), false);
});

test('raid: jednou za 5 minut a ke stejnému kanálu nejvýš 3× denně', () => {
  assert.deepEqual(raid.raidAllowed(null, 0, NOW), { ok: true });
  const r = raid.raidAllowed(iso(-60_000), 0, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryS, 240);
  assert.deepEqual(raid.raidAllowed(iso(-6 * 60_000), 3, NOW), { ok: false, reason: 'pair-limit' });
  assert.deepEqual(raid.raidAllowed(iso(-6 * 60_000), 2, NOW), { ok: true });
});

test('raid: zpráva do chatu s počtem diváků i bez něj', () => {
  assert.equal(raid.raidChatBody('Pepa', 12), '⚡ Raid! Pepa sem posílá 12 diváků');
  assert.equal(raid.raidChatBody('Pepa', null), '⚡ Raid! Pepa sem posílá své diváky');
  assert.equal(raid.raidChatBody('', 0), '⚡ Raid! Někdo sem posílá své diváky');
});

// ---------------------------------------------------------------- plán
test('plán: čas musí být v budoucnu a do 60 dní, zaokrouhlí se na minuty', () => {
  const ok = plan.validateSchedule({ startsAt: iso(3 * 3600_000 + 25_000), title: '  Večer   s Minecraftem ', game: 'minecraft' }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.startsAt, iso(3 * 3600_000));
  assert.equal(ok.title, 'Večer s Minecraftem');
  assert.equal(ok.game, 'minecraft');
  assert.deepEqual(plan.validateSchedule({ startsAt: iso(-5000) }, NOW), { ok: false, reason: 'time-past' });
  assert.deepEqual(plan.validateSchedule({ startsAt: iso(61 * 24 * 3600_000) }, NOW), { ok: false, reason: 'time-far' });
  assert.deepEqual(plan.validateSchedule({ startsAt: 'zítra' }, NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(plan.validateSchedule({ startsAt: 12345 }, NOW), { ok: false, reason: 'invalid' });
  assert.equal(plan.validateSchedule({ startsAt: iso(3600_000), game: 'Bad Game!' }, NOW).game, null);
  assert.equal(plan.validateSchedule({ startsAt: iso(3600_000), title: 'x'.repeat(300) }, NOW).title.length, 100);
});

test('plán: po začátku ještě chvíli platí („začne každou chvíli“), pak propadne', () => {
  assert.equal(plan.scheduleCurrent(iso(3600_000), NOW), true);
  assert.equal(plan.scheduleCurrent(iso(-3600_000), NOW), true);
  assert.equal(plan.scheduleCurrent(iso(-3 * 3600_000), NOW), false);
  assert.equal(plan.scheduleCurrent(null, NOW), false);
});

test('plán: odpočet jako hodiny, nad den ve dnech', () => {
  assert.equal(plan.countdownClock(65_000), '1:05');
  assert.equal(plan.countdownClock(2 * 3600_000 + 14 * 60_000 + 5_000), '2:14:05');
  assert.equal(plan.countdownClock(500), '0:01');
  assert.equal(plan.countdownClock(-5), '0:00');
  assert.equal(plan.countdownClock(25 * 3600_000), null);
  // Kalendářní dny (testy běží v UTC): neděle 20:00 -> pondělí 21:00 je "zítra", i když je to přes 24 h.
  assert.equal(plan.calendarDaysUntil(Date.parse('2026-11-02T21:00:00Z'), NOW), 1);
  assert.equal(plan.calendarDaysUntil(Date.parse('2026-11-03T00:30:00Z'), NOW), 2);
  assert.equal(plan.calendarDaysUntil(Date.parse('2026-11-01T23:00:00Z'), NOW), 0);
});

// ---------------------------------------------------------------- ankety
test('anketa: otázka a 2-4 různé možnosti, délka jen z povolených', () => {
  assert.deepEqual(polls.sanitizePoll({ question: '  Co   dál? ', options: ['Minecraft', ' ', 'Fortnite  '], seconds: 120 }), {
    ok: true,
    question: 'Co dál?',
    options: ['Minecraft', 'Fortnite'],
    seconds: 120,
  });
  assert.equal(polls.sanitizePoll({ question: 'X', options: ['a', 'b'], seconds: 99999 }).seconds, 60);
  assert.deepEqual(polls.sanitizePoll({ question: '', options: ['a', 'b'] }), { ok: false, reason: 'question' });
  assert.deepEqual(polls.sanitizePoll({ question: 'X', options: ['a'] }), { ok: false, reason: 'options' });
  assert.deepEqual(polls.sanitizePoll({ question: 'X', options: ['a', 'b', 'c', 'd', 'e'] }), { ok: false, reason: 'options' });
  assert.deepEqual(polls.sanitizePoll({ question: 'X', options: ['Ano', 'ano'] }), { ok: false, reason: 'duplicate' });
  assert.deepEqual(polls.sanitizePoll({ question: 'X', options: 'a,b' }), { ok: false, reason: 'options' });
  assert.equal(polls.sanitizePoll({ question: 'X'.repeat(500), options: ['a', 'b'] }).question.length, 120);
});

test('anketa: běží do konce, ručně ukončená hned končí, výsledky ještě chvíli vidět', () => {
  const row = { ends_at: iso(30_000), closed_at: null };
  assert.equal(polls.pollActive(row, NOW), true);
  assert.equal(polls.pollEndedAt(row, NOW), null);
  assert.equal(polls.pollActive({ ends_at: iso(30_000), closed_at: iso(-1000) }, NOW), false);
  assert.equal(polls.pollEndedAt({ ends_at: iso(30_000), closed_at: iso(-1000) }, NOW), NOW - 1000);
  assert.equal(polls.pollVisible({ ends_at: iso(-60_000), closed_at: null }, NOW), true);
  assert.equal(polls.pollVisible({ ends_at: iso(-polls.POLL_RESULTS_SHOW_MS - 1), closed_at: null }, NOW), false);
});

test('anketa: souhrn - hlasy, procenta dají 100, vítěz jen po konci a bez remízy', () => {
  const row = { id: 'p1', question: 'Co dál?', options: ['A', 'B', 'C'], created_at: iso(-60_000), ends_at: iso(-1000), closed_at: null };
  const s = polls.pollSummary(row, [{ choice: 0, votes: 1 }, { choice: 1, votes: 1 }, { choice: 2, votes: 1 }], NOW);
  assert.deepEqual(s.votes, [1, 1, 1]);
  assert.equal(s.percents.reduce((a, b) => a + b, 0), 100);
  assert.equal(s.winner, null);
  const w = polls.pollSummary(row, [{ choice: 1, votes: '5' }, { choice: 0, votes: 2 }, { choice: 9, votes: 50 }], NOW);
  assert.deepEqual(w.votes, [2, 5, 0]);
  assert.equal(w.total, 7);
  assert.equal(w.winner, 1);
  assert.deepEqual(w.percents, [29, 71, 0]);
  const running = polls.pollSummary({ ...row, ends_at: iso(60_000) }, [{ choice: 1, votes: 5 }], NOW);
  assert.equal(running.active, true);
  assert.equal(running.winner, null);
  assert.deepEqual(polls.pollSummary(row, [], NOW).percents, [0, 0, 0]);
  assert.deepEqual(polls.pollOptions(['a', 5, 'b', null]), ['a', 'b']);
});

console.log(`\n${prosly} prošlo, ${padly} spadlo`);
if (padly > 0) process.exit(1);
