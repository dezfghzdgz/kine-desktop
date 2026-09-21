import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTasklistCsv, parseSteamRunningAppId, parseSteamPath, parseLibraryFolders, parseAcfName,
  detectFromProcesses, needsConfirmation, isMinecraftCommandLine, KNOWN_GAMES, chooseGame, prettyNameFromExe, IGNORED_FOREGROUND,
} from '../dist/esm/gamesParse.js';

const base = { custom: {}, steam: null, foreground: null, windowed: new Set(), current: null, fullscreenDetection: true, minecraft: null };

test('tasklist CSV -> názvy procesů malými písmeny', () => {
  const out = '"System Idle Process","0","Services","0","8 K"\r\n"cs2.exe","1234","Console","1","1 234 567 K"\r\n"Discord.exe","55","Console","1","300 000 K"\r\n';
  const set = parseTasklistCsv(out);
  assert.ok(set.has('cs2.exe'));
  assert.ok(set.has('discord.exe'));
  assert.equal(set.size, 3);
});

test('Steam RunningAppID z registru (hex i nula)', () => {
  assert.equal(parseSteamRunningAppId('\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x2f0\r\n'), 752);
  assert.equal(parseSteamRunningAppId('    RunningAppID    REG_DWORD    0x0'), 0);
  assert.equal(parseSteamRunningAppId('ERROR: The system was unable to find the specified registry key or value.'), 0);
});

test('SteamPath a knihovny', () => {
  assert.equal(parseSteamPath('    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n'), 'c:\\program files (x86)\\steam');
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}\n';
  assert.deepEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  assert.equal(parseAcfName('"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"Counter-Strike 2"\n}'), 'Counter-Strike 2');
});

test('hra ze seznamu procesů: vlastní má přednost před známými', () => {
  const procs = new Set(['explorer.exe', 'cs2.exe', 'mojehra.exe']);
  assert.deepEqual(detectFromProcesses(procs, {}), { name: 'Counter-Strike 2', exe: 'cs2.exe', source: 'known' });
  assert.deepEqual(detectFromProcesses(procs, { 'MojeHra.exe': 'Moje hra' }), { name: 'Moje hra', exe: 'mojehra.exe', source: 'custom' });
  assert.equal(detectFromProcesses(new Set(['explorer.exe']), {}), null);
});

test('javaw.exe není hra bez potvrzení příkazové řádky', () => {
  const procs = new Set(['javaw.exe']);
  assert.equal(detectFromProcesses(procs, {}), null);
  assert.deepEqual(needsConfirmation(procs), ['javaw.exe']);
  assert.ok(isMinecraftCommandLine('javaw.exe -Xmx4G -cp ... net.minecraft.client.main.Main'));
  assert.ok(!isMinecraftCommandLine('javaw.exe -jar C:\\Users\\x\\IntelliJ\\idea.jar'));
});

test('seznam známých her má klíče malými písmeny a bez duplicit názvů exe', () => {
  for (const key of Object.keys(KNOWN_GAMES)) assert.equal(key, key.toLowerCase(), key);
  assert.ok(Object.keys(KNOWN_GAMES).length > 150);
});

test('výběr hry: okno v popředí vyhrává (CS2 před Robloxem na pozadí)', () => {
  const processes = new Set(['explorer.exe', 'robloxplayerbeta.exe', 'cs2.exe', 'discord.exe']);
  // bez pomocníka: první ze seznamu (jak to bylo) - Roblox
  const withoutHelper = chooseGame({ ...base, processes });
  assert.equal(withoutHelper.name, 'Roblox');
  // s pomocníkem: CS2 je v popředí
  const fg = { exe: 'cs2.exe', title: 'Counter-Strike 2', fullscreen: true };
  assert.deepEqual(chooseGame({ ...base, processes, foreground: fg }), { name: 'Counter-Strike 2', exe: 'cs2.exe', source: 'known' });
  // alt-tab do Discordu: hra se drží, dokud běží
  const current = { name: 'Counter-Strike 2', exe: 'cs2.exe', source: 'known' };
  assert.equal(chooseGame({ ...base, processes, current, foreground: { exe: 'discord.exe', title: 'Discord', fullscreen: false } }).exe, 'cs2.exe');
  // přepnutí do Robloxu v popředí -> Roblox
  assert.equal(chooseGame({ ...base, processes, current, foreground: { exe: 'robloxplayerbeta.exe', title: 'Roblox', fullscreen: true } }).name, 'Roblox');
});

