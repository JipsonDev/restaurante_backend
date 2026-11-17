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
