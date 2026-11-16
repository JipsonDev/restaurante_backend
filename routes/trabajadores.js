import express from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { isValidRole, normalizeRole, VALID_ROLES } from '../services/permissions.js';
import { ensurePinColumn, hashUniquePin } from '../services/quickPin.js';

const router = express.Router();
let roleColumnReady = false;

async function ensureRoleColumn() {
  if (roleColumnReady) return;
  const [rows] = await pool.query(
    `SELECT DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'trabajadores'
       AND COLUMN_NAME = 'rol'
     LIMIT 1`
  );
  if (rows[0]?.DATA_TYPE === 'enum') {
    await pool.query("ALTER TABLE trabajadores MODIFY rol ENUM('admin','supervisor','mesero','cocina','caja') NOT NULL DEFAULT 'mesero'");
  }
  await ensurePinColumn();
  roleColumnReady = true;
}

function roleOr400(rol) {
  const nextRole = normalizeRole(rol || 'mesero');
  if (!isValidRole(nextRole)) {
    const error = new Error(`Rol invalido. Usa: ${VALID_ROLES.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  return nextRole;
}

router.get('/', verifyRole('admin'), async (_req, res) => {
  try {
    await ensureRoleColumn();
    const [rows] = await pool.query(
      `SELECT id, nombre, correo, rol, activo, created_at, pin_hash IS NOT NULL AS pin_configurado
       FROM trabajadores
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', verifyRole('admin'), async (req, res) => {
  try {
    await ensureRoleColumn();
    const [rows] = await pool.query(
      'SELECT id, nombre, correo, rol, activo, pin_hash IS NOT NULL AS pin_configurado FROM trabajadores WHERE id = ?',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Trabajador no encontrado.' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const { nombre, correo, password, rol = 'mesero', pin = null, activo = 1 } = req.body;

  if (!String(nombre || '').trim() || !String(correo || '').trim() || !password) {
    return res.status(400).json({ message: 'Nombre, correo y contrasena son obligatorios.' });
  }

  try {
    await ensureRoleColumn();
    const nextRole = roleOr400(rol);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(correo).trim())) return res.status(400).json({ message: 'Correo invalido.' });
    if (![0,1].includes(Number(activo))) return res.status(400).json({ message: 'Estado invalido.' });
    if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ message: 'El PIN debe tener exactamente 4 digitos.' });
    const [existing] = await pool.query(
      'SELECT id FROM trabajadores WHERE correo = ?',
      [correo.toLowerCase().trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: 'Ya existe un usuario con ese correo.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const pinHash = pin ? await hashUniquePin(pin) : null;
    const [result] = await pool.query(
      `INSERT INTO trabajadores (nombre, correo, password_hash, pin_hash, rol, activo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nombre, correo.toLowerCase().trim(), passwordHash, pinHash, nextRole, Number(activo)]
    );

    res.status(201).json({ id: result.insertId, nombre, correo, rol: nextRole });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, correo, rol, activo, password, pin } = req.body;
  let conn;
  try {
    await ensureRoleColumn();
    const nextRole = rol !== undefined ? roleOr400(rol) : null;
    if (nombre !== undefined && !String(nombre || '').trim()) return res.status(400).json({ message: 'Nombre obligatorio.' });
    if (correo !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(correo).trim())) return res.status(400).json({ message: 'Correo invalido.' });
    if (activo !== undefined && ![0,1].includes(Number(activo))) return res.status(400).json({ message: 'Estado invalido.' });
    if (Number(req.params.id) === Number(req.user.id) && ((activo !== undefined && Number(activo) === 0) || (nextRole && nextRole !== 'admin'))) return res.status(409).json({ message: 'No puedes desactivar tu propio usuario ni quitarte el rol de administrador.' });
    if (pin && !/^\d{4}$/.test(String(pin))) return res.status(400).json({ message: 'El PIN debe tener exactamente 4 digitos.' });
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[worker]] = await conn.query('SELECT id FROM trabajadores WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!worker) { await conn.rollback(); return res.status(404).json({ message: 'Trabajador no encontrado.' }); }
    const email = correo === undefined ? null : String(correo).trim().toLowerCase();
    if (email) {
      const [duplicate] = await conn.query('SELECT id FROM trabajadores WHERE correo = ? AND id <> ?', [email, req.params.id]);
      if (duplicate.length) { await conn.rollback(); return res.status(409).json({ message: 'Ya existe un usuario con ese correo.' }); }
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const pinHash = pin ? await hashUniquePin(pin, { excludeUserId: req.params.id, db: conn }) : null;
    await conn.query(
      `UPDATE trabajadores SET nombre = COALESCE(?, nombre), correo = COALESCE(?, correo),
        rol = COALESCE(?, rol), activo = COALESCE(?, activo), password_hash = COALESCE(?, password_hash),
        pin_hash = IF(? = 1, ?, pin_hash) WHERE id = ?`,
      [nombre === undefined ? null : String(nombre).trim(), email, nextRole, activo ?? null, passwordHash, pin !== undefined ? 1 : 0, pinHash, req.params.id]
    );
    await conn.commit();
    res.json({ message: 'Trabajador actualizado.' });
  } catch (error) {
    if (conn) await conn.rollback();
    res.status(error.code === 'ER_DUP_ENTRY' ? 409 : error.statusCode || 500).json({ message: error.code === 'ER_DUP_ENTRY' ? 'Ya existe un usuario con ese correo.' : error.message });
  } finally { conn?.release(); }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  if (Number(req.params.id) === Number(req.user.id)) {
    return res.status(409).json({ message: 'No puedes eliminar tu propio usuario mientras estas conectado.' });
  }

  try {
    const [[refs]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM pedidos WHERE mesero_id = ?) AS pedidos,
         (SELECT COUNT(*) FROM caja WHERE trabajador_id = ?) AS cajas`,
      [req.params.id, req.params.id]
    );
    if (Number(refs.pedidos) > 0 || Number(refs.cajas) > 0) {
      return res.status(409).json({ message: 'No se puede eliminar completamente: el usuario tiene pedidos o cajas historicas.' });
    }

    await pool.query('DELETE FROM push_devices WHERE trabajador_id = ?', [req.params.id]).catch(() => null);
    const [result] = await pool.query('DELETE FROM trabajadores WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Trabajador no encontrado.' });
    res.json({ message: 'Trabajador eliminado permanentemente.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
