import { pool } from '../db.js';

async function addColumnIfMissing(table, column, ddl) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!rows.length) await pool.query(ddl);
}

try {
  await pool.query(`ALTER TABLE pedidos MODIFY estado VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE'`);
  await pool.query(`
    UPDATE pedidos
    SET estado = CASE
      WHEN estado IN ('Pendiente', 'PENDIENTE') THEN 'PENDIENTE'
      WHEN estado IN ('En preparación', 'En preparaciÃ³n', 'En preparacion', 'PREPARANDO') THEN 'PREPARANDO'
      WHEN estado IN ('Listo', 'LISTO') THEN 'LISTO'
      WHEN estado IN ('Entregado', 'ENTREGADO') THEN 'ENTREGADO'
      WHEN estado IN ('Completado', 'Pagado', 'PAGADO') THEN 'PAGADO'
      WHEN estado IN ('Cancelado', 'CANCELADO') THEN 'CANCELADO'
      ELSE 'PENDIENTE'
    END
  `);
  await pool.query(`
    ALTER TABLE pedidos
    MODIFY estado ENUM('PENDIENTE','PREPARANDO','LISTO','ENTREGADO','PAGADO','CANCELADO')
    NOT NULL DEFAULT 'PENDIENTE'
  `);

  await addColumnIfMissing('pedidos', 'preparando_at', 'ALTER TABLE pedidos ADD COLUMN preparando_at DATETIME NULL');
  await addColumnIfMissing('pedidos', 'listo_at', 'ALTER TABLE pedidos ADD COLUMN listo_at DATETIME NULL');
  await addColumnIfMissing('pedidos', 'entregado_at', 'ALTER TABLE pedidos ADD COLUMN entregado_at DATETIME NULL');
  await addColumnIfMissing('pedidos', 'pagado_at', 'ALTER TABLE pedidos ADD COLUMN pagado_at DATETIME NULL');
  await addColumnIfMissing('pedidos', 'cancelado_at', 'ALTER TABLE pedidos ADD COLUMN cancelado_at DATETIME NULL');
  await addColumnIfMissing('pedidos', 'inventario_descontado', 'ALTER TABLE pedidos ADD COLUMN inventario_descontado TINYINT(1) NOT NULL DEFAULT 0');
  await addColumnIfMissing('pedidos', 'cliente_nombre', 'ALTER TABLE pedidos ADD COLUMN cliente_nombre VARCHAR(120) NULL');
  await addColumnIfMissing('pedidos', 'cliente_dato', 'ALTER TABLE pedidos ADD COLUMN cliente_dato VARCHAR(160) NULL');
  await addColumnIfMissing('pedidos', 'delivery_telefono', 'ALTER TABLE pedidos ADD COLUMN delivery_telefono VARCHAR(40) NULL');
  await addColumnIfMissing('pedidos', 'delivery_direccion', 'ALTER TABLE pedidos ADD COLUMN delivery_direccion VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'delivery_referencia', 'ALTER TABLE pedidos ADD COLUMN delivery_referencia VARCHAR(220) NULL');
  await addColumnIfMissing('pedidos', 'cuenta_solicitada_at', 'ALTER TABLE pedidos ADD COLUMN cuenta_solicitada_at DATETIME NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS detalle_pedido_modificadores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      detalle_pedido_id INT NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      tipo ENUM('EXTRA','EXCLUSION','TERMINO','NOTA') NOT NULL DEFAULT 'NOTA',
      precio_extra DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_dpm_detalle
        FOREIGN KEY (detalle_pedido_id)
        REFERENCES detalle_pedidos(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS recetas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      producto_id INT NOT NULL,
      inventario_item_id INT NOT NULL,
      cantidad DECIMAL(10,3) NOT NULL DEFAULT 1.000,
      unidad VARCHAR(30) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_receta_producto_item (producto_id, inventario_item_id),
      CONSTRAINT fk_recetas_producto
        FOREIGN KEY (producto_id)
        REFERENCES productos(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_recetas_inventario
        FOREIGN KEY (inventario_item_id)
        REFERENCES inventario_items(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuenta_divisiones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id INT NOT NULL,
      nombre VARCHAR(80) NOT NULL,
      monto DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      estado ENUM('PENDIENTE','PAGADO') NOT NULL DEFAULT 'PENDIENTE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_cuenta_divisiones_pedido
        FOREIGN KEY (pedido_id)
        REFERENCES pedidos(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuenta_division_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      division_id INT NOT NULL,
      detalle_pedido_id INT NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL DEFAULT 1.00,
      CONSTRAINT fk_cdi_division
        FOREIGN KEY (division_id)
        REFERENCES cuenta_divisiones(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_cdi_detalle
        FOREIGN KEY (detalle_pedido_id)
        REFERENCES detalle_pedidos(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`ALTER TABLE pagos MODIFY metodo ENUM('Efectivo','Tarjeta','Transferencia','Mixto','Vales','Otro') NOT NULL DEFAULT 'Efectivo'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_acciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trabajador_id INT NULL,
      rol VARCHAR(30) NULL,
      accion VARCHAR(80) NOT NULL,
      entidad VARCHAR(80) NOT NULL,
      entidad_id INT NULL,
      descripcion VARCHAR(255) NULL,
      metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auditoria_entidad (entidad, entidad_id),
      INDEX idx_auditoria_fecha (created_at)
    )
  `);

  await pool.query(`UPDATE pedidos p SET estado = 'CANCELADO', cancelado_at = COALESCE(cancelado_at, NOW()) WHERE p.estado NOT IN ('PAGADO','CANCELADO') AND NOT EXISTS (
    SELECT 1 FROM detalle_pedidos dp WHERE dp.pedido_id = p.id AND dp.cantidad > 0
  )`);

  await pool.query(`UPDATE mesas SET estado = 'Libre' WHERE estado IN ('Ocupada', 'Cuenta') AND NOT EXISTS (
    SELECT 1 FROM pedidos p WHERE p.mesa_id = mesas.id AND p.estado NOT IN ('PAGADO','CANCELADO') AND EXISTS (
      SELECT 1 FROM detalle_pedidos dp WHERE dp.pedido_id = p.id AND dp.cantidad > 0
    )
  )`);

  console.log('flujo de pedidos listo');
} finally {
  await pool.end();
}
