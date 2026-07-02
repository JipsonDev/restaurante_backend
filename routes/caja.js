import express from 'express';
import { pool } from '../db.js';
import { getPedidoCompleto, transitionPedido } from './pedidos.js';
import { emitRealtime, EVENTS } from '../realtime.js';
import { getMesaPayload } from '../services/tableState.js';
import { safeLogAudit } from '../services/audit.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { verifyRole } from '../middleware/auth.js';
import { requirePermission } from '../services/permissions.js';
import { resolveQuickAuthorization } from '../services/quickPin.js';

const router = express.Router();
let customerFieldsReady = false;
let cajaFieldsReady = false;
let paymentFieldsReady = false;
let billingTablesReady = false;

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

async function ensureCustomerFields() {
  if (customerFieldsReady) return;
  await addColumnIfMissing('pedidos', 'cliente_nombre', 'ALTER TABLE pedidos ADD COLUMN cliente_nombre VARCHAR(120) NULL');
  await addColumnIfMissing('pedidos', 'cliente_dato', 'ALTER TABLE pedidos ADD COLUMN cliente_dato VARCHAR(160) NULL');
  await addColumnIfMissing('pedidos', 'delivery_telefono', 'ALTER TABLE pedidos ADD COLUMN delivery_telefono VARCHAR(40) NULL');
  await addColumnIfMissing('pedidos', 'delivery_direccion', 'ALTER TABLE pedidos ADD COLUMN delivery_direccion VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'delivery_referencia', 'ALTER TABLE pedidos ADD COLUMN delivery_referencia VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'cuenta_solicitada_at', 'ALTER TABLE pedidos ADD COLUMN cuenta_solicitada_at DATETIME NULL');
  customerFieldsReady = true;
}

async function ensureCajaFields() {
  if (cajaFieldsReady) return;
  await addColumnIfMissing('caja', 'observacion_apertura', 'ALTER TABLE caja ADD COLUMN observacion_apertura VARCHAR(255) NULL');
  await addColumnIfMissing('caja', 'observacion_cierre', 'ALTER TABLE caja ADD COLUMN observacion_cierre VARCHAR(255) NULL');
  cajaFieldsReady = true;
}

