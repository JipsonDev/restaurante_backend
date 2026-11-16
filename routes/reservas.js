import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { EVENTS, emitRealtime } from '../realtime.js';
import { safeLogAudit } from '../services/audit.js';
import {
  BLOCKING_STATES, DEFAULT_DURATION, RESERVATION_LABELS, addDays, capacityError, dayOf, findConflict,
  interval, reservationInputError, timeOf, fromMinutes, transitionError,
} from '../services/reservationLogic.js';

const router = express.Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const STAFF = ['admin', 'supervisor', 'mesero', 'caja'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

let ready = false;
export async function ensureReservationsTable(conn = pool) {
  if (ready) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      mesa_id INT NULL,
      cliente_nombre VARCHAR(120) NOT NULL,
      telefono VARCHAR(30) NULL,
      personas INT NOT NULL,
      fecha_hora DATETIME NOT NULL,
      duracion_min INT NOT NULL DEFAULT ${DEFAULT_DURATION},
      estado VARCHAR(20) NOT NULL DEFAULT 'CONFIRMADA',
      notas VARCHAR(300) NULL,
      creado_por INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL,
      INDEX idx_reservas_fecha (fecha_hora),
      INDEX idx_reservas_mesa (mesa_id, fecha_hora)
    )
  `);
  ready = true;
}

const SELECT = `
  SELECT r.id, r.mesa_id, r.cliente_nombre, r.telefono, r.personas,
         DATE_FORMAT(r.fecha_hora, '%Y-%m-%d %H:%i') AS fecha_hora, r.duracion_min, r.estado, r.notas,
         r.creado_por, t.nombre AS creado_por_nombre, m.numero AS mesa_numero, m.capacidad AS mesa_capacidad,
         u.nombre AS ubicacion_nombre
    FROM reservas r
    LEFT JOIN mesas m ON m.id = r.mesa_id
    LEFT JOIN ubicaciones u ON u.id = m.ubicacion_id
    LEFT JOIN trabajadores t ON t.id = r.creado_por`;

async function getReservation(id, conn = pool) {
  const [[row]] = await conn.query(`${SELECT} WHERE r.id = ?`, [id]);
  return row || null;
}

// Una sola escritura de reservas a la vez: así dos personas no reservan la misma mesa al mismo tiempo.
async function mutate(work) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':reservas'), 5) AS acquired");
    if (Number(lock.acquired) !== 1) throw fail(409, 'Otra persona está guardando una reserva. Intenta nuevamente.');
    locked = true;
    await conn.beginTransaction();
    const value = await work(conn);
    await conn.commit();
    return value;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    try { if (locked) await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':reservas'))"); }
    finally { conn.release(); }
  }
}

// Revisa que la mesa exista, quepa la gente y no choque con otra reserva activa.
async function checkTable(conn, candidate) {
  if (candidate.mesa_id == null) return;
  const [[table]] = await conn.query('SELECT id, numero, capacidad, activo FROM mesas WHERE id = ?', [candidate.mesa_id]);
  if (!table) throw fail(400, 'La mesa seleccionada no existe.');
  const capacity = capacityError(candidate.personas, table);
  if (capacity) throw fail(409, capacity);
  const day = dayOf(candidate.fecha_hora);
  const [nearby] = await conn.query(
    `SELECT id, mesa_id, cliente_nombre, DATE_FORMAT(fecha_hora, '%Y-%m-%d %H:%i') AS fecha_hora, duracion_min, estado
       FROM reservas WHERE mesa_id = ? AND fecha_hora >= ? AND fecha_hora < ? AND estado IN (${BLOCKING_STATES.map(() => '?').join(', ')})`,
    [candidate.mesa_id, `${addDays(day, -1)} 00:00:00`, `${addDays(day, 2)} 00:00:00`, ...BLOCKING_STATES],
  );
  const clash = findConflict(candidate, nearby);
  if (clash) {
    const span = interval(clash);
    throw fail(409, `La mesa ${table.numero} ya está reservada de ${timeOf(clash.fecha_hora)} a ${timeOf(fromMinutes(span.end))} (${clash.cliente_nombre}).`);
  }
}

function clean(body) {
  const out = {};
  for (const key of ['cliente_nombre', 'telefono', 'personas', 'fecha_hora', 'duracion_min', 'mesa_id', 'notas']) {
    if (body[key] === undefined) continue;
    let v = body[key];
    if (key === 'cliente_nombre') v = String(v).trim().replace(/\s+/g, ' ');
    if (key === 'telefono' || key === 'notas') v = v == null || String(v).trim() === '' ? null : String(v).trim();
    if (key === 'personas' || key === 'duracion_min') v = Number(v);
    if (key === 'mesa_id') v = v == null || v === '' ? null : Number(v);
    if (key === 'fecha_hora') v = String(v).trim().replace('T', ' ').slice(0, 16);
    out[key] = v;
  }
  return out;
}

function sendError(res, error) {
  if (!error.status) console.error('reservas:', error.message);
  res.status(error.status || 500).json({ message: error.status ? error.message : 'No se pudo guardar la reserva. Intenta nuevamente.' });
}

async function announce(req, action, reserva, extra = {}) {
  await safeLogAudit({ user: req.user, accion: `reserva.${action}`, entidad: 'reserva', entidadId: Number(reserva.id),
    descripcion: `${reserva.cliente_nombre} · ${reserva.personas} personas · ${reserva.fecha_hora}${reserva.mesa_numero ? ` · mesa ${reserva.mesa_numero}` : ''}`, metadata: extra });
  emitRealtime(EVENTS.RESERVATION_UPDATED, { action, reserva });
}

router.get('/', async (req, res) => {
  const desde = DAY.test(String(req.query.desde || '')) ? req.query.desde : null;
  const hasta = DAY.test(String(req.query.hasta || '')) ? req.query.hasta : null;
  if (!desde || !hasta) return res.status(400).json({ message: 'Indica el rango de fechas (desde y hasta, formato AAAA-MM-DD).' });
  if (hasta < desde) return res.status(400).json({ message: 'La fecha final no puede ser anterior a la inicial.' });
  try {
    await ensureReservationsTable();
    const [rows] = await pool.query(`${SELECT} WHERE r.fecha_hora >= ? AND r.fecha_hora < ? ORDER BY r.fecha_hora, r.id`,
      [`${desde} 00:00:00`, `${addDays(hasta, 1)} 00:00:00`]);
    res.json(rows);
  } catch (error) { sendError(res, error); }
});

router.post('/', verifyRole(...STAFF), async (req, res) => {
  const input = clean(req.body);
  const estado = req.body.estado === 'PENDIENTE' ? 'PENDIENTE' : 'CONFIRMADA';
  input.duracion_min = input.duracion_min || DEFAULT_DURATION;
  const inputError = reservationInputError(input, { creating: true });
  if (inputError) return res.status(400).json({ message: inputError });
  try {
    await ensureReservationsTable();
    const id = await mutate(async conn => {
      await checkTable(conn, input);
      const [result] = await conn.query(
        `INSERT INTO reservas (mesa_id, cliente_nombre, telefono, personas, fecha_hora, duracion_min, estado, notas, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.mesa_id ?? null, input.cliente_nombre, input.telefono ?? null, input.personas, `${input.fecha_hora}:00`, input.duracion_min, estado, input.notas ?? null, req.user?.id || null],
      );
      return result.insertId;
    });
    const reserva = await getReservation(id);
    await announce(req, 'creada', reserva);
    res.status(201).json(reserva);
  } catch (error) { sendError(res, error); }
});

