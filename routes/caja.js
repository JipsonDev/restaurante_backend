import paymentHistory from './paymentHistory.js';
import { paymentPlan, paymentError, cents, parseSnapshot, allocatePayment } from '../services/paymentLedger.js';
import { cashAmount, validateMethod, expectedCash, receiptTotals } from '../services/cashLogic.js';
import express from 'express';
import { beginAccountTransaction, emitMergedAccounts, consolidateAccount } from '../services/accounts.js';
import { refreshAccountState } from '../services/rounds.js';
import { pool } from '../db.js';
import { getPedidoCompleto, transitionPedido } from './pedidos.js';
import { emitRealtime, EVENTS } from '../realtime.js';
import { getMesaPayload } from '../services/tableState.js';
import { ensureAuditTable, safeLogAudit } from '../services/audit.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { verifyRole } from '../middleware/auth.js';
import { requirePermission } from '../services/permissions.js';
import { resolveQuickAuthorization } from '../services/quickPin.js';

const router = express.Router();
router.use('/pagos', paymentHistory);
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
  await addColumnIfMissing('pagos', 'trabajador_id', 'ALTER TABLE pagos ADD COLUMN trabajador_id INT NULL');
  await addColumnIfMissing('pagos', 'division_id', 'ALTER TABLE pagos ADD COLUMN division_id INT NULL');
  await addColumnIfMissing('pagos', 'idempotency_key', 'ALTER TABLE pagos ADD COLUMN idempotency_key VARCHAR(80) NULL, ADD UNIQUE INDEX uq_pago_request (idempotency_key)');
  await addColumnIfMissing('pagos', 'request_fingerprint', 'ALTER TABLE pagos ADD COLUMN request_fingerprint LONGTEXT NULL');
  await addColumnIfMissing('pagos', 'comprobante_snapshot', 'ALTER TABLE pagos ADD COLUMN comprobante_snapshot LONGTEXT NULL');
  await addColumnIfMissing('pagos', 'impresion_estado', "ALTER TABLE pagos ADD COLUMN impresion_estado VARCHAR(16) NOT NULL DEFAULT 'PENDIENTE'");
  await addColumnIfMissing('pagos', 'impresion_intentos', 'ALTER TABLE pagos ADD COLUMN impresion_intentos INT NOT NULL DEFAULT 0');
  await addColumnIfMissing('pagos', 'impresion_error', 'ALTER TABLE pagos ADD COLUMN impresion_error VARCHAR(255) NULL');
  await addColumnIfMissing('pagos', 'impresion_at', 'ALTER TABLE pagos ADD COLUMN impresion_at DATETIME NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS pago_desglose (
    id INT AUTO_INCREMENT PRIMARY KEY, pago_id INT NOT NULL, metodo VARCHAR(30) NOT NULL,
    monto DECIMAL(10,2) NOT NULL, referencia VARCHAR(255) NULL,
    INDEX idx_pago_desglose_pago (pago_id)
  ) ENGINE=InnoDB`);
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
  await pool.query('CREATE TABLE IF NOT EXISTS caja_control (id INT PRIMARY KEY) ENGINE=InnoDB');
  await pool.query('INSERT IGNORE INTO caja_control (id) VALUES (1)');
  billingTablesReady = true;
}

export async function initializeCashSchema() {
  await ensureAuditTable();
  await ensureCustomerFields();
  await ensureCajaFields();
  await ensurePaymentFields();
  await ensureBillingTables();
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

export async function cajaTotals(cajaId, db = pool) {
  const [[payments]] = await db.query(
    `SELECT
        COALESCE(SUM(CASE WHEN metodo = 'Efectivo' THEN monto ELSE 0 END), 0) AS efectivo,
        COALESCE(SUM(CASE WHEN metodo = 'Tarjeta' THEN monto ELSE 0 END), 0) AS tarjeta,
        COALESCE(SUM(CASE WHEN metodo = 'Transferencia' THEN monto ELSE 0 END), 0) AS transferencia,
        COALESCE(SUM(CASE WHEN metodo = 'QR' THEN monto ELSE 0 END), 0) AS qr,
        COALESCE(SUM(CASE WHEN metodo = 'Vales' THEN monto ELSE 0 END), 0) AS vales,
        COALESCE(SUM(CASE WHEN metodo = 'Otro' THEN monto ELSE 0 END), 0) AS otro,
        COALESCE(SUM(monto), 0) AS total,
        COUNT(DISTINCT pago_id) AS pagos
     FROM (
       SELECT pg.id AS pago_id, pg.caja_id, pg.estado, COALESCE(pd.metodo, pg.metodo) AS metodo,
         COALESCE(pd.monto, pg.monto) AS monto
       FROM pagos pg LEFT JOIN pago_desglose pd ON pd.pago_id = pg.id
     ) payment_parts
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
        COALESCE(SUM(CASE WHEN tipo = 'ANULACION' THEN monto ELSE 0 END), 0) AS anulaciones,
        COALESCE(SUM(CASE WHEN tipo = 'INGRESO' AND metodo = 'Efectivo' THEN monto ELSE 0 END), 0) AS ingresos_efectivo,
        COALESCE(SUM(CASE WHEN tipo = 'RETIRO' AND metodo = 'Efectivo' THEN monto ELSE 0 END), 0) AS retiros_efectivo,
        COALESCE(SUM(CASE WHEN tipo = 'GASTO' AND metodo = 'Efectivo' THEN monto ELSE 0 END), 0) AS gastos_efectivo
     FROM caja_movimientos
     WHERE caja_id = ?`,
    [cajaId]
  );
  return {
    efectivo: Number(payments.efectivo || 0),
    vales: Number(payments.vales || 0),
    otro: Number(payments.otro || 0),
    ingresos_efectivo: Number(moves.ingresos_efectivo || 0),
    retiros_efectivo: Number(moves.retiros_efectivo || 0),
    gastos_efectivo: Number(moves.gastos_efectivo || 0),
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

// One shared register is the existing business rule. This row serializes its mutations,
// including opening while no caja row exists yet, across processes and devices.
export async function lockCashRegister(conn, expectedId = null) {
  await conn.query('SELECT id FROM caja_control WHERE id = 1 FOR UPDATE');
  const caja = await getOpenCaja(null, conn);
  if (expectedId != null && (!caja || Number(caja.id) !== Number(expectedId))) {
    const error = new Error('La caja cambio o ya se cerro. Actualiza antes de continuar.');
    error.statusCode = 409;
    throw error;
  }
  return caja;
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
    const totals = caja ? await cajaTotals(cajaId) : null;
    const [[ventas]] = await pool.query(
      `SELECT COALESCE(SUM(monto), 0) AS total_cobrado,
              COUNT(*) AS pagos_hoy
       FROM pagos
       WHERE DATE(created_at) = CURDATE()
         AND COALESCE(estado, 'ACTIVO') = 'ACTIVO'`
    );
    const [[pendientes]] = await pool.query(
      `SELECT COUNT(*) AS pedidos_por_cobrar,
              COALESCE(SUM(GREATEST(total - (SELECT COALESCE(SUM(pg.monto),0) FROM pagos pg WHERE pg.pedido_id = pedidos.id AND COALESCE(pg.estado,'ACTIVO') = 'ACTIVO'),0)), 0) AS monto_por_cobrar
       FROM pedidos
       WHERE estado NOT IN ('PAGADO', 'CANCELADO')
         AND EXISTS (
           SELECT 1
           FROM detalle_pedidos dp
           WHERE dp.pedido_id = pedidos.id
             AND dp.cantidad > 0
         )`
    );
    const [pagos] = await pool.query(
      `SELECT pg.id, pg.pedido_id, pg.caja_id, pg.monto, pg.metodo, pg.referencia, pg.factura_cliente, pg.comprobante_numero, pg.estado, pg.created_at, p.mesa_id, p.tipo, p.cliente_nombre, p.cliente_dato,
              p.delivery_telefono, p.delivery_direccion, p.delivery_referencia,
              m.numero AS mesa_numero
       FROM pagos pg
       LEFT JOIN pedidos p ON pg.pedido_id = p.id
       LEFT JOIN mesas m ON p.mesa_id = m.id
       WHERE ${cajaId ? 'pg.caja_id = ?' : 'DATE(pg.created_at) = CURDATE()'}
       ORDER BY pg.created_at DESC
       LIMIT 30`, cajaId ? [cajaId] : []
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
         `
      );
      divisiones = divisionRows;
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }

    res.json({
      caja,
      totales_turno: totals,
      efectivo_esperado: caja ? expectedCash(caja.monto_inicial, totals) : null,
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
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
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
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  }
});

