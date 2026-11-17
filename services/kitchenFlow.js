// Reglas de avance de una ronda en cocina.
// Normal: PENDIENTE → PREPARANDO → LISTO → ENTREGADO.
// «Deshacer listo» (recall): LISTO → PREPARANDO, solo para cocina o admin y mientras no se haya
// entregado. No vuelve a descontar inventario (ya se descontó al empezar) y borra la hora de «listo».
const FLOW = { PENDIENTE: ['PREPARANDO'], PREPARANDO: ['LISTO'], LISTO: ['ENTREGADO'], ENTREGADO: [] };

export function roundTransition(current, next, role) {
  const from = String(current || '').toUpperCase();
  const to = String(next || '').toUpperCase();
  if (from === to) return { ok: true, recall: false, same: true };
  if (from === 'LISTO' && to === 'PREPARANDO') return { ok: role === 'cocina' || role === 'admin', recall: true };
  return { ok: (FLOW[from] || []).includes(to), recall: false };
}

// Estación de un producto (bar, plancha, fríos…). Vacío = cocina general. Texto corto y limpio.
export function cleanStation(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

// Una ronda está completa cuando todos sus platos (con cantidad) están listos.
export function allItemsReady(items = []) {
  const real = items.filter((it) => Number(it.cantidad) > 0);
  return real.length > 0 && real.every((it) => it.listo_at != null);
}
