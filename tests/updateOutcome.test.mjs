import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTEMPT_MAX_AGE_MS,
  isWindowsPolicyBlock,
  judgeUpdateOutcome,
  parseInstallerResult,
  parseSmartAppControl,
  parseUpdateAttempt,
} from '../dist/esm/updateOutcome.js';

const NOW = 1_800_000_000_000;
const attempt = (o = {}) => ({ from: '0.9.8', to: '0.9.9', at: NOW - 60_000, ...o });

test('výsledek od instalátoru (installer-result.txt, i s CRLF)', () => {
  assert.deepEqual(parseInstallerResult('result=blocked\r\nversion=0.9.9\r\n'), { result: 'blocked', version: '0.9.9' });
  assert.deepEqual(parseInstallerResult('result=in-use\nversion=0.9.9'), { result: 'in-use', version: '0.9.9' });
  assert.deepEqual(parseInstallerResult('result=ok\r\nversion=nesmysl\r\n'), { result: 'ok', version: null });
  assert.deepEqual(parseInstallerResult('result=files-missing\r\n'), { result: 'files-missing', version: null });
  assert.equal(parseInstallerResult('result=hack\nversion=0.9.9'), null);
  assert.equal(parseInstallerResult(''), null);
  assert.equal(parseInstallerResult(null), null);
});

test('záznam o pokusu (update-attempt.json)', () => {
  assert.deepEqual(parseUpdateAttempt(JSON.stringify(attempt())), attempt());
  assert.equal(parseUpdateAttempt('{"from":"0.9.8","to":"x","at":1}'), null);
  assert.equal(parseUpdateAttempt('{"from":"0.9.8","to":"0.9.9"}'), null, 'bez času');
  assert.equal(parseUpdateAttempt('{rozbité'), null);
  assert.equal(parseUpdateAttempt(undefined), null);
});

test('aktualizace z appky prošla -> updated (běží nová verze)', () => {
  assert.deepEqual(judgeUpdateOutcome({ current: '0.9.9', attempt: attempt(), installer: { result: 'ok', version: '0.9.9' }, now: NOW }), { kind: 'updated', from: '0.9.8', to: '0.9.9' });
  assert.equal(judgeUpdateOutcome({ current: '0.9.9', attempt: attempt(), installer: null, now: NOW }).kind, 'updated');
});

test('neprošla: důvod od instalátoru, jinak "nespustil se"', () => {
  assert.deepEqual(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt(), installer: { result: 'blocked', version: '0.9.9' }, now: NOW }), { kind: 'failed', version: '0.9.9', reason: 'blocked' });
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt(), installer: { result: 'in-use', version: '0.9.9' }, now: NOW }).reason, 'in-use');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt(), installer: null, now: NOW }).reason, 'not-started');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt(), installer: { result: 'blocked', version: '0.9.7' }, now: NOW }).reason, 'not-started', 'výsledek k jiné verzi se nepočítá');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt(), installer: { result: 'blocked', version: null }, now: NOW }).reason, 'blocked');
});

test('starý nebo budoucí pokus se nehlásí', () => {
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt({ at: NOW - ATTEMPT_MAX_AGE_MS - 1 }), installer: null, now: NOW }).kind, 'none');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: attempt({ at: NOW + 5 * 60_000 }), installer: null, now: NOW }).kind, 'none');
});

test('bez pokusu (aktualizaci spustila starší appka): hlásí se jen neúspěch novější verze', () => {
  assert.deepEqual(judgeUpdateOutcome({ current: '0.9.8', attempt: null, installer: { result: 'blocked', version: '0.9.9' }, now: NOW }), { kind: 'failed', version: '0.9.9', reason: 'blocked' });
  assert.equal(judgeUpdateOutcome({ current: '0.9.9', attempt: null, installer: { result: 'blocked', version: '0.9.9' }, now: NOW }).kind, 'none', 'mezitím nainstalovaná');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: null, installer: { result: 'ok', version: '0.9.9' }, now: NOW }).kind, 'none');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: null, installer: { result: 'blocked', version: null }, now: NOW }).kind, 'none', 'bez verze nevíme');
  assert.equal(judgeUpdateOutcome({ current: '0.9.8', attempt: null, installer: null, now: NOW }).kind, 'none');
});

test('Smart App Control podle reg query', () => {
  const out = (v) => `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy\r\n    VerifiedAndReputablePolicyState    REG_DWORD    ${v}\r\n\r\n`;
  assert.equal(parseSmartAppControl(out('0x1')), 'on');
  assert.equal(parseSmartAppControl(out('0x0')), 'off');
  assert.equal(parseSmartAppControl(out('0x2')), 'evaluation');
  assert.equal(parseSmartAppControl(out('0x7')), null);
  assert.equal(parseSmartAppControl('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseSmartAppControl(''), null);
});

test('chyba kvůli politice Windows (pomocník se pak nezkouší dokola)', () => {
  assert.equal(isWindowsPolicyBlock("Could not load file or assembly 'file:///C:\\Users\\x\\AppData\\Local\\Temp\\abc.dll'. An Application Control policy has blocked this file. (Exception from HRESULT: 0x800711C7)"), true);
  assert.equal(isWindowsPolicyBlock('This program is blocked by group policy.'), true);
  assert.equal(isWindowsPolicyBlock('Cannot add type. Compilation errors occurred.'), false);
  assert.equal(isWindowsPolicyBlock(''), false);
  assert.equal(isWindowsPolicyBlock(null), false);
});
