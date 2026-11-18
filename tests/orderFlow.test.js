import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// All persistence and external notifications are replaced before importing routes.
// These tests never connect to the configured database or send push notifications.
let database;
const pool = {
  query: (...args) => database.query(...args),
  getConnection: async () => database,
};
mock.module('../services/stockReservations.js', { namedExports: { reserveRoundStock: async () => {}, consumeRoundReservation: async () => false, releaseOrderReservations: async () => {} } });
mock.module('../db.js', { namedExports: { pool } });
mock.module('../middleware/auth.js', { namedExports: { verifyRole: () => (_req, _res, next) => next() } });
mock.module('../services/audit.js', { namedExports: { ensureAuditTable: async () => {}, safeLogAudit: async () => {} } });
mock.module('../services/businessConfig.js', { namedExports: { getBusinessConfig: async () => ({ servicio_porcentaje: '10' }) } });
mock.module('../routes/notificaciones.js', { namedExports: { sendPushToUser: async () => {} } });
let queued = [];
mock.module('../services/printQueue.js', { namedExports: {
  ensurePrintQueue: async () => {},
  enqueuePrint: async (conn, payload) => {
    queued.push({ conn, payload, committed: database.committed });
    return { id: 'test-job', estado: 'PENDIENTE' };
  },
} });

const { default: router, consumeInventoryItems, transitionPedido } = await import('../routes/pedidos.js');
const { freeMesaIfNoActive, listMesas } = await import('../services/tableState.js');

