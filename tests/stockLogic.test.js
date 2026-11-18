import test from 'node:test';
import assert from 'node:assert/strict';
import { alertMessage, diffStock, itemLevel } from '../services/stockLogic.js';

test('nivel de un insumo: bajo el mínimo, agotado o bien', () => {
  assert.equal(itemLevel({ stock: 10, stock_reservado: 2, stock_minimo: 5, usado: 1 }), null);
  assert.equal(itemLevel({ stock: 6, stock_reservado: 1, stock_minimo: 5, usado: 1 }), 'BAJO'); // 5 disponibles = mínimo
  assert.equal(itemLevel({ stock: 3, stock_reservado: 3, stock_minimo: 5 }), 'AGOTADO'); // todo comprometido
  assert.equal(itemLevel({ stock: 0, stock_reservado: 0, stock_minimo: 0, usado: 0 }), null); // nadie lo usa: no molesta
  assert.equal(itemLevel({ stock: 0, stock_reservado: 0, stock_minimo: 0, usado: 1 }), 'AGOTADO');
  assert.equal(itemLevel({ stock: '0.3', stock_reservado: '0.1', stock_minimo: '0.5', usado: 1 }), 'BAJO');
});

test('avisa una sola vez, sube de «bajo» a «agotado» y se limpia al reponer', () => {
  const items = [{ id: 1, nombre: 'Leche', unidad: 'l', stock: 2, stock_reservado: 0, stock_minimo: 3, usado: 1 }];
  const products = [{ id: 10, nombre: 'Cappuccino', agotado: 0, disponible: 8 }];
  let r = diffStock({ products, items, alerts: new Map(), lastSellable: null });
  assert.deepEqual(r.raised, [{ key: 'INSUMO:1', level: 'BAJO' }]);
  assert.deepEqual(r.stockChanges, []); // primera vez: no hay con qué comparar

  r = diffStock({ products, items, alerts: r.current, lastSellable: r.sellable });
  assert.deepEqual(r.raised, []); // ya avisado

  const out = [{ ...items[0], stock: 0.2, stock_reservado: 0.2 }];
  const zero = [{ ...products[0], disponible: 0 }];
  const r2 = diffStock({ products: zero, items: out, alerts: r.current, lastSellable: r.sellable });
  assert.deepEqual(r2.raised.map(x => x.key).sort(), ['INSUMO:1', 'PRODUCTO:10']);
  assert.deepEqual(r2.stockChanges, [{ producto_id: 10, nombre: 'Cappuccino', stock_disponible: 0 }]);

  const refill = [{ ...items[0], stock: 1, stock_reservado: 0 }];
  const r3 = diffStock({ products: [{ ...products[0], disponible: 5 }], items: refill, alerts: r2.current, lastSellable: r2.sellable });
  assert.deepEqual(r3.raised, []); // de agotado a bajo: sin aviso nuevo
  assert.deepEqual(r3.updated, [{ key: 'INSUMO:1', level: 'BAJO' }]);
  assert.deepEqual(r3.cleared, [{ key: 'PRODUCTO:10' }]);
  assert.equal(r3.stockChanges[0].stock_disponible, 5);

  const r4 = diffStock({ products, items: [{ ...items[0], stock: 20 }], alerts: r3.current, lastSellable: r3.sellable });
  assert.deepEqual(r4.cleared, [{ key: 'INSUMO:1' }]);
});

test('un plato agotado a mano por cocina no genera aviso de inventario', () => {
  const r = diffStock({ products: [{ id: 5, nombre: 'Ceviche', agotado: 1, disponible: 0 }], items: [], alerts: new Map() });
  assert.deepEqual(r.raised, []);
});

test('texto del aviso', () => {
  const items = [
    { id: 1, nombre: 'Leche', unidad: 'l', stock: 0, stock_reservado: 0 },
    { id: 2, nombre: 'Pollo', unidad: 'kg', stock: 1.5, stock_reservado: 0 },
    { id: 3, nombre: 'Pan', unidad: 'unidad', stock: 4, stock_reservado: 0 },
  ];
  const products = [{ id: 10, nombre: 'Cappuccino' }, { id: 11, nombre: 'Latte' }];
  const m = alertMessage([{ key: 'INSUMO:1', level: 'AGOTADO' }, { key: 'INSUMO:2', level: 'BAJO' }, { key: 'INSUMO:3', level: 'BAJO' }, { key: 'PRODUCTO:10', level: 'AGOTADO' }, { key: 'PRODUCTO:11', level: 'AGOTADO' }], { items, products });
  assert.equal(m.title, 'Inventario: se acabó Leche');
  assert.equal(m.body, 'Se acabó: Leche. Queda poco: Pollo (1,5 kg), Pan (4 u). Sin stock: Cappuccino, Latte.');
  assert.equal(alertMessage([{ key: 'INSUMO:2', level: 'BAJO' }], { items }).title, 'Inventario: queda poco Pollo');
  assert.equal(alertMessage([{ key: 'PRODUCTO:10', level: 'AGOTADO' }], { products }).title, 'Sin stock: Cappuccino');
  assert.equal(alertMessage([], { items }), null);
});
