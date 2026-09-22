import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DEFAULT_SETTINGS, isAccelerator, isDiscordWebhook, suggestedMbps } from '../dist/esm/settingsSchema.js';
import { parseHotkey, formatHotkey, isSimpleHotkey, toAccelerator, hotkeyVks, hotkeyLabel, partFromCode, partFromGamepadButton, HotkeyRecorder, PAD_VK_BASE } from '../dist/esm/hotkeys.js';
import { clipFileBase, defaultClipTitle, gameHashtag, safeFilePart, formatDuration } from '../dist/esm/clipNaming.js';
import { translate, langFromLocale, DICTS, LANG_NAMES } from '../dist/esm/i18n.js';
import { PERFORMANCE, performanceProfile } from '../dist/esm/performance.js';

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
  assert.deepEqual(r.keyUp('F8'), { mods: ['Ctrl'], keys: ['F8'], mouse: [], pad: [] });
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

test('nové volby 0.6: automatické klipy, token pro CS2, webhook Discordu', () => {
  const d = sanitizeSettings({});
  assert.equal(d.autoClips, 'multi');
  assert.equal(d.gsiToken, '');
  assert.equal(d.discordWebhook, '');
  assert.equal(sanitizeSettings({ autoClips: 'every' }).autoClips, 'every');
  assert.equal(sanitizeSettings({ autoClips: 'nesmysl' }).autoClips, 'multi');
  assert.equal(sanitizeSettings({ gsiToken: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }).gsiToken, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  assert.equal(sanitizeSettings({ gsiToken: 'kr' }).gsiToken, '', 'moc krátký token se zahodí');
  const hook = 'https://discord.com/api/webhooks/123456789/AbC-def_GHI';
  assert.equal(sanitizeSettings({ discordWebhook: ` ${hook} ` }).discordWebhook, hook);
  assert.equal(sanitizeSettings({ discordWebhook: 'https://example.com/api/webhooks/1/x' }).discordWebhook, '', 'jen Discord');
  assert.equal(isDiscordWebhook('https://discordapp.com/api/webhooks/1/x_y'), true);
  assert.equal(isDiscordWebhook('http://discord.com/api/webhooks/1/x'), false, 'jen https');
});

test('zkratky na ovladači: části Pad*, kódy pro pomocníka, záznam z Gamepad API', () => {
  const combo = parseHotkey('PadRB+PadBack');
  assert.ok(combo, 'ovladač je platná zkratka');
  assert.deepEqual(combo.pad, ['PadRB', 'PadBack'], 'pevné pořadí tlačítek');
  assert.equal(formatHotkey(combo), 'PadRB+PadBack');
  assert.ok(!isSimpleHotkey(combo), 'ovladač jde jen přes pomocníka');
  assert.deepEqual(hotkeyVks(combo), [PAD_VK_BASE + 0x0200, PAD_VK_BASE + 0x0020]);
  assert.equal(hotkeyLabel('PadBack+PadRB'), '🎮 RB + View', 'pevné pořadí jako u kláves');
  assert.equal(parseHotkey('Ctrl+PadA'), null, 'modifikátory klávesnice se s ovladačem nekombinují');
  assert.equal(parseHotkey('PadFoo'), null);
  assert.deepEqual(hotkeyVks(parseHotkey('F8+PadA')), [0x77, PAD_VK_BASE + 0x1000], 'klávesa + ovladač dohromady jde');
  assert.equal(partFromGamepadButton(5), 'PadRB');
  assert.equal(partFromGamepadButton(40), null);
  // Záznam: tlačítka držená na ovladači, hotovo po puštění všech.
  const r = new HotkeyRecorder();
  assert.equal(r.padState([8, 5]), null, 'ještě drží');
  assert.equal(formatHotkey(r.current()), 'PadRB+PadBack');
  assert.equal(r.padState([5]), null, 'jedno pořád drží');
  assert.equal(formatHotkey(r.padState([])), 'PadRB+PadBack');
  // Ovladač zahodí modifikátory klávesnice, které hráč drží omylem.
  r.keyDown('ShiftLeft');
  r.padState([0]);
  r.keyUp('ShiftLeft');
  assert.equal(formatHotkey(r.padState([])), 'PadA');
});

test('výkon appky: tři profily, neplatná hodnota = vyvážený, řazení knihovny', () => {
  assert.equal(sanitizeSettings({}).performance, 'balanced');
  assert.equal(sanitizeSettings({ performance: 'low' }).performance, 'low');
  assert.equal(sanitizeSettings({ performance: 'turbo' }).performance, 'balanced');
  assert.equal(performanceProfile('nesmysl'), PERFORMANCE.balanced);
  assert.ok(PERFORMANCE.low.gamePollMs > PERFORMANCE.balanced.gamePollMs && PERFORMANCE.balanced.gamePollMs > PERFORMANCE.high.gamePollMs, 'úsporný se ptá nejméně často');
  assert.ok(PERFORMANCE.low.helperFastMs > PERFORMANCE.high.helperFastMs);
  assert.equal(PERFORMANCE.low.hoverPreview, false);
  assert.equal(PERFORMANCE.balanced.hoverPreview, true);
  assert.equal(sanitizeSettings({ clipsSort: 'longest' }).clipsSort, 'longest');
  assert.equal(sanitizeSettings({ clipsSort: 'x' }).clipsSort, 'newest');
  assert.equal(sanitizeSettings({ lastVersion: '0.7.0' }).lastVersion, '0.7.0');
  assert.equal(sanitizeSettings({ lastVersion: 'abc' }).lastVersion, '');
});
