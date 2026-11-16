import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrderItem, orderTotal, fullPaymentAmount } from '../services/orderAmounts.js';

const product = { id: 7, precio: '4.50' };

test('uses the catalog price even when the client changes it', () => {
  const item = normalizeOrderItem({ cantidad: 2, precio: -100, modificadores: [
    { nombre: 'Leche extra', tipo: 'EXTRA', precio_extra: '0.50' },
  ] }, product);
  assert.equal(item.precio, 4.5);
  assert.equal(orderTotal([item], '10'), 11);
});

test('rejects fractional, negative and non-finite quantities and extras', () => {
  for (const cantidad of [0, -1, 1.5, 'abc', Infinity, null]) {
    assert.throws(() => normalizeOrderItem({ cantidad }, product));
  }
  for (const precio_extra of [-1, Infinity, 'abc']) {
    assert.throws(() => normalizeOrderItem({ cantidad: 1, modificadores: [{ nombre: 'Extra', precio_extra }] }, product));
  }
});

test('rounds service once, in cents, and accepts decimal comma configuration', () => {
  const item = normalizeOrderItem({ cantidad: 3 }, { id: 1, precio: '0.10' });
  assert.equal(orderTotal([item], '12,5'), 0.34);
  assert.equal(orderTotal([item]), 0.3);
});

test('a full payment cannot close an underpaid or overpaid account', () => {
  for (const amount of [0, -1, 1, 9.99, 10.01, 'abc', Infinity]) {
    assert.throws(() => fullPaymentAmount(amount, '10.00'));
  }
  assert.equal(fullPaymentAmount(undefined, '10.00'), 10);
  assert.equal(fullPaymentAmount('10.00', 10), 10);
});

test('catalog extras always use the database price, custom extras are bounded', async () => {
  const { buildExtrasCatalog, MAX_CUSTOM_EXTRA } = await import('../services/orderAmounts.js');
  const extrasCatalog = buildExtrasCatalog([{ nombre: 'Extra queso', precio: '1.00', tipo: 'EXTRA' }]);
  const item = normalizeOrderItem({ cantidad: 1, modificadores: [
    { nombre: 'extra  QUESO.', tipo: 'NOTA', precio_extra: 0 },
    { nombre: 'Salsa de la casa', tipo: 'EXTRA', precio_extra: 0.4 },
  ] }, product, { extrasCatalog });
  assert.deepEqual(item.modificadores[0], { nombre: 'Extra queso', tipo: 'EXTRA', precio_extra: 1 });
  assert.equal(item.modificadores[1].precio_extra, 0.4);
  assert.equal(orderTotal([item]), 5.9);
  assert.throws(() => normalizeOrderItem({ cantidad: 1, modificadores: [{ nombre: 'Algo', precio_extra: MAX_CUSTOM_EXTRA + 1 }] }, product, { extrasCatalog }));
  assert.throws(
    () => normalizeOrderItem({ cantidad: 1, modificadores: [{ nombre: 'Extra queso', precio_extra: 0 }] }, product, { extrasCatalog, strictPrices: true }),
    error => error.status === 409,
  );
});
