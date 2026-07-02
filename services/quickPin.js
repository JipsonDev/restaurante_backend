import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { normalizeRole } from './permissions.js';

let pinColumnReady = false;

export function normalizePin(pin) {
  return String(pin || '').replace(/\D/g, '').slice(0, 4);
}

export function isValidPin(pin) {
  return /^\d{4}$/.test(normalizePin(pin));
}

export async function ensurePinColumn(db = pool) {
  if (pinColumnReady) return;
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'trabajadores'
       AND COLUMN_NAME = 'pin_hash'
     LIMIT 1`
  );
  if (!rows.length) {
    await db.query('ALTER TABLE trabajadores ADD COLUMN pin_hash VARCHAR(255) NULL');
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

export async function findUserByPin({ pin, roles = ['admin', 'supervisor', 'mesero', 'cocina', 'caja'], excludeUserId = null, db = pool }) {
  await ensurePinColumn(db);
  const cleanPin = normalizePin(pin);
  if (!isValidPin(cleanPin)) return null;

  const allowed = roles.map(normalizeRole);
  const [rows] = await db.query(
    `SELECT id, nombre, correo, rol, pin_hash
     FROM trabajadores
     WHERE activo = 1
       AND pin_hash IS NOT NULL`
  );

  const matches = [];
  for (const user of rows) {
    if (excludeUserId && Number(user.id) === Number(excludeUserId)) continue;
    if (!allowed.includes(normalizeRole(user.rol))) continue;
    if (await bcrypt.compare(cleanPin, user.pin_hash)) {
      matches.push({ id: user.id, nombre: user.nombre, correo: user.correo, rol: normalizeRole(user.rol) });
    }
  }

  if (matches.length > 1) {
    const error = new Error('PIN duplicado. Solicita al administrador asignar PIN unicos.');
    error.statusCode = 409;
    throw error;
  }
  return matches[0] || null;
}

export async function assertPinAvailable(pin, { excludeUserId = null, db = pool } = {}) {
  const match = await findUserByPin({ pin, excludeUserId, db });
  if (match) {
    const error = new Error('Este PIN ya esta asignado a otro usuario activo.');
    error.statusCode = 409;
    throw error;
  }
}

export async function hashUniquePin(pin, { excludeUserId = null, db = pool } = {}) {
  await assertPinAvailable(pin, { excludeUserId, db });
  return hashPin(pin);
}

export async function verifyQuickPin({ correo, pin, roles = ['admin', 'supervisor'], db = pool }) {
  await ensurePinColumn(db);
  const cleanPin = normalizePin(pin);
  if (!correo || !isValidPin(cleanPin)) return null;

  const [rows] = await db.query(
    `SELECT id, nombre, correo, rol, pin_hash
     FROM trabajadores
     WHERE correo = ? AND activo = 1
     LIMIT 1`,
    [String(correo).toLowerCase().trim()]
  );
  const user = rows[0];
  if (!user || !user.pin_hash) return null;

  const allowed = roles.map(normalizeRole);
  if (!allowed.includes(normalizeRole(user.rol))) return null;

  const ok = await bcrypt.compare(cleanPin, user.pin_hash);
  if (!ok) return null;
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