function fixture({ estado = 'PREPARANDO', stock = 5, active = true, advance = false } = {}) {
  const order = { id: 12, mesa_id: 1, mesa_numero: 1, estado, total: 11, inventario_descontado: 1, tipo: 'Mesa' };
  const rounds = [{ id: 30, pedido_id: 12, estado, inventario_descontado: 1 }];
  const oldItem = { id: 20, ronda_id: 30, pedido_id: 12, producto_id: 2, cantidad: 1, precio: 10, nombre: 'Plato anterior' };
  const items = [oldItem];
  const calls = [];
  let committed = 0;
  let rolledBack = 0;
  let available = 1;
  const db = {
    calls, order, items, rounds, requests: new Map(),
    get stock() { return stock; },
    get available() { return available; },
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    beginTransaction: async () => {},
    commit: async () => { committed += 1; },
    rollback: async () => { rolledBack += 1; },
    release: () => {},
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id FROM pagos WHERE pedido_id IN')) return [advance ? [{ id: 1 }] : []];
      if (sql.startsWith('INSERT INTO pedido_solicitudes')) { if (!db.requests.has(params[1])) db.requests.set(params[1], { huella: params[2], respuesta: null }); return [{}]; }
      if (sql.startsWith('SELECT huella, respuesta')) return [[db.requests.get(params[1])]];
      if (sql.startsWith('UPDATE pedido_solicitudes')) { db.requests.get(params[2]).respuesta = params[0]; return [{}]; }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [[{ COLUMN_NAME: params[1] }]];
      if (sql.startsWith('SET TRANSACTION')) return [{}];
      if (sql.startsWith('CREATE TABLE')) return [{}];
      if (sql.startsWith('SELECT id, activo FROM mesas')) return [[{ id: 1, activo: 1 }]];
      if (sql.includes('FROM reservas WHERE mesa_id = ?')) return [db.reservas || []];
      if (sql.startsWith('UPDATE reservas SET estado')) { db.seated = params[0]; return [{}]; }
      if (sql.startsWith('SELECT nombre, precio, tipo FROM extras')) return [[]];
      if (sql.startsWith('SELECT id, nombre, precio, disponible, agotado FROM productos')) return [[{ id: 1, nombre: 'Cafe nuevo', precio: 5, disponible: 1, agotado: 0 }]];
      if (sql.startsWith('SELECT id, total, notas, estado')) return [active ? [{ ...order }] : []];
      if (sql.startsWith('SELECT id, mesa_id FROM pedidos') || sql.startsWith('SELECT mesa_id FROM pedidos') || sql.startsWith('SELECT id, mesa_id, estado FROM pedidos')) return [[{ ...order }]];
      if (sql.startsWith('SELECT id FROM mesas')) return [[{ id: 1 }]];
      if (sql.startsWith('SELECT * FROM pedidos')) return [[{ ...order }]];
      if (sql.startsWith('SELECT COUNT(*) AS activos')) return [[{ activos: order.estado !== 'PAGADO' || rounds.some((r) => ['PENDIENTE','PREPARANDO','LISTO'].includes(r.estado)) ? 1 : 0 }]];
      if (sql.startsWith('SELECT * FROM pedido_rondas WHERE id =')) return [rounds.filter((r) => r.id === Number(params[0]) && r.pedido_id === Number(params[1])).map((r) => ({ ...r }))];
      if (sql.startsWith('SELECT') && sql.includes('FROM pedido_rondas')) return [rounds.map((r) => ({ ...r }))];
      if (sql.startsWith('INSERT INTO pedido_rondas')) { const id = 30 + rounds.length; rounds.push({ id, pedido_id: params[0], estado: 'PENDIENTE', inventario_descontado: 0, creado_por: params[2] ?? null, creado_por_nombre: params[3] ?? null, pedido_origen_id: params[4] ?? null }); return [{ insertId: id }]; }
      if (sql.startsWith('DELETE FROM cuenta_divisiones')) return [{}];
      if (sql.startsWith('UPDATE pedido_rondas SET inventario_descontado = 1')) { rounds.find((r) => r.id === params[0]).inventario_descontado = 1; return [{}]; }
      if (sql.startsWith('UPDATE pedido_rondas SET estado = ?')) { const round = rounds.find((r) => r.id === params.at(-1)); round.estado = params[0]; if (sql.includes('entregado_por = ?')) Object.assign(round, { entregado_por: params[1], entregado_por_nombre: params[2] }); return [{}]; }
      if (sql.startsWith('UPDATE pedidos SET inventario_descontado = 1')) { order.inventario_descontado = 1; return [{}]; }
      if (sql.startsWith('UPDATE pedidos SET estado = ?')) { if (!sql.includes("AND estado NOT IN") || !['PAGADO','CANCELADO'].includes(order.estado)) order.estado = params[0]; return [{}]; }
      if (sql.startsWith('SELECT id FROM pedidos WHERE id')) return [[{ id: order.id }]];
      if (sql.startsWith('SELECT id FROM detalle_pedidos')) return [items.filter((item) => !sql.includes('ronda_id = ?') || item.ronda_id === params[1]).map(({ id }) => ({ id }))];
      if (sql.startsWith('SELECT mesa_id, estado FROM pedidos')) return [[{ ...order }]];
      if (sql.startsWith('SELECT p.*')) return [[{ ...order }]];
      if (sql.startsWith('SELECT dpm.id')) return [db.modifiers || []];
      if (sql.startsWith('SELECT dp.id, dp.pedido_id')) return [items.map((item) => ({ ...item, modificadores_json: null }))];
      if (sql.startsWith('SELECT dp.id AS detalle_id')) {
        const selected = params[1] ? items.filter((item) => params[1].includes(item.id)) : items;
        return [selected.map((item) => ({ ...item, stock, inventario_item_id: null }))];
      }
      if (sql.includes('FROM recetas r')) return [[]];
      if (sql.startsWith('SELECT stock FROM productos')) {
        assert.match(sql, /FOR UPDATE$/, 'must lock and read current stock');
        return [[{ stock }]];
      }
      if (sql.startsWith('UPDATE productos')) {
        // Model MySQL single-table assignment evaluation from left to right.
        for (const assignment of sql.split(' SET ')[1].split(' WHERE ')[0].split(',')) {
          if (assignment.trim().startsWith('stock =')) stock -= Number(params[0]);
          if (assignment.trim().startsWith('disponible =') && stock - Number(params[0]) <= 0) available = 0;
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE pedidos SET total')) {
        order.total = params[0]; order.estado = 'PENDIENTE';
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO pedidos')) {
        Object.assign(order, { mesa_id: params[0], total: params[2], tipo: params[3], estado: 'PENDIENTE', inventario_descontado: 0 });
        items.length = 0; rounds.length = 0;
        return [{ insertId: order.id }];
      }
      if (sql.startsWith('UPDATE pedidos SET cliente_nombre')) return [{ affectedRows: 1 }];
      if (sql.startsWith('UPDATE pedidos SET cuenta_solicitada_at')) {
        order.cuenta_solicitada_at = '2026-09-10 00:05:00';
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO detalle_pedidos')) {
        const id = 21 + items.length - 1;
        items.push({ id, pedido_id: params[0], producto_id: params[1], cantidad: params[2], precio: params[3], ronda_id: params[5], nombre: 'Cafe nuevo' });
        return [{ insertId: id }];
      }
      if (sql.startsWith('UPDATE mesas SET estado')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT m.id')) return [[{ id: 1, pedidos_activos: 1, estado: 'Ocupada' }]];
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
  return db;
}

async function request(method, path, body = {}, { rondaId = 30, rol = 'mesero', id = 1, nombre = 'Usuario de prueba' } = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { id: 12, rondaId }, query: {}, body, user: { id, nombre, rol } }, res);
  return res;
}

test('a new round records its authenticated creator and original account, ignoring supplied actors', async () => {
  database = fixture();
  const response = await request('post', '/', { mesa_id: 1, creado_por: 999, creado_por_nombre: 'Falso', items: [{ producto_id: 1, cantidad: 1 }] }, { id: 7, nombre: 'Ana Mesero' });
  assert.equal(response.statusCode, 201, JSON.stringify(response.body));
  assert.equal(database.rounds[1].creado_por, 7);
  assert.equal(database.rounds[1].creado_por_nombre, 'Ana Mesero');
  assert.equal(database.rounds[1].pedido_origen_id, 12);
});

test('delivery records its real actor and a repeated confirmation cannot replace that person', async () => {
  database = fixture({ estado: 'LISTO' });
  const first = await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO', entregado_por: 999 }, { id: 8, nombre: 'Luis Mesero' });
  assert.equal(first.statusCode, 200, JSON.stringify(first.body));
  assert.equal(database.rounds[0].entregado_por, 8);
  const retry = await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' }, { id: 9, nombre: 'Otra persona' });
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(database.rounds[0].entregado_por, 8);
  assert.equal(database.rounds[0].entregado_por_nombre, 'Luis Mesero');
});

test('tracking rejects malformed order identifiers before reading persistence', async()=>{
  database=fixture();
  const route=router.stack.find(layer=>layer.route?.path==='/:id/seguimiento').route;
  for(const id of ['0','-1','3.5','1 OR 1=1','9007199254740992']){
    const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
    await route.stack.at(-1).handle({params:{id},user:{id:1,rol:'mesero'}},res);
    assert.equal(res.statusCode,400);
  }
  assert.equal(database.calls.length,0);
});

test('requesting or printing a bill preserves kitchen state; closed orders are rejected', async () => {
  for (const path of ['/:id/solicitar-cobro', '/:id/imprimir-precuenta']) {
    for (const estado of ['PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'PAGADO', 'CANCELADO']) {
      database = fixture({ estado });
      const result = await request('post', path);
      const closed = ['PAGADO', 'CANCELADO'].includes(estado);
      assert.equal(result.statusCode, closed ? 409 : 200, JSON.stringify(result.body));
      assert.equal(database.order.estado, estado);
      assert.equal(database.committed, closed ? 0 : 1);
    }
  }
});

test('the generic state endpoint cannot mark an account paid without a payment', async () => {
  database = fixture();
  for (const estado of ['PAGADO', 'Pagado', 'Completado']) {
    const result = await request('put', '/:id', { estado });
    assert.equal(result.statusCode, 403);
  }
  assert.equal(database.calls.length, 0);
});

test('a second round preserves the earlier preparation, uses server prices and prints only new lines', async () => {
  database = fixture({ stock: 5 });
  queued = [];
  const result = await request('post', '/', { mesa_id: 1, total: 999, items: [{ producto_id: 1, cantidad: 2, precio: 0.01 }] });
  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  assert.equal(database.stock, 5, 'new pending round waits for preparation');
  assert.equal(database.rounds[0].estado, 'PREPARANDO');
  assert.equal(database.rounds[1].estado, 'PENDIENTE');
  assert.equal(database.available, 1, 'remaining stock must remain available');
  assert.equal(result.body.pedido.total, 22);
  assert.equal(result.body.pedido.items.length, 2, 'the full bill still includes earlier rounds');
  assert.match(result.body.comanda, /Cafe nuevo/);
  assert.doesNotMatch(result.body.comanda, /Plato anterior/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].conn, database);
  assert.equal(queued[0].committed, 0, 'print job must be saved before order commit');
  assert.equal(queued[0].payload.texto, result.body.comanda);
  assert.equal(result.body.cocina.impresion.estado, 'PENDIENTE');
  const tableLock = database.calls.findIndex(({ sql }) => sql.startsWith('SELECT id, activo FROM mesas'));
  const activeLookup = database.calls.findIndex(({ sql }) => sql.startsWith('SELECT id, total, notas, estado'));
  assert.ok(tableLock < activeLookup);
  assert.match(database.calls[tableLock].sql, /FOR UPDATE/);
  assert.doesNotMatch(database.calls[activeLookup].sql, /CURDATE/);
});

test('a pending first round defers stock consumption to preparation', async () => {
  database = fixture({ estado: 'PENDIENTE' });
  database.order.inventario_descontado = 0;
  const result = await request('post', '/', { mesa_id: 1, items: [{ producto_id: 1, cantidad: 1 }] });
  assert.equal(result.statusCode, 201, JSON.stringify(result.body));
  assert.equal(database.stock, 5);
});

test('new table and express orders save only their real items and the server total', async () => {
  for (const tipo of ['Mesa', 'Para llevar', 'Delivery']) {
    database = fixture({ active: false });
    const result = await request('post', '/', {
      tipo, mesa_id: 1, cliente_nombre: 'Cliente', total: 1,
      items: [{ producto_id: 1, cantidad: 1, precio: 1 }],
    });
    assert.equal(result.statusCode, 201, JSON.stringify(result.body));
    assert.equal(result.body.pedido.total, 5.5);
    assert.equal(result.body.pedido.items.length, 1);
    assert.equal(result.body.pedido.mesa_id, tipo === 'Mesa' ? 1 : null);
    assert.match(result.body.comanda, /Cafe nuevo/);
  }
});

test('una mesa apartada por una reserva no abre cuenta sin confirmar', async () => {
  const { localNowStamp } = await import('../services/businessTime.js');
  const reserva = { id: 7, mesa_id: 1, cliente_nombre: 'Ana Pérez', personas: 4, fecha_hora: localNowStamp(new Date(Date.now() + 10 * 60000)), duracion_min: 90, estado: 'CONFIRMADA' };
  const body = { tipo: 'Mesa', mesa_id: 1, avisar_reserva: true, items: [{ producto_id: 1, cantidad: 1, precio: 5 }] };

  database = fixture({ active: false }); database.reservas = [reserva];
  const blocked = await request('post', '/', body);
  assert.equal(blocked.statusCode, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'MESA_RESERVADA');
  assert.equal(blocked.body.reserva.id, 7);
  assert.match(blocked.body.message, /Ana Pérez/);
  assert.equal(database.committed, 0);

  database = fixture({ active: false }); database.reservas = [reserva];
  const anyway = await request('post', '/', { ...body, ignorar_reserva: true });
  assert.equal(anyway.statusCode, 201, JSON.stringify(anyway.body));
  assert.equal(database.seated, undefined);

  database = fixture({ active: false }); database.reservas = [reserva];
  const seated = await request('post', '/', { ...body, reserva_id: 7 });
  assert.equal(seated.statusCode, 201, JSON.stringify(seated.body));
  assert.equal(database.seated, 7); // la reserva pasa a «Llegó»

  // Una app sin actualizar (no manda avisar_reserva) no se queda bloqueada.
  database = fixture({ active: false }); database.reservas = [reserva];
  const old = await request('post', '/', { tipo: 'Mesa', mesa_id: 1, items: [{ producto_id: 1, cantidad: 1, precio: 5 }] });
  assert.equal(old.statusCode, 201, JSON.stringify(old.body));

  // Con cuenta abierta la reserva no estorba: se añade la ronda.
  database = fixture({ estado: 'PENDIENTE' }); database.reservas = [reserva];
  const round = await request('post', '/', body);
  assert.equal(round.statusCode, 201, JSON.stringify(round.body));
});

test('products remain available until the stock actually reaches zero', async () => {
  database = fixture({ stock: 5 });
  await consumeInventoryItems(database, [{ producto_id: 1, cantidad: 3, nombre: 'Cafe' }], 12);
  assert.equal(database.stock, 2);
  assert.equal(database.available, 1);
  await consumeInventoryItems(database, [{ producto_id: 1, cantidad: 2, nombre: 'Cafe' }], 12);
  assert.equal(database.stock, 0);
  assert.equal(database.available, 0);
});

test('insufficient stock prevents starting a round', async () => {
  database = fixture({ stock: 0, estado: 'PENDIENTE' });
  database.rounds[0].inventario_descontado = 0;
  const result = await request('put', '/:id/rondas/:rondaId', { estado: 'PREPARANDO' }, { rol: 'cocina' });
  assert.equal(result.statusCode, 409);
  assert.match(result.body.message, /Sin stock/);
  assert.equal(database.committed, 0);
  assert.equal(database.rolledBack, 1);
});

test('two variants of one product cannot consume the same last unit twice', async () => {
  database = fixture({ stock: 1 });
  const item = { producto_id: 1, cantidad: 1, nombre: 'Cafe', stock: 1 };
  await assert.rejects(consumeInventoryItems(database, [item, { ...item }], 12), /Sin stock/);
  assert.equal(database.stock, 0);
});

test('invalid quantities and malformed item lists fail before saving', async () => {
  for (const items of [null, {}, [], [null], [{ producto_id: 1, cantidad: 'abc' }], [{ producto_id: 1, cantidad: 0.5 }]]) {
    database = fixture();
    const result = await request('post', '/', { mesa_id: 1, items });
    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.equal(database.committed, 0);
    assert.equal(database.items.length, 1);
  }
});

test('active orders are not dropped by a day boundary or the first 100 results', async () => {
  database = fixture();
  const realQuery = database.query;
  database.query = async (sql, params) => {
    if (/^UPDATE (pedidos p|mesas m)/.test(sql.trim())) return [{}];
    return realQuery(sql, params);
  };
  const result = await request('get', '/');
  assert.equal(result.statusCode, 200);
  const list = database.calls.find(({ sql }) => sql.startsWith('SELECT p.*')).sql;
  assert.match(list, /WHERE p.estado NOT IN/);
  assert.match(list, /OR EXISTS.*pedido_rondas/);
  assert.doesNotMatch(list, /LIMIT/);
});

test('table availability and release consider unpaid orders from previous days', async () => {
  const calls = [];
  database = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('COUNT(*) AS activos')) return [[{ activos: 1 }]];
    return [[]];
  } };
  assert.equal(await freeMesaIfNoActive(database, 1), false);
  await listMesas({}, database);
  for (const sql of calls) assert.doesNotMatch(sql, /CURDATE|DATE\(/);
  assert.ok(!calls.some((sql) => sql.startsWith('UPDATE mesas SET estado')));
});


