import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { tableInputError, tableTransitionError } from '../services/tableValidation.js';

test('tables reject zero, negative, fractional and malformed seating or numbers', () => {
  for (const value of [0, -2, 1.5, '', null, 'NaN', true, 2147483648]) {
    assert.ok(tableInputError({ numero: value }, true));
    assert.ok(tableInputError({ capacidad: value }));
  }
  assert.equal(tableInputError({ numero: '12', capacidad: '8' }, true), null);
  assert.equal(tableInputError({ ubicacion_id: null, activo: false }), null);
});

test('active orders prevent hiding, freeing or reserving a table', () => {
  for (const patch of [{ activo: 0 }, { activo: false }, { estado: 'Libre' }, { estado: 'Reservada' }]) {
    assert.ok(tableTransitionError({ pedidos_activos: 1 }, patch));
  }
  assert.equal(tableTransitionError({ pedidos_activos: 1 }, { capacidad: 8, estado: 'Cuenta' }), null);
  assert.ok(tableTransitionError({ pedidos_activos: 0 }, { estado: 'Cuenta' }));
});

let current, duplicate, calls;
const conn = {
  beginTransaction: async () => calls.push('begin'),
  commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
  query: async sql => { calls.push(sql); if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]]; return sql.startsWith('SELECT id FROM mesas WHERE numero') ? [duplicate ? [{ id: 9 }] : []] : [[]]; },
};
mock.module('../db.js', { namedExports: { pool: { getConnection: async () => conn } } });
mock.module('../middleware/auth.js', { namedExports: { verifyRole: () => (_req, _res, next) => next() } });
mock.module('../services/audit.js', { namedExports: { safeLogAudit: async () => {} } });
mock.module('../services/tableState.js', { namedExports: { getMesaPayload: async () => current, listMesas: async () => [], emitMesaRealtime: async () => {} } });
const { default: router } = await import('../routes/mesas.js');
async function edit(body, table, isDuplicate = false) {
  calls = []; current = table; duplicate = isDuplicate;
  const route = router.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.put).route;
  const result = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await route.stack.at(-1).handle({ body, params: { id: '1' }, user: {} }, result);
  return result;
}
test('table edit locks before checking active orders and rolls back a forbidden deactivation', async () => {
  const result = await edit({ activo: 0 }, { id: 1, numero: 1, activo: 1, pedidos_activos: 2 });
  assert.equal(result.code, 409);
  assert.match(calls[calls.indexOf('begin') + 1], /FOR UPDATE/);
  assert.ok(!calls.some(sql => sql.startsWith('UPDATE')));
  assert.ok(calls.includes('rollback'));
  assert.match(calls.at(-2), /RELEASE_LOCK/);
  assert.equal(calls.at(-1), 'release');
});
test('reactivating a table checks its existing number for duplicates', async () => {
  const result = await edit({ activo: 1 }, { id: 1, numero: 1, activo: 0, pedidos_activos: 0 }, true);
  assert.equal(result.code, 409);
  assert.ok(!calls.includes('commit'));
});
test('editing a missing table returns 404 and releases its transaction', async () => {
  assert.equal((await edit({ capacidad: 4 }, null)).code, 404);
  assert.ok(calls.includes('rollback'));
  assert.match(calls.at(-2), /RELEASE_LOCK/);
  assert.equal(calls.at(-1), 'release');
});

test('inactive states and renumbering during service are protected', () => {
  assert.ok(tableTransitionError({ activo: 0, pedidos_activos: 0 }, { estado: 'Reservada' }));
  assert.equal(tableTransitionError({ activo: 0, pedidos_activos: 0 }, { activo: 1, estado: 'Reservada' }), null);
  assert.ok(tableTransitionError({ numero: 3, activo: 1, pedidos_activos: 1 }, { numero: 4 }));
  assert.equal(tableTransitionError({ numero: 3, activo: 1, pedidos_activos: 1 }, { numero: 3, capacidad: 6 }), null);
});
