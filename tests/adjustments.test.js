import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdjustment } from '../services/adjustments.js';
import { receiptTotals, expectedCash } from '../services/cashLogic.js';
import { paymentPlan } from '../services/paymentLedger.js';
import { localTodayISO } from '../services/businessTime.js';

// Cuenta de ejemplo: 2 × $10 + 1 × $5 = $25 en productos, 10 % de servicio = $27,50.
const order = (extra = {}) => ({
  total: 27.5, abonado: 0,
  items: [
    { id: 1, cantidad: 2, precio: 10, modificadores: [] },
    { id: 2, cantidad: 1, precio: 4.5, modificadores: [{ precio_extra: 0.5 }] },
  ],
  ...extra,
});

test('cortesía de un plato descuenta su línea más su parte de servicio', () => {
  const plan = planAdjustment(order(), { tipo: 'CORTESIA', detalle_pedido_id: 2 }, 10);
  assert.deepEqual(plan, { tipo: 'CORTESIA', porcentaje: null, detalle_pedido_id: 2, base: 5, monto: 5.5 });
});

test('descuento por porcentaje se calcula sobre lo que aún se cobra', () => {
  const first = planAdjustment(order(), { tipo: 'DESCUENTO', porcentaje: 10 }, 10);
  assert.equal(first.base, 2.5);
  assert.equal(first.monto, 2.75);
  // Con el plato 2 ya en cortesía, el 10 % es sobre $20.
  const withCourtesy = order({ total: 22, ajustes: [{ tipo: 'CORTESIA', detalle_pedido_id: 2, base: 5, monto: 5.5, estado: 'ACTIVO' }] });
  assert.equal(planAdjustment(withCourtesy, { tipo: 'DESCUENTO', porcentaje: 10 }, 10).base, 2);
});

test('descuento por monto se toma como importe final (servicio incluido)', () => {
  const plan = planAdjustment(order(), { tipo: 'DESCUENTO', monto: '5,50' }, 10);
  assert.equal(plan.monto, 5.5);
  assert.equal(plan.base, 5);
});

test('un ajuste no puede dejar la cuenta por debajo de lo ya pagado', () => {
  assert.throws(() => planAdjustment(order({ abonado: 25 }), { tipo: 'DESCUENTO', porcentaje: 50 }, 10), /supera el saldo/);
  assert.throws(() => planAdjustment(order(), { tipo: 'CORTESIA', detalle_pedido_id: 99 }, 10), /no pertenece/);
  assert.throws(() => planAdjustment(order({ ajustes: [{ tipo: 'CORTESIA', detalle_pedido_id: 1, base: 20, monto: 22, estado: 'ACTIVO' }] }), { tipo: 'CORTESIA', detalle_pedido_id: 1 }, 10), /ya es cortesía/);
  assert.throws(() => planAdjustment(order(), { tipo: 'DESCUENTO', porcentaje: 0 }, 10), /porcentaje/);
});

test('el comprobante separa bien IVA y servicio después de un descuento', () => {
  // Sin ajustes: productos $25 (IVA 15 % incluido) + servicio $2,50.
  const plain = receiptTotals(order(), 15);
  assert.equal(plain.service, 2.5);
  assert.equal(plain.total, 27.5);
  // Cortesía del plato de $5: productos $20, servicio $2.
  const comped = receiptTotals(order({ total: 22, ajustes_base: 5 }), 15);
  assert.equal(comped.service, 2);
  assert.equal(Math.round((comped.subtotal + comped.tax) * 100), 2000);
});

test('la propina en efectivo debe cubrirse con el efectivo recibido y va aparte del cobro', () => {
  const plan = paymentPlan({ monto: 27.5, metodo: 'Efectivo', efectivo_recibido: 30, propina: 2.5 }, 27.5, 0);
  assert.equal(plan.amount, 27.5);
  assert.equal(plan.tip, 2.5);
  assert.equal(plan.tipMethod, 'Efectivo');
  assert.equal(plan.change, 0);
  assert.throws(() => paymentPlan({ monto: 27.5, metodo: 'Efectivo', efectivo_recibido: 28, propina: 2.5 }, 27.5, 0), /insuficiente/);
  const card = paymentPlan({ monto: 27.5, metodo: 'Tarjeta', propina: 3 }, 27.5, 0);
  assert.equal(card.tipMethod, 'Tarjeta');
  assert.equal(card.received, 0);
});

test('las propinas en efectivo cuentan en el efectivo esperado del cajón', () => {
  assert.equal(expectedCash(20, { efectivo: 100, propinas_efectivo: 5, ingresos_efectivo: 0, retiros_efectivo: 10, gastos_efectivo: 0 }), 115);
});

test('el día del negocio es el de Ecuador aunque en UTC ya sea mañana', () => {
  // 21:30 en Ecuador = 02:30 UTC del día siguiente.
  assert.equal(localTodayISO(new Date('2026-11-17T02:30:00Z')), '2026-11-16');
  assert.equal(localTodayISO(new Date('2026-11-17T05:30:00Z')), '2026-11-17');
});