test('manual kitchen print queues a real ticket, not a success-only notification', async () => {
  database = fixture();
  queued = [];
  const result = await request('post', '/:id/imprimir-comanda');
  assert.equal(result.statusCode, 202);
  assert.equal(queued.length, 1);
  assert.match(queued[0].payload.texto, /Plato anterior/);
  assert.equal(result.body.job.estado, 'PENDIENTE');
});

test('a stale kitchen action cannot advance a newly added round', async () => {
  database = fixture();
  database.items.push({ id: 21, cantidad: 1 });
  const result = await request('put', '/:id', { estado: 'LISTO', expected_item_ids: [20] });
  assert.equal(result.statusCode, 409);
  assert.match(result.body.message, /ronda correspondiente/);
  assert.equal(database.committed, 0);
  assert.equal(database.order.estado, 'PREPARANDO');
});


test('long modifiers and preparation instructions survive hydration and ticket generation', async () => {
  database = fixture();
  const instruction = 'Sin ingrediente especial '.repeat(60) + 'FIN INSTRUCCION';
  database.modifiers = [{ id: 1, detalle_pedido_id: 20, nombre: instruction, tipo: 'NOTA', precio_extra: 0 }];
  queued = [];
  const result = await request('post', '/:id/imprimir-comanda');
  assert.equal(result.statusCode, 202);
  assert.ok(queued[0].payload.texto.replace(/\s/g, '').includes(instruction.replace(/\s/g, '')));
});


