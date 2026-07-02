import { pool } from '../db.js';

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventario_item_movimientos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inventario_item_id INT NOT NULL,
      tipo ENUM('Entrada','Salida','Ajuste') NOT NULL,
      cantidad DECIMAL(10,2) NOT NULL,
      motivo VARCHAR(255) NULL,
      trabajador_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_iim_item
        FOREIGN KEY (inventario_item_id)
        REFERENCES inventario_items(id)
        ON DELETE CASCADE,
      CONSTRAINT fk_iim_trabajador
        FOREIGN KEY (trabajador_id)
        REFERENCES trabajadores(id)
        ON DELETE SET NULL
    )
  `);

  console.log('inventario_item_movimientos lista');
} finally {
  await pool.end();
}
