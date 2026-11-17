import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

function getSslConfig() {
  if (process.env.DB_SSL !== 'true') return undefined;

  const ssl = {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };

  if (process.env.DB_SSL_CA_BASE64) {
    ssl.ca = Buffer.from(process.env.DB_SSL_CA_BASE64, 'base64').toString('utf8');
  } else if (process.env.DB_SSL_CA) {
    ssl.ca = process.env.DB_SSL_CA.replace(/\\n/g, '\n');
  }

  return ssl;
}

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // Misma intercalación en la conexión que en las tablas (utf8mb4_unicode_ci).
  charset: 'UTF8MB4_UNICODE_CI',
  ssl: getSslConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

try {
  const connection = await pool.getConnection();
  console.log('Conexion exitosa a la base de datos MySQL');
  connection.release();
} catch (error) {
  const details = error.message || error.code || error.sqlMessage || JSON.stringify(error);
  console.error('Error conectando a la base de datos:', details);
}
