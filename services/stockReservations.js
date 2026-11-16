import { pool } from '../db.js';
const tables = { PRODUCTO: 'productos', INSUMO: 'inventario_items' };
const milli = value => Math.round(Number(value) * 1000);
const qty = value => value / 1000;
const fail = message => Object.assign(new Error(message), { status: 409, statusCode: 409 });

export function aggregateRequirements(lines) {
  const totals = new Map();
  for (const line of lines) {
    const amount = milli(line.cantidad);
    if (!tables[line.tipo] || !Number.isSafeInteger(amount) || amount <= 0) throw fail('Cantidad de receta o inventario invalida.');
    const key = `${line.tipo}:${line.recurso_id}`;
    const previous = totals.get(key);
    const total = (previous?.units || 0) + amount;
    if (!Number.isSafeInteger(total)) throw fail('Cantidad fuera de rango.');
    totals.set(key, { tipo: line.tipo, recurso_id: Number(line.recurso_id), units: total });
  }
  // Every operation locks products first, then ingredients, each by ID.
  return [...totals.values()].sort((a, b) => (a.tipo === b.tipo ? a.recurso_id - b.recurso_id : a.tipo === 'PRODUCTO' ? -1 : 1));
}

export async function ensureStockReservations(db = pool) {
  for (const table of Object.values(tables)) {
    const [columns] = await db.query(`SHOW COLUMNS FROM ${table} LIKE 'stock_reservado'`);
    if (!columns.length) await db.query(`ALTER TABLE ${table} ADD COLUMN stock_reservado DECIMAL(16,3) NOT NULL DEFAULT 0`);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS stock_reservas (
    ronda_id INT NOT NULL, tipo ENUM('PRODUCTO','INSUMO') NOT NULL, recurso_id INT NOT NULL,
    cantidad DECIMAL(16,3) NOT NULL, estado ENUM('RESERVADO','CONSUMIDO','LIBERADO','RESTAURADO') NOT NULL DEFAULT 'RESERVADO',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(ronda_id, tipo, recurso_id), INDEX idx_reserva_recurso(tipo, recurso_id, estado),
    FOREIGN KEY(ronda_id) REFERENCES pedido_rondas(id)
  ) ENGINE=InnoDB`);
}

export async function reserveRoundStock(conn, roundId, { legacy = false } = {}) {
  const [existing] = await conn.query('SELECT * FROM stock_reservas WHERE ronda_id = ? FOR UPDATE', [roundId]);
  if (existing.length) return;
  const [items] = await conn.query('SELECT producto_id, cantidad FROM detalle_pedidos WHERE ronda_id = ? ORDER BY producto_id, id', [roundId]);
  if (!items.length) return;
  const productIds = [...new Set(items.map(item => Number(item.producto_id)))].sort((a,b) => a-b);
  const [products] = await conn.query('SELECT p.id, p.nombre, p.stock, p.stock_reservado, p.inventario_item_id, p.disponible, c.activo AS categoria_activa FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.id IN (?) ORDER BY p.id FOR UPDATE', [productIds]);
  const [recipes] = await conn.query('SELECT producto_id, inventario_item_id, cantidad FROM recetas WHERE producto_id IN (?) AND activo = 1 ORDER BY producto_id, inventario_item_id', [productIds]);
  const requirements = [];
  for (const item of items) {
    const product = products.find(p => Number(p.id) === Number(item.producto_id));
    if (!product || (!legacy && (Number(product.disponible) !== 1 || product.categoria_activa != null && Number(product.categoria_activa) === 0))) throw fail('Un producto o su categoría ya no está disponible.');
    const recipe = recipes.filter(r => Number(r.producto_id) === Number(item.producto_id));
    if (recipe.length) for (const r of recipe) requirements.push({ tipo: 'INSUMO', recurso_id: r.inventario_item_id, cantidad: Number(r.cantidad) * Number(item.cantidad) });
    else requirements.push({ tipo: product.inventario_item_id ? 'INSUMO' : 'PRODUCTO', recurso_id: product.inventario_item_id || product.id, cantidad: item.cantidad });
  }
  for (const need of aggregateRequirements(requirements)) {
    const table = tables[need.tipo];
    const [[resource]] = await conn.query(`SELECT id, nombre, stock, stock_reservado FROM ${table} WHERE id = ? FOR UPDATE`, [need.recurso_id]);
    if (!resource) throw fail('No existe un recurso de inventario de la receta.');
    const free = milli(resource.stock) - milli(resource.stock_reservado);
    if (!legacy && free < need.units) throw fail(`Sin stock suficiente de ${resource.nombre}. Disponible para vender: ${Math.max(0, qty(free))}; requerido: ${qty(need.units)}.`);
    await conn.query(`UPDATE ${table} SET stock_reservado = stock_reservado + ? WHERE id = ?`, [qty(need.units), need.recurso_id]);
    await conn.query('INSERT INTO stock_reservas (ronda_id, tipo, recurso_id, cantidad) VALUES (?, ?, ?, ?)', [roundId, need.tipo, need.recurso_id, qty(need.units)]);
  }
}

export async function consumeRoundReservation(conn, roundId, pedidoId) {
  const [rows] = await conn.query("SELECT * FROM stock_reservas WHERE ronda_id = ? ORDER BY tipo, recurso_id FOR UPDATE", [roundId]);
  if (!rows.length) return false;
  for (const row of rows) {
    if (row.estado === 'CONSUMIDO') continue;
    if (row.estado !== 'RESERVADO') throw fail('La reserva de esta ronda ya fue liberada.');
    const table = tables[row.tipo];
    const [[resource]] = await conn.query(`SELECT id, nombre, stock, stock_reservado FROM ${table} WHERE id = ? FOR UPDATE`, [row.recurso_id]);
    if (!resource || milli(resource.stock) < milli(row.cantidad) || milli(resource.stock_reservado) < milli(row.cantidad)) throw fail(`Sin stock fisico suficiente para preparar ${resource?.nombre || row.recurso_id}. Revisa el inventario.`);
    await conn.query(`UPDATE ${table} SET stock = stock - ?, stock_reservado = stock_reservado - ? WHERE id = ?`, [row.cantidad, row.cantidad, row.recurso_id]);
    if (row.tipo === 'INSUMO') await conn.query("INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id) VALUES (?, 'Salida', ?, ?, NULL)", [row.recurso_id, row.cantidad, `Consumo reserva ronda #${roundId}, pedido #${pedidoId}`]);
    await conn.query("UPDATE stock_reservas SET estado = 'CONSUMIDO' WHERE ronda_id = ? AND tipo = ? AND recurso_id = ?", [roundId, row.tipo, row.recurso_id]);
  }
  return true;
}

