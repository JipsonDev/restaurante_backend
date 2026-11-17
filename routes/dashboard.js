import express from 'express';
import { pool } from '../db.js';
import { fromLocalDay, isLocalToday, localDate, localTime, localTodayISO, toLocalDayEnd } from '../services/businessTime.js';
import { reportRange } from '../services/reportRange.js';
import { ensureAdjustments } from '../services/adjustments.js';
import { verifyRole } from '../middleware/auth.js';

const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', async (req, res) => {
  try {
    // Pedidos de hoy
    const [[{ pedidosHoy }]] = await pool.query(
      `SELECT COUNT(*) AS pedidosHoy FROM pedidos WHERE ${isLocalToday('created_at')}`
    );

    // Ventas de hoy
    const [[{ ventasHoy }]] = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS ventasHoy
       FROM pedidos
       WHERE ${isLocalToday('created_at')} AND estado = 'PAGADO'`
    );

    // Ticket promedio
    const [[{ ticketPromedio }]] = await pool.query(
      `SELECT COALESCE(AVG(total), 0) AS ticketPromedio
       FROM pedidos
       WHERE ${isLocalToday('created_at')} AND estado = 'PAGADO'`
    );

    // Clientes (contamos pedidos únicos por mesa hoy)
    const [[{ clientesHoy }]] = await pool.query(
      `SELECT COUNT(DISTINCT mesa_id) AS clientesHoy
       FROM pedidos WHERE ${isLocalToday('created_at')}`
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

const asNumber = value => Number(value || 0);
const ACTIVE = "COALESCE(pg.estado, 'ACTIVO') = 'ACTIVO'";

// GET /api/dashboard/reports?days=7            (hoy, 7, 30 o 90 días)
// GET /api/dashboard/reports?desde=AAAA-MM-DD&hasta=AAAA-MM-DD   (rango propio, hasta un año)
// Las cifras de dinero salen de los pagos activos: los anulados o devueltos nunca inflan las ventas.
router.get('/reports', verifyRole('admin', 'supervisor'), async (req, res) => {
  let range;
  try { range = reportRange(req.query, localTodayISO()); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  const { from, to, days, previousFrom, previousTo } = range;

  // Rangos en días del local (Ecuador), no en días UTC de la base.
  const between = column => `${column} >= ${fromLocalDay()} AND ${column} < ${toLocalDayEnd()}`;
  const current = [from, to];
  const paid = between('pg.created_at');

  try {
    const [summaryResult, previousResult, timelineResult, methodsResult, channelsResult, productsResult, hoursResult, cancellationResult, waitersResult, categoriesResult] = await Promise.all([
      pool.query(`SELECT
        COALESCE(SUM(CASE WHEN ${ACTIVE} THEN pg.monto ELSE 0 END), 0) AS ventas_netas,
        COUNT(CASE WHEN ${ACTIVE} THEN 1 END) AS pagos,
        COUNT(DISTINCT CASE WHEN ${ACTIVE} THEN pg.pedido_id END) AS pedidos_cobrados,
        COALESCE(SUM(CASE WHEN COALESCE(pg.estado, 'ACTIVO') IN ('ANULADO', 'DEVUELTO') THEN pg.monto ELSE 0 END), 0) AS reversos
        FROM pagos pg WHERE ${paid}`, current),
      pool.query(`SELECT COALESCE(SUM(pg.monto), 0) AS ventas_netas
        FROM pagos pg WHERE ${ACTIVE} AND ${paid}`, [previousFrom, previousTo]),
      pool.query(`SELECT DATE_FORMAT(${localDate('pg.created_at')}, '%Y-%m-%d') AS fecha,
        COALESCE(SUM(CASE WHEN ${ACTIVE} THEN pg.monto ELSE 0 END), 0) AS ventas,
        COUNT(DISTINCT CASE WHEN ${ACTIVE} THEN pg.pedido_id END) AS pedidos
        FROM pagos pg WHERE ${paid}
        GROUP BY fecha ORDER BY fecha`, current),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(pg.metodo), ''), 'Otro') AS nombre,
        COALESCE(SUM(pg.monto), 0) AS total, COUNT(*) AS transacciones
        FROM pagos pg WHERE ${ACTIVE} AND ${paid}
        GROUP BY COALESCE(NULLIF(TRIM(pg.metodo), ''), 'Otro') ORDER BY total DESC`, current),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(p.tipo), ''), 'Mesa') AS nombre,
        COALESCE(SUM(pg.monto), 0) AS total, COUNT(DISTINCT pg.pedido_id) AS pedidos
        FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
        WHERE ${ACTIVE} AND ${paid}
        GROUP BY COALESCE(NULLIF(TRIM(p.tipo), ''), 'Mesa') ORDER BY total DESC`, current),
      pool.query(`SELECT pr.id, pr.nombre, COALESCE(c.nombre, 'Sin categoría') AS categoria, SUM(dp.cantidad) AS unidades,
        COALESCE(SUM(dp.cantidad * dp.precio), 0) AS total
        FROM detalle_pedidos dp
        JOIN productos pr ON pr.id = dp.producto_id
        LEFT JOIN categorias c ON c.id = pr.categoria_id
        JOIN pedidos p ON p.id = dp.pedido_id
        WHERE EXISTS (
          SELECT 1 FROM pagos pg
          WHERE pg.pedido_id = p.id AND ${ACTIVE} AND ${paid}
        )
        GROUP BY pr.id, pr.nombre, COALESCE(c.nombre, 'Sin categoría') ORDER BY unidades DESC, total DESC LIMIT 40`, current),
      pool.query(`SELECT HOUR(${localTime('pg.created_at')}) AS hora, COALESCE(SUM(pg.monto), 0) AS total,
        COUNT(DISTINCT pg.pedido_id) AS pedidos
        FROM pagos pg WHERE ${ACTIVE} AND ${paid}
        GROUP BY hora ORDER BY hora`, current),
      pool.query(`SELECT COUNT(*) AS cancelados FROM pedidos p
        WHERE UPPER(p.estado) = 'CANCELADO' AND ${between('p.created_at')}`, current),
      // Rendimiento por mesero: lo cobrado de sus cuentas y sus propinas.
      pool.query(`SELECT p.mesero_id, COALESCE(t.nombre, 'Sin mesero') AS nombre,
        COALESCE(SUM(pg.monto), 0) AS total, COUNT(DISTINCT pg.pedido_id) AS cuentas,
        COALESCE(SUM(pg.propina), 0) AS propinas
        FROM pagos pg JOIN pedidos p ON p.id = pg.pedido_id
        LEFT JOIN trabajadores t ON t.id = p.mesero_id
        WHERE ${ACTIVE} AND ${paid}
        GROUP BY p.mesero_id, COALESCE(t.nombre, 'Sin mesero') ORDER BY total DESC`, current)
        .catch(error => { if (!/propina/i.test(error.message || '')) throw error; return [[]]; }),
      pool.query(`SELECT COALESCE(c.nombre, 'Sin categoría') AS nombre, SUM(dp.cantidad) AS unidades,
        COALESCE(SUM(dp.cantidad * dp.precio), 0) AS total
        FROM detalle_pedidos dp
        JOIN productos pr ON pr.id = dp.producto_id
        LEFT JOIN categorias c ON c.id = pr.categoria_id
        JOIN pedidos p ON p.id = dp.pedido_id
        WHERE EXISTS (
          SELECT 1 FROM pagos pg
          WHERE pg.pedido_id = p.id AND ${ACTIVE} AND ${paid}
        )
        GROUP BY COALESCE(c.nombre, 'Sin categoría') ORDER BY total DESC`, current),
    ]);

    // Propinas y descuentos viven en columnas/tablas que crea la caja: si aún no existen, van en cero.
    const [tipsRows] = await pool.query(`SELECT COALESCE(SUM(pg.propina), 0) AS total,
        COALESCE(SUM(CASE WHEN pg.propina_metodo = 'Efectivo' THEN pg.propina ELSE 0 END), 0) AS efectivo,
        COUNT(CASE WHEN pg.propina > 0 THEN 1 END) AS pagos
        FROM pagos pg WHERE ${ACTIVE} AND ${paid}`, current).catch(() => [[{}]]);
    const [adjustRows] = await ensureAdjustments().then(() => pool.query(`SELECT a.tipo, COUNT(*) AS veces, COALESCE(SUM(a.monto), 0) AS total
        FROM cuenta_ajustes a WHERE a.estado = 'ACTIVO' AND ${between('a.created_at')} GROUP BY a.tipo`, current)).catch(() => [[]]);
    const adjust = tipo => adjustRows.find(row => row.tipo === tipo) || {};

    const summary = summaryResult[0][0] || {};
    const previousSales = asNumber(previousResult[0][0]?.ventas_netas);
    const netSales = asNumber(summary.ventas_netas);
    const paidOrders = asNumber(summary.pedidos_cobrados);
    const change = previousSales > 0
      ? ((netSales - previousSales) / previousSales) * 100
      : netSales > 0 ? 100 : 0;

    res.json({
      period: { days, from, to, previous_from: previousFrom, previous_to: previousTo },
      summary: {
        net_sales: netSales,
        previous_sales: previousSales,
        change_percent: Number(change.toFixed(1)),
        paid_orders: paidOrders,
        payments: asNumber(summary.pagos),
        average_ticket: paidOrders ? Number((netSales / paidOrders).toFixed(2)) : 0,
        reversed_amount: asNumber(summary.reversos),
        cancelled_orders: asNumber(cancellationResult[0][0]?.cancelados),
        tips: asNumber(tipsRows[0]?.total),
        tips_cash: asNumber(tipsRows[0]?.efectivo),
        tip_payments: asNumber(tipsRows[0]?.pagos),
        discounts: asNumber(adjust('DESCUENTO').total),
        discount_count: asNumber(adjust('DESCUENTO').veces),
        comps: asNumber(adjust('CORTESIA').total),
        comp_count: asNumber(adjust('CORTESIA').veces),
      },
      timeline: timelineResult[0].map(row => ({ fecha: row.fecha, ventas: asNumber(row.ventas), pedidos: asNumber(row.pedidos) })),
      methods: methodsResult[0].map(row => ({ nombre: row.nombre, total: asNumber(row.total), transacciones: asNumber(row.transacciones) })),
      channels: channelsResult[0].map(row => ({ nombre: row.nombre, total: asNumber(row.total), pedidos: asNumber(row.pedidos) })),
      products: productsResult[0].map(row => ({ id: row.id, nombre: row.nombre, categoria: row.categoria, unidades: asNumber(row.unidades), total: asNumber(row.total) })),
      categories: categoriesResult[0].map(row => ({ nombre: row.nombre, unidades: asNumber(row.unidades), total: asNumber(row.total) })),
      hours: hoursResult[0].map(row => ({ hora: asNumber(row.hora), total: asNumber(row.total), pedidos: asNumber(row.pedidos) })),
      waiters: waitersResult[0].map(row => {
        const total = asNumber(row.total), cuentas = asNumber(row.cuentas);
        return { mesero_id: row.mesero_id ?? null, nombre: row.nombre, total, cuentas, ticket: cuentas ? Number((total / cuentas).toFixed(2)) : 0, propinas: asNumber(row.propinas) };
      }),
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo generar el reporte.', error: error.message });
  }
});

export default router;
