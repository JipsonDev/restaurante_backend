import { reserveRoundStock, consumeRoundReservation, releaseOrderReservations } from '../services/stockReservations.js';
import { requireExpressPayment, historyDate } from '../services/expressPolicy.js';
import { orderRequestKey, claimOrderRequest, finishOrderRequest } from '../services/orderRequests.js';
import { requireUnpaidMutation } from '../services/paymentLedger.js';
import express from 'express';
import { migrateRounds, decorateAccount, refreshAccountState } from '../services/rounds.js';
import { beginAccountTransaction, emitMergedAccounts, consolidateAccount, lockWholeAccount, mergeAccounts } from '../services/accounts.js';
import { buildAccountSplit } from '../services/accountLogic.js';
import { ensurePrintQueue, enqueuePrint } from '../services/printQueue.js';
import { buildExtrasCatalog, normalizeOrderItem, orderTotal } from '../services/orderAmounts.js';
import { pool } from '../db.js';
import { fromLocalDay, toLocalDayEnd, localNowStamp } from '../services/businessTime.js';
import { holdingReservation, timeOf, dayOf, addDays, BLOCKING_STATES } from '../services/reservationLogic.js';
import { ensureReservationsTable } from './reservas.js';
import { adjustmentsByOrder } from '../services/adjustments.js';
import { verifyRole } from '../middleware/auth.js';
import { emitRealtime, EVENTS } from '../realtime.js';
import { sendPushToUser } from './notificaciones.js';
import { emitTableFreed, emitTableOccupied, freeMesaIfNoActive, syncTableStates } from '../services/tableState.js';
import { ensureAuditTable, safeLogAudit } from '../services/audit.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { normalizeRole } from '../services/permissions.js';
import { loadOrderTracking, migrateRoundAttribution } from '../services/orderTracking.js';
import { listDelayAlerts, claimDelayAlerts, migrateServiceAlerts } from '../services/serviceAlerts.js';
import { roundTransition, allItemsReady } from '../services/kitchenFlow.js';

const router = express.Router();

const STATES = ['PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO', 'PAGADO', 'CANCELADO'];
const STATE_ALIASES = {
  Pendiente: 'PENDIENTE',
  PENDIENTE: 'PENDIENTE',
  'En preparación': 'PREPARANDO',
  'En preparaciÃ³n': 'PREPARANDO',
  'En preparacion': 'PREPARANDO',
  PREPARANDO: 'PREPARANDO',
  Listo: 'LISTO',
  LISTO: 'LISTO',
  Entregado: 'ENTREGADO',
  ENTREGADO: 'ENTREGADO',
  Completado: 'PAGADO',
  Pagado: 'PAGADO',
  PAGADO: 'PAGADO',
  Cancelado: 'CANCELADO',
  CANCELADO: 'CANCELADO',
};

const NEXT_ALLOWED = {
  PENDIENTE: ['PREPARANDO', 'CANCELADO'],
  PREPARANDO: ['LISTO', 'CANCELADO'],
  LISTO: ['ENTREGADO', 'CANCELADO'],
  ENTREGADO: ['PAGADO', 'CANCELADO'],
  PAGADO: [],
  CANCELADO: [],
};

const STATE_TS = {
  PREPARANDO: 'preparando_at',
  LISTO: 'listo_at',
  ENTREGADO: 'entregado_at',
  PAGADO: 'pagado_at',
  CANCELADO: 'cancelado_at',
};

let splitTablesReady = false;
let pickupFieldsReady = false;

async function addColumnIfMissing(table, column, ddl) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!rows.length) await pool.query(ddl);
}

