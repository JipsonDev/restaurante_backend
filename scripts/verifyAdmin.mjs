// Run explicitly with: node --experimental-test-module-mocks scripts/verifyAdmin.mjs
// Clones only the configured LOCAL database into a disposable database. Never writes to its source.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)) throw new Error('Esta prueba solo admite MySQL local.');
const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const source=process.env.DB_NAME;
if (!/^[A-Za-z0-9_]+$/.test(source)) throw new Error('Nombre de origen invalido.');
const testDb=`codex_admin_test_${Date.now()}`;
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

  const { default: workers } = await import('../routes/trabajadores.js');
  const { default: extras } = await import('../routes/extras.js');
  const bcrypt = (await import('bcryptjs')).default;
  const inv = await ingredient(5);
  const productBody = {nombre:'Producto prueba admin',precio:3.5,stock:4,disponible:0,descripcion:'Antes',imagen_url:'/before.png',receta:[{inventario_item_id:inv,cantidad:0.25}]};
  const created = await call(products,'post','/',productBody); expect(created,201);
  const id = created.body.id;
  const readProduct = async () => (await call(products,'get','/:id',{}, {id})).body;
  assert.equal((await readProduct()).disponible,0);
  expect(await call(products,'put','/:id',{precio:9,receta:[{inventario_item_id:2147483647,cantidad:1}]},{id}),400);
  assert.equal(Number((await readProduct()).precio),3.5);
  let recipe = await call(products,'get','/:id/receta',{}, {id}); assert.equal(recipe.body.length,1); assert.equal(Number(recipe.body[0].cantidad),0.25);
  expect(await call(products,'put','/:id/receta',{items:[{inventario_item_id:inv,cantidad:0}]},{id}),400);
  expect(await call(products,'put','/:id/receta',{items:{}},{id}),400);
  expect(await call(products,'put','/:id/receta',{items:[{inventario_item_id:inv,cantidad:1},{inventario_item_id:inv,cantidad:1}]},{id}),400);
  expect(await call(products,'put','/:id/receta',{items:[]},{id:2147483647}),404);
  const [[beforeCount]]=await pool.query('SELECT COUNT(*) AS n FROM productos');
  expect(await call(products,'post','/',{...productBody,receta:[{inventario_item_id:2147483647,cantidad:1}]}),400);
  const [[afterCount]]=await pool.query('SELECT COUNT(*) AS n FROM productos'); assert.equal(beforeCount.n,afterCount.n);
  expect(await call(products,'put','/:id',{descripcion:null,imagen_url:null,receta:[]},{id}),200);
  assert.equal((await readProduct()).descripcion,null); assert.equal((await readProduct()).imagen_url,null);
  recipe=await call(products,'get','/:id/receta',{}, {id}); assert.equal(recipe.body.length,0);
  console.log('OK: producto y receta atomicos, sin perdida de receta, disponibilidad y campos vacios.');

  for(const value of [-1,'abc',null,1.234]) {
    expect(await call(products,'post','/',{...productBody,precio:value}),400);
    expect(await call(products,'put','/:id',{precio:value},{id}),400);
    expect(await call(extras,'post','/',{nombre:'Extra prueba',precio:value}),400);
  }
  expect(await call(inventory,'post','/',{nombre:'Mal stock',stock:-1}),400);
  expect(await call(inventory,'put','/:id',{costo_unitario:-1},{id:inv}),400);
  expect(await call(inventory,'post','/:id/movimiento',{tipo:'Entrada',cantidad:0.0001},{id:inv}),400);
  expect(await call(inventory,'post','/:id/movimiento',{tipo:'Entrada',cantidad:0},{id:inv}),400);
  await pool.query("UPDATE inventario_items SET proveedor='Proveedor anterior',categoria='Anterior' WHERE id=?",[inv]);
  expect(await call(inventory,'put','/:id',{proveedor:null,categoria:null},{id:inv}),200);
  const [[cleared]]=await pool.query('SELECT proveedor,categoria FROM inventario_items WHERE id=?',[inv]); assert.equal(cleared.proveedor,null); assert.equal(cleared.categoria,null);
  console.log('OK: precios, stock, precision decimal y borrado de proveedor/categoria.');

  // Catalog policy is checked against the cloned database, including raw API requests.
  const uniqueCategory = `Catálogo prueba ${Date.now()}`;
  const categoryCreated = await call(products,'post','/categorias',{nombre:uniqueCategory}); expect(categoryCreated,201);
  const categoryId = categoryCreated.body.id;
  const hiddenCategory = await call(products,'post','/categorias',{nombre:uniqueCategory,activo:0}); expect(hiddenCategory,201);
  expect(await call(products,'put','/categorias/:id',{activo:1},{id:hiddenCategory.body.id}),409);
  expect(await call(products,'put','/categorias/:id',{nombre:'No existe'},{id:2147483647}),404);
  expect(await call(products,'post','/',{...productBody,categoria_id:2147483647}),400);
  expect(await call(products,'put','/:id',{disponible:2},{id}),400);
  expect(await call(products,'post','/',{...productBody,inventario_item_id:inv}),400);
  const linkedProduct = await call(products,'post','/',{...productBody,nombre:'Vínculo único',categoria_id:categoryId,inventario_item_id:inv,receta:[],disponible:1}); expect(linkedProduct,201);
  expect(await call(products,'put','/:id/receta',{items:[{inventario_item_id:inv,cantidad:1}]},{id:linkedProduct.body.id}),400);
  expect(await call(products,'put','/:id',{receta:[{inventario_item_id:inv,cantidad:1,unidad:'kg'}]},{id}),400);
  const unchangedRecipe = await call(products,'get','/:id/receta',{}, {id}); assert.equal(unchangedRecipe.body.length,0);
  expect(await call(products,'put','/categorias/:id',{activo:0},{id:categoryId}),200);
  const visibleCatalog = await call(products,'get','/');
  assert.equal(visibleCatalog.body.some(p => p.id === linkedProduct.body.id),false);
  const adminCatalog = await call(products,'get','/',{}, {}, {includeInactive:'1'});
  const hiddenProduct = adminCatalog.body.find(p => p.id === linkedProduct.body.id); assert.equal(hiddenProduct.categoria_activa,0);
  expect(await call(products,'put','/:id',{disponible:1},{id:linkedProduct.body.id}),400);
  expect(await send(linkedProduct.body.id,`inactive-category-${Date.now()}`),409);
  expect(await call(products,'put','/categorias/:id',{activo:1},{id:categoryId}),200);
  const activeCatalog = await call(products,'get','/'); assert.equal(activeCatalog.body.some(p => p.id === linkedProduct.body.id),true);
  console.log('OK: categorías inactivas bloquean ventas, reactivación sin duplicados, fuente única y unidades de receta.');

  const { default: tableRoutes } = await import('../routes/mesas.js');
  const [[maxTable]] = await pool.query('SELECT COALESCE(MAX(numero),0) AS n FROM mesas');
  const tableNumber = Number(maxTable.n) + 1;
  const duplicates = await Promise.all([1,2].map(() => call(tableRoutes,'post','/',{numero:tableNumber,capacidad:4})));
  assert.deepEqual(duplicates.map(r=>r.statusCode).sort(),[201,409]);
  const tableId = duplicates.find(r=>r.statusCode===201).body.id;
  expect(await call(tableRoutes,'put','/:id',{ubicacion_id:2147483647},{id:tableId}),400);
  expect(await call(tableRoutes,'put','/:id/estado',{estado:'Reservada'},{id:tableId}),200);
  expect(await call(tableRoutes,'put','/:id',{capacidad:6},{id:tableId}),200);
  const [[tableAfterEdit]]=await pool.query('SELECT estado,capacidad FROM mesas WHERE id=?',[tableId]);
  assert.equal(tableAfterEdit.estado,'Reservada'); assert.equal(tableAfterEdit.capacidad,6);
  expect(await call(tableRoutes,'put','/:id',{activo:0},{id:tableId}),200);
  expect(await call(tableRoutes,'put','/:id/estado',{estado:'Libre'},{id:tableId}),409);
  expect(await call(tableRoutes,'put','/:id',{activo:1},{id:tableId}),200);
  const tableProduct = await product(5);
  const tableOrder = await call(orders,'post','/',{tipo:'Mesa',mesa_id:tableId,request_id:`table-admin-${Date.now()}`,items:[{producto_id:tableProduct,cantidad:1}]}); expect(tableOrder,201);
  expect(await call(tableRoutes,'put','/:id',{numero:tableNumber+1},{id:tableId}),409);
  expect(await call(tableRoutes,'put','/:id',{activo:0},{id:tableId}),409);
  expect(await call(tableRoutes,'put','/:id/estado',{estado:'Libre'},{id:tableId}),409);
  expect(await call(tableRoutes,'delete','/:id',{}, {id:tableId}),409);
  expect(await cancel(tableOrder.body.id),200);
  expect(await call(tableRoutes,'delete','/:id',{}, {id:tableId}),409);
  expect(await call(tableRoutes,'put','/:id',{activo:0},{id:tableId}),200);
  const unusedTable=await call(tableRoutes,'post','/',{numero:tableNumber+1}); expect(unusedTable,201);
  expect(await call(tableRoutes,'delete','/:id',{}, {id:unusedTable.body.id}),200);
  expect(await call(tableRoutes,'delete','/:id',{}, {id:unusedTable.body.id}),404);
  console.log('OK: mesas sin duplicados concurrentes, estados protegidos, historial conservado y borrado transaccional.');

  const person = await call(workers,'post','/',{nombre:'Prueba aislada admin',correo:'prueba-admin@example.test',password:'Solo-prueba-aislada',activo:0}); expect(person,201);
  const workerId=person.body.id;
  const readWorker=async()=>{const [[r]]=await pool.query('SELECT * FROM trabajadores WHERE id=?',[workerId]);return r;};
  assert.equal((await readWorker()).activo,0);
  const passwordBefore=(await readWorker()).password_hash;
  const [[other]]=await pool.query('SELECT correo FROM trabajadores WHERE id=?',[staff.id]);
  expect(await call(workers,'put','/:id',{correo:other.correo,password:'Cambio-que-debe-fallar'},{id:workerId}),409);
  assert.equal((await readWorker()).password_hash,passwordBefore);
  expect(await call(workers,'put','/:id',{password:'Cambio-que-debe-fallar',pin:'12'},{id:workerId}),400);
  assert.equal((await readWorker()).password_hash,passwordBefore);
  expect(await call(workers,'put','/:id',{nombre:'Nuevo nombre'},{id:2147483647}),404);
  expect(await call(workers,'put','/:id',{activo:0},{id:staff.id}),409);
  expect(await call(workers,'put','/:id',{rol:'mesero'},{id:staff.id}),409);
  expect(await call(workers,'put','/:id',{nombre:'Nombre editado',correo:'  NUEVO-ADMIN@example.test ',password:'Nuevo-valido-aislado'},{id:workerId}),200);
  const edited=await readWorker(); assert.equal(edited.nombre,'Nombre editado'); assert.equal(edited.correo,'nuevo-admin@example.test'); assert.equal(await bcrypt.compare('Nuevo-valido-aislado',edited.password_hash),true);
  console.log('OK: edicion de usuario atomica, correo normalizado, inactivos y proteccion del propio administrador.');
} finally {
  await pool?.end();
  assert.match(testDb,/^codex_admin_test_\d+$/); assert.notEqual(testDb,source);
  await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``); await admin.end();
  console.log('Base temporal de pruebas eliminada.');
}
