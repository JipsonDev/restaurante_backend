import { pool } from '../db.js';

let auditReady = false;

export async function ensureAuditTable(conn = pool) {
  if (auditReady) return;
  await conn.query(`
    CREATE TABLE IF NOT EXISTS auditoria_acciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trabajador_id INT NULL,
      rol VARCHAR(30) NULL,
      accion VARCHAR(80) NOT NULL,
      entidad VARCHAR(80) NOT NULL,
      entidad_id INT NULL,
      descripcion VARCHAR(255) NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auditoria_entidad (entidad, entidad_id),
      INDEX idx_auditoria_fecha (created_at)
    )
  `);
  auditReady = true;
}

export async function logAudit({
  conn = pool,
  user = null,
  accion,
  entidad,
  entidadId = null,
  descripcion = null,
  metadata = null,
}) {
  await ensureAuditTable(conn);
  await conn.query(
    `INSERT INTO auditoria_acciones
       (trabajador_id, rol, accion, entidad, entidad_id, descripcion, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      user?.id || null,
      user?.rol || null,
      accion,
      entidad,
      entidadId,
      descripcion,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

export async function safeLogAudit(payload) {
  try {
    await logAudit(payload);
  } catch (error) {
    console.warn('No se pudo registrar auditoria:', error.message);
  }
}
