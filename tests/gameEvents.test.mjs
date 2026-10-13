import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JsonStreamFramer,
  KillStreak,
  RlMoments,
  cs2Events,
  cs2GsiConfig,
  decodeIni,
  encodeIni,
  lolEvents,
  rlConfigEnable,
  rlConfigRestore,
  rlContext,
  rlDecode,
  rlEvents,
  rlInitialState,
  rlLabelKey,
  rlMomentAllowed,
  streakLabelKey,
} from '../dist/esm/gameEventsParse.js';

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

// ---- 0.9.0: CS2 mapa + skóre, Dota 2, Minecraft ---------------------------------------

import { cs2Context, cs2MapName, dota2Events, dota2GsiConfig, heroName, isDota2Payload, minecraftGameDir, minecraftLogEvent, minecraftUserFromLog } from '../dist/esm/gameEventsParse.js';

test('CS2: mapa a skóre do názvu klipu (z pohledu hráče)', () => {
  assert.equal(cs2MapName('de_mirage'), 'Mirage');
  assert.equal(cs2MapName('cs_office'), 'Office');
  assert.equal(cs2MapName('de_ancient'), 'Ancient');
  assert.equal(cs2MapName(''), '');
  let r = cs2Events(null, gsi(0, 0, { map: { name: 'de_mirage', team_ct: { score: 7 }, team_t: { score: 5 } }, player: { steamid: ME, team: 'CT', state: { round_kills: 0 }, match_stats: { kills: 0 } } }));
  assert.equal(cs2Context(r.state), 'Mirage 7:5');
  r = cs2Events(r.state, gsi(1, 1, { map: { name: 'de_mirage', team_ct: { score: 7 }, team_t: { score: 5 } }, player: { steamid: ME, team: 'T', state: { round_kills: 1 }, match_stats: { kills: 1 } } }));
  assert.equal(cs2Context(r.state), 'Mirage 5:7');
  // Bez skóre jen mapa; bez ničeho prázdné.
  assert.equal(cs2Context(cs2Events(null, gsi(0, 0)).state), 'Mirage');
  assert.equal(cs2Context(null), '');
});

