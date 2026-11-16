import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { cashAmount, expectedCash, receiptTotals, validateMethod } from '../services/cashLogic.js';
let db;
const pool = { query: (...args) => db.query(...args), getConnection: async () => db.connection() };
mock.module('../middleware/auth.js', { namedExports: { verifyRole: () => (_req, _res, next) => next() } });
mock.module('../db.js', { namedExports: { pool } });
mock.module('../services/audit.js', { namedExports: { ensureAuditTable: async () => {}, safeLogAudit: async () => {} } });
mock.module('../services/businessConfig.js', { namedExports: { getBusinessConfig: async () => ({ iva_porcentaje: 0 }) } });
mock.module('../services/quickPin.js', { namedExports: { resolveQuickAuthorization: async () => ({ user: { id: 1 }, via: 'role' }) } });
mock.module('../services/tableState.js', { namedExports: { getMesaPayload: async () => null } });
mock.module('../services/rounds.js', { namedExports: { refreshAccountState: async () => { db.state.order.estado = 'LISTO'; } } });
mock.module('../services/accounts.js', { namedExports: {
  beginAccountTransaction: async (conn) => { await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await conn.beginTransaction(); },
  emitMergedAccounts: () => {}, consolidateAccount: async () => ({ orders: [db.state.order] }),
} });
mock.module('../routes/pedidos.js', { namedExports: {
  getPedidoCompleto: async () => { db.hydrations = (db.hydrations || 0) + 1; if (db.hydrations === db.failHydrationAt) throw new Error('hydrate failed'); return structuredClone(db.state.order); },
  transitionPedido: async () => { db.state.order.estado = 'PAGADO'; return { table_freed: false, mesa_id: null }; },
} });
const { default: router } = await import('../routes/caja.js');

