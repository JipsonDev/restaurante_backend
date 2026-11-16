// Tope para extras escritos a mano por el mesero (no estan en el catalogo).
export const MAX_CUSTOM_EXTRA = 100;

export function extraKey(nombre) {
  return String(nombre || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Construye el catalogo de extras activos indexado por nombre normalizado.
export function buildExtrasCatalog(rows = []) {
  const catalog = new Map();
  for (const row of rows) {
    const key = extraKey(row.nombre);
    if (key && !catalog.has(key)) catalog.set(key, { nombre: row.nombre, precio: Number(row.precio), tipo: row.tipo });
  }
  return catalog;
}

// options.extrasCatalog: los extras del catalogo SIEMPRE usan el precio de la
// base de datos (el cliente no puede abaratarlos). options.strictPrices: si el
// cliente pidio validar precios, un precio distinto devuelve 409 en vez de
// corregirse en silencio.
export function normalizeOrderItem(item, product, { extrasCatalog = new Map(), strictPrices = false } = {}) {
  const cantidad = Number(item.cantidad);
  if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
    throw new Error('La cantidad debe ser un entero positivo.');
  }
  const precio = Number(product.precio);
  if (!Number.isFinite(precio) || precio < 0) throw new Error('Precio del producto invalido.');

  const modificadores = (Array.isArray(item.modificadores) ? item.modificadores : []).map((mod) => {
    const nombre = String(mod?.nombre || '').trim().slice(0, 120);
    const requested = Number(mod?.precio_extra ?? 0);
    if (!Number.isFinite(requested) || requested < 0) throw new Error('Precio del extra invalido.');
    const known = extrasCatalog.get(extraKey(nombre));
    if (known) {
      if (strictPrices && Math.round(requested * 100) !== Math.round(known.precio * 100)) {
        throw Object.assign(new Error(`Cambio el precio del extra ${known.nombre}. Actualiza y revisa el total antes de enviar.`), { status: 409 });
      }
      return { nombre: known.nombre, tipo: known.tipo || 'EXTRA', precio_extra: Number(known.precio.toFixed(2)) };
    }
    if (requested > MAX_CUSTOM_EXTRA) throw new Error(`Un extra personalizado no puede superar ${MAX_CUSTOM_EXTRA}.`);
    return {
      nombre,
      tipo: ['EXTRA', 'EXCLUSION', 'TERMINO', 'NOTA'].includes(mod?.tipo) ? mod.tipo : 'NOTA',
      precio_extra: Number(requested.toFixed(2)),
    };
  }).filter((mod) => mod.nombre);

  return { producto_id: product.id, cantidad, precio, notas: item.notas || null, modificadores };
}

export function orderTotal(items, servicePercent = 0) {
  const percent = Number(String(servicePercent).replace(',', '.'));
  if (!Number.isFinite(percent) || percent < 0) throw new Error('Porcentaje de servicio invalido.');
  const cents = items.reduce((sum, item) => (
    sum + (Math.round(item.precio * 100) + item.modificadores.reduce(
      (extras, mod) => extras + Math.round(mod.precio_extra * 100), 0
    )) * item.cantidad
  ), 0);
  const totalCents = cents + Math.round(cents * percent / 100);
  if (!Number.isSafeInteger(totalCents)) throw new Error('Total fuera del rango permitido.');
  return totalCents / 100;
}

export function fullPaymentAmount(requested, total) {
  const amount = Number(requested ?? total);
  const expected = Number(total);
  if (!Number.isFinite(amount) || !Number.isFinite(expected) || amount <= 0 || expected <= 0) {
    throw new Error('El monto a cobrar debe ser un numero valido mayor a cero.');
  }
  if (Math.round(amount * 100) !== Math.round(expected * 100)) {
    throw new Error('El monto debe coincidir con el total pendiente. Actualiza la cuenta antes de cobrar.');
  }
  return Number(expected.toFixed(2));
}
