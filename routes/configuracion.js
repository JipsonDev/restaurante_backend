import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { verifyRole } from '../middleware/auth.js';
import { getBusinessConfig, setBusinessConfig } from '../services/businessConfig.js';
import { listSystemPrinters } from '../services/printers.js';
import { safeLogAudit } from '../services/audit.js';
import { collationReport, unifyCollation } from '../services/collation.js';

const router = express.Router();
const uploadDir = path.join(process.cwd(), 'uploads', 'configuracion');

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, `logo-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) return cb(new Error('Solo se permiten imagenes.'));
    cb(null, true);
  },
});

router.get('/', async (_req, res) => {
  try {
    res.json(await getBusinessConfig());
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, error: error.message });
  }
});

router.put('/', verifyRole('admin'), async (req, res) => {
  try {
    const before = await getBusinessConfig();
    const config = await setBusinessConfig(req.body || {});
    await safeLogAudit({
      user: req.user,
      accion: 'configuracion.actualizada',
      entidad: 'configuracion',
      entidadId: 1,
      descripcion: 'Configuracion del negocio actualizada',
      metadata: {
        antes: {
          nombre_restaurante: before.nombre_restaurante,
          iva_porcentaje: before.iva_porcentaje,
          servicio_porcentaje: before.servicio_porcentaje,
          moneda: before.moneda,
          impresora_caja: before.impresora_caja,
          impresora_cocina: before.impresora_cocina,
          alertas_demora_activas: before.alertas_demora_activas,
          alerta_espera_minutos: before.alerta_espera_minutos,
          alerta_lista_minutos: before.alerta_lista_minutos,
        },
        despues: {
          nombre_restaurante: config.nombre_restaurante,
          iva_porcentaje: config.iva_porcentaje,
          servicio_porcentaje: config.servicio_porcentaje,
          moneda: config.moneda,
          impresora_caja: config.impresora_caja,
          impresora_cocina: config.impresora_cocina,
          alertas_demora_activas: config.alertas_demora_activas,
          alerta_espera_minutos: config.alerta_espera_minutos,
          alerta_lista_minutos: config.alerta_lista_minutos,
        },
      },
    });
    res.json(config);
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, error: error.message });
  }
});

router.get('/impresoras', verifyRole('admin'), async (_req, res) => {
  try {
    res.json(await listSystemPrinters());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/logo', verifyRole('admin'), upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Selecciona un archivo de logo.' });
    const logoUrl = `/uploads/configuracion/${req.file.filename}`;
    const config = await setBusinessConfig({ logo_url: logoUrl });
    await safeLogAudit({
      user: req.user,
      accion: 'configuracion.logo_actualizado',
      entidad: 'configuracion',
      entidadId: 1,
      descripcion: 'Logo del negocio actualizado',
      metadata: { logo_url: logoUrl },
    });
    res.status(201).json({ logo_url: logoUrl, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mantenimiento de la base: estado de la intercalación y reintento manual (solo admin).
router.get('/mantenimiento/base', verifyRole('admin'), async (_req, res) => {
  try { res.json(await collationReport()); }
  catch (error) { res.status(500).json({ message: 'No se pudo revisar la base de datos.', detail: error.message }); }
});
router.post('/mantenimiento/base', verifyRole('admin'), async (req, res) => {
  try {
    const result = await unifyCollation();
    await safeLogAudit({ user: req.user, accion: 'base.intercalacion_unificada', entidad: 'configuracion', descripcion: 'Unificación de intercalación', metadata: result });
    res.json({ ...result, report: await collationReport() });
  } catch (error) { res.status(500).json({ message: 'No se pudo unificar la intercalación.', detail: error.message }); }
});

export default router;
