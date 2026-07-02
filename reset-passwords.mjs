import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// correo -> nueva contraseña en texto plano
const NUEVAS = {
  'admin@morenamia.com':  'admin123',
  'maria@morenamia.com':  'mesero123',
  'luis@morenamia.com':   'mesero123',
  'cocina@morenamia.com': 'cocina123',
};

for (const [correo, plain] of Object.entries(NUEVAS)) {
  const hash = await bcrypt.hash(plain, 10);
  const [r] = await pool.query(
    'UPDATE trabajadores SET password_hash = ? WHERE correo = ?',
    [hash, correo]
  );
  console.log(`${r.affectedRows ? '✅' : '⚠️ '} ${correo} -> "${plain}"`);
}

await pool.end();
console.log('\nListo. Ya puedes iniciar sesión.');
