// Revisión de datos sospechosos: productos repetidos, precios fuera de lo normal, nombres de prueba y datos del negocio.
// Solo informa; nunca borra. El administrador decide qué corregir.
const strip = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** ¿Parece texto escrito al azar o de prueba? («asdsadasd», «qwerty», «test», «xxx»…) */
export function looksLikeJunk(value) {
  const text = strip(value);
  if (!text) return false;
  if (/^(test|prueba|demo|xxx+|aaa+|asdf?|qwerty?|n\/?a|na|ninguno)$/.test(text)) return true;
  if (/(asd|sdf|dfg|qwe|wer|zxc|xcv|jkl|hjk|fgh)/.test(text.replace(/\s/g, ''))) return true;
  if (/(.)\1\1\1/.test(text)) return true;
  const letters = text.replace(/[^a-zñ]/g, '');
  return letters.length >= 4 && !/[aeiou]/.test(letters);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Revisa productos: nombres repetidos y precios fuera de lo normal en su categoría. */
export function reviewProducts(products) {
  const groups = new Map();
  for (const product of products) {
    const key = strip(product.nombre);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  const duplicados = [...groups.values()].filter((group) => group.length > 1)
    .map((group) => ({ nombre: group[0].nombre, productos: group.map(({ id, nombre, precio, disponible, categoria_nombre }) => ({ id, nombre, precio: Number(precio), disponible: Number(disponible ?? 1), categoria_nombre })) }));

  const byCategory = new Map();
  for (const product of products) {
    const key = product.categoria_id ?? 0;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(Number(product.precio));
  }
  const precios = [];
  for (const product of products) {
    const price = Number(product.precio);
    const peers = byCategory.get(product.categoria_id ?? 0) || [];
    const typical = peers.length >= 3 ? median(peers) : null;
    let motivo = null;
    if (!(price > 0)) motivo = 'Precio en cero';
    else if (typical && price >= typical * 4 && price - typical >= 10) motivo = `Mucho más caro que lo normal en su categoría (≈ $${typical.toFixed(2).replace(".", ",")})`;
    else if (price > 500) motivo = 'Precio muy alto para un restaurante';
    if (motivo && Number(product.disponible ?? 1) === 1) precios.push({ id: product.id, nombre: product.nombre, precio: price, categoria_nombre: product.categoria_nombre, tipico: typical, motivo });
  }
  const nombres = products.filter((product) => looksLikeJunk(product.nombre))
    .map(({ id, nombre, precio, categoria_nombre }) => ({ id, nombre, precio: Number(precio), categoria_nombre }));
  return { duplicados, precios, nombres };
}

/** Datos del negocio que salen en los comprobantes. */
export function reviewBusiness(config = {}) {
  const issues = [];
  const ruc = String(config.ruc || '').trim();
  if (!ruc) issues.push({ campo: 'ruc', motivo: 'Falta el RUC: sale en cada comprobante.' });
  else if (!/^\d{13}$/.test(ruc)) issues.push({ campo: 'ruc', motivo: `El RUC «${ruc}» no es válido: debe tener 13 dígitos.` });
  for (const [campo, label] of [['razon_social', 'La razón social'], ['direccion', 'La dirección'], ['nombre_restaurante', 'El nombre del local']]) {
    if (looksLikeJunk(config[campo])) issues.push({ campo, motivo: `${label} «${config[campo]}» parece de prueba.` });
  }
  return issues;
}
