import jwt from 'jsonwebtoken';
import { normalizeRole } from '../services/permissions.js';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET debe estar definido en las variables de entorno.');
}

export function verifyToken(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Acceso denegado. Token no proporcionado.' });
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalido o expirado. Inicia sesion de nuevo.' });
  }
}

export function verifyRole(...rolesPermitidos) {
  const allowed = rolesPermitidos.map(normalizeRole);
  return (req, res, next) => {
    if (!allowed.includes(normalizeRole(req.user?.rol))) {
      return res.status(403).json({ message: 'No tienes permiso para esta accion.' });
    }
    next();
  };
}

export { JWT_SECRET };
