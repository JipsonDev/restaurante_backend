import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1';
    const [rows] = await pool.query(
      `SELECT u.*,
              COUNT(m.id) AS mesas_activas
       FROM ubicaciones u
       LEFT JOIN mesas m
         ON m.ubicacion_id = u.id
        AND m.activo = 1
       ${includeInactive ? '' : 'WHERE u.activo = 1'}
       GROUP BY u.id
       ORDER BY u.nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const { nombre, descripcion = null, activo = 1 } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ message: 'Nombre es obligatorio.' });

  try {
    const [existing] = await pool.query(
      'SELECT id FROM ubicaciones WHERE LOWER(nombre) = LOWER(?) AND activo = 1',
      [nombre.trim()]
    );
    if (existing.length) return res.status(409).json({ message: 'Ya existe una ubicacion activa con ese nombre.' });

    const [result] = await pool.query(
      `INSERT INTO ubicaciones (nombre, descripcion, activo)
       VALUES (?, ?, ?)`,
      [nombre.trim(), descripcion || null, Number(activo) ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId, nombre: nombre.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, descripcion, activo } = req.body;

  try {
    if (nombre !== undefined) {
      if (!nombre.trim()) return res.status(400).json({ message: 'Nombre es obligatorio.' });
      const [existing] = await pool.query(
        'SELECT id FROM ubicaciones WHERE LOWER(nombre) = LOWER(?) AND id <> ? AND activo = 1',
        [nombre.trim(), req.params.id]
      );
      if (existing.length) return res.status(409).json({ message: 'Ya existe otra ubicacion activa con ese nombre.' });
    }

    await pool.query(
      `UPDATE ubicaciones
       SET nombre = COALESCE(?, nombre),
           descripcion = IF(? = 1, ?, descripcion),
           activo = COALESCE(?, activo)
       WHERE id = ?`,
      [
        nombre !== undefined ? nombre.trim() : null,
        Object.prototype.hasOwnProperty.call(req.body, 'descripcion') ? 1 : 0,
        descripcion || null,
        activo !== undefined ? (Number(activo) ? 1 : 0) : null,
        req.params.id,
      ]
    );
    res.json({ message: 'Ubicacion actualizada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  try {
    const [[{ mesas_activas }]] = await pool.query(
      'SELECT COUNT(*) AS mesas_activas FROM mesas WHERE ubicacion_id = ? AND activo = 1',
      [req.params.id]
    );
    if (Number(mesas_activas) > 0) {
      return res.status(409).json({ message: 'No puedes eliminar una ubicacion con mesas activas asignadas.' });
    }

    const [result] = await pool.query('DELETE FROM ubicaciones WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Ubicacion no encontrada.' });
    res.json({ message: 'Ubicacion eliminada permanentemente.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
