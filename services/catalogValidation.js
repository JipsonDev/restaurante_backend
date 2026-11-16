import { invalid } from './adminValidation.js';

export function catalogFlag(value, label = 'Estado') {
  if (![0, 1, '0', '1', true, false].includes(value)) throw invalid(`${label} inválido.`);
  return Number(value);
}
export function catalogName(value, label = 'Nombre') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw invalid(`${label}: escribe entre 1 y 80 caracteres.`);
  return value.trim();
}
export async function validateCatalogLinks(conn, { categoryId, inventoryId, recipe, published, requireCategory = true }) {
  if (categoryId != null || requireCategory) {
    if (!Number.isSafeInteger(Number(categoryId)) || Number(categoryId) <= 0) throw invalid('Selecciona una categoría válida.');
    const [[category]] = await conn.query('SELECT id, activo FROM categorias WHERE id = ? FOR UPDATE', [categoryId]);
    if (!category) throw invalid('La categoría seleccionada no existe.');
    if (published && Number(category.activo) === 0) throw invalid('Activa la categoría o selecciona otra antes de publicar el producto.');
  }
  if (inventoryId != null) {
    if (!Number.isSafeInteger(Number(inventoryId)) || Number(inventoryId) <= 0) throw invalid('Selecciona un insumo válido.');
    if (recipe?.length) throw invalid('Elige un vínculo directo o una receta; no ambos.');
    const [[item]] = await conn.query('SELECT id, activo FROM inventario_items WHERE id = ? FOR UPDATE', [inventoryId]);
    if (!item || Number(item.activo) === 0) throw invalid('El insumo vinculado no existe o está inactivo.');
  }
}
