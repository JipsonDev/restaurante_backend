import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PIN_MAX_FAILURES, verifyQuickPin } from '../services/quickPin.js';

// Base de datos falsa con una sola cuenta: simula el bloqueo en SQL.
function fakeDb(user) {
  return {
    query: async (sql, params = []) => {
      if (sql.includes('INFORMATION_SCHEMA')) return [[{ COLUMN_NAME: params[0] }]];
      if (sql.startsWith('SELECT id, nombre, correo, rol, pin_hash')) {
        if (params[0] !== user.correo) return [[]];
        const locked = user.lockedUntil && user.lockedUntil > Date.now();
        return [[{ ...user, pin_bloqueado: locked ? 1 : 0, pin_bloqueado_hasta: user.lockedUntil ? new Date(user.lockedUntil) : null }]];
      }
      if (sql.includes('pin_bloqueado_hasta = DATE_ADD')) { user.pin_fallos = 0; user.lockedUntil = Date.now() + params[0] * 60000; return [{}]; }
      if (sql.startsWith('UPDATE trabajadores SET pin_fallos = ? WHERE')) { user.pin_fallos = params[0]; return [{}]; }
      if (sql.includes('pin_fallos = 0, pin_bloqueado_hasta = NULL')) { user.pin_fallos = 0; user.lockedUntil = null; return [{}]; }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
}

const roles = ['admin', 'mesero'];

test('a wrong PIN locks only that account after the maximum failures', async () => {
  const user = { id: 1, nombre: 'Ana', correo: 'ana@x.com', rol: 'mesero', pin_hash: await bcrypt.hash('1111', 4), pin_fallos: 0 };
  const db = fakeDb(user);
  for (let i = 1; i < PIN_MAX_FAILURES; i += 1) {
    assert.equal(await verifyQuickPin({ correo: 'ana@x.com', pin: '9999', roles, db }), null);
    assert.equal(user.pin_fallos, i);
  }
  await assert.rejects(verifyQuickPin({ correo: 'ana@x.com', pin: '9999', roles, db }), { statusCode: 423 });
  // Bloqueada: ni siquiera el PIN correcto entra mientras dure el bloqueo.
  await assert.rejects(verifyQuickPin({ correo: 'ana@x.com', pin: '1111', roles, db }), { statusCode: 423 });
  user.lockedUntil = Date.now() - 1000;
  const session = await verifyQuickPin({ correo: 'ana@x.com', pin: '1111', roles, db });
  assert.equal(session.id, 1);
  assert.equal(user.pin_fallos, 0);
});

test('a correct PIN resets previous failures and unknown accounts return null', async () => {
  const user = { id: 2, nombre: 'Luis', correo: 'luis@x.com', rol: 'mesero', pin_hash: await bcrypt.hash('2222', 4), pin_fallos: 3 };
  const db = fakeDb(user);
  assert.equal((await verifyQuickPin({ correo: 'luis@x.com', pin: '2222', roles, db })).correo, 'luis@x.com');
  assert.equal(user.pin_fallos, 0);
  assert.equal(await verifyQuickPin({ correo: 'nadie@x.com', pin: '2222', roles, db }), null);
});