function fixture({ open = true, payments = [], movements = [] } = {}) {
  let tail = Promise.resolve();
  const state = {
    cajas: [{ id: 1, estado: open ? 'Abierta' : 'Cerrada', monto_inicial: 20, trabajador_id: 1, efectivo_esperado: 20 }],
    payments, movements, parts: [], divisions: [], sequence: 1,
    order: { id: 12, estado: 'LISTO', total: 11, mesa_id: null, items: [{ id: 1, precio: 10, cantidad: 1 }], rondas: [{ id: 1, estado: 'LISTO' }] },
  };
  const calls = [];
  const database = { state, calls, commits: 0, rollbacks: 0, query: async (raw, args = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim(); calls.push({ sql, args });
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [[{ COLUMN_NAME: args[1] }]];
    if (/^(CREATE TABLE|ALTER TABLE|INSERT IGNORE|SET TRANSACTION)/.test(sql)) return [{}];
    if (sql.startsWith('SELECT * FROM caja WHERE estado')) return [state.cajas.filter((c) => c.estado === 'Abierta').slice(-1)];
    if (sql.startsWith('SELECT * FROM caja WHERE id')) return [state.cajas.filter((c) => c.id === Number(args[0]) && c.estado === 'Cerrada')];
    if (sql.startsWith('INSERT INTO caja (')) { const id = state.cajas.length + 1; state.cajas.push({ id, estado: 'Abierta', monto_inicial: args[1] }); return [{ insertId: id }]; }
    if (sql.startsWith("UPDATE caja SET estado = 'Abierta'")) { state.cajas.find((c) => c.id === Number(args[0])).estado = 'Abierta'; return [{}]; }
    if (sql.includes('FROM pagos') && sql.includes('AS efectivo')) {
      const rows = state.payments.filter((p) => p.caja_id === args[0] && (p.estado || 'ACTIVO') === 'ACTIVO');
      const sums = { efectivo: 0, tarjeta: 0, transferencia: 0, qr: 0, vales: 0, otro: 0, total: 0, pagos: rows.length };
      for (const p of rows) { const parts = state.parts.filter(part => part.pago_id === p.id); for (const part of (parts.length ? parts : [p])) sums[part.metodo.toLowerCase()] += part.monto; sums.total += p.monto; }
      return [[sums]];
    }
    if (sql.includes('FROM caja_movimientos') && sql.includes('AS ingresos')) {
      const sums = { ingresos: 0, retiros: 0, gastos: 0, devoluciones: 0, anulaciones: 0, ingresos_efectivo: 0, retiros_efectivo: 0, gastos_efectivo: 0 };
      const keys = { INGRESO: 'ingresos', RETIRO: 'retiros', GASTO: 'gastos', DEVOLUCION: 'devoluciones', ANULACION: 'anulaciones' };
      for (const m of state.movements.filter((m) => m.caja_id === args[0])) {
        sums[keys[m.tipo]] += m.monto;
        if (m.metodo === 'Efectivo' && ['INGRESO','RETIRO','GASTO'].includes(m.tipo)) sums[keys[m.tipo] + '_efectivo'] += m.monto;
      }
      assert.match(sql, /metodo = 'Efectivo'/);
      return [[sums]];
    }
    if (sql.startsWith("UPDATE caja SET estado = 'Cerrada'")) {
      Object.assign(state.cajas.find((c) => c.id === args.at(-1)), { estado: 'Cerrada', monto_final: args[0], efectivo_esperado: args[2], diferencia_cierre: args[3] }); return [{}];
    }
    if (sql.startsWith('UPDATE caja SET monto_final')) return [{}];
    if (sql.startsWith('INSERT INTO caja_movimientos')) {
      const reversal = sql.includes("'ANULACION'") || sql.includes("'DEVOLUCION'");
      state.movements.push({ caja_id: args[0], tipo: reversal ? (sql.includes("'ANULACION'") ? 'ANULACION' : 'DEVOLUCION') : args[2], monto: args[reversal ? 2 : 3], metodo: args[reversal ? 3 : 4] }); return [{ insertId: state.movements.length }];
    }
    if (sql.startsWith('SELECT * FROM pagos WHERE idempotency_key')) return [state.payments.filter(p => p.idempotency_key === args[0])];
    if (sql.startsWith('SELECT COALESCE(SUM(monto),0) AS abonado')) { const active=state.payments.filter(p => p.pedido_id === args[0] && p.estado === 'ACTIVO'); const sums={abonado:0,subtotal:0,tax:0,service:0}; for(const pay of active) {sums.abonado+=pay.monto;const a=pay.comprobante_snapshot?JSON.parse(pay.comprobante_snapshot).asignacion:null;for(const key of ['subtotal','tax','service'])sums[key]+=Number(a?.[key]||0);}return [[sums]]; }
    if (sql.startsWith('SELECT * FROM cuenta_divisiones')) return [state.divisions.filter(p => p.id === args[0] && p.pedido_id === args[1])];
    if (sql.startsWith('INSERT INTO pago_desglose')) { state.parts.push({ pago_id: args[0], metodo: args[1], monto: args[2] }); return [{}]; }
    if (sql.startsWith('UPDATE pagos SET trabajador_id')) { Object.assign(state.payments.find(p => p.id === args[5]), { trabajador_id: args[0], division_id: args[1], idempotency_key: args[2], request_fingerprint: args[3], comprobante_snapshot: args[4] }); return [{}]; }
    if (sql.startsWith('DELETE FROM cuenta_divisiones')) { state.divisions = state.divisions.filter(p => p.pedido_id !== args[0] || p.estado !== 'PENDIENTE'); return [{}]; }
    if (sql.startsWith('SELECT * FROM pagos WHERE id')) return [state.payments.filter((p) => p.id === Number(args[0]))];
    if (sql.startsWith('UPDATE pagos SET estado')) { state.payments.find((p) => p.id === args[2]).estado = sql.includes("'ANULADO'") ? 'ANULADO' : 'DEVUELTO'; return [{}]; }
    if (sql.startsWith('UPDATE caja SET total_ventas')) return [{}];
    if (sql.startsWith("UPDATE pedidos SET estado = 'ENTREGADO'")) { state.order.estado = 'ENTREGADO'; return [{}]; }
    if (sql.startsWith('UPDATE cuenta_divisiones')) { for (const d of state.divisions) if (sql.includes('WHERE id =') ? d.id === args[0] : d.pedido_id === args[0]) d.estado = sql.includes("'PENDIENTE'") ? 'PENDIENTE' : 'PAGADO'; return [{}]; }
    if (sql.startsWith('SELECT * FROM pedidos WHERE id')) return [[state.order]];
    if (sql.startsWith('SELECT id FROM pagos WHERE pedido_id')) return [state.payments.filter((p) => p.pedido_id === args[0] && p.estado === 'ACTIVO')];
    if (sql.startsWith('SELECT prefijo, siguiente')) return [[{ prefijo: 'TCK', siguiente: state.sequence }]];
    if (sql.startsWith('UPDATE caja_secuencias')) { state.sequence = args[0]; return [{}]; }
    if (sql.startsWith('INSERT INTO pagos')) { state.payments.push({ id: state.payments.length + 1, pedido_id: args[0], caja_id: args[1], monto: args[2], metodo: args[3], estado: 'ACTIVO', iva_declarado: args[8], subtotal: args[12], comprobante_numero: args[10] }); return [{ insertId: state.payments.length }]; }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, connection: () => {
    let releaseLock, snapshot;
    return { query: async (sql, args) => {
      if (sql.startsWith('SELECT id FROM caja_control')) {
        const previous = tail;
        tail = new Promise((resolve) => { releaseLock = resolve; });
        await previous;
        snapshot = structuredClone(state);
        calls.push({ sql, args }); return [[{ id: 1 }]];
      }
      return database.query(sql,args);
    }, beginTransaction: async () => {},
    commit: async () => { database.commits++; snapshot = null; releaseLock?.(); releaseLock = null; },
    rollback: async () => { database.rollbacks++; if (snapshot) Object.assign(state, snapshot); snapshot = null; releaseLock?.(); releaseLock = null; },
    release: () => { releaseLock?.(); },
    };
  } };
  return database;
}
async function request(path, body = {}, id = 1, method = 'post') {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ body, params: { id }, query: {}, user: { id: 1, rol: 'admin' } }, res);
  return res;
}

