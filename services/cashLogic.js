export const PAYMENT_METHODS = ['Efectivo', 'Tarjeta', 'Transferencia', 'QR', 'Vales', 'Otro'];

export function cashAmount(value, { positive = false } = {}) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : '';
  const number = Number(text);
  const cents = Math.round(number * 100);
  if (!text || !/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(number) || cents > 9999999999 ||
      Math.abs(number * 100 - cents) > 0.000001 || (positive && cents <= 0)) {
    const error = new Error('Ingresa un monto valido, sin negativos y con maximo dos decimales.');
    error.statusCode = 400;
    throw error;
  }
  return cents / 100;
}

export function validateMethod(method) {
  if (!PAYMENT_METHODS.includes(method)) {
    const error = new Error(method === 'Mixto' ? 'El pago mixto requiere un desglose por metodo.' : 'Metodo de pago invalido.');
    error.statusCode = 400;
    throw error;
  }
}

export function expectedCash(initial, totals) {
  // Reversed payments are already excluded from active sales. Never deduct them again.
  // Las propinas en efectivo también están en el cajón (hasta entregarlas a los meseros).
  return [initial, totals.efectivo, totals.ingresos_efectivo, totals.propinas_efectivo, -Number(totals.retiros_efectivo || 0), -Number(totals.gastos_efectivo || 0)]
    .reduce((cents, value) => cents + Math.round(Number(value || 0) * 100), 0) / 100;
}

export function receiptTotals(order, percent = 0) {
  const rate = Math.max(0, Number(String(percent ?? 0).replace(',', '.')) || 0) / 100;
  const totalCents = Math.round(Number(order.total || 0) * 100);
  const itemsCents = (order.items || []).reduce((sum, item) => sum + Math.round((Number(item.precio || 0) +
    (item.modificadores || []).reduce((extra, mod) => extra + Number(mod.precio_extra || 0), 0)) * 100) * Number(item.cantidad || 0), 0);
  // Descuentos y cortesías bajan la parte de productos; el servicio es lo que queda.
  const productCents = Math.max(0, itemsCents - Math.round(Number(order.ajustes_base || 0) * 100));
  const serviceCents = Math.max(0, totalCents - productCents);
  const subtotalCents = Math.round((totalCents - serviceCents) / (1 + rate));
  return { subtotal: subtotalCents / 100, tax: (totalCents - serviceCents - subtotalCents) / 100,
    service: serviceCents / 100, total: totalCents / 100, taxPercent: rate * 100 };
}
