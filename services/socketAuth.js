import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { normalizeRole } from './permissions.js';

// Salas de Socket.IO: solo el personal autenticado recibe pedidos, pagos y
// caja; el agente de impresion (token propio) solo recibe eventos print:*.
export const STAFF_ROOM = 'staff';
export const PRINT_AGENT_ROOM = 'print-agent';

function sameSecret(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function bearer(value) {
  const text = String(value || '');
  return text.startsWith('Bearer ') ? text.slice(7) : text;
}

export function authenticateSocket(handshake = {}, { jwtSecret, printToken } = {}) {
  const auth = handshake.auth || {};
  const token = bearer(auth.token || handshake.headers?.authorization);
  if (token) {
    try {
      const user = jwt.verify(token, jwtSecret);
      return { kind: 'staff', user: { ...user, rol: normalizeRole(user.rol) }, expiresAt: user.exp ? user.exp * 1000 : null };
    } catch {
      throw Object.assign(new Error('unauthorized'), { data: { message: 'Sesion expirada. Inicia sesion de nuevo.' } });
    }
  }
  if (auth.printToken && sameSecret(printToken, auth.printToken)) return { kind: 'print-agent' };
  throw Object.assign(new Error('unauthorized'), { data: { message: 'Conexion en tiempo real sin autenticar.' } });
}

export function roomsForEvent(event) {
  return String(event).startsWith('print:') ? [STAFF_ROOM, PRINT_AGENT_ROOM] : [STAFF_ROOM];
}

export function attachSocketAuth(io, options) {
  io.use((socket, next) => {
    try {
      socket.data.session = authenticateSocket(socket.handshake, options());
      next();
    } catch (error) {
      next(error);
    }
  });
  io.on('connection', (socket) => {
    const session = socket.data.session;
    if (session.kind === 'print-agent') {
      socket.join(PRINT_AGENT_ROOM);
    } else {
      socket.join(STAFF_ROOM);
      socket.join(`rol:${session.user.rol}`);
      socket.join(`user:${session.user.id}`);
      // Cierra la conexion cuando caduca el JWT para no seguir enviando datos.
      if (session.expiresAt) {
        const timer = setTimeout(() => socket.disconnect(true), Math.max(0, session.expiresAt - Date.now()));
        socket.on('disconnect', () => clearTimeout(timer));
      }
    }
    socket.emit('system:connected', { socket_id: socket.id, emitted_at: new Date().toISOString() });
  });
}
