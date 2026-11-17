// GET /api/revision-datos: lista lo que parece de prueba o mal cargado. Solo lectura; el panel ofrece las correcciones.
import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { looksLikeJunk, reviewBusiness, reviewProducts } from '../services/dataReview.js';

const router = express.Router();

router.get('/', verifyRole('admin'), async (_req, res) => {
  try {
    const [products] = await pool.query(`SELECT p.id, p.nombre, p.precio, p.disponible, p.categoria_id, c.nombre AS categoria_nombre
      FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id ORDER BY p.nombre`);
    const [orders] = await pool.query(`SELECT p.id, p.tipo, p.cliente_nombre, p.total, p.estado, p.created_at, m.numero AS mesa_numero
      FROM pedidos p LEFT JOIN mesas m ON m.id = p.mesa_id
      WHERE p.cliente_nombre IS NOT NULL AND p.cliente_nombre <> '' AND p.estado <> 'CANCELADO'
      ORDER BY p.id DESC LIMIT 2000`);
    const productos = reviewProducts(products);
    const pedidos = orders.filter((order) => looksLikeJunk(order.cliente_nombre)).slice(0, 100)
      .map((order) => ({ ...order, total: Number(order.total), abierto: !['PAGADO', 'CANCELADO'].includes(order.estado) }));
    const negocio = reviewBusiness(await getBusinessConfig());
    res.json({ productos, pedidos, negocio,
      total: productos.duplicados.length + productos.precios.length + productos.nombres.length + pedidos.length + negocio.length });
  } catch (error) {
    console.error('[revision-datos]', error.message);
    res.status(500).json({ message: 'No se pudo revisar los datos.' });
  }
});

export default router;
