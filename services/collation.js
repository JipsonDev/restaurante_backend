// Unifica la intercalación de la base en utf8mb4_unicode_ci.
// Causa del error «Illegal mix of collations (utf8mb4_bin, …) and (utf8mb4_unicode_ci, …)»:
// algunas tablas/columnas quedaron en otra intercalación. Se convierte tabla por tabla con
// ALTER TABLE … CONVERT TO (operación atómica en InnoDB: si falla, la tabla queda como estaba).
// Se ejecuta al arrancar (con bloqueo para que dos instancias no lo hagan a la vez) y no detiene
// el servidor si algo falla.
import { pool } from '../db.js';

export const TARGET_CHARSET = 'utf8mb4';
export const TARGET_COLLATION = 'utf8mb4_unicode_ci';
const LOCK = 'morena_mia_collation';

const ident = name => `\`${String(name).replace(/`/g, '``')}\``;

// Columnas de texto que NO son utf8 (se dejan tal cual dentro del mismo ALTER).
async function keptColumns(db, table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation,
            IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, COLUMN_COMMENT AS comment, EXTRA AS extra
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CHARACTER_SET_NAME IS NOT NULL
       AND CHARACTER_SET_NAME NOT IN ('utf8mb4', 'utf8mb3', 'utf8')
     ORDER BY ORDINAL_POSITION`,
    [table]
  );
  return rows.map(c => {
    if (/GENERATED/i.test(c.extra || '')) throw new Error(`columna generada ${c.name}: revisar a mano`);
    const def = c.def == null ? '' : ` DEFAULT ${db.escape(c.def)}`;
    const comment = c.comment ? ` COMMENT ${db.escape(c.comment)}` : '';
    return `MODIFY ${ident(c.name)} ${c.type} CHARACTER SET ${c.charset} COLLATE ${c.collation} ${c.nullable === 'NO' ? 'NOT NULL' : 'NULL'}${def}${comment}`;
  });
}

// Qué hay que cambiar: base, tablas y columnas de texto con otra intercalación.
export async function collationReport(db = pool) {
  const [[schema]] = await db.query(
    'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = DATABASE()'
  );
  const [tables] = await db.query(
    `SELECT TABLE_NAME AS name, TABLE_COLLATION AS collation
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
  );
  // Solo texto utf8/utf8mb4. Las columnas con otro juego de caracteres (p. ej. ascii_bin para claves
  // de idempotencia que distinguen mayúsculas) son intencionales y se conservan.
  const [columns] = await db.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLLATION_NAME AS collation
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> ?
       AND CHARACTER_SET_NAME IN ('utf8mb4', 'utf8mb3', 'utf8')`,
    [TARGET_COLLATION]
  );
  const tableSet = new Set(tables.filter(t => t.collation && t.collation !== TARGET_COLLATION).map(t => t.name));
  for (const c of columns) tableSet.add(c.tableName);
  return {
    target: TARGET_COLLATION,
    database: { collation: schema?.collation || null, ok: schema?.collation === TARGET_COLLATION },
    tables: [...tableSet].sort(),
    columns: columns.map(c => ({ table: c.tableName, column: c.name, collation: c.collation })),
    ok: schema?.collation === TARGET_COLLATION && tableSet.size === 0,
  };
}

// Convierte lo que falte. Devuelve qué se convirtió y qué falló (con el motivo).
export async function unifyCollation(db = pool, { log = console } = {}) {
  const conn = await db.getConnection();
  const result = { converted: [], failed: [], skipped: false, database: false };
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 0) AS acquired', [LOCK]);
    if (!Number(lock?.acquired)) { result.skipped = true; return result; }
    try {
      const report = await collationReport(conn);
      if (report.ok) return result;
      if (!report.database.ok) {
        try {
          const [[{ db: name }]] = await conn.query('SELECT DATABASE() AS db');
          await conn.query(`ALTER DATABASE ${ident(name)} CHARACTER SET ${TARGET_CHARSET} COLLATE ${TARGET_COLLATION}`);
          result.database = true;
        } catch (error) {
          result.failed.push({ table: '(base de datos)', message: error.message });
        }
      }
      // Sin revisar claves foráneas durante la conversión: las columnas relacionadas pasan a la
      // misma intercalación en la misma ejecución.
      await conn.query('SET SESSION foreign_key_checks = 0');
      try {
        for (const table of report.tables) {
          try {
            const keep = await keptColumns(conn, table);
            await conn.query(`ALTER TABLE ${ident(table)} CONVERT TO CHARACTER SET ${TARGET_CHARSET} COLLATE ${TARGET_COLLATION}${keep.length ? `, ${keep.join(', ')}` : ''}`);
            result.converted.push(table);
          } catch (error) {
            // p. ej. una clave única con valores que solo difieren en mayúsculas: la tabla queda igual.
            result.failed.push({ table, message: error.message });
          }
        }
      } finally {
        await conn.query('SET SESSION foreign_key_checks = 1');
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
    }
    if (result.converted.length) log.log?.(`Intercalación unificada (${TARGET_COLLATION}) en: ${result.converted.join(', ')}`);
    if (result.failed.length) log.warn?.('No se pudo unificar la intercalación en:', result.failed);
    return result;
  } finally {
    conn.release();
  }
}
