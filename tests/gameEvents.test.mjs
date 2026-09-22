import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KillStreak, cs2Events, cs2GsiConfig, lolEvents, streakLabelKey } from '../dist/esm/gameEventsParse.js';

const ME = '76561198000000001';
const gsi = (roundKills, matchKills, extra = {}) => ({
  provider: { steamid: ME },
  map: { name: 'de_mirage' },
  round: { phase: 'live' },
  player: { steamid: ME, state: { round_kills: roundKills }, match_stats: { kills: matchKills } },
  ...extra,
});

test('CS2: první zpráva jen nastaví stav, zabití = nárůst round_kills', () => {
  let r = cs2Events(null, gsi(0, 0));
  assert.deepEqual(r.events, []);
  r = cs2Events(r.state, gsi(1, 1));
  assert.deepEqual(r.events, [{ game: 'cs2', kind: 'kill', count: 1 }]);
  r = cs2Events(r.state, gsi(2, 2));
  assert.deepEqual(r.events, [{ game: 'cs2', kind: 'multikill', count: 2 }]);
  // Nové kolo: round_kills spadne na 0 - žádná událost.
  r = cs2Events(r.state, gsi(0, 2));
  assert.deepEqual(r.events, []);
  // Pět v kole = ace.
  let s = r.state;
  for (let k = 1; k <= 5; k++) r = cs2Events((s = r.state), gsi(k, 2 + k));
  assert.equal(r.events[0].kind, 'ace');
  assert.equal(r.events[0].count, 5);
});

test('CS2: sledování spoluhráče po smrti se nepočítá, nový zápas začíná od nuly', () => {
  let r = cs2Events(null, gsi(3, 10));
  // Po smrti CS2 posílá statistiky sledovaného hráče (jiný steamid).
  r = cs2Events(r.state, { provider: { steamid: ME }, map: { name: 'de_mirage' }, player: { steamid: '999', state: { round_kills: 9 }, match_stats: { kills: 40 } } });
  assert.deepEqual(r.events, []);
  assert.equal(r.state.matchKills, 10, 'stav zůstal můj');
  // Nový zápas (kills klesly) - nic se nehlásí, stav se přepíše.
  r = cs2Events(r.state, gsi(1, 1, { map: { name: 'de_inferno' } }));
  assert.deepEqual(r.events, []);
  assert.equal(r.state.map, 'de_inferno');
  r = cs2Events(r.state, gsi(2, 2, { map: { name: 'de_inferno' } }));
  assert.equal(r.events.length, 1);
});

test('CS2: bez player_state se bere match_stats.kills', () => {
  const payload = (kills) => ({ provider: { steamid: ME }, player: { steamid: ME, match_stats: { kills } } });
  let r = cs2Events(null, payload(4));
  r = cs2Events(r.state, payload(5));
  assert.deepEqual(r.events, [{ game: 'cs2', kind: 'kill', count: 1 }]);
  assert.deepEqual(cs2Events(r.state, null).events, []);
  assert.deepEqual(cs2Events(r.state, 'nesmysl').events, []);
});

test('LoL: jen nové události a jen moje zabití; Multikill nese délku série', () => {
  const me = { name: 'Hráč#EUW', riotName: 'Hráč' };
  const events = [
    { EventID: 0, EventName: 'GameStart', EventTime: 0 },
    { EventID: 1, EventName: 'ChampionKill', KillerName: 'Hráč', VictimName: 'X' },
    { EventID: 2, EventName: 'ChampionKill', KillerName: 'Někdo jiný', VictimName: 'Hráč' },
    { EventID: 3, EventName: 'ChampionKill', KillerName: 'hráč#EUW', VictimName: 'Y' },
    { EventID: 4, EventName: 'Multikill', KillerName: 'Hráč', KillStreak: 2 },
  ];
  const first = lolEvents({ Events: events.slice(0, 2) }, -1, me);
  assert.equal(first.lastId, 1);
  assert.deepEqual(first.events, [{ game: 'lol', kind: 'kill', count: 1 }]);
  const next = lolEvents({ Events: events }, first.lastId, me);
  assert.equal(next.lastId, 4);
  assert.deepEqual(next.events.map((e) => `${e.kind}:${e.count}`), ['kill:1', 'multikill:2']);
  assert.equal(next.restarted, false);
  // Nová hra: EventID začíná znovu od nuly.
  const again = lolEvents({ Events: [{ EventID: 0, EventName: 'GameStart' }, { EventID: 1, EventName: 'Ace', Acer: 'Hráč' }] }, 4, me);
  assert.equal(again.restarted, true);
  assert.deepEqual(again.events, [{ game: 'lol', kind: 'ace', count: 5 }]);
  assert.equal(again.lastId, 1);
  assert.deepEqual(lolEvents({}, 3, me), { lastId: 3, events: [], restarted: false });
});

test('série: klip až po uklidnění, v režimu multi od dvou zabití', async () => {
  const clips = [];
  const streak = new KillStreak({ mode: () => 'multi', onClip: (n) => clips.push(n), quietMs: 30, maxMs: 200 });
  streak.add({ game: 'cs2', kind: 'kill', count: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(clips, [], 'jedno zabití v režimu multi = nic');
  streak.add({ game: 'cs2', kind: 'kill', count: 1 });
  streak.add({ game: 'cs2', kind: 'multikill', count: 2 });
  streak.add({ game: 'cs2', kind: 'multikill', count: 3 });
  assert.equal(streak.current(), 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(clips, [3], 'tři zabití = jeden klip s délkou 3');
  const every = [];
  const s2 = new KillStreak({ mode: () => 'every', onClip: (n) => every.push(n), quietMs: 30, maxMs: 200 });
  s2.add({ game: 'lol', kind: 'kill', count: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(every, [1]);
  const off = new KillStreak({ mode: () => 'off', onClip: () => assert.fail('vypnuto'), quietMs: 10 });
  off.add({ game: 'lol', kind: 'kill', count: 1 });
  await new Promise((r) => setTimeout(r, 30));
});

test('série: nejpozději po maxMs od prvního zabití, i když zabití pokračují', async () => {
  const clips = [];
  let now = 1000;
  const streak = new KillStreak({ mode: () => 'every', now: () => now, onClip: (n) => clips.push(n), quietMs: 1000, maxMs: 1500 });
  streak.add({ game: 'lol', kind: 'kill', count: 1 });
  now += 1400;
  // Další zabití 1,4 s po prvním: čekání se zkrátí na zbývajících 100 ms, ne celou sekundu.
  streak.add({ game: 'lol', kind: 'kill', count: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(clips, [2]);
});

test('popisky a cfg pro CS2', () => {
  assert.equal(streakLabelKey(1), 'autoClipKill');
  assert.equal(streakLabelKey(2), 'autoClipDouble');
  assert.equal(streakLabelKey(3), 'autoClipTriple');
  assert.equal(streakLabelKey(4), 'autoClipQuad');
  assert.equal(streakLabelKey(7), 'autoClipAce');
  const cfg = cs2GsiConfig(27381, 'abc123');
  assert.match(cfg, /"uri" "http:\/\/127\.0\.0\.1:27381"/);
  assert.match(cfg, /"token" "abc123"/);
  assert.match(cfg, /"player_state" "1"/);
  assert.ok(cfg.startsWith('"Kine"\r\n{'));
});
