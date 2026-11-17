import test from 'node:test';
import assert from 'node:assert/strict';
import { reportRange, shiftDay } from '../services/reportRange.js';

test('periodos fijos terminan hoy e incluyen el periodo anterior', () => {
  assert.deepEqual(reportRange({ days: '7' }, '2026-11-17'), { from: '2026-11-11', to: '2026-11-17', days: 7, previousFrom: '2026-11-04', previousTo: '2026-11-10' });
  assert.deepEqual(reportRange({ days: 1 }, '2026-03-01'), { from: '2026-03-01', to: '2026-03-01', days: 1, previousFrom: '2026-02-28', previousTo: '2026-02-28' });
  assert.equal(reportRange({}, '2026-11-17').days, 7);
});

test('rango propio: valida fechas, orden, futuro y largo', () => {
  const r = reportRange({ desde: '2026-10-01', hasta: '2026-10-31' }, '2026-11-17');
  assert.deepEqual(r, { from: '2026-10-01', to: '2026-10-31', days: 31, previousFrom: '2026-08-31', previousTo: '2026-09-30' });
  assert.throws(() => reportRange({ desde: '2026-10-31', hasta: '2026-10-01' }, '2026-11-17'), /anterior/);
  assert.throws(() => reportRange({ desde: '2026-02-30', hasta: '2026-03-01' }, '2026-11-17'), /válidas/);
  assert.throws(() => reportRange({ desde: '2026-11-01' }, '2026-11-17'), /válidas/);
  assert.throws(() => reportRange({ desde: '2026-11-01', hasta: '2026-11-18' }, '2026-11-17'), /después de hoy/);
  assert.throws(() => reportRange({ desde: '2025-01-01', hasta: '2026-11-17' }, '2026-11-17'), /un año/);
  assert.throws(() => reportRange({ days: 5 }, '2026-11-17'), /Periodo/);
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});
