// Run explicitly with: node --experimental-test-module-mocks scripts/verifyStockReservations.mjs
// Clones only the configured LOCAL database into a disposable database. Never writes to its source.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)) throw new Error('Esta prueba solo admite MySQL local.');
const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const source=process.env.DB_NAME;
if (!/^[A-Za-z0-9_]+$/.test(source)) throw new Error('Nombre de origen invalido.');
const testDb=`codex_stock_test_${Date.now()}`;
const admin=await mysql.createConnection(config);
let pool;
try {
  await admin.query(`CREATE DATABASE \`${testDb}\``);
  const [tables]=await admin.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?', [source,'BASE TABLE']);
  for(const {TABLE_NAME:t} of tables) { if(!/^[A-Za-z0-9_]+$/.test(t))throw new Error('Tabla invalida');await admin.query(`CREATE TABLE \`${testDb}\`.\`${t}\` LIKE \`${source}\`.\`${t}\``);await admin.query(`INSERT INTO \`${testDb}\`.\`${t}\` SELECT * FROM \`${source}\`.\`${t}\``); }
  pool=mysql.createPool({...config,database:testDb});
  mock.module('../db.js',{namedExports:{pool}});
  mock.module('../routes/notificaciones.js',{namedExports:{sendPushToUser:async()=>{}}});
  const { ensureStockReservations, migratePendingReservations } = await import('../services/stockReservations.js');
  const { default: orders, initializeOrderSchema } = await import('../routes/pedidos.js');
  const { default: products } = await import('../routes/productos.js');
  const { default: inventory } = await import('../routes/inventario.js');
  const { default: cash, initializeCashSchema } = await import('../routes/caja.js');
  const { ensureOrderRequests } = await import('../services/orderRequests.js');
  const { ensurePrintQueue } = await import('../services/printQueue.js');
  await initializeOrderSchema(); await initializeCashSchema(); await ensureStockReservations(); await ensureOrderRequests(); await ensurePrintQueue();
  const [[staff]] = await pool.query("SELECT id,nombre FROM trabajadores WHERE rol='admin' LIMIT 1"); assert.ok(staff);
  async function call(router, method, path, body = {}, params = {}, query = {}) {
    const handler = router.stack.find(l => l.route?.path === path && l.route.methods[method]).route.stack.at(-1).handle;
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body, params, query, user: { ...staff, rol: 'admin' } }, res); return res;
  }
  async function product(stock = 1, linked = null) {
    const [r] = await pool.query('INSERT INTO productos (nombre, precio, stock, disponible, inventario_item_id) VALUES (?, 5, ?, 1, ?)', [`Prueba reserva ${Date.now()}`, stock, linked]); return r.insertId;
  }
  async function ingredient(stock) {
    const [r] = await pool.query("INSERT INTO inventario_items (nombre, stock, unidad, activo) VALUES (?, ?, 'unidad', 1)", [`Insumo prueba ${Date.now()}`, stock]); return r.insertId;
  }
  const stockOf = async (table, id) => { const [[r]] = await pool.query(`SELECT stock, stock_reservado FROM ${table} WHERE id = ?`, [id]); return [Number(r.stock), Number(r.stock_reservado)]; };
  const free = async id => { const result = await call(products, 'get', '/'); assert.equal(result.statusCode, 200, JSON.stringify(result.body)); return Number(result.body.find(p => p.id === id)?.stock_disponible); };
  const send = (id, key, items = [{ producto_id: id, cantidad: 1 }]) => call(orders, 'post', '/', { tipo: 'Para llevar', cliente_nombre: 'Prueba aislada', request_id: key, items });
  const cancel = id => call(orders, 'put', '/:id', { estado: 'CANCELADO' }, { id });
  const prepare = order => call(orders, 'put', '/:id/rondas/:rondaId', { estado: 'PREPARANDO' }, { id: order.id, rondaId: order.rondas.at(-1).id });
  const expect = (r, code) => assert.equal(r.statusCode, code, JSON.stringify(r.body));

  const last = await product(1);
  const concurrent = await Promise.all([send(last, 'stock_concurrent_001'), send(last, 'stock_concurrent_002')]);
  assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [201,409]);
  const winner = concurrent.find(r => r.statusCode === 201).body.pedido;
  assert.deepEqual(await stockOf('productos', last), [1,1]); assert.equal(await free(last), 0);
  const winningKey = concurrent[0].statusCode === 201 ? 'stock_concurrent_001' : 'stock_concurrent_002';
  expect(await send(last, winningKey), 200); assert.deepEqual(await stockOf('productos', last), [1,1]);
  expect(await call(orders, 'delete', '/:id', {}, { id: winner.id }), 409);
  assert.deepEqual(await stockOf('productos', last), [1,1]);
  const [[prints]] = await pool.query('SELECT COUNT(*) AS n FROM print_jobs WHERE pedido_id = ?', [winner.id]); assert.equal(prints.n, 1);
  expect(await call(products, 'put', '/:id', { stock: 0 }, { id: last }), 409);
  expect(await cancel(winner.id), 200); assert.deepEqual(await stockOf('productos', last), [1,0]); assert.equal(await free(last), 1);
  expect(await cancel(winner.id), 200); assert.deepEqual(await stockOf('productos', last), [1,0]);
  const accepted = await send(last, 'stock_after_cancel_001'); expect(accepted,201);
  expect(await prepare(accepted.body.pedido),200); assert.deepEqual(await stockOf('productos', last), [0,0]);
  expect(await prepare(accepted.body.pedido),200); assert.deepEqual(await stockOf('productos', last), [0,0]);
  expect(await cancel(accepted.body.pedido.id),200); assert.deepEqual(await stockOf('productos', last), [1,0]);
  expect(await cancel(accepted.body.pedido.id),200); assert.deepEqual(await stockOf('productos', last), [1,0]);
  console.log('OK: dos meseros, ultima unidad, reintento, preparacion y cancelacion sin doble descuento.');

  const shared = await ingredient(1.5);
  const drinkA = await product(99), drinkB = await product(99);
  for (const id of [drinkA, drinkB]) await pool.query('INSERT INTO recetas (producto_id, inventario_item_id, cantidad, activo) VALUES (?, ?, 0.75, 1)', [id, shared]);
  assert.equal(await free(drinkA),2);
  const recipeRead = await call(products, 'get', '/:id/receta', {}, { id: drinkA });
  expect(recipeRead, 200); assert.equal(recipeRead.body.length, 1);
  const recipes = await send(drinkA, 'stock_recipes_001', [{ producto_id: drinkA, cantidad: 1 }, { producto_id: drinkB, cantidad: 1 }]); expect(recipes,201);
  assert.deepEqual(await stockOf('inventario_items',shared),[1.5,1.5]); assert.equal(await free(drinkB),0);
  expect(await send(drinkB, 'stock_recipes_reject'),409);
  expect(await call(inventory,'post','/:id/movimiento',{tipo:'Salida',cantidad:0.1},{id:shared}),409);
  expect(await call(inventory,'put','/:id',{stock:1},{id:shared}),409);
  // Editing the recipe does not change ingredients of a confirmed round.
  const replacement = await ingredient(10);
  for (const id of [drinkA, drinkB]) expect(await call(products,'put','/:id/receta',{items:[{inventario_item_id:replacement,cantidad:2}]},{id}),200);
  expect(await prepare(recipes.body.pedido),200);
  assert.deepEqual(await stockOf('inventario_items',shared),[0,0]); assert.deepEqual(await stockOf('inventario_items',replacement),[10,0]);
  expect(await cancel(recipes.body.pedido.id),200);
  assert.deepEqual(await stockOf('inventario_items',shared),[1.5,0]); assert.deepEqual(await stockOf('inventario_items',replacement),[10,0]);
  const linkedA = await product(100,shared), linkedB = await product(100,shared);
  const linked = await Promise.all([send(linkedA,'stock_linked_0001'),send(linkedB,'stock_linked_0002')]);
  assert.deepEqual(linked.map(r=>r.statusCode).sort(),[201,409]);
  expect(await cancel(linked.find(r=>r.statusCode===201).body.pedido.id),200);
  console.log('OK: recetas fraccionarias, insumo compartido, vinculo directo y cambios de receta.');

  const enough = await product(10), exhausted = await product(0);
  expect(await send(enough,'stock_rollback_001',[{producto_id:enough,cantidad:2},{producto_id:exhausted,cantidad:1}]),409);
  assert.deepEqual(await stockOf('productos',enough),[10,0]);
  expect(await send(enough,'stock_variants_001',[{producto_id:enough,cantidad:6},{producto_id:enough,cantidad:5}]),409);
  assert.deepEqual(await stockOf('productos',enough),[10,0]);
  const [[claim]] = await pool.query("SELECT COUNT(*) AS n FROM pedido_solicitudes WHERE clave IN ('stock_rollback_001','stock_variants_001')"); assert.equal(claim.n,0);
  const [[register]] = await pool.query("SELECT id FROM caja WHERE estado='Abierta' LIMIT 1"); assert.ok(register);
  const prepaid = await send(enough,'stock_prepaid_001'); expect(prepaid,201);
  expect(await call(cash,'post','/cobrar',{ pedido_id:prepaid.body.pedido.id,caja_id:register.id,metodo:'Tarjeta',monto:prepaid.body.pedido.total,idempotency_key:'stock_payment_001' }),201);
  assert.deepEqual(await stockOf('productos',enough),[9,0]);
  expect(await prepare(prepaid.body.pedido),200); assert.deepEqual(await stockOf('productos',enough),[9,0]);
  console.log('OK: rollback de toda la comanda, variantes y pago antes de preparar.');

  // Simulate a pre-migration round on the isolated copy only.
  const legacyProduct = await product(1);
  const [oldOrder] = await pool.query("INSERT INTO pedidos (mesero_id, total, estado, tipo) VALUES (?,5,'PENDIENTE','Para llevar')",[staff.id]);
  const [oldRound] = await pool.query('INSERT INTO pedido_rondas (pedido_id) VALUES (?)',[oldOrder.insertId]);
  await pool.query('INSERT INTO detalle_pedidos (pedido_id,ronda_id,producto_id,cantidad,precio) VALUES (?,?,?,2,5)',[oldOrder.insertId,oldRound.insertId,legacyProduct]);
  const migration = await migratePendingReservations();
  assert.ok(migration.shortages.some(r=>r.tipo==='producto' && r.id===legacyProduct));
  assert.deepEqual(await stockOf('productos',legacyProduct),[1,2]); assert.equal(await free(legacyProduct),0);
  await migratePendingReservations(); assert.deepEqual(await stockOf('productos',legacyProduct),[1,2]);
  expect(await send(legacyProduct,'stock_legacy_block'),409);
  expect(await cancel(oldOrder.insertId),200); assert.deepEqual(await stockOf('productos',legacyProduct),[1,0]);
  console.log('OK: migracion repetible, faltantes anteriores visibles y sin nuevas sobreventas.');
} finally {
  await pool?.end();
  assert.match(testDb,/^codex_stock_test_\d+$/); assert.notEqual(testDb,source);
  await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``); await admin.end();
  console.log('Base temporal de pruebas eliminada.');
}
