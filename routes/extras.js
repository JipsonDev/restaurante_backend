import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';

const router = express.Router();

let ready = false;

async function ensureExtrasTable() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extras (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      precio DECIMAL(10,2) NOT NULL DEFAULT 0,
      tipo ENUM('EXTRA','EXCLUSION','TERMINO','NOTA') NOT NULL DEFAULT 'EXTRA',
      categoria VARCHAR(80) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM extras');
  if (Number(total) === 0) {
    await pool.query(
      `INSERT INTO extras (nombre, precio, tipo, categoria, activo)
       VALUES
       ('Mas cafe', 0.25, 'EXTRA', 'Cafe', 1),
       ('Extra leche', 0.30, 'EXTRA', 'Cafe', 1),
       ('Shot espresso', 0.75, 'EXTRA', 'Cafe', 1),
       ('Extra queso', 1.00, 'EXTRA', 'Comida', 1),
       ('Sin cebolla', 0.00, 'EXCLUSION', 'Comida', 1),
       ('Sin azucar', 0.00, 'EXCLUSION', 'Bebidas', 1),
       ('Termino medio', 0.00, 'TERMINO', 'Comida', 1)`
    );
  }
  ready = true;
}

router.use(async (_req, _res, next) => {
  try {
    await ensureExtrasTable();
    next();
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1';
    const [rows] = await pool.query(
      `SELECT id, nombre, precio, tipo, categoria, activo, created_at, updated_at
       FROM extras
       ${includeInactive ? '' : 'WHERE activo = 1'}
       ORDER BY activo DESC, categoria ASC, nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const {
    nombre, precio = 0, tipo = 'EXTRA', categoria = null, activo = 1,
  } = req.body;
  const validTypes = ['EXTRA', 'EXCLUSION', 'TERMINO', 'NOTA'];

  if (!String(nombre || '').trim()) return res.status(400).json({ message: 'Nombre es obligatorio.' });
  if (!validTypes.includes(tipo)) return res.status(400).json({ message: `Tipo invalido. Validos: ${validTypes.join(', ')}` });

  try {
    const [result] = await pool.query(
      `INSERT INTO extras (nombre, precio, tipo, categoria, activo)
       VALUES (?, ?, ?, ?, ?)`,
      [String(nombre).trim(), Number(precio || 0), tipo, categoria || null, Number(activo) ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId, message: 'Extra creado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const {
    nombre, precio, tipo, categoria, activo,
  } = req.body;
  const validTypes = ['EXTRA', 'EXCLUSION', 'TERMINO', 'NOTA'];

  if (tipo && !validTypes.includes(tipo)) return res.status(400).json({ message: `Tipo invalido. Validos: ${validTypes.join(', ')}` });

  try {
    await pool.query(
      `UPDATE extras
       SET nombre = COALESCE(?, nombre),
           precio = COALESCE(?, precio),
           tipo = COALESCE(?, tipo),
           categoria = IF(? = 1, ?, categoria),
           activo = COALESCE(?, activo)
       WHERE id = ?`,
      [
        nombre !== undefined ? String(nombre).trim() : null,
        precio !== undefined ? Number(precio || 0) : null,
        tipo ?? null,
        Object.prototype.hasOwnProperty.call(req.body, 'categoria') ? 1 : 0,
        categoria || null,
        activo !== undefined ? (Number(activo) ? 1 : 0) : null,
        req.params.id,
      ]
    );
    res.json({ message: 'Extra actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM extras WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Extra no encontrado.' });
    res.json({ message: 'Extra eliminado permanentemente.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
