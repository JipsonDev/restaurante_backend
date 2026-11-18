// Lógica pura del vigilante de stock: qué cambió, qué hay que avisar y qué ya se repuso.
const round3 = n => Math.round(Number(n || 0) * 1000) / 1000;

/** Nivel de un insumo: AGOTADO (no queda para vender), BAJO (en el mínimo o debajo) o null (bien). */
export function itemLevel(item) {
  const available = round3(Number(item.stock || 0) - Number(item.stock_reservado || 0));
  const min = Number(item.stock_minimo || 0);
  const watched = min > 0 || Number(item.usado || 0) > 0; // un insumo que nadie usa y sin mínimo no molesta
  if (!watched) return null;
  if (available <= 0) return 'AGOTADO';
  if (min > 0 && available <= min) return 'BAJO';
  return null;
}

/**
 * Compara el estado actual con lo último que se avisó.
 *  products: [{ id, nombre, agotado, disponible }]   (disponible = unidades que se pueden vender)
 *  items:    [{ id, nombre, unidad, stock, stock_reservado, stock_minimo, usado }]
 *  alerts:   Map clave → estado ('INSUMO:3' → 'BAJO')    lastSellable: Map id → unidades (null = primera vez)
 */
export function diffStock({ products = [], items = [], alerts = new Map(), lastSellable = null }) {
  const stockChanges = [];
  const next = new Map();
  for (const p of products) {
    const units = Math.max(0, Math.floor(Number(p.disponible || 0)));
    next.set(Number(p.id), units);
    if (lastSellable && lastSellable.get(Number(p.id)) !== units) stockChanges.push({ producto_id: Number(p.id), nombre: p.nombre, stock_disponible: units });
  }

  const current = new Map();
  for (const it of items) { const level = itemLevel(it); if (level) current.set(`INSUMO:${it.id}`, level); }
  // Plato sin stock (y no agotado a mano por cocina, que ya lo sabe).
  for (const p of products) if (Math.floor(Number(p.disponible || 0)) <= 0 && Number(p.agotado || 0) !== 1) current.set(`PRODUCTO:${p.id}`, 'AGOTADO');

  const raised = [], escalated = [], cleared = [], updated = [];
  for (const [key, level] of current) {
    const before = alerts.get(key);
    if (!before) raised.push({ key, level });
    else if (before === 'BAJO' && level === 'AGOTADO') escalated.push({ key, level });
    else if (before !== level) updated.push({ key, level }); // AGOTADO → BAJO: se repuso algo, sin aviso
  }
  for (const [key] of alerts) if (!current.has(key)) cleared.push({ key });
  return { stockChanges, sellable: next, raised: [...raised, ...escalated], cleared, updated, current };
}

const fmt = n => round3(n).toLocaleString('es-EC', { maximumFractionDigits: 3 });
const unitOf = it => { const u = String(it.unidad || '').trim(); return !u || u === 'unidad' ? 'u' : u; };
const list = (names, max = 3) => names.length > max ? `${names.slice(0, max).join(', ')} y ${names.length - max} más` : names.join(', ');

/** Texto del aviso para administración («queda poco» / «se acabó»). Devuelve null si no hay nada que avisar. */
export function alertMessage(raised, { items = [], products = [] } = {}) {
  if (!raised.length) return null;
  const item = id => items.find(it => Number(it.id) === Number(id));
  const product = id => products.find(p => Number(p.id) === Number(id));
  const gone = [], low = [], lowNames = [], dishes = [];
  for (const { key, level } of raised) {
    const [type, id] = key.split(':');
    if (type === 'INSUMO') {
      const it = item(id); if (!it) continue;
      if (level === 'AGOTADO') gone.push(it.nombre);
      else { low.push(`${it.nombre} (${fmt(Number(it.stock || 0) - Number(it.stock_reservado || 0))} ${unitOf(it)})`); lowNames.push(it.nombre); }
    } else { const p = product(id); if (p) dishes.push(p.nombre); }
  }
  if (!gone.length && !low.length && !dishes.length) return null;
  const parts = [];
  if (gone.length) parts.push(`Se acabó: ${list(gone)}.`);
  if (low.length) parts.push(`Queda poco: ${list(low)}.`);
  if (dishes.length) parts.push(`Sin stock: ${list(dishes)}.`);
  const title = gone.length ? `Inventario: se acabó ${gone.length === 1 ? gone[0] : `${gone.length} insumos`}`
    : low.length ? `Inventario: queda poco${lowNames.length === 1 ? ` ${lowNames[0]}` : ''}`
    : `Sin stock: ${dishes.length === 1 ? dishes[0] : `${dishes.length} platos`}`;
  return { title, body: parts.join(' ').slice(0, 220), gone, low, dishes };
}