async function ensurePaymentFields() {
  if (paymentFieldsReady) return;
  await pool.query("ALTER TABLE pagos MODIFY metodo ENUM('Efectivo','Tarjeta','Transferencia','QR','Mixto','Vales','Otro') NOT NULL DEFAULT 'Efectivo'");
  await addColumnIfMissing('pagos', 'factura_tipo', "ALTER TABLE pagos ADD COLUMN factura_tipo ENUM('FINAL','DOCUMENTO') NOT NULL DEFAULT 'FINAL'");
  await addColumnIfMissing('pagos', 'factura_cliente', 'ALTER TABLE pagos ADD COLUMN factura_cliente VARCHAR(160) NULL');
  await addColumnIfMissing('pagos', 'factura_documento', 'ALTER TABLE pagos ADD COLUMN factura_documento VARCHAR(20) NULL');
  await addColumnIfMissing('pagos', 'iva_declarado', 'ALTER TABLE pagos ADD COLUMN iva_declarado DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('pagos', 'comprobante_tipo', "ALTER TABLE pagos ADD COLUMN comprobante_tipo ENUM('TICKET','FACTURA') NOT NULL DEFAULT 'TICKET'");
  await addColumnIfMissing('pagos', 'comprobante_numero', 'ALTER TABLE pagos ADD COLUMN comprobante_numero VARCHAR(40) NULL');
  await addColumnIfMissing('pagos', 'cliente_id', 'ALTER TABLE pagos ADD COLUMN cliente_id INT NULL');
  await addColumnIfMissing('pagos', 'subtotal', 'ALTER TABLE pagos ADD COLUMN subtotal DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('pagos', 'estado', "ALTER TABLE pagos ADD COLUMN estado ENUM('ACTIVO','ANULADO','DEVUELTO') NOT NULL DEFAULT 'ACTIVO'");
  await addColumnIfMissing('pagos', 'motivo_anulacion', 'ALTER TABLE pagos ADD COLUMN motivo_anulacion VARCHAR(255) NULL');
  await addColumnIfMissing('pagos', 'anulado_por', 'ALTER TABLE pagos ADD COLUMN anulado_por INT NULL');
  await addColumnIfMissing('pagos', 'anulado_at', 'ALTER TABLE pagos ADD COLUMN anulado_at DATETIME NULL');
  paymentFieldsReady = true;
}

async function ensureBillingTables() {
  if (billingTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes_facturacion (
      id INT AUTO_INCREMENT PRIMARY KEY,
      documento VARCHAR(20) NOT NULL UNIQUE,
      nombre VARCHAR(160) NOT NULL,
      telefono VARCHAR(40) NULL,
      correo VARCHAR(160) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_clientes_facturacion_nombre (nombre)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caja_secuencias (
      tipo ENUM('TICKET','FACTURA') PRIMARY KEY,
      prefijo VARCHAR(12) NOT NULL,
      siguiente INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    INSERT IGNORE INTO caja_secuencias (tipo, prefijo, siguiente)
    VALUES ('TICKET', 'TCK', 1), ('FACTURA', 'FAC', 1)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caja_movimientos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      caja_id INT NOT NULL,
      trabajador_id INT NOT NULL,
      tipo ENUM('INGRESO','RETIRO','GASTO','DEVOLUCION','ANULACION') NOT NULL,
      monto DECIMAL(10,2) NOT NULL DEFAULT 0,
      metodo VARCHAR(30) NOT NULL DEFAULT 'Efectivo',
      motivo VARCHAR(255) NOT NULL,
      pago_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_caja_movimientos_caja (caja_id),
      INDEX idx_caja_movimientos_fecha (created_at)
    )
  `);
  await addColumnIfMissing('caja', 'efectivo_esperado', 'ALTER TABLE caja ADD COLUMN efectivo_esperado DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'diferencia_cierre', 'ALTER TABLE caja ADD COLUMN diferencia_cierre DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_efectivo', 'ALTER TABLE caja ADD COLUMN total_efectivo DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_tarjeta', 'ALTER TABLE caja ADD COLUMN total_tarjeta DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_transferencia', 'ALTER TABLE caja ADD COLUMN total_transferencia DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_qr', 'ALTER TABLE caja ADD COLUMN total_qr DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_ingresos', 'ALTER TABLE caja ADD COLUMN total_ingresos DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_retiros', 'ALTER TABLE caja ADD COLUMN total_retiros DECIMAL(10,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('caja', 'total_gastos', 'ALTER TABLE caja ADD COLUMN total_gastos DECIMAL(10,2) NOT NULL DEFAULT 0');
  billingTablesReady = true;
}

function cleanInvoiceDocument(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 13);
}

function validInvoiceDocument(value) {
  const cleaned = cleanInvoiceDocument(value);
  return cleaned.length === 10 || cleaned.length === 13;
}

function comprobanteNumero(prefijo, value) {
  return `${prefijo}-${String(value || 1).padStart(9, '0')}`;
}

async function peekComprobante(tipo) {
  await ensureBillingTables();
  const [[row]] = await pool.query('SELECT prefijo, siguiente FROM caja_secuencias WHERE tipo = ?', [tipo]);
  return comprobanteNumero(row?.prefijo || tipo, row?.siguiente || 1);
}

async function nextComprobante(conn, tipo) {
  const [[row]] = await conn.query('SELECT prefijo, siguiente FROM caja_secuencias WHERE tipo = ? FOR UPDATE', [tipo]);
  const prefijo = row?.prefijo || tipo;
  const next = Number(row?.siguiente || 1);
  await conn.query('UPDATE caja_secuencias SET siguiente = ? WHERE tipo = ?', [next + 1, tipo]);
  return comprobanteNumero(prefijo, next);
}

async function upsertClienteFacturacion(conn, { documento, nombre, telefono = null, correo = null }) {
  const doc = cleanInvoiceDocument(documento);
  if (!validInvoiceDocument(doc)) return null;
  await conn.query(
    `INSERT INTO clientes_facturacion (documento, nombre, telefono, correo)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nombre = VALUES(nombre),
       telefono = VALUES(telefono),
       correo = VALUES(correo)`,
    [doc, String(nombre || '').trim(), telefono || null, correo || null]
  );
  const [[cliente]] = await conn.query('SELECT id FROM clientes_facturacion WHERE documento = ? LIMIT 1', [doc]);
  return cliente?.id || null;
}

async function cajaTotals(cajaId, db = pool) {
  const [[payments]] = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN metodo = 'Efectivo' THEN monto ELSE 0 END), 0) AS efectivo,
        COALESCE(SUM(CASE WHEN metodo = 'Tarjeta' THEN monto ELSE 0 END), 0) AS tarjeta,
        COALESCE(SUM(CASE WHEN metodo = 'Transferencia' THEN monto ELSE 0 END), 0) AS transferencia,
        COALESCE(SUM(CASE WHEN metodo = 'QR' THEN monto ELSE 0 END), 0) AS qr,
        COALESCE(SUM(monto), 0) AS total,
        COUNT(*) AS pagos
     FROM pagos
     WHERE caja_id = ?
       AND COALESCE(estado, 'ACTIVO') = 'ACTIVO'`,
    [cajaId]
  );
  const [[moves]] = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN tipo = 'INGRESO' THEN monto ELSE 0 END), 0) AS ingresos,
        COALESCE(SUM(CASE WHEN tipo = 'RETIRO' THEN monto ELSE 0 END), 0) AS retiros,
        COALESCE(SUM(CASE WHEN tipo = 'GASTO' THEN monto ELSE 0 END), 0) AS gastos,
        COALESCE(SUM(CASE WHEN tipo = 'DEVOLUCION' THEN monto ELSE 0 END), 0) AS devoluciones,
        COALESCE(SUM(CASE WHEN tipo = 'ANULACION' THEN monto ELSE 0 END), 0) AS anulaciones
     FROM caja_movimientos
     WHERE caja_id = ?`,
    [cajaId]
  );
  return {
    efectivo: Number(payments.efectivo || 0),
    tarjeta: Number(payments.tarjeta || 0),
    transferencia: Number(payments.transferencia || 0),
    qr: Number(payments.qr || 0),
    total: Number(payments.total || 0),
    pagos: Number(payments.pagos || 0),
    ingresos: Number(moves.ingresos || 0),
    retiros: Number(moves.retiros || 0),
    gastos: Number(moves.gastos || 0),
    devoluciones: Number(moves.devoluciones || 0),
    anulaciones: Number(moves.anulaciones || 0),
  };
}

async function getOpenCaja(trabajadorId, db = pool) {
  const [rows] = await db.query(
    `SELECT *
     FROM caja
     WHERE estado = 'Abierta'
     ORDER BY fecha_apertura DESC
     LIMIT 1`,
    []
  );
  return rows[0] || null;
}

async function mesaRealtimePayload(mesaId, extra = {}) {
  if (!mesaId) return { mesa_id: null, ...extra };
  let mesa = null;
  try {
    mesa = await getMesaPayload(mesaId);
  } catch {}
  return { mesa_id: Number(mesaId), ...(mesa ? { mesa } : {}), ...extra };
}

router.get('/resumen', verifyRole('admin', 'caja', 'supervisor'), async (req, res) => {
  try {
    await ensureCustomerFields();
    await ensureCajaFields();
    await ensurePaymentFields();
    await ensureBillingTables();
    const caja = await getOpenCaja(req.user.id);
    const cajaId = caja?.id || 0;
    const [[ventas]] = await pool.query(
      `SELECT COALESCE(SUM(monto), 0) AS total_cobrado,
              COUNT(*) AS pagos_hoy
       FROM pagos
       WHERE DATE(created_at) = CURDATE()
         AND COALESCE(estado, 'ACTIVO') = 'ACTIVO'`
    );
    const [[pendientes]] = await pool.query(
      `SELECT COUNT(*) AS pedidos_por_cobrar,
              COALESCE(SUM(total), 0) AS monto_por_cobrar
       FROM pedidos
       WHERE DATE(created_at) = CURDATE()
         AND estado NOT IN ('PAGADO', 'CANCELADO')
         AND EXISTS (
           SELECT 1
           FROM detalle_pedidos dp
           WHERE dp.pedido_id = pedidos.id
             AND dp.cantidad > 0
         )`
    );
    const [pagos] = await pool.query(
      `SELECT pg.*, p.mesa_id, p.tipo, p.cliente_nombre, p.cliente_dato,
              p.delivery_telefono, p.delivery_direccion, p.delivery_referencia,
              m.numero AS mesa_numero
       FROM pagos pg
       LEFT JOIN pedidos p ON pg.pedido_id = p.id
       LEFT JOIN mesas m ON p.mesa_id = m.id
       WHERE DATE(pg.created_at) = CURDATE()
       ORDER BY pg.created_at DESC
       LIMIT 30`
    );
    const [movimientos] = cajaId
      ? await pool.query(
        `SELECT cm.*, t.nombre AS trabajador_nombre
         FROM caja_movimientos cm
         LEFT JOIN trabajadores t ON t.id = cm.trabajador_id
         WHERE cm.caja_id = ?
         ORDER BY cm.created_at DESC
         LIMIT 30`,
        [cajaId]
      )
      : [[]];
    const [cierres] = await pool.query(
      `SELECT c.*, t.nombre AS trabajador_nombre
       FROM caja c
       LEFT JOIN trabajadores t ON t.id = c.trabajador_id
       WHERE c.estado = 'Cerrada'
       ORDER BY c.fecha_cierre DESC
       LIMIT 20`
    );
    const [clientes] = await pool.query(
      `SELECT id, documento, nombre, telefono, correo
       FROM clientes_facturacion
       ORDER BY updated_at DESC
       LIMIT 80`
    );
    let divisiones = [];
    try {
      const [divisionRows] = await pool.query(
        `SELECT cd.id, cd.pedido_id, cd.nombre, cd.monto, cd.estado, cd.created_at,
                p.mesa_id, p.tipo, p.cliente_nombre, p.cliente_dato,
                p.delivery_telefono, p.delivery_direccion, p.delivery_referencia,
                p.total AS pedido_total, p.estado AS pedido_estado,
                m.numero AS mesa_numero,
                t.nombre AS mesero_nombre
         FROM cuenta_divisiones cd
         JOIN pedidos p ON cd.pedido_id = p.id
         LEFT JOIN mesas m ON p.mesa_id = m.id
         LEFT JOIN trabajadores t ON p.mesero_id = t.id
         WHERE cd.estado = 'PENDIENTE'
           AND p.estado NOT IN ('PAGADO', 'CANCELADO')
           AND EXISTS (
             SELECT 1
             FROM detalle_pedidos dp
             WHERE dp.pedido_id = p.id
               AND dp.cantidad > 0
           )
         ORDER BY cd.created_at DESC, cd.id ASC
         LIMIT 80`
      );
      divisiones = divisionRows;
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }

    res.json({
      caja,
      total_cobrado: Number(ventas.total_cobrado || 0),
      pagos_hoy: Number(ventas.pagos_hoy || 0),
      pedidos_por_cobrar: Number(pendientes.pedidos_por_cobrar || 0),
      monto_por_cobrar: Number(pendientes.monto_por_cobrar || 0),
      pagos,
      divisiones,
      movimientos,
      cierres,
      clientes,
      siguiente_ticket: await peekComprobante('TICKET'),
      siguiente_factura: await peekComprobante('FACTURA'),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/clientes', verifyRole('admin', 'caja', 'supervisor'), async (req, res) => {
  try {
    await ensureBillingTables();
    const q = String(req.query.q || '').trim();
    const params = q ? [`%${q}%`, `%${cleanInvoiceDocument(q)}%`] : [];
    const [rows] = await pool.query(
      `SELECT id, documento, nombre, telefono, correo
       FROM clientes_facturacion
       ${q ? 'WHERE nombre LIKE ? OR documento LIKE ?' : ''}
       ORDER BY updated_at DESC
       LIMIT 80`,
      params
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/abrir', requirePermission('cash_open_close'), async (req, res) => {
  const { monto_inicial = 0, observacion = null } = req.body;

  try {
    await ensureCajaFields();
    const existing = await getOpenCaja(req.user.id);
    if (existing) return res.json(existing);

    const [result] = await pool.query(
      `INSERT INTO caja (trabajador_id, monto_inicial, estado, fecha_apertura, observacion_apertura)
       VALUES (?, ?, 'Abierta', NOW(), ?)`,
      [req.user.id, Number(monto_inicial || 0), observacion ? String(observacion).trim() : null]
    );

    const caja = await getOpenCaja(req.user.id);
    const payload = { ...caja, id: result.insertId };
    await safeLogAudit({
      user: req.user,
      accion: 'caja.abierta',
      entidad: 'caja',
      entidadId: result.insertId,
      descripcion: 'Caja abierta',
      metadata: { monto_inicial: Number(monto_inicial || 0), observacion },
    });
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'opened', caja: payload });
    res.status(201).json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/cobrar', requirePermission('cash_charge'), async (req, res) => {
  const {
    pedido_id,
    metodo = 'Efectivo',
    monto,
    referencia = null,
    factura_tipo = 'FINAL',
    factura_cliente = null,
    factura_documento = null,
    factura_telefono = null,
    factura_correo = null,
    iva_declarado = 0,
  } = req.body;
  if (!pedido_id) return res.status(400).json({ message: 'pedido_id es obligatorio.' });

  const invoiceType = factura_tipo === 'DOCUMENTO' ? 'DOCUMENTO' : 'FINAL';
  const invoiceDocument = cleanInvoiceDocument(factura_documento);
  const invoiceClient = invoiceType === 'DOCUMENTO' ? String(factura_cliente || '').trim() : 'Consumidor Final';
  if (invoiceType === 'DOCUMENTO' && !invoiceClient) {
    return res.status(400).json({ message: 'El cliente es obligatorio para facturar con documento.' });
  }
  if (invoiceType === 'DOCUMENTO' && !validInvoiceDocument(invoiceDocument)) {
    return res.status(400).json({ message: 'La cedula debe tener 10 digitos o el RUC 13 digitos.' });
  }

  let conn;
  try {
    await ensureCajaFields();
    await ensurePaymentFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    let caja = await getOpenCaja(req.user.id, conn);
    if (!caja) {
      await conn.rollback();
      return res.status(403).json({ message: 'Debes abrir caja antes de cobrar.' });
    }

    const [[pedido]] = await conn.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedido_id]);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }
    if (['PAGADO', 'CANCELADO'].includes(pedido.estado)) {
      await conn.rollback();
      return res.status(409).json({ message: `Este pedido ya esta ${pedido.estado}.` });
    }

    const [[existingPayment]] = await conn.query(
      "SELECT id FROM pagos WHERE pedido_id = ? AND COALESCE(estado, 'ACTIVO') = 'ACTIVO' LIMIT 1",
      [pedido_id]
    );
    if (existingPayment) {
      await conn.rollback();
      return res.status(409).json({ message: 'Este pedido ya tiene un pago registrado.' });
    }

    const amount = Number(monto || pedido.total || 0);
    if (amount <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'El monto a cobrar debe ser mayor a cero.' });
    }
    const businessConfig = await getBusinessConfig(conn);
    const taxRate = Math.max(0, Number(businessConfig.iva_porcentaje || 0)) / 100;
    const subtotal = taxRate > 0 ? amount / (1 + taxRate) : amount;
    const comprobanteTipo = invoiceType === 'DOCUMENTO' ? 'FACTURA' : 'TICKET';
    const comprobanteNumero = await nextComprobante(conn, comprobanteTipo);
    const clienteId = invoiceType === 'DOCUMENTO'
      ? await upsertClienteFacturacion(conn, {
        documento: invoiceDocument,
        nombre: invoiceClient,
        telefono: factura_telefono ? String(factura_telefono).trim() : null,
        correo: factura_correo ? String(factura_correo).trim() : null,
      })
      : null;
    await conn.query(
      `INSERT INTO pagos (
         pedido_id, caja_id, monto, metodo, referencia,
         factura_tipo, factura_cliente, factura_documento, iva_declarado,
         comprobante_tipo, comprobante_numero, cliente_id, subtotal
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pedido_id,
        caja.id,
        amount,
        metodo,
        referencia,
        invoiceType,
        invoiceClient,
        invoiceType === 'DOCUMENTO' ? invoiceDocument : null,
        invoiceType === 'DOCUMENTO' ? Number(iva_declarado || 0) : 0,
        comprobanteTipo,
        comprobanteNumero,
        clienteId,
        subtotal,
      ]
    );
    const transition = await transitionPedido(conn, pedido_id, 'PAGADO', { allowShortcut: true });
    await conn.query(
      `UPDATE caja
       SET total_ventas = COALESCE(total_ventas, 0) + ?
       WHERE id = ?`,
      [amount, caja.id]
    );
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'caja.cobro_registrado',
      entidad: 'pedido',
      entidadId: Number(pedido_id),
      descripcion: 'Pedido cobrado y cerrado',
      metadata: {
        monto: amount,
        metodo,
        referencia,
        caja_id: caja.id,
        factura_tipo: invoiceType,
        factura_cliente: invoiceClient,
        factura_documento: invoiceType === 'DOCUMENTO' ? invoiceDocument : null,
        iva_declarado: invoiceType === 'DOCUMENTO' ? Number(iva_declarado || 0) : 0,
        comprobante_tipo: comprobanteTipo,
        comprobante_numero: comprobanteNumero,
      },
    });

    await conn.commit();
    const pedidoActualizado = await getPedidoCompleto(pedido_id);
    emitRealtime(EVENTS.PAYMENT_CREATED, { pedido_id, monto: amount, metodo, pedido: pedidoActualizado });
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido: pedidoActualizado, pedido_id, transition });
    if (transition.table_freed) {
      emitRealtime(EVENTS.TABLE_FREED, await mesaRealtimePayload(transition.mesa_id, {
        pedido_id,
        transition,
      }));
    }
    res.status(201).json({
      message: 'Pedido cobrado.',
      pedido_id,
      monto: amount,
      estado: 'PAGADO',
      comprobante_tipo: comprobanteTipo,
      comprobante_numero: comprobanteNumero,
    });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/movimientos', requirePermission('cash_movements'), async (req, res) => {
  const { tipo, monto, metodo = 'Efectivo', motivo } = req.body;
  const allowed = ['INGRESO', 'RETIRO', 'GASTO'];
  const movementType = String(tipo || '').toUpperCase();
  if (!allowed.includes(movementType)) return res.status(400).json({ message: 'Tipo de movimiento invalido.' });
  if (Number(monto || 0) <= 0) return res.status(400).json({ message: 'El monto debe ser mayor a cero.' });
  if (!String(motivo || '').trim()) return res.status(400).json({ message: 'El motivo es obligatorio.' });

  try {
    await ensureBillingTables();
    const caja = await getOpenCaja(req.user.id);
    if (!caja) return res.status(403).json({ message: 'Debes abrir caja antes de registrar movimientos.' });
    const [result] = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, trabajador_id, tipo, monto, metodo, motivo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [caja.id, req.user.id, movementType, Number(monto), metodo, String(motivo).trim()]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'caja.movimiento_registrado',
      entidad: 'caja_movimiento',
      entidadId: result.insertId,
      descripcion: `Movimiento de caja ${movementType}`,
      metadata: { caja_id: caja.id, monto: Number(monto), metodo, motivo },
    });
    res.status(201).json({ message: 'Movimiento registrado.', id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pagos/:id/anular', verifyRole('admin', 'supervisor', 'caja'), async (req, res) => {
  const { motivo = null } = req.body;
  if (!String(motivo || '').trim()) return res.status(400).json({ message: 'El motivo es obligatorio.' });
  let conn;
  try {
    const authorization = await resolveQuickAuthorization(req, { roles: ['admin', 'supervisor'] });
    await ensurePaymentFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[pago]] = await conn.query('SELECT * FROM pagos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pago) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pago no encontrado.' });
    }
    if (pago.estado !== 'ACTIVO') {
      await conn.rollback();
      return res.status(409).json({ message: 'Este pago ya fue anulado o devuelto.' });
    }
    await conn.query(
      `UPDATE pagos
       SET estado = 'ANULADO',
           motivo_anulacion = ?,
           anulado_por = ?,
           anulado_at = NOW()
       WHERE id = ?`,
      [String(motivo).trim(), authorization.user.id, pago.id]
    );
    await conn.query(
      `INSERT INTO caja_movimientos (caja_id, trabajador_id, tipo, monto, metodo, motivo, pago_id)
       VALUES (?, ?, 'ANULACION', ?, ?, ?, ?)`,
      [pago.caja_id, req.user.id, Number(pago.monto || 0), pago.metodo || 'Efectivo', String(motivo).trim(), pago.id]
    );
    await conn.query(
      `UPDATE caja
       SET total_ventas = GREATEST(COALESCE(total_ventas, 0) - ?, 0)
       WHERE id = ?`,
      [Number(pago.monto || 0), pago.caja_id]
    );
    await conn.query(
      `UPDATE pedidos
       SET estado = 'ENTREGADO', pagado_at = NULL
       WHERE id = ? AND estado = 'PAGADO'`,
      [pago.pedido_id]
    );
    await safeLogAudit({
      conn,
      user: authorization.user,
      accion: 'caja.pago_anulado',
      entidad: 'pago',
      entidadId: Number(pago.id),
      descripcion: 'Pago anulado',
      metadata: {
        motivo,
        monto: Number(pago.monto || 0),
        pedido_id: pago.pedido_id,
        autorizado_via: authorization.via,
        ejecutado_por: req.user?.id,
        ejecutado_por_nombre: req.user?.nombre,
      },
    });
    await conn.commit();
    const pedido = await getPedidoCompleto(pago.pedido_id);
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido, action: 'pago_anulado' });
    res.json({ message: 'Pago anulado.' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/pagos/:id/devolver', verifyRole('admin', 'supervisor', 'caja'), async (req, res) => {
  const { motivo = null } = req.body;
  if (!String(motivo || '').trim()) return res.status(400).json({ message: 'El motivo es obligatorio.' });
  let conn;
  try {
    const authorization = await resolveQuickAuthorization(req, { roles: ['admin', 'supervisor'] });
    await ensurePaymentFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[pago]] = await conn.query('SELECT * FROM pagos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pago) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pago no encontrado.' });
    }
    if (pago.estado !== 'ACTIVO') {
      await conn.rollback();
      return res.status(409).json({ message: 'Este pago ya fue anulado o devuelto.' });
    }
    await conn.query(
      `UPDATE pagos
       SET estado = 'DEVUELTO',
           motivo_anulacion = ?,
           anulado_por = ?,
           anulado_at = NOW()
       WHERE id = ?`,
      [String(motivo).trim(), authorization.user.id, pago.id]
    );
    await conn.query(
      `INSERT INTO caja_movimientos (caja_id, trabajador_id, tipo, monto, metodo, motivo, pago_id)
       VALUES (?, ?, 'DEVOLUCION', ?, ?, ?, ?)`,
      [pago.caja_id, req.user.id, Number(pago.monto || 0), pago.metodo || 'Efectivo', String(motivo).trim(), pago.id]
    );
    await conn.query(
      `UPDATE caja
       SET total_ventas = GREATEST(COALESCE(total_ventas, 0) - ?, 0)
       WHERE id = ?`,
      [Number(pago.monto || 0), pago.caja_id]
    );
    await safeLogAudit({
      conn,
      user: authorization.user,
      accion: 'caja.pago_devuelto',
      entidad: 'pago',
      entidadId: Number(pago.id),
      descripcion: 'Pago devuelto',
      metadata: {
        motivo,
        monto: Number(pago.monto || 0),
        pedido_id: pago.pedido_id,
        autorizado_via: authorization.via,
        ejecutado_por: req.user?.id,
        ejecutado_por_nombre: req.user?.nombre,
      },
    });
    await conn.commit();
    res.json({ message: 'Pago devuelto.' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.get('/cierres', verifyRole('admin', 'caja', 'supervisor'), async (req, res) => {
  try {
    await ensureBillingTables();
    const [rows] = await pool.query(
      `SELECT c.*, t.nombre AS trabajador_nombre
       FROM caja c
       LEFT JOIN trabajadores t ON t.id = c.trabajador_id
       WHERE c.estado = 'Cerrada'
       ORDER BY c.fecha_cierre DESC
       LIMIT 80`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/cierres/:id', requirePermission('cash_edit_closure'), async (req, res) => {
  const { monto_final, observacion = null } = req.body;
  try {
    await ensureBillingTables();
    const [[cierre]] = await pool.query("SELECT * FROM caja WHERE id = ? AND estado = 'Cerrada'", [req.params.id]);
    if (!cierre) return res.status(404).json({ message: 'Cierre no encontrado.' });
    const finalCash = Number(monto_final ?? cierre.monto_final ?? 0);
    const diff = finalCash - Number(cierre.efectivo_esperado || 0);
    await pool.query(
      `UPDATE caja
       SET monto_final = ?,
           diferencia_cierre = ?,
           observacion_cierre = ?
       WHERE id = ?`,
      [finalCash, diff, observacion ? String(observacion).trim() : null, req.params.id]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'caja.cierre_editado',
      entidad: 'caja',
      entidadId: Number(req.params.id),
      descripcion: 'Cierre de caja editado por admin',
      metadata: { monto_final: finalCash, observacion },
    });
    res.json({ message: 'Cierre actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/cierres/:id/reabrir', requirePermission('cash_reopen_closure'), async (req, res) => {
  try {
    await ensureCajaFields();
    await ensureBillingTables();
    const [[cierre]] = await pool.query("SELECT * FROM caja WHERE id = ? AND estado = 'Cerrada'", [req.params.id]);
    if (!cierre) return res.status(404).json({ message: 'Cierre no encontrado.' });
    const existing = await getOpenCaja(cierre.trabajador_id);
    if (existing) return res.status(409).json({ message: 'Ya hay una caja abierta. Cierra la caja actual antes de reabrir un cierre.' });
    await pool.query(
      `UPDATE caja
       SET estado = 'Abierta',
           fecha_cierre = NULL,
           observacion_cierre = NULL
       WHERE id = ?`,
      [req.params.id]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'caja.cierre_reabierto',
      entidad: 'caja',
      entidadId: Number(req.params.id),
      descripcion: 'Caja reabierta por admin',
    });
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'reopened', caja_id: Number(req.params.id) });
    res.json({ message: 'Caja reabierta.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/cerrar', requirePermission('cash_open_close'), async (req, res) => {
  const { monto_final, observacion = null } = req.body;
  try {
    await ensureCajaFields();
    await ensurePaymentFields();
    await ensureBillingTables();
    const caja = await getOpenCaja(req.user.id);
    if (!caja) return res.status(404).json({ message: 'No hay caja abierta.' });
    const totals = await cajaTotals(caja.id);
    const expectedCash = Number(caja.monto_inicial || 0) + totals.efectivo + totals.ingresos - totals.retiros - totals.gastos - totals.devoluciones;
    const finalCash = Number(monto_final ?? expectedCash);
    const diff = finalCash - expectedCash;

    await pool.query(
      `UPDATE caja
       SET estado = 'Cerrada',
           monto_final = ?,
           fecha_cierre = NOW(),
           observacion_cierre = ?,
           efectivo_esperado = ?,
           diferencia_cierre = ?,
           total_efectivo = ?,
           total_tarjeta = ?,
           total_transferencia = ?,
           total_qr = ?,
           total_ingresos = ?,
           total_retiros = ?,
           total_gastos = ?
       WHERE id = ?`,
      [
        finalCash,
        observacion ? String(observacion).trim() : null,
        expectedCash,
        diff,
        totals.efectivo,
        totals.tarjeta,
        totals.transferencia,
        totals.qr,
        totals.ingresos,
        totals.retiros,
        totals.gastos,
        caja.id,
      ]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'caja.cerrada',
      entidad: 'caja',
      entidadId: Number(caja.id),
      descripcion: 'Caja cerrada',
      metadata: {
        monto_inicial: Number(caja.monto_inicial || 0),
        monto_final: finalCash,
        efectivo_esperado: expectedCash,
        diferencia: diff,
        observacion,
        totales: totals,
      },
    });
    emitRealtime(EVENTS.CASH_UPDATED, {
      action: 'closed',
      caja_id: caja.id,
      monto_final: finalCash,
      efectivo_esperado: expectedCash,
      diferencia_cierre: diff,
    });
    res.json({ message: 'Caja cerrada.', resumen: { ...totals, efectivo_esperado: expectedCash, monto_final: finalCash, diferencia: diff } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
