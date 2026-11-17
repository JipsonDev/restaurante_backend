import { cashAmount, validateMethod } from './cashLogic.js';
import { fromLocalDay, toLocalDayEnd } from './businessTime.js';

export function paymentError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export const cents = (value) => Math.round(Number(value || 0) * 100);
export function paymentPlan(body, total, paid = 0) {
  const due = cents(total) - cents(paid);
  const amount = cashAmount(body.monto, { positive: true });
  if (due <= 0 || cents(amount) > due) throw paymentError('El monto supera el saldo pendiente. Actualiza la cuenta.', 409);
  if (!body.parcial && cents(amount) !== due) throw paymentError('El cobro debe cubrir el saldo o indicarse como pago parcial.');
  const input = body.metodo === 'Mixto' ? body.desglose : [{ metodo: body.metodo || 'Efectivo', monto: amount, referencia: body.referencia }];
  if (!Array.isArray(input) || !input.length || input.length > 6 || (body.metodo === 'Mixto' && input.length < 2)) throw paymentError('El pago mixto requiere un desglose de al menos dos metodos.');
  const methods = new Set();
  const parts = input.map((part) => {
    validateMethod(part.metodo);
    if (methods.has(part.metodo)) throw paymentError('No repitas un metodo en el desglose.');
    methods.add(part.metodo);
    return { metodo: part.metodo, monto: cashAmount(part.monto, { positive: true }), referencia: String(part.referencia || '').trim().slice(0, 255) || null };
  });
  if (parts.reduce((sum, p) => sum + cents(p.monto), 0) !== cents(amount)) throw paymentError('El desglose debe sumar exactamente el monto a cobrar.');
  const cash = parts.find((p) => p.metodo === 'Efectivo')?.monto || 0;
  // Propina: va aparte del total de la cuenta. Si se deja en efectivo, el efectivo recibido también la cubre.
  const tip = body.propina == null || body.propina === '' ? 0 : cashAmount(body.propina);
  const tipMethod = tip > 0 ? (body.propina_metodo || (body.metodo === 'Mixto' ? 'Efectivo' : (body.metodo || 'Efectivo'))) : null;
  if (tipMethod) validateMethod(tipMethod);
  if (cents(tip) > cents(amount) * 2 + 2000) throw paymentError('La propina parece demasiado alta. Revisa el monto.');
  const cashNeeded = cents(cash) + (tipMethod === 'Efectivo' ? cents(tip) : 0);
  const received = cashNeeded ? cashAmount(body.efectivo_recibido ?? cashNeeded / 100) : 0;
  if (cents(received) < cashNeeded) throw paymentError('El efectivo recibido es insuficiente.');
  return { amount, parts, received, change: (cents(received) - cashNeeded) / 100, paidBefore: cents(paid) / 100,
    remaining: (due - cents(amount)) / 100, complete: cents(amount) === due, tip, tipMethod };
}

export function historyFilters(query) {
  const where = [], args = [];
  const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (query.desde) { if (!date(query.desde)) throw paymentError('Fecha inicial invalida (AAAA-MM-DD).'); where.push(`pg.created_at >= ${fromLocalDay()}`); args.push(query.desde); }
  if (query.hasta) { if (!date(query.hasta)) throw paymentError('Fecha final invalida (AAAA-MM-DD).'); where.push(`pg.created_at < ${toLocalDayEnd()}`); args.push(query.hasta); }
  if (query.desde && query.hasta && query.desde > query.hasta) throw paymentError('La fecha inicial no puede ser posterior a la final.');
  if (query.q) { const q = `%${String(query.q).trim().slice(0,160)}%`; where.push('(pg.comprobante_numero LIKE ? OR pg.factura_cliente LIKE ? OR pg.factura_documento LIKE ? OR p.cliente_nombre LIKE ?)'); args.push(q,q,q,q); }
  if (query.metodo) { if (query.metodo !== 'Mixto') validateMethod(query.metodo); where.push('(pg.metodo = ? OR EXISTS (SELECT 1 FROM pago_desglose pd WHERE pd.pago_id = pg.id AND pd.metodo = ?))'); args.push(query.metodo,query.metodo); }
  if (query.estado) { if (!['ACTIVO','ANULADO','DEVUELTO'].includes(query.estado)) throw paymentError('Estado invalido.'); where.push("COALESCE(pg.estado, 'ACTIVO') = ?"); args.push(query.estado); }
  if (query.cajero_id) { if (!/^\d+$/.test(String(query.cajero_id)) || Number(query.cajero_id) <= 0) throw paymentError('Cajero invalido.'); where.push('COALESCE(pg.trabajador_id, c.trabajador_id) = ?'); args.push(Number(query.cajero_id)); }
  const page = Number(query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw paymentError('Pagina invalida.');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args, page, limit: 20, offset: (page-1)*20 };
}

export function parseSnapshot(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export async function requireUnpaidMutation(conn, ids) {
  const [rows] = await conn.query("SELECT id FROM pagos WHERE pedido_id IN (?) AND COALESCE(estado, 'ACTIVO') = 'ACTIVO' LIMIT 1", [ids]);
  if (rows.length) throw paymentError('La cuenta tiene abonos. Anula o devuelve esos pagos antes de cambiar sus productos o su reparto.', 409);
}

// Allocate each abono over the remaining base, tax and service in cents. Reversals
// remove their original allocation, so the last abono always consumes the exact remainder.
export function allocatePayment(receipt, amount, prior = {}) {
  const keys = ['subtotal','tax','service'];
  const weights = keys.map(key => Math.max(0, cents(receipt[key]) - cents(prior[key])));
  const remaining = weights.reduce((a,b) => a+b,0), target = cents(amount);
  if (!remaining || target > remaining) throw paymentError('Los importes de la cuenta cambiaron. Revisa sus abonos.',409);
  const values = weights.map(weight => Math.floor(target * weight / remaining));
  const rank = weights.map((weight,i) => ({ i, remainder: target * weight % remaining })).sort((a,b) => b.remainder-a.remainder || a.i-b.i);
  for (let left = target-values.reduce((a,b)=>a+b,0),i=0; left>0; left--,i++) values[rank[i].i]++;
  return Object.fromEntries(keys.map((key,i) => [key,values[i]/100]));
}