test('výběr hry: po zavření CS2 se Roblox na pozadí NEhraje (čeká se na další hru)', () => {
  const current = { name: 'Counter-Strike 2', exe: 'cs2.exe', source: 'known' };
  const withoutCs = new Set(['explorer.exe', 'robloxplayerbeta.exe', 'discord.exe']);
  // s pomocníkem: v popředí je plocha / Discord -> nic
  assert.equal(chooseGame({ ...base, processes: withoutCs, current, foreground: { exe: 'explorer.exe', title: '', fullscreen: false } }), null);
  assert.equal(chooseGame({ ...base, processes: withoutCs, current, foreground: { exe: 'discord.exe', title: '', fullscreen: false } }), null);
  // hráč klikne do Robloxu -> teď se hraje Roblox
  assert.equal(chooseGame({ ...base, processes: withoutCs, current: null, foreground: { exe: 'robloxplayerbeta.exe', title: 'Roblox', fullscreen: false } }).name, 'Roblox');
  // bez pomocníka (Linux) zůstává staré chování: Roblox jako jediný kandidát
  assert.equal(chooseGame({ ...base, processes: withoutCs, current }).name, 'Roblox');
  // nic neběží
  assert.equal(chooseGame({ ...base, processes: new Set(['explorer.exe']) }), null);
});

test('výběr hry: neznámý program přes celou obrazovku je hra, prohlížeč ne', () => {
  const processes = new Set(['explorer.exe', 'superhra.exe', 'chrome.exe']);
  const game = chooseGame({ ...base, processes, foreground: { exe: 'superhra.exe', title: 'SuperHra', fullscreen: true } });
  assert.deepEqual(game, { name: 'SuperHra', exe: 'superhra.exe', source: 'fullscreen' });
  assert.equal(chooseGame({ ...base, processes, foreground: { exe: 'chrome.exe', title: 'YouTube', fullscreen: true } }), null);
  assert.equal(chooseGame({ ...base, processes, fullscreenDetection: false, foreground: { exe: 'superhra.exe', title: 'SuperHra', fullscreen: true } }), null);
  assert.equal(chooseGame({ ...base, processes, foreground: { exe: 'superhra.exe', title: 'SuperHra', fullscreen: false } }), null, 'v okně bez rámečku přes celou obrazovku ne');
  // vlastní název má přednost před titulkem
  assert.equal(chooseGame({ ...base, processes, custom: { 'superhra.exe': 'Moje super hra' }, foreground: { exe: 'superhra.exe', title: 'SuperHra', fullscreen: true } }).name, 'Moje super hra');
  // Steam ví název, program neznáme - v celé obrazovce i v okně
  const steam = { name: 'Hollow Knight: Silksong', exe: 'steam:1030300', source: 'steam' };
  assert.deepEqual(chooseGame({ ...base, processes, steam, foreground: { exe: 'superhra.exe', title: '', fullscreen: true } }), { name: 'Hollow Knight: Silksong', exe: 'superhra.exe', source: 'steam' });
  assert.deepEqual(chooseGame({ ...base, processes, steam, foreground: { exe: 'superhra.exe', title: '', fullscreen: false } }), { name: 'Hollow Knight: Silksong', exe: 'superhra.exe', source: 'steam' });
  // Steam hlásí hru, ale v popředí je prohlížeč -> nic (hra ještě nabíhá / je na pozadí)
  assert.equal(chooseGame({ ...base, processes, steam, foreground: { exe: 'chrome.exe', title: '', fullscreen: false } }), null);
  // Steam bez popředí (Linux/pomocník neběží)
  assert.equal(chooseGame({ ...base, processes: new Set(['explorer.exe']), steam }).exe, 'steam:1030300');
});

test('výběr hry: víc kandidátů bez pomocníka -> ten s oknem', () => {
  const processes = new Set(['robloxplayerbeta.exe', 'cs2.exe']);
  assert.equal(chooseGame({ ...base, processes, windowed: new Set(['cs2.exe']) }).exe, 'cs2.exe');
});

test('název hry z programu', () => {
  assert.equal(prettyNameFromExe('fortniteclient-win64-shipping.exe'), 'Fortnite');
  assert.equal(prettyNameFromExe('hd-player.exe'), 'HD Player');
  assert.equal(prettyNameFromExe('game.exe', 'Hollow Knight'), 'Hollow Knight');
  assert.equal(prettyNameFromExe('game.exe', 'Minecraft* 1.21.4 - Singleplayer'), 'Game');
  assert.ok(IGNORED_FOREGROUND.has('chrome.exe') && IGNORED_FOREGROUND.has('explorer.exe'));
});
