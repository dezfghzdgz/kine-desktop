import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, VARIANTS, VERIFY_UPDATE_SIGNATURE } from '../scripts/publish-config.mjs';

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
  assert.equal(signed.signer, 'Azure Artifact Signing');
  // Aktualizace jméno v certifikátu nekontrolují (jako u Certumu) - jinak by odchylka ve jméně
  // (diakritika u OSVČ) nebo pozdější jiný certifikát zablokovaly všechny další aktualizace.
  assert.match(signed.text, /^  verifyUpdateCodeSignature: false$/m);
  assert.match(signed.text, /publisherName: "CN=Kine"/);
  assert.deepEqual(Object.keys(VARIANTS), ['full', 'clipper']);
});

test('Azure bez AZURE_SIGN_PUBLISHER: publisherName (povinný ve schématu) = název appky', () => {
  const azure = { AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net', AZURE_SIGN_ACCOUNT: 'kine', AZURE_SIGN_PROFILE: 'kine-public' };
  assert.match(buildConfig(azure).text, /^    publisherName: "Kine"$/m);
  assert.match(buildConfig({ ...azure, KINE_VARIANT: 'clipper' }).text, /^    publisherName: "Kine Clipper"$/m);
  assert.match(buildConfig(azure).text, /^    endpoint: "https:\/\/weu\.codesigning\.azure\.net"$/m);
  assert.match(buildConfig(azure).text, /^    codeSigningAccountName: "kine"$/m);
  assert.match(buildConfig(azure).text, /^    certificateProfileName: "kine-public"$/m);
});

const THUMB = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

test('Certum: podpis z úložiště Windows (otisk), .dll a .node taky, bez ověřování jména u aktualizací', () => {
  const cfg = buildConfig({ KINE_SIGN: 'certum', KINE_SIGN_SHA1: THUMB, KINE_VARIANT: 'clipper' });
  assert.equal(cfg.signing, true);
  assert.equal(cfg.signer, `Certum (${THUMB.toUpperCase()})`);
  assert.match(cfg.text, /^  signtoolOptions:\n    certificateSha1: "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678"\n    rfc3161TimeStampServer: "http:\/\/time\.certum\.pl"\n    signingHashAlgorithms:\n      - sha256\n    sign: "\.\/scripts\/podpisHook\.mjs"$/m);
  assert.match(cfg.text, /^forceCodeSigning: true$/m);
  assert.match(cfg.text, /^  signExts:\n    - "\.dll"\n    - "\.node"$/m);
  assert.match(cfg.text, /^  verifyUpdateCodeSignature: false$/m);
  assert.doesNotMatch(cfg.text, /azureSignOptions|publisherName/);
  // Bez pomocníka, dokud ho podpis.mjs nevyrobí.
  assert.equal(cfg.helperExe, false);
  // Pomocník (dist/helper) jen s podpisem; ffmpeg pro macOS (mac.extraResources) je tam vždycky.
  assert.doesNotMatch(cfg.text, /from: dist\/helper/);
});

test('Certum má přednost před Azure; neplatný otisk = bez podpisu; pomocník jen s podpisem', () => {
  const azure = { AZURE_SIGN_ENDPOINT: 'https://weu.codesigning.azure.net', AZURE_SIGN_ACCOUNT: 'kine', AZURE_SIGN_PROFILE: 'kine-public' };
  const both = buildConfig({ ...azure, KINE_SIGN: 'certum', KINE_SIGN_SHA1: THUMB });
  assert.match(both.text, /certificateSha1/);
  assert.doesNotMatch(both.text, /azureSignOptions/);
  const azureOnly = buildConfig({ ...azure, KINE_HELPER_EXE: '1' });
  assert.match(azureOnly.text, /azureSignOptions/);
  assert.match(azureOnly.text, /signExts/);
  assert.match(azureOnly.text, /^extraResources:\n  - from: dist\/helper\n    to: helper\n    filter:\n      - kine-helper\.exe$/m);
  const broken = buildConfig({ KINE_SIGN: 'certum', KINE_SIGN_SHA1: 'abc', KINE_HELPER_EXE: '1' });
  assert.equal(broken.signing, false);
  assert.doesNotMatch(broken.text, /signtoolOptions|signExts|from: dist\/helper|forceCodeSigning/);
  const unsignedHelper = buildConfig({ KINE_HELPER_EXE: '1' });
  assert.equal(unsignedHelper.helperExe, false, 'nepodepsaný pomocník se nepřibaluje');
});

test('úložiště aktualizací jen přes https; kontrola podpisu aktualizací se zapíná jedním řádkem', () => {
  assert.throws(() => buildConfig({ DESKTOP_DOWNLOAD_BASE: 'http://pub-x.r2.dev' }), /https/);
  assert.throws(() => buildConfig({ DESKTOP_DOWNLOAD_BASE: 'ftp://pub-x.r2.dev' }), /https/);
  assert.doesNotThrow(() => buildConfig({ DESKTOP_DOWNLOAD_BASE: 'HTTPS://stahnout.kine.cz/' }));
  // Zatím vypnutá (podpis není nastavený) - zapnutí = VERIFY_UPDATE_SIGNATURE v scripts/publish-config.mjs.
  assert.equal(VERIFY_UPDATE_SIGNATURE, false);
  assert.match(buildConfig({ KINE_SIGN: 'certum', KINE_SIGN_SHA1: THUMB }).text, /^  verifyUpdateCodeSignature: false$/m);
});
