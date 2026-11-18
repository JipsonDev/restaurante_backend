// Vigilante de stock. Tras cada venta, preparación, anulación o movimiento de inventario revisa:
//  · qué platos cambiaron de unidades disponibles → avisa a meseros, cocina y menú QR (se ven «Agotado» al instante);
//  · qué insumos bajaron del mínimo o se acabaron → avisa a administración (en pantalla y al teléfono);
//  · qué se repuso → lo quita de los avisos.
// Lo ya avisado se guarda en la base para no repetir el aviso tras reiniciar el servidor.
import { pool } from '../db.js';
import { EVENTS, emitRealtime, onRealtimeEmit } from '../realtime.js';
import { sellableStockSQL } from './stockReservations.js';
import { alertMessage, diffStock } from './stockLogic.js';

let notify = async () => {};
let lastSellable = null;
let timer = null, running = false, again = false, tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_alertas (
    clave VARCHAR(40) NOT NULL,
    estado VARCHAR(10) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (clave)
  )`);
  tableReady = true;
}

async function readState() {
  const [[products], [items], [alertRows]] = await Promise.all([
    pool.query(`SELECT p.id, p.nombre, p.agotado, ${sellableStockSQL} AS disponible
      FROM productos p LEFT JOIN inventario_items ii ON ii.id = p.inventario_item_id LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.disponible = 1 AND COALESCE(c.activo, 1) = 1`),
    pool.query(`SELECT ii.id, ii.nombre, ii.unidad, ii.stock, ii.stock_reservado, ii.stock_minimo,
      (EXISTS (SELECT 1 FROM recetas r JOIN productos p ON p.id = r.producto_id WHERE r.inventario_item_id = ii.id AND r.activo = 1 AND p.disponible = 1)
        OR EXISTS (SELECT 1 FROM productos p WHERE p.inventario_item_id = ii.id AND p.disponible = 1)) AS usado
      FROM inventario_items ii WHERE ii.activo = 1`),
    pool.query('SELECT clave, estado FROM stock_alertas'),
  ]);
  return { products, items, alerts: new Map(alertRows.map(r => [r.clave, r.estado])) };
}

export async function checkStockNow() {
  if (running) { again = true; return null; }
  running = true;
  try {
    await ensureTable();
    const state = await readState();
    const firstRun = lastSellable === null;
    const result = diffStock({ ...state, lastSellable });
    lastSellable = result.sellable;

    // Guarda lo avisado / repuesto.
    for (const { key, level } of [...result.raised, ...result.updated]) {
      await pool.query('INSERT INTO stock_alertas (clave, estado) VALUES (?, ?) ON DUPLICATE KEY UPDATE estado = VALUES(estado)', [key, level]);
    }
    if (result.cleared.length) await pool.query(`DELETE FROM stock_alertas WHERE clave IN (${result.cleared.map(() => '?').join(', ')})`, result.cleared.map(c => c.key));

    if (result.stockChanges.length) emitRealtime(EVENTS.CATALOG_UPDATED, { action: 'stock', productos: result.stockChanges });

    // Primera revisión con la tabla vacía (recién instalado): se registra el estado sin avisar de todo de golpe.
    const silent = firstRun && state.alerts.size === 0 && result.raised.length > 5;
    const message = silent ? null : alertMessage(result.raised, state);
    const restored = result.cleared.map(({ key }) => {
      const [type, id] = key.split(':');
      return type === 'INSUMO' ? state.items.find(it => Number(it.id) === Number(id))?.nombre : state.products.find(p => Number(p.id) === Number(id))?.nombre;
    }).filter(Boolean);
    if (message || restored.length) {
      emitRealtime(EVENTS.INVENTORY_ALERT, { title: message?.title || null, body: message?.body || null, se_acabo: message?.gone || [], queda_poco: message?.low || [], sin_stock: message?.dishes || [], repuesto: restored });
    }
    if (message) await notify(message).catch(error => console.warn('Aviso de inventario:', error.message));
    return { ...result, message, restored };
  } catch (error) {
    console.warn('Vigilante de stock:', error.message);
    return null;
  } finally {
    running = false;
    if (again) { again = false; scheduleStockCheck(); }
  }
}

/** Pide una revisión (se agrupan las que llegan seguidas). */
export function scheduleStockCheck(delay = 800) {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; checkStockNow(); }, delay);
  timer.unref?.();
}

const TRIGGERS = new Set([EVENTS.ORDER_CREATED, EVENTS.ORDER_UPDATED, EVENTS.PAYMENT_CREATED]);

export function startStockWatch({ onAlert } = {}) {
  if (onAlert) notify = onAlert;
  // Cualquier pedido nuevo, ronda, preparación o anulación mueve stock: se revisa después.
  onRealtimeEmit((event, payload) => {
    if (TRIGGERS.has(event) || (event === EVENTS.CATALOG_UPDATED && payload?.action !== 'stock')) scheduleStockCheck();
  });
  scheduleStockCheck(3000);
  const interval = setInterval(() => scheduleStockCheck(0), 5 * 60 * 1000); // red de seguridad
  interval.unref?.();
}
