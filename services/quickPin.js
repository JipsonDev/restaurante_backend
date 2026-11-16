import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { normalizeRole } from './permissions.js';

let pinColumnReady = false;

// Bloqueo por cuenta: tras PIN_MAX_FAILURES fallos seguidos el PIN de ese
// usuario queda bloqueado PIN_LOCK_MINUTES. La contrasena sigue funcionando.
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MINUTES = 15;

export function normalizePin(pin) {
  return String(pin || '').replace(/\D/g, '').slice(0, 4);
}

export function isValidPin(pin) {
  return /^\d{4}$/.test(normalizePin(pin));
}

async function hasColumn(db, column) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'trabajadores'
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [column]
  );
  return rows.length > 0;
}

export async function ensurePinColumn(db = pool) {
  if (pinColumnReady) return;
  if (!(await hasColumn(db, 'pin_hash'))) {
    await db.query('ALTER TABLE trabajadores ADD COLUMN pin_hash VARCHAR(255) NULL');
  }
  if (!(await hasColumn(db, 'pin_fallos'))) {
    await db.query('ALTER TABLE trabajadores ADD COLUMN pin_fallos INT NOT NULL DEFAULT 0');
  }
  if (!(await hasColumn(db, 'pin_bloqueado_hasta'))) {
    await db.query('ALTER TABLE trabajadores ADD COLUMN pin_bloqueado_hasta DATETIME NULL');
  }
  pinColumnReady = true;
}

export async function hashPin(pin) {
  const clean = normalizePin(pin);
  if (!isValidPin(clean)) {
    const error = new Error('El PIN debe tener 4 digitos.');
    error.statusCode = 400;
    throw error;
  }
  return bcrypt.hash(clean, 10);
}

// El PIN siempre se valida junto al correo, asi que ya no necesita ser unico.
// Antes se exigia unicidad y eso permitia descubrir el PIN de otro usuario.
export async function hashUniquePin(pin) {
  return hashPin(pin);
}

export function pinLockedError(until) {
  const minutes = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  const error = new Error(`PIN bloqueado por intentos fallidos. Entra con tu contrasena o espera ${minutes} min.`);
  error.statusCode = 423;
  error.retryAfterSeconds = minutes * 60;
  return error;
}

export async function clearPinFailures(userId, db = pool) {
  await ensurePinColumn(db);
  await db.query('UPDATE trabajadores SET pin_fallos = 0, pin_bloqueado_hasta = NULL WHERE id = ?', [userId]);
}

async function registerPinFailure(user, db) {
  const failures = Number(user.pin_fallos || 0) + 1;
  if (failures >= PIN_MAX_FAILURES) {
    await db.query(
      'UPDATE trabajadores SET pin_fallos = 0, pin_bloqueado_hasta = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
      [PIN_LOCK_MINUTES, user.id]
    );
    throw pinLockedError(Date.now() + PIN_LOCK_MINUTES * 60000);
  }
  await db.query('UPDATE trabajadores SET pin_fallos = ? WHERE id = ?', [failures, user.id]);
}

export async function verifyQuickPin({ correo, pin, roles = ['admin', 'supervisor'], db = pool }) {
  await ensurePinColumn(db);
  const cleanPin = normalizePin(pin);
  if (!correo || !isValidPin(cleanPin)) return null;

  const [rows] = await db.query(
    `SELECT id, nombre, correo, rol, pin_hash, pin_fallos, pin_bloqueado_hasta,
            (pin_bloqueado_hasta IS NOT NULL AND pin_bloqueado_hasta > NOW()) AS pin_bloqueado
     FROM trabajadores
     WHERE correo = ? AND activo = 1
     LIMIT 1`,
    [String(correo).toLowerCase().trim()]
  );
  const user = rows[0];
  if (!user || !user.pin_hash) return null;
  if (Number(user.pin_bloqueado)) throw pinLockedError(user.pin_bloqueado_hasta);

  const ok = await bcrypt.compare(cleanPin, user.pin_hash);
  if (!ok) {
    await registerPinFailure(user, db);
    return null;
  }
  if (Number(user.pin_fallos) || user.pin_bloqueado_hasta) await clearPinFailures(user.id, db);

  const allowed = roles.map(normalizeRole);
  if (!allowed.includes(normalizeRole(user.rol))) return null;
  return { id: user.id, nombre: user.nombre, correo: user.correo, rol: normalizeRole(user.rol) };
}

export async function resolveQuickAuthorization(req, { roles = ['admin', 'supervisor'] } = {}) {
  const allowed = roles.map(normalizeRole);
  if (allowed.includes(normalizeRole(req.user?.rol))) {
    return { user: req.user, via: 'sesion' };
  }

  const auth = req.body?.authorization || {};
  const correo = auth.correo || auth.email || req.body?.autorizador_correo || req.body?.supervisor_correo;
  const pin = auth.pin || req.body?.autorizador_pin || req.body?.supervisor_pin;
  const authorizer = await verifyQuickPin({ correo, pin, roles });
  if (!authorizer) {
    const error = new Error('Autorizacion requerida: ingresa correo y PIN de admin o supervisor.');
    error.statusCode = 403;
    throw error;
  }
  return { user: authorizer, via: 'pin' };
}
