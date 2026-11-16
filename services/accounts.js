import { emitRealtime, EVENTS } from '../realtime.js';
import { refreshAccountState } from './rounds.js';

export async function mergeAccounts(conn, orders, targetId) {
  const ids = orders.map((order) => Number(order.id));
  if (!ids.includes(Number(targetId)) || orders.some((order) => ['PAGADO', 'CANCELADO'].includes(order.estado))) throw new Error('Solo se pueden unir cuentas abiertas.');
  if (ids.length < 2) return Number(targetId);
  const [payments] = await conn.query("SELECT id FROM pagos WHERE pedido_id IN (?) AND COALESCE(estado, 'ACTIVO') = 'ACTIVO' FOR UPDATE", [ids]);
  if (payments.length) throw new Error('No se pueden unir cuentas con pagos activos.');
  const sources = ids.filter((id) => id !== Number(targetId));
  await conn.query('DELETE FROM cuenta_divisiones WHERE pedido_id IN (?)', [ids]);
  await conn.query('UPDATE detalle_pedidos SET pedido_id = ? WHERE pedido_id IN (?)', [targetId, sources]);
  await conn.query('UPDATE pedido_rondas SET pedido_id = ? WHERE pedido_id IN (?)', [targetId, sources]);
  const cents = orders.reduce((sum, order) => sum + Math.round(Number(order.total) * 100), 0);
  await conn.query('UPDATE pedidos SET total = ?, notas = ?, cuenta_solicitada_at = NULL WHERE id = ?',
    [cents / 100, orders.map((order) => order.notas).filter(Boolean).join(' | ') || null, targetId]);
  await conn.query("UPDATE pedidos SET estado = 'CANCELADO', total = 0, cancelado_at = NOW() WHERE id IN (?)", [sources]);
  await refreshAccountState(conn, targetId);
  return Number(targetId);
}

// All account mutations lock tables first, then orders in ascending order.
export async function lockWholeAccount(conn, pedidoId, targetMesaId = null, { allowPaid = false } = {}) {
  const [[hint]] = await conn.query('SELECT id, mesa_id FROM pedidos WHERE id = ?', [pedidoId]);
  if (!hint) throw new Error('Pedido no encontrado.');
  const tableIds = [...new Set([hint.mesa_id, targetMesaId].filter(Boolean).map(Number))].sort((a, b) => a - b);
  if (tableIds.length) {
    const [tables] = await conn.query('SELECT id, activo FROM mesas WHERE id IN (?) ORDER BY id FOR UPDATE', [tableIds]);
    if (tables.length !== tableIds.length || tables.some((table) => Number(table.activo) !== 1)) throw new Error('La mesa no existe o esta inactiva.');
  }
  const [orders] = await conn.query(`SELECT * FROM pedidos
    WHERE id = ? OR (mesa_id IN (?) AND estado NOT IN ('PAGADO', 'CANCELADO')) ORDER BY id FOR UPDATE`, [pedidoId, tableIds.length ? tableIds : [0]]);
  const seed = orders.find((order) => Number(order.id) === Number(pedidoId));
  if (!seed || Number(seed.mesa_id || 0) !== Number(hint.mesa_id || 0)) throw new Error('La cuenta cambio de mesa. Actualiza y reintenta.');
  if (seed.estado === 'CANCELADO' || (seed.estado === 'PAGADO' && !allowPaid)) throw new Error('La cuenta ya esta cerrada.');
  return { seed, orders, tableIds };
}

export async function consolidateAccount(conn, pedidoId) {
  const account = await lockWholeAccount(conn, pedidoId);
  await mergeAccounts(conn, account.orders, pedidoId);
  return account;
}

// Inform connected screens about accounts absorbed into the surviving bill.
export function emitMergedAccounts(orders, targetId) {
  for (const order of orders) if (Number(order.id) !== Number(targetId)) {
    emitRealtime(EVENTS.ORDER_UPDATED, { action: 'cuenta_unida', pedido: {
      ...order, total: 0, estado: 'CANCELADO', estado_cobro: 'CANCELADO', estado_cocina: 'ENTREGADO',
      pendiente_entrega: false, items: [], rondas: [],
    } });
  }
}

// Initial hint/config reads must not freeze an old snapshot while waiting on table locks.
export async function beginAccountTransaction(conn) {
  await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await conn.beginTransaction();
}
