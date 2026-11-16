import { createHash } from 'node:crypto';
import { pool } from '../db.js';

export async function ensureOrderRequests() {
  await pool.query(`CREATE TABLE IF NOT EXISTS pedido_solicitudes (
    usuario_id INT NOT NULL, clave VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    huella CHAR(64) NOT NULL, respuesta LONGTEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (usuario_id, clave)
  ) ENGINE=InnoDB`);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const requestFingerprint = body => createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
export function orderRequestKey(value) {
  if (value == null) return null; // Compatibility for older clients.
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw Object.assign(new Error('Identificador de envio invalido.'), { status: 400 });
  return value;
}
export async function claimOrderRequest(conn, userId, key, body) {
  if (!key) return null;
  const hash = requestFingerprint(body);
  // The unique key serializes simultaneous retries. This row and the order are
  // committed together; a rollback also removes an uncompleted claim.
  await conn.query(`INSERT INTO pedido_solicitudes (usuario_id, clave, huella)
    VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE clave = VALUES(clave)`, [userId, key, hash]);
  const [[row]] = await conn.query('SELECT huella, respuesta FROM pedido_solicitudes WHERE usuario_id = ? AND clave = ? FOR UPDATE', [userId, key]);
  if (row.huella !== hash) throw Object.assign(new Error('Este identificador pertenece a otra comanda. Recupera el envio original.'), { status: 409, code: 'REQUEST_CONFLICT' });
  return row.respuesta ? JSON.parse(row.respuesta) : null;
}
export async function finishOrderRequest(conn, userId, key, response) {
  if (key) await conn.query('UPDATE pedido_solicitudes SET respuesta = ? WHERE usuario_id = ? AND clave = ?', [JSON.stringify(response), userId, key]);
}
