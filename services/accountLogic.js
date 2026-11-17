export function toCents(amount) {
  const number = Number(amount);
  const cents = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(cents) || cents < 0) throw new Error('Importe invalido.');
  return cents;
}

export function allocateCents(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !Number.isSafeInteger(sum) || total < 0 || !Number.isSafeInteger(total) || weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new Error('No se puede distribuir el total.');
  const amounts = weights.map((w) => Number(BigInt(total) * BigInt(w) / BigInt(sum)));
  const ranked = weights.map((w, i) => ({ i, remainder: (BigInt(total) * BigInt(w)) % BigInt(sum) }))
    .sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1);
  let rest = total - amounts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i += 1, rest -= 1) amounts[ranked[i % ranked.length].i] += 1;
  return amounts;
}

export function buildAccountSplit(account, { mode = 'equal', partes = 2, divisions = [] } = {}) {
  const total = toCents(account.total);
  if (total <= 0) throw new Error('La cuenta no tiene saldo para dividir.');
  if (!['equal', 'items'].includes(mode)) throw new Error('Modo de division invalido.');
  if (mode === 'equal') {
    const count = Number(partes);
    if (!Number.isSafeInteger(count) || count < 2 || count > 50 || count > total) throw new Error('Selecciona entre 2 y 50 partes con importe positivo.');
    return allocateCents(total, Array(count).fill(1)).map((amount, i) => ({ nombre: `Parte ${i + 1}`, monto: amount / 100, items: [] }));
  }
  if (!Array.isArray(divisions) || divisions.length < 2 || divisions.length > 50) throw new Error('Asigna productos a entre 2 y 50 comensales.');
  const details = new Map(account.items.map((item) => [Number(item.id), item]));
  const used = new Map();
  const groups = divisions.map((group, i) => {
    if (!Array.isArray(group.items) || !group.items.length) throw new Error('Cada comensal debe tener productos.');
    let weight = 0;
    const items = group.items.map((ref) => {
      const id = Number(ref.detalle_pedido_id), qty = Number(ref.cantidad);
      const item = details.get(id);
      if (!item) throw new Error('Un producto no pertenece a esta cuenta.');
      if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('Cantidad asignada invalida.');
      const count = (used.get(id) || 0) + qty;
      if (count > Number(item.cantidad)) throw new Error('Un producto esta asignado mas de una vez.');
      used.set(id, count);
      // Un plato en cortesía no pesa en el reparto: no se cobra.
      if (!item.cortesia) weight += (toCents(item.precio) + (item.modificadores || []).reduce((sum, mod) => sum + toCents(mod.precio_extra), 0)) * qty;
      return { detalle_pedido_id: id, cantidad: qty };
    });
    return { nombre: String(group.nombre || `Comensal ${i + 1}`).trim().slice(0, 80), items, weight };
  });
  for (const [id, item] of details) if ((used.get(id) || 0) !== Number(item.cantidad)) throw new Error('Debes asignar todos los productos de la cuenta.');
  const amounts = allocateCents(total, groups.map((group) => group.weight));
  if (amounts.some((amount) => amount <= 0)) throw new Error('Cada parte debe tener un importe positivo.');
  return groups.map(({ nombre, items }, i) => ({ nombre, items, monto: amounts[i] / 100 }));
}
