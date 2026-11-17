import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeJunk, reviewBusiness, reviewProducts } from '../services/dataReview.js';

test('detecta nombres escritos al azar sin marcar nombres reales', () => {
  for (const junk of ['asdsadasd', 'qwerty', 'TEST', 'xxxx', 'sdfgh', 'prueba']) assert.equal(looksLikeJunk(junk), true, junk);
  for (const real of ['Andrea', 'María José', 'Seco de pollo', 'Café pasado manabita', 'Mesa 7', 'Tigrillo zarumeño', 'Luis']) assert.equal(looksLikeJunk(real), false, real);
});

test('agrupa productos repetidos y marca precios fuera de lo normal', () => {
  const products = [
    { id: 1, nombre: 'Cappuccino', precio: 2.75, categoria_id: 1 }, { id: 2, nombre: 'cappuccino ', precio: 48, categoria_id: 1 },
    { id: 3, nombre: 'Café americano', precio: 1.8, categoria_id: 1 }, { id: 4, nombre: 'Latte', precio: 3.1, categoria_id: 1 },
    { id: 5, nombre: 'Agua', precio: 0, categoria_id: 2 },
  ];
  const review = reviewProducts(products);
  assert.deepEqual(review.duplicados.map((g) => g.productos.map((p) => p.id)), [[1, 2]]);
  assert.deepEqual(review.precios.map((p) => p.id).sort(), [2, 5]);
});

test('el RUC debe tener 13 dígitos y los datos del negocio no deben ser de prueba', () => {
  assert.deepEqual(reviewBusiness({ ruc: 'asdsad', direccion: 'sadasd', nombre_restaurante: 'Morena Mia' }).map((i) => i.campo), ['ruc', 'direccion']);
  assert.deepEqual(reviewBusiness({ ruc: '1391234567001', direccion: 'Av. Amazonas y Bolívar, Chone' }), []);
});
