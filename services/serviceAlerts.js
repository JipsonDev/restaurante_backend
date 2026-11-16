const COOLDOWN_SECONDS = 120;
const minuteLimit = (value, fallback) => /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 240 ? Number(value) : fallback;
export const delayLimits = (config = {}) => ({ enabled: String(config.alertas_demora_activas ?? '1') === '1', espera: minuteLimit(config.alerta_espera_minutos, 20), lista: minuteLimit(config.alerta_lista_minutos, 5) });

export function overdueRound(round, limits) {
  if (!limits.enabled || !['PENDIENTE', 'PREPARANDO', 'LISTO'].includes(round.estado)) return null;
  const wait = round.espera_segundos, ready = round.lista_segundos;
  if (wait === null || !Number.isFinite(Number(wait)) || Number(wait) < 0) return null;
  const tipo = round.estado === 'LISTO' ? 'lista' : 'espera';
  const elapsed = tipo === 'lista' ? ready : wait;
  if (elapsed === null || !Number.isFinite(Number(elapsed)) || Number(elapsed) < 0 || Number(elapsed) > Number(wait) || Number(elapsed) < limits[tipo] * 60) return null;
  return { ...round, tipo, minutos: Math.floor(Number(elapsed) / 60), limite: limits[tipo] };
}

// Schema work runs once on startup, never during an order/notification transaction.
export async function migrateServiceAlerts(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ronda_alertas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    trabajador_id INT NOT NULL,
    ronda_id INT NOT NULL,
    tipo ENUM('espera','lista') NOT NULL,
    detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    avisado_at DATETIME NULL,
    UNIQUE KEY uq_alerta_fase (trabajador_id,ronda_id,tipo),
    INDEX idx_alerta_avisado (trabajador_id,avisado_at),
    CONSTRAINT fk_alerta_ronda FOREIGN KEY (ronda_id) REFERENCES pedido_rondas(id) ON DELETE CASCADE,
    CONSTRAINT fk_alerta_trabajador FOREIGN KEY (trabajador_id) REFERENCES trabajadores(id) ON DELETE CASCADE
  )`);
}

async function candidates(db, userId) {
  const [settings] = await db.query("SELECT clave,valor FROM configuracion_negocio WHERE clave IN ('alertas_demora_activas','alerta_espera_minutos','alerta_lista_minutos')");
  const limits = delayLimits(Object.fromEntries(settings.map(row => [row.clave, row.valor])));
  if (!limits.enabled) return { limits, items: [] };
  // MySQL's clock and stored timestamps define eligibility; device clocks do not.
  const [rows] = await db.query(`SELECT r.id AS ronda_id,r.pedido_id,r.estado,p.mesa_id,m.numero AS mesa_numero,p.tipo AS origen,p.cliente_nombre,
    CASE WHEN p.estado='PAGADO' THEN 'PAGADO' ELSE 'PENDIENTE' END AS estado_cobro,
    TIMESTAMPDIFF(SECOND,r.created_at,NOW()) AS espera_segundos,
    TIMESTAMPDIFF(SECOND,r.listo_at,NOW()) AS lista_segundos
    FROM pedido_rondas r JOIN pedidos p ON p.id=r.pedido_id LEFT JOIN mesas m ON m.id=p.mesa_id
    WHERE p.mesero_id=? AND p.estado<>'CANCELADO' AND r.estado IN ('PENDIENTE','PREPARANDO','LISTO') AND r.entregado_at IS NULL`, [userId]);
  return { limits, items: rows.map(row => overdueRound(row, limits)).filter(Boolean) };
}

export async function listDelayAlerts(db, userId) {
  const result = await candidates(db, userId);
  if (!result.items.length) return result;
  await db.query(`INSERT IGNORE INTO ronda_alertas (trabajador_id,ronda_id,tipo) VALUES ${result.items.map(() => '(?,?,?)').join(',')}`, result.items.flatMap(item => [userId, item.ronda_id, item.tipo]));
  const [records] = await db.query('SELECT id,ronda_id,tipo,avisado_at FROM ronda_alertas WHERE trabajador_id=? AND ronda_id IN (?)', [userId, result.items.map(item => item.ronda_id)]);
  const indexed = new Map(records.map(row => [`${row.ronda_id}:${row.tipo}`, row]));
  return { limits: result.limits, items: result.items.flatMap(item => {
    const record = indexed.get(`${item.ronda_id}:${item.tipo}`);
    // A concurrent cancellation/deletion must not break the whole alert center.
    return record ? [{ ...item, id: record.id, avisada: !!record.avisado_at }] : [];
  }).sort((a,b) => b.minutos - b.limite - (a.minutos - a.limite)) };
}

export async function claimDelayAlerts(pool, userId, requestedIds) {
  if (!Array.isArray(requestedIds) || requestedIds.length > 100 || requestedIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    const error = new Error('Selecciona hasta 100 alertas válidas.'); error.statusCode = 400; throw error;
  }
  if (!requestedIds.length) return { ids: [], retry_after: 0 };
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    // Serialize claims for the authenticated worker, including multiple devices.
    const [worker] = await db.query('SELECT id FROM trabajadores WHERE id=? FOR UPDATE', [userId]);
    if (!worker.length) { const error = new Error('Usuario no disponible.'); error.statusCode = 401; throw error; }
    const active = await candidates(db, userId);
    const keys = new Set(active.items.map(item => `${item.ronda_id}:${item.tipo}`));
    const [[last]] = await db.query('SELECT TIMESTAMPDIFF(SECOND,MAX(avisado_at),NOW()) AS segundos FROM ronda_alertas WHERE trabajador_id=?', [userId]);
    const retry = last.segundos === null ? 0 : Math.max(0, COOLDOWN_SECONDS - Number(last.segundos));
    const [records] = await db.query('SELECT id,ronda_id,tipo,avisado_at FROM ronda_alertas WHERE trabajador_id=? AND id IN (?)', [userId, requestedIds]);
    const ids = retry ? [] : records.filter(row => requestedIds.includes(row.id) && !row.avisado_at && keys.has(`${row.ronda_id}:${row.tipo}`)).map(row => row.id);
    if (ids.length) await db.query('UPDATE ronda_alertas SET avisado_at=NOW() WHERE trabajador_id=? AND id IN (?) AND avisado_at IS NULL', [userId, ids]);
    await db.commit();
    return { ids, retry_after: retry };
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}
