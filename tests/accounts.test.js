import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { allocateCents, buildAccountSplit } from '../services/accountLogic.js';
mock.module('../db.js', { namedExports: { pool: {} } });
const { decorateAccount, migrateRounds } = await import('../services/rounds.js');
const { mergeAccounts, lockWholeAccount } = await import('../services/accounts.js');

const bill = { total: 13.21, items: [
  { id: 1, cantidad: 2, precio: 4, modificadores: [{ precio_extra: 1 }] },
  { id: 2, cantidad: 1, precio: 2, modificadores: [] },
] };
const group = (id, qty = 1) => ({ items: [{ detalle_pedido_id: id, cantidad: qty }] });

test('equal division conserves every cent and ignores forged client amounts', () => {
  const result = buildAccountSplit(bill, { partes: 3, divisions: [{ monto: 100 }] });
  assert.deepEqual(result.map((p) => p.monto), [4.41, 4.4, 4.4]);
});

test('item split includes modifiers and apportions the stored service, including remainder', () => {
  const result = buildAccountSplit(bill, { mode: 'items', divisions: [group(1, 2), group(2)] });
  assert.deepEqual(result.map((p) => p.monto), [11.01, 2.2]);
});

test('item split rejects foreign details, over-assignment, missing units and fractional quantities', () => {
  for (const divisions of [[group(999), group(1,2)], [group(1,2),group(1)], [group(1),group(2)], [group(1,0.5),group(2)]]) {
    assert.throws(() => buildAccountSplit(bill, { mode: 'items', divisions }));
  }
});

test('division rejects empty parties, closed zero balances and unsupported modes', () => {
  for (const partes of [1, 51, 2.5, NaN]) assert.throws(() => buildAccountSplit(bill, { partes }));
  assert.throws(() => buildAccountSplit({ ...bill, total: 0 }));
  assert.throws(() => buildAccountSplit(bill, { mode: 'bogus' }));
  assert.throws(() => buildAccountSplit(bill, { mode: 'items', divisions: [group(1,2), { items: [] }] }));
});

test('cent allocation conserves totals across different amounts and group sizes', () => {
  for (const total of [1, 2, 100, 1321, 9999999999]) for (let count = 2; count <= 50; count++) {
    const weights = Array.from({ length: count }, (_, i) => (i + 1) * 999999);
    const result = allocateCents(total, weights);
    assert.equal(result.reduce((sum, amount) => sum + amount, 0), total);
    assert.ok(result.every((amount) => Number.isSafeInteger(amount) && amount >= 0));
  }
});

test('a paid account still exposes pending kitchen rounds and isolates each round items', () => {
  const account = decorateAccount({ id: 1, estado: 'PAGADO' }, [{ id: 9, ronda_id: 10 }, { id: 8, ronda_id: 11 }], [{ id: 10, estado: 'LISTO' }, { id: 11, estado: 'PENDIENTE' }]);
  assert.equal(account.estado_cobro, 'PAGADO');
  assert.equal(account.estado_cocina, 'PENDIENTE');
  assert.equal(account.pendiente_entrega, true);
  assert.deepEqual(account.rondas.map((r) => r.items.map((i) => i.id)), [[9],[8]]);
});

test('whole-account locks include all unpaid source and destination orders, in consistent order', async () => {
  const calls = [];
  const orders = [{ id: 1, mesa_id: 4, estado: 'LISTO' }, { id: 2, mesa_id: 4, estado: 'PENDIENTE' }, { id: 3, mesa_id: 2, estado: 'ENTREGADO' }];
  const conn = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT id, mesa_id FROM pedidos')) return [[orders[0]]];
    if (sql.startsWith('SELECT id, activo FROM mesas')) return [[{ id: 2, activo: 1 }, { id: 4, activo: 1 }]];
    return [orders];
  } };
  const result = await lockWholeAccount(conn, 1, 2);
  assert.equal(result.orders.length, 3);
  assert.deepEqual(calls[1].args, [[2, 4]]);
  assert.match(calls[1].sql, /ORDER BY id FOR UPDATE/);
  assert.match(calls[2].sql, /estado NOT IN \('PAGADO', 'CANCELADO'\).*ORDER BY id FOR UPDATE/);
});

test('whole-account rejects a table change between the initial read and the lock', async () => {
  const conn = { query: async (sql) => {
    if (sql.startsWith('SELECT id, mesa_id FROM pedidos')) return [[{ id: 1, mesa_id: 1 }]];
    if (sql.startsWith('SELECT id, activo FROM mesas')) return [[{ id: 1, activo: 1 }]];
    return [[{ id: 1, mesa_id: 2, estado: 'PENDIENTE' }]];
  } };
  await assert.rejects(lockWholeAccount(conn, 1), /cambio de mesa/);
});

test('merging accounts preserves round states and consumed stock, and invalidates old splits', async () => {
  const calls = [];
  const conn = { query: async (sql, args) => { calls.push({ sql, args }); return sql.startsWith('SELECT id, estado') ? [[{ id: 7, estado: 'LISTO' }, { id: 8, estado: 'PENDIENTE' }]] : [[]]; } };
  await mergeAccounts(conn, [{ id: 1, estado: 'LISTO', total: '10.11' }, { id: 2, estado: 'PENDIENTE', total: '3.10' }], 1);
  assert.equal(calls.find((c) => c.sql.startsWith('UPDATE pedidos SET total')).args[0], 13.21);
  assert.deepEqual(calls.find((c) => c.sql.startsWith('UPDATE pedido_rondas')).args, [1, [2]]);
  assert.ok(calls.some((c) => c.sql.startsWith('DELETE FROM cuenta_divisiones')));
  assert.ok(calls.some((c) => /estado = 'CANCELADO', total = 0/.test(c.sql)));
  assert.ok(!calls.some((c) => /SET .*inventario_descontado|SET .*stock/.test(c.sql)));
  assert.equal(calls.at(-1).args[0], 'PENDIENTE');
});

test('merging rejects paid accounts and active payments before changing any data', async () => {
  let writes = 0;
  const conn = { query: async (sql) => { if (!sql.startsWith('SELECT')) writes++; return [[{ id: 99 }]]; } };
  await assert.rejects(mergeAccounts(conn, [{ id: 1, estado: 'PAGADO' },{ id: 2, estado: 'LISTO' }],1), /abiertas/);
  await assert.rejects(mergeAccounts(conn, [{ id: 1, estado: 'LISTO' },{ id: 2, estado: 'LISTO' }],1), /pagos activos/);
  assert.equal(writes, 0);
});

test('migration can restart without overwriting already assigned rounds or adding the column twice', async () => {
  const calls = [];
  let columnExists = false;
  const db = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SHOW COLUMNS')) return [columnExists ? [{ Field: 'ronda_id' }] : []];
    if (sql.startsWith('ALTER TABLE')) columnExists = true;
    return [[]];
  } };
  await migrateRounds(db); await migrateRounds(db);
  assert.equal(calls.filter((sql) => sql.startsWith('ALTER TABLE')).length, 1);
  for (const sql of calls.filter((sql) => sql.startsWith('UPDATE detalle_pedidos'))) assert.match(sql, /WHERE dp.ronda_id IS NULL/);
  assert.ok(calls.some((sql) => /INSERT IGNORE/.test(sql)));
});
