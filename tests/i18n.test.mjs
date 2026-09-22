import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LANG_NAMES, LOCALES, translate, langFromLocale } from '../dist/esm/i18n.js';

const LANGS = Object.keys(DICTS);

test('všech osm slovníků má stejné klíče jako angličtina', () => {
  const enKeys = Object.keys(DICTS.en).sort();
  assert.ok(enKeys.length > 200);
  for (const lang of LANGS) {
    const keys = Object.keys(DICTS[lang]).sort();
    const missing = enKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !enKeys.includes(k));
    assert.deepEqual(missing, [], `${lang}: chybí klíče`);
    assert.deepEqual(extra, [], `${lang}: klíče navíc`);
  }
});

test('překlady mají stejné {proměnné} jako angličtina a nejsou prázdné', () => {
  const vars = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const lang of LANGS) {
    for (const [key, text] of Object.entries(DICTS[lang])) {
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${lang}.${key} je prázdný`);
      assert.equal(vars(text), vars(DICTS.en[key]), `${lang}.${key}: jiné proměnné než v angličtině`);
    }
  }
});

test('názvy jazyků, locale a dosazování', () => {
  for (const lang of LANGS) {
    assert.ok(LANG_NAMES[lang], `${lang}: chybí název`);
    assert.match(LOCALES[lang], /^[a-z]{2}-[A-Z]{2}$/);
  }
  assert.equal(translate('cs', 'trimWorking', { percent: 42 }), 'Ukládám… 42 %');
  assert.equal(translate('en', 'barClipsCount', { count: 3 }), 'Clips (3)');
  assert.equal(langFromLocale('cs-CZ'), 'cs');
  assert.equal(langFromLocale('pt-BR'), null);
});
