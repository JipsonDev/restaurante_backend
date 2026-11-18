import { pool } from '../db.js';
import { normalizeBusinessConfigPatch } from './businessConfigValidation.js';

const DEFAULT_CONFIG = {
  nombre_restaurante: 'Morena Mia',
  razon_social: 'Morena Mia Restaurante y Cafeteria',
  ruc: '',
  direccion: '',
  telefono: '',
  correo: '',
  logo_url: '',
  color_marca: '',
  iva_porcentaje: '16',
  servicio_porcentaje: '0',
  moneda: 'USD',
  simbolo_moneda: '$',
  texto_ticket: 'Gracias por su compra',
  impresora_caja: '',
  impresora_cocina: '',
  alertas_demora_activas: '1',
  alerta_espera_minutos: '20',
  alerta_lista_minutos: '5',
};

let ready = false;

export async function ensureBusinessConfigTable(db = pool) {
  if (ready && db === pool) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS configuracion_negocio (
      clave VARCHAR(80) PRIMARY KEY,
      valor TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.query(
    `INSERT IGNORE INTO configuracion_negocio (clave, valor)
     VALUES ${Object.keys(DEFAULT_CONFIG).map(() => '(?, ?)').join(', ')}`,
    Object.entries(DEFAULT_CONFIG).flat()
  );
  if (db === pool) ready = true;
}

export async function getBusinessConfig(db = pool) {
  await ensureBusinessConfigTable(db);
  const [rows] = await db.query('SELECT clave, valor FROM configuracion_negocio');
  const config = { ...DEFAULT_CONFIG };
  rows.forEach((row) => {
    config[row.clave] = row.valor ?? '';
  });
  return config;
}

export async function setBusinessConfig(values = {}, db = pool) {
  await ensureBusinessConfigTable(db);
  const allowed = Object.keys(DEFAULT_CONFIG);
  const entries = Object.entries(normalizeBusinessConfigPatch(values, allowed));
  if (!entries.length) return getBusinessConfig(db);

  await db.query(
    `INSERT INTO configuracion_negocio (clave, valor)
     VALUES ${entries.map(() => '(?, ?)').join(', ')}
     ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
    entries.flatMap(([key, value]) => [key, value == null ? '' : String(value)])
  );
  return getBusinessConfig(db);
}

export function businessDefaults() {
  return { ...DEFAULT_CONFIG };
}
