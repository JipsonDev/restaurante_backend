// Menú público (código QR de la mesa): lo que ve el cliente sin iniciar sesión.
// El código de cada mesa va firmado para que no se pueda inventar uno a mano.
import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.QR_SECRET || process.env.JWT_SECRET || '';
const sign = id => createHmac('sha256', secret()).update(`mesa-qr:${id}`).digest('hex').slice(0, 10);

/** Código que se imprime en el QR de una mesa: «5-a1b2c3d4e5». */
export function tableToken(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Mesa inválida.');
  return `${n}-${sign(n)}`;
}

/** Id de la mesa si el código es auténtico; si no, null. */
export function parseTableToken(token) {
  const m = /^(\d{1,9})-([a-f0-9]{10})$/.exec(String(token || '').trim());
  if (!m) return null;
  const expected = Buffer.from(sign(Number(m[1])));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? Number(m[1]) : null;
}

/** Solo lo que el cliente necesita ver: sin costos, existencias ni datos internos. */
export function publicProduct(row) {
  return {
    id: Number(row.id),
    nombre: String(row.nombre || '').trim(),
    descripcion: row.descripcion ? String(row.descripcion).trim() : null,
    precio: Number(row.precio) || 0,
    imagen_url: row.imagen_url || null,
    categoria: row.categoria_nombre || 'Otros',
    agotado: Number(row.agotado) === 1,
  };
}

/** Agrupa por categoría conservando el orden en que aparecen. */
export function publicMenu(rows = []) {
  const productos = rows.map(publicProduct).filter(p => p.nombre);
  const categorias = [...new Set(productos.map(p => p.categoria))];
  return { categorias, productos };
}
