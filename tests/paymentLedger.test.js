import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentPlan, historyFilters, allocatePayment } from '../services/paymentLedger.js';

test('mixed tender rejects malformed, duplicate, negative, fractional and unbalanced components',()=>{
  const body={metodo:'Mixto',monto:10};
  for(const parts of [null,[],[{metodo:'Efectivo',monto:10}], [{metodo:'Efectivo',monto:5},{metodo:'Efectivo',monto:5}], [{metodo:'Efectivo',monto:3},{metodo:'Tarjeta',monto:6}], [{metodo:'Efectivo',monto:-1},{metodo:'Tarjeta',monto:11}], [{metodo:'Efectivo',monto:1.005},{metodo:'Tarjeta',monto:8.995}], [{metodo:'Mixto',monto:5},{metodo:'QR',monto:5}]]) assert.throws(()=>paymentPlan({...body,desglose:parts},10));
  assert.throws(()=>paymentPlan({...body,desglose:[{metodo:'Efectivo',monto:5},{metodo:'QR',monto:5}],efectivo_recibido:4},10));
});
test('cent-sized remaining balance cannot be lost or collected twice',()=>{
  assert.equal(paymentPlan({metodo:'Efectivo',monto:0.01},10,9.99).complete,true);
  assert.throws(()=>paymentPlan({metodo:'Efectivo',monto:0.02},10,9.99));
  assert.throws(()=>paymentPlan({metodo:'Efectivo',monto:1},10,10));
  assert.throws(()=>paymentPlan({metodo:'Efectivo',monto:5},10));
});
test('history filters validate dates and pagination and keep search out of SQL text',()=>{
  for(const q of [{desde:'2026-02-30'},{desde:'2026-09-11',hasta:'2026-09-10'},{page:0},{page:'1 OR 1=1'},{estado:'todo'},{cajero_id:-1}]) assert.throws(()=>historyFilters(q));
  const filter=historyFilters({q:"' OR 1=1 --",desde:'2026-09-01',hasta:'2026-09-11',page:3,metodo:'Tarjeta',cajero_id:'2'});
  assert.equal(filter.offset,40);assert.ok(!filter.sql.includes("' OR 1=1 --"));assert.ok(filter.args.includes("%' OR 1=1 --%"));
});

test('reversed cent allocations are restored without losing tax or subtotal on final settlement',()=>{
  const receipt={subtotal:0.02,tax:0.01,service:0};
  const first=allocatePayment(receipt,0.01);
  const second=allocatePayment(receipt,0.01,first);
  const totals=Object.fromEntries(['subtotal','tax','service'].map(k=>[k,first[k]+second[k]]));
  const third=allocatePayment(receipt,0.01,totals);
  // Void the second payment, then collect its amount again.
  const afterVoid=Object.fromEntries(['subtotal','tax','service'].map(k=>[k,first[k]+third[k]]));
  const replacement=allocatePayment(receipt,0.01,afterVoid);
  for(const key of ['subtotal','tax','service'])assert.equal(Math.round((afterVoid[key]+replacement[key])*100),Math.round(receipt[key]*100));
});
