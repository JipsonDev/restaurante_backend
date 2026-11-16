import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderTracking, migrateRoundAttribution } from '../services/orderTracking.js';

const order = { id: 12, mesero_id: 1, mesero_nombre: 'Asignado', created_at: '2026-10-17T12:00:00Z', rondas: [
  { id: 30, pedido_origen_id: 12, creado_por: 2, creado_por_nombre: 'Ana', created_at: '2026-10-17T12:00:00Z', estado: 'ENTREGADO', entregado_at: '2026-10-17T12:20:00Z', entregado_por: 3, entregado_por_nombre: 'Luis', items: [{ cantidad: 1, nombre: 'Café' }] },
  { id: 31, pedido_origen_id: 12, creado_por: 4, creado_por_nombre: 'María', created_at: '2026-10-17T12:10:00Z', estado: 'LISTO', items: [] },
] };
test('tracking identifies the taker, additional round author, delivery person and every payment actor', () => {
  const result = buildOrderTracking(order, [], [{ id: 9, trabajador_id: 5, trabajador_nombre: 'Caja Ana', monto: 3, metodo: 'Efectivo', estado: 'ACTIVO', created_at: '2026-10-17T12:15:00Z' }, { id: 10, trabajador_id: 6, trabajador_nombre: 'Caja Luis', monto: 4, metodo: 'Tarjeta', estado: 'ANULADO', created_at: '2026-10-17T12:25:00Z' }]);
  assert.equal(result.events.find(e => e.tipo === 'pedido_tomado').actor.nombre, 'Ana');
  assert.equal(result.events.find(e => e.tipo === 'ronda_enviada' && e.ronda_id === 31).actor.nombre, 'María');
  assert.equal(result.events.find(e => e.tipo === 'ronda_entregada').actor.nombre, 'Luis');
  assert.deepEqual(result.events.filter(e => e.tipo === 'cobro').map(e => [e.actor.nombre,e.monto,e.estado]), [['Caja Ana',3,'ACTIVO'],['Caja Luis',4,'ANULADO']]);
});
test('legacy actions use specific audit evidence and ignore duplicate delivery confirmations', () => {
  const legacy = { ...order, rondas: [{ id: 30, created_at: order.created_at, estado: 'ENTREGADO', entregado_at: '2026-10-17T12:20:00Z', items: [] }] };
  const audit = [
    { id: 1, entidad: 'pedido', entidad_id:12, accion: 'pedido.creado', trabajador_id:2, trabajador_nombre:'Ana', metadata: {ronda_id:30} },
    { id: 2, entidad:'ronda', entidad_id:30, accion:'ronda.estado_actualizado', trabajador_id:3, trabajador_nombre:'Luis', metadata:{before:'LISTO',after:'ENTREGADO'} },
    { id: 3, entidad:'ronda', entidad_id:30, accion:'ronda.estado_actualizado', trabajador_id:4, trabajador_nombre:'Reintento', metadata:{before:'ENTREGADO',after:'ENTREGADO'} },
  ];
  const events = buildOrderTracking(legacy,audit,[]).events;
  assert.equal(events.find(e=>e.tipo==='pedido_tomado').actor.nombre,'Ana');
  assert.equal(events.find(e=>e.tipo==='ronda_entregada').actor.nombre,'Luis');
});
test('missing history never assigns a round or a payment to the waiter or owner of the cash register', () => {
  const legacy = { ...order, rondas:[{id:30,created_at:order.created_at,estado:'ENTREGADO',entregado_at:'2026-10-17T12:20:00Z'}] };
  const result=buildOrderTracking(legacy,[],[{id:1,caja_trabajador_id:99,caja_trabajador_nombre:'Dueño de caja',monto:7}]);
  assert.ok(result.events.every(e=>e.actor.id===null));
  assert.ok(result.events.every(e=>e.actor.nombre==='Usuario no registrado'));
  assert.equal(result.mesero_asignado.nombre,'Asignado');
});
test('merged rounds retain their original account and cannot replace the taker of the surviving account', () => {
  const merged={...order,rondas:[{...order.rondas[0],id:29,pedido_origen_id:9,creado_por_nombre:'Otra cuenta'},...order.rondas]};
  const events=buildOrderTracking(merged,[],[]).events;
  assert.equal(events.find(e=>e.tipo==='pedido_tomado').actor.nombre,'Ana');
  assert.equal(events.find(e=>e.tipo==='ronda_enviada'&&e.ronda_id===29).pedido_origen_id,9);
});
test('attribution migration is repeatable and leaves historical rows without invented users', async () => {
  const columns=new Set(), calls=[];
  const db={query:async sql=>{calls.push(sql);if(sql.startsWith('SHOW COLUMNS'))return [[...columns].map(Field=>({Field}))];for(const field of ['creado_por','creado_por_nombre','entregado_por','entregado_por_nombre','pedido_origen_id'])if(sql.includes(`ADD COLUMN ${field} `))columns.add(field);return [[]];}};
  await migrateRoundAttribution(db);await migrateRoundAttribution(db);
  assert.equal(columns.size,5);
  assert.equal(calls.filter(sql=>sql.startsWith('ALTER TABLE')).length,1);
  assert.ok(!calls.some(sql=>sql.startsWith('UPDATE')));
});

test('tracking exposes responsible users and actions without leaking audit or invoice fields',()=>{
  const result=buildOrderTracking(order,[{id:1,entidad:'pedido',entidad_id:12,accion:'pedido.creado',trabajador_id:2,metadata:{ronda_id:30,actor_nombre:'Ana',factura_documento:'PRIVATE-DOCUMENT'}}],[{id:7,monto:7,trabajador_id:3,trabajador_nombre:'Caja',referencia:'PRIVATE-BANK-REFERENCE',comprobante_snapshot:{cliente:{documento:'PRIVATE-INVOICE'}}}]);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE-/);
});
