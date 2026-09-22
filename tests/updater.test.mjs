import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateYml, isNewerVersion } from '../dist/esm/updaterParse.js';

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
