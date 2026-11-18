import { nonNegative } from '../services/adminValidation.js';
import express from 'express';
import { pool } from '../db.js';
import { scheduleStockCheck } from '../services/stockWatch.js';
import { verifyRole } from '../middleware/auth.js';

const router = express.Router();

// Cualquier cambio que salga bien (entrada, ajuste, receta, producto) puede cambiar lo que se puede vender.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) scheduleStockCheck(); });
  next();
});

router.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT *, GREATEST(0, stock - stock_reservado) AS stock_disponible
       FROM inventario_items
       WHERE activo = 1
       ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const {
    nombre, categoria = null, proveedor = null, unidad = 'unidad',
    stock = 0, stock_minimo = 0, costo_unitario = 0,
  } = req.body;

  if (!String(nombre || '').trim()) return res.status(400).json({ message: 'Nombre es obligatorio.' });

  try {
    nonNegative(stock, 'Stock', 3); nonNegative(stock_minimo, 'Stock minimo', 3); nonNegative(costo_unitario, 'Costo unitario');
    const [result] = await pool.query(
      `INSERT INTO inventario_items
       (nombre, categoria, proveedor, unidad, stock, stock_minimo, costo_unitario)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nombre, categoria, proveedor, unidad, Number(stock), Number(stock_minimo), Number(costo_unitario)]
    );
    res.status(201).json({ id: result.insertId, nombre });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, categoria, proveedor, unidad, stock, stock_minimo, costo_unitario, activo } = req.body;
  if (stock != null && (!Number.isFinite(Number(stock)) || Number(stock) < 0)) return res.status(400).json({ message: 'Stock invalido.' });
  try {
    if (nombre !== undefined && !String(nombre || '').trim()) return res.status(400).json({ message: 'Nombre obligatorio.' });
    for (const [key, decimals] of [['stock',3], ['stock_minimo',3], ['costo_unitario',2]]) if (req.body[key] !== undefined) nonNegative(req.body[key], key, decimals);
    const [updated] = await pool.query(
      `UPDATE inventario_items
       SET nombre = COALESCE(?, nombre),
           categoria = IF(? = 1, ?, categoria),
           proveedor = IF(? = 1, ?, proveedor),
           unidad = COALESCE(?, unidad),
           stock = COALESCE(?, stock),
           stock_minimo = COALESCE(?, stock_minimo),
           costo_unitario = COALESCE(?, costo_unitario),
           activo = COALESCE(?, activo)
       WHERE id = ? AND (? IS NULL OR ? >= stock_reservado OR ? >= stock)`,
      [
        nombre ?? null,
        Object.hasOwn(req.body, 'categoria') ? 1 : 0, categoria ?? null,
        Object.hasOwn(req.body, 'proveedor') ? 1 : 0, proveedor ?? null,
        unidad ?? null,
        stock ?? null,
        stock_minimo ?? null,
        costo_unitario ?? null,
        activo ?? null,
        req.params.id, stock ?? null, stock ?? null, stock ?? null,
      ]
    );
    if (!updated.affectedRows) return res.status(409).json({ message: 'Item inexistente o stock menor al reservado para pedidos confirmados.' });
    res.json({ message: 'Inventario actualizado.' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/:id/movimiento', verifyRole('admin'), async (req, res) => {
  const { tipo = 'Entrada', cantidad, motivo = null } = req.body;
  const validos = ['Entrada', 'Salida', 'Ajuste'];
  if (!validos.includes(tipo)) return res.status(400).json({ message: 'Tipo invalido.' });
  if (cantidad === undefined || cantidad === null || !Number.isFinite(Number(cantidad)) || Number(cantidad) < 0) {
    return res.status(400).json({ message: 'Cantidad invalida.' });
  }

  const conn = await pool.getConnection();
  try {
    nonNegative(cantidad, 'Cantidad', 3);
    if (tipo !== 'Ajuste' && Number(cantidad) === 0) return res.status(400).json({ message: 'La entrada o salida debe ser mayor que cero.' });
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
    if (nuevoStock < 0 || (nuevoStock < Number(item.stock_reservado || 0) && nuevoStock < Number(item.stock))) {
      await conn.rollback();
      return res.status(409).json({ message: `Stock comprometido. Disponible para retirar: ${Math.max(0, Number(item.stock) - Number(item.stock_reservado || 0))}` });
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
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM inventario_items WHERE id = ? FOR UPDATE', [req.params.id]);
    const [[reservationRefs]] = await conn.query("SELECT COUNT(*) AS n FROM stock_reservas WHERE tipo = 'INSUMO' AND recurso_id = ?", [req.params.id]);
    if (Number(reservationRefs.n)) { await conn.rollback(); return res.status(409).json({ message: 'El insumo pertenece a reservas o consumos historicos.' }); }
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
    res.status(error.statusCode || 500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

export default router;
