import test from 'node:test';
import assert from 'node:assert/strict';
import { requireExpressPayment, historyDate } from '../services/expressPolicy.js';
test('history validates real calendar days', () => {
  assert.equal(historyDate('2026-09-12'), '2026-09-12');
  assert.equal(historyDate('2024-02-29'), '2024-02-29');
  for (const value of [null, '', '2026-02-29', '2026-13-01', '2026-09-31', '2026-9-1']) assert.throws(() => historyDate(value));
});
test('a partial payment cannot authorize pickup delivery; full payment can', () => {
  assert.throws(() => requireExpressPayment({ mesa_id: null, estado: 'LISTO', abonado: 5 }, 'ENTREGADO'), /Cobra el total/);
  assert.doesNotThrow(() => requireExpressPayment({ mesa_id: null, estado: 'PAGADO' }, 'ENTREGADO'));
  assert.doesNotThrow(() => requireExpressPayment({ mesa_id: 1, estado: 'LISTO' }, 'ENTREGADO'));
  assert.doesNotThrow(() => requireExpressPayment({ mesa_id: null, estado: 'PENDIENTE' }, 'PREPARANDO'));
});