test('cash amounts reject negative, NaN, null, infinite, fractional-cent and out-of-range values', () => {
  for (const value of [-1, NaN, null, true, '', Infinity, 'abc', 1.001, 100000000]) assert.throws(() => cashAmount(value));
  assert.equal(cashAmount('12,30'), 12.3);
  assert.equal(cashAmount(0), 0);
  assert.throws(() => cashAmount(0, { positive: true }));
  assert.throws(() => validateMethod('Mixto'), /desglose/);
});

test('cash expectation ignores card movement and does not deduct reversed payments twice', () => {
  assert.equal(expectedCash(20, { efectivo: 100, ingresos_efectivo: 5, retiros_efectivo: 2, gastos_efectivo: 1, devoluciones: 50 }), 122);
});

test('receipt respects zero tax, stored service and total with cent precision', () => {
  const order = { total: 11, items: [{ precio: 10, cantidad: 1 }] };
  assert.deepEqual(receiptTotals(order, 0), { subtotal: 10, tax: 0, service: 1, total: 11, taxPercent: 0 });
  const totals = receiptTotals(order, 15);
  assert.equal(Math.round((totals.subtotal + totals.tax + totals.service) * 100), 1100);
});

test('two simultaneous openings produce only one shared open register', async () => {
  db = fixture({ open: false });
  const results = await Promise.all([request('/abrir', { monto_inicial: 20 }), request('/abrir', { monto_inicial: 20 })]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200,201]);
  assert.equal(db.state.cajas.filter((c) => c.estado === 'Abierta').length,1);
  assert.equal(results[0].body.id, results[1].body.id);
});

test('closure totals include more than 30 payments and only cash movements, without a second refund deduction', async () => {
  const payments = Array.from({ length: 45 }, (_, i) => ({ id: i+1, caja_id: 1, metodo: 'Efectivo', monto: 10, estado: i === 0 ? 'DEVUELTO' : 'ACTIVO' }));
  db = fixture({ payments, movements: [
    { caja_id: 1, tipo: 'DEVOLUCION', metodo: 'Efectivo', monto: 10 },
    { caja_id: 1, tipo: 'GASTO', metodo: 'Tarjeta', monto: 50 },
    { caja_id: 1, tipo: 'RETIRO', metodo: 'Efectivo', monto: 5 },
  ] });
  const result = await request('/cerrar', { caja_id: 1, monto_final: '455.00' });
  assert.equal(result.statusCode,200,JSON.stringify(result.body));
  assert.equal(result.body.resumen.efectivo_esperado,455);
  assert.equal(result.body.resumen.diferencia,0);
  assert.equal(db.commits,1);
});

