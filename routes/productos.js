import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { safeLogAudit } from '../services/audit.js';

const router = express.Router();
const uploadDir = path.join(process.cwd(), 'uploads', 'productos');

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `producto-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Solo se permiten imagenes.'));
    }
    cb(null, true);
  },
});

router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1' && req.user?.rol === 'admin';
    const [rows] = await pool.query(
      `SELECT p.*,
              c.nombre AS categoria_nombre,
              ii.nombre AS inventario_nombre,
              ii.stock AS inventario_stock,
              ii.stock_minimo AS inventario_stock_minimo
       FROM productos p
       LEFT JOIN categorias c ON p.categoria_id = c.id
       LEFT JOIN inventario_items ii ON p.inventario_item_id = ii.id
       ${includeInactive ? '' : 'WHERE p.disponible = 1'}
       ORDER BY p.nombre ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/categorias', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1' && req.user?.rol === 'admin';
    const [rows] = await pool.query(
      `SELECT id, nombre, icono, activo
       FROM categorias
       ${includeInactive ? '' : 'WHERE activo = 1'}
       ORDER BY id ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/categorias', verifyRole('admin'), async (req, res) => {
  const { nombre, icono = null, activo = 1 } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ message: 'Nombre de categoria es obligatorio.' });

  try {
    const [existing] = await pool.query(
      'SELECT id FROM categorias WHERE LOWER(nombre) = LOWER(?) AND activo = 1',
      [nombre.trim()]
    );
    if (existing.length) return res.status(409).json({ message: 'Ya existe una categoria activa con ese nombre.' });

    const [result] = await pool.query(
      'INSERT INTO categorias (nombre, icono, activo) VALUES (?, ?, ?)',
      [nombre.trim(), icono || null, Number(activo) ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId, nombre: nombre.trim(), icono, activo: Number(activo) ? 1 : 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/categorias/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, icono, activo } = req.body;
  try {
    if (nombre !== undefined) {
      if (!nombre.trim()) return res.status(400).json({ message: 'Nombre de categoria es obligatorio.' });
      const [existing] = await pool.query(
        'SELECT id FROM categorias WHERE LOWER(nombre) = LOWER(?) AND id <> ? AND activo = 1',
        [nombre.trim(), req.params.id]
      );
      if (existing.length) return res.status(409).json({ message: 'Ya existe otra categoria activa con ese nombre.' });
    }

    await pool.query(
      `UPDATE categorias
       SET nombre = COALESCE(?, nombre),
           icono = IF(? = 1, ?, icono),
           activo = COALESCE(?, activo)
       WHERE id = ?`,
      [
        nombre !== undefined ? nombre.trim() : null,
        Object.prototype.hasOwnProperty.call(req.body, 'icono') ? 1 : 0,
        icono || null,
        activo !== undefined ? (Number(activo) ? 1 : 0) : null,
        req.params.id,
      ]
    );
    res.json({ message: 'Categoria actualizada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/categorias/:id', verifyRole('admin'), async (req, res) => {
  try {
    const [[{ productos }]] = await pool.query(
      'SELECT COUNT(*) AS productos FROM productos WHERE categoria_id = ?',
      [req.params.id]
    );
    if (Number(productos) > 0) {
      return res.status(409).json({ message: 'No se puede eliminar completamente: hay productos usando esta categoria.' });
    }
    await pool.query('DELETE FROM categorias WHERE id = ?', [req.params.id]);
    res.json({ message: 'Categoria eliminada.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/upload', verifyRole('admin'), upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No se recibio ninguna imagen.' });
  }

  res.status(201).json({
    imagen_url: `/uploads/productos/${req.file.filename}`,
  });
});

router.get('/:id/receta', verifyRole('admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.producto_id, r.inventario_item_id, r.cantidad, r.unidad, r.activo,
              ii.nombre AS inventario_nombre,
              ii.stock AS inventario_stock,
              ii.unidad AS inventario_unidad
       FROM recetas r
       JOIN inventario_items ii ON r.inventario_item_id = ii.id
       WHERE r.producto_id = ?
       ORDER BY ii.nombre ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/receta', verifyRole('admin'), async (req, res) => {
  const { items = [] } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM recetas WHERE producto_id = ?', [req.params.id]);
    for (const item of items) {
      if (!item.inventario_item_id || Number(item.cantidad || 0) <= 0) continue;
      await conn.query(
        `INSERT INTO recetas (producto_id, inventario_item_id, cantidad, unidad, activo)
         VALUES (?, ?, ?, ?, 1)`,
        [req.params.id, Number(item.inventario_item_id), Number(item.cantidad), item.unidad || null]
      );
    }
    await conn.commit();
    res.json({ message: 'Receta actualizada.' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Producto no encontrado.' });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', verifyRole('admin'), async (req, res) => {
  const { categoria_id = 1, inventario_item_id = null, nombre, descripcion, precio, stock = 0, imagen_url = null } = req.body;

  if (!nombre || precio === undefined || precio === null || precio === '') {
    return res.status(400).json({ message: 'Nombre y precio son obligatorios.' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO productos (categoria_id, inventario_item_id, nombre, descripcion, precio, stock, imagen_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [categoria_id, inventario_item_id, nombre, descripcion || null, Number(precio), Number(stock), imagen_url]
    );
    await safeLogAudit({
      user: req.user,
      accion: 'producto.creado',
      entidad: 'producto',
      entidadId: result.insertId,
      descripcion: `Producto creado: ${nombre}`,
      metadata: { nombre, precio: Number(precio), stock: Number(stock), categoria_id },
    });
    res.status(201).json({
      id: result.insertId,
      categoria_id,
      inventario_item_id,
      nombre,
      descripcion,
      precio,
      stock,
      imagen_url,
      disponible: 1,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, descripcion, precio, stock, imagen_url, disponible, categoria_id, inventario_item_id } = req.body;
  const hasInventarioLink = Object.prototype.hasOwnProperty.call(req.body, 'inventario_item_id');
  try {
    const [[before]] = await pool.query('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ message: 'Producto no encontrado.' });

    await pool.query(
      `UPDATE productos
       SET nombre = COALESCE(?, nombre),
           descripcion = COALESCE(?, descripcion),
           precio = COALESCE(?, precio),
           stock = COALESCE(?, stock),
           imagen_url = COALESCE(?, imagen_url),
           disponible = COALESCE(?, disponible),
           categoria_id = COALESCE(?, categoria_id),
           inventario_item_id = IF(? = 1, ?, inventario_item_id)
       WHERE id = ?`,
      [
        nombre ?? null,
        descripcion ?? null,
        precio ?? null,
        stock ?? null,
        imagen_url ?? null,
        disponible ?? null,
        categoria_id ?? null,
        hasInventarioLink ? 1 : 0,
        inventario_item_id ?? null,
        req.params.id,
      ]
    );
    const [[after]] = await pool.query('SELECT * FROM productos WHERE id = ?', [req.params.id]);
    const priceChanged = precio !== undefined && Number(before.precio) !== Number(precio);
    await safeLogAudit({
      user: req.user,
      accion: priceChanged ? 'producto.precio_cambiado' : 'producto.actualizado',
      entidad: 'producto',
      entidadId: Number(req.params.id),
      descripcion: priceChanged
        ? `Precio cambiado: ${before.nombre}`
        : `Producto actualizado: ${after?.nombre || before.nombre}`,
      metadata: {
        antes: {
          nombre: before.nombre,
          precio: Number(before.precio || 0),
          stock: Number(before.stock || 0),
          disponible: Number(before.disponible),
          categoria_id: before.categoria_id,
        },
        despues: {
          nombre: after?.nombre,
          precio: Number(after?.precio || 0),
          stock: Number(after?.stock || 0),
          disponible: Number(after?.disponible),
          categoria_id: after?.categoria_id,
        },
      },
    });
    res.json({ message: 'Producto actualizado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', verifyRole('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[producto]] = await conn.query('SELECT * FROM productos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!producto) {
      await conn.rollback();
      return res.status(404).json({ message: 'Producto no encontrado.' });
    }
    const [[{ detalles }]] = await conn.query(
      'SELECT COUNT(*) AS detalles FROM detalle_pedidos WHERE producto_id = ?',
      [req.params.id]
    );
    if (Number(detalles) > 0) {
      await conn.rollback();
      return res.status(409).json({ message: 'No se puede eliminar completamente: este producto ya existe en pedidos historicos.' });
    }

    await conn.query('DELETE FROM recetas WHERE producto_id = ?', [req.params.id]);
    const [result] = await conn.query('DELETE FROM productos WHERE id = ?', [req.params.id]);
    await safeLogAudit({
      conn,
      user: req.user,
      accion: 'producto.eliminado',
      entidad: 'producto',
      entidadId: Number(req.params.id),
      descripcion: `Producto eliminado: ${producto.nombre}`,
      metadata: {
        nombre: producto.nombre,
        precio: Number(producto.precio || 0),
        stock: Number(producto.stock || 0),
        categoria_id: producto.categoria_id,
      },
    });
    await conn.commit();
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Producto no encontrado.' });
    res.json({ message: 'Producto eliminado permanentemente.' });
  } catch (error) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

export default router;