router.post('/abrir', requirePermission('cash_open_close'), async (req, res) => {
  const { monto_inicial = 0, observacion = null } = req.body;
  let conn;
  try {
    const initial = cashAmount(monto_inicial);
    await ensureCajaFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    const existing = await lockCashRegister(conn);
    if (existing) { await conn.commit(); return res.json(existing); }

    const [result] = await conn.query(
      `INSERT INTO caja (trabajador_id, monto_inicial, estado, fecha_apertura, observacion_apertura)
       VALUES (?, ?, 'Abierta', NOW(), ?)`,
      [req.user.id, initial, observacion ? String(observacion).trim() : null]
    );

    const caja = await getOpenCaja(req.user.id, conn);
    const payload = { ...caja, id: result.insertId };
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'caja.abierta',
      entidad: 'caja',
      entidadId: result.insertId,
      descripcion: 'Caja abierta',
      metadata: { monto_inicial: initial, observacion },
    });
    await conn.commit();
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'opened', caja: payload });
    res.status(201).json(payload);
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn?.release(); }
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
    paymentPlan(req.body, monto, 0); // Validate the requested breakdown before acquiring locks.
    const requestKey = req.body.idempotency_key || null;
    if (requestKey && !/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) throw paymentError('Identificador de cobro invalido.');
    if ((req.body.parcial || metodo === 'Mixto' || req.body.division_id) && !requestKey) throw paymentError('Este cobro necesita un identificador para evitar duplicados.');
    const fingerprint = JSON.stringify({ pedido_id: Number(pedido_id), metodo, monto: cashAmount(monto), caja_id: Number(req.body.caja_id || 0),
      parcial: !!req.body.parcial, division_id: Number(req.body.division_id || 0), desglose: req.body.desglose || null,
      recibido: req.body.efectivo_recibido ?? null, referencia, invoiceType, invoiceClient, invoiceDocument, factura_telefono, factura_correo });
    await ensureCajaFields();
    await ensurePaymentFields();
    await ensureBillingTables();
    const businessConfig = await getBusinessConfig();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);

    const caja = await lockCashRegister(conn);
    if (requestKey) {
      const [[existing]] = await conn.query('SELECT * FROM pagos WHERE idempotency_key = ? FOR UPDATE', [requestKey]);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) throw paymentError('Este identificador ya se uso con otro cobro.', 409);
        const snapshot = parseSnapshot(existing.comprobante_snapshot);
        const current = await getPedidoCompleto(existing.pedido_id, conn);
        await conn.commit();
        return res.json({ message: 'Cobro ya registrado.', replayed: true, pago_id: existing.id, pago: { id: existing.id, estado: existing.estado, motivo_anulacion: existing.motivo_anulacion }, pedido: current,
          monto: Number(existing.monto), comprobante_numero: existing.comprobante_numero, snapshot });
      }
    }
    if (req.body.caja_id && Number(caja?.id) !== Number(req.body.caja_id)) throw paymentError('La caja cambio. Actualiza antes de cobrar.', 409);
    if (!caja) {
      await conn.rollback();
      return res.status(403).json({ message: 'Debes abrir caja antes de cobrar.' });
    }

    const account = await consolidateAccount(conn, Number(pedido_id));
    const [[pedido]] = await conn.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedido_id]);
    if (!pedido) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pedido no encontrado.' });
    }
    if (['PAGADO', 'CANCELADO'].includes(pedido.estado)) {
      await conn.rollback();
      return res.status(409).json({ message: `Este pedido ya esta ${pedido.estado}.` });
    }

    const [[balance]] = await conn.query("SELECT COALESCE(SUM(monto),0) AS abonado, COALESCE(SUM(JSON_EXTRACT(comprobante_snapshot, '$.asignacion.subtotal')),0) AS subtotal, COALESCE(SUM(JSON_EXTRACT(comprobante_snapshot, '$.asignacion.tax')),0) AS tax, COALESCE(SUM(JSON_EXTRACT(comprobante_snapshot, '$.asignacion.service')),0) AS service FROM pagos WHERE pedido_id = ? AND COALESCE(estado, 'ACTIVO') = 'ACTIVO'", [pedido_id]);
    const plan = paymentPlan(req.body, pedido.total, balance.abonado);
    const amount = plan.amount;
    let division = null;
    if (req.body.division_id) {
      const [[part]] = await conn.query('SELECT * FROM cuenta_divisiones WHERE id = ? AND pedido_id = ? FOR UPDATE', [req.body.division_id, pedido_id]);
      if (!part || part.estado !== 'PENDIENTE' || cents(part.monto) !== cents(amount)) throw paymentError('La parte elegida ya se cobro o su monto cambio.', 409);
      division = part;
    }
    const orderSnapshot = await getPedidoCompleto(pedido_id, conn);
    const receipt = receiptTotals(orderSnapshot, businessConfig.iva_porcentaje);
    const allocation = allocatePayment(receipt, amount, balance);
    const subtotal = allocation.subtotal;
    const paymentTax = allocation.tax;
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
    const [savedPayment] = await conn.query(
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
        invoiceType === 'DOCUMENTO' ? paymentTax : 0,
        comprobanteTipo,
        comprobanteNumero,
        clienteId,
        subtotal,
      ]
    );
    const paymentId = savedPayment.insertId;
    for (const part of plan.parts) await conn.query('INSERT INTO pago_desglose (pago_id, metodo, monto, referencia) VALUES (?, ?, ?, ?)', [paymentId, part.metodo, part.monto, part.referencia]);
    const snapshot = { version: 1, pedido: orderSnapshot, totales: receipt, negocio: businessConfig,
      created_at: new Date().toISOString(), monto: amount, asignacion: allocation, abonado_anterior: plan.paidBefore, saldo_pendiente: plan.remaining,
      efectivo_recibido: plan.received, cambio: plan.change, desglose: plan.parts, metodo,
      division: division ? { id: division.id, nombre: division.nombre } : null,
      comprobante_numero: comprobanteNumero, comprobante_tipo: comprobanteTipo,
      cliente: { nombre: invoiceClient, documento: invoiceType === 'DOCUMENTO' ? invoiceDocument : null, telefono: factura_telefono, correo: factura_correo },
      cajero: { id: req.user.id, nombre: req.user.nombre } };
    await conn.query(`UPDATE pagos SET trabajador_id = ?, division_id = ?, idempotency_key = ?, request_fingerprint = ?, comprobante_snapshot = ? WHERE id = ?`,
      [req.user.id, division?.id || null, requestKey, fingerprint, JSON.stringify(snapshot), paymentId]);
    const transition = plan.complete ? await transitionPedido(conn, pedido_id, 'PAGADO', { allowShortcut: true }) : { mesa_id: pedido.mesa_id, table_freed: false };
    if (transition.mesa_id && !transition.table_freed) await conn.query("UPDATE mesas SET estado = 'Ocupada' WHERE id = ?", [transition.mesa_id]);
    if (plan.complete) await conn.query("UPDATE cuenta_divisiones SET estado = 'PAGADO' WHERE pedido_id = ?", [pedido_id]);
    else if (division) await conn.query("UPDATE cuenta_divisiones SET estado = 'PAGADO' WHERE id = ?", [division.id]);
    else await conn.query("DELETE FROM cuenta_divisiones WHERE pedido_id = ? AND estado = 'PENDIENTE'", [pedido_id]);
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
      descripcion: plan.complete ? 'Cuenta liquidada' : 'Abono registrado',
      metadata: {
        monto: amount,
        metodo,
        referencia,
        caja_id: caja.id,
        factura_tipo: invoiceType,
        factura_cliente: invoiceClient,
        factura_documento: invoiceType === 'DOCUMENTO' ? invoiceDocument : null,
        iva_declarado: invoiceType === 'DOCUMENTO' ? paymentTax : 0,
        comprobante_tipo: comprobanteTipo,
        comprobante_numero: comprobanteNumero,
      },
    });

    const pedidoActualizado = { ...await getPedidoCompleto(pedido_id, conn), totales_cobro: receipt };
    await conn.commit();
    emitMergedAccounts(account.orders, Number(pedido_id));
    emitRealtime(EVENTS.PAYMENT_CREATED, { pedido_id, monto: amount, metodo, pedido: pedidoActualizado });
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido: pedidoActualizado, pedido_id, transition });
    if (transition.table_freed) {
      emitRealtime(EVENTS.TABLE_FREED, await mesaRealtimePayload(transition.mesa_id, {
        pedido_id,
        transition,
      }));
    }
    res.status(201).json({
      message: plan.complete ? 'Cuenta liquidada.' : 'Abono registrado.',
      pago_id: paymentId, snapshot,
      pedido: pedidoActualizado,
      pedido_id,
      monto: amount,
      estado: plan.complete ? 'PAGADO' : 'PARCIAL',
      comprobante_tipo: comprobanteTipo,
      comprobante_numero: comprobanteNumero,
    });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  } finally {
    if (conn) conn.release();
  }
});

