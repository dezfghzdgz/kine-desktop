import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickScreenSource } from '../dist/esm/displayPick.js';

const displays = [
  { id: '111', primary: true },
  { id: '222', primary: false },
];

test('monitor: vybraný podle display_id, jinak hlavní', () => {
  const sources = [
    { id: 'screen:0', display_id: '111' },
    { id: 'screen:1', display_id: '222' },
  ];
  assert.equal(pickScreenSource(sources, displays, '222')?.id, 'screen:1');
  assert.equal(pickScreenSource(sources, displays, '')?.id, 'screen:0');
  // Odpojený monitor z nastavení -> hlavní, ne chyba.
  assert.equal(pickScreenSource(sources, displays, '999')?.id, 'screen:0');
});

test('monitor: Windows bez display_id - podle pořadí monitorů', () => {
  const sources = [
    { id: 'screen:0', display_id: '' },
    { id: 'screen:1', display_id: '' },
  ];
  assert.equal(pickScreenSource(sources, displays, '222')?.id, 'screen:1');
  assert.equal(pickScreenSource(sources, displays, '')?.id, 'screen:0');
  // Hlavní monitor druhý v pořadí.
  const swapped = [{ id: '111', primary: false }, { id: '222', primary: true }];
  assert.equal(pickScreenSource(sources, swapped, '')?.id, 'screen:1');
});

test('monitor: pořadí se nepoužije, když display_id někde je (nepasoval by)', () => {
  const sources = [
    { id: 'screen:0', display_id: '111' },
    { id: 'screen:1', display_id: '' },
  ];
  assert.equal(pickScreenSource(sources, displays, '222')?.id, 'screen:0');
  assert.equal(pickScreenSource([], displays, '222'), null);
});
