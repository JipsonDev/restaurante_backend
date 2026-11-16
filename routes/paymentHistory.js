import express from 'express';
import { pool } from '../db.js';
import { verifyRole } from '../middleware/auth.js';
import { getPedidoCompleto } from './pedidos.js';
import { historyFilters, parseSnapshot } from '../services/paymentLedger.js';

const router = express.Router();
router.use(verifyRole('admin', 'caja', 'supervisor'));
const joins = `FROM pagos pg LEFT JOIN pedidos p ON p.id = pg.pedido_id
  LEFT JOIN mesas m ON m.id = p.mesa_id LEFT JOIN caja c ON c.id = pg.caja_id
  LEFT JOIN trabajadores t ON t.id = COALESCE(pg.trabajador_id, c.trabajador_id)`;
const publicFields = `pg.id, pg.pedido_id, pg.caja_id, pg.monto, pg.metodo, pg.referencia,
  pg.factura_tipo, pg.factura_cliente, pg.factura_documento, pg.comprobante_numero,
  pg.estado, pg.created_at, pg.motivo_anulacion, pg.anulado_at, pg.impresion_estado,
  pg.impresion_intentos, pg.impresion_error, pg.division_id,
  p.mesa_id, p.tipo, p.cliente_nombre, m.numero AS mesa_numero, t.nombre AS cajero_nombre`;
router.get('/', async (req, res) => {
  try {
    const filter = historyFilters(req.query);
    const [[summary]] = await pool.query(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN COALESCE(pg.estado,'ACTIVO') = 'ACTIVO' THEN pg.monto ELSE 0 END),0) AS total_activo ${joins} ${filter.sql}`, filter.args);
    const [rows] = await pool.query(`SELECT ${publicFields} ${joins} ${filter.sql} ORDER BY pg.created_at DESC, pg.id DESC LIMIT ? OFFSET ?`, [...filter.args, filter.limit, filter.offset]);
    const [cashiers] = await pool.query(`SELECT DISTINCT t.id, t.nombre FROM trabajadores t JOIN pagos pg ON pg.trabajador_id = t.id
      UNION SELECT DISTINCT t.id, t.nombre FROM trabajadores t JOIN caja c ON c.trabajador_id = t.id JOIN pagos pg ON pg.caja_id = c.id WHERE pg.trabajador_id IS NULL ORDER BY nombre`);
    res.json({ rows, total: Number(summary.total), total_activo: Number(summary.total_activo), page: filter.page, pages: Math.max(1, Math.ceil(Number(summary.total)/filter.limit)), cajeros: cashiers });
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }); }
});
router.get('/:id', async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT ${publicFields}, pg.comprobante_snapshot, pg.subtotal, pg.iva_declarado ${joins} WHERE pg.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ message: 'Comprobante no encontrado.' });
    const snapshot = parseSnapshot(row.comprobante_snapshot);
    delete row.comprobante_snapshot;
    if (snapshot) return res.json({ pago: row, snapshot });
    // Older receipts did not save immutable line items. Explicitly label reconstruction.
    const order = await getPedidoCompleto(row.pedido_id);
    res.json({ pago: row, snapshot: { version: 0, reconstruido: true, pedido: order, created_at: row.created_at,
      monto: Number(row.monto), comprobante_numero: row.comprobante_numero, metodo: row.metodo,
      cliente: { nombre: row.factura_cliente, documento: row.factura_documento },
      desglose: [{ metodo: row.metodo, monto: Number(row.monto), referencia: row.referencia }],
      totales: { total: Number(row.monto), subtotal: Number(row.subtotal), tax: Number(row.iva_declarado) } } });
  } catch (error) { res.status(500).json({ message: error.message }); }
});
router.post('/:id/impresion', async (req, res) => {
  const { estado, error } = req.body;
  if (!['ENVIADO','ERROR'].includes(estado)) return res.status(400).json({ message: 'Estado de impresion invalido.' });
  try {
    const [result] = await pool.query(`UPDATE pagos SET impresion_estado = ?, impresion_intentos = impresion_intentos + 1,
      impresion_error = ?, impresion_at = NOW() WHERE id = ?`, [estado, estado === 'ERROR' ? String(error || 'No se pudo abrir la impresion.').slice(0,255) : null, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Comprobante no encontrado.' });
    res.json({ message: estado === 'ENVIADO' ? 'Enviado al dialogo de impresion; salida fisica no confirmada.' : 'Fallo registrado. Puedes reintentar desde el historial.' });
  } catch (error) { res.status(500).json({ message: error.message }); }
});
export default router;
