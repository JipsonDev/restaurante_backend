export const TABLE_STATES = ['Libre', 'Ocupada', 'Reservada', 'Cuenta'];
const positiveInteger = value => ['string', 'number'].includes(typeof value)
  && String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;

export function tableInputError(input, creating = false) {
  if ((creating || input.numero !== undefined) && !positiveInteger(input.numero)) return 'El numero de mesa debe ser un entero mayor que cero.';
  if (input.capacidad !== undefined && !positiveInteger(input.capacidad)) return 'La capacidad debe ser un numero entero de sillas mayor que cero.';
  if (input.ubicacion_id != null && !positiveInteger(input.ubicacion_id)) return 'La ubicacion seleccionada no es valida.';
  if (input.activo !== undefined && ![0, 1, '0', '1', true, false].includes(input.activo)) return 'El valor activo debe ser 0 o 1.';
  if (input.estado !== undefined && !TABLE_STATES.includes(input.estado)) return 'El estado de mesa no es valido.';
  return null;
}

export function tableTransitionError(current, patch) {
  const active = Number(current.pedidos_activos || 0) > 0;
  if (Number(current.activo) === 0 && Number(patch.activo ?? current.activo) === 0 && patch.estado !== undefined) return 'Reactiva la mesa antes de cambiar su estado.';
  if (active && patch.numero !== undefined && current.numero !== undefined && Number(patch.numero) !== Number(current.numero)) return 'No puedes renumerar una mesa con pedidos activos.';
  if (active && patch.activo !== undefined && Number(patch.activo) === 0) return 'No puedes desactivar una mesa con pedidos activos.';
  if (active && ['Libre', 'Reservada'].includes(patch.estado)) return 'La mesa tiene pedidos activos. Completa o cancela sus pedidos antes de liberarla o reservarla.';
  if (!active && ['Ocupada', 'Cuenta'].includes(patch.estado)) return 'No puedes marcar una mesa como ocupada/cuenta si no tiene pedidos activos.';
  return null;
}
