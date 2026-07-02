import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    // Pedidos de hoy
    const [[{ pedidosHoy }]] = await pool.query(
      `SELECT COUNT(*) AS pedidosHoy FROM pedidos WHERE DATE(created_at) = CURDATE()`
    );

    // Ventas de hoy
    const [[{ ventasHoy }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS ventasHoy
       FROM pedidos
       WHERE DATE(created_at) = CURDATE() AND estado = 'PAGADO'`
    );

    // Ticket promedio
    const [[{ ticketPromedio }]] = await pool.query(
      `SELECT COALESCE(AVG(total), 0) AS ticketPromedio
       FROM pedidos
       WHERE DATE(created_at) = CURDATE() AND estado = 'PAGADO'`
    );

    // Clientes (contamos pedidos únicos por mesa hoy)
    const [[{ clientesHoy }]] = await pool.query(
      `SELECT COUNT(DISTINCT mesa_id) AS clientesHoy
       FROM pedidos WHERE DATE(created_at) = CURDATE()`
    );

    // Inventario
    const [[{ stock }]] = await pool.query(
      `SELECT COUNT(*) AS stock FROM productos WHERE disponible = 1 AND stock > 5`
    );
    const [[{ stockBajo }]] = await pool.query(
      `SELECT COUNT(*) AS stockBajo FROM productos WHERE disponible = 1 AND stock BETWEEN 1 AND 5`
    );
    const [[{ agotados }]] = await pool.query(
      `SELECT COUNT(*) AS agotados FROM productos WHERE stock = 0`
    );

    res.json({
      pedidosHoy,
      ventasHoy:      Number(ventasHoy).toFixed(2),
      ticketPromedio: Number(ticketPromedio).toFixed(2),
      clientesHoy,
      stock,
      stockBajo,
      agotados,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
