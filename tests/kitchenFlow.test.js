import test from 'node:test';
import assert from 'node:assert/strict';
import { roundTransition } from '../services/kitchenFlow.js';

test('kitchen moves rounds forward one step at a time', () => {
  assert.equal(roundTransition('PENDIENTE', 'PREPARANDO', 'cocina').ok, true);
  assert.equal(roundTransition('PREPARANDO', 'LISTO', 'cocina').ok, true);
  assert.equal(roundTransition('PENDIENTE', 'LISTO', 'cocina').ok, false);
});

test('ready can be undone by kitchen or admin, not by waiters', () => {
  assert.deepEqual(roundTransition('LISTO', 'PREPARANDO', 'cocina'), { ok: true, recall: true });
  assert.deepEqual(roundTransition('LISTO', 'PREPARANDO', 'admin'), { ok: true, recall: true });
  assert.equal(roundTransition('LISTO', 'PREPARANDO', 'mesero').ok, false);
});

test('delivered rounds cannot go back to the kitchen', () => {
  assert.equal(roundTransition('ENTREGADO', 'PREPARANDO', 'cocina').ok, false);
  assert.equal(roundTransition('ENTREGADO', 'LISTO', 'admin').ok, false);
});

import { allItemsReady, cleanStation } from '../services/kitchenFlow.js';

test('a round is complete only when every real dish is ready', () => {
  assert.equal(allItemsReady([{ cantidad: 1, listo_at: '2026-11-16 20:00:00' }, { cantidad: 2, listo_at: null }]), false);
  assert.equal(allItemsReady([{ cantidad: 1, listo_at: '2026-11-16 20:00:00' }, { cantidad: 0, listo_at: null }]), true);
  assert.equal(allItemsReady([]), false);
});

test('stations are short, trimmed and capitalised; empty means general kitchen', () => {
  assert.equal(cleanStation('  bar  '), 'Bar');
  assert.equal(cleanStation(''), null);
  assert.equal(cleanStation(null), null);
  assert.equal(cleanStation('x'.repeat(60)).length, 40);
});
