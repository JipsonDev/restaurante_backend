// Run explicitly with: node --experimental-test-module-mocks scripts/verifyOrderRequests.mjs
// Clones only the configured LOCAL database into a disposable database. Never writes to its source.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)) throw new Error('Esta prueba solo admite MySQL local.');
const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const source=process.env.DB_NAME;
if (!/^[A-Za-z0-9_]+$/.test(source)) throw new Error('Nombre de origen invalido.');
const testDb=`codex_order_test_${Date.now()}`;
const admin=await mysql.createConnection(config);
let pool;
try {
  await admin.query(`CREATE DATABASE \`${testDb}\``);
  const [tables]=await admin.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?', [source,'BASE TABLE']);
  for(const {TABLE_NAME:t} of tables) { if(!/^[A-Za-z0-9_]+$/.test(t))throw new Error('Tabla invalida');await admin.query(`CREATE TABLE \`${testDb}\`.\`${t}\` LIKE \`${source}\`.\`${t}\``);await admin.query(`INSERT INTO \`${testDb}\`.\`${t}\` SELECT * FROM \`${source}\`.\`${t}\``); }
  pool=mysql.createPool({...config,database:testDb});
  mock.module('../db.js',{namedExports:{pool}});
  mock.module('../routes/notificaciones.js',{namedExports:{sendPushToUser:async()=>{}}});
  const { ensureStockReservations } = await import('../services/stockReservations.js');
  const {default:orders,initializeOrderSchema,getPedidoCompleto}=await import('../routes/pedidos.js');
  const { ensureOrderRequests } = await import('../services/orderRequests.js');
  const { ensurePrintQueue } = await import('../services/printQueue.js');
  await initializeOrderSchema(); await ensureStockReservations(); await ensureOrderRequests(); await ensurePrintQueue();
  const [[staff]] = await pool.query("SELECT id,nombre FROM trabajadores WHERE rol='admin' LIMIT 1"); assert.ok(staff);
  const [[product]] = await pool.query('SELECT id FROM productos WHERE disponible=1 LIMIT 1'); assert.ok(product);
  const handler = orders.stack.find(l => l.route?.path === '/' && l.route.methods.post).route.stack.at(-1).handle;
  async function call(body) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
    await handler({ body, user: { ...staff, rol: 'admin' } }, res); return res;
  }
  const body = { tipo: 'Delivery', cliente_nombre: 'Prueba aislada', delivery_direccion: 'Calle de prueba', request_id: 'mysql_concurrent_0001', items: [{ producto_id: product.id, cantidad: 1 }] };
  const results = await Promise.all([call(body), call(body)]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 201], JSON.stringify(results));
  const id = results[0].body.pedido.id;
  assert.equal(results[1].body.pedido.id, id);
  async function count(table) { const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE pedido_id = ?`, [id]); return row.n; }
  assert.equal(await count('pedido_rondas'), 1); assert.equal(await count('detalle_pedidos'), 1); assert.equal(await count('print_jobs'), 1);
  const add = { ...body, pedido_id: id, cliente_nombre: 'No debe reemplazar', request_id: 'mysql_concurrent_0002' };
  const rounds = await Promise.all([call(add), call(add)]);
  assert.deepEqual(rounds.map(r => r.statusCode).sort(), [200, 201], JSON.stringify(rounds));
  assert.equal(await count('pedido_rondas'), 2); assert.equal(await count('print_jobs'), 2);
  assert.equal(rounds[0].body.pedido.cliente_nombre, 'Prueba aislada');
  assert.equal(rounds[0].body.pedido.delivery_direccion, 'Calle de prueba');
  const failed = { ...body, request_id: 'mysql_rollback_0003', items: [{ producto_id: 2147483647, cantidad: 1 }] };
  assert.equal((await call(failed)).statusCode, 409);
  const [[claim]] = await pool.query('SELECT COUNT(*) AS n FROM pedido_solicitudes WHERE clave = ?', [failed.request_id]); assert.equal(claim.n, 0);
  const fixed = await call({ ...body, request_id: failed.request_id }); assert.equal(fixed.statusCode, 201, JSON.stringify(fixed.body));
  await pool.query("UPDATE pedidos SET estado = 'PAGADO' WHERE id = ?", [id]);
  const retryClosed = await call(body); assert.equal(retryClosed.statusCode, 200); assert.equal(retryClosed.body.pedido.id, id);
  assert.equal((await call({ ...add, request_id: 'mysql_closed_0004' })).statusCode, 409);
  assert.equal((await call({ ...body, items: [{ producto_id: product.id, cantidad: 2 }] })).body.code, 'REQUEST_CONFLICT');
  assert.equal(await count('print_jobs'), 2);
  // History is based on final completion day, not on creation day or payment alone.
  const historyHandler = orders.stack.find(l => l.route?.path === '/express/historial').route.stack.at(-1).handle;
  async function history(fecha) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await historyHandler({ query: { fecha }, user: { ...staff, rol: 'admin' } }, res); return res;
  }
  await pool.query("UPDATE pedidos SET pagado_at = '2026-09-11 12:00:00' WHERE id = ?", [id]);
  assert.ok(!(await history('2026-09-11')).body.items.some(o => o.id === id), 'paid food awaiting preparation cannot be archived');
  await pool.query("UPDATE pedido_rondas SET estado = 'ENTREGADO', entregado_at = '2026-09-12 13:00:00' WHERE pedido_id = ?", [id]);
  assert.ok(!(await history('2026-09-11')).body.items.some(o => o.id === id));
  assert.ok((await history('2026-09-12')).body.items.some(o => o.id === id));
  await pool.query("UPDATE pedidos SET estado = 'ENTREGADO' WHERE id = ?", [id]);
  assert.ok(!(await history('2026-09-12')).body.items.some(o => o.id === id), 'unpaid deliveries stay outside completed history');
  assert.equal((await history('2026-02-30')).statusCode, 400);
  console.log('MySQL: historial por cierre verificado; excluye entregados sin pagar y pagados sin entregar.');
  console.log('MySQL: concurrencia, reintentos, una impresión por ronda, rollback, Express y rechazo de cuentas cerradas verificados.');
} finally {
  await pool?.end();
  assert.match(testDb, /^codex_order_test_\d+$/); assert.notEqual(testDb, source);
  await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``); await admin.end();
  console.log('Base temporal de pruebas eliminada.');
}
