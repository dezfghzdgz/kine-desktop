import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTasklistCsv, parseSteamRunningAppId, parseSteamPath, parseLibraryFolders, parseAcfName,
  detectFromProcesses, needsConfirmation, isMinecraftCommandLine, KNOWN_GAMES,
} from '../dist/esm/gamesParse.js';

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
