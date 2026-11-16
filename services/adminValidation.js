export const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
export function nonNegative(value, label, decimals = 2) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw invalid(`${label} invalido.`);
  const number = Number(value), scaled = number * 10 ** decimals;
  if (!Number.isFinite(number) || number < 0 || number > 9999999 || Math.abs(scaled - Math.round(scaled)) > 0.00001) throw invalid(`${label} invalido: usa un valor no negativo con hasta ${decimals} decimales.`);
  return number;
}
export function recipeItems(items) {
  if (!Array.isArray(items)) throw invalid('La receta debe ser una lista de insumos.');
  const seen = new Set();
  return items.map(item => {
    const id = Number(item?.inventario_item_id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw invalid('La receta contiene un insumo invalido o repetido.');
    seen.add(id);
    const cantidad = nonNegative(item.cantidad, 'Cantidad de receta', 3);
    if (cantidad === 0) throw invalid('Cada insumo de la receta debe tener una cantidad mayor que cero.');
    return { inventario_item_id: id, cantidad, unidad: item.unidad || null };
  });
}
export async function replaceRecipe(conn, productId, items) {
  for (const item of [...items].sort((a, b) => a.inventario_item_id - b.inventario_item_id)) {
    const [[resource]] = await conn.query('SELECT id, unidad, activo FROM inventario_items WHERE id = ? FOR UPDATE', [item.inventario_item_id]);
    if (!resource || Number(resource.activo) === 0) throw invalid('Un insumo de la receta no existe o está inactivo.');
    if (item.unidad && String(item.unidad).trim().toLowerCase() !== String(resource.unidad || '').trim().toLowerCase()) throw invalid(`La cantidad debe expresarse en ${resource.unidad || 'la unidad del inventario'}. No se convierten unidades automáticamente.`);
    item.unidad = resource.unidad || null;
  }
  await conn.query('DELETE FROM recetas WHERE producto_id = ?', [productId]);
  for (const item of items) await conn.query('INSERT INTO recetas (producto_id, inventario_item_id, cantidad, unidad, activo) VALUES (?, ?, ?, ?, 1)', [productId, item.inventario_item_id, item.cantidad, item.unidad]);
}