test('stale closure cannot close a newly opened register', async () => {
  db = fixture();
  const result = await request('/cerrar', { caja_id: 99, monto_final: 20 });
  assert.equal(result.statusCode,409);
  assert.equal(db.state.cajas[0].estado,'Abierta');
});

test('closure and movement are serialized; movement cannot enter a closed register', async () => {
  db = fixture();
  const [closed, moved] = await Promise.all([
    request('/cerrar', { caja_id: 1, monto_final: 20 }),
    request('/movimientos', { caja_id: 1, tipo: 'INGRESO', monto: 5, metodo: 'Efectivo', motivo: 'Cambio' }),
  ]);
  assert.equal(closed.statusCode,200,JSON.stringify(closed.body));
  assert.ok([201,409].includes(moved.statusCode));
  // Either serialized order is valid: include the movement before closure, or reject it afterward.
  assert.equal(closed.body.resumen.efectivo_esperado,moved.statusCode === 201 ? 25 : 20);
  assert.equal(db.state.movements.length,moved.statusCode === 201 ? 1 : 0);
});

test('invalid opening, movement, closure and edited closure never commit', async () => {
  for (const [path, body, method] of [
    ['/abrir',{ monto_inicial: -5 },'post'], ['/movimientos',{ tipo: 'INGRESO', monto: 'x', motivo: 'x' },'post'],
    ['/cerrar',{ caja_id: 1, monto_final: -3 },'post'], ['/cierres/:id',{ monto_final: -3 },'put'],
  ]) {
    db = fixture({ open: path !== '/cierres/:id' });
    const result = await request(path,body,1,method);
    assert.equal(result.statusCode,400,JSON.stringify(result.body));
    assert.equal(db.commits,0);
  }
});

test('closed-register payment reversals are rejected without changing historical totals', async () => {
  for (const path of ['/pagos/:id/anular','/pagos/:id/devolver']) {
    db = fixture({ open: false, payments: [{ id: 1, caja_id: 1, monto: 10, estado: 'ACTIVO', metodo: 'Efectivo' }] });
    const result = await request(path,{ motivo: 'Correccion' });
    assert.equal(result.statusCode,409,JSON.stringify(result.body));
    assert.equal(db.state.payments[0].estado,'ACTIVO');
    assert.equal(db.state.movements.length,0);
  }
});

test('refunding twice produces a single reversal movement', async () => {
  db = fixture({ payments: [{ id: 1, pedido_id: 12, caja_id: 1, monto: 10, estado: 'ACTIVO', metodo: 'Efectivo' }] });
  const responses = await Promise.all([request('/pagos/:id/devolver',{ motivo: 'Correccion' }),request('/pagos/:id/devolver',{ motivo: 'Correccion' })]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(),[200,409]);
  assert.equal(db.state.movements.length,1);
});

test('a successful charge returns the saved bill and zero tax instead of trusting supplied tax', async () => {
  db = fixture();
  const result = await request('/cobrar',{ pedido_id: 12, caja_id: 1, metodo: 'Tarjeta', monto: 11, iva_declarado: 999 });
  assert.equal(result.statusCode,201,JSON.stringify(result.body));
  assert.equal(db.state.payments[0].iva_declarado,0);
  assert.equal(result.body.pedido.estado,'PAGADO');
  assert.equal(result.body.pedido.totales_cobro.service,1);
  assert.equal(result.body.pedido.rondas[0].estado,'LISTO');
});

test('charge after closure and unsupported mixed payments save no payment', async () => {
  for (const metodo of ['Mixto','Efectivo']) {
    db = fixture({ open: false });
    const result = await request('/cobrar',{ pedido_id: 12, caja_id: 1, metodo, monto: 11 });
    assert.equal(result.statusCode,metodo === 'Mixto' ? 400 : 409,JSON.stringify(result.body));
    assert.equal(db.state.payments.length,0);
  }
});

test('failing to read the receipt cannot commit an unreported payment', async () => {
  db = fixture(); db.failHydrationAt = 2;
  const result = await request('/cobrar',{ pedido_id: 12, caja_id: 1, metodo: 'Efectivo', monto: 11 });
  assert.equal(result.statusCode,500);
  assert.equal(db.commits,0);
  assert.equal(db.state.payments.length,0);
});


