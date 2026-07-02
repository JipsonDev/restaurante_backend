import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { isValidRole, normalizeRole, VALID_ROLES } from '../services/permissions.js';
import { ensurePinColumn, findUserByPin, hashUniquePin } from '../services/quickPin.js';

const router = express.Router();
const pinAttempts = new Map();
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 2 * 60 * 1000;

const mysqlErrorDetails = (error) =>
  error.message || error.code || error.sqlMessage || JSON.stringify(error);

const loginErrorMessage = (error) => {
  if (error.code === 'ECONNREFUSED') {
    return 'No se pudo conectar a MySQL. Revisa que MySQL este iniciado y que DB_HOST/DB_PORT sean correctos.';
  }
  if (error.code === 'ER_BAD_DB_ERROR') {
    return 'La base de datos configurada no existe. Revisa DB_NAME en restaurante-backend/.env.';
  }
  if (error.code === 'ER_NO_SUCH_TABLE') {
    return 'No existe la tabla trabajadores. Importa o crea la base de datos antes de iniciar sesion.';
  }
  if (error.code === 'ER_BAD_FIELD_ERROR') {
    return 'La tabla trabajadores no tiene las columnas esperadas para login.';
  }
  if (error.code === 'ER_ACCESS_DENIED_ERROR') {
    return 'MySQL rechazo las credenciales. Revisa DB_USER y DB_PASSWORD en restaurante-backend/.env.';
  }
  return 'Error interno del servidor.';
};

function signSession(user) {
  const payload = { id: user.id, nombre: user.nombre, correo: user.correo, rol: normalizeRole(user.rol) };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  return { token, user: payload };
}

function pinAttemptKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
}

function isPinLocked(req) {
  const item = pinAttempts.get(pinAttemptKey(req));
  return item?.lockedUntil && item.lockedUntil > Date.now();
}

function registerPinFailure(req) {
  const key = pinAttemptKey(req);
  const current = pinAttempts.get(key) || { count: 0, lockedUntil: 0 };
  const count = current.lockedUntil > Date.now() ? current.count : current.count + 1;
  pinAttempts.set(key, {
    count,
    lockedUntil: count >= MAX_PIN_ATTEMPTS ? Date.now() + PIN_LOCK_MS : 0,
  });
}

function clearPinFailures(req) {
  pinAttempts.delete(pinAttemptKey(req));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { correo, password }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { correo, password } = req.body;

  if (!correo || !password) {
    return res.status(400).json({ message: 'Correo y contraseña son obligatorios.' });
  }

  try {
    // 1. Buscar usuario activo por correo
    const [rows] = await pool.query(
      `SELECT id, nombre, correo, password_hash, rol, pin_hash
       FROM trabajadores
       WHERE correo = ? AND activo = 1
       LIMIT 1`,
      [correo.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    }

    const user = rows[0];

    // 2. Comparar contraseña con bcrypt
    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    }

    if (!user.pin_hash) {
      return res.json({
        requires_pin_setup: true,
        message: 'Crea tu PIN rapido de 4 digitos para este usuario.',
        user: { id: user.id, nombre: user.nombre, correo: user.correo, rol: normalizeRole(user.rol), pin_configurado: false },
      });
    }

    return res.json(signSession(user));

  } catch (error) {
    console.error('Error en login:', mysqlErrorDetails(error));
    return res.status(500).json({ message: loginErrorMessage(error) });
  }
});

router.post('/login-pin', async (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ message: 'PIN es obligatorio.' });
  }
  if (isPinLocked(req)) {
    return res.status(429).json({ message: 'Demasiados intentos. Espera 2 minutos e intenta de nuevo.' });
  }

  try {
    const user = await findUserByPin({
      pin,
      roles: ['admin', 'supervisor', 'mesero', 'cocina', 'caja'],
    });
    if (!user) {
      registerPinFailure(req);
      return res.status(401).json({ message: 'PIN incorrecto.' });
    }

    clearPinFailures(req);
    return res.json(signSession(user));
  } catch (error) {
    console.error('Error en login-pin:', mysqlErrorDetails(error));
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : loginErrorMessage(error) });
  }
});

router.post('/setup-pin', async (req, res) => {
  const { correo, password, pin } = req.body;

  if (!correo || !password || !pin) {
    return res.status(400).json({ message: 'Correo, contrasena y PIN son obligatorios.' });
  }

  try {
    await ensurePinColumn();
    const [rows] = await pool.query(
      `SELECT id, nombre, correo, password_hash, rol, pin_hash
       FROM trabajadores
       WHERE correo = ? AND activo = 1
       LIMIT 1`,
      [correo.toLowerCase().trim()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }
    if (user.pin_hash) {
      return res.status(409).json({ message: 'Este usuario ya tiene PIN configurado.' });
    }

    const pinHash = await hashUniquePin(pin);
    await pool.query('UPDATE trabajadores SET pin_hash = ? WHERE id = ?', [pinHash, user.id]);
    return res.json(signSession(user));
  } catch (error) {
    console.error('Error en setup-pin:', mysqlErrorDetails(error));
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : loginErrorMessage(error) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register  (solo admin puede crear usuarios)
// Body: { nombre, correo, password, rol }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { nombre, correo, password, rol = 'mesero', pin = null } = req.body;
  const nextRole = normalizeRole(rol);

  if (!nombre || !correo || !password) {
    return res.status(400).json({ message: 'Nombre, correo y contraseña son obligatorios.' });
  }

  try {
    if (!isValidRole(nextRole)) {
      return res.status(400).json({ message: `Rol invalido. Usa: ${VALID_ROLES.join(', ')}.` });
    }
    await ensurePinColumn();
    // Verificar que el correo no exista
    const [existing] = await pool.query(
      'SELECT id FROM trabajadores WHERE correo = ? LIMIT 1',
      [correo.toLowerCase().trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: 'Ya existe un usuario con ese correo.' });
    }

    // Hashear contraseña
    const password_hash = await bcrypt.hash(password, 10);
    const pin_hash = pin ? await hashUniquePin(pin) : null;

    // Insertar
    const [result] = await pool.query(
      `INSERT INTO trabajadores (nombre, correo, password_hash, pin_hash, rol, activo)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [nombre, correo.toLowerCase().trim(), password_hash, pin_hash, nextRole]
    );

    return res.status(201).json({
      message: 'Usuario creado correctamente.',
      id: result.insertId,
    });

  } catch (error) {
    console.error('Error en register:', error.message);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Error interno del servidor.' });
  }
});

export default router;
