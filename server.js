import { ensureStockReservations, migratePendingReservations } from './services/stockReservations.js';
import express from 'express';
import { ensureOrderRequests } from './services/orderRequests.js';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { Server } from 'socket.io';

import authRoutes from './routes/auth.js';
import productosRoutes from './routes/productos.js';
import pedidosRoutes, { initializeOrderSchema } from './routes/pedidos.js';
import trabajadoresRoutes from './routes/trabajadores.js';
import dashboardRoutes from './routes/dashboard.js';
import mesasRoutes from './routes/mesas.js';
import cajaRoutes, { initializeCashSchema } from './routes/caja.js';
import inventarioRoutes from './routes/inventario.js';
import ubicacionesRoutes from './routes/ubicaciones.js';
import extrasRoutes from './routes/extras.js';
import notificacionesRoutes from './routes/notificaciones.js';
import auditoriaRoutes from './routes/auditoria.js';
import configuracionRoutes from './routes/configuracion.js';
import revisionDatosRoutes from './routes/revisionDatos.js';
import impresionesRoutes from './routes/impresiones.js';
import publicoRoutes from './routes/publico.js';
import reservasRoutes, { ensureReservationsTable } from './routes/reservas.js';
import { ensurePrintQueue } from './services/printQueue.js';
import { verifyToken, JWT_SECRET } from './middleware/auth.js';
import { attachSocketAuth } from './services/socketAuth.js';
import { resolveCorsOrigins, securityHeaders, trustProxySetting } from './services/httpSecurity.js';
import { setRealtimeServer } from './realtime.js';
import { ensureAuditTable } from './services/audit.js';
import { unifyCollation } from './services/collation.js';
import { ensureBusinessConfigTable } from './services/businessConfig.js';

dotenv.config();

const app = express();
// Render/Vercel ponen un proxy delante: sin esto el limite de intentos de login
// ve a todos los clientes como una sola IP. Configurable con TRUST_PROXY.
app.set('trust proxy', trustProxySetting(process.env));
app.disable('x-powered-by');

// En produccion CORS_ORIGIN es obligatorio; '*' solo se acepta en desarrollo.
const allowedOrigins = resolveCorsOrigins(process.env);
const corsOptions = {
  origin: allowedOrigins === '*' ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: allowedOrigins !== '*',
};
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5,
});

attachSocketAuth(io, () => ({ jwtSecret: JWT_SECRET, printToken: process.env.PRINT_AGENT_TOKEN }));
setRealtimeServer(io);

app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: '200kb' }));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), { dotfiles: 'deny', index: false }));
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'morena-mia-api',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/productos', verifyToken, productosRoutes);
app.use('/api/pedidos', verifyToken, pedidosRoutes);
app.use('/api/trabajadores', verifyToken, trabajadoresRoutes);
app.use('/api/dashboard', verifyToken, dashboardRoutes);
app.use('/api/mesas', verifyToken, mesasRoutes);
app.use('/api/caja', verifyToken, cajaRoutes);
app.use('/api/inventario', verifyToken, inventarioRoutes);
app.use('/api/ubicaciones', verifyToken, ubicacionesRoutes);
app.use('/api/extras', verifyToken, extrasRoutes);
app.use('/api/notificaciones', verifyToken, notificacionesRoutes);
app.use('/api/auditoria', verifyToken, auditoriaRoutes);
app.use('/api/configuracion', verifyToken, configuracionRoutes);
app.use('/api/revision-datos', verifyToken, revisionDatosRoutes);
app.use('/api/reservas', verifyToken, reservasRoutes);
app.use('/api/impresiones', impresionesRoutes);
app.use('/api/publico', publicoRoutes); // menú del QR: sin sesión, solo lectura

const PORT = process.env.PORT || 3000;
// Una sola intercalación en toda la base (evita «Illegal mix of collations»). No detiene el arranque.
try {
  await unifyCollation();
} catch (error) {
  console.warn('No se pudo revisar la intercalación de la base:', error.message);
}
try {
  await ensureAuditTable();
  await ensureBusinessConfigTable();
  await ensurePrintQueue();
  await ensureReservationsTable();
} catch (error) {
  console.warn('No se pudo preparar tablas auxiliares:', error.message);
}

await initializeOrderSchema();
await ensureOrderRequests();
await initializeCashSchema();
await ensureStockReservations();
const reservations = await migratePendingReservations();
if (reservations.shortages.length) console.warn('Inventario comprometido por pedidos anteriores: requiere reposicion', reservations.shortages);
if (reservations.migrated) console.log(`Reservas creadas para ${reservations.migrated} rondas anteriores.`);
httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
