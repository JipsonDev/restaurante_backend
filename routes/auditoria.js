import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { ensureAuditTable } from '../services/audit.js';

const router = express.Router();

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function passFilters(row, { entidad, entidadId, accion, desde, hasta }) {
  if (entidad && row.entidad !== entidad) return false;
  if (entidadId && Number(row.entidad_id) !== Number(entidadId)) return false;
  if (accion && row.accion !== accion) return false;
  const time = row.created_at ? new Date(row.created_at).getTime() : 0;
  if (desde && time < new Date(desde).getTime()) return false;
  if (hasta && time > new Date(hasta).getTime()) return false;
  return true;
}

async function queryOrEmpty(sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch {
    return [];
  }
}

async function derivedAuditRows(filters) {
  const [openRows, closeRows, paymentRows, movementRows, saleRows] = await Promise.all([
    queryOrEmpty(
      `SELECT c.id, c.trabajador_id, c.monto_inicial, c.observacion_apertura, c.fecha_apertura,
              t.nombre AS trabajador_nombre, t.rol
       FROM caja c
       LEFT JOIN trabajadores t ON t.id = c.trabajador_id
       WHERE c.fecha_apertura IS NOT NULL
       ORDER BY c.fecha_apertura DESC
       LIMIT 120`
    ),
    queryOrEmpty(
      `SELECT c.id, c.trabajador_id, c.monto_inicial, c.monto_final, c.efectivo_esperado,
              c.diferencia_cierre, c.observacion_cierre, c.fecha_cierre,
              t.nombre AS trabajador_nombre, t.rol
       FROM caja c
       LEFT JOIN trabajadores t ON t.id = c.trabajador_id
       WHERE c.fecha_cierre IS NOT NULL
       ORDER BY c.fecha_cierre DESC
       LIMIT 120`
    ),
    queryOrEmpty(
      `SELECT p.id, p.pedido_id, p.caja_id, p.monto, p.metodo, p.estado, p.motivo_anulacion,
              p.anulado_por, p.anulado_at, t.nombre AS trabajador_nombre, t.rol
       FROM pagos p
       LEFT JOIN trabajadores t ON t.id = p.anulado_por
       WHERE p.estado IN ('ANULADO','DEVUELTO') AND p.anulado_at IS NOT NULL
       ORDER BY p.anulado_at DESC
       LIMIT 120`
    ),
    queryOrEmpty(
      `SELECT cm.id, cm.caja_id, cm.trabajador_id, cm.tipo, cm.monto, cm.metodo, cm.motivo,
              cm.pago_id, cm.created_at, t.nombre AS trabajador_nombre, t.rol
       FROM caja_movimientos cm
       LEFT JOIN trabajadores t ON t.id = cm.trabajador_id
       WHERE cm.tipo IN ('INGRESO','RETIRO','GASTO')
       ORDER BY cm.created_at DESC
       LIMIT 120`
    ),
    queryOrEmpty(
      `SELECT pg.id, pg.pedido_id, pg.caja_id, pg.monto, pg.metodo, pg.estado,
              pg.factura_cliente, pg.factura_documento, pg.comprobante_numero, pg.created_at,
              COALESCE(pg.trabajador_id, c.trabajador_id) AS trabajador_id,
              cajero.nombre AS trabajador_nombre, cajero.rol,
              p.cliente_nombre, p.cliente_dato, p.tipo, p.mesa_id, m.numero AS mesa_numero,
              p.mesero_id, mesero.nombre AS mesero_nombre
       FROM pagos pg
       LEFT JOIN caja c ON c.id = pg.caja_id
       LEFT JOIN trabajadores cajero ON cajero.id = COALESCE(pg.trabajador_id, c.trabajador_id)
       LEFT JOIN pedidos p ON p.id = pg.pedido_id
       LEFT JOIN mesas m ON m.id = p.mesa_id
       LEFT JOIN trabajadores mesero ON mesero.id = p.mesero_id
       WHERE COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO'
       ORDER BY pg.created_at DESC
       LIMIT 160`
    ),
  ]);

  const rows = [
    ...openRows.map((row) => ({
      id: `hist-caja-open-${row.id}`,
      trabajador_id: row.trabajador_id,
      rol: row.rol,
      accion: 'caja.abierta',
      entidad: 'caja',
      entidad_id: row.id,
      descripcion: 'Caja abierta',
      metadata: {
        monto_inicial: Number(row.monto_inicial || 0),
        observacion: row.observacion_apertura || null,
        origen: 'historial_caja',
      },
      created_at: row.fecha_apertura,
      trabajador_nombre: row.trabajador_nombre,
    })),
    ...closeRows.map((row) => ({
      id: `hist-caja-close-${row.id}`,
      trabajador_id: row.trabajador_id,
      rol: row.rol,
      accion: 'caja.cerrada',
      entidad: 'caja',
      entidad_id: row.id,
      descripcion: 'Caja cerrada',
      metadata: {
        monto_inicial: Number(row.monto_inicial || 0),
        monto_final: Number(row.monto_final || 0),
        efectivo_esperado: Number(row.efectivo_esperado || 0),
        diferencia: Number(row.diferencia_cierre || 0),
        observacion: row.observacion_cierre || null,
        origen: 'historial_caja',
      },
      created_at: row.fecha_cierre,
      trabajador_nombre: row.trabajador_nombre,
    })),
    ...paymentRows.map((row) => ({
      id: `hist-pago-${row.estado}-${row.id}`,
      trabajador_id: row.anulado_por,
      rol: row.rol,
      accion: row.estado === 'DEVUELTO' ? 'caja.pago_devuelto' : 'caja.pago_anulado',
      entidad: 'pago',
      entidad_id: row.id,
      descripcion: row.estado === 'DEVUELTO' ? 'Pago devuelto' : 'Pago anulado',
      metadata: {
        motivo: row.motivo_anulacion || null,
        monto: Number(row.monto || 0),
        metodo: row.metodo,
        pedido_id: row.pedido_id,
        caja_id: row.caja_id,
        origen: 'historial_pagos',
      },
      created_at: row.anulado_at,
      trabajador_nombre: row.trabajador_nombre,
    })),
    ...movementRows.map((row) => ({
      id: `hist-mov-${row.id}`,
      trabajador_id: row.trabajador_id,
      rol: row.rol,
      accion: 'caja.movimiento_registrado',
      entidad: 'caja_movimiento',
      entidad_id: row.id,
      descripcion: `Movimiento de caja ${row.tipo}`,
      metadata: {
        motivo: row.motivo,
        monto: Number(row.monto || 0),
        metodo: row.metodo,
        caja_id: row.caja_id,
        tipo: row.tipo,
        origen: 'historial_caja',
      },
      created_at: row.created_at,
      trabajador_nombre: row.trabajador_nombre,
    })),
    ...saleRows.map((row) => ({
      id: `hist-venta-${row.id}`,
      trabajador_id: row.trabajador_id,
      rol: row.rol,
      accion: 'caja.cobro_registrado',
      entidad: 'pago',
      entidad_id: row.id,
      descripcion: 'Venta cobrada',
      metadata: {
        pago_id: row.id,
        pedido_id: row.pedido_id,
        caja_id: row.caja_id,
        monto: Number(row.monto || 0),
        metodo: row.metodo,
        factura_cliente: row.factura_cliente || null,
        factura_documento: row.factura_documento || null,
        comprobante_numero: row.comprobante_numero || null,
        origen: 'historial_pagos',
      },
      created_at: row.created_at,
      trabajador_nombre: row.trabajador_nombre,
      pedido_id: row.pedido_id,
      cliente_nombre: row.cliente_nombre || row.factura_cliente || null,
      cliente_documento: row.factura_documento || null,
      factura_cliente: row.factura_cliente || null,
      factura_documento: row.factura_documento || null,
      mesero_id: row.mesero_id,
      mesero_nombre: row.mesero_nombre,
      cajero_id: row.trabajador_id,
      cajero_nombre: row.trabajador_nombre,
      mesa_numero: row.mesa_numero,
      canal: row.tipo,
    })),
  ];

  return rows.filter((row) => passFilters(row, filters));
}

