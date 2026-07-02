import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *
       FROM inventario_items
       WHERE activo = 1
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const {
    nombre, categoria = null, proveedor = null, unidad = 'unidad',
    stock = 0, stock_minimo = 0, costo_unitario = 0,
  } = req.body;

  if (!nombre) return res.status(400).json({ message: 'Nombre es obligatorio.' });

  try {
    const [result] = await pool.query(
      `INSERT INTO inventario_items
       (nombre, categoria, proveedor, unidad, stock, stock_minimo, costo_unitario)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nombre, categoria, proveedor, unidad, Number(stock), Number(stock_minimo), Number(costo_unitario)]
    );
    res.status(201).json({ id: result.insertId, nombre });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, categoria, proveedor, unidad, stock, stock_minimo, costo_unitario, activo } = req.body;
  try {
    await pool.query(
      `UPDATE inventario_items
       SET nombre = COALESCE(?, nombre),
           categoria = COALESCE(?, categoria),
           proveedor = COALESCE(?, proveedor),
           unidad = COALESCE(?, unidad),
           stock = COALESCE(?, stock),
           stock_minimo = COALESCE(?, stock_minimo),
           costo_unitario = COALESCE(?, costo_unitario),
           activo = COALESCE(?, activo)
       WHERE id = ?`,
      [
        nombre ?? null,
        categoria ?? null,
        proveedor ?? null,
        unidad ?? null,
        stock ?? null,
        stock_minimo ?? null,
        costo_unitario ?? null,
        activo ?? null,
        req.params.id,
      ]
    );
    res.json({ message: 'Inventario actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/movimiento', verifyRole('admin'), async (req, res) => {
  const { tipo = 'Entrada', cantidad, motivo = null } = req.body;
  const validos = ['Entrada', 'Salida', 'Ajuste'];
  if (!validos.includes(tipo)) return res.status(400).json({ message: 'Tipo invalido.' });
  if (cantidad === undefined || cantidad === null || Number(cantidad) < 0) {
    return res.status(400).json({ message: 'Cantidad invalida.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[item]] = await conn.query('SELECT * FROM inventario_items WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!item) {
      await conn.rollback();
      return res.status(404).json({ message: 'Item de inventario no encontrado.' });
    }

    let nuevoStock = Number(item.stock);
    if (tipo === 'Entrada') nuevoStock += Number(cantidad);
    if (tipo === 'Salida') nuevoStock -= Number(cantidad);
    if (tipo === 'Ajuste') nuevoStock = Number(cantidad);
    if (nuevoStock < 0) {
      await conn.rollback();
      return res.status(409).json({ message: `Stock insuficiente. Disponible: ${item.stock}` });
    }

    await conn.query('UPDATE inventario_items SET stock = ? WHERE id = ?', [nuevoStock, req.params.id]);
    await conn.query(
      `INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id)
       VALUES (?, ?, ?, ?, ?)`,
      [req.params.id, tipo, Number(cantidad), motivo, req.user.id]
    );
    await conn.commit();
    res.json({ message: 'Movimiento registrado.', stock: nuevoStock });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[refs]] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM recetas WHERE inventario_item_id = ?) AS recetas,
         (SELECT COUNT(*) FROM productos WHERE inventario_item_id = ?) AS productos,
         (SELECT COUNT(*) FROM inventario_item_movimientos WHERE inventario_item_id = ?) AS movimientos`,
      [req.params.id, req.params.id, req.params.id]
    );
    if (Number(refs.recetas) > 0 || Number(refs.productos) > 0 || Number(refs.movimientos) > 0) {
      await conn.rollback();
      return res.status(409).json({ message: 'No se puede eliminar completamente: el insumo esta vinculado a productos, recetas o movimientos.' });
    }

    const [result] = await conn.query('DELETE FROM inventario_items WHERE id = ?', [req.params.id]);
    await conn.commit();
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Item no encontrado.' });
    res.json({ message: 'Item eliminado permanentemente.' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

export default router;
