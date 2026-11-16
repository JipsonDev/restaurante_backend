import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db.js';
import { JWT_SECRET, verifyRole, verifyToken } from '../middleware/auth.js';
import { isValidRole, normalizeRole, VALID_ROLES } from '../services/permissions.js';
import { clearPinFailures, ensurePinColumn, hashUniquePin, verifyQuickPin } from '../services/quickPin.js';

const router = express.Router();
// Count failures before credential checks; login and PIN setup share a budget.
const attemptLimit = limit => rateLimit({
  windowMs: 2 * 60 * 1000,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: 'Demasiados intentos. Espera 2 minutos e intenta de nuevo.' },
});
const passwordAttempts = attemptLimit(10);
const pinAttempts = attemptLimit(5);
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const validCredentials = (correo, password) => typeof correo === 'string'
  && correo.trim().length > 0 && correo.length <= 254
  && typeof password === 'string' && password.length > 0 && password.length <= 1024;
const validPin = pin => typeof pin === 'string' && /^\d{4}$/.test(pin);

const mysqlErrorDetails = (error) =>
  error.message || error.code || error.sqlMessage || JSON.stringify(error);

// Diagnostics stay on the server instead of exposing database configuration.
const loginErrorMessage = () => 'No se pudo iniciar sesión. Inténtalo de nuevo más tarde.';

function signSession(user) {
  const payload = { id: user.id, nombre: user.nombre, correo: user.correo, rol: normalizeRole(user.rol) };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  return { token, user: payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { correo, password }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', passwordAttempts, async (req, res) => {
  const { correo, password } = req.body || {};

  if (!validCredentials(correo, password)) {
    return res.status(400).json({ message: 'Correo y contraseña son obligatorios.' });
  }

  try {
    // 1. Buscar usuario activo por correo
    await ensurePinColumn();
    const [rows] = await pool.query(
      `SELECT id, nombre, correo, password_hash, rol, pin_hash, pin_fallos, pin_bloqueado_hasta
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

    if (user.pin_fallos || user.pin_bloqueado_hasta) await clearPinFailures(user.id);
    return res.json(signSession(user));

  } catch (error) {
    console.error('Error en login:', mysqlErrorDetails(error));
    return res.status(500).json({ message: loginErrorMessage(error) });
  }
});

router.post('/login-pin', pinAttempts, async (req, res) => {
  const { correo, pin } = req.body || {};

  if (!validPin(pin)) {
    return res.status(400).json({ message: 'El PIN debe tener exactamente 4 dígitos.' });
  }
  if (typeof correo !== 'string' || !correo.trim() || correo.length > 254) {
    return res.status(400).json({ message: 'Elige tu usuario antes de escribir el PIN.' });
  }

  try {
    // El PIN se valida contra UNA cuenta concreta (correo) y esa cuenta se
    // bloquea tras varios fallos: ya no se puede adivinar "el PIN de cualquiera".
    const user = await verifyQuickPin({
      correo,
      pin,
      roles: ['admin', 'supervisor', 'mesero', 'cocina', 'caja'],
    });
    if (!user) {
      return res.status(401).json({ message: 'Usuario o PIN incorrecto.' });
    }

    return res.json(signSession(user));
  } catch (error) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    console.error('Error en login-pin:', mysqlErrorDetails(error));
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : loginErrorMessage(error) });
  }
});

router.post('/setup-pin', passwordAttempts, async (req, res) => {
  const { correo, password, pin } = req.body || {};

  if (!validCredentials(correo, password) || !validPin(pin)) {
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
// User creation is an administrative operation even through the auth router.
router.post('/register', verifyToken, verifyRole('admin'), async (req, res) => {
  const { nombre, correo, password, rol = 'mesero', pin = null } = req.body || {};
  const nextRole = normalizeRole(rol);

  if (typeof nombre !== 'string' || !nombre.trim() || nombre.length > 150
    || !validCredentials(correo, password) || (pin !== null && !validPin(pin))) {
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
