import express from 'express';
import { TABLE_STATES, tableInputError, tableTransitionError } from '../services/tableValidation.js';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { EVENTS } from '../realtime.js';
import { emitMesaRealtime, getMesaPayload, listMesas } from '../services/tableState.js';
import { safeLogAudit } from '../services/audit.js';

const router = express.Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const eventForTableState = state => state === 'Ocupada' ? EVENTS.TABLE_OCCUPIED : state === 'Libre' ? EVENTS.TABLE_FREED : EVENTS.TABLE_UPDATED;

// Serialize catalog edits across connections; order creation uses the row lock below.
// The database-qualified lock also keeps disposable integration databases isolated.
async function mutate(work) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[result]] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':table-catalog'), 5) AS acquired");
    if (Number(result.acquired) !== 1) throw fail(409, 'Otra persona está actualizando las mesas. Intenta nuevamente.');
    locked = true;
    await conn.beginTransaction();
    const resultValue = await work(conn);
    await conn.commit();
    return resultValue;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    try { if (locked) await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':table-catalog'))"); }
    finally { conn.release(); }
  }
}
async function currentTable(conn, id) {
  await conn.query('SELECT id FROM mesas WHERE id = ? FOR UPDATE', [id]);
  const current = await getMesaPayload(id, conn);
  if (!current) throw fail(404, 'Mesa no encontrada.');
  return current;
}
async function validateLocation(conn, id, currentId) {
  if (id == null || Number(id) === Number(currentId)) return;
  const [[location]] = await conn.query('SELECT id, activo FROM ubicaciones WHERE id = ? FOR UPDATE', [id]);
  if (!location || Number(location.activo) !== 1) throw fail(400, 'Selecciona una ubicación activa y existente.');
}
async function uniqueNumber(conn, number, id = 0) {
  const [existing] = await conn.query('SELECT id FROM mesas WHERE numero = ? AND id <> ? AND activo = 1', [Number(number), id]);
  if (existing.length) throw fail(409, 'Ya existe otra mesa activa con ese número.');
}
function sendError(res, error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'No se pudo actualizar la mesa. Intenta nuevamente.' }); }
async function audit(req, action, id) {
  await safeLogAudit({ user: req.user, accion: action, entidad: 'mesa', entidadId: Number(id), descripcion: 'Administración de mesa', metadata: req.body });
}
router.get('/', async (req, res) => {
  try { res.json(await listMesas({ includeInactive: req.query.includeInactive === '1' })); }
  catch (error) { sendError(res, error); }
});
router.post('/', verifyRole('admin'), async (req, res) => {
  const inputError = tableInputError(req.body, true);
  if (inputError) return res.status(400).json({ message: inputError });
  const { numero, ubicacion_id = null, capacidad = 4, estado = 'Libre', activo = 1 } = req.body;
  if (['Ocupada', 'Cuenta'].includes(estado)) return res.status(409).json({ message: 'Crea la mesa disponible o reservada; se ocupará al recibir un pedido.' });
  try {
    const id = await mutate(async conn => {
      await validateLocation(conn, ubicacion_id);
      if (Number(activo) === 1) await uniqueNumber(conn, numero);
      const [result] = await conn.query('INSERT INTO mesas (numero, ubicacion_id, capacidad, estado, activo) VALUES (?, ?, ?, ?, ?)', [Number(numero), ubicacion_id, Number(capacidad), estado, Number(activo)]);
      return result.insertId;
    });
    await audit(req, 'mesa.creada', id);
    await emitMesaRealtime(EVENTS.TABLE_UPDATED, id, { action: 'create' });
    res.status(201).json({ id, numero: Number(numero) });
  } catch (error) { sendError(res, error); }
});
router.put('/:id', verifyRole('admin'), async (req, res) => {
  const inputError = tableInputError(req.body);
  if (inputError) return res.status(400).json({ message: inputError });
  const { numero, ubicacion_id, capacidad, estado, activo } = req.body;
  try {
    await mutate(async conn => {
      const current = await currentTable(conn, req.params.id);
      const conflict = tableTransitionError(current, req.body);
      if (conflict) throw fail(409, conflict);
      await validateLocation(conn, ubicacion_id, current.ubicacion_id);
      if (Number(activo ?? current.activo) === 1) await uniqueNumber(conn, numero ?? current.numero, req.params.id);
      await conn.query('UPDATE mesas SET numero = COALESCE(?, numero), ubicacion_id = IF(? = 1, ?, ubicacion_id), capacidad = COALESCE(?, capacidad), estado = COALESCE(?, estado), activo = COALESCE(?, activo) WHERE id = ?', [numero !== undefined ? Number(numero) : null, Object.hasOwn(req.body, 'ubicacion_id') ? 1 : 0, ubicacion_id ?? null, capacidad !== undefined ? Number(capacidad) : null, estado ?? null, activo !== undefined ? Number(activo) : null, req.params.id]);
    });
    await audit(req, 'mesa.actualizada', req.params.id);
    await emitMesaRealtime(estado ? eventForTableState(estado) : EVENTS.TABLE_UPDATED, req.params.id, { action: 'update' });
    res.json({ message: 'Mesa actualizada.' });
  } catch (error) { sendError(res, error); }
});
router.put('/:id/estado', verifyRole('admin', 'mesero', 'caja'), async (req, res) => {
  const { estado } = req.body;
  if (!TABLE_STATES.includes(estado)) return res.status(400).json({ message: 'Estado de mesa inválido.' });
  try {
    await mutate(async conn => {
      const current = await currentTable(conn, req.params.id);
      const conflict = tableTransitionError(current, { estado });
      if (conflict) throw fail(409, conflict);
      await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', [estado, req.params.id]);
    });
    await audit(req, 'mesa.estado_actualizado', req.params.id);
    await emitMesaRealtime(eventForTableState(estado), req.params.id, { action: 'state_change' });
    res.json({ message: 'Mesa actualizada.' });
  } catch (error) { sendError(res, error); }
});
router.delete('/:id', verifyRole('admin'), async (req, res) => {
  try {
    await mutate(async conn => {
      const current = await currentTable(conn, req.params.id);
      if (Number(current.pedidos_activos) > 0) throw fail(409, 'No puedes eliminar una mesa con pedidos activos.');
      const [[{ historicos }]] = await conn.query('SELECT COUNT(*) AS historicos FROM pedidos WHERE mesa_id = ?', [req.params.id]);
      if (Number(historicos) > 0) throw fail(409, 'La mesa tiene pedidos históricos. Desactívala para conservar su historial.');
      await conn.query('DELETE FROM mesas WHERE id = ?', [req.params.id]);
    });
    await audit(req, 'mesa.eliminada', req.params.id);
    await emitMesaRealtime(EVENTS.TABLE_UPDATED, req.params.id, { action: 'deactivate' });
    res.json({ message: 'Mesa eliminada permanentemente.' });
  } catch (error) { sendError(res, error); }
});
export default router;