test('simultaneous charges of the same bill cannot record two payments', async () => {
  db = fixture();
  const body = { pedido_id: 12, caja_id: 1, metodo: 'Tarjeta', monto: 11 };
  const results = await Promise.all([request('/cobrar',body),request('/cobrar',body)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(),[201,409]);
  assert.equal(db.state.payments.length,1);
});

test('reopening a closure cannot create a second open register', async () => {
  db = fixture();
  db.state.cajas.push({ id: 2, estado: 'Cerrada', monto_inicial: 10 });
  const result = await request('/cierres/:id/reabrir',{},2);
  assert.equal(result.statusCode,409);
  assert.equal(db.state.cajas[1].estado,'Cerrada');
});


test('mixed partial payment preserves the open account; final payment closes it and totals reconcile', async () => {
  db = fixture();
  const first = await request('/cobrar', { pedido_id:12, caja_id:1, metodo:'Mixto', monto:5, parcial:true, idempotency_key:'test_partial_0000001',
    desglose:[{metodo:'Efectivo',monto:2},{metodo:'Tarjeta',monto:3}], efectivo_recibido:5 });
  assert.equal(first.statusCode,201,JSON.stringify(first.body));
  assert.equal(db.state.order.estado,'LISTO');
  assert.equal(first.body.snapshot.saldo_pendiente,6);
  assert.equal(first.body.snapshot.cambio,3);
  const second = await request('/cobrar', { pedido_id:12, caja_id:1, metodo:'Efectivo', monto:6, idempotency_key:'test_partial_0000002' });
  assert.equal(second.statusCode,201,JSON.stringify(second.body));
  assert.equal(db.state.order.estado,'PAGADO');
  assert.equal(second.body.snapshot.abonado_anterior,5);
  const closure = await request('/cerrar',{caja_id:1,monto_final:28});
  assert.equal(closure.body.resumen.efectivo,8);
  assert.equal(closure.body.resumen.tarjeta,3);
  assert.equal(closure.body.resumen.total,11);
  assert.equal(closure.body.resumen.efectivo_esperado,28);
});

test('a retry after lost response uses one payment and one receipt even after account closure', async () => {
  db=fixture(); const body={pedido_id:12,caja_id:1,metodo:'Tarjeta',monto:11,idempotency_key:'test_retry_00000001'};
  const [a,b]=await Promise.all([request('/cobrar',body),request('/cobrar',body)]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,201]);
  assert.equal(db.state.payments.length,1);assert.equal(db.state.sequence,2);
  assert.equal(a.body.comprobante_numero,b.body.comprobante_numero);
  const conflict=await request('/cobrar',{...body,monto:10});
  assert.equal(conflict.statusCode,409);
});

test('concurrent different advances cannot overpay the remaining balance', async () => {
  db=fixture();const base={pedido_id:12,caja_id:1,metodo:'Tarjeta',monto:7,parcial:true};
  const result=await Promise.all([request('/cobrar',{...base,idempotency_key:'concurrent_partial_01'}),request('/cobrar',{...base,idempotency_key:'concurrent_partial_02'})]);
  assert.deepEqual(result.map(r=>r.statusCode).sort(),[201,409]);assert.equal(db.state.payments.length,1);
});

test('named division is paid once, while other diners remain pending', async () => {
  db=fixture();db.state.divisions=[{id:1,pedido_id:12,nombre:'Ana',monto:5,estado:'PENDIENTE'},{id:2,pedido_id:12,nombre:'Luis',monto:6,estado:'PENDIENTE'}];
  const body={pedido_id:12,caja_id:1,metodo:'Tarjeta',monto:5,parcial:true,division_id:1,idempotency_key:'division_pay_000001'};
  const first=await request('/cobrar',body);assert.equal(first.statusCode,201,JSON.stringify(first.body));
  assert.equal(db.state.divisions[0].estado,'PAGADO');assert.equal(db.state.divisions[1].estado,'PENDIENTE');
  assert.equal(first.body.snapshot.division.nombre,'Ana');
  const repeated=await request('/cobrar',{...body,idempotency_key:'division_pay_000002'});assert.equal(repeated.statusCode,409);
});
