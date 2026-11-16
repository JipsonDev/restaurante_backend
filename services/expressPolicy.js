export function requireExpressPayment(order, next) {
  if (next === 'ENTREGADO' && !order.mesa_id && order.estado !== 'PAGADO') {
    throw new Error('Cobra el total del pedido Express o Delivery en caja antes de entregarlo. Un abono no completa el pago.');
  }
}

export function historyDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Indica una fecha valida: AAAA-MM-DD.');
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Fecha invalida.');
  return value;
}
