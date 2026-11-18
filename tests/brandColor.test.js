import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBusinessConfigPatch } from '../services/businessConfigValidation.js';

test('color de marca: código #RRGGBB o vacío', () => {
  assert.deepEqual(normalizeBusinessConfigPatch({ color_marca: '#d63b20' }), { color_marca: '#D63B20' });
  assert.deepEqual(normalizeBusinessConfigPatch({ color_marca: '  ' }), { color_marca: '' });
  assert.throws(() => normalizeBusinessConfigPatch({ color_marca: 'rojo' }), /color de marca/);
  assert.throws(() => normalizeBusinessConfigPatch({ color_marca: '#FFF' }), /color de marca/);
  assert.throws(() => normalizeBusinessConfigPatch({ color_marca: 'url(javascript:1)' }), /color de marca/);
});
