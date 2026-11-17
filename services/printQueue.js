import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';

let ready;
export function ensurePrintQueue() {
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS print_jobs (
    id CHAR(36) PRIMARY KEY,
    sequence_id BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
    pedido_id INT NOT NULL,
    modulo VARCHAR(20) NOT NULL,
    payload JSON NOT NULL,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    claim_token CHAR(36) NULL,
    claimed_at DATETIME NULL,
    completed_at DATETIME NULL,
    error TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_print_queue (modulo, estado, created_at),
    INDEX idx_print_order (pedido_id, created_at)
  )`).catch((error) => { ready = null; throw error; });
  return ready;
}

// Call inside the same transaction as the order; a rollback also removes its ticket.
export async function enqueuePrint(conn, payload) {
  if (!payload.texto?.trim() && !payload.solo_cajon) throw new Error('La comanda no puede estar vacia.');
  const id = randomUUID();
  await conn.query(
    'INSERT INTO print_jobs (id, pedido_id, modulo, payload) VALUES (?, ?, ?, ?)',
    [id, payload.pedido_id, payload.modulo || 'cocina', JSON.stringify(payload)]
  );
  return { id, estado: 'PENDIENTE' };
}

// Último contacto de cada agente (por módulo). El agente pide trabajo cada 2 s: si pasó más de 15 s, se da por desconectado.
const agentSeen = new Map();
export const markAgentSeen = (modulo, now = Date.now()) => agentSeen.set(modulo, now);
export const agentOnline = (modulo, now = Date.now()) => now - (agentSeen.get(modulo) || 0) < 15000;

export async function claimPrintJob(modulo) {
  markAgentSeen(modulo);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // A crashed process may have printed already. Never automatically print it twice.
    await conn.query(`UPDATE print_jobs SET estado = 'REVISAR', error = 'El agente no confirmo el resultado.'
      WHERE modulo = ? AND estado = 'PROCESANDO' AND claimed_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`, [modulo]);
    const [[job]] = await conn.query(`SELECT id, payload FROM print_jobs
      WHERE modulo = ? AND estado = 'PENDIENTE' ORDER BY sequence_id LIMIT 1 FOR UPDATE`, [modulo]);
    if (!job) { await conn.commit(); return null; }
    const token = randomUUID();
    await conn.query("UPDATE print_jobs SET estado = 'PROCESANDO', claim_token = ?, claimed_at = NOW() WHERE id = ?", [token, job.id]);
    await conn.commit();
    return { id: job.id, claim_token: token, payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

export async function finishPrintJob(id, token, estado, error = null) {
  if (!['ENVIADO', 'SIMULADO', 'ERROR', 'REVISAR'].includes(estado)) throw new Error('Resultado de impresion invalido.');
  const [result] = await pool.query(`UPDATE print_jobs SET estado = ?, error = ?, completed_at = NOW()
    WHERE id = ? AND claim_token = ? AND estado IN ('PROCESANDO', 'REVISAR', ?)`,
  [estado, error ? String(error).slice(0, 2000) : null, id, token, estado]);
  // Si el trabajo era un comprobante de caja, su estado de impresión queda en el pago (Comprobantes lo muestra).
  if (result.affectedRows > 0) {
    try {
      const [[job]] = await pool.query('SELECT payload FROM print_jobs WHERE id = ?', [id]);
      const payload = typeof job?.payload === 'string' ? JSON.parse(job.payload) : job?.payload;
      if (payload?.pago_id) await pool.query(`UPDATE pagos SET impresion_estado = ?, impresion_intentos = impresion_intentos + 1,
        impresion_error = ?, impresion_at = NOW() WHERE id = ?`, [estado === 'ENVIADO' || estado === 'SIMULADO' ? 'ENVIADO' : 'ERROR', estado === 'ENVIADO' ? null : String(error || estado).slice(0, 255), payload.pago_id]);
    } catch (e) { console.error('[impresion] no se pudo actualizar el pago:', e.message); }
  }
  return result.affectedRows > 0;
}

export async function printQueueStatus(modulo = 'cocina') {
  const [counts] = await pool.query('SELECT estado, COUNT(*) AS cantidad FROM print_jobs WHERE modulo = ? GROUP BY estado', [modulo]);
  const [jobs] = await pool.query(`SELECT id, pedido_id, estado, error, created_at, completed_at
    FROM print_jobs WHERE modulo = ? ORDER BY sequence_id DESC LIMIT 30`, [modulo]);
  return { modulo, agente_activo: agentOnline(modulo), counts: Object.fromEntries(counts.map((row) => [row.estado, Number(row.cantidad)])), jobs };
}