async function ensurePickupFields() {
  if (pickupFieldsReady) return;
  await addColumnIfMissing('pedidos', 'inventario_descontado', 'ALTER TABLE pedidos ADD COLUMN inventario_descontado TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('pedidos', 'cliente_nombre', 'ALTER TABLE pedidos ADD COLUMN cliente_nombre VARCHAR(120) NULL');
  await addColumnIfMissing('pedidos', 'cliente_dato', 'ALTER TABLE pedidos ADD COLUMN cliente_dato VARCHAR(160) NULL');
  await addColumnIfMissing('pedidos', 'delivery_telefono', 'ALTER TABLE pedidos ADD COLUMN delivery_telefono VARCHAR(40) NULL');
  await addColumnIfMissing('pedidos', 'delivery_direccion', 'ALTER TABLE pedidos ADD COLUMN delivery_direccion VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'delivery_referencia', 'ALTER TABLE pedidos ADD COLUMN delivery_referencia VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'cuenta_solicitada_at', 'ALTER TABLE pedidos ADD COLUMN cuenta_solicitada_at DATETIME NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventario_item_movimientos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inventario_item_id INT NOT NULL,
      tipo ENUM('Entrada','Salida','Ajuste') NOT NULL DEFAULT 'Entrada',
      cantidad DECIMAL(10,3) NOT NULL DEFAULT 0.000,
      motivo VARCHAR(255) NULL,
      trabajador_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_iim_item
        FOREIGN KEY (inventario_item_id)
        REFERENCES inventario_items(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_iim_trabajador
        FOREIGN KEY (trabajador_id)
        REFERENCES trabajadores(id)
        ON DELETE SET NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recetas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      producto_id INT NOT NULL,
      inventario_item_id INT NOT NULL,
      cantidad DECIMAL(10,3) NOT NULL DEFAULT 1.000,
      unidad VARCHAR(30) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_receta_producto_item (producto_id, inventario_item_id),
      CONSTRAINT fk_recetas_producto
        FOREIGN KEY (producto_id)
        REFERENCES productos(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_recetas_inventario
        FOREIGN KEY (inventario_item_id)
        REFERENCES inventario_items(id)
        ON DELETE CASCADE
    )
  `);
  pickupFieldsReady = true;
}

async function ensureSplitTables() {
  if (splitTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuenta_divisiones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id INT NOT NULL,
      nombre VARCHAR(80) NOT NULL,
      monto DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      estado ENUM('PENDIENTE','PAGADO') NOT NULL DEFAULT 'PENDIENTE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cuenta_divisiones_pedido
        FOREIGN KEY (pedido_id)
        REFERENCES pedidos(id)
        ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuenta_division_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      division_id INT NOT NULL,
      detalle_pedido_id INT NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL DEFAULT 1.00,
      CONSTRAINT fk_cdi_division
        FOREIGN KEY (division_id)
        REFERENCES cuenta_divisiones(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_cdi_detalle
        FOREIGN KEY (detalle_pedido_id)
        REFERENCES detalle_pedidos(id)
        ON DELETE CASCADE
    )
  `);
  splitTablesReady = true;
}

export async function initializeOrderSchema() {
  for (const column of Object.values(STATE_TS)) await addColumnIfMissing('pedidos', column, `ALTER TABLE pedidos ADD COLUMN ${column} DATETIME NULL`);
  await addColumnIfMissing('pagos', 'estado', "ALTER TABLE pagos ADD COLUMN estado ENUM('ACTIVO','ANULADO','DEVUELTO') NOT NULL DEFAULT 'ACTIVO'");
  await ensurePickupFields();
  await ensureSplitTables();
  await migrateRounds();
  // Cocina: «listo» por plato, agotado temporal y estación de cada producto.
  await addColumnIfMissing('detalle_pedidos', 'listo_at', 'ALTER TABLE detalle_pedidos ADD COLUMN listo_at DATETIME NULL');
  await addColumnIfMissing('productos', 'agotado', 'ALTER TABLE productos ADD COLUMN agotado TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('productos', 'estacion', 'ALTER TABLE productos ADD COLUMN estacion VARCHAR(40) NULL');
  await migrateRoundAttribution(pool);
  await migrateServiceAlerts(pool);
}

function normalizeEstado(estado) {
  return STATE_ALIASES[estado] || String(estado || '').toUpperCase();
}

function isValidTransition(current, next) {
  if (current === next) return true;
  if (next === 'CANCELADO' && !['PAGADO', 'CANCELADO'].includes(current)) return true;
  return NEXT_ALLOWED[current]?.includes(next);
}

async function hydrateOrders(rows, db = pool) {
  const orders = rows.map((p) => ({ ...p, estado: normalizeEstado(p.estado), items: [] }));
  const ids = orders.map((p) => p.id);
  if (!ids.length) return orders;

  const [items] = await db.query(
    `SELECT dp.id, dp.pedido_id, dp.ronda_id, dp.producto_id, dp.cantidad, dp.precio, dp.notas, dp.listo_at, pr.nombre, pr.estacion
     FROM detalle_pedidos dp
     LEFT JOIN productos pr ON dp.producto_id = pr.id
     WHERE dp.pedido_id IN (?)
     ORDER BY dp.id ASC`, [ids]
  );
  // GROUP_CONCAT could silently truncate long preparation instructions.
  const [modifiers] = await db.query(
    `SELECT dpm.id, dpm.detalle_pedido_id, dpm.nombre, dpm.tipo, dpm.precio_extra
     FROM detalle_pedido_modificadores dpm
     JOIN detalle_pedidos dp ON dp.id = dpm.detalle_pedido_id
     WHERE dp.pedido_id IN (?) ORDER BY dpm.id`, [ids]
  );
  const modifiersByDetail = new Map();
  for (const modifier of modifiers) {
    const key = Number(modifier.detalle_pedido_id);
    if (!modifiersByDetail.has(key)) modifiersByDetail.set(key, []);
    modifiersByDetail.get(key).push(modifier);
  }

  const byOrder = items.reduce((acc, item) => {
    const mods = modifiersByDetail.get(Number(item.id)) || [];
    acc[item.pedido_id] = acc[item.pedido_id] || [];
    acc[item.pedido_id].push({
      id: item.id,
      ronda_id: item.ronda_id,
      producto_id: item.producto_id,
      nombre: item.nombre,
      cantidad: Number(item.cantidad || 0),
      precio: Number(item.precio || 0),
      notas: item.notas,
      listo_at: item.listo_at || null,
      estacion: item.estacion || null,
      modificadores: mods,
    });
    return acc;
  }, {});

  const [rounds] = await db.query('SELECT * FROM pedido_rondas WHERE pedido_id IN (?) ORDER BY id', [ids]);
  // Descuentos y cortesías: el plato en cortesía se marca; la cuenta lleva la base descontada para el comprobante.
  const adjustments = await adjustmentsByOrder(ids, db);
  return orders.map((order) => {
    const ajustes = adjustments.get(Number(order.id)) || [];
    const courtesy = new Map(ajustes.filter((a) => a.tipo === 'CORTESIA').map((a) => [Number(a.detalle_pedido_id), a]));
    const items = (byOrder[order.id] || []).map((item) => courtesy.has(Number(item.id)) ? { ...item, cortesia: { id: courtesy.get(Number(item.id)).id, motivo: courtesy.get(Number(item.id)).motivo } } : item);
    const decorated = decorateAccount(order, items, rounds.filter((round) => Number(round.pedido_id) === Number(order.id)));
    return ajustes.length ? { ...decorated, ajustes, ajustes_base: ajustes.reduce((sum, a) => sum + Math.round(a.base * 100), 0) / 100,
      ajustes_total: ajustes.reduce((sum, a) => sum + Math.round(a.monto * 100), 0) / 100 } : decorated;
  });
}

export async function getPedidoCompleto(id, db = pool) {
  const [rows] = await db.query(
    `SELECT p.*, (SELECT COALESCE(SUM(pg.monto),0) FROM pagos pg WHERE pg.pedido_id = p.id AND COALESCE(pg.estado,'ACTIVO') = 'ACTIVO') AS abonado,
            m.numero AS mesa_numero,
            t.nombre AS mesero_nombre
     FROM pedidos p
     LEFT JOIN mesas m ON p.mesa_id = m.id
     LEFT JOIN trabajadores t ON p.mesero_id = t.id
     WHERE p.id = ?`,
    [id]
  );
  return (await hydrateOrders(rows, db))[0] || null;
}

function isPickupOrder(pedido) {
  return !pedido?.mesa_id || ['Para llevar', 'Delivery'].includes(pedido?.tipo);
}

function pedidoUbicacionLabel(pedido) {
  if (!pedido) return 'Pedido';
  if (isPickupOrder(pedido)) {
    const prefix = pedido.tipo === 'Delivery' ? 'Delivery' : 'Express';
    return `${prefix} #${pedido.id || '-'} ${pedido.cliente_nombre || ''}`.trim();
  }
  return `Mesa ${pedido.mesa_numero || pedido.mesa_id || '-'}`;
}

function pickupDetailLines(pedido) {
  if (!isPickupOrder(pedido)) return [];
  if (pedido.tipo === 'Delivery') {
    return [
      pedido.delivery_telefono ? `Tel: ${pedido.delivery_telefono}` : '',
      pedido.delivery_direccion ? `Dir: ${pedido.delivery_direccion}` : '',
      pedido.delivery_referencia ? `Ref: ${pedido.delivery_referencia}` : '',
      pedido.cliente_dato ? `Dato: ${pedido.cliente_dato}` : '',
    ].filter(Boolean);
  }
  return [pedido.cliente_dato ? `Dato: ${pedido.cliente_dato}` : 'Para recoger'].filter(Boolean);
}

async function notifyWaiterOrderReady(pedido, { manual = false, rondaId = null } = {}) {
  if (!pedido) return;
  const target = pedidoUbicacionLabel(pedido);
  const title = manual ? `Cocina llama: ${target}` : `${target}: ronda lista`;
  const body = manual
    ? 'Cocina solicita que el mesero recoja o revise este pedido.'
    : `Ronda #${rondaId || '-'} del pedido #${pedido.id} lista para recoger.`;
  const payload = {
    pedido,
    message: body,
    ronda_id: rondaId,
    action: manual ? 'manual_ping' : 'order_ready',
  };

  emitRealtime(EVENTS.ORDER_READY, payload);
  await sendPushToUser(pedido.mesero_id, {
    title,
    body,
    data: {
      type: 'ORDER_READY',
      pedido_id: pedido.id,
      mesa_id: pedido.mesa_id,
      mesa_numero: pedido.mesa_numero,
      manual,
    },
  }).catch((error) => {
    console.warn('No se pudo enviar push al mesero:', error.message);
  });
}

function ticketDateParts(value) {
  const date = new Date(value || Date.now());
  const two = (n) => String(n).padStart(2, '0');
  return {
    fecha: `${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()}`,
    hora: date.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }),
  };
}

function ticketHelpers(width = 42) {
  return {
    line: '-'.repeat(width),
    center: (text) => {
      const value = String(text || '');
      const left = Math.max(0, Math.floor((width - value.length) / 2));
      return `${' '.repeat(left)}${value}`;
    },
    cut: (text, len) => String(text || '').slice(0, len),
  };
}

function kitchenItemRows(pedido, nameWidth = 24) {
  const { cut } = ticketHelpers();
  return (pedido.items || []).flatMap((item) => {
    const observaciones = [
      item.notas,
      ...(item.modificadores || []).map((mod) => {
        const prefix = mod.tipo === 'EXTRA' ? '+' : mod.tipo === 'EXCLUSION' ? 'Sin' : '';
        return `${prefix} ${mod.nombre}`.trim();
      }),
    ].filter(Boolean).join(', ');

    const first = `${String(item.cantidad).padEnd(5)} ${cut(item.nombre, nameWidth).padEnd(nameWidth)} ${cut(observaciones, 10)}`;
    const extra = [];
    const name = String(item.nombre || '');
    for (let offset = nameWidth; offset < name.length; offset += 34) {
      extra.push(`      ${name.slice(offset, offset + 34)}`);
    }
    for (let offset = 10; offset < observaciones.length; offset += 34) {
      extra.push(`      ${observaciones.slice(offset, offset + 34)}`);
    }
    return [first, ...extra];
  });
}

function buildKitchenTicket(pedido) {
  const { fecha, hora } = ticketDateParts(pedido.created_at);
  const ticket = String(pedido.id || '').padStart(5, '0');
  const { line, center, cut } = ticketHelpers();
  const target = pedidoUbicacionLabel(pedido);

  return [
    center('MORENA MIA'),
    center('TICKET COCINA'),
    line,
    `COMANDA #${ticket}`.padEnd(24) + cut(target.toUpperCase(), 18),
    `Fecha: ${fecha}`.padEnd(24) + `Hora: ${hora}`,
    `Mesero: ${cut(pedido.mesero_nombre || '-', 30)}`,
    pedido.ronda_id ? `RONDA #${pedido.ronda_id}` : '',
    line,
    'CANT. PRODUCTO                OBS.',
    line,
    ...kitchenItemRows(pedido, 24),
    line,
    pedido.notas ? `NOTA GENERAL: ${pedido.notas}` : '',
    center('USO INTERNO COCINA'),
  ].filter(Boolean).join('\n');
}

function buildPickupComanda(pedido) {
  const date = new Date(pedido.created_at || Date.now());
  const { fecha, hora } = ticketDateParts(date);
  const ticket = String(pedido.id || '').padStart(5, '0');
  const target = pedidoUbicacionLabel(pedido);
  const customerLines = pickupDetailLines(pedido);
  const { line, center, cut } = ticketHelpers();
  const isDelivery = pedido.tipo === 'Delivery';

  const lines = [
    center('MORENA MIA'),
    center(isDelivery ? 'COMANDA DELIVERY' : 'COMANDA PARA LLEVAR'),
    line,
    `PEDIDO #${ticket}`.padEnd(24) + cut(target.toUpperCase(), 18),
    `Fecha: ${fecha}`.padEnd(24) + `Hora: ${hora}`,
    `Cliente: ${cut(pedido.cliente_nombre || 'Consumidor final', 32)}`,
    `Mesero: ${cut(pedido.mesero_nombre || '-', 32)}`,
    ...customerLines,
    pedido.ronda_id ? `RONDA #${pedido.ronda_id}` : '',
    line,
    'CANT. PRODUCTO                OBS.',
    line,
    ...kitchenItemRows(pedido, 24),
    line,
    pedido.notas ? `NOTA GENERAL: ${pedido.notas}` : '',
    center(isDelivery ? 'VERIFICAR DATOS DE ENTREGA' : 'ENTREGAR EN MOSTRADOR'),
  ].filter(Boolean);

  return lines.join('\n');
}

function buildComanda(pedido) {
  return isPickupOrder(pedido) ? buildPickupComanda(pedido) : buildKitchenTicket(pedido);
}

function moneyTicket(value, symbol = '$') {
  return `${symbol}${Number(value || 0).toFixed(2)}`;
}

function ticketRow(left, right, width = 42) {
  const l = String(left || '');
  const r = String(right || '');
  const space = Math.max(1, width - l.length - r.length);
  return `${l}${' '.repeat(space)}${r}`;
}

function buildPrecuenta(pedido, settings = {}) {
  const subtotal = pedido.items.reduce((sum, item) => {
    const extras = (item.modificadores || []).reduce((mSum, mod) => mSum + Number(mod.precio_extra || 0), 0);
    return sum + (Number(item.precio || 0) + extras) * Number(item.cantidad || 0);
  }, 0);
  const total = Number(pedido.total || subtotal);
  const { line, center, cut } = ticketHelpers();
  const symbol = settings.simbolo_moneda || '$';

  return [
    center((settings.nombre_restaurante || 'MORENA MIA').toUpperCase()),
    settings.ruc ? center(`RUC: ${settings.ruc}`) : '',
    settings.direccion ? center(settings.direccion) : '',
    settings.telefono ? center(`Tel: ${settings.telefono}`) : '',
    line,
    center('TICKET CLIENTE'),
    center('PRE-CUENTA'),
    line,
    ticketRow('Pedido', `#${pedido.id}`),
    ticketRow('Fecha', new Date().toLocaleString('es-EC')),
    pedidoUbicacionLabel(pedido),
    ...pickupDetailLines(pedido),
    line,
    ...pedido.items.map((item) => {
      const extras = (item.modificadores || []).reduce((mSum, mod) => mSum + Number(mod.precio_extra || 0), 0);
      const label = `${item.cantidad}x ${cut(item.nombre, 24)}`;
      return ticketRow(label, moneyTicket((Number(item.precio || 0) + extras) * Number(item.cantidad || 0), symbol));
    }),
    line,
    ticketRow('Subtotal', moneyTicket(subtotal, symbol)),
    ticketRow('Total de cuenta', moneyTicket(total, symbol)),
    Number(pedido.abonado) > 0 ? ticketRow('Abonos', moneyTicket(pedido.abonado, symbol)) : '',
    ticketRow('Saldo a pagar', moneyTicket(pedido.saldo_pendiente ?? total, symbol)),
    line,
    center('Ticket no fiscal'),
  ].filter(Boolean).join('\n');
}

async function getPedidoItemsForInventory(conn, pedidoId, detailIds = null) {
  const [items] = await conn.query(
    `SELECT dp.id AS detalle_id, dp.producto_id, dp.cantidad,
            pr.nombre, pr.stock, pr.inventario_item_id
     FROM detalle_pedidos dp
     JOIN productos pr ON dp.producto_id = pr.id
     WHERE dp.pedido_id = ? ${detailIds ? 'AND dp.id IN (?)' : ''}
     ORDER BY dp.producto_id, dp.id`,
    detailIds ? [pedidoId, detailIds] : [pedidoId]
  );
  return items;
}

async function deductRoundInventory(conn, pedidoId, round) {
  if (Number(round.inventario_descontado) === 1) return;
  await reserveRoundStock(conn, round.id);
  if (await consumeRoundReservation(conn, round.id, pedidoId)) {
    await conn.query('UPDATE pedido_rondas SET inventario_descontado = 1 WHERE id = ?', [round.id]);
    return;
  }
  const [details] = await conn.query('SELECT id FROM detalle_pedidos WHERE pedido_id = ? AND ronda_id = ? ORDER BY id', [pedidoId, round.id]);
  if (details.length) await consumeInventoryItems(conn, await getPedidoItemsForInventory(conn, pedidoId, details.map((item) => item.id)), pedidoId);
  await conn.query('UPDATE pedido_rondas SET inventario_descontado = 1 WHERE id = ?', [round.id]);
}

async function deductInventoryForPedido(conn, pedidoId) {
  const [rounds] = await conn.query("SELECT * FROM pedido_rondas WHERE pedido_id = ? AND estado <> 'CANCELADO' ORDER BY id FOR UPDATE", [pedidoId]);
  for (const round of rounds) await deductRoundInventory(conn, pedidoId, round);
  await conn.query('UPDATE pedidos SET inventario_descontado = 1 WHERE id = ?', [pedidoId]);
}

export async function consumeInventoryItems(conn, items, pedidoId) {
  for (const item of items) {
    const [recipes] = await conn.query(
      `SELECT r.inventario_item_id, r.cantidad, ii.nombre, ii.stock
       FROM recetas r
       JOIN inventario_items ii ON r.inventario_item_id = ii.id
       WHERE r.producto_id = ? AND r.activo = 1
       FOR UPDATE`,
      [item.producto_id]
    );

    if (recipes.length) {
      for (const recipe of recipes) {
        const needed = Number(recipe.cantidad || 0) * Number(item.cantidad || 0);
        if (Number(recipe.stock) < needed) {
          throw new Error(`Sin stock suficiente de ${recipe.nombre}. Disponible: ${recipe.stock}, requerido: ${needed}.`);
        }
        await conn.query('UPDATE inventario_items SET stock = stock - ? WHERE id = ?', [needed, recipe.inventario_item_id]);
        await conn.query(
          `INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id)
           VALUES (?, 'Salida', ?, ?, NULL)`,
          [recipe.inventario_item_id, needed, `Consumo automatico pedido #${pedidoId} - ${item.nombre}`]
        );
      }
    } else if (item.inventario_item_id) {
      const [[inv]] = await conn.query('SELECT id, nombre, stock FROM inventario_items WHERE id = ? FOR UPDATE', [item.inventario_item_id]);
      if (!inv || Number(inv.stock) < Number(item.cantidad)) {
        throw new Error(`Sin stock suficiente de ${inv?.nombre || item.nombre}. Disponible: ${inv?.stock || 0}.`);
      }
      await conn.query('UPDATE inventario_items SET stock = stock - ? WHERE id = ?', [item.cantidad, item.inventario_item_id]);
      await conn.query(
        `INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id)
         VALUES (?, 'Salida', ?, ?, NULL)`,
        [item.inventario_item_id, Number(item.cantidad), `Consumo automatico pedido #${pedidoId} - ${item.nombre}`]
      );
    } else {
      const [[product]] = await conn.query('SELECT stock FROM productos WHERE id = ? FOR UPDATE', [item.producto_id]);
      if (!product || Number(product.stock) < Number(item.cantidad)) {
        throw new Error(`Sin stock suficiente para ${item.nombre}. Disponible: ${product?.stock || 0}.`);
      }
      await conn.query(
        `UPDATE productos
         SET disponible = CASE WHEN stock - ? <= 0 THEN 0 ELSE disponible END,
             stock = stock - ?
         WHERE id = ?`,
        [item.cantidad, item.cantidad, item.producto_id]
      );
    }
  }
}

async function restoreInventoryForPedido(conn, pedidoId) {
  await releaseOrderReservations(conn, pedidoId);
  const [consumed] = await conn.query('SELECT dp.id FROM detalle_pedidos dp JOIN pedido_rondas r ON r.id = dp.ronda_id WHERE dp.pedido_id = ? AND r.inventario_descontado = 1', [pedidoId]);
  if (!consumed.length) return;
  const items = await getPedidoItemsForInventory(conn, pedidoId, consumed.map((item) => item.id));
  for (const item of items) {
    const [recipes] = await conn.query(
      `SELECT inventario_item_id, cantidad
       FROM recetas
       WHERE producto_id = ? AND activo = 1`,
      [item.producto_id]
    );

    if (recipes.length) {
      for (const recipe of recipes) {
        await conn.query(
          'UPDATE inventario_items SET stock = stock + ? WHERE id = ?',
          [Number(recipe.cantidad || 0) * Number(item.cantidad || 0), recipe.inventario_item_id]
        );
        await conn.query(
          `INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id)
           VALUES (?, 'Entrada', ?, ?, NULL)`,
          [recipe.inventario_item_id, Number(recipe.cantidad || 0) * Number(item.cantidad || 0), `Restauracion automatica pedido #${pedidoId} - ${item.nombre}`]
        );
      }
    } else if (item.inventario_item_id) {
      await conn.query('UPDATE inventario_items SET stock = stock + ? WHERE id = ?', [item.cantidad, item.inventario_item_id]);
      await conn.query(
        `INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id)
         VALUES (?, 'Entrada', ?, ?, NULL)`,
        [item.inventario_item_id, Number(item.cantidad), `Restauracion automatica pedido #${pedidoId} - ${item.nombre}`]
      );
    } else {
      await conn.query('UPDATE productos SET stock = stock + ?, disponible = 1 WHERE id = ?', [item.cantidad, item.producto_id]);
    }
  }

  await conn.query('UPDATE pedidos SET inventario_descontado = 0 WHERE id = ?', [pedidoId]);
  await conn.query('UPDATE pedido_rondas SET inventario_descontado = 0 WHERE pedido_id = ?', [pedidoId]);
}

export async function transitionPedido(conn, pedidoId, nextEstado, { allowShortcut = false } = {}) {
  await ensurePickupFields();
  const [[pedido]] = await conn.query('SELECT id, mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
  if (!pedido) throw new Error('Pedido no encontrado.');

  const current = normalizeEstado(pedido.estado);
  const next = normalizeEstado(nextEstado);
  if (!STATES.includes(next)) throw new Error(`Estado invalido. Validos: ${STATES.join(', ')}`);
  if (!allowShortcut && !isValidTransition(current, next)) {
    throw new Error(`Transicion invalida: ${current} -> ${next}`);
  }

  if (next === 'PREPARANDO' || next === 'PAGADO') {
    await deductInventoryForPedido(conn, pedidoId);
  }
  if (next === 'CANCELADO') {
    await requireUnpaidMutation(conn, [pedidoId]);
    await restoreInventoryForPedido(conn, pedidoId);
    await conn.query("UPDATE pedido_rondas SET estado = 'CANCELADO' WHERE pedido_id = ?", [pedidoId]);
  }

  const tsColumn = STATE_TS[next];
  if (tsColumn) {
    await conn.query(
      `UPDATE pedidos
       SET estado = ?,
           ${tsColumn} = COALESCE(${tsColumn}, NOW())
       WHERE id = ?`,
      [next, pedidoId]
    );
  } else {
    await conn.query('UPDATE pedidos SET estado = ? WHERE id = ?', [next, pedidoId]);
  }

  const tableFreed = ['PAGADO', 'CANCELADO'].includes(next)
    ? await freeMesaIfNoActive(conn, pedido.mesa_id)
    : false;

  return { before: current, after: next, mesa_id: pedido.mesa_id, table_freed: tableFreed };
}

router.get('/', async (req, res) => {
  try {
    await ensurePickupFields();
    await syncTableStates();
    const history = req.query.history === '1';
    const kitchen = req.query.cocina === '1';
    const [rows] = await pool.query(
      `SELECT p.*, (SELECT COALESCE(SUM(pg.monto),0) FROM pagos pg WHERE pg.pedido_id = p.id AND COALESCE(pg.estado,'ACTIVO') = 'ACTIVO') AS abonado,
              m.numero AS mesa_numero,
              t.nombre AS mesero_nombre
       FROM pedidos p
       LEFT JOIN mesas m ON p.mesa_id = m.id
       LEFT JOIN trabajadores t ON p.mesero_id = t.id
       ${kitchen ? "WHERE p.estado NOT IN ('PAGADO', 'CANCELADO') OR EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = p.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO')) OR p.id IN (SELECT id FROM (SELECT id FROM pedidos ORDER BY created_at DESC LIMIT 160) recientes)" : history ? '' : "WHERE p.estado NOT IN ('PAGADO', 'CANCELADO') OR EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = p.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO')) OR DATE(p.created_at) = CURDATE()"}
       ORDER BY p.created_at DESC
       ${history && !kitchen ? 'LIMIT 160' : ''}`
    );

    res.json(await hydrateOrders(rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Precios reales de los extras del catalogo (si la tabla aun no existe, vacio).
async function loadExtrasCatalog(conn) {
  try {
    const [rows] = await conn.query('SELECT nombre, precio, tipo FROM extras WHERE activo = 1');
    return buildExtrasCatalog(rows);
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return new Map();
    throw error;
  }
}

router.post('/:id/imprimir-comanda', verifyRole('admin', 'cocina', 'mesero'), async (req, res) => {
  try {
    await ensurePrintQueue();
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    const round = req.body.ronda_id ? pedido.rondas.find((r) => Number(r.id) === Number(req.body.ronda_id)) : null;
    if (req.body.ronda_id && !round) return res.status(404).json({ message: 'Ronda no encontrada.' });
    const printOrder = round ? { ...pedido, ronda_id: round.id, items: round.items, notas: round.notas, created_at: round.created_at } : pedido;
    const settings = await getBusinessConfig();
    const payload = {
      pedido_id: pedido.id, mesa_id: pedido.mesa_id, modulo: 'cocina',
      plantilla: 'ticket_cocina', texto: buildComanda(printOrder),
      impresora: settings.impresora_cocina || null,
    };
    const job = await enqueuePrint(pool, payload);
    emitRealtime(EVENTS.PRINT_COMANDA, { ...payload, job_id: job.id });
    res.status(202).json({ job, message: 'Comanda en cola de impresion.' });
  } catch (error) { res.status(503).json({ message: error.message }); }
});

router.get('/:id/comanda', async (req, res) => {
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    res.json({
      pedido,
      texto: buildComanda(pedido),
      plantilla: isPickupOrder(pedido) ? 'comanda_pickup' : 'ticket_cocina',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/precuenta', async (req, res) => {
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    res.json({ pedido, texto: buildPrecuenta(pedido) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Completed Express orders are read by closure day, independently of active accounts.
router.get('/express/historial', async (req, res) => {
  let date, page;
  try {
    date = historyDate(req.query.fecha);
    page = Number(req.query.page ?? 0);
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000) throw new Error('Pagina invalida.');
  } catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    const closedAt = 'GREATEST(COALESCE(p.pagado_at, p.created_at), COALESCE((SELECT MAX(r.entregado_at) FROM pedido_rondas r WHERE r.pedido_id = p.id), p.created_at))';
    const [rows] = await pool.query(`SELECT p.*, t.nombre AS mesero_nombre, ${closedAt} AS cerrado_at
      FROM pedidos p LEFT JOIN trabajadores t ON t.id = p.mesero_id
      WHERE p.mesa_id IS NULL AND p.tipo IN ('Para llevar', 'Delivery') AND p.estado = 'PAGADO'
      AND NOT EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = p.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO'))
      AND ${closedAt} >= ${fromLocalDay()} AND ${closedAt} < ${toLocalDayEnd()}
      ORDER BY cerrado_at DESC, p.id DESC LIMIT 51 OFFSET ?`, [date, date, page * 50]);
    res.json({ items: await hydrateOrders(rows.slice(0, 50)), hasMore: rows.length > 50, fecha: date, page });
  } catch (error) { res.status(500).json({ message: 'No se pudo cargar el historial Express.' }); }
});

router.get('/alertas-demora', verifyRole('mesero','admin'), async (req,res) => {
  try { res.json(await listDelayAlerts(pool, req.user.id)); }
  catch { res.status(500).json({message:'No se pudieron consultar las demoras.'}); }
});
router.post('/alertas-demora/avisar', verifyRole('mesero','admin'), async (req,res) => {
  try { res.json(await claimDelayAlerts(pool, req.user.id, req.body?.ids)); }
  catch (error) { res.status(error.statusCode || 500).json({message:error.statusCode ? error.message : 'No se pudieron confirmar los avisos.'}); }
});

router.get('/:id/seguimiento', verifyRole('admin','mesero','caja'), async (req,res) => {
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) return res.status(400).json({message:'Pedido inválido.'});
  try {
    const order=await getPedidoCompleto(Number(req.params.id));
    if (!order) return res.status(404).json({message:'Pedido no encontrado.'});
    res.json(await loadOrderTracking(pool,order));
  } catch { res.status(500).json({message:'No se pudo consultar el seguimiento del pedido.'}); }
});

// ── Mantenimiento: cuentas abandonadas ──────────────────────────────────────
// Cuentas abiertas sin actividad desde hace N días (por defecto 15), normalmente pedidos de prueba
// que dejan mesas ocupadas y ensucian los reportes. Solo admin. Primero se listan; cerrarlas las
// marca como CANCELADO (no se borran) con la misma lógica que una cancelación normal: libera la
// mesa, las reservas y el inventario. Las cuentas con pagos registrados se excluyen (se resuelven en caja).
const staleDays = value => Math.min(365, Math.max(3, Math.floor(Number(value) || 15)));
async function listStaleOrders(db, days) {
  const [rows] = await db.query(
    `SELECT * FROM (
       SELECT p.id, p.mesa_id, m.numero AS mesa_numero, p.tipo, p.cliente_nombre, p.estado, p.total, p.created_at,
              GREATEST(p.created_at, COALESCE((SELECT MAX(r.created_at) FROM pedido_rondas r WHERE r.pedido_id = p.id), p.created_at)) AS ultima_actividad,
              (SELECT COALESCE(SUM(pg.monto), 0) FROM pagos pg WHERE pg.pedido_id = p.id AND COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO') AS abonado
       FROM pedidos p
       LEFT JOIN mesas m ON m.id = p.mesa_id
       WHERE p.estado NOT IN ('PAGADO', 'CANCELADO')
         AND p.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
     ) abandonados
     WHERE ultima_actividad < DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY ultima_actividad ASC
     LIMIT 500`,
    [days, days]
  );
  return rows.map(r => ({ ...r, total: Number(r.total || 0), abonado: Number(r.abonado || 0), cerrable: Number(r.abonado || 0) <= 0 }));
}

router.get('/mantenimiento/abandonados', verifyRole('admin'), async (req, res) => {
  try {
    const days = staleDays(req.query.dias);
    const items = await listStaleOrders(pool, days);
    res.json({ dias: days, items, cerrables: items.filter(i => i.cerrable).length, con_pagos: items.filter(i => !i.cerrable).length });
  } catch (error) {
    res.status(500).json({ message: 'No se pudieron revisar las cuentas abandonadas.', detail: error.message });
  }
});

router.post('/mantenimiento/abandonados/cerrar', verifyRole('admin'), async (req, res) => {
  const days = staleDays(req.body?.dias);
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500) : [];
  if (!ids.length) return res.status(400).json({ message: 'Elige al menos una cuenta.' });
  // Se vuelve a comprobar en el servidor: solo se cierran las que siguen abandonadas y sin pagos.
  const allowed = new Set((await listStaleOrders(pool, days)).filter(o => o.cerrable).map(o => Number(o.id)));
  const closed = []; const skipped = []; const freedTables = [];
  for (const id of ids) {
    if (!allowed.has(id)) { skipped.push({ id, motivo: 'Ya no está abandonada o tiene pagos.' }); continue; }
    const conn = await pool.getConnection();
    try {
      await beginAccountTransaction(conn);
      const transition = await transitionPedido(conn, id, 'CANCELADO', { allowShortcut: true });
      await safeLogAudit({
        conn, user: req.user, accion: 'pedido.cerrado_por_limpieza', entidad: 'pedido', entidadId: id,
        descripcion: `Cuenta abandonada (más de ${days} días sin actividad) marcada como cancelada`,
        metadata: { ...transition, dias: days },
      });
      await conn.commit();
      closed.push(id);
      if (transition.table_freed && transition.mesa_id) freedTables.push(transition.mesa_id);
    } catch (error) {
      await conn.rollback().catch(() => {});
      skipped.push({ id, motivo: error.message });
    } finally {
      conn.release();
    }
  }
  for (const id of closed) emitRealtime(EVENTS.ORDER_UPDATED, { pedido_id: id, action: 'cancel' });
  for (const mesa of [...new Set(freedTables)]) await emitTableFreed(mesa).catch(() => {});
  res.json({ message: closed.length ? `${closed.length} ${closed.length === 1 ? 'cuenta cerrada' : 'cuentas cerradas'}.` : 'No se cerró ninguna cuenta.', cerradas: closed, omitidas: skipped });
});

router.get('/:id', async (req, res) => {
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    res.json(pedido);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  await ensurePickupFields();
  const {
    pedido_id = null,
    mesa_id = null,
    mesero_id,
    notas = null,
    items = [],
    tipo = 'Mesa',
    cliente_nombre = null,
    cliente_dato = null,
    delivery_telefono = null,
    delivery_direccion = null,
    delivery_referencia = null,
  } = req.body;
  const normalizedTipo = tipo === 'Para llevar' || tipo === 'Delivery' ? tipo : 'Mesa';
  const isPickup = normalizedTipo !== 'Mesa';
  const targetId = pedido_id == null ? null : Number(pedido_id);
  if (targetId !== null && (!isPickup || !Number.isSafeInteger(targetId) || targetId <= 0)) return res.status(400).json({ message: 'Pedido express de destino invalido.' });
  let requestKey;
  try { requestKey = orderRequestKey(req.body.request_id); } catch (error) { return res.status(400).json({ message: error.message }); }
  const mesaId = isPickup ? null : Number(mesa_id);
  const customerName = String(cliente_nombre || '').trim();
  const customerData = String(cliente_dato || '').trim();
  const deliveryPhone = String(delivery_telefono || '').trim();
  const deliveryAddress = String(delivery_direccion || '').trim();
  const deliveryReference = String(delivery_referencia || '').trim();

  if ((!isPickup && (!Number.isSafeInteger(mesaId) || mesaId <= 0)) || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Mesa e items son obligatorios.' });
  }
  if (isPickup && !targetId && !customerName) {
    return res.status(400).json({ message: 'El nombre del cliente es obligatorio para pedidos express.' });
  }

  let conn;
  try {
    // Initialize configuration before opening the transaction (it can run DDL).
    const businessConfig = await getBusinessConfig();
    await ensureAuditTable();
    await ensurePrintQueue();
    if (!isPickup) await ensureReservationsTable();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    const replay = await claimOrderRequest(conn, req.user.id, requestKey, req.body);
    if (replay) { await conn.commit(); return res.status(200).json({ ...replay, replayed: true }); }
    if (req.body.validar_precios && Number(req.body.servicio_esperado) !== Number(String(businessConfig.servicio_porcentaje).replace(',', '.'))) {
      throw Object.assign(new Error('Cambio el porcentaje de servicio. Actualiza y revisa el total antes de enviar.'), { status: 409 });
    }
    let expressOrder = null;
    if (targetId) {
      const [[target]] = await conn.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [targetId]);
      if (!target || target.mesa_id || !['Para llevar', 'Delivery'].includes(target.tipo)) throw Object.assign(new Error('El pedido Express ya no existe o cambio de destino.'), { status: 409 });
      if (['PAGADO', 'CANCELADO'].includes(target.estado)) throw Object.assign(new Error('La cuenta Express ya esta cerrada.'), { status: 409 });
      if (target.tipo !== normalizedTipo) throw Object.assign(new Error('El tipo de entrega cambio. Actualiza el pedido.'), { status: 409 });
      await requireUnpaidMutation(conn, [target.id]);
      expressOrder = target;
    }
    if (mesaId) {
      const [[mesa]] = await conn.query('SELECT id, activo FROM mesas WHERE id = ? FOR UPDATE', [mesaId]);
      if (!mesa || Number(mesa.activo) !== 1) {
        await conn.rollback();
        return res.status(409).json({ message: 'La mesa no existe o esta inactiva.' });
      }
    }

    const normalizedItems = [];
    const extrasCatalog = await loadExtrasCatalog(conn);

    for (const item of items) {
      const productoId = Number(item?.producto_id);
      const cantidad = Number(item?.cantidad);
      if (!Number.isSafeInteger(productoId) || productoId <= 0 || !Number.isSafeInteger(cantidad) || cantidad <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'Todos los items deben tener producto y cantidad valida.' });
      }

      const [[product]] = await conn.query(
        'SELECT id, nombre, precio, disponible, agotado FROM productos WHERE id = ?',
        [productoId]
      );
      if (!product || Number(product.disponible) !== 1) {
        await conn.rollback();
        return res.status(409).json({ message: `Producto no disponible: ${product?.nombre || productoId}` });
      }
      if (Number(product.agotado) === 1) {
        await conn.rollback();
        return res.status(409).json({ message: `${product.nombre} está agotado. Quítalo de la ronda para enviarla.` });
      }
      if (req.body.validar_precios && (!Number.isFinite(Number(item.precio)) || Math.round(Number(item.precio) * 100) !== Math.round(Number(product.precio) * 100))) {
        throw Object.assign(new Error(`Cambio el precio de ${product.nombre}. Actualiza y revisa el total antes de enviar.`), { status: 409 });
      }

      try {
        normalizedItems.push(normalizeOrderItem(item, product, { extrasCatalog, strictPrices: Boolean(req.body.validar_precios) }));
      } catch (error) {
        await conn.rollback();
        return res.status(error.status || 400).json({ message: error.message });
      }
    }

    const finalTotal = orderTotal(normalizedItems, businessConfig.servicio_porcentaje);
    const [activeOrders] = await conn.query(
      `SELECT id, total, notas, estado, inventario_descontado
       FROM pedidos
       WHERE mesa_id = ?
         AND estado NOT IN ('PAGADO', 'CANCELADO')
         AND EXISTS (
           SELECT 1
           FROM detalle_pedidos dp
           WHERE dp.pedido_id = pedidos.id
             AND dp.cantidad > 0
         )
       ORDER BY id
       FOR UPDATE`,
      [mesaId]
    );
    if (activeOrders.length) await requireUnpaidMutation(conn, activeOrders.map((order) => order.id));
    let activeOrder = isPickup ? expressOrder : (activeOrders[0] || null);
    if (!isPickup && activeOrder && activeOrders.length > 1) {
      await mergeAccounts(conn, activeOrders, activeOrder.id);
      activeOrder = { ...activeOrder, total: activeOrders.reduce((sum, order) => sum + Math.round(Number(order.total) * 100), 0) / 100, notas: activeOrders.map((order) => order.notas).filter(Boolean).join(' | ') };
    }
    const isNewOrder = !activeOrder;
    let pedidoId;

    // Mesa apartada por una reserva: solo se abre cuenta si es esa reserva o si el mesero lo confirma.
    let seatedReservation = null;
    if (!isPickup && isNewOrder) {
      const stamp = localNowStamp();
      const [todays] = await conn.query(
        `SELECT id, mesa_id, cliente_nombre, personas, DATE_FORMAT(fecha_hora, '%Y-%m-%d %H:%i') AS fecha_hora, duracion_min, estado
           FROM reservas WHERE mesa_id = ? AND fecha_hora >= ? AND fecha_hora < ? AND estado IN (${BLOCKING_STATES.map(() => '?').join(', ')})`,
        [mesaId, `${addDays(dayOf(stamp), -1)} 00:00:00`, `${addDays(dayOf(stamp), 2)} 00:00:00`, ...BLOCKING_STATES],
      );
      const held = holdingReservation(todays, mesaId, stamp);
      const wanted = req.body.reserva_id == null ? null : Number(req.body.reserva_id);
      if (wanted) seatedReservation = todays.find(r => Number(r.id) === wanted && ['PENDIENTE', 'CONFIRMADA'].includes(r.estado)) || null;
      // Solo se frena a las apps que saben preguntar (avisar_reserva); una app sin actualizar sigue trabajando.
      if (held && !seatedReservation && req.body.avisar_reserva === true && req.body.ignorar_reserva !== true) {
        await conn.rollback();
        return res.status(409).json({ code: 'MESA_RESERVADA', reserva: held,
          message: `La mesa está reservada a las ${timeOf(held.fecha_hora)} para ${held.cliente_nombre}. Confirma si llegó la reserva o si vas a usar la mesa de todos modos.` });
      }
    }

    if (activeOrder) {
      pedidoId = activeOrder.id;
      const mergedNotes = [activeOrder.notas, notas].filter(Boolean).join(' | ');
      await conn.query(
        `UPDATE pedidos
         SET total = ?,
             estado = 'PENDIENTE',
             notas = ?, cuenta_solicitada_at = NULL
         WHERE id = ?`,
        [Number((Number(activeOrder.total || 0) + finalTotal).toFixed(2)), mergedNotes || null, pedidoId]
      );
    } else {
      const [result] = await conn.query(
        `INSERT INTO pedidos (mesa_id, mesero_id, total, estado, tipo, notas, created_at)
         VALUES (?, ?, ?, 'PENDIENTE', ?, ?, NOW())`,
        [mesaId, mesero_id || req.user.id, Number(finalTotal.toFixed(2)), normalizedTipo, notas]
      );
      pedidoId = result.insertId;
      if (seatedReservation) await conn.query("UPDATE reservas SET estado = 'LLEGO', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [seatedReservation.id]);
    }

    if (!targetId) await conn.query(
      `UPDATE pedidos
       SET cliente_nombre = ?,
           cliente_dato = ?,
           delivery_telefono = ?,
           delivery_direccion = ?,
           delivery_referencia = ?
       WHERE id = ?`,
      [
        customerName || null,
        customerData || null,
        normalizedTipo === 'Delivery' ? (deliveryPhone || null) : null,
        normalizedTipo === 'Delivery' ? (deliveryAddress || null) : null,
        normalizedTipo === 'Delivery' ? (deliveryReference || null) : null,
        pedidoId,
      ]
    );

    const [roundResult] = await conn.query('INSERT INTO pedido_rondas (pedido_id, notas, creado_por, creado_por_nombre, pedido_origen_id) VALUES (?, ?, ?, ?, ?)', [pedidoId, notas, req.user.id, String(req.user.nombre || '').slice(0,120) || null, pedidoId]);
    const rondaId = roundResult.insertId;
    const newDetailIds = [];
    for (const item of normalizedItems) {
      const [detail] = await conn.query(
        `INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio, notas, ronda_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pedidoId, item.producto_id, item.cantidad, item.precio, item.notas, rondaId]
      );

      newDetailIds.push(detail.insertId);
      for (const mod of item.modificadores) {
        await conn.query(
          `INSERT INTO detalle_pedido_modificadores (detalle_pedido_id, nombre, tipo, precio_extra)
           VALUES (?, ?, ?, ?)`,
          [detail.insertId, mod.nombre, mod.tipo, mod.precio_extra]
        );
      }
    }

    await reserveRoundStock(conn, rondaId);
    await conn.query('DELETE FROM cuenta_divisiones WHERE pedido_id = ?', [pedidoId]);
    await refreshAccountState(conn, pedidoId);
    if (mesaId) await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Ocupada', mesaId]);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: isNewOrder ? 'pedido.creado' : 'pedido.ronda_agregada',
      entidad: 'pedido',
      entidadId: pedidoId,
      descripcion: isNewOrder ? 'Pedido creado desde mesero' : 'Nueva ronda agregada a pedido activo',
      metadata: { ronda_id:rondaId, actor_nombre:req.user.nombre || null, mesa_id: mesaId, tipo: normalizedTipo, cliente_nombre: customerName || null, items: normalizedItems.length, total: finalTotal },
    });
    const pedido = await getPedidoCompleto(pedidoId, conn);
    const comanda = buildComanda({
      ...pedido, ronda_id: rondaId, notas, created_at: new Date(),
      items: pedido.items.filter((item) => newDetailIds.includes(Number(item.id))),
    });
    const printPayload = {
      pedido_id: pedidoId,
      mesa_id: mesaId,
      tipo: isPickupOrder(pedido) ? (pedido.tipo === 'Delivery' ? 'delivery' : 'para-llevar') : 'cocina',
      plantilla: isPickupOrder(pedido) ? 'comanda_pickup' : 'ticket_cocina',
      texto: comanda,
      impresora: businessConfig.impresora_cocina || null,
      modulo: 'cocina',
    };
    const printJob = await enqueuePrint(conn, printPayload);
    const response = {
      id: pedidoId,
      estado: 'PENDIENTE',
      message: isNewOrder
        ? 'Pedido enviado a cocina y cuenta abierta en caja.'
        : 'Nueva ronda enviada a cocina y sumada a la cuenta.',
      comanda,
      pedido,
      caja: {
        cuenta_abierta: true,
        total_pendiente: pedido.total,
      },
      cocina: {
        comanda_emitida: true,
        impresion: printJob,
      },
    };
    await finishOrderRequest(conn, req.user.id, requestKey, response);
    await conn.commit();

    if (!isNewOrder) emitMergedAccounts(activeOrders, pedidoId);
    emitRealtime(isNewOrder ? EVENTS.ORDER_CREATED : EVENTS.ORDER_UPDATED, {
      pedido, action: isNewOrder ? 'crear_pedido' : 'agregar_ronda',
    });
    emitRealtime(EVENTS.PRINT_COMANDA, { ...printPayload, job_id: printJob.id });
    if (mesaId) await emitTableOccupied(mesaId, { pedido_id: pedidoId });
    if (seatedReservation) emitRealtime(EVENTS.RESERVATION_UPDATED, { action: 'estado', reserva: { ...seatedReservation, estado: 'LLEGO' } });

    res.status(201).json(response);
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.status || error.statusCode || 500).json({ message: error.message, code: error.code });
  } finally {
    conn?.release();
  }
});

router.put('/:id/rondas/:rondaId', verifyRole('admin', 'cocina', 'mesero'), async (req, res) => {
  const next = normalizeEstado(req.body.estado);
  const role = normalizeRole(req.user.rol);
  if (!['PREPARANDO', 'LISTO', 'ENTREGADO'].includes(next) ||
      (role === 'cocina' && next === 'ENTREGADO') || (role === 'mesero' && next !== 'ENTREGADO')) {
    return res.status(403).json({ message: 'No tienes permiso para esta accion de la ronda.' });
  }
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const [[hint]] = await conn.query('SELECT mesa_id FROM pedidos WHERE id = ?', [req.params.id]);
    if (hint?.mesa_id) await conn.query('SELECT id FROM mesas WHERE id = ? FOR UPDATE', [hint.mesa_id]);
    const [[order]] = await conn.query('SELECT id, mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!order || order.estado === 'CANCELADO') throw new Error('Cuenta no disponible.');
    if (Number(order.mesa_id || 0) !== Number(hint?.mesa_id || 0)) throw new Error('La mesa cambio. Actualiza y reintenta.');
    const [[round]] = await conn.query('SELECT * FROM pedido_rondas WHERE id = ? AND pedido_id = ? FOR UPDATE', [req.params.rondaId, order.id]);
    if (!round) throw new Error('Ronda no encontrada.');
    requireExpressPayment(order, next);
    const flow = roundTransition(round.estado, next, role);
    if (flow.recall ? !flow.ok : !isValidTransition(round.estado, next)) throw new Error(`Transicion invalida: ${round.estado} -> ${next}`);
    if (flow.recall) {
      // Deshacer «listo»: vuelve a preparación sin descontar inventario otra vez.
      await conn.query("UPDATE pedido_rondas SET estado = 'PREPARANDO', listo_at = NULL WHERE id = ?", [round.id]);
      await conn.query('UPDATE detalle_pedidos SET listo_at = NULL WHERE ronda_id = ?', [round.id]);
    } else {
      if (next === 'PREPARANDO') await deductRoundInventory(conn, order.id, round);
      const recordDelivery = next === 'ENTREGADO' && round.estado !== next;
      await conn.query(`UPDATE pedido_rondas SET estado = ?, ${STATE_TS[next]} = COALESCE(${STATE_TS[next]}, NOW())${recordDelivery ? ', entregado_por = ?, entregado_por_nombre = ?' : ''} WHERE id = ?`, [next, ...(recordDelivery ? [req.user.id,String(req.user.nombre || '').slice(0,120) || null] : []), round.id]);
      if (next === 'LISTO') await conn.query('UPDATE detalle_pedidos SET listo_at = COALESCE(listo_at, NOW()) WHERE ronda_id = ?', [round.id]);
    }
    await refreshAccountState(conn, order.id);
    const freed = next === 'ENTREGADO' ? await freeMesaIfNoActive(conn, order.mesa_id) : false;
    await safeLogAudit({ conn, user: req.user, accion: flow.recall ? 'ronda.listo_deshecho' : 'ronda.estado_actualizado', entidad: 'ronda', entidadId: round.id,
      metadata: { pedido_id: order.id, actor_nombre:req.user.nombre || null, before: round.estado, after: next } });
    const pedido = await getPedidoCompleto(order.id, conn);
    await conn.commit();
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'ronda_actualizada' });
    if (next === 'LISTO' && round.estado !== next) await notifyWaiterOrderReady(pedido, { rondaId: round.id }).catch((error) => console.warn('Aviso de ronda pendiente:', error.message));
    if (freed) await emitTableFreed(order.mesa_id, { pedido_id: order.id });
    res.json({ pedido, ronda_id: round.id, mesa_liberada: freed });
  } catch (error) { await conn.rollback(); res.status(409).json({ message: error.message }); }
  finally { conn.release(); }
});

// «Listo» por plato. Cocina marca (o desmarca) platos sueltos de una ronda:
// - si la ronda estaba nueva, se empieza (descuenta inventario como siempre);
// - cuando todos sus platos están listos, la ronda pasa a LISTO y se avisa al mesero;
// - desmarcar un plato de una ronda LISTO la devuelve a preparación.
// Así los platos tachados se ven igual en todas las tablets y el mesero sabe qué puede llevar ya.
router.put('/:id/rondas/:rondaId/platos', verifyRole('admin', 'cocina'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))] : [];
  const listo = req.body?.listo !== false;
  if (!ids.length) return res.status(400).json({ message: 'Indica los platos.' });
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const [[order]] = await conn.query('SELECT id, mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!order || ['CANCELADO', 'PAGADO'].includes(order.estado)) throw new Error('Cuenta no disponible.');
    const [[round]] = await conn.query('SELECT * FROM pedido_rondas WHERE id = ? AND pedido_id = ? FOR UPDATE', [req.params.rondaId, order.id]);
    if (!round) throw new Error('Ronda no encontrada.');
    if (!['PENDIENTE', 'PREPARANDO', 'LISTO'].includes(round.estado)) throw new Error('La ronda ya se entregó.');
    let estado = round.estado;
    if (listo && estado === 'PENDIENTE') {
      requireExpressPayment(order, 'PREPARANDO');
      await deductRoundInventory(conn, order.id, round);
      await conn.query("UPDATE pedido_rondas SET estado = 'PREPARANDO', preparando_at = COALESCE(preparando_at, NOW()) WHERE id = ?", [round.id]);
      estado = 'PREPARANDO';
    }
    const [result] = await conn.query(`UPDATE detalle_pedidos SET listo_at = ${listo ? 'COALESCE(listo_at, NOW())' : 'NULL'} WHERE ronda_id = ? AND id IN (?)`, [round.id, ids]);
    if (!result.affectedRows) throw new Error('Esos platos no son de esta ronda.');
    const [items] = await conn.query('SELECT id, cantidad, listo_at FROM detalle_pedidos WHERE ronda_id = ?', [round.id]);
    let roundReady = false;
    if (listo && estado === 'PREPARANDO' && allItemsReady(items)) {
      await conn.query("UPDATE pedido_rondas SET estado = 'LISTO', listo_at = COALESCE(listo_at, NOW()) WHERE id = ?", [round.id]);
      estado = 'LISTO'; roundReady = true;
    } else if (!listo && estado === 'LISTO') {
      await conn.query("UPDATE pedido_rondas SET estado = 'PREPARANDO', listo_at = NULL WHERE id = ?", [round.id]);
      estado = 'PREPARANDO';
    }
    await refreshAccountState(conn, order.id);
    await safeLogAudit({ conn, user: req.user, accion: listo ? 'ronda.platos_listos' : 'ronda.platos_desmarcados', entidad: 'ronda', entidadId: round.id,
      metadata: { pedido_id: order.id, platos: ids, estado_ronda: estado } });
    const pedido = await getPedidoCompleto(order.id, conn);
    await conn.commit();
    const names = (pedido.items || []).filter((it) => ids.includes(Number(it.id))).map((it) => `${it.cantidad}× ${it.nombre}`);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: listo ? 'platos_listos' : 'platos_desmarcados', ronda_id: round.id, platos: ids, nombres: names, ronda_lista: roundReady });
    if (roundReady) await notifyWaiterOrderReady(pedido, { rondaId: round.id }).catch((error) => console.warn('Aviso de ronda pendiente:', error.message));
    else if (listo && names.length) {
      await sendPushToUser(pedido.mesero_id, { title: `${pedidoUbicacionLabel(pedido)}: plato listo`, body: `${names.join(', ')} listo para llevar.`,
        data: { type: 'ITEMS_READY', pedido_id: pedido.id, mesa_id: pedido.mesa_id, ronda_id: round.id } }).catch(() => {});
    }
    res.json({ pedido, ronda_id: round.id, estado_ronda: estado, ronda_lista: roundReady });
  } catch (error) {
    await conn.rollback();
    res.status(409).json({ message: error.message });
  } finally { conn.release(); }
});

router.put('/:id', verifyRole('admin', 'cocina', 'mesero', 'caja'), async (req, res) => {
  const next = normalizeEstado(req.body.estado);
  if (req.body.expected_item_ids !== undefined && !Array.isArray(req.body.expected_item_ids)) {
    return res.status(400).json({ message: 'Lista de productos invalida.' });
  }
  if (['PENDIENTE', 'PREPARANDO', 'LISTO', 'ENTREGADO'].includes(next)) {
    return res.status(409).json({ message: 'Actualiza la ronda correspondiente, no la cuenta completa.' });
  }
  if (next === 'PAGADO') {
    return res.status(403).json({ message: 'Registra el pago desde caja para cerrar la cuenta.' });
  }
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    if (req.body.expected_item_ids) {
      const [[currentOrder]] = await conn.query('SELECT id FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!currentOrder) throw new Error('Pedido no encontrado.');
      const [details] = await conn.query('SELECT id FROM detalle_pedidos WHERE pedido_id = ? ORDER BY id', [req.params.id]);
      const expected = [...req.body.expected_item_ids].map(Number).sort((a, b) => a - b);
      if (JSON.stringify(details.map((row) => Number(row.id)).sort((a, b) => a - b)) !== JSON.stringify(expected)) {
        throw new Error('El pedido cambio: revisa los productos nuevos antes de continuar.');
      }
    }
    const transition = await transitionPedido(conn, req.params.id, next);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.estado_actualizado',
      entidad: 'pedido',
      entidadId: Number(req.params.id),
      descripcion: `${transition.before} -> ${transition.after}`,
      metadata: transition,
    });
    await conn.commit();

    const pedido = await getPedidoCompleto(req.params.id);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, transition });
    if (transition.after === 'LISTO') {
      await notifyWaiterOrderReady(pedido);
    }
    if (transition.table_freed) {
      await emitTableFreed(transition.mesa_id, { pedido_id: Number(req.params.id), transition });
    }

    res.json({
      message: `Pedido actualizado a ${transition.after}.`,
      transition,
      pedido,
      mesa_liberada: transition.table_freed,
    });
  } catch (error) {
    await conn.rollback();
    res.status(error.message.includes('no encontrado') ? 404 : 409).json({ message: error.message });
  } finally {
    conn.release();
  }
});

router.post('/:id/ping', verifyRole('admin', 'cocina'), async (req, res) => {
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    if (!pedido.mesero_id) return res.status(409).json({ message: 'El pedido no tiene mesero asignado.' });

    await notifyWaiterOrderReady(pedido, { manual: true });
    res.json({ message: 'Aviso enviado al mesero.', pedido });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/:id/imprimir-precuenta', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  await ensurePickupFields();
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const account = await consolidateAccount(conn, Number(req.params.id));
    const [[pedidoRow]] = await conn.query('SELECT mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedidoRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    const current = normalizeEstado(pedidoRow.estado);
    if (['PAGADO', 'CANCELADO'].includes(current)) {
      await conn.rollback();
      return res.status(409).json({ message: 'No puedes solicitar la cuenta de un pedido cerrado.' });
    }
    await conn.query(
      `UPDATE pedidos
       SET cuenta_solicitada_at = COALESCE(cuenta_solicitada_at, NOW())
       WHERE id = ?`,
      [req.params.id]
    );
    if (pedidoRow.mesa_id) {
      await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Cuenta', pedidoRow.mesa_id]);
    }
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.precuenta_impresa',
      entidad: 'pedido',
      entidadId: Number(req.params.id),
      descripcion: 'Pre-cuenta enviada a impresion',
      metadata: { before: current },
    });
    await conn.commit();
    emitMergedAccounts(account.orders, Number(req.params.id));

    const businessConfig = await getBusinessConfig();
    const pedido = await getPedidoCompleto(req.params.id);
    const texto = buildPrecuenta(pedido, businessConfig);
    emitRealtime(EVENTS.PRINT_PRECUENTA, {
      pedido_id: pedido.id,
      mesa_id: pedido.mesa_id,
      tipo: 'cliente',
      plantilla: 'ticket_cliente_precuenta',
      texto,
      impresora: businessConfig.impresora_caja || null,
      modulo: 'caja',
    });
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, transition: { before: current, after: pedido.estado } });
    if (pedido.mesa_id) {
      emitRealtime(EVENTS.TABLE_UPDATED, { mesa_id: pedido.mesa_id, estado: 'Cuenta' });
    }
    res.json({ pedido, texto, message: 'Pre-cuenta enviada a impresion.' });
  } catch (error) {
    await conn.rollback();
    res.status(409).json({ message: error.message });
  } finally {
    conn.release();
  }
});

router.post('/:id/solicitar-cobro', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  await ensurePickupFields();
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const account = await consolidateAccount(conn, Number(req.params.id));
    const [[pedidoRow]] = await conn.query('SELECT mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedidoRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    const current = normalizeEstado(pedidoRow.estado);
    if (['PAGADO', 'CANCELADO'].includes(current)) {
      await conn.rollback();
      return res.status(409).json({ message: 'No puedes solicitar la cuenta de un pedido cerrado.' });
    }

    await conn.query(
      `UPDATE pedidos
       SET cuenta_solicitada_at = COALESCE(cuenta_solicitada_at, NOW())
       WHERE id = ?`,
      [req.params.id]
    );

    if (pedidoRow.mesa_id) {
      await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Cuenta', pedidoRow.mesa_id]);
    }

    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.cobro_solicitado',
      entidad: 'pedido',
      entidadId: Number(req.params.id),
      descripcion: 'Cobro solicitado a caja',
      metadata: { before: current },
    });

    await conn.commit();
    emitMergedAccounts(account.orders, Number(req.params.id));

    const pedido = await getPedidoCompleto(req.params.id);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, transition: { before: current, after: pedido.estado }, cobro_solicitado: true });
    if (pedido.mesa_id) {
      emitRealtime(EVENTS.TABLE_UPDATED, { mesa_id: pedido.mesa_id, estado: 'Cuenta' });
    }
    res.json({ pedido, message: 'Cobro solicitado a caja.' });
  } catch (error) {
    await conn.rollback();
    res.status(409).json({ message: error.message });
  } finally {
    conn.release();
  }
});

router.post('/:id/transferir', verifyRole('admin', 'mesero'), async (req, res) => {
  const mesaId = Number(req.body.mesa_id);
  if (!Number.isSafeInteger(mesaId) || mesaId <= 0) return res.status(400).json({ message: 'Mesa destino invalida.' });
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const { seed, orders } = await lockWholeAccount(conn, Number(req.params.id), mesaId, { allowPaid: true });
    if (!seed.mesa_id || Number(seed.mesa_id) === mesaId) throw new Error('Selecciona una mesa diferente.');
    const sourceIds = orders.filter((order) => Number(order.mesa_id) === Number(seed.mesa_id)).map((order) => order.id);
    // Paid food still awaiting delivery follows the table, but is never charged again.
    const [paid] = await conn.query(`SELECT id FROM pedidos WHERE mesa_id = ? AND estado = 'PAGADO'
      AND EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = pedidos.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO')) ORDER BY id FOR UPDATE`, [seed.mesa_id]);
    const movedIds = [...new Set([...sourceIds, ...paid.map((order) => order.id)])];
    await conn.query('UPDATE pedidos SET mesa_id = ? WHERE id IN (?)', [mesaId, movedIds]);
    const openOrders = orders.filter((order) => !['PAGADO', 'CANCELADO'].includes(order.estado));
    if (openOrders.length) await mergeAccounts(conn, openOrders, openOrders.some((order) => order.id === seed.id) ? seed.id : openOrders[0].id);
    await conn.query("UPDATE mesas SET estado = 'Ocupada' WHERE id = ?", [mesaId]);
    const sourceFreed = await freeMesaIfNoActive(conn, seed.mesa_id);
    const pedido = await getPedidoCompleto(seed.id, conn);
    const affected = [...new Set([...orders.map((order) => order.id), ...movedIds])];
    const updated = await Promise.all(affected.map((id) => getPedidoCompleto(id, conn)));
    await safeLogAudit({ conn, user: req.user, accion: 'cuenta.transferida', entidad: 'pedido', entidadId: seed.id,
      metadata: { mesa_anterior: seed.mesa_id, mesa_nueva: mesaId, pedidos: movedIds } });
    await conn.commit();
    for (const order of updated) emitRealtime(EVENTS.ORDER_UPDATED, { pedido: order, action: 'cuenta_transferida' });
    await emitTableOccupied(mesaId);
    if (sourceFreed) await emitTableFreed(seed.mesa_id);
    res.json({ pedido, pedidos: updated, message: 'Cuenta completa transferida.' });
  } catch (error) { await conn.rollback(); res.status(409).json({ message: error.message }); }
  finally { conn.release(); }
});

router.post('/unir-mesas', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.pedido_ids) ? req.body.pedido_ids : []).map(Number))];
  if (ids.length < 2 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ message: 'Selecciona al menos dos cuentas validas.' });
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const [hints] = await conn.query('SELECT id, mesa_id FROM pedidos WHERE id IN (?)', [ids]);
    const tables = [...new Set(hints.map((order) => Number(order.mesa_id)).filter(Boolean))].sort((a,b) => a-b);
    if (tables.length) await conn.query('SELECT id FROM mesas WHERE id IN (?) ORDER BY id FOR UPDATE', [tables]);
    const [orders] = await conn.query("SELECT * FROM pedidos WHERE id IN (?) OR (mesa_id IN (?) AND estado NOT IN ('PAGADO', 'CANCELADO')) ORDER BY id FOR UPDATE", [ids, tables.length ? tables : [0]]);
    if (ids.some((id) => !orders.some((order) => Number(order.id) === id))) throw new Error('Cuenta no encontrada.');
    if (hints.some((hint) => Number(orders.find((order) => Number(order.id) === Number(hint.id))?.mesa_id) !== Number(hint.mesa_id))) throw new Error('Una cuenta cambio de mesa. Actualiza y reintenta.');
    const target = orders.find((order) => Number(order.id) === ids[0]);
    if (!target.mesa_id || orders.some((order) => !order.mesa_id)) throw new Error('Solo puedes unir cuentas de mesas.');
    await mergeAccounts(conn, orders, target.id);
    const updated = await Promise.all(orders.map((order) => getPedidoCompleto(order.id, conn)));
    const freedTables = [];
    for (const table of tables) if (await freeMesaIfNoActive(conn, table)) freedTables.push(table);
    await conn.commit();
    for (const pedido of updated) emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'cuentas_unidas' });
    for (const table of tables) await (freedTables.includes(table) ? emitTableFreed(table) : emitTableOccupied(table));
    res.json({ pedido: updated.find((order) => Number(order.id) === Number(target.id)), message: 'Cuentas unidas conservando sus rondas.' });
  } catch (error) { await conn.rollback(); res.status(409).json({ message: error.message }); }
  finally { conn.release(); }
});

