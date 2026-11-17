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
