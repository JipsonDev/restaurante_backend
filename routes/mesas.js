import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { EVENTS } from '../realtime.js';
import { emitMesaRealtime, getMesaPayload, listMesas } from '../services/tableState.js';
import { safeLogAudit } from '../services/audit.js';

const router = express.Router();
const TABLE_STATES = ['Libre', 'Ocupada', 'Reservada', 'Cuenta'];

function eventForTableState(estado) {
  if (estado === 'Ocupada') return EVENTS.TABLE_OCCUPIED;
  if (estado === 'Libre') return EVENTS.TABLE_FREED;
  return EVENTS.TABLE_UPDATED;
}

router.get('/', async (req, res) => {
  try {
    res.json(await listMesas({ includeInactive: req.query.includeInactive === '1' }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const {
    numero, ubicacion_id = null, capacidad = 4, estado = 'Libre', activo = 1,
  } = req.body;

  if (!numero) return res.status(400).json({ message: 'Numero de mesa es obligatorio.' });
  if (!TABLE_STATES.includes(estado)) return res.status(400).json({ message: `Estado invalido. Validos: ${TABLE_STATES.join(', ')}` });

  try {
    const [existing] = await pool.query(
      'SELECT id FROM mesas WHERE numero = ? AND activo = 1',
      [Number(numero)]
    );
    if (existing.length) return res.status(409).json({ message: 'Ya existe una mesa activa con ese numero.' });

    const [result] = await pool.query(
      `INSERT INTO mesas (numero, ubicacion_id, capacidad, estado, activo)
       VALUES (?, ?, ?, ?, ?)`,
      [Number(numero), ubicacion_id || null, Number(capacidad || 4), estado, Number(activo) ? 1 : 0]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'mesa.creada',
      entidad: 'mesa',
      entidadId: result.insertId,
      descripcion: `Mesa ${numero} creada`,
      metadata: { numero, ubicacion_id, capacidad, estado, activo },
    });
    await emitMesaRealtime(EVENTS.TABLE_UPDATED, result.insertId, { action: 'create' });
    res.status(201).json({ id: result.insertId, numero: Number(numero) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const {
    numero, ubicacion_id, capacidad, estado, activo,
  } = req.body;

  if (estado && !TABLE_STATES.includes(estado)) {
    return res.status(400).json({ message: `Estado invalido. Validos: ${TABLE_STATES.join(', ')}` });
  }

  try {
    if (numero !== undefined) {
      const [existing] = await pool.query(
        'SELECT id FROM mesas WHERE numero = ? AND id <> ? AND activo = 1',
        [Number(numero), req.params.id]
      );
      if (existing.length) return res.status(409).json({ message: 'Ya existe otra mesa activa con ese numero.' });
    }

    const current = await getMesaPayload(req.params.id);
    if (estado && ['Ocupada', 'Cuenta'].includes(estado) && Number(current?.pedidos_activos || 0) === 0) {
      return res.status(409).json({ message: 'No puedes marcar una mesa como ocupada/cuenta si no tiene pedidos activos.' });
    }

    await pool.query(
      `UPDATE mesas
       SET numero = COALESCE(?, numero),
           ubicacion_id = IF(? = 1, ?, ubicacion_id),
           capacidad = COALESCE(?, capacidad),
           estado = COALESCE(?, estado),
           activo = COALESCE(?, activo)
       WHERE id = ?`,
      [
        numero !== undefined ? Number(numero) : null,
        Object.prototype.hasOwnProperty.call(req.body, 'ubicacion_id') ? 1 : 0,
        ubicacion_id || null,
        capacidad !== undefined ? Number(capacidad) : null,
        estado ?? null,
        activo !== undefined ? (Number(activo) ? 1 : 0) : null,
        req.params.id,
      ]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'mesa.actualizada',
      entidad: 'mesa',
      entidadId: Number(req.params.id),
      descripcion: 'Mesa actualizada',
      metadata: req.body,
    });
    await emitMesaRealtime(estado ? eventForTableState(estado) : EVENTS.TABLE_UPDATED, req.params.id, { action: 'update' });
    res.json({ message: 'Mesa actualizada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/estado', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  const { estado } = req.body;

  if (!TABLE_STATES.includes(estado)) {
    return res.status(400).json({ message: `Estado invalido. Validos: ${TABLE_STATES.join(', ')}` });
  }

  try {
    if (estado === 'Libre') {
      const [[{ activos }]] = await pool.query(
        `SELECT COUNT(*) AS activos
         FROM pedidos
         WHERE mesa_id = ?
           AND DATE(created_at) = CURDATE()
           AND estado NOT IN ('PAGADO', 'CANCELADO')
           AND EXISTS (
             SELECT 1
             FROM detalle_pedidos dp
             WHERE dp.pedido_id = pedidos.id
               AND dp.cantidad > 0
           )`,
        [req.params.id]
      );
      if (Number(activos) > 0) {
        return res.status(409).json({ message: 'No puedes liberar una mesa con pedidos activos. Completa o cancela el pedido primero.' });
      }
    }
    if (['Ocupada', 'Cuenta'].includes(estado)) {
      const [[{ activos }]] = await pool.query(
        `SELECT COUNT(*) AS activos
         FROM pedidos
         WHERE mesa_id = ?
           AND DATE(created_at) = CURDATE()
           AND estado NOT IN ('PAGADO', 'CANCELADO')
           AND EXISTS (
             SELECT 1
             FROM detalle_pedidos dp
             WHERE dp.pedido_id = pedidos.id
               AND dp.cantidad > 0
           )`,
        [req.params.id]
      );
      if (Number(activos) === 0) {
        return res.status(409).json({ message: 'No puedes ocupar una mesa sin pedidos activos. Crea primero el pedido.' });
      }
    }

    await pool.query('UPDATE mesas SET estado = ? WHERE id = ?', [estado, req.params.id]);
    await safeLogAudit({
      user: req.user,
      accion: 'mesa.estado_actualizado',
      entidad: 'mesa',
      entidadId: Number(req.params.id),
      descripcion: `Estado de mesa actualizado a ${estado}`,
      metadata: { estado },
    });
    await emitMesaRealtime(eventForTableState(estado), req.params.id, { action: 'state_change' });
    res.json({ message: 'Mesa actualizada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  try {
    const [[{ activos }]] = await pool.query(
      `SELECT COUNT(*) AS activos
       FROM pedidos
       WHERE mesa_id = ?
         AND DATE(created_at) = CURDATE()
         AND estado NOT IN ('PAGADO', 'CANCELADO')
         AND EXISTS (
           SELECT 1
           FROM detalle_pedidos dp
           WHERE dp.pedido_id = pedidos.id
             AND dp.cantidad > 0
         )`,
      [req.params.id]
    );
    if (Number(activos) > 0) {
      return res.status(409).json({ message: 'No puedes eliminar una mesa con pedidos activos.' });
    }
    const [[{ historicos }]] = await pool.query(
      'SELECT COUNT(*) AS historicos FROM pedidos WHERE mesa_id = ?',
      [req.params.id]
    );
    if (Number(historicos) > 0) {
      return res.status(409).json({ message: 'No se puede eliminar completamente: la mesa tiene pedidos historicos.' });
    }

    const [result] = await pool.query('DELETE FROM mesas WHERE id = ?', [req.params.id]);
    await emitMesaRealtime(EVENTS.TABLE_UPDATED, req.params.id, { action: 'deactivate' });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Mesa no encontrada.' });
    res.json({ message: 'Mesa eliminada permanentemente.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