router.put('/:id', verifyRole(...STAFF), async (req, res) => {
  const patch = clean(req.body);
  const inputError = reservationInputError(patch);
  if (inputError) return res.status(400).json({ message: inputError });
  try {
    await ensureReservationsTable();
    await mutate(async conn => {
      const current = await getReservation(req.params.id, conn);
      if (!current) throw fail(404, 'La reserva no existe.');
      const merged = { ...current, ...patch, id: current.id };
      if (BLOCKING_STATES.includes(current.estado)) await checkTable(conn, merged);
      await conn.query(
        `UPDATE reservas SET mesa_id = ?, cliente_nombre = ?, telefono = ?, personas = ?, fecha_hora = ?, duracion_min = ?, notas = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [merged.mesa_id ?? null, merged.cliente_nombre, merged.telefono ?? null, merged.personas, `${merged.fecha_hora}:00`, merged.duracion_min, merged.notas ?? null, current.id],
      );
    });
    const reserva = await getReservation(req.params.id);
    await announce(req, 'actualizada', reserva, { cambios: Object.keys(patch) });
    res.json(reserva);
  } catch (error) { sendError(res, error); }
});

router.put('/:id/estado', verifyRole(...STAFF), async (req, res) => {
  const { estado } = req.body || {};
  try {
    await ensureReservationsTable();
    const previous = await mutate(async conn => {
      const current = await getReservation(req.params.id, conn);
      if (!current) throw fail(404, 'La reserva no existe.');
      const error = transitionError(current.estado, estado);
      if (error) throw fail(409, error);
      // Volver a activar una reserva exige que su mesa siga libre en ese horario.
      if (BLOCKING_STATES.includes(estado) && !BLOCKING_STATES.includes(current.estado)) await checkTable(conn, current);
      await conn.query('UPDATE reservas SET estado = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [estado, current.id]);
      return current.estado;
    });
    const reserva = await getReservation(req.params.id);
    await announce(req, 'estado', reserva, { antes: RESERVATION_LABELS[previous], ahora: RESERVATION_LABELS[estado] });
    res.json(reserva);
  } catch (error) { sendError(res, error); }
});

router.delete('/:id', verifyRole('admin', 'supervisor'), async (req, res) => {
  try {
    await ensureReservationsTable();
    const reserva = await mutate(async conn => {
      const current = await getReservation(req.params.id, conn);
      if (!current) throw fail(404, 'La reserva no existe.');
      await conn.query('DELETE FROM reservas WHERE id = ?', [current.id]);
      return current;
    });
    await announce(req, 'eliminada', reserva);
    res.json({ message: 'Reserva eliminada.' });
  } catch (error) { sendError(res, error); }
});

export default router;
