import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let connection;
mock.module('../db.js', { namedExports: { pool: {
  getConnection: async () => connection,
  query: (...args) => connection.query(...args),
} } });
mock.module('../middleware/auth.js', { namedExports: {
  verifyToken: (_req, _res, next) => next(),
  verifyRole: () => (_req, _res, next) => next(),
} });
const { enqueuePrint, claimPrintJob, finishPrintJob } = await import('../services/printQueue.js');
const { verifyPrintAgent } = await import('../routes/impresiones.js');

test('queued ticket contains an immutable snapshot and uses the caller transaction', async () => {
  let saved;
  const payload = { pedido_id: 1, modulo: 'cocina', texto: '2x Cafe' };
  const conn = { query: async (sql, params) => { saved = { sql, params }; } };
  const job = await enqueuePrint(conn, payload);
  payload.texto = 'changed';
  assert.equal(JSON.parse(saved.params[3]).texto, '2x Cafe');
  assert.equal(saved.params[0], job.id);
  assert.equal(job.estado, 'PENDIENTE');
  await assert.rejects(enqueuePrint(conn, { texto: '' }), /vacia/);
});

test('claim locks pending jobs, preserves the stored ticket, and commits before returning', async () => {
  const events = [];
  connection = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'), release: () => events.push('release'),
    query: async (sql, params) => {
      events.push({ sql, params });
      if (sql.includes('SELECT id, payload')) return [[{ id: 'job1', payload: '{"texto":"Cafe"}' }]];
      return [{}];
    },
  };
  const job = await claimPrintJob('cocina');
  assert.equal(job.payload.texto, 'Cafe');
  assert.match(job.claim_token, /^[a-f0-9-]{36}$/);
  const select = events.find((event) => event.sql?.includes('SELECT id, payload'));
  assert.match(select.sql, /estado = 'PENDIENTE'/);
  assert.match(select.sql, /FOR UPDATE/);
  assert.deepEqual(events.slice(-2), ['commit', 'release']);
  assert.ok(events.some((event) => event.sql?.includes("SET estado = 'REVISAR'")), 'expired dispatches require review, never blind reprint');
});

test('failed claims rollback and release their connection', async () => {
  const events = [];
  connection = {
    beginTransaction: async () => {}, query: async () => { throw new Error('database offline'); },
    rollback: async () => events.push('rollback'), release: () => events.push('release'),
  };
  await assert.rejects(claimPrintJob('cocina'), /offline/);
  assert.deepEqual(events, ['rollback', 'release']);
});

test('only the holder of the claim can ACK and simulation remains a separate result', async () => {
  let sent;
  connection = { query: async (sql, params) => {
    if (sql.startsWith('SELECT payload')) return [[{ payload: '{}' }]]; // comprobante de caja: no es de caja, no toca pagos
    sent = { sql, params }; return [{ affectedRows: params[3] === 'right' ? 1 : 0 }];
  } };
  assert.equal(await finishPrintJob('job1', 'wrong', 'ENVIADO'), false);
  assert.equal(await finishPrintJob('job1', 'right', 'SIMULADO'), true);
  assert.match(sent.sql, /claim_token = \?/);
  assert.equal(sent.params[0], 'SIMULADO');
  await assert.rejects(finishPrintJob('job1', 'right', 'PENDIENTE'), /invalido/);
});

test('queue agent endpoints require their separate server secret', (t) => {
  const previous = process.env.PRINT_AGENT_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.PRINT_AGENT_TOKEN; else process.env.PRINT_AGENT_TOKEN = previous; });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() {} };
  process.env.PRINT_AGENT_TOKEN = 'a-secret-for-test';
  verifyPrintAgent({ headers: {} }, res, assert.fail);
  assert.equal(res.statusCode, 401);
  verifyPrintAgent({ headers: { 'x-print-token': 'a-secret-for-test' } }, res, () => { res.statusCode = 200; });
  assert.equal(res.statusCode, 200);
  delete process.env.PRINT_AGENT_TOKEN;
  verifyPrintAgent({ headers: {} }, res, assert.fail);
  assert.equal(res.statusCode, 503);
});
