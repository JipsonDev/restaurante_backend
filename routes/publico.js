// Rutas sin sesión: el menú que el cliente abre al escanear el QR de su mesa. Solo lectura.
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db.js';
import { getBusinessConfig } from '../services/businessConfig.js';
import { parseTableToken, publicMenu } from '../services/publicMenu.js';

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { message: 'Demasiadas consultas. Espera un momento e intenta de nuevo.' } }));

// GET /api/publico/menu?mesa=5-a1b2c3d4e5
router.get('/menu', async (req, res) => {
  try {
    const mesaId = parseTableToken(req.query.mesa);
    const [config, [rows], mesaRows] = await Promise.all([
      getBusinessConfig(),
      pool.query(`SELECT p.id, p.nombre, p.descripcion, p.precio, p.imagen_url, p.agotado, c.nombre AS categoria_nombre
                    FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
                   WHERE p.disponible = 1 AND COALESCE(c.activo, 1) = 1
                   ORDER BY COALESCE(c.nombre, 'ZZZ') ASC, p.nombre ASC`),
      mesaId ? pool.query('SELECT numero FROM mesas WHERE id = ? AND activo = 1', [mesaId]) : Promise.resolve([[]]),
    ]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      negocio: { nombre: config.nombre_restaurante || 'Restaurante', logo_url: config.logo_url || null, telefono: config.telefono || null, direccion: config.direccion || null, simbolo: config.simbolo_moneda || '$' },
      mesa: mesaRows[0]?.[0] ? { numero: mesaRows[0][0].numero } : null,
      ...publicMenu(rows),
    });
  } catch (error) {
    console.error('menu publico:', error.message);
    res.status(500).json({ message: 'No se pudo cargar el menú. Intenta de nuevo en un momento.' });
  }
});

export default router;
