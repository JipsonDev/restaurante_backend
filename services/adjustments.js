// Descuentos y cortesías de una cuenta.
// Un ajuste baja el total de la cuenta (pedidos.total). Guarda dos importes:
//   base  = lo que se descuenta del precio de los productos (IVA incluido),
//   monto = base + su parte proporcional del servicio. Es lo que se resta del total.
// Así el comprobante sigue separando bien subtotal, IVA y servicio.
import { pool } from '../db.js';

const cents = (value) => Math.round(Number(value || 0) * 100);
export const ADJUSTMENT_TYPES = ['DESCUENTO', 'CORTESIA'];

let ready;
export function ensureAdjustments(db = pool) {
  if (!ready) ready = db.query(`CREATE TABLE IF NOT EXISTS cuenta_ajustes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id INT NOT NULL,
    tipo VARCHAR(20) NOT NULL,
    detalle_pedido_id INT NULL,
    porcentaje DECIMAL(5,2) NULL,
    base DECIMAL(10,2) NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    motivo VARCHAR(160) NOT NULL,
    trabajador_id INT NULL,
    autorizado_por INT NULL,
    caja_id INT NULL,
    estado VARCHAR(12) NOT NULL DEFAULT 'ACTIVO',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    anulado_at DATETIME NULL,
    INDEX idx_ajustes_pedido (pedido_id, estado),
    INDEX idx_ajustes_caja (caja_id, estado)
  )`).catch((error) => { ready = null; throw error; });
  return ready;
}

const lineCents = (item) => (cents(item.precio) + (item.modificadores || []).reduce((sum, mod) => sum + cents(mod.precio_extra), 0)) * Number(item.cantidad || 0);

/**
 * Calcula un ajuste nuevo sin tocar la base.
 * @param order   cuenta hidratada (items, total, abonado, ajustes activos)
 * @param input   { tipo, porcentaje?, monto?, detalle_pedido_id? }
 * @param servicePercent  porcentaje de servicio del negocio
 */
export function planAdjustment(order, input, servicePercent = 0) {
  const tipo = String(input.tipo || '').toUpperCase();
  if (!ADJUSTMENT_TYPES.includes(tipo)) throw new Error('Tipo de ajuste inválido.');
  const svc = Math.max(0, Number(String(servicePercent ?? 0).replace(',', '.')) || 0) / 100;
  const active = (order.ajustes || []).filter((a) => (a.estado || 'ACTIVO') === 'ACTIVO');
  const courtesyIds = new Set(active.filter((a) => a.tipo === 'CORTESIA').map((a) => Number(a.detalle_pedido_id)));
  const items = (order.items || []).filter((item) => Number(item.cantidad) > 0);
  // Lo que todavía se cobra por productos: sin cortesías ni descuentos anteriores.
  const payableItems = items.filter((item) => !courtesyIds.has(Number(item.id))).reduce((sum, item) => sum + lineCents(item), 0)
    - active.filter((a) => a.tipo === 'DESCUENTO').reduce((sum, a) => sum + cents(a.base), 0);
  let base, porcentaje = null, detalle = null;
  if (tipo === 'CORTESIA') {
    const item = items.find((it) => Number(it.id) === Number(input.detalle_pedido_id));
    if (!item) throw new Error('El plato no pertenece a esta cuenta.');
    if (courtesyIds.has(Number(item.id))) throw new Error('Ese plato ya es cortesía.');
    base = lineCents(item);
    detalle = Number(item.id);
  } else if (input.porcentaje != null && input.porcentaje !== '') {
    porcentaje = Number(String(input.porcentaje).replace(',', '.'));
    if (!Number.isFinite(porcentaje) || porcentaje <= 0 || porcentaje > 100) throw new Error('El porcentaje debe estar entre 1 y 100.');
    base = Math.round(payableItems * porcentaje / 100);
  } else {
    const amount = cents(String(input.monto ?? '').replace(',', '.'));
    if (!(amount > 0)) throw new Error('Escribe el monto del descuento.');
    base = Math.round(amount / (1 + svc));
  }
  if (!(base > 0)) throw new Error('No queda nada que descontar en esta cuenta.');
  if (tipo === 'DESCUENTO' && base > payableItems) throw new Error('El descuento supera lo que falta cobrar.');
  const monto = base + Math.round(base * svc);
  const due = cents(order.total) - cents(order.abonado);
  if (monto > due) throw new Error(`El ajuste (${(monto / 100).toFixed(2)}) supera el saldo pendiente (${(due / 100).toFixed(2)}).`);
  return { tipo, porcentaje, detalle_pedido_id: detalle, base: base / 100, monto: monto / 100 };
}

/** Ajustes activos agrupados por pedido. */
export async function adjustmentsByOrder(ids, db = pool) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    await ensureAdjustments(db);
    const [rows] = await db.query(`SELECT a.id, a.pedido_id, a.tipo, a.detalle_pedido_id, a.porcentaje, a.base, a.monto, a.motivo, a.estado, a.created_at,
        t.nombre AS autorizado_nombre
      FROM cuenta_ajustes a LEFT JOIN trabajadores t ON t.id = a.autorizado_por
      WHERE a.pedido_id IN (?) AND a.estado = 'ACTIVO' ORDER BY a.id`, [ids]);
    for (const row of rows) {
      const key = Number(row.pedido_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ ...row, base: Number(row.base), monto: Number(row.monto), porcentaje: row.porcentaje == null ? null : Number(row.porcentaje) });
    }
  } catch (error) {
    console.error('[ajustes] no se pudieron leer:', error.code || '', error.message);
  }
  return map;
}

/** Totales de descuentos y cortesías de un turno. */
export async function adjustmentTotals(cajaId, db = pool) {
  await ensureAdjustments(db);
  const [[row]] = await db.query(`SELECT
      COALESCE(SUM(CASE WHEN tipo = 'DESCUENTO' THEN monto ELSE 0 END), 0) AS descuentos,
      COALESCE(SUM(CASE WHEN tipo = 'CORTESIA' THEN monto ELSE 0 END), 0) AS cortesias,
      COUNT(*) AS ajustes
    FROM cuenta_ajustes WHERE caja_id = ? AND estado = 'ACTIVO'`, [cajaId]);
  return { descuentos: Number(row.descuentos || 0), cortesias: Number(row.cortesias || 0), ajustes: Number(row.ajustes || 0) };
}
