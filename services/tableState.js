import { pool } from '../db.js';
import { emitRealtime, EVENTS } from '../realtime.js';

const ACTIVE_ORDER_CONDITION = `
  (estado NOT IN ('PAGADO', 'CANCELADO') OR (estado = 'PAGADO' AND EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = pedidos.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO'))))
  AND EXISTS (
    SELECT 1
    FROM detalle_pedidos dp
    WHERE dp.pedido_id = pedidos.id
      AND dp.cantidad > 0
  )
`;

const tableSelect = `
  SELECT m.id, m.numero, m.ubicacion_id, m.capacidad,
         m.estado AS estado_manual,
         CASE
           WHEN COALESCE(pa.pedidos_activos, 0) > 0 AND m.estado = 'Cuenta' THEN 'Cuenta'
           WHEN COALESCE(pa.pedidos_activos, 0) > 0 THEN 'Ocupada'
           WHEN m.estado IN ('Ocupada', 'Cuenta') THEN 'Libre'
           ELSE m.estado
         END AS estado,
         m.activo,
         u.nombre AS ubicacion_nombre,
         COALESCE(pa.pedidos_activos, 0) AS pedidos_activos
  FROM mesas m
  LEFT JOIN ubicaciones u ON m.ubicacion_id = u.id
  LEFT JOIN (
    SELECT mesa_id, COUNT(*) AS pedidos_activos
    FROM pedidos
    WHERE ${ACTIVE_ORDER_CONDITION}
    GROUP BY mesa_id
  ) pa ON pa.mesa_id = m.id
`;

export async function getMesaPayload(id, conn = pool) {
  if (!id) return null;
  const [rows] = await conn.query(`${tableSelect} WHERE m.id = ?`, [id]);
  return rows[0] || null;
}

export async function listMesas({ includeInactive = false } = {}, conn = pool) {
  await syncTableStates(conn);
  const [rows] = await conn.query(
    `${tableSelect}
     ${includeInactive ? '' : 'WHERE m.activo = 1'}
     ORDER BY COALESCE(u.nombre, 'ZZZ') ASC, m.numero ASC`
  );
  return rows;
}

export async function syncTableStates(conn = pool) {
  await conn.query(
    `UPDATE pedidos p
     SET p.estado = 'CANCELADO',
         p.cancelado_at = COALESCE(p.cancelado_at, NOW()),
         p.notas = CONCAT_WS(' | ', p.notas, 'Cancelado automaticamente: pedido sin productos')
     WHERE p.estado NOT IN ('PAGADO', 'CANCELADO')
       AND NOT EXISTS (
         SELECT 1
         FROM detalle_pedidos dp
         WHERE dp.pedido_id = p.id
           AND dp.cantidad > 0
       )`
  );

  await conn.query(
    `UPDATE mesas m
     SET m.estado = 'Libre'
     WHERE m.estado IN ('Ocupada', 'Cuenta')
       AND NOT EXISTS (
         SELECT 1
         FROM pedidos p
         WHERE p.mesa_id = m.id
           AND (p.estado NOT IN ('PAGADO', 'CANCELADO') OR (p.estado = 'PAGADO' AND EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = p.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO'))))
           AND EXISTS (
             SELECT 1
             FROM detalle_pedidos dp
             WHERE dp.pedido_id = p.id
               AND dp.cantidad > 0
           )
       )`
  );

  await conn.query(
    `UPDATE mesas m
     SET m.estado = 'Ocupada'
     WHERE m.estado = 'Libre'
       AND EXISTS (
         SELECT 1
         FROM pedidos p
         WHERE p.mesa_id = m.id
           AND (p.estado NOT IN ('PAGADO', 'CANCELADO') OR (p.estado = 'PAGADO' AND EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = p.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO'))))
           AND EXISTS (
             SELECT 1
             FROM detalle_pedidos dp
             WHERE dp.pedido_id = p.id
               AND dp.cantidad > 0
           )
       )`
  );
}

export async function freeMesaIfNoActive(conn, mesaId) {
  if (!mesaId) return false;
  const [[{ activos }]] = await conn.query(
    `SELECT COUNT(*) AS activos
     FROM pedidos
     WHERE mesa_id = ?
       AND (estado NOT IN ('PAGADO', 'CANCELADO') OR (estado = 'PAGADO' AND EXISTS (SELECT 1 FROM pedido_rondas r WHERE r.pedido_id = pedidos.id AND r.estado IN ('PENDIENTE', 'PREPARANDO', 'LISTO'))))
       AND EXISTS (
         SELECT 1
         FROM detalle_pedidos dp
         WHERE dp.pedido_id = pedidos.id
           AND dp.cantidad > 0
       )`,
    [mesaId]
  );
  if (Number(activos) === 0) {
    await conn.query('UPDATE mesas SET estado = ? WHERE id = ?', ['Libre', mesaId]);
    return true;
  }
  return false;
}

export async function emitMesaRealtime(event, mesaId, extra = {}) {
  let mesa = null;
  try {
    mesa = await getMesaPayload(mesaId);
  } catch {}
  emitRealtime(event, { mesa_id: Number(mesaId), ...(mesa ? { mesa } : {}), ...extra });
}

export async function emitTableFreed(mesaId, extra = {}) {
  await emitMesaRealtime(EVENTS.TABLE_FREED, mesaId, extra);
}

export async function emitTableOccupied(mesaId, extra = {}) {
  await emitMesaRealtime(EVENTS.TABLE_OCCUPIED, mesaId, extra);
}
