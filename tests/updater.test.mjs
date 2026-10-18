import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateYml, isNewerVersion, autoInstallDue, parseSeen, AUTO_INSTALL_GRACE_DAYS } from '../dist/esm/updaterParse.js';

test('app-update.yml: naše úložiště (generic) i GitHub', () => {
  assert.deepEqual(parseUpdateYml('provider: generic\nurl: https://pub-abc.r2.dev/full/\nchannel: latest\nupdaterCacheDirName: kine-desktop-updater\n'), {
    provider: 'generic',
    url: 'https://pub-abc.r2.dev/full',
    channel: 'latest',
  });
  assert.deepEqual(parseUpdateYml("provider: github\nowner: dezfghzdgz\nrepo: kine-desktop\nchannel: 'clipper'\n"), {
    provider: 'github',
    owner: 'dezfghzdgz',
    repo: 'kine-desktop',
    channel: 'clipper',
  });
  assert.equal(parseUpdateYml('provider: s3\nbucket: x\n'), null);
  assert.equal(parseUpdateYml(''), null);
});

test('porovnání verzí', () => {
  assert.ok(isNewerVersion('0.7.0', '0.6.0'));
  assert.ok(isNewerVersion('v0.10.0', '0.9.9'));
  assert.ok(isNewerVersion('1.0.0', '0.99.99'));
  assert.ok(!isNewerVersion('0.6.0', '0.6.0'));
  assert.ok(!isNewerVersion('0.5.9', '0.6.0'));
  assert.ok(!isNewerVersion('0.6', '0.6.0'), 'kratší zápis stejné verze není novější');
  assert.ok(isNewerVersion('0.6.1', '0.6'));
  assert.ok(!isNewerVersion(null, '0.6.0'));
  assert.ok(!isNewerVersion('nesmysl', '0.6.0'));
});

test('samočinná instalace: po 14 dnech od prvního zahlédnutí, nebo hned když Kine verzi odmítá', () => {
  const day = 24 * 3600 * 1000;
  const seen = Date.parse('2026-10-01T10:00:00Z');
  assert.equal(AUTO_INSTALL_GRACE_DAYS, 14);
  assert.equal(autoInstallDue(seen, seen + 13 * day, false), false, '13. den ještě ne');
  assert.equal(autoInstallDue(seen, seen + 14 * day, false), true, '14. den ano');
  assert.equal(autoInstallDue(seen, seen + 100 * day, false), true);
  assert.equal(autoInstallDue(null, seen + 100 * day, false), false, 'bez záznamu se nic nevynucuje');
  assert.equal(autoInstallDue(null, seen, true), true, 'odmítnutá verze: hned');
  assert.equal(autoInstallDue(seen, seen + 1000, true), true);
  assert.equal(autoInstallDue(seen, seen + 1 * day, false, 1), true, 'vlastní lhůta');
});

test('záznam o prvním zahlédnutí verze (update-seen.json)', () => {
  assert.equal(parseSeen(JSON.stringify({ version: '0.12.0', at: 1700000000000 }), '0.12.0'), 1700000000000);
  assert.equal(parseSeen(JSON.stringify({ version: '0.11.9', at: 1700000000000 }), '0.12.0'), null, 'jiná verze = lhůta běží znovu');
  assert.equal(parseSeen(JSON.stringify({ version: '0.12.0', at: 'včera' }), '0.12.0'), null);
  assert.equal(parseSeen('{rozbité', '0.12.0'), null);
  assert.equal(parseSeen(null, '0.12.0'), null);
});