async function splitAccount(req, res, preview = false, overrideMode = null) {
  const pedidoId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const account = await consolidateAccount(conn, pedidoId);
    const pedido = await getPedidoCompleto(pedidoId, conn);
    await requireUnpaidMutation(conn, [pedidoId]);
    const mode = overrideMode || req.body.mode || 'equal';
    const divisions = buildAccountSplit(pedido, { mode, partes: req.body.partes,
      divisions: req.body.divisions || req.body.groups });
    if (!preview) {
      await conn.query('DELETE FROM cuenta_divisiones WHERE pedido_id = ?', [pedidoId]);
      for (const division of divisions) {
        const [created] = await conn.query("INSERT INTO cuenta_divisiones (pedido_id, nombre, monto, estado) VALUES (?, ?, ?, 'PENDIENTE')", [pedidoId, division.nombre, division.monto]);
        for (const item of division.items) await conn.query('INSERT INTO cuenta_division_items (division_id, detalle_pedido_id, cantidad) VALUES (?, ?, ?)', [created.insertId, item.detalle_pedido_id, item.cantidad]);
      }
      await safeLogAudit({ conn, user: req.user, accion: 'cuenta.dividida', entidad: 'pedido', entidadId: pedidoId,
        metadata: { mode, partes: divisions.length } });
    }
    // Preview rolls back consolidation; only the requested split changes stored data.
    if (preview) await conn.rollback(); else await conn.commit();
    const payload = { pedido, pedido_id: pedidoId, mode, partes: divisions.length, divisions };
    if (!preview) {
      emitMergedAccounts(account.orders, pedidoId);
      emitRealtime(EVENTS.SPLIT_REQUESTED, payload);
      emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'split_requested' });
    }
    res.status(preview ? 200 : 201).json(payload);
  } catch (error) { await conn.rollback(); res.status(409).json({ message: error.message }); }
  finally { conn.release(); }
}
router.post('/:id/split/equal', verifyRole('admin', 'mesero', 'caja'), (req, res) => splitAccount(req, res, true, 'equal'));
router.post('/:id/split/items', verifyRole('admin', 'mesero', 'caja'), (req, res) => splitAccount(req, res, true, 'items'));
router.post('/:id/split/request', verifyRole('admin', 'mesero', 'caja'), (req, res) => splitAccount(req, res));

