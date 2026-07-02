import { pool } from '../db.js';

try {
  await pool.query(`
    ALTER TABLE mesas
    MODIFY estado ENUM('Libre','Ocupada','Reservada','Cuenta') NOT NULL DEFAULT 'Libre'
  `);

  await pool.query(`
    INSERT INTO ubicaciones (nombre, descripcion, activo)
    SELECT 'Salon', 'Zona principal', 1
    WHERE NOT EXISTS (
      SELECT 1
      FROM ubicaciones
      WHERE LOWER(nombre) IN ('salon', 'salón principal', 'salon principal')
    )
  `);

  await pool.query(`
    INSERT INTO ubicaciones (nombre, descripcion, activo)
    SELECT 'Terraza', 'Zona exterior', 1
    WHERE NOT EXISTS (SELECT 1 FROM ubicaciones WHERE nombre = 'Terraza')
  `);

  await pool.query(`
    UPDATE mesas m
    JOIN ubicaciones u ON u.nombre = CASE WHEN m.numero >= 9 THEN 'Terraza' ELSE 'Salón principal' END
    SET m.ubicacion_id = COALESCE(m.ubicacion_id, u.id)
    WHERE m.ubicacion_id IS NULL
  `);

  await pool.query(`
    UPDATE ubicaciones u
    SET activo = 0
    WHERE LOWER(u.nombre) = 'salon'
      AND NOT EXISTS (
        SELECT 1
        FROM mesas m
        WHERE m.ubicacion_id = u.id
          AND m.activo = 1
      )
  `);

  console.log('ubicaciones y mesas listas');
} finally {
  await pool.end();
}
