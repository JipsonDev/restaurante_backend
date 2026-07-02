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
  const [openRows, closeRows, paymentRows, movementRows] = await Promise.all([
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
  ];

  return rows.filter((row) => passFilters(row, filters));
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
    const historyRows = await derivedAuditRows({ entidad, entidadId, accion, desde, hasta });
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

    res.json(merged);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