router.post('/movimientos', requirePermission('cash_movements'), async (req, res) => {
  const { tipo, monto, metodo = 'Efectivo', motivo } = req.body;
  const allowed = ['INGRESO', 'RETIRO', 'GASTO'];
  const movementType = String(tipo || '').toUpperCase();
  if (!allowed.includes(movementType)) return res.status(400).json({ message: 'Tipo de movimiento invalido.' });
  if (!String(motivo || '').trim()) return res.status(400).json({ message: 'El motivo es obligatorio.' });

  let conn;
  try {
    const amount = cashAmount(monto, { positive: true });
    validateMethod(metodo);
    await ensureBillingTables();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    const caja = await lockCashRegister(conn, req.body.caja_id);
    if (!caja) { await conn.rollback(); return res.status(403).json({ message: 'Debes abrir caja antes de registrar movimientos.' }); }
    const [result] = await conn.query(
      `INSERT INTO caja_movimientos (caja_id, trabajador_id, tipo, monto, metodo, motivo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [caja.id, req.user.id, movementType, amount, metodo, String(motivo).trim()]
    );
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'caja.movimiento_registrado',
      entidad: 'caja_movimiento',
      entidadId: result.insertId,
      descripcion: `Movimiento de caja ${movementType}`,
      metadata: { caja_id: caja.id, monto: amount, metodo, motivo },
    });
    await conn.commit();
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'movement', caja_id: caja.id });
    res.status(201).json({ message: 'Movimiento registrado.', id: result.insertId });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn?.release(); }
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
    await beginAccountTransaction(conn);
    const caja = await lockCashRegister(conn);
    const [[pago]] = await conn.query('SELECT * FROM pagos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pago) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pago no encontrado.' });
    }
    if (!caja || Number(caja.id) !== Number(pago.caja_id)) {
      const error = new Error('El pago pertenece a una caja cerrada. Reabre ese cierre antes de modificarlo.');
      error.statusCode = 409; throw error;
    }
    if ((pago.estado || 'ACTIVO') !== 'ACTIVO') {
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
    await refreshAccountState(conn, pago.pedido_id);
    if (pago.division_id) await conn.query("UPDATE cuenta_divisiones SET estado = 'PENDIENTE' WHERE id = ?", [pago.division_id]);
    else await conn.query('DELETE FROM cuenta_divisiones WHERE pedido_id = ?', [pago.pedido_id]);
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
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'payment_voided', caja_id: pago.caja_id });
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
    await beginAccountTransaction(conn);
    const caja = await lockCashRegister(conn);
    const [[pago]] = await conn.query('SELECT * FROM pagos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!pago) {
      await conn.rollback();
      return res.status(404).json({ message: 'Pago no encontrado.' });
    }
    if (!caja || Number(caja.id) !== Number(pago.caja_id)) {
      const error = new Error('El pago pertenece a una caja cerrada. Reabre ese cierre antes de modificarlo.');
      error.statusCode = 409; throw error;
    }
    if ((pago.estado || 'ACTIVO') !== 'ACTIVO') {
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
    if (pago.division_id) await conn.query("UPDATE cuenta_divisiones cd JOIN pedidos p ON p.id = cd.pedido_id SET cd.estado = 'PENDIENTE' WHERE cd.id = ? AND p.estado NOT IN ('PAGADO','CANCELADO')", [pago.division_id]);
    const pedidoActualizado = await getPedidoCompleto(pago.pedido_id, conn);
    await conn.commit();
    emitRealtime(EVENTS.ORDER_UPDATED, { pedido: pedidoActualizado, action: 'abono_devuelto' });
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'payment_refunded', caja_id: pago.caja_id });
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
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  }
});

router.put('/cierres/:id', requirePermission('cash_edit_closure'), async (req, res) => {
  const { monto_final, observacion = null } = req.body;
  let conn;
  try {
    await ensureBillingTables();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    await lockCashRegister(conn);
    const [[cierre]] = await conn.query("SELECT * FROM caja WHERE id = ? AND estado = 'Cerrada'", [req.params.id]);
    if (!cierre) { await conn.rollback(); return res.status(404).json({ message: 'Cierre no encontrado.' }); }
    const finalCash = cashAmount(monto_final ?? cierre.monto_final ?? 0);
    const diff = Number((finalCash - Number(cierre.efectivo_esperado || 0)).toFixed(2));
    await conn.query(
      `UPDATE caja
       SET monto_final = ?,
           diferencia_cierre = ?,
           observacion_cierre = ?
       WHERE id = ?`,
      [finalCash, diff, observacion ? String(observacion).trim() : null, req.params.id]
    );
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'caja.cierre_editado',
      entidad: 'caja',
      entidadId: Number(req.params.id),
      descripcion: 'Cierre de caja editado por admin',
      metadata: { monto_final: finalCash, observacion },
    });
    await conn.commit();
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'closure_edited' });
    res.json({ message: 'Cierre actualizado.' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ error: error.message, message: error.message });
  } finally { conn?.release(); }
});

router.post('/cierres/:id/reabrir', requirePermission('cash_reopen_closure'), async (req, res) => {
  let conn;
  try {
    await ensureCajaFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    const currentCaja = await lockCashRegister(conn, req.body.caja_id);
    const [[cierre]] = await conn.query("SELECT * FROM caja WHERE id = ? AND estado = 'Cerrada'", [req.params.id]);
    if (!cierre) { await conn.rollback(); return res.status(404).json({ message: 'Cierre no encontrado.' }); }
    const existing = currentCaja;
    if (existing) { await conn.rollback(); return res.status(409).json({ message: 'Ya hay una caja abierta. Cierra la caja actual antes de reabrir un cierre.' }); }
    await conn.query(
      `UPDATE caja
       SET estado = 'Abierta',
           fecha_cierre = NULL,
           observacion_cierre = NULL
       WHERE id = ?`,
      [req.params.id]
    );
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'caja.cierre_reabierto',
      entidad: 'caja',
      entidadId: Number(req.params.id),
      descripcion: 'Caja reabierta por admin',
    });
    await conn.commit();
    emitRealtime(EVENTS.CASH_UPDATED, { action: 'reopened', caja_id: Number(req.params.id) });
    res.json({ message: 'Caja reabierta.' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn?.release(); }
});

router.post('/cerrar', requirePermission('cash_open_close'), async (req, res) => {
  const { monto_final, observacion = null } = req.body;
  if (!Number.isSafeInteger(Number(req.body.caja_id)) || Number(req.body.caja_id) <= 0) return res.status(400).json({ message: 'Identifica la caja que deseas cerrar.' });
  let conn;
  try {
    await ensureCajaFields();
    await ensurePaymentFields();
    await ensureBillingTables();
    conn = await pool.getConnection();
    await beginAccountTransaction(conn);
    const currentCaja = await lockCashRegister(conn, req.body.caja_id);
    const caja = currentCaja;
    if (!caja) { await conn.rollback(); return res.status(404).json({ message: 'No hay caja abierta.' }); }
    const totals = await cajaTotals(caja.id, conn);
    const expected = expectedCash(caja.monto_inicial, totals);
    const finalCash = cashAmount(monto_final);
    const diff = Number((finalCash - expected).toFixed(2));

    await conn.query(
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
        expected,
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
      conn,
      user: req.user,
      accion: 'caja.cerrada',
      entidad: 'caja',
      entidadId: Number(caja.id),
      descripcion: 'Caja cerrada',
      metadata: {
        monto_inicial: Number(caja.monto_inicial || 0),
        monto_final: finalCash,
        efectivo_esperado: expected,
        diferencia: diff,
        observacion,
        totales: totals,
      },
    });
    await conn.commit();
    emitRealtime(EVENTS.CASH_UPDATED, {
      action: 'closed',
      caja_id: caja.id,
      monto_final: finalCash,
      efectivo_esperado: expected,
      diferencia_cierre: diff,
    });
    res.json({ message: 'Caja cerrada.', resumen: { ...totals, efectivo_esperado: expected, monto_final: finalCash, diferencia: diff } });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn?.release(); }
});

export default router;
