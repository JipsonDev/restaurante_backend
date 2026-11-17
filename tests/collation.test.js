import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
mock.module('../db.js', { namedExports: { pool: {} } });
const { collationReport, unifyCollation, TARGET_COLLATION } = await import('../services/collation.js');

// Base falsa: responde a INFORMATION_SCHEMA y registra los ALTER.
function fakeDb({ dbCollation = 'utf8mb4_0900_ai_ci', tables = [], columns = [], kept = {}, failOn = [], lock = 1 } = {}) {
  const log = [];
  const conn = {
    log,
    escape: v => `'${String(v).replace(/'/g, "''")}'`,
    async query(sql, params = []) {
      log.push(sql.replace(/\s+/g, ' ').trim());
      if (/GET_LOCK/.test(sql)) return [[{ acquired: lock }]];
      if (/RELEASE_LOCK|foreign_key_checks/.test(sql)) return [[]];
      if (/SCHEMATA/.test(sql)) return [[{ charset: 'utf8mb4', collation: dbCollation }]];
      if (/INFORMATION_SCHEMA.TABLES/.test(sql)) return [tables];
      if (/NOT IN \('utf8mb4'/.test(sql)) return [kept[params[0]] || []];
      if (/INFORMATION_SCHEMA.COLUMNS/.test(sql)) return [columns];
      if (/SELECT DATABASE\(\) AS db/.test(sql)) return [[{ db: 'morena' }]];
      if (/^\s*ALTER TABLE/.test(sql) && failOn.some(t => sql.includes(`\`${t}\``))) throw new Error('Duplicate entry');
      return [[]];
    },
    release() {},
  };
  return { conn, log, getConnection: async () => conn, query: (...a) => conn.query(...a), escape: conn.escape };
}

test('report lists tables and utf8 columns with another collation', async () => {
  const db = fakeDb({
    tables: [{ name: 'pagos', collation: TARGET_COLLATION }, { name: 'pedidos', collation: 'utf8mb4_bin' }],
    columns: [{ tableName: 'pagos', name: 'metodo', collation: 'utf8mb4_bin' }],
  });
  const report = await collationReport(db);
  assert.equal(report.ok, false);
  assert.deepEqual(report.tables, ['pagos', 'pedidos']);
  assert.equal(report.columns[0].column, 'metodo');
});

test('report is ok when everything already uses the target collation', async () => {
  const db = fakeDb({ dbCollation: TARGET_COLLATION, tables: [{ name: 'pagos', collation: TARGET_COLLATION }] });
  assert.equal((await collationReport(db)).ok, true);
});

test('conversion keeps ascii_bin columns inside the same ALTER (idempotency keys stay case-sensitive)', async () => {
  const db = fakeDb({
    tables: [{ name: 'order_requests', collation: 'utf8mb4_bin' }],
    kept: { order_requests: [{ name: 'clave', type: 'varchar(100)', charset: 'ascii', collation: 'ascii_bin', nullable: 'NO', def: null, comment: '', extra: '' }] },
  });
  const result = await unifyCollation(db, { log: {} });
  assert.deepEqual(result.converted, ['order_requests']);
  assert.equal(result.database, true);
  const alter = db.log.find(q => q.startsWith('ALTER TABLE'));
  assert.match(alter, /CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, MODIFY `clave` varchar\(100\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL$/);
  assert.ok(db.log.some(q => q === 'SET SESSION foreign_key_checks = 1'), 'foreign key checks are restored');
});

test('a failing table is reported and the rest still converts', async () => {
  const db = fakeDb({ dbCollation: TARGET_COLLATION, tables: [{ name: 'a', collation: 'utf8mb4_bin' }, { name: 'b', collation: 'utf8mb4_bin' }], failOn: ['a'] });
  const result = await unifyCollation(db, { log: {} });
  assert.deepEqual(result.converted, ['b']);
  assert.equal(result.failed[0].table, 'a');
});

test('another instance holding the lock skips the conversion', async () => {
  const db = fakeDb({ tables: [{ name: 'a', collation: 'utf8mb4_bin' }], lock: 0 });
  const result = await unifyCollation(db, { log: {} });
  assert.equal(result.skipped, true);
  assert.ok(!db.log.some(q => q.startsWith('ALTER')));
});
