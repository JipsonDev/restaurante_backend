import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBusinessConfigPatch } from '../services/businessConfigValidation.js';

test('business configuration normalizes percentages, currency and contact data', () => {
  assert.deepEqual(normalizeBusinessConfigPatch({
    nombre_restaurante: '  Morena Mia  ', iva_porcentaje: '15,5', servicio_porcentaje: '0', moneda: 'usd',
    correo: ' FACTURAS@MORENAMIA.COM ', telefono: '+593 99 123 4567', ruc: '0999999999001', desconocido: 'ignorado',
  }), {
    nombre_restaurante: 'Morena Mia', iva_porcentaje: '15.5', servicio_porcentaje: '0', moneda: 'USD',
    correo: 'facturas@morenamia.com', telefono: '+593 99 123 4567', ruc: '0999999999001',
  });
});

test('business configuration rejects values that would corrupt billing or identity', () => {
  assert.throws(() => normalizeBusinessConfigPatch({ iva_porcentaje: '101' }), /entre 0 y 100/);
  assert.throws(() => normalizeBusinessConfigPatch({ servicio_porcentaje: '-1' }), /entre 0 y 100/);
  assert.throws(() => normalizeBusinessConfigPatch({ moneda: '$' }), /tres letras/);
  assert.throws(() => normalizeBusinessConfigPatch({ correo: 'correo-invalido' }), /no es válido/);
  assert.throws(() => normalizeBusinessConfigPatch({ ruc: '123' }), /10 y 13/);
  assert.throws(() => normalizeBusinessConfigPatch({ nombre_restaurante: ' ' }), /obligatorio/);
});
