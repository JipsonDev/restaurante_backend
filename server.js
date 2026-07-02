import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { Server } from 'socket.io';

import authRoutes from './routes/auth.js';
import productosRoutes from './routes/productos.js';
import pedidosRoutes from './routes/pedidos.js';
import trabajadoresRoutes from './routes/trabajadores.js';
import dashboardRoutes from './routes/dashboard.js';
import mesasRoutes from './routes/mesas.js';
import cajaRoutes from './routes/caja.js';
import inventarioRoutes from './routes/inventario.js';
import ubicacionesRoutes from './routes/ubicaciones.js';
import extrasRoutes from './routes/extras.js';
import notificacionesRoutes from './routes/notificaciones.js';
import auditoriaRoutes from './routes/auditoria.js';
import configuracionRoutes from './routes/configuracion.js';
import { verifyToken } from './middleware/auth.js';
import { setRealtimeServer } from './realtime.js';
import { ensureAuditTable } from './services/audit.js';
import { ensureBusinessConfigTable } from './services/businessConfig.js';

dotenv.config();

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsOptions = {
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
};
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  pingInterval: 10000,
  pingTimeout: 20000,
});

setRealtimeServer(io);

io.on('connection', (socket) => {
  socket.emit('system:connected', {
    socket_id: socket.id,
    emitted_at: new Date().toISOString(),
  });
});

app.use(cors(corsOptions));
app.use(express.json());
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
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

const PORT = process.env.PORT || 3000;
try {
  await ensureAuditTable();
  await ensureBusinessConfigTable();
} catch (error) {
  console.warn('No se pudo preparar tablas auxiliares:', error.message);
}

httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
