import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DEFAULT_SETTINGS, isAccelerator, suggestedMbps } from '../dist/esm/settingsSchema.js';
import { parseHotkey, formatHotkey, isSimpleHotkey, toAccelerator, hotkeyVks, hotkeyLabel, partFromCode, HotkeyRecorder } from '../dist/esm/hotkeys.js';
import { clipFileBase, defaultClipTitle, gameHashtag, safeFilePart, formatDuration } from '../dist/esm/clipNaming.js';
import { translate, langFromLocale, DICTS, LANG_NAMES } from '../dist/esm/i18n.js';

test('rozbité nastavení se srovná na výchozí', () => {
  const s = sanitizeSettings({ clipSeconds: 'abc', fps: 45, codec: 'av1', clipHotkey: 'Ctrl+', detection: 'x', customGames: { ' CS2.EXE ': 'CS' }, siteUrl: 'ftp://x' });
  assert.equal(s.clipSeconds, DEFAULT_SETTINGS.clipSeconds);
  assert.equal(s.fps, 30);
  assert.equal(s.codec, 'auto');
  assert.equal(s.clipHotkey, 'F8');
  assert.equal(s.detection, 'games');
  assert.deepEqual(s.customGames, { 'cs2.exe': 'CS' });
  assert.equal(s.siteUrl, DEFAULT_SETTINGS.siteUrl);
});

test('platné hodnoty projdou, délka klipu se ořeže', () => {
  const s = sanitizeSettings({ clipSeconds: 900, clipHotkey: 'Ctrl+Shift+S', siteUrl: 'http://localhost:3000/' });
  assert.equal(s.clipSeconds, 300);
  assert.equal(s.clipHotkey, 'Ctrl+Shift+S');
  assert.equal(s.siteUrl, 'http://localhost:3000');
});

test('zkratky: klávesy, modifikátory, víc kláves najednou, myš', () => {
  assert.ok(isAccelerator('F8'));
  assert.ok(isAccelerator('Alt+Z'));
  assert.ok(isAccelerator('Ctrl+Shift+num5'));
  assert.ok(isAccelerator('F8+F9'));
  assert.ok(isAccelerator('Ctrl+Mouse5'));
  assert.ok(!isAccelerator('Ctrl'));
  assert.ok(!isAccelerator('Foo+F8'));
  assert.ok(!isAccelerator('Mouse1'));
  // jednoduché -> systémová zkratka Electronu
  const simple = parseHotkey('Shift+Ctrl+S');
  assert.equal(formatHotkey(simple), 'Ctrl+Shift+S');
  assert.ok(isSimpleHotkey(simple));
  assert.equal(toAccelerator(simple), 'Ctrl+Shift+S');
  assert.equal(toAccelerator(parseHotkey('ScrollLock')), 'Scrolllock');
  // složené -> pomocník (virtual-key kódy)
  const chord = parseHotkey('F8+F9');
  assert.ok(!isSimpleHotkey(chord));
  assert.equal(toAccelerator(chord), null);
  assert.deepEqual(hotkeyVks(chord), [0x77, 0x78]);
  assert.deepEqual(hotkeyVks(parseHotkey('Ctrl+Mouse5')), [0x11, 0x06]);
  assert.ok(!isSimpleHotkey(parseHotkey('Pause')), 'Pause umí jen pomocník');
  assert.equal(hotkeyLabel('Ctrl+Shift+S'), 'Ctrl + Shift + S');
  assert.equal(hotkeyLabel('Mouse4'), 'Mouse 4');
  assert.equal(hotkeyLabel('num5'), 'Num 5');
  assert.deepEqual(partFromCode('KeyS'), { kind: 'key', part: 'S' });
  assert.deepEqual(partFromCode('ControlLeft'), { kind: 'mod', part: 'Ctrl' });
  assert.equal(partFromCode('Escape'), null);
});

test('záznam zkratky: drží se víc kláves, hotovo po puštění všech', () => {
  const r = new HotkeyRecorder();
  assert.ok(r.keyDown('ControlLeft'));
  assert.ok(r.keyDown('F8'));
  assert.equal(r.keyUp('ControlLeft'), null, 'F8 se ještě drží');
  assert.deepEqual(r.keyUp('F8'), { mods: ['Ctrl'], keys: ['F8'], mouse: [] });
  // samotný modifikátor zkratku nedělá
  r.keyDown('ShiftLeft');
  assert.equal(r.keyUp('ShiftLeft'), null);
  // dvě klávesy najednou
  r.keyDown('F8');
  r.keyDown('F9');
  r.keyUp('F9');
  assert.equal(formatHotkey(r.keyUp('F8')), 'F8+F9');
  // tlačítko myši
  assert.ok(r.mouseDown(4));
  assert.equal(formatHotkey(r.mouseUp(4)), 'Mouse5');
  assert.ok(!r.mouseDown(0), 'levé tlačítko se nenabízí');
});

test('názvy klipů a souborů', () => {
  const at = new Date(2026, 8, 21, 20, 14, 5);
  assert.equal(clipFileBase(at, 'Counter-Strike 2'), 'Kine 2026-09-21 20-14-05 Counter-Strike 2');
  assert.equal(clipFileBase(at, 'A:B/C*D?'), 'Kine 2026-09-21 20-14-05 ABCD');
  assert.equal(defaultClipTitle(at, 'CS2', 'klip'), 'CS2 · klip 21. 9. 20:14');
  assert.equal(defaultClipTitle(at, null), 'Clip 21. 9. 20:14');
  assert.equal(gameHashtag('Counter-Strike 2'), 'counterstrike2');
  assert.equal(gameHashtag("Baldur's Gate 3"), 'baldursgate3');
  assert.equal(safeFilePart('   '), 'clip');
  assert.equal(formatDuration(75), '1:15');
});

test('překlady: dosazení proměnných a jazyk ze systému', () => {
  assert.equal(translate('cs', 'toastClipSaved', { seconds: 30 }), 'Klip uložen · 30 s');
  assert.equal(translate('en', 'toastClipSaved', { seconds: 30 }), 'Clip saved · 30 s');
  assert.equal(langFromLocale('cs-CZ'), 'cs');
  assert.equal(langFromLocale('sk'), 'sk');
  assert.equal(langFromLocale('uk-UA'), 'uk');
  assert.equal(langFromLocale('ja-JP'), null);
  assert.equal(suggestedMbps(1080, 60), 12);
  assert.equal(DEFAULT_SETTINGS.lang, 'en', 'výchozí jazyk je angličtina');
});

test('všech osm jazyků má stejné klíče a stejné {proměnné}', () => {
  const langs = Object.keys(DICTS);
  assert.deepEqual(langs.sort(), ['cs', 'de', 'en', 'es', 'fr', 'pl', 'sk', 'uk']);
  const keys = Object.keys(DICTS.en);
  assert.ok(keys.length > 200);
  const vars = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const lang of langs) {
    const dict = DICTS[lang];
    assert.deepEqual(Object.keys(dict).sort(), [...keys].sort(), `klíče v ${lang}`);
    for (const key of keys) {
      assert.ok(typeof dict[key] === 'string' && dict[key].trim(), `${lang}.${key} prázdný`);
      assert.equal(vars(dict[key]), vars(DICTS.en[key]), `${lang}.${key} má jiné proměnné`);
    }
    assert.ok(LANG_NAMES[lang]);
  }
});
