const metadata = value => {
  try { const data = typeof value === 'string' ? JSON.parse(value) : value; return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; }
};
const actor = (id, nombre, rol = null) => ({
  id: Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null,
  nombre: String(nombre || '').trim() || (Number(id) > 0 ? `Usuario #${id}` : 'Usuario no registrado'), rol,
});
const auditActor = row => actor(row?.trabajador_id, metadata(row?.metadata).actor_nombre || row?.trabajador_nombre, row?.rol);

export async function migrateRoundAttribution(db) {
  const [columns] = await db.query('SHOW COLUMNS FROM pedido_rondas');
  const existing = new Set(columns.map(column => column.Field));
  const definitions = { creado_por:'INT NULL', creado_por_nombre:'VARCHAR(120) NULL', entregado_por:'INT NULL', entregado_por_nombre:'VARCHAR(120) NULL', pedido_origen_id:'INT NULL' };
  const missing = Object.entries(definitions).filter(([name]) => !existing.has(name));
  if (missing.length) await db.query(`ALTER TABLE pedido_rondas ${missing.map(([name,type])=>`ADD COLUMN ${name} ${type}`).join(', ')}`);
}

export function buildOrderTracking(order, auditRows = [], payments = []) {
  const audit = [...auditRows].sort((a,b)=>Number(a.id)-Number(b.id));
  const rounds = [...(order.rondas || [])].sort((a,b)=>Number(a.id)-Number(b.id));
  const taken = audit.find(row=>row.entidad==='pedido' && Number(row.entidad_id)===Number(order.id) && row.accion==='pedido.creado');
  const initial = rounds.find(round=>Number(round.pedido_origen_id)===Number(order.id));
  const events = [{ id:`pedido-${order.id}`, tipo:'pedido_tomado', at:order.created_at || taken?.created_at || null,
    actor: initial?.creado_por ? actor(initial.creado_por,initial.creado_por_nombre) : auditActor(taken) }];
  for (const round of rounds) {
    const creation = audit.find(row=>['pedido.creado','pedido.ronda_agregada'].includes(row.accion) && Number(metadata(row.metadata).ronda_id)===Number(round.id))
      || (Number(round.legacy_pedido_id)===Number(order.id) ? taken : null);
    const delivery = audit.find(row=>row.entidad==='ronda' && Number(row.entidad_id)===Number(round.id) && row.accion==='ronda.estado_actualizado'
      && metadata(row.metadata).after==='ENTREGADO' && metadata(row.metadata).before!=='ENTREGADO');
    events.push({ id:`ronda-envio-${round.id}`, tipo:'ronda_enviada', ronda_id:round.id, pedido_origen_id:round.pedido_origen_id || round.legacy_pedido_id || null,
      at:round.created_at || creation?.created_at || null, estado:round.estado,
      actor:round.creado_por ? actor(round.creado_por,round.creado_por_nombre) : auditActor(creation),
      items:(round.items || []).map(item=>({nombre:item.nombre,cantidad:item.cantidad})) });
    if (round.entregado_at || round.estado==='ENTREGADO' || delivery) events.push({ id:`ronda-entrega-${round.id}`, tipo:'ronda_entregada', ronda_id:round.id,
      at:round.entregado_at || delivery?.created_at || null, actor:round.entregado_por ? actor(round.entregado_por,round.entregado_por_nombre) : auditActor(delivery) });
  }
  // Older audit entries did not link an additional round number. Preserve the
  // recorded actor without guessing which of the numbered rounds they added.
  for (const row of audit.filter(row=>row.accion==='pedido.ronda_agregada' && !metadata(row.metadata).ronda_id)) {
    events.push({id:`audit-${row.id}`,tipo:'ronda_agregada_legacy',at:row.created_at || null,actor:auditActor(row)});
  }
  for (const payment of payments) {
    events.push({ id:`cobro-${payment.id}`,tipo:'cobro', at:payment.created_at || null,
      actor:actor(payment.trabajador_id || payment.snapshot_actor_id, payment.snapshot_actor_nombre || payment.trabajador_nombre,payment.trabajador_rol || null),
      monto:Number(payment.monto || 0),metodo:payment.metodo || null,estado:payment.estado || 'ACTIVO' });
    if (payment.anulado_at) events.push({id:`cobro-reversion-${payment.id}`,tipo:payment.estado==='DEVUELTO'?'cobro_devuelto':'cobro_anulado',at:payment.anulado_at,
      actor:actor(payment.anulado_por,payment.anulado_por_nombre),monto:Number(payment.monto || 0)});
  }
  events.sort((a,b)=>{
    const date = value => value ? new Date(value).getTime() : NaN;
    const left=date(a.at),right=date(b.at);
    return (Number.isFinite(left)?left:Infinity)-(Number.isFinite(right)?right:Infinity) || 0;
  });
  return { pedido_id:order.id,mesero_asignado:actor(order.mesero_id,order.mesero_nombre,'mesero'),events };
}

export async function loadOrderTracking(db, order) {
  const ids=(order.rondas || []).map(round=>round.id);
  const [[audit],[payments]] = await Promise.all([
    db.query(`SELECT a.id,a.trabajador_id,a.rol,a.accion,a.entidad,a.entidad_id,a.metadata,a.created_at,t.nombre AS trabajador_nombre
      FROM auditoria_acciones a LEFT JOIN trabajadores t ON t.id=a.trabajador_id
      WHERE (a.entidad='pedido' AND a.entidad_id=?) OR (a.entidad='ronda' AND a.entidad_id IN (?)) ORDER BY a.id`,[order.id,ids.length?ids:[0]]),
    db.query(`SELECT pg.id,pg.monto,pg.metodo,pg.estado,pg.created_at,pg.trabajador_id,t.nombre AS trabajador_nombre,t.rol AS trabajador_rol,
      JSON_UNQUOTE(JSON_EXTRACT(pg.comprobante_snapshot,'$.cajero.id')) AS snapshot_actor_id,
      JSON_UNQUOTE(JSON_EXTRACT(pg.comprobante_snapshot,'$.cajero.nombre')) AS snapshot_actor_nombre,
      pg.anulado_at,pg.anulado_por,reversal.nombre AS anulado_por_nombre
      FROM pagos pg LEFT JOIN trabajadores t ON t.id=pg.trabajador_id LEFT JOIN trabajadores reversal ON reversal.id=pg.anulado_por
      WHERE pg.pedido_id=? ORDER BY pg.id`,[order.id]),
  ]);
  return buildOrderTracking(order,audit,payments);
}
