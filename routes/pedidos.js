import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { emitRealtime, EVENTS } from '../realtime.js';
import { sendPushToUser } from './notificaciones.js';
import { emitTableFreed, emitTableOccupied, freeMesaIfNoActive, syncTableStates } from '../services/tableState.js';
import { safeLogAudit } from '../services/audit.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { normalizeRole } from '../services/permissions.js';

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

function normalizeEstado(estado) {
  return STATE_ALIASES[estado] || String(estado || '').toUpperCase();
}

function isValidTransition(current, next) {
  if (current === next) return true;
  if (next === 'CANCELADO' && !['PAGADO', 'CANCELADO'].includes(current)) return true;
  return NEXT_ALLOWED[current]?.includes(next);
}

function parseMods(modsJson) {
  if (!modsJson) return [];
  try {
    return JSON.parse(`[${modsJson}]`);
  } catch {
    return [];
  }
}

async function hydrateOrders(rows) {
  const orders = rows.map((p) => ({ ...p, estado: normalizeEstado(p.estado), items: [] }));
  const ids = orders.map((p) => p.id);
  if (!ids.length) return orders;

  const [items] = await pool.query(
    `SELECT dp.id, dp.pedido_id, dp.producto_id, dp.cantidad, dp.precio, dp.notas,
            pr.nombre,
            GROUP_CONCAT(
              JSON_OBJECT(
                'id', dpm.id,
                'nombre', dpm.nombre,
                'tipo', dpm.tipo,
                'precio_extra', dpm.precio_extra
              )
            ) AS modificadores_json
     FROM detalle_pedidos dp
     LEFT JOIN productos pr ON dp.producto_id = pr.id
     LEFT JOIN detalle_pedido_modificadores dpm ON dpm.detalle_pedido_id = dp.id
     WHERE dp.pedido_id IN (?)
     GROUP BY dp.id
     ORDER BY dp.id ASC`,
    [ids]
  );

  const byOrder = items.reduce((acc, item) => {
    const mods = parseMods(item.modificadores_json).filter((m) => m.id !== null);
    acc[item.pedido_id] = acc[item.pedido_id] || [];
    acc[item.pedido_id].push({
      id: item.id,
      producto_id: item.producto_id,
      nombre: item.nombre,
      cantidad: Number(item.cantidad || 0),
      precio: Number(item.precio || 0),
      notas: item.notas,
      modificadores: mods,
    });
    return acc;
  }, {});

  return orders.map((order) => ({ ...order, items: byOrder[order.id] || [] }));
}

export async function getPedidoCompleto(id) {
  const [rows] = await pool.query(
    `SELECT p.*,
            m.numero AS mesa_numero,
            t.nombre AS mesero_nombre
     FROM pedidos p
     LEFT JOIN mesas m ON p.mesa_id = m.id
     LEFT JOIN trabajadores t ON p.mesero_id = t.id
     WHERE p.id = ?`,
    [id]
  );
  return (await hydrateOrders(rows))[0] || null;
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

async function notifyWaiterOrderReady(pedido, { manual = false } = {}) {
  if (!pedido) return;
  const target = pedidoUbicacionLabel(pedido);
  const title = manual ? `Cocina llama: ${target}` : `${target} listo`;
  const body = manual
    ? 'Cocina solicita que el mesero recoja o revise este pedido.'
    : `Pedido #${pedido.id} listo para recoger.`;
  const payload = {
    pedido,
    message: body,
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
    const extra = observaciones.length > 10 ? [`      ${cut(observaciones.slice(10), 34)}`] : [];
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
    ticketRow('Total a pagar', moneyTicket(total, symbol)),
    line,
    center('Ticket no fiscal'),
  ].filter(Boolean).join('\n');
}

async function getPedidoItemsForInventory(conn, pedidoId) {
  const [items] = await conn.query(
    `SELECT dp.id AS detalle_id, dp.producto_id, dp.cantidad,
            pr.nombre, pr.stock, pr.inventario_item_id
     FROM detalle_pedidos dp
     JOIN productos pr ON dp.producto_id = pr.id
     WHERE dp.pedido_id = ?`,
    [pedidoId]
  );
  return items;
}

async function deductInventoryForPedido(conn, pedidoId) {
  const [[pedido]] = await conn.query('SELECT inventario_descontado FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
  if (!pedido || Number(pedido.inventario_descontado) === 1) return;

  const items = await getPedidoItemsForInventory(conn, pedidoId);
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
      if (Number(item.stock) < Number(item.cantidad)) {
        throw new Error(`Sin stock suficiente para ${item.nombre}. Disponible: ${item.stock}.`);
      }
      await conn.query(
        `UPDATE productos
         SET stock = stock - ?,
             disponible = CASE WHEN stock - ? <= 0 THEN 0 ELSE disponible END
         WHERE id = ?`,
        [item.cantidad, item.cantidad, item.producto_id]
      );
    }
  }

  await conn.query('UPDATE pedidos SET inventario_descontado = 1 WHERE id = ?', [pedidoId]);
}

