import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, VARIANTS } from '../scripts/publish-config.mjs';

test('Kine do PC: základ, aktualizace z <BASE>/full', () => {
  const cfg = buildConfig({ DESKTOP_DOWNLOAD_BASE: 'https://pub-x.r2.dev/' });
  assert.equal(cfg.variant, 'full');
  assert.equal(cfg.file, 'electron-builder.generated.yml');
  assert.match(cfg.text, /^appId: cz\.kine\.desktop$/m);
  assert.match(cfg.text, /^productName: "Kine"$/m);
  assert.match(cfg.text, /^  kineVariant: full$/m);
  assert.match(cfg.text, /url: "https:\/\/pub-x\.r2\.dev\/full"/);
  assert.match(cfg.text, /artifactName: "Kine-Setup\.\$\{ext\}"/);
  assert.doesNotMatch(cfg.text, /channel: clipper/);
  assert.doesNotMatch(cfg.text, /azureSignOptions/);
});

test('Kine Clipper: jiný název, ikona, appId, složka a kanál na GitHubu', () => {
  const cfg = buildConfig({ KINE_VARIANT: 'clipper', DESKTOP_DOWNLOAD_BASE: 'https://pub-x.r2.dev' });
  assert.equal(cfg.file, 'electron-builder.clipper.yml');
  assert.match(cfg.text, /^appId: cz\.kine\.clipper$/m);
  assert.match(cfg.text, /^productName: "Kine Clipper"$/m);
  assert.match(cfg.text, /^  name: kine-clipper$/m, 'vlastní složka s daty');
  assert.match(cfg.text, /^  kineVariant: clipper$/m);
  assert.match(cfg.text, /icon: build\/icon-clipper\.png/);
  assert.match(cfg.text, /url: "https:\/\/pub-x\.r2\.dev\/clipper"/);
  assert.match(cfg.text, /artifactName: "Kine-Clipper-Setup\.\$\{ext\}"/);
  assert.match(cfg.text, /channel: clipper/);
  assert.match(cfg.text, /output: release\/clipper/);
});

test('bez úložiště jen GitHub, s AZURE_* podpis', () => {
  const plain = buildConfig({});
  assert.doesNotMatch(plain.text, /provider: generic/);
  assert.match(plain.text, /provider: github/);
  const signed = buildConfig({ AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net', AZURE_SIGN_ACCOUNT: 'kine', AZURE_SIGN_PROFILE: 'kine-public', AZURE_SIGN_PUBLISHER: 'CN=Kine' });
  assert.equal(signed.signing, true);
  assert.match(signed.text, /verifyUpdateCodeSignature: true/);
  assert.match(signed.text, /publisherName: "CN=Kine"/);
  assert.deepEqual(Object.keys(VARIANTS), ['full', 'clipper']);
});
