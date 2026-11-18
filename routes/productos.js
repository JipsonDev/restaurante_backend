import { nonNegative, recipeItems, replaceRecipe } from '../services/adminValidation.js';
import { catalogFlag, catalogName, validateCatalogLinks } from '../services/catalogValidation.js';
import { sellableStockSQL } from '../services/stockReservations.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { pool } from '../db.js';
import { scheduleStockCheck } from '../services/stockWatch.js';
import { verifyRole } from '../middleware/auth.js';
import { safeLogAudit } from '../services/audit.js';
import { cleanStation } from '../services/kitchenFlow.js';
import { emitRealtime, EVENTS } from '../realtime.js';

const router = express.Router();

// Cualquier cambio que salga bien (entrada, ajuste, receta, producto) puede cambiar lo que se puede vender.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) scheduleStockCheck(); });
  next();
});
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
              c.activo AS categoria_activa,
              (SELECT COUNT(*) FROM recetas r WHERE r.producto_id = p.id AND r.activo = 1) AS receta_count,
              ii.nombre AS inventario_nombre,
              ii.stock AS inventario_stock,
              ii.stock_reservado AS inventario_reservado,
              ${sellableStockSQL} AS stock_disponible,
              ii.stock_minimo AS inventario_stock_minimo
       FROM productos p
       LEFT JOIN categorias c ON p.categoria_id = c.id
       LEFT JOIN inventario_items ii ON p.inventario_item_id = ii.id
       ${includeInactive ? '' : 'WHERE p.disponible = 1 AND COALESCE(c.activo, 1) = 1'}
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
  const conn = await pool.getConnection();
  try {
    const nombre = catalogName(req.body.nombre, 'Nombre de categoría');
    const activo = catalogFlag(req.body.activo ?? 1);
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id FROM categorias WHERE LOWER(TRIM(nombre)) = LOWER(?) AND activo = 1 FOR UPDATE', [nombre]);
    if (activo && existing.length) { await conn.rollback(); return res.status(409).json({ message: 'Ya existe una categoría activa con ese nombre.' }); }
    const [result] = await conn.query('INSERT INTO categorias (nombre, icono, activo) VALUES (?, ?, ?)', [nombre, String(req.body.icono || '').trim() || null, activo]);
    await conn.commit();
    res.status(201).json({ id: result.insertId, nombre, activo });
  } catch (error) { await conn.rollback(); res.status(error.statusCode || 500).json({ message: error.message }); }
  finally { conn.release(); }
});

router.put('/categorias/:id', verifyRole('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[before]] = await conn.query('SELECT * FROM categorias WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!before) { await conn.rollback(); return res.status(404).json({ message: 'Categoría no encontrada.' }); }
    const nombre = catalogName(req.body.nombre === undefined ? before.nombre : req.body.nombre, 'Nombre de categoría');
    const activo = catalogFlag(req.body.activo === undefined ? before.activo : req.body.activo);
    const [existing] = await conn.query('SELECT id FROM categorias WHERE LOWER(TRIM(nombre)) = LOWER(?) AND id <> ? AND activo = 1 FOR UPDATE', [nombre, req.params.id]);
    if (activo && existing.length) { await conn.rollback(); return res.status(409).json({ message: 'Ya existe otra categoría activa con ese nombre.' }); }
    await conn.query('UPDATE categorias SET nombre = ?, icono = ?, activo = ? WHERE id = ?', [nombre, Object.hasOwn(req.body, 'icono') ? String(req.body.icono || '').trim() || null : before.icono, activo, req.params.id]);
    await conn.commit();
    res.json({ message: 'Categoría actualizada.' });
  } catch (error) { await conn.rollback(); res.status(error.statusCode || 500).json({ message: error.message }); }
  finally { conn.release(); }
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
              ii.stock_reservado AS inventario_reservado,
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
  const conn = await pool.getConnection();
  try {
    const items = recipeItems(req.body.items);
    await conn.beginTransaction();
    const [[product]] = await conn.query('SELECT id, inventario_item_id FROM productos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!product) { await conn.rollback(); return res.status(404).json({ message: 'Producto no encontrado.' }); }
    if (product.inventario_item_id && items.length) { await conn.rollback(); return res.status(400).json({ message: 'Cambia el vínculo directo por una receta desde el producto.' }); }
    await replaceRecipe(conn, req.params.id, items);
    await conn.commit();
    res.json({ message: 'Receta actualizada.' });
  } catch (error) {
    await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn.release(); }
});

