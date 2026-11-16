import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';

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

const REPORT_PERIODS = new Set([1, 7, 30, 90]);
const asNumber = value => Number(value || 0);

// GET /api/dashboard/reports?days=7
// Financial figures come from active payments, so voided and refunded receipts
// never inflate revenue. Operational figures keep their own explicit source.
router.get('/reports', verifyRole('admin', 'supervisor'), async (req, res) => {
  const requestedDays = Number(req.query.days || 7);
  if (!REPORT_PERIODS.has(requestedDays)) {
    return res.status(400).json({ message: 'Periodo invalido. Usa 1, 7, 30 o 90 dias.' });
  }

  const days = requestedDays;
  const startOffset = days - 1;
  const previousStartOffset = (days * 2) - 1;
  const currentPaymentRange = `pg.created_at >= DATE_SUB(CURDATE(), INTERVAL ${startOffset} DAY)
    AND pg.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
  const previousPaymentRange = `pg.created_at >= DATE_SUB(CURDATE(), INTERVAL ${previousStartOffset} DAY)
    AND pg.created_at < DATE_SUB(CURDATE(), INTERVAL ${startOffset} DAY)`;
  const currentOrderRange = `p.created_at >= DATE_SUB(CURDATE(), INTERVAL ${startOffset} DAY)
    AND p.created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;

  try {
    const [summaryResult, previousResult, timelineResult, methodsResult, channelsResult, productsResult, hoursResult, cancellationResult] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(CASE WHEN COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' THEN pg.monto ELSE 0 END), 0) AS ventas_netas,
        COUNT(CASE WHEN COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' THEN 1 END) AS pagos,
        COUNT(DISTINCT CASE WHEN COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' THEN pg.pedido_id END) AS pedidos_cobrados,
        COALESCE(SUM(CASE WHEN COALESCE(pg.estado, 'ACTIVO') IN ('ANULADO', 'DEVUELTO') THEN pg.monto ELSE 0 END), 0) AS reversos
        FROM pagos pg WHERE ${currentPaymentRange}`),
      pool.query(`SELECT COALESCE(SUM(pg.monto), 0) AS ventas_netas
        FROM pagos pg WHERE COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' AND ${previousPaymentRange}`),
      pool.query(`SELECT DATE_FORMAT(DATE(pg.created_at), '%Y-%m-%d') AS fecha,
        COALESCE(SUM(CASE WHEN COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' THEN pg.monto ELSE 0 END), 0) AS ventas,
        COUNT(DISTINCT CASE WHEN COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' THEN pg.pedido_id END) AS pedidos
        FROM pagos pg WHERE ${currentPaymentRange}
        GROUP BY fecha ORDER BY fecha`),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(pg.metodo), ''), 'Otro') AS nombre,
        COALESCE(SUM(pg.monto), 0) AS total, COUNT(*) AS transacciones
        FROM pagos pg WHERE COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' AND ${currentPaymentRange}
        GROUP BY COALESCE(NULLIF(TRIM(pg.metodo), ''), 'Otro') ORDER BY total DESC`),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(p.tipo), ''), 'Mesa') AS nombre,
        COALESCE(SUM(pg.monto), 0) AS total, COUNT(DISTINCT pg.pedido_id) AS pedidos
        FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
        WHERE COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' AND ${currentPaymentRange}
        GROUP BY COALESCE(NULLIF(TRIM(p.tipo), ''), 'Mesa') ORDER BY total DESC`),
      pool.query(`SELECT pr.id, pr.nombre, SUM(dp.cantidad) AS unidades,
        COALESCE(SUM(dp.cantidad * dp.precio), 0) AS total
        FROM detalle_pedidos dp
        JOIN productos pr ON pr.id = dp.producto_id
        JOIN pedidos p ON p.id = dp.pedido_id
        WHERE EXISTS (
          SELECT 1 FROM pagos pg
          WHERE pg.pedido_id = p.id AND COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' AND ${currentPaymentRange}
        )
        GROUP BY pr.id, pr.nombre ORDER BY unidades DESC, total DESC LIMIT 8`),
      pool.query(`SELECT HOUR(pg.created_at) AS hora, COALESCE(SUM(pg.monto), 0) AS total,
        COUNT(DISTINCT pg.pedido_id) AS pedidos
        FROM pagos pg WHERE COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO' AND ${currentPaymentRange}
        GROUP BY hora ORDER BY hora`),
      pool.query(`SELECT COUNT(*) AS cancelados FROM pedidos p
        WHERE UPPER(p.estado) = 'CANCELADO' AND ${currentOrderRange}`),
    ]);

    const summary = summaryResult[0][0] || {};
    const previousSales = asNumber(previousResult[0][0]?.ventas_netas);
    const netSales = asNumber(summary.ventas_netas);
    const paidOrders = asNumber(summary.pedidos_cobrados);
    const change = previousSales > 0
      ? ((netSales - previousSales) / previousSales) * 100
      : netSales > 0 ? 100 : 0;

    res.json({
      period: {
        days,
        from: timelineResult[0][0]?.fecha || null,
        to: new Date().toISOString().slice(0, 10),
      },
      summary: {
        net_sales: netSales,
        previous_sales: previousSales,
        change_percent: Number(change.toFixed(1)),
        paid_orders: paidOrders,
        payments: asNumber(summary.pagos),
        average_ticket: paidOrders ? Number((netSales / paidOrders).toFixed(2)) : 0,
        reversed_amount: asNumber(summary.reversos),
        cancelled_orders: asNumber(cancellationResult[0][0]?.cancelados),
      },
      timeline: timelineResult[0].map(row => ({ fecha: row.fecha, ventas: asNumber(row.ventas), pedidos: asNumber(row.pedidos) })),
      methods: methodsResult[0].map(row => ({ nombre: row.nombre, total: asNumber(row.total), transacciones: asNumber(row.transacciones) })),
      channels: channelsResult[0].map(row => ({ nombre: row.nombre, total: asNumber(row.total), pedidos: asNumber(row.pedidos) })),
      products: productsResult[0].map(row => ({ id: row.id, nombre: row.nombre, unidades: asNumber(row.unidades), total: asNumber(row.total) })),
      hours: hoursResult[0].map(row => ({ hora: asNumber(row.hora), total: asNumber(row.total), pedidos: asNumber(row.pedidos) })),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo generar el reporte.', error: error.message });
  }
});

export default router;