const dota = (kills, extra = {}) => ({
  provider: { name: 'Dota 2', appid: 570, steamid: ME },
  map: { matchid: '7000000001', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
  player: { steamid: ME, name: 'Hráč', kills, deaths: 0, assists: 1 },
  hero: { name: 'npc_dota_hero_crystal_maiden', level: 6 },
  ...extra,
});

test('Dota 2: poznání zprávy, zabití z nárůstu player.kills, nový zápas začíná od nuly', () => {
  assert.equal(isDota2Payload(dota(0)), true);
  assert.equal(isDota2Payload(gsi(0, 0, { provider: { steamid: ME, appid: 730 } })), false);
  assert.equal(isDota2Payload(gsi(0, 0)), false);
  let r = dota2Events(null, dota(0));
  assert.deepEqual(r.events, []);
  assert.equal(r.state.hero, 'Crystal Maiden');
  r = dota2Events(r.state, dota(1));
  assert.deepEqual(r.events, [{ game: 'dota2', kind: 'kill', count: 1 }]);
  // Dvě zabití v jedné zprávě = dvě události (sérii poskládá KillStreak).
  r = dota2Events(r.state, dota(3));
  assert.equal(r.events.length, 2);
  // Nový zápas: jiné matchid, kills od nuly - nic nehlásit.
  r = dota2Events(r.state, dota(0, { map: { matchid: '7000000002' } }));
  assert.deepEqual(r.events, []);
  r = dota2Events(r.state, dota(1, { map: { matchid: '7000000002' } }));
  assert.equal(r.events.length, 1);
  // Divák: hráč s jiným steamid se nepočítá.
  r = dota2Events(r.state, dota(5, { player: { steamid: '1', kills: 5 } }));
  assert.deepEqual(r.events, []);
  assert.equal(heroName('npc_dota_hero_shadow_fiend'), 'Shadow Fiend');
  assert.match(dota2GsiConfig(27381, 'abc'), /"hero" "1"/);
  assert.match(dota2GsiConfig(27381, 'abc'), /"token" "abc"/);
});

test('Minecraft: jméno hráče ze startu logu, smrt / PvP zabití / pokrok z [CHAT] řádků', () => {
  assert.equal(minecraftUserFromLog('[10:00:01] [main/INFO]: Setting user: Steve'), 'Steve');
  assert.equal(minecraftUserFromLog('[10:00:01] [main/INFO]: Loaded 1 recipes'), null);
  const line = (text) => `[10:00:02] [Render thread/INFO]: [System] [CHAT] ${text}`;
  assert.deepEqual(minecraftLogEvent(line('Steve was slain by Zombie'), 'Steve'), { kind: 'death', text: 'Steve was slain by Zombie' });
  assert.equal(minecraftLogEvent(line('Steve fell from a high place'), 'Steve').kind, 'death');
  assert.equal(minecraftLogEvent(line('Steve drowned'), 'Steve').kind, 'death');
  assert.equal(minecraftLogEvent(line('Steve has made the advancement [Stone Age]'), 'Steve').kind, 'advancement');
  assert.equal(minecraftLogEvent(line('Steve has completed the challenge [Return to Sender]'), 'Steve').kind, 'advancement');
  // Jiný jazyk hry: název pokroku v závorkách na konci.
  assert.equal(minecraftLogEvent(line('Steve získal pokrok [Doba kamenná]'), 'Steve').kind, 'advancement');
  // PvP: cizí smrt "by Steve" (i se zbraní).
  assert.equal(minecraftLogEvent(line('Alex was slain by Steve'), 'Steve').kind, 'kill');
  assert.equal(minecraftLogEvent(line('Alex was shot by Steve using [Bow]'), 'Steve').kind, 'kill');
  // Vlastní smrt se zbraní nesmí být "pokrok".
  assert.equal(minecraftLogEvent(line('Steve was slain by Alex using [Sword]'), 'Steve').kind, 'death');
  // Chat hráčů, připojení, cizí smrt bez mě, jiný hráč se stejným začátkem jména: nic.
  assert.equal(minecraftLogEvent(line('<Steve> was slain by Zombie lol'), 'Steve'), null);
  assert.equal(minecraftLogEvent(line('Steve joined the game'), 'Steve'), null);
  assert.equal(minecraftLogEvent(line('Alex was slain by Zombie'), 'Steve'), null);
  assert.equal(minecraftLogEvent(line('Steve2 was slain by Zombie'), 'Steve'), null);
  assert.equal(minecraftLogEvent('[10:00:02] [Render thread/INFO]: Steve was slain by Zombie', 'Steve'), null);
  assert.equal(minecraftLogEvent(line('Steve was slain by Zombie'), ''), null);
  // Složka hry z příkazové řádky.
  assert.equal(minecraftGameDir('javaw -Xmx2G --gameDir C:\\Hry\\mc --assetsDir x'), 'C:\\Hry\\mc');
  assert.equal(minecraftGameDir('javaw --gameDir "C:\\Moje hry\\mc" --version 1.21'), 'C:\\Moje hry\\mc');
  assert.equal(minecraftGameDir('javaw -jar server.jar'), null);
});

// ---- Rocket League (Stats API) ----------------------------------------------------------

/** Zpráva jako ji posílá hra: Data je znovu zakódovaný text JSON. */
const rlMsg = (event, data) => JSON.stringify({ Event: event, Data: JSON.stringify(data) });
const tick = (target, teams = [0, 0], replay = false) =>
  rlDecode(rlMsg('UpdateState', { MatchGuid: 'm1', Players: [], Game: { Teams: [{ TeamNum: 0, Score: teams[0] }, { TeamNum: 1, Score: teams[1] }], bReplay: replay, bHasTarget: !!target, Target: target ?? undefined } }));
const HRAC = { Name: 'Hráč "1"', Shortcut: 1, TeamNum: 1 };
const JINY = { Name: 'Bot', Shortcut: 2, TeamNum: 0 };

test('RL: souvislý proud JSON bez oddělovače, rozseknutý kdekoli; uvozovky a závorky v textu nevadí', () => {
  const framer = new JsonStreamFramer();
  const a = rlMsg('GoalScored', { Scorer: { Name: 'A {b} "c"' } });
  const b = rlMsg('MatchEnded', { WinnerTeamNum: 1 });
  const stream = `${a}\r\n${b}${a}`;
  const out = [];
  for (let i = 0; i < stream.length; i += 7) out.push(...framer.push(stream.slice(i, i + 7)));
  assert.equal(out.length, 3);
  assert.equal(rlDecode(out[0]).data.Scorer.Name, 'A {b} "c"');
  assert.equal(rlDecode(out[1]).event, 'MatchEnded');
  assert.equal(rlDecode(out[1]).data.WinnerTeamNum, 1);
  // Data jako objekt (kdyby to hra jednou poslala bez zakódování) i nesmysl.
  assert.equal(rlDecode('{"Event":"X","Data":{"a":1}}').data.a, 1);
  assert.equal(rlDecode('{"nic":1}'), null);
  assert.equal(rlDecode('{rozbité'), null);
});

test('RL: "já" = koho kamera sleduje (Target) mimo opakované záběry; až po 10 hlasech a s většinou', () => {
  let s = rlInitialState();
  for (let i = 0; i < 9; i++) s = rlEvents(s, tick(HRAC)).state;
  assert.equal(s.me, null, 'málo hlasů');
  s = rlEvents(s, tick(HRAC)).state;
  assert.equal(s.me.name, 'Hráč "1"');
  // Opakovaný záběr gólu (kamera na střelci) se nepočítá.
  for (let i = 0; i < 30; i++) s = rlEvents(s, tick(JINY, [0, 0], true)).state;
  assert.equal(s.me.name, 'Hráč "1"');
  // Divák přepínající mezi hráči žádné "já" nemá.
  let d = rlInitialState();
  for (let i = 0; i < 10; i++) d = rlEvents(d, tick(i % 2 ? HRAC : JINY)).state;
  assert.equal(d.me, null);
  // Nový zápas začíná od nuly.
  assert.equal(rlEvents(s, rlDecode(rlMsg('MatchCreated', {}))).state.me, null);
});

test('RL: jen MOJE góly a zákroky; třetí gól = i hattrick; skóre z pohledu mého týmu', () => {
  let s = rlInitialState();
  for (let i = 0; i < 12; i++) s = rlEvents(s, tick(HRAC, [0, 0])).state;
  let r = rlEvents(s, rlDecode(rlMsg('GoalScored', { GoalSpeed: 98.5, Scorer: { Name: 'Bot', Shortcut: 2, TeamNum: 0 } })));
  assert.deepEqual(r.moments, [], 'cizí gól');
  r = rlEvents(r.state, rlDecode(rlMsg('GoalScored', { Scorer: { Name: 'Hráč "1"', Shortcut: 1, TeamNum: 1 } })));
  assert.deepEqual(r.moments, ['goal']);
  r = rlEvents(r.state, tick(HRAC, [1, 1]));
  r = rlEvents(r.state, rlDecode(rlMsg('GoalScored', { Scorer: HRAC })));
  r = rlEvents(r.state, rlDecode(rlMsg('GoalScored', { Scorer: HRAC })));
  assert.deepEqual(r.moments, ['goal', 'hatTrick']);
  r = rlEvents(r.state, tick(HRAC, [1, 3]));
  assert.equal(rlContext(r.state), '3:1', 'oranžový tým: moje skóre první');
  // Statfeed: zákroky a demolice jen moje.
  assert.deepEqual(rlEvents(r.state, rlDecode(rlMsg('StatfeedEvent', { EventName: 'EpicSave', Type: 'Epic Save', MainTarget: HRAC }))).moments, ['epicSave']);
  assert.deepEqual(rlEvents(r.state, rlDecode(rlMsg('StatfeedEvent', { EventName: 'Demolish', Type: 'Demolition', MainTarget: HRAC, SecondaryTarget: JINY }))).moments, ['demo']);
  assert.deepEqual(rlEvents(r.state, rlDecode(rlMsg('StatfeedEvent', { EventName: 'Demolish', MainTarget: JINY, SecondaryTarget: HRAC }))).moments, [], 'mě zdemolovali - to klip není');
  assert.deepEqual(rlEvents(r.state, rlDecode(rlMsg('StatfeedEvent', { EventName: 'Shot', MainTarget: HRAC }))).moments, [], 'střela bez gólu ne');
  // Bez "já" (divák) se nic neklipuje.
  assert.deepEqual(rlEvents(rlInitialState(), rlDecode(rlMsg('GoalScored', { Scorer: HRAC }))).moments, []);
});

test('RL: režimy - multi jen góly, hattrick a skvělé zákroky; every vše; off nic', () => {
  assert.ok(rlMomentAllowed('goal', 'multi') && rlMomentAllowed('epicSave', 'multi') && rlMomentAllowed('hatTrick', 'multi'));
  assert.ok(!rlMomentAllowed('save', 'multi') && !rlMomentAllowed('demo', 'multi'));
  assert.ok(rlMomentAllowed('demo', 'every') && rlMomentAllowed('save', 'every'));
  assert.ok(!rlMomentAllowed('goal', 'off'));
  assert.equal(rlLabelKey('goal'), 'autoClipGoal');
  assert.equal(rlLabelKey('hatTrick'), 'autoClipHatTrick');
});

test('RL: momenty těsně za sebou = jeden klip s nejdůležitějším názvem, po uklidnění', async () => {
  const clips = [];
  const m = new RlMoments({ mode: () => 'every', onClip: (k) => clips.push(k), quietMs: 40, maxMs: 500 });
  m.add('save');
  m.add('goal');
  m.add('demo');
  assert.deepEqual(clips, []);
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(clips, ['goal']);
  const multi = new RlMoments({ mode: () => 'multi', onClip: (k) => clips.push(k), quietMs: 20 });
  multi.add('demo');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(clips, ['goal'], 'v multi demolice klip není');
});

test('RL: zapnutí Stats API v konfiguraci a vrácení zpět (jen to, co zapnula appka)', () => {
  const shipped = '[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\nPort=49123\r\n';
  const on = rlConfigEnable(shipped);
  assert.ok(on.changed);
  assert.equal(on.port, 49123);
  assert.match(on.text, /^PacketSendRate=5$/m);
  assert.match(on.text, /puvodne 0/);
  assert.equal(rlConfigEnable(on.text).changed, false, 'podruhé nic');
  const back = rlConfigRestore(on.text);
  assert.ok(back.changed);
  assert.equal(back.text.replace(/\r\n/g, '\n').trim(), shipped.replace(/\r\n/g, '\n').trim());
  // Zapnuté jiným programem (overlay): nesahá, jen převezme port.
  const other = '[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=30\r\nPort=50000\r\n';
  const kept = rlConfigEnable(other);
  assert.equal(kept.changed, false);
  assert.equal(kept.port, 50000);
  assert.equal(rlConfigRestore(other).changed, false);
  // Prázdný / chybějící soubor: celý oddíl; vrácení ho vypne.
  const fresh = rlConfigEnable(null);
  assert.match(fresh.text, /\[TAGame\.MatchStatsExporter_TA\][\s\S]*PacketSendRate=5[\s\S]*Port=49123/);
  assert.doesNotMatch(rlConfigRestore(fresh.text).text, /PacketSendRate=5/);
  // TCP vypnuté (Port=0): appka dá výchozí port.
  assert.equal(rlConfigEnable('[TAGame.MatchStatsExporter_TA]\nPacketSendRate=0\nPort=0\n').port, 49123);
  // Jiné oddíly zůstanou.
  const mixed = '[Other]\r\nA=1\r\n[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\n[Next]\r\nB=2\r\n';
  const mixedOn = rlConfigEnable(mixed).text;
  assert.match(mixedOn, /\[Other\]\r\nA=1/);
  assert.match(mixedOn, /\[Next\]\r\nB=2/);
  assert.match(mixedOn, /PacketSendRate=5\r\nPort=49123\r\n\[Next\]/);
});

test('RL: konfigurace v UTF-16 / s BOM zůstane ve svém kódování', () => {
  const shipped = '[TAGame.MatchStatsExporter_TA]\r\nPacketSendRate=0\r\nPort=49123\r\n';
  const variants = [
    ['UTF-16 s BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(shipped, 'utf16le')])],
    ['UTF-16 bez BOM', Buffer.from(shipped, 'utf16le')],
    ['UTF-8 s BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(shipped, 'utf8')])],
    ['UTF-8', Buffer.from(shipped, 'utf8')],
  ];
  for (const [name, bytes] of variants) {
    const read = decodeIni(bytes);
    assert.equal(read.text, shipped, name);
    const on = rlConfigEnable(read.text);
    assert.ok(on.changed, name);
    const written = encodeIni(on.text, read.encoding);
    // Stejné kódování: BOM na začátku zůstal, text se dá přečíst zpátky.
    const bomLen = bytes[0] === 0xff ? 2 : bytes[0] === 0xef ? 3 : 0;
    assert.deepEqual([...written.subarray(0, bomLen)], [...bytes.subarray(0, bomLen)], name);
    if (bomLen === 0) assert.notEqual(written[0], 0xef, name);
    const again = decodeIni(written);
    assert.deepEqual(again.encoding, read.encoding, name);
    assert.match(again.text, /^PacketSendRate=5$/m, name);
    const back = encodeIni(rlConfigRestore(again.text).text, again.encoding);
    assert.equal(decodeIni(back).text.trim(), shipped.trim(), name);
  }
  // Nový soubor: UTF-8 bez BOM.
  assert.equal(encodeIni('x').toString('utf8'), 'x');
});