export async function releaseOrderReservations(conn, pedidoId) {
  const [rows] = await conn.query(`SELECT sr.* FROM stock_reservas sr JOIN pedido_rondas r ON r.id = sr.ronda_id
    WHERE r.pedido_id = ? AND sr.estado IN ('RESERVADO','CONSUMIDO') ORDER BY sr.tipo, sr.recurso_id, sr.ronda_id FOR UPDATE`, [pedidoId]);
  for (const row of rows) {
    const consumed = row.estado === 'CONSUMIDO';
    const table = tables[row.tipo];
    await conn.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [row.recurso_id]);
    if (consumed) await conn.query(`UPDATE ${table} SET stock = stock + ? WHERE id = ?`, [row.cantidad, row.recurso_id]);
    else await conn.query(`UPDATE ${table} SET stock_reservado = stock_reservado - ? WHERE id = ?`, [row.cantidad, row.recurso_id]);
    if (consumed && row.tipo === 'INSUMO') await conn.query("INSERT INTO inventario_item_movimientos (inventario_item_id, tipo, cantidad, motivo, trabajador_id) VALUES (?, 'Entrada', ?, ?, NULL)", [row.recurso_id, row.cantidad, `Restauracion reserva ronda #${row.ronda_id}, pedido #${pedidoId}`]);
    await conn.query('UPDATE stock_reservas SET estado = ? WHERE ronda_id = ? AND tipo = ? AND recurso_id = ?', [consumed ? 'RESTAURADO' : 'LIBERADO', row.ronda_id, row.tipo, row.recurso_id]);
  }
  // Keep the legacy restoration path for rounds consumed before reservations existed.
  await conn.query(`UPDATE pedido_rondas r SET inventario_descontado = 0 WHERE r.pedido_id = ?
    AND EXISTS (SELECT 1 FROM stock_reservas sr WHERE sr.ronda_id = r.id)`, [pedidoId]);
}

export async function migratePendingReservations(db = pool) {
  const [rounds] = await db.query(`SELECT r.id, r.pedido_id FROM pedido_rondas r JOIN pedidos p ON p.id = r.pedido_id
    WHERE r.inventario_descontado = 0 AND r.estado <> 'CANCELADO' AND p.estado <> 'CANCELADO'
    AND EXISTS (SELECT 1 FROM detalle_pedidos dp WHERE dp.ronda_id = r.id)
    AND NOT EXISTS (SELECT 1 FROM stock_reservas sr WHERE sr.ronda_id = r.id) ORDER BY r.pedido_id, r.id`);
  for (const round of rounds) {
    const conn = await db.getConnection();
    try {
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await conn.beginTransaction();
      await conn.query('SELECT id FROM pedidos WHERE id = ? FOR UPDATE', [round.pedido_id]);
      const [[current]] = await conn.query('SELECT * FROM pedido_rondas WHERE id = ? FOR UPDATE', [round.id]);
      if (current && !Number(current.inventario_descontado) && current.estado !== 'CANCELADO') await reserveRoundStock(conn, round.id, { legacy: true });
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  }
  const [shortages] = await db.query(`SELECT 'producto' AS tipo, id, stock, stock_reservado FROM productos WHERE stock_reservado > stock
    UNION ALL SELECT 'insumo', id, stock, stock_reservado FROM inventario_items WHERE stock_reservado > stock`);
  return { migrated: rounds.length, shortages };
}

// Raw physical stock is kept for administration; this expression exposes sellable units.
export const sellableStockSQL = `GREATEST(0, FLOOR(COALESCE(
  (SELECT MIN((ii2.stock - ii2.stock_reservado) / NULLIF(r.cantidad, 0)) FROM recetas r JOIN inventario_items ii2 ON ii2.id = r.inventario_item_id WHERE r.producto_id = p.id AND r.activo = 1),
  CASE WHEN p.inventario_item_id IS NOT NULL THEN ii.stock - ii.stock_reservado ELSE p.stock - p.stock_reservado END, 0)))`;