test('paying pending food keeps it in kitchen; starting it later does not consume stock twice', async () => {
  database = fixture({ estado: 'PENDIENTE' });
  database.rounds[0].inventario_descontado = 0;
  await transitionPedido(database, 12, 'PAGADO', { allowShortcut: true });
  assert.equal(database.stock, 4);
  assert.equal(database.order.estado, 'PAGADO');
  assert.equal(database.rounds[0].estado, 'PENDIENTE');
  const result = await request('put', '/:id/rondas/:rondaId', { estado: 'PREPARANDO' }, { rol: 'cocina' });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.pedido.estado_cobro, 'PAGADO');
  assert.equal(result.body.pedido.estado_cocina, 'PREPARANDO');
  assert.equal(result.body.pedido.pendiente_entrega, true);
  assert.equal(database.stock, 4);
});

test('delivering one ready round preserves a pending round and keeps the table occupied', async () => {
  database = fixture({ estado: 'LISTO' });
  database.rounds.push({ id: 31, pedido_id: 12, estado: 'PENDIENTE', inventario_descontado: 0 });
  const result = await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(database.rounds[0].estado, 'ENTREGADO');
  assert.equal(database.rounds[1].estado, 'PENDIENTE');
  assert.equal(result.body.pedido.estado, 'PENDIENTE');
  assert.equal(result.body.mesa_liberada, false);
});

