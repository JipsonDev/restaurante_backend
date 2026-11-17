import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const { tableToken, parseTableToken, publicMenu, publicProduct } = await import('../services/publicMenu.js');

test('el código de mesa va firmado y no se puede inventar', () => {
  const token = tableToken(5);
  assert.match(token, /^5-[a-f0-9]{10}$/);
  assert.equal(parseTableToken(token), 5);
  assert.equal(parseTableToken(token.replace(/^5-/, '6-')), null);
  assert.equal(parseTableToken('5-0000000000'), null);
  assert.equal(parseTableToken('5'), null);
  assert.equal(parseTableToken(''), null);
  assert.equal(parseTableToken(undefined), null);
  assert.throws(() => tableToken(0));
  assert.notEqual(tableToken(5), tableToken(15));
});

test('el menú público no expone costos ni existencias', () => {
  const row = { id: 3, nombre: ' Café ', descripcion: '', precio: '1.50', imagen_url: '/uploads/a.jpg', agotado: 1, categoria_nombre: 'Bebidas', stock: 4, costo: 0.4, inventario_item_id: 9 };
  assert.deepEqual(publicProduct(row), { id: 3, nombre: 'Café', descripcion: null, precio: 1.5, imagen_url: '/uploads/a.jpg', categoria: 'Bebidas', agotado: true });
  const menu = publicMenu([row, { id: 4, nombre: 'Torta', precio: 3, categoria_nombre: null }, { id: 5, nombre: '  ', precio: 1 }]);
  assert.deepEqual(menu.categorias, ['Bebidas', 'Otros']);
  assert.equal(menu.productos.length, 2);
});
