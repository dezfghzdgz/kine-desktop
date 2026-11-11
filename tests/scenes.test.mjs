import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCENES,
  appPart,
  composeScene,
  defaultScenes,
  effectiveSource,
  findScene,
  mainSource,
  newSceneId,
  nextSceneId,
  pickWindowSource,
  sameSource,
  sanitizeScenes,
  sanitizeSourceRef,
  sceneIdOrFirst,
  sourceKey,
} from '../dist/esm/scenes.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../dist/esm/settingsSchema.js';

const cam = { liveCamera: true, liveCameraDevice: 'cam1', liveCameraPosition: 'bottom-right', liveCameraSize: 'medium', liveCameraShape: 'rounded', liveCameraMirror: true };
const extra = { brb: false, brbText: 'BRB', micMuted: false, defaultText: 'Začínáme za chvíli' };

test('výchozí scény: hra s kamerou, jen kamera, text', () => {
  const scenes = defaultScenes();
  assert.deepEqual(scenes.map((s) => [s.id, s.kind]), [['game', 'source'], ['camera', 'camera'], ['starting', 'text']]);
  assert.equal(scenes[0].camera, true);
  assert.equal(scenes[0].source, null);
  assert.deepEqual(DEFAULT_SETTINGS.liveScenes, scenes);
  assert.equal(DEFAULT_SETTINGS.liveSceneId, 'game');
  assert.equal(DEFAULT_SETTINGS.captureWindow, null);
});

test('zdroj ze souboru: monitor, okno; rozbité = null', () => {
  assert.deepEqual(sanitizeSourceRef({ kind: 'screen', displayId: ' 123 ' }), { kind: 'screen', displayId: '123' });
  assert.deepEqual(sanitizeSourceRef({ kind: 'screen' }), { kind: 'screen', displayId: '' });
  assert.deepEqual(sanitizeSourceRef({ kind: 'window', id: 'window:1234:0', name: 'Opera\n' }), { kind: 'window', id: 'window:1234:0', name: 'Opera' });
  assert.equal(sanitizeSourceRef({ kind: 'window', id: 'screen:0:0', name: 'x' }), null);
  assert.equal(sanitizeSourceRef({ kind: 'window', id: 'window:1;rm -rf', name: 'x' }), null);
  assert.equal(sanitizeSourceRef({ kind: 'tab', id: 'x' }), null);
  assert.equal(sanitizeSourceRef(null), null);
  assert.equal(sanitizeSourceRef('window:1:0'), null);
});

test('scény ze souboru: nejvýš 8, jedinečná id, druhy, prázdné = výchozí', () => {
  assert.deepEqual(sanitizeScenes(undefined), defaultScenes());
  assert.deepEqual(sanitizeScenes([]), defaultScenes());
  assert.deepEqual(sanitizeScenes([{ id: 'BAD ID!' }]), defaultScenes());
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, name: `S${i}`, kind: 'source', camera: false }));
  assert.equal(sanitizeScenes(many).length, MAX_SCENES);
  const out = sanitizeScenes([
    { id: 'a', name: '  Prohlížeč  ', kind: 'source', source: { kind: 'window', id: 'window:5:0', name: 'Opera' }, camera: false, text: 'nic' },
    { id: 'a', name: 'duplicita', kind: 'text' },
    { id: 'b', name: 'x'.repeat(80), kind: 'text', text: 'Pauza\nna jídlo', source: { kind: 'screen', displayId: '1' }, camera: true },
    { id: 'c', kind: 'weird' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: 'a', name: 'Prohlížeč', kind: 'source', source: { kind: 'window', id: 'window:5:0', name: 'Opera' }, camera: false, text: '' });
  assert.equal(out[1].name.length, 40);
  assert.equal(out[1].text, 'Pauza na jídlo');
  assert.equal(out[1].source, null, 'text scéna nemá zdroj');
  assert.equal(out[1].camera, false);
  assert.equal(out[2].kind, 'source', 'neznámý druh = hra');
  assert.equal(out[2].camera, true);
});

test('nastavení: scény, vybraná scéna, aplikace, zkratka - očištění', () => {
  const s = sanitizeSettings({ liveScenes: [{ id: 'x', kind: 'camera' }], liveSceneId: 'neni', captureWindow: { kind: 'window', id: 'window:9:0', name: 'Hra' }, liveSceneHotkey: 'F7' });
  assert.equal(s.liveScenes.length, 1);
  assert.equal(s.liveSceneId, 'x', 'neplatná scéna = první');
  assert.deepEqual(s.captureWindow, { kind: 'window', id: 'window:9:0', name: 'Hra' });
  assert.equal(s.liveSceneHotkey, 'F7');
  const t = sanitizeSettings({ captureWindow: { kind: 'screen', displayId: '1' }, liveSceneHotkey: 'nesmysl+' });
  assert.equal(t.captureWindow, null, 'captureWindow je jen okno');
  assert.equal(t.liveSceneHotkey, '');
  assert.equal(sanitizeSettings({}).liveSceneId, 'game');
});

