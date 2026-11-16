import test from 'node:test';
import assert from 'node:assert/strict';
import { delayLimits, overdueRound, claimDelayAlerts, listDelayAlerts } from '../services/serviceAlerts.js';
import { normalizeBusinessConfigPatch } from '../services/businessConfigValidation.js';

const round = { ronda_id: 8, pedido_id: 2, estado: 'PREPARANDO', espera_segundos: 1200, lista_segundos: null };
test('delay thresholds include the exact boundary and start a separate phase when ready', () => {
  const limits = delayLimits({});
  assert.equal(overdueRound({ ...round, espera_segundos: 1199 }, limits), null);
  assert.equal(overdueRound(round, limits).tipo, 'espera');
  assert.equal(overdueRound({ ...round, estado: 'LISTO', lista_segundos: 299 }, limits), null);
  assert.equal(overdueRound({ ...round, estado: 'LISTO', lista_segundos: 300 }, limits).tipo, 'lista');
});
test('closed, disabled and untrustworthy round timestamps never generate alerts', () => {
  const limits = delayLimits({});
  for (const state of ['ENTREGADO', 'CANCELADO']) assert.equal(overdueRound({ ...round, estado: state }, limits), null);
  for (const seconds of [null, -1, NaN]) assert.equal(overdueRound({ ...round, espera_segundos: seconds }, limits), null);
  assert.equal(overdueRound({ ...round, estado: 'LISTO', lista_segundos: null }, limits), null);
  assert.equal(overdueRound({ ...round, estado: 'LISTO', lista_segundos: 1300 }, limits), null);
  assert.equal(overdueRound(round, delayLimits({ alertas_demora_activas: '0' })), null);
});
test('configuration only accepts whole minutes from 1 to 240 and an explicit boolean flag', () => {
  assert.equal(normalizeBusinessConfigPatch({ alerta_lista_minutos: ' 12 ' }).alerta_lista_minutos, '12');
  for (const value of ['0', '-1', '1.5', '241', '', 'Infinity']) assert.throws(() => normalizeBusinessConfigPatch({ alerta_espera_minutos: value }), /1 y 240/);
  assert.throws(() => normalizeBusinessConfigPatch({ alertas_demora_activas: 'true' }), /0 o 1/);
});

// Two independent connections share a ledger and a per-worker transaction lock.
// This models simultaneous browser tabs/devices without creating restaurant data.
function fixture() {
  let tail = Promise.resolve(), records = [{ id: 10, ronda_id: 8, tipo: 'espera', avisado_at: null }], cooldown = null;
  let active = true, rounds = [round], settings = [];
  const db = () => { let unlock; return {
    async beginTransaction() {}, async commit() { unlock?.(); }, async rollback() { unlock?.(); }, release() {},
    async query(sql, args) {
      if (sql.includes('FROM trabajadores')) { const before = tail; tail = new Promise(resolve => { unlock = resolve; }); await before; return [[{ id: args[0] }]]; }
      if (sql.includes('FROM configuracion_negocio')) return [settings];
      if (sql.includes('FROM pedido_rondas r')) { assert.match(sql,/p.mesero_id=\?/); assert.equal(args.length,1); return [active ? rounds : []]; }
      if (sql.includes('INSERT IGNORE')) return [{ affectedRows: 0 }];
      if (sql.includes('MAX(avisado_at)')) return [[{ segundos: cooldown }]];
      if (sql.includes('SELECT id,ronda_id,tipo,avisado_at')) return [records.map(row => ({ ...row }))];
      if (sql.includes('UPDATE ronda_alertas')) { records = records.map(row => args[1].includes(row.id) ? { ...row, avisado_at: 'now' } : row); cooldown = 0; return [{ affectedRows: 1 }]; }
      throw new Error(sql);
    },
  }; };
  return { pool: { getConnection: async () => db() }, db: db(), setActive: value => { active = value; }, setCooldown: value => { cooldown = value; }, setRounds:value=>{rounds=value;},setRecords:value=>{records=value;},setSettings:value=>{settings=Object.entries(value).map(([clave,valor])=>({clave,valor}));} };
}
test('a phase is claimed once across simultaneous devices and reloads', async () => {
  const f = fixture();
  const results = await Promise.all([claimDelayAlerts(f.pool, 4, [10]), claimDelayAlerts(f.pool, 4, [10])]);
  assert.equal(results.flatMap(result => result.ids).length, 1);
  assert.deepEqual((await claimDelayAlerts(f.pool, 4, [10])).ids, []);
});
test('group cooldown defers notices and resolved rounds or unknown IDs cannot be claimed', async () => {
  const f = fixture(); f.setCooldown(119);
  assert.deepEqual((await claimDelayAlerts(f.pool, 4, [10])).ids, []);
  f.setCooldown(120);
  assert.deepEqual((await claimDelayAlerts(f.pool, 4, [99])).ids, []);
  f.setActive(false);
  assert.deepEqual((await claimDelayAlerts(f.pool, 4, [10])).ids, []);
});

test('a ready phase may notify after the waiting phase, only after the group cooldown',async()=>{
  const f=fixture();
  await claimDelayAlerts(f.pool,4,[10]);
  f.setRounds([{...round,estado:'LISTO',lista_segundos:300}]);
  f.setRecords([{id:10,ronda_id:8,tipo:'espera',avisado_at:'previous'},{id:11,ronda_id:8,tipo:'lista',avisado_at:null}]);
  assert.deepEqual((await claimDelayAlerts(f.pool,4,[11])).ids,[]);
  f.setCooldown(120);
  assert.deepEqual((await claimDelayAlerts(f.pool,4,[10,11])).ids,[11]);
});
test('claims recheck updated settings, while an already notified active alert stays visible',async()=>{
  const f=fixture();
  f.setSettings({alertas_demora_activas:'0'});
  assert.deepEqual((await claimDelayAlerts(f.pool,4,[10])).ids,[]);
  f.setSettings({alerta_espera_minutos:'30'});
  assert.deepEqual((await claimDelayAlerts(f.pool,4,[10])).ids,[]);
  f.setSettings({alerta_espera_minutos:'20'});
  assert.deepEqual((await claimDelayAlerts(f.pool,4,[10])).ids,[10]);
  const active=await listDelayAlerts(f.db,4);
  assert.equal(active.items.length,1);
  assert.equal(active.items[0].avisada,true);
  f.setRecords([]); // round deleted between candidate read and ledger lookup
  assert.deepEqual((await listDelayAlerts(f.db,4)).items,[]);
});
test('malformed notification IDs are rejected before starting a transaction',async()=>{
  const pool={getConnection:()=>{throw new Error('Unexpected transaction');}};
  for(const ids of [null,['10'],[1.5],[-1],Array(101).fill(1)])await assert.rejects(claimDelayAlerts(pool,4,ids),/alertas válidas/);
});
