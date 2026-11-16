import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
mock.module('../db.js', { namedExports: { pool: {} } });
const { aggregateRequirements } = await import('../services/stockReservations.js');
test('reservation combines variants and shared ingredients with millesimal precision and stable lock order', () => {
  assert.deepEqual(aggregateRequirements([
    {tipo:'INSUMO',recurso_id:2,cantidad:0.1}, {tipo:'PRODUCTO',recurso_id:5,cantidad:1},
    {tipo:'INSUMO',recurso_id:2,cantidad:0.2}, {tipo:'INSUMO',recurso_id:1,cantidad:0.001},
  ]), [ {tipo:'PRODUCTO',recurso_id:5,units:1000}, {tipo:'INSUMO',recurso_id:1,units:1}, {tipo:'INSUMO',recurso_id:2,units:300} ]);
});
test('invalid quantities cannot create a reservation', () => {
  for (const cantidad of [0, -1, NaN, Infinity, 1e20]) assert.throws(() => aggregateRequirements([{tipo:'INSUMO',recurso_id:1,cantidad}]));
});
