import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

process.env.JWT_SECRET = 'test-only-auth-signing-secret-not-used-in-production';
let queryCount = 0;
let databaseFails = false;
let account = null;
let pinUser = null;
let pinCalls = [];
const passwordHash = await bcrypt.hash('test-password', 4);
mock.module('../db.js', { namedExports: { pool: { query: async sql => {
  queryCount += 1;
  if (databaseFails) throw Object.assign(new Error('private database details'), { code: 'ER_BAD_DB_ERROR' });
  if (sql.startsWith('SELECT id, nombre')) return [account ? [account] : []];
  return sql.startsWith('INSERT') ? [{ insertId: 999 }] : [[]];
} } } });
mock.module('../services/quickPin.js', { namedExports: {
  ensurePinColumn: async () => {},
  hashUniquePin: async () => 'test-only-hash',
  clearPinFailures: async () => {},
  verifyQuickPin: async (args) => { pinCalls.push(args); return pinUser; },
} });

let fixtureId = 0;
async function withServer(run) {
  queryCount = 0;
  databaseFails = false;
  account = null;
  pinUser = null;
  pinCalls = [];
  const { default: router } = await import(`../routes/auth.js?fixture=${++fixtureId}`);
  const app = express();
  app.use(express.json());
  app.use('/auth', router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: 'Solicitud inválida.' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/auth`;
  const post = async (path, body, role) => {
    const headers = { 'Content-Type': 'application/json' };
    if (role) headers.Authorization = `Bearer ${jwt.sign({ id: 1, rol: role }, process.env.JWT_SECRET)}`;
    return fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  };
  try { await run(post); } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('register refuses anonymous and non-admin requests before accessing the database', async () => {
  await withServer(async post => {
    const body = { nombre: 'Prueba', correo: 'test@example.com', password: 'test-password', rol: 'admin' };
    assert.equal((await post('register', body)).status, 401);
    assert.equal((await post('register', body, 'mesero')).status, 403);
    assert.equal(queryCount, 0);
    assert.equal((await post('register', body, 'admin')).status, 201);
  });
});

test('login rejects malformed input and PIN suffixes without querying the database', async () => {
  await withServer(async post => {
    for (const body of [null, {}, { correo: [], password: 'test' }, { correo: 'a@b.com', password: {} }]) {
      assert.equal((await post('login', body)).status, 400);
    }
    assert.equal((await post('login-pin', { correo: 'a@b.com', pin: '1234extra' })).status, 400);
    assert.equal((await post('login-pin', { pin: '1234' })).status, 400);
    assert.equal(pinCalls.length, 0);
    assert.equal((await post('setup-pin', { correo: 'a@b.com', password: 'test', pin: ['1234'] })).status, 400);
    assert.equal(queryCount, 0);
  });
});

test('login responses never expose database names or diagnostic details', async () => {
  await withServer(async post => {
    databaseFails = true;
    const response = await post('login', { correo: 'test@example.com', password: 'test' });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /MySQL|DB_NAME|private database|\.env/);
  });
});

test('password login and PIN setup share a bounded attempt budget and return Retry-After', async () => {
  await withServer(async post => {
    const credentials = { correo: 'test@example.com', password: 'wrong-password' };
    for (let index = 0; index < 10; index += 1) {
      const path = index % 2 ? 'setup-pin' : 'login';
      assert.equal((await post(path, { ...credentials, pin: '1234' })).status, 401);
    }
    const queriesBeforeBlock = queryCount;
    const blocked = await post('login', credentials);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    assert.equal(queryCount, queriesBeforeBlock);
  });
});

test('valid password still issues a session or requests first-time PIN setup without leaking secrets', async () => {
  await withServer(async post => {
    account = { id: 5, nombre: 'Prueba', correo: 'test@example.com', rol: 'mesero', password_hash: passwordHash, pin_hash: 'configured' };
    const response = await post('login', { correo: 'test@example.com', password: 'test-password' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const session = await response.json();
    assert.equal(jwt.verify(session.token, process.env.JWT_SECRET).id, 5);
    assert.equal(session.user.password_hash, undefined);
    account.pin_hash = null;
    const setup = await (await post('login', { correo: 'test@example.com', password: 'test-password' })).json();
    assert.equal(setup.requires_pin_setup, true);
    assert.equal(setup.token, undefined);
    const created = await post('setup-pin', { correo: 'test@example.com', password: 'test-password', pin: '0123' });
    assert.equal(created.status, 200);
    assert.equal(jwt.verify((await created.json()).token, process.env.JWT_SECRET).id, 5);
  });
});

test('PIN login blocks after five failures without accepting a longer PIN prefix', async () => {
  await withServer(async post => {
    for (let index = 0; index < 5; index += 1) assert.equal((await post('login-pin', { correo: 'a@b.com', pin: '1234' })).status, 401);
    const response = await post('login-pin', { correo: 'a@b.com', pin: '1234' });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('Retry-After')) > 0);
  });
});

test('PIN login is checked against the chosen account, never against every user', async () => {
  await withServer(async post => {
    pinUser = { id: 9, nombre: 'Ana', correo: 'ana@b.com', rol: 'mesero' };
    const response = await post('login-pin', { correo: 'ana@b.com', pin: '0123' });
    assert.equal(response.status, 200);
    assert.equal(pinCalls[0].correo, 'ana@b.com');
    assert.equal(jwt.verify((await response.json()).token, process.env.JWT_SECRET).id, 9);
  });
});