test('paid table is released only after its last round is delivered; repeat delivery is idempotent', async () => {
  database = fixture({ estado: 'PAGADO' });
  database.rounds[0].estado = 'LISTO';
  for (let i = 0; i < 2; i++) {
    const result = await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.mesa_liberada, true);
    assert.equal(result.body.pedido.estado_cobro, 'PAGADO');
    assert.equal(result.body.pedido.pendiente_entrega, false);
  }
});

test('round actions reject skipped states, another account round, and wrong staff role', async () => {
  database = fixture({ estado: 'PENDIENTE' });
  assert.equal((await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' })).statusCode, 409);
  assert.equal((await request('put', '/:id/rondas/:rondaId', { estado: 'PREPARANDO' })).statusCode, 403);
  assert.equal((await request('put', '/:id/rondas/:rondaId', { estado: 'PREPARANDO' }, { rol: 'cocina', rondaId: 999 })).statusCode, 409);
  assert.equal(database.committed, 0);
});

test('manual printing a round contains only its products and its round number', async () => {
  database = fixture();
  database.rounds.push({ id: 31, pedido_id: 12, estado: 'PENDIENTE' });
  database.items.push({ id: 21, ronda_id: 31, pedido_id: 12, cantidad: 1, nombre: 'Postre', precio: 4 });
  queued = [];
  const result = await request('post', '/:id/imprimir-comanda', { ronda_id: 31 });
  assert.equal(result.statusCode, 202);
  assert.match(queued[0].payload.texto, /Ronda #31/i);
  assert.match(queued[0].payload.texto_marcado, /\u001fT/);
  assert.match(queued[0].payload.texto, /Postre/);
  assert.doesNotMatch(queued[0].payload.texto, /Plato anterior/);
});

test('moving a whole table merges every unpaid source/destination account and carries paid food', async () => {
  const orders = [
    { id: 12, mesa_id: 1, estado: 'LISTO', total: 10 },
    { id: 13, mesa_id: 1, estado: 'PENDIENTE', total: 5 },
    { id: 14, mesa_id: 2, estado: 'ENTREGADO', total: 3 },
    { id: 15, mesa_id: 1, estado: 'PAGADO', total: 7 },
  ];
  const rounds = orders.map((order, i) => ({ id: i + 30, pedido_id: order.id, estado: order.estado === 'PAGADO' ? 'PREPARANDO' : order.estado, inventario_descontado: i === 1 ? 0 : 1 }));
  const details = rounds.map((round, i) => ({ id: i + 20, pedido_id: round.pedido_id, ronda_id: round.id, cantidad: 1, precio: orders[i].total }));
  let committed = false;
  database = { beginTransaction: async () => {}, commit: async () => { committed = true; }, rollback: async () => {}, release: () => {},
    query: async (raw, args = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SET TRANSACTION')) return [{}];
      if (sql.startsWith('SELECT id, mesa_id FROM pedidos')) return [[{ ...orders[0] }]];
      if (sql.startsWith('SELECT id, activo FROM mesas')) return [[{ id: 1, activo: 1 },{ id: 2, activo: 1 }]];
      if (sql.startsWith('SELECT * FROM pedidos')) return [orders.filter((o) => o.estado !== 'PAGADO').map((o) => ({ ...o }))];
      if (sql.startsWith('SELECT id FROM pedidos WHERE mesa_id')) return [[{ id: 15 }]];
      if (sql.startsWith('UPDATE pedidos SET mesa_id')) { for (const o of orders) if (args[1].includes(o.id)) o.mesa_id = args[0]; return [{}]; }
      if (sql.startsWith('SELECT id FROM pagos')) return [[]];
      if (sql.startsWith('DELETE FROM cuenta_divisiones')) return [{}];
      if (sql.startsWith('UPDATE detalle_pedidos SET pedido_id') || sql.startsWith('UPDATE pedido_rondas SET pedido_id')) {
        for (const row of sql.includes('detalle_pedidos') ? details : rounds) if (args[1].includes(row.pedido_id)) row.pedido_id = args[0]; return [{}];
      }
      if (sql.startsWith('UPDATE pedidos SET total')) { orders.find((o) => o.id === args[2]).total = args[0]; return [{}]; }
      if (sql.startsWith("UPDATE pedidos SET estado = 'CANCELADO'")) { for (const o of orders) if (args[0].includes(o.id)) Object.assign(o,{ estado: 'CANCELADO', total: 0 }); return [{}]; }
      if (sql.startsWith('SELECT id, estado FROM pedido_rondas')) return [rounds.filter((r) => r.pedido_id === args[0])];
      if (sql.startsWith('UPDATE pedidos SET estado = ?')) { orders.find((o) => o.id === args[1]).estado = args[0]; return [{}]; }
      if (sql.startsWith('UPDATE mesas')) return [{}];
      if (sql.startsWith('SELECT COUNT(*) AS activos')) return [[{ activos: orders.filter((o) => o.mesa_id === args[0] && !['CANCELADO','PAGADO'].includes(o.estado)).length }]];
      if (sql.startsWith('SELECT p.*')) return [orders.filter((o) => o.id === args[0]).map((o) => ({ ...o }))];
      if (sql.startsWith('SELECT dp.id, dp.pedido_id')) return [details.filter((d) => args[0].includes(d.pedido_id))];
      if (sql.startsWith('SELECT dpm.id')) return [[]];
      if (sql.startsWith('SELECT * FROM pedido_rondas')) return [rounds.filter((r) => args[0].includes(r.pedido_id))];
      if (sql.startsWith('SELECT m.id')) return [[]];
      if (sql.startsWith('UPDATE cuenta_ajustes')) return [{}];
      throw new Error(`Unexpected transfer SQL: ${sql}`);
    },
  };
  const result = await request('post', '/:id/transferir', { mesa_id: 2 });
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(committed, true);
  assert.equal(result.body.pedido.total, 18);
  assert.equal(result.body.pedido.items.length, 3);
  assert.deepEqual(result.body.pedido.rondas.map((r) => r.estado), ['LISTO','PENDIENTE','ENTREGADO']);
  assert.deepEqual(rounds.map((r) => r.inventario_descontado), [1,0,1,1]);
  assert.equal(orders[3].mesa_id, 2);
  assert.equal(orders[3].total, 7);
  assert.equal(orders[3].estado, 'PAGADO');
  assert.ok(orders.slice(1,3).every((o) => o.estado === 'CANCELADO' && o.total === 0));
});


test('retrying a saved request returns its original round without another item or print', async () => {
  database = fixture(); queued = [];
  const body = { mesa_id: 1, request_id: 'request_retry_12345', items: [{ producto_id: 1, cantidad: 1 }] };
  const first = await request('post', '/', body);
  assert.equal(first.statusCode, 201, JSON.stringify(first.body));
  const retry = await request('post', '/', body);
  assert.equal(retry.statusCode, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.pedido, JSON.parse(JSON.stringify(first.body.pedido)));
  assert.equal(database.items.length, 2);
  assert.equal(database.rounds.length, 2);
  assert.equal(queued.length, 1);
  const conflict = await request('post', '/', { ...body, items: [{ producto_id: 1, cantidad: 2 }] });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'REQUEST_CONFLICT');
  assert.equal(queued.length, 1);
});

test('an Express round keeps its account, customer and delivery data and prints new items only', async () => {
  for (const tipo of ['Para llevar', 'Delivery']) {
    database = fixture({ active: false }); queued = [];
    Object.assign(database.order, { mesa_id: null, tipo, cliente_nombre: 'Ana', delivery_direccion: 'Calle 1' });
    const result = await request('post', '/', { pedido_id: 12, tipo, cliente_nombre: 'Otro', items: [{ producto_id: 1, cantidad: 1 }] });
    assert.equal(result.statusCode, 201, JSON.stringify(result.body));
    assert.equal(result.body.pedido.id, 12);
    assert.equal(result.body.pedido.total, 16.5);
    assert.equal(result.body.pedido.cliente_nombre, 'Ana');
    assert.equal(result.body.pedido.delivery_direccion, 'Calle 1');
    assert.equal(database.rounds[0].estado, 'PREPARANDO');
    assert.equal(database.rounds[1].estado, 'PENDIENTE');
    assert.equal(queued.length, 1);
    assert.doesNotMatch(result.body.comanda, /Plato anterior/);
    assert.ok(!database.calls.some(c => c.sql.startsWith('INSERT INTO pedidos ') || c.sql.startsWith('UPDATE pedidos SET cliente_nombre')));
  }
});

test('Express rounds reject paid, cancelled, partly paid or changed destinations', async () => {
  for (const overrides of [{ estado: 'PAGADO' }, { estado: 'CANCELADO' }, { advance: true }, { tipo: 'Mesa' }, { tipo: 'Delivery' }]) {
    database = fixture({ active: false, ...overrides }); queued = [];
    Object.assign(database.order, { mesa_id: null, tipo: overrides.tipo || 'Para llevar' });
    const result = await request('post', '/', { pedido_id: 12, tipo: 'Para llevar', items: [{ producto_id: 1, cantidad: 1 }] });
    assert.equal(result.statusCode, 409, JSON.stringify(result.body));
    assert.equal(database.committed, 0);
    assert.equal(database.rounds.length, 1);
    assert.equal(queued.length, 0);
  }
});

test('price or service changes require review before a new client sends a round', async () => {
  for (const fields of [{ servicio_esperado: 0, precio: 5 }, { servicio_esperado: 10, precio: 4 }]) {
    database = fixture(); queued = [];
    const result = await request('post', '/', { mesa_id: 1, validar_precios: true, servicio_esperado: fields.servicio_esperado, items: [{ producto_id: 1, cantidad: 1, precio: fields.precio }] });
    assert.equal(result.statusCode, 409, JSON.stringify(result.body));
    assert.equal(database.committed, 0);
    assert.equal(queued.length, 0);
  }
});


test('Express delivery requires full payment, while table service remains payable afterwards', async () => {
  for (const estado of ['LISTO', 'PREPARANDO', 'ENTREGADO', 'PAGADO']) {
    database = fixture({ estado });
    Object.assign(database.order, { mesa_id: null, tipo: 'Delivery' });
    database.rounds[0].estado = 'LISTO';
    const result = await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' });
    assert.equal(result.statusCode, estado === 'PAGADO' ? 200 : 409, JSON.stringify(result.body));
    assert.equal(database.rounds[0].estado, estado === 'PAGADO' ? 'ENTREGADO' : 'LISTO');
    assert.equal(database.committed, estado === 'PAGADO' ? 1 : 0);
  }
  database = fixture({ estado: 'LISTO' });
  assert.equal((await request('put', '/:id/rondas/:rondaId', { estado: 'ENTREGADO' })).statusCode, 200);
});
