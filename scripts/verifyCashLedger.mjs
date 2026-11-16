// Run explicitly with: node --experimental-test-module-mocks scripts/verifyCashLedger.mjs
// Clones only the configured LOCAL database into a disposable database. Never writes to its source.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST)) throw new Error('Esta prueba solo admite MySQL local.');
const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
const source=process.env.DB_NAME;
if (!/^[A-Za-z0-9_]+$/.test(source)) throw new Error('Nombre de origen invalido.');
const testDb=`codex_cash_test_${Date.now()}`;
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
  const {default:cash,initializeCashSchema,cajaTotals}=await import('../routes/caja.js');
  const {default:history}=await import('../routes/paymentHistory.js');
  await initializeOrderSchema(); await ensureStockReservations();await initializeCashSchema();
  const [[staff]]=await pool.query("SELECT id,nombre FROM trabajadores WHERE rol='admin' LIMIT 1");
  assert.ok(staff);
  const user={...staff,rol:'admin'};
  async function call(router,path,body={},id=1,method='post',query={}) {
    const route=router.stack.find(l=>l.route?.path===path&&l.route.methods[method])?.route;
    assert.ok(route,`${method} ${path}`);
    const res={statusCode:200,status(n){this.statusCode=n;return this;},json(data){this.body=data;return this;}};
    await route.stack.at(-1).handle({body,params:{id},query,user},res);return res;
  }
  const [[register]]=await pool.query("SELECT * FROM caja WHERE estado='Abierta' LIMIT 1");assert.ok(register);
  // Dedicated test order and stock changes are confined to testDb.
  const [[product]]=await pool.query('SELECT id FROM productos WHERE disponible=1 ORDER BY id LIMIT 1');assert.ok(product);
  await pool.query('UPDATE productos SET stock=1000 WHERE id=?',[product.id]);
  const created=await call(orders,'/',{tipo:'Para llevar',cliente_nombre:'Prueba aislada caja',items:[{producto_id:product.id,cantidad:1}]});
  assert.equal(created.statusCode,201,JSON.stringify(created.body));
  const id=created.body.pedido.id;
  await pool.query('UPDATE pedidos SET total=11 WHERE id=?',[id]);
  await pool.query('UPDATE detalle_pedidos SET precio=10 WHERE pedido_id=?',[id]);
  // Inventory is already covered by orderFlow tests; don't require restaurant-specific recipes here.
  await pool.query('UPDATE pedido_rondas SET inventario_descontado=1 WHERE pedido_id=?',[id]);
  await pool.query('UPDATE pedidos SET inventario_descontado=1 WHERE id=?',[id]);
  const split=await call(orders,'/:id/split/request',{mode:'equal',partes:2},id);assert.equal(split.statusCode,201,JSON.stringify(split.body));
  const [divisions]=await pool.query('SELECT * FROM cuenta_divisiones WHERE pedido_id=? ORDER BY id',[id]);
  const before=await cajaTotals(register.id);
  const base={pedido_id:id,caja_id:register.id};
  const payload={...base,metodo:'Mixto',monto:5.5,parcial:true,division_id:divisions[0].id,idempotency_key:'mysql_test_partial_001',desglose:[{metodo:'Efectivo',monto:2.5},{metodo:'Tarjeta',monto:3}],efectivo_recibido:5};
  const paid=await call(cash,'/cobrar',payload);assert.equal(paid.statusCode,201,JSON.stringify(paid.body));
  assert.equal(paid.body.pedido.saldo_pendiente,5.5);assert.equal(paid.body.pedido.estado_cobro,'PARCIAL');
  const retry=await call(cash,'/cobrar',payload);assert.equal(retry.statusCode,200);assert.equal(retry.body.pago_id,paid.body.pago_id);
  const foreign=await call(cash,'/cobrar',{...payload,idempotency_key:'mysql_test_partial_002'});assert.equal(foreign.statusCode,409);
  const overshoot=await call(cash,'/cobrar',{...base,metodo:'Tarjeta',monto:6});assert.equal(overshoot.statusCode,409);
  const [entries]=await pool.query('SELECT * FROM pagos WHERE pedido_id=?',[id]);assert.equal(entries.length,1);
  const redivision=await call(orders,'/:id/split/request',{mode:'equal',partes:3},id);assert.equal(redivision.statusCode,409);
  const deletion=await call(orders,'/:id',{},id,'delete');assert.equal(deletion.statusCode,409);
  const item=await call(history,'/:id',{},paid.body.pago_id,'get');assert.equal(item.statusCode,200);assert.equal(item.body.snapshot.monto,5.5);
  const oldName=item.body.snapshot.pedido.items[0].nombre;
  await pool.query('UPDATE productos SET nombre=? WHERE id=?',['Cambio posterior de prueba',product.id]);
  const reprinted=await call(history,'/:id',{},paid.body.pago_id,'get');assert.equal(reprinted.body.snapshot.pedido.items[0].nombre,oldName);
  const failed=await call(history,'/:id/impresion',{estado:'ERROR',error:'Impresora de prueba desconectada'},paid.body.pago_id);assert.equal(failed.statusCode,200);
  const sent=await call(history,'/:id/impresion',{estado:'ENVIADO'},paid.body.pago_id);assert.equal(sent.statusCode,200);
  const listed=await call(history,'/',{},1,'get',{q:paid.body.comprobante_numero,metodo:'Tarjeta',cajero_id:String(staff.id)});
  assert.equal(listed.statusCode,200,JSON.stringify(listed.body));assert.equal(listed.body.total,1);assert.equal(listed.body.rows[0].impresion_intentos,2);
  const last=await call(cash,'/cobrar',{...base,metodo:'Efectivo',monto:5.5,idempotency_key:'mysql_test_final_001'});assert.equal(last.statusCode,201,JSON.stringify(last.body));assert.equal(last.body.pedido.estado,'PAGADO');
  const totals=await cajaTotals(register.id);assert.equal(Math.round((totals.efectivo-before.efectivo)*100),800);assert.equal(Math.round((totals.tarjeta-before.tarjeta)*100),300);assert.equal(Math.round((totals.total-before.total)*100),1100);
  const reversed=await call(cash,'/pagos/:id/anular',{motivo:'Prueba aislada de anulacion'},paid.body.pago_id);assert.equal(reversed.statusCode,200,JSON.stringify(reversed.body));
  const reopened=await getPedidoCompleto(id);assert.equal(reopened.saldo_pendiente,5.5);assert.equal(reopened.estado_cobro,'PARCIAL');
  const after=await cajaTotals(register.id);assert.equal(Math.round((after.efectivo-before.efectivo)*100),550);assert.equal(Math.round((after.tarjeta-before.tarjeta)*100),0);
  console.log('MySQL: abono mixto, division, saldo, cierre de cuenta, reintento, sobrepago, filtros, snapshot, impresion y anulacion verificados.');
} finally {
  await pool?.end();
  assert.match(testDb,/^codex_cash_test_\d+$/);assert.notEqual(testDb,source);
  await admin.query(`DROP DATABASE IF EXISTS \`${testDb}\``);await admin.end();
  console.log('Base temporal de pruebas eliminada.');
}