function positiveIds(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

async function enrichAuditRows(rows) {
  const paymentIds = positiveIds(rows.filter((row) => row.entidad === 'pago').map((row) => row.entidad_id));
  const payments = paymentIds.length ? await queryOrEmpty(
    `SELECT pg.id, pg.pedido_id, pg.trabajador_id,
            pg.factura_cliente, pg.factura_documento, pg.comprobante_numero,
            COALESCE(pg.trabajador_id, c.trabajador_id) AS cajero_id,
            cajero.nombre AS cajero_nombre
     FROM pagos pg
     LEFT JOIN caja c ON c.id = pg.caja_id
     LEFT JOIN trabajadores cajero ON cajero.id = COALESCE(pg.trabajador_id, c.trabajador_id)
     WHERE pg.id IN (?)`,
    [paymentIds]
  ) : [];
  const paymentById = new Map(payments.map((row) => [Number(row.id), row]));
  const orderIds = positiveIds(rows.flatMap((row) => {
    const payment = row.entidad === 'pago' ? paymentById.get(Number(row.entidad_id)) : null;
    return [row.pedido_id, row.metadata?.pedido_id, row.entidad === 'pedido' ? row.entidad_id : null, payment?.pedido_id];
  }));
  const orders = orderIds.length ? await queryOrEmpty(
    `SELECT p.id, p.tipo, p.mesa_id, p.cliente_nombre, p.cliente_dato, p.mesero_id,
            m.numero AS mesa_numero, mesero.nombre AS mesero_nombre
     FROM pedidos p
     LEFT JOIN mesas m ON m.id = p.mesa_id
     LEFT JOIN trabajadores mesero ON mesero.id = p.mesero_id
     WHERE p.id IN (?)`,
    [orderIds]
  ) : [];
  const orderById = new Map(orders.map((row) => [Number(row.id), row]));

  return rows.map((row) => {
    const metadata = row.metadata || {};
    const payment = row.entidad === 'pago' ? paymentById.get(Number(row.entidad_id)) : null;
    const pedidoId = Number(row.pedido_id || metadata.pedido_id || (row.entidad === 'pedido' ? row.entidad_id : 0) || payment?.pedido_id) || null;
    const order = pedidoId ? orderById.get(pedidoId) : null;
    const isCharge = row.accion === 'caja.cobro_registrado';
    return {
      ...row,
      pedido_id: pedidoId,
      cliente_nombre: row.cliente_nombre || metadata.cliente_nombre || order?.cliente_nombre || metadata.factura_cliente || payment?.factura_cliente || null,
      cliente_documento: row.cliente_documento || metadata.factura_documento || payment?.factura_documento || null,
      factura_cliente: row.factura_cliente || metadata.factura_cliente || payment?.factura_cliente || null,
      factura_documento: row.factura_documento || metadata.factura_documento || payment?.factura_documento || null,
      mesero_id: row.mesero_id || order?.mesero_id || null,
      mesero_nombre: row.mesero_nombre || order?.mesero_nombre || null,
      cajero_id: row.cajero_id || (isCharge ? row.trabajador_id : payment?.cajero_id) || null,
      cajero_nombre: row.cajero_nombre || (isCharge ? row.trabajador_nombre : payment?.cajero_nombre) || null,
      mesa_numero: row.mesa_numero || order?.mesa_numero || null,
      canal: row.canal || order?.tipo || null,
      comprobante_numero: row.comprobante_numero || metadata.comprobante_numero || payment?.comprobante_numero || null,
    };
  });
}

function isDuplicatedDerivedSale(row, auditRows) {
  if (row.accion !== 'caja.cobro_registrado' || row.metadata?.origen !== 'historial_pagos') return false;
  return auditRows.some((audit) => {
    if (audit.accion !== row.accion) return false;
    const auditOrderId = Number(audit.metadata?.pedido_id || (audit.entidad === 'pedido' ? audit.entidad_id : 0));
    const sameOrder = auditOrderId === Number(row.metadata?.pedido_id);
    const sameAmount = Math.abs(Number(audit.metadata?.monto || 0) - Number(row.metadata?.monto || 0)) < 0.005;
    const timeDistance = Math.abs(new Date(audit.created_at || 0).getTime() - new Date(row.created_at || 0).getTime());
    return sameOrder && sameAmount && timeDistance <= 30000;
  });
}

router.get('/', verifyRole('admin'), async (req, res) => {
  try {
    await ensureAuditTable();
    const limit = Math.min(200, Math.max(20, Number(req.query.limit || 80)));
    const entidad = req.query.entidad ? String(req.query.entidad) : null;
    const entidadId = req.query.entidad_id ? Number(req.query.entidad_id) : null;
    const accion = req.query.accion ? String(req.query.accion) : null;
    const desde = req.query.desde ? String(req.query.desde) : null;
    const hasta = req.query.hasta ? String(req.query.hasta) : null;

    const filters = [];
    const params = [];
    if (entidad) {
      filters.push('a.entidad = ?');
      params.push(entidad);
    }
    if (entidadId) {
      filters.push('a.entidad_id = ?');
      params.push(entidadId);
    }
    if (accion) {
      filters.push('a.accion = ?');
      params.push(accion);
    }
    if (desde) {
      filters.push('a.created_at >= ?');
      params.push(desde);
    }
    if (hasta) {
      filters.push('a.created_at <= ?');
      params.push(hasta);
    }

    const [rows] = await pool.query(
      `SELECT a.*, t.nombre AS trabajador_nombre
       FROM auditoria_acciones a
       LEFT JOIN trabajadores t ON t.id = a.trabajador_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC
       LIMIT ${limit}`,
      params
    );

    const auditRows = rows.map((row) => ({
      ...row,
      metadata: parseMetadata(row.metadata),
    }));
    const historyRows = (await derivedAuditRows({ entidad, entidadId, accion, desde, hasta }))
      .filter((row) => !isDuplicatedDerivedSale(row, auditRows));
    const seen = new Set();
    const merged = [...auditRows, ...historyRows]
      .filter((row) => {
        const key = `${row.accion}|${row.entidad}|${row.entidad_id || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, limit);

    res.json(await enrichAuditRows(merged));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
