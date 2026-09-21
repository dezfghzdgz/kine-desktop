import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DEFAULT_SETTINGS, isAccelerator, suggestedMbps } from '../dist/esm/settingsSchema.js';
import { acceleratorFromKey, acceleratorLabel } from '../dist/esm/accelerator.js';
import { clipFileBase, defaultClipTitle, gameHashtag, safeFilePart, formatDuration } from '../dist/esm/clipNaming.js';
import { translate, langFromLocale } from '../dist/esm/i18n.js';

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

test('accelerator: klávesy a modifikátory', () => {
  assert.ok(isAccelerator('F8'));
  assert.ok(isAccelerator('Alt+Z'));
  assert.ok(isAccelerator('Ctrl+Shift+num5'));
  assert.ok(!isAccelerator('Ctrl'));
  assert.ok(!isAccelerator('Foo+F8'));
  assert.equal(acceleratorFromKey({ code: 'F8', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), 'F8');
  assert.equal(acceleratorFromKey({ code: 'KeyS', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }), 'Ctrl+Shift+S');
  assert.equal(acceleratorFromKey({ code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }), null);
  assert.equal(acceleratorLabel('Ctrl+Shift+S'), 'Ctrl + Shift + S');
});

test('názvy klipů a souborů', () => {
  const at = new Date(2026, 8, 21, 20, 14, 5);
  assert.equal(clipFileBase(at, 'Counter-Strike 2'), 'Kine 2026-09-21 20-14-05 Counter-Strike 2');
  assert.equal(clipFileBase(at, 'A:B/C*D?'), 'Kine 2026-09-21 20-14-05 ABCD');
  assert.equal(defaultClipTitle(at, 'CS2', 'cs'), 'CS2 · klip 21. 9. 20:14');
  assert.equal(defaultClipTitle(at, null, 'en'), 'Clip 21. 9. 20:14');
  assert.equal(gameHashtag('Counter-Strike 2'), 'counterstrike2');
  assert.equal(gameHashtag("Baldur's Gate 3"), 'baldursgate3');
  assert.equal(safeFilePart('   '), 'klip');
  assert.equal(formatDuration(75), '1:15');
});

test('překlady: dosazení proměnných a jazyk ze systému', () => {
  assert.equal(translate('cs', 'toastClipSaved', { seconds: 30 }), 'Klip uložen · 30 s');
  assert.equal(translate('en', 'toastClipSaved', { seconds: 30 }), 'Clip saved · 30 s');
  assert.equal(langFromLocale('cs-CZ'), 'cs');
  assert.equal(langFromLocale('sk'), 'cs');
  assert.equal(langFromLocale('en-US'), 'en');
  assert.equal(suggestedMbps(1080, 60), 12);
});