// Agotado (por cocina o admin): el producto sigue en el menú del mesero, marcado «Agotado», y el
// servidor rechaza pedidos nuevos de él hasta que se vuelva a habilitar. No toca el stock ni la
// publicación (disponible), que siguen siendo cosa del admin.
router.put('/:id/agotado', verifyRole('admin', 'cocina'), async (req, res) => {
  const agotado = req.body?.agotado === true || req.body?.agotado === 1 || req.body?.agotado === '1';
  try {
    const [[before]] = await pool.query('SELECT id, nombre, agotado FROM productos WHERE id = ?', [req.params.id]);
    if (!before) return res.status(404).json({ message: 'Producto no encontrado.' });
    await pool.query('UPDATE productos SET agotado = ? WHERE id = ?', [agotado ? 1 : 0, req.params.id]);
    await safeLogAudit({ user: req.user, accion: agotado ? 'producto.agotado' : 'producto.habilitado', entidad: 'producto', entidadId: Number(req.params.id),
      descripcion: `${before.nombre} ${agotado ? 'marcado como agotado' : 'disponible otra vez'}`, metadata: { por_rol: req.user?.rol } });
    emitRealtime(EVENTS.CATALOG_UPDATED, { producto_id: Number(req.params.id), nombre: before.nombre, agotado });
    res.json({ id: Number(req.params.id), nombre: before.nombre, agotado });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo cambiar el producto.', detail: error.message });
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
  const { categoria_id = 1, inventario_item_id = null, nombre, descripcion, precio, stock = 0, imagen_url = null, disponible = 1 } = req.body;

  if (!String(nombre || '').trim() || precio === undefined || precio === null || precio === '') {
    return res.status(400).json({ message: 'Nombre y precio son obligatorios.' });
  }

  const conn = await pool.getConnection();
  try {
    nonNegative(precio, 'Precio'); nonNegative(stock, 'Stock', 0);
    catalogFlag(disponible, 'Disponibilidad');
    const cleanName = catalogName(nombre, 'Nombre del producto');
    const receta = req.body.receta === undefined ? null : recipeItems(req.body.receta);
    await conn.beginTransaction();
    await validateCatalogLinks(conn, { categoryId: categoria_id, inventoryId: inventario_item_id, recipe: receta, published: Number(disponible) === 1 });
    const [result] = await conn.query(
      `INSERT INTO productos (categoria_id, inventario_item_id, nombre, descripcion, precio, stock, imagen_url, disponible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [categoria_id, inventario_item_id, cleanName, descripcion || null, Number(precio), Number(stock), imagen_url, Number(disponible)]
    );
    if (receta !== null) await replaceRecipe(conn, result.insertId, receta);
    if (Object.hasOwn(req.body, 'estacion')) await conn.query('UPDATE productos SET estacion = ? WHERE id = ?', [cleanStation(req.body.estacion), result.insertId]);
    await conn.commit();
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
      disponible: Number(disponible),
    });
  } catch (error) {
    await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn.release(); }
});

router.put('/:id', verifyRole('admin'), async (req, res) => {
  const { nombre, descripcion, precio, stock, imagen_url, disponible, categoria_id, inventario_item_id } = req.body;
  const hasInventarioLink = Object.prototype.hasOwnProperty.call(req.body, 'inventario_item_id');
  if (stock != null && (!Number.isFinite(Number(stock)) || Number(stock) < 0 || !Number.isSafeInteger(Number(stock)))) return res.status(400).json({ message: 'Stock invalido: usa unidades enteras no negativas.' });
  const conn = await pool.getConnection();
  try {
    if (precio !== undefined) nonNegative(precio, 'Precio');
    if (stock !== undefined) nonNegative(stock, 'Stock', 0);
    if (disponible !== undefined) catalogFlag(disponible, 'Disponibilidad');
    const cleanName = nombre !== undefined ? catalogName(nombre, 'Nombre del producto') : undefined;
    const receta = req.body.receta === undefined ? null : recipeItems(req.body.receta);
    await conn.beginTransaction();
    const [[before]] = await conn.query('SELECT * FROM productos WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!before) { await conn.rollback(); return res.status(404).json({ message: 'Producto no encontrado.' }); }

    // Validate the resulting stock source, including partial requests.
    const effectiveLink = hasInventarioLink ? inventario_item_id : before.inventario_item_id;
    const [savedRecipe] = receta === null ? await conn.query('SELECT inventario_item_id FROM recetas WHERE producto_id = ? AND activo = 1', [req.params.id]) : [receta];
    await validateCatalogLinks(conn, {
      categoryId: categoria_id !== undefined ? categoria_id : Number(before.categoria_id) > 0 ? before.categoria_id : null,
      inventoryId: hasInventarioLink || receta !== null || Number(disponible) === 1 ? effectiveLink : null,
      recipe: hasInventarioLink || receta !== null ? savedRecipe : [],
      published: Number(disponible ?? before.disponible) === 1,
      requireCategory: categoria_id !== undefined,
    });

    const [updated] = await conn.query(
      `UPDATE productos
       SET nombre = COALESCE(?, nombre),
           descripcion = IF(? = 1, ?, descripcion),
           precio = COALESCE(?, precio),
           stock = COALESCE(?, stock),
           imagen_url = IF(? = 1, ?, imagen_url),
           disponible = COALESCE(?, disponible),
           categoria_id = COALESCE(?, categoria_id),
           inventario_item_id = IF(? = 1, ?, inventario_item_id)
       WHERE id = ? AND (? IS NULL OR ? >= stock_reservado OR ? >= stock)`,
      [
        cleanName ?? null,
        Object.hasOwn(req.body, 'descripcion') ? 1 : 0, descripcion ?? null,
        precio ?? null,
        stock ?? null,
        Object.hasOwn(req.body, 'imagen_url') ? 1 : 0, imagen_url ?? null,
        disponible ?? null,
        categoria_id ?? null,
        hasInventarioLink ? 1 : 0,
        inventario_item_id ?? null,
        req.params.id, stock ?? null, stock ?? null, stock ?? null,
      ]
    );
    if (!updated.affectedRows) { await conn.rollback(); return res.status(409).json({ message: 'No puedes reducir el stock por debajo de las reservas de pedidos confirmados.' }); }
    if (receta !== null) await replaceRecipe(conn, req.params.id, receta);
    if (Object.hasOwn(req.body, 'estacion')) await conn.query('UPDATE productos SET estacion = ? WHERE id = ?', [cleanStation(req.body.estacion), req.params.id]);
    const [[after]] = await conn.query('SELECT * FROM productos WHERE id = ? FOR UPDATE', [req.params.id]);
    await conn.commit();
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
    await conn.rollback();
    res.status(error.statusCode || 500).json({ message: error.message });
  } finally { conn.release(); }
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

    await conn.query('SELECT id FROM productos WHERE id = ? FOR UPDATE', [req.params.id]);
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