router.delete('/:id', verifyRole('admin', 'mesero'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await beginAccountTransaction(conn);
    const [[pedido]] = await conn.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    const [[{ detalles }]] = await conn.query(
      'SELECT COUNT(*) AS detalles FROM detalle_pedidos WHERE pedido_id = ? AND cantidad > 0',
      [req.params.id]
    );
    const sentToKitchen = Number(detalles || 0) > 0;
    if (normalizeRole(req.user.rol) === 'mesero' && sentToKitchen) {
      await conn.rollback();
      return res.status(403).json({ message: 'El mesero no puede borrar pedidos despues de enviarlos a cocina.' });
    }

    const [reservations] = await conn.query('SELECT sr.ronda_id FROM stock_reservas sr JOIN pedido_rondas r ON r.id = sr.ronda_id WHERE r.pedido_id = ? LIMIT 1', [req.params.id]);
    if (reservations.length) {
      await conn.rollback();
      return res.status(409).json({ message: 'Esta comanda tiene movimientos de inventario. Usa Cancelar para liberar sus reservas y conservar el historial.' });
    }

    const [paymentHistory] = await conn.query('SELECT id FROM pagos WHERE pedido_id = ? LIMIT 1', [req.params.id]);
    if (paymentHistory.length) { await conn.rollback(); return res.status(409).json({ message: 'Esta cuenta tiene comprobantes. Conserva su historial; no puede eliminarse.' }); }
    await conn.query('DELETE FROM detalle_pedido_modificadores WHERE detalle_pedido_id IN (SELECT id FROM detalle_pedidos WHERE pedido_id = ?)', [req.params.id]);
    await conn.query('DELETE FROM detalle_pedidos WHERE pedido_id = ?', [req.params.id]);
    await conn.query('DELETE FROM pedidos WHERE id = ?', [req.params.id]);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.eliminado',
      entidad: 'pedido',
      entidadId: Number(req.params.id),
      descripcion: 'Pedido eliminado',
      metadata: { estado: pedido.estado, mesa_id: pedido.mesa_id, sentToKitchen },
    });
    await conn.commit();
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido_id: Number(req.params.id), action: 'delete' });
    res.json({ message: 'Pedido eliminado.' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

export default router;