test('výběr scény: id, další v pořadí, nové id', () => {
  const scenes = defaultScenes();
  assert.equal(sceneIdOrFirst(scenes, 'camera'), 'camera');
  assert.equal(sceneIdOrFirst(scenes, 'nic'), 'game');
  assert.equal(findScene(scenes, 'nic').id, 'game');
  assert.equal(nextSceneId(scenes, 'game'), 'camera');
  assert.equal(nextSceneId(scenes, 'starting'), 'game');
  assert.equal(nextSceneId(scenes, 'nic'), 'game');
  const seq = [0.1, 0.1, 0.5];
  const fixed = [{ ...scenes[0], id: newSceneId([], () => 0.1) }];
  const id = newSceneId(fixed, () => seq.shift());
  assert.match(id, /^s-[0-9a-z]{6}$/);
  assert.notEqual(id, fixed[0].id);
});

test('co se nahrává: hlavní zdroj, zdroj scény jen během vysílání', () => {
  const screen = { kind: 'screen', displayId: '' };
  const opera = { kind: 'window', id: 'window:7:0', name: 'Kine - Opera' };
  assert.deepEqual(mainSource({ displayId: '2', captureWindow: null }), { kind: 'screen', displayId: '2' });
  assert.deepEqual(mainSource({ displayId: '2', captureWindow: opera }), opera);
  const game = { id: 'g', name: '', kind: 'source', source: null, camera: true, text: '' };
  const browser = { id: 'b', name: '', kind: 'source', source: opera, camera: false, text: '' };
  const camOnly = { id: 'c', name: '', kind: 'camera', source: null, camera: false, text: '' };
  assert.deepEqual(effectiveSource(screen, browser, false), screen, 'bez vysílání hlavní zdroj');
  assert.deepEqual(effectiveSource(screen, browser, true), opera);
  assert.deepEqual(effectiveSource(screen, game, true), screen, 'scéna bez zdroje = hlavní');
  assert.deepEqual(effectiveSource(screen, camOnly, true, opera), opera, 'jen kamera zdroj nemění');
  assert.deepEqual(effectiveSource(screen, camOnly, true, null), screen);
  assert.equal(sourceKey(screen), 'screen:');
  assert.equal(sourceKey(opera), 'window:window:7:0');
  assert.equal(sourceKey(null), '');
  assert.ok(sameSource({ kind: 'window', id: 'window:7:0', name: 'jiný název' }, opera));
  assert.ok(!sameSource(screen, { kind: 'screen', displayId: '1' }));
});

test('okno aplikace: podle id, po restartu podle názvu, jinak null', () => {
  const list = [
    { id: 'window:1:0', name: 'Kine - Opera' },
    { id: 'window:2:0', name: 'Counter-Strike 2' },
    { id: 'window:3:0', name: 'Discord' },
  ];
  assert.equal(pickWindowSource(list, { id: 'window:2:0', name: 'cokoli' }).id, 'window:2:0');
  assert.equal(pickWindowSource(list, { id: 'window:99:0', name: 'Counter-Strike 2' }).id, 'window:2:0', 'nové id, stejný název');
  assert.equal(pickWindowSource(list, { id: 'window:99:0', name: 'YouTube - Opera' }).id, 'window:1:0', 'prohlížeč s jinou stránkou');
  assert.equal(pickWindowSource(list, { id: 'window:99:0', name: 'Notepad' }), null);
  assert.equal(pickWindowSource(list, { id: 'window:99:0', name: '' }), null);
  // Dvě okna téže aplikace a jiný název: nehádá se.
  const two = [...list, { id: 'window:4:0', name: 'Mail - Opera' }];
  assert.equal(pickWindowSource(two, { id: 'window:99:0', name: 'YouTube - Opera' }), null);
  assert.equal(appPart('Stránka – Opera'), 'opera');
  assert.equal(appPart('Discord'), '');
  assert.equal(appPart('Counter-Strike 2'), '', 'pomlčka bez mezer není oddělovač');
});

test('scéna pro snímací stránku: kamera v rohu, jen kamera, text, "Hned jsem zpět" přebije vše', () => {
  const game = { id: 'game', name: '', kind: 'source', source: null, camera: true, text: '' };
  const g = composeScene(game, cam, extra);
  assert.deepEqual(g.camera, { deviceId: 'cam1', position: 'bottom-right', size: 'medium', shape: 'rounded', mirror: true });
  assert.equal(g.sceneId, 'game');
  assert.equal(g.cameraFull, undefined);
  assert.equal(composeScene(game, { ...cam, liveCamera: false }, extra).camera, null, 'kamera ve vysílání vypnutá');
  assert.equal(composeScene({ ...game, camera: false }, cam, extra).camera, null);
  const c = composeScene({ id: 'c', name: '', kind: 'camera', source: null, camera: false, text: '' }, { ...cam, liveCamera: false }, extra);
  assert.equal(c.cameraFull, true);
  assert.equal(c.camera.deviceId, 'cam1', 'jen kamera otevře kameru vždycky');
  const txt = composeScene({ id: 't', name: '', kind: 'text', source: null, camera: false, text: '' }, cam, extra);
  assert.equal(txt.screenText, 'Začínáme za chvíli');
  assert.equal(txt.brb, false);
  assert.equal(composeScene({ id: 't', name: '', kind: 'text', source: null, camera: false, text: 'Pauza' }, cam, extra).screenText, 'Pauza');
  const brb = composeScene(game, cam, { ...extra, brb: true, micMuted: true });
  assert.equal(brb.brb, true);
  assert.equal(brb.camera, null);
  assert.equal(brb.micMuted, true);
  assert.equal(brb.screenText, undefined);
});