async function restoreInventoryForPedido(conn, pedidoId) {
  const [[pedido]] = await conn.query('SELECT inventario_descontado FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
  if (!pedido || Number(pedido.inventario_descontado) !== 1) return;

  const items = await getPedidoItemsForInventory(conn, pedidoId);
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
    await restoreInventoryForPedido(conn, pedidoId);
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
    const [rows] = await pool.query(
      `SELECT p.*,
              m.numero AS mesa_numero,
              t.nombre AS mesero_nombre
       FROM pedidos p
       LEFT JOIN mesas m ON p.mesa_id = m.id
       LEFT JOIN trabajadores t ON p.mesero_id = t.id
       ${history ? '' : 'WHERE DATE(p.created_at) = CURDATE()'}
       ORDER BY p.created_at DESC
       LIMIT ${history ? 160 : 100}`
    );

    res.json(await hydrateOrders(rows));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    mesa_id = null,
    mesero_id,
    notas = null,
    items = [],
    total: requestedTotal = null,
    tipo = 'Mesa',
    cliente_nombre = null,
    cliente_dato = null,
    delivery_telefono = null,
    delivery_direccion = null,
    delivery_referencia = null,
  } = req.body;
  const normalizedTipo = tipo === 'Para llevar' || tipo === 'Delivery' ? tipo : 'Mesa';
  const isPickup = normalizedTipo !== 'Mesa';
  const mesaId = mesa_id ? Number(mesa_id) : null;
  const customerName = String(cliente_nombre || '').trim();
  const customerData = String(cliente_dato || '').trim();
  const deliveryPhone = String(delivery_telefono || '').trim();
  const deliveryAddress = String(delivery_direccion || '').trim();
  const deliveryReference = String(delivery_referencia || '').trim();

  if ((!mesaId && !isPickup) || !items.length) {
    return res.status(400).json({ message: 'Mesa e items son obligatorios.' });
  }
  if (isPickup && !customerName) {
    return res.status(400).json({ message: 'El nombre del cliente es obligatorio para pedidos express.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const normalizedItems = [];
    let total = 0;

    for (const item of items) {
      const productoId = Number(item.producto_id);
      const cantidad = Number(item.cantidad || 0);
      if (!productoId || cantidad <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'Todos los items deben tener producto y cantidad valida.' });
      }

      const [[product]] = await conn.query(
        'SELECT id, nombre, precio, disponible FROM productos WHERE id = ?',
        [productoId]
      );
      if (!product || Number(product.disponible) !== 1) {
        await conn.rollback();
        return res.status(409).json({ message: `Producto no disponible: ${product?.nombre || productoId}` });
      }

      const modificadores = Array.isArray(item.modificadores) ? item.modificadores.map((mod) => ({
        nombre: String(mod.nombre || '').trim(),
        tipo: ['EXTRA', 'EXCLUSION', 'TERMINO', 'NOTA'].includes(mod.tipo) ? mod.tipo : 'NOTA',
        precio_extra: Number(mod.precio_extra || 0),
      })).filter((mod) => mod.nombre) : [];

      const extras = modificadores.reduce((sum, mod) => sum + Number(mod.precio_extra || 0), 0);
      const precio = Number(item.precio ?? product.precio ?? 0);
      total += (precio + extras) * cantidad;
      normalizedItems.push({
        producto_id: productoId,
        cantidad,
        precio,
        notas: item.notas || null,
        modificadores,
      });
    }

    const finalTotal = Number(requestedTotal || 0) >= total ? Number(requestedTotal) : total;
    const [activeOrders] = await conn.query(
      `SELECT id, total, notas, estado
       FROM pedidos
       WHERE mesa_id = ?
         AND DATE(created_at) = CURDATE()
         AND estado NOT IN ('PAGADO', 'CANCELADO')
         AND EXISTS (
           SELECT 1
           FROM detalle_pedidos dp
           WHERE dp.pedido_id = pedidos.id
             AND dp.cantidad > 0
         )
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [mesaId]
    );
    const activeOrder = !isPickup ? (activeOrders[0] || null) : null;
    const isNewOrder = !activeOrder;
    let pedidoId;

    if (activeOrder) {
      pedidoId = activeOrder.id;
      const mergedNotes = [activeOrder.notas, notas].filter(Boolean).join(' | ');
      await conn.query(
        `UPDATE pedidos
         SET total = ?,
             estado = 'PENDIENTE',
             notas = ?
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
    }

    await conn.query(
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

    for (const item of normalizedItems) {
      const [detail] = await conn.query(
        `INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio, notas)
         VALUES (?, ?, ?, ?, ?)`,
        [pedidoId, item.producto_id, item.cantidad, item.precio, item.notas]
      );

      for (const mod of item.modificadores) {
        await conn.query(
          `INSERT INTO detalle_pedido_modificadores (detalle_pedido_id, nombre, tipo, precio_extra)
           VALUES (?, ?, ?, ?)`,
          [detail.insertId, mod.nombre, mod.tipo, mod.precio_extra]
        );
      }
    }

    if (mesaId) await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Ocupada', mesaId]);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: isNewOrder ? 'pedido.creado' : 'pedido.ronda_agregada',
      entidad: 'pedido',
      entidadId: pedidoId,
      descripcion: isNewOrder ? 'Pedido creado desde mesero' : 'Nueva ronda agregada a pedido activo',
      metadata: { mesa_id: mesaId, tipo: normalizedTipo, cliente_nombre: customerName || null, items: normalizedItems.length, total: finalTotal },
    });
    await conn.commit();

    const pedido = await getPedidoCompleto(pedidoId);
    const comanda = buildComanda(pedido);
    const businessConfig = await getBusinessConfig();
    emitRealtime(isNewOrder ? EVENTS.ORDER_CREATED : EVENTS.ORDER_UPDATED, {
      pedido,
      action: isNewOrder ? 'crear_pedido' : 'agregar_ronda',
    });
    if (mesaId) {
      await emitTableOccupied(mesaId, {
        pedido_id: pedidoId,
        action: isNewOrder ? 'crear_pedido' : 'agregar_ronda',
      });
    }
    emitRealtime(EVENTS.PRINT_COMANDA, {
      pedido_id: pedidoId,
      mesa_id: mesaId,
      tipo: isPickupOrder(pedido) ? (pedido.tipo === 'Delivery' ? 'delivery' : 'para-llevar') : 'cocina',
      plantilla: isPickupOrder(pedido) ? 'comanda_pickup' : 'ticket_cocina',
      texto: comanda,
      impresora: businessConfig.impresora_cocina || null,
      modulo: 'cocina',
    });

    res.status(201).json({
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
      },
    });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.put('/:id', verifyRole('admin', 'cocina', 'mesero', 'caja'), async (req, res) => {
  const next = normalizeEstado(req.body.estado);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
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
      mesa_liberada: ['PAGADO', 'CANCELADO'].includes(transition.after),
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
    await conn.beginTransaction();
    const [[pedidoRow]] = await conn.query('SELECT mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedidoRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    const current = normalizeEstado(pedidoRow.estado);
    if (['PENDIENTE', 'PREPARANDO', 'LISTO'].includes(current)) {
      await transitionPedido(conn, req.params.id, 'ENTREGADO', { allowShortcut: true });
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
    await conn.beginTransaction();
    const [[pedidoRow]] = await conn.query('SELECT mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedidoRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }

    const current = normalizeEstado(pedidoRow.estado);
    if (['PENDIENTE', 'PREPARANDO', 'LISTO'].includes(current)) {
      await transitionPedido(conn, req.params.id, 'ENTREGADO', { allowShortcut: true });
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
  const { mesa_id } = req.body;
  if (!mesa_id) return res.status(400).json({ message: 'mesa_id es obligatorio.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[pedido]] = await conn.query('SELECT mesa_id, estado FROM pedidos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }
    if (['PAGADO', 'CANCELADO'].includes(normalizeEstado(pedido.estado))) {
      await conn.rollback();
      return res.status(409).json({ message: 'No puedes transferir un pedido cerrado.' });
    }

    await conn.query('UPDATE pedidos SET mesa_id = ? WHERE id = ?', [mesa_id, req.params.id]);
    await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Ocupada', mesa_id]);
    const previousTableFreed = await freeMesaIfNoActive(conn, pedido.mesa_id);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.transferido',
      entidad: 'pedido',
      entidadId: Number(req.params.id),
      descripcion: 'Pedido transferido de mesa',
      metadata: { mesa_anterior: pedido.mesa_id, mesa_nueva: mesa_id },
    });
    await conn.commit();

    const updated = await getPedidoCompleto(req.params.id);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido: updated, action: 'transferir_mesa' });
    await emitTableOccupied(mesa_id, { pedido_id: Number(req.params.id), action: 'transferir_mesa' });
    if (previousTableFreed) {
      await emitTableFreed(pedido.mesa_id, { pedido_id: Number(req.params.id), action: 'transferir_mesa' });
    }
    res.json({ message: 'Pedido transferido.', pedido: updated });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.post('/unir-mesas', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  const { pedido_ids = [] } = req.body;
  const ids = pedido_ids.map(Number).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ message: 'Selecciona al menos dos pedidos para unir.' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const targetId = ids[0];
    const sourceIds = ids.slice(1);

    const [orders] = await conn.query('SELECT id, mesa_id, estado, total FROM pedidos WHERE id IN (?) FOR UPDATE', [ids]);
    if (orders.length !== ids.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Uno o mas pedidos no existen.' });
    }
    if (orders.some((p) => ['PAGADO', 'CANCELADO'].includes(normalizeEstado(p.estado)))) {
      await conn.rollback();
      return res.status(409).json({ message: 'No puedes unir pedidos cerrados.' });
    }

    await conn.query('UPDATE detalle_pedidos SET pedido_id = ? WHERE pedido_id IN (?)', [targetId, sourceIds]);
    const mergedTotal = orders.reduce((sum, p) => sum + Number(p.total || 0), 0);
    await conn.query('UPDATE pedidos SET total = ? WHERE id = ?', [mergedTotal, targetId]);
    await conn.query(`UPDATE pedidos SET estado = 'CANCELADO', total = 0, cancelado_at = COALESCE(cancelado_at, NOW()) WHERE id IN (?)`, [sourceIds]);

    const freedTableIds = [];
    for (const order of orders.filter((p) => p.id !== targetId)) {
      if (await freeMesaIfNoActive(conn, order.mesa_id)) {
        freedTableIds.push(order.mesa_id);
      }
    }
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.unido',
      entidad: 'pedido',
      entidadId: targetId,
      descripcion: 'Pedidos unidos',
      metadata: { source_ids: sourceIds },
    });

    await conn.commit();
    const pedido = await getPedidoCompleto(targetId);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'unir_pedidos', source_ids: sourceIds });
    for (const mesaId of freedTableIds) {
      await emitTableFreed(mesaId, { pedido_id: targetId, action: 'unir_pedidos' });
    }
    res.json({ message: 'Pedidos unidos.', pedido });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.post('/:id/split/equal', async (req, res) => {
  const partes = Math.max(2, Number(req.body.partes || 2));
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });
    const total = Number(pedido.total || 0);
    const base = Math.floor((total / partes) * 100) / 100;
    const divisions = Array.from({ length: partes }).map((_, index) => ({
      nombre: `Parte ${index + 1}`,
      monto: index === partes - 1 ? Number((total - base * (partes - 1)).toFixed(2)) : base,
    }));
    res.json({ pedido_id: pedido.id, total, partes, divisions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/split/items', async (req, res) => {
  const { groups = [] } = req.body;
  try {
    const pedido = await getPedidoCompleto(req.params.id);
    if (!pedido) return res.status(404).json({ message: 'Pedido no encontrado.' });

    const itemMap = new Map(pedido.items.map((item) => [Number(item.id), item]));
    const divisions = groups.map((group, index) => {
      const monto = (group.items || []).reduce((sum, itemRef) => {
        const item = itemMap.get(Number(itemRef.detalle_pedido_id));
        if (!item) return sum;
        const qty = Number(itemRef.cantidad || item.cantidad || 0);
        const extras = (item.modificadores || []).reduce((mSum, mod) => mSum + Number(mod.precio_extra || 0), 0);
        return sum + (Number(item.precio || 0) + extras) * qty;
      }, 0);
      return { nombre: group.nombre || `Persona ${index + 1}`, monto: Number(monto.toFixed(2)), items: group.items || [] };
    });
    res.json({ pedido_id: pedido.id, divisions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/split/request', verifyRole('admin', 'mesero'), async (req, res) => {
  const pedidoId = Number(req.params.id);
  const mode = req.body.mode === 'items' ? 'items' : 'equal';
  const partes = Math.max(2, Number(req.body.partes || 2));
  const requestedDivisions = Array.isArray(req.body.divisions) ? req.body.divisions : [];
  const conn = await pool.getConnection();

  try {
    await ensureSplitTables();
    await conn.beginTransaction();
    const [[pedidoRow]] = await conn.query(
      `SELECT id, estado, total
       FROM pedidos
       WHERE id = ?
       FOR UPDATE`,
      [pedidoId]
    );

    if (!pedidoRow) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }
    if (['PAGADO', 'CANCELADO'].includes(normalizeEstado(pedidoRow.estado))) {
      await conn.rollback();
      return res.status(409).json({ message: 'No puedes dividir una cuenta cerrada.' });
    }

    await conn.query(
      `DELETE FROM cuenta_divisiones
       WHERE pedido_id = ?
         AND estado = 'PENDIENTE'`,
      [pedidoId]
    );

    let divisions = requestedDivisions
      .map((division, index) => ({
        nombre: String(division.nombre || `Parte ${index + 1}`).trim(),
        monto: Number(division.monto || 0),
        items: Array.isArray(division.items) ? division.items : [],
      }))
      .filter((division) => division.nombre && Number.isFinite(division.monto) && division.monto > 0);

    if (!divisions.length) {
      const total = Number(pedidoRow.total || 0);
      const base = Math.floor((total / partes) * 100) / 100;
      divisions = Array.from({ length: partes }).map((_, index) => ({
        nombre: `Parte ${index + 1}`,
        monto: index === partes - 1 ? Number((total - base * (partes - 1)).toFixed(2)) : base,
        items: [],
      }));
    }

    for (const division of divisions) {
      const [created] = await conn.query(
        `INSERT INTO cuenta_divisiones (pedido_id, nombre, monto, estado)
         VALUES (?, ?, ?, 'PENDIENTE')`,
        [pedidoId, division.nombre, Number(division.monto.toFixed(2))]
      );

      for (const item of division.items) {
        const detailId = Number(item.detalle_pedido_id);
        const cantidad = Number(item.cantidad || 1);
        if (!detailId || cantidad <= 0) continue;
        await conn.query(
          `INSERT INTO cuenta_division_items (division_id, detalle_pedido_id, cantidad)
           VALUES (?, ?, ?)`,
          [created.insertId, detailId, cantidad]
        );
      }
    }
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'pedido.division_solicitada',
      entidad: 'pedido',
      entidadId: pedidoId,
      descripcion: 'Division de cuenta enviada a caja',
      metadata: { mode, partes: divisions.length },
    });

    await conn.commit();
    const pedido = await getPedidoCompleto(pedidoId);
    const payload = { pedido, pedido_id: pedidoId, mode, partes: divisions.length, divisions };
    emitRealtime(EVENTS.SPLIT_REQUESTED, payload);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'split_requested', split: payload });
    res.status(201).json({ message: 'Division enviada a caja.', ...payload });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.delete('/:id', verifyRole('admin', 'mesero'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
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
