import { pool } from '../db.js';

export function kitchenState(rounds) {
  const states = rounds.map((round) => round.estado).filter((state) => state !== 'CANCELADO');
  return ['PENDIENTE', 'PREPARANDO', 'LISTO'].find((state) => states.includes(state)) || 'ENTREGADO';
}

export function decorateAccount(order, items, rounds) {
  const hydrated = rounds.map((round) => ({ ...round, items: items.filter((item) => Number(item.ronda_id) === Number(round.id)) }));
  const estado_cocina = kitchenState(hydrated);
  const abonado = Number(order.abonado || 0);
  const saldo_pendiente = ['PAGADO','CANCELADO'].includes(order.estado) ? 0 : Math.max(0, Math.round((Number(order.total) - abonado) * 100) / 100);
  return { ...order, abonado, saldo_pendiente, items, rondas: hydrated, estado_cocina,
    estado_cobro: order.estado === 'PAGADO' ? 'PAGADO' : order.estado === 'CANCELADO' ? 'CANCELADO' : abonado > 0 ? 'PARCIAL' : 'PENDIENTE',
    pendiente_entrega: hydrated.some((round) => ['PENDIENTE', 'PREPARANDO', 'LISTO'].includes(round.estado)),
  };
}

export async function refreshAccountState(conn, pedidoId) {
  const [rounds] = await conn.query('SELECT id, estado FROM pedido_rondas WHERE pedido_id = ? ORDER BY id', [pedidoId]);
  const state = kitchenState(rounds);
  await conn.query("UPDATE pedidos SET estado = ? WHERE id = ? AND estado NOT IN ('PAGADO', 'CANCELADO')", [state, pedidoId]);
  return state;
}

// Explicit startup migration; never run DDL inside a business transaction.
export async function migrateRounds(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS pedido_rondas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pedido_id INT NOT NULL,
    legacy_pedido_id INT NULL UNIQUE,
    estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
    notas TEXT NULL,
    inventario_descontado TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    preparando_at DATETIME NULL,
    listo_at DATETIME NULL,
    entregado_at DATETIME NULL,
    INDEX idx_rondas_pedido (pedido_id, estado),
    CONSTRAINT fk_ronda_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
  )`);
  const [columns] = await db.query("SHOW COLUMNS FROM detalle_pedidos LIKE 'ronda_id'");
  if (!columns.length) await db.query('ALTER TABLE detalle_pedidos ADD COLUMN ronda_id INT NULL, ADD INDEX idx_detalle_ronda (ronda_id)');
  await db.query(`INSERT IGNORE INTO pedido_rondas
    (pedido_id, legacy_pedido_id, estado, notas, inventario_descontado, created_at, preparando_at, listo_at, entregado_at)
    SELECT p.id, p.id, CASE WHEN p.estado = 'PAGADO' THEN 'ENTREGADO' ELSE p.estado END,
      p.notas, p.inventario_descontado, p.created_at, p.preparando_at, p.listo_at, p.entregado_at
    FROM pedidos p WHERE EXISTS (SELECT 1 FROM detalle_pedidos dp WHERE dp.pedido_id = p.id AND dp.ronda_id IS NULL)`);
  await db.query(`UPDATE detalle_pedidos dp JOIN pedido_rondas r ON r.legacy_pedido_id = dp.pedido_id
    SET dp.ronda_id = r.id WHERE dp.ronda_id IS NULL`);
}
